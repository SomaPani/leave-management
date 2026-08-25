import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { Avatar, Card, EmptyPanel, Meter, MonoLabel } from "@/components/ui";
import { personById, roster } from "@/lib/domain";
import { SCORES } from "@/lib/seed";
import { requireAdmin } from "@/lib/session";
import { readDb } from "@/lib/store";

export default async function ScoresPage({
  searchParams,
}: {
  searchParams: Promise<{ u?: string }>;
}) {
  await requireAdmin();

  const params = await searchParams;
  const db = await readDb();
  const people = roster(db);

  const selected = params.u ? (personById(db, params.u) ?? null) : null;
  const card = selected ? SCORES[selected.id] : undefined;

  return (
    <>
      <PageHeader
        title="Employee score board"
        subtitle="Pick someone to see their 2026 score."
        meta="ADMIN VIEW"
      />

      <div className="grid max-w-[940px] items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          {people.map((person) => {
            const active = selected?.id === person.id;
            return (
              <Link
                key={person.id}
                href={active ? "/scores" : `/scores?u=${person.id}`}
                className={`flex items-center gap-3 rounded-[10px] border px-3.5 py-3 text-left no-underline transition-colors ${
                  active
                    ? "border-brand bg-brand-tint"
                    : "border-line bg-surface hover:border-brand"
                }`}
              >
                <Avatar initials={person.initials} size={32} />
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="text-sm font-semibold text-ink">{person.name}</span>
                  <span className="text-xs text-muted">{person.title}</span>
                </span>
                <span className="font-mono text-[17px] font-semibold tracking-[-0.02em] text-ink">
                  {SCORES[person.id]?.total ?? "—"}
                </span>
              </Link>
            );
          })}
        </div>

        {selected ? (
          <div className="flex min-w-0 flex-col gap-5">
            <Card className="flex flex-wrap items-end justify-between gap-5 p-5.5">
              <span className="flex flex-col gap-2.5">
                <MonoLabel>SCORE 2026</MonoLabel>
                <span className="flex items-baseline gap-2">
                  <span className="text-[52px] leading-none font-semibold tracking-[-0.03em]">
                    {card?.total ?? "—"}
                  </span>
                  <span className="text-sm text-muted">/ 100</span>
                </span>
              </span>
              <span className="flex flex-col items-end gap-2">
                <span className="rounded-full bg-brand-tint px-3 py-[5px] text-[13px] text-brand-dark">
                  {card?.grade ?? "No data yet"}
                </span>
                <span className="flex flex-col gap-0.5 text-right">
                  <span className="text-sm font-semibold">{selected.name}</span>
                  <span className="text-xs text-muted">{selected.title}</span>
                </span>
              </span>
            </Card>

            {card ? (
              <>
                <Card className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-5 p-5.5">
                  {card.metrics.map(([label, pct, detail]) => (
                    <div key={label} className="flex flex-col gap-2.5">
                      <span className="flex items-baseline justify-between gap-2.5">
                        <span className="text-[13px] text-muted">{label}</span>
                        <span className="text-[19px] font-semibold tracking-[-0.015em]">
                          {pct}%
                        </span>
                      </span>
                      <Meter percent={pct} />
                      <span className="text-xs text-muted">{detail}</span>
                    </div>
                  ))}
                </Card>

                <Card className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-x-8 px-5.5 pt-2 pb-3.5">
                  {card.ledger.map(([label, value]) => (
                    <span
                      key={label}
                      className="flex items-center justify-between gap-3 border-b border-line py-2.5"
                    >
                      <span className="text-[13.5px] text-ink-2">{label}</span>
                      <span className="font-mono text-[13.5px] font-semibold">
                        {value}
                      </span>
                    </span>
                  ))}
                </Card>
              </>
            ) : (
              <Card className="p-5.5 text-sm text-muted">
                No score has been recorded for {selected.name} yet.
              </Card>
            )}

            <p className="text-[12.5px] text-muted">
              Static figures for now — wired up once the real data source is connected.
            </p>
          </div>
        ) : (
          <EmptyPanel className="py-18">
            Click an employee to see their score.
          </EmptyPanel>
        )}
      </div>
    </>
  );
}
