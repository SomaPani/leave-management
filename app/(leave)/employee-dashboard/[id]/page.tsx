import Link from "next/link";
import { notFound } from "next/navigation";

import { AttendanceRing, TrendChart } from "@/components/report/charts";
import { CalendarKey, MonthCalendar, PercentChip, Section, StatusShares } from "@/components/report/parts";
import { PrintButton } from "@/components/report/print-button";
import { primaryButtonClass, selectClass } from "@/components/ui";
import { todayIso } from "@/lib/attendance";
import {
  type ReportFilters,
  anchorOf,
  monthlyBreakdown,
  parseReportFilters,
  reportQuery,
  statusShares,
  summarizeDays,
  trend,
} from "@/lib/attendance-report";
import { MONTH_NAMES, formatWeekdayShort } from "@/lib/date";
import { type Period, shiftPeriod } from "@/lib/day-status";
import { DAY_KIND_STYLE } from "@/lib/day-style";
import { teamPeriod } from "@/lib/overview-service";
import { requirePageActor } from "@/lib/page-guards";

/**
 * Admin: one employee's attendance — opened from a name on the Employee
 * dashboard. Month, quarter or year (tabs), with the summary, trend,
 * month-by-month table, day-wise calendars and an Excel / PDF export of
 * exactly what is shown.
 *
 * Reads through the same `teamPeriod` + lib/attendance-report.ts as the
 * dashboard, narrowed to this person, so both pages agree. An id outside the
 * admin's organization (or an inactive member) is a 404.
 */

const PERIOD_LABEL: Record<Period, string> = {
  month: "Monthly",
  quarter: "Quarterly",
  year: "Yearly",
};

export default async function EmployeeReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await requirePageActor();
  const { id } = await params;
  const today = todayIso();
  const filters: ReportFilters = {
    ...parseReportFilters(await searchParams, today),
    memberId: id,
    regionId: null,
    viewId: null,
  };

  const view = await teamPeriod(
    actor,
    { period: filters.period, anchor: anchorOf(filters), memberId: id },
    today,
  );
  const person = view.people[0];
  if (!person) notFound();

  const summary = summarizeDays(person.days);
  const shares = statusShares(summary.counts);
  const points = trend(filters.period, view.range, person.days);
  // Months before the person joined have no days at all; leave them out.
  const months = monthlyBreakdown(view.range, person.days).filter((m) =>
    person.days.some((d) => d.date.startsWith(`${m.year}-${String(m.month + 1).padStart(2, "0")}`)),
  );
  const unit = filters.period === "month" ? "week" : "month";

  // The page's own query keeps only period / month / year; the person is the path.
  const pageQuery = (overrides: Partial<ReportFilters>) =>
    reportQuery({ ...filters, memberId: null }, overrides);
  const href = (overrides: Partial<ReportFilters>) => `/employee-dashboard/${id}?${pageQuery(overrides)}`;
  const at = (iso: string) => ({ year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) - 1 });
  const prev = at(shiftPeriod(filters.period, anchorOf(filters), -1));
  const next = at(shiftPeriod(filters.period, anchorOf(filters), 1));
  const excelHref = `/api/attendance/report?${reportQuery(filters)}`;
  const backHref = `/employee-dashboard?${reportQuery(filters, { memberId: null })}`;

  const thisYear = Number(today.slice(0, 4));
  const years = Array.from({ length: 5 }, (_, i) => thisYear - 3 + i);
  if (!years.includes(filters.year)) years.push(filters.year);

  const cards = [
    { label: "Working days", value: summary.workingDays, chip: "bg-brand-tint text-brand-dark" },
    { label: "Present", value: summary.counts.PRESENT, chip: DAY_KIND_STYLE.PRESENT.chip },
    { label: "Absent", value: summary.counts.ABSENT, chip: DAY_KIND_STYLE.ABSENT.chip },
    { label: "WFH", value: summary.counts.WFH, chip: DAY_KIND_STYLE.WFH.chip },
    { label: "Leave", value: summary.counts.LEAVE, chip: DAY_KIND_STYLE.LEAVE.chip },
    { label: "Not marked", value: summary.counts.NOT_MARKED, chip: DAY_KIND_STYLE.NOT_MARKED.chip },
  ];

  return (
    <>
      <Link href={backHref} className="-mb-3 w-fit text-[13px] text-brand hover:underline print:hidden">
        ← Employee dashboard
      </Link>

      <header className="flex flex-wrap items-end justify-between gap-6 border-b border-line pb-5">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-[27px] font-semibold tracking-[-0.015em]">{person.name}</h1>
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
            <span>
              Emp ID: <span className="font-mono text-ink-2">{person.empId ?? "—"}</span>
            </span>
            {person.title ? <span>{person.title}</span> : null}
            <span>Team: {person.region ?? "—"}</span>
          </p>
        </div>
        <div className="flex flex-wrap gap-3 print:hidden">
          <a
            href={excelHref}
            className="rounded-lg bg-[#15803d] px-4 py-2.5 text-sm font-semibold text-white no-underline transition-colors hover:bg-[#166534]"
          >
            Export to Excel
          </a>
          <PrintButton className="cursor-pointer rounded-lg bg-[#b91c1c] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#991b1b]" />
        </div>
        <p className="hidden font-mono text-xs text-muted print:block">{view.range.label}</p>
      </header>

      {/* Period picker */}
      <div className="flex flex-wrap items-end justify-between gap-4 print:hidden">
        <nav aria-label="Report period" className="flex rounded-lg border border-line bg-surface p-1">
          {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => {
            const active = p === filters.period;
            return (
              <Link
                key={p}
                href={href({ period: p })}
                aria-current={active ? "page" : undefined}
                className={`rounded-md px-4 py-1.5 text-[13px] ${
                  active ? "bg-brand font-semibold text-white" : "text-ink-2 hover:text-ink"
                }`}
              >
                {PERIOD_LABEL[p]}
              </Link>
            );
          })}
        </nav>

        <div className="flex flex-wrap items-end gap-3">
          <span className="flex items-center gap-1">
            <Link href={href(prev)} aria-label={`Previous ${filters.period}`} className="rounded-md px-2.5 py-1.5 text-brand hover:bg-subtle">
              ‹
            </Link>
            <span className="min-w-[130px] text-center text-sm font-semibold">{view.range.label}</span>
            <Link href={href(next)} aria-label={`Next ${filters.period}`} className="rounded-md px-2.5 py-1.5 text-brand hover:bg-subtle">
              ›
            </Link>
          </span>
          <form method="get" action={`/employee-dashboard/${id}`} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="period" value={filters.period} />
            <select name="month" defaultValue={String(filters.month + 1)} aria-label="Month" className={selectClass}>
              {MONTH_NAMES.map((name, i) => (
                <option key={name} value={i + 1}>
                  {name}
                </option>
              ))}
            </select>
            <select name="year" defaultValue={String(filters.year)} aria-label="Year" className={selectClass}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            <button type="submit" className={primaryButtonClass}>
              Go
            </button>
          </form>
        </div>
      </div>

      {/* Summary */}
      <Section title={`Summary — ${view.range.label}`}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {cards.map((card) => (
            <div key={card.label} className={`flex flex-col gap-1 rounded-xl px-4 py-4 ${card.chip}`}>
              <span className="text-[28px] leading-none font-semibold">{card.value}</span>
              <span className="text-[13px] text-ink-2">{card.label}</span>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted">
          Present + Absent + WFH + Leave + Not marked = {summary.workingDays} working days. Weekends and holidays are
          not counted.
          {summary.half > 0 ? ` ${summary.half} half ${summary.half === 1 ? "day counts" : "days count"} as 0.5.` : ""}
        </p>
      </Section>

      <div className="grid gap-7 xl:grid-cols-2">
        <Section title="Attendance percentage">
          <div className="grid items-center gap-6 sm:grid-cols-[auto_minmax(0,1fr)]">
            <AttendanceRing percent={summary.percent} />
            <StatusShares shares={shares} />
          </div>
          <p className="text-xs text-muted">
            Attendance % = days worked ÷ days marked Present, WFH or Absent. Leave and not-marked days are left out.
          </p>
        </Section>

        <Section title={`Attendance % by ${unit}`}>
          <TrendChart points={points} caption={`Attendance percentage by ${unit}, ${view.range.label}`} />
        </Section>
      </div>

      {/* Month-wise */}
      {months.length > 1 ? (
        <Section title="Month-wise attendance">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line bg-subtle text-left font-mono text-[11px] tracking-[0.06em] text-muted">
                  <th className="px-2.5 py-2.5 font-normal">MONTH</th>
                  <th className="px-2.5 py-2.5 text-right font-normal">DAYS</th>
                  <th className="px-2.5 py-2.5 text-right font-normal">PRESENT</th>
                  <th className="px-2.5 py-2.5 text-right font-normal">ABSENT</th>
                  <th className="px-2.5 py-2.5 text-right font-normal">WFH</th>
                  <th className="px-2.5 py-2.5 text-right font-normal">LEAVE</th>
                  <th className="px-2.5 py-2.5 text-right font-normal">NOT MARKED</th>
                  <th className="px-2.5 py-2.5 text-right font-normal">ATTENDANCE</th>
                </tr>
              </thead>
              <tbody>
                {months.map((m) => (
                  <tr key={m.label} className="border-b border-line last:border-b-0">
                    <td className="px-2.5 py-2.5">
                      <Link href={href({ period: "month", year: m.year, month: m.month })} className="font-semibold text-brand hover:underline">
                        {m.label}
                      </Link>
                    </td>
                    <td className="px-2.5 py-2.5 text-right tabular-nums">{m.summary.workingDays}</td>
                    <td className="px-2.5 py-2.5 text-right tabular-nums">
                      {m.summary.counts.PRESENT}
                      {m.summary.half > 0 ? <span className="text-muted">{` (${m.summary.half} half)`}</span> : null}
                    </td>
                    <td className="px-2.5 py-2.5 text-right tabular-nums">{m.summary.counts.ABSENT}</td>
                    <td className="px-2.5 py-2.5 text-right tabular-nums">{m.summary.counts.WFH}</td>
                    <td className="px-2.5 py-2.5 text-right tabular-nums">{m.summary.counts.LEAVE}</td>
                    <td className="px-2.5 py-2.5 text-right tabular-nums">{m.summary.counts.NOT_MARKED}</td>
                    <td className="px-2.5 py-2.5 text-right">
                      <PercentChip percent={m.summary.percent} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted">Click a month to see its days.</p>
        </Section>
      ) : null}

      {/* Day-wise */}
      <Section title="Day-wise attendance">
        {filters.period === "month" ? (
          <div className="grid gap-7 xl:grid-cols-2">
            <div className="flex flex-col gap-3">
              <MonthCalendar year={filters.year} month={filters.month} days={person.days} />
              <CalendarKey />
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-line bg-subtle text-left font-mono text-[11px] tracking-[0.06em] text-muted">
                    <th className="px-2.5 py-2 font-normal">DATE</th>
                    <th className="px-2.5 py-2 font-normal">DAY</th>
                    <th className="px-2.5 py-2 font-normal">STATUS</th>
                    <th className="px-2.5 py-2 font-normal">DETAIL</th>
                  </tr>
                </thead>
                <tbody>
                  {person.days.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-2.5 py-4 text-center text-muted">
                        Nothing to show yet for {view.range.label}.
                      </td>
                    </tr>
                  ) : (
                    person.days.map((d) => (
                      <tr key={d.date} className={`border-b border-line last:border-b-0 ${d.kind === "WEEKEND" ? "text-muted" : ""}`}>
                        <td className="px-2.5 py-1.5 font-mono text-[12px]">{d.date}</td>
                        <td className="px-2.5 py-1.5">{formatWeekdayShort(d.date)}</td>
                        <td className="px-2.5 py-1.5">
                          <span className={`rounded px-1.5 py-0.5 text-[12px] ${DAY_KIND_STYLE[d.kind].chip}`}>
                            {DAY_KIND_STYLE[d.kind].label}
                          </span>
                        </td>
                        <td className="px-2.5 py-1.5 text-ink-2">{d.detail ?? ""}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
              {months.map((m) => (
                <MonthCalendar key={m.label} year={m.year} month={m.month} days={person.days} compact />
              ))}
            </div>
            <CalendarKey compact />
            <p className="text-xs text-muted">Hover a day for its status, or pick Monthly to see the day-by-day list.</p>
          </>
        )}
      </Section>
    </>
  );
}
