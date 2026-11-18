import type { DayKind } from "@/lib/day-status";

/**
 * How each kind of day reads on the Overview screens and in the export.
 * Colours match the Attendance screen's palette.
 */
export const DAY_KIND_STYLE: Record<DayKind, { label: string; chip: string }> = {
  PRESENT: { label: "Present", chip: "bg-[#dcfce7] text-[#16a34a]" },
  WFH: { label: "WFH", chip: "bg-[#dbeafe] text-[#2563eb]" },
  ABSENT: { label: "Absent", chip: "bg-[#fee2e2] text-[#dc2626]" },
  LEAVE: { label: "On leave", chip: "bg-[#fef3c7] text-[#d97706]" },
  NOT_MARKED: { label: "Not marked", chip: "bg-[#efeeea] text-muted" },
  HOLIDAY: { label: "Holiday", chip: "bg-[#ede9fe] text-[#7c3aed]" },
  WEEKEND: { label: "Weekend", chip: "bg-[#f4f4f5] text-muted" },
};

/** Filter keys for `/dashboard?show=`, mapped to the kind they keep. */
export const SHOW_FILTERS: { key: string; kind: DayKind | null; label: string }[] = [
  { key: "all", kind: null, label: "All" },
  { key: "present", kind: "PRESENT", label: "Present" },
  { key: "wfh", kind: "WFH", label: "WFH" },
  { key: "absent", kind: "ABSENT", label: "Absent" },
  { key: "leave", kind: "LEAVE", label: "On leave" },
  { key: "unmarked", kind: "NOT_MARKED", label: "Not marked" },
];
