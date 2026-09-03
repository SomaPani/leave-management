import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

/**
 * Holidays against the Dockerized Postgres.
 *
 * Same approach as attendance.integration.test.ts: the session is stubbed and
 * everything below it — the real handlers, the real policy layer, real Prisma
 * queries — runs for real. Rows are namespaced with a per-run prefix.
 */
const { actorRef } = vi.hoisted(() => ({
  actorRef: { current: null as Actor | null },
}));

vi.mock("@/lib/auth", () => ({
  currentActor: async () => actorRef.current,
  auth: async () => null,
  handlers: { GET: () => new Response(), POST: () => new Response() },
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { prisma } = await import("@/lib/prisma");

const RUN = `hol-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

let orgId: string;
let adminId: string;
let memberId: string;
let chennaiId: string;
let delhiId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `${RUN} Org` } });
  orgId = org.id;

  const chennai = await prisma.region.create({
    data: { name: "Chennai", organizationId: orgId },
  });
  chennaiId = chennai.id;

  const delhi = await prisma.region.create({
    data: { name: "Delhi", organizationId: orgId },
  });
  delhiId = delhi.id;

  const admin = await prisma.user.create({
    data: {
      name: "Run Admin",
      email: email("admin"),
      passwordHash: "x",
      role: Role.ADMIN,
      organizationId: orgId,
    },
  });
  adminId = admin.id;

  const member = await prisma.user.create({
    data: {
      name: "Run Member",
      email: email("member"),
      passwordHash: "x",
      role: Role.MEMBER,
      organizationId: orgId,
      regionId: chennaiId,
    },
  });
  memberId = member.id;
});

afterAll(async () => {
  await prisma.holiday.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.region.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe("the database rejects a reversed range", () => {
  it("refuses endDate before startDate", async () => {
    await expect(
      prisma.holiday.create({
        data: {
          organizationId: orgId,
          name: "Backwards",
          startDate: new Date("2026-11-09"),
          endDate: new Date("2026-11-08"),
        },
      }),
    ).rejects.toThrow();
  });

  it("accepts a two-day holiday and a single-day one", async () => {
    const diwali = await prisma.holiday.create({
      data: {
        organizationId: orgId,
        name: "Diwali",
        startDate: new Date("2026-11-08"),
        endDate: new Date("2026-11-09"),
      },
    });
    expect(diwali.endDate.toISOString().slice(0, 10)).toBe("2026-11-09");
    expect(diwali.regionId).toBeNull();

    const pongal = await prisma.holiday.create({
      data: {
        organizationId: orgId,
        regionId: chennaiId,
        name: "Pongal",
        startDate: new Date("2026-01-15"),
        endDate: new Date("2026-01-15"),
      },
    });
    expect(pongal.regionId).toBe(chennaiId);
  });
});

const {
  listHolidays,
  createHoliday,
  createHolidays,
  updateHoliday,
  deleteHoliday,
} = await import("@/lib/holiday-service");

const adminActor = (): Actor => ({
  id: adminId,
  role: Role.ADMIN,
  organizationId: orgId,
});
const memberActor = (): Actor => ({
  id: memberId,
  role: Role.MEMBER,
  organizationId: orgId,
});

describe("createHoliday", () => {
  it("defaults a single-day holiday's end to its start", async () => {
    const created = await createHoliday(adminActor(), {
      name: "Republic Day",
      startDate: "2026-01-26",
      endDate: "2026-01-26",
      regionId: null,
      note: null,
    });

    expect(created.startDate).toBe("2026-01-26");
    expect(created.endDate).toBe("2026-01-26");
    expect(created.region).toBeNull();
  });

  it("attaches a region and returns its name", async () => {
    const created = await createHoliday(adminActor(), {
      name: "Holi",
      startDate: "2026-03-03",
      endDate: "2026-03-03",
      regionId: delhiId,
      note: "North India",
    });

    expect(created.region).toEqual({ id: delhiId, name: "Delhi" });
    expect(created.note).toBe("North India");
  });

  it("refuses a reversed range before the database has to", async () => {
    await expect(
      createHoliday(adminActor(), {
        name: "Backwards",
        startDate: "2026-05-05",
        endDate: "2026-05-01",
        regionId: null,
        note: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a region from another organization", async () => {
    const other = await prisma.organization.create({
      data: { name: `${RUN} Other` },
    });
    const foreignRegion = await prisma.region.create({
      data: { name: "Mumbai", organizationId: other.id },
    });

    await expect(
      createHoliday(adminActor(), {
        name: "Elsewhere",
        startDate: "2026-06-01",
        endDate: "2026-06-01",
        regionId: foreignRegion.id,
        note: null,
      }),
    ).rejects.toMatchObject({ status: 400 });

    await prisma.region.delete({ where: { id: foreignRegion.id } });
    await prisma.organization.delete({ where: { id: other.id } });
  });

  it("refuses a member and a superadmin", async () => {
    const input = {
      name: "Nope",
      startDate: "2026-07-01",
      endDate: "2026-07-01",
      regionId: null,
      note: null,
    };

    await expect(createHoliday(memberActor(), input)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      createHoliday({ id: "su", role: Role.SUPERADMIN, organizationId: null }, input),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("listHolidays", () => {
  it("gives an admin the whole organization, sorted", async () => {
    const rows = await listHolidays(adminActor(), { year: 2026 });
    const names = rows.map((h) => h.name);

    expect(names).toContain("Republic Day");
    expect(names).toContain("Holi");
    // Sorted by start date: January before March.
    expect(names.indexOf("Republic Day")).toBeLessThan(names.indexOf("Holi"));
  });

  it("gives a member their own region plus the organization-wide ones", async () => {
    // The member is in Chennai; "Holi" is Delhi-only.
    const rows = await listHolidays(memberActor(), { year: 2026 });
    const names = rows.map((h) => h.name);

    expect(names).toContain("Republic Day");
    expect(names).toContain("Pongal");
    expect(names).not.toContain("Holi");
  });

  it("ignores a region filter a member tries to pass", async () => {
    const rows = await listHolidays(memberActor(), { year: 2026, regionId: delhiId });
    expect(rows.map((h) => h.name)).not.toContain("Holi");
  });

  it("honours a region filter for an admin", async () => {
    const rows = await listHolidays(adminActor(), { year: 2026, regionId: delhiId });
    const names = rows.map((h) => h.name);

    expect(names).toContain("Holi");
    expect(names).toContain("Republic Day"); // org-wide always applies
    expect(names).not.toContain("Pongal");
  });

  it("narrows to a year", async () => {
    expect(await listHolidays(adminActor(), { year: 2025 })).toEqual([]);
  });
});

describe("createHolidays (bulk)", () => {
  it("inserts a batch and skips the ones already there", async () => {
    const batch = [
      {
        name: "Gandhi Jayanti",
        startDate: "2026-10-02",
        endDate: "2026-10-02",
        regionId: null,
        note: null,
      },
      {
        name: "Christmas",
        startDate: "2026-12-25",
        endDate: "2026-12-25",
        regionId: null,
        note: null,
      },
      // Already inserted above — same name, same start, same region.
      {
        name: "Republic Day",
        startDate: "2026-01-26",
        endDate: "2026-01-26",
        regionId: null,
        note: null,
      },
    ];

    const result = await createHolidays(adminActor(), batch);

    expect(result.created).toHaveLength(2);
    expect(result.skipped).toBe(1);
  });

  it("is a no-op run twice", async () => {
    const again = await createHolidays(adminActor(), [
      {
        name: "Christmas",
        startDate: "2026-12-25",
        endDate: "2026-12-25",
        regionId: null,
        note: null,
      },
    ]);

    expect(again.created).toHaveLength(0);
    expect(again.skipped).toBe(1);
  });
});

describe("updateHoliday and deleteHoliday", () => {
  it("renames and moves a holiday", async () => {
    const created = await createHoliday(adminActor(), {
      name: "Typo Day",
      startDate: "2026-04-01",
      endDate: "2026-04-01",
      regionId: null,
      note: null,
    });

    const updated = await updateHoliday(adminActor(), created.id, {
      name: "April Day",
      endDate: "2026-04-02",
    });

    expect(updated.name).toBe("April Day");
    expect(updated.endDate).toBe("2026-04-02");
    expect(updated.startDate).toBe("2026-04-01");
  });

  it("refuses an update that would reverse the range", async () => {
    const created = await createHoliday(adminActor(), {
      name: "Range Test",
      startDate: "2026-04-10",
      endDate: "2026-04-12",
      regionId: null,
      note: null,
    });

    await expect(
      updateHoliday(adminActor(), created.id, { endDate: "2026-04-09" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("404s an id outside the caller's organization", async () => {
    await expect(
      updateHoliday(adminActor(), "no-such-holiday", { name: "x" }),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      deleteHoliday(adminActor(), "no-such-holiday"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("deletes", async () => {
    const created = await createHoliday(adminActor(), {
      name: "Temporary",
      startDate: "2026-05-20",
      endDate: "2026-05-20",
      regionId: null,
      note: null,
    });

    expect(await deleteHoliday(adminActor(), created.id)).toEqual({
      id: created.id,
      deleted: true,
    });
    expect(await prisma.holiday.findUnique({ where: { id: created.id } })).toBeNull();
  });

  it("refuses a member", async () => {
    await expect(
      deleteHoliday(memberActor(), "anything"),
    ).rejects.toMatchObject({ status: 403 });
  });
});
