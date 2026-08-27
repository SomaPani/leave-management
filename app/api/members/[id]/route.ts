import { errorResponse, patchEmail, patchString, readJson } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { HttpError, requireActor } from "@/lib/rbac";
import { deleteMember, updateMember } from "@/lib/services";

/**
 * A single member — the Admin of that member's own organization.
 *
 * Scope is decided against the member's stored `organizationId`, so an admin
 * from another organization gets 403 no matter what the request says. There is
 * no `organizationId` field to patch: moving a member between organizations
 * would sidestep the rule that an admin only ever acts inside their own.
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

    const member = await updateMember(actor, id, {
      name: patchString(body, "name"),
      email: patchEmail(body, "email"),
      password,
    });

    return Response.json(member);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const { id } = await params;
    return Response.json(await deleteMember(actor, id));
  } catch (error) {
    return errorResponse(error);
  }
}
