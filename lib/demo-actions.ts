"use server";

import { redirect } from "next/navigation";

/**
 * Stand-ins for the leave-management server actions.
 *
 * The screens still on `seedDb()` — an in-memory fixture, not a table — have
 * nowhere for a decision or a policy edit to go. Each action below bounces back
 * to the page it came from with `?demo=…`, which the page turns into a banner
 * saying the change was not saved. That is deliberately more honest than a
 * silent no-op, which reads as a broken button.
 *
 * Attendance has left: it is backed by `orgapp.Attendance` and writes through
 * lib/attendance-actions.ts. Team left before it, then the holiday calendar,
 * then Apply, and now the approvals loop — /approvals and /requests both write
 * through lib/leave-actions.ts. The rest go the same way: each needs a real
 * data source first, not a different action.
 */

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

/* ----------------------------------------------------------------- team -- */

export async function demoAddTeamMember(): Promise<void> {
  redirect("/team?demo=add");
}

/* --------------------------------------------------------------- member -- */

export async function demoUploadDocuments(): Promise<void> {
  redirect("/profile?demo=upload");
}

export async function demoRemoveDocument(): Promise<void> {
  redirect("/profile?demo=remove");
}

/* ---------------------------------------------------------------- setup -- */

export async function demoUpdatePolicy(): Promise<void> {
  redirect("/setup?demo=policy");
}

export async function demoUpdateWfhPolicy(): Promise<void> {
  redirect("/setup?demo=wfh");
}

export async function demoToggleApprovalRule(): Promise<void> {
  redirect("/setup?demo=rule");
}

/**
 * The one change that does take effect: the region is carried in the URL, so
 * the holiday calendar below it really does switch. Nothing is written.
 */
export async function demoSetHolidayRegion(form: FormData): Promise<void> {
  const region = text(form, "region");
  redirect(`/setup?region=${encodeURIComponent(region)}`);
}
