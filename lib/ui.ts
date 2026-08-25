import type { AttendanceCode, RequestStatus } from "@/lib/types";

/**
 * Presentation tokens for the two data-driven colour scales in the design.
 * Everything else is expressed with the theme colours in `app/globals.css`.
 */

export const STATUS_STYLE: Record<
  RequestStatus,
  { label: string; className: string }
> = {
  pending: { label: "PENDING", className: "bg-[#fef3c7] text-[#d97706]" },
  approved: { label: "APPROVED", className: "bg-[#dcfce7] text-[#16a34a]" },
  rejected: { label: "REJECTED", className: "bg-[#fee2e2] text-[#dc2626]" },
  withdrawn: { label: "WITHDRAWN", className: "bg-[#efeeea] text-muted" },
};

export const ATTENDANCE_STYLE: Record<
  AttendanceCode,
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

/** Order used by the legend and the summary pills. */
export const ATTENDANCE_ORDER: AttendanceCode[] = [
  "present",
  "half",
  "wfh",
  "absent",
  "leave",
  "short",
];

/** The "status today" pill on the team table. */
export function todayPill(codes: AttendanceCode[]): {
  label: string;
  className: string;
} {
  for (const code of ["leave", "wfh", "half", "absent"] as const) {
    if (codes.includes(code)) {
      return { label: ATTENDANCE_STYLE[code].label, className: ATTENDANCE_STYLE[code].chip };
    }
  }
  return { label: "Working", className: ATTENDANCE_STYLE.present.chip };
}
