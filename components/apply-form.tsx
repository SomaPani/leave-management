"use client";

import { useState } from "react";

import {
  MonoLabel,
  inputClass,
  primaryButtonClass,
  selectClass,
  textareaClass,
} from "@/components/ui";
import { workdays } from "@/lib/date";

export type ApplyOption = {
  name: string;
  /** `days` policies count weekdays; `uses` policies count one occurrence. */
  unit: "days" | "uses";
  balance: number;
};

const SHORT_LEAVE = "Short leave";

export function ApplyForm({
  action,
  options,
  approverName,
  defaultFrom,
  defaultTo,
}: {
  action: (formData: FormData) => void | Promise<void>;
  options: ApplyOption[];
  approverName: string;
  defaultFrom: string;
  defaultTo: string;
}) {
  const [type, setType] = useState(options[0]?.name ?? SHORT_LEAVE);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);

  const option = options.find((o) => o.name === type);
  const isShort = type === SHORT_LEAVE || option?.unit === "uses";

  const unitSuffix = isShort ? "use" : "days";
  const cost = isShort ? 1 : workdays(from, to);
  const balance = option?.balance ?? 0;
  const after = balance - cost;

  return (
    <form action={action} className="grid items-start gap-6 xl:grid-cols-[1.2fr_0.8fr]">
      <div className="flex flex-col gap-4.5 rounded-xl border border-line bg-surface p-6">
        <label className="flex flex-col gap-1.5 text-xs text-muted">
          Leave type
          <select
            name="type"
            value={type}
            onChange={(event) => setType(event.target.value)}
            className={selectClass}
          >
            {options.map((item) => (
              <option key={item.name} value={item.name}>
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
              name="from"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className={inputClass}
            />
          </label>

          <label className="flex flex-col gap-1.5 text-xs text-muted">
            To
            <input
              type="date"
              name="to"
              value={isShort ? from : to}
              disabled={isShort}
              onChange={(event) => setTo(event.target.value)}
              className={`${inputClass} disabled:text-muted`}
            />
          </label>
        </div>

        {isShort ? (
          <p className="rounded-lg bg-subtle px-3 py-2.5 text-[12.5px] text-muted">
            A 2-hour short leave on {from || "the selected day"} — no need to set an
            end date.
          </p>
        ) : null}

        <label className="flex flex-col gap-1.5 text-xs text-muted">
          Reason
          <textarea
            name="reason"
            rows={4}
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
          <span className="text-[40px] font-semibold tracking-[-0.02em]">
            {isShort ? "2 hrs" : cost}
          </span>
          <span className="text-[13px] text-muted">
            {isShort ? "one-time use" : "working days"}
          </span>
        </span>

        <dl className="flex flex-col gap-2.5 border-t border-brand-tint pt-3.5 text-[13px]">
          <div className="flex justify-between">
            <dt className="text-muted">{type} balance</dt>
            <dd>
              {balance} {unitSuffix}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">After approval</dt>
            <dd>
              {after} {unitSuffix}
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
