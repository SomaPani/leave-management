import Link from "next/link";

import { CompOffClaimStatus } from "@/generated/prisma/enums";
import type { FilterEntry } from "@/components/approval-queue";
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
import { reviewCompOffClaimAction } from "@/lib/comp-off-actions";
import type { ReviewCompOffRecord } from "@/lib/comp-off-service";
import { initialsFor } from "@/lib/domain";

/**
 * The comp-off half of /approvals: claims filed against days already worked.
 *
 * Sibling to components/approval-queue.tsx rather than a shared row shape. A
 * claim carries one date and no cost, and it is decided on what was worked
 * rather than on a balance — the panel below says so, and a row built to hold
 * both would say neither well.
 *
 * Approving one is what creates the credit: there is no ledger behind this,
 * so the member's Comp-off balance on /apply moves the moment a row here
 * turns APPROVED.
 */
export function CompOffQueue({
  claims,
  selected,
  filters,
  filterKey,
}: {
  claims: ReviewCompOffRecord[];
  selected: ReviewCompOffRecord | null;
  filters: readonly FilterEntry[];
  filterKey: string;
}) {
  const href = (claimId?: string, nextFilter: string = filterKey) =>
    `/approvals?filter=${nextFilter}${claimId ? `&c=${claimId}` : ""}`;

  return (
    <>
      <MonoLabel>COMP-OFF CLAIMS</MonoLabel>

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
            {claims.map((claim) => {
              const active = selected?.id === claim.id;
              return (
                <Link
                  key={claim.id}
                  href={href(claim.id)}
                  className={`grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 border-b border-line px-4 py-3.5 text-left no-underline transition-colors ${
                    active ? "bg-brand-tint" : "bg-surface hover:bg-subtle"
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Avatar initials={initialsFor(claim.user.name)} size={28} />
                    <span className="text-sm font-semibold text-ink">
                      {claim.user.name}
                    </span>
                  </span>
                  <StatusBadge status={claim.status} />
                  <span className="col-start-1 font-mono text-[13px] text-ink-2">
                    {claim.workedOn}
                  </span>
                  <span className="text-[13px] text-muted">1 day</span>
                </Link>
              );
            })}

            {claims.length === 0 ? (
              <div className="px-4 py-11 text-center text-sm text-muted">
                No comp-off claims here.
              </div>
            ) : null}
          </div>
        </Card>

        {selected ? (
          <Card className="sticky top-6 flex flex-col gap-5 p-5.5">
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-[17px] font-semibold">{selected.user.name}</h2>
                <StatusBadge status={selected.status} />
              </div>

              <dl className="grid grid-cols-3 gap-3 rounded-[9px] bg-subtle p-3.5">
                {[
                  { label: "DAY WORKED", value: selected.workedOn },
                  { label: "EARNS", value: "1 day" },
                  // A claim has no balance to weigh: approving it is what
                  // creates the credit, so there is nothing to spend yet.
                  { label: "LAPSES", value: `31 Dec ${selected.workedOn.slice(0, 4)}` },
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

            {selected.status === CompOffClaimStatus.PENDING ? (
              <form action={reviewCompOffClaimAction} className="flex flex-col gap-4">
                <input type="hidden" name="claimId" value={selected.id} />
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
                    WITHDRAWN is not a decision and has no decider — the member
                    took it back. A bare `decidedBy` fallback would invent one.
                  */}
                  {selected.status === CompOffClaimStatus.WITHDRAWN
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
          </Card>
        ) : (
          <EmptyPanel>Select a claim to review it.</EmptyPanel>
        )}
      </div>
    </>
  );
}
