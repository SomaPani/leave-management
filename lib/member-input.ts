import { EmploymentStatus, WorkMode } from "@/generated/prisma/enums";
import {
  patchNullableDate,
  patchNullableEmail,
  patchNullableEnum,
  patchNullableString,
} from "@/lib/api";
import { HttpError } from "@/lib/rbac";
import type { MemberProfileInput } from "@/lib/services";

/**
 * Reading a member's Team profile out of a JSON request body.
 *
 * Shared by `POST /api/members` and `PATCH /api/members/[id]` so the two agree
 * on field names, coercion and error messages. Creation and update use the same
 * parser deliberately: every profile field is optional in both, and a field the
 * caller never mentioned comes back `undefined` and is dropped before it
 * reaches Prisma.
 *
 * The Server Actions behind the pages do not use this — they read `FormData`,
 * not JSON.
 */

export const WORK_MODES = [WorkMode.WFO, WorkMode.WFH] as const;

export const EMPLOYMENT_STATUSES = [
  EmploymentStatus.ACTIVE,
  EmploymentStatus.INACTIVE,
] as const;

export function memberProfileFrom(body: Record<string, unknown>): MemberProfileInput {
  return {
    title: patchNullableString(body, "title"),
    empId: patchNullableString(body, "empId"),
    joinedOn: patchNullableDate(body, "joinedOn"),
    workMode: patchNullableEnum(body, "workMode", WORK_MODES),
    regionId: patchNullableString(body, "regionId"),
    managerId: patchNullableString(body, "managerId"),
    phone: patchNullableString(body, "phone"),
    personalEmail: patchNullableEmail(body, "personalEmail"),
    address: patchNullableString(body, "address"),
    emergencyName: patchNullableString(body, "emergencyName"),
    emergencyPhone: patchNullableString(body, "emergencyPhone"),
  };
}

/**
 * The `?status=` filter on `GET /api/members`.
 *
 * Absent means "let the service decide", which is ACTIVE only. `ALL` is the
 * explicit opt-in to seeing deactivated people — spelled out rather than
 * inferred from an empty value, so nobody widens the roster by accident.
 */
export function statusFilterFrom(
  params: URLSearchParams,
): EmploymentStatus | null | undefined {
  const raw = params.get("status")?.trim();
  if (!raw) return undefined;

  const candidate = raw.toUpperCase();
  if (candidate === "ALL") return null;
  if (!EMPLOYMENT_STATUSES.includes(candidate as EmploymentStatus)) {
    throw new HttpError(
      400,
      `"status" must be one of: ${EMPLOYMENT_STATUSES.join(", ")}, ALL.`,
    );
  }
  return candidate as EmploymentStatus;
}
