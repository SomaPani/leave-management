import { errorResponse } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { listLeavePolicies } from "@/lib/leave-service";
import { requireActor } from "@/lib/rbac";

/**
 * The organization's leave entitlements.
 *
 * Read-only. Editing a policy belongs to /setup, which is still on the
 * fixture; adding write verbs here before that screen exists would be an
 * endpoint with no caller and no test of its real use.
 */
export async function GET(): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    return Response.json(await listLeavePolicies(actor));
  } catch (error) {
    return errorResponse(error);
  }
}
