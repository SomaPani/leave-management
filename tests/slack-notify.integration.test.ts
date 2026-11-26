import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AttendanceStatus, Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

/**
 * Slack attendance notifications against the Dockerized Postgres, with
 * Slack's Web API replaced by a stub that records what would be posted.
 */
vi.mock("@/lib/auth", () => ({
  currentActor: async () => null,
  auth: async () => null,
  handlers: { GET: () => new Response(), POST: () => new Response() },
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { prisma } = await import("@/lib/prisma");
const { todayIso } = await import("@/lib/attendance");
const { clearAttendance, markEveryonePresent, setAttendance } = await import("@/lib/attendance-service");
const { flushNotifications, sendNotMarkedReminder } = await import("@/lib/attendance-notify");
const { clearSlackCache } = await import("@/lib/slack");
const route = await import("@/app/api/attendance/not-marked-reminder/route");

const RUN = `slk-${Date.now().toString(36)}`;
const WEDNESDAY = "2026-11-18";
const SATURDAY = "2026-11-21";

let orgId = "";
let admin: Actor;
let anuId = "";
let balaId = "";
let posts: string[] = [];

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `${RUN} Org` } });
  orgId = org.id;
  const make = (name: string, role: Role) =>
    prisma.user.create({
      data: { name, email: `${RUN}-${name.toLowerCase()}@example.test`, passwordHash: "x", role, organizationId: orgId },
    });
  admin = { id: (await make("Admin", Role.ADMIN)).id, role: Role.ADMIN, organizationId: orgId };
  anuId = (await make("Anu", Role.MEMBER)).id;
  balaId = (await make("Bala", Role.MEMBER)).id;
});

beforeEach(async () => {
  posts = [];
  clearSlackCache();
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
  vi.stubEnv("SLACK_ORG_NAME", `${RUN} Org`);
  vi.stubEnv("ATTENDANCE_CRON_TOKEN", "cron-secret");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = new URLSearchParams(init.body as URLSearchParams);
      if (url.endsWith("users.lookupByEmail")) {
        return Response.json(
          body.get("email")?.includes("-anu@") ? { ok: true, user: { id: "UANU" } } : { ok: false, error: "users_not_found" },
        );
      }
      posts.push(body.get("text") ?? "");
      return Response.json({ ok: true });
    }),
  );
  await prisma.attendanceEvent.deleteMany({ where: { organizationId: orgId } });
  await prisma.attendance.deleteMany({ where: { organizationId: orgId } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.attendanceEvent.deleteMany({ where: { organizationId: orgId } });
  await prisma.attendance.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe("marking today", () => {
  const mark = (userId: string, status: AttendanceStatus) =>
    setAttendance(admin, { userId, date: todayIso(), status, modifier: null });

  it("posts once, tagging the person, on the first Present mark", async () => {
    await mark(anuId, AttendanceStatus.PRESENT);
    await mark(anuId, AttendanceStatus.WFH); // an edit
    await flushNotifications();
    expect(posts).toEqual([
      "<@UANU> Your attendance has been successfully marked for today. Have a productive day ahead!",
    ]);
  });

  it("does not post again when a day is cleared and marked again", async () => {
    await mark(anuId, AttendanceStatus.PRESENT);
    await clearAttendance(admin, { userId: anuId, date: todayIso() });
    await mark(anuId, AttendanceStatus.PRESENT);
    await flushNotifications();
    expect(posts).toHaveLength(1);
  });

  it("does not post for Absent, or for another organization's channel", async () => {
    await mark(anuId, AttendanceStatus.ABSENT);
    vi.stubEnv("SLACK_ORG_NAME", "Some Other Org");
    await mark(balaId, AttendanceStatus.PRESENT);
    await flushNotifications();
    expect(posts).toEqual([]);
  });

  it("posts one message for Mark everyone present, falling back to names", async () => {
    await markEveryonePresent(admin, todayIso());
    await flushNotifications();
    expect(posts).toEqual([
      "<@UANU> *Bala* Your attendance has been successfully marked for today. Have a productive day ahead!",
    ]);
  });

  it("sends nothing without a bot token", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    await mark(anuId, AttendanceStatus.PRESENT);
    await flushNotifications();
    expect(posts).toEqual([]);
  });
});

describe("the not-marked reminder", () => {
  it("tags everyone still not marked on a working day", async () => {
    await prisma.attendance.create({
      data: {
        userId: anuId,
        organizationId: orgId,
        date: new Date(`${WEDNESDAY}T00:00:00.000Z`),
        status: AttendanceStatus.PRESENT,
        markedById: admin.id,
      },
    });
    const results = await sendNotMarkedReminder(WEDNESDAY);
    expect(results).toEqual([{ organization: `${RUN} Org`, notMarked: 1, posted: true }]);
    expect(posts).toEqual(["Attendance not marked for today:\n• *Bala*"]);
  });

  it("posts nothing on a weekend", async () => {
    const results = await sendNotMarkedReminder(SATURDAY);
    expect(results).toEqual([{ organization: `${RUN} Org`, notMarked: 0, posted: false }]);
    expect(posts).toEqual([]);
  });

  it("is guarded by the cron token", async () => {
    const call = (auth?: string) =>
      route.POST(
        new Request("http://localhost/api/attendance/not-marked-reminder", {
          method: "POST",
          headers: auth ? { Authorization: auth } : {},
        }),
      );
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    const ok = await call("Bearer cron-secret");
    expect(ok.status).toBe(200);
  });
});
