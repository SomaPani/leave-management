import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

/**
 * The Server Action behind "Edit contact details" on /profile.
 *
 * A member edits four fields of their own row — other email, contact number,
 * emergency contact name and number — and nothing else. Same harness as
 * team-actions.test.ts: `redirect` is stubbed to record where the action sent
 * the caller, so success (`/profile`) and failure (`?error=`) are both asserted
 * against the real service and the real Postgres row.
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
const { updateOwnContactAction } = await import("@/lib/profile-actions");

const RUN = `own-contact-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

let orgId = "";
let me: Actor;
let colleague: Actor;

async function run(fields: Record<string, string>): Promise<string> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);

  nav.redirectedTo = "";
  await expect(updateOwnContactAction(form)).rejects.toThrow("NEXT_REDIRECT");
  return nav.redirectedTo;
}

function errorIn(url: string): string | null {
  const query = url.split("?")[1];
  return query ? new URLSearchParams(query).get("error") : null;
}

const row = (id: string) =>
  prisma.user.findUniqueOrThrow({
    where: { id },
    select: {
      name: true,
      email: true,
      title: true,
      empId: true,
      address: true,
      permanentAddress: true,
      phone: true,
      workMode: true,
      personalEmail: true,
      emergencyName: true,
      emergencyPhone: true,
    },
  });

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `${RUN} Org` } });
  orgId = org.id;

  const [a, b] = await Promise.all(
    ["me", "colleague"].map((local) =>
      prisma.user.create({
        data: {
          name: local,
          email: email(local),
          passwordHash: "x",
          role: Role.MEMBER,
          organizationId: org.id,
          title: "Developer",
          empId: `${RUN}-${local}`,
          address: "1 Test Road",
        },
      }),
    ),
  );
  me = { id: a!.id, role: Role.MEMBER, organizationId: org.id };
  colleague = { id: b!.id, role: Role.MEMBER, organizationId: org.id };
});

beforeEach(() => {
  actorRef.current = me;
  nav.revalidated = [];
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe("updateOwnContactAction", () => {
  it("saves the contact fields and both addresses on the signed-in member's own row", async () => {
    const url = await run({
      personalEmail: "Me@Personal.Test",
      phone: "+91 90000 00001",
      emergencyName: "Parent",
      emergencyPhone: "+91 90000 00002",
      address: "12 Current Lane, Delhi",
      permanentAddress: "9 Home Street, Shimla",
    });

    expect(url).toBe("/profile");
    expect(nav.revalidated).toContain("/profile");
    expect(await row(me.id)).toMatchObject({
      personalEmail: "me@personal.test",
      phone: "+91 90000 00001",
      emergencyName: "Parent",
      emergencyPhone: "+91 90000 00002",
      address: "12 Current Lane, Delhi",
      permanentAddress: "9 Home Street, Shimla",
    });
  });

  it("clears a field submitted blank", async () => {
    await run({
      personalEmail: "",
      phone: "",
      emergencyName: "Parent",
      emergencyPhone: "",
      permanentAddress: "",
    });

    expect(await row(me.id)).toMatchObject({
      personalEmail: null,
      phone: null,
      emergencyName: "Parent",
      emergencyPhone: null,
      permanentAddress: null,
    });
  });

  it("refuses an other email that is not an address, and changes nothing", async () => {
    const before = await row(me.id);
    const url = await run({ personalEmail: "not-an-email", phone: "123" });

    expect(url.startsWith("/profile?edit=1")).toBe(true);
    expect(errorIn(url)).toMatch(/email/i);
    expect(await row(me.id)).toEqual(before);
  });

  it("ignores every field outside the editable ones, however the form is crafted", async () => {
    const url = await run({
      phone: "+91 90000 00003",
      name: "Renamed",
      email: email("hijack"),
      title: "CEO",
      empId: "X-1",
      workMode: "WFO",
      regionId: "anything",
      managerId: "anything",
      id: colleague.id,
    });

    expect(url).toBe("/profile");
    expect(await row(me.id)).toMatchObject({
      name: "me",
      email: email("me"),
      title: "Developer",
      empId: `${RUN}-me`,
      workMode: null,
      phone: "+91 90000 00003",
    });
  });

  it("never touches another member's row", async () => {
    const before = await row(colleague.id);
    await run({ phone: "+91 90000 00004", id: colleague.id });

    expect(await row(colleague.id)).toEqual(before);
  });

  it("sends a signed-out caller back with an error", async () => {
    actorRef.current = null;
    const url = await run({ phone: "+91 90000 00005" });

    expect(errorIn(url)).not.toBeNull();
  });
});
