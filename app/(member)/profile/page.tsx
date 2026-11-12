import { PageHeader } from "@/components/page-header";
import { Card, Detail, MonoLabel } from "@/components/ui";
import { formatDayMonthYear } from "@/lib/date";
import { initialsFor } from "@/lib/domain";
import { requirePageActor } from "@/lib/page-guards";
import { ownProfileDetails } from "@/lib/services";

/**
 * Member: their own record on file.
 *
 * Read-only by design — the subtitle sends changes to the admin, who edits the
 * same fields from /team. Every value is the signed-in member's own row via
 * `ownProfileDetails`; a field nobody has filled in shows a dash.
 */
export default async function ProfilePage() {
  const actor = await requirePageActor();
  const user = await ownProfileDetails(actor);

  const joined = user.joinedOn ? formatDayMonthYear(user.joinedOn) : "—";

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
        { label: "Designation", value: user.title ?? "—" },
        { label: "Reporting manager", value: user.manager ?? "—" },
        { label: "Region", value: user.region ?? "—" },
        { label: "Work mode", value: user.workMode ?? "—" },
        { label: "Joined", value: joined },
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
            {initialsFor(user.name)}
          </span>

          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="text-[26px] font-semibold tracking-[-0.02em]">
              {user.name}
            </span>
            <span className="text-sm text-muted">
              {user.title ?? "—"} · {user.region ?? "—"}
            </span>
          </span>

          <dl className="flex gap-7 font-mono text-xs text-muted">
            <div className="flex flex-col gap-1.5">
              <dd className="text-[15px] text-ink">{user.empId ?? "—"}</dd>
              <dt>EMPLOYEE ID</dt>
            </div>
            <div className="flex flex-col gap-1.5">
              <dd className="text-[15px] text-ink">{joined}</dd>
              <dt>JOINED</dt>
            </div>
          </dl>
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
