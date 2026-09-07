import { LeaveRequestStatus } from "@/generated/prisma/enums";
import { todayIso } from "@/lib/attendance";
import {
  type LeaveRequestRecord,
  type LeaveSummary,
  REQUEST_FIELDS,
  type RequestRow,
  summaryFor,
  toRecord,
} from "@/lib/leave-service";
import { prisma } from "@/lib/prisma";
import {
  type Actor,
  HttpError,
  canListLeaveRequests,
  canReviewLeave,
  visibleOrgId,
} from "@/lib/rbac";

/**
 * Everything about leave that reads or writes across a roster.
 *
 * The mirror image of lib/leave-service.ts, and deliberately a separate file.
 * That one opens by declaring that every operation in it is self-scoped and
 * that no `userId` parameter appears anywhere in it — one sentence a reviewer
 * can verify at a glance. Every function here takes somebody else's id or
 * reaches somebody else's row, so putting them together would demote that
 * claim to "self-scoped, except these five", which checks nothing.
 *
 * The rule the whole file follows: authorize against the row's **stored**
 * `organizationId` and `userId`, never against anything a caller supplied.
 * A request outside the caller's organization answers 404, indistinguishable
 * from one that does not exist — there is no id-probing oracle here.
 */

/** The two states a decision can put a request into. */
export type Decision = Extract<LeaveRequestStatus, "APPROVED" | "REJECTED">;

export type DecisionInput = { decision: Decision; note: string | null };

/**
 * A request as the approvals queue shows it: the member's own record, plus who
 * filed it and — once it is decided — which admin decided.
 */
export type ReviewRequestRecord = LeaveRequestRecord & {
  applicant: { id: string; name: string };
  /**
   * Null while PENDING, and also once the deciding admin has been deleted.
   *
   * The only thing this record adds beyond what the applicant's own
   * `LeaveRequestRecord` already carries. `decidedAt` and `decisionNote` are
   * on that base record, because the member is told when and why.
   */
  decidedBy: { id: string; name: string } | null;
};

/**
 * Four relations: policy and approver from `REQUEST_FIELDS`, plus the
 * applicant and the deciding admin.
 *
 * Selecting three or more relations in one operation makes Prisma 7's
 * interpreter issue the relation loads concurrently on a single `pg`
 * connection, which logs "Calling client.query() when the client is already
 * executing a query is deprecated" once per process. Measured here: two
 * relations are silent, three and four are not, in a transaction or out of
 * one. It is Prisma's fan-out rather than anything this file does — pg queues
 * the second query, so the results are correct — and dodging it would mean
 * hand-stitching the applicant and the decider onto the row in JavaScript.
 * Noted rather than worked around, because `pg` is pinned to ^8.23.0 and the
 * queueing it deprecates only disappears in pg@9.
 */
const REVIEW_FIELDS = {
  ...REQUEST_FIELDS,
  user: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, name: true } },
} as const;

type ReviewRow = RequestRow & {
  user: { id: string; name: string };
  decidedBy: { id: string; name: string } | null;
};

function toReviewRecord(row: ReviewRow): ReviewRequestRecord {
  return {
    ...toRecord(row),
    applicant: row.user,
    decidedBy: row.decidedBy,
  };
}

/**
 * The organization a roster read is scoped to.
 *
 * `visibleOrgId` answers null for a SUPERADMIN, meaning every organization —
 * so the `where` clause below omits the column entirely rather than filtering
 * on null, which would match nothing.
 */
function scopeFor(actor: Actor): { organizationId?: string } {
  if (!canListLeaveRequests(actor)) {
    throw new HttpError(403, "Your role does not permit this action.");
  }
  const organizationId = visibleOrgId(actor);
  return organizationId ? { organizationId } : {};
}

/* --------------------------------------------------------------- reading -- */

/**
 * One organization's requests, oldest filing first.
 *
 * Ordered by `createdAt`, not `startDate`: the screen's promise is "requests
 * waiting on you, oldest first", which is about how long somebody has been
 * waiting for an answer, not about when their leave begins.
 */
export async function listLeaveRequests(
  actor: Actor,
  filter: { status?: LeaveRequestStatus } = {},
): Promise<ReviewRequestRecord[]> {
  const rows = await prisma.leaveRequest.findMany({
    where: {
      ...scopeFor(actor),
      ...(filter.status ? { status: filter.status } : {}),
    },
    select: REVIEW_FIELDS,
    orderBy: { createdAt: "asc" },
  });

  return rows.map(toReviewRecord);
}

export async function findLeaveRequest(
  actor: Actor,
  id: string,
): Promise<ReviewRequestRecord | null> {
  const row = await prisma.leaveRequest.findFirst({
    where: { id, ...scopeFor(actor) },
    select: REVIEW_FIELDS,
  });

  return row ? toReviewRecord(row) : null;
}

/** The Approvals badge in app/(leave)/layout.tsx. */
export async function countPendingLeaveRequests(actor: Actor): Promise<number> {
  return prisma.leaveRequest.count({
    where: { ...scopeFor(actor), status: LeaveRequestStatus.PENDING },
  });
}

/**
 * One member's balances, for the approver deciding their request.
 *
 * The only function in the leave stack that reads a balance belonging to
 * somebody other than the caller, which is why it is ADMIN-only and why the
 * member is looked up inside the caller's own organization: an id from another
 * organization answers 404 rather than confirming that the person exists.
 *
 * The arithmetic is `summaryFor` in lib/leave-service.ts — the same function
 * `listOwnLeaveSummary` calls, not a second copy of it. The one difference is
 * deliberate and passed as an argument: this view includes retired policies.
 */
export async function leaveSummaryFor(
  actor: Actor,
  userId: string,
  asOf: string = todayIso(),
): Promise<LeaveSummary> {
  const scope = scopeFor(actor);
  const member = await prisma.user.findFirst({
    where: { id: userId, ...scope },
    select: { organizationId: true },
  });
  if (!member?.organizationId) {
    throw new HttpError(404, "That member does not exist.");
  }

  // Retired policies included: this view exists to decide requests, and a
  // request filed before its policy was withdrawn from the scheme still needs
  // a balance beside it. `listOwnLeaveSummary` stays active-only, so /apply
  // goes on offering only what a member may actually pick.
  return summaryFor(member.organizationId, userId, asOf, true);
}

/* --------------------------------------------------------------- writing -- */

/**
 * Approve or reject a pending request.
 *
 * The load and the write share a transaction, so two admins deciding the same
 * request at once cannot both pass the status check — the same reasoning the
 * overlap check in `createOwnLeaveRequest` gives.
 *
 * The status guard is deliberately inside it and deliberately strict: a
 * decision is terminal. Reversing one would mean re-checking the freed days
 * against everything filed since, which is a reconciliation path this design
 * does not open.
 */
export async function decideLeaveRequest(
  actor: Actor,
  id: string,
  input: DecisionInput,
): Promise<ReviewRequestRecord> {
  // Refusing someone's leave without saying why is the one case worth forcing
  // a sentence for. Checked before the row is loaded: it is a fact about the
  // input, not about the request.
  if (input.decision === LeaveRequestStatus.REJECTED && !input.note) {
    throw new HttpError(400, "A rejection needs a reason.");
  }

  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.leaveRequest.findUnique({
      where: { id },
      select: { organizationId: true, userId: true, status: true },
    });
    // Outside the caller's organization is indistinguishable from nonexistent.
    if (!existing) throw new HttpError(404, "That request does not exist.");
    if (
      visibleOrgId(actor) !== null &&
      existing.organizationId !== actor.organizationId
    ) {
      throw new HttpError(404, "That request does not exist.");
    }
    // Authorized on the stored columns, never on anything a caller sent.
    if (!canReviewLeave(actor, existing.organizationId, existing.userId)) {
      throw new HttpError(403, "Your role does not permit this action.");
    }
    if (existing.status !== LeaveRequestStatus.PENDING) {
      throw new HttpError(409, "That request has already been decided.");
    }

    return tx.leaveRequest.update({
      where: { id },
      data: {
        status: input.decision,
        decidedAt: new Date(),
        decidedById: actor.id,
        decisionNote: input.note,
      },
      select: REVIEW_FIELDS,
    });
  });

  return toReviewRecord(row);
}
