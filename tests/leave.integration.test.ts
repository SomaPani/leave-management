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
const service = await import("@/lib/leave-service");
const policyRoute = await import("@/app/api/leave-policies/route");
const requestRoute = await import("@/app/api/leave-requests/route");

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
    data: {
      organizationId: orgId,
      name: "Casual",
      allowance: 6,
      position: 0,
      effectiveFrom: new Date("2026-01-01"),
    },
  });
  casualId = casual.id;

  const short = await prisma.leavePolicy.create({
    data: {
      organizationId: orgId,
      name: "Short leave",
      allowance: 4,
      unit: "USES",
      position: 3,
      effectiveFrom: new Date("2026-01-01"),
    },
  });
  shortId = short.id;

  const foreign = await prisma.leavePolicy.create({
    data: {
      organizationId: otherOrgId,
      name: "Casual",
      allowance: 6,
      effectiveFrom: new Date("2026-01-01"),
    },
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
        data: {
          organizationId: orgId,
          name: "Impossible",
          allowance: -1,
          effectiveFrom: new Date("2026-01-01"),
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses two policies with one name in one organization", async () => {
    await expect(
      prisma.leavePolicy.create({
        data: {
          organizationId: orgId,
          name: "Casual",
          allowance: 9,
          effectiveFrom: new Date("2026-01-01"),
        },
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

  it("refuses a MONTHLY allowance that will not divide into twelve months", async () => {
    await expect(
      prisma.leavePolicy.create({
        data: {
          organizationId: orgId,
          name: "Awkward",
          allowance: 13,
          accrual: "MONTHLY",
          effectiveFrom: new Date("2026-01-01"),
        },
      }),
    ).rejects.toThrow();
  });

  it("accepts a MONTHLY allowance that divides evenly", async () => {
    const monthly = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: "Divisible",
        allowance: 12,
        accrual: "MONTHLY",
        effectiveFrom: new Date("2026-01-01"),
      },
    });
    expect(monthly.allowance).toBe(12);
    await prisma.leavePolicy.delete({ where: { id: monthly.id } });
  });

  it("leaves an UPFRONT allowance free of the divisibility rule", async () => {
    const odd = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: "Odd",
        allowance: 13,
        effectiveFrom: new Date("2026-01-01"),
      },
    });
    expect(odd.allowance).toBe(13);
    await prisma.leavePolicy.delete({ where: { id: odd.id } });
  });

  it("refuses a negative cap", async () => {
    await expect(
      prisma.leavePolicy.create({
        data: {
          organizationId: orgId,
          name: "Negative cap",
          allowance: 12,
          cap: -1,
          effectiveFrom: new Date("2026-01-01"),
        },
      }),
    ).rejects.toThrow();
  });

  it("keeps a decided request readable after the deciding admin is deleted", async () => {
    const leaver = await prisma.user.create({
      data: {
        name: "Run Leaver",
        email: email("leaver"),
        passwordHash: "x",
        role: Role.ADMIN,
        organizationId: orgId,
      },
    });

    const request = await prisma.leaveRequest.create({
      data: {
        organizationId: orgId,
        userId: memberId,
        policyId: casualId,
        startDate: new Date("2026-10-05"),
        endDate: new Date("2026-10-06"),
        cost: 2,
        status: "APPROVED",
        decidedAt: new Date("2026-09-07T10:00:00Z"),
        decidedById: leaver.id,
        decisionNote: "Fine.",
      },
    });

    await prisma.user.delete({ where: { id: leaver.id } });

    const after = await prisma.leaveRequest.findUnique({ where: { id: request.id } });

    // Attribution, not ownership: the admin goes, the decision stays.
    expect(after).toMatchObject({
      status: "APPROVED",
      decidedById: null,
      decisionNote: "Fine.",
    });
    expect(after?.decidedAt).not.toBeNull();

    await prisma.leaveRequest.delete({ where: { id: request.id } });
  });
});

const memberActor = (): Actor => ({
  id: memberId,
  role: Role.MEMBER,
  organizationId: orgId,
});

const adminActor = (): Actor => ({
  id: adminId,
  role: Role.ADMIN,
  organizationId: orgId,
});

const superActor = (): Actor => ({
  id: "super",
  role: Role.SUPERADMIN,
  organizationId: null,
});

async function clearRequests(): Promise<void> {
  await prisma.leaveRequest.deleteMany({ where: { organizationId: orgId } });
}

async function clearHolidays(): Promise<void> {
  await prisma.holiday.deleteMany({ where: { organizationId: orgId } });
}

describe("listing leave policies", () => {
  it("returns the caller's own organization's active policies, in order", async () => {
    const policies = await service.listLeavePolicies(memberActor());

    expect(policies.map((p) => p.name)).toEqual(["Casual", "Short leave"]);
    expect(policies[0]).toMatchObject({ allowance: 6, unit: "DAYS" });
    expect(policies[1]).toMatchObject({ allowance: 4, unit: "USES" });
  });

  it("never returns another organization's policies", async () => {
    const policies = await service.listLeavePolicies(memberActor());
    expect(policies.map((p) => p.id)).not.toContain(otherPolicyId);
  });

  it("hides a retired policy", async () => {
    const retired = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: "Sabbatical",
        allowance: 30,
        active: false,
        effectiveFrom: new Date("2026-01-01"),
      },
    });

    const policies = await service.listLeavePolicies(memberActor());
    expect(policies.map((p) => p.name)).not.toContain("Sabbatical");

    await prisma.leavePolicy.delete({ where: { id: retired.id } });
  });

  it("refuses a superadmin, who has no organization to have policies in", async () => {
    await expect(service.listLeavePolicies(superActor())).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("the member's own leave summary", () => {
  it("starts every balance at the full allowance", async () => {
    await clearRequests();
    const summary = await service.listOwnLeaveSummary(memberActor(), "2026-12-31");

    expect(summary.year).toBe(2026);
    expect(summary.balances).toEqual([
      expect.objectContaining({ name: "Casual", used: 0, balance: 6 }),
      expect.objectContaining({ name: "Short leave", used: 0, balance: 4 }),
    ]);
  });

  it("routes to the applicant's manager", async () => {
    const summary = await service.listOwnLeaveSummary(memberActor(), "2026-12-31");
    expect(summary.approver).toEqual({ id: managerId, name: "Run Manager" });
  });

  it("falls back to an admin when the applicant has no manager", async () => {
    // The manager has none of their own.
    const summary = await service.listOwnLeaveSummary(
      { id: managerId, role: Role.MEMBER, organizationId: orgId },
      "2026-12-31",
    );
    expect(summary.approver).toEqual({ id: adminId, name: "Run Admin" });
  });

  it("counts a pending request against the balance", async () => {
    await clearRequests();
    await clearHolidays();

    // Monday to Wednesday: three working days.
    await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-09-07",
      endDate: "2026-09-09",
      reason: null,
    });

    const summary = await service.listOwnLeaveSummary(memberActor(), "2026-12-31");
    expect(summary.balances[0]).toMatchObject({ used: 3, balance: 3 });
  });

  it("frees the days again when the request is withdrawn", async () => {
    await prisma.leaveRequest.updateMany({
      where: { userId: memberId },
      data: { status: "WITHDRAWN" },
    });

    const summary = await service.listOwnLeaveSummary(memberActor(), "2026-12-31");
    expect(summary.balances[0]).toMatchObject({ used: 0, balance: 6 });
  });

  it("charges a year-spanning request to the year it starts in", async () => {
    await clearRequests();

    // 31 December 2026 is a Thursday; the request runs into January.
    await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-12-31",
      endDate: "2027-01-01",
      reason: null,
    });

    const in2026 = await service.listOwnLeaveSummary(memberActor(), "2026-12-31");
    const in2027 = await service.listOwnLeaveSummary(memberActor(), "2027-12-31");

    expect(in2026.balances[0].used).toBe(2);
    expect(in2027.balances[0].used).toBe(0);
  });
});

describe("filing a leave request", () => {
  it("stores the working days, the organization and a PENDING status", async () => {
    await clearRequests();
    await clearHolidays();

    const created = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-09-11",
      endDate: "2026-09-14",
      reason: "Family thing",
    });

    // Friday and Monday; the weekend between them is free.
    expect(created).toMatchObject({
      cost: 2,
      status: "PENDING",
      startDate: "2026-09-11",
      endDate: "2026-09-14",
      reason: "Family thing",
      approver: { id: managerId, name: "Run Manager" },
    });

    const stored = await prisma.leaveRequest.findUnique({
      where: { id: created.id },
      select: { organizationId: true, userId: true },
    });
    expect(stored).toEqual({ organizationId: orgId, userId: memberId });
  });

  it("does not charge a holiday in the applicant's own region", async () => {
    await clearRequests();
    await clearHolidays();

    await prisma.holiday.create({
      data: {
        organizationId: orgId,
        regionId: chennaiId,
        name: "Diwali",
        startDate: new Date("2026-11-08"),
        endDate: new Date("2026-11-09"),
      },
    });

    // Monday to Wednesday, with the Monday covered by Diwali.
    const created = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-11-09",
      endDate: "2026-11-11",
      reason: null,
    });

    expect(created.cost).toBe(2);
  });

  it("does charge a holiday that belongs to another region", async () => {
    await clearRequests();
    await clearHolidays();

    await prisma.holiday.create({
      data: {
        organizationId: orgId,
        regionId: delhiId,
        name: "Delhi-only day",
        startDate: new Date("2026-11-09"),
        endDate: new Date("2026-11-09"),
      },
    });

    // The member is in Chennai, so the Delhi holiday is a working day for them.
    const created = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-11-09",
      endDate: "2026-11-11",
      reason: null,
    });

    expect(created.cost).toBe(3);
  });

  it("keeps the cost it was priced at when a holiday is added later", async () => {
    await clearRequests();
    await clearHolidays();

    const created = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-11-09",
      endDate: "2026-11-11",
      reason: null,
    });
    expect(created.cost).toBe(3);

    await prisma.holiday.create({
      data: {
        organizationId: orgId,
        regionId: chennaiId,
        name: "Declared afterwards",
        startDate: new Date("2026-11-10"),
        endDate: new Date("2026-11-10"),
      },
    });

    const reread = await service.findOwnLeaveRequest(memberActor(), created.id);
    expect(reread?.cost).toBe(3);
  });

  it("collapses a USES request to one day and one use", async () => {
    await clearRequests();
    await clearHolidays();

    const created = await service.createOwnLeaveRequest(memberActor(), {
      policyId: shortId,
      startDate: "2026-09-07",
      endDate: "2026-09-30",
      reason: null,
    });

    expect(created).toMatchObject({
      cost: 1,
      startDate: "2026-09-07",
      endDate: "2026-09-07",
    });
  });

  it("refuses a range that overlaps an existing pending request", async () => {
    await clearRequests();
    await clearHolidays();

    await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-09-07",
      endDate: "2026-09-09",
      reason: null,
    });

    await expect(
      service.createOwnLeaveRequest(memberActor(), {
        policyId: casualId,
        startDate: "2026-09-09",
        endDate: "2026-09-11",
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("allows a range that starts the day after an existing one ends", async () => {
    // The 7th-9th request from the previous test is still there.
    const created = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-09-10",
      endDate: "2026-09-11",
      reason: null,
    });

    expect(created.cost).toBe(2);
  });

  it("ignores a rejected request when checking for an overlap", async () => {
    await clearRequests();

    const first = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-09-07",
      endDate: "2026-09-09",
      reason: null,
    });
    await prisma.leaveRequest.update({
      where: { id: first.id },
      data: { status: "REJECTED" },
    });

    const second = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-09-07",
      endDate: "2026-09-09",
      reason: null,
    });
    expect(second.cost).toBe(3);
  });

  it("hides another organization's policy behind a 404", async () => {
    await expect(
      service.createOwnLeaveRequest(memberActor(), {
        policyId: otherPolicyId,
        startDate: "2026-10-05",
        endDate: "2026-10-05",
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a retired policy the same way", async () => {
    const retired = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: "Retired",
        allowance: 5,
        active: false,
        effectiveFrom: new Date("2026-01-01"),
      },
    });

    await expect(
      service.createOwnLeaveRequest(memberActor(), {
        policyId: retired.id,
        startDate: "2026-10-05",
        endDate: "2026-10-05",
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 404 });

    await prisma.leavePolicy.delete({ where: { id: retired.id } });
  });

  it("refuses a superadmin, who belongs to no organization", async () => {
    await expect(
      service.createOwnLeaveRequest(superActor(), {
        policyId: casualId,
        startDate: "2026-10-05",
        endDate: "2026-10-05",
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lets an admin file their own request", async () => {
    await clearRequests();

    const created = await service.createOwnLeaveRequest(adminActor(), {
      policyId: casualId,
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      reason: null,
    });

    expect(created.cost).toBe(1);
  });
});

describe("reading one's own requests", () => {
  it("returns only the caller's own, newest first", async () => {
    await clearRequests();

    await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-09-07",
      endDate: "2026-09-07",
      reason: null,
    });
    await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      reason: null,
    });
    await service.createOwnLeaveRequest(adminActor(), {
      policyId: casualId,
      startDate: "2026-11-02",
      endDate: "2026-11-02",
      reason: null,
    });

    const mine = await service.listOwnLeaveRequests(memberActor());
    expect(mine.map((r) => r.startDate)).toEqual(["2026-10-05", "2026-09-07"]);
  });

  it("returns null for a request that belongs to somebody else", async () => {
    const theirs = await service.listOwnLeaveRequests(adminActor());
    const found = await service.findOwnLeaveRequest(memberActor(), theirs[0].id);
    expect(found).toBeNull();
  });
});

function post(body: unknown): Request {
  return new Request("http://localhost/api/leave-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/leave-policies", () => {
  it("answers a member with their organization's policies", async () => {
    actorRef.current = memberActor();

    const response = await policyRoute.GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.map((p: { name: string }) => p.name)).toEqual([
      "Casual",
      "Short leave",
    ]);
  });

  it("answers 401 when nobody is signed in", async () => {
    actorRef.current = null;
    expect((await policyRoute.GET()).status).toBe(401);
  });

  it("answers 403 for a superadmin", async () => {
    actorRef.current = superActor();
    expect((await policyRoute.GET()).status).toBe(403);
  });
});

describe("POST /api/leave-requests", () => {
  it("creates a request and answers 201", async () => {
    await clearRequests();
    await clearHolidays();
    actorRef.current = memberActor();

    const response = await requestRoute.POST(
      post({
        policyId: casualId,
        startDate: "2026-09-07",
        endDate: "2026-09-09",
        reason: "Family thing",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ cost: 3, status: "PENDING" });
  });

  it("defaults a missing endDate to the start date", async () => {
    await clearRequests();
    actorRef.current = memberActor();

    const response = await requestRoute.POST(
      post({ policyId: casualId, startDate: "2026-09-07" }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ startDate: "2026-09-07", endDate: "2026-09-07" });
  });

  it("treats an empty endDate the same way — a disabled input submits nothing", async () => {
    await clearRequests();
    actorRef.current = memberActor();

    const response = await requestRoute.POST(
      post({ policyId: casualId, startDate: "2026-09-07", endDate: "" }),
    );

    expect(response.status).toBe(201);
  });

  it("answers 400 for a reversed range", async () => {
    actorRef.current = memberActor();

    const response = await requestRoute.POST(
      post({ policyId: casualId, startDate: "2026-09-09", endDate: "2026-09-07" }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/earlier than/);
  });

  it("answers 400 for a date that does not exist", async () => {
    actorRef.current = memberActor();

    const response = await requestRoute.POST(
      post({ policyId: casualId, startDate: "2026-02-30" }),
    );

    expect(response.status).toBe(400);
  });

  it("answers 400 for a missing policyId", async () => {
    actorRef.current = memberActor();

    const response = await requestRoute.POST(post({ startDate: "2026-09-07" }));

    expect(response.status).toBe(400);
  });

  it("answers 400 for a reason longer than the column expects", async () => {
    actorRef.current = memberActor();

    const response = await requestRoute.POST(
      post({
        policyId: casualId,
        startDate: "2026-10-05",
        reason: "x".repeat(501),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("answers 409 for an overlap", async () => {
    await clearRequests();
    actorRef.current = memberActor();

    await requestRoute.POST(
      post({ policyId: casualId, startDate: "2026-09-07", endDate: "2026-09-09" }),
    );
    const response = await requestRoute.POST(
      post({ policyId: casualId, startDate: "2026-09-08", endDate: "2026-09-10" }),
    );

    expect(response.status).toBe(409);
  });

  it("answers 404 for another organization's policy", async () => {
    actorRef.current = memberActor();

    const response = await requestRoute.POST(
      post({ policyId: otherPolicyId, startDate: "2026-10-05" }),
    );

    expect(response.status).toBe(404);
  });

  it("answers 401 when nobody is signed in", async () => {
    actorRef.current = null;

    const response = await requestRoute.POST(
      post({ policyId: casualId, startDate: "2026-10-05" }),
    );

    expect(response.status).toBe(401);
  });
});

describe("GET /api/leave-requests", () => {
  it("answers with the caller's own requests only", async () => {
    await clearRequests();

    actorRef.current = adminActor();
    await requestRoute.POST(post({ policyId: casualId, startDate: "2026-11-02" }));

    actorRef.current = memberActor();
    await requestRoute.POST(post({ policyId: casualId, startDate: "2026-10-05" }));

    const response = await requestRoute.GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ startDate: "2026-10-05" });
  });
});

describe("balances on a credit schedule", () => {
  let clId = "";
  let elId = "";

  /** One policy's row out of a summary, by name. */
  function policyIn(
    summary: {
      balances: { name: string; credited: number; used: number; balance: number }[];
    },
    name: string,
  ): { credited: number; used: number; balance: number } {
    const row = summary.balances.find((balance) => balance.name === name);
    if (!row) throw new Error(`No policy named ${name} in the summary.`);
    return row;
  }

  beforeAll(async () => {
    const cl = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: "Scheme CL",
        allowance: 6,
        prorated: true,
        position: 10,
        effectiveFrom: new Date("2026-09-01"),
      },
    });
    clId = cl.id;

    const el = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: "Scheme EL",
        allowance: 12,
        accrual: "MONTHLY",
        carry: true,
        cap: 20,
        position: 11,
        effectiveFrom: new Date("2026-09-01"),
      },
    });
    elId = el.id;

    // The member joined two months before the scheme; the manager two years.
    await prisma.user.update({
      where: { id: memberId },
      data: { joinedOn: new Date("2026-07-02") },
    });
    await prisma.user.update({
      where: { id: managerId },
      data: { joinedOn: new Date("2024-02-03") },
    });
  });

  afterAll(async () => {
    await prisma.leaveRequest.deleteMany({
      where: { policyId: { in: [clId, elId] } },
    });
    await prisma.leavePolicy.deleteMany({ where: { id: { in: [clId, elId] } } });
    await prisma.user.update({
      where: { id: memberId },
      data: { joinedOn: null },
    });
    await prisma.user.update({
      where: { id: managerId },
      data: { joinedOn: null },
    });
  });

  it("credits CL two days and EL one on the fourth of September", async () => {
    await clearRequests();
    const summary = await service.listOwnLeaveSummary(memberActor(), "2026-09-04");

    expect(summary.asOf).toBe("2026-09-04");
    expect(summary.year).toBe(2026);
    // The whole point of the change: EL reads 1, not 12.
    expect(policyIn(summary, "Scheme CL")).toMatchObject({ credited: 2, balance: 2 });
    expect(policyIn(summary, "Scheme EL")).toMatchObject({ credited: 1, balance: 1 });
  });

  it("has credited EL four days by the end of the scheme's first year", async () => {
    const summary = await service.listOwnLeaveSummary(memberActor(), "2026-12-31");
    expect(policyIn(summary, "Scheme EL")).toMatchObject({ credited: 4, balance: 4 });
  });

  it("credits nothing before the scheme starts", async () => {
    const summary = await service.listOwnLeaveSummary(memberActor(), "2026-08-31");
    expect(policyIn(summary, "Scheme CL")).toMatchObject({ credited: 0, balance: 0 });
    expect(policyIn(summary, "Scheme EL")).toMatchObject({ credited: 0, balance: 0 });
  });

  it("gives a member employed since 2024 the same four-month year", async () => {
    // Tenure does not buy a bigger 2026: the scheme start governs.
    const summary = await service.listOwnLeaveSummary(
      { id: managerId, role: Role.MEMBER, organizationId: orgId },
      "2026-09-04",
    );
    expect(policyIn(summary, "Scheme CL")).toMatchObject({ credited: 2 });
    expect(policyIn(summary, "Scheme EL")).toMatchObject({ credited: 1 });
  });

  it("counts a filed request against the credited amount", async () => {
    await clearRequests();
    await service.createOwnLeaveRequest(memberActor(), {
      policyId: clId,
      startDate: "2026-09-07",
      endDate: "2026-09-08",
      reason: null,
    });

    const summary = await service.listOwnLeaveSummary(memberActor(), "2026-09-09");
    expect(policyIn(summary, "Scheme CL")).toMatchObject({
      credited: 2,
      used: 2,
      balance: 0,
    });
  });

  it("carries EL into the next year, net of what was spent", async () => {
    await clearRequests();
    await prisma.leaveRequest.create({
      data: {
        organizationId: orgId,
        userId: memberId,
        policyId: elId,
        startDate: new Date("2026-12-07"),
        endDate: new Date("2026-12-07"),
        cost: 1,
      },
    });

    const summary = await service.listOwnLeaveSummary(memberActor(), "2027-01-15");
    // 2026 closed at 4 credited less 1 spent; January 2027 adds one more.
    expect(policyIn(summary, "Scheme EL")).toMatchObject({
      credited: 4,
      used: 0,
      balance: 4,
    });
  });

  it("lapses CL at the year boundary", async () => {
    // The same read as above: 2026's unused CL is gone, 2027 opens at six.
    const summary = await service.listOwnLeaveSummary(memberActor(), "2027-01-15");
    expect(policyIn(summary, "Scheme CL")).toMatchObject({ credited: 6, balance: 6 });
  });

  it("defaults to today when no date is given", async () => {
    await clearRequests();
    const summary = await service.listOwnLeaveSummary(memberActor());
    expect(summary.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
