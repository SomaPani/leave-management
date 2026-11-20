import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AttendanceModifier, AttendanceStatus, EmploymentStatus, Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

/**
 * The Employee dashboard's reads (`teamPeriod`) and its CSV route
 * (`GET /api/attendance/report`) against the Dockerized Postgres.
 */
const { actorRef } = vi.hoisted(() => ({ actorRef: { current: null as Actor | null } }));

vi.mock("@/lib/auth", () => ({
  currentActor: async () => actorRef.current,
  auth: async () => null,
  handlers: { GET: () => new Response(), POST: () => new Response() },
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { prisma } = await import("@/lib/prisma");
const { teamPeriod } = await import("@/lib/overview-service");
const route = await import("@/app/api/attendance/report/route");

const RUN = `rep-${Date.now().toString(36)}`;
const TODAY = "2026-11-18"; // Wednesday

let orgId = "";
let otherOrgId = "";
let chennaiId = "";
let delhiId = "";
let otherRegionId = "";
let anuId = "";
let balaId = "";
let otherMemberId = "";
let admin: Actor;
let otherAdmin: Actor;
let member: Actor;

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `${RUN} Org` } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `${RUN} Other` } })).id;
  chennaiId = (await prisma.region.create({ data: { name: "Chennai", organizationId: orgId } })).id;
  delhiId = (await prisma.region.create({ data: { name: "Delhi", organizationId: orgId } })).id;
  otherRegionId = (await prisma.region.create({ data: { name: "Pune", organizationId: otherOrgId } })).id;

  const make = (
    name: string,
    role: Role,
    org: string,
    extra: { regionId?: string; status?: EmploymentStatus } = {},
  ) =>
    prisma.user.create({
      data: {
        name,
        email: `${RUN}-${name.replace(/\W/g, "").toLowerCase()}@example.test`,
        passwordHash: "x",
        role,
        organizationId: org,
        ...extra,
      },
    });

  const a = await make("Run Admin", Role.ADMIN, orgId);
  admin = { id: a.id, role: Role.ADMIN, organizationId: orgId };
  const oa = await make("Other Admin", Role.ADMIN, otherOrgId);
  otherAdmin = { id: oa.id, role: Role.ADMIN, organizationId: otherOrgId };

  anuId = (await make("Anu Chennai", Role.MEMBER, orgId, { regionId: chennaiId })).id;
  balaId = (await make("=Bala Delhi", Role.MEMBER, orgId, { regionId: delhiId })).id;
  await make("Gone Member", Role.MEMBER, orgId, { regionId: chennaiId, status: EmploymentStatus.INACTIVE });
  otherMemberId = (await make("Other Member", Role.MEMBER, otherOrgId, { regionId: otherRegionId })).id;
  member = { id: anuId, role: Role.MEMBER, organizationId: orgId };

  const mark = (userId: string, org: string, date: string, status: AttendanceStatus, modifier?: AttendanceModifier) => ({
    userId,
    organizationId: org,
    date: d(date),
    status,
    modifier: modifier ?? null,
    markedById: org === orgId ? a.id : oa.id,
  });
  await prisma.attendance.createMany({
    data: [
      mark(anuId, orgId, "2026-11-02", AttendanceStatus.PRESENT),
      mark(anuId, orgId, "2026-11-03", AttendanceStatus.PRESENT, AttendanceModifier.HALF_DAY),
      mark(balaId, orgId, "2026-11-02", AttendanceStatus.ABSENT),
      mark(balaId, orgId, "2026-11-03", AttendanceStatus.WFH),
      mark(otherMemberId, otherOrgId, "2026-11-02", AttendanceStatus.PRESENT),
    ],
  });
  await prisma.attendanceEvent.create({
    data: {
      organizationId: orgId,
      userId: anuId,
      date: d("2026-11-03"),
      toStatus: AttendanceStatus.PRESENT,
      actorId: a.id,
      at: new Date("2026-11-03T10:30:00.000Z"),
    },
  });
});

afterAll(async () => {
  for (const id of [orgId, otherOrgId]) {
    await prisma.attendanceEvent.deleteMany({ where: { organizationId: id } });
    await prisma.attendance.deleteMany({ where: { organizationId: id } });
    await prisma.user.deleteMany({ where: { organizationId: id } });
    await prisma.region.deleteMany({ where: { organizationId: id } });
    await prisma.organization.delete({ where: { id } });
  }
  await prisma.$disconnect();
});

describe("teamPeriod", () => {
  it("lists active members of the caller's organization with their days", async () => {
    const view = await teamPeriod(admin, { period: "month", anchor: "2026-11-01" }, TODAY);

    expect(view.range).toEqual({ from: "2026-11-01", to: TODAY, label: "November 2026" });
    expect(view.people.map((p) => p.name).sort()).toEqual(["=Bala Delhi", "Anu Chennai"].sort());
    expect(view.people.find((p) => p.id === anuId)?.region).toBe("Chennai");
    const anu = view.people.find((p) => p.id === anuId)!;
    expect(anu.days.find((day) => day.date === "2026-11-03")).toEqual({
      date: "2026-11-03",
      kind: "PRESENT",
      detail: "Half day",
    });
    expect(anu.days[0]?.date).toBe("2026-11-01"); // oldest first
    expect(view.everyone.map((p) => p.name).sort()).toEqual(["=Bala Delhi", "Anu Chennai"].sort());
    expect(view.regions.map((r) => r.name)).toEqual(["Chennai", "Delhi"]);
    expect(view.lastUpdated?.toISOString()).toBe("2026-11-03T10:30:00.000Z");
  });

  it("narrows by team and by member, but keeps the full lists for the filters", async () => {
    const byTeam = await teamPeriod(admin, { period: "month", anchor: "2026-11-01", regionId: delhiId }, TODAY);
    expect(byTeam.people.map((p) => p.id)).toEqual([balaId]);
    expect(byTeam.everyone).toHaveLength(2);

    const byMember = await teamPeriod(admin, { period: "month", anchor: "2026-11-01", memberId: anuId }, TODAY);
    expect(byMember.people.map((p) => p.id)).toEqual([anuId]);
  });

  it("matches nothing for another organization's member or team", async () => {
    const view = await teamPeriod(otherAdmin, { period: "month", anchor: "2026-11-01", memberId: anuId }, TODAY);
    expect(view.people).toEqual([]);
    const team = await teamPeriod(admin, { period: "month", anchor: "2026-11-01", regionId: otherRegionId }, TODAY);
    expect(team.people).toEqual([]);
    expect(team.regions.map((r) => r.id)).not.toContain(otherRegionId);
  });

  it("refuses a member", async () => {
    await expect(teamPeriod(member, { period: "month", anchor: "2026-11-01" }, TODAY)).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("GET /api/attendance/report", () => {
  const get = (query: string) => route.GET(new Request(`http://localhost/api/attendance/report?${query}`));

  it("needs a signed-in admin", async () => {
    actorRef.current = null;
    expect((await get("period=month&month=11&year=2026")).status).toBe(401);
    actorRef.current = member;
    expect((await get("period=month&month=11&year=2026")).status).toBe(403);
  });

  it("downloads the employee-wise table as CSV", async () => {
    actorRef.current = admin;
    const res = await get("period=month&month=11&year=2026");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="attendance_November-2026.csv"');

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM, for Excel
    const body = new TextDecoder().decode(bytes);
    expect(body).toContain("Employee,Emp ID,Team");
    expect(body).toContain("'=Bala Delhi"); // formula guard
    expect(body).toContain("Anu Chennai");
    expect(body).not.toContain("Other Member");
    expect(body).not.toContain("Gone Member");
  });

  it("respects the team filter", async () => {
    actorRef.current = admin;
    const body = await (await get(`period=month&month=11&year=2026&team=${delhiId}`)).text();
    expect(body).toContain("Bala Delhi");
    expect(body).not.toContain("Anu Chennai");
  });
});
