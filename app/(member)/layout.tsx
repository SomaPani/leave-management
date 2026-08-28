import { Role } from "@/generated/prisma/enums";
import { SidebarNav, type NavItem } from "@/components/sidebar-nav";
import { Avatar } from "@/components/ui";
import { auth } from "@/lib/auth";
import { demoDb, demoMember } from "@/lib/demo-data";
import { signOutAction } from "@/lib/org-actions";
import { requirePageRole } from "@/lib/page-guards";
import { COMPANY_NAME } from "@/lib/seed";

/**
 * Shell for the member leave screens — the mirror of app/(leave)/layout.tsx.
 *
 * The screens under it render the fixture person (see lib/demo-data.ts), but
 * the sidebar shows whoever is actually signed in: the balances are sample
 * data, the session is not, and conflating the two would be confusing. The job
 * title comes from the fixture, since an Auth.js user has no such field.
 */

const NAV: NavItem[] = [
  { href: "/profile", label: "My profile" },
  { href: "/overview", label: "Overview" },
  { href: "/calendar", label: "My attendance" },
  { href: "/apply", label: "Apply for leave" },
  { href: "/requests", label: "My requests" },
  { href: "/score", label: "My score board" },
];

export default async function MemberLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requirePageRole(Role.MEMBER);
  const session = await auth();
  const title = demoMember(demoDb()).title;

  const name = session?.user?.name ?? "Member";
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

        <SidebarNav items={NAV} />

        <div className="mt-auto flex flex-col gap-3 border-t border-white/15 pt-4">
          <div className="flex items-center gap-2.5 px-1">
            <Avatar
              initials={initials}
              size={32}
              className="bg-white/15 text-white"
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-semibold">{name}</span>
              <span className="text-[11px] text-brand-mute">{title}</span>
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
