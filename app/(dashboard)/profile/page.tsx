import { PageHeader } from "@/components/page-header";
import { AutoSubmitForm } from "@/components/auto-submit-form";
import { Card, Detail, MonoLabel } from "@/components/ui";
import { removeDocument, uploadDocuments } from "@/lib/actions";
import { requireMember } from "@/lib/session";
import { readDb } from "@/lib/store";

function formatSize(bytes: number): string {
  return bytes > 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default async function ProfilePage() {
  const user = await requireMember();
  const db = await readDb();
  const documents = db.documents[user.id] ?? [];

  const groups = [
    {
      section: "CONTACT",
      items: [
        { label: "Work email", value: user.email },
        { label: "Other email", value: user.personalEmail ?? "—" },
        { label: "Contact number", value: user.phone ?? "—" },
        { label: "Address", value: user.address ?? "—" },
      ],
    },
    {
      section: "EMERGENCY",
      items: [
        { label: "Contact name", value: user.emergencyName ?? "—" },
        { label: "Contact number", value: user.emergencyPhone ?? "—" },
      ],
    },
    {
      section: "ROLE",
      items: [
        { label: "Designation", value: user.title },
        { label: "Reporting manager", value: user.manager ?? "Ananya Rao" },
        { label: "Region", value: user.region ?? "—" },
        { label: "Joined", value: user.joined ?? "—" },
      ],
    },
  ];

  return (
    <>
      <PageHeader
        title="My profile"
        subtitle="Your record on file. Ask your admin to change anything here."
        meta="MEMBER VIEW"
      />

      <div className="flex max-w-[900px] flex-col gap-5">
        <Card className="flex flex-wrap items-center gap-6 px-7 py-6">
          <span className="flex size-[88px] shrink-0 items-center justify-center rounded-full bg-brand-tint text-2xl font-semibold text-brand">
            {user.initials}
          </span>

          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-[26px] font-semibold tracking-[-0.02em]">
              {user.name}
            </span>
            <span className="text-sm text-muted">
              {user.title} · {user.region ?? "—"}
            </span>
          </span>

          <dl className="flex gap-7 font-mono text-xs text-muted">
            <div className="flex flex-col gap-1.5">
              <dd className="text-[15px] text-ink">{user.empId ?? "—"}</dd>
              <dt>EMPLOYEE ID</dt>
            </div>
            <div className="flex flex-col gap-1.5">
              <dd className="text-[15px] text-ink">{user.joined ?? "—"}</dd>
              <dt>JOINED</dt>
            </div>
          </dl>
        </Card>

        <Card className="flex flex-col gap-3.5 p-5">
          <span className="flex items-center justify-between gap-3">
            <MonoLabel>DOCUMENTS</MonoLabel>
            <AutoSubmitForm action={uploadDocuments}>
              <label className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-[13px] text-white transition-colors hover:bg-brand-dark">
                Choose File
                <input type="file" name="docs" multiple className="hidden" />
              </label>
            </AutoSubmitForm>
          </span>

          {documents.length === 0 ? (
            <span className="text-[13px] text-muted">
              No documents uploaded yet.
            </span>
          ) : (
            documents.map((doc) => (
              <span
                key={doc.id}
                className="flex items-center gap-3 border-b border-line py-2.5 last:border-b-0"
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-tint text-xs font-semibold text-brand-dark">
                  DOC
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[13.5px] font-medium">
                    {doc.name}
                  </span>
                  <span className="text-[11.5px] text-muted">
                    {formatSize(doc.size)}
                  </span>
                </span>
                <form action={removeDocument}>
                  <input type="hidden" name="docId" value={doc.id} />
                  <button
                    type="submit"
                    className="cursor-pointer rounded-[7px] border border-line bg-transparent px-2.5 py-1.5 text-xs text-muted transition-colors hover:border-danger hover:text-danger"
                  >
                    Remove
                  </button>
                </form>
              </span>
            ))
          )}
        </Card>

        {groups.map((group) => (
          <Card key={group.section} className="flex flex-col gap-3.5 p-5">
            <MonoLabel>{group.section}</MonoLabel>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-x-7 gap-y-4">
              {group.items.map((item) => (
                <Detail key={item.label} label={item.label} value={item.value} />
              ))}
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
