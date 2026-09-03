import { errorResponse, readJson } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { holidayListFrom } from "@/lib/holiday-input";
import { createHolidays } from "@/lib/holiday-service";
import { requireActor } from "@/lib/rbac";

/**
 * Load a year's calendar in one call.
 *
 * Answers counts rather than the created rows: an import of 200 holidays does
 * not need to echo all of them back, and `skipped` is the number that already
 * existed, which is what makes re-running an import safe.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const body = await readJson(request);

    const result = await createHolidays(actor, holidayListFrom(body));
    return Response.json({
      created: result.created.length,
      skipped: result.skipped,
      holidays: result.created,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
