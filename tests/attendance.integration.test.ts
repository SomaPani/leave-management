import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

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
