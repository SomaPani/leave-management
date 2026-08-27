import {
  errorResponse,
  optionalString,
  readJson,
  requiredEmail,
  requiredString,
} from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { HttpError, requireActor } from "@/lib/rbac";
import { createMember, listMembers } from "@/lib/services";

/** Members — created by the Admin of their own organization. */

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const body = await readJson(request);
    const password = body["password"];

    if (typeof password !== "string") {
      throw new HttpError(400, '"password" is required.');
    }

    const member = await createMember(actor, {
      name: requiredString(body, "name"),
      email: requiredEmail(body, "email"),
      // Read only so a cross-org attempt is rejected outright rather than
      // silently rewritten to the caller's own organization.
      organizationId: optionalString(body, "organizationId"),
      password,
    });

    return Response.json(member, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    return Response.json(await listMembers(actor));
  } catch (error) {
    return errorResponse(error);
  }
}
