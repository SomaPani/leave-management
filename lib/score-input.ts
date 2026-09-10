import { ScoreStatus } from "@/generated/prisma/enums";
import { HttpError } from "@/lib/rbac";

/**
 * Parsing the scorecard ingest payload.
 *
 * Separate from the service for the same reason lib/attendance-input.ts is:
 * what a request body is allowed to say is its own rule, testable without a
 * database.
 *
 * The one thing this file must never do is turn an absent number into a zero.
 * A NOT_SCORED day carries no numbers at all, and a zero here would be
 * indistinguishable from a genuinely bad day.
 */

export type ScoreDayInput = {
  email: string;
  /** `YYYY-MM-DD`. */
  date: string;
  status: ScoreStatus;
  reason: string | null;
  attendance: string;

  checkinPts: number | null;
  pickedPts: number | null;
  descriptionPts: number | null;
  commitPts: number | null;
  commentPts: number | null;
  deliveryPts: number | null;
  coordinationPts: number | null;

  process: number | null;
  delivery: number | null;
  total: number | null;
  band: string | null;

  tasksPicked: number | null;
  tasksDone: number | null;
  tasksCredit: number | null;
  volumeFactor: number | null;

  pickedTasks: string[];
  flags: string[];
  computedAt: Date;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${where} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/** A number, or null when absent. Never a zero standing in for "no value". */
function num(source: Record<string, unknown>, field: string): number | null {
  const value = source[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, `"${field}" must be a number.`);
  }
  return value;
}

function text(source: Record<string, unknown>, field: string): string | null {
  const value = source[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, `"${field}" must be a string.`);
  return value.trim();
}

function strings(source: Record<string, unknown>, field: string): string[] {
  const value = source[field];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new HttpError(400, `"${field}" must be an array of strings.`);
  }
  return value as string[];
}

function parseDay(raw: unknown): ScoreDayInput {
  const day = record(raw, 'Each entry in "days"');

  const email = String(day.email ?? "").trim().toLowerCase();
  if (!EMAIL.test(email)) throw new HttpError(400, `"email" must be an email address.`);

  const date = String(day.date ?? "").trim();
  if (!ISO_DATE.test(date)) throw new HttpError(400, `"date" must be YYYY-MM-DD.`);

  const status = String(day.status ?? "").toUpperCase();
  if (status !== ScoreStatus.SCORED && status !== ScoreStatus.NOT_SCORED) {
    throw new HttpError(400, `"status" must be SCORED or NOT_SCORED.`);
  }

  const computedAt = new Date(String(day.computedAt ?? ""));
  if (Number.isNaN(computedAt.getTime())) {
    throw new HttpError(400, `"computedAt" must be a timestamp.`);
  }

  // Absent for a NOT_SCORED day, and that is exactly right: every points field
  // below stays null rather than becoming zero.
  const points = day.points === undefined ? {} : record(day.points, '"points"');

  return {
    email,
    date,
    status: status as ScoreStatus,
    reason: text(day, "reason"),
    attendance: text(day, "attendance") ?? "Unknown",

    checkinPts: num(points, "checkin"),
    pickedPts: num(points, "picked"),
    descriptionPts: num(points, "description"),
    commitPts: num(points, "commit"),
    commentPts: num(points, "comment"),
    // The upstream record calls the delivery points "done"; the column here is
    // deliveryPts, matching what the rubric calls the 60 points.
    deliveryPts: num(points, "done"),
    coordinationPts: num(points, "coordination"),

    process: num(day, "process"),
    delivery: num(day, "delivery"),
    total: num(day, "total"),
    band: text(day, "band"),

    tasksPicked: num(day, "tasksPicked"),
    tasksDone: num(day, "tasksDone"),
    tasksCredit: num(day, "tasksCredit"),
    volumeFactor: num(day, "volumeFactor"),

    pickedTasks: strings(day, "pickedTasks"),
    flags: strings(day, "flags"),
    computedAt,
  };
}

export function parseScorePayload(body: Record<string, unknown>): ScoreDayInput[] {
  const days = body.days;
  if (!Array.isArray(days) || days.length === 0) {
    throw new HttpError(400, `"days" must be a non-empty array.`);
  }
  return days.map(parseDay);
}
