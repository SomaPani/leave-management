import { optionalString, requiredString } from "@/lib/api";
import { parseDateParam } from "@/lib/attendance";
import type { LeaveRequestInput } from "@/lib/leave-service";
import { HttpError } from "@/lib/rbac";

/**
 * Parsing leave request bodies, shared by the route handler and the Server
 * Action — the rule lib/holiday-input.ts and lib/attendance-input.ts already
 * follow, so a form post and an API call cannot drift apart on field names,
 * defaults or coercion.
 *
 * That sharing is what makes the Apply form work without a special case: it
 * *disables* the To input for a one-occurrence policy, a disabled input
 * submits no value at all, and `endDate` defaulting to `startDate` reads that
 * absence correctly.
 */

/** Long enough for a paragraph, short enough that the column is not a dumping ground. */
const MAX_REASON = 500;

export function leaveRequestInputFrom(
  body: Record<string, unknown>,
): LeaveRequestInput {
  const startDate = parseDateParam(body["startDate"], "startDate");
  const endDate =
    body["endDate"] === undefined || body["endDate"] === null || body["endDate"] === ""
      ? startDate
      : parseDateParam(body["endDate"], "endDate");

  // Ordering is malformed input, not a policy decision, so it is refused here
  // rather than in the service — the same place every other date field in this
  // codebase is validated.
  if (endDate < startDate) {
    throw new HttpError(400, '"endDate" must not be earlier than "startDate".');
  }

  const reason = optionalString(body, "reason");
  if (reason !== null && reason.length > MAX_REASON) {
    throw new HttpError(400, `"reason" must be ${MAX_REASON} characters or fewer.`);
  }

  return {
    policyId: requiredString(body, "policyId"),
    startDate,
    endDate,
    reason,
  };
}
