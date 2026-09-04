import { addDays, isWeekend } from "@/lib/date";

/**
 * The leave arithmetic, as pure functions.
 *
 * No Prisma and no session here, so the whole rule set is unit testable — the
 * same split lib/attendance.ts has from lib/attendance-service.ts.
 *
 * This module is also imported by components/apply-form.tsx, a client
 * component, so that the cost previewed while typing and the cost written to
 * the database come from the same function and cannot disagree. That is why it
 * imports lib/date.ts and nothing else: lib/holidays.ts would reach
 * lib/rbac.ts and pull the generated Prisma client into the browser bundle.
 */

/**
 * Mirrors the `LeaveUnit` enum in the schema.
 *
 * Declared as a string union rather than imported from `@/generated/prisma/enums`
 * for the client-safety reason above. `lib/leave-service.ts` converts between
 * the two through a one-line function, so a rename in the schema breaks the
 * build there rather than silently at runtime here.
 */
export type LeaveUnitName = "DAYS" | "USES";

/**
 * An inclusive span of days — the shape of a holiday, described structurally.
 *
 * `HolidayRecord` from lib/holidays.ts is assignable to this without a cast,
 * which is the whole point: the server passes holidays straight in, and the
 * client passes a plain list of dates it already has.
 */
export type DateRange = { startDate: string; endDate: string };

/** Every date in an inclusive range, ascending. Empty if the range is reversed. */
export function datesInRange(from: string, to: string): string[] {
  const dates: string[] = [];
  // A reversed range must terminate rather than loop forever: the CHECK
  // constraint guards the table, but this function is called on form input
  // that has not reached it yet.
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

/** Every day covered by any of the ranges, as a set for O(1) lookup. */
export function offDates(ranges: readonly DateRange[]): Set<string> {
  const dates = new Set<string>();
  for (const range of ranges) {
    for (const date of datesInRange(range.startDate, range.endDate)) dates.add(date);
  }
  return dates;
}

/**
 * The days a request actually costs: weekdays in the range that are not
 * already off.
 *
 * A holiday falling on a Saturday discounts nothing, because the Saturday was
 * never chargeable — the filter is one pass, not two subtractions.
 */
export function chargeableDays(
  from: string,
  to: string,
  off: ReadonlySet<string>,
): string[] {
  return datesInRange(from, to).filter((date) => !isWeekend(date) && !off.has(date));
}

/**
 * What a request costs against its policy.
 *
 * A `USES` policy is one occurrence however long the range is — a short leave
 * taken on a Saturday still spends the one use.
 */
export function costFrom(
  unit: LeaveUnitName,
  from: string,
  to: string,
  off: ReadonlySet<string>,
): number {
  return unit === "USES" ? 1 : chargeableDays(from, to, off).length;
}

/**
 * The end date actually stored.
 *
 * A `USES` request collapses to its start day, so the stored row says what the
 * request means rather than what the form happened to be showing.
 */
export function effectiveEndDate(
  unit: LeaveUnitName,
  from: string,
  to: string,
): string {
  return unit === "USES" ? from : to;
}

/**
 * The calendar year a request is charged to.
 *
 * The year of the *start* date, so a request running 30 December to 2 January
 * belongs entirely to the year it began in. Splitting it across two balances
 * would be more accurate and much harder to explain to the person filing it.
 */
export function chargeYear(startDate: string): number {
  return Number(startDate.slice(0, 4));
}

/** `day`/`days` for a DAYS policy, `use`/`uses` for a USES one. */
export function unitNoun(unit: LeaveUnitName, count: number): string {
  const singular = Math.abs(count) === 1;
  if (unit === "USES") return singular ? "use" : "uses";
  return singular ? "day" : "days";
}
