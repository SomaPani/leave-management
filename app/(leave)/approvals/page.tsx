import Link from "next/link";

// One import from the enums module, not two — `no-duplicate-imports` is on.
import { LeaveRequestStatus, Role } from "@/generated/prisma/enums";
import { PageHeader } from "@/components/page-header";
import {
  Avatar,
  Card,
  EmptyPanel,
  MonoLabel,
  StatusBadge,
  dangerButtonClass,
  primaryButtonClass,
  textareaClass,
} from "@/components/ui";
import { formatRange } from "@/lib/date";
import { initialsFor } from "@/lib/domain";
import { unitNoun } from "@/lib/leave";
import { reviewLeaveRequestAction } from "@/lib/leave-actions";
import {
  findLeaveRequest,
  leaveSummaryFor,
  listLeaveRequests,
} from "@/lib/leave-review-service";
import { requirePageRole } from "@/lib/page-guards";

/**
 * Admin approvals — the organization's real leave requests.
 *
 * Every row comes from `orgapp.LeaveRequest` through
 * lib/leave-review-service.ts, which scopes the read to the caller's own
 * organization and authorizes the decision against the row's stored columns.
 * Approve and Reject persist; there is no fixture left on this screen.
 *
 * The balance in the panel is `leaveSummaryFor`, which shares its arithmetic
 * with the `listOwnLeaveSummary` behind /apply — so the figure an approver
 * reads here and the figure the member read when they filed cannot disagree.
 */

const FILTERS = [
  { key: "pending", label: "Pending", status: LeaveRequestStatus.PENDING },
  { key: "approved", label: "Approved", status: LeaveRequestStatus.APPROVED },
  { key: "rejected", label: "Rejected", status: LeaveRequestStatus.REJECTED },
  // No status: All includes WITHDRAWN, which is reachable now that a member
  // can actually take a request back.
  { key: "all", label: "All", status: undefined },
] as const;

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; r?: string; error?: string }>;
}) {
  const actor = await requirePageRole(Role.ADMIN);
  const params = await searchParams;
  const option = FILTERS.find((f) => f.key === params.filter) ?? FILTERS[0];

  const queue = await listLeaveRequests(actor, { status: option.status });

  // Scoped in the query, so an id from another organization comes back null
  // down the same path a nonexistent one does. Falling back to the head of the
  // queue keeps the panel filled when a decision drops a request out of the
  // current filter.
  const selected =
    (params.r ? await findLeaveRequest(actor, params.r) : null) ?? queue[0] ?? null;

  const summary = selected
    ? await leaveSummaryFor(actor, selected.applicant.id)
    : null;

  const href = (requestId?: string, nextFilter: string = option.key) =>
    `/approvals?filter=${nextFilter}${requestId ? `&r=${requestId}` : ""}`;

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="Requests waiting on you, oldest first."
      />

      {params.error ? (
        <p className="rounded-lg border border-danger-line bg-danger-tint px-3.5 py-2.5 text-sm text-danger">
          {params.error}
        </p>
      ) : null}

      <div className="grid items-start gap-6 xl:grid-cols-[1.25fr_1fr]">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap gap-1.5 border-b border-line px-3.5 py-3">
            {FILTERS.map((entry) => {
              const active = entry.key === option.key;
              return (
                <Link
                  key={entry.key}
                  href={href(undefined, entry.key)}
                  className={`rounded-full border px-3 py-[5px] text-xs no-underline ${
                    active
                      ? "border-brand bg-brand text-white hover:text-white"
                      : "border-line bg-surface text-ink-2 hover:text-ink"
                  }`}
                >
                  {entry.label}
                </Link>
              );
            })}
          </div>

          <div className="flex flex-col">
            {queue.map((request) => {
              const active = selected?.id === request.id;
              return (
                <Link
                  key={request.id}
                  href={href(request.id)}
                  className={`grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 border-b border-line px-4 py-3.5 text-left no-underline transition-colors ${
                    active ? "bg-brand-tint" : "bg-surface hover:bg-subtle"
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Avatar initials={initialsFor(request.applicant.name)} size={28} />
                    <span className="text-sm font-semibold text-ink">
                      {request.applicant.name}
                    </span>
                    <span className="text-xs text-muted">{request.policy.name}</span>
                  </span>
                  <StatusBadge status={request.status} />
                  <span className="col-start-1 font-mono text-[13px] text-ink-2">
                    {formatRange(request.startDate, request.endDate)}
                  </span>
                  <span className="text-[13px] text-muted">
                    {request.cost} {unitNoun(request.policy.unit, request.cost)}
                  </span>
                </Link>
              );
            })}

            {queue.length === 0 ? (
              <div className="px-4 py-11 text-center text-sm text-muted">
                Nothing here.
              </div>
            ) : null}
          </div>
        </Card>

        {selected ? (
          <Card className="sticky top-6 flex flex-col gap-5 p-5.5">
            {(() => {
              const policy = summary?.balances.find(
                (balance) => balance.id === selected.policy.id,
              );
              // `leaveSummaryFor` includes retired policies, so a request
              // filed before its type left the scheme still shows a balance.
              // Marked, though: the number is real, but the entitlement behind
              // it is closed and the member cannot file against it again.
              const left = policy
                ? `${policy.balance} ${unitNoun(policy.unit, policy.balance)}${
                    policy.active ? "" : " · retired"
                  }`
                : "—";

              return (
                <>
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-[17px] font-semibold">
                        {selected.applicant.name}
                      </h2>
                      <StatusBadge status={selected.status} />
                    </div>

                    <dl className="grid grid-cols-3 gap-3 rounded-[9px] bg-subtle p-3.5">
                      {[
                        { label: "TYPE", value: selected.policy.name },
                        {
                          label: "DATES",
                          value: formatRange(selected.startDate, selected.endDate),
                        },
                        // Pending days are already spent — see `SPENT` in
                        // lib/leave-service.ts — so this is what is left
                        // whether or not this request is approved.
                        { label: "BALANCE LEFT", value: left },
                      ].map((cell) => (
                        <div key={cell.label} className="flex flex-col gap-1">
                          <dt className="text-[11px] tracking-[0.06em] text-muted">
                            {cell.label}
                          </dt>
                          <dd className="text-[13px] font-semibold">{cell.value}</dd>
                        </div>
                      ))}
                    </dl>

                    <p className="text-sm leading-relaxed text-ink text-pretty">
                      {selected.reason ?? "No reason given."}
                    </p>
                  </div>

                  {selected.status === LeaveRequestStatus.PENDING ? (
                    <form
                      action={reviewLeaveRequestAction}
                      className="flex flex-col gap-4"
                    >
                      <input type="hidden" name="requestId" value={selected.id} />
                      <input type="hidden" name="filter" value={option.key} />

                      <div className="flex flex-col gap-3 border-t border-line pt-4">
                        <MonoLabel>NOTE</MonoLabel>
                        <textarea
                          name="note"
                          rows={3}
                          placeholder="Required when rejecting…"
                          className={`${textareaClass} bg-surface`}
                        />
                      </div>

                      <div className="flex flex-1 gap-2">
                        <button
                          type="submit"
                          name="intent"
                          value="approve"
                          className={`${primaryButtonClass} flex-1`}
                        >
                          Approve
                        </button>
                        <button
                          type="submit"
                          name="intent"
                          value="reject"
                          className={`${dangerButtonClass} flex-1`}
                        >
                          Reject
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex flex-col gap-2 border-t border-line pt-4">
                      <MonoLabel>DECISION</MonoLabel>
                      <p className="text-[13px] text-muted">
                        {/*
                          WITHDRAWN is not a decision and has no decider — the
                          member took it back. Saying "an admin who has since
                          left" here, which is what a bare `decidedBy` fallback
                          does, would invent one.
                        */}
                        {selected.status === LeaveRequestStatus.WITHDRAWN
                          ? "Withdrawn by the member."
                          : `${
                              selected.decidedBy?.name ??
                              "An admin who has since left"
                            } · ${selected.decidedAt?.slice(0, 10) ?? "—"}`}
                      </p>
                      {selected.decisionNote ? (
                        <p className="text-sm leading-relaxed text-ink text-pretty">
                          {selected.decisionNote}
                        </p>
                      ) : null}
                    </div>
                  )}
                </>
              );
            })()}
          </Card>
        ) : (
          <EmptyPanel>Select a request to review it.</EmptyPanel>
        )}
      </div>
    </>
  );
}
