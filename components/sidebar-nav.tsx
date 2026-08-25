"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = { href: string; label: string; badge?: number };

export function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm no-underline transition-colors ${
              active
                ? "bg-line text-brand hover:text-brand"
                : "text-brand-mute hover:bg-white/5 hover:text-white"
            }`}
          >
            <span className="flex-1">{item.label}</span>
            {item.badge ? (
              <span className="rounded-full bg-white px-[7px] py-[2px] font-mono text-[11px] text-brand">
                {item.badge}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
