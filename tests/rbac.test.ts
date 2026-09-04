import { describe, expect, it } from "vitest";

import { Role } from "@/generated/prisma/enums";
import {
  type Actor,
  HttpError,
  assertOrgInvariant,
  canApplyForLeave,
  canCreateAdmin,
  canCreateMember,
  canCreateOrganization,
  canDeleteAdmin,
  canDeleteMember,
  canDeleteOrganization,
  canListAttendance,
  canListHolidays,
  canListLeavePolicies,
  canListMembers,
  canListOrganizations,
  canListRegions,
  canManageHolidays,
  canManageRegions,
  canMarkAttendance,
  canReadOwnAttendance,
  canUpdateAdmin,
  canUpdateMember,
  canUpdateOrganization,
  memberOrganizationFor,
  requireActor,
  requireOrg,
  requireRole,
  visibleOrgId,
} from "@/lib/rbac";

/** The full allow/deny matrix, with no database or session involved. */

const ORG_A = "org-a";
const ORG_B = "org-b";

const superadmin: Actor = { id: "su", role: Role.SUPERADMIN, organizationId: null };
const adminA: Actor = { id: "a1", role: Role.ADMIN, organizationId: ORG_A };
const adminB: Actor = { id: "a2", role: Role.ADMIN, organizationId: ORG_B };
const memberA: Actor = { id: "m1", role: Role.MEMBER, organizationId: ORG_A };

describe("who can create an organization", () => {
  it("allows a superadmin", () => {
    expect(canCreateOrganization(superadmin)).toBe(true);
  });

  it("denies admins and members", () => {
    expect(canCreateOrganization(adminA)).toBe(false);
    expect(canCreateOrganization(memberA)).toBe(false);
  });
});

describe("who can create an admin", () => {
  it("allows a superadmin", () => {
    expect(canCreateAdmin(superadmin)).toBe(true);
  });

  it("denies admins and members", () => {
    expect(canCreateAdmin(adminA)).toBe(false);
    expect(canCreateAdmin(memberA)).toBe(false);
  });
});

describe("who can create a member", () => {
  it("allows an admin inside their own organization", () => {
    expect(canCreateMember(adminA, ORG_A)).toBe(true);
  });

  it("denies an admin in someone else's organization", () => {
    expect(canCreateMember(adminA, ORG_B)).toBe(false);
    expect(canCreateMember(adminB, ORG_A)).toBe(false);
  });

  it("denies members", () => {
    expect(canCreateMember(memberA, ORG_A)).toBe(false);
  });

  it("denies a superadmin — the creation chain runs through an admin", () => {
    expect(canCreateMember(superadmin, ORG_A)).toBe(false);
  });
});

describe("who can manage regions", () => {
  it("allows an admin inside their own organization", () => {
    expect(canManageRegions(adminA, ORG_A)).toBe(true);
  });

  it("denies an admin in someone else's organization", () => {
    expect(canManageRegions(adminA, ORG_B)).toBe(false);
    expect(canManageRegions(adminB, ORG_A)).toBe(false);
  });

  it("denies members", () => {
    expect(canManageRegions(memberA, ORG_A)).toBe(false);
  });

  it("denies a superadmin — what is inside an org is its admin's to manage", () => {
    expect(canManageRegions(superadmin, ORG_A)).toBe(false);
  });
});

describe("list scoping", () => {
  it("lets only a superadmin list organizations", () => {
    expect(canListOrganizations(superadmin)).toBe(true);
    expect(canListOrganizations(adminA)).toBe(false);
    expect(canListOrganizations(memberA)).toBe(false);
  });

  it("lets superadmins and admins list members", () => {
    expect(canListMembers(superadmin)).toBe(true);
    expect(canListMembers(adminA)).toBe(true);
    expect(canListMembers(memberA)).toBe(false);
  });

  it("lets a superadmin read regions they cannot manage", () => {
    expect(canListRegions(superadmin)).toBe(true);
    expect(canManageRegions(superadmin, ORG_A)).toBe(false);
    expect(canListRegions(adminA)).toBe(true);
    expect(canListRegions(memberA)).toBe(false);
  });

  it("scopes a superadmin to every organization and an admin to their own", () => {
    expect(visibleOrgId(superadmin)).toBeNull();
    expect(visibleOrgId(adminA)).toBe(ORG_A);
    expect(visibleOrgId(adminB)).toBe(ORG_B);
  });
});

describe("memberOrganizationFor", () => {
  it("derives the organization from the admin's session", () => {
    expect(memberOrganizationFor(adminA)).toBe(ORG_A);
  });

  it("ignores a matching claim from the request body", () => {
    expect(memberOrganizationFor(adminA, ORG_A)).toBe(ORG_A);
  });

  it("rejects a cross-org claim rather than silently rewriting it", () => {
    expect(() => memberOrganizationFor(adminA, ORG_B)).toThrowError(HttpError);
    try {
      memberOrganizationFor(adminA, ORG_B);
    } catch (error) {
      expect((error as HttpError).status).toBe(403);
    }
  });

  it("rejects non-admins", () => {
    expect(() => memberOrganizationFor(superadmin, ORG_A)).toThrowError(HttpError);
    expect(() => memberOrganizationFor(memberA, ORG_A)).toThrowError(HttpError);
  });
});

describe("guards", () => {
  it("requireActor rejects a signed-out caller with 401", () => {
    try {
      requireActor(null);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as HttpError).status).toBe(401);
    }
  });

  it("requireRole allows a listed role and rejects others with 403", () => {
    expect(requireRole(adminA, Role.ADMIN)).toBe(adminA);
    try {
      requireRole(memberA, Role.ADMIN, Role.SUPERADMIN);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as HttpError).status).toBe(403);
    }
  });

  it("requireOrg lets a superadmin into any organization", () => {
    expect(requireOrg(superadmin, ORG_A)).toBe(superadmin);
    expect(requireOrg(superadmin, ORG_B)).toBe(superadmin);
  });

  it("requireOrg confines everyone else to their own", () => {
    expect(requireOrg(adminA, ORG_A)).toBe(adminA);
    try {
      requireOrg(adminA, ORG_B);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as HttpError).status).toBe(403);
    }
  });
});

describe("assertOrgInvariant", () => {
  it("accepts a superadmin with no organization", () => {
    expect(() => assertOrgInvariant(Role.SUPERADMIN, null)).not.toThrow();
  });

  it("rejects a superadmin that belongs to one", () => {
    expect(() => assertOrgInvariant(Role.SUPERADMIN, ORG_A)).toThrowError(HttpError);
  });

  it("requires an organization for admins and members", () => {
    expect(() => assertOrgInvariant(Role.ADMIN, null)).toThrowError(HttpError);
    expect(() => assertOrgInvariant(Role.MEMBER, null)).toThrowError(HttpError);
    expect(() => assertOrgInvariant(Role.ADMIN, ORG_A)).not.toThrow();
    expect(() => assertOrgInvariant(Role.MEMBER, ORG_A)).not.toThrow();
  });
});

describe("who can update and delete organizations", () => {
  it("allows a superadmin", () => {
    expect(canUpdateOrganization(superadmin)).toBe(true);
    expect(canDeleteOrganization(superadmin)).toBe(true);
  });

  it("denies admins and members", () => {
    for (const actor of [adminA, memberA]) {
      expect(canUpdateOrganization(actor)).toBe(false);
      expect(canDeleteOrganization(actor)).toBe(false);
    }
  });
});

describe("who can update and delete admins", () => {
  it("allows a superadmin", () => {
    expect(canUpdateAdmin(superadmin)).toBe(true);
    expect(canDeleteAdmin(superadmin)).toBe(true);
  });

  it("denies admins and members", () => {
    for (const actor of [adminA, memberA]) {
      expect(canUpdateAdmin(actor)).toBe(false);
      expect(canDeleteAdmin(actor)).toBe(false);
    }
  });
});

describe("who can update and delete members", () => {
  it("allows the admin of the member's own organization", () => {
    expect(canUpdateMember(adminA, ORG_A)).toBe(true);
    expect(canDeleteMember(adminA, ORG_A)).toBe(true);
  });

  it("denies an admin from another organization", () => {
    expect(canUpdateMember(adminA, ORG_B)).toBe(false);
    expect(canDeleteMember(adminB, ORG_A)).toBe(false);
  });

  it("denies members and superadmins, matching who can create them", () => {
    for (const actor of [memberA, superadmin]) {
      expect(canUpdateMember(actor, ORG_A)).toBe(false);
      expect(canDeleteMember(actor, ORG_A)).toBe(false);
    }
  });

  it("denies an orphaned member with no organization", () => {
    expect(canUpdateMember(adminA, null)).toBe(false);
  });
});

describe("who can mark attendance", () => {
  it("allows an admin inside their own organization", () => {
    expect(canMarkAttendance(adminA, ORG_A)).toBe(true);
  });

  it("denies an admin from another organization", () => {
    expect(canMarkAttendance(adminB, ORG_A)).toBe(false);
  });

  it("denies a member, even for their own row", () => {
    expect(canMarkAttendance(memberA, ORG_A)).toBe(false);
  });

  it("denies a superadmin — they create organizations, not attendance", () => {
    expect(canMarkAttendance(superadmin, ORG_A)).toBe(false);
  });

  it("denies an orphaned member with no organization", () => {
    expect(canMarkAttendance(adminA, null)).toBe(false);
  });
});

describe("who can read attendance", () => {
  it("allows an admin and a superadmin, matching canListMembers", () => {
    expect(canListAttendance(adminA)).toBe(true);
    expect(canListAttendance(superadmin)).toBe(true);
  });

  it("denies a member the whole roster's attendance", () => {
    expect(canListAttendance(memberA)).toBe(false);
  });
});

describe("who can read holidays", () => {
  it("allows every signed-in role — a member needs their own calendar", () => {
    expect(canListHolidays(memberA)).toBe(true);
    expect(canListHolidays(adminA)).toBe(true);
    expect(canListHolidays(superadmin)).toBe(true);
  });
});

describe("who can manage holidays", () => {
  it("allows an admin inside their own organization", () => {
    expect(canManageHolidays(adminA, ORG_A)).toBe(true);
  });

  it("denies an admin from another organization", () => {
    expect(canManageHolidays(adminB, ORG_A)).toBe(false);
  });

  it("denies members and superadmins, matching canManageRegions", () => {
    expect(canManageHolidays(memberA, ORG_A)).toBe(false);
    expect(canManageHolidays(superadmin, ORG_A)).toBe(false);
  });

  it("denies an orphaned holiday with no organization", () => {
    expect(canManageHolidays(adminA, null)).toBe(false);
  });
});

describe("who can read one person's attendance", () => {
  it("allows the person themselves", () => {
    expect(canReadOwnAttendance(memberA, memberA.id)).toBe(true);
  });

  it("denies reading somebody else's, even inside one organization", () => {
    expect(canReadOwnAttendance(memberA, "m2")).toBe(false);
    expect(canReadOwnAttendance(adminA, memberA.id)).toBe(false);
  });
});

describe("who can read leave policies", () => {
  it("allows a member and an admin inside an organization", () => {
    expect(canListLeavePolicies(memberA)).toBe(true);
    expect(canListLeavePolicies(adminA)).toBe(true);
  });

  it("denies a superadmin, who belongs to no organization to have policies in", () => {
    expect(canListLeavePolicies(superadmin)).toBe(false);
  });
});

describe("who can apply for leave", () => {
  it("allows a member", () => {
    expect(canApplyForLeave(memberA)).toBe(true);
  });

  it("allows an admin — admins take leave too", () => {
    expect(canApplyForLeave(adminA)).toBe(true);
  });

  it("denies a superadmin", () => {
    expect(canApplyForLeave(superadmin)).toBe(false);
  });

  it("denies an org-bound role whose organization is somehow missing", () => {
    expect(canApplyForLeave({ ...memberA, organizationId: null })).toBe(false);
  });
});
