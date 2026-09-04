// Prisma 7 generates each enum as a const object plus a same-named type, so
// one plain import gives both the values and the type.
import {
  EmploymentStatus,
  LeaveRequestStatus,
  type LeaveUnit,
  Role,
} from "@/generated/prisma/enums";
import { fromDbDate, toDbDate, todayIso } from "@/lib/attendance";
import { listHolidays } from "@/lib/holiday-service";
import {
  type LeaveUnitName,
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
const SPENT: LeaveRequestStatus[] = [
  LeaveRequestStatus.PENDING,
  LeaveRequestStatus.APPROVED,
];

const POLICY_FIELDS = {
  id: true,
  name: true,
  note: true,
  allowance: true,
  unit: true,
  carry: true,
} as const;

const REQUEST_FIELDS = {
  id: true,
  startDate: true,
  endDate: true,
  cost: true,
  reason: true,
  status: true,
  createdAt: true,
  policy: { select: { id: true, name: true, unit: true } },
  approver: { select: { id: true, name: true } },
} as const;

export type LeavePolicyRecord = {
  id: string;
  name: string;
  note: string | null;
  allowance: number;
  unit: LeaveUnitName;
  carry: boolean;
};

export type LeaveBalanceRecord = LeavePolicyRecord & {
  /** Days (or uses) already spent this year on PENDING and APPROVED requests. */
  used: number;
  /** May go negative: an over-balance request is filed, not refused. */
  balance: number;
};

export type ApproverRecord = { id: string; name: string } | null;

export type LeaveSummary = {
  year: number;
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
};

type RequestRow = {
  id: string;
  startDate: Date;
  endDate: Date;
  cost: number;
  reason: string | null;
  status: LeaveRequestStatus;
  createdAt: Date;
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

function toRecord(row: RequestRow): LeaveRequestRecord {
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

/** The DATE bounds of one calendar year. */
function yearWindow(year: number): { gte: Date; lte: Date } {
  return { gte: toDbDate(`${year}-01-01`), lte: toDbDate(`${year}-12-31`) };
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

export async function listLeavePolicies(actor: Actor): Promise<LeavePolicyRecord[]> {
  if (!canListLeavePolicies(actor) || !actor.organizationId) {
    throw new HttpError(403, "Your role does not permit this action.");
  }

  const rows = await prisma.leavePolicy.findMany({
    where: { organizationId: actor.organizationId, active: true },
    select: POLICY_FIELDS,
    orderBy: [{ position: "asc" }, { name: "asc" }],
  });

  return rows.map((row) => ({ ...row, unit: unitName(row.unit) }));
}

/**
 * Every policy with what this member has left of it, plus who their requests
 * go to — one call, because the Apply screen needs all of it at once.
 *
 * The balance is derived rather than stored: allowance minus the cost of the
 * requests that have already spent it. PENDING counts alongside APPROVED, or
 * a member could file the same six days three times before anyone looked at
 * the first one. Withdrawn and rejected requests free their days by falling
 * out of the filter, which is the whole reason there is no ledger to reconcile.
 */
export async function listOwnLeaveSummary(
  actor: Actor,
  year: number = chargeYear(todayIso()),
): Promise<LeaveSummary> {
  const organizationId = applicantOrgFor(actor);

  const applicant = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { manager: { select: { id: true, name: true } } },
  });
  if (!applicant) throw new HttpError(401, "Your account no longer exists.");

  const [policies, spent, approver] = await Promise.all([
    listLeavePolicies(actor),
    prisma.leaveRequest.groupBy({
      by: ["policyId"],
      where: {
        userId: actor.id,
        status: { in: SPENT },
        startDate: yearWindow(year),
      },
      _sum: { cost: true },
    }),
    approverFor(applicant.manager, organizationId),
  ]);

  const usedByPolicy = new Map(spent.map((row) => [row.policyId, row._sum.cost ?? 0]));

  return {
    year,
    balances: policies.map((policy) => {
      const used = usedByPolicy.get(policy.id) ?? 0;
      return { ...policy, used, balance: policy.allowance - used };
    }),
    approver,
  };
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
