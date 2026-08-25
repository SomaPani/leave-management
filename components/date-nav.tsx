"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

/**
 * A date picker that drives a `?date=` search param instead of component state,
 * so the selected day survives reloads and can be linked to.
 */
export function DateNav({
  value,
  param = "date",
  className = "",
  id,
}: {
  value: string;
  param?: string;
  className?: string;
  id?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  return (
    <input
      id={id}
      type="date"
      value={value}
      disabled={pending}
      onChange={(event) => {
        const next = new URLSearchParams(searchParams);
        next.set(param, event.target.value);
        startTransition(() => router.replace(`${pathname}?${next}`));
      }}
      className={className}
    />
  );
}
