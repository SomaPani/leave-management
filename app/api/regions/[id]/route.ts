import { errorResponse, readJson, requiredString } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { requireActor } from "@/lib/rbac";
import { deleteRegion, updateRegion } from "@/lib/services";

/**
 * A single region.
 *
 * Scope is decided against the region's stored `organizationId`, so an admin
 * from another organization gets 403 whatever the request claims — the same
 * rule as `/api/members/[id]`.
 *
 * DELETE returns 409 while anyone is still in the region: `User.regionId` is
 * ON DELETE SET NULL, so an unguarded delete would quietly drop every member
 * out of their grouping instead of failing.
 */

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const { id } = await params;
    const body = await readJson(request);

    const region = await updateRegion(actor, id, { name: requiredString(body, "name") });
    return Response.json(region);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const { id } = await params;
    return Response.json(await deleteRegion(actor, id));
  } catch (error) {
    return errorResponse(error);
  }
}
