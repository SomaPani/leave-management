import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

/**
 * The Team endpoints — regions, and the member profile that hangs off them —
 * exercised against the Dockerized Postgres.
 *
 * Same approach as api.integration.test.ts: the route handlers are called
 * directly with a `Request`, so the real handler, the real policy layer and
 * real Prisma queries all run, with only the session stubbed. Rows are
 * namespaced with a per-run prefix and removed afterwards.
 *
 * Kept separate from api.integration.test.ts because that file pins the
 * organization backbone's authorization matrix; this one pins Team behaviour —
 * profile validation, the status filter, and the region guards.
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
const members = await import("@/app/api/members/route");
const memberById = await import("@/app/api/members/[id]/route");
const regions = await import("@/app/api/regions/route");
const regionById = await import("@/app/api/regions/[id]/route");

const RUN = `step4-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

const post = (body: unknown) =>
  new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const patch = (body: unknown) =>
  new Request("http://localhost/api", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const del = () => new Request("http://localhost/api", { method: "DELETE" });
const get = (query = "") =>
  new Request(`http://localhost/api${query ? `?${query}` : ""}`);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const actingAs = (actor: Actor | null) => {
  actorRef.current = actor;
};

let orgA = "";
let orgB = "";
let superadmin: Actor;
let adminA: Actor;
let adminB: Actor;
let chennai = "";
let acmeRegion = "";
let memberId = "";

beforeAll(async () => {
  const [a, b] = await Promise.all([
    prisma.organization.create({ data: { name: `${RUN}-a` }, select: { id: true } }),
    prisma.organization.create({ data: { name: `${RUN}-b` }, select: { id: true } }),
  ]);
  orgA = a.id;
  orgB = b.id;

  const made = await Promise.all([
    prisma.user.create({
      data: { name: "Root", email: email("root"), passwordHash: "x", role: Role.SUPERADMIN },
      select: { id: true },
    }),
    prisma.user.create({
      data: {
        name: "Admin A",
        email: email("admin-a"),
        passwordHash: "x",
        role: Role.ADMIN,
        organizationId: orgA,
      },
      select: { id: true },
    }),
    prisma.user.create({
      data: {
        name: "Admin B",
        email: email("admin-b"),
        passwordHash: "x",
        role: Role.ADMIN,
        organizationId: orgB,
      },
      select: { id: true },
    }),
  ]);
  superadmin = { id: made[0].id, role: Role.SUPERADMIN, organizationId: null };
  adminA = { id: made[1].id, role: Role.ADMIN, organizationId: orgA };
  adminB = { id: made[2].id, role: Role.ADMIN, organizationId: orgB };
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
  await prisma.region.deleteMany({ where: { organizationId: { in: [orgA, orgB] } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: RUN } } });
  await prisma.$disconnect();
});

describe("/api/regions", () => {
  it("lets an admin create one", async () => {
    actingAs(adminA);
    const response = await regions.POST(post({ name: "Chennai" }));
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string; organizationId: string };
    chennai = created.id;
    expect(created.organizationId).toBe(orgA);
  });

  it("refuses a superadmin with 403", async () => {
    actingAs(superadmin);
    expect((await regions.POST(post({ name: "Nope" }))).status).toBe(403);
  });

  it("refuses a signed-out caller with 401", async () => {
    actingAs(null);
    expect((await regions.POST(post({ name: "Nope" }))).status).toBe(401);
  });

  it("refuses a duplicate name with 409", async () => {
    actingAs(adminA);
    expect((await regions.POST(post({ name: "Chennai" }))).status).toBe(409);
  });

  it("allows the same name in another organization", async () => {
    actingAs(adminB);
    const response = await regions.POST(post({ name: "Chennai" }));
    expect(response.status).toBe(201);
    acmeRegion = ((await response.json()) as { id: string }).id;
  });

  it("scopes the list to the caller's organization", async () => {
    actingAs(adminA);
    const list = (await (await regions.GET()).json()) as { id: string }[];
    expect(list.map((r) => r.id)).toEqual([chennai]);
  });

  it("lets a superadmin read every organization's regions", async () => {
    actingAs(superadmin);
    const list = (await (await regions.GET()).json()) as { id: string }[];
    const ids = list.map((r) => r.id);
    expect(ids).toContain(chennai);
    expect(ids).toContain(acmeRegion);
  });

  it("refuses another organization's admin renaming one", async () => {
    actingAs(adminB);
    expect((await regionById.PATCH(patch({ name: "Hijack" }), ctx(chennai))).status).toBe(403);
  });
});

describe("POST /api/members with a profile", () => {
  it("stores the profile fields", async () => {
    actingAs(adminA);
    const response = await members.POST(
      post({
        name: "Aisha Khan",
        email: email("aisha"),
        password: "a-long-enough-password",
        title: "Art director",
        empId: "STX-9001",
        workMode: "wfh",
        joinedOn: "2024-02-03",
        regionId: chennai,
        managerId: adminA.id,
      }),
    );
    expect(response.status).toBe(201);

    const created = (await response.json()) as {
      id: string;
      title: string;
      workMode: string;
      region: { name: string };
      manager: { name: string };
      status: string;
    };
    memberId = created.id;
    expect(created.title).toBe("Art director");
    expect(created.workMode).toBe("WFH");
    expect(created.region.name).toBe("Chennai");
    expect(created.manager.name).toBe("Admin A");
    expect(created.status).toBe("ACTIVE");
  });

  it("rejects another organization's region with 400", async () => {
    actingAs(adminA);
    const response = await members.POST(
      post({
        name: "Nope",
        email: email("nope"),
        password: "a-long-enough-password",
        regionId: acmeRegion,
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a bad workMode and a bad date with 400", async () => {
    actingAs(adminA);
    const base = { name: "X", password: "a-long-enough-password" };
    expect(
      (await members.POST(post({ ...base, email: email("w"), workMode: "REMOTE" }))).status,
    ).toBe(400);
    expect(
      (await members.POST(post({ ...base, email: email("d"), joinedOn: "yesterday" }))).status,
    ).toBe(400);
  });

  it("reports a duplicate employee id as an employee id, not an email", async () => {
    actingAs(adminA);
    const response = await members.POST(
      post({
        name: "Clash",
        email: email("clash"),
        password: "a-long-enough-password",
        empId: "STX-9001",
      }),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/employee id/i);
  });

  it("still reports a duplicate email as an email", async () => {
    actingAs(adminA);
    const response = await members.POST(
      post({ name: "Dupe", email: email("aisha"), password: "a-long-enough-password" }),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/email address/i);
  });
});

describe("PATCH /api/members/[id]", () => {
  it("clears a field with null and leaves unmentioned ones alone", async () => {
    actingAs(adminA);
    const updated = (await (
      await memberById.PATCH(patch({ title: null }), ctx(memberId))
    ).json()) as { title: string | null; empId: string };
    expect(updated.title).toBeNull();
    expect(updated.empId).toBe("STX-9001");
  });

  it("refuses a member as their own manager with 400", async () => {
    actingAs(adminA);
    expect(
      (await memberById.PATCH(patch({ managerId: memberId }), ctx(memberId))).status,
    ).toBe(400);
  });

  it("refuses an empty status with 400", async () => {
    actingAs(adminA);
    expect((await memberById.PATCH(patch({ status: null }), ctx(memberId))).status).toBe(400);
  });
});

describe("GET /api/members filters", () => {
  it("hides a deactivated member by default and shows them with ALL", async () => {
    actingAs(adminA);
    await memberById.PATCH(patch({ status: "INACTIVE" }), ctx(memberId));

    const active = (await (await members.GET(get())).json()) as { id: string }[];
    expect(active.map((m) => m.id)).not.toContain(memberId);

    const all = (await (await members.GET(get("status=ALL"))).json()) as { id: string }[];
    expect(all.map((m) => m.id)).toContain(memberId);

    const inactive = (await (
      await members.GET(get("status=inactive"))
    ).json()) as { id: string }[];
    expect(inactive.map((m) => m.id)).toContain(memberId);
  });

  it("rejects an unknown status with 400", async () => {
    actingAs(adminA);
    expect((await members.GET(get("status=retired"))).status).toBe(400);
  });

  it("filters by region", async () => {
    actingAs(adminA);
    await memberById.PATCH(patch({ status: "ACTIVE" }), ctx(memberId));

    const inRegion = (await (
      await members.GET(get(`region=${chennai}`))
    ).json()) as { id: string }[];
    expect(inRegion.map((m) => m.id)).toContain(memberId);

    const elsewhere = (await (
      await members.GET(get(`region=${acmeRegion}`))
    ).json()) as { id: string }[];
    expect(elsewhere).toHaveLength(0);
  });
});

describe("DELETE /api/regions/[id]", () => {
  it("refuses while a member is still in it", async () => {
    actingAs(adminA);
    const response = await regionById.DELETE(del(), ctx(chennai));
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/still has 1 member/);
  });

  it("succeeds once the region is empty", async () => {
    actingAs(adminA);
    await memberById.PATCH(patch({ regionId: null }), ctx(memberId));
    expect((await regionById.DELETE(del(), ctx(chennai))).status).toBe(200);
  });
});
