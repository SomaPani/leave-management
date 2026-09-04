"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { currentActor } from "@/lib/auth";
import { backWithError, formBody } from "@/lib/form";
import { leaveRequestInputFrom } from "@/lib/leave-input";
import { createOwnLeaveRequest } from "@/lib/leave-service";
import { requireActor } from "@/lib/rbac";

/**
 * The Server Action behind the Apply screen.
 *
 * Same contract as lib/holiday-actions.ts: re-authenticate rather than
 * trusting proxy.ts, because a Server Action is a POST to the page's own path
 * and a matcher change could remove that gate without any code here changing.
 * Authorization itself lives in lib/leave-service.ts, which this shares with
 * `/api/leave-requests`.
 *
 * The body is read with `leaveRequestInputFrom` — the same parser the JSON
 * route uses — so a form post and an API call cannot drift apart. That also
 * gives the form what it needs for free: the To input is disabled for a
 * one-occurrence policy and therefore submits nothing, which the parser reads
 * as a one-day request.
 */
export async function submitLeaveRequestAction(form: FormData): Promise<void> {
  let id = "";

  try {
    const actor = requireActor(await currentActor());
    const created = await createOwnLeaveRequest(
      actor,
      leaveRequestInputFrom(formBody(form)),
    );
    id = created.id;
  } catch (error) {
    // Back to the form the request came from, with the message beside the
    // fields it is about.
    backWithError("/apply", error);
  }

  // Land back on /apply naming the new request rather than on /requests: that
  // screen is still on the fixture and would show a stranger's thread instead
  // of the filing just made.
  revalidatePath("/apply");
  redirect(`/apply?submitted=${id}`);
}
