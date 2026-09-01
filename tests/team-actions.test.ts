import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { EmploymentStatus, Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

/**
 * The Server Actions behind the Team screen.
 *
 * They are plain async functions over `FormData`, so they can be called
 * directly. `redirect` and `revalidatePath` are stubbed: the first records
 * where the action sent the caller and throws the way the real one does, which
 * is how both success (`/team`) and failure (`?error=...`) are asserted.
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
const actions = await import("@/lib/team-actions");

const RUN = `actions-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

let orgA = "";
let adminA: Actor;
let otherAdmin: Actor;
let chennai = "";

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

beforeAll(async () => {
  const [a, b] = await Promise.all([
    prisma.organization.create({ data: { name: `${RUN}-a` }, select: { id: true } }),
    prisma.organization.create({ data: { name: `${RUN}-b` }, select: { id: true } }),
  ]);
  orgA = a.id;

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
  ]);
  adminA = { id: made[0].id, role: Role.ADMIN, organizationId: a.id };
  otherAdmin = { id: made[1].id, role: Role.ADMIN, organizationId: b.id };
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
  await prisma.region.deleteMany({ where: { organization: { name: { startsWith: RUN } } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: RUN } } });
  await prisma.$disconnect();
});

beforeEach(() => {
  actorRef.current = adminA;
  nav.revalidated = [];
});

describe("createRegionAction", () => {
  it("creates one and returns to the roster", async () => {
    expect(await run(actions.createRegionAction, { name: "Chennai" })).toBe("/team");
    expect(nav.revalidated).toContain("/team");

    const region = await prisma.region.findFirst({ where: { organizationId: orgA } });
    chennai = region?.id ?? "";
    expect(region?.name).toBe("Chennai");
  });

  it("reports a duplicate on the page it came from", async () => {
    const to = await run(actions.createRegionAction, { name: "Chennai" });
    expect(to).toContain("/team?region=new");
    expect(errorIn(to)).toMatch(/already exists/i);
  });
});

describe("createTeamMemberAction", () => {
  it("stores the profile the form submitted", async () => {
    const to = await run(actions.createTeamMemberAction, {
      name: "Aisha Khan",
      email: email("aisha"),
      password: "a-long-enough-password",
      title: "Art director",
      workMode: "WFH",
      regionId: chennai,
      joinedOn: "2024-02-03",
      // Rendered but left blank: clears rather than failing validation.
      empId: "",
    });
    expect(to).toBe("/team");

    const member = await prisma.user.findUnique({
      where: { email: email("aisha") },
      select: { title: true, workMode: true, regionId: true, empId: true, status: true },
    });
    expect(member).toMatchObject({
      title: "Art director",
      workMode: "WFH",
      regionId: chennai,
      empId: null,
      status: EmploymentStatus.ACTIVE,
    });
  });

  it("keeps the add form open when the password is too short", async () => {
    const to = await run(actions.createTeamMemberAction, {
      name: "Too Short",
      email: email("short"),
      password: "abc",
    });
    expect(to).toContain("/team?add=1");
    expect(errorIn(to)).toMatch(/at least 8 characters/i);
  });

  it("refuses another organization's region", async () => {
    const foreign = await prisma.region.create({
      data: { name: "Foreign", organizationId: otherAdmin.organizationId! },
      select: { id: true },
    });
    const to = await run(actions.createTeamMemberAction, {
      name: "Nope",
      email: email("nope"),
      password: "a-long-enough-password",
      regionId: foreign.id,
    });
    expect(errorIn(to)).toMatch(/does not exist in your organization/i);
  });

  it("refuses a signed-out caller", async () => {
    actorRef.current = null;
    const to = await run(actions.createTeamMemberAction, {
      name: "Anon",
      email: email("anon"),
      password: "a-long-enough-password",
    });
    expect(errorIn(to)).toMatch(/signed in/i);
  });
});

describe("updateTeamMemberAction", () => {
  it("clears a blank field and leaves unsubmitted ones alone", async () => {
    const member = await prisma.user.findUniqueOrThrow({
      where: { email: email("aisha") },
      select: { id: true },
    });

    // `title` is submitted blank (clear); `regionId` is not submitted at all.
    expect(await run(actions.updateTeamMemberAction, { id: member.id, title: "" })).toBe(
      "/team",
    );

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: member.id },
      select: { title: true, regionId: true, name: true },
    });
    expect(after.title).toBeNull();
    expect(after.regionId).toBe(chennai);
    expect(after.name).toBe("Aisha Khan");
  });

  it("returns to the edit panel on failure", async () => {
    const member = await prisma.user.findUniqueOrThrow({
      where: { email: email("aisha") },
      select: { id: true },
    });
    const to = await run(actions.updateTeamMemberAction, {
      id: member.id,
      managerId: member.id,
    });
    expect(to).toContain(`/team?edit=${member.id}`);
    expect(errorIn(to)).toMatch(/report to themselves/i);
  });
});

describe("deactivate and restore", () => {
  it("round-trips a member's status", async () => {
    const member = await prisma.user.findUniqueOrThrow({
      where: { email: email("aisha") },
      select: { id: true },
    });

    await run(actions.deactivateTeamMemberAction, { id: member.id });
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: member.id }, select: { status: true } }),
    ).resolves.toEqual({ status: EmploymentStatus.INACTIVE });

    await run(actions.restoreTeamMemberAction, { id: member.id });
    await expect(
      prisma.user.findUniqueOrThrow({ where: { id: member.id }, select: { status: true } }),
    ).resolves.toEqual({ status: EmploymentStatus.ACTIVE });
  });

  it("refuses an admin from another organization", async () => {
    const member = await prisma.user.findUniqueOrThrow({
      where: { email: email("aisha") },
      select: { id: true },
    });
    actorRef.current = otherAdmin;

    const to = await run(actions.deactivateTeamMemberAction, { id: member.id });
    expect(errorIn(to)).toMatch(/your own organization/i);
  });
});
