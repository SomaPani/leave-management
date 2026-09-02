import { errorResponse, readJson } from "@/lib/api";
import { parseDateParam } from "@/lib/attendance";
import { markEveryonePresent } from "@/lib/attendance-service";
import { currentActor } from "@/lib/auth";
import { requireActor } from "@/lib/rbac";

/**
 * Fill a day's gaps with Present.
 *
 * One segment deep, so it cannot be shadowed by the two-segment
 * `[userId]/[date]` route beside it.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const body = await readJson(request);

    return Response.json(
      await markEveryonePresent(actor, parseDateParam(body["date"], "date")),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
