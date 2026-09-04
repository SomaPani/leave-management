import { errorResponse, readJson } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { leaveRequestInputFrom } from "@/lib/leave-input";
import { createOwnLeaveRequest, listOwnLeaveRequests } from "@/lib/leave-service";
import { requireActor } from "@/lib/rbac";

/**
 * The caller's own leave requests.
 *
 * Deliberately self-scoped with no `userId` parameter in any form: a
 * member-facing read that took an id would be one authorization slip away from
 * leaking a colleague's leave record. The roster-wide read /approvals needs
 * arrives with that screen and gets its own predicate then.
 */
export async function GET(): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    return Response.json(await listOwnLeaveRequests(actor));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const body = await readJson(request);

    return Response.json(
      await createOwnLeaveRequest(actor, leaveRequestInputFrom(body)),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
