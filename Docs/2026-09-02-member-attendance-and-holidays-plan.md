# Member Attendance and the Holiday Calendar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-09-02
**Status:** Proposed plan (pre-implementation)
**Goal:** Put `/calendar` on the signed-in member's own attendance, defaulting to the current month, with present / half-day / absent counts and a correct percentage — and give the organization a real, region-scoped holiday table with an API to load and maintain it.

**Architecture:** A new org-scoped `Holiday` table storing an inclusive `startDate`–`endDate` range with a nullable `regionId` (null = every region). Reads and writes go through `lib/holiday-service.ts` behind `/api/holidays`, mirroring the Team and Attendance stack. The member calendar reads its own attendance through a new `listOwnMonth` that takes no user id at all — the member is the session — and both the grid and the four stat cards are computed by one pure module so they cannot disagree.

**Tech Stack:** Next.js 16.3.2 (App Router, Route Handlers), React 19.2, Prisma 7 with `@prisma/adapter-pg`, PostgreSQL, Auth.js v5, Vitest 4, Tailwind 4.

**Spec:** This document. Builds on
[`2026-09-02-attendance-real-data-plan.md`](./2026-09-02-attendance-real-data-plan.md) and
[`2026-09-01-team-real-data-plan.md`](./2026-09-01-team-real-data-plan.md).

## Global Constraints

- Models live in the **`orgapp`** Postgres schema, set by the `schema` parameter on the connection URL (`lib/prisma-url.ts`). No `@@schema` attribute, no `multiSchema` preview feature.
- Every migration statement is **schema-qualified by hand** (`"orgapp"."Holiday"`). `prisma migrate diff` emits bare names, which would land in `public` on a fresh database.
- Dates are **`YYYY-MM-DD` strings** above the database and `DATE` columns beneath it, converted with the existing `toDbDate` / `fromDbDate` in `lib/attendance.ts`. Prisma returns `DATE` at UTC midnight, so the round trip is exact.
- "Today" comes from `todayIso()` (`lib/attendance.ts`), which resolves in `Asia/Kolkata`. Never `new Date()` against a date string.
- Authorization is decided in `lib/rbac.ts` (pure predicates) and enforced in the service modules. Route handlers never decide policy.
- A member id is **never** accepted from a member's request. `listOwnMonth` derives it from the session, so there is no id to tamper with.
- Tests: `npm test` (Vitest, `fileParallelism: false`). Integration tests hit the Dockerized Postgres (`docker compose up -d`, service name **`postgres`**, user `leave`, database `leave_management`), namespace rows with a per-run prefix, and clean up in `afterAll`.
- Commit after every task.

---

## 1. Where things stand

`/calendar` is MEMBER-only and correctly gated — `proxy.ts` lists the prefix and `app/(member)/layout.tsx` calls `requirePageRole(Role.MEMBER)`. The gate is not the problem.

Four things are:

| # | Defect | Fixed in |
|---|--------|----------|
| C1 | The page renders `demoMember(db)` — a hardcoded `DEMO_MEMBER_ID = "u2"` (Dev Menon). Every real member sees a fixture person's attendance under their own name. Now that `/attendance` is real, the two screens actively contradict each other. | Task 7, Task 8 |
| C2 | The month defaults to `TODAY` (`"2026-08-17"`), so the page opens on **August** when it is September, and the fixture has no marks past the 17th. | Task 6, Task 8 |
| C3 | `attendanceStats` computes `worked = present + half * 0.5` over a denominator of every marked day, so a **WFH day counts exactly like an absence**. The 77% on screen today is that bug. | Task 6 |
| C4 | The grid calls `attendanceMonth` (resolved codes, with auto-fill) while the stat cards call `attendanceStats` (the raw record), so the two panels can describe the same month differently. | Task 6 — one module computes both |

Holidays have no table at all. `HOLIDAYS` in `lib/seed.ts` is eight hardcoded 2026 entries, and `db.holidayRegion` is a string that only round-trips through the URL.

---

## 2. The rules this implements

Confirmed with the product owner on 2026-09-02:

1. **The member sees their own attendance**, never anyone else's.
2. **The month defaults to the current month.**
3. **Days present, half days and absent** are shown for that month, alongside WFH.
4. **The percentage is computed over the days that were actually marked.** Unmarked and future days are excluded, so the figure is meaningful from the first of the month and cannot be dragged down by an admin's backlog.

   ```
   per day:  PRESENT or WFH  ->  1.0, or 0.5 if it carries HALF_DAY
             ABSENT          ->  0.0
             LEAVE           ->  excluded from both sides
             no mark         ->  excluded from both sides

   percent = round(sum of day values / number of counted days * 100)
   ```

   `SHORT_LEAVE` does not reduce the day: a couple of hours off is still a day worked. With no counted days the figure is `—`, not `0%`.

   **A day is scored once.** `PRESENT + HALF_DAY` is 0.5, not 1.0 + 0.5 — the naive "count each code and add" is exactly the shape of bug C3, so the value is computed per day, not per code.

5. **Holidays are shown according to the member's region.** A holiday with no region applies to every region in the organization.
6. **The holiday panel lists the whole year**, not just the displayed month, so it doubles as a leave-planning aid.
7. **Holidays have a real table and a full API** — list, create, update, delete, plus a bulk insert for loading a year in one call. Writes are admin-only and scoped to their own organization; members may read their own organization's list.

---

## 3. Database table required

### 3.1 New table — `Holiday`

```prisma
/// A public holiday for one organization, optionally narrowed to one region.
///
/// The range is inclusive and stored as two DATE columns rather than a start
/// plus a day count: "which holidays touch September" is then one indexed
/// predicate instead of an expansion in application code, which is what
/// `holidayDateMap()` has to do with the fixture today.
///
/// A null `regionId` means the holiday applies to every region in the
/// organization — the same rule the fixture expresses by omitting `region`.
model Holiday {
  id String @id @default(cuid())

  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  /// Null = every region in the organization.
  regionId String?
  region   Region? @relation(fields: [regionId], references: [id], onDelete: Cascade)

  name String

  /// Inclusive. A single-day holiday has startDate == endDate.
  startDate DateTime @db.Date
  endDate   DateTime @db.Date

  note String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([organizationId, startDate])
  @@index([regionId])
}
```

Plus the constraint Prisma cannot express:

```sql
ALTER TABLE "orgapp"."Holiday"
  ADD CONSTRAINT "Holiday_range_ordered" CHECK ("endDate" >= "startDate");
```

**On `onDelete: Cascade` for `regionId`:** deleting a region deletes the holidays that were specific to it. This is deliberate and differs from `User.regionId`, which is `SetNull`: a person outlives their office, but "Pongal, in the Chennai region" has no meaning once Chennai is gone — it would silently become an organization-wide holiday, which is worse than losing the row.

**No unique constraint.** Two regions legitimately have a holiday of the same name on the same date, and Postgres treats NULL `regionId` values as distinct anyway, so a unique index would be half-enforced and misleading. The bulk endpoint and the seed guard against duplicates by querying first (Tasks 4 and 8).

### 3.2 Changed tables

```prisma
// Organization
  holidays Holiday[]

// Region
  holidays Holiday[]
```

### 3.3 Deliberately NOT stored

- **A `year` column.** It is `startDate`'s year; a stored copy would drift on edit.
- **A weekend or working-day flag.** `isWeekend` in `lib/date.ts` derives it.
- **Whether a holiday was "taken".** Attendance already records the day. A holiday is a property of the calendar, not of a person.

---

## 4. APIs required

### 4.1 Holiday route handlers

| Method | Path | Body / query | Who | Answers |
|--------|------|--------------|-----|---------|
| `GET` | `/api/holidays` | `?year=`, `?region=<id>`, `?from=&to=` | ADMIN, MEMBER, SUPERADMIN | The organization's holidays, region-filtered |
| `POST` | `/api/holidays` | `{ name, startDate, endDate?, regionId?, note? }` | ADMIN (own org) | `201` and the created holiday |
| `POST` | `/api/holidays/bulk` | `{ holidays: [...] }` | ADMIN (own org) | `{ created, skipped }` — a year in one call |
| `PATCH` | `/api/holidays/[id]` | any subset of the above | ADMIN (own org) | The updated holiday |
| `DELETE` | `/api/holidays/[id]` | — | ADMIN (own org) | `204` |

`endDate` is optional on write and defaults to `startDate`, so a single-day holiday is `{ name, startDate }`.

A MEMBER calling `GET` sees their **own region's** holidays plus the organization-wide ones, regardless of any `?region=` they pass — the parameter is honoured only for ADMIN and SUPERADMIN. That keeps one endpoint honest for both audiences instead of adding a second.

Status codes follow `lib/api.ts` unchanged: `401`, `403`, `400`, `404` for an id outside the caller's organization.

### 4.2 Attendance — one addition

No new endpoint. `listOwnMonth(actor, year, month)` is added to `lib/attendance-service.ts` for the page. It is deliberately **not** exposed as a route: `/api/attendance` already answers spans for admins, and a member-facing read that took a `userId` would be one authorization slip away from leaking a colleague's record. The page is a server component; it does not need a fetch.

---

## 5. File structure

| File | Responsibility |
|------|----------------|
| `prisma/schema.prisma` | *Modify.* `Holiday` model, two back-relations |
| `prisma/migrations/<ts>_holidays/migration.sql` | *Create.* Schema-qualified DDL plus the `CHECK` |
| `lib/holidays.ts` | *Create.* Pure: expand a range to dates, filter to a month or year, group for a grid |
| `lib/holiday-input.ts` | *Create.* Body parsing shared by the routes |
| `lib/holiday-service.ts` | *Create.* The only module touching `prisma.holiday`. Authorization + region scoping |
| `app/api/holidays/route.ts` | *Create.* `GET`, `POST` |
| `app/api/holidays/[id]/route.ts` | *Create.* `PATCH`, `DELETE` |
| `app/api/holidays/bulk/route.ts` | *Create.* `POST` |
| `lib/attendance-month.ts` | *Create.* Pure: month cells and the summary. **The percentage lives here and nowhere else** |
| `lib/attendance-service.ts` | *Modify.* `listOwnMonth` |
| `lib/rbac.ts` | *Modify.* `canListHolidays`, `canManageHolidays`, `canReadOwnAttendance` |
| `app/(member)/calendar/page.tsx` | *Modify.* Real data, current month, C1–C4 |
| `app/(member)/layout.tsx` | *Modify.* The sidebar job title from the real user, not the fixture person |
| `lib/domain.ts` | *Modify.* Delete `attendanceMonth`, `attendanceStats`, `viewingRegion` — dead once the page moves |
| `prisma/seed.ts` | *Modify.* Load the 2026 holidays into the table |
| `tests/holidays.test.ts` | *Create.* Unit: range expansion and filtering |
| `tests/attendance-month.test.ts` | *Create.* Unit: cells and the percentage |
| `tests/holidays.integration.test.ts` | *Create.* The handlers against Postgres |
| `tests/attendance.integration.test.ts` | *Modify.* `listOwnMonth` |
| `tests/rbac.test.ts` | *Modify.* The three new predicates |

`holidaysForRegion`, `holidayDateMap` and `holidayYearGrid` stay in `lib/domain.ts` — `/setup` still uses them against the fixture and is out of scope.

---

# Tasks

### Task 1: The `Holiday` table

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_holidays/migration.sql`
- Test: `tests/holidays.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `prisma.holiday` on the generated client.

- [ ] **Step 1: Add the model and back-relations**

Add the `Holiday` model from §3.1 to `prisma/schema.prisma`, and the two back-relations from §3.2 to `Organization` and `Region`.

- [ ] **Step 2: Generate the migration without applying it**

```bash
npx prisma migrate dev --create-only --name holidays
```

Keep the generated timestamp directory name.

- [ ] **Step 3: Qualify every name and append the CHECK**

Rewrite the generated `migration.sql` so every object is `"orgapp"."…"`, matching `20260902075923_attendance/migration.sql`. The finished file:

```sql
-- Public holidays, per organization and optionally per region.
--
-- Every object is schema-qualified rather than relying on the `schema=orgapp`
-- parameter to set the search path — same rule as every migration before it.

-- CreateTable
CREATE TABLE "orgapp"."Holiday" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "regionId" TEXT,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Holiday_organizationId_startDate_idx" ON "orgapp"."Holiday"("organizationId", "startDate");

-- CreateIndex
CREATE INDEX "Holiday_regionId_idx" ON "orgapp"."Holiday"("regionId");

-- AddForeignKey
ALTER TABLE "orgapp"."Holiday" ADD CONSTRAINT "Holiday_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "orgapp"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Cascade, unlike User.regionId which is SetNull: a person outlives their
-- office, but "Pongal, in the Chennai region" has no meaning once Chennai is
-- gone — it would silently widen into an organization-wide holiday.
ALTER TABLE "orgapp"."Holiday" ADD CONSTRAINT "Holiday_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "orgapp"."Region"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The range is inclusive and ordered. Prisma's schema language cannot say so.
ALTER TABLE "orgapp"."Holiday"
  ADD CONSTRAINT "Holiday_range_ordered" CHECK ("endDate" >= "startDate");
```

- [ ] **Step 4: Write the failing test**

Create `tests/holidays.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

/**
 * Holidays against the Dockerized Postgres.
 *
 * Same approach as attendance.integration.test.ts: the session is stubbed and
 * everything below it — the real handlers, the real policy layer, real Prisma
 * queries — runs for real. Rows are namespaced with a per-run prefix.
 */
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

const RUN = `hol-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

let orgId: string;
let adminId: string;
let memberId: string;
let chennaiId: string;
let delhiId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `${RUN} Org` } });
  orgId = org.id;

  const chennai = await prisma.region.create({
    data: { name: "Chennai", organizationId: orgId },
  });
  chennaiId = chennai.id;

  const delhi = await prisma.region.create({
    data: { name: "Delhi", organizationId: orgId },
  });
  delhiId = delhi.id;

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
      regionId: chennaiId,
    },
  });
  memberId = member.id;
});

afterAll(async () => {
  await prisma.holiday.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.region.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

describe("the database rejects a reversed range", () => {
  it("refuses endDate before startDate", async () => {
    await expect(
      prisma.holiday.create({
        data: {
          organizationId: orgId,
          name: "Backwards",
          startDate: new Date("2026-11-09"),
          endDate: new Date("2026-11-08"),
        },
      }),
    ).rejects.toThrow();
  });

  it("accepts a two-day holiday and a single-day one", async () => {
    const diwali = await prisma.holiday.create({
      data: {
        organizationId: orgId,
        name: "Diwali",
        startDate: new Date("2026-11-08"),
        endDate: new Date("2026-11-09"),
      },
    });
    expect(diwali.endDate.toISOString().slice(0, 10)).toBe("2026-11-09");
    expect(diwali.regionId).toBeNull();

    const pongal = await prisma.holiday.create({
      data: {
        organizationId: orgId,
        regionId: chennaiId,
        name: "Pongal",
        startDate: new Date("2026-01-15"),
        endDate: new Date("2026-01-15"),
      },
    });
    expect(pongal.regionId).toBe(chennaiId);
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

```bash
docker compose up -d
npx vitest run tests/holidays.integration.test.ts
```

Expected: FAIL — `Cannot read properties of undefined (reading 'create')`, because `prisma.holiday` does not exist yet.

- [ ] **Step 6: Apply the migration and regenerate**

```bash
npx prisma migrate dev
npx prisma generate
```

`migrate dev` does not always refresh the client in this repo — run `generate` explicitly, as the attendance migration needed.

- [ ] **Step 7: Run it and watch it pass**

```bash
npx vitest run tests/holidays.integration.test.ts
docker compose exec -T postgres psql -U leave -d leave_management -c '\d orgapp."Holiday"' | grep -i check
```

Expected: PASS, and the `\d` output naming `Holiday_range_ordered`.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations tests/holidays.integration.test.ts
git commit -m "Add an org-scoped, region-aware Holiday table"
```

---

### Task 2: Pure holiday helpers — `lib/holidays.ts`

**Files:**
- Create: `lib/holidays.ts`
- Test: `tests/holidays.test.ts`

**Interfaces:**
- Consumes: `toDbDate`, `fromDbDate`, `parseDateParam` from `@/lib/attendance`; `HttpError` from `@/lib/rbac`.
- Produces:
  - `type HolidayRecord = { id: string; name: string; startDate: string; endDate: string; note: string | null; region: { id: string; name: string } | null }`
  - `holidayDates(holiday: Pick<HolidayRecord, "startDate" | "endDate">): string[]`
  - `holidayNameByDate(holidays: HolidayRecord[]): Record<string, string>`
  - `holidaysInMonth(holidays: HolidayRecord[], year: number, month: number): HolidayRecord[]`
  - `holidaysInYear(holidays: HolidayRecord[], year: number): HolidayRecord[]`
  - `monthBounds(year: number, month: number): { from: string; to: string }`
  - `parseYearParam(value: unknown, field?: string): number`

- [ ] **Step 1: Write the failing tests**

Create `tests/holidays.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  holidayDates,
  holidayNameByDate,
  holidaysInMonth,
  holidaysInYear,
  monthBounds,
  parseYearParam,
  type HolidayRecord,
} from "@/lib/holidays";
import { HttpError } from "@/lib/rbac";

const holiday = (
  name: string,
  startDate: string,
  endDate = startDate,
  region: HolidayRecord["region"] = null,
): HolidayRecord => ({ id: name, name, startDate, endDate, note: null, region });

const DIWALI = holiday("Diwali", "2026-11-08", "2026-11-09");
const PONGAL = holiday("Pongal", "2026-01-15", "2026-01-15", {
  id: "r1",
  name: "Chennai",
});
const NEW_YEAR = holiday("New Year's Day", "2026-01-01");
const SPANNING = holiday("Long break", "2026-08-30", "2026-09-02");

describe("holidayDates", () => {
  it("expands a single day to one date", () => {
    expect(holidayDates(NEW_YEAR)).toEqual(["2026-01-01"]);
  });

  it("expands an inclusive range", () => {
    expect(holidayDates(DIWALI)).toEqual(["2026-11-08", "2026-11-09"]);
  });

  it("crosses a month boundary", () => {
    expect(holidayDates(SPANNING)).toEqual([
      "2026-08-30",
      "2026-08-31",
      "2026-09-01",
      "2026-09-02",
    ]);
  });

  it("crosses a year boundary", () => {
    expect(holidayDates(holiday("NY", "2026-12-31", "2027-01-01"))).toEqual([
      "2026-12-31",
      "2027-01-01",
    ]);
  });
});

describe("holidayNameByDate", () => {
  it("maps every covered day to its holiday", () => {
    expect(holidayNameByDate([DIWALI, NEW_YEAR])).toEqual({
      "2026-11-08": "Diwali",
      "2026-11-09": "Diwali",
      "2026-01-01": "New Year's Day",
    });
  });
});

describe("monthBounds", () => {
  it("covers the whole month", () => {
    expect(monthBounds(2026, 8)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("handles February in a leap year", () => {
    expect(monthBounds(2028, 1)).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
});

describe("holidaysInMonth", () => {
  it("includes a holiday that only overlaps the month", () => {
    // Starts in August, ends in September — belongs to both.
    expect(holidaysInMonth([SPANNING], 2026, 7).map((h) => h.name)).toEqual([
      "Long break",
    ]);
    expect(holidaysInMonth([SPANNING], 2026, 8).map((h) => h.name)).toEqual([
      "Long break",
    ]);
  });

  it("excludes a holiday in another month", () => {
    expect(holidaysInMonth([DIWALI, PONGAL], 2026, 8)).toEqual([]);
  });
});

describe("holidaysInYear", () => {
  it("keeps anything touching the year, sorted by start date", () => {
    const sorted = holidaysInYear([DIWALI, NEW_YEAR, PONGAL], 2026);
    expect(sorted.map((h) => h.name)).toEqual([
      "New Year's Day",
      "Pongal",
      "Diwali",
    ]);
  });

  it("drops another year entirely", () => {
    expect(holidaysInYear([DIWALI], 2025)).toEqual([]);
  });
});

describe("parseYearParam", () => {
  it("accepts a plausible year", () => {
    expect(parseYearParam("2026")).toBe(2026);
  });

  it("rejects nonsense and absurd years", () => {
    expect(() => parseYearParam("nope")).toThrow(HttpError);
    expect(() => parseYearParam("999999")).toThrow(HttpError);
    expect(() => parseYearParam("1200")).toThrow(HttpError);
    expect(() => parseYearParam(undefined)).toThrow(HttpError);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/holidays.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/holidays'`.

- [ ] **Step 3: Write `lib/holidays.ts`**

```ts
import { addDays, daysInMonth, isoDate } from "@/lib/date";
import { HttpError } from "@/lib/rbac";

/**
 * Holiday shaping, as pure functions.
 *
 * No Prisma and no session, so the range arithmetic is unit testable on its
 * own — the same split lib/attendance.ts has from lib/attendance-service.ts.
 *
 * A holiday is an inclusive `startDate`–`endDate` range. Most are one day, so
 * most ranges have both ends equal.
 */

export type HolidayRecord = {
  id: string;
  name: string;
  /** Inclusive, `YYYY-MM-DD`. */
  startDate: string;
  endDate: string;
  note: string | null;
  /** `null` means the holiday applies to every region. */
  region: { id: string; name: string } | null;
};

/** Every date a holiday covers, ascending. */
export function holidayDates(
  holiday: Pick<HolidayRecord, "startDate" | "endDate">,
): string[] {
  const dates: string[] = [];
  // Guarded by the CHECK constraint, but a reversed range read from anywhere
  // else must terminate rather than loop forever.
  for (
    let date = holiday.startDate;
    date <= holiday.endDate;
    date = addDays(date, 1)
  ) {
    dates.push(date);
  }
  return dates;
}

/**
 * Every covered day mapped to its holiday's name, for painting a calendar
 * grid. A later holiday wins an overlap, which only happens when an
 * organization has entered two holidays on one day.
 */
export function holidayNameByDate(
  holidays: HolidayRecord[],
): Record<string, string> {
  const marks: Record<string, string> = {};
  for (const holiday of holidays) {
    for (const date of holidayDates(holiday)) marks[date] = holiday.name;
  }
  return marks;
}

/** The first and last day of a month, `YYYY-MM-DD`. `month` is 0-based. */
export function monthBounds(
  year: number,
  month: number,
): { from: string; to: string } {
  return {
    from: isoDate(year, month, 1),
    to: isoDate(year, month, daysInMonth(year, month)),
  };
}

function overlaps(holiday: HolidayRecord, from: string, to: string): boolean {
  return holiday.startDate <= to && holiday.endDate >= from;
}

function byStart(a: HolidayRecord, b: HolidayRecord): number {
  return a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0;
}

/**
 * Holidays touching a month — overlap, not containment, so a break that runs
 * from 30 August to 2 September appears in both months rather than neither.
 */
export function holidaysInMonth(
  holidays: HolidayRecord[],
  year: number,
  month: number,
): HolidayRecord[] {
  const { from, to } = monthBounds(year, month);
  return holidays.filter((h) => overlaps(h, from, to)).sort(byStart);
}

export function holidaysInYear(
  holidays: HolidayRecord[],
  year: number,
): HolidayRecord[] {
  const from = isoDate(year, 0, 1);
  const to = isoDate(year, 11, 31);
  return holidays.filter((h) => overlaps(h, from, to)).sort(byStart);
}

/**
 * A calendar year, or a 400.
 *
 * Bounded rather than merely numeric: the member calendar takes `?y=` straight
 * from the URL, and an unbounded year renders an empty grid for a date that
 * cannot mean anything.
 */
export function parseYearParam(value: unknown, field = "year"): number {
  const year = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    throw new HttpError(400, `"${field}" must be a year between 2000 and 2100.`);
  }
  return year;
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
npx vitest run tests/holidays.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add lib/holidays.ts tests/holidays.test.ts
git commit -m "Add pure holiday range helpers"
```

---

### Task 3: Authorization predicates

**Files:**
- Modify: `lib/rbac.ts`
- Test: `tests/rbac.test.ts`

**Interfaces:**
- Consumes: `Actor`, `Role` — already there.
- Produces: `canListHolidays(actor: Actor): boolean`, `canManageHolidays(actor: Actor, holidayOrganizationId: string | null): boolean`, `canReadOwnAttendance(actor: Actor, userId: string): boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/rbac.test.ts`, reusing the existing `adminA` / `adminB` / `memberA` / `superadmin` / `ORG_A` / `ORG_B` fixtures at the top of that file:

```ts
describe("who can read holidays", () => {
  it("allows every signed-in role — a member needs their own calendar", () => {
    expect(canListHolidays(memberA)).toBe(true);
    expect(canListHolidays(adminA)).toBe(true);
    expect(canListHolidays(superadmin)).toBe(true);
  });
});

describe("who can manage holidays", () => {
  it("allows an admin inside their own organization", () => {
    expect(canManageHolidays(adminA, ORG_A)).toBe(true);
  });

  it("denies an admin from another organization", () => {
    expect(canManageHolidays(adminB, ORG_A)).toBe(false);
  });

  it("denies members and superadmins, matching canManageRegions", () => {
    expect(canManageHolidays(memberA, ORG_A)).toBe(false);
    expect(canManageHolidays(superadmin, ORG_A)).toBe(false);
  });

  it("denies an orphaned holiday with no organization", () => {
    expect(canManageHolidays(adminA, null)).toBe(false);
  });
});

describe("who can read one person's attendance", () => {
  it("allows the person themselves", () => {
    expect(canReadOwnAttendance(memberA, memberA.id)).toBe(true);
  });

  it("denies reading somebody else's, even inside one organization", () => {
    expect(canReadOwnAttendance(memberA, "m2")).toBe(false);
    expect(canReadOwnAttendance(adminA, memberA.id)).toBe(false);
  });
});
```

Add `canListHolidays`, `canManageHolidays` and `canReadOwnAttendance` to that file's existing import from `@/lib/rbac`, keeping the list alphabetical.

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/rbac.test.ts
```

Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Add the predicates to `lib/rbac.ts`**

Put the two holiday predicates next to `canManageRegions`, whose rule they mirror:

```ts
/**
 * The holiday calendar is maintained by the Admin of the organization it
 * belongs to — the same rule as `canManageRegions`, and for the same reason:
 * a SuperAdmin creates organizations and admins, and what lives inside an
 * organization is its admin's to manage.
 *
 * Pass the *stored* `Holiday.organizationId`, never one from a request body.
 */
export function canManageHolidays(
  actor: Actor,
  holidayOrganizationId: string | null,
): boolean {
  return actor.role === Role.ADMIN && actor.organizationId === holidayOrganizationId;
}

/**
 * Reading is wider than every other list in this file: a MEMBER needs the
 * holiday calendar on their own attendance screen. Scope the query with
 * `visibleOrgId`, and narrow a member further to their own region in
 * lib/holiday-service.ts — a holiday is not sensitive, but which office
 * somebody works in is not this endpoint's to broadcast.
 */
export function canListHolidays(actor: Actor): boolean {
  return (
    actor.role === Role.SUPERADMIN ||
    actor.role === Role.ADMIN ||
    actor.role === Role.MEMBER
  );
}
```

And next to `canMarkAttendance`:

```ts
/**
 * A person may read their own attendance record.
 *
 * Deliberately self-only, and deliberately *not* satisfied by an admin: admins
 * read the roster through `canListAttendance`, which is org-scoped and already
 * covers them. Keeping this predicate to a single identity comparison means
 * the member calendar has exactly one way to be wrong, and it is a way that
 * fails closed.
 */
export function canReadOwnAttendance(actor: Actor, userId: string): boolean {
  return actor.id === userId;
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
git commit -m "Add holiday and own-attendance authorization predicates"
```

---

### Task 4: The holiday service

**Files:**
- Create: `lib/holiday-service.ts`
- Modify: `lib/services.ts` (export one existing helper)
- Test: `tests/holidays.integration.test.ts` (extend)

**Interfaces:**
- Consumes: `HolidayRecord`, `holidaysInYear` (Task 2); `canListHolidays`, `canManageHolidays` (Task 3); `toDbDate`, `fromDbDate` (`@/lib/attendance`); `visibleOrgId`, `HttpError` (`@/lib/rbac`).
- Produces:
  - `type HolidayInput = { name: string; startDate: string; endDate: string; regionId: string | null; note: string | null }`
  - `type HolidayPatch = Partial<HolidayInput>`
  - `listHolidays(actor: Actor, filter: { year?: number; from?: string; to?: string; regionId?: string }): Promise<HolidayRecord[]>`
  - `createHoliday(actor: Actor, input: HolidayInput): Promise<HolidayRecord>`
  - `createHolidays(actor: Actor, inputs: HolidayInput[]): Promise<{ created: HolidayRecord[]; skipped: number }>`
  - `updateHoliday(actor: Actor, id: string, patch: HolidayPatch): Promise<HolidayRecord>`
  - `deleteHoliday(actor: Actor, id: string): Promise<{ id: string; deleted: true }>`

- [ ] **Step 1: Export the region guard from `lib/services.ts`**

`assertRegionInOrg` already exists there and does exactly what a holiday write needs — "missing" and "belongs to another organization" answer identically with a 400, so region ids elsewhere cannot be probed. Change its declaration from `async function` to `export async function` and leave the body alone. Duplicating it would let the two copies drift on the one thing that matters about it: that both failure modes look the same.

- [ ] **Step 2: Write the failing tests**

Append to `tests/holidays.integration.test.ts`:

```ts
const {
  listHolidays,
  createHoliday,
  createHolidays,
  updateHoliday,
  deleteHoliday,
} = await import("@/lib/holiday-service");

const adminActor = (): Actor => ({
  id: adminId,
  role: Role.ADMIN,
  organizationId: orgId,
});
const memberActor = (): Actor => ({
  id: memberId,
  role: Role.MEMBER,
  organizationId: orgId,
});

describe("createHoliday", () => {
  it("defaults a single-day holiday's end to its start", async () => {
    const created = await createHoliday(adminActor(), {
      name: "Republic Day",
      startDate: "2026-01-26",
      endDate: "2026-01-26",
      regionId: null,
      note: null,
    });

    expect(created.startDate).toBe("2026-01-26");
    expect(created.endDate).toBe("2026-01-26");
    expect(created.region).toBeNull();
  });

  it("attaches a region and returns its name", async () => {
    const created = await createHoliday(adminActor(), {
      name: "Holi",
      startDate: "2026-03-03",
      endDate: "2026-03-03",
      regionId: delhiId,
      note: "North India",
    });

    expect(created.region).toEqual({ id: delhiId, name: "Delhi" });
    expect(created.note).toBe("North India");
  });

  it("refuses a reversed range before the database has to", async () => {
    await expect(
      createHoliday(adminActor(), {
        name: "Backwards",
        startDate: "2026-05-05",
        endDate: "2026-05-01",
        regionId: null,
        note: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a region from another organization", async () => {
    const other = await prisma.organization.create({
      data: { name: `${RUN} Other` },
    });
    const foreignRegion = await prisma.region.create({
      data: { name: "Mumbai", organizationId: other.id },
    });

    await expect(
      createHoliday(adminActor(), {
        name: "Elsewhere",
        startDate: "2026-06-01",
        endDate: "2026-06-01",
        regionId: foreignRegion.id,
        note: null,
      }),
    ).rejects.toMatchObject({ status: 400 });

    await prisma.region.delete({ where: { id: foreignRegion.id } });
    await prisma.organization.delete({ where: { id: other.id } });
  });

  it("refuses a member and a superadmin", async () => {
    const input = {
      name: "Nope",
      startDate: "2026-07-01",
      endDate: "2026-07-01",
      regionId: null,
      note: null,
    };

    await expect(createHoliday(memberActor(), input)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      createHoliday({ id: "su", role: Role.SUPERADMIN, organizationId: null }, input),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("listHolidays", () => {
  it("gives an admin the whole organization, sorted", async () => {
    const rows = await listHolidays(adminActor(), { year: 2026 });
    const names = rows.map((h) => h.name);

    expect(names).toContain("Republic Day");
    expect(names).toContain("Holi");
    // Sorted by start date: January before March.
    expect(names.indexOf("Republic Day")).toBeLessThan(names.indexOf("Holi"));
  });

  it("gives a member their own region plus the organization-wide ones", async () => {
    // The member is in Chennai; "Holi" is Delhi-only.
    const rows = await listHolidays(memberActor(), { year: 2026 });
    const names = rows.map((h) => h.name);

    expect(names).toContain("Republic Day");
    expect(names).toContain("Pongal");
    expect(names).not.toContain("Holi");
  });

  it("ignores a region filter a member tries to pass", async () => {
    const rows = await listHolidays(memberActor(), { year: 2026, regionId: delhiId });
    expect(rows.map((h) => h.name)).not.toContain("Holi");
  });

  it("honours a region filter for an admin", async () => {
    const rows = await listHolidays(adminActor(), { year: 2026, regionId: delhiId });
    const names = rows.map((h) => h.name);

    expect(names).toContain("Holi");
    expect(names).toContain("Republic Day"); // org-wide always applies
    expect(names).not.toContain("Pongal");
  });

  it("narrows to a year", async () => {
    expect(await listHolidays(adminActor(), { year: 2025 })).toEqual([]);
  });
});

describe("createHolidays (bulk)", () => {
  it("inserts a batch and skips the ones already there", async () => {
    const batch = [
      {
        name: "Gandhi Jayanti",
        startDate: "2026-10-02",
        endDate: "2026-10-02",
        regionId: null,
        note: null,
      },
      {
        name: "Christmas",
        startDate: "2026-12-25",
        endDate: "2026-12-25",
        regionId: null,
        note: null,
      },
      // Already inserted above — same name, same start, same region.
      {
        name: "Republic Day",
        startDate: "2026-01-26",
        endDate: "2026-01-26",
        regionId: null,
        note: null,
      },
    ];

    const result = await createHolidays(adminActor(), batch);

    expect(result.created).toHaveLength(2);
    expect(result.skipped).toBe(1);
  });

  it("is a no-op run twice", async () => {
    const again = await createHolidays(adminActor(), [
      {
        name: "Christmas",
        startDate: "2026-12-25",
        endDate: "2026-12-25",
        regionId: null,
        note: null,
      },
    ]);

    expect(again.created).toHaveLength(0);
    expect(again.skipped).toBe(1);
  });
});

describe("updateHoliday and deleteHoliday", () => {
  it("renames and moves a holiday", async () => {
    const created = await createHoliday(adminActor(), {
      name: "Typo Day",
      startDate: "2026-04-01",
      endDate: "2026-04-01",
      regionId: null,
      note: null,
    });

    const updated = await updateHoliday(adminActor(), created.id, {
      name: "April Day",
      endDate: "2026-04-02",
    });

    expect(updated.name).toBe("April Day");
    expect(updated.endDate).toBe("2026-04-02");
    expect(updated.startDate).toBe("2026-04-01");
  });

  it("refuses an update that would reverse the range", async () => {
    const created = await createHoliday(adminActor(), {
      name: "Range Test",
      startDate: "2026-04-10",
      endDate: "2026-04-12",
      regionId: null,
      note: null,
    });

    await expect(
      updateHoliday(adminActor(), created.id, { endDate: "2026-04-09" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("404s an id outside the caller's organization", async () => {
    await expect(
      updateHoliday(adminActor(), "no-such-holiday", { name: "x" }),
    ).rejects.toMatchObject({ status: 404 });

    await expect(
      deleteHoliday(adminActor(), "no-such-holiday"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("deletes", async () => {
    const created = await createHoliday(adminActor(), {
      name: "Temporary",
      startDate: "2026-05-20",
      endDate: "2026-05-20",
      regionId: null,
      note: null,
    });

    expect(await deleteHoliday(adminActor(), created.id)).toEqual({
      id: created.id,
      deleted: true,
    });
    expect(await prisma.holiday.findUnique({ where: { id: created.id } })).toBeNull();
  });

  it("refuses a member", async () => {
    await expect(
      deleteHoliday(memberActor(), "anything"),
    ).rejects.toMatchObject({ status: 403 });
  });
});
```

Task 1's `beforeAll` already creates a "Pongal" row in Chennai, which the member test above relies on.

- [ ] **Step 3: Run them and watch them fail**

```bash
npx vitest run tests/holidays.integration.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/holiday-service'`.

- [ ] **Step 4: Write `lib/holiday-service.ts`**

```ts
import { Role } from "@/generated/prisma/enums";
import { fromDbDate, toDbDate } from "@/lib/attendance";
import type { HolidayRecord } from "@/lib/holidays";
import { prisma } from "@/lib/prisma";
import {
  type Actor,
  HttpError,
  canListHolidays,
  canManageHolidays,
  visibleOrgId,
} from "@/lib/rbac";
import { assertRegionInOrg } from "@/lib/services";

/**
 * Everything that reads or writes the holiday table.
 *
 * Same contract as lib/services.ts and lib/attendance-service.ts: the route
 * handlers hand in an `Actor` they have already authenticated, and every
 * authorization decision is made here, once per operation.
 */

const HOLIDAY_FIELDS = {
  id: true,
  name: true,
  startDate: true,
  endDate: true,
  note: true,
  region: { select: { id: true, name: true } },
} as const;

export type HolidayInput = {
  name: string;
  startDate: string;
  /** Inclusive. The parser defaults it to `startDate` for a one-day holiday. */
  endDate: string;
  regionId: string | null;
  note: string | null;
};

export type HolidayPatch = Partial<HolidayInput>;

type HolidayRow = {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  note: string | null;
  region: { id: string; name: string } | null;
};

function toRecord(row: HolidayRow): HolidayRecord {
  return {
    id: row.id,
    name: row.name,
    startDate: fromDbDate(row.startDate),
    endDate: fromDbDate(row.endDate),
    note: row.note,
    region: row.region,
  };
}

/** The organization an admin may write holidays into, or a 403. */
function writableOrgFor(actor: Actor): string {
  const organizationId = actor.organizationId;
  if (!organizationId || !canManageHolidays(actor, organizationId)) {
    throw new HttpError(403, "Only an organization admin can manage holidays.");
  }
  return organizationId;
}

function assertOrderedRange(startDate: string, endDate: string): void {
  if (endDate < startDate) {
    throw new HttpError(400, '"endDate" must not be earlier than "startDate".');
  }
}

/* --------------------------------------------------------------- reading -- */

/**
 * Which region a caller's list is narrowed to.
 *
 * A MEMBER always gets their own region and nothing else — a `?region=` they
 * pass is ignored rather than rejected, because there is no legitimate reason
 * for a member to ask and a 403 would only tell them the parameter exists.
 * An ADMIN or SUPERADMIN gets whatever they asked for, or no narrowing.
 *
 * `undefined` means "do not narrow"; a string means "that region, plus the
 * organization-wide holidays".
 */
async function regionScopeFor(
  actor: Actor,
  requested?: string,
): Promise<string | undefined> {
  if (actor.role !== Role.MEMBER) return requested;

  const member = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { regionId: true },
  });
  return member?.regionId ?? undefined;
}

export async function listHolidays(
  actor: Actor,
  filter: { year?: number; from?: string; to?: string; regionId?: string } = {},
): Promise<HolidayRecord[]> {
  if (!canListHolidays(actor)) {
    throw new HttpError(403, "Your role does not permit this action.");
  }

  const orgId = visibleOrgId(actor);
  const regionId = await regionScopeFor(actor, filter.regionId);

  // A year narrows to its bounds; from/to override it when both are given.
  const from = filter.from ?? (filter.year ? `${filter.year}-01-01` : undefined);
  const to = filter.to ?? (filter.year ? `${filter.year}-12-31` : undefined);

  const rows = await prisma.holiday.findMany({
    where: {
      ...(orgId ? { organizationId: orgId } : {}),
      // Overlap, not containment: a break spanning two months belongs to both.
      ...(to ? { startDate: { lte: toDbDate(to) } } : {}),
      ...(from ? { endDate: { gte: toDbDate(from) } } : {}),
      // Organization-wide holidays (null region) always apply.
      ...(regionId ? { OR: [{ regionId }, { regionId: null }] } : {}),
    },
    select: HOLIDAY_FIELDS,
    orderBy: [{ startDate: "asc" }, { name: "asc" }],
  });

  return rows.map(toRecord);
}

/* --------------------------------------------------------------- writing -- */

export async function createHoliday(
  actor: Actor,
  input: HolidayInput,
): Promise<HolidayRecord> {
  const organizationId = writableOrgFor(actor);
  assertOrderedRange(input.startDate, input.endDate);
  if (input.regionId) await assertRegionInOrg(input.regionId, organizationId);

  const row = await prisma.holiday.create({
    data: {
      organizationId,
      regionId: input.regionId,
      name: input.name,
      startDate: toDbDate(input.startDate),
      endDate: toDbDate(input.endDate),
      note: input.note,
    },
    select: HOLIDAY_FIELDS,
  });

  return toRecord(row);
}

/**
 * Load several holidays at once — a whole year in one call.
 *
 * Skips anything already present with the same name, start date and region,
 * so re-running an import is a no-op rather than a duplicate calendar. There
 * is no unique index doing this for us on purpose: two regions legitimately
 * share a holiday name and date, and Postgres treats null `regionId` values as
 * distinct, so an index would only half-enforce the rule and mislead about it.
 */
export async function createHolidays(
  actor: Actor,
  inputs: HolidayInput[],
): Promise<{ created: HolidayRecord[]; skipped: number }> {
  const organizationId = writableOrgFor(actor);

  for (const input of inputs) {
    assertOrderedRange(input.startDate, input.endDate);
    if (input.regionId) await assertRegionInOrg(input.regionId, organizationId);
  }

  const existing = await prisma.holiday.findMany({
    where: { organizationId },
    select: { name: true, startDate: true, regionId: true },
  });
  const seen = new Set(
    existing.map((h) => `${h.name}|${fromDbDate(h.startDate)}|${h.regionId ?? ""}`),
  );

  const created: HolidayRecord[] = [];
  let skipped = 0;

  for (const input of inputs) {
    const key = `${input.name}|${input.startDate}|${input.regionId ?? ""}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);

    const row = await prisma.holiday.create({
      data: {
        organizationId,
        regionId: input.regionId,
        name: input.name,
        startDate: toDbDate(input.startDate),
        endDate: toDbDate(input.endDate),
        note: input.note,
      },
      select: HOLIDAY_FIELDS,
    });
    created.push(toRecord(row));
  }

  return { created, skipped };
}

/**
 * The holiday an admin may act on, or a 404.
 *
 * Scoped by the *stored* organizationId, so an id from another organization is
 * indistinguishable from one that does not exist.
 */
async function findWritable(
  actor: Actor,
  id: string,
): Promise<{ organizationId: string; startDate: Date; endDate: Date }> {
  const organizationId = writableOrgFor(actor);

  const holiday = await prisma.holiday.findUnique({
    where: { id },
    select: { organizationId: true, startDate: true, endDate: true },
  });
  if (!holiday || holiday.organizationId !== organizationId) {
    throw new HttpError(404, "That holiday does not exist.");
  }
  return holiday;
}

export async function updateHoliday(
  actor: Actor,
  id: string,
  patch: HolidayPatch,
): Promise<HolidayRecord> {
  const current = await findWritable(actor, id);

  // The range is validated as it will be after the patch, not as it arrived —
  // moving only one end still has to leave the two in order.
  const startDate = patch.startDate ?? fromDbDate(current.startDate);
  const endDate = patch.endDate ?? fromDbDate(current.endDate);
  assertOrderedRange(startDate, endDate);

  if (patch.regionId) {
    await assertRegionInOrg(patch.regionId, current.organizationId);
  }

  const row = await prisma.holiday.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.regionId !== undefined ? { regionId: patch.regionId } : {}),
      startDate: toDbDate(startDate),
      endDate: toDbDate(endDate),
    },
    select: HOLIDAY_FIELDS,
  });

  return toRecord(row);
}

export async function deleteHoliday(
  actor: Actor,
  id: string,
): Promise<{ id: string; deleted: true }> {
  await findWritable(actor, id);
  await prisma.holiday.delete({ where: { id } });
  return { id, deleted: true as const };
}
```

- [ ] **Step 5: Run them and watch them pass**

```bash
npx vitest run tests/holidays.integration.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 6: Commit**

```bash
git add lib/holiday-service.ts lib/services.ts tests/holidays.integration.test.ts
git commit -m "Add the holiday service: region-scoped reads, admin-only writes"
```

---

### Task 5: The holiday route handlers

**Files:**
- Create: `lib/holiday-input.ts`
- Create: `app/api/holidays/route.ts`
- Create: `app/api/holidays/[id]/route.ts`
- Create: `app/api/holidays/bulk/route.ts`
- Test: `tests/holidays.integration.test.ts` (extend)

**Interfaces:**
- Consumes: the service from Task 4; `errorResponse`, `readJson`, `requiredString`, `patchString`, `patchNullableString` from `@/lib/api`; `parseDateParam` from `@/lib/attendance`; `parseYearParam` from `@/lib/holidays`.
- Produces: `holidayInputFrom(body): HolidayInput`, `holidayPatchFrom(body): HolidayPatch` in `lib/holiday-input.ts`; the five endpoints of §4.1.

- [ ] **Step 1: Write the failing tests**

Append to `tests/holidays.integration.test.ts`:

```ts
const holidaysRoute = await import("@/app/api/holidays/route");
const holidayByIdRoute = await import("@/app/api/holidays/[id]/route");
const bulkRoute = await import("@/app/api/holidays/bulk/route");

const get = (query = "") =>
  new Request(`http://localhost/api/holidays${query ? `?${query}` : ""}`);
const post = (body: unknown) =>
  new Request("http://localhost/api/holidays", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const patch = (body: unknown) =>
  new Request("http://localhost/api/holidays", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const del = () => new Request("http://localhost/api/holidays", { method: "DELETE" });
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const actingAs = (actor: Actor | null) => {
  actorRef.current = actor;
};

describe("GET /api/holidays", () => {
  it("401s when nobody is signed in", async () => {
    actingAs(null);
    expect((await holidaysRoute.GET(get("year=2026"))).status).toBe(401);
  });

  it("400s a nonsense year", async () => {
    actingAs(adminActor());
    expect((await holidaysRoute.GET(get("year=abcd"))).status).toBe(400);
    expect((await holidaysRoute.GET(get("year=999999"))).status).toBe(400);
  });

  it("defaults to the current year when none is given", async () => {
    actingAs(adminActor());
    const response = await holidaysRoute.GET(get());
    expect(response.status).toBe(200);
    expect(Array.isArray(await response.json())).toBe(true);
  });

  it("lets a member read their own region's calendar", async () => {
    actingAs(memberActor());
    const response = await holidaysRoute.GET(get("year=2026"));

    expect(response.status).toBe(200);
    const names = (await response.json()).map((h: { name: string }) => h.name);
    expect(names).toContain("Pongal");
    expect(names).not.toContain("Holi");
  });
});

describe("POST /api/holidays", () => {
  it("creates a single-day holiday from just a name and a start", async () => {
    actingAs(adminActor());
    const response = await holidaysRoute.POST(
      post({ name: "Founders Day", startDate: "2026-02-11" }),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.startDate).toBe("2026-02-11");
    expect(body.endDate).toBe("2026-02-11");
  });

  it("400s a missing name and a malformed date", async () => {
    actingAs(adminActor());
    expect((await holidaysRoute.POST(post({ startDate: "2026-02-11" }))).status).toBe(
      400,
    );
    expect(
      (await holidaysRoute.POST(post({ name: "Bad", startDate: "11-02-2026" }))).status,
    ).toBe(400);
  });

  it("403s a member", async () => {
    actingAs(memberActor());
    expect(
      (await holidaysRoute.POST(post({ name: "Nope", startDate: "2026-02-12" })))
        .status,
    ).toBe(403);
  });
});

describe("POST /api/holidays/bulk", () => {
  it("loads several and reports what it skipped", async () => {
    actingAs(adminActor());
    const response = await bulkRoute.POST(
      post({
        holidays: [
          { name: "Independence Day", startDate: "2026-08-15" },
          { name: "Founders Day", startDate: "2026-02-11" }, // already there
        ],
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ created: 1, skipped: 1 });
  });

  it("400s a body that is not a list", async () => {
    actingAs(adminActor());
    expect((await bulkRoute.POST(post({ holidays: "nope" }))).status).toBe(400);
  });
});

describe("PATCH and DELETE /api/holidays/[id]", () => {
  it("renames a holiday", async () => {
    actingAs(adminActor());
    const created = await createHoliday(adminActor(), {
      name: "Route Test",
      startDate: "2026-09-09",
      endDate: "2026-09-09",
      regionId: null,
      note: null,
    });

    const response = await holidayByIdRoute.PATCH(
      patch({ name: "Route Test Renamed", note: "moved" }),
      idCtx(created.id),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: "Route Test Renamed",
      note: "moved",
    });

    const removed = await holidayByIdRoute.DELETE(del(), idCtx(created.id));
    expect(removed.status).toBe(204);
  });

  it("404s an unknown id", async () => {
    actingAs(adminActor());
    expect(
      (await holidayByIdRoute.PATCH(patch({ name: "x" }), idCtx("nope"))).status,
    ).toBe(404);
  });

  it("403s a member", async () => {
    actingAs(memberActor());
    expect(
      (await holidayByIdRoute.DELETE(del(), idCtx("anything"))).status,
    ).toBe(403);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/holidays.integration.test.ts
```

Expected: FAIL — `Cannot find module '@/app/api/holidays/route'`.

- [ ] **Step 3: Write `lib/holiday-input.ts`**

```ts
import { patchNullableString, patchString, requiredString } from "@/lib/api";
import { parseDateParam } from "@/lib/attendance";
import type { HolidayInput, HolidayPatch } from "@/lib/holiday-service";
import { HttpError } from "@/lib/rbac";

/**
 * Parsing holiday bodies, shared by the three route files — the rule
 * lib/member-input.ts and lib/attendance-input.ts already follow, so a bulk
 * entry and a single POST cannot drift apart on field names or coercion.
 */

/**
 * `endDate` is optional and defaults to `startDate`, so the common case — a
 * one-day holiday — is `{ name, startDate }`.
 */
export function holidayInputFrom(body: Record<string, unknown>): HolidayInput {
  const startDate = parseDateParam(body["startDate"], "startDate");
  const endDate =
    body["endDate"] === undefined || body["endDate"] === null || body["endDate"] === ""
      ? startDate
      : parseDateParam(body["endDate"], "endDate");

  return {
    name: requiredString(body, "name"),
    startDate,
    endDate,
    regionId: patchNullableString(body, "regionId") ?? null,
    note: patchNullableString(body, "note") ?? null,
  };
}

/** Absent keys are left alone; `null` and `""` clear a nullable field. */
export function holidayPatchFrom(body: Record<string, unknown>): HolidayPatch {
  const patch: HolidayPatch = {};

  const name = patchString(body, "name");
  if (name !== undefined) patch.name = name;

  if (body["startDate"] !== undefined) {
    patch.startDate = parseDateParam(body["startDate"], "startDate");
  }
  if (body["endDate"] !== undefined) {
    patch.endDate = parseDateParam(body["endDate"], "endDate");
  }
  if ("regionId" in body) patch.regionId = patchNullableString(body, "regionId") ?? null;
  if ("note" in body) patch.note = patchNullableString(body, "note") ?? null;

  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, "Nothing to update.");
  }
  return patch;
}

/** The `holidays` array on a bulk request. */
export function holidayListFrom(body: Record<string, unknown>): HolidayInput[] {
  const list = body["holidays"];
  if (!Array.isArray(list) || list.length === 0) {
    throw new HttpError(400, '"holidays" must be a non-empty array.');
  }
  if (list.length > 200) {
    throw new HttpError(400, "Load at most 200 holidays in one call.");
  }

  return list.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new HttpError(400, `"holidays[${index}]" must be an object.`);
    }
    return holidayInputFrom(entry as Record<string, unknown>);
  });
}
```

- [ ] **Step 4: Write `app/api/holidays/route.ts`**

```ts
import { errorResponse, readJson } from "@/lib/api";
import { parseDateParam, todayIso } from "@/lib/attendance";
import { holidayInputFrom } from "@/lib/holiday-input";
import { createHoliday, listHolidays } from "@/lib/holiday-service";
import { parseYearParam } from "@/lib/holidays";
import { currentActor } from "@/lib/auth";
import { HttpError, requireActor } from "@/lib/rbac";

/**
 * The organization's holiday calendar.
 *
 * A MEMBER sees their own region plus the organization-wide entries; the
 * region narrowing is applied in lib/holiday-service.ts, not here.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const params = new URL(request.url).searchParams;

    const from = params.get("from");
    const to = params.get("to");
    if (Boolean(from) !== Boolean(to)) {
      throw new HttpError(400, 'Pass both "from" and "to", or neither.');
    }

    return Response.json(
      await listHolidays(actor, {
        // A year is the common case, so it defaults rather than being required.
        year: from ? undefined : parseYearParam(params.get("year") ?? todayIso().slice(0, 4)),
        from: from ? parseDateParam(from, "from") : undefined,
        to: to ? parseDateParam(to, "to") : undefined,
        regionId: params.get("region")?.trim() || undefined,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const body = await readJson(request);

    return Response.json(await createHoliday(actor, holidayInputFrom(body)), {
      status: 201,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
```

- [ ] **Step 5: Write `app/api/holidays/[id]/route.ts`**

```ts
import { errorResponse, readJson } from "@/lib/api";
import { holidayPatchFrom } from "@/lib/holiday-input";
import { deleteHoliday, updateHoliday } from "@/lib/holiday-service";
import { currentActor } from "@/lib/auth";
import { requireActor } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const { id } = await ctx.params;
    const body = await readJson(request);

    return Response.json(await updateHoliday(actor, id, holidayPatchFrom(body)));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(_request: Request, ctx: Ctx): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const { id } = await ctx.params;

    await deleteHoliday(actor, id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return errorResponse(error);
  }
}
```

- [ ] **Step 6: Write `app/api/holidays/bulk/route.ts`**

```ts
import { errorResponse, readJson } from "@/lib/api";
import { holidayListFrom } from "@/lib/holiday-input";
import { createHolidays } from "@/lib/holiday-service";
import { currentActor } from "@/lib/auth";
import { requireActor } from "@/lib/rbac";

/**
 * Load a year's calendar in one call.
 *
 * Answers counts rather than the created rows: an import of 200 holidays does
 * not need to echo all of them back, and `skipped` is the number that already
 * existed, which is what makes re-running an import safe.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const body = await readJson(request);

    const result = await createHolidays(actor, holidayListFrom(body));
    return Response.json({
      created: result.created.length,
      skipped: result.skipped,
      holidays: result.created,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
```

- [ ] **Step 7: Run them and watch them pass**

```bash
npx vitest run tests/holidays.integration.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 8: Commit**

```bash
git add lib/holiday-input.ts app/api/holidays tests/holidays.integration.test.ts
git commit -m "Add the /api/holidays endpoints"
```

---

### Task 6: The month, computed once — `lib/attendance-month.ts`

This is where defects C2, C3 and C4 are actually fixed. The grid and the stat cards are built from one call, so they cannot describe the month differently.

**Files:**
- Create: `lib/attendance-month.ts`
- Test: `tests/attendance-month.test.ts`

**Interfaces:**
- Consumes: `AttendanceStatus`, `AttendanceModifier` enums; `daysInMonth`, `firstWeekdayOfMonth`, `isWeekend`, `isoDate` from `@/lib/date`; `HolidayRecord`, `holidayNameByDate` from `@/lib/holidays`.
- Produces:
  - `type DayMark = { date: string; status: AttendanceStatus; modifier: AttendanceModifier | null }`
  - `type MonthCell = { key: string; day: number | null; date: string | null; weekend: boolean; holiday: string | null; state: { status: AttendanceStatus; modifier: AttendanceModifier | null } | null }`
  - `type MonthSummary = { present: number; wfh: number; half: number; absent: number; leave: number; counted: number; worked: number; percent: string }`
  - `dayValue(mark: DayMark): number | null`
  - `buildMonthCells(year: number, month: number, marks: DayMark[], holidays: HolidayRecord[]): MonthCell[]`
  - `summarizeMonth(marks: DayMark[]): MonthSummary`

- [ ] **Step 1: Write the failing tests**

Create `tests/attendance-month.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  buildMonthCells,
  dayValue,
  summarizeMonth,
  type DayMark,
} from "@/lib/attendance-month";
import type { HolidayRecord } from "@/lib/holidays";

/**
 * The month a member sees.
 *
 * The percentage rule is the product requirement, so it is pinned here rather
 * than inferred from the screen: only marked days count, a working day is 1.0
 * or 0.5 if it is a half day, an absence is 0.0, and approved leave is
 * excluded from both sides.
 */

const mark = (
  date: string,
  status: DayMark["status"],
  modifier: DayMark["modifier"] = null,
): DayMark => ({ date, status, modifier });

describe("dayValue", () => {
  it("scores a full working day as one, whether in the office or at home", () => {
    expect(dayValue(mark("2026-09-01", "PRESENT"))).toBe(1);
    expect(dayValue(mark("2026-09-01", "WFH"))).toBe(1);
  });

  it("scores a half day as one half, on either base", () => {
    expect(dayValue(mark("2026-09-01", "PRESENT", "HALF_DAY"))).toBe(0.5);
    expect(dayValue(mark("2026-09-01", "WFH", "HALF_DAY"))).toBe(0.5);
  });

  it("does not dock a short leave — a couple of hours off is still a day", () => {
    expect(dayValue(mark("2026-09-01", "PRESENT", "SHORT_LEAVE"))).toBe(1);
    expect(dayValue(mark("2026-09-01", "WFH", "SHORT_LEAVE"))).toBe(1);
  });

  it("scores an absence as zero", () => {
    expect(dayValue(mark("2026-09-01", "ABSENT"))).toBe(0);
  });

  it("excludes approved leave entirely", () => {
    expect(dayValue(mark("2026-09-01", "LEAVE"))).toBeNull();
  });
});

describe("summarizeMonth", () => {
  it("returns an em dash rather than 0% when nothing is marked", () => {
    const summary = summarizeMonth([]);
    expect(summary.percent).toBe("—");
    expect(summary.counted).toBe(0);
  });

  it("counts each status and each add-on", () => {
    const summary = summarizeMonth([
      mark("2026-09-01", "PRESENT"),
      mark("2026-09-02", "PRESENT", "HALF_DAY"),
      mark("2026-09-03", "WFH"),
      mark("2026-09-04", "ABSENT"),
      mark("2026-09-07", "LEAVE"),
    ]);

    expect(summary.present).toBe(2);
    expect(summary.wfh).toBe(1);
    expect(summary.half).toBe(1);
    expect(summary.absent).toBe(1);
    expect(summary.leave).toBe(1);
  });

  it("divides worked days by marked days, excluding leave", () => {
    const summary = summarizeMonth([
      mark("2026-09-01", "PRESENT"), // 1.0
      mark("2026-09-02", "ABSENT"), // 0.0
      mark("2026-09-03", "WFH", "HALF_DAY"), // 0.5
      mark("2026-09-04", "LEAVE"), // excluded
    ]);

    expect(summary.counted).toBe(3);
    expect(summary.worked).toBe(1.5);
    expect(summary.percent).toBe("50%");
  });

  it("does not treat working from home as an absence", () => {
    // This is defect C3: the old formula scored this month at 0%.
    const summary = summarizeMonth([
      mark("2026-09-01", "WFH"),
      mark("2026-09-02", "WFH"),
    ]);

    expect(summary.percent).toBe("100%");
  });

  it("scores a day once, not once per code", () => {
    // PRESENT + HALF_DAY is half a day, not one and a half.
    const summary = summarizeMonth([mark("2026-09-01", "PRESENT", "HALF_DAY")]);

    expect(summary.worked).toBe(0.5);
    expect(summary.percent).toBe("50%");
  });

  it("is 100% for a month of full days and 0% for a month of absences", () => {
    expect(
      summarizeMonth([mark("2026-09-01", "PRESENT"), mark("2026-09-02", "PRESENT")])
        .percent,
    ).toBe("100%");
    expect(summarizeMonth([mark("2026-09-01", "ABSENT")]).percent).toBe("0%");
  });

  it("is an em dash when every marked day is leave", () => {
    expect(summarizeMonth([mark("2026-09-01", "LEAVE")]).percent).toBe("—");
  });
});

describe("buildMonthCells", () => {
  const holiday = (name: string, startDate: string, endDate = startDate): HolidayRecord => ({
    id: name,
    name,
    startDate,
    endDate,
    note: null,
    region: null,
  });

  it("pads to whole weeks", () => {
    const cells = buildMonthCells(2026, 8, [], []);
    // September 2026 has 30 days and starts on a Tuesday.
    expect(cells.length % 7).toBe(0);
    expect(cells.filter((c) => c.day !== null)).toHaveLength(30);
    expect(cells[0]!.day).toBeNull();
    expect(cells[1]!.day).toBeNull();
    expect(cells[2]!.day).toBe(1);
  });

  it("attaches a mark to its day", () => {
    const cells = buildMonthCells(
      2026,
      8,
      [mark("2026-09-03", "WFH", "HALF_DAY")],
      [],
    );
    const third = cells.find((c) => c.date === "2026-09-03");

    expect(third?.state).toEqual({ status: "WFH", modifier: "HALF_DAY" });
  });

  it("flags weekends and leaves them unmarked", () => {
    const cells = buildMonthCells(2026, 8, [], []);
    const saturday = cells.find((c) => c.date === "2026-09-05");

    expect(saturday?.weekend).toBe(true);
    expect(saturday?.state).toBeNull();
  });

  it("names a holiday on every day it covers", () => {
    const cells = buildMonthCells(2026, 8, [], [holiday("Long break", "2026-09-01", "2026-09-02")]);

    expect(cells.find((c) => c.date === "2026-09-01")?.holiday).toBe("Long break");
    expect(cells.find((c) => c.date === "2026-09-02")?.holiday).toBe("Long break");
    expect(cells.find((c) => c.date === "2026-09-03")?.holiday).toBeNull();
  });

  it("keeps a mark that falls on a holiday — somebody worked it", () => {
    const cells = buildMonthCells(
      2026,
      8,
      [mark("2026-09-01", "PRESENT")],
      [holiday("Founders Day", "2026-09-01")],
    );
    const first = cells.find((c) => c.date === "2026-09-01");

    expect(first?.holiday).toBe("Founders Day");
    expect(first?.state).toEqual({ status: "PRESENT", modifier: null });
  });

  it("ignores marks from another month", () => {
    const cells = buildMonthCells(2026, 8, [mark("2026-08-31", "PRESENT")], []);
    expect(cells.filter((c) => c.state !== null)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/attendance-month.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/attendance-month'`.

- [ ] **Step 3: Write `lib/attendance-month.ts`**

```ts
import { AttendanceModifier, AttendanceStatus } from "@/generated/prisma/enums";
import { daysInMonth, firstWeekdayOfMonth, isWeekend, isoDate } from "@/lib/date";
import { holidayNameByDate, type HolidayRecord } from "@/lib/holidays";

/**
 * One member's month: the grid and the summary, from one source.
 *
 * Both are computed here from the same `DayMark[]`, which is the point. The
 * screen this replaces built its grid from the resolved codes and its stat
 * cards from the raw record, so the two panels could describe the same month
 * differently.
 *
 * Pure — no Prisma, no session — so the percentage rule is unit testable.
 */

export type DayMark = {
  date: string;
  status: AttendanceStatus;
  modifier: AttendanceModifier | null;
};

export type MonthCell = {
  key: string;
  /** `null` for the padding cells before the 1st and after the last day. */
  day: number | null;
  date: string | null;
  weekend: boolean;
  /** The holiday covering this day, if any. */
  holiday: string | null;
  state: { status: AttendanceStatus; modifier: AttendanceModifier | null } | null;
};

export type MonthSummary = {
  present: number;
  wfh: number;
  half: number;
  absent: number;
  leave: number;
  /** The denominator: marked days that are not leave. */
  counted: number;
  /** The numerator: the sum of each counted day's value. */
  worked: number;
  /** Already formatted, `"—"` when nothing counts. */
  percent: string;
};

/**
 * What one day is worth, or `null` when it does not count at all.
 *
 * Scored per day rather than per code on purpose. Counting each code and
 * adding — `present + wfh + half * 0.5` — makes a `PRESENT + HALF_DAY` day
 * worth 1.5, which is exactly the shape of the bug this replaces.
 *
 * `SHORT_LEAVE` does not reduce the day: a couple of hours off is still a day
 * worked, and it is recorded so the pattern is visible, not so it can be
 * deducted.
 */
export function dayValue(mark: DayMark): number | null {
  if (mark.status === AttendanceStatus.LEAVE) return null;
  if (mark.status === AttendanceStatus.ABSENT) return 0;
  return mark.modifier === AttendanceModifier.HALF_DAY ? 0.5 : 1;
}

export function summarizeMonth(marks: DayMark[]): MonthSummary {
  let present = 0;
  let wfh = 0;
  let half = 0;
  let absent = 0;
  let leave = 0;
  let counted = 0;
  let worked = 0;

  for (const mark of marks) {
    switch (mark.status) {
      case AttendanceStatus.PRESENT:
        present++;
        break;
      case AttendanceStatus.WFH:
        wfh++;
        break;
      case AttendanceStatus.ABSENT:
        absent++;
        break;
      case AttendanceStatus.LEAVE:
        leave++;
        break;
    }
    if (mark.modifier === AttendanceModifier.HALF_DAY) half++;

    const value = dayValue(mark);
    if (value === null) continue;
    counted++;
    worked += value;
  }

  return {
    present,
    wfh,
    half,
    absent,
    leave,
    counted,
    worked,
    // An em dash, not 0%: a month nobody has marked yet has no attendance
    // figure, and showing zero would read as a month of absences.
    percent: counted === 0 ? "—" : `${Math.round((worked / counted) * 100)}%`,
  };
}

/** A 7-column grid of one member's month. `month` is 0-based. */
export function buildMonthCells(
  year: number,
  month: number,
  marks: DayMark[],
  holidays: HolidayRecord[],
): MonthCell[] {
  const byDate = new Map(marks.map((m) => [m.date, m]));
  const holidayNames = holidayNameByDate(holidays);

  const cells: MonthCell[] = [];
  const lead = firstWeekdayOfMonth(year, month);

  for (let i = 0; i < lead; i++) {
    cells.push({
      key: `lead-${i}`,
      day: null,
      date: null,
      weekend: false,
      holiday: null,
      state: null,
    });
  }

  const total = daysInMonth(year, month);
  for (let day = 1; day <= total; day++) {
    const date = isoDate(year, month, day);
    const mark = byDate.get(date);

    cells.push({
      key: date,
      day,
      date,
      weekend: isWeekend(date),
      holiday: holidayNames[date] ?? null,
      // A mark on a holiday is kept: somebody worked it, and hiding that would
      // lose a day the member may want to raise.
      state: mark ? { status: mark.status, modifier: mark.modifier } : null,
    });
  }

  while (cells.length % 7 !== 0) {
    cells.push({
      key: `tail-${cells.length}`,
      day: null,
      date: null,
      weekend: false,
      holiday: null,
      state: null,
    });
  }

  return cells;
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
npx vitest run tests/attendance-month.test.ts
```

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add lib/attendance-month.ts tests/attendance-month.test.ts
git commit -m "Compute a member's month and percentage in one pure module"
```

---

### Task 7: Reading one member's month

**Files:**
- Modify: `lib/attendance-service.ts`
- Test: `tests/attendance.integration.test.ts` (extend)

**Interfaces:**
- Consumes: `canReadOwnAttendance` (Task 3); `monthBounds` (Task 2); the existing `AttendanceMark` type and `toDbDate` / `fromDbDate`.
- Produces: `listMemberMonth(actor: Actor, userId: string, year: number, month: number): Promise<AttendanceMark[]>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/attendance.integration.test.ts`:

```ts
const { listMemberMonth } = await import("@/lib/attendance-service");

describe("listMemberMonth", () => {
  it("gives a member their own month, ascending", async () => {
    await setAttendance(adminActor(), {
      userId: memberId,
      date: "2026-08-03",
      status: "PRESENT",
      modifier: null,
    });
    await setAttendance(adminActor(), {
      userId: memberId,
      date: "2026-08-04",
      status: "WFH",
      modifier: "HALF_DAY",
    });

    const rows = await listMemberMonth(
      { id: memberId, role: Role.MEMBER, organizationId: orgId },
      memberId,
      2026,
      7,
    );

    expect(rows.map((r) => r.date)).toContain("2026-08-03");
    expect(rows.map((r) => r.date)).toContain("2026-08-04");
    expect(rows.every((r) => r.date.startsWith("2026-08"))).toBe(true);
  });

  it("excludes the months either side", async () => {
    const rows = await listMemberMonth(
      { id: memberId, role: Role.MEMBER, organizationId: orgId },
      memberId,
      2026,
      6, // July — nothing was written there
    );
    expect(rows).toEqual([]);
  });

  it("refuses a member reading somebody else", async () => {
    await expect(
      listMemberMonth(
        { id: "someone-else", role: Role.MEMBER, organizationId: orgId },
        memberId,
        2026,
        7,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lets an admin read a member of their own organization", async () => {
    const rows = await listMemberMonth(adminActor(), memberId, 2026, 7);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("shows an admin from another organization nothing", async () => {
    const rows = await listMemberMonth(
      { id: "x", role: Role.ADMIN, organizationId: "another-org" },
      memberId,
      2026,
      7,
    );
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/attendance.integration.test.ts
```

Expected: FAIL — `listMemberMonth is not a function`.

- [ ] **Step 3: Add it to `lib/attendance-service.ts`**

Add `canReadOwnAttendance` to the existing `@/lib/rbac` import and `monthBounds` to a new `@/lib/holidays` import, then append to the reading section:

```ts
/**
 * One member's marks for one calendar month.
 *
 * Two ways in: the member themselves, or an admin who can already list the
 * roster. `canReadOwnAttendance` is a bare identity comparison, so the member
 * path has exactly one way to be wrong and it fails closed. The admin path
 * reuses `visibleOrgId`, which means a member in another organization returns
 * an empty month rather than an error that would confirm they exist.
 *
 * The member calendar passes `actor.id`, never a value from the request, so
 * there is nothing for a member to tamper with.
 */
export async function listMemberMonth(
  actor: Actor,
  userId: string,
  year: number,
  month: number,
): Promise<AttendanceMark[]> {
  const isSelf = canReadOwnAttendance(actor, userId);
  if (!isSelf && !canListAttendance(actor)) {
    throw new HttpError(403, "Your role does not permit this action.");
  }

  const orgId = isSelf ? actor.organizationId : visibleOrgId(actor);
  const { from, to } = monthBounds(year, month);

  const rows = await prisma.attendance.findMany({
    where: {
      userId,
      date: { gte: toDbDate(from), lte: toDbDate(to) },
      ...(orgId ? { organizationId: orgId } : {}),
    },
    select: { userId: true, date: true, status: true, modifier: true },
    orderBy: [{ date: "asc" }],
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

Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add lib/attendance-service.ts tests/attendance.integration.test.ts
git commit -m "Read one member's attendance month, self or admin"
```

---

### Task 8: The calendar screen, the sidebar and the seed

**Files:**
- Modify: `app/(member)/calendar/page.tsx`
- Modify: `app/(member)/layout.tsx`
- Modify: `lib/services.ts` (add `ownProfile`)
- Modify: `lib/domain.ts` (delete three dead functions)
- Modify: `prisma/seed.ts`
- Test: manual verification (below) plus the full suite

**Interfaces:**
- Consumes: everything from Tasks 2, 4, 6 and 7.
- Produces: `ownProfile(actor: Actor): Promise<{ id: string; name: string; title: string | null; region: { id: string; name: string } | null }>` in `lib/services.ts`.

- [ ] **Step 1: Add `ownProfile` to `lib/services.ts`**

Both the sidebar and the calendar need the signed-in person's own title and region, and neither is on the Auth.js session.

```ts
/**
 * The signed-in person's own profile.
 *
 * No policy check: the only id it accepts is the actor's own, so there is
 * nothing to authorize. Used by the member shell for the sidebar and by the
 * calendar for the region its holiday list is scoped to.
 */
export async function ownProfile(actor: Actor) {
  const user = await prisma.user.findUnique({
    where: { id: actor.id },
    select: {
      id: true,
      name: true,
      title: true,
      region: { select: { id: true, name: true } },
    },
  });
  if (!user) throw new HttpError(401, "Your account no longer exists.");
  return user;
}
```

- [ ] **Step 2: Take the fixture out of the member shell**

In `app/(member)/layout.tsx`, replace the `demoMember(demoDb()).title` line. The sidebar currently shows the signed-in person's name above a **fixture person's job title** — the same lie the calendar tells, in smaller type.

```ts
  const actor = await requirePageRole(Role.MEMBER);
  const session = await auth();
  const profile = await ownProfile(actor);
  const title = profile.title ?? "Team member";
```

Drop the `demoDb, demoMember` import and add `ownProfile` from `@/lib/services`. Update the file's header comment: the screens under it no longer all render the fixture person.

- [ ] **Step 3: Rewrite `app/(member)/calendar/page.tsx`**

```tsx
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { Card, MonoLabel } from "@/components/ui";
import { ATTENDANCE_CODES, codeLabel, todayIso } from "@/lib/attendance";
import { buildMonthCells, summarizeMonth } from "@/lib/attendance-month";
import { listMemberMonth } from "@/lib/attendance-service";
import { MONTH_NAMES, formatDayMonth, formatHeader, shiftMonth } from "@/lib/date";
import { listHolidays } from "@/lib/holiday-service";
import { holidaysInYear } from "@/lib/holidays";
import { requirePageActor } from "@/lib/page-guards";
import { ownProfile } from "@/lib/services";
import { ATTENDANCE_STYLE } from "@/lib/ui";

/**
 * Member: my own attendance, month by month.
 *
 * Reads `orgapp.Attendance` through `listMemberMonth` — which takes the id
 * from the session, never the URL — and the holiday calendar through
 * `listHolidays`, which narrows a member to their own region.
 *
 * The grid and the four stat cards both come from lib/attendance-month.ts, so
 * they cannot disagree about the month they are describing.
 */

const WEEKDAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

/** Keeps `?y=` from rendering a grid for a year that cannot mean anything. */
function clampYear(value: number, fallback: number): number {
  return value >= 2000 && value <= 2100 ? value : fallback;
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ y?: string; m?: string }>;
}) {
  const actor = await requirePageActor();
  const params = await searchParams;
  const profile = await ownProfile(actor);

  const today = todayIso();
  const currentYear = Number(today.slice(0, 4));
  const currentMonth = Number(today.slice(5, 7)) - 1;

  const parsedYear = Number.parseInt(params.y ?? "", 10);
  const parsedMonth = Number.parseInt(params.m ?? "", 10);

  const year = Number.isInteger(parsedYear)
    ? clampYear(parsedYear, currentYear)
    : currentYear;
  const month =
    Number.isInteger(parsedMonth) && parsedMonth >= 0 && parsedMonth <= 11
      ? parsedMonth
      : currentMonth;

  const [marks, holidays] = await Promise.all([
    listMemberMonth(actor, actor.id, year, month),
    listHolidays(actor, { year }),
  ]);

  const cells = buildMonthCells(year, month, marks, holidays);
  const stats = summarizeMonth(marks);
  const yearHolidays = holidaysInYear(holidays, year);

  const monthHref = (delta: number) => {
    const next = shiftMonth(year, month, delta);
    return `/calendar?y=${next.year}&m=${next.month}`;
  };

  const statCards = [
    { label: "Days present", value: stats.present },
    { label: "Days at home", value: stats.wfh },
    { label: "Half days", value: stats.half },
    { label: "Absent", value: stats.absent },
    { label: "Attendance", value: stats.percent },
  ];

  return (
    <>
      <PageHeader
        title="My attendance"
        subtitle="Every day your admin has marked this month."
        meta={formatHeader(today)}
      />

      <div className="grid max-w-[940px] items-start gap-6 lg:grid-cols-2">
        <Card className="flex flex-col gap-4 px-5.5 py-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[17px] font-semibold">
              {MONTH_NAMES[month]} {year}
            </h2>
            <span className="flex gap-1.5">
              <Link
                href={monthHref(-1)}
                aria-label="Previous month"
                className="flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 no-underline hover:border-muted"
              >
                ‹
              </Link>
              <Link
                href={monthHref(1)}
                aria-label="Next month"
                className="flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 no-underline hover:border-muted"
              >
                ›
              </Link>
            </span>
          </div>

          <div className="grid grid-cols-7 gap-[5px]">
            {WEEKDAY_INITIALS.map((day, index) => (
              <span
                key={index}
                className="text-center font-mono text-[11px] tracking-[0.08em] text-muted"
              >
                {day}
              </span>
            ))}

            {cells.map((cell) => {
              if (cell.day === null) {
                return <span key={cell.key} className="aspect-square" />;
              }

              // The add-on is the more informative colour when there is one: a
              // half day is what stands out on a month of ordinary days.
              const code = cell.state
                ? (cell.state.modifier ?? cell.state.status)
                : null;
              const style = code ? ATTENDANCE_STYLE[code] : null;

              const title = [
                cell.holiday,
                cell.state
                  ? [cell.state.status, cell.state.modifier]
                      .filter(Boolean)
                      .join(" + ")
                  : null,
              ]
                .filter(Boolean)
                .join(" · ");

              return (
                <span
                  key={cell.key}
                  title={title || undefined}
                  className={`flex aspect-square min-w-0 flex-col items-center justify-center gap-px overflow-hidden rounded-lg border ${
                    cell.weekend
                      ? "border-line bg-subtle text-[#cbd5e1]"
                      : style
                        ? `${style.chip} border-transparent`
                        : cell.holiday
                          ? "border-dashed border-accent bg-surface text-ink-2"
                          : "border-line bg-surface text-muted"
                  }`}
                >
                  <span
                    className={`text-[13px] leading-none ${style ? "font-semibold" : ""}`}
                  >
                    {cell.day}
                  </span>
                  <span className="font-mono text-[9px] leading-none tracking-[0.04em]">
                    {cell.weekend
                      ? ""
                      : style
                        ? `${ATTENDANCE_STYLE[cell.state!.status].short}${
                            cell.state!.modifier
                              ? ATTENDANCE_STYLE[cell.state!.modifier].short
                              : ""
                          }`
                        : cell.holiday
                          ? "H"
                          : "–"}
                  </span>
                </span>
              );
            })}
          </div>

          <div className="flex flex-wrap gap-2.5 border-t border-line pt-3.5">
            {/* The same order and the same wording as the admin grid:
                ATTENDANCE_CODES and codeLabel own both, so the legend cannot
                drift from the buttons that produce these marks. */}
            {ATTENDANCE_CODES.map((code) => (
              <span
                key={code}
                className="flex items-center gap-1.5 text-[12.5px] text-ink-2"
              >
                <span
                  className={`size-3 rounded-[3px] border ${ATTENDANCE_STYLE[code].swatch}`}
                />
                {codeLabel(code)}
              </span>
            ))}
            <span className="flex items-center gap-1.5 text-[12.5px] text-ink-2">
              <span className="size-3 rounded-[3px] border border-dashed border-accent" />
              Holiday
            </span>
          </div>
        </Card>

        <div className="flex min-w-0 flex-col gap-3">
          {statCards.map((stat) => (
            <Card
              key={stat.label}
              className="flex items-baseline justify-between gap-3 px-4.5 py-4"
            >
              <span className="text-[13px] text-muted">{stat.label}</span>
              <span className="text-2xl font-semibold tracking-[-0.02em]">
                {stat.value}
              </span>
            </Card>
          ))}

          <p className="text-[12.5px] leading-relaxed text-muted">
            Marked by your admin over {stats.counted}{" "}
            {stats.counted === 1 ? "day" : "days"} this month. Days of approved
            leave are left out of the percentage. Flag anything wrong in the
            request thread.
          </p>

          <Card className="flex flex-col gap-3 p-4.5">
            <span className="flex items-baseline justify-between gap-2.5">
              <MonoLabel>HOLIDAYS {year}</MonoLabel>
              <span className="font-mono text-[11px] text-muted">
                {profile.region?.name ?? "All regions"}
              </span>
            </span>

            {yearHolidays.length === 0 ? (
              <span className="text-[12.5px] text-muted">
                No holidays are on the calendar for {year} yet.
              </span>
            ) : (
              yearHolidays.map((holiday) => (
                <span
                  key={holiday.id}
                  className="flex items-center gap-2.5 border-b border-line pb-2 last:border-b-0 last:pb-0"
                >
                  <span className="size-[5px] shrink-0 rounded-full bg-accent" />
                  <span className="min-w-0 flex-1 text-[12.5px]">{holiday.name}</span>
                  <span className="font-mono text-[11.5px] text-muted">
                    {holiday.startDate === holiday.endDate
                      ? formatDayMonth(holiday.startDate)
                      : `${formatDayMonth(holiday.startDate)} – ${formatDayMonth(holiday.endDate)}`}
                  </span>
                </span>
              ))
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
```

The tooltip builds its own text from the raw enum values. If you would rather it read as prose, use `describeState` from `@/lib/attendance` — it is the function the admin grid uses for the same job.

- [ ] **Step 4: Delete the dead fixture helpers**

`attendanceMonth`, `attendanceStats` and `viewingRegion` in `lib/domain.ts` had exactly one caller between them — the page just rewritten. Delete all three, and the now-unused `CalendarCell` type.

Keep `holidaysForRegion`, `holidayDateMap` and `holidayYearGrid`: `/setup` still uses them against the fixture and is out of scope.

- [ ] **Step 5: Seed the 2026 holidays**

In `prisma/seed.ts`, after `seedAttendance`, add a loader that maps the fixture's region *names* onto the real `Region` rows.

```ts
/**
 * The 2026 holiday calendar for the seeded organization.
 *
 * Region names are resolved to the rows the seed just created; a holiday with
 * no region applies to the whole organization. Idempotent by (name, startDate,
 * regionId), the same key the bulk endpoint uses — re-running the seed adds
 * nothing.
 */
const SEED_HOLIDAYS: {
  name: string;
  startDate: string;
  endDate?: string;
  region?: string;
}[] = [
  { name: "New Year's Day", startDate: "2026-01-01" },
  { name: "Pongal", startDate: "2026-01-15", region: "Chennai" },
  { name: "Republic Day", startDate: "2026-01-26" },
  { name: "Holi", startDate: "2026-03-03", region: "Delhi" },
  { name: "Independence Day", startDate: "2026-08-15" },
  { name: "Gandhi Jayanti", startDate: "2026-10-02" },
  { name: "Diwali", startDate: "2026-11-08", endDate: "2026-11-09" },
  { name: "Christmas", startDate: "2026-12-25" },
];

async function seedHolidays(
  organizationId: string,
  regions: { id: string; name: string }[],
): Promise<number> {
  const regionId = new Map(regions.map((r) => [r.name, r.id]));

  const existing = await prisma.holiday.findMany({
    where: { organizationId },
    select: { name: true, startDate: true, regionId: true },
  });
  const seen = new Set(
    existing.map(
      (h) => `${h.name}|${h.startDate.toISOString().slice(0, 10)}|${h.regionId ?? ""}`,
    ),
  );

  let created = 0;
  for (const holiday of SEED_HOLIDAYS) {
    const region = holiday.region ? (regionId.get(holiday.region) ?? null) : null;
    // A holiday naming a region the organization does not have is skipped
    // rather than silently widened to everyone.
    if (holiday.region && !region) continue;

    const key = `${holiday.name}|${holiday.startDate}|${region ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);

    await prisma.holiday.create({
      data: {
        organizationId,
        regionId: region,
        name: holiday.name,
        startDate: new Date(`${holiday.startDate}T00:00:00.000Z`),
        endDate: new Date(`${holiday.endDate ?? holiday.startDate}T00:00:00.000Z`),
      },
    });
    created++;
  }

  return created;
}
```

Call it in `main`, beside the attendance seeding:

```ts
  const holidayRows = await seedHolidays(seeded.organization.id, seeded.regions);
```

and log it after the attendance line:

```ts
  console.log(`Holidays: ${holidayRows} added for 2026.`);
```

- [ ] **Step 6: Run the whole suite, the linter and the type checker**

```bash
npm test
npm run lint
npx tsc --noEmit
```

Expected: all green. `tsc` catches anything still importing the three deleted helpers from `lib/domain.ts`.

- [ ] **Step 7: Verify in the running app**

```bash
docker compose up -d
npx prisma migrate deploy
npm run seed
npm run dev
```

Restart `next dev` if it was already running — `lib/prisma.ts` caches the client on `globalThis` across HMR, so a regenerated client needs a full restart.

Sign in as the demo **member** and check each of these on `/calendar`:

1. The page opens on the **current month**, not August (C2).
2. The days the admin marked on `/attendance` appear, and they are **this member's** — not Dev Menon's (C1).
3. The grid and the stat cards agree: the number of coloured weekday cells matches `present + wfh + absent` and the "over N days" line (C4).
4. A month with a WFH day does **not** show a reduced percentage (C3). Mark a member WFH for two days as admin and confirm the member sees 100%, not 0%.
5. A `PRESENT + HALF_DAY` day scores 0.5 — one such day alone reads 50%.
6. A month with nothing marked shows `—`, not `0%`.
7. Holidays for the member's region appear in the side panel for the whole year, and any holiday falling in the displayed month is outlined on the grid.
8. A Delhi-only holiday does **not** appear for a Chennai member. Change the member's region on `/team` and confirm the list changes.
9. `?y=999999` and `?m=99` fall back to the current year and month.
10. The sidebar shows the signed-in member's real job title, not "Copywriter" from the fixture.
11. `POST /api/holidays` as an admin adds a holiday that shows up on the member's calendar; as a member it 403s.

- [ ] **Step 8: Commit**

```bash
git add "app/(member)/calendar/page.tsx" "app/(member)/layout.tsx" lib/services.ts lib/domain.ts prisma/seed.ts
git commit -m "Move the member calendar onto real attendance and holidays"
```

---

## 6. Verification

| Check | Command |
|-------|---------|
| Pure rules | `npx vitest run tests/holidays.test.ts tests/attendance-month.test.ts tests/rbac.test.ts` |
| Endpoints and policy | `npx vitest run tests/holidays.integration.test.ts tests/attendance.integration.test.ts` |
| Whole suite | `npm test` |
| Types | `npx tsc --noEmit` |
| Lint | `npm run lint` |
| The CHECK exists | `docker compose exec -T postgres psql -U leave -d leave_management -c '\d orgapp."Holiday"'` |
| The screen | Task 8, Step 7 |

---

## 7. What is still fixture after this, and why

- **`/setup`'s holiday calendar** still renders `seedDb()` and `holidayYearGrid`. The table and the API now exist, so moving it is a page rewrite with no new backend — but it also owns leave policies and approval rules, which have no tables, so it cannot come off the fixture in one piece.
- **`/overview`, `/apply`, `/requests`, `/score`, `/approvals`** all need `LeaveRequest`, which does not exist yet. `/overview` is the one that still calls `demoMember`.
- **Approved leave still does not auto-fill attendance.** `LEAVE` remains a status an admin sets by hand, and the calendar's percentage already excludes it correctly for when it does become automatic.
- **`lib/store.ts`, `lib/actions.ts`, `lib/db.ts`** still target the dropped `public` tables. Untouched.

## 8. Out of scope

- An admin screen for managing holidays. The API is complete; `/setup` keeps its fixture calendar until leave policies move too.
- Recurring or rule-based holidays ("second Saturday", Easter). Every holiday is an explicit date range.
- Holiday calendars shared across organizations, or a country-level default to import from.
- Excluding holidays from the attendance denominator. The chosen rule counts only marked days, so a holiday nobody marked is already excluded — no special case needed.
- A member's view of anyone else's attendance, including a manager's view of their reports.
