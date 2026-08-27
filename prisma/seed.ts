import "dotenv/config";

import { Role } from "../generated/prisma/enums";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../lib/password";
import { prisma } from "../lib/prisma";

/**
 * Seeds the default "Stacx" organization and one Admin inside it.
 *
 * Idempotent: the organization upserts by name and the admin by email, so
 * re-running changes nothing. The SuperAdmin is intentionally *not* seeded —
 * it stays CLI-only (scripts/create-superadmin.ts).
 *
 *   npm run seed
 */

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

  const passwordHash = await hashPassword(adminPassword);

  // One transaction: the org and its admin land together or not at all.
  const { organization, admin } = await prisma.$transaction(async (tx) => {
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

    return { organization, admin };
  });

  console.log(
    `Seeded organization "${organization.name}" (${organization.id}) with admin ${admin.email}`,
  );
}

main()
  .catch((error: unknown) => {
    console.error("Seed failed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
