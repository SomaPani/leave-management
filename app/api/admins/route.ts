import { errorResponse, readJson, requiredEmail, requiredString } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { HttpError, requireActor } from "@/lib/rbac";
import { createAdmin } from "@/lib/services";

/**
 * Admins — created by a SuperAdmin and assigned to an organization.
 *
 * Unlike member creation, the organization *is* taken from the request body
 * here: a SuperAdmin has no organization of their own to derive it from. The
 * service validates that it exists before writing.
 */

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const body = await readJson(request);
    const password = body["password"];

    if (typeof password !== "string") {
      throw new HttpError(400, '"password" is required.');
    }

    const admin = await createAdmin(actor, {
      name: requiredString(body, "name"),
      email: requiredEmail(body, "email"),
      organizationId: requiredString(body, "organizationId"),
      password,
    });

    return Response.json(admin, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
