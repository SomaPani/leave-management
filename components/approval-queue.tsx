import Link from "next/link";

import { LeaveRequestStatus } from "@/generated/prisma/enums";
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
import { initialsFor } from "@/lib/domain";
import { formatWhen, unitNoun } from "@/lib/leave";
import { reviewLeaveRequestAction } from "@/lib/leave-actions";
import type { ReviewRequestRecord } from "@/lib/leave-review-service";
import type { LeaveSummary } from "@/lib/leave-service";

/**
 * The leave half of /approvals: the filtered queue and the review panel.
 *
 * Extracted from the page unchanged when the comp-off section arrived — the
 * page had grown past what one file should hold, and the two queues are
 * decided on different information. The page keeps the data loading and the
 * filter parsing; this renders one list.
 */

export type FilterEntry = { key: string; label: string };

export function ApprovalQueue({
  queue,
  selected,
  summary,
  filters,
  filterKey,
}: {
  queue: ReviewRequestRecord[];
  selected: ReviewRequestRecord | null;
  /** The selected applicant's balances, or null when nothing is selected. */
  summary: LeaveSummary | null;
  filters: readonly FilterEntry[];
  filterKey: string;
}) {
  const href = (requestId?: string, nextFilter: string = filterKey) =>
    `/approvals?filter=${nextFilter}${requestId ? `&r=${requestId}` : ""}`;

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[1.25fr_1fr]">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap gap-1.5 border-b border-line px-3.5 py-3">
          {filters.map((entry) => {
            const active = entry.key === filterKey;
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
                  {formatWhen(
                    request.startDate,
                    request.endDate,
                    request.startTime,
                    request.endTime,
                  )}
                </span>
                <span className="text-[13px] text-muted">
                  {request.cost} {unitNoun(request.policy.unit, request.cost)}
                </span>
              </Link>
            );
          })}

          {queue.length === 0 ? (
            <div className="px-4 py-11 text-center text-sm text-muted">Nothing here.</div>
          ) : null}
        </div>
      </Card>

      {selected ? (
        <Card className="sticky top-6 flex flex-col gap-5 p-5.5">
          {(() => {
            const policy = summary?.balances.find(
              (balance) => balance.id === selected.policy.id,
            );
            // `leaveSummaryFor` includes retired policies, so a request filed
            // before its type left the scheme still shows a balance. Marked,
            // though: the number is real, but the entitlement behind it is
            // closed and the member cannot file against it again.
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
                        value: formatWhen(
                          selected.startDate,
                          selected.endDate,
                          selected.startTime,
                          selected.endTime,
                        ),
                      },
                      // Pending days are already spent — see `SPENT` in
                      // lib/leave-service.ts — so this is what is left whether
                      // or not this request is approved.
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
                  <form action={reviewLeaveRequestAction} className="flex flex-col gap-4">
                    <input type="hidden" name="requestId" value={selected.id} />
                    <input type="hidden" name="filter" value={filterKey} />

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
                            selected.decidedBy?.name ?? "An admin who has since left"
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
  );
}
