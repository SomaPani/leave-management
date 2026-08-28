import Link from "next/link";

import { DemoBanner } from "@/components/demo-banner";
import { PageHeader } from "@/components/page-header";
import { RequestThread } from "@/components/request-thread";
import {
  Avatar,
  Card,
  EmptyPanel,
  MonoLabel,
  StatusBadge,
  dangerButtonClass,
  ghostButtonClass,
  primaryButtonClass,
  textareaClass,
} from "@/components/ui";
import { formatRange } from "@/lib/date";
import { demoReviewRequest } from "@/lib/demo-actions";
import {
  balanceOf,
  dayCountLabel,
  formatBalance,
  personOrFallback,
  requestDays,
} from "@/lib/domain";
import { seedDb } from "@/lib/seed";
import type { RequestStatus } from "@/lib/types";

/**
 * Admin approvals — demo data.
 *
 * Every figure on this page comes from `seedDb()`, the in-memory fixture in
 * lib/seed.ts. Nothing is read from or written to Postgres: the tables this
 * screen was originally built against were dropped, and the `orgapp` schema
 * models organizations and users only, with no leave request of any kind.
 *
 * So the layout, filters and detail panel are real; the records are not, and
 * Approve / Reject / Send comment do not persist. Making them persist means
 * choosing a data source first — restore the old tables, or add leave models to
 * prisma/schema.prisma — after which the `seedDb()` call below becomes a query.
 */

const FILTERS = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
] as const;

type FilterKey = (typeof FILTERS)[number]["key"];


export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; r?: string; demo?: string }>;
}) {
  const params = await searchParams;
  const filter: FilterKey = FILTERS.some((f) => f.key === params.filter)
    ? (params.filter as FilterKey)
    : "pending";

  const db = seedDb();
  const queue = db.requests.filter((request) =>
    filter === "all" ? true : request.status === (filter as RequestStatus),
  );

  const selected =
    queue.find((request) => request.id === params.r) ?? queue[0] ?? null;

  const href = (requestId?: string, nextFilter: FilterKey = filter) =>
    `/approvals?filter=${nextFilter}${requestId ? `&r=${requestId}` : ""}`;

  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="Requests waiting on you, oldest first."
      />

      <DemoBanner action={params.demo} />

      <div className="grid items-start gap-6 xl:grid-cols-[1.25fr_1fr]">
        <Card className="overflow-hidden">
          <div className="flex flex-wrap gap-1.5 border-b border-line px-3.5 py-3">
            {FILTERS.map((option) => {
              const active = option.key === filter;
              return (
                <Link
                  key={option.key}
                  href={href(undefined, option.key)}
                  className={`rounded-full border px-3 py-[5px] text-xs no-underline ${
                    active
                      ? "border-brand bg-brand text-white hover:text-white"
                      : "border-line bg-surface text-ink-2 hover:text-ink"
                  }`}
                >
                  {option.label}
                </Link>
              );
            })}
          </div>

          <div className="flex flex-col">
            {queue.map((request) => {
              const person = personOrFallback(db, request.userId);
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
                    <Avatar initials={person.initials} size={28} />
                    <span className="text-sm font-semibold text-ink">
                      {person.name}
                    </span>
                    <span className="text-xs text-muted">{request.type}</span>
                  </span>
                  <StatusBadge status={request.status} />
                  <span className="col-start-1 font-mono text-[13px] text-ink-2">
                    {formatRange(request.from, request.to)}
                  </span>
                  <span className="text-[13px] text-muted">
                    {dayCountLabel(requestDays(request))}
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
              const person = personOrFallback(db, selected.userId);
              const left = balanceOf(db, selected.userId, selected.type);
              const after =
                selected.status === "approved"
                  ? left
                  : left - requestDays(selected);

              return (
                <>
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-[17px] font-semibold">{person.name}</h2>
                      <StatusBadge status={selected.status} />
                    </div>

                    <dl className="grid grid-cols-3 gap-3 rounded-[9px] bg-subtle p-3.5">
                      {[
                        { label: "TYPE", value: selected.type },
                        {
                          label: "DATES",
                          value: formatRange(selected.from, selected.to),
                        },
                        {
                          label: "BALANCE AFTER",
                          value: formatBalance(db, after, selected.type),
                        },
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
                      {selected.reason}
                    </p>
                  </div>

                  <form action={demoReviewRequest} className="flex flex-col gap-4">
                    <input type="hidden" name="requestId" value={selected.id} />
                    <input type="hidden" name="filter" value={filter} />

                    <div className="flex flex-col gap-3 border-t border-line pt-4">
                      <MonoLabel>FEEDBACK</MonoLabel>
                      <div className="max-h-60 overflow-auto">
                        <RequestThread
                          messages={selected.thread}
                          viewerIsAdmin
                          memberName={person.name}
                          emptyText="No feedback yet."
                        />
                      </div>
                      <textarea
                        name="note"
                        rows={3}
                        placeholder="Write feedback for this request…"
                        className={`${textareaClass} bg-surface`}
                      />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {selected.status === "pending" ? (
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
                      ) : null}
                      <button
                        type="submit"
                        name="intent"
                        value="comment"
                        className={ghostButtonClass}
                      >
                        Send comment
                      </button>
                    </div>
                  </form>
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
