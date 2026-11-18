import Link from "next/link";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { Card, ghostButtonClass } from "@/components/ui";
import { todayIso } from "@/lib/attendance";
import { formatShort, formatWeekdayShort, isValidDate } from "@/lib/date";
import { COUNTED_KINDS, PERIODS, type Period, periodRange, shiftPeriod } from "@/lib/day-status";
import { DAY_KIND_STYLE } from "@/lib/day-style";
import { memberPeriod } from "@/lib/overview-service";
import { requirePageActor } from "@/lib/page-guards";
import { HttpError } from "@/lib/rbac";

/**
 * Admin: one person's month, quarter or year, day by day, with an export.
 *
 * `?period=` and `?at=` drive everything and fall back to "this month" when
 * missing or malformed, so a hand-edited or stale link still opens.
 */

const PERIOD_LABEL: Record<Period, string> = { month: "Month", quarter: "Quarter", year: "Year" };

const COLUMNS = "grid-cols-[110px_70px_140px_minmax(160px,1fr)]";

export default async function MemberOverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{ period?: string; at?: string }>;
}) {
  const actor = await requirePageActor();
  const { userId } = await params;
  const query = await searchParams;

  const today = todayIso();
  const period: Period = PERIODS.includes(query.period as Period) ? (query.period as Period) : "month";
  const at = query.at && isValidDate(query.at) && query.at <= today ? query.at : today;

  let view;
  try {
    view = await memberPeriod(actor, userId, period, at, today);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) notFound();
    throw error;
  }

  const href = (p: Period, anchor: string) => `/dashboard/${userId}?period=${p}&at=${anchor}`;
  const previous = shiftPeriod(period, at, -1);
  const next = shiftPeriod(period, at, 1);
  const hasNext = periodRange(period, next, "9999-12-31").from <= today;
  const meta = [view.member.title, view.member.empId, view.member.region].filter(Boolean).join(" · ");

  return (
    <>
      <PageHeader title={view.member.name} subtitle={meta || "Attendance history"} meta={view.range.label} />

      <Link href="/dashboard" className="w-fit text-[13px] text-brand hover:underline">
        ← Overview
      </Link>

      <Card className="flex flex-wrap items-center justify-between gap-4 px-5 py-4">
        <nav aria-label="Period" className="flex gap-1 rounded-lg border border-line bg-subtle p-1">
          {PERIODS.map((p) => (
            <Link
              key={p}
              href={href(p, at)}
              aria-current={p === period ? "page" : undefined}
              className={`rounded-md px-3.5 py-1.5 text-[13px] ${
                p === period ? "bg-surface font-semibold shadow-sm" : "text-ink-2 hover:text-ink"
              }`}
            >
              {PERIOD_LABEL[p]}
            </Link>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          <Link href={href(period, previous)} aria-label="Previous" className={ghostButtonClass}>
            ‹
          </Link>
          <span className="min-w-[130px] text-center text-sm font-semibold">{view.range.label}</span>
          {hasNext ? (
            <Link href={href(period, next)} aria-label="Next" className={ghostButtonClass}>
              ›
            </Link>
          ) : (
            <span aria-hidden className={`${ghostButtonClass} cursor-default opacity-40`}>
              ›
            </span>
          )}
        </div>

        <a
          href={`/api/attendance/export?userId=${encodeURIComponent(userId)}&period=${period}&at=${at}`}
          className="cursor-pointer rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-dark"
          download
        >
          Export CSV
        </a>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {COUNTED_KINDS.map((kind) => (
          <Card key={kind} className="flex flex-col gap-1.5 px-4.5 py-3.5">
            <span className="font-mono text-[11px] tracking-[0.1em] text-muted uppercase">
              {DAY_KIND_STYLE[kind].label}
            </span>
            <span className="text-[26px] leading-none font-semibold">{view.counts[kind]}</span>
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted">
        {formatShort(view.range.from)} – {formatShort(view.range.to)}. Weekends and holidays are
        listed but not counted.
      </p>

      <Card className="overflow-x-auto">
        <div className="min-w-[520px]">
          <div
            className={`grid ${COLUMNS} gap-4 border-b border-line bg-subtle px-4.5 py-3 font-mono text-[11px] tracking-[0.08em] text-muted`}
          >
            <span>DATE</span>
            <span>DAY</span>
            <span>STATUS</span>
            <span>DETAIL</span>
          </div>
          {view.days.length === 0 ? (
            <p className="px-4.5 py-5 text-[13px] text-muted">Nothing to show for this period.</p>
          ) : (
            view.days.map((day) => {
              const style = DAY_KIND_STYLE[day.kind];
              const quiet = day.kind === "WEEKEND" || day.kind === "HOLIDAY";
              return (
                <div
                  key={day.date}
                  className={`grid ${COLUMNS} items-center gap-4 border-b border-line px-4.5 py-2.5 text-[13px] last:border-b-0 ${
                    quiet ? "bg-subtle/60 text-muted" : ""
                  }`}
                >
                  <span className="font-mono">{formatShort(day.date)}</span>
                  <span className="text-muted">{formatWeekdayShort(day.date)}</span>
                  <span>
                    <span
                      className={`rounded-md px-2 py-[3px] font-mono text-[11px] tracking-[0.08em] ${style.chip}`}
                    >
                      {style.label.toUpperCase()}
                    </span>
                  </span>
                  <span className="text-muted">{day.detail ?? ""}</span>
                </div>
              );
            })
          )}
        </div>
      </Card>
    </>
  );
}
