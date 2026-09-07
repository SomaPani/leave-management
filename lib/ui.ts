import { LeaveRequestStatus } from "@/generated/prisma/enums";
import type { AttendanceCode } from "@/lib/attendance";
import type {
  AttendanceCode as LegacyAttendanceCode,
  RequestStatus,
} from "@/lib/types";

/**
 * Presentation tokens for the two data-driven colour scales in the design.
 * Everything else is expressed with the theme colours in `app/globals.css`.
 */

/**
 * Keyed by the database enum, not the fixture's lowercase union: /approvals
 * and /requests both read `orgapp.LeaveRequest` now, and nothing renders a
 * `RequestStatus` any more.
 */
export const STATUS_STYLE: Record<
  LeaveRequestStatus,
  { label: string; className: string }
> = {
  PENDING: { label: "PENDING", className: "bg-[#fef3c7] text-[#d97706]" },
  APPROVED: { label: "APPROVED", className: "bg-[#dcfce7] text-[#16a34a]" },
  REJECTED: { label: "REJECTED", className: "bg-[#fee2e2] text-[#dc2626]" },
  WITHDRAWN: { label: "WITHDRAWN", className: "bg-[#efeeea] text-muted" },
};

/**
 * The fixture screens' status palette, keyed by the lowercase union in
 * lib/types.ts. Deleted when those screens move to real data; `STATUS_STYLE`
 * above is the one keyed by the database enum.
 *
 * Kept as a separate map rather than casting one union to the other at a call
 * site: the two happen to spell the same four states today, so a cast would
 * compile, and a fixture status with no database counterpart would then reach
 * `STATUS_STYLE[status]` as `undefined` and crash on `.className`. Two maps
 * make that a type error instead. Same reasoning, and the same shape, as
 * `LEGACY_ATTENDANCE_STYLE` below.
 */
export const LEGACY_STATUS_STYLE: Record<
  RequestStatus,
  { label: string; className: string }
> = {
  pending: STATUS_STYLE.PENDING,
  approved: STATUS_STYLE.APPROVED,
  rejected: STATUS_STYLE.REJECTED,
  withdrawn: STATUS_STYLE.WITHDRAWN,
};

/**
 * The fixture screens' attendance palette, keyed by the lowercase codes in
 * lib/types.ts. Deleted when those screens move to real data;
 * `ATTENDANCE_STYLE` below is the one keyed by the database enums.
 */
export const LEGACY_ATTENDANCE_STYLE: Record<
  LegacyAttendanceCode,
  { label: string; short: string; chip: string; border: string; swatch: string }
> = {
  present: {
    label: "Present",
    short: "P",
    chip: "bg-[#dcfce7] text-[#16a34a]",
    border: "border-[#16a34a]",
    swatch: "bg-[#dcfce7] border-[#16a34a]",
  },
  half: {
    label: "Half day",
    short: "H",
    chip: "bg-[#fef3c7] text-[#d97706]",
    border: "border-[#d97706]",
    swatch: "bg-[#fef3c7] border-[#d97706]",
  },
  absent: {
    label: "Absent",
    short: "A",
    chip: "bg-[#fee2e2] text-[#dc2626]",
    border: "border-[#dc2626]",
    swatch: "bg-[#fee2e2] border-[#dc2626]",
  },
  wfh: {
    label: "WFH",
    short: "W",
    chip: "bg-[#dcfce7] text-[#16a34a]",
    border: "border-[#16a34a]",
    swatch: "bg-[#dcfce7] border-[#16a34a]",
  },
  leave: {
    label: "On leave",
    short: "L",
    chip: "bg-[#e0e7ff] text-[#4338ca]",
    border: "border-[#4338ca]",
    swatch: "bg-[#e0e7ff] border-[#4338ca]",
  },
  short: {
    label: "Short leave",
    short: "S",
    chip: "bg-[#fce7f3] text-[#be185d]",
    border: "border-[#be185d]",
    swatch: "bg-[#fce7f3] border-[#be185d]",
  },
};

/**
 * The same palette keyed by the Prisma enums, for the screens on real data.
 *
 * No `label` key: `codeLabel` in lib/attendance.ts owns the wording, so a
 * button and a pill cannot disagree about what to call a code.
 *
 * WFH deliberately shares Present's green — a day worked from home is still a
 * day worked, and the design distinguishes them by label, not colour.
 */
export const ATTENDANCE_STYLE: Record<
  AttendanceCode,
  { short: string; chip: string; border: string; swatch: string }
> = {
  PRESENT: {
    short: "P",
    chip: "bg-[#dcfce7] text-[#16a34a]",
    border: "border-[#16a34a]",
    swatch: "bg-[#dcfce7] border-[#16a34a]",
  },
  WFH: {
    short: "W",
    chip: "bg-[#dcfce7] text-[#16a34a]",
    border: "border-[#16a34a]",
    swatch: "bg-[#dcfce7] border-[#16a34a]",
  },
  HALF_DAY: {
    short: "H",
    chip: "bg-[#fef3c7] text-[#d97706]",
    border: "border-[#d97706]",
    swatch: "bg-[#fef3c7] border-[#d97706]",
  },
  ABSENT: {
    short: "A",
    chip: "bg-[#fee2e2] text-[#dc2626]",
    border: "border-[#dc2626]",
    swatch: "bg-[#fee2e2] border-[#dc2626]",
  },
  LEAVE: {
    short: "L",
    chip: "bg-[#e0e7ff] text-[#4338ca]",
    border: "border-[#4338ca]",
    swatch: "bg-[#e0e7ff] border-[#4338ca]",
  },
  SHORT_LEAVE: {
    short: "S",
    chip: "bg-[#fce7f3] text-[#be185d]",
    border: "border-[#be185d]",
    swatch: "bg-[#fce7f3] border-[#be185d]",
  },
};

/** Order used by the fixture screens' legend and summary pills. */
export const ATTENDANCE_ORDER: LegacyAttendanceCode[] = [
  "present",
  "half",
  "wfh",
  "absent",
  "leave",
  "short",
];

/** The "status today" pill on the team table. */
export function todayPill(codes: LegacyAttendanceCode[]): {
  label: string;
  className: string;
} {
  for (const code of ["leave", "wfh", "half", "absent"] as const) {
    if (codes.includes(code)) {
      return {
        label: LEGACY_ATTENDANCE_STYLE[code].label,
        className: LEGACY_ATTENDANCE_STYLE[code].chip,
      };
    }
  }
  return { label: "Working", className: LEGACY_ATTENDANCE_STYLE.present.chip };
}
