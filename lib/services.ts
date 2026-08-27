import { Role } from "@/generated/prisma/enums";
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
  input: {
    name: string;
    email: string;
    password: string;
    /** Only ever used to reject a cross-org attempt — never to choose the org. */
    organizationId?: string | null;
  },
) {
  const organizationId = memberOrganizationFor(actor, input.organizationId);
  assertPassword(input.password);
  assertOrgInvariant(Role.MEMBER, organizationId);

  return prisma.user.create({
    select: USER_FIELDS,
    data: {
      name: input.name,
      email: input.email,
      role: Role.MEMBER,
      passwordHash: await hashPassword(input.password),
      organizationId,
      createdById: actor.id,
    },
  });
}

export async function listMembers(actor: Actor) {
  if (!canListMembers(actor)) {
    throw new HttpError(403, "Your role does not permit listing members.");
  }

  // null => every organization, and only ever for a SuperAdmin.
  const scope = visibleOrgId(actor);

  return prisma.user.findMany({
    where: {
      role: Role.MEMBER,
      ...(scope === null ? {} : { organizationId: scope }),
    },
    select: { ...USER_FIELDS, organization: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
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
  input: { name?: string; email?: string; password?: string },
) {
  assertSomethingToUpdate(input);
  const member = await findUserWithRole(id, Role.MEMBER);

  // Scope is checked against the member's stored organization, not anything the
  // request supplied.
  if (!canUpdateMember(actor, member.organizationId)) {
    throw new HttpError(403, "You can only manage members of your own organization.");
  }

  if (input.password !== undefined) assertPassword(input.password);

  return prisma.user.update({
    where: { id },
    select: USER_FIELDS,
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.password !== undefined
        ? { passwordHash: await hashPassword(input.password) }
        : {}),
    },
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
