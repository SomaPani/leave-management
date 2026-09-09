import { AttendanceModifier, AttendanceStatus } from "@/generated/prisma/enums";
import type { AttendanceCode } from "@/lib/attendance";
import { HttpError } from "@/lib/rbac";

/**
 * Parsing attendance input, shared by the route handlers and the Server
 * Actions — the same rule lib/member-input.ts follows for Team, so a form post
 * and a JSON call cannot drift apart on field names or coercion.
 */

const STATUSES = Object.values(AttendanceStatus);
const MODIFIERS = Object.values(AttendanceModifier);

export function statusFrom(body: Record<string, unknown>): AttendanceStatus {
  const value = body["status"];
  if (typeof value !== "string" || !STATUSES.includes(value as AttendanceStatus)) {
    throw new HttpError(400, `"status" must be one of: ${STATUSES.join(", ")}.`);
  }
  return value as AttendanceStatus;
}

/** Absent, null and "" all mean "no add-on". */
export function modifierFrom(
  body: Record<string, unknown>,
): AttendanceModifier | null {
  const value = body["modifier"];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !MODIFIERS.includes(value as AttendanceModifier)) {
    throw new HttpError(
      400,
      `"modifier" must be one of: ${MODIFIERS.join(", ")}, or omitted.`,
    );
  }
  return value as AttendanceModifier;
}

/** One grid button: any status or any modifier. */
export function codeFrom(value: unknown, field = "code"): AttendanceCode {
  if (
    typeof value !== "string" ||
    !(
      STATUSES.includes(value as AttendanceStatus) ||
      MODIFIERS.includes(value as AttendanceModifier)
    )
  ) {
    throw new HttpError(
      400,
      `"${field}" must be one of: ${[...STATUSES, ...MODIFIERS].join(", ")}.`,
    );
  }
  return value as AttendanceCode;
}
