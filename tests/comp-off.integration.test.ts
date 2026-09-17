import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CompOffClaimStatus, Role } from "@/generated/prisma/enums";
import { addDays, dayOfWeek } from "@/lib/date";
import type { Actor } from "@/lib/rbac";

/**
 * Comp-off claims against the Dockerized Postgres.
 *
 * Same approach as leave.integration.test.ts: the session is stubbed and
 * everything below it — the real service, the real policy layer, real Prisma
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
const compOff = await import("@/lib/comp-off-service");
const leave = await import("@/lib/leave-service");
const { todayIso } = await import("@/lib/attendance");

const RUN = `co-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

/**
 * Dates are derived from today rather than written down.
 *
 * A fixed "2026-09-13 is in the future" stops being true the moment the
 * calendar passes it, and this suite asserts on exactly that distinction.
 */
const TODAY = todayIso();
const THIS_YEAR = Number(TODAY.slice(0, 4));

function walk(from: string, step: number, wanted: (iso: string) => boolean): string {
  let date = from;
  for (let i = 0; i < 400; i++) {
    if (wanted(date)) return date;
    date = addDays(date, step);
  }
  throw new Error(`no date found walking ${step > 0 ? "forward" : "back"} from ${from}`);
}

const isSunday = (iso: string) => dayOfWeek(iso) === 0;
const isWeekday = (iso: string) => dayOfWeek(iso) > 0 && dayOfWeek(iso) < 6;

/** Ten past Sundays, most recent first. Each test claims its own. */
const SUNDAYS: string[] = [];
{
  let cursor = addDays(TODAY, -1);
  while (SUNDAYS.length < 20) {
    cursor = walk(cursor, -1, isSunday);
    SUNDAYS.push(cursor);
    cursor = addDays(cursor, -1);
  }
}
const [
  SUNDAY,
  OTHER_SUNDAY,
  THIRD_SUNDAY,
  FOURTH_SUNDAY,
  DECIDE_SUNDAY,
  REJECT_SUNDAY,
  TWICE_SUNDAY,
  ADMIN_SUNDAY,
  MEMBER_DECIDE_SUNDAY,
  CYCLE_SUNDAY,
  GRANT_SUNDAY,
  GRANT_BALANCE_SUNDAY,
  GRANT_DUP_SUNDAY,
  GRANT_SELF_SUNDAY,
  GRANT_MEMBER_SUNDAY,
  GRANT_FOREIGN_SUNDAY,
  REVOKE_SUNDAY,
  REVOKE_TWICE_SUNDAY,
  REVOKE_CLAIM_SUNDAY,
  GRANT_LIST_SUNDAY,
] = SUNDAYS;

/** A past weekday that is not a holiday: an ordinary working day. */
const WORKING_DAY = walk(addDays(TODAY, -1), -1, isWeekday);
/** A weekday far enough back not to collide with WORKING_DAY, made a holiday. */
const REGION_HOLIDAY = walk(addDays(WORKING_DAY, -7), -1, isWeekday);
/** The next Sunday that has not happened yet. */
const FUTURE_SUNDAY = walk(addDays(TODAY, 1), 1, isSunday);

let orgId: string;
let otherOrgId: string;
let chennaiId: string;
let adminId: string;
let secondAdminId: string;
let memberId: string;
let balanceMemberId: string;
let otherOrgMemberId: string;
let granteeId: string;

const adminActor = (): Actor => ({ id: adminId, role: Role.ADMIN, organizationId: orgId });
const secondAdminActor = (): Actor => ({
  id: secondAdminId,
  role: Role.ADMIN,
  organizationId: orgId,
});
const memberActor = (): Actor => ({ id: memberId, role: Role.MEMBER, organizationId: orgId });
const balanceMemberActor = (): Actor => ({
  id: balanceMemberId,
  role: Role.MEMBER,
  organizationId: orgId,
});
const otherOrgMemberActor = (): Actor => ({
  id: otherOrgMemberId,
  role: Role.MEMBER,
  organizationId: otherOrgId,
});
const granteeActor = (): Actor => ({ id: granteeId, role: Role.MEMBER, organizationId: orgId });
const superadminActor = (): Actor => ({ id: "su", role: Role.SUPERADMIN, organizationId: null });

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `${RUN} Org` } });
  orgId = org.id;

  const other = await prisma.organization.create({ data: { name: `${RUN} Other` } });
  otherOrgId = other.id;

  const chennai = await prisma.region.create({
    data: { name: "Chennai", organizationId: orgId },
  });
  chennaiId = chennai.id;

  const admin = await prisma.user.create({
    data: {
      name: "Run Admin",
      email: email("admin"),
      passwordHash: "x",
      role: Role.ADMIN,
      organizationId: orgId,
      regionId: chennaiId,
    },
  });
  adminId = admin.id;

  const secondAdmin = await prisma.user.create({
    data: {
      name: "Run Second Admin",
      email: email("admin2"),
      passwordHash: "x",
      role: Role.ADMIN,
      organizationId: orgId,
    },
  });
  secondAdminId = secondAdmin.id;

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

  // A member of their own, so the balance assertions start from nothing: the
  // member above carries claims from every test before them.
  const balanceMember = await prisma.user.create({
    data: {
      name: "Run Balance Member",
      email: email("balance"),
      passwordHash: "x",
      role: Role.MEMBER,
      organizationId: orgId,
      regionId: chennaiId,
    },
  });
  balanceMemberId = balanceMember.id;

  // The grant tests' own member, so their balance starts from nothing.
  const grantee = await prisma.user.create({
    data: {
      name: "Run Grantee",
      email: email("grantee"),
      passwordHash: "x",
      role: Role.MEMBER,
      organizationId: orgId,
      regionId: chennaiId,
    },
  });
  granteeId = grantee.id;

  const otherOrgMember = await prisma.user.create({
    data: {
      name: "Run Foreign Member",
      email: email("foreign"),
      passwordHash: "x",
      role: Role.MEMBER,
      organizationId: otherOrgId,
    },
  });
  otherOrgMemberId = otherOrgMember.id;

  await prisma.holiday.create({
    data: {
      organizationId: orgId,
      regionId: chennaiId,
      name: "Run Holiday",
      startDate: new Date(`${REGION_HOLIDAY}T00:00:00.000Z`),
      endDate: new Date(`${REGION_HOLIDAY}T00:00:00.000Z`),
    },
  });
});

afterAll(async () => {
  await prisma.compOffClaim.deleteMany({ where: { organizationId: orgId } });
  await prisma.compOffClaim.deleteMany({ where: { organizationId: otherOrgId } });
  await prisma.leaveRequest.deleteMany({ where: { organizationId: orgId } });
  await prisma.leavePolicy.deleteMany({ where: { organizationId: orgId } });
  await prisma.holiday.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: otherOrgId } });
  await prisma.region.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.organization.delete({ where: { id: otherOrgId } });
});

describe("createOwnCompOffClaim", () => {
  it("accepts a worked Sunday", async () => {
    const claim = await compOff.createOwnCompOffClaim(memberActor(), {
      workedOn: SUNDAY,
      reason: "Release cutover",
    });
    expect(claim.status).toBe("PENDING");
    expect(claim.workedOn).toBe(SUNDAY);
    expect(claim.reason).toBe("Release cutover");
  });

  it("accepts a regional holiday that falls on a weekday", async () => {
    const claim = await compOff.createOwnCompOffClaim(memberActor(), {
      workedOn: REGION_HOLIDAY,
      reason: null,
    });
    expect(claim.status).toBe("PENDING");
  });

  it("refuses an ordinary working day with 400", async () => {
    await expect(
      compOff.createOwnCompOffClaim(memberActor(), { workedOn: WORKING_DAY, reason: null }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a future day with 400", async () => {
    await expect(
      compOff.createOwnCompOffClaim(memberActor(), { workedOn: FUTURE_SUNDAY, reason: null }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a second claim for a day already pending, with 409", async () => {
    await compOff.createOwnCompOffClaim(memberActor(), {
      workedOn: OTHER_SUNDAY,
      reason: null,
    });
    await expect(
      compOff.createOwnCompOffClaim(memberActor(), { workedOn: OTHER_SUNDAY, reason: null }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("copies the organization from the stored user, not from anything sent", async () => {
    const claim = await compOff.createOwnCompOffClaim(memberActor(), {
      workedOn: THIRD_SUNDAY,
      reason: null,
    });
    const row = await prisma.compOffClaim.findUnique({
      where: { id: claim.id },
      select: { organizationId: true, userId: true },
    });
    expect(row).toEqual({ organizationId: orgId, userId: memberId });
  });

  it("routes to an admin when the claimant has no manager", async () => {
    const claim = await compOff.createOwnCompOffClaim(memberActor(), {
      workedOn: FOURTH_SUNDAY,
      reason: null,
    });
    expect(claim.approver?.id).toBe(adminId);
  });

  it("refuses a SUPERADMIN with 403", async () => {
    await expect(
      compOff.createOwnCompOffClaim(superadminActor(), { workedOn: SUNDAY, reason: null }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("listOwnCompOffClaims", () => {
  it("returns the caller's own claims and nobody else's", async () => {
    await compOff.createOwnCompOffClaim(otherOrgMemberActor(), {
      workedOn: SUNDAY,
      reason: null,
    });

    const mine = await compOff.listOwnCompOffClaims(memberActor());
    expect(mine.length).toBeGreaterThan(0);

    const notMine = await prisma.compOffClaim.count({
      where: { id: { in: mine.map((c) => c.id) }, userId: { not: memberId } },
    });
    expect(notMine).toBe(0);
  });

  it("refuses a SUPERADMIN, who claims nothing and so reads nothing", async () => {
    await expect(compOff.listOwnCompOffClaims(superadminActor())).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("withdrawOwnCompOffClaim", () => {
  it("withdraws a pending claim and frees the day", async () => {
    const claim = await compOff.createOwnCompOffClaim(balanceMemberActor(), {
      workedOn: FOURTH_SUNDAY,
      reason: null,
    });

    const withdrawn = await compOff.withdrawOwnCompOffClaim(balanceMemberActor(), claim.id);
    expect(withdrawn.status).toBe("WITHDRAWN");

    // The same day can now be claimed again — the reason the duplicate check
    // covers PENDING and APPROVED rather than every row.
    await expect(
      compOff.createOwnCompOffClaim(balanceMemberActor(), {
        workedOn: FOURTH_SUNDAY,
        reason: null,
      }),
    ).resolves.toMatchObject({ status: "PENDING" });

    // Leave the day free for the balance suite below.
    const refiled = await compOff.listOwnCompOffClaims(balanceMemberActor());
    const pending = refiled.find(
      (c) => c.workedOn === FOURTH_SUNDAY && c.status === "PENDING",
    );
    await compOff.withdrawOwnCompOffClaim(balanceMemberActor(), pending!.id);
  });

  it("answers 404 for somebody else's claim", async () => {
    const theirs = await compOff.createOwnCompOffClaim(otherOrgMemberActor(), {
      workedOn: OTHER_SUNDAY,
      reason: null,
    });
    await expect(
      compOff.withdrawOwnCompOffClaim(memberActor(), theirs.id),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("earnedByYearFor", () => {
  it("counts nothing for a member with no approved claims", async () => {
    const earned = await compOff.earnedByYearFor(memberId);
    expect(earned.size).toBe(0);
  });
});

describe("decideCompOffClaim", () => {
  it("approves a pending claim and records who decided it", async () => {
    const claim = await compOff.createOwnCompOffClaim(memberActor(), {
      workedOn: DECIDE_SUNDAY,
      reason: null,
    });

    const decided = await compOff.decideCompOffClaim(adminActor(), claim.id, {
      decision: "APPROVED",
      note: null,
    });
    expect(decided.status).toBe("APPROVED");
    expect(decided.decidedAt).not.toBeNull();
    expect(decided.user.id).toBe(memberId);

    const row = await prisma.compOffClaim.findUnique({
      where: { id: claim.id },
      select: { decidedById: true },
    });
    expect(row?.decidedById).toBe(adminId);
  });

  it("refuses a rejection with no reason, with 400", async () => {
    const claim = await compOff.createOwnCompOffClaim(memberActor(), {
      workedOn: REJECT_SUNDAY,
      reason: null,
    });
    await expect(
      compOff.decideCompOffClaim(adminActor(), claim.id, { decision: "REJECTED", note: null }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects with a reason, and the day can then be claimed again", async () => {
    const claims = await compOff.listOwnCompOffClaims(memberActor());
    const pending = claims.find((c) => c.workedOn === REJECT_SUNDAY && c.status === "PENDING");

    const rejected = await compOff.decideCompOffClaim(adminActor(), pending!.id, {
      decision: "REJECTED",
      note: "Not a rostered day",
    });
    expect(rejected.status).toBe("REJECTED");

    await expect(
      compOff.createOwnCompOffClaim(memberActor(), { workedOn: REJECT_SUNDAY, reason: "Rostered" }),
    ).resolves.toMatchObject({ status: "PENDING" });
  });

  it("refuses to decide the same claim twice, with 409", async () => {
    const claim = await compOff.createOwnCompOffClaim(memberActor(), {
      workedOn: TWICE_SUNDAY,
      reason: null,
    });
    await compOff.decideCompOffClaim(adminActor(), claim.id, {
      decision: "APPROVED",
      note: null,
    });
    await expect(
      compOff.decideCompOffClaim(adminActor(), claim.id, { decision: "APPROVED", note: null }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses the claimant deciding their own claim, with 403", async () => {
    const own = await compOff.createOwnCompOffClaim(adminActor(), {
      workedOn: ADMIN_SUNDAY,
      reason: null,
    });
    await expect(
      compOff.decideCompOffClaim(adminActor(), own.id, { decision: "APPROVED", note: null }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lets a second admin decide the first admin's claim", async () => {
    const own = await prisma.compOffClaim.findFirst({
      where: { userId: adminId, status: CompOffClaimStatus.PENDING },
      select: { id: true },
    });
    const decided = await compOff.decideCompOffClaim(secondAdminActor(), own!.id, {
      decision: "APPROVED",
      note: null,
    });
    expect(decided.status).toBe("APPROVED");
  });

  it("answers 404 for a claim in another organization", async () => {
    const theirs = await compOff.createOwnCompOffClaim(otherOrgMemberActor(), {
      workedOn: THIRD_SUNDAY,
      reason: null,
    });
    await expect(
      compOff.decideCompOffClaim(adminActor(), theirs.id, { decision: "APPROVED", note: null }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a member with 403", async () => {
    const claim = await compOff.createOwnCompOffClaim(memberActor(), {
      workedOn: MEMBER_DECIDE_SUNDAY,
      reason: null,
    });
    await expect(
      compOff.decideCompOffClaim(memberActor(), claim.id, { decision: "APPROVED", note: null }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("listCompOffClaims", () => {
  it("returns only the caller's organization", async () => {
    const rows = await compOff.listCompOffClaims(adminActor());
    expect(rows.length).toBeGreaterThan(0);

    const foreign = await prisma.compOffClaim.count({
      where: { id: { in: rows.map((r) => r.id) }, organizationId: { not: orgId } },
    });
    expect(foreign).toBe(0);
  });

  it("carries the claimant, so the queue can name who filed", async () => {
    const rows = await compOff.listCompOffClaims(adminActor());
    expect(rows[0]?.user.name).toBeTruthy();
  });

  it("filters by status", async () => {
    const rows = await compOff.listCompOffClaims(adminActor(), {
      status: CompOffClaimStatus.APPROVED,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === "APPROVED")).toBe(true);
  });

  it("refuses a MEMBER with 403", async () => {
    await expect(compOff.listCompOffClaims(memberActor())).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("countPendingCompOffClaims", () => {
  it("counts this organization's pending claims", async () => {
    const counted = await compOff.countPendingCompOffClaims(adminActor());
    const expected = await prisma.compOffClaim.count({
      where: { organizationId: orgId, status: CompOffClaimStatus.PENDING },
    });
    expect(counted).toBe(expected);
  });

  it("does not count another organization's", async () => {
    const counted = await compOff.countPendingCompOffClaims(adminActor());
    const everywhere = await prisma.compOffClaim.count({
      where: { status: CompOffClaimStatus.PENDING },
    });
    expect(counted).toBeLessThanOrEqual(everywhere);
  });
});

describe("comp-off credit on the balance", () => {
  let compOffPolicyId: string;

  beforeAll(async () => {
    const policy = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: `${RUN} Comp-off`,
        allowance: 0,
        unit: "DAYS",
        accrual: "EARNED",
        carry: false,
        effectiveFrom: new Date(`${THIS_YEAR}-01-01T00:00:00.000Z`),
        position: 9,
      },
      select: { id: true },
    });
    compOffPolicyId = policy.id;
  });

  const compOffBalance = async (asOf: string) => {
    const summary = await leave.summaryFor(orgId, balanceMemberId, asOf);
    return summary.balances.find((b) => b.id === compOffPolicyId);
  };

  it("shows nothing before a claim is approved", async () => {
    expect(await compOffBalance(TODAY)).toMatchObject({
      credited: 0,
      used: 0,
      balance: 0,
    });
  });

  it("credits one day per approved claim", async () => {
    const claim = await compOff.createOwnCompOffClaim(balanceMemberActor(), {
      workedOn: SUNDAY,
      reason: null,
    });
    await compOff.decideCompOffClaim(adminActor(), claim.id, {
      decision: "APPROVED",
      note: null,
    });

    expect(await compOffBalance(TODAY)).toMatchObject({ credited: 1, balance: 1 });
  });

  it("does not credit a pending claim", async () => {
    await compOff.createOwnCompOffClaim(balanceMemberActor(), {
      workedOn: OTHER_SUNDAY,
      reason: null,
    });

    expect(await compOffBalance(TODAY)).toMatchObject({ credited: 1 });
  });

  it("does not credit a rejected claim", async () => {
    const claim = await compOff.createOwnCompOffClaim(balanceMemberActor(), {
      workedOn: THIRD_SUNDAY,
      reason: null,
    });
    await compOff.decideCompOffClaim(adminActor(), claim.id, {
      decision: "REJECTED",
      note: "Not rostered",
    });

    expect(await compOffBalance(TODAY)).toMatchObject({ credited: 1 });
  });

  it("spends the credit when a comp-off day is taken", async () => {
    await prisma.leaveRequest.create({
      data: {
        organizationId: orgId,
        userId: balanceMemberId,
        policyId: compOffPolicyId,
        startDate: new Date(`${TODAY}T00:00:00.000Z`),
        endDate: new Date(`${TODAY}T00:00:00.000Z`),
        cost: 1,
        status: "APPROVED",
      },
    });

    expect(await compOffBalance(TODAY)).toMatchObject({
      credited: 1,
      used: 1,
      balance: 0,
    });
  });

  it("does not carry a credit earned last year into this one", async () => {
    await prisma.compOffClaim.create({
      data: {
        organizationId: orgId,
        userId: balanceMemberId,
        workedOn: new Date(`${THIS_YEAR - 1}-12-27T00:00:00.000Z`),
        status: "APPROVED",
      },
    });

    // Still one: last year's credit lapsed on 31 December.
    expect(await compOffBalance(TODAY)).toMatchObject({ credited: 1 });
  });

  it("leaves every scheduled policy's balance untouched", async () => {
    const casual = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: `${RUN} Casual`,
        allowance: 6,
        effectiveFrom: new Date(`${THIS_YEAR}-01-01T00:00:00.000Z`),
        position: 0,
      },
      select: { id: true },
    });

    const summary = await leave.summaryFor(orgId, balanceMemberId, TODAY);
    expect(summary.balances.find((b) => b.id === casual.id)).toMatchObject({
      credited: 6,
      used: 0,
      balance: 6,
    });
  });
});

describe("filing leave with comp-off loaded first", () => {
  /**
   * The regression test for the import cycle.
   *
   * This file imports lib/comp-off-service.ts before lib/leave-service.ts,
   * which is the order that used to leave `approverFor` undefined: the two
   * services imported each other, so whichever the bundler entered second was
   * still half-initialised. `tsc`, `vitest` and `next build` all resolved it
   * happily and a page render worked; the Server Action entered the other way
   * and threw, reaching the browser as "An unexpected response was received
   * from the server".
   *
   * tests/module-graph.test.ts guards the structure. This one guards the
   * behaviour it was protecting: `approverFor` is reachable, and routes a
   * leave request to the same admin a comp-off claim goes to.
   */
  it("routes a leave request to an approver, the same one a claim gets", async () => {
    const policy = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: `${RUN} Cycle CL`,
        allowance: 6,
        effectiveFrom: new Date(`${THIS_YEAR}-01-01T00:00:00.000Z`),
        position: 0,
      },
      select: { id: true },
    });

    const request = await leave.createOwnLeaveRequest(memberActor(), {
      policyId: policy.id,
      startDate: `${THIS_YEAR}-11-09`,
      endDate: `${THIS_YEAR}-11-09`,
      reason: null,
    });
    expect(request.approver?.id).toBe(adminId);

    const claim = await compOff.createOwnCompOffClaim(memberActor(), {
      workedOn: CYCLE_SUNDAY,
      reason: null,
    });
    expect(claim.approver?.id).toBe(request.approver?.id);
  });
});

describe("listCompOffGrantees", () => {
  it("lists colleagues in the admin's own organization", async () => {
    const names = (await compOff.listCompOffGrantees(adminActor())).map((u) => u.id);

    expect(names).toContain(memberId);
    expect(names).toContain(granteeId);
  });

  it("excludes the acting admin - nobody grants to themselves", async () => {
    const ids = (await compOff.listCompOffGrantees(adminActor())).map((u) => u.id);

    expect(ids).not.toContain(adminId);
  });

  it("includes other admins - an admin works weekends too", async () => {
    const ids = (await compOff.listCompOffGrantees(adminActor())).map((u) => u.id);

    expect(ids).toContain(secondAdminId);
  });

  it("excludes another organization's people", async () => {
    const ids = (await compOff.listCompOffGrantees(adminActor())).map((u) => u.id);

    expect(ids).not.toContain(otherOrgMemberId);
  });

  it("refuses a member with 403", async () => {
    await expect(compOff.listCompOffGrantees(memberActor())).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("grantCompOff", () => {
  it("credits a day the member never claimed", async () => {
    const grant = await compOff.grantCompOff(adminActor(), {
      userId: granteeId,
      workedOn: GRANT_SUNDAY,
      reason: "Covered the release cutover",
    });

    expect(grant).toMatchObject({
      status: CompOffClaimStatus.APPROVED,
      workedOn: GRANT_SUNDAY,
      reason: "Covered the release cutover",
    });
  });

  it("records the granting admin and marks the row a grant", async () => {
    const grant = await compOff.grantCompOff(adminActor(), {
      userId: granteeId,
      workedOn: GRANT_BALANCE_SUNDAY,
      reason: null,
    });

    const row = await prisma.compOffClaim.findUnique({
      where: { id: grant.id },
      select: { source: true, decidedById: true, decidedAt: true, userId: true },
    });

    expect(row).toMatchObject({
      source: "ADMIN_GRANT",
      decidedById: adminId,
      userId: granteeId,
    });
    expect(row?.decidedAt).not.toBeNull();
  });

  it("moves the grantee's earned credit without any approval step", async () => {
    const earned = await compOff.earnedByYearFor(granteeId);

    expect(earned.get(THIS_YEAR)).toBe(2);
  });

  it("accepts a holiday in the grantee's region that falls on a weekday", async () => {
    const grant = await compOff.grantCompOff(adminActor(), {
      userId: granteeId,
      workedOn: REGION_HOLIDAY,
      reason: null,
    });

    expect(grant.workedOn).toBe(REGION_HOLIDAY);
  });

  it("refuses an ordinary working day with 400", async () => {
    await expect(
      compOff.grantCompOff(adminActor(), {
        userId: granteeId,
        workedOn: WORKING_DAY,
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a future day with 400", async () => {
    await expect(
      compOff.grantCompOff(adminActor(), {
        userId: granteeId,
        workedOn: FUTURE_SUNDAY,
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a day the member already holds a claim for, with 409", async () => {
    await compOff.createOwnCompOffClaim(granteeActor(), {
      workedOn: GRANT_DUP_SUNDAY,
      reason: null,
    });

    await expect(
      compOff.grantCompOff(adminActor(), {
        userId: granteeId,
        workedOn: GRANT_DUP_SUNDAY,
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses an admin granting to themselves with 403", async () => {
    await expect(
      compOff.grantCompOff(adminActor(), {
        userId: adminId,
        workedOn: GRANT_SELF_SUNDAY,
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses a member with 403", async () => {
    await expect(
      compOff.grantCompOff(memberActor(), {
        userId: granteeId,
        workedOn: GRANT_MEMBER_SUNDAY,
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("answers 404 for a grantee in another organization", async () => {
    await expect(
      compOff.grantCompOff(adminActor(), {
        userId: otherOrgMemberId,
        workedOn: GRANT_FOREIGN_SUNDAY,
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("revokeCompOffGrant", () => {
  it("takes back a grant, and the credit goes with it", async () => {
    const grant = await compOff.grantCompOff(adminActor(), {
      userId: granteeId,
      workedOn: REVOKE_SUNDAY,
      reason: null,
    });
    const before = (await compOff.earnedByYearFor(granteeId)).get(THIS_YEAR) ?? 0;

    await compOff.revokeCompOffGrant(adminActor(), grant.id);

    const after = (await compOff.earnedByYearFor(granteeId)).get(THIS_YEAR) ?? 0;
    expect(after).toBe(before - 1);
  });

  it("refuses to revoke twice, with 409", async () => {
    const grant = await compOff.grantCompOff(adminActor(), {
      userId: granteeId,
      workedOn: REVOKE_TWICE_SUNDAY,
      reason: null,
    });
    await compOff.revokeCompOffGrant(adminActor(), grant.id);

    await expect(
      compOff.revokeCompOffGrant(adminActor(), grant.id),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("will not touch a claim the member filed themselves, answering 404", async () => {
    const claim = await compOff.createOwnCompOffClaim(granteeActor(), {
      workedOn: REVOKE_CLAIM_SUNDAY,
      reason: null,
    });
    await compOff.decideCompOffClaim(adminActor(), claim.id, {
      decision: "APPROVED",
      note: null,
    });

    await expect(
      compOff.revokeCompOffGrant(adminActor(), claim.id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a member with 403", async () => {
    const grant = await compOff.grantCompOff(adminActor(), {
      userId: granteeId,
      workedOn: GRANT_LIST_SUNDAY,
      reason: null,
    });

    await expect(
      compOff.revokeCompOffGrant(memberActor(), grant.id),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("listCompOffGrants", () => {
  it("lists grants and not claims the members filed", async () => {
    const grants = await compOff.listCompOffGrants(adminActor());

    expect(grants.length).toBeGreaterThan(0);
    for (const grant of grants) {
      expect(grant.source).toBe("ADMIN_GRANT");
    }
  });

  it("carries the grantee, so the list can name who was credited", async () => {
    const grants = await compOff.listCompOffGrants(adminActor());

    expect(grants[0].user).toMatchObject({ id: expect.any(String), name: expect.any(String) });
  });

  it("refuses a member with 403", async () => {
    await expect(compOff.listCompOffGrants(memberActor())).rejects.toMatchObject({
      status: 403,
    });
  });
});
