import { EmploymentStatus, Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";

/**
 * Who a filing goes to for a decision.
 *
 * Its own module rather than a function inside lib/leave-service.ts, because
 * both that file and lib/comp-off-service.ts need it and importing it across
 * put the two services in a cycle. A cycle here is not a tidiness problem: it
 * survives `tsc`, `vitest` and `next build`, then decides at runtime which
 * module is left half-initialised based on which one the bundler entered
 * first — a page render entering one way worked, while a Server Action
 * entering the other way threw. tests/module-graph.test.ts holds the line.
 *
 * Copying the function into both services would have removed the cycle too,
 * and let a claim and a leave request route to different people the first
 * time the fallback changed. One definition, two importers.
 */

export type ApproverRecord = { id: string; name: string } | null;

/**
 * The applicant's manager, or failing that the organization's
 * longest-standing active admin, or nobody.
 *
 * A fallback rather than a requirement. A one-person organization and a member
 * whose manager has left are both real, and neither should leave somebody
 * unable to file at all.
 */
export async function approverFor(
  manager: ApproverRecord,
  organizationId: string,
): Promise<ApproverRecord> {
  if (manager) return manager;

  return prisma.user.findFirst({
    where: { organizationId, role: Role.ADMIN, status: EmploymentStatus.ACTIVE },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
}
