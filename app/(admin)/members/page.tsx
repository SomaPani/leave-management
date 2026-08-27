import { Role } from "@/generated/prisma/enums";
import { auth } from "@/lib/auth";
import { createMemberAction } from "@/lib/org-actions";
import { requirePageRole } from "@/lib/page-guards";
import { listMembers } from "@/lib/services";
import { Field, OrgShell, Section } from "@/components/org-shell";

/**
 * Admin: the members of their own organization.
 *
 * There is no organization picker on the form on purpose — the new member's
 * organization comes from this admin's session, never from the submitted form.
 */

export default async function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const actor = await requirePageRole(Role.ADMIN);
  const [{ error }, session, members] = await Promise.all([
    searchParams,
    auth(),
    listMembers(actor),
  ]);

  const organizationName = members[0]?.organization?.name;

  return (
    <OrgShell
      title="Organization administration"
      role={actor.role}
      email={session?.user?.email ?? ""}
      error={error}
    >
      <Section heading={`Members${organizationName ? ` · ${organizationName}` : ""} (${members.length})`}>
        {members.length === 0 ? (
          <p>No members yet.</p>
        ) : (
          <table cellPadding={6} style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th align="left">Name</th>
                <th align="left">Email</th>
                <th align="left">Created</th>
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.id} style={{ borderTop: "1px solid #ddd" }}>
                  <td>{member.name}</td>
                  <td>{member.email}</td>
                  <td>{member.createdAt.toISOString().slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section heading="Add a member">
        <form action={createMemberAction}>
          <Field label="Name" name="name" />
          <Field label="Email" name="email" type="email" autoComplete="off" />
          <Field
            label="Initial password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
          />
          <button type="submit">Add member</button>
        </form>
        <p style={{ fontSize: "0.8125rem", color: "#555", marginTop: "0.5rem" }}>
          They join your organization and can sign in immediately with the
          password you set.
        </p>
      </Section>
    </OrgShell>
  );
}
