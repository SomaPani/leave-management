import { AttendanceModifier, AttendanceStatus } from "@/generated/prisma/enums";
import { HttpError } from "@/lib/rbac";

/**
 * The attendance rules, as pure functions.
 *
 * No Prisma and no session here, so the whole combination matrix is unit
 * testable — the same split lib/rbac.ts has from lib/services.ts.
 *
 * A day is a `status` plus an optional `modifier`. `null` is not a third
 * status: it means the day has no row at all, which is how "not marked yet" is
 * stored.
 */

export type AttendanceState = {
  status: AttendanceStatus;
  modifier: AttendanceModifier | null;
};

/**
 * One button on the grid. The six codes are exactly the two enums' members, so
 * a code needs no separate vocabulary and no mapping table.
 */
export type AttendanceCode = AttendanceStatus | AttendanceModifier;

/** Render order on the grid. */
export const ATTENDANCE_CODES: AttendanceCode[] = [
  AttendanceStatus.PRESENT,
  AttendanceStatus.WFH,
  AttendanceModifier.HALF_DAY,
  AttendanceStatus.ABSENT,
  AttendanceStatus.LEAVE,
  AttendanceModifier.SHORT_LEAVE,
];

/** A day partly worked — the only base a modifier may sit on. */
const WORKING: AttendanceStatus[] = [AttendanceStatus.PRESENT, AttendanceStatus.WFH];

const MODIFIERS: string[] = [
  AttendanceModifier.HALF_DAY,
  AttendanceModifier.SHORT_LEAVE,
];

function isModifier(code: AttendanceCode): code is AttendanceModifier {
  return MODIFIERS.includes(code);
}

export function isWorkingStatus(status: AttendanceStatus): boolean {
  return WORKING.includes(status);
}

/* ----------------------------------------------------------------- dates -- */

/**
 * The timezone "today" is resolved in.
 *
 * A fixed zone rather than the server's: the team is in India, and comparing a
 * UTC `new Date()` against a `YYYY-MM-DD` string would roll the attendance day
 * over at 05:30 local. Override per-deployment with `ATTENDANCE_TIMEZONE`.
 */
export const ATTENDANCE_TIMEZONE = process.env.ATTENDANCE_TIMEZONE ?? "Asia/Kolkata";

/** Today, as `YYYY-MM-DD`, in `ATTENDANCE_TIMEZONE`. */
export function todayIso(now: Date = new Date()): string {
  // `en-CA` formats as YYYY-MM-DD, which is the shape the rest of the app uses.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ATTENDANCE_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A `YYYY-MM-DD` string, or a 400.
 *
 * Round-tripping through `Date` rejects the days that match the pattern but do
 * not exist — `2026-02-30` normalises to March 2nd, so the strings differ.
 */
export function parseDateParam(value: unknown, field = "date"): string {
  if (typeof value !== "string" || !ISO_DAY.test(value.trim())) {
    throw new HttpError(400, `"${field}" must be a date, e.g. "2026-08-17".`);
  }

  const iso = value.trim();
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) {
    throw new HttpError(400, `"${field}" is not a real date.`);
  }
  return iso;
}

/** String comparison is enough: `YYYY-MM-DD` sorts chronologically. */
export function isFutureDate(date: string, today: string = todayIso()): boolean {
  return date > today;
}

/** Today and every past day may be marked; tomorrow may not. */
export function assertMarkable(date: string, today: string = todayIso()): void {
  if (isFutureDate(date, today)) {
    throw new HttpError(400, "Attendance cannot be marked for a future date.");
  }
}

/** `2026-08-17` to the UTC-midnight `Date` a DATE column stores. */
export function toDbDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** The inverse. Prisma hands DATE columns back at UTC midnight. */
export function fromDbDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/* ---------------------------------------------------------------- toggle -- */

export function isActiveCode(
  state: AttendanceState | null,
  code: AttendanceCode,
): boolean {
  if (!state) return false;
  return isModifier(code) ? state.modifier === code : state.status === code;
}

/**
 * The next state after one button press. Total: every code applies to every
 * state, and the result is always storable.
 *
 * Clicking whichever code is already active clears the whole day rather than
 * peeling off one layer — a HALF_DAY with no base is not a state this schema
 * can hold, and "clicking the lit button turns the day off" is the simpler
 * rule to explain.
 *
 * Applying an add-on to a day that is unmarked, absent or on leave promotes it
 * to PRESENT, since a half day is by definition a day partly worked.
 */
export function toggle(
  state: AttendanceState | null,
  code: AttendanceCode,
): AttendanceState | null {
  if (isModifier(code)) {
    if (state?.modifier === code) {
      // The base survives; the CHECK constraint guarantees it is a working day.
      return { status: state.status, modifier: null };
    }
    const base =
      state && isWorkingStatus(state.status) ? state.status : AttendanceStatus.PRESENT;
    return { status: base, modifier: code };
  }

  if (state?.status === code) return null;

  return {
    status: code,
    // A base swap keeps the add-on; anything else drops it, which is what makes
    // Absent and On leave exclusive without a special case.
    modifier:
      isWorkingStatus(code) && state && isWorkingStatus(state.status)
        ? state.modifier
        : null,
  };
}

/* ----------------------------------------------------------------- label -- */

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  PRESENT: "Present",
  WFH: "WFH",
  ABSENT: "Absent",
  LEAVE: "On leave",
};

const MODIFIER_LABEL: Record<AttendanceModifier, string> = {
  HALF_DAY: "Half day",
  SHORT_LEAVE: "Short leave",
};

export function codeLabel(code: AttendanceCode): string {
  return isModifier(code) ? MODIFIER_LABEL[code] : STATUS_LABEL[code];
}

/** The one-line note under a person's name on the grid. */
export function describeState(state: AttendanceState | null): string {
  if (!state) return "Not marked yet";
  const base = STATUS_LABEL[state.status];
  return state.modifier ? `${base} + ${MODIFIER_LABEL[state.modifier]}` : base;
}
