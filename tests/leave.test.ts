import { describe, expect, it } from "vitest";

import {
  chargeYear,
  chargeableDays,
  costFrom,
  datesInRange,
  effectiveEndDate,
  offDates,
  unitNoun,
} from "@/lib/leave";

/** 2026-09-07 is a Monday; 2026-09-12 a Saturday; 2026-09-13 a Sunday. */

describe("datesInRange", () => {
  it("is inclusive at both ends", () => {
    expect(datesInRange("2026-09-07", "2026-09-09")).toEqual([
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
    ]);
  });

  it("returns the single day when both ends match", () => {
    expect(datesInRange("2026-09-07", "2026-09-07")).toEqual(["2026-09-07"]);
  });

  it("returns nothing for a reversed range rather than looping forever", () => {
    expect(datesInRange("2026-09-09", "2026-09-07")).toEqual([]);
  });

  it("crosses a month boundary", () => {
    expect(datesInRange("2026-08-31", "2026-09-01")).toEqual([
      "2026-08-31",
      "2026-09-01",
    ]);
  });
});

describe("offDates", () => {
  it("expands every day a holiday covers", () => {
    const off = offDates([{ startDate: "2026-11-08", endDate: "2026-11-09" }]);
    expect([...off].sort()).toEqual(["2026-11-08", "2026-11-09"]);
  });

  it("merges overlapping holidays into one set", () => {
    const off = offDates([
      { startDate: "2026-11-08", endDate: "2026-11-09" },
      { startDate: "2026-11-09", endDate: "2026-11-10" },
    ]);
    expect(off.size).toBe(3);
  });

  it("is empty for no holidays", () => {
    expect(offDates([]).size).toBe(0);
  });
});

describe("chargeableDays", () => {
  const none = new Set<string>();

  it("skips the weekend", () => {
    // Fri 11th to Mon 14th: only the Friday and the Monday count.
    expect(chargeableDays("2026-09-11", "2026-09-14", none)).toEqual([
      "2026-09-11",
      "2026-09-14",
    ]);
  });

  it("skips a holiday that falls on a weekday", () => {
    const off = new Set(["2026-09-08"]);
    expect(chargeableDays("2026-09-07", "2026-09-09", off)).toEqual([
      "2026-09-07",
      "2026-09-09",
    ]);
  });

  it("does not double-discount a holiday that falls on a weekend", () => {
    const off = new Set(["2026-09-12"]);
    expect(chargeableDays("2026-09-11", "2026-09-14", off)).toEqual([
      "2026-09-11",
      "2026-09-14",
    ]);
  });

  it("is empty when every day is a weekend or a holiday", () => {
    const off = new Set(["2026-09-11"]);
    expect(chargeableDays("2026-09-11", "2026-09-13", off)).toEqual([]);
  });
});

describe("costFrom", () => {
  const none = new Set<string>();

  it("counts working days for a DAYS policy", () => {
    expect(costFrom("DAYS", "2026-09-07", "2026-09-09", none)).toBe(3);
  });

  it("is always 1 for a USES policy, however long the range", () => {
    expect(costFrom("USES", "2026-09-07", "2026-09-30", none)).toBe(1);
  });

  it("is 1 for a USES policy even on a weekend", () => {
    expect(costFrom("USES", "2026-09-12", "2026-09-12", none)).toBe(1);
  });

  it("is 0 for an all-weekend DAYS range — a filing, priced at nothing", () => {
    expect(costFrom("DAYS", "2026-09-12", "2026-09-13", none)).toBe(0);
  });
});

describe("effectiveEndDate", () => {
  it("collapses a USES range to its start day", () => {
    expect(effectiveEndDate("USES", "2026-09-07", "2026-09-30")).toBe("2026-09-07");
  });

  it("leaves a DAYS range alone", () => {
    expect(effectiveEndDate("DAYS", "2026-09-07", "2026-09-09")).toBe("2026-09-09");
  });
});

describe("chargeYear", () => {
  it("charges a request to the year it starts in", () => {
    expect(chargeYear("2026-12-30")).toBe(2026);
  });

  it("does not follow the range into January", () => {
    // The request runs 30 Dec to 2 Jan; it is a 2026 request.
    expect(chargeYear("2026-12-30")).toBe(2026);
    expect(chargeYear("2027-01-02")).toBe(2027);
  });
});

describe("unitNoun", () => {
  it("singularises at exactly one", () => {
    expect(unitNoun("DAYS", 1)).toBe("day");
    expect(unitNoun("USES", 1)).toBe("use");
  });

  it("pluralises at zero and above one", () => {
    expect(unitNoun("DAYS", 0)).toBe("days");
    expect(unitNoun("DAYS", 3)).toBe("days");
    expect(unitNoun("USES", 2)).toBe("uses");
  });

  it("singularises a negative one — an over-drawn balance reads as -1 day", () => {
    expect(unitNoun("DAYS", -1)).toBe("day");
  });
});
