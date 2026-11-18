import { errorResponse } from "@/lib/api";
import { parseDateParam } from "@/lib/attendance";
import { currentActor } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import { formatWeekdayShort } from "@/lib/date";
import { COUNTED_KINDS, PERIODS, type Period } from "@/lib/day-status";
import { DAY_KIND_STYLE } from "@/lib/day-style";
import { memberPeriod } from "@/lib/overview-service";
import { HttpError, requireActor } from "@/lib/rbac";

/**
 * One person's month, quarter or year as a CSV download — the same days the
 * `/dashboard/[userId]` screen shows, oldest first, then the totals.
 *
 * Starts with a UTF-8 byte-order mark so Excel reads non-ASCII names
 * correctly; Google Sheets and Numbers ignore it.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const params = new URL(request.url).searchParams;

    const userId = params.get("userId")?.trim();
    if (!userId) throw new HttpError(400, '"userId" is required.');

    const period = params.get("period") ?? "month";
    if (!PERIODS.includes(period as Period)) {
      throw new HttpError(400, `"period" must be one of: ${PERIODS.join(", ")}.`);
    }
    const at = parseDateParam(params.get("at"), "at");

    const view = await memberPeriod(actor, userId, period as Period, at);

    const rows: (string | number)[][] = [["Date", "Day", "Status", "Detail"]];
    for (const day of [...view.days].reverse()) {
      rows.push([day.date, formatWeekdayShort(day.date), DAY_KIND_STYLE[day.kind].label, day.detail ?? ""]);
    }
    rows.push([]);
    rows.push([view.member.name, view.range.label]);
    for (const kind of COUNTED_KINDS) rows.push([DAY_KIND_STYLE[kind].label, view.counts[kind]]);

    return new Response("﻿" + toCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${fileName(view.member.name, view.range.label)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/** `Run Member` + `November 2026` → `Run-Member_November-2026.csv`. */
function fileName(name: string, label: string): string {
  const slug = (text: string) =>
    text
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^A-Za-z0-9_-]/g, "") || "member";
  return `${slug(name)}_${slug(label)}.csv`;
}
