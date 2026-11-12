"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { currentActor } from "@/lib/auth";
import { backWithError, formBody } from "@/lib/form";
import { ownContactFrom } from "@/lib/member-input";
import { requireActor } from "@/lib/rbac";
import { updateOwnContact } from "@/lib/services";

/**
 * Server Action behind "Edit contact details" on /profile.
 *
 * Re-authenticates for the same reason lib/team-actions.ts does. The row is
 * always the actor's own — no id is read from the form — and `ownContactFrom`
 * reads only the four editable fields, so anything else posted is ignored.
 */
export async function updateOwnContactAction(form: FormData): Promise<void> {
  try {
    const actor = requireActor(await currentActor());
    await updateOwnContact(actor, ownContactFrom(formBody(form)));
  } catch (error) {
    // Back to the open form, so the message sits next to the fields.
    backWithError("/profile?edit=1", error);
  }
  revalidatePath("/profile");
  redirect("/profile");
}
