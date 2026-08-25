import { redirect } from "next/navigation";

import { signIn } from "@/lib/actions";
import { TODAY } from "@/lib/date";
import { attendanceCodes, pendingRequests, roster } from "@/lib/domain";
import { COMPANY_NAME, DEMO_ACCOUNT_IDS } from "@/lib/seed";
import { getCurrentUser, homePathFor } from "@/lib/session";
import { readDb } from "@/lib/store";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const signedIn = await getCurrentUser();
  if (signedIn) redirect(homePathFor(signedIn));

  const { error } = await searchParams;
  const db = await readDb();

  const accounts = DEMO_ACCOUNT_IDS.map((id) =>
    db.people.find((p) => p.id === id),
  ).filter((p) => p !== undefined);

  const outToday = roster(db).filter((p) =>
    attendanceCodes(db, p.id, TODAY).includes("leave"),
  ).length;

  const stats = [
    { value: db.people.length, label: "PEOPLE" },
    { value: pendingRequests(db).length, label: "PENDING" },
    { value: outToday, label: "OUT TODAY" },
  ];

  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[1.15fr_1fr]">
      <div className="flex flex-col justify-between gap-12 bg-brand-deep p-10 text-white lg:p-16">
        <div className="font-mono text-[13px] tracking-[0.16em] text-brand-mute uppercase">
          {COMPANY_NAME}
        </div>

        <div className="flex max-w-[460px] flex-col gap-6">
          <h1 className="text-[46px] leading-[1.05] font-medium tracking-[-0.02em] text-pretty">
            Leave Management, Without the Hassle
          </h1>
          <p className="text-base leading-relaxed text-brand-mute text-pretty">
            Apply, approve, and settle it in one place. Balances update the moment a
            request is decided.
          </p>
        </div>

        <dl className="flex gap-10 font-mono text-xs text-brand-mute">
          {stats.map((stat) => (
            <div key={stat.label} className="flex flex-col gap-1.5">
              <dd className="text-[22px] text-white">{stat.value}</dd>
              <dt>{stat.label}</dt>
            </div>
          ))}
        </dl>
      </div>

      <div className="flex items-center justify-center p-8 lg:p-12">
        <div className="flex w-full max-w-[380px] flex-col gap-7">
          <div className="flex flex-col gap-2">
            <h2 className="text-2xl font-semibold tracking-[-0.01em]">Sign in</h2>
            <p className="text-sm text-muted">Choose an account to continue.</p>
          </div>

          {error ? (
            <p className="rounded-lg border border-danger-line bg-danger-tint px-3 py-2 text-sm text-danger">
              That account no longer exists. Pick another one.
            </p>
          ) : null}

          <div className="flex flex-col gap-2.5">
            {accounts.map((account) => (
              <form key={account.id} action={signIn}>
                <input type="hidden" name="userId" value={account.id} />
                <button
                  type="submit"
                  className="flex w-full cursor-pointer items-center gap-3.5 rounded-[10px] border border-line bg-surface px-4 py-3.5 text-left transition-[border-color,box-shadow] hover:border-brand hover:shadow-[0_1px_0_var(--color-brand)]"
                >
                  <span className="flex size-[38px] items-center justify-center rounded-full bg-brand-tint text-[13px] font-semibold tracking-[0.04em] text-brand">
                    {account.initials}
                  </span>
                  <span className="flex flex-1 flex-col gap-0.5">
                    <span className="text-sm font-semibold">{account.name}</span>
                    <span className="text-xs text-muted">{account.email}</span>
                  </span>
                  <span className="rounded-md border border-line px-[7px] py-1 font-mono text-[10px] tracking-[0.12em] text-muted">
                    {account.role === "admin" ? "ADMIN" : "MEMBER"}
                  </span>
                </button>
              </form>
            ))}
          </div>

          <div className="flex flex-col gap-3 border-t border-line pt-5">
            <label className="flex flex-col gap-1.5 text-xs text-muted">
              Password
              <input
                type="password"
                defaultValue="demo-password"
                readOnly
                aria-readonly
                className="rounded-lg border border-line bg-surface px-3 py-2.5 text-sm"
              />
            </label>
            <p className="text-xs text-muted">
              Demo prototype — pick any account above.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
