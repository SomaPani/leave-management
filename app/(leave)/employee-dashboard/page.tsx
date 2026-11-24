import Link from "next/link";
import type { ReactNode } from "react";

import { PageHeader } from "@/components/page-header";
import { AttendanceRing, TrendChart } from "@/components/report/charts";
import { AutoPrint, PrintButton } from "@/components/report/print-button";
import { Card, EmptyPanel, primaryButtonClass, selectClass } from "@/components/ui";
import { ATTENDANCE_TIMEZONE, todayIso } from "@/lib/attendance";
import {
  type Band,
  type ReportFilters,
  anchorOf,
  combineSummaries,
  formatPercent,
  insight,
  monthGrid,
  parseReportFilters,
  percentBand,
  reportQuery,
  statusShares,
  summarizeDays,
  teamWorkingDays,
  trend,
} from "@/lib/attendance-report";
import { MONTH_NAMES } from "@/lib/date";
import type { DayKind, Period } from "@/lib/day-status";
import { DAY_KIND_STYLE } from "@/lib/day-style";
import { teamPeriod } from "@/lib/overview-service";
import { requirePageActor } from "@/lib/page-guards";

/**
 * Admin: the Employee dashboard — attendance for a month, quarter or year,
 * for everyone or one team or one person, with a CSV and a printable export.
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

const BAND_CHIP: Record<Band, string> = {
  good: "bg-[#dcfce7] text-[#15803d]",
  warn: "bg-[#fef3c7] text-[#92400e]",
  bad: "bg-[#fee2e2] text-[#b91c1c]",
};

const BAR_FILL: Record<"PRESENT" | "ABSENT" | "WFH" | "LEAVE", string> = {
  PRESENT: "bg-[#16a34a]",
  ABSENT: "bg-[#dc2626]",
  WFH: "bg-[#2563eb]",
  LEAVE: "bg-[#d97706]",
};

/** The letter a calendar cell shows; colour is never the only signal. */
const CELL_CODE: Partial<Record<DayKind, string>> = {
  PRESENT: "P",
  WFH: "WFH",
  ABSENT: "A",
  LEAVE: "L",
  HOLIDAY: "H",
  NOT_MARKED: "–",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function Section({
  step,
  title,
  action,
  children,
  className = "",
}: {
  step: number;
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={`flex min-w-0 flex-col gap-4 p-5 break-inside-avoid ${className}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2.5 text-[17px] font-semibold">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-[13px] text-white">
            {step}
          </span>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

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
  const params = await searchParams;
  const filters = parseReportFilters(params, today);
  const autoPrint = params.print === "1";

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

  const viewed =
    people.find((p) => p.id === filters.viewId) ??
    people.find((p) => p.id === filters.memberId) ??
    people[0] ??
    null;

  const href = (overrides: Partial<ReportFilters>) =>
    `/employee-dashboard?${reportQuery(filters, overrides)}`;
  const exportHref = `/api/attendance/report?${reportQuery(filters, { viewId: null })}`;

  const thisYear = Number(today.slice(0, 4));
  const years = Array.from({ length: 5 }, (_, i) => thisYear - 3 + i);
  if (!years.includes(filters.year)) years.push(filters.year);

  const prevMonth = filters.month === 0 ? { month: 11, year: filters.year - 1 } : { month: filters.month - 1, year: filters.year };
  const nextMonth = filters.month === 11 ? { month: 0, year: filters.year + 1 } : { month: filters.month + 1, year: filters.year };
  const viewedId = viewed?.id ?? null;
  const grid = viewed ? monthGrid(filters.year, filters.month, viewed.days) : [];
  const many = people.length > 1;

  // Once someone is picked — a name clicked in the table, or the Employee
  // filter — Export covers only that person, for the month on the calendar.
  const picked = filters.viewId || filters.memberId ? viewed : null;
  const pickedQuery = picked
    ? reportQuery(filters, { period: "month", memberId: picked.id, regionId: null, viewId: picked.id })
    : null;
  const excelHref = pickedQuery ? `/api/attendance/report?${pickedQuery}` : exportHref;
  const pdfHref = pickedQuery ? `/employee-dashboard?${pickedQuery}&print=1` : null;
  const pickedLabel = picked ? `${picked.name} – ${MONTH_NAMES[filters.month]} ${filters.year}` : null;

  return (
    <>
      {autoPrint ? <AutoPrint /> : null}
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
                      const band = percentBand(p.summary.percent);
                      const selected = p.id === viewedId;
                      return (
                        <tr key={p.id} className={`border-b border-line last:border-b-0 ${selected ? "bg-brand-tint/40" : ""}`}>
                          <td className="px-2.5 py-2.5 text-muted">{i + 1}</td>
                          <td className="px-2.5 py-2.5">
                            <Link
                              href={`${href({ viewId: p.id })}#daily`}
                              aria-current={selected ? "true" : undefined}
                              className="font-semibold text-brand hover:underline"
                            >
                              {p.name}
                            </Link>
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
                            <span className={`inline-block rounded-md px-2 py-[3px] font-mono text-[12px] tabular-nums ${band ? BAND_CHIP[band] : "text-muted"}`}>
                              {formatPercent(p.summary.percent)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted">
                Click a name to see their days below. Green is 90% or more, amber 75–90%, red under 75%.
              </p>
            </Section>

            {/* 4 — Percentage */}
            <Section step={4} title="Attendance percentage">
              <div className="grid items-center gap-6 md:grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)]">
                <AttendanceRing percent={overall.percent} />
                <ul className="m-0 flex min-w-[200px] list-none flex-col gap-3 p-0">
                  {shares.map((s) => (
                    <li key={s.kind} className="flex flex-col gap-1">
                      <span className="flex items-center justify-between gap-3 text-[13px]">
                        <span className="flex items-center gap-2">
                          <span className={`h-2.5 w-2.5 rounded-full ${BAR_FILL[s.kind]}`} aria-hidden="true" />
                          {DAY_KIND_STYLE[s.kind].label}
                        </span>
                        <span className="font-semibold tabular-nums">
                          {formatPercent(s.percent)}
                          <span className="ml-1.5 font-normal text-muted">({s.count})</span>
                        </span>
                      </span>
                      <span className="h-1.5 overflow-hidden rounded-full bg-line" aria-hidden="true">
                        <span className={`block h-full rounded-full ${BAR_FILL[s.kind]}`} style={{ width: `${s.percent}%` }} />
                      </span>
                    </li>
                  ))}
                </ul>
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

          <div className="grid gap-7 xl:grid-cols-2">
            {/* 5 — Daily details */}
            <Section
              step={5}
              title="Daily attendance details"
              action={
                <span className="flex items-center gap-1 print:hidden">
                  <Link href={`${href({ ...prevMonth, viewId: viewedId })}#daily`} aria-label="Previous month" className="rounded-md px-2 py-1 text-brand hover:bg-subtle">
                    ‹
                  </Link>
                  <Link href={`${href({ ...nextMonth, viewId: viewedId })}#daily`} aria-label="Next month" className="rounded-md px-2 py-1 text-brand hover:bg-subtle">
                    ›
                  </Link>
                </span>
              }
            >
              <div id="daily" className="flex flex-col gap-3">
                <p className="text-sm font-semibold">
                  {viewed?.name} – {MONTH_NAMES[filters.month]} {filters.year}
                </p>
                <div className="grid grid-cols-7 gap-1 text-center">
                  {WEEKDAYS.map((w) => (
                    <span key={w} className="py-1 font-mono text-[11px] text-muted">
                      {w}
                    </span>
                  ))}
                  {grid.map((cell) => {
                    if (cell.day === null) return <span key={cell.key} />;
                    const style = cell.kind && cell.kind !== "WEEKEND" ? DAY_KIND_STYLE[cell.kind] : null;
                    const code = cell.kind ? CELL_CODE[cell.kind] : null;
                    const tip = [cell.date, style?.label ?? (cell.kind === "WEEKEND" ? "Weekend" : "Upcoming"), cell.detail]
                      .filter(Boolean)
                      .join(" · ");
                    return (
                      <span
                        key={cell.key}
                        title={tip}
                        className={`flex min-h-[52px] flex-col items-center justify-center gap-1 rounded-lg border border-line text-[12px] ${
                          cell.kind === "WEEKEND" || cell.kind === null ? "bg-subtle text-muted" : "bg-surface"
                        }`}
                      >
                        <span>{cell.day}</span>
                        {code && style ? (
                          <span className={`rounded px-1.5 font-mono text-[10px] font-semibold ${style.chip}`}>{code}</span>
                        ) : null}
                      </span>
                    );
                  })}
                </div>
                <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  <span>P Present</span>
                  <span>A Absent</span>
                  <span>WFH Work from home</span>
                  <span>L Leave</span>
                  <span>H Holiday</span>
                  <span>– Not marked</span>
                </p>
              </div>
            </Section>

            {/* 6 — Trend */}
            <Section step={6} title="Monthly / quarterly / yearly report">
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
              <TrendChart
                points={points}
                caption={`Attendance percentage by ${filters.period === "month" ? "week" : "month"}, ${view.range.label}`}
              />
            </Section>
          </div>

          {/* 7 — Export */}
          <Section step={7} title="Export reports" className="print:hidden">
            <p className="text-sm text-ink-2">
              {pickedLabel ? (
                <>
                  Download <span className="font-semibold">{pickedLabel}</span> only: the summary and every day of
                  the month.
                </>
              ) : (
                <>Download the employee-wise report for {view.range.label}, with the filters above.</>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <a href={excelHref} className="rounded-lg bg-[#15803d] px-5 py-3 text-sm font-semibold text-white no-underline transition-colors hover:bg-[#166534]">
                Export to Excel
              </a>
              {pdfHref ? (
                <a href={pdfHref} target="_blank" rel="noopener" className="cursor-pointer rounded-lg bg-[#b91c1c] px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#991b1b] no-underline">
                  Export to PDF
                </a>
              ) : (
                <PrintButton className="cursor-pointer rounded-lg bg-[#b91c1c] px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#991b1b]" />
              )}
              {picked && many ? (
                <a href={exportHref} className="text-[13px] text-brand hover:underline">
                  or export all employees ({view.range.label})
                </a>
              ) : null}
            </div>
            <p className="rounded-lg border border-brand-tint bg-brand-tint/50 px-4 py-3 text-[13px] text-brand-dark">
              ✓ Reports are ready to download. Excel opens the .csv file directly; for PDF choose “Save as PDF” in the print dialog.
            </p>
          </Section>
        </>
      )}
    </>
  );
}
