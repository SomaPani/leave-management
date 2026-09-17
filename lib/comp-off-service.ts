import {
  CompOffClaimStatus,
  CompOffSource,
  EmploymentStatus,
  Role,
} from "@/generated/prisma/enums";
import { fromDbDate, toDbDate, todayIso } from "@/lib/attendance";
import {
  type CompOffClaimInput,
  type CompOffClaimStatusName,
  type CompOffDecisionInput,
  type CompOffGrantInput,
  type CompOffSourceName,
  claimableDay,
  earnedByYearFrom,
} from "@/lib/comp-off";
import { listHolidays } from "@/lib/holiday-service";
import { offDates } from "@/lib/leave";
import { type ApproverRecord, approverFor } from "@/lib/approver";
import { prisma } from "@/lib/prisma";
import {
  type Actor,
  HttpError,
  canClaimCompOff,
  canGrantCompOff,
  canListCompOffClaims,
  canReviewCompOff,
  canRevokeCompOffGrant,
  visibleOrgId,
} from "@/lib/rbac";

/**
 * Everything that reads or writes CompOffClaim.
 *
 * The same contract as lib/leave-service.ts: every entry point authorizes in
 * exactly one place, and the self-scoped reads take no user id at all, so a
 * member has no id to change into a colleague's.
 *
 * An APPROVED claim *is* the credit. There is no ledger table to keep in step
 * with these rows — `earnedByYearFor` below counts them, and that count is
 * what lib/leave-service.ts hands to `balanceAsOf`. See
 * Docs/2026-09-10-comp-off-design.md section 3.1.
 */

const CLAIM_FIELDS = {
  id: true,
  workedOn: true,
  reason: true,
  status: true,
  createdAt: true,
  decidedAt: true,
  decisionNote: true,
  approver: { select: { id: true, name: true } },
} as const;

type ClaimRow = {
  id: string;
  workedOn: Date;
  reason: string | null;
  status: CompOffClaimStatus;
  createdAt: Date;
  decidedAt: Date | null;
  decisionNote: string | null;
  approver: ApproverRecord;
};

export type CompOffClaimRecord = {
  id: string;
  workedOn: string;
  reason: string | null;
  status: CompOffClaimStatusName;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  approver: ApproverRecord;
};

/**
 * The statuses that hold a day.
 *
 * A withdrawn or rejected claim frees it, which is the whole reason there is
 * no `@@unique([userId, workedOn])` on the table: the constraint is partial,
 * so it lives here rather than in the schema.
 */
const HELD: CompOffClaimStatus[] = [
  CompOffClaimStatus.PENDING,
  CompOffClaimStatus.APPROVED,
];

function toRecord(row: ClaimRow): CompOffClaimRecord {
  return {
    id: row.id,
    workedOn: fromDbDate(row.workedOn),
    reason: row.reason,
    status: row.status,
    approver: row.approver,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
  };
}

/** The organization a caller may claim in, or a 403. */
function claimantOrgFor(actor: Actor): string {
  const organizationId = actor.organizationId;
  if (!organizationId || !canClaimCompOff(actor)) {
    throw new HttpError(403, "Only a member of an organization can claim a comp-off.");
  }
  return organizationId;
}

/* --------------------------------------------------------------- reading -- */

/**
 * The caller's own claims, newest worked day first.
 *
 * Self-scoped: the claimant is the session, so there is no id parameter and
 * nothing for a member to tamper with — the convention
 * `listOwnLeaveRequests` set.
 */
export async function listOwnCompOffClaims(
  actor: Actor,
): Promise<CompOffClaimRecord[]> {
  claimantOrgFor(actor);

  const rows = await prisma.compOffClaim.findMany({
    where: { userId: actor.id },
    select: CLAIM_FIELDS,
    orderBy: [{ workedOn: "desc" }, { createdAt: "desc" }],
  });

  return rows.map(toRecord);
}

/**
 * One member's approved claims, counted into the year each was worked in.
 *
 * Lives here rather than in lib/leave-service.ts so the claim table's read
 * rules stay in one file. It takes a plain id and makes no authorization
 * decision: its caller, `summaryFor`, has already made one — the same
 * contract `summaryFor` itself has.
 *
 * Every year is fetched, not just the current one. A carrying policy needs
 * that and an EARNED one does not, but the row count is one member's claims
 * and the filter would be a second place to get the year boundary wrong.
 */
export async function earnedByYearFor(userId: string): Promise<Map<number, number>> {
  const rows = await prisma.compOffClaim.findMany({
    where: { userId, status: CompOffClaimStatus.APPROVED },
    select: { workedOn: true },
  });

  return earnedByYearFrom(rows.map((row) => ({ workedOn: fromDbDate(row.workedOn) })));
}

/* --------------------------------------------------------------- writing -- */

/**
 * File a claim for a day already worked.
 *
 * Step for step the shape of `createOwnLeaveRequest`: authorize, read the
 * stored user for the organization and region, fetch that region's holidays,
 * validate, resolve the approver, then check and insert in one transaction.
 */
export async function createOwnCompOffClaim(
  actor: Actor,
  input: CompOffClaimInput,
): Promise<CompOffClaimRecord> {
  claimantOrgFor(actor);

  // The organization is read from the stored user, never taken from the
  // request. lib/attendance-service.ts follows the same rule for the same
  // reason: a denormalised tenancy column that trusts a body is a tenancy hole.
  const claimant = await prisma.user.findUnique({
    where: { id: actor.id },
    select: {
      organizationId: true,
      regionId: true,
      manager: { select: { id: true, name: true } },
    },
  });
  if (!claimant?.organizationId) {
    throw new HttpError(401, "Your account no longer exists.");
  }
  const organizationId = claimant.organizationId;

  // `listHolidays` ignores the region a MEMBER asks for and uses their own,
  // so passing it changes nothing for a member and gets an ADMIN's own region
  // right — the same call `createOwnLeaveRequest` makes.
  const holidays = await listHolidays(actor, {
    from: input.workedOn,
    to: input.workedOn,
    regionId: claimant.regionId ?? undefined,
  });

  const refusal = claimableDay(input.workedOn, todayIso(), offDates(holidays));
  if (refusal) throw new HttpError(400, refusal);

  const approver = await approverFor(claimant.manager, organizationId);

  // The duplicate check and the insert share a transaction, so two submits
  // racing each other cannot both pass it. This narrows the window rather
  // than closing it: only a partial unique index over (userId, workedOn)
  // where status in (PENDING, APPROVED) would close it, and that is a bigger
  // change than this screen justifies today — the same trade
  // `createOwnLeaveRequest` documents for its overlap check.
  const row = await prisma.$transaction(async (tx) => {
    const held = await tx.compOffClaim.findFirst({
      where: {
        userId: actor.id,
        workedOn: toDbDate(input.workedOn),
        status: { in: HELD },
      },
      select: { id: true },
    });
    if (held) {
      throw new HttpError(409, "You have already claimed that day.");
    }

    return tx.compOffClaim.create({
      data: {
        organizationId,
        userId: actor.id,
        workedOn: toDbDate(input.workedOn),
        reason: input.reason,
        approverId: approver?.id ?? null,
      },
      select: CLAIM_FIELDS,
    });
  });

  return toRecord(row);
}

/**
 * The claimant takes their own pending claim back.
 *
 * `PENDING` only: an approved credit has already been spent against, and a
 * rejected one has nothing to take back.
 *
 * Scoped by `userId` inside the lookup rather than fetched and then checked,
 * so somebody else's id changes nothing and reports nothing. The lookup and
 * the update share a transaction, so two submits racing cannot both pass the
 * status check.
 */
export async function withdrawOwnCompOffClaim(
  actor: Actor,
  id: string,
): Promise<CompOffClaimRecord> {
  claimantOrgFor(actor);

  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.compOffClaim.findFirst({
      where: { id, userId: actor.id },
      select: { status: true },
    });
    if (!existing) throw new HttpError(404, "That claim does not exist.");
    if (existing.status !== CompOffClaimStatus.PENDING) {
      throw new HttpError(409, "That claim has already been decided.");
    }

    return tx.compOffClaim.update({
      where: { id },
      data: { status: CompOffClaimStatus.WITHDRAWN },
      select: CLAIM_FIELDS,
    });
  });

  return toRecord(row);
}

/* -------------------------------------------------------------- approving -- */

const REVIEW_CLAIM_FIELDS = {
  ...CLAIM_FIELDS,
  user: { select: { id: true, name: true, email: true } },
  decidedBy: { select: { id: true, name: true } },
} as const;

type ReviewClaimRow = ClaimRow & {
  user: { id: string; name: string; email: string };
  decidedBy: { id: string; name: string } | null;
};

export type ReviewCompOffRecord = CompOffClaimRecord & {
  user: { id: string; name: string; email: string };
  decidedBy: { id: string; name: string } | null;
};

function toReviewRecord(row: ReviewClaimRow): ReviewCompOffRecord {
  return { ...toRecord(row), user: row.user, decidedBy: row.decidedBy };
}

/**
 * The organization a list read is scoped to, or a 403.
 *
 * An empty object means every organization and is only ever returned for a
 * SuperAdmin — the shape `scopeFor` in lib/leave-review-service.ts uses, so
 * the two queues cannot disagree about who sees what.
 */
function scopeFor(actor: Actor): { organizationId?: string } {
  if (!canListCompOffClaims(actor)) {
    throw new HttpError(403, "Your role does not permit this action.");
  }
  const organizationId = visibleOrgId(actor);
  return organizationId ? { organizationId } : {};
}

/** One organization's claims, oldest filing first. */
export async function listCompOffClaims(
  actor: Actor,
  filter: { status?: CompOffClaimStatus } = {},
): Promise<ReviewCompOffRecord[]> {
  const rows = await prisma.compOffClaim.findMany({
    where: {
      ...scopeFor(actor),
      ...(filter.status ? { status: filter.status } : {}),
    },
    select: REVIEW_CLAIM_FIELDS,
    orderBy: { createdAt: "asc" },
  });

  return rows.map(toReviewRecord);
}

/** One claim in the caller's own organization, or null. */
export async function findCompOffClaim(
  actor: Actor,
  id: string,
): Promise<ReviewCompOffRecord | null> {
  const row = await prisma.compOffClaim.findFirst({
    where: { id, ...scopeFor(actor) },
    select: REVIEW_CLAIM_FIELDS,
  });

  return row ? toReviewRecord(row) : null;
}

/** The Approvals badge in app/(leave)/layout.tsx, summed with the leave count. */
export async function countPendingCompOffClaims(actor: Actor): Promise<number> {
  return prisma.compOffClaim.count({
    where: { ...scopeFor(actor), status: CompOffClaimStatus.PENDING },
  });
}

/**
 * An admin approves or rejects a claim.
 *
 * Step for step `decideLeaveRequest`: the note check before the row is
 * loaded, 404 rather than 403 for another organization, authorization on the
 * stored columns, the status check, all inside one transaction so two admins
 * deciding at once cannot both win.
 */
export async function decideCompOffClaim(
  actor: Actor,
  id: string,
  input: CompOffDecisionInput,
): Promise<ReviewCompOffRecord> {
  // Refusing somebody's earned day without saying why is the one case worth
  // forcing a sentence for. Checked before the row is loaded: it is a fact
  // about the input, not about the claim.
  if (input.decision === "REJECTED" && !input.note) {
    throw new HttpError(400, "A rejection needs a reason.");
  }

  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.compOffClaim.findUnique({
      where: { id },
      select: { organizationId: true, userId: true, status: true },
    });
    // Outside the caller's organization is indistinguishable from nonexistent.
    if (!existing) throw new HttpError(404, "That claim does not exist.");
    if (visibleOrgId(actor) !== null && existing.organizationId !== actor.organizationId) {
      throw new HttpError(404, "That claim does not exist.");
    }
    // Authorized on the stored columns, never on anything a caller sent.
    if (!canReviewCompOff(actor, existing.organizationId, existing.userId)) {
      throw new HttpError(403, "Your role does not permit this action.");
    }
    if (existing.status !== CompOffClaimStatus.PENDING) {
      throw new HttpError(409, "That claim has already been decided.");
    }

    return tx.compOffClaim.update({
      where: { id },
      data: {
        status: input.decision,
        decidedAt: new Date(),
        decidedById: actor.id,
        decisionNote: input.note,
      },
      select: REVIEW_CLAIM_FIELDS,
    });
  });

  return toReviewRecord(row);
}

/* ---------------------------------------------------------------- grants -- */

export type CompOffGranteeRecord = {
  id: string;
  name: string;
  email: string;
  role: Role;
};

/**
 * Who this admin may grant a comp-off to: every active person in their own
 * organization except themselves.
 *
 * Not `listMembers`, which hard-filters `role: MEMBER`. Rule 4 of
 * Docs/2026-09-16-comp-off-admin-grant-design.md puts the other admins on
 * this list, on the same grounds `canClaimCompOff` admits them — an admin is
 * a person who works weekends. The actor is dropped here as well as in
 * `canGrantCompOff`, so a name they cannot grant to never reaches the picker.
 */
export async function listCompOffGrantees(
  actor: Actor,
): Promise<CompOffGranteeRecord[]> {
  const organizationId = granterOrgFor(actor);

  return prisma.user.findMany({
    where: {
      organizationId,
      status: EmploymentStatus.ACTIVE,
      id: { not: actor.id },
    },
    select: { id: true, name: true, email: true, role: true },
    orderBy: { name: "asc" },
  });
}

/**
 * The organization an admin may grant in, or a 403.
 *
 * Takes no grantee: `canGrantCompOff` needs one and is called separately,
 * because a caller with no business on this screen at all should be refused
 * before a grantee id is even looked at.
 */
function granterOrgFor(actor: Actor): string {
  const organizationId = actor.organizationId;
  if (!organizationId || actor.role !== Role.ADMIN) {
    throw new HttpError(403, "Your role does not permit this action.");
  }
  return organizationId;
}

/**
 * An admin credits a colleague with a day they worked, without a claim.
 *
 * Deliberately not `createOwnCompOffClaim` with an id parameter. That
 * function's contract is that it has *no* id to tamper with — rule 8 of
 * Docs/2026-09-10-comp-off-design.md — and adding one to serve this caller
 * would hand every later reader the question of whether a member can pass a
 * colleague's id. Two entry points, each authorizing once, is cheaper.
 *
 * Otherwise it is `createOwnCompOffClaim` step for step: read the stored user
 * for the organization and region, fetch that region's holidays, validate
 * with the same `claimableDay`, then check and insert in one transaction. The
 * row is born APPROVED, so there is no approver to route to and nothing to
 * decide later.
 */
export async function grantCompOff(
  actor: Actor,
  input: CompOffGrantInput,
): Promise<CompOffClaimRecord> {
  const organizationId = granterOrgFor(actor);

  if (!canGrantCompOff(actor, input.userId)) {
    throw new HttpError(403, "You cannot grant a comp-off to yourself.");
  }

  // The grantee is read from the database, and the organization compared
  // against the admin's own — outside it is indistinguishable from
  // nonexistent, the answer `decideCompOffClaim` gives for the same reason.
  const grantee = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { organizationId: true, regionId: true },
  });
  if (!grantee || grantee.organizationId !== organizationId) {
    throw new HttpError(404, "That member does not exist.");
  }

  // The *grantee's* region, not the admin's. A holiday is a fact about where
  // the person worked, and an admin in Delhi granting a Chennai holiday must
  // be judged against Chennai.
  const holidays = await listHolidays(actor, {
    from: input.workedOn,
    to: input.workedOn,
    regionId: grantee.regionId ?? undefined,
  });

  const refusal = claimableDay(input.workedOn, todayIso(), offDates(holidays));
  if (refusal) throw new HttpError(400, refusal);

  // The same check-and-insert transaction `createOwnCompOffClaim` runs, with
  // the same honesty about the race it narrows rather than closes.
  const row = await prisma.$transaction(async (tx) => {
    const held = await tx.compOffClaim.findFirst({
      where: {
        userId: input.userId,
        workedOn: toDbDate(input.workedOn),
        status: { in: HELD },
      },
      select: { id: true },
    });
    if (held) {
      throw new HttpError(409, "That member already has a comp-off for that day.");
    }

    return tx.compOffClaim.create({
      data: {
        organizationId,
        userId: input.userId,
        workedOn: toDbDate(input.workedOn),
        reason: input.reason,
        source: CompOffSource.ADMIN_GRANT,
        // Born decided: there was never a pending state, so `decidedAt` and
        // `decidedById` are set here rather than by a later transition.
        status: CompOffClaimStatus.APPROVED,
        decidedAt: new Date(),
        decidedById: actor.id,
      },
      select: CLAIM_FIELDS,
    });
  });

  return toRecord(row);
}

export type CompOffGrantRecord = CompOffClaimRecord & {
  source: CompOffSourceName;
  user: { id: string; name: string; email: string };
  decidedBy: { id: string; name: string } | null;
};

/** One organization's admin grants, newest first, for the list on /setup. */
export async function listCompOffGrants(
  actor: Actor,
  limit = 10,
): Promise<CompOffGrantRecord[]> {
  const organizationId = granterOrgFor(actor);

  const rows = await prisma.compOffClaim.findMany({
    where: {
      organizationId,
      source: CompOffSource.ADMIN_GRANT,
      status: CompOffClaimStatus.APPROVED,
    },
    select: {
      ...CLAIM_FIELDS,
      source: true,
      user: { select: { id: true, name: true, email: true } },
      decidedBy: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });

  return rows.map((row) => ({
    ...toRecord(row),
    source: row.source,
    user: row.user,
    decidedBy: row.decidedBy,
  }));
}

/**
 * An admin takes back a grant they should not have made.
 *
 * Scoped to `source = ADMIN_GRANT` inside the lookup rather than checked
 * after it, so a claim the member filed themselves is not merely refused but
 * invisible: undoing a member's approved claim is a decision with a claimant
 * on the other end, and it does not belong on a setup screen.
 *
 * `WITHDRAWN` rather than a delete, so the row stays readable and the credit
 * stops counting by the same rule every other non-APPROVED claim does.
 *
 * Revoking a credit the member has already spent drives their balance
 * negative rather than being refused. Every policy in the system already goes
 * negative on an over-spend, and comp-off is not the place to invent a second
 * answer — see rule 7 of the design.
 */
export async function revokeCompOffGrant(
  actor: Actor,
  id: string,
): Promise<CompOffClaimRecord> {
  const organizationId = granterOrgFor(actor);

  return toRecord(
    await prisma.$transaction(async (tx) => {
      const existing = await tx.compOffClaim.findFirst({
        where: { id, organizationId, source: CompOffSource.ADMIN_GRANT },
        select: { status: true },
      });
      if (!existing) throw new HttpError(404, "That grant does not exist.");

      if (!canRevokeCompOffGrant(actor, organizationId)) {
        throw new HttpError(403, "Your role does not permit this action.");
      }

      if (existing.status !== CompOffClaimStatus.APPROVED) {
        throw new HttpError(409, "That grant has already been revoked.");
      }

      return tx.compOffClaim.update({
        where: { id },
        data: { status: CompOffClaimStatus.WITHDRAWN },
        select: CLAIM_FIELDS,
      });
    }),
  );
}
