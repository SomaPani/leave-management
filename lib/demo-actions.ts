"use server";

import { redirect } from "next/navigation";

/**
 * Stand-ins for the leave-management server actions.
 *
 * The admin screens render `seedDb()` — an in-memory fixture, not a table — so
 * there is nowhere for a decision, a mark or a policy edit to go. Each action
 * below bounces back to the page it came from with `?demo=…`, which the page
 * turns into a banner saying the change was not saved. That is deliberately
 * more honest than a silent no-op, which reads as a broken button.
 *
 * The real versions are still in lib/actions.ts. Swapping back to them means
 * giving these screens a data source first — see the note at the top of
 * app/(leave)/approvals/page.tsx.
 */

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

/** Preserves the date the attendance grid was showing. */
function attendanceHref(form: FormData, marker: string): string {
  const date = text(form, "date");
  return `/attendance?${date ? `date=${date}&` : ""}demo=${marker}`;
}

/* ------------------------------------------------------------ approvals -- */

export async function demoReviewRequest(form: FormData): Promise<void> {
  const requestId = text(form, "requestId");
  const filter = text(form, "filter") || "pending";
  const intent = text(form, "intent") || "comment";

  redirect(`/approvals?filter=${filter}&r=${requestId}&demo=${intent}`);
}

/* ----------------------------------------------------------- attendance -- */

export async function demoMarkAttendance(form: FormData): Promise<void> {
  redirect(attendanceHref(form, "mark"));
}

export async function demoMarkEveryonePresent(form: FormData): Promise<void> {
  redirect(attendanceHref(form, "present"));
}

/* ----------------------------------------------------------------- team -- */

export async function demoAddTeamMember(): Promise<void> {
  redirect("/team?demo=add");
}

/* --------------------------------------------------------------- member -- */

export async function demoSubmitLeaveRequest(): Promise<void> {
  redirect("/apply?demo=apply");
}

export async function demoUpdateOwnRequest(form: FormData): Promise<void> {
  const requestId = text(form, "requestId");
  redirect(`/requests?${requestId ? `r=${requestId}&` : ""}demo=reply`);
}

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
