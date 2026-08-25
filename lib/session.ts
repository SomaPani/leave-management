import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { readDb } from "@/lib/store";
import type { Person } from "@/lib/types";

export const SESSION_COOKIE = "lm_user";

/**
 * The demo signs in by picking an account, so the session cookie is just the
 * person's id. A real deployment would swap this for a signed/encrypted session
 * — every caller below only depends on `getCurrentUser` returning a `Person`.
 */
export async function getCurrentUser(): Promise<Person | null> {
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  if (!id) return null;

  const db = await readDb();
  return db.people.find((p) => p.id === id) ?? null;
}

export function homePathFor(user: Person): string {
  return user.role === "admin" ? "/approvals" : "/overview";
}

/** Any signed-in user, or a redirect to the sign-in screen. */
export async function requireUser(): Promise<Person> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** An admin, or a redirect away from the admin-only area. */
export async function requireAdmin(): Promise<Person> {
  const user = await requireUser();
  if (user.role !== "admin") redirect(homePathFor(user));
  return user;
}

/** A non-admin, or a redirect away from the member-only area. */
export async function requireMember(): Promise<Person> {
  const user = await requireUser();
  if (user.role === "admin") redirect(homePathFor(user));
  return user;
}
