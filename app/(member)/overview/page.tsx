import Link from "next/link";

import { DemoBanner } from "@/components/demo-banner";
import { PageHeader } from "@/components/page-header";
import { Avatar, Card, Meter, MonoLabel } from "@/components/ui";
import { TODAY, formatRange } from "@/lib/date";
import { balanceOf, outFrom, requestsFor } from "@/lib/domain";
import { demoDb, demoMember } from "@/lib/demo-data";

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ demo?: string }>;
}) {
  const params = await searchParams;
  const db = demoDb();
  const user = demoMember(db);

  const balances = db.policies.map((policy) => {
    const left = balanceOf(db, user.id, policy.name);
    return {
      name: policy.name,
      left,
      total: policy.days,
      unit: policy.unit === "uses" ? "uses" : "days",
      percent: policy.days > 0 ? (left / policy.days) * 100 : 0,
    };
  });

  const mine = requestsFor(db, user.id);
  const needsReply = mine.filter(
    (request) => request.thread.at(-1)?.by === "admin",
  );
  const outThisWeek = outFrom(db, TODAY);

  return (
    <>
      <PageHeader
        title="Your leave"
        subtitle="Balances, replies, and the week ahead."
        meta={`MEMBER VIEW · ${user.name.toUpperCase()}`}
      />

      <DemoBanner action={params.demo} />

      <div className="flex flex-col gap-6">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-4">
          {balances.map((balance) => (
            <Card key={balance.name} className="flex flex-col gap-3.5 p-5">
              <span className="text-[13px] text-muted">{balance.name}</span>
              <span className="flex items-baseline gap-1.5">
                <span className="text-[34px] font-semibold tracking-[-0.02em]">
                  {balance.left}
                </span>
                <span className="text-[13px] text-muted">
                  of {balance.total} {balance.unit} left
                </span>
              </span>
              <Meter percent={balance.percent} />
            </Card>
          ))}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="flex flex-col gap-3.5 p-5">
            <MonoLabel>NEEDS YOUR REPLY</MonoLabel>
            {needsReply.length === 0 ? (
              <span className="text-[13px] text-muted">Nothing waiting on you.</span>
            ) : (
              needsReply.map((request) => (
                <Link
                  key={request.id}
                  href={`/requests?r=${request.id}`}
                  className="flex flex-col gap-1.5 rounded-[9px] border border-warn-line bg-warn-tint p-3.5 text-left no-underline"
                >
                  <span className="text-[13px] font-semibold text-ink">
                    {request.type} · {formatRange(request.from, request.to)}
                  </span>
                  <span className="text-[13px] leading-relaxed text-warn-ink">
                    {request.thread.at(-1)?.text}
                  </span>
                </Link>
              ))
            )}
          </Card>

          <Card className="flex flex-col gap-3 p-5">
            <MonoLabel>WHO&apos;S OUT THIS WEEK</MonoLabel>
            {outThisWeek.length === 0 ? (
              <span className="text-[13px] text-muted">Everyone is in.</span>
            ) : (
              outThisWeek.map((entry) => (
                <div key={entry.id} className="flex items-center gap-2.5">
                  <Avatar initials={entry.initials} size={26} />
                  <span className="flex-1 text-[13.5px]">{entry.name}</span>
                  <span className="font-mono text-xs text-muted">
                    {formatRange(entry.request.from, entry.request.to)}
                  </span>
                </div>
              ))
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
