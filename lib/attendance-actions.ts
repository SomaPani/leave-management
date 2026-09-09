"use server";

import { refresh } from "next/cache";

import { parseDateParam } from "@/lib/attendance";
import { codeFrom } from "@/lib/attendance-input";
import { markEveryonePresent, toggleAttendanceCode } from "@/lib/attendance-service";
import { currentActor } from "@/lib/auth";
import { backWithError, field } from "@/lib/form";
import { requireActor } from "@/lib/rbac";

/**
 * Server Actions behind the attendance grid.
 *
 * Same contract as lib/team-actions.ts: re-authenticate rather than trusting
 * proxy.ts, because a Server Action is a POST to the page's own path and a
 * matcher change could remove that gate without any code here changing.
 * Authorization lives in lib/attendance-service.ts, shared with
 * /api/attendance.
 *
 * On success these call `refresh()` and return rather than redirecting, so the
 * selected date and the scroll position survive a click. Only a failure
 * navigates, carrying the message back as `?error=`.
 */

export async function markAttendanceAction(form: FormData): Promise<void> {
  const date = field(form, "date");

  try {
    const actor = requireActor(await currentActor());
    await toggleAttendanceCode(actor, {
      userId: field(form, "userId"),
      date: parseDateParam(date, "date"),
      code: codeFrom(field(form, "code")),
    });
  } catch (error) {
    backWithError(`/attendance?date=${encodeURIComponent(date)}`, error);
  }

  refresh();
}

export async function markEveryonePresentAction(form: FormData): Promise<void> {
  const date = field(form, "date");

  try {
    const actor = requireActor(await currentActor());
    await markEveryonePresent(actor, parseDateParam(date, "date"));
  } catch (error) {
    backWithError(`/attendance?date=${encodeURIComponent(date)}`, error);
  }

  refresh();
}
