import type { ScoreStatus } from "@/generated/prisma/enums";

/**
 * The score aggregation rules, with no database and no session in sight.
 *
 * This application never computes a score. The rubric lives in the
 * Standup-Automation pipeline's `scorecard.py` and arrives here already
 * decided. What this module holds is how a *period* is summarised from those
 * days — which the upstream system also does, in `period_average`, for its own
 * month tabs. Two implementations of one rule is a drift risk, so this one is
 * pure and pinned by tests rather than spread across the screens.
 *
 * The rule that matters most: `Not Scored` is not zero. A Jira outage, a Slack
 * failure and an unposted roll-call all produce it, and averaging any of them
 * as a zero turns a broken integration into somebody's poor performance.
 */

/** One day of score, as every read in this application sees it. */
export type ScoreDayRecord = {
  /** `YYYY-MM-DD`. */
  date: string;
  status: ScoreStatus;
  /** Why the day was not scored. Null when it was. */
  reason: string | null;
  /** The upstream label: Present | Half Day | Absent | Leave | Weekend | Holiday. */
  attendance: string;
  points: {
    checkin: number | null;
    picked: number | null;
    description: number | null;
    commit: number | null;
    comment: number | null;
    delivery: number | null;
    coordination: number | null;
  };
  process: number | null;
  delivery: number | null;
  /** 0-110. The coordination bonus sits on top of the hundred. */
  total: number | null;
  band: string | null;
  tasksPicked: number | null;
  tasksDone: number | null;
  pickedTasks: string[];
  flags: string[];
};

export type CheckAverage = {
  label: string;
  key: CheckKey;
  cap: number;
  /** Null when nothing in the period was scored. */
  average: number | null;
};

export type MonthScoreSummary = {
  average: number | null;
  band: string | null;
  checks: CheckAverage[];
  daysScored: number;
  daysNotScored: number;
  daysAbsent: number;
  tasksPicked: number;
  tasksDone: number;
  coordinationDays: number;
};

/**
 * The six checks, in the order every explanation of a score reads them out.
 *
 * One definition, mirroring the upstream constant in `scorecard.py`, which
 * exists there for the same reason: a cap that drifted between two places
 * would be a scoring bug that only showed up as a mismatched denominator.
 */
export const CHECKS = [
  { label: "Check-in", key: "checkin", cap: 10 },
  { label: "Task picked", key: "picked", cap: 5 },
  { label: "Jira description", key: "description", cap: 10 },
  { label: "Commit linked", key: "commit", cap: 5 },
  { label: "Jira comment", key: "comment", cap: 10 },
  { label: "Tasks done", key: "delivery", cap: 60 },
] as const;

export type CheckKey = (typeof CHECKS)[number]["key"];

/** >=85 Excellent, >=70 On Track, >=50 Needs Attention, else At Risk. */
const BANDS: readonly (readonly [number, string])[] = [
  [85, "Excellent"],
  [70, "On Track"],
  [50, "Needs Attention"],
  [0, "At Risk"],
];

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** How much a day counts toward an average: half days count half. */
export function weightOf(day: ScoreDayRecord): number {
  return day.attendance.toLowerCase().includes("half day") ? 0.5 : 1;
}

/** The days carrying a real number. Everything else is excluded, not zeroed. */
export function scoredDays(days: ScoreDayRecord[]): ScoreDayRecord[] {
  return days.filter((day) => day.status === "SCORED" && day.total !== null);
}

/**
 * Weighted mean total. Null when nothing in the period was scored — which is
 * not the same as an average of zero and must not be rendered as one.
 */
export function periodAverage(days: ScoreDayRecord[]): number | null {
  const scored = scoredDays(days);
  if (scored.length === 0) return null;

  const weight = scored.reduce((sum, day) => sum + weightOf(day), 0);
  if (weight <= 0) return null;

  const total = scored.reduce((sum, day) => sum + (day.total ?? 0) * weightOf(day), 0);
  return round1(total / weight);
}

export function bandOf(total: number): string {
  for (const [floor, name] of BANDS) {
    if (total >= floor) return name;
  }
  return BANDS[BANDS.length - 1][1];
}

/** The weighted average of one check across the scored days, or null. */
function checkAverage(days: ScoreDayRecord[], key: CheckKey): number | null {
  const scored = scoredDays(days).filter((day) => day.points[key] !== null);
  if (scored.length === 0) return null;

  const weight = scored.reduce((sum, day) => sum + weightOf(day), 0);
  if (weight <= 0) return null;

  const total = scored.reduce(
    (sum, day) => sum + (day.points[key] ?? 0) * weightOf(day),
    0,
  );
  return round1(total / weight);
}

export function summarizeMonth(days: ScoreDayRecord[]): MonthScoreSummary {
  const scored = scoredDays(days);
  const average = periodAverage(days);

  return {
    average,
    // No band without an average: "At Risk" for a month nobody scored would be
    // exactly the zero-for-null mistake this module exists to prevent.
    band: average === null ? null : bandOf(average),
    checks: CHECKS.map((check) => ({
      label: check.label,
      key: check.key,
      cap: check.cap,
      average: checkAverage(days, check.key),
    })),
    daysScored: scored.length,
    daysNotScored: days.filter((day) => day.status === "NOT_SCORED").length,
    daysAbsent: days.filter(
      (day) => day.attendance.toLowerCase() === "absent" && day.status === "SCORED",
    ).length,
    tasksPicked: scored.reduce((sum, day) => sum + (day.tasksPicked ?? 0), 0),
    tasksDone: scored.reduce((sum, day) => sum + (day.tasksDone ?? 0), 0),
    coordinationDays: scored.filter((day) => (day.points.coordination ?? 0) > 0).length,
  };
}
