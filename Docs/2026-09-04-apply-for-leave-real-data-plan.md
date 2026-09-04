# Apply for Leave on Real Data — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-09-04
**Status:** Proposed plan (pre-implementation)
**Goal:** Put `/apply` on the signed-in member's own data — real leave policies, a real balance, a day count that respects the organization's holidays, and a `LeaveRequest` row that is actually written — replacing the fixture person and the redirect that pretends to save.

**Architecture:** Two new org-scoped tables, `LeavePolicy` (the entitlement) and `LeaveRequest` (the filing). Reads and writes go through `lib/leave-service.ts` behind `/api/leave-policies` and `/api/leave-requests`, mirroring the Team, Attendance and Holiday stacks. Balance is *derived* — allowance minus the cost of that member's pending and approved requests for the year — so there is no ledger to drift. The day count lives in one pure module, `lib/leave.ts`, imported by both the server action and the client form, so the live preview and the price the database stores cannot disagree.

**Tech Stack:** Next.js 16.3.2 (App Router, Route Handlers), React 19.2, Prisma 7 with `@prisma/adapter-pg`, PostgreSQL, Auth.js v5, Vitest 4, Tailwind 4.

**Spec:** This document. Builds on
[`2026-09-02-member-attendance-and-holidays-plan.md`](./2026-09-02-member-attendance-and-holidays-plan.md),
[`2026-09-02-attendance-real-data-plan.md`](./2026-09-02-attendance-real-data-plan.md) and
[`2026-09-01-team-real-data-plan.md`](./2026-09-01-team-real-data-plan.md).

## Global Constraints

- Models live in the **`orgapp`** Postgres schema, set by the `schema` parameter on the connection URL (`lib/prisma-url.ts`). No `@@schema` attribute, no `multiSchema` preview feature.
- Every migration statement is **schema-qualified by hand** (`"orgapp"."LeaveRequest"`). `prisma migrate diff` emits bare names, which would land in `public` on a fresh database.
- Dates are **`YYYY-MM-DD` strings** above the database and `DATE` columns beneath it, converted with the existing `toDbDate` / `fromDbDate` in `lib/attendance.ts`. Prisma returns `DATE` at UTC midnight, so the round trip is exact.
- "Today" comes from `todayIso()` (`lib/attendance.ts`), which resolves in `Asia/Kolkata`. Never `new Date()` against a date string. **`TODAY` in `lib/date.ts` is the demo's frozen `"2026-08-17"` and must not be used by anything in this plan.**
- Authorization is decided in `lib/rbac.ts` (pure predicates) and enforced in the service modules. Route handlers never decide policy.
- A member id is **never** accepted from a member's request. Every operation here derives it from the session, so there is no id to tamper with.
- `lib/leave.ts` is imported by a **client component**. It may import `lib/date.ts` and nothing else — no `lib/rbac.ts`, no `@/generated/prisma/*` — or the Prisma client is pulled into the browser bundle.
- Tests: `npm test` (Vitest, `fileParallelism: false`). Integration tests hit the Dockerized Postgres (`docker compose up -d`, service name **`postgres`**, user `leave`, database `leave_management`), namespace rows with a per-run prefix, and clean up in `afterAll`.
- Commit after every task.

---

## 1. Where things stand

`/apply` is MEMBER-only and correctly gated — `proxy.ts` lists the prefix and `app/(member)/layout.tsx` calls `requirePageRole(Role.MEMBER)`. The gate is not the problem. Nine things are:

| # | Defect | Fixed in |
|---|--------|----------|
| A1 | The page renders `demoMember(db)` — a hardcoded `DEMO_MEMBER_ID = "u2"` (Dev Menon). Every real member sees a fixture person's balances and a fixture person's approver under their own name. The sidebar beside it already shows the real signed-in user, so the screen contradicts itself. | Task 7 |
| A2 | Submitting calls `demoSubmitLeaveRequest()`, a bare `redirect("/apply?demo=apply")`. **Nothing is written.** There is no table to write to. | Tasks 1, 4, 6 |
| A3 | Policies are the `POLICIES` fixture in `lib/seed.ts` — four hardcoded entries with no organization. Two organizations cannot have different entitlements. | Tasks 1, 8 |
| A4 | Balance is `allowance − db.used[userId][type]`, and `used` is a fixture map. It is not derived from any request the member ever made, so it cannot move when one is filed. | Tasks 2, 4 |
| A5 | The day count is `workdays(from, to)`, which skips **weekends only**. `orgapp.Holiday` is real and region-scoped as of 2026-09-02, and this ignores it — a member spanning Diwali is charged for it. | Tasks 2, 4, 7 |
| A6 | The approver is resolved by matching `Person.manager`, a **name string**. The real `User` model has a `managerId` foreign key, and a rename would orphan the match. | Task 4 |
| A7 | Nothing stops a member filing three requests over the same week. Every balance on the screen is meaningless until that is closed. | Task 4 |
| A8 | The page maps `error === "range"` to a fixed sentence. The only code that ever produced that value is `submitLeaveRequest` in `lib/actions.ts` — the pre-fixture action against `lib/store.ts`, which nothing renders any more: `git grep -n submitLeaveRequest` finds only its own definition. So the branch is unreachable, *and* it is the wrong shape — `backWithError`, which every other screen uses, puts a **readable message** in `?error=`. Leaving a second, dead `submitLeaveRequest` in the tree beside the real one this plan writes is a trap for the next reader. | Task 7 |
| A9 | `SHORT_LEAVE` is matched by the literal string `"Short leave"` in `components/apply-form.tsx`. Renaming the policy silently changes the arithmetic. | Tasks 2, 7 |

There is no `LeavePolicy` and no `LeaveRequest` table. The leave tables were dropped when the `orgapp` schema was introduced; it models organizations, users, regions, attendance and holidays only.

---

## 2. The rules this implements

Confirmed with the product owner on 2026-09-04:

1. **The member sees their own policies, balances and approver** — resolved from the session, never from the URL or a form field.
2. **Allowance comes from a per-organization `LeavePolicy` table**, seeded with Casual 6, Sick 6, Paid / annual 18, and Short leave (counted in occurrences, not days).
3. **Balance is derived, not stored:**

   ```
   used    = sum(cost) of that member's requests for that policy
             where status is PENDING or APPROVED
             and the request's start date falls in the calendar year

   balance = policy.allowance - used
   ```

   **Pending counts.** Otherwise a member files the same six days three times before anyone looks at the first one. A withdrawn or rejected request frees its days by falling out of the filter — there is no ledger to reconcile, and no reconcile path to get wrong.

   A request spanning New Year is charged **to the year of its start date**. Stated here because it is otherwise exactly the kind of edge two functions quietly disagree about.

4. **A request costs the working days it actually covers:** days in the inclusive range that are neither a weekend nor a holiday in the member's region. A `USES` policy costs **1** regardless of the range, and its stored `endDate` collapses to its `startDate`.

5. **The cost is frozen at submit.** It is stored on the row, not recomputed on read. An admin adding a holiday in November must not silently re-price a request that was approved in September.

6. **Overlapping requests are rejected** — any `PENDING` or `APPROVED` request of that member's that shares a day with the new range gives a `409`.

7. **Deliberately NOT rejected**, so today's behaviour is preserved:
   - **Past dates.** A member may still file for a date that has gone.
   - **Over-balance.** The request is filed and the card shows the shortfall, exactly as the current copy promises ("Over your balance — admin will see the shortfall").
   - **Notice period.** The subtitle's "two weeks' notice for anything over five days" stays advisory.

   One consequence to accept knowingly: a range that is all weekend and holiday submits at **cost 0**. Only `endDate < startDate` is refused, and it is refused at the parser as a `400`, the way every other date field in `lib/*-input.ts` is. If cost 0 should become a `400` it is a two-line guard in `createOwnLeaveRequest` — but it is not in this plan.

8. **A request goes to the member's manager** (`User.managerId`), falling back to any active ADMIN in the organization, and to nobody if the organization has neither.

9. **After a successful submit the member stays on `/apply`** with a confirmation strip naming the type, dates, day count and approver. `/requests` is still on the fixture in this scope, so redirecting there would show a stranger's thread instead of the request just filed.

---

## 3. Database tables required

### 3.1 New enums

```prisma
/// How a policy is counted. `DAYS` charges working days in the range; `USES`
/// charges one occurrence however long the range is — the rule the fixture
/// expressed by matching the literal name "Short leave".
enum LeaveUnit {
  DAYS
  USES
}

enum LeaveRequestStatus {
  PENDING
  APPROVED
  REJECTED
  WITHDRAWN
}
```

### 3.2 New table — `LeavePolicy`

```prisma
/// A leave entitlement an organization grants, per calendar year.
///
/// Org-scoped rather than global — the same reasoning as `Region`: two
/// organizations may both grant "Casual" without sharing a row, and one of
/// them may grant eight days where the other grants six.
model LeavePolicy {
  id String @id @default(cuid())

  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  name String
  note String?

  /// Working days per year for a DAYS policy; occurrences for a USES one.
  allowance Int
  unit      LeaveUnit @default(DAYS)

  /// Whether an unused balance rolls into next year. Carried for the Setup
  /// screen's benefit; nothing in this plan reads it, because nothing in this
  /// plan computes a second year.
  carry Boolean @default(false)

  /// Render order in the Apply form's select. Ties break on name.
  position Int @default(0)

  /// A policy with requests against it is retired, not deleted — see the
  /// `Restrict` on LeaveRequest.policyId. Inactive policies drop out of the
  /// Apply select but keep every request they already priced readable.
  active Boolean @default(true)

  requests LeaveRequest[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@unique([organizationId, name])
  @@index([organizationId])
}
```

Plus the constraint Prisma cannot express:

```sql
ALTER TABLE "orgapp"."LeavePolicy"
  ADD CONSTRAINT "LeavePolicy_allowance_nonnegative" CHECK ("allowance" >= 0);
```

### 3.3 New table — `LeaveRequest`

```prisma
/// One member's application for leave.
///
/// `organizationId` is denormalised from the applicant's own `User` row so the
/// approvals queue — every request in one organization over a span — is a
/// single indexed read with no join. lib/leave-service.ts always copies it
/// from the stored user, never from a request body: the same rule
/// lib/attendance-service.ts follows.
model LeaveRequest {
  id String @id @default(cuid())

  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  userId String
  user   User   @relation("LeaveRequestSubject", fields: [userId], references: [id], onDelete: Cascade)

  /// A reference, not the policy's name: renaming "Paid / annual" must not
  /// orphan a year of requests. The same reasoning as `User.managerId`.
  ///
  /// Restrict, so a policy with history cannot be deleted out from under it.
  /// Retiring a policy is `active = false`.
  policyId String
  policy   LeavePolicy @relation(fields: [policyId], references: [id], onDelete: Restrict)

  /// Inclusive. A USES request has startDate == endDate.
  startDate DateTime @db.Date
  endDate   DateTime @db.Date

  /// Working days charged, computed at submit against weekends and the
  /// applicant's region's holidays. Stored rather than derived: it is the
  /// price frozen at submit, and a holiday added in November must not
  /// re-price a request approved in September.
  cost Int

  reason String?

  status LeaveRequestStatus @default(PENDING)

  /// Who it went to at submit time — the applicant's manager, or an admin.
  ///
  /// Nullable and SetNull rather than Restrict, for the reason
  /// `Attendance.markedById` gives: this is routing, not ownership. An
  /// approver who leaves is deleted, and neither blocking that delete nor
  /// destroying the team's leave history with it is acceptable.
  approverId String?
  approver   User?   @relation("LeaveRequestApprover", fields: [approverId], references: [id], onDelete: SetNull)

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  /// The approvals queue: one organization, ordered by date.
  @@index([organizationId, startDate])
  /// The balance query and the overlap check: one member, filtered by status.
  @@index([userId, status])
}
```

Plus:

```sql
ALTER TABLE "orgapp"."LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_range_ordered" CHECK ("endDate" >= "startDate");

ALTER TABLE "orgapp"."LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_cost_nonnegative" CHECK ("cost" >= 0);
```

`cost >= 0` and not `cost > 0`: rule 7 accepts an all-weekend range at cost 0, and a CHECK that contradicted the service would surface as a `500` rather than a message.

### 3.4 Changed tables

```prisma
// Organization
  leavePolicies  LeavePolicy[]
  leaveRequests  LeaveRequest[]

// User
  leaveRequests  LeaveRequest[] @relation("LeaveRequestSubject")
  leaveApprovals LeaveRequest[] @relation("LeaveRequestApprover")
```

Two relations to `User`, so both have to be named — the same shape `Attendance` already has for its subject and its marker.

### 3.5 Deliberately NOT stored

- **A balance or ledger row.** Rule 3 derives it. A stored copy is a second source of truth that drifts the first time a request is withdrawn.
- **A `year` column on the request.** It is `startDate`'s year.
- **A decision thread.** Comments belong to `/approvals`, which is out of scope. An empty `LeaveComment` table now would be a table nothing reads.
- **`days` as a separate column from `cost`.** They are the same number. A USES request costs 1 and covers 1 day.
- **The applicant's region.** It is `User.regionId`. Copying it would let a request disagree with the person who filed it.

---

## 4. APIs required

### 4.1 Leave policy route handler

| Method | Path | Query | Who | Answers |
|--------|------|-------|-----|---------|
| `GET` | `/api/leave-policies` | — | ADMIN, MEMBER (own org) | The organization's active policies, by `position` |

No write endpoints. Editing a policy belongs to `/setup`, which is out of scope; the seed is the only writer in this plan. A SUPERADMIN gets a `403` rather than an empty list: policies belong to an organization and a SuperAdmin has none, so an empty array would misreport "your organization grants nothing".

### 4.2 Leave request route handler

| Method | Path | Body | Who | Answers |
|--------|------|------|-----|---------|
| `GET` | `/api/leave-requests` | — | ADMIN, MEMBER (own org) | **The caller's own** requests, newest first |
| `POST` | `/api/leave-requests` | `{ policyId, startDate, endDate?, reason? }` | ADMIN, MEMBER (own org) | `201` and the created request |

`endDate` is optional and defaults to `startDate`, so a one-day request is `{ policyId, startDate }`. That default is also what makes the form work untouched: `components/apply-form.tsx` **disables** the `To` input for a `USES` policy, and a disabled input submits no value at all.

`GET` is self-scoped with no `userId` parameter in any form. A member-facing read that took an id would be one authorization slip away from leaking a colleague's leave record; the approvals-side read, which legitimately spans a roster, arrives with `/approvals` and gets its own predicate then.

Status codes follow `lib/api.ts` unchanged: `401` unauthenticated, `403` wrong role, `400` validation, `404` for a policy id outside the caller's organization, `409` for an overlap.

### 4.3 Server Action

`submitLeaveRequestAction(form)` in `lib/leave-actions.ts`, calling the same service the route handler calls and parsing with the same parser. It re-authenticates rather than trusting `proxy.ts` — a Server Action is a POST to the page's own path, and a matcher change could remove that gate without any code here changing. The rule `lib/holiday-actions.ts` already states.

---

## 5. File structure

| File | Responsibility |
|------|----------------|
| `prisma/schema.prisma` | *Modify.* Two enums, two models, four back-relations |
| `prisma/migrations/<ts>_leave_requests/migration.sql` | *Create.* Schema-qualified DDL plus three `CHECK`s |
| `lib/leave.ts` | *Create.* **Pure, client-safe.** Range expansion, the chargeable-day rule, cost, unit labels. Imports `lib/date.ts` and nothing else |
| `lib/leave-input.ts` | *Create.* Body parsing shared by the route handler and the Server Action |
| `lib/leave-service.ts` | *Create.* The only module touching `prisma.leavePolicy` and `prisma.leaveRequest`. Authorization, balance derivation, the overlap check |
| `app/api/leave-policies/route.ts` | *Create.* `GET` |
| `app/api/leave-requests/route.ts` | *Create.* `GET`, `POST` |
| `lib/leave-actions.ts` | *Create.* `submitLeaveRequestAction` |
| `lib/rbac.ts` | *Modify.* `canListLeavePolicies`, `canApplyForLeave` |
| `app/(member)/apply/page.tsx` | *Modify.* Real data, A1 and A8, the confirmation strip |
| `components/apply-form.tsx` | *Modify.* Policy ids, `LeaveUnit`, holiday-aware preview, A9 |
| `lib/demo-actions.ts` | *Modify.* Delete `demoSubmitLeaveRequest` |
| `lib/actions.ts` | *Modify.* Delete the dead legacy `submitLeaveRequest` this plan replaces |
| `components/demo-banner.tsx` | *Modify.* Drop the `apply` case |
| `prisma/seed.ts` | *Modify.* Seed the four policies per organization |
| `tests/leave.test.ts` | *Create.* Unit: the day rule, cost, balance arithmetic |
| `tests/leave.integration.test.ts` | *Create.* The handlers and the service against Postgres |
| `tests/leave-actions.test.ts` | *Create.* The Server Action's redirects |
| `tests/rbac.test.ts` | *Modify.* The two new predicates |

`lib/domain.ts` keeps `balanceOf`, `policyByName`, `usageUnit`, `requestsFor` and `requestDays` — `/requests`, `/approvals`, `/overview` and `/score` still call them against the fixture and are out of scope. Nothing is deleted from it in this plan.

---

# Tasks

### Task 1: The `LeavePolicy` and `LeaveRequest` tables

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_leave_requests/migration.sql`
- Test: `tests/leave.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `prisma.leavePolicy` and `prisma.leaveRequest` on the generated client; the enums `LeaveUnit` and `LeaveRequestStatus` in `@/generated/prisma/enums`.

- [ ] **Step 1: Add the enums, models and back-relations**

Add the two enums from §3.1 next to the existing `AttendanceModifier` enum, the two models from §3.2 and §3.3 after `Holiday`, and the four back-relations from §3.4 to `Organization` and `User`.

- [ ] **Step 2: Generate the migration without applying it**

```bash
npx prisma migrate dev --create-only --name leave_requests
```

Keep the generated timestamp directory name.

- [ ] **Step 3: Qualify every name and append the CHECKs**

Rewrite the generated `migration.sql` so every object is `"orgapp"."…"`, matching the holiday migration before it. The finished file:

```sql
-- Leave policies and leave requests, per organization.
--
-- Every object is schema-qualified rather than relying on the `schema=orgapp`
-- parameter to set the search path — same rule as every migration before it.

-- CreateEnum
CREATE TYPE "orgapp"."LeaveUnit" AS ENUM ('DAYS', 'USES');

-- CreateEnum
CREATE TYPE "orgapp"."LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "orgapp"."LeavePolicy" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "allowance" INTEGER NOT NULL,
    "unit" "orgapp"."LeaveUnit" NOT NULL DEFAULT 'DAYS',
    "carry" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeavePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orgapp"."LeaveRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "cost" INTEGER NOT NULL,
    "reason" TEXT,
    "status" "orgapp"."LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "approverId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeavePolicy_organizationId_name_key" ON "orgapp"."LeavePolicy"("organizationId", "name");

-- CreateIndex
CREATE INDEX "LeavePolicy_organizationId_idx" ON "orgapp"."LeavePolicy"("organizationId");

-- CreateIndex
CREATE INDEX "LeaveRequest_organizationId_startDate_idx" ON "orgapp"."LeaveRequest"("organizationId", "startDate");

-- CreateIndex
CREATE INDEX "LeaveRequest_userId_status_idx" ON "orgapp"."LeaveRequest"("userId", "status");

-- AddForeignKey
ALTER TABLE "orgapp"."LeavePolicy" ADD CONSTRAINT "LeavePolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "orgapp"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orgapp"."LeaveRequest" ADD CONSTRAINT "LeaveRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "orgapp"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orgapp"."LeaveRequest" ADD CONSTRAINT "LeaveRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "orgapp"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Restrict, not Cascade: a policy with requests against it is retired
-- (active = false), never deleted, or a year of pricing loses its meaning.
ALTER TABLE "orgapp"."LeaveRequest" ADD CONSTRAINT "LeaveRequest_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "orgapp"."LeavePolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
-- SetNull, like Attendance.markedById: this is routing, not ownership. An
-- approver who leaves must not block their own deletion nor take the team's
-- leave history with them.
ALTER TABLE "orgapp"."LeaveRequest" ADD CONSTRAINT "LeaveRequest_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "orgapp"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- An allowance is a count, not a signed quantity.
ALTER TABLE "orgapp"."LeavePolicy"
  ADD CONSTRAINT "LeavePolicy_allowance_nonnegative" CHECK ("allowance" >= 0);

-- The range is inclusive and ordered. Prisma's schema language cannot say so.
ALTER TABLE "orgapp"."LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_range_ordered" CHECK ("endDate" >= "startDate");

-- Zero is legal — an all-weekend range costs nothing and is still a filing.
-- Negative is not.
ALTER TABLE "orgapp"."LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_cost_nonnegative" CHECK ("cost" >= 0);
```

- [ ] **Step 4: Write the failing test**

Create `tests/leave.integration.test.ts`. This file grows through Tasks 4 and 5; it starts as the constraint checks.

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

/**
 * Leave policies and leave requests against the Dockerized Postgres.
 *
 * Same approach as holidays.integration.test.ts: the session is stubbed and
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

const RUN = `lv-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

let orgId: string;
let otherOrgId: string;
let adminId: string;
let managerId: string;
let memberId: string;
let chennaiId: string;
let delhiId: string;
let casualId: string;
let shortId: string;
let otherPolicyId: string;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `${RUN} Org` } });
  orgId = org.id;

  const other = await prisma.organization.create({ data: { name: `${RUN} Other` } });
  otherOrgId = other.id;

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

  const manager = await prisma.user.create({
    data: {
      name: "Run Manager",
      email: email("manager"),
      passwordHash: "x",
      role: Role.MEMBER,
      organizationId: orgId,
      regionId: chennaiId,
    },
  });
  managerId = manager.id;

  const member = await prisma.user.create({
    data: {
      name: "Run Member",
      email: email("member"),
      passwordHash: "x",
      role: Role.MEMBER,
      organizationId: orgId,
      regionId: chennaiId,
      managerId: manager.id,
    },
  });
  memberId = member.id;

  const casual = await prisma.leavePolicy.create({
    data: { organizationId: orgId, name: "Casual", allowance: 6, position: 0 },
  });
  casualId = casual.id;

  const short = await prisma.leavePolicy.create({
    data: {
      organizationId: orgId,
      name: "Short leave",
      allowance: 4,
      unit: "USES",
      position: 3,
    },
  });
  shortId = short.id;

  const foreign = await prisma.leavePolicy.create({
    data: { organizationId: otherOrgId, name: "Casual", allowance: 6 },
  });
  otherPolicyId = foreign.id;
});

afterAll(async () => {
  await prisma.leaveRequest.deleteMany({ where: { organizationId: orgId } });
  await prisma.leavePolicy.deleteMany({ where: { organizationId: orgId } });
  await prisma.leavePolicy.deleteMany({ where: { organizationId: otherOrgId } });
  await prisma.holiday.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.region.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.organization.delete({ where: { id: otherOrgId } });
  await prisma.$disconnect();
});

describe("the database enforces what the schema cannot say", () => {
  it("refuses endDate before startDate", async () => {
    await expect(
      prisma.leaveRequest.create({
        data: {
          organizationId: orgId,
          userId: memberId,
          policyId: casualId,
          startDate: new Date("2026-09-10"),
          endDate: new Date("2026-09-09"),
          cost: 1,
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses a negative cost but allows zero", async () => {
    await expect(
      prisma.leaveRequest.create({
        data: {
          organizationId: orgId,
          userId: memberId,
          policyId: casualId,
          startDate: new Date("2026-09-12"),
          endDate: new Date("2026-09-13"),
          cost: -1,
        },
      }),
    ).rejects.toThrow();

    const free = await prisma.leaveRequest.create({
      data: {
        organizationId: orgId,
        userId: memberId,
        policyId: casualId,
        startDate: new Date("2026-09-12"),
        endDate: new Date("2026-09-13"),
        cost: 0,
      },
    });
    expect(free.cost).toBe(0);
    await prisma.leaveRequest.delete({ where: { id: free.id } });
  });

  it("refuses a negative allowance", async () => {
    await expect(
      prisma.leavePolicy.create({
        data: { organizationId: orgId, name: "Impossible", allowance: -1 },
      }),
    ).rejects.toThrow();
  });

  it("refuses two policies with one name in one organization", async () => {
    await expect(
      prisma.leavePolicy.create({
        data: { organizationId: orgId, name: "Casual", allowance: 9 },
      }),
    ).rejects.toThrow();
  });

  it("lets two organizations each have a Casual policy", async () => {
    const foreign = await prisma.leavePolicy.findUnique({
      where: { id: otherPolicyId },
      select: { name: true, organizationId: true },
    });
    expect(foreign).toEqual({ name: "Casual", organizationId: otherOrgId });
  });

  it("refuses to delete a policy that has requests against it", async () => {
    const request = await prisma.leaveRequest.create({
      data: {
        organizationId: orgId,
        userId: memberId,
        policyId: casualId,
        startDate: new Date("2026-09-14"),
        endDate: new Date("2026-09-14"),
        cost: 1,
      },
    });

    await expect(
      prisma.leavePolicy.delete({ where: { id: casualId } }),
    ).rejects.toThrow();

    await prisma.leaveRequest.delete({ where: { id: request.id } });
  });
});
```

Note `delhiId`, `adminId`, `shortId` and `managerId` are unused until Tasks 4 and 5; declare them now so the fixture is written once. If the linter objects to an unused binding before then, that is expected and resolves in Task 4.

- [ ] **Step 5: Run it and watch it fail**

```bash
docker compose up -d
npx vitest run tests/leave.integration.test.ts
```

Expected: FAIL — `prisma.leavePolicy` is not a property on the client, because the migration has not been applied and the client has not been regenerated.

- [ ] **Step 6: Apply the migration and regenerate**

```bash
npx prisma migrate dev
```

This applies the edited SQL and regenerates the client into `generated/prisma`.

- [ ] **Step 7: Run it and watch it pass**

```bash
npx vitest run tests/leave.integration.test.ts
```

Expected: PASS, six tests.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations tests/leave.integration.test.ts
git commit -m "Add the LeavePolicy and LeaveRequest tables"
```

---

### Task 2: Pure leave arithmetic — `lib/leave.ts`

**Files:**
- Create: `lib/leave.ts`
- Test: `tests/leave.test.ts`

**Interfaces:**
- Consumes: `addDays`, `isWeekend` from `@/lib/date`.
- Produces:
  - `type LeaveUnitName = "DAYS" | "USES"`
  - `type DateRange = { startDate: string; endDate: string }`
  - `datesInRange(from: string, to: string): string[]`
  - `offDates(ranges: readonly DateRange[]): Set<string>`
  - `chargeableDays(from: string, to: string, off: ReadonlySet<string>): string[]`
  - `costFrom(unit: LeaveUnitName, from: string, to: string, off: ReadonlySet<string>): number`
  - `effectiveEndDate(unit: LeaveUnitName, from: string, to: string): string`
  - `chargeYear(startDate: string): number`
  - `unitNoun(unit: LeaveUnitName, count: number): string`

**This module is imported by `components/apply-form.tsx`, a client component.** It may import `lib/date.ts` and nothing else. `DateRange` is declared structurally rather than importing `HolidayRecord` from `lib/holidays.ts` precisely because that file imports `lib/rbac.ts`, which imports the generated Prisma enums — importing it here would pull the Prisma client into the browser bundle. `HolidayRecord` is assignable to `DateRange` without a cast.

- [ ] **Step 1: Write the failing tests**

Create `tests/leave.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  chargeYear,
  chargeableDays,
  costFrom,
  datesInRange,
  effectiveEndDate,
  offDates,
  unitNoun,
} from "@/lib/leave";

/** 2026-09-07 is a Monday; 2026-09-12 a Saturday; 2026-09-13 a Sunday. */

describe("datesInRange", () => {
  it("is inclusive at both ends", () => {
    expect(datesInRange("2026-09-07", "2026-09-09")).toEqual([
      "2026-09-07",
      "2026-09-08",
      "2026-09-09",
    ]);
  });

  it("returns the single day when both ends match", () => {
    expect(datesInRange("2026-09-07", "2026-09-07")).toEqual(["2026-09-07"]);
  });

  it("returns nothing for a reversed range rather than looping forever", () => {
    expect(datesInRange("2026-09-09", "2026-09-07")).toEqual([]);
  });

  it("crosses a month boundary", () => {
    expect(datesInRange("2026-08-31", "2026-09-01")).toEqual([
      "2026-08-31",
      "2026-09-01",
    ]);
  });
});

describe("offDates", () => {
  it("expands every day a holiday covers", () => {
    const off = offDates([{ startDate: "2026-11-08", endDate: "2026-11-09" }]);
    expect([...off].sort()).toEqual(["2026-11-08", "2026-11-09"]);
  });

  it("merges overlapping holidays into one set", () => {
    const off = offDates([
      { startDate: "2026-11-08", endDate: "2026-11-09" },
      { startDate: "2026-11-09", endDate: "2026-11-10" },
    ]);
    expect(off.size).toBe(3);
  });

  it("is empty for no holidays", () => {
    expect(offDates([]).size).toBe(0);
  });
});

describe("chargeableDays", () => {
  const none = new Set<string>();

  it("skips the weekend", () => {
    // Fri 11th to Mon 14th: only the Friday and the Monday count.
    expect(chargeableDays("2026-09-11", "2026-09-14", none)).toEqual([
      "2026-09-11",
      "2026-09-14",
    ]);
  });

  it("skips a holiday that falls on a weekday", () => {
    const off = new Set(["2026-09-08"]);
    expect(chargeableDays("2026-09-07", "2026-09-09", off)).toEqual([
      "2026-09-07",
      "2026-09-09",
    ]);
  });

  it("does not double-discount a holiday that falls on a weekend", () => {
    const off = new Set(["2026-09-12"]);
    expect(chargeableDays("2026-09-11", "2026-09-14", off)).toEqual([
      "2026-09-11",
      "2026-09-14",
    ]);
  });

  it("is empty when every day is a weekend or a holiday", () => {
    const off = new Set(["2026-09-11"]);
    expect(chargeableDays("2026-09-11", "2026-09-13", off)).toEqual([]);
  });
});

describe("costFrom", () => {
  const none = new Set<string>();

  it("counts working days for a DAYS policy", () => {
    expect(costFrom("DAYS", "2026-09-07", "2026-09-09", none)).toBe(3);
  });

  it("is always 1 for a USES policy, however long the range", () => {
    expect(costFrom("USES", "2026-09-07", "2026-09-30", none)).toBe(1);
  });

  it("is 1 for a USES policy even on a weekend", () => {
    expect(costFrom("USES", "2026-09-12", "2026-09-12", none)).toBe(1);
  });

  it("is 0 for an all-weekend DAYS range — a filing, priced at nothing", () => {
    expect(costFrom("DAYS", "2026-09-12", "2026-09-13", none)).toBe(0);
  });
});

describe("effectiveEndDate", () => {
  it("collapses a USES range to its start day", () => {
    expect(effectiveEndDate("USES", "2026-09-07", "2026-09-30")).toBe("2026-09-07");
  });

  it("leaves a DAYS range alone", () => {
    expect(effectiveEndDate("DAYS", "2026-09-07", "2026-09-09")).toBe("2026-09-09");
  });
});

describe("chargeYear", () => {
  it("charges a request to the year it starts in", () => {
    expect(chargeYear("2026-12-30")).toBe(2026);
  });

  it("does not follow the range into January", () => {
    // The request runs 30 Dec to 2 Jan; it is a 2026 request.
    expect(chargeYear("2026-12-30")).toBe(2026);
    expect(chargeYear("2027-01-02")).toBe(2027);
  });
});

describe("unitNoun", () => {
  it("singularises at exactly one", () => {
    expect(unitNoun("DAYS", 1)).toBe("day");
    expect(unitNoun("USES", 1)).toBe("use");
  });

  it("pluralises at zero and above one", () => {
    expect(unitNoun("DAYS", 0)).toBe("days");
    expect(unitNoun("DAYS", 3)).toBe("days");
    expect(unitNoun("USES", 2)).toBe("uses");
  });

  it("singularises a negative one — an over-drawn balance reads as -1 day", () => {
    expect(unitNoun("DAYS", -1)).toBe("day");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/leave.test.ts
```

Expected: FAIL — cannot resolve `@/lib/leave`.

- [ ] **Step 3: Write `lib/leave.ts`**

```ts
import { addDays, isWeekend } from "@/lib/date";

/**
 * The leave arithmetic, as pure functions.
 *
 * No Prisma and no session here, so the whole rule set is unit testable — the
 * same split lib/attendance.ts has from lib/attendance-service.ts.
 *
 * This module is also imported by components/apply-form.tsx, a client
 * component, so that the cost previewed while typing and the cost written to
 * the database come from the same function and cannot disagree. That is why it
 * imports lib/date.ts and nothing else: lib/holidays.ts would reach
 * lib/rbac.ts and pull the generated Prisma client into the browser bundle.
 */

/**
 * Mirrors the `LeaveUnit` enum in the schema.
 *
 * Declared as a string union rather than imported from `@/generated/prisma/enums`
 * for the client-safety reason above. `lib/leave-service.ts` converts between
 * the two through a one-line function, so a rename in the schema breaks the
 * build there rather than silently at runtime here.
 */
export type LeaveUnitName = "DAYS" | "USES";

/**
 * An inclusive span of days — the shape of a holiday, described structurally.
 *
 * `HolidayRecord` from lib/holidays.ts is assignable to this without a cast,
 * which is the whole point: the server passes holidays straight in, and the
 * client passes a plain list of dates it already has.
 */
export type DateRange = { startDate: string; endDate: string };

/** Every date in an inclusive range, ascending. Empty if the range is reversed. */
export function datesInRange(from: string, to: string): string[] {
  const dates: string[] = [];
  // A reversed range must terminate rather than loop forever: the CHECK
  // constraint guards the table, but this function is called on form input
  // that has not reached it yet.
  for (let date = from; date <= to; date = addDays(date, 1)) dates.push(date);
  return dates;
}

/** Every day covered by any of the ranges, as a set for O(1) lookup. */
export function offDates(ranges: readonly DateRange[]): Set<string> {
  const dates = new Set<string>();
  for (const range of ranges) {
    for (const date of datesInRange(range.startDate, range.endDate)) dates.add(date);
  }
  return dates;
}

/**
 * The days a request actually costs: weekdays in the range that are not
 * already off.
 *
 * A holiday falling on a Saturday discounts nothing, because the Saturday was
 * never chargeable — the filter is one pass, not two subtractions.
 */
export function chargeableDays(
  from: string,
  to: string,
  off: ReadonlySet<string>,
): string[] {
  return datesInRange(from, to).filter((date) => !isWeekend(date) && !off.has(date));
}

/**
 * What a request costs against its policy.
 *
 * A `USES` policy is one occurrence however long the range is — a short leave
 * taken on a Saturday still spends the one use.
 */
export function costFrom(
  unit: LeaveUnitName,
  from: string,
  to: string,
  off: ReadonlySet<string>,
): number {
  return unit === "USES" ? 1 : chargeableDays(from, to, off).length;
}

/**
 * The end date actually stored.
 *
 * A `USES` request collapses to its start day, so the stored row says what the
 * request means rather than what the form happened to be showing.
 */
export function effectiveEndDate(
  unit: LeaveUnitName,
  from: string,
  to: string,
): string {
  return unit === "USES" ? from : to;
}

/**
 * The calendar year a request is charged to.
 *
 * The year of the *start* date, so a request running 30 December to 2 January
 * belongs entirely to the year it began in. Splitting it across two balances
 * would be more accurate and much harder to explain to the person filing it.
 */
export function chargeYear(startDate: string): number {
  return Number(startDate.slice(0, 4));
}

/** `day`/`days` for a DAYS policy, `use`/`uses` for a USES one. */
export function unitNoun(unit: LeaveUnitName, count: number): string {
  const singular = Math.abs(count) === 1;
  if (unit === "USES") return singular ? "use" : "uses";
  return singular ? "day" : "days";
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
npx vitest run tests/leave.test.ts
```

Expected: PASS, all of them.

- [ ] **Step 5: Commit**

```bash
git add lib/leave.ts tests/leave.test.ts
git commit -m "Add pure leave arithmetic with holiday-aware day counting"
```

---

### Task 3: Authorization predicates

**Files:**
- Modify: `lib/rbac.ts`
- Test: `tests/rbac.test.ts`

**Interfaces:**
- Consumes: `Actor`, `Role` — already there.
- Produces: `canListLeavePolicies(actor: Actor): boolean`, `canApplyForLeave(actor: Actor): boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/rbac.test.ts`, reusing the existing `adminA` / `memberA` / `superadmin` fixtures at the top of that file:

```ts
describe("who can read leave policies", () => {
  it("allows a member and an admin inside an organization", () => {
    expect(canListLeavePolicies(memberA)).toBe(true);
    expect(canListLeavePolicies(adminA)).toBe(true);
  });

  it("denies a superadmin, who belongs to no organization to have policies in", () => {
    expect(canListLeavePolicies(superadmin)).toBe(false);
  });
});

describe("who can apply for leave", () => {
  it("allows a member", () => {
    expect(canApplyForLeave(memberA)).toBe(true);
  });

  it("allows an admin — admins take leave too", () => {
    expect(canApplyForLeave(adminA)).toBe(true);
  });

  it("denies a superadmin", () => {
    expect(canApplyForLeave(superadmin)).toBe(false);
  });

  it("denies an org-bound role whose organization is somehow missing", () => {
    expect(canApplyForLeave({ ...memberA, organizationId: null })).toBe(false);
  });
});
```

Add `canApplyForLeave` and `canListLeavePolicies` to that file's existing import from `@/lib/rbac`, keeping the list alphabetical.

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/rbac.test.ts
```

Expected: FAIL — the two functions are not exported.

- [ ] **Step 3: Add the predicates to `lib/rbac.ts`**

Put both next to `canListHolidays`, whose audience they narrow:

```ts
/**
 * Leave policies are an organization's own entitlements, so unlike
 * `canListHolidays` this excludes a SUPERADMIN: they belong to no
 * organization, and answering them with an empty list would misreport "your
 * organization grants nothing" as though it were a fact about somebody.
 */
export function canListLeavePolicies(actor: Actor): boolean {
  return (
    (actor.role === Role.ADMIN || actor.role === Role.MEMBER) &&
    actor.organizationId !== null
  );
}

/**
 * Applying is self-service: the applicant is always the caller, so there is no
 * target to compare against and no id to tamper with.
 *
 * ADMIN is allowed deliberately — an admin is a person who takes leave, and
 * the API should not pretend otherwise. `/apply` itself stays MEMBER-only
 * because app/(member)/layout.tsx gates the whole group; the day an admin
 * needs the screen, that gate is what changes, not this predicate.
 *
 * Written out rather than delegating to `canListLeavePolicies`, whose rule it
 * currently matches by coincidence and not by definition.
 */
export function canApplyForLeave(actor: Actor): boolean {
  return (
    (actor.role === Role.ADMIN || actor.role === Role.MEMBER) &&
    actor.organizationId !== null
  );
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
git commit -m "Add leave policy and apply-for-leave authorization predicates"
```

---

### Task 4: The leave service — `lib/leave-service.ts`

**Files:**
- Create: `lib/leave-service.ts`
- Test: `tests/leave.integration.test.ts` (modify — the file from Task 1)

**Interfaces:**
- Consumes: `Actor`, `HttpError`, `canApplyForLeave`, `canListLeavePolicies` from `@/lib/rbac`; `fromDbDate`, `toDbDate`, `todayIso` from `@/lib/attendance`; `listHolidays` from `@/lib/holiday-service`; `chargeYear`, `costFrom`, `effectiveEndDate`, `offDates`, `LeaveUnitName` from `@/lib/leave`.
- Produces:
  - `type LeavePolicyRecord = { id, name, note, allowance, unit: LeaveUnitName, carry }`
  - `type LeaveBalanceRecord = LeavePolicyRecord & { used: number; balance: number }`
  - `type ApproverRecord = { id: string; name: string } | null`
  - `type LeaveSummary = { year: number; balances: LeaveBalanceRecord[]; approver: ApproverRecord }`
  - `type LeaveRequestInput = { policyId, startDate, endDate, reason: string | null }`
  - `type LeaveRequestRecord = { id, policy: { id, name, unit }, startDate, endDate, cost, reason, status, approver, createdAt }`
  - `listLeavePolicies(actor): Promise<LeavePolicyRecord[]>`
  - `listOwnLeaveSummary(actor, year?): Promise<LeaveSummary>`
  - `listOwnLeaveRequests(actor): Promise<LeaveRequestRecord[]>`
  - `findOwnLeaveRequest(actor, id): Promise<LeaveRequestRecord | null>`
  - `createOwnLeaveRequest(actor, input): Promise<LeaveRequestRecord>`

- [ ] **Step 1: Write the failing tests**

Add the service import next to the existing Prisma import at the top of `tests/leave.integration.test.ts`:

```ts
const { prisma } = await import("@/lib/prisma");
const service = await import("@/lib/leave-service");
```

Then append the helpers and suites below. September 2026: the 7th is a Monday, the 11th a Friday, the 12th and 13th the weekend, the 14th a Monday. November 2026: the 8th is a Sunday and the 9th a Monday, which is why Diwali is the holiday worth testing — it covers one weekend day that was never chargeable and one weekday that was.

```ts
const memberActor = (): Actor => ({
  id: memberId,
  role: Role.MEMBER,
  organizationId: orgId,
});

const adminActor = (): Actor => ({
  id: adminId,
  role: Role.ADMIN,
  organizationId: orgId,
});

const superActor = (): Actor => ({
  id: "super",
  role: Role.SUPERADMIN,
  organizationId: null,
});

async function clearRequests(): Promise<void> {
  await prisma.leaveRequest.deleteMany({ where: { organizationId: orgId } });
}

async function clearHolidays(): Promise<void> {
  await prisma.holiday.deleteMany({ where: { organizationId: orgId } });
}

describe("listing leave policies", () => {
  it("returns the caller's own organization's active policies, in order", async () => {
    const policies = await service.listLeavePolicies(memberActor());

    expect(policies.map((p) => p.name)).toEqual(["Casual", "Short leave"]);
    expect(policies[0]).toMatchObject({ allowance: 6, unit: "DAYS" });
    expect(policies[1]).toMatchObject({ allowance: 4, unit: "USES" });
  });

  it("never returns another organization's policies", async () => {
    const policies = await service.listLeavePolicies(memberActor());
    expect(policies.map((p) => p.id)).not.toContain(otherPolicyId);
  });

  it("hides a retired policy", async () => {
    const retired = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: "Sabbatical",
        allowance: 30,
        active: false,
      },
    });

    const policies = await service.listLeavePolicies(memberActor());
    expect(policies.map((p) => p.name)).not.toContain("Sabbatical");

    await prisma.leavePolicy.delete({ where: { id: retired.id } });
  });

  it("refuses a superadmin, who has no organization to have policies in", async () => {
    await expect(service.listLeavePolicies(superActor())).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("the member's own leave summary", () => {
  it("starts every balance at the full allowance", async () => {
    await clearRequests();
    const summary = await service.listOwnLeaveSummary(memberActor(), 2026);

    expect(summary.year).toBe(2026);
    expect(summary.balances).toEqual([
      expect.objectContaining({ name: "Casual", used: 0, balance: 6 }),
      expect.objectContaining({ name: "Short leave", used: 0, balance: 4 }),
    ]);
  });

  it("routes to the applicant's manager", async () => {
    const summary = await service.listOwnLeaveSummary(memberActor(), 2026);
    expect(summary.approver).toEqual({ id: managerId, name: "Run Manager" });
  });

  it("falls back to an admin when the applicant has no manager", async () => {
    // The manager has none of their own.
    const summary = await service.listOwnLeaveSummary(
      { id: managerId, role: Role.MEMBER, organizationId: orgId },
      2026,
    );
    expect(summary.approver).toEqual({ id: adminId, name: "Run Admin" });
  });

  it("counts a pending request against the balance", async () => {
    await clearRequests();
    await clearHolidays();

    // Monday to Wednesday: three working days.
    await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-09-07",
      endDate: "2026-09-09",
      reason: null,
    });

    const summary = await service.listOwnLeaveSummary(memberActor(), 2026);
    expect(summary.balances[0]).toMatchObject({ used: 3, balance: 3 });
  });

  it("frees the days again when the request is withdrawn", async () => {
    await prisma.leaveRequest.updateMany({
      where: { userId: memberId },
      data: { status: "WITHDRAWN" },
    });

    const summary = await service.listOwnLeaveSummary(memberActor(), 2026);
    expect(summary.balances[0]).toMatchObject({ used: 0, balance: 6 });
  });

  it("charges a year-spanning request to the year it starts in", async () => {
    await clearRequests();

    // 31 December 2026 is a Thursday; the request runs into January.
    await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-12-31",
      endDate: "2027-01-01",
      reason: null,
    });

    const in2026 = await service.listOwnLeaveSummary(memberActor(), 2026);
    const in2027 = await service.listOwnLeaveSummary(memberActor(), 2027);

    expect(in2026.balances[0].used).toBe(2);
    expect(in2027.balances[0].used).toBe(0);
  });
});

describe("filing a leave request", () => {
  it("stores the working days, the organization and a PENDING status", async () => {
    await clearRequests();
    await clearHolidays();

    const created = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-09-11",
      endDate: "2026-09-14",
      reason: "Family thing",
    });

    // Friday and Monday; the weekend between them is free.
    expect(created).toMatchObject({
      cost: 2,
      status: "PENDING",
      startDate: "2026-09-11",
      endDate: "2026-09-14",
      reason: "Family thing",
      approver: { id: managerId, name: "Run Manager" },
    });

    const stored = await prisma.leaveRequest.findUnique({
      where: { id: created.id },
      select: { organizationId: true, userId: true },
    });
    expect(stored).toEqual({ organizationId: orgId, userId: memberId });
  });

  it("does not charge a holiday in the applicant's own region", async () => {
    await clearRequests();
    await clearHolidays();

    await prisma.holiday.create({
      data: {
        organizationId: orgId,
        regionId: chennaiId,
        name: "Diwali",
        startDate: new Date("2026-11-08"),
        endDate: new Date("2026-11-09"),
      },
    });

    // Monday to Wednesday, with the Monday covered by Diwali.
    const created = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-11-09",
      endDate: "2026-11-11",
      reason: null,
    });

    expect(created.cost).toBe(2);
  });

  it("does charge a holiday that belongs to another region", async () => {
    await clearRequests();
    await clearHolidays();

    await prisma.holiday.create({
      data: {
        organizationId: orgId,
        regionId: delhiId,
        name: "Delhi-only day",
        startDate: new Date("2026-11-09"),
        endDate: new Date("2026-11-09"),
      },
    });

    // The member is in Chennai, so the Delhi holiday is a working day for them.
    const created = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-11-09",
      endDate: "2026-11-11",
      reason: null,
    });

    expect(created.cost).toBe(3);
  });

  it("keeps the cost it was priced at when a holiday is added later", async () => {
    await clearRequests();
    await clearHolidays();

    const created = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-11-09",
      endDate: "2026-11-11",
      reason: null,
    });
    expect(created.cost).toBe(3);

    await prisma.holiday.create({
      data: {
        organizationId: orgId,
        regionId: chennaiId,
        name: "Declared afterwards",
        startDate: new Date("2026-11-10"),
        endDate: new Date("2026-11-10"),
      },
    });

    const reread = await service.findOwnLeaveRequest(memberActor(), created.id);
    expect(reread?.cost).toBe(3);
  });

  it("collapses a USES request to one day and one use", async () => {
    await clearRequests();
    await clearHolidays();

    const created = await service.createOwnLeaveRequest(memberActor(), {
      policyId: shortId,
      startDate: "2026-09-07",
      endDate: "2026-09-30",
      reason: null,
    });

    expect(created).toMatchObject({
      cost: 1,
      startDate: "2026-09-07",
      endDate: "2026-09-07",
    });
  });

  it("refuses a range that overlaps an existing pending request", async () => {
    await clearRequests();
    await clearHolidays();

    await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-09-07",
      endDate: "2026-09-09",
      reason: null,
    });

    await expect(
      service.createOwnLeaveRequest(memberActor(), {
        policyId: casualId,
        startDate: "2026-09-09",
        endDate: "2026-09-11",
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("allows a range that starts the day after an existing one ends", async () => {
    // The 7th-9th request from the previous test is still there.
    const created = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-09-10",
      endDate: "2026-09-11",
      reason: null,
    });

    expect(created.cost).toBe(2);
  });

  it("ignores a rejected request when checking for an overlap", async () => {
    await clearRequests();

    const first = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-09-07",
      endDate: "2026-09-09",
      reason: null,
    });
    await prisma.leaveRequest.update({
      where: { id: first.id },
      data: { status: "REJECTED" },
    });

    const second = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-09-07",
      endDate: "2026-09-09",
      reason: null,
    });
    expect(second.cost).toBe(3);
  });

  it("hides another organization's policy behind a 404", async () => {
    await expect(
      service.createOwnLeaveRequest(memberActor(), {
        policyId: otherPolicyId,
        startDate: "2026-10-05",
        endDate: "2026-10-05",
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses a retired policy the same way", async () => {
    const retired = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: "Retired",
        allowance: 5,
        active: false,
      },
    });

    await expect(
      service.createOwnLeaveRequest(memberActor(), {
        policyId: retired.id,
        startDate: "2026-10-05",
        endDate: "2026-10-05",
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 404 });

    await prisma.leavePolicy.delete({ where: { id: retired.id } });
  });

  it("refuses a superadmin, who belongs to no organization", async () => {
    await expect(
      service.createOwnLeaveRequest(superActor(), {
        policyId: casualId,
        startDate: "2026-10-05",
        endDate: "2026-10-05",
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lets an admin file their own request", async () => {
    await clearRequests();

    const created = await service.createOwnLeaveRequest(adminActor(), {
      policyId: casualId,
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      reason: null,
    });

    expect(created.cost).toBe(1);
  });
});

describe("reading one's own requests", () => {
  it("returns only the caller's own, newest first", async () => {
    await clearRequests();

    await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-09-07",
      endDate: "2026-09-07",
      reason: null,
    });
    await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-10-05",
      endDate: "2026-10-05",
      reason: null,
    });
    await service.createOwnLeaveRequest(adminActor(), {
      policyId: casualId,
      startDate: "2026-11-02",
      endDate: "2026-11-02",
      reason: null,
    });

    const mine = await service.listOwnLeaveRequests(memberActor());
    expect(mine.map((r) => r.startDate)).toEqual(["2026-10-05", "2026-09-07"]);
  });

  it("returns null for a request that belongs to somebody else", async () => {
    const theirs = await service.listOwnLeaveRequests(adminActor());
    const found = await service.findOwnLeaveRequest(memberActor(), theirs[0].id);
    expect(found).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/leave.integration.test.ts
```

Expected: FAIL — cannot resolve `@/lib/leave-service`.

- [ ] **Step 3: Write `lib/leave-service.ts`**

```ts
// Prisma 7 generates each enum as a const object plus a same-named type, so
// one plain import gives both the values and the type.
import {
  EmploymentStatus,
  LeaveRequestStatus,
  type LeaveUnit,
  Role,
} from "@/generated/prisma/enums";
import { fromDbDate, toDbDate, todayIso } from "@/lib/attendance";
import { listHolidays } from "@/lib/holiday-service";
import {
  type LeaveUnitName,
  chargeYear,
  costFrom,
  effectiveEndDate,
  offDates,
} from "@/lib/leave";
import { prisma } from "@/lib/prisma";
import {
  type Actor,
  HttpError,
  canApplyForLeave,
  canListLeavePolicies,
} from "@/lib/rbac";

/**
 * Everything that reads or writes leave policies and leave requests.
 *
 * Same contract as lib/holiday-service.ts: the route handlers and the Server
 * Action hand in an `Actor` they have already authenticated, and every
 * authorization decision is made here, once per operation.
 *
 * Every operation in this file is self-scoped. There is no `userId` parameter
 * anywhere in it — the applicant is the session — so there is no id for a
 * member to tamper with and no path that could reach a colleague's leave. The
 * roster-wide read belongs to /approvals and gets its own predicate when that
 * screen moves off the fixture.
 */

/** Requests in these states have already spent their days. */
const SPENT: LeaveRequestStatus[] = [
  LeaveRequestStatus.PENDING,
  LeaveRequestStatus.APPROVED,
];

const POLICY_FIELDS = {
  id: true,
  name: true,
  note: true,
  allowance: true,
  unit: true,
  carry: true,
} as const;

const REQUEST_FIELDS = {
  id: true,
  startDate: true,
  endDate: true,
  cost: true,
  reason: true,
  status: true,
  createdAt: true,
  policy: { select: { id: true, name: true, unit: true } },
  approver: { select: { id: true, name: true } },
} as const;

export type LeavePolicyRecord = {
  id: string;
  name: string;
  note: string | null;
  allowance: number;
  unit: LeaveUnitName;
  carry: boolean;
};

export type LeaveBalanceRecord = LeavePolicyRecord & {
  /** Days (or uses) already spent this year on PENDING and APPROVED requests. */
  used: number;
  /** May go negative: an over-balance request is filed, not refused. */
  balance: number;
};

export type ApproverRecord = { id: string; name: string } | null;

export type LeaveSummary = {
  year: number;
  balances: LeaveBalanceRecord[];
  approver: ApproverRecord;
};

export type LeaveRequestInput = {
  policyId: string;
  startDate: string;
  /** Inclusive. The parser defaults it to `startDate` for a one-day request. */
  endDate: string;
  reason: string | null;
};

export type LeaveRequestRecord = {
  id: string;
  policy: { id: string; name: string; unit: LeaveUnitName };
  startDate: string;
  endDate: string;
  cost: number;
  reason: string | null;
  status: LeaveRequestStatus;
  approver: ApproverRecord;
  createdAt: string;
};

type RequestRow = {
  id: string;
  startDate: Date;
  endDate: Date;
  cost: number;
  reason: string | null;
  status: LeaveRequestStatus;
  createdAt: Date;
  policy: { id: string; name: string; unit: LeaveUnit };
  approver: { id: string; name: string } | null;
};

/**
 * The schema's enum as the client-safe union lib/leave.ts speaks.
 *
 * A function rather than a cast, so renaming a member of `LeaveUnit` fails the
 * type check right here instead of silently mispricing every USES request.
 */
function unitName(unit: LeaveUnit): LeaveUnitName {
  return unit;
}

function toRecord(row: RequestRow): LeaveRequestRecord {
  return {
    id: row.id,
    policy: { ...row.policy, unit: unitName(row.policy.unit) },
    startDate: fromDbDate(row.startDate),
    endDate: fromDbDate(row.endDate),
    cost: row.cost,
    reason: row.reason,
    status: row.status,
    approver: row.approver,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The organization a caller may file leave in, or a 403. */
function applicantOrgFor(actor: Actor): string {
  const organizationId = actor.organizationId;
  if (!organizationId || !canApplyForLeave(actor)) {
    throw new HttpError(403, "Only a member of an organization can apply for leave.");
  }
  return organizationId;
}

/** The DATE bounds of one calendar year. */
function yearWindow(year: number): { gte: Date; lte: Date } {
  return { gte: toDbDate(`${year}-01-01`), lte: toDbDate(`${year}-12-31`) };
}

/**
 * Who a request goes to: the applicant's manager, or failing that the
 * organization's longest-standing active admin, or nobody.
 *
 * A fallback rather than a requirement. A one-person organization and a member
 * whose manager has left are both real, and neither should leave somebody
 * unable to file at all.
 */
async function approverFor(
  manager: ApproverRecord,
  organizationId: string,
): Promise<ApproverRecord> {
  if (manager) return manager;

  return prisma.user.findFirst({
    where: { organizationId, role: Role.ADMIN, status: EmploymentStatus.ACTIVE },
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
}

/* --------------------------------------------------------------- reading -- */

export async function listLeavePolicies(actor: Actor): Promise<LeavePolicyRecord[]> {
  if (!canListLeavePolicies(actor) || !actor.organizationId) {
    throw new HttpError(403, "Your role does not permit this action.");
  }

  const rows = await prisma.leavePolicy.findMany({
    where: { organizationId: actor.organizationId, active: true },
    select: POLICY_FIELDS,
    orderBy: [{ position: "asc" }, { name: "asc" }],
  });

  return rows.map((row) => ({ ...row, unit: unitName(row.unit) }));
}

/**
 * Every policy with what this member has left of it, plus who their requests
 * go to — one call, because the Apply screen needs all of it at once.
 *
 * The balance is derived rather than stored: allowance minus the cost of the
 * requests that have already spent it. PENDING counts alongside APPROVED, or
 * a member could file the same six days three times before anyone looked at
 * the first one. Withdrawn and rejected requests free their days by falling
 * out of the filter, which is the whole reason there is no ledger to reconcile.
 */
export async function listOwnLeaveSummary(
  actor: Actor,
  year: number = chargeYear(todayIso()),
): Promise<LeaveSummary> {
  const organizationId = applicantOrgFor(actor);

  const applicant = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { manager: { select: { id: true, name: true } } },
  });
  if (!applicant) throw new HttpError(401, "Your account no longer exists.");

  const [policies, spent, approver] = await Promise.all([
    listLeavePolicies(actor),
    prisma.leaveRequest.groupBy({
      by: ["policyId"],
      where: {
        userId: actor.id,
        status: { in: SPENT },
        startDate: yearWindow(year),
      },
      _sum: { cost: true },
    }),
    approverFor(applicant.manager, organizationId),
  ]);

  const usedByPolicy = new Map(spent.map((row) => [row.policyId, row._sum.cost ?? 0]));

  return {
    year,
    balances: policies.map((policy) => {
      const used = usedByPolicy.get(policy.id) ?? 0;
      return { ...policy, used, balance: policy.allowance - used };
    }),
    approver,
  };
}

export async function listOwnLeaveRequests(
  actor: Actor,
): Promise<LeaveRequestRecord[]> {
  applicantOrgFor(actor);

  const rows = await prisma.leaveRequest.findMany({
    where: { userId: actor.id },
    select: REQUEST_FIELDS,
    orderBy: [{ startDate: "desc" }, { createdAt: "desc" }],
  });

  return rows.map(toRecord);
}

/**
 * One of the caller's own requests, or null.
 *
 * Scoped by `userId` inside the query rather than fetched and then checked, so
 * somebody else's id returns null down the same path a nonexistent one does.
 */
export async function findOwnLeaveRequest(
  actor: Actor,
  id: string,
): Promise<LeaveRequestRecord | null> {
  applicantOrgFor(actor);

  const row = await prisma.leaveRequest.findFirst({
    where: { id, userId: actor.id },
    select: REQUEST_FIELDS,
  });

  return row ? toRecord(row) : null;
}

/* --------------------------------------------------------------- writing -- */

export async function createOwnLeaveRequest(
  actor: Actor,
  input: LeaveRequestInput,
): Promise<LeaveRequestRecord> {
  if (!canApplyForLeave(actor)) {
    throw new HttpError(403, "Only a member of an organization can apply for leave.");
  }

  // The organization is read from the stored user, never taken from the
  // request. lib/attendance-service.ts follows the same rule for the same
  // reason: a denormalised tenancy column that trusts a body is a tenancy hole.
  const applicant = await prisma.user.findUnique({
    where: { id: actor.id },
    select: {
      organizationId: true,
      regionId: true,
      manager: { select: { id: true, name: true } },
    },
  });
  if (!applicant?.organizationId) {
    throw new HttpError(401, "Your account no longer exists.");
  }
  const organizationId = applicant.organizationId;

  const policy = await prisma.leavePolicy.findUnique({
    where: { id: input.policyId },
    select: { id: true, organizationId: true, unit: true, active: true },
  });
  // Scoped by the stored organizationId, so another organization's policy is
  // indistinguishable from one that does not exist. A retired policy answers
  // the same way: it is not a choice this member can make.
  if (!policy || policy.organizationId !== organizationId || !policy.active) {
    throw new HttpError(404, "That leave type does not exist.");
  }

  const unit = unitName(policy.unit);
  const startDate = input.startDate;
  const endDate = effectiveEndDate(unit, startDate, input.endDate);

  // `listHolidays` ignores the region a MEMBER asks for and uses their own, so
  // passing it here changes nothing for a member and gets an ADMIN's own
  // region right. A person with no region gets every region's holidays — the
  // same behaviour /calendar already has, and the reason to give everybody a
  // region rather than to special-case it here.
  const holidays = await listHolidays(actor, {
    from: startDate,
    to: endDate,
    regionId: applicant.regionId ?? undefined,
  });
  const cost = costFrom(unit, startDate, endDate, offDates(holidays));

  const approver = await approverFor(applicant.manager, organizationId);

  // The overlap check and the insert share a transaction, so two submits
  // racing each other cannot both pass the check. This narrows the window
  // rather than closing it: only a Postgres exclusion constraint over a
  // daterange would close it, and that is a bigger change than this screen
  // justifies today.
  const row = await prisma.$transaction(async (tx) => {
    const clash = await tx.leaveRequest.findFirst({
      where: {
        userId: actor.id,
        status: { in: SPENT },
        // Overlap, not containment: sharing a single day is enough.
        startDate: { lte: toDbDate(endDate) },
        endDate: { gte: toDbDate(startDate) },
      },
      select: { id: true },
    });
    if (clash) {
      throw new HttpError(409, "You already have a request covering those dates.");
    }

    return tx.leaveRequest.create({
      data: {
        organizationId,
        userId: actor.id,
        policyId: policy.id,
        startDate: toDbDate(startDate),
        endDate: toDbDate(endDate),
        cost,
        reason: input.reason,
        approverId: approver?.id ?? null,
      },
      select: REQUEST_FIELDS,
    });
  });

  return toRecord(row);
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
npx vitest run tests/leave.integration.test.ts
```

Expected: PASS, the whole file.

- [ ] **Step 5: Commit**

```bash
git add lib/leave-service.ts tests/leave.integration.test.ts
git commit -m "Add the leave service with derived balances and an overlap check"
```

---

### Task 5: The route handlers and `lib/leave-input.ts`

**Files:**
- Create: `lib/leave-input.ts`
- Create: `app/api/leave-policies/route.ts`
- Create: `app/api/leave-requests/route.ts`
- Test: `tests/leave.integration.test.ts` (modify)

**Interfaces:**
- Consumes: `optionalString`, `requiredString`, `readJson`, `errorResponse` from `@/lib/api`; `parseDateParam` from `@/lib/attendance`; `requireActor`, `HttpError` from `@/lib/rbac`; `currentActor` from `@/lib/auth`; the service from Task 4.
- Produces: `leaveRequestInputFrom(body: Record<string, unknown>): LeaveRequestInput`; the two route modules.

- [ ] **Step 1: Write the failing tests**

Append to `tests/leave.integration.test.ts`. Add the handler imports beside the service import at the top of the file:

```ts
const policyRoute = await import("@/app/api/leave-policies/route");
const requestRoute = await import("@/app/api/leave-requests/route");
```

Then the suites:

```ts
function post(body: unknown): Request {
  return new Request("http://localhost/api/leave-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/leave-policies", () => {
  it("answers a member with their organization's policies", async () => {
    actorRef.current = memberActor();

    const response = await policyRoute.GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.map((p: { name: string }) => p.name)).toEqual([
      "Casual",
      "Short leave",
    ]);
  });

  it("answers 401 when nobody is signed in", async () => {
    actorRef.current = null;
    expect((await policyRoute.GET()).status).toBe(401);
  });

  it("answers 403 for a superadmin", async () => {
    actorRef.current = superActor();
    expect((await policyRoute.GET()).status).toBe(403);
  });
});

describe("POST /api/leave-requests", () => {
  it("creates a request and answers 201", async () => {
    await clearRequests();
    await clearHolidays();
    actorRef.current = memberActor();

    const response = await requestRoute.POST(
      post({
        policyId: casualId,
        startDate: "2026-09-07",
        endDate: "2026-09-09",
        reason: "Family thing",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ cost: 3, status: "PENDING" });
  });

  it("defaults a missing endDate to the start date", async () => {
    await clearRequests();
    actorRef.current = memberActor();

    const response = await requestRoute.POST(
      post({ policyId: casualId, startDate: "2026-09-07" }),
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ startDate: "2026-09-07", endDate: "2026-09-07" });
  });

  it("treats an empty endDate the same way — a disabled input submits nothing", async () => {
    await clearRequests();
    actorRef.current = memberActor();

    const response = await requestRoute.POST(
      post({ policyId: casualId, startDate: "2026-09-07", endDate: "" }),
    );

    expect(response.status).toBe(201);
  });

  it("answers 400 for a reversed range", async () => {
    actorRef.current = memberActor();

    const response = await requestRoute.POST(
      post({ policyId: casualId, startDate: "2026-09-09", endDate: "2026-09-07" }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/earlier than/);
  });

  it("answers 400 for a date that does not exist", async () => {
    actorRef.current = memberActor();

    const response = await requestRoute.POST(
      post({ policyId: casualId, startDate: "2026-02-30" }),
    );

    expect(response.status).toBe(400);
  });

  it("answers 400 for a missing policyId", async () => {
    actorRef.current = memberActor();

    const response = await requestRoute.POST(post({ startDate: "2026-09-07" }));

    expect(response.status).toBe(400);
  });

  it("answers 400 for a reason longer than the column expects", async () => {
    actorRef.current = memberActor();

    const response = await requestRoute.POST(
      post({
        policyId: casualId,
        startDate: "2026-10-05",
        reason: "x".repeat(501),
      }),
    );

    expect(response.status).toBe(400);
  });

  it("answers 409 for an overlap", async () => {
    await clearRequests();
    actorRef.current = memberActor();

    await requestRoute.POST(
      post({ policyId: casualId, startDate: "2026-09-07", endDate: "2026-09-09" }),
    );
    const response = await requestRoute.POST(
      post({ policyId: casualId, startDate: "2026-09-08", endDate: "2026-09-10" }),
    );

    expect(response.status).toBe(409);
  });

  it("answers 404 for another organization's policy", async () => {
    actorRef.current = memberActor();

    const response = await requestRoute.POST(
      post({ policyId: otherPolicyId, startDate: "2026-10-05" }),
    );

    expect(response.status).toBe(404);
  });

  it("answers 401 when nobody is signed in", async () => {
    actorRef.current = null;

    const response = await requestRoute.POST(
      post({ policyId: casualId, startDate: "2026-10-05" }),
    );

    expect(response.status).toBe(401);
  });
});

describe("GET /api/leave-requests", () => {
  it("answers with the caller's own requests only", async () => {
    await clearRequests();

    actorRef.current = adminActor();
    await requestRoute.POST(post({ policyId: casualId, startDate: "2026-11-02" }));

    actorRef.current = memberActor();
    await requestRoute.POST(post({ policyId: casualId, startDate: "2026-10-05" }));

    const response = await requestRoute.GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ startDate: "2026-10-05" });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/leave.integration.test.ts
```

Expected: FAIL — cannot resolve `@/app/api/leave-policies/route`.

- [ ] **Step 3: Write `lib/leave-input.ts`**

```ts
import { optionalString, requiredString } from "@/lib/api";
import { parseDateParam } from "@/lib/attendance";
import type { LeaveRequestInput } from "@/lib/leave-service";
import { HttpError } from "@/lib/rbac";

/**
 * Parsing leave request bodies, shared by the route handler and the Server
 * Action — the rule lib/holiday-input.ts and lib/attendance-input.ts already
 * follow, so a form post and an API call cannot drift apart on field names,
 * defaults or coercion.
 *
 * That sharing is what makes the Apply form work without a special case: it
 * *disables* the To input for a one-occurrence policy, a disabled input
 * submits no value at all, and `endDate` defaulting to `startDate` reads that
 * absence correctly.
 */

/** Long enough for a paragraph, short enough that the column is not a dumping ground. */
const MAX_REASON = 500;

export function leaveRequestInputFrom(
  body: Record<string, unknown>,
): LeaveRequestInput {
  const startDate = parseDateParam(body["startDate"], "startDate");
  const endDate =
    body["endDate"] === undefined || body["endDate"] === null || body["endDate"] === ""
      ? startDate
      : parseDateParam(body["endDate"], "endDate");

  // Ordering is malformed input, not a policy decision, so it is refused here
  // rather than in the service — the same place every other date field in this
  // codebase is validated.
  if (endDate < startDate) {
    throw new HttpError(400, '"endDate" must not be earlier than "startDate".');
  }

  const reason = optionalString(body, "reason");
  if (reason !== null && reason.length > MAX_REASON) {
    throw new HttpError(400, `"reason" must be ${MAX_REASON} characters or fewer.`);
  }

  return {
    policyId: requiredString(body, "policyId"),
    startDate,
    endDate,
    reason,
  };
}
```

- [ ] **Step 4: Write `app/api/leave-policies/route.ts`**

```ts
import { errorResponse } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { listLeavePolicies } from "@/lib/leave-service";
import { requireActor } from "@/lib/rbac";

/**
 * The organization's leave entitlements.
 *
 * Read-only. Editing a policy belongs to /setup, which is still on the
 * fixture; adding write verbs here before that screen exists would be an
 * endpoint with no caller and no test of its real use.
 */
export async function GET(): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    return Response.json(await listLeavePolicies(actor));
  } catch (error) {
    return errorResponse(error);
  }
}
```

- [ ] **Step 5: Write `app/api/leave-requests/route.ts`**

```ts
import { errorResponse, readJson } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { leaveRequestInputFrom } from "@/lib/leave-input";
import { createOwnLeaveRequest, listOwnLeaveRequests } from "@/lib/leave-service";
import { requireActor } from "@/lib/rbac";

/**
 * The caller's own leave requests.
 *
 * Deliberately self-scoped with no `userId` parameter in any form: a
 * member-facing read that took an id would be one authorization slip away from
 * leaking a colleague's leave record. The roster-wide read /approvals needs
 * arrives with that screen and gets its own predicate then.
 */
export async function GET(): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    return Response.json(await listOwnLeaveRequests(actor));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const body = await readJson(request);

    return Response.json(
      await createOwnLeaveRequest(actor, leaveRequestInputFrom(body)),
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
```

- [ ] **Step 6: Run them and watch them pass**

```bash
npx vitest run tests/leave.integration.test.ts
```

Expected: PASS, the whole file.

- [ ] **Step 7: Commit**

```bash
git add lib/leave-input.ts app/api/leave-policies app/api/leave-requests tests/leave.integration.test.ts
git commit -m "Add the leave policy and leave request route handlers"
```

---

### Task 6: The Server Action — `lib/leave-actions.ts`

**Files:**
- Create: `lib/leave-actions.ts`
- Test: `tests/leave-actions.test.ts`

**Interfaces:**
- Consumes: `currentActor` from `@/lib/auth`; `backWithError`, `formBody` from `@/lib/form`; `leaveRequestInputFrom` from `@/lib/leave-input`; `createOwnLeaveRequest` from `@/lib/leave-service`; `requireActor` from `@/lib/rbac`.
- Produces: `submitLeaveRequestAction(form: FormData): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `tests/leave-actions.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/generated/prisma/enums";
import type { Actor } from "@/lib/rbac";

/**
 * The Server Action behind the Apply screen.
 *
 * Same approach as holiday-actions.test.ts: the action is a plain async
 * function over `FormData`, so it is called directly. `redirect` and
 * `revalidatePath` are stubbed — the first records where the action sent the
 * caller and throws the way the real one does, which is how success
 * (`?submitted=`) and failure (`?error=`) are both asserted.
 */

const { actorRef, nav } = vi.hoisted(() => ({
  actorRef: { current: null as Actor | null },
  nav: { redirectedTo: "", revalidated: [] as string[] },
}));

vi.mock("@/lib/auth", () => ({
  currentActor: async () => actorRef.current,
  auth: async () => null,
  handlers: { GET: () => new Response(), POST: () => new Response() },
  signIn: async () => undefined,
  signOut: async () => undefined,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    nav.redirectedTo = url;
    throw new Error("NEXT_REDIRECT");
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => nav.revalidated.push(path),
}));

const { prisma } = await import("@/lib/prisma");
const actions = await import("@/lib/leave-actions");

const RUN = `lvact-${Date.now().toString(36)}`;
const email = (local: string) => `${RUN}-${local}@example.test`;

let orgId = "";
let memberId = "";
let casualId = "";
let member: Actor;

beforeAll(async () => {
  const org = await prisma.organization.create({ data: { name: `${RUN} Org` } });
  orgId = org.id;

  const admin = await prisma.user.create({
    data: {
      name: "Act Admin",
      email: email("admin"),
      passwordHash: "x",
      role: Role.ADMIN,
      organizationId: orgId,
    },
  });

  const person = await prisma.user.create({
    data: {
      name: "Act Member",
      email: email("member"),
      passwordHash: "x",
      role: Role.MEMBER,
      organizationId: orgId,
      managerId: admin.id,
    },
  });
  memberId = person.id;
  member = { id: memberId, role: Role.MEMBER, organizationId: orgId };

  const casual = await prisma.leavePolicy.create({
    data: { organizationId: orgId, name: "Casual", allowance: 6 },
  });
  casualId = casual.id;
});

afterAll(async () => {
  await prisma.leaveRequest.deleteMany({ where: { organizationId: orgId } });
  await prisma.leavePolicy.deleteMany({ where: { organizationId: orgId } });
  await prisma.user.deleteMany({ where: { organizationId: orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.leaveRequest.deleteMany({ where: { organizationId: orgId } });
  actorRef.current = member;
  nav.redirectedTo = "";
  nav.revalidated = [];
});

/** Runs the action and reports where it redirected. */
async function run(fields: Record<string, string>): Promise<string> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);

  nav.redirectedTo = "";
  await expect(actions.submitLeaveRequestAction(form)).rejects.toThrow(
    "NEXT_REDIRECT",
  );
  return nav.redirectedTo;
}

/** The message an action attached to its redirect, decoded. */
function errorIn(url: string): string | null {
  const query = url.split("?")[1];
  return query ? new URLSearchParams(query).get("error") : null;
}

describe("submitting a leave request", () => {
  it("writes the row and comes back with its id", async () => {
    const url = await run({
      policyId: casualId,
      from: "",
      startDate: "2026-09-07",
      endDate: "2026-09-09",
      reason: "Family thing",
    });

    const stored = await prisma.leaveRequest.findFirst({
      where: { userId: memberId },
      select: { id: true, cost: true, status: true },
    });

    expect(stored).toMatchObject({ cost: 3, status: "PENDING" });
    expect(url).toBe(`/apply?submitted=${stored?.id}`);
    expect(nav.revalidated).toContain("/apply");
  });

  it("treats a disabled To field — which submits nothing — as a one-day request", async () => {
    await run({ policyId: casualId, startDate: "2026-09-07" });

    const stored = await prisma.leaveRequest.findFirst({
      where: { userId: memberId },
      select: { startDate: true, endDate: true },
    });
    expect(stored?.startDate).toEqual(stored?.endDate);
  });

  it("comes back to /apply with a readable message on an overlap", async () => {
    await run({ policyId: casualId, startDate: "2026-09-07", endDate: "2026-09-09" });

    const url = await run({
      policyId: casualId,
      startDate: "2026-09-08",
      endDate: "2026-09-10",
    });

    expect(url.startsWith("/apply?error=")).toBe(true);
    expect(errorIn(url)).toBe("You already have a request covering those dates.");
    expect(await prisma.leaveRequest.count({ where: { userId: memberId } })).toBe(1);
  });

  it("reports a reversed range rather than storing it", async () => {
    const url = await run({
      policyId: casualId,
      startDate: "2026-09-09",
      endDate: "2026-09-07",
    });

    expect(errorIn(url)).toBe('"endDate" must not be earlier than "startDate".');
    expect(await prisma.leaveRequest.count({ where: { userId: memberId } })).toBe(0);
  });

  it("reports a missing leave type", async () => {
    const url = await run({ startDate: "2026-09-07" });
    expect(errorIn(url)).toBe('"policyId" is required.');
  });

  it("re-authenticates rather than trusting the proxy", async () => {
    actorRef.current = null;

    const url = await run({ policyId: casualId, startDate: "2026-09-07" });

    expect(errorIn(url)).toBe("You must be signed in.");
    expect(await prisma.leaveRequest.count({ where: { userId: memberId } })).toBe(0);
  });
});
```

The stray `from: ""` in the first case is deliberate: the form posts fields the parser does not read, and an unknown key must be ignored rather than rejected.

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run tests/leave-actions.test.ts
```

Expected: FAIL — cannot resolve `@/lib/leave-actions`.

- [ ] **Step 3: Write `lib/leave-actions.ts`**

```ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { currentActor } from "@/lib/auth";
import { backWithError, formBody } from "@/lib/form";
import { leaveRequestInputFrom } from "@/lib/leave-input";
import { createOwnLeaveRequest } from "@/lib/leave-service";
import { requireActor } from "@/lib/rbac";

/**
 * The Server Action behind the Apply screen.
 *
 * Same contract as lib/holiday-actions.ts: re-authenticate rather than
 * trusting proxy.ts, because a Server Action is a POST to the page's own path
 * and a matcher change could remove that gate without any code here changing.
 * Authorization itself lives in lib/leave-service.ts, which this shares with
 * `/api/leave-requests`.
 *
 * The body is read with `leaveRequestInputFrom` — the same parser the JSON
 * route uses — so a form post and an API call cannot drift apart. That also
 * gives the form what it needs for free: the To input is disabled for a
 * one-occurrence policy and therefore submits nothing, which the parser reads
 * as a one-day request.
 */
export async function submitLeaveRequestAction(form: FormData): Promise<void> {
  let id = "";

  try {
    const actor = requireActor(await currentActor());
    const created = await createOwnLeaveRequest(actor, leaveRequestInputFrom(formBody(form)));
    id = created.id;
  } catch (error) {
    // Back to the form the request came from, with the message beside the
    // fields it is about.
    backWithError("/apply", error);
  }

  // Land back on /apply naming the new request rather than on /requests: that
  // screen is still on the fixture and would show a stranger's thread instead
  // of the filing just made.
  revalidatePath("/apply");
  redirect(`/apply?submitted=${id}`);
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
npx vitest run tests/leave-actions.test.ts
```

Expected: PASS, six tests.

- [ ] **Step 5: Commit**

```bash
git add lib/leave-actions.ts tests/leave-actions.test.ts
git commit -m "Add the submit-leave-request Server Action"
```

---

### Task 7: The Apply screen and the form

**Files:**
- Modify: `components/apply-form.tsx`
- Modify: `app/(member)/apply/page.tsx`
- Modify: `lib/demo-actions.ts`
- Modify: `lib/actions.ts`
- Modify: `components/demo-banner.tsx`

**Interfaces:**
- Consumes: `submitLeaveRequestAction` (Task 6); `listOwnLeaveSummary`, `findOwnLeaveRequest` (Task 4); `costFrom`, `offDates`, `unitNoun`, `chargeYear`, `LeaveUnitName` (Task 2); `listHolidays` from `@/lib/holiday-service`.
- Produces: `type ApplyOption = { id: string; name: string; unit: LeaveUnitName; balance: number }` — a **changed** shape; `name` and `unit` were the old identity and `unit` was `"days" | "uses"`.

- [ ] **Step 1: Rewrite `components/apply-form.tsx`**

Three changes, all of them fixing A9: the select posts a **policy id** rather than a name, the unit is the schema's `LeaveUnitName` rather than a match on the literal `"Short leave"`, and the preview counts holidays. The whole file:

```tsx
"use client";

import { useMemo, useState } from "react";

import {
  MonoLabel,
  inputClass,
  primaryButtonClass,
  selectClass,
  textareaClass,
} from "@/components/ui";
import { type LeaveUnitName, costFrom, unitNoun } from "@/lib/leave";

export type ApplyOption = {
  id: string;
  name: string;
  /** `USES` policies are counted per occurrence, not per day. */
  unit: LeaveUnitName;
  balance: number;
};

/** Reused so the "before holidays" comparison allocates nothing per keystroke. */
const NO_HOLIDAYS: ReadonlySet<string> = new Set<string>();

export function ApplyForm({
  action,
  options,
  approverName,
  holidayDates,
  defaultFrom,
  defaultTo,
}: {
  action: (formData: FormData) => void | Promise<void>;
  options: ApplyOption[];
  approverName: string;
  /** Every holiday date that applies to this member, for the live day count. */
  holidayDates: string[];
  defaultFrom: string;
  defaultTo: string;
}) {
  const [policyId, setPolicyId] = useState(options[0]?.id ?? "");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);

  const off = useMemo(() => new Set(holidayDates), [holidayDates]);

  const option = options.find((item) => item.id === policyId);
  const unit: LeaveUnitName = option?.unit ?? "DAYS";
  const isUses = unit === "USES";

  // `costFrom` is the same function lib/leave-service.ts prices the row with,
  // so the number under the button and the number in the database cannot
  // disagree.
  const end = isUses ? from : to;
  const cost = costFrom(unit, from, end, off);
  const holidayDays = costFrom(unit, from, end, NO_HOLIDAYS) - cost;

  const balance = option?.balance ?? 0;
  const after = balance - cost;

  return (
    <form action={action} className="grid items-start gap-6 xl:grid-cols-[1.2fr_0.8fr]">
      <div className="flex flex-col gap-4.5 rounded-xl border border-line bg-surface p-6">
        <label className="flex flex-col gap-1.5 text-xs text-muted">
          Leave type
          <select
            name="policyId"
            value={policyId}
            onChange={(event) => setPolicyId(event.target.value)}
            className={selectClass}
          >
            {options.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>

        <div className="grid gap-3.5 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-xs text-muted">
            From
            <input
              type="date"
              name="startDate"
              value={from}
              onChange={(event) => setFrom(event.target.value)}
              className={inputClass}
            />
          </label>

          <label className="flex flex-col gap-1.5 text-xs text-muted">
            To
            <input
              type="date"
              name="endDate"
              value={end}
              disabled={isUses}
              onChange={(event) => setTo(event.target.value)}
              className={`${inputClass} disabled:text-muted`}
            />
          </label>
        </div>

        {isUses ? (
          <p className="rounded-lg bg-subtle px-3 py-2.5 text-[12.5px] text-muted">
            One {option?.name.toLowerCase() ?? "occurrence"} on{" "}
            {from || "the selected day"} — no need to set an end date.
          </p>
        ) : null}

        {holidayDays > 0 ? (
          <p className="rounded-lg bg-subtle px-3 py-2.5 text-[12.5px] text-muted">
            {holidayDays} {unitNoun(unit, holidayDays)} in that range{" "}
            {holidayDays === 1 ? "is a holiday" : "are holidays"} — not counted.
          </p>
        ) : null}

        <label className="flex flex-col gap-1.5 text-xs text-muted">
          Reason
          <textarea
            name="reason"
            rows={4}
            maxLength={500}
            placeholder="A line is enough — your manager sees this first."
            className={textareaClass}
          />
        </label>

        <div className="flex flex-wrap items-center gap-3.5 border-t border-line pt-4">
          <button type="submit" className={primaryButtonClass}>
            Submit request
          </button>
          <span className="text-[13px] text-muted">
            {cost > balance
              ? "Over your balance — admin will see the shortfall."
              : `Goes straight to ${approverName}.`}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5.5">
        <MonoLabel>THIS REQUEST</MonoLabel>
        <span className="flex items-baseline gap-2">
          <span className="text-[40px] font-semibold tracking-[-0.02em]">{cost}</span>
          <span className="text-[13px] text-muted">
            {isUses ? unitNoun(unit, cost) : `working ${unitNoun(unit, cost)}`}
          </span>
        </span>

        <dl className="flex flex-col gap-2.5 border-t border-brand-tint pt-3.5 text-[13px]">
          <div className="flex justify-between">
            <dt className="text-muted">{option?.name ?? "Leave"} balance</dt>
            <dd>
              {balance} {unitNoun(unit, balance)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">After approval</dt>
            <dd>
              {after} {unitNoun(unit, after)}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">Approver</dt>
            <dd>{approverName}</dd>
          </div>
        </dl>
      </div>
    </form>
  );
}
```

Note the `To` input now renders `end` rather than `to`, so a `USES` policy visibly shows the start date instead of a stale span. It stays `disabled`, which is what makes it submit nothing — the parser's `endDate` default is what reads that.

- [ ] **Step 2: Rewrite `app/(member)/apply/page.tsx`**

```tsx
import { ApplyForm, type ApplyOption } from "@/components/apply-form";
import { PageHeader } from "@/components/page-header";
import { EmptyPanel } from "@/components/ui";
import { todayIso } from "@/lib/attendance";
import { addDays, formatRange } from "@/lib/date";
import { listHolidays } from "@/lib/holiday-service";
import { chargeYear, offDates, unitNoun } from "@/lib/leave";
import { submitLeaveRequestAction } from "@/lib/leave-actions";
import { findOwnLeaveRequest, listOwnLeaveSummary } from "@/lib/leave-service";
import { requirePageActor } from "@/lib/page-guards";

/**
 * Member: apply for leave.
 *
 * Reads the signed-in member's own policies, balances and approver through
 * `listOwnLeaveSummary`, which takes no user id at all — the member is the
 * session, the same contract `listMemberMonth` has on /calendar.
 *
 * The day count comes from lib/leave.ts and is shared with the form below, so
 * the figure the member sees while picking dates and the figure written to
 * the row are one function rather than two that agree by luck.
 */
export default async function ApplyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; submitted?: string }>;
}) {
  const actor = await requirePageActor();
  const params = await searchParams;

  const today = todayIso();
  const year = chargeYear(today);

  const [summary, holidays] = await Promise.all([
    listOwnLeaveSummary(actor, year),
    // This year and the next: somebody planning in December is picking dates
    // in January, and a preview that quietly stopped counting holidays at the
    // year boundary would be wrong exactly when it matters most.
    listHolidays(actor, { from: `${year}-01-01`, to: `${year + 1}-12-31` }),
  ]);

  // Self-scoped: an id belonging to somebody else comes back as null and the
  // strip simply does not render.
  const submitted = params.submitted
    ? await findOwnLeaveRequest(actor, params.submitted)
    : null;

  const options: ApplyOption[] = summary.balances.map((policy) => ({
    id: policy.id,
    name: policy.name,
    unit: policy.unit,
    balance: policy.balance,
  }));

  const approverName = summary.approver?.name ?? "your admin";

  return (
    <>
      <PageHeader
        title="Apply for leave"
        subtitle="Two weeks' notice for anything over five days."
        meta="MEMBER VIEW"
      />

      {submitted ? (
        <p className="rounded-lg border border-brand-tint bg-brand-tint px-3.5 py-2.5 text-sm text-brand-dark">
          Request filed — {submitted.policy.name},{" "}
          {formatRange(submitted.startDate, submitted.endDate)}, {submitted.cost}{" "}
          {unitNoun(submitted.policy.unit, submitted.cost)}. It is with{" "}
          {submitted.approver?.name ?? "your admin"} now.
        </p>
      ) : null}

      {params.error ? (
        <p className="rounded-lg border border-danger-line bg-danger-tint px-3.5 py-2.5 text-sm text-danger">
          {params.error}
        </p>
      ) : null}

      {options.length === 0 ? (
        <EmptyPanel>
          No leave types yet — your admin has not set up any policies for this
          organization.
        </EmptyPanel>
      ) : (
        <ApplyForm
          action={submitLeaveRequestAction}
          options={options}
          approverName={approverName}
          holidayDates={[...offDates(holidays)]}
          defaultFrom={addDays(today, 7)}
          defaultTo={addDays(today, 9)}
        />
      )}
    </>
  );
}
```

Four things this closes:

- **A1** — `requirePageActor()` and `listOwnLeaveSummary` replace `demoMember(db)`. The screen is now about whoever is signed in.
- **A5** — the defaults are `addDays(todayIso(), …)`, not `addDays(TODAY, …)`. The form no longer opens on a date in the frozen demo past.
- **A8** — `?error=` is rendered as the message it carries. The unreachable `error === "range"` branch is gone, and so is `DemoBanner`.
- The empty-organization case renders a panel rather than a select with no options, which would post an empty `policyId` and come back as a `400`.

- [ ] **Step 3: Delete both dead submit paths and the banner case**

In `lib/demo-actions.ts`, delete `demoSubmitLeaveRequest` entirely. Keep `demoUpdateOwnRequest`, `demoUploadDocuments` and `demoRemoveDocument` — `/requests` and `/profile` still use them.

In `lib/actions.ts`, delete `submitLeaveRequest` — the pre-fixture action that wrote through `lib/store.ts` and produced the `?error=range` and `?error=invalid` values the page used to map (A8). Confirm first that it is unreferenced, then that it is gone:

```bash
git grep -n "submitLeaveRequest"
```

Before the edit this must show only `lib/actions.ts` and the two lines in the Apply page that Step 2 already replaced; after it, nothing. Leave the rest of `lib/actions.ts` alone — `signOut` and the attendance actions are still exported from it.

Deleting that one function strands exactly three imports, which must go with it:

- `workdays` from the `@/lib/date` import on line 7. `TODAY`, `formatShort` and `isValidDate` all stay — `isValidDate` is still used by the two attendance actions further down.
- `isShortLeave` from the `@/lib/domain` import.
- `LeaveRequest` from the `@/lib/types` import.

`npx tsc --noEmit` in Step 4 is what confirms the list is exactly right.

Update that file's header comment, which lists what has moved off the fixture:

```ts
 * Attendance has left: it is backed by `orgapp.Attendance` and writes through
 * lib/attendance-actions.ts. Team left before it, then the holiday calendar,
 * and now Apply — see lib/leave-actions.ts. The rest go the same way: each
 * needs a real data source first, not a different action.
```

In `components/demo-banner.tsx`, delete this line from `MESSAGES`:

```ts
  apply: "the leave request was not submitted.",
```

- [ ] **Step 4: Type-check and lint**

```bash
npx tsc --noEmit
npx eslint .
```

Expected: clean. If `tsc` reports an unused `DemoBanner` or `ApplyOption` import anywhere, remove it.

- [ ] **Step 5: Run the whole suite**

```bash
npx vitest run
```

Expected: PASS. No existing test imports `demoSubmitLeaveRequest` or `ApplyOption`, so nothing else should move.

- [ ] **Step 6: Commit**

```bash
git add components/apply-form.tsx "app/(member)/apply/page.tsx" lib/demo-actions.ts lib/actions.ts components/demo-banner.tsx
git commit -m "Move the Apply screen onto real policies, balances and requests"
```

---

### Task 8: The seed, and verification in the running app

**Files:**
- Modify: `prisma/seed.ts`

**Interfaces:**
- Consumes: `prisma.leavePolicy` (Task 1).
- Produces: `seedLeavePolicies(organizationId: string): Promise<number>`.

- [ ] **Step 1: Add the policies to `prisma/seed.ts`**

Put this beside `SEED_HOLIDAYS` and `seedHolidays`, whose shape it follows:

```ts
/**
 * The leave entitlements granted to the seeded organization.
 *
 * These are the four the fixture in lib/seed.ts hardcoded, now owned by an
 * organization that can change them. Idempotent by (organizationId, name) —
 * the unique index — so re-running the seed adds nothing and, importantly,
 * does not reset an allowance an admin has since edited.
 */
const SEED_LEAVE_POLICIES: {
  name: string;
  note: string;
  allowance: number;
  unit?: "USES";
  carry?: boolean;
}[] = [
  {
    name: "Casual",
    note: "Short personal breaks, applied at least a day ahead.",
    allowance: 6,
  },
  {
    name: "Sick",
    note: "No notice needed. Doctor's note past three days.",
    allowance: 6,
  },
  {
    name: "Paid / annual",
    note: "Accrues monthly. Two weeks' notice for 5+ days.",
    allowance: 18,
    carry: true,
  },
  {
    name: "Short leave",
    note: "A couple of hours off. Counted per use, not per day.",
    allowance: 4,
    unit: "USES",
  },
];

async function seedLeavePolicies(organizationId: string): Promise<number> {
  const existing = await prisma.leavePolicy.findMany({
    where: { organizationId },
    select: { name: true },
  });
  const seen = new Set(existing.map((policy) => policy.name));

  let created = 0;
  for (const [position, policy] of SEED_LEAVE_POLICIES.entries()) {
    if (seen.has(policy.name)) continue;

    await prisma.leavePolicy.create({
      data: {
        organizationId,
        name: policy.name,
        note: policy.note,
        allowance: policy.allowance,
        unit: policy.unit ?? "DAYS",
        carry: policy.carry ?? false,
        // The array's order is the select's order.
        position,
      },
    });
    created++;
  }

  return created;
}
```

Call it in `main()` beside the other two, and report it:

```ts
  const attendanceRows = await seedAttendance(seeded.organization.id, seeded.admin.id);
  const holidayRows = await seedHolidays(seeded.organization.id, seeded.regions);
  const policyRows = await seedLeavePolicies(seeded.organization.id);
```

```ts
  console.log(`Leave policies: ${policyRows} added.`);
```

- [ ] **Step 2: Run the seed**

```bash
npx prisma db seed
```

Expected: `Leave policies: 4 added.` Run it a second time and expect `0 added` — the guard, not the unique index, is what makes that a clean no-op rather than a crash.

- [ ] **Step 3: Run the whole suite, the linter and the type checker**

```bash
docker compose up -d
npx vitest run
npx eslint .
npx tsc --noEmit
```

Expected: all clean.

- [ ] **Step 4: Verify in the running app**

```bash
npm run dev
```

Sign in as the seeded **member** and open `http://localhost:3000/apply`. Check each of these:

1. The four seeded leave types are in the select, in the order Casual, Sick, Paid / annual, Short leave.
2. The balances are the full allowances — 6, 6, 18, 4 — and the approver is the member's own manager, or the seeded admin if they have none. **Neither should say "Ananya Rao"**, which was the fixture person's manager (A1).
3. The From/To defaults are a week out from *today*, not from August 2026 (A5).
4. Pick a range spanning a weekend: the count skips it.
5. Pick a range covering a seeded holiday in the member's region — Diwali runs 8–9 November 2026, and the 9th is a Monday. The count drops by one and the "1 day in that range is a holiday" note appears (A5).
6. Select Short leave: the To field disables and shows the start date, and the card reads `1 use`.
7. Submit. The green strip names the type, the dates, the day count and the approver, and the yellow "nothing on this screen is saved" banner is gone (A2).
8. Reload `/apply`. The balance for that type has dropped by the cost — a *pending* request already spends its days.
9. Submit an overlapping range. It comes back with "You already have a request covering those dates." and no second row (A7).
10. Confirm the row landed:

```bash
docker compose exec postgres psql -U leave -d leave_management \
  -c 'SELECT "startDate", "endDate", cost, status FROM "orgapp"."LeaveRequest";'
```

- [ ] **Step 5: Commit**

```bash
git add prisma/seed.ts
git commit -m "Seed the four leave policies for the seeded organization"
```

---

## 6. Verification

The plan is done when all of the following hold:

- `npx vitest run` passes, including the four leave test files.
- `npx eslint .` and `npx tsc --noEmit` are clean.
- `npx prisma db seed` run twice adds four policies and then none.
- `/apply` renders the signed-in member's own balances and approver, and neither dead submit path survives:

  ```bash
  git grep -n "demoSubmitLeaveRequest"   # expect no matches
  git grep -n "error=range"              # expect no matches
  git grep -n "submitLeaveRequest"       # expect only lib/leave-actions.ts and its callers
  ```

- A submitted request exists in `orgapp.LeaveRequest` with a `cost` that excludes weekends and the member's region's holidays, and the balance on the screen has moved by that cost.
- `git grep -n "Short leave" components/` returns nothing — A9 is closed, and the unit comes from the schema.

## 7. What is still fixture after this, and why

`/requests`, `/approvals`, `/overview`, `/score` and `/setup` still read `seedDb()` and still carry their demo banners. That is deliberate and is the same one-screen-at-a-time rhythm the Team, Attendance and Holiday plans followed.

It leaves one seam worth naming plainly: **a member can file a real request and then not see it on `/requests`**, which reads the fixture. The confirmation strip on `/apply` exists precisely because of that gap — it is the only place the filing is visible until `/requests` moves. That is the first follow-up plan, and it is small: the table, the service and the API it needs all exist after this one, so it is a page rewrite plus a `listOwnLeaveRequests` call.

## 8. Out of scope

- **Approving, rejecting or withdrawing.** Nothing in this plan writes a status other than `PENDING`. `/approvals` gets the decision path, the comment thread and the `canReviewLeave` predicate.
- **Editing policies.** `/setup` owns that screen. The seed is the only writer here, and `/api/leave-policies` is read-only on purpose.
- **Carry-forward.** The `carry` column is stored and nothing reads it; a second year's balance is a question for whenever a second year exists.
- **Notice-period, past-date and over-balance enforcement.** Confirmed as deliberately advisory in §2.7.
- **Closing the overlap race properly.** The transaction narrows it; a Postgres exclusion constraint over a `daterange` would close it. Not worth the migration until two people share a login, which they should not.
- **Attendance written from an approved request.** A `LEAVE` day on the attendance grid is still marked by an admin. Linking the two tables is a real feature and a separate plan.
