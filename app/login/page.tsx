import { redirect } from "next/navigation";

import { inputClass, primaryButtonClass } from "@/components/ui";
import { currentActor } from "@/lib/auth";
import { signInAction } from "@/lib/org-actions";
import { HOME_FOR_ROLE } from "@/lib/page-guards";
import { COMPANY_NAME } from "@/lib/seed";

/**
 * Email + password log-in — the application's only sign-in screen.
 *
 * Credentials are checked against `orgapp."User"` in `lib/auth.ts`: the row is
 * looked up by email and the password compared against its bcrypt hash. Every
 * role signs in here; `signInAction` posts to `/`, which dispatches on the role
 * the sign-in just established.
 *
 * This path used to hold the leave-management account picker, which signed a
 * `Person` in against tables that no longer exist.
 */

/** Auth.js sends its own opaque code when the callback is posted directly. */
function readError(error: string | undefined): string | null {
  if (!error) return null;
  return error === "CredentialsSignin" ? "Invalid email or password." : error;
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const actor = await currentActor();
  if (actor) redirect(HOME_FOR_ROLE[actor.role]);

  const { error, callbackUrl } = await searchParams;
  const message = readError(error);

  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[1.15fr_1fr]">
      <div className="hidden flex-col justify-between gap-12 bg-brand-deep p-10 text-white lg:flex lg:p-16">
        <div className="font-mono text-[13px] tracking-[0.16em] text-brand-mute uppercase">
          {COMPANY_NAME}
        </div>
        <div className="flex flex-col gap-4">
          <h1 className="text-4xl leading-tight font-semibold">
            Organization administration
          </h1>
          <p className="max-w-md text-[15px] text-brand-mute">
            Sign in to manage organizations, administrators and members. Your
            access is scoped to the role your account holds.
          </p>
        </div>
        <div className="font-mono text-xs tracking-[0.12em] text-brand-mute/70 uppercase">
          Authorized access only
        </div>
      </div>

      <main className="flex flex-col justify-center px-6 py-12 sm:px-12 lg:px-16">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-8 font-mono text-[13px] tracking-[0.16em] text-brand uppercase lg:hidden">
            {COMPANY_NAME}
          </div>

          <h2 className="text-2xl font-semibold text-ink">Log in</h2>
          <p className="mt-1.5 text-sm text-muted">
            Enter the email and password for your account.
          </p>

          {message ? (
            <p
              role="alert"
              className="mt-6 rounded-lg border border-danger-line bg-danger-tint px-3 py-2.5 text-sm text-danger"
            >
              {message}
            </p>
          ) : null}

          <form action={signInAction} className="mt-6 flex flex-col gap-4">
            <input type="hidden" name="callbackUrl" value={callbackUrl ?? ""} />

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-ink-2">Email</span>
              <input
                name="email"
                type="email"
                required
                autoComplete="username"
                autoFocus
                placeholder="you@company.com"
                className={inputClass}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-ink-2">Password</span>
              <input
                name="password"
                type="password"
                required
                autoComplete="current-password"
                placeholder="••••••••"
                className={inputClass}
              />
            </label>

            <button type="submit" className={`${primaryButtonClass} mt-2`}>
              Log in
            </button>
          </form>

          <p className="mt-8 text-[13px] text-muted">
            Accounts are created for you — an administrator by a super admin, a
            member by their organization&rsquo;s administrator.
          </p>
        </div>
      </main>
    </div>
  );
}
