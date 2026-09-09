import { describe, expect, it } from "vitest";

import type { CreditRule } from "@/lib/leave";
import {
  accrualStart,
  balanceAsOf,
  chargeYear,
  chargeableDays,
  costFrom,
  creditedInYear,
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

/* ------------------------------------------------------- the credit rules -- */

/** Casual Leave: 6 days at once, pro-rated in a partial first year. */
const CL: CreditRule = {
  allowance: 6,
  accrual: "UPFRONT",
  prorated: true,
  carry: false,
  cap: null,
  effectiveFrom: "2026-09-01",
};

/** Earned Leave: one day on the first of each month, banked up to 20. */
const EL: CreditRule = {
  allowance: 12,
  accrual: "MONTHLY",
  prorated: false,
  carry: true,
  cap: 20,
  effectiveFrom: "2026-09-01",
};

/** Short leave: four uses a year, never pro-rated. */
const SHORT: CreditRule = {
  allowance: 4,
  accrual: "UPFRONT",
  prorated: false,
  carry: false,
  cap: null,
  effectiveFrom: "2026-09-01",
};

const NO_USE: ReadonlyMap<number, number> = new Map();

describe("accrualStart", () => {
  it("uses the scheme start for somebody who was already here", () => {
    // Employed since 2024; the scheme still begins when it begins.
    expect(accrualStart(CL, "2024-02-03")).toBe("2026-09-01");
  });

  it("uses the scheme start for somebody who joined earlier the same year", () => {
    expect(accrualStart(CL, "2026-07-02")).toBe("2026-09-01");
  });

  it("uses the join month for somebody who joins after the scheme starts", () => {
    expect(accrualStart(CL, "2027-03-15")).toBe("2027-03-01");
  });

  it("falls back to the scheme start when no join date is recorded", () => {
    // Every ADMIN today. They were here when the scheme began.
    expect(accrualStart(CL, null)).toBe("2026-09-01");
  });

  it("takes the first of the join month, not the join day", () => {
    expect(accrualStart(CL, "2027-03-31")).toBe("2027-03-01");
  });
});

describe("creditedInYear — UPFRONT", () => {
  it("pro-rates the scheme's first partial year down to two days", () => {
    // September to December is four months: floor(6 x 4/12).
    expect(creditedInYear(CL, "2026-07-02", 2026, "2026-09-04")).toBe(2);
  });

  it("credits the whole entitlement in the first full year", () => {
    expect(creditedInYear(CL, "2026-07-02", 2027, "2027-01-01")).toBe(6);
  });

  it("credits nothing for a year that ended before the scheme started", () => {
    expect(creditedInYear(CL, "2024-02-03", 2025, "2025-12-31")).toBe(0);
  });

  it("credits nothing before the credit date has actually passed", () => {
    // 31 August is inside 2026, but the scheme starts the next day.
    expect(creditedInYear(CL, "2026-07-02", 2026, "2026-08-31")).toBe(0);
  });

  it("credits on the credit date itself", () => {
    expect(creditedInYear(CL, "2026-07-02", 2026, "2026-09-01")).toBe(2);
  });

  it("rounds a fractional share down rather than up", () => {
    // A member joining in August has five months left: 6 x 5/12 is 2.5.
    expect(creditedInYear(CL, "2027-08-10", 2027, "2027-12-31")).toBe(2);
  });

  it("does not pro-rate a policy that opted out", () => {
    // Short leave is four uses whenever the year starts.
    expect(creditedInYear(SHORT, "2026-07-02", 2026, "2026-09-04")).toBe(4);
  });

  it("pro-rates a late joiner in an ordinary year", () => {
    // March onward is ten months: floor(6 x 10/12) = 5.
    expect(creditedInYear(CL, "2027-03-15", 2027, "2027-12-31")).toBe(5);
  });
});

describe("creditedInYear — MONTHLY", () => {
  it("has credited exactly one day four days into the scheme", () => {
    // The whole point of the change: EL reads 1 on 4 September, not 12.
    expect(creditedInYear(EL, "2026-07-02", 2026, "2026-09-04")).toBe(1);
  });

  it("reaches four by the end of the scheme's first year", () => {
    expect(creditedInYear(EL, "2026-07-02", 2026, "2026-12-31")).toBe(4);
  });

  it("counts a month from its first, not from the day asked about", () => {
    // 1 October has passed, so October is credited in full.
    expect(creditedInYear(EL, "2026-07-02", 2026, "2026-10-01")).toBe(2);
  });

  it("credits a full twelve across a whole year", () => {
    expect(creditedInYear(EL, "2026-07-02", 2027, "2027-12-31")).toBe(12);
  });

  it("credits only the months elapsed so far in the current year", () => {
    expect(creditedInYear(EL, "2026-07-02", 2027, "2027-06-15")).toBe(6);
  });

  it("credits nothing before the scheme starts", () => {
    expect(creditedInYear(EL, "2026-07-02", 2026, "2026-08-31")).toBe(0);
  });

  it("counts from the join month for somebody who joins mid-year", () => {
    // March to December inclusive is ten months.
    expect(creditedInYear(EL, "2027-03-15", 2027, "2027-12-31")).toBe(10);
  });
});

describe("balanceAsOf — policies that lapse", () => {
  it("is the credit less what has been spent this year", () => {
    const used = new Map([[2026, 2]]);
    expect(balanceAsOf(CL, "2026-07-02", "2026-09-04", used)).toEqual({
      credited: 2,
      used: 2,
      balance: 0,
    });
  });

  it("goes negative when more was filed than credited", () => {
    // Over-balance requests are filed, not refused, so this is reachable.
    const used = new Map([[2026, 5]]);
    expect(balanceAsOf(CL, "2026-07-02", "2026-09-04", used).balance).toBe(-3);
  });

  it("does not carry last year's unused days into this one", () => {
    // 2026 credited 2 and spent nothing; 2027 still opens at its own 6.
    const used = new Map([[2026, 0]]);
    expect(balanceAsOf(CL, "2026-07-02", "2027-01-01", used)).toEqual({
      credited: 6,
      used: 0,
      balance: 6,
    });
  });
});

describe("balanceAsOf — policies that carry", () => {
  it("carries an unused closing balance into the next year", () => {
    // 2026 closes at 4; 1 January 2027 credits one more.
    expect(balanceAsOf(EL, "2026-07-02", "2027-01-15", NO_USE)).toEqual({
      credited: 5,
      used: 0,
      balance: 5,
    });
  });

  it("carries a closing balance net of what was spent", () => {
    const used = new Map([[2026, 3]]);
    // 2026: credited 4, used 3, closes at 1. 2027 adds January.
    expect(balanceAsOf(EL, "2026-07-02", "2027-01-15", used).balance).toBe(2);
  });

  it("applies the cap at the year boundary", () => {
    const banked: CreditRule = { ...EL, effectiveFrom: "2024-01-01" };
    // 2024 closes 12, 2025 would close 24 but carries 20, 2026 adds January.
    expect(balanceAsOf(banked, null, "2026-01-15", NO_USE).balance).toBe(21);
  });

  it("lets a balance exceed the cap within a year", () => {
    const banked: CreditRule = { ...EL, effectiveFrom: "2024-01-01" };
    // Opening 20 plus a full 12 accrued, with nothing spent, reaches 32.
    expect(balanceAsOf(banked, null, "2026-12-31", NO_USE).balance).toBe(32);
  });

  it("does not hand back days the cap already discarded", () => {
    // THE REGRESSION. Credited 36 across three years, spent 10, cap 20.
    // Capping continuously computes min(20, 36 - 10) = 20 — the member
    // spends ten days and their balance does not move, because the days the
    // cap threw away flow back in to replace them. Capping at the boundary
    // gives 20 opening + 12 accrued - 10 spent = 22.
    const banked: CreditRule = { ...EL, effectiveFrom: "2024-01-01" };
    const used = new Map([[2026, 10]]);
    expect(balanceAsOf(banked, null, "2026-12-31", used).balance).toBe(22);
  });

  it("carries an overdrawn balance forward as a debt", () => {
    const used = new Map([[2026, 6]]);
    // 2026: credited 4, used 6, closes at -2. 2027 adds January.
    expect(balanceAsOf(EL, "2026-07-02", "2027-01-15", used).balance).toBe(-1);
  });

  it("reports this year's usage, not the running total", () => {
    const used = new Map([
      [2026, 3],
      [2027, 1],
    ]);
    const result = balanceAsOf(EL, "2026-07-02", "2027-01-15", used);
    expect(result.used).toBe(1);
    // Opening 1 (4 credited less 3 spent) plus January's day, less this
    // year's one day spent.
    expect(result.balance).toBe(1);
  });

  it("is empty before accrual has started at all", () => {
    expect(balanceAsOf(EL, "2027-03-15", "2026-12-31", NO_USE)).toEqual({
      credited: 0,
      used: 0,
      balance: 0,
    });
  });
});
