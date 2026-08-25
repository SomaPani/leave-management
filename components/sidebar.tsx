import { signOut } from "@/lib/actions";
import { pendingRequests } from "@/lib/domain";
import { COMPANY_NAME } from "@/lib/seed";
import type { Db, Person } from "@/lib/types";

import { Avatar } from "@/components/ui";
import { SidebarNav, type NavItem } from "@/components/sidebar-nav";

const ADMIN_NAV: NavItem[] = [
  { href: "/approvals", label: "Approvals" },
  { href: "/attendance", label: "Attendance" },
  { href: "/team", label: "Team" },
  { href: "/setup", label: "Leave setup" },
  { href: "/scores", label: "Employee score board" },
];

const MEMBER_NAV: NavItem[] = [
  { href: "/profile", label: "My profile" },
  { href: "/overview", label: "Overview" },
  { href: "/calendar", label: "My attendance" },
  { href: "/apply", label: "Apply for leave" },
  { href: "/requests", label: "My requests" },
  { href: "/score", label: "My score board" },
];

export function Sidebar({ user, db }: { user: Person; db: Db }) {
  const isAdmin = user.role === "admin";

  const items: NavItem[] = isAdmin
    ? ADMIN_NAV.map((item) =>
        item.href === "/approvals"
          ? { ...item, badge: pendingRequests(db).length }
          : item,
      )
    : MEMBER_NAV;

  return (
    <aside className="sticky top-0 flex h-screen flex-col gap-7 bg-brand-deep px-4 py-6 text-white">
      <div className="px-2 font-mono text-xs tracking-[0.16em] text-brand-mute uppercase">
        {COMPANY_NAME}
      </div>

      <SidebarNav items={items} />

      <div className="mt-auto flex flex-col gap-3 border-t border-white/15 pt-4">
        <div className="flex items-center gap-2.5 px-1">
          <Avatar initials={user.initials} size={32} className="bg-white/15 text-white" />
          <span className="flex flex-col">
            <span className="text-[13px] font-semibold">{user.name}</span>
            <span className="text-[11px] text-brand-mute">
              {isAdmin ? "Administrator" : user.title}
            </span>
          </span>
        </div>
        <form action={signOut}>
          <button
            type="submit"
            className="w-full cursor-pointer rounded-lg border border-brand-mute/50 bg-transparent px-3 py-2 text-xs text-brand-mute transition-colors hover:border-white hover:text-white"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
