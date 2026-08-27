import { Role } from "@/generated/prisma/enums";
import { auth } from "@/lib/auth";
import { requirePageRole } from "@/lib/page-guards";
import { prisma } from "@/lib/prisma";
import { OrgShell, Section } from "@/components/org-shell";

/** Member: their own record, scoped to their own organization. */

export default async function AccountPage() {
  const actor = await requirePageRole(Role.MEMBER);
  const [session, me] = await Promise.all([
    auth(),
    prisma.user.findUnique({
      where: { id: actor.id },
      select: {
        name: true,
        email: true,
        createdAt: true,
        organization: { select: { name: true } },
      },
    }),
  ]);

  return (
    <OrgShell
      title="My account"
      role={actor.role}
      email={session?.user?.email ?? ""}
    >
      <Section heading="Your record">
        {me ? (
          <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.5rem 1.5rem" }}>
            <dt>Name</dt>
            <dd>{me.name}</dd>
            <dt>Email</dt>
            <dd>{me.email}</dd>
            <dt>Organization</dt>
            <dd>{me.organization?.name ?? "—"}</dd>
            <dt>Member since</dt>
            <dd>{me.createdAt.toISOString().slice(0, 10)}</dd>
          </dl>
        ) : (
          <p>Your account could not be loaded.</p>
        )}
      </Section>

      <Section heading="What you can do">
        <p>
          Members have read access to their own record. Creating and managing
          people is an admin capability.
        </p>
      </Section>
    </OrgShell>
  );
}
