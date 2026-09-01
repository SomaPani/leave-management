import Link from "next/link";

import { EmploymentStatus, Role, WorkMode } from "@/generated/prisma/enums";
import { PageHeader } from "@/components/page-header";
import {
  Avatar,
  Card,
  EmptyPanel,
  ghostButtonClass,
  inputClass,
  primaryButtonClass,
  selectClass,
} from "@/components/ui";
import { auth } from "@/lib/auth";
import { initialsFor } from "@/lib/domain";
import { requirePageRole } from "@/lib/page-guards";
import { listMembers, listRegions } from "@/lib/services";
import {
  createRegionAction,
  createTeamMemberAction,
  deactivateTeamMemberAction,
  restoreTeamMemberAction,
  updateTeamMemberAction,
} from "@/lib/team-actions";

/**
 * Admin: the organization's roster, grouped by region.
 *
 * Reads `orgapp.User` through lib/services.ts — the same functions
 * `/api/members` and `/api/regions` call — so the screen and the API cannot
 * disagree about scope. The admin's organization comes from their session; no
 * organization id is ever read from the page's own URL.
 *
 * The score, balance and today's-status columns are still placeholders. They
 * belong to the leave-policy and attendance features, which have no tables yet;
 * rendering them as em dashes keeps the layout the design asked for without
 * inventing numbers. See Docs/2026-09-01-team-real-data-plan.md.
 */

const COLUMNS = "grid-cols-[1.7fr_0.6fr_repeat(4,0.8fr)_auto]";

/** Not yet backed by anything — see the note above. */
const PENDING = <span className="text-muted">—</span>;

type Member = Awaited<ReturnType<typeof listMembers>>[number];
type Region = Awaited<ReturnType<typeof listRegions>>[number];

function isoDay(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : "";
}

/** The muted second line under a person's name. */
function personMeta(member: Member): string {
  return [member.title, member.empId, member.workMode]
    .filter(Boolean)
    .join(" · ");
}

/* ------------------------------------------------------------------ form -- */

function Labelled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-xs text-muted">
      {label}
      {children}
    </label>
  );
}

/**
 * The add and edit forms are the same fields.
 *
 * On edit every input is rendered with the member's current value, which is
 * what makes a blank box mean "clear this" — the Server Action reads an empty
 * string as null. On add they start empty, and the ones left blank are simply
 * never set.
 */
function MemberFields({
  member,
  regions,
  managers,
}: {
  member?: Member;
  regions: Region[];
  managers: { id: string; name: string }[];
}) {
  return (
    <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
      <Labelled label="Full name">
        <input
          name="name"
          required
          defaultValue={member?.name ?? ""}
          placeholder="e.g. Aisha Khan"
          className={inputClass}
        />
      </Labelled>

      <Labelled label="Role">
        <input
          name="title"
          defaultValue={member?.title ?? ""}
          placeholder="e.g. Art director"
          className={inputClass}
        />
      </Labelled>

      <Labelled label="Work email">
        <input
          name="email"
          type="email"
          required
          defaultValue={member?.email ?? ""}
          placeholder="name@stacx24.com"
          className={inputClass}
        />
      </Labelled>

      <Labelled label={member ? "New password (optional)" : "Initial password"}>
        <input
          name="password"
          type="password"
          required={!member}
          minLength={8}
          autoComplete="new-password"
          placeholder={member ? "Leave blank to keep" : "At least 8 characters"}
          className={inputClass}
        />
      </Labelled>

      <Labelled label="Region">
        <select
          name="regionId"
          defaultValue={member?.region?.id ?? ""}
          className={selectClass}
        >
          <option value="">Unassigned</option>
          {regions.map((region) => (
            <option key={region.id} value={region.id}>
              {region.name}
            </option>
          ))}
        </select>
      </Labelled>

      <Labelled label="Working mode">
        <select
          name="workMode"
          defaultValue={member?.workMode ?? ""}
          className={selectClass}
        >
          <option value="">Not set</option>
          <option value={WorkMode.WFO}>WFO</option>
          <option value={WorkMode.WFH}>WFH</option>
        </select>
      </Labelled>

      <Labelled label="Employee ID">
        <input
          name="empId"
          defaultValue={member?.empId ?? ""}
          placeholder="e.g. STX-0142"
          className={inputClass}
        />
      </Labelled>

      <Labelled label="Joining date">
        <input
          name="joinedOn"
          type="date"
          defaultValue={isoDay(member?.joinedOn ?? null)}
          className={inputClass}
        />
      </Labelled>

      <Labelled label="Reports to">
        <select
          name="managerId"
          defaultValue={member?.manager?.id ?? ""}
          className={selectClass}
        >
          <option value="">No one</option>
          {managers
            .filter((candidate) => candidate.id !== member?.id)
            .map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
        </select>
      </Labelled>
    </div>
  );
}

/* ------------------------------------------------------------------ page -- */

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{
    add?: string;
    edit?: string;
    error?: string;
    status?: string;
    region?: string;
  }>;
}) {
  const actor = await requirePageRole(Role.ADMIN);
  const [params, session] = await Promise.all([searchParams, auth()]);

  const showInactive = params.status === "ALL";
  const [members, regions] = await Promise.all([
    listMembers(actor, { status: showInactive ? null : EmploymentStatus.ACTIVE }),
    listRegions(actor),
  ]);

  const editing = params.edit
    ? members.find((member) => member.id === params.edit)
    : undefined;

  // An admin may manage someone directly, so they are a candidate alongside
  // every active member. Both are inside this organization by construction.
  const managers = [
    { id: actor.id, name: `${session?.user?.name ?? "You"} (you)` },
    ...members
      .filter((member) => member.status === EmploymentStatus.ACTIVE)
      .map((member) => ({ id: member.id, name: member.name })),
  ];

  // Every region gets a section even when empty, so an admin can see the
  // grouping they created. People with no region fall into a final bucket.
  const groups = [
    ...regions.map((region) => ({
      key: region.id,
      name: region.name,
      people: members.filter((member) => member.region?.id === region.id),
    })),
    {
      key: "unassigned",
      name: "No region",
      people: members.filter((member) => !member.region),
    },
  ].filter((group) => group.people.length > 0 || group.key !== "unassigned");

  const active = members.filter((m) => m.status === EmploymentStatus.ACTIVE).length;

  return (
    <>
      <PageHeader
        title="Team"
        subtitle="Everyone in your organization, grouped by region."
        meta="ADMIN VIEW"
      />

      {params.error ? (
        <p
          role="alert"
          className="rounded-lg border border-danger-line bg-danger-tint px-3.5 py-2.5 text-[13px] text-danger"
        >
          {params.error}
        </p>
      ) : null}

      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <span className="text-[13px] text-muted">
            {active} {active === 1 ? "person" : "people"} across{" "}
            {regions.length} {regions.length === 1 ? "region" : "regions"}
            {showInactive ? " · showing past members too" : ""}
          </span>

          <span className="flex flex-wrap items-center gap-2.5">
            <Link
              href={showInactive ? "/team" : "/team?status=ALL"}
              className={`${ghostButtonClass} no-underline hover:text-ink`}
            >
              {showInactive ? "Hide past members" : "Show past members"}
            </Link>
            {params.region === "new" ? null : (
              <Link
                href="/team?region=new"
                className={`${ghostButtonClass} no-underline hover:text-ink`}
              >
                Add region
              </Link>
            )}
            {params.add === "1" ? null : (
              <Link
                href="/team?add=1"
                className={`${primaryButtonClass} no-underline hover:text-white`}
              >
                Add new
              </Link>
            )}
          </span>
        </div>

        {params.region === "new" ? (
          <Card className="border-brand p-5">
            <form action={createRegionAction} className="flex flex-wrap items-end gap-3">
              <Labelled label="Region name">
                <input
                  name="name"
                  required
                  placeholder="e.g. Chennai"
                  className={inputClass}
                />
              </Labelled>
              <button type="submit" className={primaryButtonClass}>
                Add region
              </button>
              <Link href="/team" className={`${ghostButtonClass} no-underline hover:text-ink`}>
                Cancel
              </Link>
            </form>
          </Card>
        ) : null}

        {params.add === "1" ? (
          <Card className="border-brand p-5">
            <form action={createTeamMemberAction} className="flex flex-col gap-4">
              <span className="text-[15px] font-semibold">Add someone to the team</span>

              <MemberFields regions={regions} managers={managers} />

              <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-3.5">
                <button type="submit" className={primaryButtonClass}>
                  Add to team
                </button>
                <Link href="/team" className={`${ghostButtonClass} no-underline hover:text-ink`}>
                  Cancel
                </Link>
                <span className="text-[12.5px] text-muted">
                  They can sign in immediately with the password you set.
                </span>
              </div>
            </form>
          </Card>
        ) : null}

        {editing ? (
          <Card className="border-brand p-5">
            <form action={updateTeamMemberAction} className="flex flex-col gap-4">
              <input type="hidden" name="id" value={editing.id} />
              <span className="text-[15px] font-semibold">
                Edit {editing.name}
              </span>

              <MemberFields member={editing} regions={regions} managers={managers} />

              <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-3.5">
                <button type="submit" className={primaryButtonClass}>
                  Save changes
                </button>
                <Link href="/team" className={`${ghostButtonClass} no-underline hover:text-ink`}>
                  Cancel
                </Link>
                <span className="text-[12.5px] text-muted">
                  Clearing a box empties that field.
                </span>
              </div>
            </form>
          </Card>
        ) : null}

        {members.length === 0 && regions.length === 0 ? (
          <EmptyPanel>
            No one on the team yet. Add a region, then add the people in it.
          </EmptyPanel>
        ) : null}

        {groups.map((group) => (
          <section key={group.key} className="flex flex-col gap-2.5">
            <div className="flex items-baseline gap-3">
              <h2 className="text-[15px] font-semibold tracking-[-0.01em]">
                {group.name}
              </h2>
              <span className="font-mono text-xs text-muted">
                {group.people.length}{" "}
                {group.people.length === 1 ? "person" : "people"}
              </span>
            </div>

            <Card className="overflow-x-auto">
              <div className="min-w-[820px]">
                <div
                  className={`grid ${COLUMNS} gap-4 border-b border-line bg-subtle px-4.5 py-3 font-mono text-[11px] tracking-[0.08em] text-muted`}
                >
                  <span>PERSON</span>
                  <span>SCORE</span>
                  <span>CASUAL</span>
                  <span>SICK</span>
                  <span>PAID</span>
                  <span>STATUS TODAY</span>
                  <span className="sr-only">Actions</span>
                </div>

                {group.people.length === 0 ? (
                  <p className="px-4.5 py-5 text-[13px] text-muted">
                    No one in this region yet.
                  </p>
                ) : (
                  group.people.map((member) => {
                    const inactive = member.status === EmploymentStatus.INACTIVE;
                    return (
                      <div
                        key={member.id}
                        className={`grid ${COLUMNS} items-center gap-4 border-b border-line px-4.5 py-3.5 last:border-b-0 ${
                          inactive ? "opacity-60" : ""
                        }`}
                      >
                        <span className="flex items-center gap-2.5">
                          <Avatar initials={initialsFor(member.name)} />
                          <span className="flex min-w-0 flex-col">
                            <span className="flex items-center gap-2 text-sm font-semibold">
                              {member.name}
                              {inactive ? (
                                <span className="rounded-md bg-line px-1.5 py-[1px] font-mono text-[10px] tracking-[0.08em] text-muted">
                                  PAST
                                </span>
                              ) : null}
                            </span>
                            <span className="truncate text-xs text-muted">
                              {personMeta(member) || member.email}
                            </span>
                          </span>
                        </span>

                        <span className="font-mono text-[13px]">{PENDING}</span>
                        <span className="font-mono text-[13px]">{PENDING}</span>
                        <span className="font-mono text-[13px]">{PENDING}</span>
                        <span className="font-mono text-[13px]">{PENDING}</span>
                        <span className="font-mono text-[13px]">{PENDING}</span>

                        <span className="flex items-center justify-end gap-2">
                          <Link
                            href={`/team?edit=${member.id}`}
                            className="text-[13px] text-brand hover:underline"
                          >
                            Edit
                          </Link>
                          <form
                            action={
                              inactive
                                ? restoreTeamMemberAction
                                : deactivateTeamMemberAction
                            }
                          >
                            <input type="hidden" name="id" value={member.id} />
                            <button
                              type="submit"
                              className={
                                inactive
                                  ? "cursor-pointer text-[13px] text-brand hover:underline"
                                  : "cursor-pointer text-[13px] text-danger hover:underline"
                              }
                            >
                              {inactive ? "Restore" : "Remove"}
                            </button>
                          </form>
                        </span>
                      </div>
                    );
                  })
                )}
              </div>
            </Card>
          </section>
        ))}

        <p className="text-[12.5px] text-muted">
          Score, leave balances and today&rsquo;s status arrive with the leave-policy
          and attendance features — the roster itself is live.
        </p>
      </div>
    </>
  );
}
