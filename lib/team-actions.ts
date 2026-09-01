"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { EmploymentStatus } from "@/generated/prisma/enums";
import { currentActor } from "@/lib/auth";
import { backWithError, field, formBody } from "@/lib/form";
import { memberProfileFrom } from "@/lib/member-input";
import { requireActor } from "@/lib/rbac";
import {
  createMember,
  createRegion,
  setMemberStatus,
  updateMember,
} from "@/lib/services";

/**
 * Server Actions behind the Team screen.
 *
 * Same contract as lib/org-actions.ts: re-authenticate rather than trusting
 * proxy.ts, because a Server Action is a POST to the page's own path and a
 * matcher change could remove that gate without any code here changing.
 * Authorization itself lives in lib/services.ts, which these share with
 * `/api/members` and `/api/regions`.
 *
 * The profile is read with `memberProfileFrom`, the same parser the JSON routes
 * use, so a form post and an API call cannot drift apart on field names,
 * coercion or validation. It also gives the form what it needs for free: an
 * input the form does not render is absent and left alone, while one rendered
 * and submitted empty reads as `null` and clears the field.
 */

/** After a successful write, close whatever panel was open. */
function backToTeam(): never {
  revalidatePath("/team");
  redirect("/team");
}

export async function createTeamMemberAction(form: FormData): Promise<void> {
  try {
    const actor = requireActor(await currentActor());
    await createMember(actor, {
      ...memberProfileFrom(formBody(form)),
      name: field(form, "name"),
      email: field(form, "email").toLowerCase(),
      password: field(form, "password"),
      // Deliberately not read from the form — the service derives the
      // organization from the admin's own session.
    });
  } catch (error) {
    // Back to the open form rather than the bare list, so the message lands
    // next to the fields it is about.
    backWithError("/team?add=1", error);
  }
  backToTeam();
}

export async function updateTeamMemberAction(form: FormData): Promise<void> {
  const id = field(form, "id");

  try {
    const actor = requireActor(await currentActor());
    const password = field(form, "password");

    await updateMember(actor, id, {
      ...memberProfileFrom(formBody(form)),
      // Identity fields are only touched when the form actually carries them —
      // unlike the profile, there is no "clear your own name".
      ...(form.has("name") ? { name: field(form, "name") } : {}),
      ...(form.has("email") ? { email: field(form, "email").toLowerCase() } : {}),
      // A blank password box means "leave it as it is", not "set an empty one".
      ...(password ? { password } : {}),
    });
  } catch (error) {
    backWithError(`/team?edit=${encodeURIComponent(id)}`, error);
  }
  backToTeam();
}

/**
 * Take someone off the team.
 *
 * A status change, not a delete: the row has to survive for the leave and
 * attendance records that will reference it. `restoreTeamMemberAction` is the
 * way back.
 */
export async function deactivateTeamMemberAction(form: FormData): Promise<void> {
  try {
    const actor = requireActor(await currentActor());
    await setMemberStatus(actor, field(form, "id"), EmploymentStatus.INACTIVE);
  } catch (error) {
    backWithError("/team", error);
  }
  backToTeam();
}

export async function restoreTeamMemberAction(form: FormData): Promise<void> {
  try {
    const actor = requireActor(await currentActor());
    await setMemberStatus(actor, field(form, "id"), EmploymentStatus.ACTIVE);
  } catch (error) {
    backWithError("/team?status=ALL", error);
  }
  backToTeam();
}

export async function createRegionAction(form: FormData): Promise<void> {
  try {
    const actor = requireActor(await currentActor());
    await createRegion(actor, { name: field(form, "name") });
  } catch (error) {
    backWithError("/team?region=new", error);
  }
  backToTeam();
}
