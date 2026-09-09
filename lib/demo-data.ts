import { seedDb } from "@/lib/seed";
import type { Db, Person } from "@/lib/types";

/**
 * The fixture behind the leave screens.
 *
 * `seedDb()` builds the whole demo dataset in memory, so these screens run with
 * no database at all — the tables they were written against were dropped, and
 * the `orgapp` schema models organizations and users only.
 *
 * The member screens are per-person, and an Auth.js MEMBER has no row in the
 * fixture, so they are shown against one of its people. Dev Menon is the pick:
 * he has balances, a request thread and attendance, which is what those screens
 * are built to display.
 */

export const DEMO_MEMBER_ID = "u2";

export function demoDb(): Db {
  return seedDb();
}

export function demoMember(db: Db): Person {
  const person = db.people.find((p) => p.id === DEMO_MEMBER_ID);
  if (!person) {
    throw new Error(`Fixture is missing person ${DEMO_MEMBER_ID}.`);
  }
  return person;
}
