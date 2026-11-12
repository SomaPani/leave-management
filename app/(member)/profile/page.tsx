import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import {
  Card,
  Detail,
  MonoLabel,
  ghostButtonClass,
  inputClass,
  primaryButtonClass,
  textareaClass,
} from "@/components/ui";
import { formatDayMonthYear } from "@/lib/date";
import { initialsFor } from "@/lib/domain";
import { requirePageActor } from "@/lib/page-guards";
import { updateOwnContactAction } from "@/lib/profile-actions";
import { ownProfileDetails } from "@/lib/services";

/**
 * Member: their own record on file.
 *
 * Every value is the signed-in member's own row via `ownProfileDetails`; a
 * field nobody has filled in shows a dash. The member may edit their contact,
 * address and emergency details (`?edit=1` opens the form); identity, role and
 * reporting fields stay with the admin on /team.
 */
export default async function ProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ edit?: string; error?: string }>;
}) {
  const actor = await requirePageActor();
  const params = await searchParams;
  const user = await ownProfileDetails(actor);
  const editing = params.edit === "1";

  const joined = user.joinedOn ? formatDayMonthYear(user.joinedOn) : "—";

  const groups = [
    {
      section: "CONTACT",
      items: [
        { label: "Work email", value: user.email },
        { label: "Other email", value: user.personalEmail ?? "—" },
        { label: "Contact number", value: user.phone ?? "—" },
      ],
    },
    {
      section: "ADDRESS",
      items: [
        { label: "Current address", value: user.address ?? "—" },
        { label: "Permanent address", value: user.permanentAddress ?? "—" },
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
        subtitle="Your record on file. Keep your contact details current; ask your admin to change anything else."
        meta="MEMBER VIEW"
      />

      {params.error ? (
        <p
          role="alert"
          className="max-w-[900px] rounded-lg border border-danger-line bg-danger-tint px-3.5 py-2.5 text-[13px] text-danger"
        >
          {params.error}
        </p>
      ) : null}

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

        {editing ? (
          <ContactForm user={user} />
        ) : (
          <div className="flex justify-end">
            <Link href="/profile?edit=1" className={ghostButtonClass}>
              Edit contact details
            </Link>
          </div>
        )}

        {groups
          .filter((group) => !editing || group.section === "ROLE")
          .map((group) => (
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

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-xs text-muted">
      {label}
      {children}
    </label>
  );
}

/**
 * The fields a member may change: contact, both addresses and the emergency
 * contact. Each input carries its current value, so a box left blank on
 * purpose clears that field.
 */
function ContactForm({
  user,
}: {
  user: Awaited<ReturnType<typeof ownProfileDetails>>;
}) {
  return (
    <Card className="p-5">
      <form action={updateOwnContactAction} className="flex flex-col gap-5">
        <MonoLabel>CONTACT</MonoLabel>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-x-7 gap-y-4">
          <Detail label="Work email" value={user.email} />
          <Labelled label="Other email">
            <input
              name="personalEmail"
              type="email"
              defaultValue={user.personalEmail ?? ""}
              placeholder="you@example.com"
              autoComplete="email"
              className={inputClass}
            />
          </Labelled>
          <Labelled label="Contact number">
            <input
              name="phone"
              type="tel"
              defaultValue={user.phone ?? ""}
              placeholder="+91 98765 43210"
              autoComplete="tel"
              className={inputClass}
            />
          </Labelled>
        </div>

        <MonoLabel>ADDRESS</MonoLabel>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-x-7 gap-y-4">
          <Labelled label="Current address">
            <textarea
              name="address"
              rows={3}
              defaultValue={user.address ?? ""}
              placeholder="Where you live now"
              autoComplete="street-address"
              className={textareaClass}
            />
          </Labelled>
          <Labelled label="Permanent address">
            <textarea
              name="permanentAddress"
              rows={3}
              defaultValue={user.permanentAddress ?? ""}
              placeholder="Your home address on record"
              className={textareaClass}
            />
          </Labelled>
        </div>

        <MonoLabel>EMERGENCY</MonoLabel>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-x-7 gap-y-4">
          <Labelled label="Contact name">
            <input
              name="emergencyName"
              defaultValue={user.emergencyName ?? ""}
              placeholder="Name (relationship)"
              className={inputClass}
            />
          </Labelled>
          <Labelled label="Contact number">
            <input
              name="emergencyPhone"
              type="tel"
              defaultValue={user.emergencyPhone ?? ""}
              placeholder="+91 98765 43210"
              className={inputClass}
            />
          </Labelled>
        </div>

        <div className="flex gap-3 border-t border-line pt-4">
          <button type="submit" className={primaryButtonClass}>
            Save
          </button>
          <Link href="/profile" className={ghostButtonClass}>
            Cancel
          </Link>
        </div>
      </form>
    </Card>
  );
}
