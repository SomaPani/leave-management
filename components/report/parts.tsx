import type { ReactNode } from "react";

import { Card } from "@/components/ui";
import { type Band, type ShareKind, formatPercent, monthGrid, percentBand } from "@/lib/attendance-report";
import { MONTH_NAMES } from "@/lib/date";
import type { DayKind, ResolvedDay } from "@/lib/day-status";
import { DAY_KIND_STYLE } from "@/lib/day-style";

/** Shared pieces of the Employee dashboard and the per-employee page. */

export const BAND_CHIP: Record<Band, string> = {
  good: "bg-[#dcfce7] text-[#15803d]",
  warn: "bg-[#fef3c7] text-[#92400e]",
  bad: "bg-[#fee2e2] text-[#b91c1c]",
};

export const BAR_FILL: Record<ShareKind, string> = {
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

export function Section({
  step,
  title,
  action,
  children,
  className = "",
  id,
}: {
  step?: number;
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <Card className={`flex min-w-0 flex-col gap-4 p-5 break-inside-avoid ${className}`}>
      <div id={id} className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2.5 text-[17px] font-semibold">
          {step !== undefined ? (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-[13px] text-white">
              {step}
            </span>
          ) : null}
          {title}
        </h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

export function PercentChip({ percent }: { percent: number | null }) {
  const band = percentBand(percent);
  return (
    <span className={`inline-block rounded-md px-2 py-[3px] font-mono text-[12px] tabular-nums ${band ? BAND_CHIP[band] : "text-muted"}`}>
      {formatPercent(percent)}
    </span>
  );
}

export function StatusShares({ shares }: { shares: { kind: ShareKind; count: number; percent: number }[] }) {
  return (
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
  );
}

/** One month as a Sunday-first grid; `compact` for the quarter and year views. */
export function MonthCalendar({
  year,
  month,
  days,
  compact = false,
}: {
  year: number;
  month: number;
  days: ResolvedDay[];
  compact?: boolean;
}) {
  const grid = monthGrid(year, month, days);
  return (
    <div className="flex min-w-0 flex-col gap-2 break-inside-avoid">
      {compact ? <p className="text-[13px] font-semibold">{MONTH_NAMES[month]} {year}</p> : null}
      <div className="grid grid-cols-7 gap-1 text-center">
        {WEEKDAYS.map((w) => (
          <span key={w} className="py-1 font-mono text-[10px] text-muted">
            {compact ? w[0] : w}
          </span>
        ))}
        {grid.map((cell) => {
          if (cell.day === null) return <span key={cell.key} />;
          const style = cell.kind && cell.kind !== "WEEKEND" ? DAY_KIND_STYLE[cell.kind] : null;
          const code = cell.kind ? CELL_CODE[cell.kind] : null;
          const tip = [cell.date, style?.label ?? (cell.kind === "WEEKEND" ? "Weekend" : "Upcoming"), cell.detail]
            .filter(Boolean)
            .join(" · ");
          const off = cell.kind === "WEEKEND" || cell.kind === null;
          if (compact) {
            return (
              <span
                key={cell.key}
                title={tip}
                className={`flex h-7 items-center justify-center rounded text-[11px] ${
                  off ? "bg-subtle text-muted" : style ? `${style.chip} font-semibold` : "bg-surface"
                }`}
              >
                {cell.day}
              </span>
            );
          }
          return (
            <span
              key={cell.key}
              title={tip}
              className={`flex min-h-[52px] flex-col items-center justify-center gap-1 rounded-lg border border-line text-[12px] ${
                off ? "bg-subtle text-muted" : "bg-surface"
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
    </div>
  );
}

export function CalendarKey({ compact = false }: { compact?: boolean }) {
  const items: [DayKind, string][] = [
    ["PRESENT", "P Present"],
    ["ABSENT", "A Absent"],
    ["WFH", "WFH Work from home"],
    ["LEAVE", "L Leave"],
    ["HOLIDAY", "H Holiday"],
    ["NOT_MARKED", "– Not marked"],
  ];
  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
      {items.map(([kind, text]) =>
        compact ? (
          <span key={kind} className="flex items-center gap-1.5">
            <span className={`h-3 w-3 rounded-sm ${DAY_KIND_STYLE[kind].chip}`} aria-hidden="true" />
            {DAY_KIND_STYLE[kind].label}
          </span>
        ) : (
          <span key={kind}>{text}</span>
        ),
      )}
    </p>
  );
}
