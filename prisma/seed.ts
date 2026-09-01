import "dotenv/config";

import { Role, WorkMode } from "../generated/prisma/enums";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../lib/password";
import { prisma } from "../lib/prisma";
import type { Prisma } from "../generated/prisma/client";

/**
 * Seeds the default "Stacx" organization, one Admin inside it, the regions the
 * Team screen groups by, and optionally one sample Member.
 *
 * Idempotent: the organization upserts by name, the admin and member by email,
 * and each region by (organization, name), so re-running changes nothing. The
 * SuperAdmin is intentionally *not* seeded — it stays CLI-only
 * (scripts/create-superadmin.ts).
 *
 *   npm run seed
 */

/** Used when STACX_REGIONS is not set. */
const DEFAULT_REGIONS = ["Chennai", "Delhi"];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      `Missing ${name}. Set STACX_ORG_NAME, STACX_ADMIN_NAME, STACX_ADMIN_EMAIL and STACX_ADMIN_PASSWORD in .env.`,
    );
    process.exit(1);
  }
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

/** `STACX_REGIONS` as a comma-separated list, de-duplicated and order-preserving. */
function regionNames(): string[] {
  const configured = optional("STACX_REGIONS");
  const names = (configured ? configured.split(",") : DEFAULT_REGIONS)
    .map((name) => name.trim())
    .filter(Boolean);
  return [...new Set(names)];
}

/**
 * The sample member, or `null` when the seed should not touch one.
 *
 * Optional on purpose. The admin is what the organization needs to function;
 * a member is only there so a fresh database renders a populated Team screen
 * rather than an empty one. Leaving `STACX_MEMBER_*` unset skips it entirely,
 * which is also what keeps `npm run seed` working for an .env written before
 * these variables existed.
 */
function memberConfig(): { name: string; email: string; password: string } | null {
  const email = optional("STACX_MEMBER_EMAIL")?.toLowerCase();
  const password = optional("STACX_MEMBER_PASSWORD");
  if (!email || !password) return null;

  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `STACX_MEMBER_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    );
    process.exit(1);
  }

  return { name: optional("STACX_MEMBER_NAME") ?? "Stacx Member", email, password };
}

/**
 * Upserts the sample member, or explains why it did not.
 *
 * The organization is deliberately never rewritten on an existing account. The
 * member email is usually pinned in .env while `STACX_ORG_NAME` is not — the
 * integration tests point the seed at a throwaway organization, for one — so an
 * unguarded upsert would quietly move a real member out of their organization
 * and into whichever one this run happened to build.
 */
async function upsertMember(
  tx: Prisma.TransactionClient,
  config: { name: string; email: string; password: string },
  passwordHash: string,
  organizationId: string,
  managerId: string,
  regionId: string | null,
): Promise<{ email: string } | string> {
  const existing = await tx.user.findUnique({
    where: { email: config.email },
    select: { role: true, organizationId: true },
  });

  if (existing && existing.role !== Role.MEMBER) {
    return `${config.email} already exists as ${existing.role}; left alone.`;
  }
  if (existing?.organizationId && existing.organizationId !== organizationId) {
    return `${config.email} belongs to another organization; left alone.`;
  }

  const profile = {
    name: config.name,
    passwordHash,
    title: "Copywriter",
    empId: "STX-0001",
    workMode: WorkMode.WFO,
    joinedOn: new Date("2024-02-03"),
    regionId,
    managerId,
  };

  return tx.user.upsert({
    where: { email: config.email },
    select: { email: true },
    create: {
      ...profile,
      email: config.email,
      role: Role.MEMBER,
      organizationId,
      createdById: managerId,
    },
    update: { ...profile, role: Role.MEMBER, organizationId },
  });
}

async function main(): Promise<void> {
  const orgName = required("STACX_ORG_NAME");
  const adminName = required("STACX_ADMIN_NAME");
  const adminEmail = required("STACX_ADMIN_EMAIL").toLowerCase();
  const adminPassword = required("STACX_ADMIN_PASSWORD");

  if (adminPassword.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `STACX_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    );
    process.exit(1);
  }

  // Validated before anything is written, so a bad value fails the run rather
  // than leaving the organization half-seeded.
  const member = memberConfig();

  const existing = await prisma.user.findUnique({
    where: { email: adminEmail },
    select: { role: true },
  });
  if (existing && existing.role !== Role.ADMIN) {
    console.error(
      `${adminEmail} already exists as ${existing.role}. Refusing to change an existing account's role.`,
    );
    process.exit(1);
  }

  // Hashing is deliberately outside the transaction: bcrypt at 12 rounds is
  // slow enough that holding a transaction open across it is wasteful.
  const passwordHash = await hashPassword(adminPassword);
  const memberHash = member ? await hashPassword(member.password) : null;

  // One transaction: the org, its admin, its regions and the sample member
  // land together or not at all.
  const seeded = await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.upsert({
      where: { name: orgName },
      select: { id: true, name: true },
      create: { name: orgName },
      update: {},
    });

    const admin = await tx.user.upsert({
      where: { email: adminEmail },
      select: { id: true, email: true },
      create: {
        name: adminName,
        email: adminEmail,
        passwordHash,
        role: Role.ADMIN,
        organizationId: organization.id,
      },
      update: {
        name: adminName,
        passwordHash,
        role: Role.ADMIN,
        organizationId: organization.id,
      },
    });

    const regions = [];
    for (const name of regionNames()) {
      regions.push(
        await tx.region.upsert({
          where: { organizationId_name: { organizationId: organization.id, name } },
          select: { id: true, name: true },
          create: { name, organizationId: organization.id },
          update: {},
        }),
      );
    }

    const memberResult =
      member && memberHash
        ? await upsertMember(
            tx,
            member,
            memberHash,
            organization.id,
            admin.id,
            regions[0]?.id ?? null,
          )
        : null;

    return { organization, admin, regions, memberResult };
  });

  console.log(
    `Seeded organization "${seeded.organization.name}" (${seeded.organization.id}) with admin ${seeded.admin.email}`,
  );
  console.log(
    `Regions: ${seeded.regions.map((region) => region.name).join(", ") || "none"}`,
  );

  if (seeded.memberResult === null) {
    console.log("Member: skipped (set STACX_MEMBER_EMAIL and STACX_MEMBER_PASSWORD).");
  } else if (typeof seeded.memberResult === "string") {
    console.log(`Member: ${seeded.memberResult}`);
  } else {
    console.log(`Member: ${seeded.memberResult.email}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error("Seed failed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
