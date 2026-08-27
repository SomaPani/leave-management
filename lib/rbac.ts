import { Role } from "@/generated/prisma/enums";

/**
 * Authorization policy for the organization backbone.
 *
 * The `can*` predicates at the top are pure functions of an actor and the thing
 * being acted on — no session, no database — so the whole allow/deny matrix is
 * unit-testable. The `require*` guards below wrap them for use inside route
 * handlers, and throw `HttpError` so a handler can turn any denial into the
 * right status code without a chain of if-statements.
 */

/** The caller, reduced to what any policy decision needs. */
export type Actor = {
  id: string;
  role: Role;
  /** Null only for SUPERADMIN. */
  organizationId: string | null;
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/* ---------------------------------------------------------------- policy -- */

export function canCreateOrganization(actor: Actor): boolean {
  return actor.role === Role.SUPERADMIN;
}

export function canCreateAdmin(actor: Actor): boolean {
  return actor.role === Role.SUPERADMIN;
}

/**
 * Members are created by the Admin of their own organization.
 *
 * SuperAdmin is deliberately excluded: the design's hierarchy is a strict
 * creation chain (SuperAdmin -> Organization -> Admin -> Member), and its
 * permission table lists only Organizations and Admins under what a SuperAdmin
 * creates. SuperAdmin still *sees* every organization — that's `visibleOrgId`
 * below. Widening this to SuperAdmin is a one-line change here.
 */
export function canCreateMember(actor: Actor, targetOrganizationId: string): boolean {
  return actor.role === Role.ADMIN && actor.organizationId === targetOrganizationId;
}

export function canUpdateOrganization(actor: Actor): boolean {
  return actor.role === Role.SUPERADMIN;
}

export function canDeleteOrganization(actor: Actor): boolean {
  return actor.role === Role.SUPERADMIN;
}

export function canUpdateAdmin(actor: Actor): boolean {
  return actor.role === Role.SUPERADMIN;
}

export function canDeleteAdmin(actor: Actor): boolean {
  return actor.role === Role.SUPERADMIN;
}

/**
 * Members are edited and removed by the Admin of their own organization — the
 * same rule as `canCreateMember`, and deliberately not widened to SuperAdmin so
 * that who-manages-members has exactly one answer.
 */
export function canUpdateMember(actor: Actor, memberOrganizationId: string | null): boolean {
  return actor.role === Role.ADMIN && actor.organizationId === memberOrganizationId;
}

export function canDeleteMember(actor: Actor, memberOrganizationId: string | null): boolean {
  return canUpdateMember(actor, memberOrganizationId);
}

export function canListOrganizations(actor: Actor): boolean {
  return actor.role === Role.SUPERADMIN;
}

export function canListMembers(actor: Actor): boolean {
  return actor.role === Role.SUPERADMIN || actor.role === Role.ADMIN;
}

/**
 * Which organization a list request is scoped to: `null` means "every
 * organization" and is only ever returned for a SuperAdmin.
 */
export function visibleOrgId(actor: Actor): string | null {
  return actor.role === Role.SUPERADMIN ? null : actor.organizationId;
}

/**
 * The organization a newly created Member belongs to.
 *
 * Always the creating Admin's own organization, taken from their session — a
 * client-supplied `organizationId` is never trusted here. Callers pass whatever
 * the request body claimed only so a mismatch can be rejected explicitly rather
 * than silently rewritten.
 */
export function memberOrganizationFor(actor: Actor, claimed?: string | null): string {
  if (actor.role !== Role.ADMIN || !actor.organizationId) {
    throw new HttpError(403, "Only an organization admin can create members.");
  }
  if (claimed && claimed !== actor.organizationId) {
    throw new HttpError(403, "You can only create members in your own organization.");
  }
  return actor.organizationId;
}

/* ---------------------------------------------------------------- guards -- */

/** Requires a signed-in caller. */
export function requireActor(actor: Actor | null | undefined): Actor {
  if (!actor) throw new HttpError(401, "You must be signed in.");
  return actor;
}

/** Requires a signed-in caller holding one of `roles`. */
export function requireRole(actor: Actor | null | undefined, ...roles: Role[]): Actor {
  const caller = requireActor(actor);
  if (!roles.includes(caller.role)) {
    throw new HttpError(403, "Your role does not permit this action.");
  }
  return caller;
}

/**
 * Requires the caller to be acting inside `organizationId`. SuperAdmin passes
 * for any organization; everyone else only for their own.
 */
export function requireOrg(
  actor: Actor | null | undefined,
  organizationId: string,
): Actor {
  const caller = requireActor(actor);
  if (caller.role === Role.SUPERADMIN) return caller;
  if (caller.organizationId !== organizationId) {
    throw new HttpError(403, "That organization is outside your scope.");
  }
  return caller;
}

/**
 * Every ADMIN and MEMBER must carry an organization, and every SUPERADMIN must
 * not. The column is nullable to allow the SuperAdmin row, so this is the
 * invariant that keeps the rest honest — creation paths run it before writing.
 */
export function assertOrgInvariant(role: Role, organizationId: string | null): void {
  if (role === Role.SUPERADMIN && organizationId !== null) {
    throw new HttpError(400, "A superadmin cannot belong to an organization.");
  }
  if (role !== Role.SUPERADMIN && !organizationId) {
    throw new HttpError(400, `A ${role.toLowerCase()} must belong to an organization.`);
  }
}
