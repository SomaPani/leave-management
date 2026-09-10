import Link from "next/link";

import { Role } from "@/generated/prisma/enums";
import { PageHeader } from "@/components/page-header";
import { ScoreChart } from "@/components/score-chart";
import { ScoreDayPanel } from "@/components/score-day-panel";
import { ScoreDayTable } from "@/components/score-day-table";
import { Avatar, Card, EmptyPanel, Meter, MonoLabel } from "@/components/ui";
import { todayIso } from "@/lib/attendance";
import { MONTH_NAMES, shiftMonth } from "@/lib/date";
import { requirePageRole } from "@/lib/page-guards";
import { summarizeMonth } from "@/lib/score";
import { findMemberScoreDays, listOrgScoreMonths } from "@/lib/score-service";

/**
 * Admin: the organization's score boards, one member at a time.
 *
 * The mirror of /score, and the reason both exist. `listOrgScoreMonths` scopes
 * to the actor's own organization through `visibleOrgId`, and the `?u=`
 * drill-down is scoped the same way *inside* its query — a member of another
 * organization returns null down the same path a nonexistent id does, so
 * neither is distinguishable from the outside.
 *
 * There is no edit affordance here either. An admin cannot change a score any
 * more than a member can: corrections come from the upstream recompute.
 */

/** Keeps `?y=` from rendering a month that cannot mean anything. */
function clampYear(value: number, fallback: number): number {
  return value >= 2000 && value <= 2100 ? value : fallback;
}

export default async function ScoresPage({
  searchParams,
}: {
  searchParams: Promise<{ u?: string; y?: string; m?: string; d?: string }>;
}) {
  const actor = await requirePageRole(Role.ADMIN);
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

  const roster = await listOrgScoreMonths(actor, year, month);
  const selected = params.u
    ? await findMemberScoreDays(actor, params.u, year, month)
    : null;

  const summary = selected ? summarizeMonth(selected.member.days) : null;
  const selectedDay = selected
    ? (selected.member.days.find((day) => day.date === params.d) ??
      selected.member.days[selected.member.days.length - 1] ??
      null)
    : null;

  const monthHref = (delta: number) => {
    const next = shiftMonth(year, month, delta);
    const who = params.u ? `&u=${params.u}` : "";
    return `/scores?y=${next.year}&m=${next.month}${who}`;
  };

  return (
    <>
      <PageHeader
        title="Employee score board"
        subtitle="Pick someone to see how their month scored."
        meta="ADMIN VIEW"
      />

      <div className="mb-5 flex items-center gap-3">
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

      <div className="grid max-w-[940px] items-start gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        <div className="flex flex-col gap-2">
          {roster.length === 0 ? (
            <EmptyPanel className="py-10">
              No active members in this organization yet.
            </EmptyPanel>
          ) : null}

          {roster.map((person) => {
            const active = selected?.member.id === person.id;
            const average = summarizeMonth(person.days).average;
            return (
              <Link
                key={person.id}
                href={
                  active
                    ? `/scores?y=${year}&m=${month}`
                    : `/scores?u=${person.id}&y=${year}&m=${month}`
                }
                className={`flex items-center gap-3 rounded-[10px] border px-3.5 py-3 text-left no-underline transition-colors ${
                  active
                    ? "border-brand bg-brand-tint"
                    : "border-line bg-surface hover:border-brand"
                }`}
              >
                <Avatar initials={person.initials} size={32} />
                <span className="flex flex-1 flex-col gap-0.5">
                  <span className="text-sm font-semibold text-ink">{person.name}</span>
                  <span className="text-xs text-muted">{person.title ?? "—"}</span>
                </span>
                <span className="font-mono text-[17px] font-semibold tracking-[-0.02em] text-ink">
                  {average ?? "—"}
                </span>
              </Link>
            );
          })}
        </div>

        {selected && summary ? (
          <div className="flex min-w-0 flex-col gap-5">
            <Card className="flex flex-wrap items-end justify-between gap-5 p-5.5">
              <span className="flex flex-col gap-2.5">
                <MonoLabel>MONTH AVERAGE</MonoLabel>
                <span className="flex items-baseline gap-2">
                  <span className="text-[52px] leading-none font-semibold tracking-[-0.03em]">
                    {summary.average ?? "—"}
                  </span>
                  <span className="text-sm text-muted">/ 100</span>
                </span>
              </span>
              <span className="flex flex-col items-end gap-2">
                <span className="rounded-full bg-brand-tint px-3 py-[5px] text-[13px] text-brand-dark">
                  {summary.band ?? "No score this month"}
                </span>
                <span className="flex flex-col gap-0.5 text-right">
                  <span className="text-sm font-semibold">{selected.member.name}</span>
                  <span className="text-xs text-muted">
                    {selected.member.title ?? "—"}
                  </span>
                </span>
              </span>
            </Card>

            {summary.average === null ? (
              <Card className="p-5.5 text-sm text-muted">
                No score has been recorded for {selected.member.name} this month.
              </Card>
            ) : (
              <>
                <Card className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-5 p-5.5">
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

                <Card className="flex flex-col gap-4.5 p-5.5">
                  <MonoLabel>BY DAY</MonoLabel>
                  <ScoreChart
                    days={selected.member.days}
                    hrefFor={(date) =>
                      `/scores?u=${selected.member.id}&y=${year}&m=${month}&d=${date}`
                    }
                  />
                </Card>

                <Card className="flex flex-col gap-3 px-5.5 pt-5 pb-1">
                  <MonoLabel>DAY BY DAY</MonoLabel>
                  <ScoreDayTable
                    days={selected.member.days}
                    selectedDate={selectedDay?.date}
                    hrefFor={(date) =>
                      `/scores?u=${selected.member.id}&y=${year}&m=${month}&d=${date}`
                    }
                  />
                </Card>

                {selectedDay ? (
                  <Card className="px-5.5 py-4">
                    <MonoLabel>THAT DAY</MonoLabel>
                    <ScoreDayPanel day={selectedDay} />
                  </Card>
                ) : null}
              </>
            )}

            <p className="text-[12.5px] text-muted">
              Scored upstream from Slack and Jira. A wrong score is corrected by the
              nightly recompute, not edited here.
            </p>
          </div>
        ) : (
          <EmptyPanel className="py-18">Click an employee to see their score.</EmptyPanel>
        )}
      </div>
    </>
  );
}
