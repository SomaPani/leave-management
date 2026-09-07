"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { currentActor } from "@/lib/auth";
import { backWithError, field, formBody } from "@/lib/form";
import { leaveDecisionFrom, leaveRequestInputFrom } from "@/lib/leave-input";
import { decideLeaveRequest } from "@/lib/leave-review-service";
import { createOwnLeaveRequest, withdrawOwnLeaveRequest } from "@/lib/leave-service";
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

/**
 * The Server Action behind the Approvals screen.
 *
 * Lands back on the same filter and the same request, so an admin working a
 * queue keeps their place and can read the decision they just made rather than
 * being bounced to the top of a list that no longer contains it.
 *
 * The body goes through `leaveDecisionFrom` — the same parser
 * `PATCH /api/leave-requests/[id]` uses — so the form's button value
 * (`approve`) and an API caller's status (`APPROVED`) cannot drift apart.
 */
export async function reviewLeaveRequestAction(form: FormData): Promise<void> {
  const body = formBody(form);
  const requestId = field(form, "requestId");
  const filter = field(form, "filter") || "pending";
  const back = `/approvals?filter=${filter}${requestId ? `&r=${requestId}` : ""}`;

  try {
    const actor = requireActor(await currentActor());
    await decideLeaveRequest(actor, requestId, leaveDecisionFrom(body));
  } catch (error) {
    // Back to the request being reviewed, with the message beside it — the
    // "a rejection needs a reason" refusal is the one an admin will actually
    // meet, and it has to land where they were typing.
    backWithError(back, error);
  }

  revalidatePath("/approvals");
  redirect(back);
}

/** The Server Action behind the member's own Withdraw button. */
export async function withdrawOwnRequestAction(form: FormData): Promise<void> {
  const requestId = field(form, "requestId");
  const back = `/requests${requestId ? `?r=${requestId}` : ""}`;

  try {
    const actor = requireActor(await currentActor());
    await withdrawOwnLeaveRequest(actor, requestId);
  } catch (error) {
    backWithError(back, error);
  }

  revalidatePath("/requests");
  redirect(back);
}
