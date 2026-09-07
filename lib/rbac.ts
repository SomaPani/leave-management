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

/**
 * Attendance is marked by the Admin of the member's own organization.
 *
 * Same rule as `canUpdateMember`, and deliberately not widened to SuperAdmin:
 * a SuperAdmin creates organizations and admins, and what happens inside an
 * organization is its admin's to record. Reading is the exception, below.
 *
 * A MEMBER is excluded even for their own row — attendance is an employer's
 * record of the day, not a self-service check-in.
 */
export function canMarkAttendance(
  actor: Actor,
  memberOrganizationId: string | null,
): boolean {
  return actor.role === Role.ADMIN && actor.organizationId === memberOrganizationId;
}

/**
 * A person may read their own attendance record.
 *
 * Deliberately self-only, and deliberately *not* satisfied by an admin: admins
 * read the roster through `canListAttendance`, which is org-scoped and already
 * covers them. Keeping this predicate to a single identity comparison means
 * the member calendar has exactly one way to be wrong, and it is a way that
 * fails closed.
 */
export function canReadOwnAttendance(actor: Actor, userId: string): boolean {
  return actor.id === userId;
}

/**
 * Regions — the groupings the Team screen lists people under — are created,
 * renamed and removed by the Admin of the organization they belong to.
 *
 * Covers all three verbs deliberately: a region has no lifecycle in which
 * creating it and renaming it answer to different people. Pass the *stored*
 * `Region.organizationId` when updating or deleting one, never an id from the
 * request — that is what stops an admin reaching into another organization's
 * regions, the same way `canUpdateMember` reads the member's own column.
 *
 * Not widened to SuperAdmin, matching `canCreateMember`: a SuperAdmin creates
 * organizations and admins, and what lives inside an organization is its
 * admin's to manage. `canListRegions` below is the read-side exception.
 */
export function canManageRegions(actor: Actor, regionOrganizationId: string): boolean {
  return actor.role === Role.ADMIN && actor.organizationId === regionOrganizationId;
}

/**
 * The holiday calendar is maintained by the Admin of the organization it
 * belongs to — the same rule as `canManageRegions`, and for the same reason:
 * a SuperAdmin creates organizations and admins, and what lives inside an
 * organization is its admin's to manage.
 *
 * Pass the *stored* `Holiday.organizationId`, never one from a request body.
 */
export function canManageHolidays(
  actor: Actor,
  holidayOrganizationId: string | null,
): boolean {
  return actor.role === Role.ADMIN && actor.organizationId === holidayOrganizationId;
}

/**
 * Reading is wider than every other list in this file: a MEMBER needs the
 * holiday calendar on their own attendance screen. Scope the query with
 * `visibleOrgId`, and narrow a member further to their own region in
 * lib/holiday-service.ts — a holiday is not sensitive, but which office
 * somebody works in is not this endpoint's to broadcast.
 */
export function canListHolidays(actor: Actor): boolean {
  return (
    actor.role === Role.SUPERADMIN ||
    actor.role === Role.ADMIN ||
    actor.role === Role.MEMBER
  );
}

/**
 * Leave policies are an organization's own entitlements, so unlike
 * `canListHolidays` this excludes a SUPERADMIN: they belong to no
 * organization, and answering them with an empty list would misreport "your
 * organization grants nothing" as though it were a fact about somebody.
 */
export function canListLeavePolicies(actor: Actor): boolean {
  return (
    (actor.role === Role.ADMIN || actor.role === Role.MEMBER) &&
    actor.organizationId !== null
  );
}

/**
 * Applying is self-service: the applicant is always the caller, so there is no
 * target to compare against and no id to tamper with.
 *
 * ADMIN is allowed deliberately — an admin is a person who takes leave, and
 * the API should not pretend otherwise. `/apply` itself stays MEMBER-only
 * because app/(member)/layout.tsx gates the whole group; the day an admin
 * needs the screen, that gate is what changes, not this predicate.
 *
 * Written out rather than delegating to `canListLeavePolicies`, whose rule it
 * currently matches by coincidence and not by definition.
 */
export function canApplyForLeave(actor: Actor): boolean {
  return (
    (actor.role === Role.ADMIN || actor.role === Role.MEMBER) &&
    actor.organizationId !== null
  );
}

/**
 * Deciding a request belongs to the ADMIN of the organization it was filed in
 * — the same rule as `canManageHolidays`. Pass the *stored*
 * `LeaveRequest.organizationId`, never one from a request body.
 *
 * `LeaveRequest.approverId` is deliberately not consulted. It records who the
 * request was *routed* to at submit, and routing is not permission: a manager
 * may be a MEMBER, who cannot open /approvals at all, and the column is
 * SetNull when an approver leaves. Either would strand a request that any
 * admin can plainly see.
 *
 * The applicant is excluded even when they are that admin. `canApplyForLeave`
 * admits an ADMIN deliberately — "an admin is a person who takes leave" — so
 * without this line an admin approves their own leave. The consequence is
 * accepted knowingly: in a one-admin organization that admin's own request
 * cannot be decided by anybody, which is the better of the two failures.
 */
export function canReviewLeave(
  actor: Actor,
  requestOrganizationId: string,
  applicantId: string,
): boolean {
  return (
    actor.role === Role.ADMIN &&
    actor.organizationId === requestOrganizationId &&
    actor.id !== applicantId
  );
}

/**
 * Reading follows `canListAttendance`, not `canReviewLeave`: a SuperAdmin sees
 * every organization, so they may read the requests inside one even though
 * they cannot decide them. Scope the query with `visibleOrgId`.
 *
 * A MEMBER is excluded. Their own requests come from the self-scoped reads in
 * lib/leave-service.ts, which take no id and therefore have no id to tamper
 * with.
 */
export function canListLeaveRequests(actor: Actor): boolean {
  return actor.role === Role.SUPERADMIN || actor.role === Role.ADMIN;
}

export function canListOrganizations(actor: Actor): boolean {
  return actor.role === Role.SUPERADMIN;
}

export function canListMembers(actor: Actor): boolean {
  return actor.role === Role.SUPERADMIN || actor.role === Role.ADMIN;
}

/**
 * Reading regions follows `canListMembers`, not `canManageRegions`: a
 * SuperAdmin sees every organization, so they may read the regions inside one
 * even though they cannot change them. Scope the query with `visibleOrgId`.
 */
export function canListRegions(actor: Actor): boolean {
  return actor.role === Role.SUPERADMIN || actor.role === Role.ADMIN;
}

/**
 * Reading attendance follows `canListMembers`, not `canMarkAttendance`: a
 * SuperAdmin sees every organization, so they may read the attendance inside
 * one even though they cannot change it. Scope the query with `visibleOrgId`.
 */
export function canListAttendance(actor: Actor): boolean {
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
