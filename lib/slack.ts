/**
 * A minimal Slack Web API client for the attendance notifications.
 *
 * Configured only by environment variables:
 *
 *   SLACK_BOT_TOKEN          xoxb-… token of the Stacx24 Slack app (required;
 *                            without it nothing is sent)
 *   SLACK_ATTENDANCE_CHANNEL channel id to post in (default: #stacx_admin)
 *
 * Every function here swallows its own failures and reports them on the server
 * log: a Slack outage, a wrong token or a missing scope must never stop an
 * admin from marking attendance.
 */

const API = "https://slack.com/api";

/** #stacx_admin */
export const DEFAULT_ATTENDANCE_CHANNEL = "C0CM0FHAM8B";

export function slackEnabled(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN?.trim());
}

function attendanceChannel(): string {
  return process.env.SLACK_ATTENDANCE_CHANNEL?.trim() || DEFAULT_ATTENDANCE_CHANNEL;
}

type SlackReply = { ok: boolean; error?: string; user?: { id?: string } };

async function callSlack(method: string, params: Record<string, string>): Promise<SlackReply | null> {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) return null;
  try {
    const res = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(10_000),
    });
    const reply = (await res.json()) as SlackReply;
    if (!reply.ok && reply.error !== "users_not_found") {
      console.error(`[slack] ${method} failed: ${reply.error ?? res.status}`);
    }
    return reply;
  } catch (error) {
    console.error(`[slack] ${method} failed:`, error instanceof Error ? error.message : error);
    return null;
  }
}

/** Post `text` in the attendance channel. True when Slack accepted it. */
export async function postAttendanceMessage(text: string): Promise<boolean> {
  const reply = await callSlack("chat.postMessage", { channel: attendanceChannel(), text });
  return reply?.ok === true;
}

// Slack user ids by email. A miss is cached too, so someone without a Slack
// account is not looked up on every mark; restarting the app clears it.
const userIdByEmail = new Map<string, string | null>();

/**
 * `<@U…>` — a real tag that notifies the person — when their leave-management
 * email has a Slack account; otherwise their name in bold.
 */
export async function slackMention(person: { email: string; name: string }): Promise<string> {
  const email = person.email.trim().toLowerCase();
  if (!userIdByEmail.has(email)) {
    const reply = await callSlack("users.lookupByEmail", { email });
    // A failed call (network, missing scope) is not cached, so it is retried.
    if (reply === null || (!reply.ok && reply.error !== "users_not_found")) {
      return `*${person.name}*`;
    }
    userIdByEmail.set(email, reply.ok ? (reply.user?.id ?? null) : null);
  }
  const id = userIdByEmail.get(email);
  return id ? `<@${id}>` : `*${person.name}*`;
}

/** For tests. */
export function clearSlackCache(): void {
  userIdByEmail.clear();
}
