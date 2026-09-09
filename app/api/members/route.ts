import {
  errorResponse,
  optionalString,
  readJson,
  requiredEmail,
  requiredString,
} from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { memberProfileFrom, statusFilterFrom } from "@/lib/member-input";
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
      // The Team profile: every field optional, absent ones left unset.
      ...memberProfileFrom(body),
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

/**
 * The roster.
 *
 * `?status=ACTIVE|INACTIVE|ALL` and `?region=<id>` narrow it; with neither, the
 * service returns the active members of whatever organizations the caller can
 * see. `region` is not validated against the caller's organization because it
 * cannot leak anything — the org scope is applied regardless, so a foreign
 * region id simply matches nobody.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const params = new URL(request.url).searchParams;

    return Response.json(
      await listMembers(actor, {
        status: statusFilterFrom(params),
        regionId: params.get("region")?.trim() || undefined,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
