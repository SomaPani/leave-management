import type { ReactNode } from "react";

import { LeaveRequestStatus } from "@/generated/prisma/enums";
import { STATUS_STYLE } from "@/lib/ui";

/* Shared class strings, so form controls look identical everywhere. */

export const inputClass =
  "rounded-lg border border-line bg-subtle px-3 py-2.5 text-sm text-ink placeholder:text-muted";

export const selectClass =
  "rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-ink";

export const textareaClass =
  "resize-y rounded-lg border border-line bg-subtle px-3 py-2.5 text-sm text-ink placeholder:text-muted";

export const primaryButtonClass =
  "cursor-pointer rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-dark disabled:opacity-60";

export const ghostButtonClass =
  "cursor-pointer rounded-lg border border-line bg-surface px-4 py-2.5 text-sm transition-colors hover:border-muted";

export const dangerButtonClass =
  "cursor-pointer rounded-lg border border-danger-line bg-surface px-4 py-2.5 text-sm font-semibold text-danger transition-colors hover:bg-danger-tint";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-line bg-surface ${className}`}>
      {children}
    </div>
  );
}

/** The small uppercase monospace caption used above most panels. */
export function MonoLabel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`font-mono text-[11px] tracking-[0.1em] text-muted ${className}`}
    >
      {children}
    </span>
  );
}

export function Avatar({
  initials,
  size = 30,
  className = "",
}: {
  initials: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-full bg-line text-[11px] font-semibold text-ink-2 ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      {initials}
    </span>
  );
}

function Badge({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={`rounded-md px-2 py-[3px] font-mono text-[11px] tracking-[0.08em] ${className}`}
    >
      {label}
    </span>
  );
}

export function StatusBadge({ status }: { status: LeaveRequestStatus }) {
  return <Badge {...STATUS_STYLE[status]} />;
}

/** Dashed "nothing selected" placeholder. */
export function EmptyPanel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-dashed border-ink-2 bg-surface px-6 py-14 text-center text-sm text-muted ${className}`}
    >
      {children}
    </div>
  );
}

export function Meter({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <span className="block h-[5px] overflow-hidden rounded bg-line">
      <span
        className="block h-[5px] rounded bg-brand"
        style={{ width: `${clamped}%` }}
      />
    </span>
  );
}

/** Label + value pair used across the profile and detail panels. */
export function Detail({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-sm leading-relaxed font-medium text-pretty">{value}</span>
    </span>
  );
}
