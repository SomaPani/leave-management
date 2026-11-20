import { describe, expect, it } from "vitest";

import {
  attendanceCsvRows,
  combineSummaries,
  formatPercent,
  insight,
  monthGrid,
  parseReportFilters,
  percentBand,
  statusShares,
  summarizeDays,
  teamWorkingDays,
  trend,
} from "@/lib/attendance-report";
import type { DayKind, ResolvedDay } from "@/lib/day-status";

const TODAY = "2026-11-18"; // a Wednesday

const day = (date: string, kind: DayKind, detail: string | null = null): ResolvedDay => ({
  date,
  kind,
  detail,
});

describe("parseReportFilters", () => {
  it("defaults to this month, everyone, every team", () => {
    expect(parseReportFilters({}, TODAY)).toEqual({
      period: "month",
      year: 2026,
      month: 10,
      memberId: null,
      regionId: null,
      viewId: null,
    });
  });

  it("reads every filter", () => {
    expect(
      parseReportFilters(
        { period: "quarter", year: "2025", month: "3", member: "u1", team: "r1", view: "u2" },
        TODAY,
      ),
    ).toEqual({ period: "quarter", year: 2025, month: 2, memberId: "u1", regionId: "r1", viewId: "u2" });
  });

  it("falls back on values it does not understand instead of failing", () => {
    const f = parseReportFilters(
      { period: "weekly", year: "1800", month: "13", member: " ", team: ["a", "b"] },
      TODAY,
    );
    expect(f).toMatchObject({ period: "month", year: 2026, month: 10, memberId: null, regionId: "a" });
  });
});

describe("summarizeDays", () => {
  it("counts a half day as half a day worked, once", () => {
    const s = summarizeDays([
      day("2026-11-02", "PRESENT", "Half day"),
      day("2026-11-03", "PRESENT"),
      day("2026-11-04", "ABSENT"),
      day("2026-11-05", "WFH", "Short leave"),
    ]);
    expect(s.half).toBe(1);
    expect(s.worked).toBe(2.5);
    expect(s.scored).toBe(4);
    expect(s.percent).toBeCloseTo(62.5);
  });

  it("leaves leave and unmarked days out of the percentage, like the member calendar", () => {
    const s = summarizeDays([
      day("2026-11-02", "PRESENT"),
      day("2026-11-03", "LEAVE", "Earned Leave"),
      day("2026-11-04", "NOT_MARKED"),
    ]);
    expect(s.percent).toBe(100);
    expect(s.workingDays).toBe(3);
    expect(s.counts.NOT_MARKED).toBe(1);
  });

  it("does not count weekends or holidays as working days", () => {
    const s = summarizeDays([
      day("2026-11-07", "WEEKEND"),
      day("2026-11-09", "HOLIDAY", "Diwali"),
      day("2026-11-10", "PRESENT"),
    ]);
    expect(s.workingDays).toBe(1);
  });

  it("has no percentage when nothing that counts is marked", () => {
    expect(summarizeDays([day("2026-11-02", "NOT_MARKED")]).percent).toBeNull();
    expect(summarizeDays([]).percent).toBeNull();
  });
});

describe("combineSummaries", () => {
  it("weights by days, not by averaging percentages", () => {
    const a = summarizeDays([day("2026-11-02", "PRESENT")]); // 100% of 1
    const b = summarizeDays([
      day("2026-11-02", "ABSENT"),
      day("2026-11-03", "ABSENT"),
      day("2026-11-04", "ABSENT"),
    ]); // 0% of 3
    const all = combineSummaries([a, b]);
    expect(all.percent).toBe(25);
    expect(all.counts.ABSENT).toBe(3);
    expect(all.workingDays).toBe(4);
  });
});

describe("teamWorkingDays", () => {
  it("counts each date once, however many people worked it", () => {
    expect(
      teamWorkingDays([
        [day("2026-11-02", "PRESENT"), day("2026-11-03", "LEAVE")],
        [day("2026-11-02", "ABSENT"), day("2026-11-04", "NOT_MARKED"), day("2026-11-07", "WEEKEND")],
      ]),
    ).toBe(3);
  });
});

describe("formatPercent and percentBand", () => {
  it("formats to two decimals, or a dash when there is no figure", () => {
    expect(formatPercent(90.909090)).toBe("90.91%");
    expect(formatPercent(100)).toBe("100%");
    expect(formatPercent(null)).toBe("—");
  });

  it("bands at 90 and 75", () => {
    expect(percentBand(90)).toBe("good");
    expect(percentBand(89.99)).toBe("warn");
    expect(percentBand(75)).toBe("warn");
    expect(percentBand(74.9)).toBe("bad");
    expect(percentBand(null)).toBeNull();
  });
});

describe("statusShares", () => {
  it("splits present, absent, WFH and leave out of the days that have one", () => {
    const shares = statusShares({ PRESENT: 2, ABSENT: 1, WFH: 1, LEAVE: 0, NOT_MARKED: 5 });
    expect(shares.map((s) => [s.kind, s.percent])).toEqual([
      ["PRESENT", 50],
      ["ABSENT", 25],
      ["WFH", 25],
      ["LEAVE", 0],
    ]);
  });

  it("is all zero for an empty period", () => {
    expect(statusShares({ PRESENT: 0, ABSENT: 0, WFH: 0, LEAVE: 0, NOT_MARKED: 0 }).every((s) => s.percent === 0)).toBe(true);
  });
});

describe("trend", () => {
  it("is weekly for a month, with future weeks left empty", () => {
    const points = trend("month", { from: "2026-11-01", to: TODAY }, [
      day("2026-11-02", "PRESENT"),
      day("2026-11-03", "ABSENT"),
      day("2026-11-09", "PRESENT"),
      day("2026-11-16", "PRESENT", "Half day"),
    ]);
    expect(points.map((p) => p.label)).toEqual(["Week 1", "Week 2", "Week 3", "Week 4", "Week 5"]);
    expect(points.map((p) => p.percent)).toEqual([50, 100, 50, null, null]);
  });

  it("is monthly for a quarter and a year", () => {
    const q = trend("quarter", { from: "2026-10-01", to: TODAY }, [
      day("2026-10-05", "PRESENT"),
      day("2026-11-05", "ABSENT"),
    ]);
    expect(q).toEqual([
      { label: "Oct", percent: 100 },
      { label: "Nov", percent: 0 },
      { label: "Dec", percent: null },
    ]);
    expect(trend("year", { from: "2026-01-01", to: TODAY }, [])).toHaveLength(12);
  });
});

describe("insight", () => {
  const row = (name: string, percent: number | null) => ({ name, percent });

  it("names the people below 75% first", () => {
    expect(insight(80, [row("Anu", 60), row("Bala", 95), row("Chitra", 70)], "November 2026")).toEqual({
      tone: "bad",
      text: "2 people are below 75% for November 2026: Anu, Chitra.",
    });
  });

  it("praises a team above 90%", () => {
    expect(insight(93.5, [row("Anu", 93.5)], "November 2026")).toEqual({
      tone: "good",
      text: "Attendance is above 90% for November 2026.",
    });
  });

  it("says plainly when nothing is marked", () => {
    expect(insight(null, [row("Anu", null)], "November 2026").text).toBe(
      "No attendance has been marked for November 2026 yet.",
    );
  });
});

describe("monthGrid", () => {
  it("pads to whole Sunday-first weeks and places each day", () => {
    const cells = monthGrid(2026, 10, [day("2026-11-02", "PRESENT"), day("2026-11-13", "LEAVE", "EL")]);
    expect(cells.length % 7).toBe(0);
    // 1 Nov 2026 is a Sunday: no lead padding.
    expect(cells[0]).toMatchObject({ date: "2026-11-01", day: 1, kind: null });
    expect(cells.find((c) => c.date === "2026-11-02")?.kind).toBe("PRESENT");
    expect(cells.find((c) => c.date === "2026-11-13")).toMatchObject({ kind: "LEAVE", detail: "EL" });
    expect(cells.filter((c) => c.day !== null)).toHaveLength(30);
  });
});

describe("attendanceCsvRows", () => {
  it("writes the table, then the totals", () => {
    const s = summarizeDays([day("2026-11-02", "PRESENT"), day("2026-11-03", "ABSENT")]);
    const rows = attendanceCsvRows(
      [{ name: "Anu", empId: "E1", region: "Chennai", summary: s }],
      combineSummaries([s]),
      "November 2026",
    );
    expect(rows[0]).toEqual([
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
    ]);
    expect(rows[1]).toEqual([1, "Anu", "E1", "Chennai", 2, 1, 1, 0, 0, 0, 0, "50%"]);
    expect(rows.at(-1)).toEqual(["", "All (November 2026)", "", "", 2, 1, 1, 0, 0, 0, 0, "50%"]);
  });
});
