import { redirect } from "next/navigation";

import { HttpError } from "@/lib/rbac";

/**
 * Helpers shared by the Server Actions behind the pages.
 *
 * A plain module rather than part of either actions file: a `"use server"` file
 * may only export async functions, so anything shared between two of them has
 * to live outside both.
 */

/** One text field, trimmed. Absent and blank both read as `""`. */
export function field(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The form's text fields as a plain object, so the same parsers that read a
 * JSON request body can read a form post.
 *
 * Keys the form never submitted stay absent, which is what makes "leave this
 * field alone" and "clear this field" distinguishable — see
 * `patchNullableString` in lib/api.ts. File entries are dropped; no form here
 * uploads anything.
 */
export function formBody(form: FormData): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") body[key] = value;
  }
  return body;
}

/**
 * Sends the caller back to `path` with a readable message attached.
 *
 * Failures come back as a `?error=` message on the page rather than an
 * exception, so the forms stay usable without client-side state.
 */
export function backWithError(path: string, error: unknown): never {
  const message = error instanceof HttpError ? error.message : "Something went wrong.";
  const separator = path.includes("?") ? "&" : "?";
  redirect(`${path}${separator}error=${encodeURIComponent(message)}`);
}
