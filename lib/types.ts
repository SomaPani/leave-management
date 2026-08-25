export type Role = "admin" | "user";
export type WorkMode = "WFO" | "WFH";
export type RequestStatus = "pending" | "approved" | "rejected" | "withdrawn";
export type AttendanceCode =
  | "present"
  | "half"
  | "absent"
  | "wfh"
  | "leave"
  | "short";

/** A cell in the attendance grid: one code, or a combination such as `["wfh","half"]`. */
export type AttendanceMark = AttendanceCode | AttendanceCode[];

export type Person = {
  id: string;
  name: string;
  initials: string;
  email: string;
  title: string;
  role: Role;
  region?: string;
  workMode?: WorkMode;
  empId?: string;
  joined?: string;
  personalEmail?: string;
  phone?: string;
  address?: string;
  emergencyName?: string;
  emergencyPhone?: string;
  manager?: string;
};

export type Policy = {
  name: string;
  note: string;
  days: number;
  carry: boolean;
  /** `uses` policies (Short leave) are counted per occurrence, not per day. */
  unit?: "uses";
};

export type WfhPolicy = { perMonth: number; needsApproval: boolean };

export type Holiday = {
  name: string;
  /** ISO `YYYY-MM-DD`. */
  date: string;
  days: number;
  /** Absent means the holiday applies to every region. */
  region?: string;
  note?: string;
};

export type Rule = { label: string; on: boolean };

export type ThreadMessage = { by: "admin" | "user"; text: string; at: string };

export type LeaveRequest = {
  id: string;
  userId: string;
  /** Matches a `Policy.name`. */
  type: string;
  from: string;
  to: string;
  reason: string;
  status: RequestStatus;
  thread: ThreadMessage[];
};

export type DocumentRecord = { id: string; name: string; size: number };

export type ScoreCard = {
  total: number;
  grade: string;
  /** `[label, percentage, detail]` */
  metrics: [string, number, string][];
  /** `[label, value]` */
  ledger: [string, string][];
};

export type Db = {
  people: Person[];
  requests: LeaveRequest[];
  /** `used[userId][policyName]` — days (or uses) already consumed this year. */
  used: Record<string, Record<string, number>>;
  /** `attendance[userId][isoDate]` */
  attendance: Record<string, Record<string, AttendanceMark>>;
  /** `documents[userId]` */
  documents: Record<string, DocumentRecord[]>;
  policies: Policy[];
  wfhPolicy: WfhPolicy;
  holidays: Holiday[];
  holidayRegion: string;
  rules: Rule[];
};
