import { timingSafeEqual } from "node:crypto";

import { sendNotMarkedReminder } from "@/lib/attendance-notify";
import { slackEnabled } from "@/lib/slack";

/**
 * POST /api/attendance/not-marked-reminder — called by a cron job on the
 * server once a working day (see Docs/slack-attendance.md). Posts one
 * "Attendance not marked for today" message in #stacx_admin tagging everyone
 * still unmarked. A weekend or holiday finds no one, so it posts nothing.
 *
 * Not a session route: it needs `Authorization: Bearer <ATTENDANCE_CRON_TOKEN>`.
 */
function authorized(request: Request): boolean {
  const expected = process.env.ATTENDANCE_CRON_TOKEN?.trim();
  if (!expected) return false;
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!slackEnabled()) {
    return Response.json({ error: "SLACK_BOT_TOKEN is not set" }, { status: 503 });
  }
  try {
    const results = await sendNotMarkedReminder();
    return Response.json({ results });
  } catch (error) {
    console.error("[slack] not-marked reminder failed:", error);
    return Response.json({ error: "Reminder failed" }, { status: 500 });
  }
}
