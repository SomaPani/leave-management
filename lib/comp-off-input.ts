import { optionalString, requiredString } from "@/lib/api";
import { parseDateParam } from "@/lib/attendance";
import type {
  CompOffClaimInput,
  CompOffDecision,
  CompOffDecisionInput,
} from "@/lib/comp-off";
import { HttpError } from "@/lib/rbac";

/**
 * Parsing comp-off claim bodies, shared by the Server Actions and any route
 * handler that follows — the rule lib/leave-input.ts and lib/holiday-input.ts
 * already follow, so a form post and a JSON call cannot drift apart on field
 * names, defaults or coercion.
 */

/** Long enough for a paragraph, short enough that the column is not a dumping ground. */
const MAX_REASON = 500;

/**
 * A claim body.
 *
 * Whether the day may be claimed at all is `claimableDay` in lib/comp-off.ts,
 * called by the service: it needs the claimant's region's holidays, which a
 * parser has no way to fetch and no business fetching.
 */
export function compOffClaimInputFrom(
  body: Record<string, unknown>,
): CompOffClaimInput {
  const workedOn = parseDateParam(body["workedOn"], "workedOn");

  const reason = optionalString(body, "reason");
  if (reason !== null && reason.length > MAX_REASON) {
    throw new HttpError(400, `"reason" must be ${MAX_REASON} characters or fewer.`);
  }

  return { workedOn, reason };
}

/** The form's button values, and the statuses they mean. */
const DECISIONS: Record<string, CompOffDecision> = {
  approve: "APPROVED",
  reject: "REJECTED",
};

/**
 * A decision body, shared by the Server Action behind /approvals and any
 * route handler that follows.
 *
 * Both spellings are accepted on the same reasoning `leaveDecisionFrom`
 * gives: the form submits its button's value (`approve`), an API caller sends
 * the status (`APPROVED`), and neither is translated at a call site where the
 * mapping would eventually be duplicated.
 */
export function compOffDecisionFrom(
  body: Record<string, unknown>,
): CompOffDecisionInput {
  const raw = requiredString(body, "intent").toLowerCase();
  const decision =
    DECISIONS[raw] ??
    (raw === "approved" || raw === "rejected"
      ? (raw.toUpperCase() as CompOffDecision)
      : undefined);

  if (!decision) {
    throw new HttpError(400, '"intent" must be one of: approve, reject.');
  }

  const note = optionalString(body, "note");
  if (note !== null && note.length > MAX_REASON) {
    throw new HttpError(400, `"note" must be ${MAX_REASON} characters or fewer.`);
  }

  // The "a rejection needs a reason" rule lives in `decideCompOffClaim`, not
  // here: it is a policy about a transition, and this file only knows shapes.
  return { decision, note };
}
