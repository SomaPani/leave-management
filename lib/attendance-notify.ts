import { AttendanceStatus, Role } from "@/generated/prisma/enums";
import { todayIso } from "@/lib/attendance";
import { todayOverview } from "@/lib/overview-service";
import { prisma } from "@/lib/prisma";
import { postAttendanceMessage, slackEnabled, slackMention } from "@/lib/slack";

/**
 * Slack messages about attendance, posted in #stacx_admin:
 *
 *   - when someone's *today* is first marked Present or WFH, a post tagging
 *     them: "Your attendance has been successfully marked for today…";
 *   - once a day (POST /api/attendance/not-marked-reminder, from a cron job),
 *     one post tagging everyone whose working day is still not marked.
 *
 * With SLACK_ORG_NAME set, only that organization posts (there is one
 * channel); unset, every organization does.
 */

export const MARKED_TEXT = "Your attendance has been successfully marked for today. Have a productive day ahead!";
export const NOT_MARKED_TEXT = "Attendance not marked for today";

export function markedMessage(mentions: string[]): string {
  return `${mentions.join(" ")} ${MARKED_TEXT}`;
}

export function notMarkedMessage(mentions: string[]): string {
  return `${NOT_MARKED_TEXT}:\n${mentions.map((m) => `• ${m}`).join("\n")}`;
}

/**
 * The first Present / WFH mark of today. Edits, Absent / Leave, other dates,
 * and a day that was marked worked, cleared and marked again do not post.
 */
export function isFirstMarkToday(input: {
  previous: { status: AttendanceStatus } | null;
  /** An earlier Present / WFH mark of this day exists in the audit log. */
  markedBefore: boolean;
  status: AttendanceStatus;
  date: string;
  today: string;
}): boolean {
  return (
    input.previous === null &&
    !input.markedBefore &&
    input.date === input.today &&
    (input.status === AttendanceStatus.PRESENT || input.status === AttendanceStatus.WFH)
  );
}

async function orgPosts(organizationId: string): Promise<boolean> {
  const wanted = process.env.SLACK_ORG_NAME?.trim();
  if (!wanted) return true;
  const org = await prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } });
  return org?.name === wanted;
}

async function mentionsFor(userIds: string[]): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { name: true, email: true },
    orderBy: { name: "asc" },
  });
  return Promise.all(users.map((u) => slackMention(u)));
}

async function sendMarked(organizationId: string, userIds: string[]): Promise<void> {
  if (!slackEnabled() || userIds.length === 0 || !(await orgPosts(organizationId))) return;
  // A bulk "mark everyone present" is one post tagging everyone, not one each.
  await postAttendanceMessage(markedMessage(await mentionsFor(userIds)));
}

const inFlight = new Set<Promise<void>>();

/**
 * Post the "marked" message without making the admin wait for Slack, and
 * without ever failing the mark. Call after the write has committed.
 */
export function notifyMarked(organizationId: string, userIds: string[]): void {
  if (!slackEnabled() || userIds.length === 0) return;
  const job = sendMarked(organizationId, userIds)
    .catch((error) => console.error("[slack] attendance notification failed:", error))
    .finally(() => inFlight.delete(job));
  inFlight.add(job);
}

/** For tests: wait for posts started by `notifyMarked`. */
export async function flushNotifications(): Promise<void> {
  await Promise.all([...inFlight]);
}

/**
 * Post who is not marked today, per organization. Weekends, holidays,
 * approved leave and people who have not joined yet are not "not marked"
 * (lib/day-status.ts), so a weekend or a holiday posts nothing.
 */
export async function sendNotMarkedReminder(
  today: string = todayIso(),
): Promise<{ organization: string; notMarked: number; posted: boolean }[]> {
  if (!slackEnabled()) return [];
  const orgs = await prisma.organization.findMany({ select: { id: true, name: true }, orderBy: { name: "asc" } });

  const results = [];
  for (const org of orgs) {
    if (!(await orgPosts(org.id))) continue;
    const view = await todayOverview({ id: "slack-reminder", role: Role.ADMIN, organizationId: org.id }, today);
    const missing = view.people.filter((p) => p.today.kind === "NOT_MARKED").map((p) => p.id);
    const posted = missing.length > 0 && (await postAttendanceMessage(notMarkedMessage(await mentionsFor(missing))));
    results.push({ organization: org.name, notMarked: missing.length, posted });
  }
  return results;
}
