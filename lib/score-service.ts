import { EmploymentStatus, Role } from "@/generated/prisma/enums";
import { initialsFor } from "@/lib/domain";
import { monthBounds } from "@/lib/holidays";
import { prisma } from "@/lib/prisma";
import {
  type Actor,
  HttpError,
  canListScores,
  canReadOwnScores,
  visibleOrgId,
} from "@/lib/rbac";
import type { ScoreDayRecord } from "@/lib/score";
import type { ScoreDayInput } from "@/lib/score-input";

/**
 * Everything that reads or writes the score table.
 *
 * The same contract as lib/attendance-service.ts: every entry point comes
 * through here, so authorization is decided in exactly one place per
 * operation.
 *
 * Ingest is the exception that proves it. It has no `Actor` and takes none:
 * the caller is the Standup-Automation pipeline holding a bearer token, not a
 * person, and handing a machine credential an `Actor` would let it flow into
 * functions written for a signed-in human.
 */

export type IngestResult = {
  accepted: number;
  rejected: { email: string; reason: string }[];
};

export type MemberScoreMonth = {
  id: string;
  name: string;
  title: string | null;
  initials: string;
  days: ScoreDayRecord[];
};

const DAY_FIELDS = {
  date: true,
  status: true,
  reason: true,
  attendance: true,
  checkinPts: true,
  pickedPts: true,
  descriptionPts: true,
  commitPts: true,
  commentPts: true,
  deliveryPts: true,
  coordinationPts: true,
  process: true,
  delivery: true,
  total: true,
  band: true,
  tasksPicked: true,
  tasksDone: true,
  pickedTasks: true,
  flags: true,
} as const;

/** The stored row, in the shape lib/score.ts reasons about. */
function toRecord(row: Record<string, unknown>): ScoreDayRecord {
  const value = (key: string) => (row[key] ?? null) as number | null;
  return {
    date: (row.date as Date).toISOString().slice(0, 10),
    status: row.status as ScoreDayRecord["status"],
    reason: (row.reason ?? null) as string | null,
    attendance: row.attendance as string,
    points: {
      checkin: value("checkinPts"),
      picked: value("pickedPts"),
      description: value("descriptionPts"),
      commit: value("commitPts"),
      comment: value("commentPts"),
      delivery: value("deliveryPts"),
      coordination: value("coordinationPts"),
    },
    process: value("process"),
    delivery: value("delivery"),
    total: value("total"),
    band: (row.band ?? null) as string | null,
    tasksPicked: value("tasksPicked"),
    tasksDone: value("tasksDone"),
    pickedTasks: (row.pickedTasks ?? []) as string[],
    flags: (row.flags ?? []) as string[],
  };
}

/**
 * The month's date range.
 *
 * `month` is **0-based**, the convention `monthBounds`, `listMemberMonth` and
 * the /calendar screen already share. Every read below says so in its own
 * signature comment, because a month that is 1-based in one function and
 * 0-based in the next is a bug that reads as "no data for September".
 */
function monthRange(year: number, month: number): { gte: Date; lte: Date } {
  const { from, to } = monthBounds(year, month);
  return { gte: new Date(from), lte: new Date(to) };
}

/* -------------------------------------------------------------- ingest -- */

/**
 * Store a batch of scored days.
 *
 * Upserts on `[userId, date]` because the upstream recompute pass re-pushes
 * the trailing days every night. That is what carries its self-correction —
 * which exists there *instead of* an appeals process — through to the screen,
 * with no correction workflow and no override button on this side.
 *
 * An email with no `User` is expected, not exceptional: not everyone in the
 * Slack roll-call is a member here. Those are collected and returned so the
 * pipeline can report them to its own ops channel, rather than failing a batch
 * that is mostly good.
 */
export async function ingestScoreDays(days: ScoreDayInput[]): Promise<IngestResult> {
  const emails = [...new Set(days.map((day) => day.email))];
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true, organizationId: true },
  });
  const byEmail = new Map(users.map((user) => [user.email, user]));

  const rejected: IngestResult["rejected"] = [];
  let accepted = 0;

  for (const day of days) {
    const user = byEmail.get(day.email);
    if (!user) {
      rejected.push({ email: day.email, reason: "no such user" });
      continue;
    }
    // A SuperAdmin has no organization and is never scored. Rejecting rather
    // than defaulting keeps `organizationId` non-null without a fallback that
    // would file somebody's score under the wrong company.
    if (!user.organizationId) {
      rejected.push({ email: day.email, reason: "user belongs to no organization" });
      continue;
    }

    // Listed column by column rather than spread from the input, so a field
    // added to `ScoreDayInput` later cannot reach the table without somebody
    // deciding it should. `email` and `date` are deliberately absent: the
    // first is resolved to a user above, the second is part of the key.
    const fields = {
      organizationId: user.organizationId,
      status: day.status,
      reason: day.reason,
      attendance: day.attendance,
      checkinPts: day.checkinPts,
      pickedPts: day.pickedPts,
      descriptionPts: day.descriptionPts,
      commitPts: day.commitPts,
      commentPts: day.commentPts,
      deliveryPts: day.deliveryPts,
      coordinationPts: day.coordinationPts,
      process: day.process,
      delivery: day.delivery,
      total: day.total,
      band: day.band,
      tasksPicked: day.tasksPicked,
      tasksDone: day.tasksDone,
      tasksCredit: day.tasksCredit,
      volumeFactor: day.volumeFactor,
      pickedTasks: day.pickedTasks,
      flags: day.flags,
      computedAt: day.computedAt,
    };

    await prisma.scoreDay.upsert({
      where: { userId_date: { userId: user.id, date: new Date(day.date) } },
      create: { userId: user.id, date: new Date(day.date), ...fields },
      update: fields,
    });
    accepted += 1;
  }

  return { accepted, rejected };
}

/* --------------------------------------------------------------- reads -- */

/**
 * The caller's own month.
 *
 * There is no `userId` parameter, the same contract `listOwnLeaveRequests`
 * holds: the subject is the session, so there is nothing in the URL for a
 * member to change into a colleague's.
 *
 * `month` is 0-based.
 */
export async function listOwnScoreDays(
  actor: Actor,
  year: number,
  month: number,
): Promise<ScoreDayRecord[]> {
  if (!canReadOwnScores(actor)) {
    throw new HttpError(403, "You do not have a score board.");
  }

  const rows = await prisma.scoreDay.findMany({
    where: { userId: actor.id, date: monthRange(year, month) },
    select: DAY_FIELDS,
    orderBy: { date: "asc" },
  });
  return rows.map((row) => toRecord(row as unknown as Record<string, unknown>));
}

/** Every active member of the actor's organization, with their month. 0-based. */
export async function listOrgScoreMonths(
  actor: Actor,
  year: number,
  month: number,
): Promise<MemberScoreMonth[]> {
  if (!canListScores(actor)) {
    throw new HttpError(403, "You are not allowed to read scores.");
  }
  const organizationId = visibleOrgId(actor);

  const members = await prisma.user.findMany({
    where: {
      role: Role.MEMBER,
      status: EmploymentStatus.ACTIVE,
      ...(organizationId ? { organizationId } : {}),
    },
    select: {
      id: true,
      name: true,
      title: true,
      scores: {
        where: { date: monthRange(year, month) },
        select: DAY_FIELDS,
        orderBy: { date: "asc" },
      },
    },
    orderBy: { name: "asc" },
  });

  return members.map((member) => ({
    id: member.id,
    name: member.name,
    title: member.title,
    initials: initialsFor(member.name),
    days: member.scores.map((row) => toRecord(row as unknown as Record<string, unknown>)),
  }));
}

/**
 * One member's month, for the admin drill-down.
 *
 * Scoped by organization *inside* the query rather than fetched and then
 * checked, so a member in another organization returns null down the same path
 * a nonexistent id does.
 *
 * `month` is 0-based.
 */
export async function findMemberScoreDays(
  actor: Actor,
  userId: string,
  year: number,
  month: number,
): Promise<{ member: MemberScoreMonth } | null> {
  if (!canListScores(actor)) {
    throw new HttpError(403, "You are not allowed to read scores.");
  }
  const organizationId = visibleOrgId(actor);

  const member = await prisma.user.findFirst({
    where: { id: userId, ...(organizationId ? { organizationId } : {}) },
    select: {
      id: true,
      name: true,
      title: true,
      scores: {
        where: { date: monthRange(year, month) },
        select: DAY_FIELDS,
        orderBy: { date: "asc" },
      },
    },
  });
  if (!member) return null;

  return {
    member: {
      id: member.id,
      name: member.name,
      title: member.title,
      initials: initialsFor(member.name),
      days: member.scores.map((row) =>
        toRecord(row as unknown as Record<string, unknown>),
      ),
    },
  };
}
