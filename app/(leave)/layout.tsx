import { Role } from "@/generated/prisma/enums";
import { SidebarNav, type NavItem } from "@/components/sidebar-nav";
import { Avatar } from "@/components/ui";
import { auth } from "@/lib/auth";
import { pendingRequests } from "@/lib/domain";
import { signOutAction } from "@/lib/org-actions";
import { requirePageRole } from "@/lib/page-guards";
import { COMPANY_NAME, seedDb } from "@/lib/seed";

/**
 * Shell for the admin leave screens.
 *
 * Deliberately not the leave-management `(dashboard)` layout: that one reads
 * `readDb()` and signs a `Person` in off the `lm_user` cookie, both of which
 * depend on tables that no longer exist. This one is guarded by the Auth.js
 * session and every screen under it renders the in-memory fixture.
 */

const NAV: NavItem[] = [
  { href: "/approvals", label: "Approvals" },
  { href: "/attendance", label: "Attendance" },
  { href: "/team", label: "Team" },
  { href: "/setup", label: "Leave setup" },
  { href: "/scores", label: "Employee score board" },
  { href: "/holidays", label: "Holiday calendar" },
];

export default async function LeaveLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const actor = await requirePageRole(Role.ADMIN);
  const session = await auth();
  const pending = pendingRequests(seedDb()).length;

  const items = NAV.map((item) =>
    item.href === "/approvals" ? { ...item, badge: pending } : item,
  );

  const name = session?.user?.name ?? "Administrator";
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="grid min-h-screen grid-cols-[236px_minmax(0,1fr)]">
      <aside className="sticky top-0 flex h-screen flex-col gap-7 bg-brand-deep px-4 py-6 text-white">
        <div className="px-2 font-mono text-xs tracking-[0.16em] text-brand-mute uppercase">
          {COMPANY_NAME}
        </div>

        <SidebarNav items={items} />

        <div className="mt-auto flex flex-col gap-3 border-t border-white/15 pt-4">
          <div className="flex items-center gap-2.5 px-1">
            <Avatar
              initials={initials}
              size={32}
              className="bg-white/15 text-white"
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-semibold">{name}</span>
              <span className="text-[11px] text-brand-mute">
                {actor.role === Role.ADMIN ? "Administrator" : actor.role}
              </span>
            </span>
          </div>
          <form action={signOutAction}>
            <button
              type="submit"
              className="w-full cursor-pointer rounded-lg border border-brand-mute/50 bg-transparent px-3 py-2 text-xs text-brand-mute transition-colors hover:border-white hover:text-white"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <main className="flex min-w-0 max-w-[1180px] flex-col gap-7 px-10 pt-9 pb-16">
        {children}
      </main>
    </div>
  );
}
