import { EmploymentStatus, LeaveRequestStatus, LeaveUnit, Role } from "@/generated/prisma/enums";
import { fromDbDate, toDbDate, todayIso } from "@/lib/attendance";
import { addDays } from "@/lib/date";
import {
  type DayCounts,
  type Period,
  type ResolvedDay,
  countDays,
  periodRange,
  resolveDay,
} from "@/lib/day-status";
import { prisma } from "@/lib/prisma";
import { type Actor, HttpError, canListAttendance, visibleOrgId } from "@/lib/rbac";

/**
 * The admin Overview: who is in today, and one person's month, quarter or
 * year. Read-only — nothing here writes.
 *
 * Every view is four reads whatever its length (members, attendance marks,
 * approved day-based leave, holidays), then lib/day-status.ts decides each day
 * in memory. Scoped like the Attendance screen: `canListAttendance` for the
 * role, `visibleOrgId` for the organization.
 */

const MEMBER_FIELDS = {
  id: true,
  name: true,
  title: true,
  empId: true,
  joinedOn: true,
  organizationId: true,
  regionId: true,
  region: { select: { name: true } },
} as const;

type MemberRow = {
  id: string;
  name: string;
  title: string | null;
  empId: string | null;
  joinedOn: Date | null;
  organizationId: string | null;
  regionId: string | null;
  region: { name: string } | null;
};

export type OverviewMember = {
  id: string;
  name: string;
  title: string | null;
  empId: string | null;
  region: string | null;
};

export type OverviewPerson = OverviewMember & { today: ResolvedDay };

function scope(actor: Actor): { organizationId?: string } {
  if (!canListAttendance(actor)) {
    throw new HttpError(403, "Your role does not permit this action.");
  }
  const organizationId = visibleOrgId(actor);
  return organizationId ? { organizationId } : {};
}

function toMember(row: MemberRow): OverviewMember {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    empId: row.empId,
    region: row.region?.name ?? null,
  };
}

/** Each member's resolved days over `from`..`to`, oldest first. */
async function resolveRange(
  members: MemberRow[],
  from: string,
  to: string,
  today: string,
): Promise<Map<string, ResolvedDay[]>> {
  const result = new Map<string, ResolvedDay[]>(members.map((m) => [m.id, []]));
  if (members.length === 0 || to < from) return result;

  const userIds = members.map((m) => m.id);
  const orgIds = [...new Set(members.map((m) => m.organizationId).filter((o): o is string => !!o))];
  const regionIds = [...new Set(members.map((m) => m.regionId).filter((r): r is string => !!r))];

  const [marks, leaves, holidays] = await Promise.all([
    prisma.attendance.findMany({
      where: { userId: { in: userIds }, date: { gte: toDbDate(from), lte: toDbDate(to) } },
      select: { userId: true, date: true, status: true, modifier: true },
    }),
    prisma.leaveRequest.findMany({
      where: {
        userId: { in: userIds },
        status: LeaveRequestStatus.APPROVED,
        policy: { unit: LeaveUnit.DAYS },
        startDate: { lte: toDbDate(to) },
        endDate: { gte: toDbDate(from) },
      },
      select: { userId: true, startDate: true, endDate: true, policy: { select: { name: true } } },
    }),
    prisma.holiday.findMany({
      where: {
        organizationId: { in: orgIds },
        OR: [{ regionId: null }, { regionId: { in: regionIds } }],
        startDate: { lte: toDbDate(to) },
        endDate: { gte: toDbDate(from) },
      },
      select: { organizationId: true, regionId: true, name: true, startDate: true, endDate: true },
    }),
  ]);

  const markOf = new Map(marks.map((m) => [`${m.userId}|${fromDbDate(m.date)}`, m]));
  const leaveSpans = leaves.map((l) => ({
    userId: l.userId,
    from: fromDbDate(l.startDate),
    to: fromDbDate(l.endDate),
    name: l.policy.name,
  }));
  const holidaySpans = holidays.map((h) => ({
    regionId: h.regionId,
    from: fromDbDate(h.startDate),
    to: fromDbDate(h.endDate),
    name: h.name,
  }));

  for (const member of members) {
    const joinedOn = member.joinedOn ? member.joinedOn.toISOString().slice(0, 10) : null;
    const days = result.get(member.id)!;
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const mark = markOf.get(`${member.id}|${date}`);
      const leave = leaveSpans.find((l) => l.userId === member.id && l.from <= date && date <= l.to);
      const holiday = holidaySpans.find(
        (h) => (h.regionId === null || h.regionId === member.regionId) && h.from <= date && date <= h.to,
      );
      const day = resolveDay({
        date,
        today,
        joinedOn,
        mark: mark ? { status: mark.status, modifier: mark.modifier } : null,
        leave: leave ? { policyName: leave.name } : null,
        holiday: holiday ? { name: holiday.name } : null,
      });
      if (day) days.push(day);
    }
  }
  return result;
}

/** Today's counts and everyone's status, people sorted by name. */
export async function todayOverview(
  actor: Actor,
  today: string = todayIso(),
): Promise<{ date: string; counts: DayCounts; total: number; people: OverviewPerson[] }> {
  const where = scope(actor);
  const members = await prisma.user.findMany({
    where: { ...where, role: Role.MEMBER, status: EmploymentStatus.ACTIVE },
    select: MEMBER_FIELDS,
    orderBy: [{ name: "asc" }],
  });

  const days = await resolveRange(members, today, today, today);
  const people: OverviewPerson[] = [];
  for (const member of members) {
    // A member who has not joined yet has no "today".
    const day = days.get(member.id)?.[0];
    if (day) people.push({ ...toMember(member), today: day });
  }

  return {
    date: today,
    counts: countDays(people.map((p) => p.today)),
    total: people.length,
    people,
  };
}

/** One member's days over a period, newest first. 404 outside the caller's org. */
export async function memberPeriod(
  actor: Actor,
  userId: string,
  period: Period,
  anchor: string,
  today: string = todayIso(),
): Promise<{
  member: OverviewMember;
  range: { from: string; to: string; label: string };
  days: ResolvedDay[];
  counts: DayCounts;
}> {
  const where = scope(actor);
  const member = await prisma.user.findFirst({
    where: { ...where, id: userId, role: Role.MEMBER },
    select: MEMBER_FIELDS,
  });
  if (!member) throw new HttpError(404, "That person does not exist.");

  const range = periodRange(period, anchor, today);
  const days = (await resolveRange([member], range.from, range.to, today)).get(member.id) ?? [];
  days.reverse();

  return { member: toMember(member), range, days, counts: countDays(days) };
}
