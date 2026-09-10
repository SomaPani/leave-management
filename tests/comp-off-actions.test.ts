import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/generated/prisma/enums";
import { addDays, dayOfWeek } from "@/lib/date";
import type { Actor } from "@/lib/rbac";

/**
 * The Server Actions behind the comp-off card on /apply and the comp-off
 * section on /approvals.
 *
 * Same approach as leave-actions.test.ts: the actions are plain async
 * functions over `FormData`, so they are called directly. `redirect` and
 * `revalidatePath` are stubbed — the first records where the action sent the
 * caller and throws the way the real one does, which is how success
 * (`/requests?c=`) and failure (`?error=`) are both asserted.
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
const actions = await import("@/lib/comp-off-actions");
const compOff = await import("@/lib/comp-off-service");
const { todayIso } = await import("@/lib/attendance");

const RUN = `coact-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

const TODAY = todayIso();

/** The most recent Sunday, and the Monday before it. Derived, never fixed. */
function walkBack(from: string, wanted: (iso: string) => boolean): string {
  let date = from;
  for (let i = 0; i < 400; i++) {
    if (wanted(date)) return date;
    date = addDays(date, -1);
  }
  throw new Error(`no date found walking back from ${from}`);
}

const SUNDAY = walkBack(addDays(TODAY, -1), (iso) => dayOfWeek(iso) === 0);
const SECOND_SUNDAY = walkBack(addDays(SUNDAY, -1), (iso) => dayOfWeek(iso) === 0);
const WORKING_DAY = walkBack(addDays(TODAY, -1), (iso) => {
  const d = dayOfWeek(iso);
  return d > 0 && d < 6;
});

let orgId = "";
let adminId = "";
let memberId = "";
let member: Actor;

const adminActor = (): Actor => ({ id: adminId, role: Role.ADMIN, organizationId: orgId });

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `${RUN} Org` } });
  orgId = org.id;

  const admin = await prisma.user.create({
    data: {
      name: "Act Admin",
      email: email("admin"),
      passwordHash: "x",
      role: Role.ADMIN,
      organizationId: orgId,
    },
  });
  adminId = admin.id;

  const person = await prisma.user.create({
    data: {
      name: "Act Member",
      email: email("member"),
      passwordHash: "x",
      role: Role.MEMBER,
      organizationId: orgId,
      managerId: admin.id,
    },
  });
  memberId = person.id;
  member = { id: memberId, role: Role.MEMBER, organizationId: orgId };
});

afterAll(async () => {
  await prisma.compOffClaim.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.compOffClaim.deleteMany({ where: { organizationId: orgId } });
  actorRef.current = member;
  nav.redirectedTo = "";
  nav.revalidated = [];
});

describe("submitCompOffClaimAction", () => {
  it("files the claim and sends the member to /requests", async () => {
    const form = new FormData();
    form.set("workedOn", SUNDAY);
    form.set("reason", "Release cutover");

    await expect(actions.submitCompOffClaimAction(form)).rejects.toThrow("NEXT_REDIRECT");

    const stored = await prisma.compOffClaim.findFirst({
      where: { userId: memberId },
      select: { id: true, reason: true },
    });
    expect(stored?.reason).toBe("Release cutover");
    expect(nav.redirectedTo).toBe(`/requests?c=${stored?.id}`);
    expect(nav.revalidated).toContain("/requests");
  });

  it("sends a working-day refusal back to /apply with the message", async () => {
    const form = new FormData();
    form.set("workedOn", WORKING_DAY);

    await expect(actions.submitCompOffClaimAction(form)).rejects.toThrow("NEXT_REDIRECT");

    expect(nav.redirectedTo).toContain("/apply?error=");
    expect(decodeURIComponent(nav.redirectedTo)).toContain("was a working day");
  });

  it("sends a malformed date back to /apply rather than throwing", async () => {
    const form = new FormData();
    form.set("workedOn", "not-a-date");

    await expect(actions.submitCompOffClaimAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirectedTo).toContain("/apply?error=");
  });

  it("refuses when there is no session at all", async () => {
    actorRef.current = null;
    const form = new FormData();
    form.set("workedOn", SUNDAY);

    await expect(actions.submitCompOffClaimAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirectedTo).toContain("/apply?error=");
  });
});

describe("withdrawCompOffClaimAction", () => {
  it("withdraws the member's own pending claim", async () => {
    const claim = await compOff.createOwnCompOffClaim(member, {
      workedOn: SUNDAY,
      reason: null,
    });

    const form = new FormData();
    form.set("claimId", claim.id);

    await expect(actions.withdrawCompOffClaimAction(form)).rejects.toThrow("NEXT_REDIRECT");

    const row = await prisma.compOffClaim.findUnique({
      where: { id: claim.id },
      select: { status: true },
    });
    expect(row?.status).toBe("WITHDRAWN");
    expect(nav.redirectedTo).toBe(`/requests?c=${claim.id}`);
  });

  it("sends an unknown claim back to /requests with the message", async () => {
    const form = new FormData();
    form.set("claimId", "does-not-exist");

    await expect(actions.withdrawCompOffClaimAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirectedTo).toContain("/requests?error=");
  });
});

describe("reviewCompOffClaimAction", () => {
  it("approves and lands back on the same filter and claim", async () => {
    const claim = await compOff.createOwnCompOffClaim(member, {
      workedOn: SUNDAY,
      reason: null,
    });
    actorRef.current = adminActor();

    const form = new FormData();
    form.set("claimId", claim.id);
    form.set("filter", "pending");
    form.set("intent", "approve");

    await expect(actions.reviewCompOffClaimAction(form)).rejects.toThrow("NEXT_REDIRECT");

    const row = await prisma.compOffClaim.findUnique({
      where: { id: claim.id },
      select: { status: true, decidedById: true },
    });
    expect(row?.status).toBe("APPROVED");
    expect(row?.decidedById).toBe(adminId);
    expect(nav.redirectedTo).toBe(`/approvals?filter=pending&c=${claim.id}`);
    expect(nav.revalidated).toContain("/approvals");
  });

  it("keeps the admin's filter when it is not the default", async () => {
    const claim = await compOff.createOwnCompOffClaim(member, {
      workedOn: SECOND_SUNDAY,
      reason: null,
    });
    actorRef.current = adminActor();

    const form = new FormData();
    form.set("claimId", claim.id);
    form.set("filter", "all");
    form.set("intent", "reject");
    form.set("note", "Not a rostered day");

    await expect(actions.reviewCompOffClaimAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirectedTo).toBe(`/approvals?filter=all&c=${claim.id}`);
  });

  it("sends a reasonless rejection back to the claim being reviewed", async () => {
    const claim = await compOff.createOwnCompOffClaim(member, {
      workedOn: SUNDAY,
      reason: null,
    });
    actorRef.current = adminActor();

    const form = new FormData();
    form.set("claimId", claim.id);
    form.set("filter", "pending");
    form.set("intent", "reject");

    await expect(actions.reviewCompOffClaimAction(form)).rejects.toThrow("NEXT_REDIRECT");

    expect(nav.redirectedTo).toContain(`&c=${claim.id}`);
    expect(decodeURIComponent(nav.redirectedTo)).toContain("A rejection needs a reason.");

    const row = await prisma.compOffClaim.findUnique({
      where: { id: claim.id },
      select: { status: true },
    });
    expect(row?.status).toBe("PENDING");
  });

  it("refuses a member deciding, and says so on the page", async () => {
    const claim = await compOff.createOwnCompOffClaim(member, {
      workedOn: SUNDAY,
      reason: null,
    });

    const form = new FormData();
    form.set("claimId", claim.id);
    form.set("filter", "pending");
    form.set("intent", "approve");

    await expect(actions.reviewCompOffClaimAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(nav.redirectedTo).toContain("error=");

    const row = await prisma.compOffClaim.findUnique({
      where: { id: claim.id },
      select: { status: true },
    });
    expect(row?.status).toBe("PENDING");
  });
});
