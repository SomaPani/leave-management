import Link from "next/link";

import { LeaveRequestStatus } from "@/generated/prisma/enums";
import { PageHeader } from "@/components/page-header";
import { Card, EmptyPanel, MonoLabel, StatusBadge } from "@/components/ui";
import { formatRange } from "@/lib/date";
import { unitNoun } from "@/lib/leave";
import { withdrawOwnRequestAction } from "@/lib/leave-actions";
import { listOwnLeaveRequests } from "@/lib/leave-service";
import { requirePageActor } from "@/lib/page-guards";

/**
 * Member: every request this person has filed, and what became of it.
 *
 * Self-scoped, like /apply and /calendar: `listOwnLeaveRequests` takes no user
 * id at all — the applicant is the session — so there is no id in the URL for
 * a member to change into a colleague's.
 *
 * The approver's decision note takes the place of the fixture's feedback
 * thread. A real back-and-forth needs a table, and there isn't one; a single
 * recorded reason is what a decision actually carries today.
 */
export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ r?: string; error?: string }>;
}) {
  const actor = await requirePageActor();
  const params = await searchParams;

  const mine = await listOwnLeaveRequests(actor);
  const selected = mine.find((request) => request.id === params.r) ?? mine[0] ?? null;

  return (
    <>
      <PageHeader
        title="My requests"
        subtitle="Every request you have filed, and what became of it."
        meta="MEMBER VIEW"
      />

      {params.error ? (
        <p className="rounded-lg border border-danger-line bg-danger-tint px-3.5 py-2.5 text-sm text-danger">
          {params.error}
        </p>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden">
          {mine.map((request) => {
            const active = selected?.id === request.id;
            return (
              <Link
                key={request.id}
                href={`/requests?r=${request.id}`}
                className={`grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 border-b border-line px-4 py-3.5 text-left no-underline transition-colors last:border-b-0 ${
                  active ? "bg-brand-tint" : "bg-surface hover:bg-subtle"
                }`}
              >
                <span className="text-sm font-semibold text-ink">
                  {request.policy.name}
                </span>
                <StatusBadge status={request.status} />
                <span className="font-mono text-[13px] text-ink-2">
                  {formatRange(request.startDate, request.endDate)}
                </span>
                <span className="text-[13px] text-muted">
                  {request.cost} {unitNoun(request.policy.unit, request.cost)}
                </span>
              </Link>
            );
          })}

          {mine.length === 0 ? (
            <div className="px-4 py-11 text-center text-sm text-muted">
              No requests yet — file one from Apply for leave.
            </div>
          ) : null}
        </Card>

        {selected ? (
          <Card className="sticky top-6 flex flex-col gap-4.5 p-5.5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[17px] font-semibold">
                {selected.policy.name} ·{" "}
                {formatRange(selected.startDate, selected.endDate)}
              </h2>
              <StatusBadge status={selected.status} />
            </div>

            <p className="text-sm leading-relaxed text-ink text-pretty">
              {selected.reason ?? "No reason given."}
            </p>

            {selected.status === LeaveRequestStatus.PENDING ? (
              <form action={withdrawOwnRequestAction} className="border-t border-line pt-4">
                <input type="hidden" name="requestId" value={selected.id} />
                <p className="mb-3 text-[13px] text-muted">
                  With {selected.approver?.name ?? "your admin"} now.
                </p>
                <button
                  type="submit"
                  className="w-full cursor-pointer rounded-lg border border-line bg-surface px-3 py-2.5 text-[13px] text-danger transition-colors hover:bg-danger-tint"
                >
                  Withdraw request
                </button>
              </form>
            ) : (
              <div className="flex flex-col gap-2 border-t border-line pt-4">
                <MonoLabel>DECISION</MonoLabel>
                <p className="text-[13px] text-muted">
                  {selected.status === LeaveRequestStatus.WITHDRAWN
                    ? "You took this back."
                    : `${selected.approver?.name ?? "Your admin"} decided this.`}
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
          <EmptyPanel>Select a request to see what became of it.</EmptyPanel>
        )}
      </div>
    </>
  );
}
