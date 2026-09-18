"use client";

import { useMemo, useState } from "react";

import {
  MonoLabel,
  inputClass,
  primaryButtonClass,
  selectClass,
  textareaClass,
} from "@/components/ui";
import {
  MAX_SHORT_LEAVE_MINUTES,
  type LeaveUnitName,
  costFrom,
  formatClockTime,
  parseClockTime,
  shortLeaveTimes,
  unitNoun,
} from "@/lib/leave";

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
  today,
}: {
  action: (formData: FormData) => void | Promise<void>;
  options: ApplyOption[];
  approverName: string;
  /** Every holiday date that applies to this member, for the live day count. */
  holidayDates: string[];
  defaultFrom: string;
  defaultTo: string;
  /** The server's today, so a short leave cannot be dated anywhere else. */
  today: string;
}) {
  const [policyId, setPolicyId] = useState(options[0]?.id ?? "");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");

  const off = useMemo(() => new Set(holidayDates), [holidayDates]);

  const option = options.find((item) => item.id === policyId);
  const unit: LeaveUnitName = option?.unit ?? "DAYS";
  const isUses = unit === "USES";

  // A short leave is for today, so the date stops being a choice. Snapping it
  // in the render rather than in an effect keeps the posted value and the
  // shown value the same on the very first frame — an effect would submit
  // whatever the previous selection left behind if the member is quick.
  const start = isUses ? today : from;
  const end = isUses ? start : to;
  // `costFrom` is the same function lib/leave-service.ts prices the row with,
  // so the number under the button and the number in the database cannot
  // disagree.
  const cost = costFrom(unit, start, end, off);
  const holidayDays = costFrom(unit, start, end, NO_HOLIDAYS) - cost;

  const startMinutes = parseClockTime(startTime);
  const endMinutes = parseClockTime(endTime);
  // The same function lib/leave-service.ts refuses with, so the sentence the
  // member reads beside the inputs is the sentence the server would have
  // sent — not a second copy of the rule that drifts from it.
  const timeRefusal = isUses
    ? shortLeaveTimes(unit, startMinutes, endMinutes, start, today)
    : null;
  const spanMinutes =
    startMinutes !== null && endMinutes !== null ? endMinutes - startMinutes : 0;

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
              // A disabled control is not submitted, so the visible input
              // loses its name when it locks and the hidden one below carries
              // the date instead. Without that the post arrives with no
              // startDate at all and the parser refuses it — the one thing
              // that makes locking the field different from disabling `To`,
              // which the parser is happy to default.
              name={isUses ? undefined : "startDate"}
              value={start}
              disabled={isUses}
              onChange={(event) => setFrom(event.target.value)}
              className={`${inputClass} disabled:text-muted`}
            />
            {isUses ? <input type="hidden" name="startDate" value={start} /> : null}
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
          <>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-xs text-muted">
                Start time
                <input
                  type="time"
                  name="startTime"
                  value={startTime}
                  required
                  onChange={(event) => setStartTime(event.target.value)}
                  className={inputClass}
                />
              </label>

              <label className="flex flex-col gap-1.5 text-xs text-muted">
                End time
                <input
                  type="time"
                  name="endTime"
                  value={endTime}
                  required
                  onChange={(event) => setEndTime(event.target.value)}
                  className={inputClass}
                />
              </label>
            </div>

            {timeRefusal ? (
              <p className="rounded-lg border border-danger-line bg-danger-tint px-3.5 py-2.5 text-[12.5px] text-danger">
                {timeRefusal}
              </p>
            ) : (
              <p className="rounded-lg bg-subtle px-3 py-2.5 text-[12.5px] text-muted">
                {spanMinutes > 0
                  ? `${formatClockTime(startMinutes as number)} – ${formatClockTime(
                      endMinutes as number,
                    )} today, ${spanMinutes} minutes.`
                  : `Today only, up to ${MAX_SHORT_LEAVE_MINUTES / 60} hours.`}
              </p>
            )}
          </>
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
          <button
            type="submit"
            disabled={timeRefusal !== null}
            className={primaryButtonClass}
          >
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
