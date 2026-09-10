import { timingSafeEqual } from "node:crypto";

import { errorResponse, readJson } from "@/lib/api";
import { HttpError } from "@/lib/rbac";
import { parseScorePayload } from "@/lib/score-input";
import { ingestScoreDays } from "@/lib/score-service";

/**
 * Scorecard ingest — the one route in this application not authenticated by a
 * user session.
 *
 * The caller is the Standup-Automation pipeline, which holds a shared secret
 * rather than an account. It deliberately never becomes an `Actor`: a machine
 * credential must not be able to flow into the policy layer written for people.
 *
 * Partial success is the normal answer, not a degraded one. Not everybody in
 * the Slack roll-call is a member here, so unknown emails come back in
 * `rejected` while the rest of the batch is stored, and the pipeline reports
 * them to its own ops channel.
 */

/** Constant-time compare, so a wrong token cannot be found one byte at a time. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorize(request: Request): void {
  const expected = process.env.SCORE_INGEST_TOKEN;
  // An unset secret must not read as an empty-string match. Refusing the whole
  // route is the safe failure: a misconfigured deployment stops accepting
  // scores rather than accepting anybody's.
  if (!expected) throw new HttpError(503, "Score ingest is not configured.");

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented || !tokenMatches(presented, expected)) {
    throw new HttpError(401, "Invalid ingest token.");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    authorize(request);
    const days = parseScorePayload(await readJson(request));
    return Response.json(await ingestScoreDays(days));
  } catch (error) {
    return errorResponse(error);
  }
}
