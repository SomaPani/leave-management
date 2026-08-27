import "dotenv/config";

import { Role } from "../generated/prisma/enums";
import { hashPassword, MIN_PASSWORD_LENGTH } from "../lib/password";
import { prisma } from "../lib/prisma";

/**
 * Creates or updates a SuperAdmin from environment variables.
 *
 * This is the *only* way a SuperAdmin is minted — no HTTP route creates one,
 * and the seed deliberately leaves them alone. Re-runnable: the same email
 * updates the existing record, a new email adds another SuperAdmin.
 *
 *   npm run create-superadmin
 */

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      `Missing ${name}. Set SUPERADMIN_NAME, SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD in .env.`,
    );
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const name = required("SUPERADMIN_NAME");
  const email = required("SUPERADMIN_EMAIL").toLowerCase();
  const password = required("SUPERADMIN_PASSWORD");

  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `SUPERADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    );
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, role: true },
  });

  if (existing && existing.role !== Role.SUPERADMIN) {
    console.error(
      `${email} already exists as ${existing.role}. Refusing to change an existing account's role.`,
    );
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);

  const superadmin = await prisma.user.upsert({
    where: { email },
    select: { id: true, email: true },
    // organizationId stays null: a SuperAdmin belongs to no organization.
    create: { name, email, passwordHash, role: Role.SUPERADMIN, organizationId: null },
    update: { name, passwordHash, role: Role.SUPERADMIN, organizationId: null },
  });

  console.log(
    `${existing ? "Updated" : "Created"} superadmin ${superadmin.email} (${superadmin.id})`,
  );
}

main()
  .catch((error: unknown) => {
    console.error("Failed to create superadmin:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
