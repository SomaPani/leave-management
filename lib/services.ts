import { EmploymentStatus, Role, WorkMode } from "@/generated/prisma/enums";
import { hashPassword, isAcceptablePassword, MIN_PASSWORD_LENGTH } from "@/lib/password";
import { prisma } from "@/lib/prisma";
import {
  type Actor,
  HttpError,
  assertOrgInvariant,
  canCreateAdmin,
  canCreateOrganization,
  canDeleteAdmin,
  canDeleteMember,
  canDeleteOrganization,
  canListMembers,
  canListOrganizations,
  canListRegions,
  canManageRegions,
  canUpdateAdmin,
  canUpdateMember,
  canUpdateOrganization,
  memberOrganizationFor,
  visibleOrgId,
} from "@/lib/rbac";

/**
 * Everything that reads or writes the organization tables.
 *
 * Both entry points — the API route handlers and the Server Actions behind the
 * pages — go through here, so authorization is decided in exactly one place per
 * operation. Callers pass an `Actor` they have already authenticated; these
 * functions never look at a request body or a cookie themselves.
 */

const USER_FIELDS = {
  id: true,
  name: true,
  email: true,
  role: true,
  organizationId: true,
  createdAt: true,
} as const;

/**
 * What a member looks like to the Team screen: identity plus the profile the
 * screen renders.
 *
 * Deliberately separate from `USER_FIELDS`, which stays the identity-only shape
 * that organization and admin responses are built from. An admin has no title
 * and no region, so widening `USER_FIELDS` would only pad `/api/admins` with
 * nulls and change a response contract that has nothing to do with Team.
 */
const MEMBER_FIELDS = {
  ...USER_FIELDS,
  title: true,
  empId: true,
  joinedOn: true,
  workMode: true,
  status: true,
  phone: true,
  personalEmail: true,
  address: true,
  emergencyName: true,
  emergencyPhone: true,
  region: { select: { id: true, name: true } },
  manager: { select: { id: true, name: true } },
} as const;

const REGION_FIELDS = {
  id: true,
  name: true,
  organizationId: true,
  createdAt: true,
} as const;

/**
 * The profile fields a member carries on the Team screen.
 *
 * `undefined` means "leave alone" and `null` means "clear it" — the distinction
 * a PATCH needs, and the reason these are not plain optional strings.
 */
export type MemberProfileInput = {
  title?: string | null;
  empId?: string | null;
  joinedOn?: Date | null;
  workMode?: WorkMode | null;
  regionId?: string | null;
  managerId?: string | null;
  phone?: string | null;
  personalEmail?: string | null;
  address?: string | null;
  emergencyName?: string | null;
  emergencyPhone?: string | null;
};

/** Drops the keys the caller never mentioned, keeping explicit nulls. */
function pickDefined<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/**
 * A region the caller may point a member at.
 *
 * "Missing" and "belongs to another organization" answer identically and with a
 * 400 rather than a 404, so an admin cannot use this endpoint to probe which
 * region ids exist elsewhere.
 */
export async function assertRegionInOrg(
  regionId: string,
  organizationId: string,
): Promise<void> {
  const region = await prisma.region.findUnique({
    where: { id: regionId },
    select: { organizationId: true },
  });
  if (!region || region.organizationId !== organizationId) {
    throw new HttpError(400, "That region does not exist in your organization.");
  }
}

/**
 * A manager the caller may point a member at.
 *
 * Either an Admin or a Member of the same organization — a SuperAdmin carries
 * no organization, so the scope check already excludes them. Self-reference is
 * refused; longer reporting cycles (A reports to B reports to A) are not walked,
 * because nothing renders a reporting chain yet.
 */
async function assertManagerInOrg(
  managerId: string,
  organizationId: string,
  memberId?: string,
): Promise<void> {
  if (memberId && managerId === memberId) {
    throw new HttpError(400, "A member cannot report to themselves.");
  }

  const manager = await prisma.user.findUnique({
    where: { id: managerId },
    select: { organizationId: true },
  });
  if (!manager || manager.organizationId !== organizationId) {
    throw new HttpError(400, "That manager is not in your organization.");
  }
}

/**
 * Validates the cross-references in a profile and returns the columns to write.
 *
 * `regionId` and `managerId` arrive from the client, so both are checked against
 * the organization the caller is actually acting in — never against anything the
 * request claims. Same rule as `memberOrganizationFor`.
 */
async function profileData(
  organizationId: string,
  input: MemberProfileInput,
  memberId?: string,
): Promise<Partial<MemberProfileInput>> {
  if (input.regionId) await assertRegionInOrg(input.regionId, organizationId);
  if (input.managerId) {
    await assertManagerInOrg(input.managerId, organizationId, memberId);
  }
  return pickDefined(input);
}

function assertPassword(password: unknown): asserts password is string {
  if (!isAcceptablePassword(password)) {
    throw new HttpError(
      400,
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    );
  }
}

/* --------------------------------------------------------- organizations -- */

export async function createOrganization(actor: Actor, input: { name: string }) {
  if (!canCreateOrganization(actor)) {
    throw new HttpError(403, "Only a superadmin can create organizations.");
  }

  const existing = await prisma.organization.findUnique({
    where: { name: input.name },
    select: { id: true },
  });
  if (existing) {
    throw new HttpError(409, "An organization with that name already exists.");
  }

  return prisma.organization.create({
    select: { id: true, name: true, createdAt: true },
    data: { name: input.name },
  });
}

export async function listOrganizations(actor: Actor) {
  if (!canListOrganizations(actor)) {
    throw new HttpError(403, "Only a superadmin can list organizations.");
  }

  return prisma.organization.findMany({
    select: {
      id: true,
      name: true,
      createdAt: true,
      _count: { select: { users: true } },
    },
    orderBy: { createdAt: "asc" },
  });
}

/* ---------------------------------------------------------------- admins -- */

export async function createAdmin(
  actor: Actor,
  input: { name: string; email: string; password: string; organizationId: string },
) {
  if (!canCreateAdmin(actor)) {
    throw new HttpError(403, "Only a superadmin can create admins.");
  }
  assertPassword(input.password);

  const organization = await prisma.organization.findUnique({
    where: { id: input.organizationId },
    select: { id: true },
  });
  if (!organization) throw new HttpError(400, "That organization does not exist.");

  assertOrgInvariant(Role.ADMIN, organization.id);

  return prisma.user.create({
    select: USER_FIELDS,
    data: {
      name: input.name,
      email: input.email,
      role: Role.ADMIN,
      passwordHash: await hashPassword(input.password),
      organizationId: organization.id,
      createdById: actor.id,
    },
  });
}

export async function listAdmins(actor: Actor) {
  if (!canListOrganizations(actor)) {
    throw new HttpError(403, "Only a superadmin can list admins.");
  }

  return prisma.user.findMany({
    where: { role: Role.ADMIN },
    select: { ...USER_FIELDS, organization: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
}

/* --------------------------------------------------------------- members -- */

export async function createMember(
  actor: Actor,
  input: MemberProfileInput & {
    name: string;
    email: string;
    password: string;
    /** Only ever used to reject a cross-org attempt — never to choose the org. */
    organizationId?: string | null;
  },
) {
  const { name, email, password, organizationId: claimed, ...profile } = input;

  const organizationId = memberOrganizationFor(actor, claimed);
  assertPassword(password);
  assertOrgInvariant(Role.MEMBER, organizationId);

  const fields = await profileData(organizationId, profile);

  return prisma.user.create({
    select: MEMBER_FIELDS,
    data: {
      ...fields,
      name,
      email,
      role: Role.MEMBER,
      passwordHash: await hashPassword(password),
      organizationId,
      createdById: actor.id,
    },
  });
}

/**
 * The member roster.
 *
 * Defaults to ACTIVE only — the Team screen wants the people who are on the
 * team, and a removal is a status change rather than a delete. Pass
 * `status: null` for everyone, past and present.
 */
export async function listMembers(
  actor: Actor,
  filter: { status?: EmploymentStatus | null; regionId?: string } = {},
) {
  if (!canListMembers(actor)) {
    throw new HttpError(403, "Your role does not permit listing members.");
  }

  // null => every organization, and only ever for a SuperAdmin.
  const scope = visibleOrgId(actor);
  const status = filter.status === undefined ? EmploymentStatus.ACTIVE : filter.status;

  return prisma.user.findMany({
    where: {
      role: Role.MEMBER,
      ...(scope === null ? {} : { organizationId: scope }),
      ...(status === null ? {} : { status }),
      ...(filter.regionId ? { regionId: filter.regionId } : {}),
    },
    select: { ...MEMBER_FIELDS, organization: { select: { name: true } } },
    orderBy: { name: "asc" },
  });
}

/* ------------------------------------------------- update and delete --- */

/**
 * A user targeted by id, narrowed to one role.
 *
 * `/api/admins/[id]` must not be able to reach a MEMBER or a SUPERADMIN, and
 * `/api/members/[id]` must not reach an ADMIN — otherwise the role check on the
 * route would be decorative and either endpoint could act on any account.
 * SuperAdmins are unreachable from both: they exist only through the CLI.
 */
async function findUserWithRole(id: string, role: Role) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, role: true, organizationId: true },
  });
  if (!user || user.role !== role) {
    throw new HttpError(404, `No ${role.toLowerCase()} with that id.`);
  }
  return user;
}

/** Rejects an update that carries no fields at all. */
function assertSomethingToUpdate(input: Record<string, unknown>): void {
  const provided = Object.values(input).some((value) => value !== undefined);
  if (!provided) throw new HttpError(400, "Nothing to update.");
}

export async function updateOrganization(
  actor: Actor,
  id: string,
  input: { name: string },
) {
  if (!canUpdateOrganization(actor)) {
    throw new HttpError(403, "Only a superadmin can rename organizations.");
  }

  const organization = await prisma.organization.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!organization) throw new HttpError(404, "No organization with that id.");

  const clash = await prisma.organization.findUnique({
    where: { name: input.name },
    select: { id: true },
  });
  if (clash && clash.id !== id) {
    throw new HttpError(409, "An organization with that name already exists.");
  }

  return prisma.organization.update({
    where: { id },
    select: { id: true, name: true, createdAt: true },
    data: { name: input.name },
  });
}

/**
 * Deleting an organization is refused while anyone still belongs to it.
 *
 * `User.organizationId` is `ON DELETE SET NULL`, so an unguarded delete would
 * not fail — it would quietly strip the organization off every admin and member
 * in it, leaving accounts that are neither scoped nor SuperAdmin and that
 * `assertOrgInvariant` considers impossible. Emptying it first has to be a
 * deliberate act.
 */
export async function deleteOrganization(actor: Actor, id: string) {
  if (!canDeleteOrganization(actor)) {
    throw new HttpError(403, "Only a superadmin can delete organizations.");
  }

  const organization = await prisma.organization.findUnique({
    where: { id },
    select: { id: true, name: true, _count: { select: { users: true } } },
  });
  if (!organization) throw new HttpError(404, "No organization with that id.");

  if (organization._count.users > 0) {
    throw new HttpError(
      409,
      `"${organization.name}" still has ${organization._count.users} user(s). Remove them before deleting it.`,
    );
  }

  await prisma.organization.delete({ where: { id } });
  return { id, deleted: true as const };
}

export async function updateAdmin(
  actor: Actor,
  id: string,
  input: {
    name?: string;
    email?: string;
    password?: string;
    organizationId?: string;
  },
) {
  if (!canUpdateAdmin(actor)) {
    throw new HttpError(403, "Only a superadmin can update admins.");
  }
  assertSomethingToUpdate(input);
  await findUserWithRole(id, Role.ADMIN);

  if (input.password !== undefined) assertPassword(input.password);

  if (input.organizationId !== undefined) {
    const organization = await prisma.organization.findUnique({
      where: { id: input.organizationId },
      select: { id: true },
    });
    if (!organization) throw new HttpError(400, "That organization does not exist.");
    // An admin must always land in a real organization, never null.
    assertOrgInvariant(Role.ADMIN, organization.id);
  }

  return prisma.user.update({
    where: { id },
    select: USER_FIELDS,
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.organizationId !== undefined
        ? { organizationId: input.organizationId }
        : {}),
      ...(input.password !== undefined
        ? { passwordHash: await hashPassword(input.password) }
        : {}),
    },
  });
}

export async function deleteAdmin(actor: Actor, id: string) {
  if (!canDeleteAdmin(actor)) {
    throw new HttpError(403, "Only a superadmin can delete admins.");
  }
  await findUserWithRole(id, Role.ADMIN);

  await prisma.user.delete({ where: { id } });
  return { id, deleted: true as const };
}

export async function updateMember(
  actor: Actor,
  id: string,
  input: MemberProfileInput & {
    name?: string;
    email?: string;
    password?: string;
    status?: EmploymentStatus;
  },
) {
  assertSomethingToUpdate(input);
  const { name, email, password, status, ...profile } = input;
  const member = await findUserWithRole(id, Role.MEMBER);

  // Scope is checked against the member's stored organization, not anything the
  // request supplied.
  if (!canUpdateMember(actor, member.organizationId)) {
    throw new HttpError(403, "You can only manage members of your own organization.");
  }

  if (password !== undefined) assertPassword(password);

  // `member.organizationId` is non-null for a MEMBER — `assertOrgInvariant`
  // holds it so on every creation path — but the column is nullable to allow
  // the SuperAdmin row, so narrow it rather than asserting.
  if (!member.organizationId) {
    throw new HttpError(500, "That member has no organization.");
  }
  const fields = await profileData(member.organizationId, profile, id);

  return prisma.user.update({
    where: { id },
    select: MEMBER_FIELDS,
    data: {
      ...fields,
      ...(name !== undefined ? { name } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(password !== undefined
        ? { passwordHash: await hashPassword(password) }
        : {}),
    },
  });
}

/**
 * Take a member off the team, or put them back on.
 *
 * The Team screen's "remove" — a status change rather than `deleteMember`, so
 * the row survives for the leave and attendance records that will reference it.
 */
export async function setMemberStatus(
  actor: Actor,
  id: string,
  status: EmploymentStatus,
) {
  const member = await findUserWithRole(id, Role.MEMBER);

  if (!canUpdateMember(actor, member.organizationId)) {
    throw new HttpError(403, "You can only manage members of your own organization.");
  }

  return prisma.user.update({
    where: { id },
    select: MEMBER_FIELDS,
    data: { status },
  });
}

export async function deleteMember(actor: Actor, id: string) {
  const member = await findUserWithRole(id, Role.MEMBER);

  if (!canDeleteMember(actor, member.organizationId)) {
    throw new HttpError(403, "You can only manage members of your own organization.");
  }

  await prisma.user.delete({ where: { id } });
  return { id, deleted: true as const };
}

/* --------------------------------------------------------------- regions -- */

/**
 * The organization a region operation acts in.
 *
 * Always the Admin's own, from their session. There is no claimed-id parameter
 * to reject here because no region endpoint accepts one: an admin has exactly
 * one organization, so naming it would only create a way to get it wrong.
 */
function regionOrganizationFor(actor: Actor): string {
  const organizationId = actor.organizationId;
  if (!organizationId || !canManageRegions(actor, organizationId)) {
    throw new HttpError(403, "Only an organization admin can manage regions.");
  }
  return organizationId;
}

/** A region by id, with the organization its scope is decided against. */
async function findRegion(id: string) {
  const region = await prisma.region.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      organizationId: true,
      _count: { select: { users: true } },
    },
  });
  if (!region) throw new HttpError(404, "No region with that id.");
  return region;
}

export async function createRegion(actor: Actor, input: { name: string }) {
  const organizationId = regionOrganizationFor(actor);

  const existing = await prisma.region.findUnique({
    where: { organizationId_name: { organizationId, name: input.name } },
    select: { id: true },
  });
  if (existing) {
    throw new HttpError(409, "A region with that name already exists.");
  }

  return prisma.region.create({
    select: REGION_FIELDS,
    data: { name: input.name, organizationId },
  });
}

/**
 * The regions a caller can see, with how many members sit in each.
 *
 * Reading follows `canListMembers`: a SuperAdmin sees every organization's
 * regions even though `canManageRegions` will not let them change any.
 */
export async function listRegions(actor: Actor) {
  if (!canListRegions(actor)) {
    throw new HttpError(403, "Your role does not permit listing regions.");
  }

  const scope = visibleOrgId(actor);

  return prisma.region.findMany({
    where: scope === null ? {} : { organizationId: scope },
    select: { ...REGION_FIELDS, _count: { select: { users: true } } },
    orderBy: { name: "asc" },
  });
}

export async function updateRegion(actor: Actor, id: string, input: { name: string }) {
  const region = await findRegion(id);

  // Scope is decided against the region's stored organization, never the
  // caller's claim — the same rule as `updateMember`.
  if (!canManageRegions(actor, region.organizationId)) {
    throw new HttpError(403, "You can only manage regions in your own organization.");
  }

  const clash = await prisma.region.findUnique({
    where: {
      organizationId_name: { organizationId: region.organizationId, name: input.name },
    },
    select: { id: true },
  });
  if (clash && clash.id !== id) {
    throw new HttpError(409, "A region with that name already exists.");
  }

  return prisma.region.update({
    where: { id },
    select: REGION_FIELDS,
    data: { name: input.name },
  });
}

/**
 * Deleting a region is refused while anyone is still in it.
 *
 * `User.regionId` is `ON DELETE SET NULL`, so an unguarded delete would not
 * fail — it would quietly drop every member out of their region and off the
 * Team screen's grouping. Emptying it first has to be deliberate. Same
 * reasoning as `deleteOrganization`.
 */
export async function deleteRegion(actor: Actor, id: string) {
  const region = await findRegion(id);

  if (!canManageRegions(actor, region.organizationId)) {
    throw new HttpError(403, "You can only manage regions in your own organization.");
  }

  if (region._count.users > 0) {
    throw new HttpError(
      409,
      `"${region.name}" still has ${region._count.users} member(s). Move them before deleting it.`,
    );
  }

  await prisma.region.delete({ where: { id } });
  return { id, deleted: true as const };
}
