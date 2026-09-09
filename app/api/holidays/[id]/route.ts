import { errorResponse, readJson } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { holidayPatchFrom } from "@/lib/holiday-input";
import { deleteHoliday, updateHoliday } from "@/lib/holiday-service";
import { requireActor } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const { id } = await ctx.params;
    const body = await readJson(request);

    return Response.json(await updateHoliday(actor, id, holidayPatchFrom(body)));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, ctx: Ctx): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const { id } = await ctx.params;

    await deleteHoliday(actor, id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
