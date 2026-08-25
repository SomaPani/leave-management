import type { ReactNode } from "react";

import { TODAY, formatHeader } from "@/lib/date";

export function PageHeader({
  title,
  subtitle,
  meta,
}: {
  title: string;
  subtitle: string;
  /** Right-hand caption. Defaults to the current day. */
  meta?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-6 border-b border-line pb-5">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-[27px] font-semibold tracking-[-0.015em]">{title}</h1>
        <p className="text-sm text-muted">{subtitle}</p>
      </div>
      <div className="font-mono text-xs text-muted">
        {meta ?? formatHeader(TODAY)}
      </div>
    </header>
  );
}
