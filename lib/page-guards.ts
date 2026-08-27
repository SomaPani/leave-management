import { redirect } from "next/navigation";

import type { Role } from "@/generated/prisma/enums";
import { currentActor } from "@/lib/auth";
import type { Actor } from "@/lib/rbac";

/**
 * Page-level guards.
 *
 * Route handlers throw `HttpError` and answer with a status code; a page should
 * send the visitor somewhere instead, so these redirect. proxy.ts already turns
 * most of these away, but a page must not depend on that — see the note in
 * proxy.ts.
 */

export const HOME_FOR_ROLE: Record<Role, string> = {
  SUPERADMIN: "/organizations",
  ADMIN: "/members",
  MEMBER: "/account",
};

export async function requirePageActor(): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) redirect("/signin");
  return actor;
}

/** A caller holding `role`, or a redirect to wherever they do belong. */
export async function requirePageRole(role: Role): Promise<Actor> {
  const actor = await requirePageActor();
  if (actor.role !== role) redirect(HOME_FOR_ROLE[actor.role]);
  return actor;
}
