import { optionalString, requiredString } from "@/lib/api";
import { parseDateParam } from "@/lib/attendance";
import type { Decision, DecisionInput } from "@/lib/leave-review-service";
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

/** Long enough to explain a refusal, short enough that the column is not a dumping ground. */
const MAX_NOTE = 500;

/** The form's button values, and the statuses they mean. */
const DECISIONS: Record<string, Decision> = {
  approve: "APPROVED",
  reject: "REJECTED",
};

/**
 * A decision body, shared by `PATCH /api/leave-requests/[id]` and the Server
 * Action behind /approvals — the rule every `lib/*-input.ts` follows, so a
 * form post and a JSON call cannot drift.
 *
 * Both spellings are accepted: the form submits its button's value
 * (`approve`), an API caller sends the status (`APPROVED`). Neither is
 * translated at a call site, where the mapping would eventually be duplicated.
 */
export function leaveDecisionFrom(body: Record<string, unknown>): DecisionInput {
  const raw = requiredString(body, "intent").toLowerCase();
  const decision =
    DECISIONS[raw] ??
    (raw === "approved" || raw === "rejected"
      ? (raw.toUpperCase() as Decision)
      : undefined);

  if (!decision) {
    throw new HttpError(400, '"intent" must be one of: approve, reject.');
  }

  const note = optionalString(body, "note");
  if (note !== null && note.length > MAX_NOTE) {
    throw new HttpError(400, `"note" must be ${MAX_NOTE} characters or fewer.`);
  }

  // The "a rejection needs a reason" rule lives in `decideLeaveRequest`, not
  // here: it is a policy about a transition, and this file only knows shapes.
  return { decision, note };
}
