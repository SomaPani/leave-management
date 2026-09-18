import { addDays, formatRange, isWeekend } from "@/lib/date";

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

/* ------------------------------------------------------ credit schedule -- */

/**
 * Mirrors the `LeaveAccrual` enum in the schema. Declared here as a string
 * union rather than imported from the generated client, for the same
 * client-safety reason as `LeaveUnitName`.
 */
/**
 * The longest a short leave may run. Past four hours it is half a day, which
 * is a different leave type and a different conversation.
 *
 * Deliberately not a CHECK constraint: it is a policy that may reasonably
 * change, and enforcing it in the database would make changing it a
 * migration.
 */
export const MAX_SHORT_LEAVE_MINUTES = 240;

/**
 * `"15:00"` -> `900`, or null when the value is not a real clock time.
 *
 * A single-digit hour is accepted because not every browser pads what its
 * `<input type="time">` submits, and refusing `"9:45"` would be a refusal
 * about the browser rather than about the member.
 */
export function parseClockTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

/**
 * `900` -> `"3:00 PM"`. The one place the display format is decided, so the
 * apply form, the approvals queue and the member's own list cannot drift.
 *
 * The `% 12 || 12` is what keeps noon from rendering as "0:00 PM" and
 * midnight from rendering as "0:00 AM" — the two cases a 12-hour clock gets
 * wrong, and the reason both have a test.
 */
export function formatClockTime(minutes: number): string {
  const hours24 = Math.floor(minutes / 60);
  const hours12 = hours24 % 12 || 12;
  const rest = String(minutes % 60).padStart(2, "0");
  return `${hours12}:${rest} ${hours24 < 12 ? "AM" : "PM"}`;
}

/**
 * When a leave request happens, for the one line every screen shows.
 *
 * `Sep 17` for a day, `Sep 17 – Sep 21` for a span, and
 * `Sep 17 · 3:00 PM – 5:00 PM` for a short leave. One function rather than
 * two call sites formatting a row each, so /approvals and the member's own
 * list cannot describe the same request two different ways.
 *
 * It lives here rather than beside `formatRange` in lib/date.ts because
 * lib/date.ts imports nothing at all: reaching back for `formatClockTime`
 * would close a cycle. It goes where the dependency already points.
 */
export function formatWhen(
  from: string,
  to: string,
  startTime: number | null,
  endTime: number | null,
): string {
  const dates = formatRange(from, to);
  if (startTime === null || endTime === null) return dates;
  return `${dates} · ${formatClockTime(startTime)} – ${formatClockTime(endTime)}`;
}

/**
 * Whether two half-open ranges share any minute.
 *
 * Half-open on purpose: a range that ends at 11:00 and one that starts at
 * 11:00 do not overlap, because the member is back. Touching endpoints is
 * the case this would otherwise get wrong, so it has a test in both
 * directions.
 */
export function timesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Whether these times may be filed against this policy on this date: the
 * refusal to show the member, or null when they may.
 *
 * A sentence rather than a boolean because both callers have to say why — the
 * form beside the inputs, the service in a 400. The shape `claimableDay` in
 * lib/comp-off.ts established.
 *
 * Rules 1, 2 and 3 of the spec live here together because they are one
 * question from a caller's side — may this be filed? — and splitting them
 * would put three refusals in three places that must agree.
 *
 * The hours are never compared to the clock. Filing at 5 PM for 3:00-5:00 PM
 * is accepted: people step out first and file afterwards, an approver still
 * decides it, and a rule that changes with the time of day is one nobody can
 * predict.
 */
export function shortLeaveTimes(
  unit: LeaveUnitName,
  startTime: number | null,
  endTime: number | null,
  startDate: string,
  today: string,
): string | null {
  if (unit !== "USES") {
    return startTime === null && endTime === null
      ? null
      : "That leave type is taken in whole days, not hours.";
  }

  if (startTime === null || endTime === null) {
    return "A short leave needs a start and an end time.";
  }

  if (startDate !== today) {
    return "A short leave can only be taken today.";
  }

  if (endTime <= startTime) {
    return "The end time must be after the start time.";
  }

  if (endTime - startTime > MAX_SHORT_LEAVE_MINUTES) {
    return "A short leave cannot run longer than four hours.";
  }

  return null;
}

export type LeaveAccrualName = "UPFRONT" | "MONTHLY" | "EARNED";

/**
 * The default earned map, for every policy whose credit comes from a
 * schedule. `NO_USAGE` in lib/leave-service.ts is the same thing for the
 * other direction, and is not importable here without inverting the
 * dependency between the two files.
 */
const NO_EARNED: ReadonlyMap<number, number> = new Map();

/**
 * A policy's crediting configuration — everything the arithmetic below needs
 * and nothing it does not. `lib/leave-service.ts` builds one of these from a
 * `LeavePolicy` row.
 */
export type CreditRule = {
  /** Days (or uses) for a whole year. Ignored by an EARNED rule, whose credit
   * is one day per approved comp-off claim and has no yearly share. */
  allowance: number;
  accrual: LeaveAccrualName;
  /** UPFRONT only: scale a partial first year down. */
  prorated: boolean;
  /** Whether an unused balance survives 31 December. */
  carry: boolean;
  /** Ceiling on a carried balance. Null means none. */
  cap: number | null;
  /** The day this entitlement starts existing, `YYYY-MM-DD`. */
  effectiveFrom: string;
};

/** The first of the month a date falls in. */
function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Months since year zero, so two dates can be subtracted by month. */
function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

/** 1-based month number: January is 1. */
function monthOf(date: string): number {
  return Number(date.slice(5, 7));
}

/**
 * The first day a member accrues under a policy: the later of the scheme
 * start and the first of their join month.
 *
 * The join month therefore only matters for somebody who joins *after* the
 * scheme begins. Everyone already employed starts together on the scheme
 * date, however long they have been here — that is what makes 2026 a
 * four-month year for the whole organization rather than a different one per
 * person.
 *
 * A member with no recorded join date accrues from the scheme start. That is
 * every ADMIN today, and it is the right answer for them: they were here.
 *
 * Both ends are normalised to a month boundary, so a scheme configured to
 * start mid-month still credits from that month's first.
 */
export function accrualStart(rule: CreditRule, joinedOn: string | null): string {
  const scheme = firstOfMonth(rule.effectiveFrom);
  if (!joinedOn) return scheme;

  const joined = firstOfMonth(joinedOn);
  return joined > scheme ? joined : scheme;
}

/**
 * How much of `year`'s entitlement has actually been credited by `asOf`.
 *
 * Not the same question as "what is this member entitled to this year": a
 * MONTHLY policy answers 1 on 4 September and 4 on 31 December for the same
 * year, because the days arrive one at a time.
 *
 * `earnedByYear` is comp-off credit, keyed by the year each day was worked in
 * — see `earnedByYearFrom` in lib/comp-off.ts. It is only read for an EARNED
 * rule, and defaults to empty so every scheduled policy's call site is
 * unchanged.
 */
export function creditedInYear(
  rule: CreditRule,
  joinedOn: string | null,
  year: number,
  asOf: string,
  earnedByYear: ReadonlyMap<number, number> = NO_EARNED,
): number {
  // Earned credit has no schedule: it exists because a day was worked, so
  // neither the scheme start nor the member's join month bears on it, and
  // there is no yearly share to prorate. A day earned in a member's first
  // week is theirs. Returned before any of that arithmetic runs, rather than
  // after it with the result discarded.
  if (rule.accrual === "EARNED") return earnedByYear.get(year) ?? 0;

  const start = accrualStart(rule, joinedOn);
  const january = `${year}-01-01`;
  const december = `${year}-12-31`;

  // The first day of this year the member accrues on.
  const from = start > january ? start : january;

  // Accrual begins after this year ends, or has not reached `asOf` yet.
  if (from > december || from > asOf) return 0;

  if (rule.accrual === "MONTHLY") {
    const to = asOf < december ? asOf : december;
    const months = monthIndex(to) - monthIndex(from) + 1;
    // Multiply before dividing so a whole year is exact. The
    // LeavePolicy_monthly_divisible CHECK keeps allowance/12 a whole number
    // in the database; flooring here means a misconfiguration reaching this
    // function degrades to a smaller credit rather than a fractional day.
    return Math.floor((rule.allowance * months) / 12);
  }

  if (!rule.prorated) return rule.allowance;

  // January leaves 12 months, September leaves 4.
  const remainingMonths = 13 - monthOf(from);
  return Math.floor((rule.allowance * remainingMonths) / 12);
}

/**
 * One policy's balance for one member, as of a date.
 *
 * `usedByYear` maps a calendar year to the days already spent in it. A
 * request is bucketed by the year its *start date* falls in, which is what
 * `chargeYear` decides.
 *
 * A policy that lapses is one subtraction. A policy that carries has to walk
 * the years from its accrual start, because the cap applies at each boundary
 * and a single lifetime subtraction cannot express that: capping
 * `creditedEver - usedEver` lets the days the cap discarded flow back in to
 * replace days the member later spends, so spending ten days would leave a
 * capped balance unmoved. See section 2.5 of the design.
 *
 * `balance` may exceed the cap within a year — an opening of 20 plus a fresh
 * 12 reaches 32 — and may go negative, because an over-balance request is
 * filed rather than refused.
 */
export function balanceAsOf(
  rule: CreditRule,
  joinedOn: string | null,
  asOf: string,
  usedByYear: ReadonlyMap<number, number>,
  earnedByYear: ReadonlyMap<number, number> = NO_EARNED,
): { credited: number; used: number; balance: number } {
  const year = chargeYear(asOf);
  const used = usedByYear.get(year) ?? 0;
  const thisYear = creditedInYear(rule, joinedOn, year, asOf, earnedByYear);

  if (!rule.carry) {
    return { credited: thisYear, used, balance: thisYear - used };
  }

  // An EARNED rule cannot reach the walk below — the
  // LeavePolicy_earned_lapses CHECK forbids it carrying — but the map is
  // passed anyway rather than relying on that from a distance.
  let opening = 0;
  for (let y = chargeYear(accrualStart(rule, joinedOn)); y < year; y++) {
    const closing =
      opening +
      creditedInYear(rule, joinedOn, y, `${y}-12-31`, earnedByYear) -
      (usedByYear.get(y) ?? 0);
    opening = rule.cap === null ? closing : Math.min(rule.cap, closing);
  }

  return {
    credited: opening + thisYear,
    used,
    balance: opening + thisYear - used,
  };
}
