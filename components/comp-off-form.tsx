"use client";

import { useMemo, useState } from "react";

import { MonoLabel, inputClass, primaryButtonClass, textareaClass } from "@/components/ui";
import { claimableDay } from "@/lib/comp-off";

/**
 * Claim a comp-off: a day off earned by working a day that was not owed.
 *
 * The refusal comes from `claimableDay` — the same function
 * lib/comp-off-service.ts refuses with — so the sentence the member reads
 * beside the input is the sentence the server would have sent, rather than a
 * second copy of the rule that drifts from it.
 *
 * The button is disabled while a refusal is showing and the input carries a
 * `max`, but the server checks again regardless: both are a courtesy, not a
 * control.
 */
export function CompOffForm({
  action,
  holidayDates,
  today,
  balance,
}: {
  action: (formData: FormData) => void | Promise<void>;
  /** Every holiday date that applies to this member, for the live check. */
  holidayDates: string[];
  today: string;
  /** Comp-off days already earned and not yet spent. */
  balance: number;
}) {
  const [workedOn, setWorkedOn] = useState("");

  const off = useMemo(() => new Set(holidayDates), [holidayDates]);
  const refusal = workedOn ? claimableDay(workedOn, today, off) : null;

  return (
    <form action={action} className="grid items-start gap-6 xl:grid-cols-[1.2fr_0.8fr]">
      <div className="flex flex-col gap-4.5 rounded-xl border border-line bg-surface p-6">
        <label className="flex flex-col gap-1.5 text-xs text-muted">
          Day you worked
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
            A weekend or a holiday you worked. One approved claim is one day off.
          </p>
        )}

        <label className="flex flex-col gap-1.5 text-xs text-muted">
          What you worked on
          <textarea
            name="reason"
            rows={3}
            maxLength={500}
            placeholder="A line is enough — this is what your approver decides on."
            className={textareaClass}
          />
        </label>

        <div className="flex flex-wrap items-center gap-3.5 border-t border-line pt-4">
          <button type="submit" disabled={refusal !== null} className={primaryButtonClass}>
            Claim comp-off
          </button>
          <span className="text-[13px] text-muted">
            Your balance moves once an admin approves it.
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5.5">
        <MonoLabel>COMP-OFF EARNED</MonoLabel>
        <span className="flex items-baseline gap-2">
          <span className="text-[40px] font-semibold tracking-[-0.02em]">{balance}</span>
          <span className="text-[13px] text-muted">
            {balance === 1 ? "day" : "days"} available
          </span>
        </span>
        <p className="border-t border-brand-tint pt-3.5 text-[13px] text-muted">
          Earned days lapse on 31 December. Take them with a Comp-off leave
          request before then.
        </p>
      </div>
    </form>
  );
}
