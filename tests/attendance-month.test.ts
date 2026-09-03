import { describe, expect, it } from "vitest";

import {
  buildMonthCells,
  dayValue,
  summarizeMonth,
  type DayMark,
} from "@/lib/attendance-month";
import type { HolidayRecord } from "@/lib/holidays";

/**
 * The month a member sees.
 *
 * The percentage rule is the product requirement, so it is pinned here rather
 * than inferred from the screen: only marked days count, a working day is 1.0
 * or 0.5 if it is a half day, an absence is 0.0, and approved leave is
 * excluded from both sides.
 */

const mark = (
  date: string,
  status: DayMark["status"],
  modifier: DayMark["modifier"] = null,
): DayMark => ({ date, status, modifier });

describe("dayValue", () => {
  it("scores a full working day as one, whether in the office or at home", () => {
    expect(dayValue(mark("2026-09-01", "PRESENT"))).toBe(1);
    expect(dayValue(mark("2026-09-01", "WFH"))).toBe(1);
  });

  it("scores a half day as one half, on either base", () => {
    expect(dayValue(mark("2026-09-01", "PRESENT", "HALF_DAY"))).toBe(0.5);
    expect(dayValue(mark("2026-09-01", "WFH", "HALF_DAY"))).toBe(0.5);
  });

  it("does not dock a short leave — a couple of hours off is still a day", () => {
    expect(dayValue(mark("2026-09-01", "PRESENT", "SHORT_LEAVE"))).toBe(1);
    expect(dayValue(mark("2026-09-01", "WFH", "SHORT_LEAVE"))).toBe(1);
  });

  it("scores an absence as zero", () => {
    expect(dayValue(mark("2026-09-01", "ABSENT"))).toBe(0);
  });

  it("excludes approved leave entirely", () => {
    expect(dayValue(mark("2026-09-01", "LEAVE"))).toBeNull();
  });
});

describe("summarizeMonth", () => {
  it("returns an em dash rather than 0% when nothing is marked", () => {
    const summary = summarizeMonth([]);
    expect(summary.percent).toBe("—");
    expect(summary.counted).toBe(0);
  });

  it("counts each status and each add-on", () => {
    const summary = summarizeMonth([
      mark("2026-09-01", "PRESENT"),
      mark("2026-09-02", "PRESENT", "HALF_DAY"),
      mark("2026-09-03", "WFH"),
      mark("2026-09-04", "ABSENT"),
      mark("2026-09-07", "LEAVE"),
    ]);

    expect(summary.present).toBe(2);
    expect(summary.wfh).toBe(1);
    expect(summary.half).toBe(1);
    expect(summary.absent).toBe(1);
    expect(summary.leave).toBe(1);
  });

  it("divides worked days by marked days, excluding leave", () => {
    const summary = summarizeMonth([
      mark("2026-09-01", "PRESENT"), // 1.0
      mark("2026-09-02", "ABSENT"), // 0.0
      mark("2026-09-03", "WFH", "HALF_DAY"), // 0.5
      mark("2026-09-04", "LEAVE"), // excluded
    ]);

    expect(summary.counted).toBe(3);
    expect(summary.worked).toBe(1.5);
    expect(summary.percent).toBe("50%");
  });

  it("does not treat working from home as an absence", () => {
    // This is defect C3: the old formula scored this month at 0%.
    const summary = summarizeMonth([
      mark("2026-09-01", "WFH"),
      mark("2026-09-02", "WFH"),
    ]);

    expect(summary.percent).toBe("100%");
  });

  it("scores a day once, not once per code", () => {
    // PRESENT + HALF_DAY is half a day, not one and a half.
    const summary = summarizeMonth([mark("2026-09-01", "PRESENT", "HALF_DAY")]);

    expect(summary.worked).toBe(0.5);
    expect(summary.percent).toBe("50%");
  });

  it("is 100% for a month of full days and 0% for a month of absences", () => {
    expect(
      summarizeMonth([mark("2026-09-01", "PRESENT"), mark("2026-09-02", "PRESENT")])
        .percent,
    ).toBe("100%");
    expect(summarizeMonth([mark("2026-09-01", "ABSENT")]).percent).toBe("0%");
  });

  it("is an em dash when every marked day is leave", () => {
    expect(summarizeMonth([mark("2026-09-01", "LEAVE")]).percent).toBe("—");
  });
});

describe("buildMonthCells", () => {
  const holiday = (
    name: string,
    startDate: string,
    endDate = startDate,
  ): HolidayRecord => ({
    id: name,
    name,
    startDate,
    endDate,
    note: null,
    region: null,
  });

  it("pads to whole weeks", () => {
    const cells = buildMonthCells(2026, 8, [], []);
    // September 2026 has 30 days and starts on a Tuesday.
    expect(cells.length % 7).toBe(0);
    expect(cells.filter((c) => c.day !== null)).toHaveLength(30);
    expect(cells[0]!.day).toBeNull();
    expect(cells[1]!.day).toBeNull();
    expect(cells[2]!.day).toBe(1);
  });

  it("attaches a mark to its day", () => {
    const cells = buildMonthCells(
      2026,
      8,
      [mark("2026-09-03", "WFH", "HALF_DAY")],
      [],
    );
    const third = cells.find((c) => c.date === "2026-09-03");

    expect(third?.state).toEqual({ status: "WFH", modifier: "HALF_DAY" });
  });

  it("flags weekends and leaves them unmarked", () => {
    const cells = buildMonthCells(2026, 8, [], []);
    const saturday = cells.find((c) => c.date === "2026-09-05");

    expect(saturday?.weekend).toBe(true);
    expect(saturday?.state).toBeNull();
  });

  it("names a holiday on every day it covers", () => {
    const cells = buildMonthCells(
      2026,
      8,
      [],
      [holiday("Long break", "2026-09-01", "2026-09-02")],
    );

    expect(cells.find((c) => c.date === "2026-09-01")?.holiday).toBe("Long break");
    expect(cells.find((c) => c.date === "2026-09-02")?.holiday).toBe("Long break");
    expect(cells.find((c) => c.date === "2026-09-03")?.holiday).toBeNull();
  });

  it("keeps a mark that falls on a holiday — somebody worked it", () => {
    const cells = buildMonthCells(
      2026,
      8,
      [mark("2026-09-01", "PRESENT")],
      [holiday("Founders Day", "2026-09-01")],
    );
    const first = cells.find((c) => c.date === "2026-09-01");

    expect(first?.holiday).toBe("Founders Day");
    expect(first?.state).toEqual({ status: "PRESENT", modifier: null });
  });

  it("ignores marks from another month", () => {
    const cells = buildMonthCells(2026, 8, [mark("2026-08-31", "PRESENT")], []);
    expect(cells.filter((c) => c.state !== null)).toHaveLength(0);
  });
});
