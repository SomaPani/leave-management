import Link from "next/link";

import { DemoBanner } from "@/components/demo-banner";
import { PageHeader } from "@/components/page-header";
import { Card, MonoLabel } from "@/components/ui";
import { MONTH_NAMES, TODAY, formatDayMonth, shiftMonth } from "@/lib/date";
import {
  attendanceMonth,
  attendanceStats,
  holidaysForRegion,
  viewingRegion,
} from "@/lib/domain";
import { demoDb, demoMember } from "@/lib/demo-data";
import { ATTENDANCE_ORDER, LEGACY_ATTENDANCE_STYLE } from "@/lib/ui";

const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

const [DEFAULT_YEAR, DEFAULT_MONTH] = [
  Number(TODAY.slice(0, 4)),
  Number(TODAY.slice(5, 7)) - 1,
];

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ y?: string; m?: string; demo?: string }>;
}) {
  const params = await searchParams;
  const db = demoDb();
  const user = demoMember(db);

  const parsedYear = Number.parseInt(params.y ?? "", 10);
  const parsedMonth = Number.parseInt(params.m ?? "", 10);
  const year = Number.isInteger(parsedYear) ? parsedYear : DEFAULT_YEAR;
  const month =
    Number.isInteger(parsedMonth) && parsedMonth >= 0 && parsedMonth <= 11
      ? parsedMonth
      : DEFAULT_MONTH;

  const cells = attendanceMonth(db, user.id, year, month);
  const stats = attendanceStats(db, user.id, year, month);

  const region = viewingRegion(db, user);
  const holidays = holidaysForRegion(db, region);
  const holidayDays = holidays.reduce((n, h) => n + h.days, 0);

  const monthHref = (delta: number) => {
    const next = shiftMonth(year, month, delta);
    return `/calendar?y=${next.year}&m=${next.month}`;
  };

  const statCards = [
    { label: "Days present", value: stats.present },
    { label: "Half days", value: stats.half },
    { label: "Absent", value: stats.absent },
    { label: "Attendance", value: stats.percent },
  ];

  return (
    <>
      <PageHeader
        title="My attendance"
        subtitle="Every day since you joined the month."
        meta="MEMBER VIEW"
      />

      <DemoBanner action={params.demo} />

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

              const primary = cell.codes[0];
              const style = primary ? LEGACY_ATTENDANCE_STYLE[primary] : null;

              return (
                <span
                  key={cell.key}
                  title={cell.codes.map((c) => LEGACY_ATTENDANCE_STYLE[c].label).join(" + ")}
                  className={`flex aspect-square min-w-0 flex-col items-center justify-center gap-px overflow-hidden rounded-lg border ${
                    cell.weekend
                      ? "border-line bg-subtle text-[#cbd5e1]"
                      : style
                        ? `${style.chip} border-transparent`
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
                      : cell.codes.length
                        ? cell.codes.map((c) => LEGACY_ATTENDANCE_STYLE[c].short).join("")
                        : "–"}
                  </span>
                </span>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-2.5 border-t border-line pt-3.5">
            {ATTENDANCE_ORDER.map((code) => (
              <span
                key={code}
                className="flex items-center gap-1.5 text-[12.5px] text-ink-2"
              >
                <span
                  className={`size-3 rounded-[3px] border ${LEGACY_ATTENDANCE_STYLE[code].swatch}`}
                />
                {LEGACY_ATTENDANCE_STYLE[code].label}
              </span>
            ))}
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
            Marked by your admin. Approved leave appears automatically — flag anything
            wrong in the request thread.
          </p>

          <Card className="flex flex-col gap-3 p-4.5">
            <span className="flex items-baseline justify-between gap-2.5">
              <MonoLabel>HOLIDAYS</MonoLabel>
              <span className="font-mono text-[11px] text-muted">
                {region} · {holidayDays}
              </span>
            </span>
            {holidays.map((holiday) => (
              <span
                key={`${holiday.name}-${holiday.date}`}
                className="flex items-center gap-2.5 border-b border-line pb-2 last:border-b-0 last:pb-0"
              >
                <span className="size-[5px] shrink-0 rounded-full bg-accent" />
                <span className="min-w-0 flex-1 text-[12.5px]">{holiday.name}</span>
                <span className="font-mono text-[11.5px] text-muted">
                  {formatDayMonth(holiday.date)}
                </span>
              </span>
            ))}
          </Card>
        </div>
      </div>
    </>
  );
}
