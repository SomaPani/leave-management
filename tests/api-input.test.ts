import { describe, expect, it } from "vitest";

import { EmploymentStatus, WorkMode } from "@/generated/prisma/enums";
import {
  patchEnum,
  patchNullableDate,
  patchNullableEmail,
  patchNullableEnum,
  patchNullableString,
} from "@/lib/api";
import { memberProfileFrom, statusFilterFrom } from "@/lib/member-input";
import { HttpError } from "@/lib/rbac";

/**
 * Request-body parsing, with no database or session involved.
 *
 * These rules are load-bearing in two places at once: the JSON routes and, via
 * `formBody`, the Server Actions behind the Team screen. The three-way
 * distinction they encode — absent, blank, present — is what lets a PATCH and
 * an HTML form both say "leave this alone" and "empty this" without a special
 * case per field, so it is pinned here directly rather than only through the
 * endpoints that happen to use it.
 */

const WORK_MODES = [WorkMode.WFO, WorkMode.WFH] as const;

describe("patchNullableString", () => {
  it("reads an absent field as 'leave alone'", () => {
    expect(patchNullableString({}, "title")).toBeUndefined();
    expect(patchNullableString({ title: undefined }, "title")).toBeUndefined();
  });

  it("reads null and blank alike as 'clear it'", () => {
    expect(patchNullableString({ title: null }, "title")).toBeNull();
    expect(patchNullableString({ title: "" }, "title")).toBeNull();
    // Whitespace only: what an untouched form input submits.
    expect(patchNullableString({ title: "   " }, "title")).toBeNull();
  });

  it("trims a real value", () => {
    expect(patchNullableString({ title: "  Art director " }, "title")).toBe(
      "Art director",
    );
  });

  it("rejects a non-string", () => {
    expect(() => patchNullableString({ title: 42 }, "title")).toThrow(HttpError);
  });
});

describe("patchNullableEmail", () => {
  it("lower-cases and clears", () => {
    expect(patchNullableEmail({ e: "Dev@Stacx24.com" }, "e")).toBe("dev@stacx24.com");
    expect(patchNullableEmail({ e: "" }, "e")).toBeNull();
    expect(patchNullableEmail({}, "e")).toBeUndefined();
  });

  it("rejects a malformed address", () => {
    expect(() => patchNullableEmail({ e: "not-an-email" }, "e")).toThrow(HttpError);
  });
});

describe("patchNullableDate", () => {
  it("accepts an ISO day", () => {
    const parsed = patchNullableDate({ joinedOn: "2024-02-03" }, "joinedOn");
    expect(parsed).toBeInstanceOf(Date);
    expect((parsed as Date).toISOString().slice(0, 10)).toBe("2024-02-03");
  });

  it("clears on blank and leaves an absent field alone", () => {
    expect(patchNullableDate({ joinedOn: "" }, "joinedOn")).toBeNull();
    expect(patchNullableDate({}, "joinedOn")).toBeUndefined();
  });

  it("rejects a bare year, so a loose string cannot pass as a date", () => {
    expect(() => patchNullableDate({ joinedOn: "2024" }, "joinedOn")).toThrow(HttpError);
  });

  it("rejects an unparseable or impossible date", () => {
    expect(() => patchNullableDate({ joinedOn: "yesterday" }, "joinedOn")).toThrow(
      HttpError,
    );
    expect(() => patchNullableDate({ joinedOn: "2024-13-45" }, "joinedOn")).toThrow(
      HttpError,
    );
  });
});

describe("patchNullableEnum", () => {
  it("accepts any casing", () => {
    expect(patchNullableEnum({ workMode: "wfh" }, "workMode", WORK_MODES)).toBe(
      WorkMode.WFH,
    );
    expect(patchNullableEnum({ workMode: "WFO" }, "workMode", WORK_MODES)).toBe(
      WorkMode.WFO,
    );
  });

  it("clears on blank", () => {
    expect(patchNullableEnum({ workMode: "" }, "workMode", WORK_MODES)).toBeNull();
  });

  it("rejects a value outside the set, naming the options", () => {
    expect(() =>
      patchNullableEnum({ workMode: "REMOTE" }, "workMode", WORK_MODES),
    ).toThrow(/WFO, WFH/);
  });
});

describe("patchEnum", () => {
  const STATUSES = [EmploymentStatus.ACTIVE, EmploymentStatus.INACTIVE] as const;

  it("behaves like the nullable form for real values", () => {
    expect(patchEnum({ status: "inactive" }, "status", STATUSES)).toBe(
      EmploymentStatus.INACTIVE,
    );
    expect(patchEnum({}, "status", STATUSES)).toBeUndefined();
  });

  it("refuses to clear a NOT NULL column", () => {
    expect(() => patchEnum({ status: null }, "status", STATUSES)).toThrow(/cannot be empty/);
    expect(() => patchEnum({ status: "" }, "status", STATUSES)).toThrow(/cannot be empty/);
  });
});

describe("memberProfileFrom", () => {
  it("mentions only the fields the body carried", () => {
    const profile = memberProfileFrom({ title: "Strategist" });
    expect(profile.title).toBe("Strategist");
    // Everything else stays undefined, so `pickDefined` drops it before Prisma
    // sees it and an unrelated PATCH cannot blank a field by omission.
    expect(profile.empId).toBeUndefined();
    expect(profile.regionId).toBeUndefined();
    expect(profile.managerId).toBeUndefined();
    expect(profile.workMode).toBeUndefined();
  });

  it("distinguishes a blank field from an absent one", () => {
    const profile = memberProfileFrom({ empId: "" });
    expect(profile.empId).toBeNull();
    expect(profile.title).toBeUndefined();
  });

  it("ignores keys that are not part of the profile", () => {
    const profile = memberProfileFrom({
      name: "Aisha",
      password: "secret",
      organizationId: "someone-elses-org",
    });
    expect(Object.values(profile).every((value) => value === undefined)).toBe(true);
  });
});

describe("statusFilterFrom", () => {
  const params = (query: string) => new URLSearchParams(query);

  it("leaves the default to the service when absent or blank", () => {
    expect(statusFilterFrom(params(""))).toBeUndefined();
    expect(statusFilterFrom(params("status="))).toBeUndefined();
  });

  it("reads ALL as 'every status'", () => {
    expect(statusFilterFrom(params("status=ALL"))).toBeNull();
    expect(statusFilterFrom(params("status=all"))).toBeNull();
  });

  it("reads a named status, any casing", () => {
    expect(statusFilterFrom(params("status=inactive"))).toBe(EmploymentStatus.INACTIVE);
    expect(statusFilterFrom(params("status=ACTIVE"))).toBe(EmploymentStatus.ACTIVE);
  });

  it("rejects anything else", () => {
    expect(() => statusFilterFrom(params("status=retired"))).toThrow(HttpError);
  });
});
