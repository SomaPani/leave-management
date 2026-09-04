import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

/**
 * The Server Action behind the Apply screen.
 *
 * Same approach as holiday-actions.test.ts: the action is a plain async
 * function over `FormData`, so it is called directly. `redirect` and
 * `revalidatePath` are stubbed — the first records where the action sent the
 * caller and throws the way the real one does, which is how success
 * (`?submitted=`) and failure (`?error=`) are both asserted.
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
const actions = await import("@/lib/leave-actions");

const RUN = `lvact-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

let orgId = "";
let memberId = "";
let casualId = "";
let member: Actor;

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

  const casual = await prisma.leavePolicy.create({
    data: { organizationId: orgId, name: "Casual", allowance: 6 },
  });
  casualId = casual.id;
});

afterAll(async () => {
  await prisma.leaveRequest.deleteMany({ where: { organizationId: orgId } });
  await prisma.leavePolicy.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.leaveRequest.deleteMany({ where: { organizationId: orgId } });
  actorRef.current = member;
  nav.redirectedTo = "";
  nav.revalidated = [];
});

/** Runs the action and reports where it redirected. */
async function run(fields: Record<string, string>): Promise<string> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);

  nav.redirectedTo = "";
  await expect(actions.submitLeaveRequestAction(form)).rejects.toThrow(
    "NEXT_REDIRECT",
  );
  return nav.redirectedTo;
}

/** The message an action attached to its redirect, decoded. */
function errorIn(url: string): string | null {
  const query = url.split("?")[1];
  return query ? new URLSearchParams(query).get("error") : null;
}

describe("submitting a leave request", () => {
  it("writes the row and comes back with its id", async () => {
    const url = await run({
      policyId: casualId,
      from: "",
      startDate: "2026-09-07",
      endDate: "2026-09-09",
      reason: "Family thing",
    });

    const stored = await prisma.leaveRequest.findFirst({
      where: { userId: memberId },
      select: { id: true, cost: true, status: true },
    });

    expect(stored).toMatchObject({ cost: 3, status: "PENDING" });
    expect(url).toBe(`/apply?submitted=${stored?.id}`);
    expect(nav.revalidated).toContain("/apply");
  });

  it("treats a disabled To field — which submits nothing — as a one-day request", async () => {
    await run({ policyId: casualId, startDate: "2026-09-07" });

    const stored = await prisma.leaveRequest.findFirst({
      where: { userId: memberId },
      select: { startDate: true, endDate: true },
    });
    expect(stored?.startDate).toEqual(stored?.endDate);
  });

  it("comes back to /apply with a readable message on an overlap", async () => {
    await run({ policyId: casualId, startDate: "2026-09-07", endDate: "2026-09-09" });

    const url = await run({
      policyId: casualId,
      startDate: "2026-09-08",
      endDate: "2026-09-10",
    });

    expect(url.startsWith("/apply?error=")).toBe(true);
    expect(errorIn(url)).toBe("You already have a request covering those dates.");
    expect(await prisma.leaveRequest.count({ where: { userId: memberId } })).toBe(1);
  });

  it("reports a reversed range rather than storing it", async () => {
    const url = await run({
      policyId: casualId,
      startDate: "2026-09-09",
      endDate: "2026-09-07",
    });

    expect(errorIn(url)).toBe('"endDate" must not be earlier than "startDate".');
    expect(await prisma.leaveRequest.count({ where: { userId: memberId } })).toBe(0);
  });

  it("reports a missing leave type", async () => {
    const url = await run({ startDate: "2026-09-07" });
    expect(errorIn(url)).toBe('"policyId" is required.');
  });

  it("re-authenticates rather than trusting the proxy", async () => {
    actorRef.current = null;

    const url = await run({ policyId: casualId, startDate: "2026-09-07" });

    expect(errorIn(url)).toBe("You must be signed in.");
    expect(await prisma.leaveRequest.count({ where: { userId: memberId } })).toBe(0);
  });
});
