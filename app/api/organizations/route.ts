import { errorResponse, readJson, requiredString } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { requireActor } from "@/lib/rbac";
import { createOrganization, listOrganizations } from "@/lib/services";

/** Organizations — SuperAdmin only, in both directions. */

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const body = await readJson(request);

    const organization = await createOrganization(actor, {
      name: requiredString(body, "name"),
    });

    return Response.json(organization, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    return Response.json(await listOrganizations(actor));
  } catch (error) {
    return errorResponse(error);
  }
}
