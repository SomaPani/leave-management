import Link from "next/link";

import { DemoBanner } from "@/components/demo-banner";
import { PageHeader } from "@/components/page-header";
import { RequestThread } from "@/components/request-thread";
import {
  Card,
  EmptyPanel,
  StatusBadge,
  primaryButtonClass,
  textareaClass,
} from "@/components/ui";
import { demoUpdateOwnRequest as updateOwnRequest } from "@/lib/demo-actions";
import { formatRange } from "@/lib/date";
import { dayCountLabel, requestDays, requestsFor } from "@/lib/domain";
import { demoDb, demoMember } from "@/lib/demo-data";

export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ r?: string; demo?: string }>;
}) {
  const params = await searchParams;

  const db = demoDb();
  const user = demoMember(db);
  const mine = requestsFor(db, user.id);
  const selected = mine.find((request) => request.id === params.r) ?? mine[0] ?? null;

  return (
    <>
      <PageHeader
        title="My requests"
        subtitle="Every request and its feedback thread."
        meta="MEMBER VIEW"
      />

      <DemoBanner action={params.demo} />

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
                <span className="text-sm font-semibold text-ink">{request.type}</span>
                <StatusBadge status={request.status} />
                <span className="font-mono text-[13px] text-ink-2">
                  {formatRange(request.from, request.to)}
                </span>
                <span className="text-[13px] text-muted">
                  {dayCountLabel(requestDays(request))}
                </span>
              </Link>
            );
          })}

          {mine.length === 0 ? (
            <div className="px-4 py-11 text-center text-sm text-muted">
              No requests yet.
            </div>
          ) : null}
        </Card>

        {selected ? (
          <Card className="sticky top-6 flex flex-col gap-4.5 p-5.5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[17px] font-semibold">
                {selected.type} · {formatRange(selected.from, selected.to)}
              </h2>
              <StatusBadge status={selected.status} />
            </div>

            <p className="text-sm leading-relaxed text-ink text-pretty">
              {selected.reason}
            </p>

            <div className="max-h-64 overflow-auto border-t border-line pt-4">
              <RequestThread
                messages={selected.thread}
                viewerIsAdmin={false}
                memberName={user.name}
                emptyText="No feedback yet — you'll be notified here."
              />
            </div>

            <form action={updateOwnRequest} className="flex flex-col gap-3">
              <input type="hidden" name="requestId" value={selected.id} />

              <div className="flex gap-2">
                <textarea
                  name="note"
                  rows={2}
                  placeholder="Reply to your admin…"
                  className={`${textareaClass} flex-1`}
                />
                <button
                  type="submit"
                  name="intent"
                  value="comment"
                  className={`${primaryButtonClass} self-stretch px-4.5`}
                >
                  Reply
                </button>
              </div>

              {selected.status === "pending" ? (
                <button
                  type="submit"
                  name="intent"
                  value="withdraw"
                  className="w-full cursor-pointer rounded-lg border border-line bg-surface px-3 py-2.5 text-[13px] text-danger transition-colors hover:bg-danger-tint"
                >
                  Withdraw request
                </button>
              ) : null}
            </form>
          </Card>
        ) : (
          <EmptyPanel>Select a request to see its feedback thread.</EmptyPanel>
        )}
      </div>
    </>
  );
}
