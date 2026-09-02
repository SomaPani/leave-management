import {
  AttendanceModifier,
  AttendanceStatus,
  EmploymentStatus,
  Role,
  WorkMode,
} from "@/generated/prisma/enums";
import {
  assertMarkable,
  fromDbDate,
  isWorkingStatus,
  toDbDate,
  toggle,
  type AttendanceCode,
  type AttendanceState,
} from "@/lib/attendance";
import { prisma } from "@/lib/prisma";
import {
  type Actor,
  HttpError,
  canListAttendance,
  canMarkAttendance,
  visibleOrgId,
} from "@/lib/rbac";

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

/* --------------------------------------------------------------- writing -- */

/**
 * The member an admin may write against, or a 403.
 *
 * "Not found" and "belongs to another organization" answer identically, and
 * with a 403 rather than a 404, so this cannot be used to discover which user
 * ids exist elsewhere — the same rule `assertRegionInOrg` follows in
 * lib/services.ts.
 */
async function assertMarkableMember(
  actor: Actor,
  userId: string,
): Promise<{ organizationId: string }> {
  const member = await prisma.user.findUnique({
    where: { id: userId },
    select: { organizationId: true, role: true, status: true },
  });

  if (!member || !canMarkAttendance(actor, member.organizationId)) {
    throw new HttpError(403, "You cannot mark attendance for that person.");
  }
  if (member.role !== Role.MEMBER) {
    throw new HttpError(400, "Attendance is only recorded for team members.");
  }
  if (member.status !== EmploymentStatus.ACTIVE) {
    throw new HttpError(400, "That person is no longer on the team.");
  }

  // Non-null by canMarkAttendance: it only passes for an ADMIN, and an ADMIN
  // always carries an organization.
  return { organizationId: member.organizationId! };
}

/** The combination rule, checked before the database has to. */
function assertValidState(state: AttendanceState): void {
  if (state.modifier && !isWorkingStatus(state.status)) {
    throw new HttpError(
      400,
      "Half day and Short leave only apply to a day worked — Present or WFH.",
    );
  }
}

/**
 * Write one person's day, and log the change.
 *
 * The read, the write and the audit row share one transaction so a concurrent
 * edit cannot interleave between reading the previous value and recording it.
 */
export async function setAttendance(
  actor: Actor,
  input: {
    userId: string;
    date: string;
    status: AttendanceStatus;
    modifier: AttendanceModifier | null;
  },
): Promise<AttendanceState> {
  assertMarkable(input.date);
  assertValidState({ status: input.status, modifier: input.modifier });
  const { organizationId } = await assertMarkableMember(actor, input.userId);

  const date = toDbDate(input.date);

  return prisma.$transaction(async (tx) => {
    const previous = await tx.attendance.findUnique({
      where: { userId_date: { userId: input.userId, date } },
      select: { status: true, modifier: true },
    });

    const row = await tx.attendance.upsert({
      where: { userId_date: { userId: input.userId, date } },
      create: {
        userId: input.userId,
        organizationId,
        date,
        status: input.status,
        modifier: input.modifier,
        markedById: actor.id,
      },
      update: {
        status: input.status,
        modifier: input.modifier,
        markedById: actor.id,
      },
      select: { status: true, modifier: true },
    });

    await tx.attendanceEvent.create({
      data: {
        organizationId,
        userId: input.userId,
        date,
        fromStatus: previous?.status ?? null,
        fromModifier: previous?.modifier ?? null,
        toStatus: row.status,
        toModifier: row.modifier,
        actorId: actor.id,
      },
    });

    return { status: row.status, modifier: row.modifier };
  });
}

/**
 * Unmark a day.
 *
 * A no-op on a day that has no row: the caller asked for it to be unmarked and
 * it is, so raising a 404 would only make the grid's toggle harder to use.
 * Nothing is logged in that case either — there was no change.
 */
export async function clearAttendance(
  actor: Actor,
  input: { userId: string; date: string },
): Promise<void> {
  assertMarkable(input.date);
  const { organizationId } = await assertMarkableMember(actor, input.userId);

  const date = toDbDate(input.date);

  await prisma.$transaction(async (tx) => {
    const previous = await tx.attendance.findUnique({
      where: { userId_date: { userId: input.userId, date } },
      select: { status: true, modifier: true },
    });
    if (!previous) return;

    await tx.attendance.delete({
      where: { userId_date: { userId: input.userId, date } },
    });

    await tx.attendanceEvent.create({
      data: {
        organizationId,
        userId: input.userId,
        date,
        fromStatus: previous.status,
        fromModifier: previous.modifier,
        toStatus: null,
        toModifier: null,
        actorId: actor.id,
      },
    });
  });
}

/**
 * One button press on the grid.
 *
 * The next state is computed by `toggle` in lib/attendance.ts — the same pure
 * function the unit tests pin — so the screen's behaviour and the stored rules
 * cannot drift apart. Returns the new state, or `null` when the press cleared
 * the day.
 */
export async function toggleAttendanceCode(
  actor: Actor,
  input: { userId: string; date: string; code: AttendanceCode },
): Promise<AttendanceState | null> {
  assertMarkable(input.date);
  await assertMarkableMember(actor, input.userId);

  const current = await prisma.attendance.findUnique({
    where: { userId_date: { userId: input.userId, date: toDbDate(input.date) } },
    select: { status: true, modifier: true },
  });

  const next = toggle(current ?? null, input.code);

  if (!next) {
    await clearAttendance(actor, { userId: input.userId, date: input.date });
    return null;
  }

  return setAttendance(actor, {
    userId: input.userId,
    date: input.date,
    status: next.status,
    modifier: next.modifier,
  });
}

/**
 * Fill the gaps on a day with a plain Present.
 *
 * Only the people with no row are touched: a half day, an absence or a day of
 * leave already recorded is deliberate work, and a bulk button must not erase
 * it. That also makes the action idempotent — clicking it twice changes
 * nothing the second time.
 *
 * Not `createMany({ skipDuplicates: true })`, which would be one statement but
 * would not say *which* rows it created, and every created row needs an audit
 * event. The gap is computed first instead, inside the transaction.
 */
export async function markEveryonePresent(
  actor: Actor,
  date: string,
): Promise<{ filled: number; skipped: number }> {
  assertMarkable(date);

  if (actor.role !== Role.ADMIN || !actor.organizationId) {
    throw new HttpError(403, "Only an organization admin can mark attendance.");
  }
  const organizationId = actor.organizationId;
  const day = toDbDate(date);

  return prisma.$transaction(async (tx) => {
    const members = await tx.user.findMany({
      where: {
        organizationId,
        role: Role.MEMBER,
        status: EmploymentStatus.ACTIVE,
      },
      select: { id: true },
    });

    const marked = await tx.attendance.findMany({
      where: { organizationId, date: day },
      select: { userId: true },
    });
    const already = new Set(marked.map((m) => m.userId));
    const gaps = members.filter((m) => !already.has(m.id));

    if (gaps.length > 0) {
      await tx.attendance.createMany({
        data: gaps.map((m) => ({
          userId: m.id,
          organizationId,
          date: day,
          status: AttendanceStatus.PRESENT,
          modifier: null,
          markedById: actor.id,
        })),
      });

      await tx.attendanceEvent.createMany({
        data: gaps.map((m) => ({
          organizationId,
          userId: m.id,
          date: day,
          fromStatus: null,
          fromModifier: null,
          toStatus: AttendanceStatus.PRESENT,
          toModifier: null,
          actorId: actor.id,
        })),
      });
    }

    return { filled: gaps.length, skipped: members.length - gaps.length };
  });
}
