import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { Avatar, Card, EmptyPanel } from "@/components/ui";
import { formatHeader } from "@/lib/date";
import { COUNTED_KINDS, type CountedKind } from "@/lib/day-status";
import { DAY_KIND_STYLE, SHOW_FILTERS } from "@/lib/day-style";
import { initialsFor } from "@/lib/domain";
import { todayOverview } from "@/lib/overview-service";
import { requirePageActor } from "@/lib/page-guards";

/**
 * Admin: who is in today, at a glance.
 *
 * The counts and the list come from lib/overview-service.ts, which reads the
 * day's attendance marks and fills in approved leave and holidays for anyone
 * not marked — so "On leave" is right even before attendance is taken.
 * Filtering is a plain `?show=` link, so the page needs no client script.
 */

const COLUMNS = "grid-cols-[minmax(220px,2fr)_minmax(110px,1fr)_minmax(160px,1.4fr)]";

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const actor = await requirePageActor();
  const params = await searchParams;
  const view = await todayOverview(actor);

  const filter = SHOW_FILTERS.find((f) => f.key === params.show) ?? SHOW_FILTERS[0]!;
  const people = filter.kind
    ? view.people.filter((person) => person.today.kind === filter.kind)
    : view.people;

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Who is in today, at a glance."
        meta={formatHeader(view.date)}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {COUNTED_KINDS.map((kind: CountedKind) => {
          const style = DAY_KIND_STYLE[kind];
          const key = SHOW_FILTERS.find((f) => f.kind === kind)?.key ?? "all";
          return (
            <Link key={kind} href={`/dashboard?show=${key}`} className="group">
              <Card className="flex h-full flex-col gap-2 px-4.5 py-4 transition-colors group-hover:border-muted">
                <span className="font-mono text-[11px] tracking-[0.1em] text-muted uppercase">
                  {style.label}
                </span>
                <span className="text-[30px] leading-none font-semibold">
                  {view.counts[kind]}
                </span>
                <span className="text-xs text-muted">
                  {kind === "PRESENT"
                    ? `of ${view.total} ${view.total === 1 ? "person" : "people"}`
                    : kind === "NOT_MARKED" && view.counts.NOT_MARKED > 0
                      ? "Mark attendance →"
                      : " "}
                </span>
              </Card>
            </Link>
          );
        })}
      </div>

      {view.counts.NOT_MARKED > 0 ? (
        <p className="text-[13px] text-muted">
          {view.counts.NOT_MARKED} not marked yet —{" "}
          <Link href="/attendance" className="text-brand hover:underline">
            take today&apos;s attendance
          </Link>
          .
        </p>
      ) : null}

      <nav aria-label="Filter by status" className="flex flex-wrap gap-2">
        {SHOW_FILTERS.map((f) => {
          const active = f.key === filter.key;
          return (
            <Link
              key={f.key}
              href={f.key === "all" ? "/dashboard" : `/dashboard?show=${f.key}`}
              aria-current={active ? "page" : undefined}
              className={`rounded-full border px-3.5 py-1.5 text-[13px] transition-colors ${
                active
                  ? "border-brand bg-brand text-white"
                  : "border-line bg-surface text-ink-2 hover:border-muted"
              }`}
            >
              {f.label}
            </Link>
          );
        })}
      </nav>

      {view.people.length === 0 ? (
        <EmptyPanel>No one in your organization yet. Add people on the Team screen.</EmptyPanel>
      ) : (
        <Card className="overflow-x-auto">
          <div className="min-w-[560px]">
            <div
              className={`grid ${COLUMNS} gap-4 border-b border-line bg-subtle px-4.5 py-3 font-mono text-[11px] tracking-[0.08em] text-muted`}
            >
              <span>PERSON</span>
              <span>REGION</span>
              <span>TODAY</span>
            </div>

            {people.length === 0 ? (
              <p className="px-4.5 py-5 text-[13px] text-muted">
                No one is {DAY_KIND_STYLE[filter.kind ?? "PRESENT"].label.toLowerCase()} today.
              </p>
            ) : (
              people.map((person) => {
                const style = DAY_KIND_STYLE[person.today.kind];
                const meta = [person.title, person.empId].filter(Boolean).join(" · ");
                return (
                  <div
                    key={person.id}
                    className={`grid ${COLUMNS} items-center gap-4 border-b border-line px-4.5 py-3.5 last:border-b-0`}
                  >
                    <Link
                      href={`/dashboard/${person.id}`}
                      className="flex items-center gap-2.5 hover:underline"
                    >
                      <Avatar initials={initialsFor(person.name)} />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-sm font-semibold text-brand">{person.name}</span>
                        {meta ? <span className="truncate text-xs text-muted">{meta}</span> : null}
                      </span>
                    </Link>
                    <span className="text-[13px] text-ink-2">{person.region ?? "—"}</span>
                    <span className="flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-md px-2 py-[3px] font-mono text-[11px] tracking-[0.08em] ${style.chip}`}
                      >
                        {style.label.toUpperCase()}
                      </span>
                      {person.today.detail ? (
                        <span className="text-xs text-muted">{person.today.detail}</span>
                      ) : null}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </Card>
      )}
    </>
  );
}
