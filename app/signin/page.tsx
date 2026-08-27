import { redirect } from "next/navigation";

import { currentActor } from "@/lib/auth";
import { signInAction } from "@/lib/org-actions";
import { HOME_FOR_ROLE } from "@/lib/page-guards";

/**
 * Email + password sign-in for the organization backbone.
 *
 * Separate from `/login`, which is the leave-management account picker on its
 * own cookie session. The two sit side by side rather than one replacing the
 * other; unifying them is a follow-up, not part of this backbone.
 */

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const actor = await currentActor();
  if (actor) redirect(HOME_FOR_ROLE[actor.role]);

  const { error, callbackUrl } = await searchParams;

  return (
    <main style={{ maxWidth: "22rem", margin: "4rem auto", padding: "0 1.5rem" }}>
      <h1 style={{ fontSize: "1.25rem", marginBottom: "1rem" }}>Sign in</h1>

      {error ? (
        <p role="alert" style={{ color: "#b00020", marginBottom: "1rem" }}>
          {error}
        </p>
      ) : null}

      <form action={signInAction}>
        <input type="hidden" name="callbackUrl" value={callbackUrl ?? ""} />
        <label style={{ display: "block", marginBottom: "0.5rem" }}>
          <span style={{ display: "block", fontSize: "0.875rem" }}>Email</span>
          <input name="email" type="email" required autoComplete="username" />
        </label>
        <label style={{ display: "block", marginBottom: "1rem" }}>
          <span style={{ display: "block", fontSize: "0.875rem" }}>Password</span>
          <input
            name="password"
            type="password"
            required
            autoComplete="current-password"
          />
        </label>
        <button type="submit">Sign in</button>
      </form>

      <p style={{ marginTop: "2rem", fontSize: "0.8125rem", color: "#555" }}>
        Looking for the leave-management demo? That signs in at <a href="/login">/login</a>.
      </p>
    </main>
  );
}
