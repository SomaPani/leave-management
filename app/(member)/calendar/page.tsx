import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { Card, MonoLabel } from "@/components/ui";
import { ATTENDANCE_CODES, codeLabel, todayIso } from "@/lib/attendance";
import { buildMonthCells, summarizeMonth } from "@/lib/attendance-month";
import { listMemberMonth } from "@/lib/attendance-service";
import { MONTH_NAMES, formatDayMonth, formatHeader, shiftMonth } from "@/lib/date";
import { listHolidays } from "@/lib/holiday-service";
import { holidaysInYear } from "@/lib/holidays";
import { requirePageActor } from "@/lib/page-guards";
import { ownProfile } from "@/lib/services";
import { ATTENDANCE_STYLE } from "@/lib/ui";

/**
 * Member: my own attendance, month by month.
 *
 * Reads `orgapp.Attendance` through `listMemberMonth` — which takes the id
 * from the session, never the URL — and the holiday calendar through
 * `listHolidays`, which narrows a member to their own region.
 *
 * The grid and the four stat cards both come from lib/attendance-month.ts, so
 * they cannot disagree about the month they are describing.
 */

const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

/** Keeps `?y=` from rendering a grid for a year that cannot mean anything. */
function clampYear(value: number, fallback: number): number {
  return value >= 2000 && value <= 2100 ? value : fallback;
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ y?: string; m?: string }>;
}) {
  const actor = await requirePageActor();
  const params = await searchParams;
  const profile = await ownProfile(actor);

  const today = todayIso();
  const currentYear = Number(today.slice(0, 4));
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

  const [marks, holidays] = await Promise.all([
    listMemberMonth(actor, actor.id, year, month),
    listHolidays(actor, { year }),
  ]);

  const cells = buildMonthCells(year, month, marks, holidays);
  const stats = summarizeMonth(marks);
  const yearHolidays = holidaysInYear(holidays, year);

  const monthHref = (delta: number) => {
    const next = shiftMonth(year, month, delta);
    return `/calendar?y=${next.year}&m=${next.month}`;
  };

  const statCards = [
    { label: "Days present", value: stats.present },
    { label: "Days at home", value: stats.wfh },
    { label: "Half days", value: stats.half },
    { label: "Absent", value: stats.absent },
    { label: "Attendance", value: stats.percent },
  ];

  return (
    <>
      <PageHeader
        title="My attendance"
        subtitle="Every day your admin has marked this month."
        meta={formatHeader(today)}
      />

      <div className="grid max-w-[940px] items-start gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-4 px-5.5 py-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[17px] font-semibold">
              {MONTH_NAMES[month]} {year}
            </h2>
            <span className="flex gap-1.5">
              <Link
                href={monthHref(-1)}
                aria-label="Previous month"
                className="flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 no-underline hover:border-muted"
              >
                ‹
              </Link>
              <Link
                href={monthHref(1)}
                aria-label="Next month"
                className="flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 no-underline hover:border-muted"
              >
                ›
              </Link>
            </span>
          </div>

          <div className="grid grid-cols-7 gap-[5px]">
            {WEEKDAY_INITIALS.map((day, index) => (
              <span
                key={index}
                className="text-center font-mono text-[11px] tracking-[0.08em] text-muted"
              >
                {day}
              </span>
            ))}

            {cells.map((cell) => {
              if (cell.day === null) {
                return <span key={cell.key} className="aspect-square" />;
              }

              // The add-on is the more informative colour when there is one: a
              // half day is what stands out on a month of ordinary days.
              const code = cell.state
                ? (cell.state.modifier ?? cell.state.status)
                : null;
              const style = code ? ATTENDANCE_STYLE[code] : null;

              const title = [
                cell.holiday,
                cell.state
                  ? [cell.state.status, cell.state.modifier]
                      .filter(Boolean)
                      .join(" + ")
                  : null,
              ]
                .filter(Boolean)
                .join(" · ");

              return (
                <span
                  key={cell.key}
                  title={title || undefined}
                  className={`flex aspect-square min-w-0 flex-col items-center justify-center gap-px overflow-hidden rounded-lg border ${
                    cell.weekend
                      ? "border-line bg-subtle text-[#cbd5e1]"
                      : style
                        ? `${style.chip} border-transparent`
                        : cell.holiday
                          ? "border-dashed border-accent bg-surface text-ink-2"
                          : "border-line bg-surface text-muted"
                  }`}
                >
                  <span
                    className={`text-[13px] leading-none ${style ? "font-semibold" : ""}`}
                  >
                    {cell.day}
                  </span>
                  <span className="font-mono text-[9px] leading-none tracking-[0.04em]">
                    {cell.weekend
                      ? ""
                      : style
                        ? `${ATTENDANCE_STYLE[cell.state!.status].short}${
                            cell.state!.modifier
                              ? ATTENDANCE_STYLE[cell.state!.modifier].short
                              : ""
                          }`
                        : cell.holiday
                          ? "H"
                          : "–"}
                  </span>
                </span>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-2.5 border-t border-line pt-3.5">
            {/* The same order and the same wording as the admin grid:
                ATTENDANCE_CODES and codeLabel own both, so the legend cannot
                drift from the buttons that produce these marks. */}
            {ATTENDANCE_CODES.map((code) => (
              <span
                key={code}
                className="flex items-center gap-1.5 text-[12.5px] text-ink-2"
              >
                <span
                  className={`size-3 rounded-[3px] border ${ATTENDANCE_STYLE[code].swatch}`}
                />
                {codeLabel(code)}
              </span>
            ))}
            <span className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
              <span className="size-3 rounded-[3px] border border-dashed border-accent" />
              Holiday
            </span>
          </div>
        </Card>

        <div className="flex min-w-0 flex-col gap-3">
          {statCards.map((stat) => (
            <Card
              key={stat.label}
              className="flex items-baseline justify-between gap-3 px-4.5 py-4"
            >
              <span className="text-[13px] text-muted">{stat.label}</span>
              <span className="text-2xl font-semibold tracking-[-0.02em]">
                {stat.value}
              </span>
            </Card>
          ))}

          <p className="text-[12.5px] leading-relaxed text-muted">
            Marked by your admin over {stats.counted}{" "}
            {stats.counted === 1 ? "day" : "days"} this month. Days of approved
            leave are left out of the percentage. Flag anything wrong in the
            request thread.
          </p>

          <Card className="flex flex-col gap-3 p-4.5">
            <span className="flex items-baseline justify-between gap-2.5">
              <MonoLabel>HOLIDAYS {year}</MonoLabel>
              <span className="font-mono text-[11px] text-muted">
                {profile.region?.name ?? "All regions"}
              </span>
            </span>

            {yearHolidays.length === 0 ? (
              <span className="text-[12.5px] text-muted">
                No holidays are on the calendar for {year} yet.
              </span>
            ) : (
              yearHolidays.map((holiday) => (
                <span
                  key={holiday.id}
                  className="flex items-center gap-2.5 border-b border-line pb-2 last:border-b-0 last:pb-0"
                >
                  <span className="size-[5px] shrink-0 rounded-full bg-accent" />
                  <span className="min-w-0 flex-1 text-[12.5px]">{holiday.name}</span>
                  <span className="font-mono text-[11.5px] text-muted">
                    {holiday.startDate === holiday.endDate
                      ? formatDayMonth(holiday.startDate)
                      : `${formatDayMonth(holiday.startDate)} – ${formatDayMonth(holiday.endDate)}`}
                  </span>
                </span>
              ))
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
