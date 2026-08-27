import { spawnSync } from "node:child_process";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";

/**
 * The CLI and the seed, run the way an operator runs them.
 *
 * Spawned as real subprocesses rather than imported, because "fails fast with a
 * clear message" is about the exit code and stderr — behaviour you only see
 * from the outside. Each run is pointed at its own throwaway organization and
 * email so it can share the development database safely.
 *
 * Note `dotenv` does not override variables that are already set, so the env
 * passed here wins over .env. A blank-but-present value is how the
 * missing-variable cases are exercised: it survives Windows' env handling,
 * where a truly empty string can be dropped.
 */

const ROOT = process.cwd();
const RUN = `stest-${Date.now().toString(36)}`;
const BLANK = "   ";

function run(script: string, env: Record<string, string>) {
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), script],
    {
      cwd: ROOT,
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const superadmin = (env: Record<string, string>) =>
  run("scripts/create-superadmin.ts", env);
const seed = (env: Record<string, string>) => run("prisma/seed.ts", env);

const SU_EMAIL = `${RUN}-super@example.test`;
const ORG_NAME = `${RUN}-Org`;
const ADMIN_EMAIL = `${RUN}-admin@example.test`;

const SU_ENV = {
  SUPERADMIN_NAME: "Test Super",
  SUPERADMIN_EMAIL: SU_EMAIL,
  SUPERADMIN_PASSWORD: "a-long-enough-password",
};

const SEED_ENV = {
  STACX_ORG_NAME: ORG_NAME,
  STACX_ADMIN_NAME: "Test Admin",
  STACX_ADMIN_EMAIL: ADMIN_EMAIL,
  STACX_ADMIN_PASSWORD: "a-long-enough-password",
};

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { startsWith: RUN } } });
  await prisma.organization.deleteMany({ where: { name: { startsWith: RUN } } });
  await prisma.$disconnect();
});

describe("create-superadmin CLI", { timeout: 120_000 }, () => {
  it("fails fast when a variable is missing", () => {
    const result = superadmin({ ...SU_ENV, SUPERADMIN_EMAIL: BLANK });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SUPERADMIN_EMAIL");
  });

  it("fails fast when the password is too short", () => {
    const result = superadmin({ ...SU_ENV, SUPERADMIN_PASSWORD: "short" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SUPERADMIN_PASSWORD");
  });

  it("creates a superadmin with no organization", async () => {
    const result = superadmin(SU_ENV);
    expect(result.status).toBe(0);

    const user = await prisma.user.findUnique({
      where: { email: SU_EMAIL },
      select: { role: true, organizationId: true, passwordHash: true },
    });
    expect(user?.role).toBe(Role.SUPERADMIN);
    expect(user?.organizationId).toBeNull();
    expect(user?.passwordHash.startsWith("$2")).toBe(true);
  });

  it("is re-runnable without duplicating", async () => {
    expect(superadmin(SU_ENV).status).toBe(0);
    expect(superadmin(SU_ENV).status).toBe(0);

    const count = await prisma.user.count({ where: { email: SU_EMAIL } });
    expect(count).toBe(1);
  });

  it("re-hashes on re-run, so the password can be rotated", async () => {
    superadmin(SU_ENV);
    const before = await prisma.user.findUnique({
      where: { email: SU_EMAIL },
      select: { passwordHash: true },
    });

    superadmin({ ...SU_ENV, SUPERADMIN_PASSWORD: "a-different-password" });
    const after = await prisma.user.findUnique({
      where: { email: SU_EMAIL },
      select: { passwordHash: true },
    });

    expect(after?.passwordHash).not.toBe(before?.passwordHash);
  });
});

describe("seed", { timeout: 120_000 }, () => {
  it("fails fast when a variable is missing", () => {
    const result = seed({ ...SEED_ENV, STACX_ADMIN_EMAIL: BLANK });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("STACX_ADMIN_EMAIL");
  });

  it("creates the organization and an admin that belongs to it", async () => {
    expect(seed(SEED_ENV).status).toBe(0);

    const admin = await prisma.user.findUnique({
      where: { email: ADMIN_EMAIL },
      select: { role: true, organization: { select: { name: true } } },
    });
    expect(admin?.role).toBe(Role.ADMIN);
    expect(admin?.organization?.name).toBe(ORG_NAME);
  });

  it("is re-runnable without duplicating the organization or the admin", async () => {
    expect(seed(SEED_ENV).status).toBe(0);
    expect(seed(SEED_ENV).status).toBe(0);

    expect(await prisma.organization.count({ where: { name: ORG_NAME } })).toBe(1);
    expect(await prisma.user.count({ where: { email: ADMIN_EMAIL } })).toBe(1);
  });

  it("does not create a superadmin — that stays CLI-only", async () => {
    seed(SEED_ENV);
    const superadmins = await prisma.user.count({
      where: { role: Role.SUPERADMIN, email: { startsWith: RUN } },
    });
    // Only the one the CLI test made, never one from the seed.
    expect(superadmins).toBeLessThanOrEqual(1);
  });
});
