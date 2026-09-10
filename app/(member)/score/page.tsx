import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { ScoreChart } from "@/components/score-chart";
import { ScoreDayPanel } from "@/components/score-day-panel";
import { ScoreDayTable } from "@/components/score-day-table";
import { Card, EmptyPanel, Meter, MonoLabel } from "@/components/ui";
import { todayIso } from "@/lib/attendance";
import { MONTH_NAMES, shiftMonth } from "@/lib/date";
import { requirePageActor } from "@/lib/page-guards";
import { summarizeMonth } from "@/lib/score";
import { listOwnScoreDays } from "@/lib/score-service";

/**
 * Member: my own performance score, month by month.
 *
 * Self-scoped like /calendar and /requests: `listOwnScoreDays` takes no user id
 * at all — the subject is the session — so there is no id in the URL for a
 * member to change into a colleague's.
 *
 * Nothing here computes a score. The rubric lives in the Standup-Automation
 * pipeline and arrives already decided; this screen only summarises a month of
 * it, and there is deliberately no way to edit a day. A wrong score is
 * corrected upstream and re-pushed.
 *
 * `Not Scored` days are shown as such and left out of the average. Folding
 * them in as zeros would turn a Jira outage into somebody's bad month.
 */

/** Keeps `?y=` from rendering a month that cannot mean anything. */
function clampYear(value: number, fallback: number): number {
  return value >= 2000 && value <= 2100 ? value : fallback;
}

export default async function ScorePage({
  searchParams,
}: {
  searchParams: Promise<{ y?: string; m?: string; d?: string }>;
}) {
  const actor = await requirePageActor();
  const params = await searchParams;

  const today = todayIso();
  const currentYear = Number(today.slice(0, 4));
  // 0-based, the convention monthBounds and /calendar already share.
  const currentMonth = Number(today.slice(5, 7)) - 1;

  const parsedYear = Number.parseInt(params.y ?? "", 10);
  const parsedMonth = Number.parseInt(params.m ?? "", 10);

  const year = Number.isInteger(parsedYear)
    ? clampYear(parsedYear, currentYear)
    : currentYear;
  const month =
    Number.isInteger(parsedMonth) && parsedMonth >= 0 && parsedMonth <= 11
      ? parsedMonth
      : currentMonth;

  const days = await listOwnScoreDays(actor, year, month);
  const summary = summarizeMonth(days);

  // The day whose breakdown is open. Defaults to the last day with a row, so
  // the panel is never empty on arrival.
  const selected =
    days.find((day) => day.date === params.d) ?? days[days.length - 1] ?? null;

  const monthHref = (delta: number) => {
    const next = shiftMonth(year, month, delta);
    return `/score?y=${next.year}&m=${next.month}`;
  };

  return (
    <>
      <PageHeader
        title="My score board"
        subtitle="How your stand-ups and Jira tickets scored, day by day."
        meta="MEMBER VIEW"
      />

      <div className="flex max-w-[940px] flex-col gap-5">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold">
            {MONTH_NAMES[month]} {year}
          </span>
          <Link
            href={monthHref(-1)}
            aria-label="Previous month"
            className="text-sm text-muted no-underline hover:text-ink"
          >
            ←
          </Link>
          <Link
            href={monthHref(1)}
            aria-label="Next month"
            className="text-sm text-muted no-underline hover:text-ink"
          >
            →
          </Link>
        </div>

        {summary.average === null ? (
          <EmptyPanel className="py-18">
            No score has been recorded for you this month.
          </EmptyPanel>
        ) : (
          <>
            <div className="grid items-stretch gap-5 lg:grid-cols-[280px_1fr]">
              <Card className="flex flex-col gap-3.5 p-6">
                <MonoLabel>MONTH AVERAGE</MonoLabel>
                <span className="flex items-baseline gap-2">
                  <span className="text-[64px] leading-none font-semibold tracking-[-0.03em]">
                    {summary.average}
                  </span>
                  <span className="text-sm text-muted">/ 100</span>
                </span>
                <span className="self-start rounded-full bg-brand-tint px-3 py-[5px] text-[13px] text-brand-dark">
                  {summary.band}
                </span>
                <span className="mt-auto text-xs leading-relaxed text-muted">
                  {summary.daysScored} day{summary.daysScored === 1 ? "" : "s"} scored
                  {summary.daysNotScored > 0
                    ? `, ${summary.daysNotScored} not scored and left out of the average`
                    : ""}
                  .
                </span>
              </Card>

              <Card className="grid gap-5 p-5.5 sm:grid-cols-2">
                {summary.checks.map((check) => (
                  <div key={check.key} className="flex flex-col gap-2.5">
                    <span className="flex items-baseline justify-between gap-2.5">
                      <span className="text-[13px] text-muted">{check.label}</span>
                      <span className="text-[19px] font-semibold tracking-[-0.015em]">
                        {check.average === null ? "—" : check.average}
                        <span className="text-sm text-muted"> / {check.cap}</span>
                      </span>
                    </span>
                    <Meter
                      percent={
                        check.average === null ? 0 : (check.average / check.cap) * 100
                      }
                      label={check.label}
                    />
                  </div>
                ))}
              </Card>
            </div>

            <div className="grid items-start gap-5 lg:grid-cols-2">
              <Card className="flex flex-col gap-4.5 p-5.5">
                <MonoLabel>BY DAY</MonoLabel>
                <ScoreChart
                  days={days}
                  hrefFor={(date) => `/score?y=${year}&m=${month}&d=${date}`}
                />
              </Card>

              <Card className="flex flex-col px-5.5 pt-1.5 pb-3">
                {(
                  [
                    ["Days scored", summary.daysScored],
                    ["Not scored", summary.daysNotScored],
                    ["Tasks picked", summary.tasksPicked],
                    ["Tasks done", summary.tasksDone],
                    ["Coordination days", summary.coordinationDays],
                    ["Absent", summary.daysAbsent],
                  ] as const
                ).map(([label, value]) => (
                  <span
                    key={label}
                    className="flex items-center justify-between gap-3 border-b border-line py-2.5 last:border-b-0"
                  >
                    <span className="text-[13.5px] text-ink-2">{label}</span>
                    <span className="font-mono text-[13.5px] font-semibold">{value}</span>
                  </span>
                ))}
              </Card>
            </div>

            <Card className="flex flex-col gap-3 px-5.5 pt-5 pb-1">
              <MonoLabel>DAY BY DAY</MonoLabel>
              <ScoreDayTable
                days={days}
                selectedDate={selected?.date}
                hrefFor={(date) => `/score?y=${year}&m=${month}&d=${date}`}
              />
            </Card>

            {selected ? (
              <Card className="px-5.5 py-4">
                <MonoLabel>THAT DAY</MonoLabel>
                <ScoreDayPanel day={selected} />
              </Card>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
