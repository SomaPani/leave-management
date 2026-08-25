/**
 * Date helpers for the app.
 *
 * Every function works on `YYYY-MM-DD` strings and computes in UTC, so the
 * rendered output never shifts with the server's timezone (and never disagrees
 * between a server render and a client hydration).
 */

/**
 * The demo's "current day". The seeded roster, attendance and requests are all
 * anchored to it. Swap this for `new Date()` once the app is backed by live data.
 */
export const TODAY = "2026-08-17";

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const WEEKDAY_SHORT = WEEKDAY_NAMES.map((d) => d.slice(0, 3));

/** Build an ISO date from a year, a 0-based month and a day. */
export function isoDate(year: number, month: number, day: number): string {
  const d = new Date(Date.UTC(year, month, day));
  return d.toISOString().slice(0, 10);
}

function parts(iso: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "");
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]) - 1;
  const d = Number(match[3]);
  if (m < 0 || m > 11 || d < 1 || d > 31) return null;
  return { y, m, d };
}

export function isValidDate(iso: string): boolean {
  return parts(iso) !== null;
}

/** 0 = Sunday … 6 = Saturday. Returns -1 for an unparseable date. */
export function dayOfWeek(iso: string): number {
  const p = parts(iso);
  if (!p) return -1;
  return new Date(Date.UTC(p.y, p.m, p.d)).getUTCDay();
}

export function isWeekend(iso: string): boolean {
  const w = dayOfWeek(iso);
  return w === 0 || w === 6;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/** Weekday index the 1st of the month falls on. */
export function firstWeekdayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 1)).getUTCDay();
}

/** `2026-08-31` → `Aug 31`. */
export function formatShort(iso: string): string {
  const p = parts(iso);
  if (!p) return "—";
  return `${MONTH_SHORT[p.m]} ${p.d}`;
}

/** `2026-08-31` → `31 Aug`. */
export function formatDayMonth(iso: string): string {
  const p = parts(iso);
  if (!p) return "—";
  return `${p.d} ${MONTH_SHORT[p.m]}`;
}

/** `2026-08-17` → `Monday, August 17`. */
export function formatLong(iso: string): string {
  const p = parts(iso);
  if (!p) return "—";
  return `${WEEKDAY_NAMES[dayOfWeek(iso)]}, ${MONTH_NAMES[p.m]} ${p.d}`;
}

/** `2026-08-17` → `Mon, Aug 17 2026`. */
export function formatHeader(iso: string): string {
  const p = parts(iso);
  if (!p) return "—";
  return `${WEEKDAY_SHORT[dayOfWeek(iso)]}, ${MONTH_SHORT[p.m]} ${p.d} ${p.y}`;
}

/** `2026-08-17` → `Mon`. */
export function formatWeekdayShort(iso: string): string {
  const w = dayOfWeek(iso);
  return w < 0 ? "—" : WEEKDAY_SHORT[w];
}

/** A single date renders as `Aug 31`; a span as `Aug 31 – Sep 4`. */
export function formatRange(from: string, to: string): string {
  return from === to ? formatShort(from) : `${formatShort(from)} – ${formatShort(to)}`;
}

/** Mon–Fri days in an inclusive span. Returns 0 if the range is invalid or reversed. */
export function workdays(from: string, to: string): number {
  const a = parts(from);
  const b = parts(to);
  if (!a || !b) return 0;

  const start = Date.UTC(a.y, a.m, a.d);
  const end = Date.UTC(b.y, b.m, b.d);
  if (end < start) return 0;

  const DAY = 86_400_000;
  let count = 0;
  for (let t = start; t <= end; t += DAY) {
    const w = new Date(t).getUTCDay();
    if (w !== 0 && w !== 6) count++;
  }
  return count;
}

/** Shift an ISO date by a whole number of days. */
export function addDays(iso: string, delta: number): string {
  const p = parts(iso);
  if (!p) return iso;
  return isoDate(p.y, p.m, p.d + delta);
}

/** Normalise a `year`/`month` pair after adding an offset to the month. */
export function shiftMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const total = year * 12 + month + delta;
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 };
}
