import { errorResponse, readJson, requiredString } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { requireActor } from "@/lib/rbac";
import { deleteOrganization, updateOrganization } from "@/lib/services";

/**
 * A single organization — SuperAdmin only.
 *
 * PATCH renames it; DELETE removes it, but only once it holds no users (see
 * `deleteOrganization` for why that guard matters).
 */

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const { id } = await params;
    const body = await readJson(request);

    const organization = await updateOrganization(actor, id, {
      name: requiredString(body, "name"),
    });

    return Response.json(organization);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const { id } = await params;
    return Response.json(await deleteOrganization(actor, id));
  } catch (error) {
    return errorResponse(error);
  }
}
