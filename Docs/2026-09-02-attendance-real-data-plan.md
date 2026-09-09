# Attendance on Real Data — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-09-02
**Status:** Proposed plan (pre-implementation)
**Goal:** Move `/attendance` off the in-memory fixture onto org-scoped Postgres tables, so an admin can mark and correct any past or current day for their own organization and nobody else can.

**Architecture:** Two new tables in the `orgapp` Prisma schema — `Attendance` (one row per member per day) and `AttendanceEvent` (append-only audit). A day is stored as a `status` enum plus a nullable `modifier` enum, with a database `CHECK` making every invalid combination unrepresentable. Reads and writes go through `lib/attendance-service.ts`, which both the `/api/attendance` route handlers and the page's Server Actions call, so authorization is decided once — the same shape Team already uses.

**Tech Stack:** Next.js 16.3.2 (App Router, Server Actions, Route Handlers), React 19.2, Prisma 7 with `@prisma/adapter-pg`, PostgreSQL, Auth.js v5, Vitest 4, Tailwind 4.

**Spec:** This document. Builds directly on
[`2026-09-01-team-real-data-plan.md`](./2026-09-01-team-real-data-plan.md) and
[`2026-08-27-multi-tenant-org-rbac-design.md`](./2026-08-27-multi-tenant-org-rbac-design.md).

## Global Constraints

- Models live in the **`orgapp`** Postgres schema, set by the `schema` parameter on the connection URL (`lib/prisma-url.ts`). There is no `@@schema` attribute and no `multiSchema` preview feature.
- Every migration statement is **schema-qualified by hand** (`"orgapp"."Attendance"`). `prisma migrate diff` emits bare names, which would land in `public` on a fresh database.
- Dates are handled as **`YYYY-MM-DD` strings** everywhere above the database, and computed in UTC — the existing rule in `lib/date.ts`. The column is `DATE`, and Prisma hands back a `Date` at UTC midnight, so `d.toISOString().slice(0, 10)` round-trips exactly.
- "Today" is resolved in **`Asia/Kolkata`**, overridable with `ATTENDANCE_TIMEZONE`. Never compare a raw `new Date()` against a UTC date string — at 01:00 IST those disagree by a day.
- Authorization is decided in `lib/rbac.ts` (pure predicates) and enforced in `lib/attendance-service.ts` (the only module that touches `prisma.attendance`). Route handlers and Server Actions **never** decide policy themselves.
- Server Actions **re-authenticate**. `proxy.ts` is an optimistic gate, not the boundary — a Server Action POSTs to the page's own path.
- A member id arriving from a request is **never** trusted for scoping. The organization is always read from the stored `User` row, and "missing" and "belongs to another org" answer identically so ids cannot be probed.
- Tests: `npm test` (Vitest, `fileParallelism: false`). Integration tests hit the Dockerized Postgres (`docker compose up -d`), namespace rows with a per-run prefix, and clean up in `afterAll`.
- Commit after every task.

---

## 1. Where things stand

`/attendance` is ADMIN-only and correctly gated twice — `proxy.ts:37` lists the prefix, and `app/(leave)/layout.tsx` calls `requirePageRole(Role.ADMIN)`. The gate is not the problem.

The data is. `app/(leave)/attendance/page.tsx` calls `seedDb()` from `lib/seed.ts`, and every button posts to `demoMarkAttendance` / `demoMarkEveryonePresent` in `lib/demo-actions.ts`, which redirect to `/attendance?demo=…` so `<DemoBanner />` can say the change was not saved.

The genuine `markAttendance` / `markEveryonePresent` in `lib/actions.ts:200` are **not** the answer. They write through `lib/store.ts`, which targets the old leave-management tables in the `public` schema — dropped when the repo was narrowed to the organization backbone. Reviving them is not a swap of one import.

Four defects on the current screen are fixed as a side effect of this work, and are called out where they land:

| # | Defect | Fixed in |
|---|--------|----------|
| D1 | `TODAY` is hardcoded to `2026-08-17` (`lib/date.ts:12`), so the screen opens on a stale day | Task 2 (`todayIso`), Task 8 (page default) |
| D2 | The section heading says "Work from office" over rows marked WFH, because no fixture person has a `workMode` | Task 8 — `User.workMode` is a real column, so the grouping becomes real |
| D3 | `PageHeader` renders `formatHeader(TODAY)` and ignores the selected date, so the header contradicts the card below it | Task 8 — pass `meta={formatHeader(date)}` |
| D4 | The count pills increment per *code*, mixing "codes" with "people" so the row can exceed headcount | Task 8 — status pills sum to headcount; modifiers get a separate labelled row |

---

## 2. The rules this implements

Confirmed with the product owner on 2026-09-02:

1. **The date defaults to the current date.** Not a fixture constant.
2. **An admin may add or edit attendance for today and any past date.** Future dates are refused.
3. **Only an ADMIN may mark attendance**, and only for members of their own organization. A MEMBER gets 403; a SUPERADMIN may read but not mark.
4. **"Mark all present" fills only the people with no mark yet.** Anyone already carrying a half day, an absence or leave keeps it. The button is therefore safe to click twice.
5. **The markable combinations are exactly these eight.** `Present` and `WFH` are the base; `Half day` and `Short leave` are add-ons; `Absent` and `On leave` stand alone.

| Status | Modifier | Reads as |
|--------|----------|----------|
| `PRESENT` | — | Present |
| `WFH` | — | WFH |
| `PRESENT` | `HALF_DAY` | Present + Half day |
| `WFH` | `HALF_DAY` | WFH + Half day |
| `PRESENT` | `SHORT_LEAVE` | Present + Short leave |
| `WFH` | `SHORT_LEAVE` | WFH + Short leave |
| `ABSENT` | — | Absent |
| `LEAVE` | — | On leave |

Absent + Half day, On leave + Short leave, and Half day + Short leave are **not** valid. The two-column shape makes the third impossible, and the `CHECK` constraint makes the first two impossible.

---

## 3. Database tables required

### 3.1 New enums

```prisma
/// The base state of a day. Exactly one applies.
enum AttendanceStatus {
  PRESENT
  WFH
  ABSENT
  LEAVE
}

/// An add-on to a working day. Only ever set alongside PRESENT or WFH, and
/// only one at a time — enforced by the column shape and a CHECK constraint,
/// not by application code alone.
enum AttendanceModifier {
  HALF_DAY
  SHORT_LEAVE
}
```

### 3.2 New table — `Attendance`

One row per member per day. **The absence of a row means "not marked yet"** — there is no `UNMARKED` status, so clearing a day is a delete, and "how many are unmarked" is `roster.length - rows.length`.

```prisma
/// One member's attendance on one day.
///
/// `organizationId` is denormalised from the member's own `User` row so the
/// screen's hottest query — every mark in one organization on one day — is a
/// single indexed read with no join. `lib/attendance-service.ts` always copies
/// it from the stored user, never from a request body.
model Attendance {
  id String @id @default(cuid())

  userId String
  user   User   @relation("AttendanceSubject", fields: [userId], references: [id], onDelete: Cascade)

  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  /// Stored as DATE, not a timestamp: a day has no time and no offset.
  date DateTime @db.Date

  status   AttendanceStatus
  modifier AttendanceModifier?

  /// Who last wrote this row. The full history is in AttendanceEvent.
  markedById String
  markedBy   User   @relation("AttendanceMarkedBy", fields: [markedById], references: [id])

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  /// The natural key. Also the index behind every per-member read.
  @@unique([userId, date])
  @@index([organizationId, date])
}
```

Plus the constraint Prisma cannot express, added by hand to the migration:

```sql
ALTER TABLE "orgapp"."Attendance"
  ADD CONSTRAINT "Attendance_modifier_requires_working_day"
  CHECK ("modifier" IS NULL OR "status" IN ('PRESENT', 'WFH'));
```

### 3.3 New table — `AttendanceEvent`

Append-only. This is what makes unlimited backdating safe: a correction made three months late is traceable rather than prevented.

```prisma
/// Append-only log of every attendance write. Never updated, never deleted
/// except with its organization.
///
/// `userId` and `actorId` are plain columns rather than relations on purpose:
/// an audit row has to outlive the rows it describes. `organizationId` keeps
/// its foreign key so the log is removed with the organization it belongs to.
model AttendanceEvent {
  id String @id @default(cuid())

  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  /// The member the mark is about.
  userId String
  date   DateTime @db.Date

  /// `from*` null means the day had no row; `to*` null means it was cleared.
  fromStatus   AttendanceStatus?
  fromModifier AttendanceModifier?
  toStatus     AttendanceStatus?
  toModifier   AttendanceModifier?

  /// The admin who made the change.
  actorId String
  at      DateTime @default(now())

  @@index([organizationId, date])
  @@index([userId, date])
}
```

### 3.4 Changed table — `User`

Two back-relations only. No new columns — `workMode`, `status` and `regionId` already landed with Team.

```prisma
  attendance       Attendance[] @relation("AttendanceSubject")
  attendanceMarked Attendance[] @relation("AttendanceMarkedBy")
```

### 3.5 Changed table — `Organization`

```prisma
  attendance       Attendance[]
  attendanceEvents AttendanceEvent[]
```

### 3.6 Deliberately NOT stored

- **An `UNMARKED` status.** A missing row already says it, and a real value would need backfilling for every member × every day.
- **A derived attendance percentage.** `attendanceStats` in `lib/domain.ts` computes it from the rows; a stored copy would drift.
- **Auto-fill from approved leave.** `LEAVE` is a status an admin sets by hand for now. There is no `LeaveRequest` table in Prisma yet — leave requests are still fixture — so the screen's "Approved leave fills itself in" behaviour cannot be real in this pass. See §7.
- **A holiday or weekend flag.** `isWeekend` in `lib/date.ts` derives the weekend; holidays belong with the leave-policy migration.

---

## 4. APIs required

Two entry points, one policy layer — the rule Team established.

### 4.1 Route handlers

| Method | Path | Body / query | Who | Answers |
|--------|------|--------------|-----|---------|
| `GET` | `/api/attendance` | `?date=YYYY-MM-DD` | ADMIN, SUPERADMIN | The day's roster with each member's state (`null` when unmarked) |
| `GET` | `/api/attendance` | `?from=&to=[&userId=]` | ADMIN, SUPERADMIN | Raw marks over a span — the seam the member calendar will use |
| `PUT` | `/api/attendance/[userId]/[date]` | `{ status, modifier? }` | ADMIN (own org) | The stored state. Idempotent upsert |
| `DELETE` | `/api/attendance/[userId]/[date]` | — | ADMIN (own org) | `204`. Clears the day |
| `POST` | `/api/attendance/mark-all-present` | `{ date }` | ADMIN (own org) | `{ filled: n }` — how many gaps were closed |

`/api/attendance/mark-all-present` is one segment deep and `[userId]/[date]` is two, so the static route cannot be shadowed by the dynamic one.

Status codes follow `lib/api.ts` unchanged: `401` unauthenticated, `403` wrong role or wrong organization, `400` validation (bad date, future date, invalid combination, inactive member), `409` duplicate.

### 4.2 Server Actions — `lib/attendance-actions.ts`

| Action | Form fields | Replaces |
|--------|-------------|----------|
| `markAttendanceAction` | `userId`, `date`, `code` | `demoMarkAttendance` |
| `markEveryonePresentAction` | `date` | `demoMarkEveryonePresent` |

Both call the same `lib/attendance-service.ts` functions the route handlers do. On success they call `refresh()` from `next/cache` and return — no redirect, so the selected date and the scroll position survive a click. On failure they `backWithError` to `/attendance?date=…`, the pattern `lib/team-actions.ts` already uses.

`refresh()` is Server-Action-only in Next 16 (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/refresh.md`) — it must not be called from the route handlers.

### 4.3 Not built in this pass

`PATCH /api/attendance/[userId]/[date]` — there is no partial update of a two-column row that `PUT` does not already express.

---

## 5. File structure

| File | Responsibility |
|------|----------------|
| `prisma/schema.prisma` | *Modify.* Two enums, two models, four back-relations |
| `prisma/migrations/20260902120000_attendance/migration.sql` | *Create.* Schema-qualified DDL plus the `CHECK` |
| `lib/attendance.ts` | *Create.* Pure rules: the toggle matrix, date validation, `todayIso`. No Prisma, no session |
| `lib/rbac.ts` | *Modify.* `canMarkAttendance`, `canListAttendance` |
| `lib/attendance-service.ts` | *Create.* The only module that touches `prisma.attendance`. Authorization + audit |
| `lib/attendance-input.ts` | *Create.* Body/param parsing shared by the routes and the actions |
| `app/api/attendance/route.ts` | *Create.* `GET` |
| `app/api/attendance/[userId]/[date]/route.ts` | *Create.* `PUT`, `DELETE` |
| `app/api/attendance/mark-all-present/route.ts` | *Create.* `POST` |
| `lib/attendance-actions.ts` | *Create.* The two Server Actions |
| `app/(leave)/attendance/page.tsx` | *Modify.* Real data, real default date, D2–D4 |
| `components/date-nav.tsx` | *Modify.* Accept a `max` so the picker cannot offer a future day |
| `lib/ui.ts` | *Modify.* An `ATTENDANCE_STYLE` keyed by the Prisma enums, beside the fixture screens' existing one |
| `prisma/seed.ts` | *Modify.* A fortnight of attendance for the demo org |
| `tests/attendance.test.ts` | *Create.* Unit: the toggle matrix and the date rules |
| `tests/attendance.integration.test.ts` | *Create.* The handlers against Postgres |
| `tests/rbac.test.ts` | *Modify.* The two new predicates |

`lib/demo-actions.ts` keeps its other exports; only the two attendance ones fall out of use (Task 8).

---

# Tasks

### Task 1: Schema, migration and the CHECK constraint

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260902120000_attendance/migration.sql`
- Test: `tests/attendance.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AttendanceStatus` and `AttendanceModifier` in `@/generated/prisma/enums`; `prisma.attendance` and `prisma.attendanceEvent` on the client from `@/lib/prisma`.

- [ ] **Step 1: Add the enums and models to `prisma/schema.prisma`**

Append the two enums after the existing `EmploymentStatus`, add the two models at the end of the file, and add the back-relations to `User` and `Organization`. Use the exact blocks from §3.1–3.5 above.

- [ ] **Step 2: Generate the migration without applying it**

```bash
npx prisma migrate dev --create-only --name attendance
```

This writes `prisma/migrations/<timestamp>_attendance/migration.sql` with **bare** table names. Rename the directory to `20260902120000_attendance`.

- [ ] **Step 3: Qualify every name and append the CHECK**

Rewrite `migration.sql` so every object is `"orgapp"."…"`, matching `20260901140000_team_profiles/migration.sql`. The finished file:

```sql
-- Attendance: one row per member per day, plus an append-only audit log.
--
-- Every object is schema-qualified rather than relying on the `schema=orgapp`
-- parameter to set the search path — same rule as the baseline migration.

-- CreateEnum
CREATE TYPE "orgapp"."AttendanceStatus" AS ENUM ('PRESENT', 'WFH', 'ABSENT', 'LEAVE');

-- CreateEnum
CREATE TYPE "orgapp"."AttendanceModifier" AS ENUM ('HALF_DAY', 'SHORT_LEAVE');

-- CreateTable
CREATE TABLE "orgapp"."Attendance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "orgapp"."AttendanceStatus" NOT NULL,
    "modifier" "orgapp"."AttendanceModifier",
    "markedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orgapp"."AttendanceEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "fromStatus" "orgapp"."AttendanceStatus",
    "fromModifier" "orgapp"."AttendanceModifier",
    "toStatus" "orgapp"."AttendanceStatus",
    "toModifier" "orgapp"."AttendanceModifier",
    "actorId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Attendance_organizationId_date_idx" ON "orgapp"."Attendance"("organizationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_userId_date_key" ON "orgapp"."Attendance"("userId", "date");

-- CreateIndex
CREATE INDEX "AttendanceEvent_organizationId_date_idx" ON "orgapp"."AttendanceEvent"("organizationId", "date");

-- CreateIndex
CREATE INDEX "AttendanceEvent_userId_date_idx" ON "orgapp"."AttendanceEvent"("userId", "date");

-- AddForeignKey
ALTER TABLE "orgapp"."Attendance" ADD CONSTRAINT "Attendance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "orgapp"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orgapp"."Attendance" ADD CONSTRAINT "Attendance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "orgapp"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orgapp"."Attendance" ADD CONSTRAINT "Attendance_markedById_fkey" FOREIGN KEY ("markedById") REFERENCES "orgapp"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orgapp"."AttendanceEvent" ADD CONSTRAINT "AttendanceEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "orgapp"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The combination rule, which Prisma's schema language cannot express:
-- "Half day" and "Short leave" are add-ons to a working day. An absence or a
-- day of leave carries neither.
ALTER TABLE "orgapp"."Attendance"
  ADD CONSTRAINT "Attendance_modifier_requires_working_day"
  CHECK ("modifier" IS NULL OR "status" IN ('PRESENT', 'WFH'));
```

- [ ] **Step 4: Write the failing constraint test**

Create `tests/attendance.integration.test.ts` with just this much for now:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Role } from "@/generated/prisma/enums";

/**
 * Attendance against the Dockerized Postgres.
 *
 * Same approach as team.integration.test.ts: real Prisma queries, rows
 * namespaced with a per-run prefix and removed afterwards.
 */

const { prisma } = await import("@/lib/prisma");

const RUN = `att-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

let orgId: string;
let adminId: string;
let memberId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `${RUN} Org` } });
  orgId = org.id;

  const admin = await prisma.user.create({
    data: {
      name: "Run Admin",
      email: email("admin"),
      passwordHash: "x",
      role: Role.ADMIN,
      organizationId: orgId,
    },
  });
  adminId = admin.id;

  const member = await prisma.user.create({
    data: {
      name: "Run Member",
      email: email("member"),
      passwordHash: "x",
      role: Role.MEMBER,
      organizationId: orgId,
    },
  });
  memberId = member.id;
});

afterAll(async () => {
  await prisma.attendanceEvent.deleteMany({ where: { organizationId: orgId } });
  await prisma.attendance.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe("the database rejects impossible combinations", () => {
  it("refuses a modifier on an absence", async () => {
    await expect(
      prisma.attendance.create({
        data: {
          userId: memberId,
          organizationId: orgId,
          date: new Date("2026-08-17"),
          status: "ABSENT",
          modifier: "HALF_DAY",
          markedById: adminId,
        },
      }),
    ).rejects.toThrow();
  });

  it("accepts a modifier on a working day", async () => {
    const row = await prisma.attendance.create({
      data: {
        userId: memberId,
        organizationId: orgId,
        date: new Date("2026-08-18"),
        status: "WFH",
        modifier: "SHORT_LEAVE",
        markedById: adminId,
      },
    });

    expect(row.status).toBe("WFH");
    expect(row.modifier).toBe("SHORT_LEAVE");
    // A DATE column round-trips through UTC midnight.
    expect(row.date.toISOString().slice(0, 10)).toBe("2026-08-18");
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

```bash
docker compose up -d
npx vitest run tests/attendance.integration.test.ts
```

Expected: FAIL — `prisma.attendance` is undefined, because the migration has not been applied and the client has not been regenerated.

- [ ] **Step 6: Apply the migration and regenerate**

```bash
npx prisma migrate dev
npx prisma generate
```

- [ ] **Step 7: Run it and watch it pass**

```bash
npx vitest run tests/attendance.integration.test.ts
```

Expected: PASS, both tests. If "refuses a modifier on an absence" passes for the wrong reason, confirm the constraint exists:

```bash
docker compose exec -T db psql -U postgres -c "\d orgapp.\"Attendance\"" | grep -i check
```

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations tests/attendance.integration.test.ts
git commit -m "Add attendance tables with a status/modifier combination constraint"
```

---

### Task 2: The pure rules — `lib/attendance.ts`

**Files:**
- Create: `lib/attendance.ts`
- Test: `tests/attendance.test.ts`

**Interfaces:**
- Consumes: `AttendanceStatus`, `AttendanceModifier` from Task 1. `HttpError` from `@/lib/rbac`.
- Produces:
  - `type AttendanceState = { status: AttendanceStatus; modifier: AttendanceModifier | null }`
  - `type AttendanceCode = AttendanceStatus | AttendanceModifier`
  - `const ATTENDANCE_CODES: AttendanceCode[]`
  - `todayIso(now?: Date): string`
  - `isFutureDate(date: string, today?: string): boolean`
  - `parseDateParam(value: unknown, field?: string): string`
  - `assertMarkable(date: string, today?: string): void`
  - `isActiveCode(state: AttendanceState | null, code: AttendanceCode): boolean`
  - `toggle(state: AttendanceState | null, code: AttendanceCode): AttendanceState | null`
  - `toDbDate(date: string): Date`
  - `fromDbDate(value: Date): string`
  - `describeState(state: AttendanceState | null): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/attendance.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  assertMarkable,
  fromDbDate,
  isActiveCode,
  isFutureDate,
  parseDateParam,
  toDbDate,
  todayIso,
  toggle,
  type AttendanceState,
} from "@/lib/attendance";
import { HttpError } from "@/lib/rbac";

const state = (
  status: AttendanceState["status"],
  modifier: AttendanceState["modifier"] = null,
): AttendanceState => ({ status, modifier });

describe("todayIso", () => {
  it("resolves the day in Asia/Kolkata, not UTC", () => {
    // 2026-09-02T20:30:00Z is 2026-09-03 02:00 IST — a different day.
    expect(todayIso(new Date("2026-09-02T20:30:00Z"))).toBe("2026-09-03");
  });

  it("agrees with UTC in the middle of the day", () => {
    expect(todayIso(new Date("2026-09-02T06:00:00Z"))).toBe("2026-09-02");
  });
});

describe("date parsing", () => {
  it("accepts an ISO day", () => {
    expect(parseDateParam("2026-08-17")).toBe("2026-08-17");
  });

  it("rejects a malformed day", () => {
    expect(() => parseDateParam("17-08-2026")).toThrow(HttpError);
  });

  it("rejects a day that does not exist", () => {
    expect(() => parseDateParam("2026-02-30")).toThrow(HttpError);
  });

  it("rejects a missing value", () => {
    expect(() => parseDateParam(undefined)).toThrow(HttpError);
  });

  it("round-trips through the database representation", () => {
    expect(fromDbDate(toDbDate("2026-08-17"))).toBe("2026-08-17");
  });
});

describe("future dates", () => {
  it("refuses tomorrow", () => {
    expect(isFutureDate("2026-09-03", "2026-09-02")).toBe(true);
    expect(() => assertMarkable("2026-09-03", "2026-09-02")).toThrow(HttpError);
  });

  it("allows today and any past day", () => {
    expect(isFutureDate("2026-09-02", "2026-09-02")).toBe(false);
    expect(isFutureDate("2020-01-01", "2026-09-02")).toBe(false);
    expect(() => assertMarkable("2026-09-02", "2026-09-02")).not.toThrow();
    expect(() => assertMarkable("2020-01-01", "2026-09-02")).not.toThrow();
  });
});

describe("toggle — every valid combination is reachable", () => {
  it("marks an unmarked day present", () => {
    expect(toggle(null, "PRESENT")).toEqual(state("PRESENT"));
  });

  it("clears the day when the active base is clicked again", () => {
    expect(toggle(state("PRESENT"), "PRESENT")).toBeNull();
    expect(toggle(state("PRESENT", "HALF_DAY"), "PRESENT")).toBeNull();
  });

  it("swaps the base and keeps the add-on", () => {
    expect(toggle(state("WFH", "HALF_DAY"), "PRESENT")).toEqual(
      state("PRESENT", "HALF_DAY"),
    );
    expect(toggle(state("PRESENT", "SHORT_LEAVE"), "WFH")).toEqual(
      state("WFH", "SHORT_LEAVE"),
    );
  });

  it("defaults to Present when an add-on is applied to an unmarked day", () => {
    expect(toggle(null, "HALF_DAY")).toEqual(state("PRESENT", "HALF_DAY"));
    expect(toggle(null, "SHORT_LEAVE")).toEqual(state("PRESENT", "SHORT_LEAVE"));
  });

  it("keeps Half day and Short leave mutually exclusive", () => {
    expect(toggle(state("PRESENT", "HALF_DAY"), "SHORT_LEAVE")).toEqual(
      state("PRESENT", "SHORT_LEAVE"),
    );
    expect(toggle(state("WFH", "SHORT_LEAVE"), "HALF_DAY")).toEqual(
      state("WFH", "HALF_DAY"),
    );
  });

  it("removes the add-on and keeps the base", () => {
    expect(toggle(state("WFH", "HALF_DAY"), "HALF_DAY")).toEqual(state("WFH"));
  });

  it("lifts an absence to a working day when an add-on is applied", () => {
    expect(toggle(state("ABSENT"), "HALF_DAY")).toEqual(state("PRESENT", "HALF_DAY"));
  });

  it("lets Absent and On leave replace everything", () => {
    expect(toggle(state("PRESENT", "HALF_DAY"), "ABSENT")).toEqual(state("ABSENT"));
    expect(toggle(state("WFH", "SHORT_LEAVE"), "LEAVE")).toEqual(state("LEAVE"));
  });

  it("clears the day when the active solo code is clicked again", () => {
    expect(toggle(state("ABSENT"), "ABSENT")).toBeNull();
    expect(toggle(state("LEAVE"), "LEAVE")).toBeNull();
  });

  it("never produces a modifier without a working base", () => {
    const codes = ["PRESENT", "WFH", "HALF_DAY", "ABSENT", "LEAVE", "SHORT_LEAVE"] as const;
    const starts: (AttendanceState | null)[] = [
      null,
      state("PRESENT"),
      state("WFH"),
      state("ABSENT"),
      state("LEAVE"),
      state("PRESENT", "HALF_DAY"),
      state("WFH", "SHORT_LEAVE"),
    ];

    for (const start of starts) {
      for (const code of codes) {
        const next = toggle(start, code);
        if (next?.modifier) {
          expect(["PRESENT", "WFH"]).toContain(next.status);
        }
      }
    }
  });
});

describe("isActiveCode", () => {
  it("reads the base and the add-on independently", () => {
    const s = state("WFH", "HALF_DAY");
    expect(isActiveCode(s, "WFH")).toBe(true);
    expect(isActiveCode(s, "HALF_DAY")).toBe(true);
    expect(isActiveCode(s, "PRESENT")).toBe(false);
    expect(isActiveCode(s, "SHORT_LEAVE")).toBe(false);
  });

  it("treats an unmarked day as nothing active", () => {
    expect(isActiveCode(null, "PRESENT")).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/attendance.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/attendance'`.

- [ ] **Step 3: Write `lib/attendance.ts`**

```ts
import { AttendanceModifier, AttendanceStatus } from "@/generated/prisma/enums";
import { HttpError } from "@/lib/rbac";

/**
 * The attendance rules, as pure functions.
 *
 * No Prisma and no session here, so the whole combination matrix is unit
 * testable — the same split `lib/rbac.ts` has from `lib/services.ts`.
 *
 * A day is a `status` plus an optional `modifier`. `null` is not a third
 * status: it means the day has no row at all, which is what "not marked yet"
 * is stored as.
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

/** A working day — the only base a modifier may sit on. */
const WORKING: AttendanceStatus[] = [AttendanceStatus.PRESENT, AttendanceStatus.WFH];

const MODIFIERS: string[] = [
  AttendanceModifier.HALF_DAY,
  AttendanceModifier.SHORT_LEAVE,
];

function isModifier(code: AttendanceCode): code is AttendanceModifier {
  return MODIFIERS.includes(code);
}

function isWorking(status: AttendanceStatus): boolean {
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
 * peeling off one layer — a `HALF_DAY` with no base is not a state this schema
 * can hold, and "clicking the lit button turns the day off" is the simpler
 * rule to explain.
 *
 * Applying an add-on to a day that is unmarked, absent or on leave promotes it
 * to `PRESENT`, since a half day is by definition a day partly worked.
 */
export function toggle(
  state: AttendanceState | null,
  code: AttendanceCode,
): AttendanceState | null {
  if (isModifier(code)) {
    if (state?.modifier === code) {
      // The base survives; the constraint guarantees it is a working day.
      return { status: state.status, modifier: null };
    }
    const base = state && isWorking(state.status) ? state.status : AttendanceStatus.PRESENT;
    return { status: base, modifier: code };
  }

  if (state?.status === code) return null;

  return {
    status: code,
    // A base swap keeps the add-on; anything else drops it, which is what
    // makes Absent and On leave exclusive without a special case.
    modifier:
      isWorking(code) && state && isWorking(state.status) ? state.modifier : null,
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

/** The one-line note under a person's name. */
export function describeState(state: AttendanceState | null): string {
  if (!state) return "Not marked yet";
  const base = STATUS_LABEL[state.status];
  return state.modifier ? `${base} + ${MODIFIER_LABEL[state.modifier]}` : base;
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
npx vitest run tests/attendance.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add lib/attendance.ts tests/attendance.test.ts
git commit -m "Add the pure attendance rules: toggle matrix, dates, labels"
```

---

### Task 3: Authorization predicates

**Files:**
- Modify: `lib/rbac.ts`
- Test: `tests/rbac.test.ts`

**Interfaces:**
- Consumes: `Actor`, `Role` — already in `lib/rbac.ts`.
- Produces: `canMarkAttendance(actor: Actor, memberOrganizationId: string | null): boolean`, `canListAttendance(actor: Actor): boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/rbac.test.ts`:

```ts
describe("attendance", () => {
  const admin: Actor = { id: "a1", role: Role.ADMIN, organizationId: "org1" };
  const otherAdmin: Actor = { id: "a2", role: Role.ADMIN, organizationId: "org2" };
  const member: Actor = { id: "m1", role: Role.MEMBER, organizationId: "org1" };
  const superadmin: Actor = { id: "s1", role: Role.SUPERADMIN, organizationId: null };

  it("lets an admin mark inside their own organization", () => {
    expect(canMarkAttendance(admin, "org1")).toBe(true);
  });

  it("stops an admin marking in another organization", () => {
    expect(canMarkAttendance(otherAdmin, "org1")).toBe(false);
  });

  it("stops a member marking anyone, including themselves", () => {
    expect(canMarkAttendance(member, "org1")).toBe(false);
  });

  it("stops a superadmin marking — they create organizations, not attendance", () => {
    expect(canMarkAttendance(superadmin, "org1")).toBe(false);
  });

  it("lets an admin and a superadmin read", () => {
    expect(canListAttendance(admin)).toBe(true);
    expect(canListAttendance(superadmin)).toBe(true);
  });

  it("stops a member reading the whole roster's attendance", () => {
    expect(canListAttendance(member)).toBe(false);
  });
});
```

Add `canListAttendance` and `canMarkAttendance` to the file's existing import from `@/lib/rbac`.

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/rbac.test.ts
```

Expected: FAIL — the two functions are not exported.

- [ ] **Step 3: Add the predicates to `lib/rbac.ts`**

Place them next to `canUpdateMember`, whose rule they mirror:

```ts
/**
 * Attendance is marked by the Admin of the member's own organization.
 *
 * Same shape as `canUpdateMember`, and deliberately not widened to SuperAdmin:
 * a SuperAdmin creates organizations and admins, and what happens inside an
 * organization is its admin's to record. Reading is the exception, below.
 *
 * A MEMBER is excluded even for their own row — attendance is an employer's
 * record of the day, not a self-service check-in.
 */
export function canMarkAttendance(
  actor: Actor,
  memberOrganizationId: string | null,
): boolean {
  return actor.role === Role.ADMIN && actor.organizationId === memberOrganizationId;
}

/**
 * Reading follows `canListMembers`: a SuperAdmin sees every organization, so
 * they may read the attendance inside one even though they cannot change it.
 * Scope the query with `visibleOrgId`.
 */
export function canListAttendance(actor: Actor): boolean {
  return actor.role === Role.SUPERADMIN || actor.role === Role.ADMIN;
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
npx vitest run tests/rbac.test.ts
```

Expected: PASS, the whole file.

- [ ] **Step 5: Commit**

```bash
git add lib/rbac.ts tests/rbac.test.ts
git commit -m "Add attendance authorization predicates"
```

---

### Task 4: Reading a day — `listDayAttendance`

**Files:**
- Create: `lib/attendance-service.ts`
- Test: `tests/attendance.integration.test.ts` (extend)

**Interfaces:**
- Consumes: `AttendanceState`, `toDbDate`, `fromDbDate`, `parseDateParam` (Task 2); `canListAttendance`, `visibleOrgId`, `HttpError` (Task 3).
- Produces:
  - `type AttendanceMember = { id: string; name: string; title: string | null; empId: string | null; workMode: WorkMode | null; region: { id: string; name: string } | null }`
  - `type AttendanceDayRow = { member: AttendanceMember; state: AttendanceState | null }`
  - `listDayAttendance(actor: Actor, date: string): Promise<AttendanceDayRow[]>`
  - `listRangeAttendance(actor: Actor, input: { from: string; to: string; userId?: string }): Promise<{ userId: string; date: string; status: AttendanceStatus; modifier: AttendanceModifier | null }[]>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/attendance.integration.test.ts`:

```ts
const { listDayAttendance, listRangeAttendance } = await import(
  "@/lib/attendance-service"
);

const adminActor = (): Actor => ({
  id: adminId,
  role: Role.ADMIN,
  organizationId: orgId,
});

describe("listDayAttendance", () => {
  it("returns every active member, unmarked ones included", async () => {
    const rows = await listDayAttendance(adminActor(), "2026-08-19");
    const mine = rows.find((r) => r.member.id === memberId);

    expect(mine).toBeDefined();
    expect(mine?.state).toBeNull();
  });

  it("attaches the stored state for a marked day", async () => {
    const rows = await listDayAttendance(adminActor(), "2026-08-18");
    const mine = rows.find((r) => r.member.id === memberId);

    expect(mine?.state).toEqual({ status: "WFH", modifier: "SHORT_LEAVE" });
  });

  it("refuses a member", async () => {
    await expect(
      listDayAttendance(
        { id: memberId, role: Role.MEMBER, organizationId: orgId },
        "2026-08-18",
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("shows an admin nothing from another organization", async () => {
    const rows = await listDayAttendance(
      { id: "someone", role: Role.ADMIN, organizationId: "not-a-real-org" },
      "2026-08-18",
    );

    expect(rows).toEqual([]);
  });
});

describe("listRangeAttendance", () => {
  it("returns the marks inside the span, as date strings", async () => {
    const rows = await listRangeAttendance(adminActor(), {
      from: "2026-08-17",
      to: "2026-08-19",
      userId: memberId,
    });

    expect(rows).toEqual([
      { userId: memberId, date: "2026-08-18", status: "WFH", modifier: "SHORT_LEAVE" },
    ]);
  });

  it("refuses a reversed span", async () => {
    await expect(
      listRangeAttendance(adminActor(), { from: "2026-08-19", to: "2026-08-17" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
```

Add to the imports at the top of the file:

```ts
import type { Actor } from "@/lib/rbac";
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/attendance.integration.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/attendance-service'`.

- [ ] **Step 3: Write the read half of `lib/attendance-service.ts`**

```ts
import {
  AttendanceModifier,
  AttendanceStatus,
  EmploymentStatus,
  Role,
  WorkMode,
} from "@/generated/prisma/enums";
import {
  fromDbDate,
  toDbDate,
  type AttendanceState,
} from "@/lib/attendance";
import { prisma } from "@/lib/prisma";
// `canMarkAttendance` joins this import in Task 5 — importing it now would
// fail the linter as unused.
import { type Actor, HttpError, canListAttendance, visibleOrgId } from "@/lib/rbac";

/**
 * Everything that reads or writes the attendance tables.
 *
 * The same contract as lib/services.ts: both entry points — the route handlers
 * under app/api/attendance and the Server Actions behind the screen — come
 * through here, so authorization is decided in exactly one place per
 * operation. Callers pass an `Actor` they have already authenticated; nothing
 * here reads a cookie or a request.
 */

/** The member fields the attendance grid renders. */
const MEMBER_FIELDS = {
  id: true,
  name: true,
  title: true,
  empId: true,
  workMode: true,
  region: { select: { id: true, name: true } },
} as const;

export type AttendanceMember = {
  id: string;
  name: string;
  title: string | null;
  empId: string | null;
  workMode: WorkMode | null;
  region: { id: string; name: string } | null;
};

export type AttendanceDayRow = {
  member: AttendanceMember;
  /** `null` when the day has no row — "not marked yet". */
  state: AttendanceState | null;
};

export type AttendanceMark = {
  userId: string;
  date: string;
  status: AttendanceStatus;
  modifier: AttendanceModifier | null;
};

/* --------------------------------------------------------------- reading -- */

/**
 * The roster for one day, with each person's mark.
 *
 * Two queries rather than a join with a filtered relation: the roster is the
 * same every day and the marks are a single indexed read on
 * `[organizationId, date]`. Members with no row come back with `state: null`,
 * which is what makes "unmarked" countable without a placeholder row.
 */
export async function listDayAttendance(
  actor: Actor,
  date: string,
): Promise<AttendanceDayRow[]> {
  if (!canListAttendance(actor)) {
    throw new HttpError(403, "Your role does not permit this action.");
  }

  const orgId = visibleOrgId(actor);
  const members = await prisma.user.findMany({
    where: {
      role: Role.MEMBER,
      status: EmploymentStatus.ACTIVE,
      ...(orgId ? { organizationId: orgId } : {}),
    },
    select: MEMBER_FIELDS,
    orderBy: [{ name: "asc" }],
  });

  if (members.length === 0) return [];

  const marks = await prisma.attendance.findMany({
    where: {
      date: toDbDate(date),
      userId: { in: members.map((m) => m.id) },
    },
    select: { userId: true, status: true, modifier: true },
  });

  const byUser = new Map(marks.map((m) => [m.userId, m]));

  return members.map((member) => {
    const mark = byUser.get(member.id);
    return {
      member,
      state: mark ? { status: mark.status, modifier: mark.modifier } : null,
    };
  });
}

/**
 * Raw marks over a span, for a whole organization or one member.
 *
 * The seam a member calendar and any monthly report read through. Scoped by
 * `visibleOrgId` like every other list, so a `userId` from another
 * organization simply matches nothing.
 */
export async function listRangeAttendance(
  actor: Actor,
  input: { from: string; to: string; userId?: string },
): Promise<AttendanceMark[]> {
  if (!canListAttendance(actor)) {
    throw new HttpError(403, "Your role does not permit this action.");
  }
  if (input.to < input.from) {
    throw new HttpError(400, '"to" must not be earlier than "from".');
  }

  const orgId = visibleOrgId(actor);
  const rows = await prisma.attendance.findMany({
    where: {
      date: { gte: toDbDate(input.from), lte: toDbDate(input.to) },
      ...(orgId ? { organizationId: orgId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
    },
    select: { userId: true, date: true, status: true, modifier: true },
    orderBy: [{ date: "asc" }, { userId: "asc" }],
  });

  return rows.map((row) => ({
    userId: row.userId,
    date: fromDbDate(row.date),
    status: row.status,
    modifier: row.modifier,
  }));
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
npx vitest run tests/attendance.integration.test.ts
```

Expected: PASS, all tests including Task 1's.

- [ ] **Step 5: Commit**

```bash
git add lib/attendance-service.ts tests/attendance.integration.test.ts
git commit -m "Read attendance for a day and a span, org-scoped"
```

---

### Task 5: Writing a day — set, clear, toggle, audit

**Files:**
- Modify: `lib/attendance-service.ts`
- Test: `tests/attendance.integration.test.ts` (extend)

**Interfaces:**
- Consumes: everything from Task 4, plus `toggle`, `assertMarkable` (Task 2), `canMarkAttendance` (Task 3).
- Produces:
  - `setAttendance(actor: Actor, input: { userId: string; date: string; status: AttendanceStatus; modifier: AttendanceModifier | null }): Promise<AttendanceState>`
  - `clearAttendance(actor: Actor, input: { userId: string; date: string }): Promise<void>`
  - `toggleAttendanceCode(actor: Actor, input: { userId: string; date: string; code: AttendanceCode }): Promise<AttendanceState | null>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/attendance.integration.test.ts`:

```ts
const { setAttendance, clearAttendance, toggleAttendanceCode } = await import(
  "@/lib/attendance-service"
);

describe("setAttendance", () => {
  it("creates and then overwrites the same day", async () => {
    const first = await setAttendance(adminActor(), {
      userId: memberId,
      date: "2026-08-20",
      status: "PRESENT",
      modifier: null,
    });
    expect(first).toEqual({ status: "PRESENT", modifier: null });

    const second = await setAttendance(adminActor(), {
      userId: memberId,
      date: "2026-08-20",
      status: "WFH",
      modifier: "HALF_DAY",
    });
    expect(second).toEqual({ status: "WFH", modifier: "HALF_DAY" });

    const rows = await prisma.attendance.findMany({
      where: { userId: memberId, date: new Date("2026-08-20") },
    });
    expect(rows).toHaveLength(1);
  });

  it("records who marked it", async () => {
    const row = await prisma.attendance.findUnique({
      where: { userId_date: { userId: memberId, date: new Date("2026-08-20") } },
    });
    expect(row?.markedById).toBe(adminId);
  });

  it("writes an audit event per change, with the previous value", async () => {
    const events = await prisma.attendanceEvent.findMany({
      where: { userId: memberId, date: new Date("2026-08-20") },
      orderBy: { at: "asc" },
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      fromStatus: null,
      toStatus: "PRESENT",
      actorId: adminId,
    });
    expect(events[1]).toMatchObject({
      fromStatus: "PRESENT",
      fromModifier: null,
      toStatus: "WFH",
      toModifier: "HALF_DAY",
    });
  });

  it("refuses a future date", async () => {
    await expect(
      setAttendance(adminActor(), {
        userId: memberId,
        date: "2099-01-01",
        status: "PRESENT",
        modifier: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses an invalid combination before it reaches the database", async () => {
    await expect(
      setAttendance(adminActor(), {
        userId: memberId,
        date: "2026-08-21",
        status: "ABSENT",
        modifier: "HALF_DAY",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a member", async () => {
    await expect(
      setAttendance(
        { id: memberId, role: Role.MEMBER, organizationId: orgId },
        { userId: memberId, date: "2026-08-21", status: "PRESENT", modifier: null },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("answers the same way for a foreign member and an unknown id", async () => {
    const foreign = setAttendance(
      { id: "x", role: Role.ADMIN, organizationId: "another-org" },
      { userId: memberId, date: "2026-08-21", status: "PRESENT", modifier: null },
    );
    const unknown = setAttendance(adminActor(), {
      userId: "no-such-user",
      date: "2026-08-21",
      status: "PRESENT",
      modifier: null,
    });

    await expect(foreign).rejects.toMatchObject({ status: 403 });
    await expect(unknown).rejects.toMatchObject({ status: 403 });
  });
});

describe("clearAttendance", () => {
  it("removes the row and logs the clear", async () => {
    await setAttendance(adminActor(), {
      userId: memberId,
      date: "2026-08-24",
      status: "PRESENT",
      modifier: null,
    });
    await clearAttendance(adminActor(), { userId: memberId, date: "2026-08-24" });

    const row = await prisma.attendance.findUnique({
      where: { userId_date: { userId: memberId, date: new Date("2026-08-24") } },
    });
    expect(row).toBeNull();

    const last = await prisma.attendanceEvent.findFirst({
      where: { userId: memberId, date: new Date("2026-08-24") },
      orderBy: { at: "desc" },
    });
    expect(last).toMatchObject({ fromStatus: "PRESENT", toStatus: null });
  });

  it("is silent on a day that was never marked", async () => {
    await expect(
      clearAttendance(adminActor(), { userId: memberId, date: "2026-08-25" }),
    ).resolves.toBeUndefined();
  });
});

describe("toggleAttendanceCode", () => {
  it("walks a day through the combinations the grid offers", async () => {
    const on = (code: Parameters<typeof toggleAttendanceCode>[1]["code"]) =>
      toggleAttendanceCode(adminActor(), { userId: memberId, date: "2026-08-26", code });

    expect(await on("PRESENT")).toEqual({ status: "PRESENT", modifier: null });
    expect(await on("HALF_DAY")).toEqual({ status: "PRESENT", modifier: "HALF_DAY" });
    expect(await on("WFH")).toEqual({ status: "WFH", modifier: "HALF_DAY" });
    expect(await on("SHORT_LEAVE")).toEqual({ status: "WFH", modifier: "SHORT_LEAVE" });
    expect(await on("ABSENT")).toEqual({ status: "ABSENT", modifier: null });
    expect(await on("ABSENT")).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/attendance.integration.test.ts
```

Expected: FAIL — `setAttendance is not a function`.

- [ ] **Step 3: Add the write half to `lib/attendance-service.ts`**

Append, and widen the imports at the top to include `assertMarkable`, `toggle` and `AttendanceCode`:

```ts
/* --------------------------------------------------------------- writing -- */

/**
 * The member an admin may write against, or a 403.
 *
 * "Not found" and "belongs to another organization" answer identically, and
 * with a 403 rather than a 404, so this endpoint cannot be used to discover
 * which user ids exist elsewhere — the same rule `assertRegionInOrg` follows
 * in lib/services.ts.
 */
async function assertMarkableMember(
  actor: Actor,
  userId: string,
): Promise<{ organizationId: string }> {
  const member = await prisma.user.findUnique({
    where: { id: userId },
    select: { organizationId: true, role: true, status: true },
  });

  if (!member || !canMarkAttendance(actor, member.organizationId)) {
    throw new HttpError(403, "You cannot mark attendance for that person.");
  }
  if (member.role !== Role.MEMBER) {
    throw new HttpError(400, "Attendance is only recorded for team members.");
  }
  if (member.status !== EmploymentStatus.ACTIVE) {
    throw new HttpError(400, "That person is no longer on the team.");
  }

  // Non-null by canMarkAttendance: an ADMIN always carries an organization.
  return { organizationId: member.organizationId! };
}

/** The combination rule, checked before the database has to. */
function assertValidState(state: AttendanceState): void {
  const working =
    state.status === AttendanceStatus.PRESENT || state.status === AttendanceStatus.WFH;
  if (state.modifier && !working) {
    throw new HttpError(
      400,
      "Half day and Short leave only apply to a day worked — Present or WFH.",
    );
  }
}

/**
 * Write one person's day, and log the change.
 *
 * The read, the write and the audit row share one transaction so a concurrent
 * edit cannot interleave between reading the previous value and recording it.
 */
export async function setAttendance(
  actor: Actor,
  input: {
    userId: string;
    date: string;
    status: AttendanceStatus;
    modifier: AttendanceModifier | null;
  },
): Promise<AttendanceState> {
  assertMarkable(input.date);
  assertValidState({ status: input.status, modifier: input.modifier });
  const { organizationId } = await assertMarkableMember(actor, input.userId);

  const date = toDbDate(input.date);

  return prisma.$transaction(async (tx) => {
    const previous = await tx.attendance.findUnique({
      where: { userId_date: { userId: input.userId, date } },
      select: { status: true, modifier: true },
    });

    const row = await tx.attendance.upsert({
      where: { userId_date: { userId: input.userId, date } },
      create: {
        userId: input.userId,
        organizationId,
        date,
        status: input.status,
        modifier: input.modifier,
        markedById: actor.id,
      },
      update: {
        status: input.status,
        modifier: input.modifier,
        markedById: actor.id,
      },
      select: { status: true, modifier: true },
    });

    await tx.attendanceEvent.create({
      data: {
        organizationId,
        userId: input.userId,
        date,
        fromStatus: previous?.status ?? null,
        fromModifier: previous?.modifier ?? null,
        toStatus: row.status,
        toModifier: row.modifier,
        actorId: actor.id,
      },
    });

    return { status: row.status, modifier: row.modifier };
  });
}

/**
 * Unmark a day.
 *
 * A no-op on a day that has no row: the caller asked for it to be unmarked and
 * it is, so raising a 404 would only make the grid's toggle harder to use.
 * Nothing is logged in that case either — there was no change.
 */
export async function clearAttendance(
  actor: Actor,
  input: { userId: string; date: string },
): Promise<void> {
  assertMarkable(input.date);
  const { organizationId } = await assertMarkableMember(actor, input.userId);

  const date = toDbDate(input.date);

  await prisma.$transaction(async (tx) => {
    const previous = await tx.attendance.findUnique({
      where: { userId_date: { userId: input.userId, date } },
      select: { status: true, modifier: true },
    });
    if (!previous) return;

    await tx.attendance.delete({
      where: { userId_date: { userId: input.userId, date } },
    });

    await tx.attendanceEvent.create({
      data: {
        organizationId,
        userId: input.userId,
        date,
        fromStatus: previous.status,
        fromModifier: previous.modifier,
        toStatus: null,
        toModifier: null,
        actorId: actor.id,
      },
    });
  });
}

/**
 * One button press on the grid.
 *
 * The next state is computed by `toggle` in lib/attendance.ts — the same pure
 * function the unit tests pin — so the screen's behaviour and the stored rules
 * cannot drift apart. Returns the new state, or `null` when the press cleared
 * the day.
 */
export async function toggleAttendanceCode(
  actor: Actor,
  input: { userId: string; date: string; code: AttendanceCode },
): Promise<AttendanceState | null> {
  assertMarkable(input.date);
  await assertMarkableMember(actor, input.userId);

  const current = await prisma.attendance.findUnique({
    where: { userId_date: { userId: input.userId, date: toDbDate(input.date) } },
    select: { status: true, modifier: true },
  });

  const next = toggle(current ?? null, input.code);

  if (!next) {
    await clearAttendance(actor, { userId: input.userId, date: input.date });
    return null;
  }

  return setAttendance(actor, {
    userId: input.userId,
    date: input.date,
    status: next.status,
    modifier: next.modifier,
  });
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
npx vitest run tests/attendance.integration.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add lib/attendance-service.ts tests/attendance.integration.test.ts
git commit -m "Write, clear and toggle attendance with an audit trail"
```

---

### Task 6: Mark all present

**Files:**
- Modify: `lib/attendance-service.ts`
- Test: `tests/attendance.integration.test.ts` (extend)

**Interfaces:**
- Consumes: Task 5's helpers.
- Produces: `markEveryonePresent(actor: Actor, date: string): Promise<{ filled: number; skipped: number }>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/attendance.integration.test.ts`:

```ts
const { markEveryonePresent } = await import("@/lib/attendance-service");

describe("markEveryonePresent", () => {
  it("fills only the people with no mark, leaving the rest alone", async () => {
    const other = await prisma.user.create({
      data: {
        name: "Run Second",
        email: email("second"),
        passwordHash: "x",
        role: Role.MEMBER,
        organizationId: orgId,
      },
    });

    // memberId already carries a deliberate absence on this day.
    await setAttendance(adminActor(), {
      userId: memberId,
      date: "2026-08-27",
      status: "ABSENT",
      modifier: null,
    });

    const result = await markEveryonePresent(adminActor(), "2026-08-27");

    expect(result).toEqual({ filled: 1, skipped: 1 });

    const kept = await prisma.attendance.findUnique({
      where: { userId_date: { userId: memberId, date: new Date("2026-08-27") } },
    });
    expect(kept?.status).toBe("ABSENT");

    const added = await prisma.attendance.findUnique({
      where: { userId_date: { userId: other.id, date: new Date("2026-08-27") } },
    });
    expect(added?.status).toBe("PRESENT");
    expect(added?.modifier).toBeNull();
  });

  it("is a no-op the second time", async () => {
    const result = await markEveryonePresent(adminActor(), "2026-08-27");
    expect(result).toEqual({ filled: 0, skipped: 2 });
  });

  it("logs one audit event per row it created", async () => {
    const events = await prisma.attendanceEvent.findMany({
      where: { organizationId: orgId, date: new Date("2026-08-27"), fromStatus: null },
    });
    expect(events).toHaveLength(1);
  });

  it("refuses a future date", async () => {
    await expect(markEveryonePresent(adminActor(), "2099-01-01")).rejects.toMatchObject(
      { status: 400 },
    );
  });

  it("refuses a member and a superadmin", async () => {
    await expect(
      markEveryonePresent(
        { id: memberId, role: Role.MEMBER, organizationId: orgId },
        "2026-08-27",
      ),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      markEveryonePresent(
        { id: "s1", role: Role.SUPERADMIN, organizationId: null },
        "2026-08-27",
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/attendance.integration.test.ts
```

Expected: FAIL — `markEveryonePresent is not a function`.

- [ ] **Step 3: Add it to `lib/attendance-service.ts`**

```ts
/**
 * Fill the gaps on a day with a plain Present.
 *
 * Only the people with no row are touched: a half day, an absence or a day of
 * leave already recorded is deliberate work, and a bulk button must not erase
 * it. That also makes the action idempotent — clicking it twice changes
 * nothing the second time.
 *
 * Not `createMany({ skipDuplicates: true })`, which would be one statement but
 * would not say *which* rows it created, and every created row needs an audit
 * event. The gap is computed first instead, inside the transaction.
 */
export async function markEveryonePresent(
  actor: Actor,
  date: string,
): Promise<{ filled: number; skipped: number }> {
  assertMarkable(date);

  if (actor.role !== Role.ADMIN || !actor.organizationId) {
    throw new HttpError(403, "Only an organization admin can mark attendance.");
  }
  const organizationId = actor.organizationId;
  const day = toDbDate(date);

  return prisma.$transaction(async (tx) => {
    const members = await tx.user.findMany({
      where: {
        organizationId,
        role: Role.MEMBER,
        status: EmploymentStatus.ACTIVE,
      },
      select: { id: true },
    });

    const marked = await tx.attendance.findMany({
      where: { organizationId, date: day },
      select: { userId: true },
    });
    const already = new Set(marked.map((m) => m.userId));
    const gaps = members.filter((m) => !already.has(m.id));

    if (gaps.length > 0) {
      await tx.attendance.createMany({
        data: gaps.map((m) => ({
          userId: m.id,
          organizationId,
          date: day,
          status: AttendanceStatus.PRESENT,
          modifier: null,
          markedById: actor.id,
        })),
      });

      await tx.attendanceEvent.createMany({
        data: gaps.map((m) => ({
          organizationId,
          userId: m.id,
          date: day,
          fromStatus: null,
          fromModifier: null,
          toStatus: AttendanceStatus.PRESENT,
          toModifier: null,
          actorId: actor.id,
        })),
      });
    }

    return { filled: gaps.length, skipped: members.length - gaps.length };
  });
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
npx vitest run tests/attendance.integration.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add lib/attendance-service.ts tests/attendance.integration.test.ts
git commit -m "Add mark-all-present, filling only unmarked people"
```

---

### Task 7: The route handlers

**Files:**
- Create: `lib/attendance-input.ts`
- Create: `app/api/attendance/route.ts`
- Create: `app/api/attendance/[userId]/[date]/route.ts`
- Create: `app/api/attendance/mark-all-present/route.ts`
- Test: `tests/attendance.integration.test.ts` (extend)

**Interfaces:**
- Consumes: the whole service from Tasks 4–6; `errorResponse`, `readJson` from `@/lib/api`; `currentActor` from `@/lib/auth`; `requireActor` from `@/lib/rbac`.
- Produces: `statusFrom(body): AttendanceStatus`, `modifierFrom(body): AttendanceModifier | null`, `codeFrom(value): AttendanceCode` in `lib/attendance-input.ts`; the five endpoints of §4.1.

- [ ] **Step 1: Write the failing tests**

Append to `tests/attendance.integration.test.ts`. Note the `vi.mock` of `@/lib/auth` must sit at the **top** of the file, before the `await import` lines — move it there when adding this block:

```ts
const attendanceRoute = await import("@/app/api/attendance/route");
const dayRoute = await import("@/app/api/attendance/[userId]/[date]/route");
const bulkRoute = await import("@/app/api/attendance/mark-all-present/route");

const get = (query = "") =>
  new Request(`http://localhost/api/attendance${query ? `?${query}` : ""}`);
const put = (body: unknown) =>
  new Request("http://localhost/api/attendance", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const post = (body: unknown) =>
  new Request("http://localhost/api/attendance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const del = () => new Request("http://localhost/api/attendance", { method: "DELETE" });
const dayCtx = (userId: string, date: string) => ({
  params: Promise.resolve({ userId, date }),
});
const actingAs = (actor: Actor | null) => {
  actorRef.current = actor;
};

describe("GET /api/attendance", () => {
  it("401s when nobody is signed in", async () => {
    actingAs(null);
    expect((await attendanceRoute.GET(get("date=2026-08-18"))).status).toBe(401);
  });

  it("403s a member", async () => {
    actingAs({ id: memberId, role: Role.MEMBER, organizationId: orgId });
    expect((await attendanceRoute.GET(get("date=2026-08-18"))).status).toBe(403);
  });

  it("400s without a date or a span", async () => {
    actingAs(adminActor());
    expect((await attendanceRoute.GET(get())).status).toBe(400);
  });

  it("returns the day for an admin", async () => {
    actingAs(adminActor());
    const response = await attendanceRoute.GET(get("date=2026-08-18"));
    expect(response.status).toBe(200);

    const body = await response.json();
    const mine = body.find((r: { member: { id: string } }) => r.member.id === memberId);
    expect(mine.state).toEqual({ status: "WFH", modifier: "SHORT_LEAVE" });
  });
});

describe("PUT /api/attendance/[userId]/[date]", () => {
  it("stores a combination", async () => {
    actingAs(adminActor());
    const response = await dayRoute.PUT(
      put({ status: "PRESENT", modifier: "SHORT_LEAVE" }),
      dayCtx(memberId, "2026-08-28"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "PRESENT",
      modifier: "SHORT_LEAVE",
    });
  });

  it("400s an unknown status", async () => {
    actingAs(adminActor());
    const response = await dayRoute.PUT(
      put({ status: "HOLIDAY" }),
      dayCtx(memberId, "2026-08-28"),
    );
    expect(response.status).toBe(400);
  });

  it("400s an invalid combination", async () => {
    actingAs(adminActor());
    const response = await dayRoute.PUT(
      put({ status: "LEAVE", modifier: "HALF_DAY" }),
      dayCtx(memberId, "2026-08-28"),
    );
    expect(response.status).toBe(400);
  });

  it("400s a future date", async () => {
    actingAs(adminActor());
    const response = await dayRoute.PUT(
      put({ status: "PRESENT" }),
      dayCtx(memberId, "2099-01-01"),
    );
    expect(response.status).toBe(400);
  });

  it("403s an admin from another organization", async () => {
    actingAs({ id: "x", role: Role.ADMIN, organizationId: "another-org" });
    const response = await dayRoute.PUT(
      put({ status: "PRESENT" }),
      dayCtx(memberId, "2026-08-28"),
    );
    expect(response.status).toBe(403);
  });
});

describe("DELETE /api/attendance/[userId]/[date]", () => {
  it("clears the day", async () => {
    actingAs(adminActor());
    const response = await dayRoute.DELETE(del(), dayCtx(memberId, "2026-08-28"));
    expect(response.status).toBe(204);

    const row = await prisma.attendance.findUnique({
      where: { userId_date: { userId: memberId, date: new Date("2026-08-28") } },
    });
    expect(row).toBeNull();
  });
});

describe("POST /api/attendance/mark-all-present", () => {
  it("reports how many gaps it closed", async () => {
    actingAs(adminActor());
    const response = await bulkRoute.POST(post({ date: "2026-08-31" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ filled: 2, skipped: 0 });
  });

  it("403s a member", async () => {
    actingAs({ id: memberId, role: Role.MEMBER, organizationId: orgId });
    expect((await bulkRoute.POST(post({ date: "2026-08-31" }))).status).toBe(403);
  });
});
```

And at the very top of the file, above every `await import`:

```ts
import { vi } from "vitest";

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
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/attendance.integration.test.ts
```

Expected: FAIL — `Cannot find module '@/app/api/attendance/route'`.

- [ ] **Step 3: Write `lib/attendance-input.ts`**

```ts
import { AttendanceModifier, AttendanceStatus } from "@/generated/prisma/enums";
import type { AttendanceCode } from "@/lib/attendance";
import { HttpError } from "@/lib/rbac";

/**
 * Parsing attendance input, shared by the route handlers and the Server
 * Actions — the same rule `lib/member-input.ts` follows for Team, so a form
 * post and a JSON call cannot drift apart on field names or coercion.
 */

const STATUSES = Object.values(AttendanceStatus);
const MODIFIERS = Object.values(AttendanceModifier);

export function statusFrom(body: Record<string, unknown>): AttendanceStatus {
  const value = body["status"];
  if (typeof value !== "string" || !STATUSES.includes(value as AttendanceStatus)) {
    throw new HttpError(400, `"status" must be one of: ${STATUSES.join(", ")}.`);
  }
  return value as AttendanceStatus;
}

/** Absent, null and "" all mean "no add-on". */
export function modifierFrom(
  body: Record<string, unknown>,
): AttendanceModifier | null {
  const value = body["modifier"];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !MODIFIERS.includes(value as AttendanceModifier)) {
    throw new HttpError(
      400,
      `"modifier" must be one of: ${MODIFIERS.join(", ")}, or omitted.`,
    );
  }
  return value as AttendanceModifier;
}

/** One grid button: any status or any modifier. */
export function codeFrom(value: unknown, field = "code"): AttendanceCode {
  if (
    typeof value !== "string" ||
    !(
      STATUSES.includes(value as AttendanceStatus) ||
      MODIFIERS.includes(value as AttendanceModifier)
    )
  ) {
    throw new HttpError(
      400,
      `"${field}" must be one of: ${[...STATUSES, ...MODIFIERS].join(", ")}.`,
    );
  }
  return value as AttendanceCode;
}
```

- [ ] **Step 4: Write `app/api/attendance/route.ts`**

```ts
import { errorResponse } from "@/lib/api";
import { parseDateParam } from "@/lib/attendance";
import { listDayAttendance, listRangeAttendance } from "@/lib/attendance-service";
import { currentActor } from "@/lib/auth";
import { HttpError, requireActor } from "@/lib/rbac";

/**
 * Attendance reads.
 *
 * Two shapes on one path: `?date=` is the grid's day, `?from=&to=` is a span
 * for a calendar or a report. They answer different shapes, so asking for both
 * or neither is a 400 rather than a guess.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const params = new URL(request.url).searchParams;

    const date = params.get("date");
    const from = params.get("from");
    const to = params.get("to");

    if (date && (from || to)) {
      throw new HttpError(400, 'Use either "date" or "from"/"to", not both.');
    }

    if (date) {
      return Response.json(
        await listDayAttendance(actor, parseDateParam(date, "date")),
      );
    }

    if (from || to) {
      return Response.json(
        await listRangeAttendance(actor, {
          from: parseDateParam(from, "from"),
          to: parseDateParam(to, "to"),
          userId: params.get("userId")?.trim() || undefined,
        }),
      );
    }

    throw new HttpError(400, 'Pass "date", or "from" and "to".');
  } catch (error) {
    return errorResponse(error);
  }
}
```

- [ ] **Step 5: Write `app/api/attendance/[userId]/[date]/route.ts`**

```ts
import { errorResponse, readJson } from "@/lib/api";
import { parseDateParam } from "@/lib/attendance";
import { clearAttendance, setAttendance } from "@/lib/attendance-service";
import { modifierFrom, statusFrom } from "@/lib/attendance-input";
import { currentActor } from "@/lib/auth";
import { requireActor } from "@/lib/rbac";

/**
 * One member's one day, addressed by its natural key.
 *
 * PUT rather than PATCH: a day is a status and an optional modifier, and there
 * is no partial update of two fields that a whole-value write does not
 * already express. Clearing a day is DELETE, not a PUT of null — the absence
 * of a row is what "not marked yet" is stored as.
 */

type Ctx = { params: Promise<{ userId: string; date: string }> };

export async function PUT(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const { userId, date } = await ctx.params;
    const body = await readJson(request);

    return Response.json(
      await setAttendance(actor, {
        userId,
        date: parseDateParam(date, "date"),
        status: statusFrom(body),
        modifier: modifierFrom(body),
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, ctx: Ctx): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const { userId, date } = await ctx.params;

    await clearAttendance(actor, { userId, date: parseDateParam(date, "date") });
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
```

- [ ] **Step 6: Write `app/api/attendance/mark-all-present/route.ts`**

```ts
import { errorResponse, readJson } from "@/lib/api";
import { parseDateParam } from "@/lib/attendance";
import { markEveryonePresent } from "@/lib/attendance-service";
import { currentActor } from "@/lib/auth";
import { requireActor } from "@/lib/rbac";

/**
 * Fill a day's gaps with Present.
 *
 * One segment deep, so it cannot be shadowed by the two-segment
 * `[userId]/[date]` route beside it.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const body = await readJson(request);

    return Response.json(
      await markEveryonePresent(actor, parseDateParam(body["date"], "date")),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
```

- [ ] **Step 7: Run them and watch them pass**

```bash
npx vitest run tests/attendance.integration.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 8: Commit**

```bash
git add lib/attendance-input.ts app/api/attendance tests/attendance.integration.test.ts
git commit -m "Add the /api/attendance endpoints"
```

---

### Task 8: The screen, the Server Actions and the seed

**Files:**
- Create: `lib/attendance-actions.ts`
- Modify: `app/(leave)/attendance/page.tsx`
- Modify: `components/date-nav.tsx`
- Modify: `prisma/seed.ts`
- Test: manual verification (below) plus the full suite

**Interfaces:**
- Consumes: `toggleAttendanceCode`, `markEveryonePresent`, `listDayAttendance` (Tasks 4–6); `codeFrom` (Task 7); `todayIso`, `isFutureDate`, `parseDateParam`, `ATTENDANCE_CODES`, `codeLabel`, `describeState`, `isActiveCode` (Task 2).
- Produces: `markAttendanceAction(form: FormData): Promise<void>`, `markEveryonePresentAction(form: FormData): Promise<void>`.

- [ ] **Step 1: Write `lib/attendance-actions.ts`**

```ts
"use server";

import { refresh } from "next/cache";

import { parseDateParam } from "@/lib/attendance";
import { codeFrom } from "@/lib/attendance-input";
import { markEveryonePresent, toggleAttendanceCode } from "@/lib/attendance-service";
import { currentActor } from "@/lib/auth";
import { backWithError, field } from "@/lib/form";
import { requireActor } from "@/lib/rbac";

/**
 * Server Actions behind the attendance grid.
 *
 * Same contract as lib/team-actions.ts: re-authenticate rather than trusting
 * proxy.ts, because a Server Action is a POST to the page's own path and a
 * matcher change could remove that gate without any code here changing.
 * Authorization lives in lib/attendance-service.ts, shared with
 * /api/attendance.
 *
 * On success these call `refresh()` and return rather than redirecting, so the
 * selected date and the scroll position survive a click. Only a failure
 * navigates, carrying the message as `?error=`.
 */

export async function markAttendanceAction(form: FormData): Promise<void> {
  const date = field(form, "date");

  try {
    const actor = requireActor(await currentActor());
    await toggleAttendanceCode(actor, {
      userId: field(form, "userId"),
      date: parseDateParam(date, "date"),
      code: codeFrom(field(form, "code")),
    });
  } catch (error) {
    backWithError(`/attendance?date=${encodeURIComponent(date)}`, error);
  }

  refresh();
}

export async function markEveryonePresentAction(form: FormData): Promise<void> {
  const date = field(form, "date");

  try {
    const actor = requireActor(await currentActor());
    await markEveryonePresent(actor, parseDateParam(date, "date"));
  } catch (error) {
    backWithError(`/attendance?date=${encodeURIComponent(date)}`, error);
  }

  refresh();
}
```

- [ ] **Step 2: Give `DateNav` a ceiling**

In `components/date-nav.tsx`, add a `max` prop and pass it through to the input, so the picker cannot offer a future day:

```tsx
export function DateNav({
  value,
  param = "date",
  className = "",
  id,
  max,
}: {
  value: string;
  param?: string;
  className?: string;
  id?: string;
  /** Latest selectable day, `YYYY-MM-DD`. The server re-checks it regardless. */
  max?: string;
}) {
```

and on the element:

```tsx
    <input
      id={id}
      type="date"
      value={value}
      max={max}
      disabled={pending}
```

- [ ] **Step 3: Rewrite `app/(leave)/attendance/page.tsx`**

```tsx
import { PageHeader } from "@/components/page-header";
import { DateNav } from "@/components/date-nav";
import { Avatar, Card, EmptyPanel, inputClass, primaryButtonClass } from "@/components/ui";
import { WorkMode } from "@/generated/prisma/enums";
import {
  ATTENDANCE_CODES,
  codeLabel,
  describeState,
  isActiveCode,
  isFutureDate,
  todayIso,
} from "@/lib/attendance";
import {
  markAttendanceAction,
  markEveryonePresentAction,
} from "@/lib/attendance-actions";
import {
  listDayAttendance,
  type AttendanceDayRow,
} from "@/lib/attendance-service";
import { formatHeader, formatLong, isValidDate, isWeekend } from "@/lib/date";
import { requirePageActor } from "@/lib/page-guards";
import { ATTENDANCE_STYLE } from "@/lib/ui";

/**
 * Admin: mark the day for the organization's roster.
 *
 * Reads `orgapp.Attendance` through lib/attendance-service.ts — the same
 * functions `/api/attendance` calls — so the screen and the API cannot drift.
 *
 * The date defaults to today and is clamped: a future day is refused by the
 * service, and this page does not offer the buttons for one either.
 */

const MODES: { key: WorkMode; label: string }[] = [
  { key: WorkMode.WFO, label: "Work from office" },
  { key: WorkMode.WFH, label: "Work from home" },
];

/**
 * Status counts sum to headcount; the two add-on counts deliberately overlap
 * them, so they are rendered as a separate, labelled row rather than mixed
 * into one line that appears not to add up.
 */
function summarize(rows: AttendanceDayRow[]) {
  const status = { PRESENT: 0, WFH: 0, ABSENT: 0, LEAVE: 0 };
  const modifier = { HALF_DAY: 0, SHORT_LEAVE: 0 };
  let unmarked = 0;

  for (const row of rows) {
    if (!row.state) {
      unmarked++;
      continue;
    }
    status[row.state.status]++;
    if (row.state.modifier) modifier[row.state.modifier]++;
  }

  return { status, modifier, unmarked };
}

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; error?: string }>;
}) {
  const actor = await requirePageActor();
  const params = await searchParams;

  const today = todayIso();
  const requested =
    params.date && isValidDate(params.date) ? params.date : today;
  // A future date in the URL falls back to today rather than erroring: the
  // page is linkable, and a stale link should still open on something useful.
  const date = isFutureDate(requested, today) ? today : requested;

  const rows = await listDayAttendance(actor, date);
  const counts = summarize(rows);

  return (
    <>
      <PageHeader
        title="Attendance"
        subtitle="Mark the day for everyone. Today and any past day can be corrected."
        meta={formatHeader(date)}
      />

      {params.error ? (
        <p className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-2.5 text-[13px] text-warn-ink">
          {params.error}
        </p>
      ) : null}

      <div className="flex max-w-[900px] flex-col gap-5">
        <Card className="flex flex-wrap items-center gap-5 px-5 py-4.5">
          <label
            className="flex flex-col gap-1.5 font-mono text-[11px] tracking-[0.06em] text-muted"
            htmlFor="attendance-date"
          >
            DATE
            <DateNav
              id="attendance-date"
              value={date}
              max={today}
              className={inputClass}
            />
          </label>

          <span className="flex flex-1 flex-col gap-1.5">
            <span className="text-[15px] font-semibold">{formatLong(date)}</span>

            <span className="flex flex-wrap gap-2">
              {(["PRESENT", "WFH", "ABSENT", "LEAVE"] as const).map((code) => (
                <span
                  key={code}
                  className={`flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-xs ${ATTENDANCE_STYLE[code].chip}`}
                >
                  <span className="font-mono font-semibold">{counts.status[code]}</span>
                  {codeLabel(code)}
                </span>
              ))}
              <span className="flex items-center gap-1.5 rounded-full bg-line px-2.5 py-[3px] text-xs text-muted">
                <span className="font-mono font-semibold">{counts.unmarked}</span>
                Unmarked
              </span>
            </span>

            <span className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
              of whom
              {(["HALF_DAY", "SHORT_LEAVE"] as const).map((code) => (
                <span
                  key={code}
                  className={`flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-xs ${ATTENDANCE_STYLE[code].chip}`}
                >
                  <span className="font-mono font-semibold">
                    {counts.modifier[code]}
                  </span>
                  {codeLabel(code)}
                </span>
              ))}
            </span>
          </span>

          <form action={markEveryonePresentAction}>
            <input type="hidden" name="date" value={date} />
            <button
              type="submit"
              className={`${primaryButtonClass} whitespace-nowrap`}
            >
              Mark all present
            </button>
          </form>
        </Card>

        {isWeekend(date) ? (
          <div className="rounded-[10px] border border-warn-line bg-warn-tint px-4 py-3 text-[13px] text-warn-ink">
            That&apos;s a weekend — most agencies leave it unmarked.
          </div>
        ) : null}

        {rows.length === 0 ? (
          <EmptyPanel>
            No team members yet. Add people on the Team screen and they will
            appear here.
          </EmptyPanel>
        ) : null}

        {MODES.map((mode) => {
          // A member with no work mode set is treated as office-based, which is
          // the default an agency assumes.
          const inMode = rows.filter(
            (row) => (row.member.workMode ?? WorkMode.WFO) === mode.key,
          );
          if (inMode.length === 0) return null;

          return (
            <section key={mode.key} className="flex flex-col gap-2.5">
              <h2 className="text-[15px] font-semibold tracking-[-0.01em]">
                {mode.label}
              </h2>

              <Card className="overflow-hidden">
                {inMode.map(({ member, state }) => (
                  <div
                    key={member.id}
                    className="flex flex-wrap items-center gap-4 border-b border-line px-4.5 py-3.5 last:border-b-0"
                  >
                    <Avatar initials={initialsFor(member.name)} size={32} />
                    <span className="flex flex-1 flex-col gap-0.5">
                      <span className="text-sm font-semibold">{member.name}</span>
                      <span className="text-xs text-muted">
                        {describeState(state)}
                      </span>
                    </span>

                    <span
                      className="flex flex-wrap gap-1.5"
                      role="group"
                      aria-label={`Attendance for ${member.name}`}
                    >
                      {ATTENDANCE_CODES.map((code) => {
                        const active = isActiveCode(state, code);
                        const style = ATTENDANCE_STYLE[code];
                        return (
                          <form key={code} action={markAttendanceAction}>
                            <input type="hidden" name="userId" value={member.id} />
                            <input type="hidden" name="date" value={date} />
                            <input type="hidden" name="code" value={code} />
                            <button
                              type="submit"
                              aria-pressed={active}
                              className={`cursor-pointer rounded-[7px] border px-3 py-1.5 text-[12.5px] transition-colors ${
                                active
                                  ? `${style.chip} ${style.border}`
                                  : "border-line bg-surface text-muted hover:border-muted"
                              }`}
                            >
                              {codeLabel(code)}
                            </button>
                          </form>
                        );
                      })}
                    </span>
                  </div>
                ))}
              </Card>
            </section>
          );
        })}
      </div>
    </>
  );
}
```

Add `import { initialsFor } from "@/lib/domain";` to the imports — it is a pure helper with no fixture dependency.

- [ ] **Step 4: Re-key `ATTENDANCE_STYLE` in `lib/ui.ts`**

The new page indexes the palette by the Prisma enum values (`PRESENT`, `HALF_DAY`, …), while five fixture screens still index it by the lowercase codes in `lib/types.ts` (`present`, `half`, …). Both have to work until those screens migrate, so `lib/ui.ts` carries two objects for one release.

`todayPill` in the same file, and the fixture screens that call it, still use the old lowercase codes. Do not migrate them here. Instead:

1. **Rename** the existing export in place — change the declaration line from `export const ATTENDANCE_STYLE: Record<AttendanceCode, …>` (the `AttendanceCode` from `@/lib/types`) to `export const LEGACY_ATTENDANCE_STYLE`, leaving all six lowercase entries and their values byte-for-byte unchanged, and give it this comment:

```ts
/**
 * The fixture screens' palette, keyed by the lowercase codes in lib/types.ts.
 * Deleted when those screens move to real data. ATTENDANCE_STYLE below is the
 * one keyed by the database enums.
 */
```

2. **Add** the new export beside it, keyed by the Prisma enums. The colour values are copied from their lowercase counterparts — `WFH` shares `PRESENT`'s green in the current palette, which is deliberate:

```ts
import type { AttendanceCode } from "@/lib/attendance";

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
```

There is no `label` key: `codeLabel` in `lib/attendance.ts` owns the wording now, so it cannot disagree between the button and the pill. Copy the `LEAVE` and `SHORT_LEAVE` colour values from the existing `leave` and `short` entries rather than the literals above if they have since changed.

3. **Point the old callers at the old name.** Change `todayPill` in `lib/ui.ts` to read `LEGACY_ATTENDANCE_STYLE`, then let `npx tsc --noEmit` find every other `ATTENDANCE_STYLE` / `ATTENDANCE_ORDER` reference and repoint it the same way. `ATTENDANCE_ORDER` itself stays — the fixture screens iterate it; the new screen uses `ATTENDANCE_CODES`.

- [ ] **Step 5: Seed a fortnight of attendance**

`prisma/seed.ts` seeds **at most one** member, and only when `STACX_MEMBER_EMAIL` and `STACX_MEMBER_PASSWORD` are set (`memberConfig()`). So this function must not take a member list from the caller — it reads whichever members the organization actually has, and does nothing when there are none. Note the file uses **relative** imports, not the `@/` alias.

Add to the imports at the top:

```ts
import { AttendanceModifier, AttendanceStatus, Role, WorkMode } from "../generated/prisma/enums";
import { todayIso } from "../lib/attendance";
```

(`Role` and `WorkMode` are already imported from that path — extend the existing line rather than adding a second one.)

Add this function above `main`:

```ts
/**
 * A fortnight of attendance for the seeded organization, so a fresh database
 * renders a populated grid rather than a column of "Not marked yet".
 *
 * Reads the roster rather than taking one, because the sample member is
 * optional (`memberConfig`) — with none configured this writes nothing and
 * says so. Weekdays only, ending today, with a rotating exception so the grid
 * shows more than one state.
 *
 * Idempotent: `skipDuplicates` against the `[userId, date]` unique index means
 * re-running the seed changes nothing. Deliberately outside the main
 * transaction — it is demo colour, and failing it should not roll back the
 * organization and its admin.
 */
async function seedAttendance(
  organizationId: string,
  adminId: string,
): Promise<number> {
  const members = await prisma.user.findMany({
    where: { organizationId, role: Role.MEMBER },
    select: { id: true },
  });
  if (members.length === 0) return 0;

  const today = new Date(`${todayIso()}T00:00:00.000Z`);
  const rows = [];

  let weekdays = 0;
  for (let back = 0; weekdays < 10 && back < 30; back++) {
    const date = new Date(today);
    date.setUTCDate(date.getUTCDate() - back);

    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    weekdays++;

    members.forEach((member, index) => {
      const slot = (weekdays + index) % 7;

      const status =
        slot === 3
          ? AttendanceStatus.WFH
          : slot === 5
            ? AttendanceStatus.ABSENT
            : AttendanceStatus.PRESENT;

      const modifier =
        slot === 1
          ? AttendanceModifier.HALF_DAY
          : slot === 4
            ? AttendanceModifier.SHORT_LEAVE
            : null;

      rows.push({
        userId: member.id,
        organizationId,
        date,
        status,
        // The CHECK constraint: an absence carries no add-on.
        modifier: status === AttendanceStatus.ABSENT ? null : modifier,
        markedById: adminId,
      });
    });
  }

  const { count } = await prisma.attendance.createMany({
    data: rows,
    skipDuplicates: true,
  });
  return count;
}
```

Call it in `main`, after the `prisma.$transaction(...)` block that produces `seeded` and before the `console.log` lines:

```ts
  const attendanceRows = await seedAttendance(seeded.organization.id, seeded.admin.id);
```

and add one more line to the output, after the "Member:" logging:

```ts
  console.log(
    attendanceRows > 0
      ? `Attendance: ${attendanceRows} rows across the last 10 weekdays.`
      : "Attendance: skipped (no members in this organization).",
  );
```

`tests/scripts.integration.test.ts` points the seed at a throwaway organization; `skipDuplicates` and the empty-roster guard keep it safe there. Re-run that file as part of Step 6.

- [ ] **Step 6: Run the whole suite and the linter**

```bash
npm test
npm run lint
npx tsc --noEmit
```

Expected: all green. `tsc` catches any screen still importing the renamed `ATTENDANCE_STYLE` keys or `ATTENDANCE_ORDER`.

- [ ] **Step 7: Verify in the running app**

```bash
docker compose up -d
npx prisma migrate deploy
npm run seed
npm run dev
```

Then sign in as the demo admin at `http://localhost:3000/login` and check each of these on `/attendance`:

1. The page opens on **today's** date, and the header caption on the right matches the date in the card (D1, D3).
2. The date input will not offer a future day, and `?date=2099-01-01` falls back to today.
3. Clicking `Half day` on an unmarked person sets **Present + Half day**; the note under their name says so.
4. Clicking `WFH` then keeps the half day: **WFH + Half day**.
5. Clicking `Short leave` replaces the half day, never stacks with it.
6. Clicking `Absent` clears both; clicking `Absent` again unmarks the day entirely.
7. The status pills sum to headcount; the "of whom" row shows the add-ons (D4).
8. Set someone Absent, then click **Mark all present**: everyone else becomes Present and the absence survives.
9. Click **Mark all present** a second time — nothing changes.
10. A member with `workMode = WFH` on the Team screen appears under **Work from home**, not under the office heading (D2).
11. Change the date to a past weekday: the marks for that day load, and edits stick after a reload.
12. Sign in as the demo member: `/attendance` redirects to `/overview`.

- [ ] **Step 8: Retire the demo path**

Delete `demoMarkAttendance`, `demoMarkEveryonePresent` and the `attendanceHref` helper from `lib/demo-actions.ts`, and drop the `mark` and `present` entries from `MESSAGES` in `components/demo-banner.tsx`. Leave the rest — the other screens still use them.

- [ ] **Step 9: Commit**

```bash
git add app/\(leave\)/attendance/page.tsx lib/attendance-actions.ts lib/ui.ts components/date-nav.tsx components/demo-banner.tsx lib/demo-actions.ts prisma/seed.ts
git commit -m "Move the Attendance screen onto real org-scoped data"
```

---

## 6. Verification

| Check | Command |
|-------|---------|
| Unit rules | `npx vitest run tests/attendance.test.ts tests/rbac.test.ts` |
| Endpoints and policy | `npx vitest run tests/attendance.integration.test.ts` |
| Whole suite | `npm test` |
| Types | `npx tsc --noEmit` |
| Lint | `npm run lint` |
| The constraint really exists | `docker compose exec -T db psql -U postgres -c '\d orgapp."Attendance"'` |
| Migration replays on an empty database | `docker compose down -v && docker compose up -d && npx prisma migrate deploy` |
| The screen | Task 8, Step 7 |

---

## 7. What is still fixture after this, and why

- **"Approved leave fills itself in."** The current screen infers `leave` from `db.requests`. There is no `LeaveRequest` table in Prisma, so after this pass `LEAVE` is a status an admin sets by hand. Restoring the auto-fill is a two-line change in `listDayAttendance` once leave requests are real — read the approved requests covering the date and use them where `state` is `null`.
- **`/approvals`, `/setup`, `/scores`** and every `(member)` screen still render `seedDb()`. Untouched here.
- **`lib/store.ts`, `lib/actions.ts`, `lib/db.ts`** still target the dropped `public` tables. This plan does not revive them; it routes around them. They can be deleted once the last screen leaves the fixture.
- **`TODAY` in `lib/date.ts`** stays at `2026-08-17` because the fixture screens are anchored to it. `/attendance` no longer reads it.
- **`attendanceMonth` / `attendanceStats` in `lib/domain.ts`** still take a fixture `Db`. The member calendar will need versions that take `AttendanceMark[]` from `listRangeAttendance` — the reason that function exists now.

## 8. Out of scope

- Member self-service check-in. Attendance is an employer's record; `canMarkAttendance` excludes MEMBER deliberately.
- Editing attendance for a member whose employment status is `INACTIVE`. The service refuses it; historical corrections for departed staff need a rule about how far back "still on the team" reaches.
- Approval workflow for a correction. The audit log records who changed what; nobody signs it off.
- Bulk import from a spreadsheet or a biometric device.
- A UI for reading `AttendanceEvent`. The rows are written and queryable; no screen shows them yet.
