import { errorResponse, readJson, requiredString } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { requireActor } from "@/lib/rbac";
import { createRegion, listRegions } from "@/lib/services";

/**
 * Regions — the groupings the Team screen lists people under.
 *
 * Created and managed by the Admin of the organization they belong to. There is
 * no `organizationId` in the body: an admin has exactly one organization, taken
 * from their session, so naming it would only create a way to get it wrong.
 *
 * Reading is wider than writing on purpose — a SuperAdmin can list every
 * organization's regions but cannot change any. See `canListRegions` and
 * `canManageRegions` in lib/rbac.ts.
 */

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const body = await readJson(request);

    const region = await createRegion(actor, { name: requiredString(body, "name") });
    return Response.json(region, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    return Response.json(await listRegions(actor));
  } catch (error) {
    return errorResponse(error);
  }
}
