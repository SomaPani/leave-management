import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Role, WorkMode } from "@/generated/prisma/enums";
import { formatDayMonthYear } from "@/lib/date";
import type { Actor } from "@/lib/rbac";

/**
 * /profile — the signed-in person's own record, read from Postgres.
 *
 * The service takes no user id: the record is the actor's, so the test checks
 * that every field the page shows comes back from the row, and that an empty
 * profile reads as nulls rather than another person's sample data.
 */

const { prisma } = await import("@/lib/prisma");
const { ownProfileDetails } = await import("@/lib/services");

const RUN = `profile-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

let orgId = "";
let manager: Actor;
let member: Actor;
let bare: Actor;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `${RUN} Org` } });
  orgId = org.id;
  const region = await prisma.region.create({
    data: { name: `${RUN} Delhi`, organizationId: org.id },
  });

  const boss = await prisma.user.create({
    data: {
      name: "Ananya Rao",
      email: email("boss"),
      passwordHash: "x",
      role: Role.ADMIN,
      organizationId: org.id,
    },
  });
  manager = { id: boss.id, role: Role.ADMIN, organizationId: org.id };

  const full = await prisma.user.create({
    data: {
      name: "Sahil Thakur",
      email: email("sahil"),
      passwordHash: "x",
      role: Role.MEMBER,
      organizationId: org.id,
      title: "Developer",
      empId: "STX-123",
      joinedOn: new Date("2026-09-01T00:00:00.000Z"),
      workMode: WorkMode.WFH,
      regionId: region.id,
      managerId: boss.id,
      phone: "+91 90000 00000",
      personalEmail: "sahil@personal.test",
      address: "1 Test Road, Delhi",
      permanentAddress: "9 Home Street, Shimla",
      emergencyName: "Parent",
      emergencyPhone: "+91 91111 11111",
    },
  });
  member = { id: full.id, role: Role.MEMBER, organizationId: org.id };

  const empty = await prisma.user.create({
    data: {
      name: "New Joiner",
      email: email("new"),
      passwordHash: "x",
      role: Role.MEMBER,
      organizationId: org.id,
    },
  });
  bare = { id: empty.id, role: Role.MEMBER, organizationId: org.id };
});

afterAll(async () => {
  await prisma.user.updateMany({ where: { organizationId: orgId }, data: { managerId: null } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.region.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe("ownProfileDetails", () => {
  it("returns the signed-in member's own record from the database", async () => {
    const profile = await ownProfileDetails(member);

    expect(profile).toMatchObject({
      name: "Sahil Thakur",
      email: email("sahil"),
      title: "Developer",
      empId: "STX-123",
      joinedOn: "2026-09-01",
      workMode: "WFH",
      region: `${RUN} Delhi`,
      manager: "Ananya Rao",
      phone: "+91 90000 00000",
      personalEmail: "sahil@personal.test",
      address: "1 Test Road, Delhi",
      permanentAddress: "9 Home Street, Shimla",
      emergencyName: "Parent",
      emergencyPhone: "+91 91111 11111",
    });
  });

  it("returns nulls for fields nobody has filled in", async () => {
    const profile = await ownProfileDetails(bare);

    expect(profile.name).toBe("New Joiner");
    expect(profile).toMatchObject({
      title: null,
      empId: null,
      joinedOn: null,
      region: null,
      manager: null,
      phone: null,
      address: null,
      permanentAddress: null,
      emergencyName: null,
    });
  });

  it("only ever reads the actor's own row", async () => {
    const profile = await ownProfileDetails(manager);
    expect(profile.name).toBe("Ananya Rao");
  });
});

describe("formatDayMonthYear", () => {
  it("formats an ISO day as `3 Feb 2024`", () => {
    expect(formatDayMonthYear("2024-02-03")).toBe("3 Feb 2024");
    expect(formatDayMonthYear("2026-09-01")).toBe("1 Sep 2026");
  });

  it("returns a dash for a malformed date", () => {
    expect(formatDayMonthYear("not-a-date")).toBe("—");
  });
});
