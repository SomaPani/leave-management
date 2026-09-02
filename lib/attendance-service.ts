import {
  AttendanceModifier,
  AttendanceStatus,
  EmploymentStatus,
  Role,
  WorkMode,
} from "@/generated/prisma/enums";
import { fromDbDate, toDbDate, type AttendanceState } from "@/lib/attendance";
import { prisma } from "@/lib/prisma";
import { type Actor, HttpError, canListAttendance, visibleOrgId } from "@/lib/rbac";

/**
 * Everything that reads or writes the attendance tables.
 *
 * The same contract as lib/services.ts: both entry points — the route handlers
 * under app/api/attendance and the Server Actions behind the screen — come
 * through here, so authorization is decided in exactly one place per
 * operation. Callers pass an `Actor` they have already authenticated; nothing
 * here reads a cookie or a request.
 */

/** The member fields the attendance grid renders. */
const MEMBER_FIELDS = {
  id: true,
  name: true,
  title: true,
  empId: true,
  workMode: true,
  region: { select: { id: true, name: true } },
} as const;

export type AttendanceMember = {
  id: string;
  name: string;
  title: string | null;
  empId: string | null;
  workMode: WorkMode | null;
  region: { id: string; name: string } | null;
};

export type AttendanceDayRow = {
  member: AttendanceMember;
  /** `null` when the day has no row — "not marked yet". */
  state: AttendanceState | null;
};

export type AttendanceMark = {
  userId: string;
  date: string;
  status: AttendanceStatus;
  modifier: AttendanceModifier | null;
};

/* --------------------------------------------------------------- reading -- */

/**
 * The roster for one day, with each person's mark.
 *
 * Two queries rather than a join with a filtered relation: the roster is the
 * same every day, and the marks are a single indexed read on
 * `[organizationId, date]`. Members with no row come back with `state: null`,
 * which is what makes "unmarked" countable without a placeholder row.
 */
export async function listDayAttendance(
  actor: Actor,
  date: string,
): Promise<AttendanceDayRow[]> {
  if (!canListAttendance(actor)) {
    throw new HttpError(403, "Your role does not permit this action.");
  }

  const orgId = visibleOrgId(actor);
  const members = await prisma.user.findMany({
    where: {
      role: Role.MEMBER,
      status: EmploymentStatus.ACTIVE,
      ...(orgId ? { organizationId: orgId } : {}),
    },
    select: MEMBER_FIELDS,
    orderBy: [{ name: "asc" }],
  });

  if (members.length === 0) return [];

  const marks = await prisma.attendance.findMany({
    where: {
      date: toDbDate(date),
      userId: { in: members.map((m) => m.id) },
    },
    select: { userId: true, status: true, modifier: true },
  });

  const byUser = new Map(marks.map((m) => [m.userId, m]));

  return members.map((member) => {
    const mark = byUser.get(member.id);
    return {
      member,
      state: mark ? { status: mark.status, modifier: mark.modifier } : null,
    };
  });
}

/**
 * Raw marks over a span, for a whole organization or one member.
 *
 * The seam a member calendar and any monthly report read through. Scoped by
 * `visibleOrgId` like every other list, so a `userId` from another
 * organization simply matches nothing.
 */
export async function listRangeAttendance(
  actor: Actor,
  input: { from: string; to: string; userId?: string },
): Promise<AttendanceMark[]> {
  if (!canListAttendance(actor)) {
    throw new HttpError(403, "Your role does not permit this action.");
  }
  if (input.to < input.from) {
    throw new HttpError(400, '"to" must not be earlier than "from".');
  }

  const orgId = visibleOrgId(actor);
  const rows = await prisma.attendance.findMany({
    where: {
      date: { gte: toDbDate(input.from), lte: toDbDate(input.to) },
      ...(orgId ? { organizationId: orgId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
    },
    select: { userId: true, date: true, status: true, modifier: true },
    orderBy: [{ date: "asc" }, { userId: "asc" }],
  });

  return rows.map((row) => ({
    userId: row.userId,
    date: fromDbDate(row.date),
    status: row.status,
    modifier: row.modifier,
  }));
}
