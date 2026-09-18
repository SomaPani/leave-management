"use client";

import { useMemo, useState } from "react";

import {
  Avatar,
  Card,
  dangerButtonClass,
  inputClass,
  primaryButtonClass,
  selectClass,
  textareaClass,
} from "@/components/ui";
import { claimableDay } from "@/lib/comp-off";
import type { CompOffGranteeRecord, CompOffGrantRecord } from "@/lib/comp-off-service";
import { formatDayMonth } from "@/lib/date";
import { initialsFor } from "@/lib/domain";

/**
 * Grant a comp-off: an admin credits a colleague with a day they worked,
 * without waiting for a claim.
 *
 * The one section on /setup backed by real rows. Everything above and below
 * it is still `seedDb()`, which is why the card says so rather than letting
 * the page's banner speak for it.
 *
 * The live refusal comes from `claimableDay` — the same function
 * lib/comp-off-service.ts refuses with, and the same one
 * components/comp-off-form.tsx shows the member. One rule, three callers, no
 * copy to drift.
 */
export function CompOffGrant({
  grantAction,
  revokeAction,
  grantees,
  grants,
  holidayDates,
  today,
}: {
  grantAction: (formData: FormData) => void | Promise<void>;
  revokeAction: (formData: FormData) => void | Promise<void>;
  grantees: CompOffGranteeRecord[];
  grants: CompOffGrantRecord[];
  /** Every holiday date in the organization, for the live check. */
  holidayDates: string[];
  today: string;
}) {
  const [workedOn, setWorkedOn] = useState("");

  const off = useMemo(() => new Set(holidayDates), [holidayDates]);
  const refusal = workedOn ? claimableDay(workedOn, today, off) : null;

  return (
    <Card className="flex flex-col gap-4 p-5">
      <span className="flex flex-wrap items-baseline justify-between gap-2.5">
        <h2 className="text-[15px] font-semibold">Comp-off</h2>
        <span className="font-mono text-[11px] tracking-[0.06em] text-muted">
          SAVED · REAL DATA
        </span>
      </span>

      <p className="text-[13px] text-muted">
        Credit a day somebody worked when they were not owed. It lands on their
        balance straight away — there is no claim to approve. Earned days lapse
        on 31 December.
      </p>

      <form
        action={grantAction}
        className="grid items-start gap-3.5 border-t border-line pt-4 sm:grid-cols-[minmax(0,1fr)_auto]"
      >
        <div className="flex flex-col gap-3.5">
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            Who worked
            <select name="userId" required defaultValue="" className={selectClass}>
              <option value="" disabled>
                Pick a colleague
              </option>
              {grantees.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                  {person.role === "ADMIN" ? " · admin" : ""}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5 text-xs text-muted">
            Day they worked
            <input
              type="date"
              name="workedOn"
              value={workedOn}
              max={today}
              required
              onChange={(event) => setWorkedOn(event.target.value)}
              className={inputClass}
            />
          </label>

          {refusal ? (
            <p className="rounded-lg border border-danger-line bg-danger-tint px-3.5 py-2.5 text-[12.5px] text-danger">
              {refusal}
            </p>
          ) : (
            <p className="rounded-lg bg-subtle px-3 py-2.5 text-[12.5px] text-muted">
              A weekend, or a holiday in their own region. One grant is one day
              off.
            </p>
          )}

          <label className="flex flex-col gap-1.5 text-xs text-muted">
            What they worked on
            <textarea
              name="reason"
              rows={2}
              maxLength={500}
              placeholder="A line is enough — this is the record of why they earned it."
              className={textareaClass}
            />
          </label>
        </div>

        <button
          type="submit"
          disabled={refusal !== null || grantees.length === 0}
          className={`${primaryButtonClass} sm:self-end`}
        >
          Grant comp-off
        </button>
      </form>

      {grantees.length === 0 ? (
        <p className="text-[12.5px] text-muted">
          Nobody to grant to yet — add a colleague on the Team screen first.
        </p>
      ) : null}

      <div className="flex flex-col gap-1 border-t border-line pt-3.5">
        <span className="font-mono text-[11px] tracking-[0.06em] text-muted">
          RECENTLY GRANTED
        </span>

        {grants.length === 0 ? (
          <p className="py-2 text-[12.5px] text-muted">
            No comp-off granted yet. Days members claimed themselves are on
            Approvals, not here.
          </p>
        ) : (
          <ul className="flex flex-col">
            {grants.map((grant) => (
              <li
                key={grant.id}
                className="flex flex-wrap items-center gap-3 border-b border-line py-2.5 last:border-b-0"
              >
                <Avatar initials={initialsFor(grant.user.name)} />

                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="text-[12.5px] font-semibold text-ink">
                    {grant.user.name}
                  </span>
                  <span className="truncate text-[11px] text-muted">
                    {grant.reason ?? "No note"}
                    {grant.decidedBy ? ` · granted by ${grant.decidedBy.name}` : ""}
                  </span>
                </span>

                <span className="font-mono text-[11.5px] whitespace-nowrap text-muted">
                  {formatDayMonth(grant.workedOn)}
                </span>

                <form action={revokeAction}>
                  <input type="hidden" name="claimId" value={grant.id} />
                  <button type="submit" className={dangerButtonClass}>
                    Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
