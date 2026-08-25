import { isoDate, isWeekend } from "@/lib/date";
import type {
  AttendanceMark,
  Db,
  Holiday,
  LeaveRequest,
  Person,
  Policy,
  Rule,
  ScoreCard,
} from "@/lib/types";

export const COMPANY_NAME = "Stacx24";

export const REGIONS = ["Chennai", "Delhi"];

export const PEOPLE: Person[] = [
  {
    id: "u1",
    name: "Ananya Rao",
    initials: "AR",
    email: "ananya@stacx24.com",
    title: "Design lead",
    role: "admin",
  },
  {
    id: "u2",
    name: "Dev Menon",
    initials: "DM",
    email: "dev@stacx24.com",
    title: "Copywriter",
    role: "user",
    region: "Chennai",
    empId: "STX-0142",
    joined: "3 Feb 2024",
    personalEmail: "dev.menon@gmail.com",
    phone: "+91 98410 22318",
    address: "12B Kasturi Rangan Rd, Alwarpet, Chennai 600018",
    emergencyName: "Latha Menon (mother)",
    emergencyPhone: "+91 98400 71129",
    manager: "Ananya Rao",
  },
  {
    id: "u3",
    name: "Priya Shah",
    initials: "PS",
    email: "priya@stacx24.com",
    title: "Account manager",
    role: "user",
    region: "Delhi",
    empId: "STX-0118",
    joined: "9 Sep 2023",
    personalEmail: "priya.shah@gmail.com",
    phone: "+91 98110 46527",
    address: "44 Nizamuddin East, New Delhi 110013",
    emergencyName: "Rakesh Shah (father)",
    emergencyPhone: "+91 98104 33810",
    manager: "Ananya Rao",
  },
  {
    id: "u4",
    name: "Kabir Nair",
    initials: "KN",
    email: "kabir@stacx24.com",
    title: "Motion designer",
    role: "user",
    region: "Chennai",
  },
  {
    id: "u5",
    name: "Meera Iyer",
    initials: "MI",
    email: "meera@stacx24.com",
    title: "Strategist",
    role: "user",
    region: "Delhi",
  },
  {
    id: "u6",
    name: "Rohan Das",
    initials: "RD",
    email: "rohan@stacx24.com",
    title: "Developer",
    role: "user",
    region: "Chennai",
  },
];

/** The three accounts offered on the sign-in screen. */
export const DEMO_ACCOUNT_IDS = ["u1", "u2", "u3"];

export const SCORES: Record<string, ScoreCard> = {
  u2: {
    total: 86,
    grade: "Strong",
    metrics: [
      ["Attendance", 94, "182 of 194 working days"],
      ["Punctuality", 88, "9 late arrivals"],
      ["Leave discipline", 91, "1 unplanned absence"],
      ["Utilisation", 76, "Billable vs. available"],
    ],
    ledger: [
      ["Working days", "194"],
      ["Days present", "182"],
      ["WFH days", "21"],
      ["Leave taken", "12 days"],
      ["Half days", "4"],
      ["Unplanned absence", "1"],
    ],
  },
  u3: {
    total: 79,
    grade: "On track",
    metrics: [
      ["Attendance", 89, "173 of 194 working days"],
      ["Punctuality", 74, "22 late arrivals"],
      ["Leave discipline", 82, "3 unplanned absences"],
      ["Utilisation", 84, "Billable vs. available"],
    ],
    ledger: [
      ["Working days", "194"],
      ["Days present", "173"],
      ["WFH days", "34"],
      ["Leave taken", "19 days"],
      ["Half days", "6"],
      ["Unplanned absence", "3"],
    ],
  },
  u4: {
    total: 92,
    grade: "Excellent",
    metrics: [
      ["Attendance", 97, "188 of 194 working days"],
      ["Punctuality", 95, "3 late arrivals"],
      ["Leave discipline", 96, "None"],
      ["Utilisation", 81, "Billable vs. available"],
    ],
    ledger: [
      ["Working days", "194"],
      ["Days present", "188"],
      ["WFH days", "12"],
      ["Leave taken", "6 days"],
      ["Half days", "2"],
      ["Unplanned absence", "0"],
    ],
  },
  u5: {
    total: 71,
    grade: "Needs attention",
    metrics: [
      ["Attendance", 84, "163 of 194 working days"],
      ["Punctuality", 68, "31 late arrivals"],
      ["Leave discipline", 70, "5 unplanned absences"],
      ["Utilisation", 62, "Billable vs. available"],
    ],
    ledger: [
      ["Working days", "194"],
      ["Days present", "163"],
      ["WFH days", "41"],
      ["Leave taken", "23 days"],
      ["Half days", "9"],
      ["Unplanned absence", "5"],
    ],
  },
  u6: {
    total: 88,
    grade: "Strong",
    metrics: [
      ["Attendance", 93, "180 of 194 working days"],
      ["Punctuality", 91, "6 late arrivals"],
      ["Leave discipline", 89, "1 unplanned absence"],
      ["Utilisation", 88, "Billable vs. available"],
    ],
    ledger: [
      ["Working days", "194"],
      ["Days present", "180"],
      ["WFH days", "28"],
      ["Leave taken", "14 days"],
      ["Half days", "3"],
      ["Unplanned absence", "1"],
    ],
  },
};

/** The member's own score board is a fixed placeholder in the design. */
export const MY_SCORE = {
  total: "86",
  grade: "Strong",
  note: "Placeholder figures — wired up once the real data source is connected.",
  metrics: [
    { label: "Attendance", value: "94%", detail: "182 of 194 working days", pct: 94 },
    { label: "Punctuality", value: "88%", detail: "9 late arrivals this year", pct: 88 },
    { label: "Leave discipline", value: "91%", detail: "1 unplanned absence", pct: 91 },
    { label: "Utilisation", value: "76%", detail: "Billable vs. available hours", pct: 76 },
  ],
  quarters: [
    { label: "Q1", value: 82 },
    { label: "Q2", value: 88 },
    { label: "Q3", value: 86 },
    { label: "Q4", value: 0 },
  ],
  ledger: [
    { label: "Working days", value: "194" },
    { label: "Days present", value: "182" },
    { label: "WFH days", value: "21" },
    { label: "Leave taken", value: "12 days" },
    { label: "Half days", value: "4" },
    { label: "Unplanned absence", value: "1" },
  ],
};

const POLICIES: Policy[] = [
  {
    name: "Casual",
    note: "Short personal breaks, applied at least a day ahead.",
    days: 6,
    carry: false,
  },
  {
    name: "Sick",
    note: "No notice needed. Doctor's note past three days.",
    days: 6,
    carry: false,
  },
  {
    name: "Paid / annual",
    note: "Accrues monthly. Two weeks' notice for 5+ days.",
    days: 18,
    carry: true,
  },
  {
    name: "Short leave",
    note: "2 hours for a medical or personal emergency. Same-day, no notice needed.",
    days: 4,
    carry: false,
    unit: "uses",
  },
];

const HOLIDAYS: Holiday[] = [
  { name: "New Year's Day", date: "2026-01-01", days: 1 },
  { name: "Pongal", date: "2026-01-15", days: 1, region: "Chennai" },
  { name: "Republic Day", date: "2026-01-26", days: 1 },
  { name: "Holi", date: "2026-03-03", days: 1, region: "Delhi" },
  { name: "Independence Day", date: "2026-08-15", days: 1 },
  { name: "Gandhi Jayanti", date: "2026-10-02", days: 1 },
  { name: "Diwali", date: "2026-11-08", days: 2 },
  { name: "Christmas", date: "2026-12-25", days: 1 },
];

const RULES: Rule[] = [
  { label: "Auto-approve single-day sick leave", on: true },
  { label: "Warn when two people from a team overlap", on: true },
  { label: "Require a reason on every request", on: false },
];

const REQUESTS: LeaveRequest[] = [
  {
    id: "r1",
    userId: "u2",
    type: "Paid / annual",
    from: "2026-08-31",
    to: "2026-09-04",
    reason:
      "Family trip booked in June — flights are non-refundable. Handing the Larkin copy to Priya before I go.",
    status: "pending",
    thread: [],
  },
  {
    id: "r2",
    userId: "u4",
    type: "Casual",
    from: "2026-08-20",
    to: "2026-08-20",
    reason: "House move.",
    status: "pending",
    thread: [
      {
        by: "admin",
        text: "Can you push this a day? The Ferro edit ships Thursday.",
        at: "Aug 17",
      },
    ],
  },
  {
    id: "r3",
    userId: "u3",
    type: "Sick",
    from: "2026-08-17",
    to: "2026-08-18",
    reason: "Fever since last night.",
    status: "approved",
    thread: [
      { by: "admin", text: "Rest up. I'll cover the Monday standup.", at: "Aug 17" },
    ],
  },
  {
    id: "r4",
    userId: "u5",
    type: "Paid / annual",
    from: "2026-08-24",
    to: "2026-08-28",
    reason: "Holiday.",
    status: "rejected",
    thread: [
      {
        by: "admin",
        text: "Clashes with the Novara pitch week — can we look at the first week of September instead?",
        at: "Aug 14",
      },
      { by: "user", text: "September 7–11 works for me. Reapplying now.", at: "Aug 15" },
    ],
  },
  {
    id: "r5",
    userId: "u6",
    type: "Casual",
    from: "2026-08-13",
    to: "2026-08-13",
    reason: "Visa appointment.",
    status: "approved",
    thread: [],
  },
];

/** Weekdays 1–17 August 2026 marked present, with a handful of exceptions. */
function seedAttendance(): Record<string, Record<string, AttendanceMark>> {
  const exceptions: Record<string, Record<string, AttendanceMark>> = {
    u2: { "2026-08-06": "half", "2026-08-11": "absent", "2026-08-17": "wfh" },
    u3: { "2026-08-04": "half", "2026-08-10": "wfh" },
    u4: { "2026-08-07": "absent", "2026-08-12": "half", "2026-08-17": "wfh" },
    u5: { "2026-08-05": "absent", "2026-08-17": "half" },
    u6: { "2026-08-13": "half", "2026-08-14": "wfh", "2026-08-17": "wfh" },
  };

  const out: Record<string, Record<string, AttendanceMark>> = {};
  for (const person of PEOPLE) {
    if (person.role === "admin") continue;
    const record: Record<string, AttendanceMark> = {};
    for (let day = 1; day <= 17; day++) {
      const key = isoDate(2026, 7, day);
      if (isWeekend(key)) continue;
      record[key] = exceptions[person.id]?.[key] ?? "present";
    }
    out[person.id] = record;
  }
  return out;
}

/**
 * Days covered by an approved request are left unmarked so the app's own rule —
 * approved leave fills itself in — is what shows, rather than a stale
 * "present" from the bulk seed.
 */
function clearApprovedLeaveDays(
  attendance: Record<string, Record<string, AttendanceMark>>,
): void {
  for (const request of REQUESTS) {
    if (request.status !== "approved") continue;
    const record = attendance[request.userId];
    if (!record) continue;
    for (const key of Object.keys(record)) {
      if (key >= request.from && key <= request.to) delete record[key];
    }
  }
}

export function seedDb(): Db {
  const attendance = seedAttendance();
  clearApprovedLeaveDays(attendance);

  return {
    people: PEOPLE.map((p) => ({ ...p })),
    requests: REQUESTS.map((r) => ({ ...r, thread: [...r.thread] })),
    used: {
      u2: { Casual: 4, Sick: 2, "Paid / annual": 6 },
      u3: { Casual: 4, Sick: 1, "Paid / annual": 11 },
      u4: { Casual: 2, Sick: 5, "Paid / annual": 3 },
      u5: { Casual: 5, Sick: 0, "Paid / annual": 14 },
      u6: { Casual: 1, Sick: 3, "Paid / annual": 8 },
    },
    attendance,
    documents: {},
    policies: POLICIES.map((p) => ({ ...p })),
    wfhPolicy: { perMonth: 2, needsApproval: true },
    holidays: HOLIDAYS.map((h) => ({ ...h })),
    holidayRegion: "Chennai",
    rules: RULES.map((r) => ({ ...r })),
  };
}
