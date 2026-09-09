import { errorResponse } from "@/lib/api";
import { parseDateParam } from "@/lib/attendance";
import { listDayAttendance, listRangeAttendance } from "@/lib/attendance-service";
import { currentActor } from "@/lib/auth";
import { HttpError, requireActor } from "@/lib/rbac";

/**
 * Attendance reads.
 *
 * Two shapes on one path: `?date=` is the grid's day, `?from=&to=` is a span
 * for a calendar or a report. They answer different shapes, so asking for both
 * or neither is a 400 rather than a guess.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const params = new URL(request.url).searchParams;

    const date = params.get("date");
    const from = params.get("from");
    const to = params.get("to");

    if (date && (from || to)) {
      throw new HttpError(400, 'Use either "date" or "from"/"to", not both.');
    }

    if (date) {
      return Response.json(
        await listDayAttendance(actor, parseDateParam(date, "date")),
      );
    }

    if (from || to) {
      return Response.json(
        await listRangeAttendance(actor, {
          from: parseDateParam(from, "from"),
          to: parseDateParam(to, "to"),
          userId: params.get("userId")?.trim() || undefined,
        }),
      );
    }

    throw new HttpError(400, 'Pass "date", or "from" and "to".');
  } catch (error) {
    return errorResponse(error);
  }
}
