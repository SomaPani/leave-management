"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { currentActor } from "@/lib/auth";
import {
  compOffClaimInputFrom,
  compOffDecisionFrom,
  compOffGrantInputFrom,
} from "@/lib/comp-off-input";
import {
  createOwnCompOffClaim,
  decideCompOffClaim,
  grantCompOff,
  revokeCompOffGrant,
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

/**
 * An admin grants a comp-off from the Comp-off section on /setup.
 *
 * Every path lands back on /setup, success and failure alike: the form is one
 * card among four others on a long page, and a refusal has to appear where
 * the admin was typing rather than on a screen they have to navigate back
 * from. "That member already has a comp-off for that day" is the refusal they
 * will actually meet.
 */
export async function grantCompOffAction(form: FormData): Promise<void> {
  try {
    const actor = requireActor(await currentActor());
    await grantCompOff(actor, compOffGrantInputFrom(formBody(form)));
  } catch (error) {
    backWithError("/setup", error);
  }

  revalidatePath("/setup");
  // /apply reads the balance this grant just moved, and the member may have
  // it open. Revalidating here is cheaper than a stale number they cannot
  // explain.
  revalidatePath("/apply");
  redirect("/setup?granted=1");
}

/** An admin takes a grant back, from the same section. */
export async function revokeCompOffGrantAction(form: FormData): Promise<void> {
  const claimId = field(form, "claimId");

  try {
    const actor = requireActor(await currentActor());
    await revokeCompOffGrant(actor, claimId);
  } catch (error) {
    backWithError("/setup", error);
  }

  revalidatePath("/setup");
  revalidatePath("/apply");
  redirect("/setup?revoked=1");
}
