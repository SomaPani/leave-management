import type { AttendanceModifier, AttendanceStatus } from "@/generated/prisma/enums";
import { MONTH_NAMES, daysInMonth, isWeekend, isoDate } from "@/lib/date";

/**
 * What one day *was* for one person — the single rule the admin Overview, the
 * per-person history and the CSV export all read through.
 *
 * Pure on purpose: the order of the rules below is the whole design, and it is
 * cheap to pin with unit tests. First match wins:
 *
 *   1. a future date, or one before the person joined → not counted (null)
 *   2. an attendance mark → that mark (it is what actually happened, so it
 *      beats approved leave; a half day or short leave stays as the detail).
 *      On a weekend or holiday only a Present / WFH mark counts; a Leave or
 *      Absent mark on a day off is ignored.
 *   3. a holiday for the whole organization or the person's region → HOLIDAY
 *   4. Saturday or Sunday → WEEKEND
 *   5. approved day-based leave covering the date → LEAVE
 *   6. otherwise → NOT_MARKED
 *
 * Holiday and weekend come before leave because leave is charged in working
 * days only: a Saturday or a holiday inside a leave span is not a leave day.
 */

export type DayKind = "PRESENT" | "WFH" | "ABSENT" | "LEAVE" | "NOT_MARKED" | "HOLIDAY" | "WEEKEND";

export type CountedKind = "PRESENT" | "WFH" | "ABSENT" | "LEAVE" | "NOT_MARKED";

export type DayCounts = Record<CountedKind, number>;

export type DayFacts = {
  date: string;
  today: string;
  joinedOn: string | null;
  mark: { status: AttendanceStatus; modifier: AttendanceModifier | null } | null;
  leave: { policyName: string } | null;
  holiday: { name: string } | null;
};

export type ResolvedDay = { date: string; kind: DayKind; detail: string | null };

export const MODIFIER_DETAIL: Record<AttendanceModifier, string> = {
  HALF_DAY: "Half day",
  SHORT_LEAVE: "Short leave",
};

export function resolveDay(facts: DayFacts): ResolvedDay | null {
  const { date } = facts;
  if (date > facts.today) return null;
  if (facts.joinedOn && date < facts.joinedOn) return null;

  // A weekend or holiday is already a day off, so only a mark saying the
  // person *worked* it (Present / WFH) changes it. A Leave or Absent mark on
  // a Saturday — easy to make on the Attendance screen — is ignored rather
  // than counted as a leave or absent day.
  const dayOff = facts.holiday !== null || isWeekend(date);
  const worked = facts.mark?.status === "PRESENT" || facts.mark?.status === "WFH";

  if (facts.mark && (worked || !dayOff)) {
    const detail = facts.mark.modifier ? MODIFIER_DETAIL[facts.mark.modifier] : null;
    return { date, kind: facts.mark.status, detail };
  }
  if (facts.holiday) return { date, kind: "HOLIDAY", detail: facts.holiday.name };
  if (isWeekend(date)) return { date, kind: "WEEKEND", detail: null };
  if (facts.leave) return { date, kind: "LEAVE", detail: facts.leave.policyName };
  return { date, kind: "NOT_MARKED", detail: null };
}

export const COUNTED_KINDS: CountedKind[] = ["PRESENT", "WFH", "ABSENT", "LEAVE", "NOT_MARKED"];

export function countDays(days: ResolvedDay[]): DayCounts {
  const counts: DayCounts = { PRESENT: 0, WFH: 0, ABSENT: 0, LEAVE: 0, NOT_MARKED: 0 };
  for (const day of days) {
    if (day.kind !== "HOLIDAY" && day.kind !== "WEEKEND") counts[day.kind] += 1;
  }
  return counts;
}

/* --------------------------------------------------------------- periods -- */

export type Period = "month" | "quarter" | "year";

export const PERIODS: Period[] = ["month", "quarter", "year"];

/**
 * First month (1-12) of Q1. January means calendar quarters; set to 4 for an
 * April–March year.
 */
export const QUARTER_START_MONTH = 1;

function yearMonth(iso: string): { year: number; month: number } {
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) - 1 };
}

/** 0-based month offset of `month` from the quarter year's start. */
function quarterStart(year: number, month: number): { year: number; month: number; q: number } {
  const start = QUARTER_START_MONTH - 1;
  const offset = (month - start + 12) % 12;
  const q = Math.floor(offset / 3);
  const first = start + q * 3;
  // A quarter that starts before January belongs to the previous label year.
  const firstYear = month < start ? year - 1 : year;
  return { year: firstYear + Math.floor(first / 12), month: first % 12, q: q + 1 };
}

/** The span of the period containing `anchor`, clipped to `today`. */
export function periodRange(
  period: Period,
  anchor: string,
  today: string,
): { from: string; to: string; label: string } {
  const { year, month } = yearMonth(anchor);
  let from: string;
  let to: string;
  let label: string;

  if (period === "month") {
    from = isoDate(year, month, 1);
    to = isoDate(year, month, daysInMonth(year, month));
    label = `${MONTH_NAMES[month]} ${year}`;
  } else if (period === "quarter") {
    const start = quarterStart(year, month);
    from = isoDate(start.year, start.month, 1);
    const last = isoDate(start.year, start.month + 3, 0);
    to = last;
    label = `Q${start.q} ${QUARTER_START_MONTH === 1 ? start.year : `FY${start.year}`}`;
  } else {
    from = isoDate(year, 0, 1);
    to = isoDate(year, 11, 31);
    label = String(year);
  }

  return { from, to: to > today ? today : to, label };
}

/** A date inside the period `steps` periods away from the one holding `anchor`. */
export function shiftPeriod(period: Period, anchor: string, steps: number): string {
  const { year, month } = yearMonth(anchor);
  // Always land on the 1st, so stepping from Jan 31 cannot overflow into March.
  if (period === "month") return isoDate(year, month + steps, 1);
  if (period === "quarter") return isoDate(year, month + steps * 3, 1);
  return isoDate(year + steps, 0, 1);
}
