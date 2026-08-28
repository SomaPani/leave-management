import { redirect } from "next/navigation";

import { currentActor } from "@/lib/auth";
import { HOME_FOR_ROLE } from "@/lib/page-guards";

/**
 * The application's front door.
 *
 * This used to hand off to the leave-management account picker at `/login`.
 * That screen reads `lib/store.ts`, whose tables were dropped when the repo
 * narrowed to the organization backbone, so `/` answered with a 500 instead of
 * reaching anything usable. It now points at the backbone: signed-in visitors
 * go to their role's home, everyone else to `/login`.
 */
export default async function RootPage() {
  const actor = await currentActor();
  redirect(actor ? HOME_FOR_ROLE[actor.role] : "/login");
}
