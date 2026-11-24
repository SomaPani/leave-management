import { MONTH_NAMES, daysInMonth, firstWeekdayOfMonth, formatWeekdayShort, isoDate } from "@/lib/date";
import {
  type CountedKind,
  type DayCounts,
  type DayKind,
  MODIFIER_DETAIL,
  PERIODS,
  type Period,
  type ResolvedDay,
  countDays,
} from "@/lib/day-status";

/**
 * The admin Employee dashboard's numbers: filters, per-person and team
 * summaries, the trend, the insight line and the CSV rows.
 *
 * Pure — every figure is computed here from `ResolvedDay[]`, which
 * lib/day-status.ts decides and lib/overview-service.ts loads. Cards, table,
 * donut, trend and export all read through these functions, so no two panels
 * can describe the same period differently.
 *
 * The percentage is the member calendar's rule (lib/attendance-month.ts):
 * days worked ÷ days marked Present, WFH or Absent, a half day worth 0.5.
 * Leave and unmarked days are left out of it, so taking approved leave never
 * lowers anyone's attendance and a day nobody marked is not an absence.
 */

/* --------------------------------------------------------------- filters -- */

export type ReportFilters = {
  period: Period;
  year: number;
  /** 0-based. The period is the month, quarter or year containing it. */
  month: number;
  /** Only this member in the table, cards and trend. */
  memberId: string | null;
  /** Only members of this region ("Team"). */
  regionId: string | null;
  /** Whose daily calendar section 5 shows. */
  viewId: string | null;
};

type Params = Record<string, string | string[] | undefined>;

function first(params: Params, key: string): string | null {
  const raw = params[key];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value ? value : null;
}

function intIn(value: string | null, min: number, max: number): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/** URL search params → filters. Anything unrecognised falls back; never throws. */
export function parseReportFilters(params: Params, today: string): ReportFilters {
  const period = first(params, "period");
  const month = intIn(first(params, "month"), 1, 12);
  return {
    period: PERIODS.includes(period as Period) ? (period as Period) : "month",
    year: intIn(first(params, "year"), 2000, 2100) ?? Number(today.slice(0, 4)),
    month: month !== null ? month - 1 : Number(today.slice(5, 7)) - 1,
    memberId: first(params, "member"),
    regionId: first(params, "team"),
    viewId: first(params, "view"),
  };
}

/** The 1st of the filter's month — the anchor `periodRange` expects. */
export function anchorOf(filters: ReportFilters): string {
  return isoDate(filters.year, filters.month, 1);
}

/** Filters back to a query string, with overrides. Empty values are dropped. */
export function reportQuery(filters: ReportFilters, overrides: Partial<ReportFilters> = {}): string {
  const f = { ...filters, ...overrides };
  const params = new URLSearchParams();
  params.set("period", f.period);
  params.set("month", String(f.month + 1));
  params.set("year", String(f.year));
  if (f.memberId) params.set("member", f.memberId);
  if (f.regionId) params.set("team", f.regionId);
  if (f.viewId) params.set("view", f.viewId);
  return params.toString();
}

/* ------------------------------------------------------------- summaries -- */

export type Summary = {
  counts: DayCounts;
  /** Days that count at all: everything except weekends and holidays. */
  workingDays: number;
  /** Present or WFH days that were half days. */
  half: number;
  /** Numerator: present + WFH, a half day worth 0.5. */
  worked: number;
  /** Denominator: days marked Present, WFH or Absent. */
  scored: number;
  /** 0–100, or null when nothing counts yet. */
  percent: number | null;
};

const HALF_DAY = MODIFIER_DETAIL.HALF_DAY;

function isHalf(day: ResolvedDay): boolean {
  return (day.kind === "PRESENT" || day.kind === "WFH") && day.detail === HALF_DAY;
}

function finish(counts: DayCounts, half: number): Summary {
  const worked = counts.PRESENT + counts.WFH - half * 0.5;
  const scored = counts.PRESENT + counts.WFH + counts.ABSENT;
  const workingDays = counts.PRESENT + counts.WFH + counts.ABSENT + counts.LEAVE + counts.NOT_MARKED;
  return {
    counts,
    workingDays,
    half,
    worked,
    scored,
    percent: scored === 0 ? null : (worked / scored) * 100,
  };
}

export function summarizeDays(days: ResolvedDay[]): Summary {
  return finish(countDays(days), days.filter(isHalf).length);
}

/** Many people's summaries as one, weighted by days. */
export function combineSummaries(summaries: Summary[]): Summary {
  const counts: DayCounts = { PRESENT: 0, WFH: 0, ABSENT: 0, LEAVE: 0, NOT_MARKED: 0 };
  let half = 0;
  for (const s of summaries) {
    for (const kind of Object.keys(counts) as CountedKind[]) counts[kind] += s.counts[kind];
    half += s.half;
  }
  return finish(counts, half);
}

/**
 * Distinct dates that were a working day for at least one person — the
 * "Total working days" card. Summing people's days would give person-days,
 * which is not what the card means.
 */
export function teamWorkingDays(dayLists: ResolvedDay[][]): number {
  const dates = new Set<string>();
  for (const days of dayLists) {
    for (const day of days) {
      if (day.kind !== "WEEKEND" && day.kind !== "HOLIDAY") dates.add(day.date);
    }
  }
  return dates.size;
}

export function formatPercent(percent: number | null): string {
  if (percent === null) return "—";
  return `${Number(percent.toFixed(2))}%`;
}

export type Band = "good" | "warn" | "bad";

export function percentBand(percent: number | null): Band | null {
  if (percent === null) return null;
  if (percent >= 90) return "good";
  if (percent >= 75) return "warn";
  return "bad";
}

export type ShareKind = "PRESENT" | "ABSENT" | "WFH" | "LEAVE";

export const SHARE_KINDS: ShareKind[] = ["PRESENT", "ABSENT", "WFH", "LEAVE"];

/** Each status's share of the days that have one — the donut. */
export function statusShares(counts: DayCounts): { kind: ShareKind; count: number; percent: number }[] {
  const total = SHARE_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
  return SHARE_KINDS.map((kind) => ({
    kind,
    count: counts[kind],
    percent: total === 0 ? 0 : (counts[kind] / total) * 100,
  }));
}

/* ----------------------------------------------------------------- trend -- */

export type TrendPoint = { label: string; percent: number | null };

const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));

/**
 * Attendance % over the period: per week (days 1–7, 8–14, …) for a month,
 * per month for a quarter or a year. A bucket with nothing scored — the
 * future, or a week nobody marked — is `null`, drawn as a gap, not as 0%.
 */
export function trend(period: Period, range: { from: string; to: string }, days: ResolvedDay[]): TrendPoint[] {
  const year = Number(range.from.slice(0, 4));
  const month = Number(range.from.slice(5, 7)) - 1;

  let labels: string[];
  let bucketOf: (date: string) => number;

  if (period === "month") {
    const weeks = Math.ceil(daysInMonth(year, month) / 7);
    labels = Array.from({ length: weeks }, (_, i) => `Week ${i + 1}`);
    bucketOf = (date) => Math.floor((Number(date.slice(8, 10)) - 1) / 7);
  } else {
    const months = period === "quarter" ? 3 : 12;
    labels = Array.from({ length: months }, (_, i) => MONTH_SHORT[(month + i) % 12]!);
    const start = year * 12 + month;
    bucketOf = (date) => Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1 - start;
  }

  const buckets: ResolvedDay[][] = labels.map(() => []);
  for (const day of days) buckets[bucketOf(day.date)]?.push(day);

  return labels.map((label, i) => ({ label, percent: summarizeDays(buckets[i]!).percent }));
}

/* --------------------------------------------------------------- insight -- */

/** One sentence about the period, worst news first. */
export function insight(
  overall: number | null,
  rows: { name: string; percent: number | null }[],
  label: string,
): { tone: Band | "neutral"; text: string } {
  if (overall === null) {
    return { tone: "neutral", text: `No attendance has been marked for ${label} yet.` };
  }

  const low = rows.filter((r) => r.percent !== null && r.percent < 75);
  if (low.length > 0) {
    const names = low.slice(0, 3).map((r) => r.name).join(", ");
    const more = low.length > 3 ? ` and ${low.length - 3} more` : "";
    const who = low.length === 1 ? "1 person is" : `${low.length} people are`;
    return { tone: "bad", text: `${who} below 75% for ${label}: ${names}${more}.` };
  }

  if (overall >= 90) return { tone: "good", text: `Attendance is above 90% for ${label}.` };
  return { tone: "warn", text: `Attendance is ${formatPercent(overall)} for ${label}.` };
}

/* ------------------------------------------------------------------ grid -- */

export type GridCell = {
  key: string;
  day: number | null;
  date: string | null;
  kind: DayKind | null;
  detail: string | null;
};

/** One month, Sunday-first, padded to whole weeks. Days with no entry (future) have `kind: null`. */
export function monthGrid(year: number, month: number, days: ResolvedDay[]): GridCell[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const cells: GridCell[] = [];
  const blank = (key: string): GridCell => ({ key, day: null, date: null, kind: null, detail: null });

  for (let i = 0; i < firstWeekdayOfMonth(year, month); i++) cells.push(blank(`lead-${i}`));
  for (let d = 1; d <= daysInMonth(year, month); d++) {
    const date = isoDate(year, month, d);
    const found = byDate.get(date);
    cells.push({ key: date, day: d, date, kind: found?.kind ?? null, detail: found?.detail ?? null });
  }
  while (cells.length % 7 !== 0) cells.push(blank(`tail-${cells.length}`));
  return cells;
}

/* ------------------------------------------------------------------- csv -- */

export type CsvPerson = { name: string; empId: string | null; region: string | null; summary: Summary };

function figures(s: Summary): (string | number)[] {
  return [
    s.workingDays,
    s.counts.PRESENT,
    s.counts.ABSENT,
    s.counts.WFH,
    s.counts.LEAVE,
    s.counts.NOT_MARKED,
    s.half,
    formatPercent(s.percent),
  ];
}

/** The employee-wise table as spreadsheet rows, then one totals row. */
export function attendanceCsvRows(
  people: CsvPerson[],
  overall: Summary,
  label: string,
): (string | number)[][] {
  return [
    [
      "#",
      "Employee",
      "Emp ID",
      "Team",
      "Working days",
      "Present",
      "Absent",
      "WFH",
      "Leave",
      "Not marked",
      "Half days",
      "Attendance %",
    ],
    ...people.map((p, i) => [i + 1, p.name, p.empId ?? "", p.region ?? "", ...figures(p.summary)]),
    ["", `All (${label})`, "", "", ...figures(overall)],
  ];
}

const DAY_LABEL: Record<DayKind, string> = {
  PRESENT: "Present",
  WFH: "WFH",
  ABSENT: "Absent",
  LEAVE: "Leave",
  NOT_MARKED: "Not marked",
  HOLIDAY: "Holiday",
  WEEKEND: "Weekend",
};

/**
 * One employee's export: their summary row, a blank line, then one row per
 * day of the period (oldest first) — what the Daily attendance calendar shows.
 */
export function employeeCsvRows(person: CsvPerson & { days: ResolvedDay[] }, label: string): (string | number)[][] {
  const table = attendanceCsvRows([person], person.summary, label).slice(0, 2);
  return [
    ...table,
    [],
    ["Date", "Day", "Status", "Detail"],
    ...person.days.map((d) => [d.date, formatWeekdayShort(d.date), DAY_LABEL[d.kind], d.detail ?? ""]),
  ];
}
