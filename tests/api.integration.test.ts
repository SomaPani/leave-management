import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

/**
 * API authorization, exercised against the Dockerized Postgres.
 *
 * The route handlers are called directly with a `Request` rather than over
 * HTTP — that keeps the test a plain function call while still running the real
 * handler, the real policy layer, and real Prisma queries against the real
 * database. Only the session is stubbed, since signing a JWT would test
 * Auth.js rather than these rules.
 *
 * Rows are namespaced with a per-run prefix and removed afterwards, so this can
 * run against the same `orgapp` schema as development without touching the
 * seeded Stacx organization.
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
const organizations = await import("@/app/api/organizations/route");
const admins = await import("@/app/api/admins/route");
const members = await import("@/app/api/members/route");
const organizationById = await import("@/app/api/organizations/[id]/route");
const adminById = await import("@/app/api/admins/[id]/route");
const memberById = await import("@/app/api/members/[id]/route");

const RUN = `itest-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

function post(body: unknown): Request {
  return new Request("http://localhost/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(body: unknown): Request {
  return new Request("http://localhost/api", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(): Request {
  return new Request("http://localhost/api", { method: "DELETE" });
}

/** Route handlers receive params as a promise in Next 16. */
function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

/** Signs the given actor in for the duration of the next handler call. */
function actingAs(actor: Actor | null): void {
  actorRef.current = actor;
}

let orgA = "";
let orgB = "";
let superadmin: Actor;
let adminA: Actor;
let adminB: Actor;
let memberA: Actor;

beforeAll(async () => {
  const [a, b] = await Promise.all([
    prisma.organization.create({ data: { name: `${RUN}-org-a` }, select: { id: true } }),
    prisma.organization.create({ data: { name: `${RUN}-org-b` }, select: { id: true } }),
  ]);
  orgA = a.id;
  orgB = b.id;

  const made = await Promise.all([
    prisma.user.create({
      data: {
        name: "Root",
        email: email("root"),
        passwordHash: "x",
        role: Role.SUPERADMIN,
      },
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
    prisma.user.create({
      data: {
        name: "Member A",
        email: email("member-a"),
        passwordHash: "x",
        role: Role.MEMBER,
        organizationId: orgA,
      },
      select: { id: true },
    }),
  ]);

  superadmin = { id: made[0].id, role: Role.SUPERADMIN, organizationId: null };
  adminA = { id: made[1].id, role: Role.ADMIN, organizationId: orgA };
  adminB = { id: made[2].id, role: Role.ADMIN, organizationId: orgB };
  memberA = { id: made[3].id, role: Role.MEMBER, organizationId: orgA };
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: RUN } } });
  await prisma.$disconnect();
});

describe("POST /api/organizations", () => {
  it("lets a superadmin create one", async () => {
    actingAs(superadmin);
    const response = await organizations.POST(post({ name: `${RUN}-acme` }));
    expect(response.status).toBe(201);

    const created = (await response.json()) as { id: string; name: string };
    expect(created.name).toBe(`${RUN}-acme`);
    await expect(
      prisma.organization.findUnique({ where: { id: created.id } }),
    ).resolves.not.toBeNull();
  });

  it("rejects an admin with 403", async () => {
    actingAs(adminA);
    const response = await organizations.POST(post({ name: `${RUN}-nope` }));
    expect(response.status).toBe(403);
    await expect(
      prisma.organization.findUnique({ where: { name: `${RUN}-nope` } }),
    ).resolves.toBeNull();
  });

  it("rejects a member with 403", async () => {
    actingAs(memberA);
    expect((await organizations.POST(post({ name: `${RUN}-nope2` }))).status).toBe(403);
  });

  it("rejects a signed-out caller with 401", async () => {
    actingAs(null);
    expect((await organizations.POST(post({ name: `${RUN}-nope3` }))).status).toBe(401);
  });

  it("rejects a missing name with 400", async () => {
    actingAs(superadmin);
    expect((await organizations.POST(post({}))).status).toBe(400);
  });

  it("rejects a duplicate name with 409", async () => {
    actingAs(superadmin);
    await organizations.POST(post({ name: `${RUN}-dupe` }));
    expect((await organizations.POST(post({ name: `${RUN}-dupe` }))).status).toBe(409);
  });
});

describe("GET /api/organizations", () => {
  it("lets a superadmin list every organization", async () => {
    actingAs(superadmin);
    const response = await organizations.GET();
    expect(response.status).toBe(200);

    const list = (await response.json()) as { id: string }[];
    const ids = list.map((organization) => organization.id);
    expect(ids).toContain(orgA);
    expect(ids).toContain(orgB);
  });

  it("rejects an admin with 403", async () => {
    actingAs(adminA);
    expect((await organizations.GET()).status).toBe(403);
  });
});

describe("POST /api/admins", () => {
  it("lets a superadmin create an admin in a chosen organization", async () => {
    actingAs(superadmin);
    const response = await admins.POST(
      post({
        name: "New Admin",
        email: email("new-admin"),
        password: "a-long-enough-password",
        organizationId: orgB,
      }),
    );
    expect(response.status).toBe(201);

    const created = (await response.json()) as { id: string; organizationId: string };
    expect(created.organizationId).toBe(orgB);

    const stored = await prisma.user.findUnique({
      where: { id: created.id },
      select: { role: true, organizationId: true, passwordHash: true, createdById: true },
    });
    expect(stored?.role).toBe(Role.ADMIN);
    expect(stored?.organizationId).toBe(orgB);
    expect(stored?.createdById).toBe(superadmin.id);
    // Stored hashed, never in the clear.
    expect(stored?.passwordHash).not.toBe("a-long-enough-password");
    expect(stored?.passwordHash.startsWith("$2")).toBe(true);
  });

  it("rejects an admin with 403", async () => {
    actingAs(adminA);
    const response = await admins.POST(
      post({
        name: "Sneaky",
        email: email("sneaky-admin"),
        password: "a-long-enough-password",
        organizationId: orgA,
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects a member with 403", async () => {
    actingAs(memberA);
    const response = await admins.POST(
      post({
        name: "Sneaky",
        email: email("sneaky-admin-2"),
        password: "a-long-enough-password",
        organizationId: orgA,
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects an unknown organization with 400", async () => {
    actingAs(superadmin);
    const response = await admins.POST(
      post({
        name: "Nowhere",
        email: email("nowhere"),
        password: "a-long-enough-password",
        organizationId: "does-not-exist",
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a short password with 400", async () => {
    actingAs(superadmin);
    const response = await admins.POST(
      post({
        name: "Short",
        email: email("short"),
        password: "short",
        organizationId: orgA,
      }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a duplicate email with 409", async () => {
    actingAs(superadmin);
    const body = {
      name: "Twice",
      email: email("twice"),
      password: "a-long-enough-password",
      organizationId: orgA,
    };
    expect((await admins.POST(post(body))).status).toBe(201);
    expect((await admins.POST(post(body))).status).toBe(409);
  });
});

describe("POST /api/members", () => {
  it("lets an admin create a member in their own organization", async () => {
    actingAs(adminA);
    const response = await members.POST(
      post({
        name: "Member One",
        email: email("member-one"),
        password: "a-long-enough-password",
      }),
    );
    expect(response.status).toBe(201);

    const created = (await response.json()) as { id: string; organizationId: string };
    expect(created.organizationId).toBe(orgA);

    const stored = await prisma.user.findUnique({
      where: { id: created.id },
      select: { role: true, createdById: true },
    });
    expect(stored?.role).toBe(Role.MEMBER);
    expect(stored?.createdById).toBe(adminA.id);
  });

  it("ignores a body organizationId that matches the admin's own", async () => {
    actingAs(adminA);
    const response = await members.POST(
      post({
        name: "Member Two",
        email: email("member-two"),
        password: "a-long-enough-password",
        organizationId: orgA,
      }),
    );
    expect(response.status).toBe(201);
    expect(((await response.json()) as { organizationId: string }).organizationId).toBe(orgA);
  });

  it("rejects a cross-org attempt with 403 and writes nothing", async () => {
    actingAs(adminA);
    const response = await members.POST(
      post({
        name: "Wrong Org",
        email: email("wrong-org"),
        password: "a-long-enough-password",
        organizationId: orgB,
      }),
    );
    expect(response.status).toBe(403);
    await expect(
      prisma.user.findUnique({ where: { email: email("wrong-org") } }),
    ).resolves.toBeNull();
  });

  it("rejects a member with 403", async () => {
    actingAs(memberA);
    const response = await members.POST(
      post({
        name: "Nope",
        email: email("member-nope"),
        password: "a-long-enough-password",
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects a superadmin with 403 — members are created by their own admin", async () => {
    actingAs(superadmin);
    const response = await members.POST(
      post({
        name: "Root Made",
        email: email("root-made"),
        password: "a-long-enough-password",
        organizationId: orgA,
      }),
    );
    expect(response.status).toBe(403);
  });

  it("rejects a signed-out caller with 401", async () => {
    actingAs(null);
    const response = await members.POST(
      post({ name: "X", email: email("x"), password: "a-long-enough-password" }),
    );
    expect(response.status).toBe(401);
  });
});

describe("GET /api/members", () => {
  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        {
          name: "Scoped A",
          email: email("scoped-a"),
          passwordHash: "x",
          role: Role.MEMBER,
          organizationId: orgA,
        },
        {
          name: "Scoped B",
          email: email("scoped-b"),
          passwordHash: "x",
          role: Role.MEMBER,
          organizationId: orgB,
        },
      ],
    });
  });

  it("shows an admin only their own organization's members", async () => {
    actingAs(adminA);
    const response = await members.GET();
    expect(response.status).toBe(200);

    const list = (await response.json()) as { email: string; organizationId: string }[];
    expect(list.every((member) => member.organizationId === orgA)).toBe(true);
    expect(list.map((member) => member.email)).toContain(email("scoped-a"));
    expect(list.map((member) => member.email)).not.toContain(email("scoped-b"));
  });

  it("shows the other admin their own organization instead", async () => {
    actingAs(adminB);
    const list = (await (await members.GET()).json()) as { email: string }[];
    expect(list.map((member) => member.email)).toContain(email("scoped-b"));
    expect(list.map((member) => member.email)).not.toContain(email("scoped-a"));
  });

  it("shows a superadmin members from every organization", async () => {
    actingAs(superadmin);
    const list = (await (await members.GET()).json()) as { email: string }[];
    const emails = list.map((member) => member.email);
    expect(emails).toContain(email("scoped-a"));
    expect(emails).toContain(email("scoped-b"));
  });

  it("rejects a member with 403", async () => {
    actingAs(memberA);
    expect((await members.GET()).status).toBe(403);
  });
});

describe("PATCH/DELETE /api/organizations/[id]", () => {
  it("lets a superadmin rename one", async () => {
    actingAs(superadmin);
    const created = (await (
      await organizations.POST(post({ name: `${RUN}-rename-me` }))
    ).json()) as { id: string };

    const response = await organizationById.PATCH(
      patch({ name: `${RUN}-renamed` }),
      ctx(created.id),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { name: string }).name).toBe(`${RUN}-renamed`);
  });

  it("rejects an admin with 403", async () => {
    actingAs(adminA);
    expect(
      (await organizationById.PATCH(patch({ name: `${RUN}-x` }), ctx(orgB))).status,
    ).toBe(403);
    expect((await organizationById.DELETE(del(), ctx(orgB))).status).toBe(403);
  });

  it("rejects a signed-out caller with 401", async () => {
    actingAs(null);
    expect((await organizationById.DELETE(del(), ctx(orgA))).status).toBe(401);
  });

  it("returns 404 for an unknown id", async () => {
    actingAs(superadmin);
    expect((await organizationById.DELETE(del(), ctx("nope"))).status).toBe(404);
  });

  it("rejects a rename onto an existing name with 409", async () => {
    actingAs(superadmin);
    const target = (await (
      await organizations.POST(post({ name: `${RUN}-clash-target` }))
    ).json()) as { id: string };
    await organizations.POST(post({ name: `${RUN}-clash-taken` }));

    const response = await organizationById.PATCH(
      patch({ name: `${RUN}-clash-taken` }),
      ctx(target.id),
    );
    expect(response.status).toBe(409);
  });

  it("refuses to delete an organization that still has users", async () => {
    actingAs(superadmin);
    // orgA holds adminA and memberA.
    const response = await organizationById.DELETE(del(), ctx(orgA));
    expect(response.status).toBe(409);

    // The users must still be attached, not orphaned by ON DELETE SET NULL.
    const stillThere = await prisma.user.findUnique({
      where: { id: adminA.id },
      select: { organizationId: true },
    });
    expect(stillThere?.organizationId).toBe(orgA);
  });

  it("deletes an empty organization", async () => {
    actingAs(superadmin);
    const created = (await (
      await organizations.POST(post({ name: `${RUN}-empty` }))
    ).json()) as { id: string };

    expect((await organizationById.DELETE(del(), ctx(created.id))).status).toBe(200);
    await expect(
      prisma.organization.findUnique({ where: { id: created.id } }),
    ).resolves.toBeNull();
  });
});

describe("PATCH/DELETE /api/admins/[id]", () => {
  async function makeAdmin(local: string) {
    actingAs(superadmin);
    return (await (
      await admins.POST(
        post({
          name: "Target",
          email: email(local),
          password: "a-long-enough-password",
          organizationId: orgA,
        }),
      )
    ).json()) as { id: string };
  }

  it("lets a superadmin change name, email and organization", async () => {
    const target = await makeAdmin("patch-admin");
    const response = await adminById.PATCH(
      patch({ name: "Renamed", email: email("patched-admin"), organizationId: orgB }),
      ctx(target.id),
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      name: string;
      email: string;
      organizationId: string;
    };
    expect(body.name).toBe("Renamed");
    expect(body.email).toBe(email("patched-admin"));
    expect(body.organizationId).toBe(orgB);
  });

  it("re-hashes a new password rather than storing it", async () => {
    const target = await makeAdmin("pw-admin");
    const before = await prisma.user.findUnique({
      where: { id: target.id },
      select: { passwordHash: true },
    });

    const response = await adminById.PATCH(
      patch({ password: "another-long-password" }),
      ctx(target.id),
    );
    expect(response.status).toBe(200);

    const after = await prisma.user.findUnique({
      where: { id: target.id },
      select: { passwordHash: true },
    });
    expect(after?.passwordHash).not.toBe(before?.passwordHash);
    expect(after?.passwordHash).not.toBe("another-long-password");
  });

  it("rejects a short password with 400", async () => {
    const target = await makeAdmin("short-pw-admin");
    expect(
      (await adminById.PATCH(patch({ password: "short" }), ctx(target.id))).status,
    ).toBe(400);
  });

  it("rejects an empty patch with 400", async () => {
    const target = await makeAdmin("empty-patch-admin");
    expect((await adminById.PATCH(patch({}), ctx(target.id))).status).toBe(400);
  });

  it("rejects an unknown organization with 400", async () => {
    const target = await makeAdmin("bad-org-admin");
    expect(
      (await adminById.PATCH(patch({ organizationId: "nope" }), ctx(target.id))).status,
    ).toBe(400);
  });

  it("cannot be pointed at a member or a superadmin", async () => {
    actingAs(superadmin);
    expect((await adminById.DELETE(del(), ctx(memberA.id))).status).toBe(404);
    expect((await adminById.DELETE(del(), ctx(superadmin.id))).status).toBe(404);

    await expect(
      prisma.user.findUnique({ where: { id: memberA.id } }),
    ).resolves.not.toBeNull();
  });

  it("rejects an admin and a member with 403", async () => {
    const target = await makeAdmin("guarded-admin");
    for (const actor of [adminA, memberA]) {
      actingAs(actor);
      expect(
        (await adminById.PATCH(patch({ name: "Nope" }), ctx(target.id))).status,
      ).toBe(403);
      expect((await adminById.DELETE(del(), ctx(target.id))).status).toBe(403);
    }
  });

  it("deletes an admin", async () => {
    const target = await makeAdmin("delete-admin");
    actingAs(superadmin);
    expect((await adminById.DELETE(del(), ctx(target.id))).status).toBe(200);
    await expect(
      prisma.user.findUnique({ where: { id: target.id } }),
    ).resolves.toBeNull();
  });
});

describe("PATCH/DELETE /api/members/[id]", () => {
  async function makeMember(local: string) {
    actingAs(adminA);
    return (await (
      await members.POST(
        post({ name: "Target", email: email(local), password: "a-long-enough-password" }),
      )
    ).json()) as { id: string };
  }

  it("lets the owning admin update one", async () => {
    const target = await makeMember("patch-member");
    actingAs(adminA);
    const response = await memberById.PATCH(
      patch({ name: "Renamed", email: email("patched-member") }),
      ctx(target.id),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { name: string }).name).toBe("Renamed");
  });

  it("rejects an admin from another organization with 403", async () => {
    const target = await makeMember("cross-org-member");
    actingAs(adminB);
    expect(
      (await memberById.PATCH(patch({ name: "Nope" }), ctx(target.id))).status,
    ).toBe(403);
    expect((await memberById.DELETE(del(), ctx(target.id))).status).toBe(403);

    const stored = await prisma.user.findUnique({
      where: { id: target.id },
      select: { name: true },
    });
    expect(stored?.name).toBe("Target");
  });

  it("rejects a member and a superadmin with 403", async () => {
    const target = await makeMember("guarded-member");
    for (const actor of [memberA, superadmin]) {
      actingAs(actor);
      expect(
        (await memberById.PATCH(patch({ name: "Nope" }), ctx(target.id))).status,
      ).toBe(403);
      expect((await memberById.DELETE(del(), ctx(target.id))).status).toBe(403);
    }
  });

  it("cannot be pointed at an admin", async () => {
    actingAs(adminA);
    expect((await memberById.DELETE(del(), ctx(adminA.id))).status).toBe(404);
  });

  it("has no way to move a member between organizations", async () => {
    const target = await makeMember("immovable-member");
    actingAs(adminA);
    // organizationId is not a patchable field: it is ignored, not honoured.
    const response = await memberById.PATCH(
      patch({ name: "Still Here", organizationId: orgB }),
      ctx(target.id),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { organizationId: string }).organizationId).toBe(
      orgA,
    );
  });

  it("deletes a member", async () => {
    const target = await makeMember("delete-member");
    actingAs(adminA);
    expect((await memberById.DELETE(del(), ctx(target.id))).status).toBe(200);
    await expect(
      prisma.user.findUnique({ where: { id: target.id } }),
    ).resolves.toBeNull();
  });
});
