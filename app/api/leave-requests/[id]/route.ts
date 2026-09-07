import { errorResponse, readJson } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { leaveDecisionFrom } from "@/lib/leave-input";
import { decideLeaveRequest } from "@/lib/leave-review-service";
import { withdrawOwnLeaveRequest } from "@/lib/leave-service";
import { requireActor } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Decide a request, or withdraw one's own.
 *
 * One handler for two verbs because they are the same transition from the
 * caller's side — "this request is finished" — and which one they are entitled
 * to is a policy question, answered in the service rather than by the shape of
 * the URL. `withdrawOwnLeaveRequest` is self-scoped and `decideLeaveRequest`
 * is ADMIN-only; neither trusts anything in the body but the intent.
 */
export async function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const { id } = await ctx.params;
    const body = await readJson(request);

    if (body["intent"] === "withdraw") {
      return Response.json(await withdrawOwnLeaveRequest(actor, id));
    }

    return Response.json(
      await decideLeaveRequest(actor, id, leaveDecisionFrom(body)),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
