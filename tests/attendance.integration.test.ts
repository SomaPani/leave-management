import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

/**
 * The session the route handlers read, stubbed. Everything below it — the real
 * handler, the real policy layer, real Prisma queries — runs for real.
 *
 * Hoisted above every dynamic import so the mock is registered before
 * lib/auth.ts is pulled in by any module under test.
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

/**
 * Attendance against the Dockerized Postgres.
 *
 * Same approach as team.integration.test.ts: real Prisma queries and, later in
 * the file, the real route handlers called with a `Request`. Rows are
 * namespaced with a per-run prefix and removed afterwards.
 */

const { prisma } = await import("@/lib/prisma");

const RUN = `att-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

let orgId: string;
let adminId: string;
let memberId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `${RUN} Org` } });
  orgId = org.id;

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

  const member = await prisma.user.create({
    data: {
      name: "Run Member",
      email: email("member"),
      passwordHash: "x",
      role: Role.MEMBER,
      organizationId: orgId,
    },
  });
  memberId = member.id;
});

afterAll(async () => {
  await prisma.attendanceEvent.deleteMany({ where: { organizationId: orgId } });
  await prisma.attendance.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe("the database rejects impossible combinations", () => {
  it("refuses a modifier on an absence", async () => {
    await expect(
      prisma.attendance.create({
        data: {
          userId: memberId,
          organizationId: orgId,
          date: new Date("2026-08-17"),
          status: "ABSENT",
          modifier: "HALF_DAY",
          markedById: adminId,
        },
      }),
    ).rejects.toThrow();
  });

  it("accepts a modifier on a working day", async () => {
    const row = await prisma.attendance.create({
      data: {
        userId: memberId,
        organizationId: orgId,
        date: new Date("2026-08-18"),
        status: "WFH",
        modifier: "SHORT_LEAVE",
        markedById: adminId,
      },
    });

    expect(row.status).toBe("WFH");
    expect(row.modifier).toBe("SHORT_LEAVE");
    // A DATE column round-trips through UTC midnight.
    expect(row.date.toISOString().slice(0, 10)).toBe("2026-08-18");
  });
});

const { listDayAttendance, listRangeAttendance } = await import(
  "@/lib/attendance-service"
);

const adminActor = (): Actor => ({
  id: adminId,
  role: Role.ADMIN,
  organizationId: orgId,
});

describe("listDayAttendance", () => {
  it("returns every active member, unmarked ones included", async () => {
    const rows = await listDayAttendance(adminActor(), "2026-08-19");
    const mine = rows.find((r) => r.member.id === memberId);

    expect(mine).toBeDefined();
    expect(mine?.state).toBeNull();
  });

  it("attaches the stored state for a marked day", async () => {
    const rows = await listDayAttendance(adminActor(), "2026-08-18");
    const mine = rows.find((r) => r.member.id === memberId);

    expect(mine?.state).toEqual({ status: "WFH", modifier: "SHORT_LEAVE" });
  });

  it("refuses a member", async () => {
    await expect(
      listDayAttendance(
        { id: memberId, role: Role.MEMBER, organizationId: orgId },
        "2026-08-18",
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("shows an admin nothing from another organization", async () => {
    const rows = await listDayAttendance(
      { id: "someone", role: Role.ADMIN, organizationId: "not-a-real-org" },
      "2026-08-18",
    );

    expect(rows).toEqual([]);
  });
});

describe("listRangeAttendance", () => {
  it("returns the marks inside the span, as date strings", async () => {
    const rows = await listRangeAttendance(adminActor(), {
      from: "2026-08-17",
      to: "2026-08-19",
      userId: memberId,
    });

    expect(rows).toEqual([
      { userId: memberId, date: "2026-08-18", status: "WFH", modifier: "SHORT_LEAVE" },
    ]);
  });

  it("refuses a reversed span", async () => {
    await expect(
      listRangeAttendance(adminActor(), { from: "2026-08-19", to: "2026-08-17" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

const { setAttendance, clearAttendance, toggleAttendanceCode } = await import(
  "@/lib/attendance-service"
);

describe("setAttendance", () => {
  it("creates and then overwrites the same day", async () => {
    const first = await setAttendance(adminActor(), {
      userId: memberId,
      date: "2026-08-20",
      status: "PRESENT",
      modifier: null,
    });
    expect(first).toEqual({ status: "PRESENT", modifier: null });

    const second = await setAttendance(adminActor(), {
      userId: memberId,
      date: "2026-08-20",
      status: "WFH",
      modifier: "HALF_DAY",
    });
    expect(second).toEqual({ status: "WFH", modifier: "HALF_DAY" });

    const rows = await prisma.attendance.findMany({
      where: { userId: memberId, date: new Date("2026-08-20") },
    });
    expect(rows).toHaveLength(1);
  });

  it("records who marked it", async () => {
    const row = await prisma.attendance.findUnique({
      where: { userId_date: { userId: memberId, date: new Date("2026-08-20") } },
    });
    expect(row?.markedById).toBe(adminId);
  });

  it("writes an audit event per change, with the previous value", async () => {
    const events = await prisma.attendanceEvent.findMany({
      where: { userId: memberId, date: new Date("2026-08-20") },
      orderBy: { at: "asc" },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      fromStatus: null,
      toStatus: "PRESENT",
      actorId: adminId,
    });
    expect(events[1]).toMatchObject({
      fromStatus: "PRESENT",
      fromModifier: null,
      toStatus: "WFH",
      toModifier: "HALF_DAY",
    });
  });

  it("refuses a future date", async () => {
    await expect(
      setAttendance(adminActor(), {
        userId: memberId,
        date: "2099-01-01",
        status: "PRESENT",
        modifier: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses an invalid combination before it reaches the database", async () => {
    await expect(
      setAttendance(adminActor(), {
        userId: memberId,
        date: "2026-08-21",
        status: "ABSENT",
        modifier: "HALF_DAY",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a member", async () => {
    await expect(
      setAttendance(
        { id: memberId, role: Role.MEMBER, organizationId: orgId },
        { userId: memberId, date: "2026-08-21", status: "PRESENT", modifier: null },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("answers the same way for a foreign member and an unknown id", async () => {
    const foreign = setAttendance(
      { id: "x", role: Role.ADMIN, organizationId: "another-org" },
      { userId: memberId, date: "2026-08-21", status: "PRESENT", modifier: null },
    );
    const unknown = setAttendance(adminActor(), {
      userId: "no-such-user",
      date: "2026-08-21",
      status: "PRESENT",
      modifier: null,
    });

    await expect(foreign).rejects.toMatchObject({ status: 403 });
    await expect(unknown).rejects.toMatchObject({ status: 403 });
  });
});

describe("clearAttendance", () => {
  it("removes the row and logs the clear", async () => {
    await setAttendance(adminActor(), {
      userId: memberId,
      date: "2026-08-24",
      status: "PRESENT",
      modifier: null,
    });
    await clearAttendance(adminActor(), { userId: memberId, date: "2026-08-24" });

    const row = await prisma.attendance.findUnique({
      where: { userId_date: { userId: memberId, date: new Date("2026-08-24") } },
    });
    expect(row).toBeNull();

    const last = await prisma.attendanceEvent.findFirst({
      where: { userId: memberId, date: new Date("2026-08-24") },
      orderBy: { at: "desc" },
    });
    expect(last).toMatchObject({ fromStatus: "PRESENT", toStatus: null });
  });

  it("is silent on a day that was never marked", async () => {
    await expect(
      clearAttendance(adminActor(), { userId: memberId, date: "2026-08-25" }),
    ).resolves.toBeUndefined();
  });
});

describe("toggleAttendanceCode", () => {
  it("walks a day through the combinations the grid offers", async () => {
    const on = (code: Parameters<typeof toggleAttendanceCode>[1]["code"]) =>
      toggleAttendanceCode(adminActor(), { userId: memberId, date: "2026-08-26", code });

    expect(await on("PRESENT")).toEqual({ status: "PRESENT", modifier: null });
    expect(await on("HALF_DAY")).toEqual({ status: "PRESENT", modifier: "HALF_DAY" });
    expect(await on("WFH")).toEqual({ status: "WFH", modifier: "HALF_DAY" });
    expect(await on("SHORT_LEAVE")).toEqual({ status: "WFH", modifier: "SHORT_LEAVE" });
    expect(await on("ABSENT")).toEqual({ status: "ABSENT", modifier: null });
    expect(await on("ABSENT")).toBeNull();
  });
});

const { markEveryonePresent } = await import("@/lib/attendance-service");

describe("markEveryonePresent", () => {
  let secondId: string;

  it("fills only the people with no mark, leaving the rest alone", async () => {
    const other = await prisma.user.create({
      data: {
        name: "Run Second",
        email: email("second"),
        passwordHash: "x",
        role: Role.MEMBER,
        organizationId: orgId,
      },
    });
    secondId = other.id;

    // memberId already carries a deliberate absence on this day.
    await setAttendance(adminActor(), {
      userId: memberId,
      date: "2026-08-27",
      status: "ABSENT",
      modifier: null,
    });

    const result = await markEveryonePresent(adminActor(), "2026-08-27");

    expect(result).toEqual({ filled: 1, skipped: 1 });

    const kept = await prisma.attendance.findUnique({
      where: { userId_date: { userId: memberId, date: new Date("2026-08-27") } },
    });
    expect(kept?.status).toBe("ABSENT");

    const added = await prisma.attendance.findUnique({
      where: { userId_date: { userId: other.id, date: new Date("2026-08-27") } },
    });
    expect(added?.status).toBe("PRESENT");
    expect(added?.modifier).toBeNull();
  });

  it("is a no-op the second time", async () => {
    const result = await markEveryonePresent(adminActor(), "2026-08-27");
    expect(result).toEqual({ filled: 0, skipped: 2 });
  });

  it("logs an event for the row it created and none for the one it skipped", async () => {
    // The absence on memberId was written by this describe's own setup, so it
    // has a creation event too — filtering on `fromStatus: null` alone would
    // catch both. What the bulk fill is responsible for is the PRESENT one.
    const filled = await prisma.attendanceEvent.findMany({
      where: {
        organizationId: orgId,
        date: new Date("2026-08-27"),
        toStatus: "PRESENT",
      },
    });
    expect(filled).toHaveLength(1);
    expect(filled[0]).toMatchObject({ userId: secondId, fromStatus: null });

    // The person who was skipped kept exactly the one event their own mark
    // wrote — the second run of markEveryonePresent added nothing.
    const skipped = await prisma.attendanceEvent.findMany({
      where: { userId: memberId, date: new Date("2026-08-27") },
    });
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ toStatus: "ABSENT" });
  });

  it("refuses a future date", async () => {
    await expect(
      markEveryonePresent(adminActor(), "2099-01-01"),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a member and a superadmin", async () => {
    await expect(
      markEveryonePresent(
        { id: memberId, role: Role.MEMBER, organizationId: orgId },
        "2026-08-27",
      ),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      markEveryonePresent(
        { id: "s1", role: Role.SUPERADMIN, organizationId: null },
        "2026-08-27",
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

/* ------------------------------------------------------- the route handlers -- */

const attendanceRoute = await import("@/app/api/attendance/route");
const dayRoute = await import("@/app/api/attendance/[userId]/[date]/route");
const bulkRoute = await import("@/app/api/attendance/mark-all-present/route");

const get = (query = "") =>
  new Request(`http://localhost/api/attendance${query ? `?${query}` : ""}`);
const put = (body: unknown) =>
  new Request("http://localhost/api/attendance", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const post = (body: unknown) =>
  new Request("http://localhost/api/attendance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const del = () => new Request("http://localhost/api/attendance", { method: "DELETE" });
const dayCtx = (userId: string, date: string) => ({
  params: Promise.resolve({ userId, date }),
});
const actingAs = (actor: Actor | null) => {
  actorRef.current = actor;
};

describe("GET /api/attendance", () => {
  it("401s when nobody is signed in", async () => {
    actingAs(null);
    expect((await attendanceRoute.GET(get("date=2026-08-18"))).status).toBe(401);
  });

  it("403s a member", async () => {
    actingAs({ id: memberId, role: Role.MEMBER, organizationId: orgId });
    expect((await attendanceRoute.GET(get("date=2026-08-18"))).status).toBe(403);
  });

  it("400s without a date or a span", async () => {
    actingAs(adminActor());
    expect((await attendanceRoute.GET(get())).status).toBe(400);
  });

  it("400s a malformed date", async () => {
    actingAs(adminActor());
    expect((await attendanceRoute.GET(get("date=18-08-2026"))).status).toBe(400);
  });

  it("returns the day for an admin", async () => {
    actingAs(adminActor());
    const response = await attendanceRoute.GET(get("date=2026-08-18"));
    expect(response.status).toBe(200);

    const body = await response.json();
    const mine = body.find((r: { member: { id: string } }) => r.member.id === memberId);
    expect(mine.state).toEqual({ status: "WFH", modifier: "SHORT_LEAVE" });
  });

  it("returns a span for an admin", async () => {
    actingAs(adminActor());
    const response = await attendanceRoute.GET(
      get(`from=2026-08-17&to=2026-08-19&userId=${memberId}`),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { userId: memberId, date: "2026-08-18", status: "WFH", modifier: "SHORT_LEAVE" },
    ]);
  });
});

describe("PUT /api/attendance/[userId]/[date]", () => {
  it("stores a combination", async () => {
    actingAs(adminActor());
    const response = await dayRoute.PUT(
      put({ status: "PRESENT", modifier: "SHORT_LEAVE" }),
      dayCtx(memberId, "2026-08-28"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "PRESENT",
      modifier: "SHORT_LEAVE",
    });
  });

  it("400s an unknown status", async () => {
    actingAs(adminActor());
    const response = await dayRoute.PUT(
      put({ status: "HOLIDAY" }),
      dayCtx(memberId, "2026-08-28"),
    );
    expect(response.status).toBe(400);
  });

  it("400s an invalid combination", async () => {
    actingAs(adminActor());
    const response = await dayRoute.PUT(
      put({ status: "LEAVE", modifier: "HALF_DAY" }),
      dayCtx(memberId, "2026-08-28"),
    );
    expect(response.status).toBe(400);
  });

  it("400s a future date", async () => {
    actingAs(adminActor());
    const response = await dayRoute.PUT(
      put({ status: "PRESENT" }),
      dayCtx(memberId, "2099-01-01"),
    );
    expect(response.status).toBe(400);
  });

  it("403s an admin from another organization", async () => {
    actingAs({ id: "x", role: Role.ADMIN, organizationId: "another-org" });
    const response = await dayRoute.PUT(
      put({ status: "PRESENT" }),
      dayCtx(memberId, "2026-08-28"),
    );
    expect(response.status).toBe(403);
  });
});

describe("DELETE /api/attendance/[userId]/[date]", () => {
  it("clears the day", async () => {
    actingAs(adminActor());
    const response = await dayRoute.DELETE(del(), dayCtx(memberId, "2026-08-28"));
    expect(response.status).toBe(204);

    const row = await prisma.attendance.findUnique({
      where: { userId_date: { userId: memberId, date: new Date("2026-08-28") } },
    });
    expect(row).toBeNull();
  });
});

describe("POST /api/attendance/mark-all-present", () => {
  it("reports how many gaps it closed", async () => {
    actingAs(adminActor());
    const response = await bulkRoute.POST(post({ date: "2026-08-31" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ filled: 2, skipped: 0 });
  });

  it("403s a member", async () => {
    actingAs({ id: memberId, role: Role.MEMBER, organizationId: orgId });
    expect((await bulkRoute.POST(post({ date: "2026-08-31" }))).status).toBe(403);
  });
});

describe("an admin leaving does not take the attendance with them", () => {
  it("keeps the rows and drops only the attribution", async () => {
    const leaver = await prisma.user.create({
      data: {
        name: "Run Leaver",
        email: email("leaver"),
        passwordHash: "x",
        role: Role.ADMIN,
        organizationId: orgId,
      },
    });

    await setAttendance(
      { id: leaver.id, role: Role.ADMIN, organizationId: orgId },
      { userId: memberId, date: "2026-08-14", status: "PRESENT", modifier: null },
    );

    // The Team screen deactivates rather than deletes, but /api/admins/[id]
    // hard-deletes an admin, and that must not fail or cascade.
    await prisma.user.delete({ where: { id: leaver.id } });

    const row = await prisma.attendance.findUnique({
      where: { userId_date: { userId: memberId, date: new Date("2026-08-14") } },
    });
    expect(row).not.toBeNull();
    expect(row?.status).toBe("PRESENT");
    expect(row?.markedById).toBeNull();

    // The audit log keeps the original actor: it carries no foreign key.
    const event = await prisma.attendanceEvent.findFirst({
      where: { userId: memberId, date: new Date("2026-08-14") },
    });
    expect(event?.actorId).toBe(leaver.id);
  });
});
