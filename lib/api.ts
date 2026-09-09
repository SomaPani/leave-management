import { HttpError } from "@/lib/rbac";

/**
 * Turning thrown errors into the status codes the design calls for:
 * 401 unauthenticated, 403 wrong role/org, 409 duplicate value, 400 validation.
 */

/** Reads a nested property without asserting the shape of anything. */
function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * What Prisma's unique-constraint violation (P2002) points at, or `null` when
 * the error is something else.
 *
 * Two shapes, because they depend on how the client talks to Postgres. The
 * classic engine fills in `meta.target` with the column names; the driver
 * adapter this app uses (`@prisma/adapter-pg`) leaves that undefined and
 * carries the Postgres constraint name instead, e.g.
 * `User_organizationId_empId_key`. Both are matched as free text below rather
 * than as exact column names, so neither shape has to be normalised.
 *
 * An empty array means P2002 with nothing usable — still a duplicate, just one
 * we cannot name.
 */
function uniqueViolationTarget(error: unknown): string[] | null {
  if (typeof error !== "object" || error === null) return null;
  if ((error as { code?: unknown }).code !== "P2002") return null;

  const target = at(error, "meta", "target");
  if (typeof target === "string") return [target];
  if (Array.isArray(target)) {
    return target.filter((column): column is string => typeof column === "string");
  }

  const constraint = at(
    error,
    "meta",
    "driverAdapterError",
    "cause",
    "constraint",
    "index",
  );
  return typeof constraint === "string" ? [constraint] : [];
}

/**
 * Which constraint was hit.
 *
 * There is more than one unique constraint on `User` now — email globally, and
 * `[organizationId, empId]` per organization — so reporting every duplicate as a
 * duplicate email would be actively misleading. Services pre-check the cases
 * they can and raise their own 409; this is the fallback for the races they
 * cannot.
 *
 * Matched as a substring so a constraint name works as well as a column list.
 * Order matters: `User_organizationId_empId_key` must not be read as an email.
 */
function uniqueViolationMessage(target: string[]): string {
  const haystack = target.join(" ").toLowerCase();

  if (haystack.includes("email")) return "That email address is already registered.";
  if (haystack.includes("empid")) {
    return "That employee id is already used in your organization.";
  }
  if (haystack.includes("name")) return "That name is already taken.";
  return "That value is already in use.";
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  const duplicate = uniqueViolationTarget(error);
  if (duplicate) {
    return Response.json(
      { error: uniqueViolationMessage(duplicate) },
      { status: 409 },
    );
  }

  console.error("[api] unhandled error", error);
  return Response.json({ error: "Something went wrong." }, { status: 500 });
}

/** Parses a JSON body, treating malformed JSON as a 400 rather than a crash. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new HttpError(400, "Expected a JSON object.");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Expected a JSON object.");
  }
}

/** A required, non-empty string field. */
export function requiredString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `"${field}" is required.`);
  }
  return value.trim();
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
): string | null {
  const value = body[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new HttpError(400, `"${field}" must be a string.`);
  }
  return value.trim();
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function requiredEmail(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = requiredString(body, field).toLowerCase();
  if (!EMAIL.test(value)) throw new HttpError(400, `"${field}" must be an email address.`);
  return value;
}

/** An optional string field: absent stays absent, present must be non-empty. */
export function patchString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  if (!(field in body) || body[field] === undefined) return undefined;
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `"${field}" must be a non-empty string.`);
  }
  return value.trim();
}

/** An optional email field, lower-cased and validated when present. */
export function patchEmail(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = patchString(body, field);
  if (value === undefined) return undefined;
  const email = value.toLowerCase();
  if (!EMAIL.test(email)) throw new HttpError(400, `"${field}" must be an email address.`);
  return email;
}

/* ------------------------------------------------------- clearable fields -- */

/**
 * A field that can be set, left alone, or emptied.
 *
 * `patchString` above cannot express the third case: it treats anything that is
 * not a non-empty string as an error, so there is no way to say "remove this
 * person's employee id". These variants map absent to `undefined` (leave alone)
 * and both `null` and `""` to `null` (clear it) — the shape
 * `MemberProfileInput` is built around.
 *
 * `""` counts as clearing so that an HTML form, which submits empty inputs as
 * empty strings rather than omitting them, does not have to special-case
 * every optional field.
 */
export function patchNullableString(
  body: Record<string, unknown>,
  field: string,
): string | null | undefined {
  if (!(field in body) || body[field] === undefined) return undefined;
  const value = body[field];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, `"${field}" must be a string or null.`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function patchNullableEmail(
  body: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = patchNullableString(body, field);
  if (value === undefined || value === null) return value;
  const email = value.toLowerCase();
  if (!EMAIL.test(email)) throw new HttpError(400, `"${field}" must be an email address.`);
  return email;
}

/** Anchored so a bare year or a loose string cannot pass as a date. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ].*)?$/;

export function patchNullableDate(
  body: Record<string, unknown>,
  field: string,
): Date | null | undefined {
  const value = patchNullableString(body, field);
  if (value === undefined || value === null) return value;

  const date = new Date(value);
  if (!ISO_DATE.test(value) || Number.isNaN(date.getTime())) {
    throw new HttpError(400, `"${field}" must be an ISO date, e.g. "2024-02-03".`);
  }
  return date;
}

/** A clearable enum field. Values are compared upper-cased. */
export function patchNullableEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  values: readonly T[],
): T | null | undefined {
  const value = patchNullableString(body, field);
  if (value === undefined || value === null) return value;

  const candidate = value.toUpperCase() as T;
  if (!values.includes(candidate)) {
    throw new HttpError(400, `"${field}" must be one of: ${values.join(", ")}.`);
  }
  return candidate;
}

/** An enum field backed by a NOT NULL column, so clearing it is refused. */
export function patchEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  values: readonly T[],
): T | undefined {
  const value = patchNullableEnum(body, field, values);
  if (value === null) throw new HttpError(400, `"${field}" cannot be empty.`);
  return value;
}
