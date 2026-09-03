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
