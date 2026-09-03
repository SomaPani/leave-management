import {
  daysInMonth,
  firstWeekdayOfMonth,
  isoDate,
  workdays,
} from "@/lib/date";
import type {
  AttendanceCode,
  AttendanceMark,
  Db,
  Holiday,
  LeaveRequest,
  Person,
  Policy,
} from "@/lib/types";

export const SHORT_LEAVE = "Short leave";

/* ---------------------------------------------------------------- people -- */

export function roster(db: Db): Person[] {
  return db.people.filter((p) => p.role !== "admin");
}

export function personById(db: Db, id: string): Person | undefined {
  return db.people.find((p) => p.id === id);
}

export function personOrFallback(db: Db, id: string): Person {
  return personById(db, id) ?? db.people[0];
}

export function initialsFor(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("");
}

export function isRemote(db: Db, userId: string): boolean {
  return personById(db, userId)?.workMode === "WFH";
}

/* -------------------------------------------------------------- policies -- */

export function policyByName(db: Db, name: string): Policy | undefined {
  return db.policies.find((p) => p.name === name);
}

export function allowance(db: Db, name: string): number {
  return policyByName(db, name)?.days ?? 0;
}

export function usedBy(db: Db, userId: string, type: string): number {
  return db.used[userId]?.[type] ?? 0;
}

export function balanceOf(db: Db, userId: string, type: string): number {
  return allowance(db, type) - usedBy(db, userId, type);
}

export function isShortLeave(type: string): boolean {
  return type === SHORT_LEAVE;
}

/** `" days"` for day-based policies, `" use"` for occurrence-based ones. */
export function usageUnit(db: Db, type: string): string {
  const policy = policyByName(db, type);
  return policy?.unit === "uses" || isShortLeave(type) ? " use" : " days";
}

export function formatBalance(db: Db, amount: number, type: string): string {
  return `${amount}${usageUnit(db, type)}`;
}

/* -------------------------------------------------------------- requests -- */

/** Short leave always counts as a single use; everything else counts weekdays. */
export function requestDays(request: Pick<LeaveRequest, "type" | "from" | "to">): number {
  return isShortLeave(request.type) ? 1 : workdays(request.from, request.to);
}

export function dayCountLabel(days: number): string {
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export function requestsFor(db: Db, userId: string): LeaveRequest[] {
  return db.requests.filter((r) => r.userId === userId);
}

export function pendingRequests(db: Db): LeaveRequest[] {
  return db.requests.filter((r) => r.status === "pending");
}

/** Requests still open, or ending today or later — "who's out this week". */
export function outFrom(db: Db, from: string) {
  return db.requests
    .filter((r) => r.status === "approved" && r.to >= from)
    .map((r) => {
      const person = personOrFallback(db, r.userId);
      return { id: r.id, name: person.name, initials: person.initials, request: r };
    });
}

/* ------------------------------------------------------------ attendance -- */

export function onApprovedLeave(db: Db, userId: string, date: string): boolean {
  return db.requests.some(
    (r) =>
      r.userId === userId &&
      r.status === "approved" &&
      r.from <= date &&
      r.to >= date,
  );
}

/**
 * What a person's day resolves to: an explicit mark wins, then approved leave
 * fills itself in, then a full-time remote worker defaults to WFH.
 */
export function attendanceMark(
  db: Db,
  userId: string,
  date: string,
): AttendanceMark | null {
  const marked = db.attendance[userId]?.[date];
  if (marked) return marked;
  if (onApprovedLeave(db, userId, date)) return "leave";
  if (isRemote(db, userId)) return "wfh";
  return null;
}

export function attendanceCodes(
  db: Db,
  userId: string,
  date: string,
): AttendanceCode[] {
  const mark = attendanceMark(db, userId, date);
  if (!mark) return [];
  return Array.isArray(mark) ? mark : [mark];
}

/** True when the day has no explicit mark and is being inferred. */
export function isAutoFilled(db: Db, userId: string, date: string): boolean {
  return db.attendance[userId]?.[date] === undefined;
}

/**
 * Toggle one code on a person's day, keeping the combination coherent:
 * clicking an active code clears it, `absent`/`leave` replace everything,
 * `present`/`wfh` replace each other, and `half`/`short` are mutually exclusive.
 *
 * Mutates `db` — call it inside `mutateDb`.
 */
export function toggleAttendance(
  db: Db,
  userId: string,
  date: string,
  code: AttendanceCode,
): void {
  const record = (db.attendance[userId] ??= {});
  const current = record[date];
  let combo: AttendanceCode[] = Array.isArray(current)
    ? [...current]
    : current
      ? [current]
      : [];

  const exclusive = code === "absent" || code === "leave";

  if (combo.includes(code)) {
    combo = combo.filter((c) => c !== code);
  } else if (exclusive) {
    combo = [code];
  } else {
    combo = combo.filter((c) => c !== "absent" && c !== "leave");
    if (code === "short") combo = combo.filter((c) => c !== "half");
    if (code === "half") combo = combo.filter((c) => c !== "short");
    if (code === "present" || code === "wfh") {
      combo = combo.filter((c) => c !== "present" && c !== "wfh");
    }
    combo.push(code);
  }

  if (combo.length === 0) delete record[date];
  else record[date] = combo.length === 1 ? combo[0]! : combo;
}

/** The options an admin can pick for a person — remote staff have no "Present". */
export function attendanceOptionsFor(db: Db, userId: string): AttendanceCode[] {
  return isRemote(db, userId)
    ? ["wfh", "half", "absent", "leave", "short"]
    : ["present", "wfh", "half", "absent", "leave", "short"];
}

/* -------------------------------------------------------------- holidays -- */

export function holidaysForRegion(db: Db, region: string): Holiday[] {
  return db.holidays
    .filter((h) => !h.region || h.region === region)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Every ISO date covered by a holiday, mapped to the holiday's name. */
export function holidayDateMap(holidays: Holiday[]): Record<string, string> {
  const marks: Record<string, string> = {};
  for (const holiday of holidays) {
    const [y, m, d] = holiday.date.split("-").map(Number);
    for (let i = 0; i < holiday.days; i++) {
      marks[isoDate(y!, m! - 1, d! + i)] = holiday.name;
    }
  }
  return marks;
}

export type HolidayMonth = {
  key: number;
  label: string;
  hasHolidays: boolean;
  cells: { key: string; day: number | null; holiday: string | null }[];
  names: string[];
};

/** Twelve mini month grids with the region's holidays highlighted. */
export function holidayYearGrid(holidays: Holiday[], year: number): HolidayMonth[] {
  const marks = holidayDateMap(holidays);

  return Array.from({ length: 12 }, (_, month) => {
    const cells: HolidayMonth["cells"] = [];
    const lead = firstWeekdayOfMonth(year, month);
    for (let i = 0; i < lead; i++) {
      cells.push({ key: `lead-${month}-${i}`, day: null, holiday: null });
    }

    const total = daysInMonth(year, month);
    for (let day = 1; day <= total; day++) {
      const date = isoDate(year, month, day);
      cells.push({ key: date, day, holiday: marks[date] ?? null });
    }

    const monthKey = String(month + 1).padStart(2, "0");
    const names = holidays
      .filter((h) => h.date.slice(5, 7) === monthKey)
      .map((h) => h.name);

    return {
      key: month,
      label: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month]!,
      hasHolidays: names.length > 0,
      cells,
      names,
    };
  });
}
