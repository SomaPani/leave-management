import { HttpError } from "@/lib/rbac";

/**
 * Turning thrown errors into the status codes the design calls for:
 * 401 unauthenticated, 403 wrong role/org, 409 duplicate email, 400 validation.
 */

/** Prisma's unique-constraint violation. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (isUniqueViolation(error)) {
    return Response.json(
      { error: "That email address is already registered." },
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
