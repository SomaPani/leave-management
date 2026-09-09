"use client";

import { useMemo, useState } from "react";

import {
  MonoLabel,
  inputClass,
  primaryButtonClass,
  selectClass,
  textareaClass,
} from "@/components/ui";
import { type LeaveUnitName, costFrom, unitNoun } from "@/lib/leave";

export type ApplyOption = {
  id: string;
  name: string;
  /** `USES` policies are counted per occurrence, not per day. */
  unit: LeaveUnitName;
  balance: number;
};

/** Reused so the "before holidays" comparison allocates nothing per keystroke. */
const NO_HOLIDAYS: ReadonlySet<string> = new Set<string>();

export function ApplyForm({
  action,
  options,
  approverName,
  holidayDates,
  defaultFrom,
  defaultTo,
}: {
  action: (formData: FormData) => void | Promise<void>;
  options: ApplyOption[];
  approverName: string;
  /** Every holiday date that applies to this member, for the live day count. */
  holidayDates: string[];
  defaultFrom: string;
  defaultTo: string;
}) {
  const [policyId, setPolicyId] = useState(options[0]?.id ?? "");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);

  const off = useMemo(() => new Set(holidayDates), [holidayDates]);

  const option = options.find((item) => item.id === policyId);
  const unit: LeaveUnitName = option?.unit ?? "DAYS";
  const isUses = unit === "USES";

  // `costFrom` is the same function lib/leave-service.ts prices the row with,
  // so the number under the button and the number in the database cannot
  // disagree.
  const end = isUses ? from : to;
  const cost = costFrom(unit, from, end, off);
  const holidayDays = costFrom(unit, from, end, NO_HOLIDAYS) - cost;

  const balance = option?.balance ?? 0;
  const after = balance - cost;

  return (
    <form action={action} className="grid items-start gap-6 xl:grid-cols-[1.2fr_0.8fr]">
      <div className="flex flex-col gap-4.5 rounded-xl border border-line bg-surface p-6">
        <label className="flex flex-col gap-1.5 text-xs text-muted">
          Leave type
          <select
            name="policyId"
            value={policyId}
            onChange={(event) => setPolicyId(event.target.value)}
            className={selectClass}
          >
            {options.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>

        <div className="grid gap-3.5 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            From
            <input
              type="date"
              name="startDate"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className={inputClass}
            />
          </label>

          <label className="flex flex-col gap-1.5 text-xs text-muted">
            To
            <input
              type="date"
              name="endDate"
              value={end}
              disabled={isUses}
              onChange={(event) => setTo(event.target.value)}
              className={`${inputClass} disabled:text-muted`}
            />
          </label>
        </div>

        {isUses ? (
          <p className="rounded-lg bg-subtle px-3 py-2.5 text-[12.5px] text-muted">
            One {option?.name.toLowerCase() ?? "occurrence"} on{" "}
            {from || "the selected day"} — no need to set an end date.
          </p>
        ) : null}

        {holidayDays > 0 ? (
          <p className="rounded-lg bg-subtle px-3 py-2.5 text-[12.5px] text-muted">
            {holidayDays} {unitNoun(unit, holidayDays)} in that range{" "}
            {holidayDays === 1 ? "is a holiday" : "are holidays"} — not counted.
          </p>
        ) : null}

        <label className="flex flex-col gap-1.5 text-xs text-muted">
          Reason
          <textarea
            name="reason"
            rows={4}
            maxLength={500}
            placeholder="A line is enough — your manager sees this first."
            className={textareaClass}
          />
        </label>

        <div className="flex flex-wrap items-center gap-3.5 border-t border-line pt-4">
          <button type="submit" className={primaryButtonClass}>
            Submit request
          </button>
          <span className="text-[13px] text-muted">
            {cost > balance
              ? "Over your balance — admin will see the shortfall."
              : `Goes straight to ${approverName}.`}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5.5">
        <MonoLabel>THIS REQUEST</MonoLabel>
        <span className="flex items-baseline gap-2">
          <span className="text-[40px] font-semibold tracking-[-0.02em]">{cost}</span>
          <span className="text-[13px] text-muted">
            {isUses ? unitNoun(unit, cost) : `working ${unitNoun(unit, cost)}`}
          </span>
        </span>

        <dl className="flex flex-col gap-2.5 border-t border-brand-tint pt-3.5 text-[13px]">
          <div className="flex justify-between">
            <dt className="text-muted">{option?.name ?? "Leave"} balance</dt>
            <dd>
              {balance} {unitNoun(unit, balance)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">After approval</dt>
            <dd>
              {after} {unitNoun(unit, after)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Approver</dt>
            <dd>{approverName}</dd>
          </div>
        </dl>
      </div>
    </form>
  );
}
