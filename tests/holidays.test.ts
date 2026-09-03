import { describe, expect, it } from "vitest";

import {
  holidayDates,
  holidayNameByDate,
  holidaysInMonth,
  holidaysInYear,
  monthBounds,
  parseYearParam,
  type HolidayRecord,
} from "@/lib/holidays";
import { HttpError } from "@/lib/rbac";

const holiday = (
  name: string,
  startDate: string,
  endDate = startDate,
  region: HolidayRecord["region"] = null,
): HolidayRecord => ({ id: name, name, startDate, endDate, note: null, region });

const DIWALI = holiday("Diwali", "2026-11-08", "2026-11-09");
const PONGAL = holiday("Pongal", "2026-01-15", "2026-01-15", {
  id: "r1",
  name: "Chennai",
});
const NEW_YEAR = holiday("New Year's Day", "2026-01-01");
const SPANNING = holiday("Long break", "2026-08-30", "2026-09-02");

describe("holidayDates", () => {
  it("expands a single day to one date", () => {
    expect(holidayDates(NEW_YEAR)).toEqual(["2026-01-01"]);
  });

  it("expands an inclusive range", () => {
    expect(holidayDates(DIWALI)).toEqual(["2026-11-08", "2026-11-09"]);
  });

  it("crosses a month boundary", () => {
    expect(holidayDates(SPANNING)).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });

  it("crosses a year boundary", () => {
    expect(holidayDates(holiday("NY", "2026-12-31", "2027-01-01"))).toEqual([
      "2026-12-31",
      "2027-01-01",
    ]);
  });
});

describe("holidayNameByDate", () => {
  it("maps every covered day to its holiday", () => {
    expect(holidayNameByDate([DIWALI, NEW_YEAR])).toEqual({
      "2026-11-08": "Diwali",
      "2026-11-09": "Diwali",
      "2026-01-01": "New Year's Day",
    });
  });
});

describe("monthBounds", () => {
  it("covers the whole month", () => {
    expect(monthBounds(2026, 8)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("handles February in a leap year", () => {
    expect(monthBounds(2028, 1)).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
});

describe("holidaysInMonth", () => {
  it("includes a holiday that only overlaps the month", () => {
    // Starts in August, ends in September — belongs to both.
    expect(holidaysInMonth([SPANNING], 2026, 7).map((h) => h.name)).toEqual([
      "Long break",
    ]);
    expect(holidaysInMonth([SPANNING], 2026, 8).map((h) => h.name)).toEqual([
      "Long break",
    ]);
  });

  it("excludes a holiday in another month", () => {
    expect(holidaysInMonth([DIWALI, PONGAL], 2026, 8)).toEqual([]);
  });
});

describe("holidaysInYear", () => {
  it("keeps anything touching the year, sorted by start date", () => {
    const sorted = holidaysInYear([DIWALI, NEW_YEAR, PONGAL], 2026);
    expect(sorted.map((h) => h.name)).toEqual([
      "New Year's Day",
      "Pongal",
      "Diwali",
    ]);
  });

  it("drops another year entirely", () => {
    expect(holidaysInYear([DIWALI], 2025)).toEqual([]);
  });
});

describe("parseYearParam", () => {
  it("accepts a plausible year", () => {
    expect(parseYearParam("2026")).toBe(2026);
  });

  it("rejects nonsense and absurd years", () => {
    expect(() => parseYearParam("nope")).toThrow(HttpError);
    expect(() => parseYearParam("999999")).toThrow(HttpError);
    expect(() => parseYearParam("1200")).toThrow(HttpError);
    expect(() => parseYearParam(undefined)).toThrow(HttpError);
  });
});
