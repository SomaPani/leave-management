import { errorResponse, patchEmail, patchString, readJson } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { HttpError, requireActor } from "@/lib/rbac";
import { deleteAdmin, updateAdmin } from "@/lib/services";

/**
 * A single admin — SuperAdmin only.
 *
 * PATCH accepts any subset of name, email, password and organizationId; the
 * service refuses an empty patch and validates the organization exists. The id
 * is resolved to a user whose role is ADMIN, so this endpoint cannot be pointed
 * at a member or at a superadmin.
 */

type Params = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Params): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const { id } = await params;
    const body = await readJson(request);

    const password = body["password"];
    if (password !== undefined && typeof password !== "string") {
      throw new HttpError(400, '"password" must be a string.');
    }

    const admin = await updateAdmin(actor, id, {
      name: patchString(body, "name"),
      email: patchEmail(body, "email"),
      organizationId: patchString(body, "organizationId"),
      password,
    });

    return Response.json(admin);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const { id } = await params;
    return Response.json(await deleteAdmin(actor, id));
  } catch (error) {
    return errorResponse(error);
  }
}
