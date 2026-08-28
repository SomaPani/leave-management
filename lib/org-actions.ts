"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AuthError } from "next-auth";

import { currentActor, signIn, signOut } from "@/lib/auth";
import { HttpError, requireActor } from "@/lib/rbac";
import { createAdmin, createMember, createOrganization } from "@/lib/services";

/**
 * Server Actions behind the backbone's pages.
 *
 * These re-authenticate rather than trusting proxy.ts: a Server Action is a
 * POST to the page's own path, so a matcher change could remove that gate
 * without any code here changing. Authorization itself lives in lib/services.ts,
 * which these share with the API routes.
 *
 * Failures come back as a `?error=` message on the page instead of an
 * exception, so the unstyled forms stay usable without client-side state.
 */

function field(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/** Sends the caller back to `path` with a readable message attached. */
function backWithError(path: string, error: unknown): never {
  const message =
    error instanceof HttpError ? error.message : "Something went wrong.";
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

export async function signInAction(form: FormData): Promise<void> {
  const email = field(form, "email");
  const password = field(form, "password");
  const callbackUrl = field(form, "callbackUrl");

  try {
    await signIn("credentials", {
      email,
      password,
      // "/" dispatches on the role the sign-in just established — an Admin
      // lands on /members, a SuperAdmin on /organizations, a Member on
      // /account. Hard-coding one of those here sent the other roles through
      // a needless proxy bounce.
      redirectTo: callbackUrl || "/",
    });
  } catch (error) {
    // signIn throws a redirect on success — it must be allowed through.
    if (error instanceof AuthError) {
      redirect("/login?error=Invalid+email+or+password");
    }
    throw error;
  }
}

export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: "/login" });
}

export async function createOrganizationAction(form: FormData): Promise<void> {
  try {
    const actor = requireActor(await currentActor());
    await createOrganization(actor, { name: field(form, "name") });
  } catch (error) {
    backWithError("/organizations", error);
  }
  revalidatePath("/organizations");
  revalidatePath("/admins");
}

export async function createAdminAction(form: FormData): Promise<void> {
  try {
    const actor = requireActor(await currentActor());
    await createAdmin(actor, {
      name: field(form, "name"),
      email: field(form, "email").toLowerCase(),
      password: field(form, "password"),
      organizationId: field(form, "organizationId"),
    });
  } catch (error) {
    backWithError("/admins", error);
  }
  revalidatePath("/admins");
  revalidatePath("/organizations");
}

export async function createMemberAction(form: FormData): Promise<void> {
  try {
    const actor = requireActor(await currentActor());
    await createMember(actor, {
      name: field(form, "name"),
      email: field(form, "email").toLowerCase(),
      password: field(form, "password"),
      // Deliberately not read from the form — the service derives it from the
      // Admin's own session.
    });
  } catch (error) {
    backWithError("/members", error);
  }
  revalidatePath("/members");
}
