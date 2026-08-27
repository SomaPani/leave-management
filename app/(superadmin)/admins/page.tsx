import { Role } from "@/generated/prisma/enums";
import { auth } from "@/lib/auth";
import { createAdminAction } from "@/lib/org-actions";
import { requirePageRole } from "@/lib/page-guards";
import { listAdmins, listOrganizations } from "@/lib/services";
import { Field, OrgShell, Section } from "@/components/org-shell";

/**
 * SuperAdmin: create an Admin and assign them to an organization.
 *
 * The organization is picked here rather than derived from the session — a
 * SuperAdmin has none of their own. Member creation is the opposite case; see
 * `memberOrganizationFor` in lib/rbac.ts.
 */

export default async function AdminsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const actor = await requirePageRole(Role.SUPERADMIN);
  const [{ error }, session, organizations, admins] = await Promise.all([
    searchParams,
    auth(),
    listOrganizations(actor),
    listAdmins(actor),
  ]);

  return (
    <OrgShell
      title="System administration"
      role={actor.role}
      email={session?.user?.email ?? ""}
      error={error}
    >
      <Section heading={`Admins (${admins.length})`}>
        {admins.length === 0 ? (
          <p>No admins yet.</p>
        ) : (
          <table cellPadding={6} style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th align="left">Name</th>
                <th align="left">Email</th>
                <th align="left">Organization</th>
                <th align="left">Created</th>
              </tr>
            </thead>
            <tbody>
              {admins.map((admin) => (
                <tr key={admin.id} style={{ borderTop: "1px solid #ddd" }}>
                  <td>{admin.name}</td>
                  <td>{admin.email}</td>
                  <td>{admin.organization?.name ?? "—"}</td>
                  <td>{admin.createdAt.toISOString().slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section heading="Create an admin">
        {organizations.length === 0 ? (
          <p>
            Create an organization first — an admin has to belong to one.
          </p>
        ) : (
          <form action={createAdminAction}>
            <Field label="Name" name="name" />
            <Field label="Email" name="email" type="email" autoComplete="off" />
            <Field
              label="Initial password"
              name="password"
              type="password"
              autoComplete="new-password"
              minLength={8}
            />
            <label style={{ display: "block", marginBottom: "0.5rem" }}>
              <span style={{ display: "block", fontSize: "0.875rem" }}>
                Organization
              </span>
              <select name="organizationId" required defaultValue="">
                <option value="" disabled>
                  Choose an organization
                </option>
                {organizations.map((organization) => (
                  <option key={organization.id} value={organization.id}>
                    {organization.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">Create admin</button>
          </form>
        )}
      </Section>
    </OrgShell>
  );
}
