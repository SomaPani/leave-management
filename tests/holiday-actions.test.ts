import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

/**
 * The Server Actions behind the Holiday calendar screen.
 *
 * Same approach as team-actions.test.ts: the actions are plain async functions
 * over `FormData`, so they are called directly. `redirect` and `revalidatePath`
 * are stubbed — the first records where the action sent the caller and throws
 * the way the real one does, which is how success (`/holidays`) and failure
 * (`?error=...`) are both asserted.
 */

const { actorRef, nav } = vi.hoisted(() => ({
  actorRef: { current: null as Actor | null },
  nav: { redirectedTo: "", revalidated: [] as string[] },
}));

vi.mock("@/lib/auth", () => ({
  currentActor: async () => actorRef.current,
  auth: async () => null,
  handlers: { GET: () => new Response(), POST: () => new Response() },
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    nav.redirectedTo = url;
    throw new Error("NEXT_REDIRECT");
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => nav.revalidated.push(path),
}));

const { prisma } = await import("@/lib/prisma");
const actions = await import("@/lib/holiday-actions");

const RUN = `holact-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

let orgA = "";
let adminA: Actor;
let otherAdmin: Actor;
let memberA: Actor;
let chennai = "";
let delhi = "";

/** Runs an action and reports where it redirected. */
async function run(
  action: (form: FormData) => Promise<void>,
  fields: Record<string, string>,
): Promise<string> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);

  nav.redirectedTo = "";
  await expect(action(form)).rejects.toThrow("NEXT_REDIRECT");
  return nav.redirectedTo;
}

/** The message an action attached to its redirect, decoded. */
function errorIn(url: string): string | null {
  const query = url.split("?")[1];
  return query ? new URLSearchParams(query).get("error") : null;
}

const holidayNamed = (name: string) =>
  prisma.holiday.findFirst({ where: { organizationId: orgA, name } });

beforeAll(async () => {
  const [a, b] = await Promise.all([
    prisma.organization.create({ data: { name: `${RUN}-a` }, select: { id: true } }),
    prisma.organization.create({ data: { name: `${RUN}-b` }, select: { id: true } }),
  ]);
  orgA = a.id;

  const regions = await Promise.all([
    prisma.region.create({
      data: { name: "Chennai", organizationId: a.id },
      select: { id: true },
    }),
    prisma.region.create({
      data: { name: "Delhi", organizationId: a.id },
      select: { id: true },
    }),
  ]);
  chennai = regions[0].id;
  delhi = regions[1].id;

  const made = await Promise.all([
    prisma.user.create({
      data: {
        name: "Admin A",
        email: email("admin-a"),
        passwordHash: "x",
        role: Role.ADMIN,
        organizationId: a.id,
      },
      select: { id: true },
    }),
    prisma.user.create({
      data: {
        name: "Admin B",
        email: email("admin-b"),
        passwordHash: "x",
        role: Role.ADMIN,
        organizationId: b.id,
      },
      select: { id: true },
    }),
    prisma.user.create({
      data: {
        name: "Member A",
        email: email("member-a"),
        passwordHash: "x",
        role: Role.MEMBER,
        organizationId: a.id,
      },
      select: { id: true },
    }),
  ]);
  adminA = { id: made[0].id, role: Role.ADMIN, organizationId: a.id };
  otherAdmin = { id: made[1].id, role: Role.ADMIN, organizationId: b.id };
  memberA = { id: made[2].id, role: Role.MEMBER, organizationId: a.id };
});

afterAll(async () => {
  await prisma.holiday.deleteMany({
    where: { organization: { name: { startsWith: RUN } } },
  });
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
  await prisma.region.deleteMany({
    where: { organization: { name: { startsWith: RUN } } },
  });
  await prisma.organization.deleteMany({ where: { name: { startsWith: RUN } } });
  await prisma.$disconnect();
});

beforeEach(() => {
  actorRef.current = adminA;
  nav.revalidated = [];
});

describe("createHolidayAction", () => {
  it("adds an organization-wide holiday and returns to the calendar", async () => {
    const to = await run(actions.createHolidayAction, {
      name: "Republic Day",
      startDate: "2026-01-26",
      endDate: "",
      regionId: "",
      note: "",
    });

    expect(to).toBe("/holidays?y=2026");
    expect(nav.revalidated).toContain("/holidays");

    const row = await holidayNamed("Republic Day");
    expect(row?.regionId).toBeNull();
    // A blank end date is the single-day case, not an error.
    expect(row?.endDate.toISOString().slice(0, 10)).toBe("2026-01-26");
  });

  it("scopes a holiday to one region", async () => {
    await run(actions.createHolidayAction, {
      name: "Pongal",
      startDate: "2026-01-15",
      endDate: "",
      regionId: chennai,
      note: "Harvest festival",
    });

    const row = await holidayNamed("Pongal");
    expect(row?.regionId).toBe(chennai);
    expect(row?.note).toBe("Harvest festival");
  });

  it("keeps a multi-day range", async () => {
    await run(actions.createHolidayAction, {
      name: "Diwali",
      startDate: "2026-11-08",
      endDate: "2026-11-09",
      regionId: "",
      note: "",
    });

    const row = await holidayNamed("Diwali");
    expect(row?.endDate.toISOString().slice(0, 10)).toBe("2026-11-09");
  });

  it("returns to the open form with the message when the range is reversed", async () => {
    const to = await run(actions.createHolidayAction, {
      name: "Backwards",
      startDate: "2026-05-05",
      endDate: "2026-05-01",
      regionId: "",
      note: "",
    });

    expect(to).toContain("/holidays?add=1");
    expect(errorIn(to)).toMatch(/endDate/i);
    expect(await holidayNamed("Backwards")).toBeNull();
  });

  it("refuses a member", async () => {
    actorRef.current = memberA;

    const to = await run(actions.createHolidayAction, {
      name: "Member Made This",
      startDate: "2026-07-01",
      endDate: "",
      regionId: "",
      note: "",
    });

    expect(errorIn(to)).toMatch(/admin/i);
    expect(await holidayNamed("Member Made This")).toBeNull();
  });

  it("refuses a region belonging to another organization", async () => {
    const foreign = await prisma.region.create({
      data: {
        name: "Mumbai",
        organization: { connect: { name: `${RUN}-b` } },
      },
      select: { id: true },
    });

    const to = await run(actions.createHolidayAction, {
      name: "Elsewhere",
      startDate: "2026-06-01",
      endDate: "",
      regionId: foreign.id,
      note: "",
    });

    expect(errorIn(to)).toMatch(/region/i);
    expect(await holidayNamed("Elsewhere")).toBeNull();
  });
});

describe("updateHolidayAction", () => {
  it("renames a holiday and moves it to another region", async () => {
    const existing = await holidayNamed("Pongal");

    const to = await run(actions.updateHolidayAction, {
      id: existing!.id,
      name: "Pongal (Tamil New Year)",
      startDate: "2026-01-15",
      endDate: "2026-01-16",
      regionId: delhi,
      note: "",
    });

    expect(to).toBe("/holidays?y=2026");

    const row = await prisma.holiday.findUnique({ where: { id: existing!.id } });
    expect(row?.name).toBe("Pongal (Tamil New Year)");
    expect(row?.regionId).toBe(delhi);
    expect(row?.endDate.toISOString().slice(0, 10)).toBe("2026-01-16");
    // An emptied note box clears the field rather than being ignored.
    expect(row?.note).toBeNull();
  });

  it("widens a regional holiday back to the whole organization", async () => {
    const existing = await holidayNamed("Pongal (Tamil New Year)");

    await run(actions.updateHolidayAction, {
      id: existing!.id,
      name: "Pongal (Tamil New Year)",
      startDate: "2026-01-15",
      endDate: "2026-01-16",
      regionId: "",
      note: "",
    });

    const row = await prisma.holiday.findUnique({ where: { id: existing!.id } });
    expect(row?.regionId).toBeNull();
  });

  it("returns to the open edit panel when the range is reversed", async () => {
    const existing = await holidayNamed("Diwali");

    const to = await run(actions.updateHolidayAction, {
      id: existing!.id,
      name: "Diwali",
      startDate: "2026-11-08",
      endDate: "2026-11-01",
      regionId: "",
      note: "",
    });

    expect(to).toContain(`/holidays?edit=${existing!.id}`);
    expect(errorIn(to)).toMatch(/endDate/i);

    const row = await prisma.holiday.findUnique({ where: { id: existing!.id } });
    expect(row?.endDate.toISOString().slice(0, 10)).toBe("2026-11-09");
  });

  it("will not let an admin touch another organization's holiday", async () => {
    const existing = await holidayNamed("Diwali");
    actorRef.current = otherAdmin;

    const to = await run(actions.updateHolidayAction, {
      id: existing!.id,
      name: "Hijacked",
      startDate: "2026-11-08",
      endDate: "2026-11-09",
      regionId: "",
      note: "",
    });

    expect(errorIn(to)).toMatch(/does not exist/i);

    const row = await prisma.holiday.findUnique({ where: { id: existing!.id } });
    expect(row?.name).toBe("Diwali");
  });
});

describe("deleteHolidayAction", () => {
  it("removes one and returns to the year the admin was viewing", async () => {
    const existing = await holidayNamed("Republic Day");

    // The row's form carries the displayed year, so removing a 2027 entry does
    // not bounce the admin back to the current year.
    expect(
      await run(actions.deleteHolidayAction, { id: existing!.id, year: "2026" }),
    ).toBe("/holidays?y=2026");

    expect(await prisma.holiday.findUnique({ where: { id: existing!.id } })).toBeNull();
  });

  it("falls back to the bare calendar when no year came with the form", async () => {
    const stray = await prisma.holiday.create({
      data: {
        organizationId: orgA,
        name: "Stray",
        startDate: new Date("2027-03-01"),
        endDate: new Date("2027-03-01"),
      },
      select: { id: true },
    });

    expect(await run(actions.deleteHolidayAction, { id: stray.id })).toBe("/holidays");
    expect(await prisma.holiday.findUnique({ where: { id: stray.id } })).toBeNull();
  });

  it("refuses a member", async () => {
    const existing = await holidayNamed("Diwali");
    actorRef.current = memberA;

    const to = await run(actions.deleteHolidayAction, { id: existing!.id });

    expect(errorIn(to)).toMatch(/admin/i);
    expect(await prisma.holiday.findUnique({ where: { id: existing!.id } })).not.toBeNull();
  });
});
