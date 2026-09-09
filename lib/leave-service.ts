// Prisma 7 generates each enum as a const object plus a same-named type, so
// one plain import gives both the values and the type.
import {
  EmploymentStatus,
  type LeaveAccrual,
  LeaveRequestStatus,
  type LeaveUnit,
  Role,
} from "@/generated/prisma/enums";
import { fromDbDate, toDbDate, todayIso } from "@/lib/attendance";
import { listHolidays } from "@/lib/holiday-service";
import {
  type LeaveAccrualName,
  type LeaveUnitName,
  balanceAsOf,
  chargeYear,
  costFrom,
  effectiveEndDate,
  offDates,
} from "@/lib/leave";
import { prisma } from "@/lib/prisma";
import {
  type Actor,
  HttpError,
  canApplyForLeave,
  canListLeavePolicies,
} from "@/lib/rbac";

/**
 * Everything that reads or writes leave policies and leave requests.
 *
 * Same contract as lib/holiday-service.ts: the route handlers and the Server
 * Action hand in an `Actor` they have already authenticated, and every
 * authorization decision is made here, once per operation.
 *
 * Every operation in this file is self-scoped. There is no `userId` parameter
 * anywhere in it — the applicant is the session — so there is no id for a
 * member to tamper with and no path that could reach a colleague's leave. The
 * roster-wide read belongs to /approvals and gets its own predicate when that
 * screen moves off the fixture.
 */

/** Requests in these states have already spent their days. */
// Exported for lib/leave-review-service.ts: a roster read that disagreed with
// this list about what "spent" means would show a balance no member's own
// screen agrees with.
export const SPENT: LeaveRequestStatus[] = [
  LeaveRequestStatus.PENDING,
  LeaveRequestStatus.APPROVED,
];

/** Shared empty map, so a policy with no history allocates nothing. */
const NO_USAGE: ReadonlyMap<number, number> = new Map();

const POLICY_FIELDS = {
  id: true,
  name: true,
  note: true,
  allowance: true,
  unit: true,
  carry: true,
  accrual: true,
  prorated: true,
  cap: true,
  effectiveFrom: true,
  active: true,
} as const;

// Exported for lib/leave-review-service.ts, which selects these fields plus
// the applicant and the deciding admin. One list, so a field added here
// reaches both screens.
export const REQUEST_FIELDS = {
  id: true,
  startDate: true,
  endDate: true,
  cost: true,
  reason: true,
  status: true,
  createdAt: true,
  decidedAt: true,
  decisionNote: true,
  policy: { select: { id: true, name: true, unit: true } },
  approver: { select: { id: true, name: true } },
} as const;

/**
 * A policy as the rest of the app sees it.
 *
 * This shape deliberately satisfies `CreditRule` in lib/leave.ts — allowance,
 * accrual, prorated, carry, cap and effectiveFrom — so it can be handed
 * straight to `balanceAsOf` with no adapter to keep in step.
 */
export type LeavePolicyRecord = {
  id: string;
  name: string;
  note: string | null;
  allowance: number;
  unit: LeaveUnitName;
  carry: boolean;
  accrual: LeaveAccrualName;
  prorated: boolean;
  cap: number | null;
  /** `YYYY-MM-DD`. */
  effectiveFrom: string;
  /**
   * False once a policy is retired. Retiring stops new applications; it does
   * not decide the requests already filed against it, so an approver still
   * sees these and needs to know which they are.
   */
  active: boolean;
};

export type LeaveBalanceRecord = LeavePolicyRecord & {
  /** How much of the entitlement has actually been credited by `asOf`. */
  credited: number;
  /** Days (or uses) spent in the calendar year `asOf` falls in. */
  used: number;
  /**
   * May exceed `cap` within a year, and may go negative: an over-balance
   * request is filed rather than refused.
   */
  balance: number;
};

export type ApproverRecord = { id: string; name: string } | null;

export type LeaveSummary = {
  /** The calendar year `asOf` falls in. */
  year: number;
  /** The date these balances were computed against, `YYYY-MM-DD`. */
  asOf: string;
  balances: LeaveBalanceRecord[];
  approver: ApproverRecord;
};

export type LeaveRequestInput = {
  policyId: string;
  startDate: string;
  /** Inclusive. The parser defaults it to `startDate` for a one-day request. */
  endDate: string;
  reason: string | null;
};

export type LeaveRequestRecord = {
  id: string;
  policy: { id: string; name: string; unit: LeaveUnitName };
  startDate: string;
  endDate: string;
  cost: number;
  reason: string | null;
  status: LeaveRequestStatus;
  approver: ApproverRecord;
  createdAt: string;
  /** ISO timestamp. Null while PENDING. */
  decidedAt: string | null;
  /**
   * The approver's reason. The member sees it: a rejection they cannot read
   * the reason for is the fixture's silence with a real status on it.
   *
   * `decidedById` is deliberately absent from this record. The applicant is
   * told the decision and the reason, not which admin in the building made
   * it; /approvals shows that, to admins, through `ReviewRequestRecord`.
   */
  decisionNote: string | null;
};

export type RequestRow = {
  id: string;
  startDate: Date;
  endDate: Date;
  cost: number;
  reason: string | null;
  status: LeaveRequestStatus;
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  policy: { id: string; name: string; unit: LeaveUnit };
  approver: { id: string; name: string } | null;
};

/**
 * The schema's enum as the client-safe union lib/leave.ts speaks.
 *
 * A function rather than a cast, so renaming a member of `LeaveUnit` fails the
 * type check right here instead of silently mispricing every USES request.
 */
function unitName(unit: LeaveUnit): LeaveUnitName {
  return unit;
}

/**
 * The schema's enum as the client-safe union lib/leave.ts speaks — the same
 * trick, and the same reason, as `unitName` above.
 */
function accrualName(accrual: LeaveAccrual): LeaveAccrualName {
  return accrual;
}

// Exported for lib/leave-review-service.ts. The date and enum conversions
// belong to the record shape, not to either caller.
export function toRecord(row: RequestRow): LeaveRequestRecord {
  return {
    id: row.id,
    policy: { ...row.policy, unit: unitName(row.policy.unit) },
    startDate: fromDbDate(row.startDate),
    endDate: fromDbDate(row.endDate),
    cost: row.cost,
    reason: row.reason,
    status: row.status,
    approver: row.approver,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
  };
}

/** The organization a caller may file leave in, or a 403. */
function applicantOrgFor(actor: Actor): string {
  const organizationId = actor.organizationId;
  if (!organizationId || !canApplyForLeave(actor)) {
    throw new HttpError(403, "Only a member of an organization can apply for leave.");
  }
  return organizationId;
}

/**
 * Who a request goes to: the applicant's manager, or failing that the
 * organization's longest-standing active admin, or nobody.
 *
 * A fallback rather than a requirement. A one-person organization and a member
 * whose manager has left are both real, and neither should leave somebody
 * unable to file at all.
 */
async function approverFor(
  manager: ApproverRecord,
  organizationId: string,
): Promise<ApproverRecord> {
  if (manager) return manager;

  return prisma.user.findFirst({
    where: { organizationId, role: Role.ADMIN, status: EmploymentStatus.ACTIVE },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
}

/* --------------------------------------------------------------- reading -- */

/**
 * One organization's active policies, in render order.
 *
 * Takes an organization id rather than an actor and decides nothing:
 * `listLeavePolicies` below is the authorized entry point, and `summaryFor`
 * is the other caller, which has already authorized in its own way.
 *
 * `includeRetired` is for the approver's view only. A member picking a leave
 * type must not be offered one that has been withdrawn from the scheme, but a
 * request filed before it was retired still has to be decided, and the admin
 * deciding it needs the same balance they would get for any other policy.
 */
async function policiesIn(
  organizationId: string,
  includeRetired = false,
): Promise<LeavePolicyRecord[]> {
  const rows = await prisma.leavePolicy.findMany({
    where: { organizationId, ...(includeRetired ? {} : { active: true }) },
    select: POLICY_FIELDS,
    orderBy: [{ position: "asc" }, { name: "asc" }],
  });

  return rows.map((row) => ({
    ...row,
    unit: unitName(row.unit),
    accrual: accrualName(row.accrual),
    effectiveFrom: fromDbDate(row.effectiveFrom),
  }));
}

export async function listLeavePolicies(actor: Actor): Promise<LeavePolicyRecord[]> {
  if (!canListLeavePolicies(actor) || !actor.organizationId) {
    throw new HttpError(403, "Your role does not permit this action.");
  }
  return policiesIn(actor.organizationId);
}

/**
 * Every policy with what one member has left of it, plus who their requests
 * go to.
 *
 * Takes the ids rather than an actor: it makes no authorization decision at
 * all. Its two callers do — `listOwnLeaveSummary` below, and `leaveSummaryFor`
 * in lib/leave-review-service.ts — and they must agree on the arithmetic to
 * the day, or the balance an approver reads on /approvals contradicts the one
 * the member read on /apply.
 *
 * The balance is derived rather than stored, and respects a credit schedule:
 * an EL day exists once its month has begun, so this answers 1 on 4 September
 * and 4 on 31 December for the same year. All of that arithmetic is in
 * lib/leave.ts; this function's job is to fetch what it needs.
 *
 * PENDING counts alongside APPROVED, or a member could file the same six days
 * three times before anyone looked at the first one. Withdrawn and rejected
 * requests free their days by falling out of the filter, which is the whole
 * reason there is no ledger to reconcile.
 *
 * Exported for that second caller only. Nothing outside those two should reach
 * a member's balance without deciding first whether it may.
 */
export async function summaryFor(
  organizationId: string,
  userId: string,
  asOf: string,
  includeRetired = false,
): Promise<LeaveSummary> {
  const applicant = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      joinedOn: true,
      manager: { select: { id: true, name: true } },
    },
  });
  // 404, where `listOwnLeaveSummary` used to answer 401 "Your account no
  // longer exists." A shared function has two callers now, and only one of
  // them is asking about themselves — "you have been deleted" is the wrong
  // sentence to show an admin who mistyped a member id.
  if (!applicant) throw new HttpError(404, "That member does not exist.");

  const [policies, spent, approver] = await Promise.all([
    // The policy list is the organization's, not the caller's, so an admin
    // reading a member's balance sees the entitlements that member is
    // actually measured against.
    policiesIn(organizationId, includeRetired),
    // Every spent request, not one year's. A carrying policy needs each year's
    // usage from its accrual start, because the cap is applied at every year
    // boundary and cannot be collapsed into one subtraction. This is a single
    // person's leave history, so it stays small.
    prisma.leaveRequest.findMany({
      where: { userId, status: { in: SPENT } },
      select: { policyId: true, startDate: true, cost: true },
    }),
    approverFor(applicant.manager, organizationId),
  ]);

  // policy id -> calendar year -> days spent.
  const usedByPolicy = new Map<string, Map<number, number>>();
  for (const row of spent) {
    const year = chargeYear(fromDbDate(row.startDate));
    const byYear = usedByPolicy.get(row.policyId) ?? new Map<number, number>();
    byYear.set(year, (byYear.get(year) ?? 0) + row.cost);
    usedByPolicy.set(row.policyId, byYear);
  }

  // `joinedOn` is a timestamp rather than a DATE column, but everything that
  // writes it stores UTC midnight, so the slice is exact.
  const joinedOn = applicant.joinedOn ? fromDbDate(applicant.joinedOn) : null;

  return {
    year: chargeYear(asOf),
    asOf,
    balances: policies.map((policy) => ({
      ...policy,
      ...balanceAsOf(policy, joinedOn, asOf, usedByPolicy.get(policy.id) ?? NO_USAGE),
    })),
    approver,
  };
}

/**
 * The signed-in member's own summary — one call, because the Apply screen
 * needs all of it at once.
 *
 * Self-scoped: the applicant is the session, so there is no id to tamper with.
 *
 * `asOf` is a parameter rather than always `todayIso()` so the credit schedule
 * can be tested at a chosen date without touching the clock.
 */
export async function listOwnLeaveSummary(
  actor: Actor,
  asOf: string = todayIso(),
): Promise<LeaveSummary> {
  return summaryFor(applicantOrgFor(actor), actor.id, asOf);
}

export async function listOwnLeaveRequests(
  actor: Actor,
): Promise<LeaveRequestRecord[]> {
  applicantOrgFor(actor);

  const rows = await prisma.leaveRequest.findMany({
    where: { userId: actor.id },
    select: REQUEST_FIELDS,
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
  });

  return rows.map(toRecord);
}

/**
 * One of the caller's own requests, or null.
 *
 * Scoped by `userId` inside the query rather than fetched and then checked, so
 * somebody else's id returns null down the same path a nonexistent one does.
 */
export async function findOwnLeaveRequest(
  actor: Actor,
  id: string,
): Promise<LeaveRequestRecord | null> {
  applicantOrgFor(actor);

  const row = await prisma.leaveRequest.findFirst({
    where: { id, userId: actor.id },
    select: REQUEST_FIELDS,
  });

  return row ? toRecord(row) : null;
}

/* --------------------------------------------------------------- writing -- */

export async function createOwnLeaveRequest(
  actor: Actor,
  input: LeaveRequestInput,
): Promise<LeaveRequestRecord> {
  if (!canApplyForLeave(actor)) {
    throw new HttpError(403, "Only a member of an organization can apply for leave.");
  }

  // The organization is read from the stored user, never taken from the
  // request. lib/attendance-service.ts follows the same rule for the same
  // reason: a denormalised tenancy column that trusts a body is a tenancy hole.
  const applicant = await prisma.user.findUnique({
    where: { id: actor.id },
    select: {
      organizationId: true,
      regionId: true,
      manager: { select: { id: true, name: true } },
    },
  });
  if (!applicant?.organizationId) {
    throw new HttpError(401, "Your account no longer exists.");
  }
  const organizationId = applicant.organizationId;

  const policy = await prisma.leavePolicy.findUnique({
    where: { id: input.policyId },
    select: { id: true, organizationId: true, unit: true, active: true },
  });
  // Scoped by the stored organizationId, so another organization's policy is
  // indistinguishable from one that does not exist. A retired policy answers
  // the same way: it is not a choice this member can make.
  if (!policy || policy.organizationId !== organizationId || !policy.active) {
    throw new HttpError(404, "That leave type does not exist.");
  }

  const unit = unitName(policy.unit);
  const startDate = input.startDate;
  const endDate = effectiveEndDate(unit, startDate, input.endDate);

  // `listHolidays` ignores the region a MEMBER asks for and uses their own, so
  // passing it here changes nothing for a member and gets an ADMIN's own
  // region right. A person with no region gets every region's holidays — the
  // same behaviour /calendar already has, and the reason to give everybody a
  // region rather than to special-case it here.
  const holidays = await listHolidays(actor, {
    from: startDate,
    to: endDate,
    regionId: applicant.regionId ?? undefined,
  });
  const cost = costFrom(unit, startDate, endDate, offDates(holidays));

  const approver = await approverFor(applicant.manager, organizationId);

  // The overlap check and the insert share a transaction, so two submits
  // racing each other cannot both pass the check. This narrows the window
  // rather than closing it: only a Postgres exclusion constraint over a
  // daterange would close it, and that is a bigger change than this screen
  // justifies today.
  const row = await prisma.$transaction(async (tx) => {
    const clash = await tx.leaveRequest.findFirst({
      where: {
        userId: actor.id,
        status: { in: SPENT },
        // Overlap, not containment: sharing a single day is enough.
        startDate: { lte: toDbDate(endDate) },
        endDate: { gte: toDbDate(startDate) },
      },
      select: { id: true },
    });
    if (clash) {
      throw new HttpError(409, "You already have a request covering those dates.");
    }

    return tx.leaveRequest.create({
      data: {
        organizationId,
        userId: actor.id,
        policyId: policy.id,
        startDate: toDbDate(startDate),
        endDate: toDbDate(endDate),
        cost,
        reason: input.reason,
        approverId: approver?.id ?? null,
      },
      select: REQUEST_FIELDS,
    });
  });

  return toRecord(row);
}

/**
 * The applicant takes their own pending request back.
 *
 * `PENDING` only. An approved absence the team has already planned around is
 * not the applicant's alone to cancel, and a rejected one has nothing to take
 * back.
 *
 * Scoped by `userId` inside the lookup rather than fetched and then checked,
 * so somebody else's id changes nothing and reports nothing — the same shape
 * `findOwnLeaveRequest` uses. The lookup and the update share a transaction,
 * so two submits racing each other cannot both pass the status check.
 */
export async function withdrawOwnLeaveRequest(
  actor: Actor,
  id: string,
): Promise<LeaveRequestRecord> {
  applicantOrgFor(actor);

  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.leaveRequest.findFirst({
      where: { id, userId: actor.id },
      select: { status: true },
    });
    if (!existing) throw new HttpError(404, "That request does not exist.");
    if (existing.status !== LeaveRequestStatus.PENDING) {
      throw new HttpError(409, "That request has already been decided.");
    }

    return tx.leaveRequest.update({
      where: { id },
      data: { status: LeaveRequestStatus.WITHDRAWN },
      select: REQUEST_FIELDS,
    });
  });

  return toRecord(row);
}
