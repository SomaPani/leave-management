import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Role } from "@/generated/prisma/enums";

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
