import { spawnSync } from "node:child_process";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { EmploymentStatus, Role, WorkMode } from "@/generated/prisma/enums";
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

/**
 * The Team half of the seed.
 *
 * Every case names its own organization, because the seed accumulates: regions
 * upsert into whichever organization the run is pointed at, so sharing one
 * would make the assertions depend on test order.
 *
 * `STACX_MEMBER_*` is blanked explicitly wherever a run should not touch a
 * member. It cannot be left to chance: tests/setup.ts loads .env into the
 * vitest process and `run` forwards `process.env` to the subprocess, so a
 * developer's real member configuration is inherited unless it is overridden.
 */
describe("seed: regions and the sample member", { timeout: 120_000 }, () => {
  const NO_MEMBER = {
    STACX_MEMBER_NAME: BLANK,
    STACX_MEMBER_EMAIL: BLANK,
    STACX_MEMBER_PASSWORD: BLANK,
  };

  /** A seed run against its own organization. */
  function seedInto(label: string, env: Record<string, string> = {}) {
    const orgName = `${RUN}-${label}`;
    const result = seed({
      STACX_ORG_NAME: orgName,
      STACX_ADMIN_NAME: `${label} Admin`,
      STACX_ADMIN_EMAIL: `${RUN}-${label}-admin@example.test`,
      STACX_ADMIN_PASSWORD: "a-long-enough-password",
      ...NO_MEMBER,
      ...env,
    });
    return { orgName, adminEmail: `${RUN}-${label}-admin@example.test`, ...result };
  }

  const regionsOf = (orgName: string) =>
    prisma.region.findMany({
      where: { organization: { name: orgName } },
      select: { name: true },
      orderBy: { name: "asc" },
    });

  it("defaults to Chennai and Delhi when STACX_REGIONS is unset", async () => {
    const { orgName, status } = seedInto("rdefault", { STACX_REGIONS: BLANK });
    expect(status).toBe(0);
    expect((await regionsOf(orgName)).map((r) => r.name)).toEqual(["Chennai", "Delhi"]);
  });

  it("honours STACX_REGIONS, trimming and de-duplicating", async () => {
    const { orgName, status } = seedInto("rcustom", {
      STACX_REGIONS: " South , North ,South",
    });
    expect(status).toBe(0);
    expect((await regionsOf(orgName)).map((r) => r.name)).toEqual(["North", "South"]);
  });

  it("is re-runnable without duplicating regions", async () => {
    const first = seedInto("rrepeat", { STACX_REGIONS: "Chennai,Delhi" });
    expect(first.status).toBe(0);
    expect(seedInto("rrepeat", { STACX_REGIONS: "Chennai,Delhi" }).status).toBe(0);

    expect(await prisma.region.count({ where: { organization: { name: first.orgName } } })).toBe(2);
  });

  it("skips the member when STACX_MEMBER_* is unset", async () => {
    const { orgName, stdout, status } = seedInto("mskip");
    expect(status).toBe(0);
    expect(stdout).toContain("Member: skipped");

    const members = await prisma.user.count({
      where: { role: Role.MEMBER, organization: { name: orgName } },
    });
    expect(members).toBe(0);
  });

  it("creates the member with a profile, in the first region, reporting to the admin", async () => {
    const email = `${RUN}-member@example.test`;
    const { orgName, adminEmail, status } = seedInto("mmake", {
      STACX_REGIONS: "Chennai,Delhi",
      STACX_MEMBER_NAME: "Test Member",
      STACX_MEMBER_EMAIL: email,
      STACX_MEMBER_PASSWORD: "a-long-enough-password",
    });
    expect(status).toBe(0);

    const member = await prisma.user.findUnique({
      where: { email },
      select: {
        role: true,
        status: true,
        title: true,
        empId: true,
        workMode: true,
        joinedOn: true,
        passwordHash: true,
        organization: { select: { name: true } },
        region: { select: { name: true } },
        manager: { select: { email: true } },
      },
    });

    expect(member).toMatchObject({
      role: Role.MEMBER,
      status: EmploymentStatus.ACTIVE,
      title: "Copywriter",
      empId: "STX-0001",
      workMode: WorkMode.WFO,
      organization: { name: orgName },
      region: { name: "Chennai" },
      manager: { email: adminEmail },
    });
    expect(member?.joinedOn).not.toBeNull();
    expect(member?.passwordHash.startsWith("$2")).toBe(true);
  });

  it("fails fast when the member password is too short", () => {
    const result = seedInto("mshort", {
      STACX_MEMBER_EMAIL: `${RUN}-short@example.test`,
      STACX_MEMBER_PASSWORD: "short",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("STACX_MEMBER_PASSWORD");
  });

  /**
   * The case this guard exists for: the member email is pinned in .env while
   * the organization name is not, so a run aimed elsewhere would otherwise
   * move a real member into whichever organization it just built.
   */
  it("refuses to move a member that belongs to another organization", async () => {
    const email = `${RUN}-settled@example.test`;
    const home = seedInto("mhome", {
      STACX_MEMBER_EMAIL: email,
      STACX_MEMBER_PASSWORD: "a-long-enough-password",
    });
    expect(home.status).toBe(0);

    const elsewhere = seedInto("melsewhere", {
      STACX_MEMBER_EMAIL: email,
      STACX_MEMBER_PASSWORD: "a-long-enough-password",
    });
    expect(elsewhere.status).toBe(0);
    expect(elsewhere.stdout).toContain("belongs to another organization");

    const settled = await prisma.user.findUnique({
      where: { email },
      select: { organization: { select: { name: true } } },
    });
    expect(settled?.organization?.name).toBe(home.orgName);
  });

  it("refuses to convert an account that holds another role", async () => {
    const { adminEmail, stdout, status } = seedInto("mrole", {
      STACX_MEMBER_EMAIL: `${RUN}-mrole-admin@example.test`,
      STACX_MEMBER_PASSWORD: "a-long-enough-password",
    });
    expect(status).toBe(0);
    expect(stdout).toContain("already exists as ADMIN");

    const stillAdmin = await prisma.user.findUnique({
      where: { email: adminEmail },
      select: { role: true },
    });
    expect(stillAdmin?.role).toBe(Role.ADMIN);
  });
});
