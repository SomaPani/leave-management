import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AttendanceStatus, LeaveRequestStatus, Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/lib/rbac";

const { todayOverview, memberPeriod } = await import("@/lib/overview-service");

/**
 * The admin Overview against the Dockerized Postgres: the four reads, the
 * day rule from lib/day-status.ts applied to them, and the org scoping.
 */
const RUN = `ov-${Date.now().toString(36)}`;
const TODAY = "2026-11-18"; // Wednesday

let orgId = "";
let otherOrgId = "";
let admin: Actor;
let otherAdmin: Actor;
let presentId = "";
let wfhId = "";
let leaveId = "";
let delhiId = "";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: `${RUN} Org` } })).id;
  otherOrgId = (await prisma.organization.create({ data: { name: `${RUN} Other` } })).id;

  const chennai = await prisma.region.create({ data: { name: "Chennai", organizationId: orgId } });
  delhiId = (await prisma.region.create({ data: { name: "Delhi", organizationId: orgId } })).id;

  const user = (name: string, role: Role, org: string, regionId: string | null = null) =>
    prisma.user.create({
      data: {
        name,
        email: `${RUN}-${name.replace(/\s/g, "").toLowerCase()}@example.test`,
        passwordHash: "x",
        role,
        organizationId: org,
        regionId,
      },
    });

  const a = await user("Run Admin", Role.ADMIN, orgId);
  admin = { id: a.id, role: Role.ADMIN, organizationId: orgId };
  const oa = await user("Other Admin", Role.ADMIN, otherOrgId);
  otherAdmin = { id: oa.id, role: Role.ADMIN, organizationId: otherOrgId };

  presentId = (await user("Anu Present", Role.MEMBER, orgId, chennai.id)).id;
  wfhId = (await user("Bala Wfh", Role.MEMBER, orgId, chennai.id)).id;
  leaveId = (await user("Chitra Leave", Role.MEMBER, orgId, chennai.id)).id;

  await prisma.attendance.createMany({
    data: [
      { userId: presentId, organizationId: orgId, date: d(TODAY), status: AttendanceStatus.PRESENT, markedById: a.id },
      { userId: wfhId, organizationId: orgId, date: d(TODAY), status: AttendanceStatus.WFH, markedById: a.id },
    ],
  });

  const el = await prisma.leavePolicy.create({
    data: { organizationId: orgId, name: "Earned Leave (EL)", allowance: 12, effectiveFrom: d("2026-01-01") },
  });
  const short = await prisma.leavePolicy.create({
    data: {
      organizationId: orgId,
      name: "Short leave",
      allowance: 4,
      unit: "USES",
      position: 3,
      effectiveFrom: d("2026-01-01"),
    },
  });

  const leave = (userId: string, policyId: string, from: string, to: string, status: LeaveRequestStatus) =>
    prisma.leaveRequest.create({
      data: { organizationId: orgId, userId, policyId, startDate: d(from), endDate: d(to), cost: 1, status },
    });

  await leave(leaveId, el.id, TODAY, TODAY, LeaveRequestStatus.APPROVED);
  await leave(leaveId, el.id, "2026-10-30", "2026-11-03", LeaveRequestStatus.APPROVED);
  // None of these make a day "on leave".
  await leave(presentId, el.id, "2026-11-10", "2026-11-10", LeaveRequestStatus.PENDING);
  await leave(presentId, el.id, "2026-11-11", "2026-11-11", LeaveRequestStatus.REJECTED);
  await leave(presentId, short.id, "2026-11-12", "2026-11-12", LeaveRequestStatus.APPROVED);

  await prisma.holiday.create({
    data: { organizationId: orgId, regionId: delhiId, name: "Delhi Day", startDate: d("2026-11-09"), endDate: d("2026-11-09") },
  });
  await prisma.holiday.create({
    data: { organizationId: orgId, regionId: null, name: "Founders Day", startDate: d("2026-11-13"), endDate: d("2026-11-13") },
  });
});

afterAll(async () => {
  for (const id of [orgId, otherOrgId]) {
    await prisma.attendance.deleteMany({ where: { organizationId: id } });
    await prisma.leaveRequest.deleteMany({ where: { organizationId: id } });
    await prisma.leavePolicy.deleteMany({ where: { organizationId: id } });
    await prisma.holiday.deleteMany({ where: { organizationId: id } });
    await prisma.user.deleteMany({ where: { organizationId: id } });
    await prisma.region.deleteMany({ where: { organizationId: id } });
    await prisma.organization.delete({ where: { id } });
  }
  await prisma.$disconnect();
});

describe("todayOverview", () => {
  it("counts a mark, a WFH mark and approved leave", async () => {
    const view = await todayOverview(admin, TODAY);

    expect(view.date).toBe(TODAY);
    expect(view.total).toBe(3);
    expect(view.counts).toEqual({ PRESENT: 1, WFH: 1, ABSENT: 0, LEAVE: 1, NOT_MARKED: 0 });
    expect(view.people.map((p) => p.name)).toEqual(["Anu Present", "Bala Wfh", "Chitra Leave"]);
    expect(view.people[2]?.today).toEqual({ date: TODAY, kind: "LEAVE", detail: "Earned Leave (EL)" });
    expect(view.people[0]?.region).toBe("Chennai");
  });

  it("refuses a member", async () => {
    await expect(
      todayOverview({ id: presentId, role: Role.MEMBER, organizationId: orgId }, TODAY),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("memberPeriod", () => {
  it("counts only the leave days inside the period", async () => {
    const view = await memberPeriod(admin, leaveId, "month", "2026-11-05", TODAY);

    expect(view.range).toEqual({ from: "2026-11-01", to: TODAY, label: "November 2026" });
    const leaveDays = view.days.filter((day) => day.kind === "LEAVE").map((day) => day.date);
    expect(leaveDays.sort()).toEqual(["2026-11-02", "2026-11-03", TODAY]);
    expect(view.days[0]?.date).toBe(TODAY); // newest first
    expect(view.days.at(-1)?.date).toBe("2026-11-01");
    expect(view.days.find((day) => day.date === "2026-11-01")?.kind).toBe("WEEKEND");
  });

  it("ignores pending, rejected and short leave", async () => {
    const view = await memberPeriod(admin, presentId, "month", TODAY, TODAY);
    const kinds = Object.fromEntries(view.days.map((day) => [day.date, day.kind]));

    expect(kinds["2026-11-10"]).toBe("NOT_MARKED");
    expect(kinds["2026-11-11"]).toBe("NOT_MARKED");
    expect(kinds["2026-11-12"]).toBe("NOT_MARKED");
    expect(kinds[TODAY]).toBe("PRESENT");
  });

  it("applies org-wide holidays but not another region's", async () => {
    const view = await memberPeriod(admin, presentId, "month", TODAY, TODAY);
    const byDate = Object.fromEntries(view.days.map((day) => [day.date, day]));

    expect(byDate["2026-11-09"]?.kind).toBe("NOT_MARKED"); // Delhi's holiday, Chennai member
    expect(byDate["2026-11-13"]).toEqual({ date: "2026-11-13", kind: "HOLIDAY", detail: "Founders Day" });
  });

  it("covers a quarter", async () => {
    const view = await memberPeriod(admin, leaveId, "quarter", TODAY, TODAY);
    expect(view.range.label).toBe("Q4 2026");
    expect(view.days.some((day) => day.date === "2026-10-30" && day.kind === "LEAVE")).toBe(true);
  });

  it("hides another organization's member", async () => {
    await expect(memberPeriod(otherAdmin, leaveId, "month", TODAY, TODAY)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("refuses a member", async () => {
    await expect(
      memberPeriod({ id: presentId, role: Role.MEMBER, organizationId: orgId }, presentId, "month", TODAY, TODAY),
    ).rejects.toMatchObject({ status: 403 });
  });
});
