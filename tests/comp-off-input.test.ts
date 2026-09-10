import { describe, expect, it } from "vitest";

import { compOffClaimInputFrom, compOffDecisionFrom } from "@/lib/comp-off-input";

describe("compOffClaimInputFrom", () => {
  it("reads a date and a reason", () => {
    expect(compOffClaimInputFrom({ workedOn: "2026-09-13", reason: "Release cutover" })).toEqual({
      workedOn: "2026-09-13",
      reason: "Release cutover",
    });
  });

  it("treats a missing reason as null", () => {
    expect(compOffClaimInputFrom({ workedOn: "2026-09-13" }).reason).toBeNull();
  });

  it("treats an empty reason as null — a disabled or untouched textarea", () => {
    expect(compOffClaimInputFrom({ workedOn: "2026-09-13", reason: "" }).reason).toBeNull();
  });

  it("trims a reason", () => {
    expect(compOffClaimInputFrom({ workedOn: "2026-09-13", reason: "  cutover  " }).reason).toBe(
      "cutover",
    );
  });

  it("refuses a missing date", () => {
    expect(() => compOffClaimInputFrom({})).toThrow(/workedOn/);
  });

  it("refuses a malformed date", () => {
    expect(() => compOffClaimInputFrom({ workedOn: "13-09-2026" })).toThrow(/workedOn/);
  });

  it("refuses a date that is not real", () => {
    expect(() => compOffClaimInputFrom({ workedOn: "2026-02-30" })).toThrow(/not a real date/);
  });

  it("refuses a reason longer than 500 characters", () => {
    expect(() =>
      compOffClaimInputFrom({ workedOn: "2026-09-13", reason: "x".repeat(501) }),
    ).toThrow(/500 characters or fewer/);
  });

  it("does not decide whether the day is claimable — that needs holidays", () => {
    // An ordinary Monday parses fine. `claimableDay` in the service refuses
    // it, because only the service can know the claimant's region.
    expect(compOffClaimInputFrom({ workedOn: "2026-09-07" }).workedOn).toBe("2026-09-07");
  });
});

describe("compOffDecisionFrom", () => {
  it("reads the form's button value", () => {
    expect(compOffDecisionFrom({ intent: "approve" })).toEqual({
      decision: "APPROVED",
      note: null,
    });
  });

  it("reads an API caller's status", () => {
    expect(compOffDecisionFrom({ intent: "REJECTED", note: "Not a rostered day" })).toEqual({
      decision: "REJECTED",
      note: "Not a rostered day",
    });
  });

  it("refuses an unknown intent", () => {
    expect(() => compOffDecisionFrom({ intent: "maybe" })).toThrow(/approve, reject/);
  });

  it("refuses a missing intent", () => {
    expect(() => compOffDecisionFrom({})).toThrow(/intent/);
  });

  it("refuses a note longer than 500 characters", () => {
    expect(() => compOffDecisionFrom({ intent: "reject", note: "x".repeat(501) })).toThrow(
      /500 characters or fewer/,
    );
  });

  it("does not enforce that a rejection has a reason — that is a transition rule", () => {
    expect(compOffDecisionFrom({ intent: "reject" })).toEqual({
      decision: "REJECTED",
      note: null,
    });
  });
});
