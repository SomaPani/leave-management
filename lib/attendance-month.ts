import { AttendanceModifier, AttendanceStatus } from "@/generated/prisma/enums";
import { daysInMonth, firstWeekdayOfMonth, isWeekend, isoDate } from "@/lib/date";
import { holidayNameByDate, type HolidayRecord } from "@/lib/holidays";

/**
 * One member's month: the grid and the summary, from one source.
 *
 * Both are computed here from the same `DayMark[]`, which is the point. The
 * screen this replaces built its grid from the resolved codes and its stat
 * cards from the raw record, so the two panels could describe the same month
 * differently.
 *
 * Pure — no Prisma, no session — so the percentage rule is unit testable.
 */

export type DayMark = {
  date: string;
  status: AttendanceStatus;
  modifier: AttendanceModifier | null;
};

export type MonthCell = {
  key: string;
  /** `null` for the padding cells before the 1st and after the last day. */
  day: number | null;
  date: string | null;
  weekend: boolean;
  /** The holiday covering this day, if any. */
  holiday: string | null;
  state: { status: AttendanceStatus; modifier: AttendanceModifier | null } | null;
};

export type MonthSummary = {
  present: number;
  wfh: number;
  half: number;
  absent: number;
  leave: number;
  /** The denominator: marked days that are not leave. */
  counted: number;
  /** The numerator: the sum of each counted day's value. */
  worked: number;
  /** Already formatted, `"—"` when nothing counts. */
  percent: string;
};

/**
 * What one day is worth, or `null` when it does not count at all.
 *
 * Scored per day rather than per code on purpose. Counting each code and
 * adding — `present + wfh + half * 0.5` — makes a `PRESENT + HALF_DAY` day
 * worth 1.5, which is exactly the shape of the bug this replaces.
 *
 * `SHORT_LEAVE` does not reduce the day: a couple of hours off is still a day
 * worked, and it is recorded so the pattern is visible, not so it can be
 * deducted.
 */
export function dayValue(mark: DayMark): number | null {
  if (mark.status === AttendanceStatus.LEAVE) return null;
  if (mark.status === AttendanceStatus.ABSENT) return 0;
  return mark.modifier === AttendanceModifier.HALF_DAY ? 0.5 : 1;
}

export function summarizeMonth(marks: DayMark[]): MonthSummary {
  let present = 0;
  let wfh = 0;
  let half = 0;
  let absent = 0;
  let leave = 0;
  let counted = 0;
  let worked = 0;

  for (const mark of marks) {
    switch (mark.status) {
      case AttendanceStatus.PRESENT:
        present++;
        break;
      case AttendanceStatus.WFH:
        wfh++;
        break;
      case AttendanceStatus.ABSENT:
        absent++;
        break;
      case AttendanceStatus.LEAVE:
        leave++;
        break;
    }
    if (mark.modifier === AttendanceModifier.HALF_DAY) half++;

    const value = dayValue(mark);
    if (value === null) continue;
    counted++;
    worked += value;
  }

  return {
    present,
    wfh,
    half,
    absent,
    leave,
    counted,
    worked,
    // An em dash, not 0%: a month nobody has marked yet has no attendance
    // figure, and showing zero would read as a month of absences.
    percent: counted === 0 ? "—" : `${Math.round((worked / counted) * 100)}%`,
  };
}

/** A 7-column grid of one member's month. `month` is 0-based. */
export function buildMonthCells(
  year: number,
  month: number,
  marks: DayMark[],
  holidays: HolidayRecord[],
): MonthCell[] {
  const byDate = new Map(marks.map((m) => [m.date, m]));
  const holidayNames = holidayNameByDate(holidays);

  const cells: MonthCell[] = [];
  const lead = firstWeekdayOfMonth(year, month);

  for (let i = 0; i < lead; i++) {
    cells.push({
      key: `lead-${i}`,
      day: null,
      date: null,
      weekend: false,
      holiday: null,
      state: null,
    });
  }

  const total = daysInMonth(year, month);
  for (let day = 1; day <= total; day++) {
    const date = isoDate(year, month, day);
    const mark = byDate.get(date);

    cells.push({
      key: date,
      day,
      date,
      weekend: isWeekend(date),
      holiday: holidayNames[date] ?? null,
      // A mark on a holiday is kept: somebody worked it, and hiding that would
      // lose a day the member may want to raise.
      state: mark ? { status: mark.status, modifier: mark.modifier } : null,
    });
  }

  while (cells.length % 7 !== 0) {
    cells.push({
      key: `tail-${cells.length}`,
      day: null,
      date: null,
      weekend: false,
      holiday: null,
      state: null,
    });
  }

  return cells;
}
