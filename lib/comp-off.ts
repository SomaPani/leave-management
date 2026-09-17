import { isWeekend } from "@/lib/date";
import { chargeYear } from "@/lib/leave";

/**
 * The comp-off rules that depend on nothing but dates.
 *
 * No Prisma import, for the same reason lib/leave.ts has none: the claim form
 * imports `claimableDay` into the browser, so the member is refused an
 * ordinary Tuesday before the round trip — by the same function
 * lib/comp-off-service.ts refuses it with afterwards, rather than by a second
 * copy of the rule that can drift from it.
 */

/**
 * Mirrors the `CompOffClaimStatus` enum in the schema. Declared here as a
 * string union rather than imported from the generated client, for the same
 * client-safety reason `LeaveUnitName` gives in lib/leave.ts.
 */
export type CompOffClaimStatusName = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";

/**
 * A claim as it arrives from a form or a JSON body, after parsing and before
 * any policy has been applied to it.
 *
 * Declared here rather than in lib/comp-off-service.ts — where
 * `LeaveRequestInput` sits for leave — because lib/comp-off-input.ts needs it
 * and this is the one file in the stack with no Prisma import. The parser
 * would otherwise reach into the service purely for a type, which is the
 * dependency that makes the pure module worth having.
 */
export type CompOffClaimInput = { workedOn: string; reason: string | null };

/**
 * Mirrors the `CompOffSource` enum in the schema, declared here as a string
 * union for the same client-safety reason `CompOffClaimStatusName` gives.
 *
 * `earnedByYearFrom` deliberately does not read it: a granted day and a
 * claimed day are the same credit. It exists for the audit, and to scope the
 * revoke on /setup so it can never withdraw a claim a member actually filed.
 */
export type CompOffSourceName = "CLAIM" | "ADMIN_GRANT";

/**
 * A grant as it arrives from the /setup form: a claim body plus the colleague
 * it is for.
 *
 * `userId` is the one field `CompOffClaimInput` cannot carry. A claim is
 * filed by its subject and so needs no id; a grant is filed *for* somebody,
 * and keeping the two shapes apart is what stops an id ever being read on the
 * self-scoped path.
 */
export type CompOffGrantInput = CompOffClaimInput & { userId: string };

/** The two decisions an approver can reach. A claim is not withdrawn by them. */
export type CompOffDecision = "APPROVED" | "REJECTED";

export type CompOffDecisionInput = { decision: CompOffDecision; note: string | null };

/**
 * Whether `workedOn` may be claimed as a comp-off: the refusal to show the
 * claimant, or `null` when it may.
 *
 * A sentence rather than a boolean because both callers have to say why — the
 * form beside the input, the service in a 400.
 *
 * The future check runs first, so a future Saturday is refused for being in
 * the future. That is the more accurate of the two refusals, and it avoids
 * implying the day would be fine if only it were a weekend, which it already
 * is.
 *
 * `offDates` is the claimant's *own* region's holidays, built by `offDates` in
 * lib/leave.ts from `listHolidays`. A date outside that set is an ordinary
 * working day for this member, whatever it may be for a colleague elsewhere.
 */
export function claimableDay(
  workedOn: string,
  today: string,
  offDates: ReadonlySet<string>,
): string | null {
  if (workedOn > today) {
    return "You cannot claim a comp-off for a day you have not worked yet.";
  }

  if (!isWeekend(workedOn) && !offDates.has(workedOn)) {
    return `${workedOn} was a working day. Comp-off is earned on a weekend or a holiday.`;
  }

  return null;
}

/**
 * Approved claims, counted into the calendar year each day was worked in.
 *
 * The shape `balanceAsOf` wants for an EARNED rule. Bucketing on `workedOn`
 * rather than on the decision date is what makes the lapse rule work: a Sunday
 * worked in December is a December credit however long the approval took, and
 * it expires with the rest of that year's.
 *
 * One claim is one day. There is no `days` column to sum — see section 2 of
 * Docs/2026-09-10-comp-off-design.md.
 */
export function earnedByYearFrom(
  claims: ReadonlyArray<{ workedOn: string }>,
): Map<number, number> {
  const byYear = new Map<number, number>();
  for (const claim of claims) {
    const year = chargeYear(claim.workedOn);
    byYear.set(year, (byYear.get(year) ?? 0) + 1);
  }
  return byYear;
}
