"use server";

import { refresh } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { TODAY, formatShort, isValidDate } from "@/lib/date";
import {
  initialsFor,
  onApprovedLeave,
  requestDays,
  roster,
  toggleAttendance,
} from "@/lib/domain";
import { REGIONS } from "@/lib/seed";
import {
  SESSION_COOKIE,
  homePathFor,
  requireAdmin,
  requireUser,
} from "@/lib/session";
import { mutateDb, readDb } from "@/lib/store";
import type {
  AttendanceCode,
  Person,
  RequestStatus,
  WorkMode,
} from "@/lib/types";

const ATTENDANCE_CODES: AttendanceCode[] = [
  "present",
  "half",
  "absent",
  "wfh",
  "leave",
  "short",
];

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function integer(form: FormData, key: string, fallback = 0): number {
  const parsed = Number.parseInt(text(form, key), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/* ------------------------------------------------------------------ auth -- */

export async function signIn(form: FormData): Promise<void> {
  const userId = text(form, "userId");
  const db = await readDb();
  const person = db.people.find((p) => p.id === userId);
  if (!person) redirect("/login?error=unknown-account");

  const jar = await cookies();
  jar.set(SESSION_COOKIE, person.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });

  redirect(homePathFor(person));
}

export async function signOut(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}

/* -------------------------------------------------------------- requests -- */

/**
 * The approvals panel posts one form with three submit buttons, so the
 * `intent` field decides what the shared draft textarea is used for.
 */
export async function reviewRequest(form: FormData): Promise<void> {
  await requireAdmin();
  const requestId = text(form, "requestId");
  const intent = text(form, "intent");
  const note = text(form, "note");

  if (intent === "comment") {
    await appendMessage(requestId, "admin", note);
    refresh();
    return;
  }

  const status: RequestStatus | null =
    intent === "approve" ? "approved" : intent === "reject" ? "rejected" : null;
  if (!status) return;

  await mutateDb((db) => {
    const request = db.requests.find((r) => r.id === requestId);
    if (!request || request.status !== "pending") return;

    if (status === "approved") {
      const used = (db.used[request.userId] ??= {});
      used[request.type] = (used[request.type] ?? 0) + requestDays(request);
    }

    request.status = status;
    request.thread.push({
      by: "admin",
      text:
        note ||
        (status === "approved"
          ? "Approved — enjoy."
          : "Rejected. Let's find another window."),
      at: formatShort(TODAY),
    });
  });

  // Approving changes the sidebar badge and the team balances too.
  refresh();
}

/** A member replying on, or withdrawing, their own request. */
export async function updateOwnRequest(form: FormData): Promise<void> {
  const user = await requireUser();
  const requestId = text(form, "requestId");
  const intent = text(form, "intent");

  const db = await readDb();
  const request = db.requests.find((r) => r.id === requestId);
  if (!request || request.userId !== user.id) return;

  if (intent === "withdraw") {
    await mutateDb((current) => {
      const target = current.requests.find((r) => r.id === requestId);
      if (target && target.status === "pending") target.status = "withdrawn";
    });
    refresh();
    return;
  }

  if (intent === "comment") {
    await appendMessage(requestId, "user", text(form, "note"));
    refresh();
  }
}

async function appendMessage(
  requestId: string,
  by: "admin" | "user",
  body: string,
): Promise<void> {
  if (!body) return;
  await mutateDb((db) => {
    const request = db.requests.find((r) => r.id === requestId);
    request?.thread.push({ by, text: body, at: formatShort(TODAY) });
  });
}

/* ------------------------------------------------------------ attendance -- */

export async function markAttendance(form: FormData): Promise<void> {
  await requireAdmin();

  const userId = text(form, "userId");
  const date = text(form, "date");
  const code = text(form, "code") as AttendanceCode;

  if (!isValidDate(date) || !ATTENDANCE_CODES.includes(code)) return;

  await mutateDb((db) => {
    if (!db.people.some((p) => p.id === userId && p.role !== "admin")) return;
    toggleAttendance(db, userId, date, code);
  });

  refresh();
}

export async function markEveryonePresent(form: FormData): Promise<void> {
  await requireAdmin();

  const date = text(form, "date");
  if (!isValidDate(date)) return;

  await mutateDb((db) => {
    for (const person of roster(db)) {
      if (onApprovedLeave(db, person.id, date)) continue;
      (db.attendance[person.id] ??= {})[date] = "present";
    }
  });

  refresh();
}

/* ------------------------------------------------------------------ team -- */

export async function addTeamMember(form: FormData): Promise<void> {
  await requireAdmin();

  const name = text(form, "name");
  if (!name) redirect("/team?error=name");

  const region = REGIONS.includes(text(form, "region"))
    ? text(form, "region")
    : REGIONS[0]!;
  const workMode: WorkMode = text(form, "workMode") === "WFH" ? "WFH" : "WFO";

  const id = `usr_${Date.now().toString(36)}`;
  const person: Person = {
    id,
    name,
    initials: initialsFor(name),
    email:
      text(form, "email") ||
      `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@stacx24.com`,
    title: text(form, "title") || "Team member",
    role: "user",
    region,
    workMode,
  };

  await mutateDb((db) => {
    db.people.push(person);
    db.used[id] = { Casual: 0, Sick: 0, "Paid / annual": 0, "Short leave": 0 };
    db.attendance[id] = {};
  });

  redirect("/team");
}

/* ----------------------------------------------------------- leave setup -- */

export async function updatePolicy(form: FormData): Promise<void> {
  await requireAdmin();

  const index = integer(form, "index", -1);
  const intent = text(form, "intent");

  await mutateDb((db) => {
    const policy = db.policies[index];
    if (!policy) return;
    if (intent === "carry") policy.carry = !policy.carry;
    else policy.days = Math.max(0, integer(form, "days", policy.days));
  });

  refresh();
}

export async function updateWfhPolicy(form: FormData): Promise<void> {
  await requireAdmin();

  const intent = text(form, "intent");

  await mutateDb((db) => {
    if (intent === "approval") {
      db.wfhPolicy.needsApproval = !db.wfhPolicy.needsApproval;
    } else {
      db.wfhPolicy.perMonth = Math.max(
        0,
        integer(form, "perMonth", db.wfhPolicy.perMonth),
      );
    }
  });

  refresh();
}

export async function toggleApprovalRule(form: FormData): Promise<void> {
  await requireAdmin();

  const index = integer(form, "index", -1);

  await mutateDb((db) => {
    const rule = db.rules[index];
    if (rule) rule.on = !rule.on;
  });

  refresh();
}

export async function setHolidayRegion(form: FormData): Promise<void> {
  await requireAdmin();

  const region = text(form, "region");
  if (!REGIONS.includes(region)) return;

  await mutateDb((db) => {
    db.holidayRegion = region;
  });

  refresh();
}

/* ------------------------------------------------------------- documents -- */

export async function uploadDocuments(form: FormData): Promise<void> {
  const user = await requireUser();

  // Only the file metadata is kept — wiring up blob storage is the next step.
  const files = form
    .getAll("docs")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0);
  if (files.length === 0) return;

  await mutateDb((db) => {
    const existing = (db.documents[user.id] ??= []);
    files.forEach((file, i) => {
      existing.push({
        id: `doc_${Date.now().toString(36)}_${i}`,
        name: file.name,
        size: file.size,
      });
    });
  });

  refresh();
}

export async function removeDocument(form: FormData): Promise<void> {
  const user = await requireUser();
  const docId = text(form, "docId");

  await mutateDb((db) => {
    db.documents[user.id] = (db.documents[user.id] ?? []).filter(
      (d) => d.id !== docId,
    );
  });

  refresh();
}
