import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { AttendanceRing, TrendChart } from "@/components/report/charts";
import { PercentChip, Section, StatusShares } from "@/components/report/parts";
import { EmptyPanel, primaryButtonClass, selectClass } from "@/components/ui";
import { ATTENDANCE_TIMEZONE, todayIso } from "@/lib/attendance";
import {
  type ReportFilters,
  anchorOf,
  combineSummaries,
  insight,
  parseReportFilters,
  reportQuery,
  statusShares,
  summarizeDays,
  teamWorkingDays,
  trend,
} from "@/lib/attendance-report";
import { MONTH_NAMES } from "@/lib/date";
import type { Period } from "@/lib/day-status";
import { DAY_KIND_STYLE } from "@/lib/day-style";
import { teamPeriod } from "@/lib/overview-service";
import { requirePageActor } from "@/lib/page-guards";

/**
 * Admin: the Employee dashboard — attendance for a month, quarter or year,
 * for everyone or one team. Each name opens that person's own page
 * (./[id]/page.tsx) with their month-, quarter- and year-wise detail and
 * exports.
 *
 * Every figure comes from one `teamPeriod` read and the pure functions in
 * lib/attendance-report.ts, so the cards, table, ring, trend and the CSV agree.
 * All state is in the query string: filters are a plain GET form and every
 * other control is a link, so the page needs no client script except the
 * print button.
 */

const PERIOD_LABEL: Record<Period, string> = {
  month: "Monthly",
  quarter: "Quarterly",
  year: "Yearly",
};

function formatUpdated(at: Date): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: ATTENDANCE_TIMEZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

export default async function EmployeeDashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requirePageActor();
  const today = todayIso();
  const filters = parseReportFilters(await searchParams, today);

  const view = await teamPeriod(
    actor,
    {
      period: filters.period,
      anchor: anchorOf(filters),
      memberId: filters.memberId,
      regionId: filters.regionId,
    },
    today,
  );

  const people = view.people.map((p) => ({ ...p, summary: summarizeDays(p.days) }));
  const overall = combineSummaries(people.map((p) => p.summary));
  const workingDays = teamWorkingDays(people.map((p) => p.days));
  const shares = statusShares(overall.counts);
  const allDays = people.flatMap((p) => p.days);
  const points = trend(filters.period, view.range, allDays);
  const note = insight(
    overall.percent,
    people.map((p) => ({ name: p.name, percent: p.summary.percent })),
    view.range.label,
  );

  const href = (overrides: Partial<ReportFilters>) =>
    `/employee-dashboard?${reportQuery(filters, overrides)}`;
  const exportHref = `/api/attendance/report?${reportQuery(filters, { viewId: null })}`;

  const thisYear = Number(today.slice(0, 4));
  const years = Array.from({ length: 5 }, (_, i) => thisYear - 3 + i);
  if (!years.includes(filters.year)) years.push(filters.year);

  const many = people.length > 1;

  return (
    <>
      <PageHeader
        title="Employee dashboard"
        subtitle="Track · Analyze · Export — attendance for a month, quarter or year."
        meta={view.range.label}
      />

      {/* 1 — Filters */}
      <Section
        step={1}
        title="Report filters"
        className="print:hidden"
        action={
          <span className="font-mono text-xs text-muted">
            {view.lastUpdated ? `Last updated: ${formatUpdated(view.lastUpdated)}` : "No changes in this period"}
          </span>
        }
      >
        <form method="get" action="/employee-dashboard" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            Employee
            <select name="member" defaultValue={filters.memberId ?? ""} className={selectClass}>
              <option value="">All employees</option>
              {view.everyone.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            Team
            <select name="team" defaultValue={filters.regionId ?? ""} className={selectClass}>
              <option value="">All teams</option>
              {view.regions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            Period
            <select name="period" defaultValue={filters.period} className={selectClass}>
              {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
                <option key={p} value={p}>
                  {PERIOD_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            Month
            <select name="month" defaultValue={String(filters.month + 1)} className={selectClass}>
              {MONTH_NAMES.map((name, i) => (
                <option key={name} value={i + 1}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            Year
            <select name="year" defaultValue={String(filters.year)} className={selectClass}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className={primaryButtonClass}>
            Apply
          </button>
          {filters.memberId || filters.regionId ? (
            <Link href={href({ memberId: null, regionId: null, viewId: null })} className="py-2.5 text-[13px] text-brand hover:underline">
              Clear
            </Link>
          ) : null}
        </form>
        {filters.period !== "month" ? (
          <p className="text-xs text-muted">
            {PERIOD_LABEL[filters.period]} shows the {filters.period} containing the chosen month: {view.range.label}.
          </p>
        ) : null}
      </Section>

      {people.length === 0 ? (
        <EmptyPanel>
          No one matches these filters. Pick another team or employee, or add people on the Team screen.
        </EmptyPanel>
      ) : (
        <>
          {/* 2 — Summary */}
          <Section step={2} title="Overall attendance summary">
            {/*
              Every card is in the same unit so they add up: with one person,
              days; with several, person-days (each person's working days
              summed). Mixing calendar days in the first card with person-days
              in the rest read as "14 working days, 27 present".
            */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {[
                {
                  label: many ? "Working person-days" : "Total working days",
                  value: overall.workingDays,
                  // "14 × 7" only when it is exactly that; someone who joined
                  // mid-period has fewer days, and the product would not match.
                  note: !many
                    ? null
                    : workingDays * people.length === overall.workingDays
                      ? `${workingDays} working days × ${people.length} people`
                      : `${workingDays} working days, ${people.length} people`,
                  chip: "bg-brand-tint text-brand-dark",
                },
                { label: "Present", value: overall.counts.PRESENT, note: null, chip: DAY_KIND_STYLE.PRESENT.chip },
                { label: "Absent", value: overall.counts.ABSENT, note: null, chip: DAY_KIND_STYLE.ABSENT.chip },
                { label: "WFH", value: overall.counts.WFH, note: null, chip: DAY_KIND_STYLE.WFH.chip },
                { label: "Leave", value: overall.counts.LEAVE, note: null, chip: DAY_KIND_STYLE.LEAVE.chip },
                { label: "Not marked", value: overall.counts.NOT_MARKED, note: null, chip: DAY_KIND_STYLE.NOT_MARKED.chip },
              ].map((card) => (
                <div key={card.label} className={`flex flex-col gap-1 rounded-xl px-4 py-4 ${card.chip}`}>
                  <span className="text-[28px] leading-none font-semibold">{card.value}</span>
                  <span className="text-[13px] text-ink-2">{card.label}</span>
                  {card.note ? <span className="text-[11px] text-muted">{card.note}</span> : null}
                </div>
              ))}
            </div>
            <p className="text-xs text-muted">
              {many
                ? `All figures are person-days: Present + Absent + WFH + Leave + Not marked = ${overall.workingDays}. `
                : ""}
              {overall.counts.NOT_MARKED > 0
                ? `Not-marked days are left out of the attendance percentage.`
                : "Every working day so far is marked."}
              {overall.half > 0 ? ` ${overall.half} half ${overall.half === 1 ? "day counts" : "days count"} as 0.5.` : ""}
            </p>
          </Section>

          <div className="grid gap-7">
            {/* 3 — Table */}
            <Section
              step={3}
              title="Employee-wise attendance"
              action={
                <a href={exportHref} className="rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink-2 hover:border-muted print:hidden">
                  Export CSV
                </a>
              }
            >
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-line bg-subtle text-left font-mono text-[11px] tracking-[0.06em] text-muted">
                      <th className="px-2.5 py-2.5 font-normal">#</th>
                      <th className="px-2.5 py-2.5 font-normal">EMPLOYEE</th>
                      <th className="px-2.5 py-2.5 font-normal">TEAM</th>
                      <th className="px-2.5 py-2.5 text-right font-normal">DAYS</th>
                      <th className="px-2.5 py-2.5 text-right font-normal">PRESENT</th>
                      <th className="px-2.5 py-2.5 text-right font-normal">ABSENT</th>
                      <th className="px-2.5 py-2.5 text-right font-normal">WFH</th>
                      <th className="px-2.5 py-2.5 text-right font-normal">LEAVE</th>
                      <th className="px-2.5 py-2.5 text-right font-normal">ATTENDANCE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {people.map((p, i) => {
                      return (
                        <tr key={p.id} className="border-b border-line last:border-b-0">
                          <td className="px-2.5 py-2.5 text-muted">{i + 1}</td>
                          <td className="px-2.5 py-2.5">
                            <Link
                              href={`/employee-dashboard/${p.id}?${reportQuery(filters, { memberId: null, regionId: null, viewId: null })}`}
                              className="font-semibold text-brand hover:underline"
                            >
                              {p.name}
                            </Link>
                            {p.empId ? <span className="ml-1.5 font-mono text-[11px] text-muted">{p.empId}</span> : null}
                          </td>
                          <td className="px-2.5 py-2.5 text-ink-2">{p.region ?? "—"}</td>
                          <td className="px-2.5 py-2.5 text-right tabular-nums">{p.summary.workingDays}</td>
                          <td className="px-2.5 py-2.5 text-right tabular-nums">
                            {p.summary.counts.PRESENT}
                            {p.summary.half > 0 ? <span className="text-muted">{` (${p.summary.half} half)`}</span> : null}
                          </td>
                          <td className="px-2.5 py-2.5 text-right tabular-nums">{p.summary.counts.ABSENT}</td>
                          <td className="px-2.5 py-2.5 text-right tabular-nums">{p.summary.counts.WFH}</td>
                          <td className="px-2.5 py-2.5 text-right tabular-nums">{p.summary.counts.LEAVE}</td>
                          <td className="px-2.5 py-2.5 text-right">
                            <PercentChip percent={p.summary.percent} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted">
                Click a name to open that employee&rsquo;s page: day-, month-, quarter- and year-wise attendance, with Excel and PDF export. Green is 90% or more, amber 75–90%, red under 75%.
              </p>
            </Section>

            {/* 4 — Percentage */}
            <Section step={4} title="Attendance percentage">
              <div className="grid items-center gap-6 md:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]">
                <AttendanceRing percent={overall.percent} />
                <StatusShares shares={shares} />
              <div
                className={`rounded-xl border px-4 py-3.5 text-[13px] ${
                  note.tone === "good"
                    ? "border-brand-tint bg-brand-tint/50"
                    : note.tone === "bad"
                      ? "border-danger-line bg-danger-tint"
                      : note.tone === "warn"
                        ? "border-warn-line bg-warn-tint"
                        : "border-line bg-subtle"
                }`}
              >
                <span className="mb-1 block font-semibold">Key insight</span>
                {note.text}
              </div>
              </div>
            </Section>
          </div>

          <div className="grid gap-7">
            {/* 5 — Trend */}
            <Section step={5} title="Monthly / quarterly / yearly report">
              <nav aria-label="Report period" className="flex border-b border-line print:hidden">
                {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => {
                  const active = p === filters.period;
                  return (
                    <Link
                      key={p}
                      href={href({ period: p })}
                      aria-current={active ? "page" : undefined}
                      className={`-mb-px flex-1 border-b-2 px-3 py-2 text-center text-[13px] ${
                        active ? "border-brand font-semibold text-brand" : "border-transparent text-ink-2 hover:text-ink"
                      }`}
                    >
                      {PERIOD_LABEL[p]}
                    </Link>
                  );
                })}
              </nav>
              <p className="text-[13px] text-ink-2">
                Attendance % by {filters.period === "month" ? "week" : "month"} — {view.range.label}
              </p>
              <div className="max-w-3xl">
              <TrendChart
                points={points}
                caption={`Attendance percentage by ${filters.period === "month" ? "week" : "month"}, ${view.range.label}`}
              />
              </div>
            </Section>
          </div>

        </>
      )}
    </>
  );
}
