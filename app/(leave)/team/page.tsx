import Link from "next/link";

import { DemoBanner } from "@/components/demo-banner";
import { PageHeader } from "@/components/page-header";
import {
  Avatar,
  Card,
  ghostButtonClass,
  inputClass,
  primaryButtonClass,
  selectClass,
} from "@/components/ui";
import { demoAddTeamMember as addTeamMember } from "@/lib/demo-actions";
import { TODAY } from "@/lib/date";
import { attendanceCodes, balanceOf, allowance, roster } from "@/lib/domain";
import { REGIONS, SCORES, seedDb } from "@/lib/seed";
import { todayPill } from "@/lib/ui";

const COLUMNS = "grid-cols-[1.6fr_0.7fr_repeat(4,1fr)]";

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ add?: string; error?: string; demo?: string }>;
}) {
  const params = await searchParams;
  const addOpen = params.add === "1";

  const db = seedDb();
  const people = roster(db);

  const balanceCell = (userId: string, type: string) =>
    `${balanceOf(db, userId, type)} / ${allowance(db, type)}`;

  return (
    <>
      <PageHeader
        title="Team"
        subtitle="Balances and who's out today."
        meta="ADMIN VIEW"
      />

      <DemoBanner action={params.demo} />

      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between gap-4">
          <span className="text-[13px] text-muted">
            {people.length} {people.length === 1 ? "person" : "people"} across{" "}
            {REGIONS.join(" and ")}
          </span>
          {addOpen ? null : (
            <Link href="/team?add=1" className={`${primaryButtonClass} no-underline hover:text-white`}>
              Add new
            </Link>
          )}
        </div>

        {addOpen ? (
          <Card className="border-brand p-5">
            <form action={addTeamMember} className="flex flex-col gap-4">
              <span className="text-[15px] font-semibold">Add someone to the team</span>

              {params.error === "name" ? (
                <p className="text-[13px] text-danger">A full name is required.</p>
              ) : null}

              <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
                <label className="flex flex-col gap-1.5 text-xs text-muted">
                  Full name
                  <input
                    name="name"
                    required
                    placeholder="e.g. Aisha Khan"
                    className={inputClass}
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-xs text-muted">
                  Role
                  <input
                    name="title"
                    placeholder="e.g. Art director"
                    className={inputClass}
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-xs text-muted">
                  Work email
                  <input
                    name="email"
                    type="email"
                    placeholder="name@stacx24.com"
                    className={inputClass}
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-xs text-muted">
                  Region
                  <select name="region" defaultValue={REGIONS[0]} className={selectClass}>
                    {REGIONS.map((region) => (
                      <option key={region} value={region}>
                        {region}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1.5 text-xs text-muted">
                  Working mode
                  <select name="workMode" defaultValue="WFO" className={selectClass}>
                    <option value="WFO">WFO</option>
                    <option value="WFH">WFH</option>
                  </select>
                </label>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-3.5">
                <button type="submit" className={primaryButtonClass}>
                  Add to team
                </button>
                <Link href="/team" className={`${ghostButtonClass} no-underline hover:text-ink`}>
                  Cancel
                </Link>
                <span className="text-[12.5px] text-muted">
                  Starts on the standard policy —{" "}
                  {db.policies
                    .filter((p) => p.unit !== "uses")
                    .map((p) => `${p.days} ${p.name.toLowerCase()}`)
                    .join(", ")}
                  .
                </span>
              </div>
            </form>
          </Card>
        ) : null}

        {REGIONS.map((region) => {
          const members = people.filter((p) => (p.region ?? REGIONS[0]) === region);
          if (members.length === 0) return null;

          const out = members.filter((p) =>
            attendanceCodes(db, p.id, TODAY).includes("leave"),
          ).length;

          return (
            <section key={region} className="flex flex-col gap-2.5">
              <div className="flex items-baseline gap-3">
                <h2 className="text-[15px] font-semibold tracking-[-0.01em]">
                  {region}
                </h2>
                <span className="font-mono text-xs text-muted">
                  {members.length} {members.length === 1 ? "person" : "people"} ·{" "}
                  {out ? `${out} on leave today` : "everyone in"}
                </span>
              </div>

              <Card className="overflow-x-auto">
                <div className="min-w-[720px]">
                  <div
                    className={`grid ${COLUMNS} gap-4 border-b border-line bg-subtle px-4.5 py-3 font-mono text-[11px] tracking-[0.08em] text-muted`}
                  >
                    <span>PERSON</span>
                    <span>SCORE</span>
                    <span>CASUAL</span>
                    <span>SICK</span>
                    <span>PAID</span>
                    <span>STATUS TODAY</span>
                  </div>

                  {members.map((person) => {
                    const pill = todayPill(attendanceCodes(db, person.id, TODAY));
                    return (
                      <div
                        key={person.id}
                        className={`grid ${COLUMNS} items-center gap-4 border-b border-line px-4.5 py-3.5 last:border-b-0`}
                      >
                        <span className="flex items-center gap-2.5">
                          <Avatar initials={person.initials} />
                          <span className="flex flex-col">
                            <span className="text-sm font-semibold">{person.name}</span>
                            <span className="text-xs text-muted">{person.title}</span>
                          </span>
                        </span>
                        <span className="font-mono text-[13px] font-semibold">
                          {SCORES[person.id]?.total ?? "—"}
                        </span>
                        <span className="font-mono text-[13px]">
                          {balanceCell(person.id, "Casual")}
                        </span>
                        <span className="font-mono text-[13px]">
                          {balanceCell(person.id, "Sick")}
                        </span>
                        <span className="font-mono text-[13px]">
                          {balanceCell(person.id, "Paid / annual")}
                        </span>
                        <span
                          className={`justify-self-start rounded-md px-2.5 py-[3px] text-xs ${pill.className}`}
                        >
                          {pill.label}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </Card>
            </section>
          );
        })}
      </div>
    </>
  );
}
