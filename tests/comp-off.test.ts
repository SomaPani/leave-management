import { describe, expect, it } from "vitest";

import { claimableDay, earnedByYearFrom } from "@/lib/comp-off";

/** 2026-09-07 is a Monday; 2026-09-12 a Saturday; 2026-09-13 a Sunday. */

const NO_HOLIDAYS: ReadonlySet<string> = new Set();
const TODAY = "2026-09-15";

describe("claimableDay", () => {
  it("accepts a Saturday that has already been worked", () => {
    expect(claimableDay("2026-09-12", TODAY, NO_HOLIDAYS)).toBeNull();
  });

  it("accepts a Sunday", () => {
    expect(claimableDay("2026-09-13", TODAY, NO_HOLIDAYS)).toBeNull();
  });

  it("accepts a weekday that is a holiday in the claimant's region", () => {
    expect(claimableDay("2026-09-07", TODAY, new Set(["2026-09-07"]))).toBeNull();
  });

  it("refuses an ordinary working day", () => {
    expect(claimableDay("2026-09-07", TODAY, NO_HOLIDAYS)).toBe(
      "2026-09-07 was a working day. Comp-off is earned on a weekend or a holiday.",
    );
  });

  it("refuses a day that has not happened yet", () => {
    expect(claimableDay("2026-09-19", TODAY, NO_HOLIDAYS)).toBe(
      "You cannot claim a comp-off for a day you have not worked yet.",
    );
  });

  it("refuses a future day for being future, not for being a working day", () => {
    // A future Saturday is refused for the more accurate of the two reasons.
    // The order of the checks is what decides it.
    expect(claimableDay("2026-09-19", TODAY, NO_HOLIDAYS)).toContain("not worked yet");
    expect(claimableDay("2026-09-26", TODAY, NO_HOLIDAYS)).toContain("not worked yet");
  });

  it("accepts today itself", () => {
    expect(claimableDay("2026-09-13", "2026-09-13", NO_HOLIDAYS)).toBeNull();
  });

  it("does not treat another region's holiday as claimable", () => {
    // The caller passes the claimant's own region's dates; a date absent from
    // that set is an ordinary working day for them.
    expect(claimableDay("2026-09-07", TODAY, new Set(["2026-09-08"]))).toContain(
      "was a working day",
    );
  });
});

describe("earnedByYearFrom", () => {
  it("buckets by the year the day was worked", () => {
    const earned = earnedByYearFrom([
      { workedOn: "2026-09-13" },
      { workedOn: "2026-09-12" },
      { workedOn: "2025-12-27" },
    ]);
    expect(earned.get(2026)).toBe(2);
    expect(earned.get(2025)).toBe(1);
  });

  it("keeps a December claim in the year it was worked", () => {
    const earned = earnedByYearFrom([{ workedOn: "2026-12-26" }]);
    expect(earned.get(2026)).toBe(1);
    expect(earned.get(2027)).toBeUndefined();
  });

  it("counts one day per claim, never more", () => {
    const earned = earnedByYearFrom([
      { workedOn: "2026-09-13" },
      { workedOn: "2026-09-13" },
    ]);
    expect(earned.get(2026)).toBe(2);
  });

  it("is empty for no claims", () => {
    expect(earnedByYearFrom([]).size).toBe(0);
  });
});
