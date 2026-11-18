import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AttendanceStatus, Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

/** `GET /api/attendance/export` against the Dockerized Postgres. */
const { actorRef } = vi.hoisted(() => ({ actorRef: { current: null as Actor | null } }));

vi.mock("@/lib/auth", () => ({
  currentActor: async () => actorRef.current,
  auth: async () => null,
  handlers: { GET: () => new Response(), POST: () => new Response() },
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { prisma } = await import("@/lib/prisma");
const route = await import("@/app/api/attendance/export/route");

const RUN = `ovx-${Date.now().toString(36)}`;

let orgId = "";
let otherOrgId = "";
let memberId = "";
let admin: Actor;
let otherAdmin: Actor;

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `${RUN} Org` } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `${RUN} Other` } })).id;

  const make = (name: string, role: Role, org: string) =>
    prisma.user.create({
      data: {
        name,
        email: `${RUN}-${name.replace(/\W/g, "").toLowerCase()}@example.test`,
        passwordHash: "x",
        role,
        organizationId: org,
      },
    });

  const a = await make("Run Admin", Role.ADMIN, orgId);
  admin = { id: a.id, role: Role.ADMIN, organizationId: orgId };
  const oa = await make("Other Admin", Role.ADMIN, otherOrgId);
  otherAdmin = { id: oa.id, role: Role.ADMIN, organizationId: otherOrgId };
  memberId = (await make("Run Member", Role.MEMBER, orgId)).id;

  await prisma.attendance.create({
    data: {
      userId: memberId,
      organizationId: orgId,
      date: new Date("2026-11-02T00:00:00.000Z"),
      status: AttendanceStatus.WFH,
      markedById: a.id,
    },
  });
});

afterAll(async () => {
  for (const id of [orgId, otherOrgId]) {
    await prisma.attendance.deleteMany({ where: { organizationId: id } });
    await prisma.user.deleteMany({ where: { organizationId: id } });
    await prisma.organization.delete({ where: { id } });
  }
  await prisma.$disconnect();
});

const get = (query: string) =>
  route.GET(new Request(`http://localhost/api/attendance/export?${query}`));

describe("GET /api/attendance/export", () => {
  it("downloads a month as CSV for an admin", async () => {
    actorRef.current = admin;
    const response = await get(`userId=${memberId}&period=month&at=2026-11-05`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="Run-Member_November-2026.csv"',
    );

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM, for Excel
    const body = new TextDecoder().decode(bytes);
    expect(body.startsWith("Date,Day,Status,Detail\r\n")).toBe(true);
    // Oldest first in the file.
    expect(body.indexOf("2026-11-01")).toBeLessThan(body.indexOf("2026-11-02"));
    expect(body).toContain("2026-11-02,Mon,WFH,\r\n");
    expect(body).toContain("WFH,1\r\n");
    expect(body).toContain("Not marked,");
  });

  it("names a quarter and a year file", async () => {
    actorRef.current = admin;
    const q = await get(`userId=${memberId}&period=quarter&at=2026-08-01`);
    expect(q.headers.get("content-disposition")).toContain('filename="Run-Member_Q3-2026.csv"');
    const y = await get(`userId=${memberId}&period=year&at=2025-05-01`);
    expect(y.headers.get("content-disposition")).toContain('filename="Run-Member_2025.csv"');
  });

  it("refuses a member", async () => {
    actorRef.current = { id: memberId, role: Role.MEMBER, organizationId: orgId };
    expect((await get(`userId=${memberId}&period=month&at=2026-11-05`)).status).toBe(403);
  });

  it("hides another organization's member", async () => {
    actorRef.current = otherAdmin;
    expect((await get(`userId=${memberId}&period=month&at=2026-11-05`)).status).toBe(404);
  });

  it("rejects a bad period, a bad date and a missing user", async () => {
    actorRef.current = admin;
    expect((await get(`userId=${memberId}&period=week&at=2026-11-05`)).status).toBe(400);
    expect((await get(`userId=${memberId}&period=month&at=nope`)).status).toBe(400);
    expect((await get(`period=month&at=2026-11-05`)).status).toBe(400);
  });

  it("asks a signed-out caller to sign in", async () => {
    actorRef.current = null;
    expect((await get(`userId=${memberId}&period=month&at=2026-11-05`)).status).toBe(401);
  });
});
