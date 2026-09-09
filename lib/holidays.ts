import { addDays, daysInMonth, isoDate } from "@/lib/date";
import { HttpError } from "@/lib/rbac";

/**
 * Holiday shaping, as pure functions.
 *
 * No Prisma and no session, so the range arithmetic is unit testable on its
 * own — the same split lib/attendance.ts has from lib/attendance-service.ts.
 *
 * A holiday is an inclusive `startDate`–`endDate` range. Most are one day, so
 * most ranges have both ends equal.
 */

export type HolidayRecord = {
  id: string;
  name: string;
  /** Inclusive, `YYYY-MM-DD`. */
  startDate: string;
  endDate: string;
  note: string | null;
  /** `null` means the holiday applies to every region. */
  region: { id: string; name: string } | null;
};

/** Every date a holiday covers, ascending. */
export function holidayDates(
  holiday: Pick<HolidayRecord, "startDate" | "endDate">,
): string[] {
  const dates: string[] = [];
  // Guarded by the CHECK constraint, but a reversed range read from anywhere
  // else must terminate rather than loop forever.
  for (
    let date = holiday.startDate;
    date <= holiday.endDate;
    date = addDays(date, 1)
  ) {
    dates.push(date);
  }
  return dates;
}

/**
 * Every covered day mapped to its holiday's name, for painting a calendar
 * grid. A later holiday wins an overlap, which only happens when an
 * organization has entered two holidays on one day.
 */
export function holidayNameByDate(
  holidays: HolidayRecord[],
): Record<string, string> {
  const marks: Record<string, string> = {};
  for (const holiday of holidays) {
    for (const date of holidayDates(holiday)) marks[date] = holiday.name;
  }
  return marks;
}

/** The first and last day of a month, `YYYY-MM-DD`. `month` is 0-based. */
export function monthBounds(
  year: number,
  month: number,
): { from: string; to: string } {
  return {
    from: isoDate(year, month, 1),
    to: isoDate(year, month, daysInMonth(year, month)),
  };
}

function overlaps(holiday: HolidayRecord, from: string, to: string): boolean {
  return holiday.startDate <= to && holiday.endDate >= from;
}

function byStart(a: HolidayRecord, b: HolidayRecord): number {
  return a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0;
}

/**
 * Holidays touching a month — overlap, not containment, so a break that runs
 * from 30 August to 2 September appears in both months rather than neither.
 */
export function holidaysInMonth(
  holidays: HolidayRecord[],
  year: number,
  month: number,
): HolidayRecord[] {
  const { from, to } = monthBounds(year, month);
  return holidays.filter((h) => overlaps(h, from, to)).sort(byStart);
}

export function holidaysInYear(
  holidays: HolidayRecord[],
  year: number,
): HolidayRecord[] {
  const from = isoDate(year, 0, 1);
  const to = isoDate(year, 11, 31);
  return holidays.filter((h) => overlaps(h, from, to)).sort(byStart);
}

/**
 * A calendar year, or a 400.
 *
 * Bounded rather than merely numeric: the member calendar takes `?y=` straight
 * from the URL, and an unbounded year renders an empty grid for a date that
 * cannot mean anything.
 */
export function parseYearParam(value: unknown, field = "year"): number {
  const year = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new HttpError(400, `"${field}" must be a year between 2000 and 2100.`);
  }
  return year;
}
