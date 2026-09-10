import { describe, expect, it } from "vitest";

import {
  bandOf,
  periodAverage,
  summarizeMonth,
  weightOf,
  type ScoreDayRecord,
} from "@/lib/score";

/**
 * The aggregation rules, with no database in sight.
 *
 * These mirror `period_average` in the upstream pipeline's scorecard.py. The
 * cases below are the ones that make a score unfair if the two drift apart: a
 * not-scored day must never be averaged as a zero, and a half day must count
 * half.
 */

const day = (over: Partial<ScoreDayRecord> = {}): ScoreDayRecord => ({
  date: "2026-09-08",
  status: "SCORED",
  reason: null,
  attendance: "Present",
  points: {
    checkin: 10,
    picked: 5,
    description: 10,
    commit: 5,
    comment: 10,
    delivery: 60,
    coordination: 0,
  },
  process: 40,
  delivery: 60,
  total: 100,
  band: "Excellent",
  tasksPicked: 2,
  tasksDone: 2,
  pickedTasks: ["HIR-131"],
  flags: [],
  ...over,
});

const notScored = (reason: string, attendance = "Present"): ScoreDayRecord =>
  day({
    status: "NOT_SCORED",
    reason,
    attendance,
    points: {
      checkin: null,
      picked: null,
      description: null,
      commit: null,
      comment: null,
      delivery: null,
      coordination: null,
    },
    process: null,
    delivery: null,
    total: null,
    band: null,
    tasksPicked: null,
    tasksDone: null,
    pickedTasks: [],
    flags: [],
  });

describe("weightOf", () => {
  it("counts a half day as half", () => {
    expect(weightOf(day({ attendance: "Half Day" }))).toBe(0.5);
  });

  it("counts every other day in full", () => {
    expect(weightOf(day({ attendance: "Present" }))).toBe(1);
    expect(weightOf(day({ attendance: "Absent" }))).toBe(1);
  });
});

describe("periodAverage", () => {
  it("excludes Not Scored days rather than counting them as zero", () => {
    // Averaging the 100 against a zero would give 50. A not-scored day is a
    // broken integration, not a bad day, and must not read as one.
    expect(periodAverage([day({ total: 100 }), notScored("jira: 503")])).toBe(100);
  });

  it("includes an absent day as a real zero", () => {
    expect(
      periodAverage([day({ total: 100 }), day({ attendance: "Absent", total: 0 })]),
    ).toBe(50);
  });

  it("weights a half day at one half", () => {
    // (100 * 1 + 40 * 0.5) / 1.5 = 80
    const half = day({ attendance: "Half Day", total: 40 });
    expect(periodAverage([day({ total: 100 }), half])).toBe(80);
  });

  it("returns null for a period with nothing scored, which is not zero", () => {
    expect(periodAverage([notScored("no roll-call posted for the day")])).toBeNull();
    expect(periodAverage([])).toBeNull();
  });

  it("does not clamp a coordination bonus above 100", () => {
    expect(periodAverage([day({ total: 110 })])).toBe(110);
  });
});

describe("bandOf", () => {
  it("bands by the upstream thresholds", () => {
    expect(bandOf(110)).toBe("Excellent");
    expect(bandOf(85)).toBe("Excellent");
    expect(bandOf(84.9)).toBe("On Track");
    expect(bandOf(70)).toBe("On Track");
    expect(bandOf(69.9)).toBe("Needs Attention");
    expect(bandOf(50)).toBe("Needs Attention");
    expect(bandOf(0)).toBe("At Risk");
  });
});

describe("summarizeMonth", () => {
  it("counts the days each way and averages each check", () => {
    const summary = summarizeMonth([
      day({ points: { ...day().points, description: 5 } }),
      day(),
      notScored("jira: 503"),
      day({
        attendance: "Absent",
        total: 0,
        points: {
          checkin: 0,
          picked: 0,
          description: 0,
          commit: 0,
          comment: 0,
          delivery: 0,
          coordination: 0,
        },
      }),
    ]);

    expect(summary.daysScored).toBe(3);
    expect(summary.daysNotScored).toBe(1);
    expect(summary.daysAbsent).toBe(1);
    // (5 + 10 + 0) / 3
    expect(summary.checks.find((check) => check.key === "description")?.average).toBe(5);
  });

  it("counts the days a coordination bonus was earned", () => {
    const summary = summarizeMonth([
      day({ points: { ...day().points, coordination: 10 } }),
      day(),
    ]);
    expect(summary.coordinationDays).toBe(1);
  });

  it("reports a null average and no band when nothing was scored", () => {
    const summary = summarizeMonth([notScored("jira: 503")]);
    expect(summary.average).toBeNull();
    expect(summary.band).toBeNull();
  });
});
