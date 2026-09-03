"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { currentActor } from "@/lib/auth";
import { backWithError, field, formBody } from "@/lib/form";
import { holidayInputFrom, holidayPatchFrom } from "@/lib/holiday-input";
import { createHoliday, deleteHoliday, updateHoliday } from "@/lib/holiday-service";
import { requireActor } from "@/lib/rbac";

/**
 * Server Actions behind the Holiday calendar screen.
 *
 * Same contract as lib/team-actions.ts: re-authenticate rather than trusting
 * proxy.ts, because a Server Action is a POST to the page's own path and a
 * matcher change could remove that gate without any code here changing.
 * Authorization itself lives in lib/holiday-service.ts, which these share with
 * `/api/holidays`.
 *
 * Bodies are read with `holidayInputFrom` / `holidayPatchFrom` — the same
 * parsers the JSON routes use — so a form post and an API call cannot drift
 * apart on field names, defaults or coercion. That also gives the form what it
 * needs for free: a blank end date falls back to the start date, and a blank
 * region select reads as `null`, meaning the whole organization.
 */

/**
 * After a successful write, land back on the year the row belongs to.
 *
 * A write is the one moment the screen knows which year the admin cares about,
 * so adding a 2027 date from the 2026 view shows the new row rather than an
 * apparently empty calendar. An empty year falls back to the bare path, which
 * the page reads as the current year.
 */
function backToCalendar(year: string): never {
  revalidatePath("/holidays");
  redirect(year ? `/holidays?y=${year}` : "/holidays");
}

/** The calendar year an ISO date sits in. `""` for anything unparseable. */
function yearOf(date: string): string {
  return /^\d{4}/.test(date) ? date.slice(0, 4) : "";
}

export async function createHolidayAction(form: FormData): Promise<void> {
  let year = "";

  try {
    const actor = requireActor(await currentActor());
    const input = holidayInputFrom(formBody(form));

    await createHoliday(actor, input);
    year = yearOf(input.startDate);
  } catch (error) {
    // Back to the open form rather than the bare list, so the message lands
    // next to the fields it is about.
    backWithError("/holidays?add=1", error);
  }
  backToCalendar(year);
}

export async function updateHolidayAction(form: FormData): Promise<void> {
  const id = field(form, "id");
  let year = "";

  try {
    const actor = requireActor(await currentActor());

    // `id` names the row being edited, not a column on it — dropping it keeps
    // the patch parser from reading it as a field to write.
    const body = formBody(form);
    delete body["id"];

    const updated = await updateHoliday(actor, id, holidayPatchFrom(body));
    year = yearOf(updated.startDate);
  } catch (error) {
    backWithError(`/holidays?edit=${encodeURIComponent(id)}`, error);
  }
  backToCalendar(year);
}

/**
 * Remove one holiday.
 *
 * The year comes from the form rather than the row: the row is gone by the
 * time we redirect, and the displayed year is what the admin wants to return
 * to anyway.
 */
export async function deleteHolidayAction(form: FormData): Promise<void> {
  const year = yearOf(field(form, "year"));

  try {
    const actor = requireActor(await currentActor());
    await deleteHoliday(actor, field(form, "id"));
  } catch (error) {
    backWithError(year ? `/holidays?y=${year}` : "/holidays", error);
  }
  backToCalendar(year);
}
