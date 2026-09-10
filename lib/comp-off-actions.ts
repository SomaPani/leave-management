"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { currentActor } from "@/lib/auth";
import { compOffClaimInputFrom, compOffDecisionFrom } from "@/lib/comp-off-input";
import {
  createOwnCompOffClaim,
  decideCompOffClaim,
  withdrawOwnCompOffClaim,
} from "@/lib/comp-off-service";
import { backWithError, field, formBody } from "@/lib/form";
import { requireActor } from "@/lib/rbac";

/**
 * The Server Actions behind the comp-off card on /apply and the comp-off
 * section on /approvals.
 *
 * Same contract as lib/leave-actions.ts: re-authenticate rather than trusting
 * proxy.ts, because a Server Action is a POST to the page's own path and a
 * matcher change could remove that gate without any code here changing.
 * Authorization itself lives in lib/comp-off-service.ts.
 */

/**
 * File a claim.
 *
 * The claim lands on /requests beside the member's leave, highlighted with
 * `?c=` rather than the `?r=` a leave request uses, so a claim and a request
 * cannot fight over the same highlight.
 */
export async function submitCompOffClaimAction(form: FormData): Promise<void> {
  let id = "";

  try {
    const actor = requireActor(await currentActor());
    const created = await createOwnCompOffClaim(actor, compOffClaimInputFrom(formBody(form)));
    id = created.id;
  } catch (error) {
    // Back to the form the claim came from, with the message beside the input
    // it is about — "that was a working day" has to land where they picked it.
    backWithError("/apply", error);
  }

  revalidatePath("/requests");
  redirect(`/requests?c=${id}`);
}

/** The claimant takes a pending claim back, from /requests. */
export async function withdrawCompOffClaimAction(form: FormData): Promise<void> {
  const claimId = field(form, "claimId");

  try {
    const actor = requireActor(await currentActor());
    await withdrawOwnCompOffClaim(actor, claimId);
  } catch (error) {
    backWithError("/requests", error);
  }

  revalidatePath("/requests");
  redirect(`/requests?c=${claimId}`);
}

/**
 * An admin decides a claim.
 *
 * Lands back on the same filter and the same claim, so an admin working the
 * queue keeps their place and can read the decision they just made rather
 * than being bounced to the top of a list that no longer contains it.
 */
export async function reviewCompOffClaimAction(form: FormData): Promise<void> {
  const body = formBody(form);
  const claimId = field(form, "claimId");
  const filter = field(form, "filter") || "pending";
  const back = `/approvals?filter=${filter}${claimId ? `&c=${claimId}` : ""}`;

  try {
    const actor = requireActor(await currentActor());
    await decideCompOffClaim(actor, claimId, compOffDecisionFrom(body));
  } catch (error) {
    // Back to the claim being reviewed. "A rejection needs a reason" is the
    // refusal an admin will actually meet, and it has to land where they were
    // typing.
    backWithError(back, error);
  }

  revalidatePath("/approvals");
  redirect(back);
}
