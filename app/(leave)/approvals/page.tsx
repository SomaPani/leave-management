// One import from the enums module, not two — `no-duplicate-imports` is on.
import { CompOffClaimStatus, LeaveRequestStatus, Role } from "@/generated/prisma/enums";
import { ApprovalQueue } from "@/components/approval-queue";
import { CompOffQueue } from "@/components/comp-off-queue";
import { PageHeader } from "@/components/page-header";
import {
  findCompOffClaim,
  listCompOffClaims,
} from "@/lib/comp-off-service";
import {
  findLeaveRequest,
  leaveSummaryFor,
  listLeaveRequests,
} from "@/lib/leave-review-service";
import { requirePageRole } from "@/lib/page-guards";

/**
 * Admin approvals — the organization's real leave requests, and the comp-off
 * claims filed against days already worked.
 *
 * Every row comes from lib/leave-review-service.ts or
 * lib/comp-off-service.ts, each of which scopes the read to the caller's own
 * organization and authorizes the decision against the row's stored columns.
 * Approve and Reject persist; there is no fixture left on this screen.
 *
 * The balance in the leave panel is `leaveSummaryFor`, which shares its
 * arithmetic with the `listOwnLeaveSummary` behind /apply — so the figure an
 * approver reads here and the figure the member read when they filed cannot
 * disagree. That now includes Comp-off, whose credit is the approved claims
 * in the section below.
 *
 * This page loads; the two sections render. `components/approval-queue.tsx`
 * and `components/comp-off-queue.tsx` hold the markup, because a leave
 * request and a claim are decided on different information and a shared row
 * shape would blur that.
 */

const FILTERS = [
  { key: "pending", label: "Pending", status: LeaveRequestStatus.PENDING },
  { key: "approved", label: "Approved", status: LeaveRequestStatus.APPROVED },
  { key: "rejected", label: "Rejected", status: LeaveRequestStatus.REJECTED },
  // No status: All includes WITHDRAWN, which is reachable now that a member
  // can actually take a request back.
  { key: "all", label: "All", status: undefined },
] as const;

/**
 * The claim statuses the same four filters mean.
 *
 * `CompOffClaimStatus` is a separate enum carrying the same four values, so
 * one filter row drives both sections. Mapped by key rather than reusing
 * `option.status`, so the day the two enums diverge this fails to compile
 * instead of filtering a queue by a status it does not have.
 */
const CLAIM_STATUS: Record<string, CompOffClaimStatus | undefined> = {
  pending: CompOffClaimStatus.PENDING,
  approved: CompOffClaimStatus.APPROVED,
  rejected: CompOffClaimStatus.REJECTED,
  all: undefined,
};

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; r?: string; c?: string; error?: string }>;
}) {
  const actor = await requirePageRole(Role.ADMIN);
  const params = await searchParams;
  const option = FILTERS.find((f) => f.key === params.filter) ?? FILTERS[0];

  const [queue, claims] = await Promise.all([
    listLeaveRequests(actor, { status: option.status }),
    listCompOffClaims(actor, { status: CLAIM_STATUS[option.key] }),
  ]);

  // Scoped in the query, so an id from another organization comes back null
  // down the same path a nonexistent one does. Falling back to the head of the
  // queue keeps the panel filled when a decision drops a request out of the
  // current filter.
  const selected =
    (params.r ? await findLeaveRequest(actor, params.r) : null) ?? queue[0] ?? null;

  const selectedClaim =
    (params.c ? await findCompOffClaim(actor, params.c) : null) ?? claims[0] ?? null;

  const summary = selected ? await leaveSummaryFor(actor, selected.applicant.id) : null;

  return (
    <>
      <PageHeader title="Approvals" subtitle="Requests waiting on you, oldest first." />

      {params.error ? (
        <p className="rounded-lg border border-danger-line bg-danger-tint px-3.5 py-2.5 text-sm text-danger">
          {params.error}
        </p>
      ) : null}

      <CompOffQueue
        claims={claims}
        selected={selectedClaim}
        filters={FILTERS}
        filterKey={option.key}
      />

      <ApprovalQueue
        queue={queue}
        selected={selected}
        summary={summary}
        filters={FILTERS}
        filterKey={option.key}
      />
    </>
  );
}
