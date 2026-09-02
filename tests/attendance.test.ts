import { describe, expect, it } from "vitest";

import {
  assertMarkable,
  fromDbDate,
  isActiveCode,
  isFutureDate,
  parseDateParam,
  toDbDate,
  todayIso,
  toggle,
  type AttendanceState,
} from "@/lib/attendance";
import { HttpError } from "@/lib/rbac";

/**
 * The attendance rules, with no database and no session in sight.
 *
 * The combination matrix is the product requirement, so it is pinned here
 * rather than inferred from the screen: Present and WFH are the base, Half day
 * and Short leave are add-ons, Absent and On leave stand alone.
 */

const state = (
  status: AttendanceState["status"],
  modifier: AttendanceState["modifier"] = null,
): AttendanceState => ({ status, modifier });

describe("todayIso", () => {
  it("resolves the day in Asia/Kolkata, not UTC", () => {
    // 2026-09-02T20:30:00Z is 2026-09-03 02:00 IST — a different day.
    expect(todayIso(new Date("2026-09-02T20:30:00Z"))).toBe("2026-09-03");
  });

  it("agrees with UTC in the middle of the day", () => {
    expect(todayIso(new Date("2026-09-02T06:00:00Z"))).toBe("2026-09-02");
  });
});

describe("date parsing", () => {
  it("accepts an ISO day", () => {
    expect(parseDateParam("2026-08-17")).toBe("2026-08-17");
  });

  it("rejects a malformed day", () => {
    expect(() => parseDateParam("17-08-2026")).toThrow(HttpError);
  });

  it("rejects a day that does not exist", () => {
    expect(() => parseDateParam("2026-02-30")).toThrow(HttpError);
  });

  it("rejects a missing value", () => {
    expect(() => parseDateParam(undefined)).toThrow(HttpError);
  });

  it("round-trips through the database representation", () => {
    expect(fromDbDate(toDbDate("2026-08-17"))).toBe("2026-08-17");
  });
});

describe("future dates", () => {
  it("refuses tomorrow", () => {
    expect(isFutureDate("2026-09-03", "2026-09-02")).toBe(true);
    expect(() => assertMarkable("2026-09-03", "2026-09-02")).toThrow(HttpError);
  });

  it("allows today and any past day", () => {
    expect(isFutureDate("2026-09-02", "2026-09-02")).toBe(false);
    expect(isFutureDate("2020-01-01", "2026-09-02")).toBe(false);
    expect(() => assertMarkable("2026-09-02", "2026-09-02")).not.toThrow();
    expect(() => assertMarkable("2020-01-01", "2026-09-02")).not.toThrow();
  });
});

describe("toggle — every valid combination is reachable", () => {
  it("marks an unmarked day present", () => {
    expect(toggle(null, "PRESENT")).toEqual(state("PRESENT"));
  });

  it("clears the day when the active base is clicked again", () => {
    expect(toggle(state("PRESENT"), "PRESENT")).toBeNull();
    expect(toggle(state("PRESENT", "HALF_DAY"), "PRESENT")).toBeNull();
  });

  it("swaps the base and keeps the add-on", () => {
    expect(toggle(state("WFH", "HALF_DAY"), "PRESENT")).toEqual(
      state("PRESENT", "HALF_DAY"),
    );
    expect(toggle(state("PRESENT", "SHORT_LEAVE"), "WFH")).toEqual(
      state("WFH", "SHORT_LEAVE"),
    );
  });

  it("defaults to Present when an add-on is applied to an unmarked day", () => {
    expect(toggle(null, "HALF_DAY")).toEqual(state("PRESENT", "HALF_DAY"));
    expect(toggle(null, "SHORT_LEAVE")).toEqual(state("PRESENT", "SHORT_LEAVE"));
  });

  it("keeps Half day and Short leave mutually exclusive", () => {
    expect(toggle(state("PRESENT", "HALF_DAY"), "SHORT_LEAVE")).toEqual(
      state("PRESENT", "SHORT_LEAVE"),
    );
    expect(toggle(state("WFH", "SHORT_LEAVE"), "HALF_DAY")).toEqual(
      state("WFH", "HALF_DAY"),
    );
  });

  it("removes the add-on and keeps the base", () => {
    expect(toggle(state("WFH", "HALF_DAY"), "HALF_DAY")).toEqual(state("WFH"));
  });

  it("lifts an absence to a working day when an add-on is applied", () => {
    expect(toggle(state("ABSENT"), "HALF_DAY")).toEqual(state("PRESENT", "HALF_DAY"));
  });

  it("lets Absent and On leave replace everything", () => {
    expect(toggle(state("PRESENT", "HALF_DAY"), "ABSENT")).toEqual(state("ABSENT"));
    expect(toggle(state("WFH", "SHORT_LEAVE"), "LEAVE")).toEqual(state("LEAVE"));
  });

  it("clears the day when the active solo code is clicked again", () => {
    expect(toggle(state("ABSENT"), "ABSENT")).toBeNull();
    expect(toggle(state("LEAVE"), "LEAVE")).toBeNull();
  });

  it("never produces a modifier without a working base", () => {
    const codes = [
      "PRESENT",
      "WFH",
      "HALF_DAY",
      "ABSENT",
      "LEAVE",
      "SHORT_LEAVE",
    ] as const;
    const starts: (AttendanceState | null)[] = [
      null,
      state("PRESENT"),
      state("WFH"),
      state("ABSENT"),
      state("LEAVE"),
      state("PRESENT", "HALF_DAY"),
      state("WFH", "SHORT_LEAVE"),
    ];

    for (const start of starts) {
      for (const code of codes) {
        const next = toggle(start, code);
        if (next?.modifier) {
          expect(["PRESENT", "WFH"]).toContain(next.status);
        }
      }
    }
  });
});

describe("isActiveCode", () => {
  it("reads the base and the add-on independently", () => {
    const s = state("WFH", "HALF_DAY");
    expect(isActiveCode(s, "WFH")).toBe(true);
    expect(isActiveCode(s, "HALF_DAY")).toBe(true);
    expect(isActiveCode(s, "PRESENT")).toBe(false);
    expect(isActiveCode(s, "SHORT_LEAVE")).toBe(false);
  });

  it("treats an unmarked day as nothing active", () => {
    expect(isActiveCode(null, "PRESENT")).toBe(false);
  });
});
