import { errorResponse, readJson } from "@/lib/api";
import { parseDateParam } from "@/lib/attendance";
import { modifierFrom, statusFrom } from "@/lib/attendance-input";
import { clearAttendance, setAttendance } from "@/lib/attendance-service";
import { currentActor } from "@/lib/auth";
import { requireActor } from "@/lib/rbac";

/**
 * One member's one day, addressed by its natural key.
 *
 * PUT rather than PATCH: a day is a status and an optional modifier, and there
 * is no partial update of two fields that a whole-value write does not already
 * express. Clearing a day is DELETE, not a PUT of null — the absence of a row
 * is how "not marked yet" is stored.
 */

type Ctx = { params: Promise<{ userId: string; date: string }> };

export async function PUT(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const { userId, date } = await ctx.params;
    const body = await readJson(request);

    return Response.json(
      await setAttendance(actor, {
        userId,
        date: parseDateParam(date, "date"),
        status: statusFrom(body),
        modifier: modifierFrom(body),
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, ctx: Ctx): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const { userId, date } = await ctx.params;

    await clearAttendance(actor, { userId, date: parseDateParam(date, "date") });
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
