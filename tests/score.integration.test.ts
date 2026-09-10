import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Role, ScoreStatus } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

/**
 * The session the route handlers read, stubbed. Everything below it — the real
 * handler, the real policy layer, real Prisma queries — runs for real.
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
 * Scores against the Dockerized Postgres.
 *
 * Same approach as attendance.integration.test.ts: real Prisma queries and,
 * later in the file, the real route handler called with a `Request`. Rows are
 * namespaced with a per-run prefix and removed afterwards.
 */

const { prisma } = await import("@/lib/prisma");
const { ingestScoreDays } = await import("@/lib/score-service");

const RUN = `score-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

let orgId: string;
let memberId: string;
let adminId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `${RUN} Org` } });
  orgId = org.id;

  const member = await prisma.user.create({
    data: {
      name: "Soma",
      email: email("soma"),
      passwordHash: "x",
      role: Role.MEMBER,
      organizationId: orgId,
    },
  });
  memberId = member.id;

  const admin = await prisma.user.create({
    data: {
      name: "Admin Person",
      email: email("admin"),
      passwordHash: "x",
      role: Role.ADMIN,
      organizationId: orgId,
    },
  });
  adminId = admin.id;
});

afterAll(async () => {
  await prisma.scoreDay.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

const input = (over: Record<string, unknown> = {}) => ({
  email: email("soma"),
  date: "2026-09-08",
  status: ScoreStatus.SCORED,
  reason: null,
  attendance: "Present",
  checkinPts: 10,
  pickedPts: 5,
  descriptionPts: 10,
  commitPts: 5,
  commentPts: 10,
  deliveryPts: 60,
  coordinationPts: 0,
  process: 40,
  delivery: 60,
  total: 100,
  band: "Excellent",
  tasksPicked: 2,
  tasksDone: 2,
  tasksCredit: 2,
  volumeFactor: 1,
  pickedTasks: ["HIR-131"],
  flags: [],
  computedAt: new Date("2026-09-08T18:04:11Z"),
  ...over,
});

describe("ingestScoreDays", () => {
  it("writes a day and copies the organization from the stored user", async () => {
    const result = await ingestScoreDays([input()]);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toEqual([]);

    const row = await prisma.scoreDay.findFirst({ where: { userId: memberId } });
    expect(row?.organizationId).toBe(orgId);
    expect(row?.total).toBe(100);
  });

  it("corrects a re-pushed day in place rather than duplicating it", async () => {
    await ingestScoreDays([input({ date: "2026-09-10", total: 70, band: "On Track" })]);
    await ingestScoreDays([input({ date: "2026-09-10", total: 90, band: "Excellent" })]);

    const rows = await prisma.scoreDay.findMany({
      where: { userId: memberId, date: new Date("2026-09-10") },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].total).toBe(90);
  });

  it("stores nulls for a day that was not scored, never zeros", async () => {
    await ingestScoreDays([
      input({
        date: "2026-09-11",
        status: ScoreStatus.NOT_SCORED,
        reason: "jira: 503",
        checkinPts: null,
        pickedPts: null,
        descriptionPts: null,
        commitPts: null,
        commentPts: null,
        deliveryPts: null,
        coordinationPts: null,
        process: null,
        delivery: null,
        total: null,
        band: null,
        tasksPicked: null,
        tasksDone: null,
        tasksCredit: null,
        volumeFactor: null,
        pickedTasks: [],
      }),
    ]);

    const row = await prisma.scoreDay.findFirst({
      where: { userId: memberId, date: new Date("2026-09-11") },
    });
    expect(row?.total).toBeNull();
    expect(row?.checkinPts).toBeNull();
    expect(row?.reason).toBe("jira: 503");
  });

  it("reports an unknown email and still accepts the rest of the batch", async () => {
    const result = await ingestScoreDays([
      input({ date: "2026-09-12" }),
      input({ date: "2026-09-12", email: email("nobody") }),
    ]);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toEqual([{ email: email("nobody"), reason: "no such user" }]);
  });

  it("keeps a total above 100 — the coordination bonus is not clamped", async () => {
    await ingestScoreDays([input({ date: "2026-09-13", total: 110, coordinationPts: 10 })]);
    const row = await prisma.scoreDay.findFirst({
      where: { userId: memberId, date: new Date("2026-09-13") },
    });
    expect(row?.total).toBe(110);
  });
});

describe("POST /api/scores", () => {
  const post = async (body: unknown, token: string | null) => {
    const { POST } = await import("@/app/api/scores/route");
    return POST(
      new Request("http://test/api/scores", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      }),
    );
  };

  const payload = {
    days: [
      {
        date: "2026-09-15",
        email: email("soma"),
        status: "SCORED",
        attendance: "Present",
        points: {
          checkin: 10,
          picked: 5,
          description: 10,
          commit: 5,
          comment: 10,
          done: 60,
          coordination: 0,
        },
        process: 40,
        delivery: 60,
        total: 100,
        band: "Excellent",
        tasksPicked: 1,
        tasksDone: 1,
        tasksCredit: 1,
        volumeFactor: 1,
        pickedTasks: ["HIR-1"],
        flags: [],
        computedAt: "2026-09-15T18:00:00Z",
      },
    ],
  };

  it("accepts a batch with the right token", async () => {
    process.env.SCORE_INGEST_TOKEN = "test-token";
    const response = await post(payload, "test-token");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1, rejected: [] });
  });

  it("refuses a wrong token with 401", async () => {
    process.env.SCORE_INGEST_TOKEN = "test-token";
    expect((await post(payload, "wrong-token")).status).toBe(401);
  });

  it("refuses a missing Authorization header with 401", async () => {
    process.env.SCORE_INGEST_TOKEN = "test-token";
    expect((await post(payload, null)).status).toBe(401);
  });

  it("answers 503 when no token is configured, rather than matching an empty string", async () => {
    delete process.env.SCORE_INGEST_TOKEN;
    expect((await post(payload, "")).status).toBe(503);
  });

  it("refuses a malformed body with 400", async () => {
    process.env.SCORE_INGEST_TOKEN = "test-token";
    expect((await post({ days: "nope" }, "test-token")).status).toBe(400);
  });
});

describe("the reads", () => {
  it("gives a member their own month and takes no user id", async () => {
    const member: Actor = { id: memberId, role: Role.MEMBER, organizationId: orgId };
    const { listOwnScoreDays } = await import("@/lib/score-service");

    // September is 8: monthBounds is 0-based, as /calendar already is.
    const days = await listOwnScoreDays(member, 2026, 8);
    expect(days.length).toBeGreaterThan(0);
    expect(days.every((day) => day.date.startsWith("2026-09"))).toBe(true);
    // The signature is the guard: actor, year, month — there is no parameter
    // to put a colleague's id in.
    expect(listOwnScoreDays.length).toBe(3);
  });

  it("gives an admin every member of their own organization", async () => {
    const admin: Actor = { id: adminId, role: Role.ADMIN, organizationId: orgId };
    const { listOrgScoreMonths } = await import("@/lib/score-service");

    const roster = await listOrgScoreMonths(admin, 2026, 8);
    expect(roster.map((entry) => entry.name)).toContain("Soma");
  });

  it("refuses a member the organization-wide read", async () => {
    const member: Actor = { id: memberId, role: Role.MEMBER, organizationId: orgId };
    const { listOrgScoreMonths } = await import("@/lib/score-service");
    await expect(listOrgScoreMonths(member, 2026, 8)).rejects.toThrow(/not allowed/i);
  });

  it("returns null for a member outside the admin's organization", async () => {
    const outsider = await prisma.organization.create({ data: { name: `${RUN} Other` } });
    const stranger = await prisma.user.create({
      data: {
        name: "Stranger",
        email: email("stranger"),
        passwordHash: "x",
        role: Role.MEMBER,
        organizationId: outsider.id,
      },
    });
    const admin: Actor = { id: adminId, role: Role.ADMIN, organizationId: orgId };
    const { findMemberScoreDays } = await import("@/lib/score-service");

    expect(await findMemberScoreDays(admin, stranger.id, 2026, 8)).toBeNull();

    await prisma.user.delete({ where: { id: stranger.id } });
    await prisma.organization.delete({ where: { id: outsider.id } });
  });
});
