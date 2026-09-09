# Score Boards on Real Data — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put `/score` and `/scores` on the real daily performance scores computed by the Standup-Automation pipeline, with an admin seeing their own organization and a member seeing only themselves.

**Architecture:** Standup-Automation gains a fourth output sink that POSTs each scored day to a new token-authenticated `POST /api/scores`. leave-management stores those days in one new table keyed `(userId, date)`, so the upstream recompute pass corrects rows in place. Both screens read an actor-scoped service; the member read takes no user id at all.

**Tech Stack:** Next.js 16 (App Router, Server Components), Prisma 7 + Postgres, Vitest, TypeScript. Phase 2 only: Python 3, pytest, `requests`, gspread.

**Spec:** [`docs/2026-09-09-score-real-data-design.md`](./2026-09-09-score-real-data-design.md)

## Global Constraints

- **`Not Scored` is never `0`.** Every points column is nullable. A `NOT_SCORED` row stores nulls, is excluded from every average, and renders as `—`. (Spec rule 1)
- **Averages are weighted.** `Not Scored` excluded; **Half Day** at 0.5 weight; everything else 1.0. An empty period averages to `null`, never `0`. (Spec rule 2)
- **A total may exceed 100** — the coordination bonus produces up to 110. No clamp, no check constraint, no meter that assumes a 100 ceiling. (Spec rule 3)
- **`organizationId` is always copied from the stored `User` row**, never read from a request body. (Spec rule 6)
- **The member read has no user-id parameter.** (Spec rule 8)
- **Scores are never computed in this application.** The rubric lives upstream.
- Tests: `npm test` (vitest, `fileParallelism: false`). Unit tests are `tests/<n>.test.ts`; database tests are `tests/<n>.integration.test.ts` and mock `@/lib/auth` via `vi.hoisted`.
- Migrations: `npm run migrate` (= `prisma migrate dev`).

**Phases.** Tasks 1–11 are leave-management and ship working software on their own — the board renders from payloads posted with `curl`. Tasks 12–15 are the Standup-Automation repo (`C:\Users\panis\Projects\Standup-Automation`), a different toolchain, and may be executed as a separate session. Do not start Phase 2 before Task 6 exists.

---

# Phase 1 — leave-management

### Task 1: The `ScoreDay` table

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<generated>/migration.sql` (written by Prisma)

**Interfaces:**
- Produces: `ScoreDay` model and `ScoreStatus` enum, importable as `import { ScoreStatus } from "@/generated/prisma/enums"`.

- [ ] **Step 1: Add the enum and model to `prisma/schema.prisma`**

Append after the `LeaveRequest` model. Copy the full block from spec §4 — it carries the comments that explain why every points column is nullable. The essentials:

```prisma
enum ScoreStatus {
  SCORED
  NOT_SCORED
}

model ScoreDay {
  id String @id @default(cuid())

  userId String
  user   User   @relation("ScoreSubject", fields: [userId], references: [id], onDelete: Cascade)

  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  date DateTime @db.Date

  status     ScoreStatus
  reason     String?
  attendance String

  checkinPts      Float?
  pickedPts       Float?
  descriptionPts  Float?
  commitPts       Float?
  commentPts      Float?
  deliveryPts     Float?
  coordinationPts Float?

  process  Float?
  delivery Float?
  total    Float?
  band     String?

  tasksPicked  Int?
  tasksDone    Int?
  tasksCredit  Float?
  volumeFactor Float?

  pickedTasks String[]
  flags       String[]

  computedAt DateTime
  receivedAt DateTime @default(now())

  @@unique([userId, date])
  @@index([organizationId, date])
}
```

- [ ] **Step 2: Add the two back-relations**

In `model User`, beside the existing `attendance` / `leaveRequests` relations:

```prisma
  scores ScoreDay[] @relation("ScoreSubject")
```

In `model Organization`, beside its other collections:

```prisma
  scores ScoreDay[]
```

- [ ] **Step 3: Generate the migration**

Run: `npm run migrate -- --name score_day`
Expected: a new folder under `prisma/migrations/`, and `generated/prisma` regenerated.

- [ ] **Step 4: Verify the client has the model**

Run: `npx tsc --noEmit`
Expected: exit 0. If `ScoreStatus` does not resolve, run `npm run prisma:generate`.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "Add the ScoreDay table"
```

---

### Task 2: The pure scoring rules — `lib/score.ts`

The averaging in Global Constraints is a re-implementation of `period_average` (`scorecard.py:697`) in another language. That is a drift risk, so it lives in one pure, unit-tested place — the split `lib/attendance.ts` / `lib/attendance-service.ts` already uses.

**Files:**
- Create: `lib/score.ts`
- Test: `tests/score.test.ts`

**Interfaces:**
- Produces: `ScoreDayRecord`, `MonthScoreSummary`, `CHECKS`, `weightOf`, `periodAverage`, `bandOf`, `summarizeMonth`.

- [ ] **Step 1: Write the failing test**

Create `tests/score.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  bandOf,
  periodAverage,
  summarizeMonth,
  weightOf,
  type ScoreDayRecord,
} from "@/lib/score";

/**
 * The aggregation rules, with no database in sight.
 *
 * These mirror `period_average` in the upstream pipeline's scorecard.py. The
 * cases below are the ones that make a score unfair if they drift: a not-scored
 * day must never be averaged as a zero, and a half day must count half.
 */

const day = (over: Partial<ScoreDayRecord> = {}): ScoreDayRecord => ({
  date: "2026-09-08",
  status: "SCORED",
  reason: null,
  attendance: "Present",
  points: {
    checkin: 10, picked: 5, description: 10,
    commit: 5, comment: 10, delivery: 60, coordination: 0,
  },
  process: 40,
  delivery: 60,
  total: 100,
  band: "Excellent",
  tasksPicked: 2,
  tasksDone: 2,
  pickedTasks: ["HIR-131"],
  flags: [],
  ...over,
});

const notScored = (reason: string, attendance = "Present"): ScoreDayRecord =>
  day({
    status: "NOT_SCORED",
    reason,
    attendance,
    points: {
      checkin: null, picked: null, description: null,
      commit: null, comment: null, delivery: null, coordination: null,
    },
    process: null, delivery: null, total: null, band: null,
    tasksPicked: null, tasksDone: null, pickedTasks: [], flags: [],
  });

describe("weightOf", () => {
  it("counts a half day as half", () => {
    expect(weightOf(day({ attendance: "Half Day" }))).toBe(0.5);
  });

  it("counts every other day in full", () => {
    expect(weightOf(day({ attendance: "Present" }))).toBe(1);
    expect(weightOf(day({ attendance: "Absent" }))).toBe(1);
  });
});

describe("periodAverage", () => {
  it("excludes Not Scored days rather than counting them as zero", () => {
    // Averaging the 100 with a zero would give 50. The not-scored day is a
    // broken integration, not a bad day, and must not appear as one.
    expect(periodAverage([day({ total: 100 }), notScored("jira: 503")])).toBe(100);
  });

  it("includes an absent day as a real zero", () => {
    expect(periodAverage([day({ total: 100 }), day({ attendance: "Absent", total: 0 })])).toBe(50);
  });

  it("weights a half day at one half", () => {
    // (100*1 + 40*0.5) / 1.5 = 80
    const half = day({ attendance: "Half Day", total: 40 });
    expect(periodAverage([day({ total: 100 }), half])).toBe(80);
  });

  it("returns null for a period with nothing scored, which is not zero", () => {
    expect(periodAverage([notScored("no roll-call posted for the day")])).toBeNull();
    expect(periodAverage([])).toBeNull();
  });

  it("does not clamp a coordination bonus above 100", () => {
    expect(periodAverage([day({ total: 110 })])).toBe(110);
  });
});

describe("bandOf", () => {
  it("bands by the upstream thresholds", () => {
    expect(bandOf(110)).toBe("Excellent");
    expect(bandOf(85)).toBe("Excellent");
    expect(bandOf(84.9)).toBe("On Track");
    expect(bandOf(70)).toBe("On Track");
    expect(bandOf(69.9)).toBe("Needs Attention");
    expect(bandOf(50)).toBe("Needs Attention");
    expect(bandOf(0)).toBe("At Risk");
  });
});

describe("summarizeMonth", () => {
  it("counts the days each way and averages each check", () => {
    const summary = summarizeMonth([
      day({ points: { ...day().points, description: 5 } }),
      day(),
      notScored("jira: 503"),
      day({ attendance: "Absent", total: 0, points: {
        checkin: 0, picked: 0, description: 0,
        commit: 0, comment: 0, delivery: 0, coordination: 0 } }),
    ]);

    expect(summary.daysScored).toBe(3);
    expect(summary.daysNotScored).toBe(1);
    expect(summary.daysAbsent).toBe(1);
    // (5 + 10 + 0) / 3
    expect(summary.checks.find((c) => c.key === "description")?.average).toBe(5);
  });

  it("counts the days a coordination bonus was earned", () => {
    const summary = summarizeMonth([
      day({ points: { ...day().points, coordination: 10 } }),
      day(),
    ]);
    expect(summary.coordinationDays).toBe(1);
  });

  it("reports a null average and no band when nothing was scored", () => {
    const summary = summarizeMonth([notScored("jira: 503")]);
    expect(summary.average).toBeNull();
    expect(summary.band).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/score.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/score"`.

- [ ] **Step 3: Write `lib/score.ts`**

```ts
import type { ScoreStatus } from "@/generated/prisma/enums";

/**
 * The score aggregation rules, with no database and no session in sight.
 *
 * This application never computes a score: the rubric lives in the
 * Standup-Automation pipeline's `scorecard.py` and arrives here already
 * decided. What this module holds is how a *period* is summarised from those
 * days, which the upstream system also does — in `period_average` — for its
 * own month tabs. Two implementations of one rule is a drift risk, so this one
 * is pure and pinned by tests rather than spread across the screens.
 *
 * The rule that matters most: `Not Scored` is not zero. A Jira outage, a Slack
 * failure and an unposted roll-call all produce it, and averaging any of them
 * as a zero turns a broken integration into somebody's poor performance.
 */

/** One day of score, as every read in this application sees it. */
export type ScoreDayRecord = {
  /** `YYYY-MM-DD`. */
  date: string;
  status: ScoreStatus;
  /** Why a day was not scored. Null when scored. */
  reason: string | null;
  /** The upstream label: Present | Half Day | Absent | Leave | Weekend | Holiday. */
  attendance: string;
  points: {
    checkin: number | null;
    picked: number | null;
    description: number | null;
    commit: number | null;
    comment: number | null;
    delivery: number | null;
    coordination: number | null;
  };
  process: number | null;
  delivery: number | null;
  /** 0–110. The coordination bonus sits on top of the hundred. */
  total: number | null;
  band: string | null;
  tasksPicked: number | null;
  tasksDone: number | null;
  pickedTasks: string[];
  flags: string[];
};

export type CheckAverage = {
  label: string;
  key: CheckKey;
  cap: number;
  /** Null when nothing in the period was scored. */
  average: number | null;
};

export type MonthScoreSummary = {
  average: number | null;
  band: string | null;
  checks: CheckAverage[];
  daysScored: number;
  daysNotScored: number;
  daysAbsent: number;
  tasksPicked: number;
  tasksDone: number;
  coordinationDays: number;
};

/**
 * The six checks, in the order every explanation of a score reads them out.
 *
 * One definition, mirroring the upstream constant at `scorecard.py:69`, which
 * exists there for the same reason: a cap that drifted between two places
 * would be a scoring bug that only showed up as a mismatched denominator.
 */
export const CHECKS = [
  { label: "Check-in", key: "checkin", cap: 10 },
  { label: "Task picked", key: "picked", cap: 5 },
  { label: "Jira description", key: "description", cap: 10 },
  { label: "Commit linked", key: "commit", cap: 5 },
  { label: "Jira comment", key: "comment", cap: 10 },
  { label: "Tasks done", key: "delivery", cap: 60 },
] as const;

export type CheckKey = (typeof CHECKS)[number]["key"];

/** ≥85 Excellent · ≥70 On Track · ≥50 Needs Attention · At Risk. */
const BANDS: readonly [number, string][] = [
  [85, "Excellent"],
  [70, "On Track"],
  [50, "Needs Attention"],
  [0, "At Risk"],
];

const round1 = (value: number): number => Math.round(value * 10) / 10;

/** How much a day counts toward an average: half days count half. */
export function weightOf(day: ScoreDayRecord): number {
  return day.attendance.toLowerCase().includes("half day") ? 0.5 : 1;
}

/** The days that carry a real number. Everything else is excluded, not zeroed. */
export function scoredDays(days: ScoreDayRecord[]): ScoreDayRecord[] {
  return days.filter((day) => day.status === "SCORED" && day.total !== null);
}

/**
 * Weighted mean total. Null when nothing in the period was scored — which is
 * not the same as an average of zero and must not be rendered as one.
 */
export function periodAverage(days: ScoreDayRecord[]): number | null {
  const scored = scoredDays(days);
  if (scored.length === 0) return null;

  const weight = scored.reduce((sum, day) => sum + weightOf(day), 0);
  if (weight <= 0) return null;

  const total = scored.reduce((sum, day) => sum + (day.total ?? 0) * weightOf(day), 0);
  return round1(total / weight);
}

export function bandOf(total: number): string {
  for (const [floor, name] of BANDS) {
    if (total >= floor) return name;
  }
  return BANDS[BANDS.length - 1][1];
}

/** The weighted average of one check across the scored days, or null. */
function checkAverage(days: ScoreDayRecord[], key: CheckKey): number | null {
  const scored = scoredDays(days).filter((day) => day.points[key] !== null);
  if (scored.length === 0) return null;

  const weight = scored.reduce((sum, day) => sum + weightOf(day), 0);
  if (weight <= 0) return null;

  const total = scored.reduce(
    (sum, day) => sum + (day.points[key] ?? 0) * weightOf(day),
    0,
  );
  return round1(total / weight);
}

export function summarizeMonth(days: ScoreDayRecord[]): MonthScoreSummary {
  const scored = scoredDays(days);
  const average = periodAverage(days);

  return {
    average,
    // No band without an average: "At Risk" for a month nobody scored would be
    // exactly the zero-for-null mistake this module exists to prevent.
    band: average === null ? null : bandOf(average),
    checks: CHECKS.map((check) => ({
      label: check.label,
      key: check.key,
      cap: check.cap,
      average: checkAverage(days, check.key),
    })),
    daysScored: scored.length,
    daysNotScored: days.filter((day) => day.status === "NOT_SCORED").length,
    daysAbsent: days.filter(
      (day) => day.attendance.toLowerCase() === "absent" && day.status === "SCORED",
    ).length,
    tasksPicked: scored.reduce((sum, day) => sum + (day.tasksPicked ?? 0), 0),
    tasksDone: scored.reduce((sum, day) => sum + (day.tasksDone ?? 0), 0),
    coordinationDays: scored.filter((day) => (day.points.coordination ?? 0) > 0).length,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/score.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/score.ts tests/score.test.ts
git commit -m "Add the pure score aggregation rules"
```

---

### Task 3: Two RBAC predicates

**Files:**
- Modify: `lib/rbac.ts`
- Test: `tests/rbac.test.ts`

**Interfaces:**
- Produces: `canReadOwnScores(actor)`, `canListScores(actor)`. Scoping still uses the existing `visibleOrgId(actor)`.

- [ ] **Step 1: Write the failing test**

Append to `tests/rbac.test.ts`. Match the actor helpers already in that file — if it builds actors with a local `actor()` helper, reuse it rather than adding another.

```ts
describe("canReadOwnScores", () => {
  it("lets a member read their own scores", () => {
    expect(canReadOwnScores({ id: "u1", role: Role.MEMBER, organizationId: "o1" })).toBe(true);
  });

  it("lets an admin read their own scores — an admin is a person who is scored", () => {
    expect(canReadOwnScores({ id: "a1", role: Role.ADMIN, organizationId: "o1" })).toBe(true);
  });

  it("refuses a SuperAdmin, who belongs to no organization and is never scored", () => {
    expect(canReadOwnScores({ id: "s1", role: Role.SUPERADMIN, organizationId: null })).toBe(false);
  });
});

describe("canListScores", () => {
  it("lets an admin list their organization's scores", () => {
    expect(canListScores({ id: "a1", role: Role.ADMIN, organizationId: "o1" })).toBe(true);
  });

  it("lets a SuperAdmin read, mirroring canListAttendance", () => {
    expect(canListScores({ id: "s1", role: Role.SUPERADMIN, organizationId: null })).toBe(true);
  });

  it("refuses a member", () => {
    expect(canListScores({ id: "u1", role: Role.MEMBER, organizationId: "o1" })).toBe(false);
  });
});
```

Add `canListScores, canReadOwnScores` to the existing `@/lib/rbac` import at the top of the file.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/rbac.test.ts`
Expected: FAIL — `canReadOwnScores is not a function`.

- [ ] **Step 3: Add the predicates to `lib/rbac.ts`**

Place them after `canListAttendance`, whose comment they refer to:

```ts
/**
 * Reading your own score board.
 *
 * An admin is included deliberately, on the same reasoning as
 * `canApplyForLeave`: an admin is a person, and the pipeline scores whoever is
 * on the Slack roll-call regardless of their role here. A SuperAdmin belongs to
 * no organization and appears in no roll-call, so there is nothing to read.
 *
 * There is no `userId` parameter: the subject of this read is the session, and
 * the service takes no id either, so a member has no way to name anybody else.
 */
export function canReadOwnScores(actor: Actor): boolean {
  return actor.role !== Role.SUPERADMIN && actor.organizationId !== null;
}

/**
 * Reading the whole organization's scores follows `canListAttendance`: a
 * SuperAdmin sees every organization, so they may read the scores inside one.
 * Scope the query with `visibleOrgId`.
 *
 * Nobody may *write* a score through a predicate — ingest is authenticated by a
 * bearer token and has no Actor at all. See lib/score-service.ts.
 */
export function canListScores(actor: Actor): boolean {
  return actor.role === Role.SUPERADMIN || actor.role === Role.ADMIN;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/rbac.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/rbac.ts tests/rbac.test.ts
git commit -m "Add the two score RBAC predicates"
```

---

### Task 4: Payload validation — `lib/score-input.ts`

Mirrors `lib/attendance-input.ts` and `lib/leave-input.ts`: parsing a request body is its own concern, separately testable, and never mixed into the service.

**Files:**
- Create: `lib/score-input.ts`
- Test: `tests/score-input.test.ts`

**Interfaces:**
- Produces: `type ScoreDayInput`, `parseScorePayload(body): ScoreDayInput[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/score-input.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseScorePayload } from "@/lib/score-input";
import { HttpError } from "@/lib/rbac";

const scored = {
  date: "2026-09-08",
  email: "Soma@Stacx24.com",
  status: "SCORED",
  attendance: "Present",
  points: { checkin: 10, picked: 5, description: 6.7, commit: 0, comment: 8.3, done: 60, coordination: 10 },
  process: 30, delivery: 60, total: 100, band: "Excellent",
  tasksPicked: 2, tasksDone: 2, tasksCredit: 2, volumeFactor: 1,
  pickedTasks: ["HIR-131", "BHA-158"],
  flags: ["coordinated"],
  computedAt: "2026-09-08T18:04:11",
};

describe("parseScorePayload", () => {
  it("reads a scored day and lower-cases the email", () => {
    const [day] = parseScorePayload({ days: [scored] });
    expect(day.email).toBe("soma@stacx24.com");
    expect(day.date).toBe("2026-09-08");
    expect(day.total).toBe(100);
    expect(day.pickedTasks).toEqual(["HIR-131", "BHA-158"]);
  });

  it("stores nulls, not zeros, for a day that was not scored", () => {
    const [day] = parseScorePayload({
      days: [{
        date: "2026-09-09", email: "soma@stacx24.com", status: "NOT_SCORED",
        attendance: "Unknown", reason: "no roll-call posted for the day",
        computedAt: "2026-09-09T02:00:00",
      }],
    });
    expect(day.status).toBe("NOT_SCORED");
    expect(day.total).toBeNull();
    expect(day.checkinPts).toBeNull();
    expect(day.reason).toBe("no roll-call posted for the day");
    expect(day.pickedTasks).toEqual([]);
  });

  it("accepts a total above 100 — the coordination bonus is real", () => {
    const [day] = parseScorePayload({ days: [{ ...scored, total: 110 }] });
    expect(day.total).toBe(110);
  });

  it("rejects a body with no days array", () => {
    expect(() => parseScorePayload({})).toThrow(HttpError);
  });

  it("rejects a day with no email", () => {
    const { email: _drop, ...rest } = scored;
    expect(() => parseScorePayload({ days: [rest] })).toThrow(/email/);
  });

  it("rejects a malformed date", () => {
    expect(() => parseScorePayload({ days: [{ ...scored, date: "08-09-2026" }] })).toThrow(/date/);
  });

  it("rejects an unknown status", () => {
    expect(() => parseScorePayload({ days: [{ ...scored, status: "MAYBE" }] })).toThrow(/status/);
  });

  it("rejects an empty batch, which is always a mistake in the caller", () => {
    expect(() => parseScorePayload({ days: [] })).toThrow(HttpError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/score-input.test.ts`
Expected: FAIL — cannot resolve `@/lib/score-input`.

- [ ] **Step 3: Write `lib/score-input.ts`**

```ts
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
 * A NOT_SCORED day has no numbers at all, and a zero would be indistinguishable
 * from a genuinely bad day.
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
  const day = record(raw, "Each entry in \"days\"");

  const email = String(day.email ?? "").trim().toLowerCase();
  if (!EMAIL.test(email)) throw new HttpError(400, `"email" must be an email address.`);

  const date = String(day.date ?? "").trim();
  if (!ISO_DATE.test(date)) throw new HttpError(400, `"date" must be YYYY-MM-DD.`);

  const status = String(day.status ?? "").toUpperCase();
  if (status !== ScoreStatus.SCORED && status !== ScoreStatus.NOT_SCORED) {
    throw new HttpError(400, `"status" must be SCORED or NOT_SCORED.`);
  }

  const computedRaw = String(day.computedAt ?? "");
  const computedAt = new Date(computedRaw);
  if (Number.isNaN(computedAt.getTime())) {
    throw new HttpError(400, `"computedAt" must be a timestamp.`);
  }

  // Absent for a NOT_SCORED day, and that is exactly right: every points
  // column below stays null rather than becoming zero.
  const points = day.points === undefined ? {} : record(day.points, `"points"`);

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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/score-input.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/score-input.ts tests/score-input.test.ts
git commit -m "Parse the scorecard ingest payload"
```

---

### Task 5: Ingest — `lib/score-service.ts`

**Files:**
- Create: `lib/score-service.ts`
- Test: `tests/score.integration.test.ts`

**Interfaces:**
- Consumes: `ScoreDayInput` (Task 4).
- Produces: `type IngestResult = { accepted: number; rejected: { email: string; reason: string }[] }`, `ingestScoreDays(days: ScoreDayInput[]): Promise<IngestResult>`.

- [ ] **Step 1: Write the failing test**

Create `tests/score.integration.test.ts`. Follow `tests/attendance.integration.test.ts` exactly for the auth mock and the per-run prefix:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Role, ScoreStatus } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

const { actorRef } = vi.hoisted(() => ({
  actorRef: { current: null as Actor | null },
}));

vi.mock("@/lib/auth", () => ({
  currentActor: async () => actorRef.current,
  auth: async () => null,
  handlers: { GET: () => new Response(), POST: () => new Response() },
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

const { prisma } = await import("@/lib/prisma");
const { ingestScoreDays } = await import("@/lib/score-service");

const RUN = `score-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

let orgId: string;
let memberId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `${RUN} Org` } });
  orgId = org.id;
  const member = await prisma.user.create({
    data: {
      name: "Soma", email: email("soma"), passwordHash: "x",
      role: Role.MEMBER, organizationId: orgId,
    },
  });
  memberId = member.id;
});

afterAll(async () => {
  await prisma.scoreDay.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

const input = (over: Record<string, unknown> = {}) => ({
  email: email("soma"),
  date: "2026-09-08",
  status: ScoreStatus.SCORED,
  reason: null,
  attendance: "Present",
  checkinPts: 10, pickedPts: 5, descriptionPts: 10,
  commitPts: 5, commentPts: 10, deliveryPts: 60, coordinationPts: 0,
  process: 40, delivery: 60, total: 100, band: "Excellent",
  tasksPicked: 2, tasksDone: 2, tasksCredit: 2, volumeFactor: 1,
  pickedTasks: ["HIR-131"], flags: [],
  computedAt: new Date("2026-09-08T18:04:11Z"),
  ...over,
});

describe("ingestScoreDays", () => {
  it("writes a day and copies the organization from the stored user", async () => {
    const result = await ingestScoreDays([input()]);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toEqual([]);

    const row = await prisma.scoreDay.findFirst({ where: { userId: memberId } });
    expect(row?.organizationId).toBe(orgId);
    expect(row?.total).toBe(100);
  });

  it("corrects a re-pushed day in place rather than duplicating it", async () => {
    await ingestScoreDays([input({ date: "2026-09-10", total: 70, band: "On Track" })]);
    await ingestScoreDays([input({ date: "2026-09-10", total: 90, band: "Excellent" })]);

    const rows = await prisma.scoreDay.findMany({
      where: { userId: memberId, date: new Date("2026-09-10") },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].total).toBe(90);
  });

  it("stores nulls for a day that was not scored, never zeros", async () => {
    await ingestScoreDays([input({
      date: "2026-09-11", status: ScoreStatus.NOT_SCORED,
      reason: "jira: 503", attendance: "Present",
      checkinPts: null, pickedPts: null, descriptionPts: null,
      commitPts: null, commentPts: null, deliveryPts: null, coordinationPts: null,
      process: null, delivery: null, total: null, band: null,
      tasksPicked: null, tasksDone: null, tasksCredit: null, volumeFactor: null,
      pickedTasks: [],
    })]);

    const row = await prisma.scoreDay.findFirst({
      where: { userId: memberId, date: new Date("2026-09-11") },
    });
    expect(row?.total).toBeNull();
    expect(row?.checkinPts).toBeNull();
    expect(row?.reason).toBe("jira: 503");
  });

  it("reports an unknown email and still accepts the rest of the batch", async () => {
    const result = await ingestScoreDays([
      input({ date: "2026-09-12" }),
      input({ date: "2026-09-12", email: email("nobody") }),
    ]);
    expect(result.accepted).toBe(1);
    expect(result.rejected).toEqual([
      { email: email("nobody"), reason: "no such user" },
    ]);
  });

  it("keeps a total above 100 — the coordination bonus is not clamped", async () => {
    await ingestScoreDays([input({ date: "2026-09-13", total: 110, coordinationPts: 10 })]);
    const row = await prisma.scoreDay.findFirst({
      where: { userId: memberId, date: new Date("2026-09-13") },
    });
    expect(row?.total).toBe(110);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/score.integration.test.ts`
Expected: FAIL — cannot resolve `@/lib/score-service`.

- [ ] **Step 3: Write the ingest half of `lib/score-service.ts`**

```ts
import { prisma } from "@/lib/prisma";
import type { ScoreDayInput } from "@/lib/score-input";

/**
 * Everything that reads or writes the score table.
 *
 * The same contract as lib/attendance-service.ts: every entry point comes
 * through here, so authorization is decided in exactly one place per operation.
 *
 * Ingest is the exception that proves it. It has no `Actor` and takes none:
 * the caller is the Standup-Automation pipeline holding a bearer token, not a
 * person, and handing it an Actor would let a machine credential flow into
 * functions written for a signed-in human.
 */

export type IngestResult = {
  accepted: number;
  rejected: { email: string; reason: string }[];
};

/**
 * Store a batch of scored days.
 *
 * Upserts on `(userId, date)` because the upstream recompute pass re-pushes the
 * trailing three days every night. That is what carries its self-correction —
 * which exists there *instead of* an appeals process — through to the screen,
 * with no correction workflow and no override button on this side.
 *
 * An email with no `User` is expected, not exceptional: not everyone in the
 * Slack roll-call is a member here. Those are collected and returned so the
 * pipeline can report them to its ops channel, rather than failing a batch that
 * is mostly good.
 */
export async function ingestScoreDays(days: ScoreDayInput[]): Promise<IngestResult> {
  const emails = [...new Set(days.map((day) => day.email))];
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true, organizationId: true },
  });
  const byEmail = new Map(users.map((user) => [user.email, user]));

  const rejected: IngestResult["rejected"] = [];
  let accepted = 0;

  for (const day of days) {
    const user = byEmail.get(day.email);
    if (!user) {
      rejected.push({ email: day.email, reason: "no such user" });
      continue;
    }
    // A SuperAdmin has no organization and cannot be scored. Rejecting rather
    // than defaulting keeps `organizationId` non-null without a fallback that
    // would file somebody's score under the wrong company.
    if (!user.organizationId) {
      rejected.push({ email: day.email, reason: "user belongs to no organization" });
      continue;
    }

    const { email: _email, date, ...rest } = day;
    const fields = { ...rest, organizationId: user.organizationId };

    await prisma.scoreDay.upsert({
      where: { userId_date: { userId: user.id, date: new Date(date) } },
      create: { userId: user.id, date: new Date(date), ...fields },
      update: fields,
    });
    accepted += 1;
  }

  return { accepted, rejected };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/score.integration.test.ts`
Expected: PASS, 5 tests. Requires the Docker Postgres the other integration tests use.

- [ ] **Step 5: Commit**

```bash
git add lib/score-service.ts tests/score.integration.test.ts
git commit -m "Ingest pushed score days, upserting by member and date"
```

---

### Task 6: The ingest route — `POST /api/scores`

**Files:**
- Create: `app/api/scores/route.ts`
- Modify: `tests/score.integration.test.ts` (append a describe block)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `parseScorePayload` (Task 4), `ingestScoreDays` (Task 5).
- Produces: `POST /api/scores`, authenticated by `Authorization: Bearer $SCORE_INGEST_TOKEN`.

- [ ] **Step 1: Write the failing test**

Append to `tests/score.integration.test.ts`:

```ts
describe("POST /api/scores", () => {
  const post = async (body: unknown, token: string | null) => {
    const { POST } = await import("@/app/api/scores/route");
    return POST(new Request("http://test/api/scores", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }));
  };

  const payload = {
    days: [{
      date: "2026-09-15", email: email("soma"), status: "SCORED",
      attendance: "Present",
      points: { checkin: 10, picked: 5, description: 10, commit: 5, comment: 10, done: 60, coordination: 0 },
      process: 40, delivery: 60, total: 100, band: "Excellent",
      tasksPicked: 1, tasksDone: 1, tasksCredit: 1, volumeFactor: 1,
      pickedTasks: ["HIR-1"], flags: [], computedAt: "2026-09-15T18:00:00Z",
    }],
  };

  it("accepts a batch with the right token", async () => {
    process.env.SCORE_INGEST_TOKEN = "test-token";
    const response = await post(payload, "test-token");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1, rejected: [] });
  });

  it("refuses a wrong token with 401", async () => {
    process.env.SCORE_INGEST_TOKEN = "test-token";
    expect((await post(payload, "wrong")).status).toBe(401);
  });

  it("refuses a missing Authorization header with 401", async () => {
    process.env.SCORE_INGEST_TOKEN = "test-token";
    expect((await post(payload, null)).status).toBe(401);
  });

  it("answers 503 when no token is configured, rather than matching an empty string", async () => {
    delete process.env.SCORE_INGEST_TOKEN;
    expect((await post(payload, "")).status).toBe(503);
  });

  it("refuses a malformed body with 400", async () => {
    process.env.SCORE_INGEST_TOKEN = "test-token";
    expect((await post({ days: "nope" }, "test-token")).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/score.integration.test.ts -t "POST /api/scores"`
Expected: FAIL — cannot resolve `@/app/api/scores/route`.

- [ ] **Step 3: Write `app/api/scores/route.ts`**

```ts
import { timingSafeEqual } from "node:crypto";

import { errorResponse, readJson } from "@/lib/api";
import { HttpError } from "@/lib/rbac";
import { parseScorePayload } from "@/lib/score-input";
import { ingestScoreDays } from "@/lib/score-service";

/**
 * Scorecard ingest — the one route in this application not authenticated by a
 * user session.
 *
 * The caller is the Standup-Automation pipeline, which holds a shared secret
 * rather than an account. It deliberately never becomes an `Actor`: a machine
 * credential must not be able to flow into the policy layer written for people.
 *
 * Partial success is the normal answer, not a degraded one. Not everybody in
 * the Slack roll-call is a member here, so unknown emails come back in
 * `rejected` while the rest of the batch is stored, and the pipeline reports
 * them to its own ops channel.
 */

/** Constant-time compare, so a wrong token cannot be found one byte at a time. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorize(request: Request): void {
  const expected = process.env.SCORE_INGEST_TOKEN;
  // An unset secret must not read as an empty-string match. Refusing the whole
  // route is the safe failure: a misconfigured deployment stops accepting
  // scores rather than accepting anybody's.
  if (!expected) throw new HttpError(503, "Score ingest is not configured.");

  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!presented || !tokenMatches(presented, expected)) {
    throw new HttpError(401, "Invalid ingest token.");
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    authorize(request);
    const days = parseScorePayload(await readJson(request));
    return Response.json(await ingestScoreDays(days));
  } catch (error) {
    return errorResponse(error);
  }
}
```

- [ ] **Step 4: Document the variable**

Append to `.env.example`:

```
# Shared secret the Standup-Automation scorecard pipeline presents when pushing
# daily scores to POST /api/scores. Unset means the route refuses everything
# with 503 — an empty value must never read as a match.
SCORE_INGEST_TOKEN=
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/score.integration.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Commit**

```bash
git add app/api/scores tests/score.integration.test.ts .env.example
git commit -m "Accept pushed scores on a token-authenticated route"
```

---

### Task 7: The reads — member and admin

**Files:**
- Modify: `lib/score-service.ts`
- Modify: `tests/score.integration.test.ts`

**Interfaces:**
- Consumes: `canReadOwnScores`, `canListScores`, `visibleOrgId` (Task 3); `ScoreDayRecord` (Task 2).
- Produces:
  - `listOwnScoreDays(actor, year, month): Promise<ScoreDayRecord[]>`
  - `listOrgScoreMonths(actor, year, month): Promise<MemberScoreMonth[]>` where `MemberScoreMonth = { id, name, title, initials, days }`
  - `findMemberScoreDays(actor, userId, year, month): Promise<{ member; days } | null>`

- [ ] **Step 1: Write the failing test**

Append to `tests/score.integration.test.ts`. Add a second member and an admin in `beforeAll` first:

```ts
describe("the reads", () => {
  it("gives a member their own month and takes no user id", async () => {
    actorRef.current = { id: memberId, role: Role.MEMBER, organizationId: orgId };
    const { listOwnScoreDays } = await import("@/lib/score-service");

    const days = await listOwnScoreDays(actorRef.current, 2026, 9);
    expect(days.length).toBeGreaterThan(0);
    expect(days.every((day) => day.date.startsWith("2026-09"))).toBe(true);
    // The signature is the guard: there is no parameter to put a colleague in.
    expect(listOwnScoreDays.length).toBe(3);
  });

  it("gives an admin every member of their own organization", async () => {
    const admin: Actor = { id: adminId, role: Role.ADMIN, organizationId: orgId };
    const { listOrgScoreMonths } = await import("@/lib/score-service");

    const roster = await listOrgScoreMonths(admin, 2026, 9);
    expect(roster.map((entry) => entry.name)).toContain("Soma");
  });

  it("refuses a member the organization-wide read", async () => {
    const member: Actor = { id: memberId, role: Role.MEMBER, organizationId: orgId };
    const { listOrgScoreMonths } = await import("@/lib/score-service");
    await expect(listOrgScoreMonths(member, 2026, 9)).rejects.toThrow(/403|permission|allowed/i);
  });

  it("returns null for a member outside the admin's organization", async () => {
    const outsider = await prisma.organization.create({ data: { name: `${RUN} Other` } });
    const stranger = await prisma.user.create({
      data: {
        name: "Stranger", email: email("stranger"), passwordHash: "x",
        role: Role.MEMBER, organizationId: outsider.id,
      },
    });
    const admin: Actor = { id: adminId, role: Role.ADMIN, organizationId: orgId };
    const { findMemberScoreDays } = await import("@/lib/score-service");

    expect(await findMemberScoreDays(admin, stranger.id, 2026, 9)).toBeNull();

    await prisma.user.delete({ where: { id: stranger.id } });
    await prisma.organization.delete({ where: { id: outsider.id } });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/score.integration.test.ts -t "the reads"`
Expected: FAIL — `listOwnScoreDays is not a function`.

- [ ] **Step 3: Add the reads to `lib/score-service.ts`**

```ts
import { EmploymentStatus, Role } from "@/generated/prisma/enums";
import { initialsFor } from "@/lib/domain";
import { monthBounds } from "@/lib/holidays";
import {
  type Actor,
  HttpError,
  canListScores,
  canReadOwnScores,
  visibleOrgId,
} from "@/lib/rbac";
import type { ScoreDayRecord } from "@/lib/score";

export type MemberScoreMonth = {
  id: string;
  name: string;
  title: string | null;
  initials: string;
  days: ScoreDayRecord[];
};

const DAY_FIELDS = {
  date: true, status: true, reason: true, attendance: true,
  checkinPts: true, pickedPts: true, descriptionPts: true,
  commitPts: true, commentPts: true, deliveryPts: true, coordinationPts: true,
  process: true, delivery: true, total: true, band: true,
  tasksPicked: true, tasksDone: true, pickedTasks: true, flags: true,
} as const;

type DayRow = { [K in keyof typeof DAY_FIELDS]: unknown } & {
  date: Date; status: ScoreDayRecord["status"];
};

/** The stored row, in the shape lib/score.ts reasons about. */
function toRecord(row: Record<string, unknown>): ScoreDayRecord {
  const value = (key: string) => (row[key] ?? null) as number | null;
  return {
    date: (row.date as Date).toISOString().slice(0, 10),
    status: row.status as ScoreDayRecord["status"],
    reason: (row.reason ?? null) as string | null,
    attendance: row.attendance as string,
    points: {
      checkin: value("checkinPts"),
      picked: value("pickedPts"),
      description: value("descriptionPts"),
      commit: value("commitPts"),
      comment: value("commentPts"),
      delivery: value("deliveryPts"),
      coordination: value("coordinationPts"),
    },
    process: value("process"),
    delivery: value("delivery"),
    total: value("total"),
    band: (row.band ?? null) as string | null,
    tasksPicked: value("tasksPicked"),
    tasksDone: value("tasksDone"),
    pickedTasks: (row.pickedTasks ?? []) as string[],
    flags: (row.flags ?? []) as string[],
  };
}

function monthRange(year: number, month: number): { gte: Date; lte: Date } {
  const { from, to } = monthBounds(year, month);
  return { gte: new Date(from), lte: new Date(to) };
}

/**
 * The caller's own month.
 *
 * There is no `userId` parameter, the same contract `listOwnLeaveRequests`
 * holds: the subject is the session, so there is nothing in the URL for a
 * member to change into a colleague's.
 */
export async function listOwnScoreDays(
  actor: Actor,
  year: number,
  month: number,
): Promise<ScoreDayRecord[]> {
  if (!canReadOwnScores(actor)) {
    throw new HttpError(403, "You do not have a score board.");
  }

  const rows = await prisma.scoreDay.findMany({
    where: { userId: actor.id, date: monthRange(year, month) },
    select: DAY_FIELDS,
    orderBy: { date: "asc" },
  });
  return rows.map((row) => toRecord(row as Record<string, unknown>));
}

/** Every member of the actor's organization, with their month. */
export async function listOrgScoreMonths(
  actor: Actor,
  year: number,
  month: number,
): Promise<MemberScoreMonth[]> {
  if (!canListScores(actor)) {
    throw new HttpError(403, "You are not allowed to read scores.");
  }
  const organizationId = visibleOrgId(actor);

  const members = await prisma.user.findMany({
    where: {
      role: Role.MEMBER,
      status: EmploymentStatus.ACTIVE,
      ...(organizationId ? { organizationId } : {}),
    },
    select: {
      id: true, name: true, title: true,
      scores: {
        where: { date: monthRange(year, month) },
        select: DAY_FIELDS,
        orderBy: { date: "asc" },
      },
    },
    orderBy: { name: "asc" },
  });

  return members.map((member) => ({
    id: member.id,
    name: member.name,
    title: member.title,
    initials: initialsFor(member.name),
    days: member.scores.map((row) => toRecord(row as Record<string, unknown>)),
  }));
}

/**
 * One member's month, for the admin drill-down.
 *
 * Scoped by organization *inside* the query rather than fetched and then
 * checked, so a member in another organization returns null down the same path
 * a nonexistent id does.
 */
export async function findMemberScoreDays(
  actor: Actor,
  userId: string,
  year: number,
  month: number,
): Promise<{ member: MemberScoreMonth } | null> {
  if (!canListScores(actor)) {
    throw new HttpError(403, "You are not allowed to read scores.");
  }
  const organizationId = visibleOrgId(actor);

  const member = await prisma.user.findFirst({
    where: { id: userId, ...(organizationId ? { organizationId } : {}) },
    select: {
      id: true, name: true, title: true,
      scores: {
        where: { date: monthRange(year, month) },
        select: DAY_FIELDS,
        orderBy: { date: "asc" },
      },
    },
  });
  if (!member) return null;

  return {
    member: {
      id: member.id,
      name: member.name,
      title: member.title,
      initials: initialsFor(member.name),
      days: member.scores.map((row) => toRecord(row as Record<string, unknown>)),
    },
  };
}
```

If `initialsFor` is not exported from `lib/domain.ts`, check its real name there first — `app/(member)/layout.tsx` derives initials inline, and the `User` model comment says *"`initials` is deliberately absent: it is derived from `name` by `initialsFor()` in lib/domain.ts"*.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/score.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/score-service.ts tests/score.integration.test.ts
git commit -m "Read scores, self-scoped for a member and org-scoped for an admin"
```

---

### Task 8: `Meter` accessibility and a day-scaled bar chart

Fixes defects C5 and C8. Both screens use these components, so they change once.

**Files:**
- Modify: `components/ui.tsx:108-118`
- Create: `components/score-chart.tsx`

**Interfaces:**
- Produces: `<ScoreChart days={ScoreDayRecord[]} height={number} />`.

- [ ] **Step 1: Give `Meter` a meter role**

Replace the body of `Meter` in `components/ui.tsx`:

```tsx
export function Meter({
  percent,
  label,
}: {
  percent: number;
  /** What the meter is measuring, for a screen reader. */
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <span
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className="block h-[5px] overflow-hidden rounded bg-line"
    >
      <span
        className="block h-[5px] rounded bg-brand"
        style={{ width: `${clamped}%` }}
      />
    </span>
  );
}
```

- [ ] **Step 2: Create `components/score-chart.tsx`**

```tsx
import Link from "next/link";

import type { ScoreDayRecord } from "@/lib/score";

/**
 * A bar per scored day of the month.
 *
 * Two things the fixture chart got wrong and this does not:
 *
 * Bars scale against the highest total actually in the month, not a fixed
 * ceiling. The old chart mapped 100 to 56px, so a real 82-to-88 spread rendered
 * as three pixels and every bar looked the same height.
 *
 * A day that was not scored renders as a gap with no bar at all. Drawing it as
 * a zero-height bar would say the person scored nothing, which is the one thing
 * `Not Scored` must never be mistaken for.
 */
export function ScoreChart({
  days,
  height = 96,
  hrefFor,
}: {
  days: ScoreDayRecord[];
  height?: number;
  /** When given, each bar links to its own day's breakdown. */
  hrefFor?: (date: string) => string;
}) {
  const totals = days
    .filter((day) => day.status === "SCORED" && day.total !== null)
    .map((day) => day.total as number);

  if (totals.length === 0) {
    return (
      <span className="flex items-center justify-center text-xs text-muted" style={{ height }}>
        Nothing scored this month yet.
      </span>
    );
  }

  // Never below 100, so an ordinary month is not stretched to look dramatic,
  // and never below the observed max, so a 110 still fits.
  const ceiling = Math.max(100, ...totals);
  const barMax = height - 28;

  return (
    <span className="flex items-end gap-1" style={{ height }}>
      {days.map((day) => {
        const scored = day.status === "SCORED" && day.total !== null;
        const dayOfMonth = Number(day.date.slice(8));
        const Bar = hrefFor ? Link : "span";
        return (
          <Bar
            key={day.date}
            {...(hrefFor ? { href: hrefFor(day.date) } : {})}
            className="flex flex-1 flex-col items-center justify-end gap-1.5 no-underline"
            title={
              scored
                ? `${day.date} — ${day.total} / 100`
                : `${day.date} — not scored: ${day.reason ?? "unknown"}`
            }
          >
            {scored ? (
              <span
                className="w-full rounded-t-md rounded-b-sm bg-accent"
                style={{ height: Math.max(3, ((day.total as number) / ceiling) * barMax) }}
              />
            ) : (
              <span className="w-full border-b border-dashed border-line" />
            )}
            <span className="text-[10px] text-muted">{dayOfMonth}</span>
          </Bar>
        );
      })}
    </span>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add components/ui.tsx components/score-chart.tsx
git commit -m "Announce the meter, and scale score bars to the month"
```

---

### Task 9: The member screen — `/score`

**Files:**
- Modify: `app/(member)/score/page.tsx` (full rewrite)

**Interfaces:**
- Consumes: `requirePageActor`, `listOwnScoreDays`, `summarizeMonth`, `ScoreChart`.
- Produces: `<ScoreDayPanel day={ScoreDayRecord} />`, reused by `/scores` in Task 10.

- [ ] **Step 1: Create the day breakdown panel**

Create `components/score-day-panel.tsx`. This is the answer to "which check cost me the points", and it is the reason the per-check columns are stored at all:

```tsx
import { CHECKS, type ScoreDayRecord } from "@/lib/score";

/**
 * One day, check by check.
 *
 * The six lines are the whole rubric, so a person can see where a score came
 * from without opening a spreadsheet. Per-task evidence — which ticket passed
 * which check, with Jira links — is deliberately not here: it lives in the
 * pipeline's Slack DM, and putting it on this panel would turn a readable
 * breakdown into a wall (SCORING.md section 8.3 makes the same call).
 *
 * A day that was not scored says so instead of printing six zeros. That
 * distinction is the whole point of storing nulls.
 */
export function ScoreDayPanel({ day }: { day: ScoreDayRecord }) {
  if (day.status !== "SCORED") {
    return (
      <span className="flex flex-col gap-1.5 py-2">
        <span className="text-sm font-semibold">{day.date}</span>
        <span className="text-[13px] text-muted">
          Not scored — {day.reason ?? "reason not recorded"}. This day is left out
          of the month average.
        </span>
      </span>
    );
  }

  return (
    <span className="flex flex-col gap-2.5 py-1">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold">{day.date}</span>
        <span className="text-[13px] text-muted">
          {day.total} / 100 · {day.band}
        </span>
      </span>

      {CHECKS.map((check) => (
        <span key={check.key} className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-ink-2">{check.label}</span>
          <span className="font-mono text-[13px]">
            {day.points[check.key] ?? "—"}
            <span className="text-muted"> / {check.cap}</span>
          </span>
        </span>
      ))}

      {(day.points.coordination ?? 0) > 0 ? (
        <span className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-ink-2">Coordination bonus</span>
          <span className="font-mono text-[13px]">+{day.points.coordination}</span>
        </span>
      ) : null}

      {day.pickedTasks.length > 0 ? (
        <span className="flex flex-wrap gap-1.5 border-t border-line pt-2.5">
          {day.pickedTasks.map((key) => (
            <span key={key} className="rounded bg-subtle px-2 py-0.5 font-mono text-[12px]">
              {key}
            </span>
          ))}
        </span>
      ) : (
        <span className="border-t border-line pt-2.5 text-[12.5px] text-muted">
          No ticket was named in the stand-up that day.
        </span>
      )}
    </span>
  );
}
```

- [ ] **Step 2: Rewrite the page**

```tsx
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { ScoreChart } from "@/components/score-chart";
import { ScoreDayPanel } from "@/components/score-day-panel";
import { Card, EmptyPanel, Meter, MonoLabel } from "@/components/ui";
import { MONTH_NAMES, shiftMonth } from "@/lib/date";
import { requirePageActor } from "@/lib/page-guards";
import { summarizeMonth } from "@/lib/score";
import { listOwnScoreDays } from "@/lib/score-service";

/**
 * Member: my own performance score, month by month.
 *
 * Self-scoped like /calendar and /requests: `listOwnScoreDays` takes no user id
 * at all — the subject is the session — so there is no id in the URL for a
 * member to change into a colleague's.
 *
 * Nothing here computes a score. The rubric lives in the Standup-Automation
 * pipeline and arrives already decided; this screen only summarises a month of
 * it. `Not Scored` days are shown as such and excluded from the average, never
 * folded into it as zeros.
 */
export default async function ScorePage({
  searchParams,
}: {
  searchParams: Promise<{ y?: string; m?: string; d?: string }>;
}) {
  const actor = await requirePageActor();
  const params = await searchParams;

  const now = new Date();
  const year = Number(params.y) || now.getFullYear();
  const month = Number(params.m) || now.getMonth() + 1;

  const days = await listOwnScoreDays(actor, year, month);
  const summary = summarizeMonth(days);

  // The day whose breakdown is open. Defaults to the latest day in the month
  // that has a row, so the panel is never empty on arrival.
  const selected =
    days.find((day) => day.date === params.d) ?? days[days.length - 1] ?? null;

  const monthHref = (delta: number) => {
    const next = shiftMonth(year, month, delta);
    return `/score?y=${next.year}&m=${next.month}`;
  };

  return (
    <>
      <PageHeader
        title="My score board"
        subtitle="How your stand-ups and Jira tickets scored, day by day."
        meta="MEMBER VIEW"
      />

      <div className="flex max-w-[940px] flex-col gap-5">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold">
            {MONTH_NAMES[month]} {year}
          </span>
          <Link href={monthHref(-1)} aria-label="Previous month" className="text-sm text-muted no-underline hover:text-ink">
            ←
          </Link>
          <Link href={monthHref(1)} aria-label="Next month" className="text-sm text-muted no-underline hover:text-ink">
            →
          </Link>
        </div>

        {summary.average === null ? (
          <EmptyPanel className="py-18">
            No score has been recorded for you this month.
          </EmptyPanel>
        ) : (
          <>
            <div className="grid items-stretch gap-5 lg:grid-cols-[280px_1fr]">
              <Card className="flex flex-col gap-3.5 p-6">
                <MonoLabel>MONTH AVERAGE</MonoLabel>
                <span className="flex items-baseline gap-2">
                  <span className="text-[64px] leading-none font-semibold tracking-[-0.03em]">
                    {summary.average}
                  </span>
                  <span className="text-sm text-muted">/ 100</span>
                </span>
                <span className="self-start rounded-full bg-brand-tint px-3 py-[5px] text-[13px] text-brand-dark">
                  {summary.band}
                </span>
                <span className="mt-auto text-xs leading-relaxed text-muted">
                  {summary.daysScored} day{summary.daysScored === 1 ? "" : "s"} scored
                  {summary.daysNotScored > 0
                    ? `, ${summary.daysNotScored} not scored and left out of the average`
                    : ""}
                  .
                </span>
              </Card>

              <Card className="grid gap-5 p-5.5 sm:grid-cols-2">
                {summary.checks.map((check) => (
                  <div key={check.key} className="flex flex-col gap-2.5">
                    <span className="flex items-baseline justify-between gap-2.5">
                      <span className="text-[13px] text-muted">{check.label}</span>
                      <span className="text-[19px] font-semibold tracking-[-0.015em]">
                        {check.average === null ? "—" : check.average}
                        <span className="text-sm text-muted"> / {check.cap}</span>
                      </span>
                    </span>
                    <Meter
                      percent={check.average === null ? 0 : (check.average / check.cap) * 100}
                      label={check.label}
                    />
                  </div>
                ))}
              </Card>
            </div>

            <div className="grid items-start gap-5 lg:grid-cols-2">
              <Card className="flex flex-col gap-4.5 p-5.5">
                <MonoLabel>BY DAY</MonoLabel>
                <ScoreChart
                  days={days}
                  hrefFor={(date) => `/score?y=${year}&m=${month}&d=${date}`}
                />
              </Card>

              <Card className="flex flex-col px-5.5 pt-1.5 pb-3">
                {[
                  ["Days scored", summary.daysScored],
                  ["Not scored", summary.daysNotScored],
                  ["Tasks picked", summary.tasksPicked],
                  ["Tasks done", summary.tasksDone],
                  ["Coordination days", summary.coordinationDays],
                  ["Absent", summary.daysAbsent],
                ].map(([label, value]) => (
                  <span
                    key={String(label)}
                    className="flex items-center justify-between gap-3 border-b border-line py-2.5 last:border-b-0"
                  >
                    <span className="text-[13.5px] text-ink-2">{label}</span>
                    <span className="font-mono text-[13.5px] font-semibold">{value}</span>
                  </span>
                ))}
              </Card>
            </div>

            {selected ? (
              <Card className="px-5.5 py-4">
                <MonoLabel>THAT DAY</MonoLabel>
                <ScoreDayPanel day={selected} />
              </Card>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
```

The chart's `hrefFor` prop is what makes a bar open its day in the panel below.

- [ ] **Step 3: Check `MONTH_NAMES` and `shiftMonth` exist**

Run: `grep -n "MONTH_NAMES\|shiftMonth" lib/date.ts`
Expected: both exported. `app/(member)/calendar/page.tsx` already imports them; match whatever that file does.

- [ ] **Step 4: Typecheck and view it**

Run: `npx tsc --noEmit`, then `npm run dev` and open `http://localhost:3000/score`.
Expected: with no rows, the empty panel. Post a day with `curl` (Task 6's payload) and reload — the board fills in, and clicking a bar opens that day's breakdown.

- [ ] **Step 5: Commit**

```bash
git add "app/(member)/score/page.tsx" components/score-day-panel.tsx
git commit -m "Put the member score board on real data"
```

---

### Task 10: The admin screen — `/scores`

**Files:**
- Modify: `app/(leave)/scores/page.tsx`

- [ ] **Step 1: Replace the fixture reads**

Keep the existing two-column layout and the `?u=` selection. Three changes:

```tsx
import { requirePageRole } from "@/lib/page-guards";
import { summarizeMonth } from "@/lib/score";
import { findMemberScoreDays, listOrgScoreMonths } from "@/lib/score-service";
```

```tsx
const actor = await requirePageRole(Role.ADMIN);
const params = await searchParams;
const year = Number(params.y) || new Date().getFullYear();
const month = Number(params.m) || new Date().getMonth() + 1;

const roster = await listOrgScoreMonths(actor, year, month);
const selected = params.u ? await findMemberScoreDays(actor, params.u, year, month) : null;
```

In the roster list, replace `SCORES[person.id]?.total ?? "—"` with the member's month average:

```tsx
{summarizeMonth(person.days).average ?? "—"}
```

In the detail panel, replace every `card?.…` with the same `summarizeMonth(selected.member.days)` summary and the `ScoreChart`, mirroring Task 9's panels, and add the same day breakdown below it:

```tsx
<ScoreChart
  days={selected.member.days}
  hrefFor={(date) => `/scores?u=${selected.member.id}&y=${year}&m=${month}&d=${date}`}
/>
```

```tsx
{(() => {
  const day =
    selected.member.days.find((entry) => entry.date === params.d) ??
    selected.member.days[selected.member.days.length - 1];
  return day ? (
    <Card className="px-5.5 py-4">
      <MonoLabel>THAT DAY</MonoLabel>
      <ScoreDayPanel day={day} />
    </Card>
  ) : null;
})()}
```

Add `d?: string` to this page's `searchParams` type. Delete the `SCORES`, `seedDb`, `roster`, `personById` and `DemoBanner` imports.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Verify both roles in the browser**

Sign in as an admin, open `/scores`, click a member. Sign in as a member, confirm `/scores` redirects to `/overview` and `/score` shows only their own month.

- [ ] **Step 4: Commit**

```bash
git add "app/(leave)/scores/page.tsx"
git commit -m "Put the admin score board on real data"
```

---

### Task 11: Delete the fixtures

**Files:**
- Modify: `lib/seed.ts`

- [ ] **Step 1: Confirm nothing else reads them**

Run: `grep -rn "MY_SCORE\|SCORES\b" --include="*.ts" --include="*.tsx" . | grep -v node_modules | grep -v .next`
Expected: no hits outside `lib/seed.ts`.

- [ ] **Step 2: Delete `MY_SCORE` and `SCORES` from `lib/seed.ts`**

Remove both exports and any now-unused types they referenced.

- [ ] **Step 3: Full suite and typecheck**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add lib/seed.ts
git commit -m "Delete the score fixtures"
```

---

# Phase 2 — Standup-Automation

Repo: `C:\Users\panis\Projects\Standup-Automation`. Tests: `.venv/Scripts/python.exe -m pytest`.

Everything here is additive and inert until `SCORE_PUSH_URL` is set, so it can ship before the endpoint is switched on. **No scoring rule, weight, threshold or existing output sink changes.**

### Task 12: Email on the Master roster

**Files:**
- Modify: `build_scorecard.py`
- Test: `tests/test_scorecard_agent.py`

**Interfaces:**
- Produces: `roster_emails(sh) -> dict[str, str]`, short name → email.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_scorecard_agent.py`, following the `_FakeSheet` pattern in `tests/test_master_roster.py`:

```python
class _FakeMaster:
    """The slice of a gspread Spreadsheet that roster_emails() touches."""

    def __init__(self, rows):
        self._rows = rows

    def worksheet(self, title):
        assert title == "Master"
        return self

    def get_all_values(self):
        return self._rows


MASTER_WITH_EMAIL = [
    ["Name", "Employee ID", "Designation", "Gross Salary", "Date of Joining", "Email"],
    ["Kevin", "1234", "Engineer", "50000", "", "kevin@stacx24.com"],
    ["Soma", "9999", "Engineer", "50000", "", "Soma@Stacx24.com"],
    ["Gokul", "", "", "", "03-Aug-2026", ""],
]


def test_roster_emails_reads_the_appended_column():
    emails = bs.roster_emails(_FakeMaster(MASTER_WITH_EMAIL))
    assert emails["Kevin"] == "kevin@stacx24.com"


def test_roster_emails_lower_cases_so_the_join_cannot_miss_on_case():
    emails = bs.roster_emails(_FakeMaster(MASTER_WITH_EMAIL))
    assert emails["Soma"] == "soma@stacx24.com"


def test_roster_emails_omits_a_developer_with_no_email():
    # Omitted, not blank: an empty string would be pushed and rejected, turning
    # a roster gap into a nightly ops alert.
    assert "Gokul" not in bs.roster_emails(_FakeMaster(MASTER_WITH_EMAIL))


def test_roster_emails_survives_a_sheet_that_has_no_email_column_yet():
    narrow = [row[:5] for row in MASTER_WITH_EMAIL]
    assert bs.roster_emails(_FakeMaster(narrow)) == {}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/test_scorecard_agent.py -k roster_emails -q`
Expected: FAIL — `module 'build_scorecard' has no attribute 'roster_emails'`.

- [ ] **Step 3: Add `roster_emails` to `build_scorecard.py`**

Place it beside the other sheet helpers:

```python
# Column 5 of the Master tab, appended after Date of Joining. read_master()
# in build_salary_slips.py reads columns 0-3 positionally and ignores anything
# past them, which tests/test_master_roster.py already pins — the same reason
# Date of Joining could be appended safely.
MASTER_EMAIL_COL = 5


def roster_emails(sh) -> dict[str, str]:
    """{short name: email} from the Master tab, for the scorecard push.

    A developer with no email is omitted rather than carried as a blank: a blank
    would be pushed, rejected by the endpoint, and reported to ops every night
    for a roster gap that is not a failure.
    """
    rows = sh.worksheet("Master").get_all_values()
    out: dict[str, str] = {}
    for row in rows[1:]:
        if not row or not row[0].strip():
            continue
        if len(row) <= MASTER_EMAIL_COL:
            continue
        email = row[MASTER_EMAIL_COL].strip().lower()
        if email:
            out[row[0].strip()] = email
    return out
```

- [ ] **Step 4: Run the tests**

Run: `.venv/Scripts/python.exe -m pytest tests/test_scorecard_agent.py -q`
Expected: PASS.

- [ ] **Step 5: Add the column to the live sheet**

Add `Email` as the header of column F on the `Master` tab and fill in each developer's leave-management login email. This is a manual data step — the code above tolerates it being missing or partly filled.

- [ ] **Step 6: Commit**

```bash
git add build_scorecard.py tests/test_scorecard_agent.py
git commit -m "Read developer emails from the Master roster"
```

---

### Task 13: `compose_payload` — pure

**Files:**
- Modify: `src/standup_summarizer/scorecard.py`
- Test: `tests/test_scorecard.py`

**Interfaces:**
- Produces: `compose_payload(records: list[dict], emails: dict[str, str]) -> dict`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_scorecard.py`, reusing whatever record-building helper the file already has:

```python
def test_compose_payload_sends_a_scored_day_with_its_points():
    record = sc.score_day(_facts(), sc.Weights(), sc.Thresholds(),
                          computed_at=dt.datetime(2026, 9, 8, 18, 4, 11))
    payload = sc.compose_payload([record], {"Soma": "soma@stacx24.com"})

    assert payload["source"] == "standup-automation"
    day = payload["days"][0]
    assert day["email"] == "soma@stacx24.com"
    assert day["status"] == "SCORED"
    assert day["points"]["checkin"] == 10.0


def test_compose_payload_omits_the_numbers_for_a_not_scored_day():
    # The endpoint stores absent as null. Sending zeros would make a broken
    # Jira indistinguishable from a bad day — SCORING.md section 7.
    record = sc.score_day(_facts(data_ok=False, data_error="jira: 503"),
                          sc.Weights(), sc.Thresholds(),
                          computed_at=dt.datetime(2026, 9, 8, 18, 4, 11))
    day = sc.compose_payload([record], {"Soma": "soma@stacx24.com"})["days"][0]

    assert day["status"] == "NOT_SCORED"
    assert day["reason"] == "jira: 503"
    assert "points" not in day
    assert "total" not in day


def test_compose_payload_skips_a_developer_with_no_email():
    record = sc.score_day(_facts(), sc.Weights(), sc.Thresholds(),
                          computed_at=dt.datetime(2026, 9, 8, 18, 4, 11))
    assert sc.compose_payload([record], {})["days"] == []


def test_compose_payload_keeps_a_total_above_one_hundred():
    record = sc.score_day(_facts(coordinated=True), sc.Weights(), sc.Thresholds(),
                          computed_at=dt.datetime(2026, 9, 8, 18, 4, 11))
    day = sc.compose_payload([record], {"Soma": "soma@stacx24.com"})["days"][0]
    assert day["total"] > 100
```

Adjust `_facts()` to whatever the file's existing `DayFacts` helper is called, and make sure it names the developer `Soma`.

- [ ] **Step 2: Run it to verify it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/test_scorecard.py -k compose_payload -q`
Expected: FAIL — `module has no attribute 'compose_payload'`.

- [ ] **Step 3: Add `compose_payload` to `scorecard.py`**

Place it in the "Sheet surfaces" section, beside `daily_row`:

```python
def compose_payload(records: list[dict], emails: dict[str, str]) -> dict:
    """The scored days, as the leave-management ingest endpoint wants them.

    Composition only — no I/O, so this stays inside the pure module and is
    testable against literal records (SCORECARD_API.md).

    A `Not Scored` day carries no numbers at all rather than zeros. The endpoint
    stores absent as null, which is what keeps a broken integration from
    reading as somebody's poor performance (SCORING.md section 7).

    A developer with no email on the Master roster is skipped: they have no
    account on the other side, and sending a blank would only produce a nightly
    rejection for a roster gap.
    """
    days = []
    for record in records:
        email = emails.get(record["developer"])
        if not email:
            continue

        day = {
            "date": record["date"],
            "email": email,
            "status": "SCORED" if record["status"] == SCORED else "NOT_SCORED",
            "attendance": record.get("attendance", ""),
            "computedAt": record["computed_at"],
        }
        if record["status"] != SCORED:
            day["reason"] = record.get("reason", "")
            days.append(day)
            continue

        points = record["points"]
        day.update({
            "points": {
                "checkin": points["checkin"], "picked": points["picked"],
                "description": points["description"], "commit": points["commit"],
                "comment": points["comment"], "done": points["done"],
                "coordination": points.get("coordination", 0.0),
            },
            "process": record["process"],
            "delivery": record["delivery"],
            "total": record["total"],
            "band": record["band"],
            "tasksPicked": record["evidence"]["picked"]["count"],
            "tasksDone": record["tasks_done"],
            "tasksCredit": record["tasks_credit"],
            "volumeFactor": record["volume_factor"],
            "pickedTasks": [task["key"] for task in record["evidence"]["tasks"]],
            "flags": record["flags"],
        })
        days.append(day)

    return {"source": "standup-automation", "days": days}
```

Check the exact key names against `_base()` and `daily_row()` in the same file — `date` and `computed_at` must be strings by the time they are composed. If `_base` stores them as objects, call `.isoformat()` here.

- [ ] **Step 4: Run the tests**

Run: `.venv/Scripts/python.exe -m pytest tests/test_scorecard.py -q`
Expected: PASS, all existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/standup_summarizer/scorecard.py tests/test_scorecard.py
git commit -m "Compose the scorecard push payload"
```

---

### Task 14: The push, and its containment

**Files:**
- Modify: `src/standup_summarizer/config.py`
- Modify: `build_scorecard.py`
- Modify: `.env.example`
- Test: `tests/test_scorecard_agent.py`

**Interfaces:**
- Consumes: `roster_emails` (Task 12), `compose_payload` (Task 13).
- Produces: `push_scores(score_cfg, payload) -> tuple[int, list[dict]] | None`; `ScoreConfig.push_url`, `ScoreConfig.push_token`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_scorecard_agent.py`:

```python
def test_push_is_skipped_when_no_url_is_configured(monkeypatch):
    monkeypatch.delenv("SCORE_PUSH_URL", raising=False)
    cfg = ScoreConfig.from_env()
    assert cfg.push_url == ""
    assert bs.push_scores(cfg, {"days": []}) is None


def test_push_failure_does_not_raise(monkeypatch, capsys):
    """An export must not be able to take down the scoring of everybody's work.

    The same rule SCORING.md section 4.7 already states for a coordination
    channel the bot cannot read.
    """
    def boom(*args, **kwargs):
        raise RuntimeError("connection refused")

    monkeypatch.setattr(bs.requests, "post", boom)
    cfg = ScoreConfig.from_env().__class__(
        **{**ScoreConfig.from_env().__dict__, "push_url": "http://x/api/scores",
           "push_token": "t"})

    assert bs.push_scores(cfg, {"days": [{"email": "a@b.c"}]}) is None
    assert "push failed" in capsys.readouterr().out
```

- [ ] **Step 2: Run it to verify it fails**

Run: `.venv/Scripts/python.exe -m pytest tests/test_scorecard_agent.py -k push -q`
Expected: FAIL — no `push_url` on `ScoreConfig`.

- [ ] **Step 3: Add the config**

In `src/standup_summarizer/config.py`, on `ScoreConfig`:

```python
    push_url: str = ""
    """Where to POST each day's scores — the leave-management ingest endpoint.
    Empty disables the push entirely, the same way an empty SCORE_COORDINATION
    disables that check."""
    push_token: str = ""
    """The bearer token that endpoint expects."""
```

and in `from_env()`'s `return cls(...)`:

```python
            push_url=os.environ.get("SCORE_PUSH_URL", "").strip(),
            push_token=os.environ.get("SCORE_PUSH_TOKEN", "").strip(),
```

- [ ] **Step 4: Add `push_scores` to `build_scorecard.py`**

Add `import requests` at the top with the other third-party imports, then:

```python
def push_scores(score_cfg: ScoreConfig, payload: dict) -> tuple[int, list[dict]] | None:
    """POST the day's scores to leave-management. None when not configured.

    Never raises. A failed export costs the export and nothing else — the same
    rule SCORING.md section 4.7 sets for a coordination channel the bot cannot
    read: extra surfaces must not be able to take down the scoring of
    everybody's actual work. The nightly recompute re-pushes anyway, so a
    missed night self-corrects.
    """
    if not score_cfg.push_url or not score_cfg.push_token:
        return None
    if not payload["days"]:
        print("  push: nothing to send (no developer has an email on Master)")
        return None

    def _post():
        response = requests.post(
            score_cfg.push_url,
            json=payload,
            headers={"Authorization": f"Bearer {score_cfg.push_token}"},
            timeout=30,
        )
        response.raise_for_status()
        return response.json()

    try:
        body = retrying.retry_api(_post, describe="push scores")
    except Exception as exc:  # noqa: BLE001
        print(f"  push failed ({type(exc).__name__}: {exc}); scores are still in "
              f"the sheet and the recompute pass will retry")
        return None

    accepted = int(body.get("accepted", 0))
    rejected = list(body.get("rejected", []))
    print(f"  pushed {accepted} day(s) -> {score_cfg.push_url}")
    for entry in rejected:
        print(f"    rejected {entry.get('email')}: {entry.get('reason')}")
    return accepted, rejected
```

- [ ] **Step 5: Call it from `do_score`**

After the `write_tab(...)` calls and the "Wrote 'Scorecard Daily'…" print, before the `if notify:` block:

```python
    pushed = push_scores(score_cfg, sc.compose_payload(records, roster_emails(sh)))
    if pushed and pushed[1] and score_cfg.ops_channel_id and not dry_run:
        lines = [f"*Scorecard push — {day.isoformat()}*", ""]
        lines += [f"  • {e.get('email')}: {e.get('reason')}" for e in pushed[1]]
        lines += ["", "_Add them in leave-management, or add their email to the "
                  "Master tab. Their scores are still in the sheet._"]
        post_slack(cfg, score_cfg.ops_channel_id, "\n".join(lines), "push rejections")
```

In the `if dry_run:` branch above, print the payload instead of sending it — *"a dry run that hides the output it is dry-running is not much of a check."*

- [ ] **Step 6: Document the variables**

Append to `.env.example` in the `SCORE_*` block:

```
SCORE_PUSH_URL=          # leave-management ingest endpoint; empty disables the push
SCORE_PUSH_TOKEN=        # must match SCORE_INGEST_TOKEN on that side
```

- [ ] **Step 7: Run the full suite**

Run: `.venv/Scripts/python.exe -m pytest -q`
Expected: PASS — the 218 existing scorecard tests plus the new ones.

- [ ] **Step 8: Dry-run against a real day**

Run: `.venv/Scripts/python.exe build_scorecard.py --score --date 2026-09-08 --dry-run`
Expected: the payload printed, nothing sent, nothing written.

- [ ] **Step 9: Commit**

```bash
git add src/standup_summarizer/config.py build_scorecard.py tests/test_scorecard_agent.py .env.example
git commit -m "Push each day's scores to leave-management"
```

---

### Task 15: Documentation, then go live

**Files:**
- Modify: `docs/SCORING.md`
- Modify: `docs/SCORECARD_API.md`

- [ ] **Step 1: Add the fourth output surface to `SCORING.md` §8**

A new `### 8.4 leave-management` subsection: what is pushed, when, that a `Not Scored` day carries no numbers, that the recompute re-pushes and corrects in place, and that a failed push never fails the run.

- [ ] **Step 2: Add `compose_payload` to `SCORECARD_API.md`**

While in that file, close the drift found on 2026-09-09: `TaskFacts` is missing `assignee` and `assigned_to_developer`, and `DayFacts` is missing `coordinated`, `coordination_partner` and `coordination_channel`.

- [ ] **Step 3: Commit the docs**

```bash
git add docs/SCORING.md docs/SCORECARD_API.md
git commit -m "Document the leave-management push"
```

- [ ] **Step 4: Switch it on**

1. Set `SCORE_INGEST_TOKEN` in leave-management to a freshly generated secret.
2. Set `SCORE_PUSH_URL` and `SCORE_PUSH_TOKEN` in Standup-Automation to that endpoint and the same secret.
3. Backfill: `.venv/Scripts/python.exe build_scorecard.py --recompute --days 30`. No new code path — it re-runs the identical scorer and pushes each day.
4. Open `/score` as a member and `/scores` as an admin and confirm a month of real history.

---

## Notes for whoever executes this

- **Never invent a zero.** If you find yourself writing `?? 0` on a points value, stop — that is the one defect this whole design is shaped to prevent.
- **A total of 110 is correct**, not a bug to clamp.
- **Do not add an edit affordance to either screen.** Corrections arrive by re-push. There is no override upstream and there must be none here.
- Task 7's `toRecord` uses loose casts because Prisma's generated row type is wide. If `npx tsc --noEmit` is happy with a tighter type, use it.
