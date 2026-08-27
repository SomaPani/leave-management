import { Role } from "@/generated/prisma/enums";
import { auth } from "@/lib/auth";
import { createOrganizationAction } from "@/lib/org-actions";
import { requirePageRole } from "@/lib/page-guards";
import { listOrganizations } from "@/lib/services";
import { Field, OrgShell, Section } from "@/components/org-shell";

/** SuperAdmin: every organization in the system, and a form to add one. */

export default async function OrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const actor = await requirePageRole(Role.SUPERADMIN);
  const [{ error }, session, organizations] = await Promise.all([
    searchParams,
    auth(),
    listOrganizations(actor),
  ]);

  return (
    <OrgShell
      title="System administration"
      role={actor.role}
      email={session?.user?.email ?? ""}
      error={error}
    >
      <Section heading={`Organizations (${organizations.length})`}>
        {organizations.length === 0 ? (
          <p>No organizations yet.</p>
        ) : (
          <table cellPadding={6} style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th align="left">Name</th>
                <th align="left">Users</th>
                <th align="left">Created</th>
                <th align="left">ID</th>
              </tr>
            </thead>
            <tbody>
              {organizations.map((organization) => (
                <tr key={organization.id} style={{ borderTop: "1px solid #ddd" }}>
                  <td>{organization.name}</td>
                  <td>{organization._count.users}</td>
                  <td>{organization.createdAt.toISOString().slice(0, 10)}</td>
                  <td>
                    <code style={{ fontSize: "0.8125rem" }}>{organization.id}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section heading="Create an organization">
        <form action={createOrganizationAction}>
          <Field label="Name" name="name" />
          <button type="submit">Create organization</button>
        </form>
      </Section>
    </OrgShell>
  );
}
