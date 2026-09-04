import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

/**
 * Leave policies and leave requests against the Dockerized Postgres.
 *
 * Same approach as holidays.integration.test.ts: the session is stubbed and
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

const RUN = `lv-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

let orgId: string;
let otherOrgId: string;
let adminId: string;
let managerId: string;
let memberId: string;
let chennaiId: string;
let delhiId: string;
let casualId: string;
let shortId: string;
let otherPolicyId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `${RUN} Org` } });
  orgId = org.id;

  const other = await prisma.organization.create({ data: { name: `${RUN} Other` } });
  otherOrgId = other.id;

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

  const manager = await prisma.user.create({
    data: {
      name: "Run Manager",
      email: email("manager"),
      passwordHash: "x",
      role: Role.MEMBER,
      organizationId: orgId,
      regionId: chennaiId,
    },
  });
  managerId = manager.id;

  const member = await prisma.user.create({
    data: {
      name: "Run Member",
      email: email("member"),
      passwordHash: "x",
      role: Role.MEMBER,
      organizationId: orgId,
      regionId: chennaiId,
      managerId: manager.id,
    },
  });
  memberId = member.id;

  const casual = await prisma.leavePolicy.create({
    data: { organizationId: orgId, name: "Casual", allowance: 6, position: 0 },
  });
  casualId = casual.id;

  const short = await prisma.leavePolicy.create({
    data: {
      organizationId: orgId,
      name: "Short leave",
      allowance: 4,
      unit: "USES",
      position: 3,
    },
  });
  shortId = short.id;

  const foreign = await prisma.leavePolicy.create({
    data: { organizationId: otherOrgId, name: "Casual", allowance: 6 },
  });
  otherPolicyId = foreign.id;
});

afterAll(async () => {
  await prisma.leaveRequest.deleteMany({ where: { organizationId: orgId } });
  await prisma.leavePolicy.deleteMany({ where: { organizationId: orgId } });
  await prisma.leavePolicy.deleteMany({ where: { organizationId: otherOrgId } });
  await prisma.holiday.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.region.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.organization.delete({ where: { id: otherOrgId } });
  await prisma.$disconnect();
});

describe("the database enforces what the schema cannot say", () => {
  it("refuses endDate before startDate", async () => {
    await expect(
      prisma.leaveRequest.create({
        data: {
          organizationId: orgId,
          userId: memberId,
          policyId: casualId,
          startDate: new Date("2026-09-10"),
          endDate: new Date("2026-09-09"),
          cost: 1,
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses a negative cost but allows zero", async () => {
    await expect(
      prisma.leaveRequest.create({
        data: {
          organizationId: orgId,
          userId: memberId,
          policyId: casualId,
          startDate: new Date("2026-09-12"),
          endDate: new Date("2026-09-13"),
          cost: -1,
        },
      }),
    ).rejects.toThrow();

    const free = await prisma.leaveRequest.create({
      data: {
        organizationId: orgId,
        userId: memberId,
        policyId: casualId,
        startDate: new Date("2026-09-12"),
        endDate: new Date("2026-09-13"),
        cost: 0,
      },
    });
    expect(free.cost).toBe(0);
    await prisma.leaveRequest.delete({ where: { id: free.id } });
  });

  it("refuses a negative allowance", async () => {
    await expect(
      prisma.leavePolicy.create({
        data: { organizationId: orgId, name: "Impossible", allowance: -1 },
      }),
    ).rejects.toThrow();
  });

  it("refuses two policies with one name in one organization", async () => {
    await expect(
      prisma.leavePolicy.create({
        data: { organizationId: orgId, name: "Casual", allowance: 9 },
      }),
    ).rejects.toThrow();
  });

  it("lets two organizations each have a Casual policy", async () => {
    const foreign = await prisma.leavePolicy.findUnique({
      where: { id: otherPolicyId },
      select: { name: true, organizationId: true },
    });
    expect(foreign).toEqual({ name: "Casual", organizationId: otherOrgId });
  });

  it("refuses to delete a policy that has requests against it", async () => {
    const request = await prisma.leaveRequest.create({
      data: {
        organizationId: orgId,
        userId: memberId,
        policyId: casualId,
        startDate: new Date("2026-09-14"),
        endDate: new Date("2026-09-14"),
        cost: 1,
      },
    });

    await expect(
      prisma.leavePolicy.delete({ where: { id: casualId } }),
    ).rejects.toThrow();

    await prisma.leaveRequest.delete({ where: { id: request.id } });
  });
});
