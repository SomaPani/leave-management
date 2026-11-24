import { describe, expect, it } from "vitest";

import { AttendanceModifier, AttendanceStatus } from "@/generated/prisma/enums";
import {
  type DayFacts,
  countDays,
  periodRange,
  resolveDay,
  shiftPeriod,
} from "@/lib/day-status";

const TODAY = "2026-11-18"; // a Wednesday

function facts(overrides: Partial<DayFacts> = {}): DayFacts {
  return {
    date: "2026-11-16", // a Monday
    today: TODAY,
    joinedOn: null,
    mark: null,
    leave: null,
    holiday: null,
    ...overrides,
  };
}

describe("resolveDay", () => {
  it("lets an attendance mark beat approved leave", () => {
    const day = resolveDay(
      facts({
        mark: { status: AttendanceStatus.PRESENT, modifier: null },
        leave: { policyName: "Earned Leave (EL)" },
      }),
    );
    expect(day?.kind).toBe("PRESENT");
  });

  it("keeps a modifier as the detail of its base status", () => {
    const day = resolveDay(
      facts({ mark: { status: AttendanceStatus.PRESENT, modifier: AttendanceModifier.HALF_DAY } }),
    );
    expect(day).toEqual({ date: "2026-11-16", kind: "PRESENT", detail: "Half day" });
  });

  it("maps each mark to its kind", () => {
    for (const status of [
      AttendanceStatus.PRESENT,
      AttendanceStatus.WFH,
      AttendanceStatus.ABSENT,
      AttendanceStatus.LEAVE,
    ]) {
      expect(resolveDay(facts({ mark: { status, modifier: null } }))?.kind).toBe(status);
    }
  });

  it("reads approved leave when nothing is marked", () => {
    const day = resolveDay(facts({ leave: { policyName: "Earned Leave (EL)" } }));
    expect(day).toEqual({ date: "2026-11-16", kind: "LEAVE", detail: "Earned Leave (EL)" });
  });

  it("names a holiday, a weekend, and an unmarked weekday", () => {
    expect(resolveDay(facts({ holiday: { name: "Diwali" } }))).toEqual({
      date: "2026-11-16",
      kind: "HOLIDAY",
      detail: "Diwali",
    });
    expect(resolveDay(facts({ date: "2026-11-14" }))?.kind).toBe("WEEKEND");
    expect(resolveDay(facts())?.kind).toBe("NOT_MARKED");
  });

  it("does not call a weekend inside a leave span a leave day", () => {
    const day = resolveDay(facts({ date: "2026-11-15", leave: { policyName: "EL" } }));
    expect(day?.kind).toBe("WEEKEND");
  });

  it("ignores a Leave or Absent mark on a weekend: it is already a day off", () => {
    const saturday = "2026-11-14";
    for (const status of [AttendanceStatus.LEAVE, AttendanceStatus.ABSENT]) {
      const day = resolveDay(facts({ date: saturday, mark: { status, modifier: null } }));
      expect(day).toEqual({ date: saturday, kind: "WEEKEND", detail: null });
    }
  });

  it("ignores a Leave or Absent mark on a holiday", () => {
    const day = resolveDay(
      facts({ holiday: { name: "Diwali" }, mark: { status: AttendanceStatus.LEAVE, modifier: null } }),
    );
    expect(day).toEqual({ date: "2026-11-16", kind: "HOLIDAY", detail: "Diwali" });
  });

  it("still counts a weekend or holiday someone worked", () => {
    const saturday = resolveDay(
      facts({ date: "2026-11-14", mark: { status: AttendanceStatus.PRESENT, modifier: null } }),
    );
    expect(saturday?.kind).toBe("PRESENT");
    const holiday = resolveDay(
      facts({ holiday: { name: "Diwali" }, mark: { status: AttendanceStatus.WFH, modifier: null } }),
    );
    expect(holiday?.kind).toBe("WFH");
  });

  it("skips the future and the days before joining", () => {
    expect(resolveDay(facts({ date: "2026-11-19" }))).toBeNull();
    expect(resolveDay(facts({ joinedOn: "2026-11-17" }))).toBeNull();
    expect(resolveDay(facts({ joinedOn: "2026-11-16" }))?.kind).toBe("NOT_MARKED");
  });

  it("counts today", () => {
    expect(resolveDay(facts({ date: TODAY }))?.kind).toBe("NOT_MARKED");
  });
});

describe("periodRange", () => {
  it("covers a month up to today", () => {
    expect(periodRange("month", "2026-11-05", TODAY)).toEqual({
      from: "2026-11-01",
      to: "2026-11-18",
      label: "November 2026",
    });
  });

  it("covers a whole past quarter", () => {
    expect(periodRange("quarter", "2026-08-10", TODAY)).toEqual({
      from: "2026-07-01",
      to: "2026-09-30",
      label: "Q3 2026",
    });
  });

  it("covers a whole past year", () => {
    expect(periodRange("year", "2025-03-01", TODAY)).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
      label: "2025",
    });
  });

  it("clips the current quarter and year at today", () => {
    expect(periodRange("quarter", TODAY, TODAY)).toMatchObject({ from: "2026-10-01", to: TODAY });
    expect(periodRange("year", TODAY, TODAY)).toMatchObject({ from: "2026-01-01", to: TODAY });
  });

  it("ends a February on its last day", () => {
    expect(periodRange("month", "2024-02-10", TODAY).to).toBe("2024-02-29");
  });
});

describe("shiftPeriod", () => {
  it("steps across a year boundary", () => {
    expect(shiftPeriod("month", "2026-01-15", -1).slice(0, 7)).toBe("2025-12");
    expect(periodRange("quarter", shiftPeriod("quarter", TODAY, 1), "2030-01-01").label).toBe(
      "Q1 2027",
    );
    expect(shiftPeriod("year", TODAY, -1).slice(0, 4)).toBe("2025");
  });

  it("does not skip a short month from the 31st", () => {
    expect(shiftPeriod("month", "2026-01-31", 1).slice(0, 7)).toBe("2026-02");
  });
});

describe("countDays", () => {
  it("counts the five working kinds and ignores holidays and weekends", () => {
    const counts = countDays([
      { date: "a", kind: "PRESENT", detail: null },
      { date: "b", kind: "PRESENT", detail: null },
      { date: "c", kind: "WFH", detail: null },
      { date: "d", kind: "LEAVE", detail: null },
      { date: "e", kind: "NOT_MARKED", detail: null },
      { date: "f", kind: "HOLIDAY", detail: null },
      { date: "g", kind: "WEEKEND", detail: null },
    ]);
    expect(counts).toEqual({ PRESENT: 2, WFH: 1, ABSENT: 0, LEAVE: 1, NOT_MARKED: 1 });
  });
});
