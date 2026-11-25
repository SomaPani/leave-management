import { errorResponse } from "@/lib/api";
import {
  anchorOf,
  attendanceCsvRows,
  combineSummaries,
  employeeCsvRows,
  parseReportFilters,
  summarizeDays,
} from "@/lib/attendance-report";
import { todayIso } from "@/lib/attendance";
import { currentActor } from "@/lib/auth";
import { toCsv } from "@/lib/csv";
import { teamPeriod } from "@/lib/overview-service";
import { requireActor } from "@/lib/rbac";

/**
 * The Employee dashboard's employee-wise table as a CSV download ("Export to
 * Excel"). Takes the same query string as `/employee-dashboard`, so the file
 * always matches what is on screen.
 *
 * With one employee picked (`member=`), the file is that person only: their
 * summary row followed by every day of the period.
 *
 * Starts with a UTF-8 byte-order mark so Excel reads non-ASCII names
 * correctly. The file name is built from the period label only, never from a
 * person's name.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const today = todayIso();
    const filters = parseReportFilters(
      Object.fromEntries(new URL(request.url).searchParams),
      today,
    );

    const view = await teamPeriod(
      actor,
      {
        period: filters.period,
        anchor: anchorOf(filters),
        memberId: filters.memberId,
        regionId: filters.regionId,
      },
      today,
    );

    const people = view.people.map((p) => ({ ...p, summary: summarizeDays(p.days) }));
    const overall = combineSummaries(people.map((p) => p.summary));
    const single = filters.memberId && people.length === 1 ? people[0] : null;
    const rows = single
      ? employeeCsvRows(single, view.range)
      : attendanceCsvRows(people, overall, view.range.label);

    const safe = (text: string) => text.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_-]/g, "");
    // An employee file is told apart by Emp ID, never by the person's name.
    const label = [safe(view.range.label), single ? safe(single.empId ?? "employee") || "employee" : ""]
      .filter(Boolean)
      .join("_");
    return new Response("﻿" + toCsv(rows), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="attendance_${label || "report"}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
