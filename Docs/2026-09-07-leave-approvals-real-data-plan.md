# Leave Approvals on Real Data — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-09-07
**Status:** Implemented
**Goal:** Close the loop `/apply` opens. A `LeaveRequest` filed today is written to Postgres and read by nothing; this puts `/approvals` and `/requests` on that table and makes Approve, Reject and Withdraw persist.

**Architecture:** Three nullable decision columns on the existing `LeaveRequest` — no new table. Roster-scoped reads and the decision write go in a **new** `lib/leave-review-service.ts`, because `lib/leave-service.ts` declares itself self-scoped with no `userId` parameter anywhere in it and that claim is what makes it reviewable. Authorization is two new pure predicates in `lib/rbac.ts`. The balance the approvals panel needs and the balance `/apply` already shows are extracted to one shared internal function so the two screens cannot disagree.

**Tech Stack:** Next.js 16.3.2 (App Router, Route Handlers, Server Actions), React 19.2, Prisma 7 with `@prisma/adapter-pg`, PostgreSQL, Auth.js v5, Vitest 4, Tailwind 4.

**Spec:** [`2026-09-07-leave-approvals-real-data-design.md`](./2026-09-07-leave-approvals-real-data-design.md). Builds on
[`2026-09-04-apply-for-leave-real-data-plan.md`](./2026-09-04-apply-for-leave-real-data-plan.md),
[`2026-09-04-leave-accrual-plan.md`](./2026-09-04-leave-accrual-plan.md),
[`2026-08-27-multi-tenant-org-rbac-design.md`](./2026-08-27-multi-tenant-org-rbac-design.md).

## Global Constraints

- Models live in the **`orgapp`** Postgres schema, set by the `schema` parameter on the connection URL (`lib/prisma-url.ts`). No `@@schema` attribute, no `multiSchema` preview feature.
- Every migration statement is **schema-qualified by hand** (`"orgapp"."LeaveRequest"`). `prisma migrate diff` emits bare names, which would land in `public` on a fresh database.
- Dates are **`YYYY-MM-DD` strings** above the database and `DATE` columns beneath it, converted with `toDbDate` / `fromDbDate` in `lib/attendance.ts`.
- "Today" comes from `todayIso()` (`lib/attendance.ts`), which resolves in `Asia/Kolkata`. Never `new Date()` against a date string. **`TODAY` in `lib/date.ts` is the demo's frozen `"2026-08-17"` and must not be used by anything in this plan.**
- Authorization is decided in `lib/rbac.ts` (pure predicates) and enforced in the service modules. Route handlers never decide policy.
- A member id is **never** accepted from a member's request. `leaveSummaryFor(actor, userId)` takes one, and is `ADMIN`-only for exactly that reason.
- Pass the **stored** `LeaveRequest.organizationId` and `LeaveRequest.userId` to every predicate — never a value from a request body.
- Request bodies are parsed by `lib/leave-input.ts`, shared by the route handler and the Server Action, so a form post and a JSON call cannot drift on field names or coercion.
- Server Actions **re-authenticate** with `currentActor()` rather than trusting `proxy.ts`: an action is a POST to the page's own path, and a matcher change would silently drop that gate.
- Tests: `npm test` (Vitest, `fileParallelism: false`). Integration tests hit the Dockerized Postgres (`docker compose up -d`, service name **`postgres`**, user `leave`, database `leave_management`), namespace rows with a per-run prefix, and clean up in `afterAll`.
- Commit after every task.

---

## 1. Where things stand

`/apply` is real as of `863afbd`. Everything downstream of its write is not.

| # | Defect | Fixed in |
|---|--------|----------|
| B1 | `/approvals` renders `seedDb()`. Every request on the screen is invented; no real filing is visible to anyone. | Task 5 |
| B2 | Approve / Reject / Send comment post to `demoReviewRequest` — a bare redirect. Nothing is written. | Tasks 3, 4, 5 |
| B3 | `/requests` renders `demoMember(db)`, a hardcoded `"u2"` (Dev Menon). Every member sees a fixture person's history under their own name. | Task 6 |
| B4 | Withdraw posts to `demoUpdateOwnRequest`. `LeaveRequestStatus.WITHDRAWN` exists and no code path can set it. | Tasks 3, 4, 6 |
| B5 | The sidebar badge counts `pendingRequests(seedDb())` — unrelated to the admin's organization. | Task 5 |
| B6 | No roster-wide read exists, and no predicate authorizes one. | Tasks 2, 3 |
| B7 | Nowhere records who decided, when, or why. | Task 1 |
| B8 | `STATUS_STYLE` in `lib/ui.ts` is keyed by the fixture's **lowercase** `RequestStatus`; the database enum is `PENDING`. `StatusBadge` would read `undefined` and crash on `style.className`. | Task 5 |

## 2. The rules this implements

From §2 of the design, confirmed with the product owner on 2026-09-07:

1. **Any `ADMIN` decides any request in their own organization.** `approverId` is routing and attribution, not permission — it may point at a `MEMBER` manager who cannot open `/approvals`, and it is `SetNull` when an approver leaves.
2. **Nobody decides their own request.** Cost accepted knowingly: a one-admin organization cannot decide that admin's leave.
3. **A decision is terminal.** `PENDING → APPROVED | REJECTED`. Re-deciding is a `409`. No un-approve.
4. **A rejection requires a note.** An approval's is optional.
5. **A member withdraws their own `PENDING` request only.**
6. **Balances need no new arithmetic.** `PENDING` already counts as spent, so approving is balance-neutral and rejecting or withdrawing returns the days by falling out of the `SPENT` filter.
7. **A `SUPERADMIN` reads but does not decide** — the `canListAttendance` / `canMarkAttendance` split.
8. **`cost` is never re-priced at decision time.** It was frozen at submit.

## 3. Database changes

### 3.1 Changed table — `LeaveRequest`

Three nullable columns. No new table, no new enum: `LeaveRequestStatus` already has all four members.

```prisma
  /// When the decision was made. Null while PENDING.
  ///
  /// Distinct from `updatedAt`, which moves for any write — reading "when was
  /// this approved" off `updatedAt` would be wrong the first time anything
  /// else touches the row.
  decidedAt DateTime?

  /// The admin who approved or rejected it — not necessarily `approverId`,
  /// which records who it was *routed* to at submit. Any admin in the
  /// organization may decide, so the two differ routinely.
  ///
  /// Nullable and SetNull for the reason `approverId` and
  /// `Attendance.markedById` give: this is attribution, not ownership. Null
  /// means "the admin who decided this is gone", never "undecided" — `status`
  /// and `decidedAt` are what answer that.
  decidedById String?
  decidedBy   User?   @relation("LeaveRequestDecider", fields: [decidedById], references: [id], onDelete: SetNull)

  /// Why. Required by the service on a rejection, optional on an approval.
  /// Not a CHECK constraint: it is a policy about one transition, not an
  /// invariant of the row.
  decisionNote String?
```

Plus the queue's index:

```prisma
  /// The approvals queue: one organization's requests in one state, oldest
  /// filing first.
  @@index([organizationId, status, createdAt])
```

The existing `@@index([organizationId, startDate])` stays — it serves the reads that ask which requests touch a span.

### 3.2 Changed table — `User`

One back-relation, the third named relation on the model:

```prisma
  leaveDecisions LeaveRequest[] @relation("LeaveRequestDecider")
```

### 3.3 Deliberately NOT stored

- **A decision event log.** `AttendanceEvent` exists because attendance permits unlimited backdated correction. A leave decision happens once and is terminal, so the log would hold one row per request duplicating three columns already on it.
- **A comment thread.** Out of scope — see §8.
- **A recomputed cost.** Frozen at submit, rule 8.

### 3.4 Data migration

None. All three columns are nullable and every existing row is `PENDING`, for which null is correct.

## 4. File structure

| File | Responsibility |
|---|---|
| `prisma/schema.prisma` | *Modified* — three columns, one relation, one index |
| `prisma/migrations/<ts>_leave_decisions/migration.sql` | *Created* — hand-qualified DDL |
| `lib/rbac.ts` | *Modified* — `canReviewLeave`, `canListLeaveRequests` |
| `lib/leave-review-service.ts` | **Created** — every roster-scoped read and the decision write |
| `lib/leave-service.ts` | *Modified* — `withdrawOwnLeaveRequest`; balance body extracted for sharing |
| `lib/leave-input.ts` | *Modified* — `leaveDecisionFrom` |
| `app/api/leave-requests/[id]/route.ts` | **Created** — `PATCH`: decide or withdraw |
| `lib/leave-actions.ts` | *Modified* — two new actions; the submit redirect moves |
| `lib/demo-actions.ts` | *Modified* — two functions deleted |
| `components/demo-banner.tsx` | *Modified* — four dead message keys removed |
| `lib/ui.ts` | *Modified* — `STATUS_STYLE` re-keyed to the database enum |
| `components/ui.tsx` | *Modified* — `StatusBadge` takes `LeaveRequestStatus` |
| `app/(leave)/approvals/page.tsx` | *Modified* — off the fixture |
| `app/(leave)/layout.tsx` | *Modified* — real pending badge |
| `app/(member)/requests/page.tsx` | *Modified* — off the fixture |
| `app/(member)/apply/page.tsx` | *Modified* — confirmation strip removed |
| `tests/rbac.test.ts` | *Modified* — the two predicates |
| `tests/leave.integration.test.ts` | *Modified* — the review service end to end |
| `tests/leave-actions.test.ts` | *Modified* — the two new actions |

**Why a new module rather than a bigger one.** `lib/leave-service.ts` opens with an invariant it enforces file-wide — *"Every operation in this file is self-scoped. There is no `userId` parameter anywhere in it."* Adding a roster read demotes that to "self-scoped, except these five functions", which is not a claim a reviewer can check at a glance. The roster work gets its own file; `withdrawOwnLeaveRequest` is self-scoped and stays where the invariant still holds over it.

---

# Tasks

### Task 1: The decision columns

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_leave_decisions/migration.sql`
- Test: `tests/leave.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LeaveRequest.decidedAt: Date | null`, `LeaveRequest.decidedById: string | null`, `LeaveRequest.decisionNote: string | null`, and the relation name `"LeaveRequestDecider"`. Every later task depends on these.

- [x] **Step 1: Write the failing test**

Add to `tests/leave.integration.test.ts`, inside the existing `describe("the database enforces what the schema cannot say")` block:

```ts
  it("keeps a decided request readable after the deciding admin is deleted", async () => {
    const leaver = await prisma.user.create({
      data: {
        name: "Run Leaver",
        email: email("leaver"),
        passwordHash: "x",
        role: Role.ADMIN,
        organizationId: orgId,
      },
    });

    const request = await prisma.leaveRequest.create({
      data: {
        organizationId: orgId,
        userId: memberId,
        policyId: casualId,
        startDate: new Date("2026-10-05"),
        endDate: new Date("2026-10-06"),
        cost: 2,
        status: "APPROVED",
        decidedAt: new Date("2026-09-07T10:00:00Z"),
        decidedById: leaver.id,
        decisionNote: "Fine.",
      },
    });

    await prisma.user.delete({ where: { id: leaver.id } });

    const after = await prisma.leaveRequest.findUnique({ where: { id: request.id } });

    // Attribution, not ownership: the admin goes, the decision stays.
    expect(after).toMatchObject({
      status: "APPROVED",
      decidedById: null,
      decisionNote: "Fine.",
    });
    expect(after?.decidedAt).not.toBeNull();

    await prisma.leaveRequest.delete({ where: { id: request.id } });
  });
```

- [x] **Step 2: Run it and watch it fail**

```bash
docker compose up -d
npm test -- tests/leave.integration.test.ts
```

Expected: FAIL — `Unknown argument 'decidedAt'`. Prisma does not know the column.

- [x] **Step 3: Add the columns to the schema**

In `prisma/schema.prisma`, inside `model LeaveRequest`, after the `approverId` / `approver` pair and before `createdAt`, add the block from §3.1 verbatim (all three columns with their doc comments).

Then add the index alongside the two that are already there:

```prisma
  /// The approvals queue: one organization's requests in one state, oldest
  /// filing first.
  @@index([organizationId, status, createdAt])
```

In `model User`, beside `leaveRequests` and `leaveApprovals`, add:

```prisma
  leaveDecisions LeaveRequest[] @relation("LeaveRequestDecider")
```

- [x] **Step 4: Write the migration by hand**

Create `prisma/migrations/20260907120000_leave_decisions/migration.sql`:

```sql
-- Decisions: who approved or rejected a request, when, and why.
--
-- Every object is schema-qualified rather than relying on the `schema=orgapp`
-- parameter to set the search path — same rule as every migration before it.

-- AlterTable
-- All three are nullable and every existing row is PENDING, for which null is
-- the correct value. No backfill.
ALTER TABLE "orgapp"."LeaveRequest"
  ADD COLUMN "decidedAt" TIMESTAMP(3),
  ADD COLUMN "decidedById" TEXT,
  ADD COLUMN "decisionNote" TEXT;

-- SetNull, not Restrict: this is attribution, not ownership. An admin who
-- leaves is deleted, and neither blocking that delete nor destroying the
-- organization's leave history with it is acceptable — the same reasoning
-- "LeaveRequest_approverId_fkey" and "Attendance_markedById_fkey" follow.
ALTER TABLE "orgapp"."LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "orgapp"."User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The approvals queue reads one organization filtered by status, oldest
-- filing first. The existing [organizationId, startDate] index is on the
-- wrong column for both the filter and the sort.
CREATE INDEX "LeaveRequest_organizationId_status_createdAt_idx"
  ON "orgapp"."LeaveRequest"("organizationId", "status", "createdAt");
```

- [x] **Step 5: Apply it and regenerate the client**

```bash
npx prisma migrate dev
npx prisma generate
```

Expected: the migration applies with no drift warning. If Prisma reports drift, the hand-written SQL disagrees with the schema — fix the SQL, not the schema.

- [x] **Step 6: Run the test and watch it pass**

```bash
npm test -- tests/leave.integration.test.ts
```

Expected: PASS, including every test that was already green.

- [x] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations tests/leave.integration.test.ts
git commit -m "Record who decided a leave request, when, and why"
```

---

### Task 2: The two predicates

**Files:**
- Modify: `lib/rbac.ts`
- Test: `tests/rbac.test.ts`

**Interfaces:**
- Consumes: `Actor`, `Role`, `visibleOrgId` — all already in `lib/rbac.ts`.
- Produces:
  - `canReviewLeave(actor: Actor, requestOrganizationId: string, applicantId: string): boolean`
  - `canListLeaveRequests(actor: Actor): boolean`

  Task 3 calls both.

- [x] **Step 1: Write the failing tests**

Add `canListLeaveRequests` and `canReviewLeave` to the import list at the top of `tests/rbac.test.ts` (it is alphabetical — they go after `canListLeavePolicies` and after `canReadOwnAttendance` respectively). Then append:

```ts
describe("reviewing a leave request", () => {
  it("allows an admin of the organization it was filed in", () => {
    expect(canReviewLeave(adminA, ORG_A, "someone-else")).toBe(true);
  });

  it("denies an admin of another organization", () => {
    expect(canReviewLeave(adminA, ORG_B, "someone-else")).toBe(false);
  });

  it("denies a member, who has no queue to work", () => {
    expect(canReviewLeave(memberA, ORG_A, "someone-else")).toBe(false);
  });

  it("denies a superadmin, who reads an organization but does not run it", () => {
    expect(canReviewLeave(superadmin, ORG_A, "someone-else")).toBe(false);
  });

  it("denies an admin their own request — canApplyForLeave admits admins", () => {
    expect(canReviewLeave(adminA, ORG_A, adminA.id)).toBe(false);
  });
});

describe("listing leave requests across a roster", () => {
  it("allows an admin", () => {
    expect(canListLeaveRequests(adminA)).toBe(true);
  });

  it("allows a superadmin, who reads every organization", () => {
    expect(canListLeaveRequests(superadmin)).toBe(true);
  });

  it("denies a member — /api/leave-requests stays self-scoped for them", () => {
    expect(canListLeaveRequests(memberA)).toBe(false);
  });
});
```

- [x] **Step 2: Run them and watch them fail**

```bash
npm test -- tests/rbac.test.ts
```

Expected: FAIL — `canReviewLeave is not exported by lib/rbac.ts`.

- [x] **Step 3: Add the predicates**

In `lib/rbac.ts`, after `canApplyForLeave`:

```ts
/**
 * Deciding a request belongs to the ADMIN of the organization it was filed in
 * — the same rule as `canManageHolidays`. Pass the *stored*
 * `LeaveRequest.organizationId`, never one from a request body.
 *
 * `LeaveRequest.approverId` is deliberately not consulted. It records who the
 * request was *routed* to at submit, and routing is not permission: a manager
 * may be a MEMBER, who cannot open /approvals at all, and the column is
 * SetNull when an approver leaves. Either would strand a request that any
 * admin can plainly see.
 *
 * The applicant is excluded even when they are that admin. `canApplyForLeave`
 * admits an ADMIN deliberately — "an admin is a person who takes leave" — so
 * without this line an admin approves their own leave. The consequence is
 * accepted knowingly: in a one-admin organization that admin's own request
 * cannot be decided by anybody, which is the better of the two failures.
 */
export function canReviewLeave(
  actor: Actor,
  requestOrganizationId: string,
  applicantId: string,
): boolean {
  return (
    actor.role === Role.ADMIN &&
    actor.organizationId === requestOrganizationId &&
    actor.id !== applicantId
  );
}

/**
 * Reading follows `canListAttendance`, not `canReviewLeave`: a SuperAdmin sees
 * every organization, so they may read the requests inside one even though
 * they cannot decide them. Scope the query with `visibleOrgId`.
 *
 * A MEMBER is excluded. Their own requests come from the self-scoped reads in
 * lib/leave-service.ts, which take no id and therefore have no id to tamper
 * with.
 */
export function canListLeaveRequests(actor: Actor): boolean {
  return actor.role === Role.SUPERADMIN || actor.role === Role.ADMIN;
}
```

- [x] **Step 4: Run them and watch them pass**

```bash
npm test -- tests/rbac.test.ts
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add lib/rbac.ts tests/rbac.test.ts
git commit -m "Say who may read and decide an organization's leave requests"
```

---

### Task 3: The review service

The biggest task. It ends with every read and write the two screens need, tested against real Postgres, with no page touched yet.

**Files:**
- Create: `lib/leave-review-service.ts`
- Modify: `lib/leave-service.ts`
- Test: `tests/leave.integration.test.ts`

**Interfaces:**
- Consumes: `canReviewLeave`, `canListLeaveRequests` (Task 2); the `decided*` columns (Task 1); `LeaveRequestRecord`, `LeaveSummary`, `REQUEST_FIELDS`, `SPENT`, `toRecord` from `lib/leave-service.ts`.
- Produces:

  ```ts
  // lib/leave-service.ts — LeaveRequestRecord gains, for both screens:
  //   decidedAt: string | null
  //   decisionNote: string | null

  // lib/leave-review-service.ts — what only an approver sees:
  type ReviewRequestRecord = LeaveRequestRecord & {
    applicant: { id: string; name: string };
    decidedBy: { id: string; name: string } | null;
  };
  type Decision = "APPROVED" | "REJECTED";
  type DecisionInput = { decision: Decision; note: string | null };

  listLeaveRequests(actor: Actor, filter?: { status?: LeaveRequestStatus }): Promise<ReviewRequestRecord[]>
  findLeaveRequest(actor: Actor, id: string): Promise<ReviewRequestRecord | null>
  decideLeaveRequest(actor: Actor, id: string, input: DecisionInput): Promise<ReviewRequestRecord>
  countPendingLeaveRequests(actor: Actor): Promise<number>
  leaveSummaryFor(actor: Actor, userId: string, asOf?: string): Promise<LeaveSummary>

  // lib/leave-service.ts
  withdrawOwnLeaveRequest(actor: Actor, id: string): Promise<LeaveRequestRecord>
  ```

  Tasks 4, 5 and 6 call these.

- [x] **Step 1: Write the failing tests**

Append to `tests/leave.integration.test.ts`. Add the import beside the existing `const service = await import("@/lib/leave-service");`:

```ts
const review = await import("@/lib/leave-review-service");
```

Then append these blocks:

```ts
describe("the approvals queue", () => {
  it("returns the organization's pending requests, oldest filing first", async () => {
    await clearRequests();

    const older = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-11-02",
      endDate: "2026-11-03",
      reason: "First",
    });
    const newer = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-11-09",
      endDate: "2026-11-10",
      reason: "Second",
    });

    const queue = await review.listLeaveRequests(adminActor(), { status: "PENDING" });

    expect(queue.map((r) => r.id)).toEqual([older.id, newer.id]);
    expect(queue[0].applicant).toMatchObject({ id: memberId, name: "Run Member" });
  });

  it("never returns another organization's requests", async () => {
    const foreignAdmin: Actor = {
      id: "other-admin",
      role: Role.ADMIN,
      organizationId: otherOrgId,
    };

    const queue = await review.listLeaveRequests(foreignAdmin);

    expect(queue).toEqual([]);
  });

  it("counts the pending requests for the badge", async () => {
    expect(await review.countPendingLeaveRequests(adminActor())).toBe(2);
  });

  it("refuses a member, who has no queue to work", async () => {
    await expect(review.listLeaveRequests(memberActor())).rejects.toMatchObject({
      status: 403,
    });
  });
});

describe("deciding a request", () => {
  it("records the status, the time, the admin and the note", async () => {
    await clearRequests();
    const filed = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-11-16",
      endDate: "2026-11-17",
      reason: "Wedding",
    });

    const decided = await review.decideLeaveRequest(adminActor(), filed.id, {
      decision: "APPROVED",
      note: "Enjoy it.",
    });

    expect(decided).toMatchObject({
      status: "APPROVED",
      decisionNote: "Enjoy it.",
      decidedBy: { id: adminId, name: "Run Admin" },
    });
    expect(decided.decidedAt).not.toBeNull();
  });

  it("refuses to decide an already-decided request", async () => {
    const [only] = await review.listLeaveRequests(adminActor(), { status: "APPROVED" });

    await expect(
      review.decideLeaveRequest(adminActor(), only.id, {
        decision: "REJECTED",
        note: "Changed my mind.",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a rejection with no reason", async () => {
    await clearRequests();
    const filed = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-11-23",
      endDate: "2026-11-24",
      reason: null,
    });

    await expect(
      review.decideLeaveRequest(adminActor(), filed.id, {
        decision: "REJECTED",
        note: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("allows an approval with no note", async () => {
    const [pending] = await review.listLeaveRequests(adminActor(), { status: "PENDING" });

    const decided = await review.decideLeaveRequest(adminActor(), pending.id, {
      decision: "APPROVED",
      note: null,
    });

    expect(decided).toMatchObject({ status: "APPROVED", decisionNote: null });
  });

  it("hides another organization's request behind a 404", async () => {
    await clearRequests();
    const filed = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-11-30",
      endDate: "2026-12-01",
      reason: null,
    });
    const foreignAdmin: Actor = {
      id: "other-admin",
      role: Role.ADMIN,
      organizationId: otherOrgId,
    };

    await expect(
      review.decideLeaveRequest(foreignAdmin, filed.id, {
        decision: "APPROVED",
        note: null,
      }),
    ).rejects.toMatchObject({ status: 404 });

    expect(await review.findLeaveRequest(foreignAdmin, filed.id)).toBeNull();
  });

  it("refuses an admin their own request", async () => {
    const adminActorValue = adminActor();
    const own = await service.createOwnLeaveRequest(adminActorValue, {
      policyId: casualId,
      startDate: "2026-12-07",
      endDate: "2026-12-08",
      reason: "Mine",
    });

    await expect(
      review.decideLeaveRequest(adminActorValue, own.id, {
        decision: "APPROVED",
        note: null,
      }),
    ).rejects.toMatchObject({ status: 403 });

    await prisma.leaveRequest.delete({ where: { id: own.id } });
  });

  it("returns the days to the applicant's balance on a rejection", async () => {
    await clearRequests();
    const filed = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-12-14",
      endDate: "2026-12-16",
      reason: null,
    });

    const held = await service.listOwnLeaveSummary(memberActor(), "2026-12-31");
    expect(held.balances[0]).toMatchObject({ used: 3 });

    await review.decideLeaveRequest(adminActor(), filed.id, {
      decision: "REJECTED",
      note: "Year end freeze.",
    });

    const freed = await service.listOwnLeaveSummary(memberActor(), "2026-12-31");
    expect(freed.balances[0]).toMatchObject({ used: 0, balance: 6 });
  });
});

describe("the applicant's balance, as the approver sees it", () => {
  it("agrees with the member's own summary for the same date", async () => {
    await clearRequests();
    await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-12-21",
      endDate: "2026-12-22",
      reason: null,
    });

    const mine = await service.listOwnLeaveSummary(memberActor(), "2026-12-31");
    const theirs = await review.leaveSummaryFor(adminActor(), memberId, "2026-12-31");

    expect(theirs.balances).toEqual(mine.balances);
    expect(theirs.year).toBe(mine.year);
  });

  it("refuses a member asking about anybody, including themselves", async () => {
    await expect(
      review.leaveSummaryFor(memberActor(), memberId, "2026-12-31"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("refuses an admin asking about another organization's member", async () => {
    const foreignAdmin: Actor = {
      id: "other-admin",
      role: Role.ADMIN,
      organizationId: otherOrgId,
    };

    await expect(
      review.leaveSummaryFor(foreignAdmin, memberId, "2026-12-31"),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("withdrawing one's own request", () => {
  it("withdraws a pending request and returns its days", async () => {
    await clearRequests();
    const filed = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-12-28",
      endDate: "2026-12-29",
      reason: null,
    });

    const withdrawn = await service.withdrawOwnLeaveRequest(memberActor(), filed.id);
    expect(withdrawn.status).toBe("WITHDRAWN");

    const summary = await service.listOwnLeaveSummary(memberActor(), "2026-12-31");
    expect(summary.balances[0]).toMatchObject({ used: 0, balance: 6 });
  });

  it("refuses to withdraw a decided request", async () => {
    await clearRequests();
    const filed = await service.createOwnLeaveRequest(memberActor(), {
      policyId: casualId,
      startDate: "2026-12-30",
      endDate: "2026-12-31",
      reason: null,
    });
    await review.decideLeaveRequest(adminActor(), filed.id, {
      decision: "APPROVED",
      note: null,
    });

    await expect(
      service.withdrawOwnLeaveRequest(memberActor(), filed.id),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("returns a 404 for somebody else's request", async () => {
    const [any] = await review.listLeaveRequests(adminActor(), { status: "APPROVED" });
    const managerActor: Actor = {
      id: managerId,
      role: Role.MEMBER,
      organizationId: orgId,
    };

    await expect(
      service.withdrawOwnLeaveRequest(managerActor, any.id),
    ).rejects.toMatchObject({ status: 404 });
  });
});
```

- [x] **Step 2: Run them and watch them fail**

```bash
npm test -- tests/leave.integration.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/leave-review-service'`.

- [x] **Step 3: Put the decision on the record, and export what the new module needs**

The decision belongs on `LeaveRequestRecord` itself, not only on the approver's view of it: a member whose leave is refused must be able to read why. Only *who* decided is approver-only.

In `lib/leave-service.ts`, add two fields to `REQUEST_FIELDS`:

```ts
  decidedAt: true,
  decisionNote: true,
```

two to `RequestRow`:

```ts
  decidedAt: Date | null;
  decisionNote: string | null;
```

two to `LeaveRequestRecord`:

```ts
  /** ISO timestamp. Null while PENDING. */
  decidedAt: string | null;
  /**
   * The approver's reason. The member sees it: a rejection they cannot read
   * the reason for is the fixture's silence with a real status on it.
   *
   * `decidedById` is deliberately absent from this record. The applicant is
   * told the decision and the reason, not which admin in the building made
   * it; /approvals shows that, to admins, through `ReviewRequestRecord`.
   */
  decisionNote: string | null;
```

and two to the object `toRecord` returns:

```ts
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
```

Three things are also currently private and must be shared rather than copied. Add `export` to `SPENT`, `REQUEST_FIELDS` and `toRecord`, and give each a line saying why it is no longer private:

```ts
/** Requests in these states have already spent their days. */
// Exported for lib/leave-review-service.ts: a roster read that disagreed with
// this list about what "spent" means would show a balance no member's own
// screen agrees with.
export const SPENT: LeaveRequestStatus[] = [
```

```ts
// Exported for lib/leave-review-service.ts, which selects these fields plus
// the applicant and the decision. One list, so a field added here reaches
// both screens.
export const REQUEST_FIELDS = {
```

```ts
// Exported for lib/leave-review-service.ts. The date and enum conversions
// belong to the record shape, not to either caller.
export function toRecord(row: RequestRow): LeaveRequestRecord {
```

Also export the row type it needs:

```ts
export type RequestRow = {
```

- [x] **Step 4: Extract the shared balance body in `lib/leave-service.ts`**

`listOwnLeaveSummary` currently reads `actor.id` in three places. Split the body out so `leaveSummaryFor` can reuse it rather than copy it. Replace `listOwnLeaveSummary` with:

```ts
/**
 * Every policy with what one member has left of it, plus who their requests
 * go to.
 *
 * Takes the ids rather than an actor: it makes no authorization decision at
 * all. Its two callers do — `listOwnLeaveSummary` below, and
 * `leaveSummaryFor` in lib/leave-review-service.ts — and they must agree on
 * the arithmetic to the day, or the balance an approver reads on /approvals
 * contradicts the one the member read on /apply.
 *
 * Exported for that second caller only. Nothing outside those two should
 * reach a member's balance without deciding first whether it may.
 */
export async function summaryFor(
  organizationId: string,
  userId: string,
  asOf: string,
): Promise<LeaveSummary> {
  const applicant = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      joinedOn: true,
      manager: { select: { id: true, name: true } },
    },
  });
  // 404, where `listOwnLeaveSummary` used to answer 401 "Your account no
  // longer exists." A shared function has two callers now, and only one of
  // them is asking about themselves — "you have been deleted" is the wrong
  // sentence to show an admin who mistyped a member id. The self path loses
  // a nicety; nothing in it depended on the code.
  if (!applicant) throw new HttpError(404, "That member does not exist.");

  const [policies, spent, approver] = await Promise.all([
    // The policy list is the organization's, not the caller's, so an admin
    // reading a member's balance sees the entitlements that member is
    // actually measured against.
    policiesIn(organizationId),
    // Every spent request, not one year's. A carrying policy needs each
    // year's usage from its accrual start, because the cap is applied at
    // every year boundary and cannot be collapsed into one subtraction.
    prisma.leaveRequest.findMany({
      where: { userId, status: { in: SPENT } },
      select: { policyId: true, startDate: true, cost: true },
    }),
    approverFor(applicant.manager, organizationId),
  ]);

  // policy id -> calendar year -> days spent.
  const usedByPolicy = new Map<string, Map<number, number>>();
  for (const row of spent) {
    const year = chargeYear(fromDbDate(row.startDate));
    const byYear = usedByPolicy.get(row.policyId) ?? new Map<number, number>();
    byYear.set(year, (byYear.get(year) ?? 0) + row.cost);
    usedByPolicy.set(row.policyId, byYear);
  }

  // `joinedOn` is a timestamp rather than a DATE column, but everything that
  // writes it stores UTC midnight, so the slice is exact.
  const joinedOn = applicant.joinedOn ? fromDbDate(applicant.joinedOn) : null;

  return {
    year: chargeYear(asOf),
    asOf,
    balances: policies.map((policy) => ({
      ...policy,
      ...balanceAsOf(policy, joinedOn, asOf, usedByPolicy.get(policy.id) ?? NO_USAGE),
    })),
    approver,
  };
}

/**
 * The signed-in member's own summary. Self-scoped: the applicant is the
 * session, so there is no id to tamper with.
 *
 * `asOf` is a parameter rather than always `todayIso()` so the credit
 * schedule can be tested at a chosen date without touching the clock.
 */
export async function listOwnLeaveSummary(
  actor: Actor,
  asOf: string = todayIso(),
): Promise<LeaveSummary> {
  return summaryFor(applicantOrgFor(actor), actor.id, asOf);
}
```

`listLeavePolicies` takes an actor, so `summaryFor` cannot call it. Add the org-keyed read it needs, and make `listLeavePolicies` a wrapper so there is still one query:

```ts
/**
 * One organization's active policies, in render order.
 *
 * Takes an organization id rather than an actor and decides nothing:
 * `listLeavePolicies` below is the authorized entry point, and `summaryFor`
 * is the other caller, which has already authorized in its own way.
 */
async function policiesIn(organizationId: string): Promise<LeavePolicyRecord[]> {
  const rows = await prisma.leavePolicy.findMany({
    where: { organizationId, active: true },
    select: POLICY_FIELDS,
    orderBy: [{ position: "asc" }, { name: "asc" }],
  });

  return rows.map((row) => ({
    ...row,
    unit: unitName(row.unit),
    accrual: accrualName(row.accrual),
    effectiveFrom: fromDbDate(row.effectiveFrom),
  }));
}

export async function listLeavePolicies(actor: Actor): Promise<LeavePolicyRecord[]> {
  if (!canListLeavePolicies(actor) || !actor.organizationId) {
    throw new HttpError(403, "Your role does not permit this action.");
  }
  return policiesIn(actor.organizationId);
}
```

- [x] **Step 5: Add `withdrawOwnLeaveRequest` to `lib/leave-service.ts`**

At the end of the writing section:

```ts
/**
 * The applicant takes their own pending request back.
 *
 * `PENDING` only. An approved absence the team has already planned around is
 * not the applicant's alone to cancel, and a rejected one has nothing to take
 * back.
 *
 * Scoped by `userId` inside the `updateMany` rather than fetched and then
 * checked, so somebody else's id changes nothing and reports nothing — the
 * same shape `findOwnLeaveRequest` uses.
 */
export async function withdrawOwnLeaveRequest(
  actor: Actor,
  id: string,
): Promise<LeaveRequestRecord> {
  applicantOrgFor(actor);

  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.leaveRequest.findFirst({
      where: { id, userId: actor.id },
      select: { status: true },
    });
    if (!existing) throw new HttpError(404, "That request does not exist.");
    if (existing.status !== LeaveRequestStatus.PENDING) {
      throw new HttpError(409, "That request has already been decided.");
    }

    return tx.leaveRequest.update({
      where: { id },
      data: { status: LeaveRequestStatus.WITHDRAWN },
      select: REQUEST_FIELDS,
    });
  });

  return toRecord(row);
}
```

- [x] **Step 6: Write `lib/leave-review-service.ts`**

```ts
import { LeaveRequestStatus } from "@/generated/prisma/enums";
import { todayIso } from "@/lib/attendance";
import {
  type LeaveRequestRecord,
  type LeaveSummary,
  REQUEST_FIELDS,
  type RequestRow,
  summaryFor,
  toRecord,
} from "@/lib/leave-service";
import { prisma } from "@/lib/prisma";
import {
  type Actor,
  HttpError,
  canListLeaveRequests,
  canReviewLeave,
  visibleOrgId,
} from "@/lib/rbac";

/**
 * Everything about leave that reads or writes across a roster.
 *
 * The mirror image of lib/leave-service.ts, and deliberately a separate file.
 * That one opens by declaring that every operation in it is self-scoped and
 * that no `userId` parameter appears anywhere in it — one sentence a reviewer
 * can verify at a glance. Every function here takes somebody else's id or
 * reaches somebody else's row, so putting them together would demote that
 * claim to "self-scoped, except these five", which checks nothing.
 *
 * The rule the whole file follows: authorize against the row's **stored**
 * `organizationId` and `userId`, never against anything a caller supplied.
 * A request outside the caller's organization answers 404, indistinguishable
 * from one that does not exist — there is no id-probing oracle here.
 */

/** The two states a decision can put a request into. */
export type Decision = Extract<LeaveRequestStatus, "APPROVED" | "REJECTED">;

export type DecisionInput = { decision: Decision; note: string | null };

/**
 * A request as the approvals queue shows it: the member's own record, plus who
 * filed it and — once it is decided — who decided and what they said.
 */
export type ReviewRequestRecord = LeaveRequestRecord & {
  applicant: { id: string; name: string };
  /**
   * Null while PENDING, and also once the deciding admin has been deleted.
   *
   * The only thing this record adds beyond what the applicant's own
   * `LeaveRequestRecord` already carries. `decidedAt` and `decisionNote` are
   * on that base record, because the member is told when and why.
   */
  decidedBy: { id: string; name: string } | null;
};

const REVIEW_FIELDS = {
  ...REQUEST_FIELDS,
  user: { select: { id: true, name: true } },
  decidedBy: { select: { id: true, name: true } },
} as const;

type ReviewRow = RequestRow & {
  user: { id: string; name: string };
  decidedBy: { id: string; name: string } | null;
};

function toReviewRecord(row: ReviewRow): ReviewRequestRecord {
  return {
    ...toRecord(row),
    applicant: row.user,
    decidedBy: row.decidedBy,
  };
}

/**
 * The organization a roster read is scoped to.
 *
 * `visibleOrgId` answers null for a SUPERADMIN, meaning every organization —
 * so the `where` clause below omits the column entirely rather than filtering
 * on null, which would match nothing.
 */
function scopeFor(actor: Actor): { organizationId?: string } {
  if (!canListLeaveRequests(actor)) {
    throw new HttpError(403, "Your role does not permit this action.");
  }
  const organizationId = visibleOrgId(actor);
  return organizationId ? { organizationId } : {};
}

/* --------------------------------------------------------------- reading -- */

/**
 * One organization's requests, oldest filing first.
 *
 * Ordered by `createdAt`, not `startDate`: the screen's promise is "requests
 * waiting on you, oldest first", which is about how long somebody has been
 * waiting for an answer, not about when their leave begins.
 */
export async function listLeaveRequests(
  actor: Actor,
  filter: { status?: LeaveRequestStatus } = {},
): Promise<ReviewRequestRecord[]> {
  const rows = await prisma.leaveRequest.findMany({
    where: {
      ...scopeFor(actor),
      ...(filter.status ? { status: filter.status } : {}),
    },
    select: REVIEW_FIELDS,
    orderBy: { createdAt: "asc" },
  });

  return rows.map(toReviewRecord);
}

export async function findLeaveRequest(
  actor: Actor,
  id: string,
): Promise<ReviewRequestRecord | null> {
  const row = await prisma.leaveRequest.findFirst({
    where: { id, ...scopeFor(actor) },
    select: REVIEW_FIELDS,
  });

  return row ? toReviewRecord(row) : null;
}

/** The Approvals badge in app/(leave)/layout.tsx. */
export async function countPendingLeaveRequests(actor: Actor): Promise<number> {
  return prisma.leaveRequest.count({
    where: { ...scopeFor(actor), status: LeaveRequestStatus.PENDING },
  });
}

/**
 * One member's balances, for the approver deciding their request.
 *
 * The only function in the leave stack that reads a balance belonging to
 * somebody other than the caller, which is why it is ADMIN-only and why the
 * member is looked up inside the caller's own organization: an id from another
 * organization answers 404 rather than confirming that the person exists.
 *
 * The arithmetic is `summaryFor` in lib/leave-service.ts — the same function
 * `listOwnLeaveSummary` calls, not a second copy of it.
 */
export async function leaveSummaryFor(
  actor: Actor,
  userId: string,
  asOf: string = todayIso(),
): Promise<LeaveSummary> {
  const scope = scopeFor(actor);
  const member = await prisma.user.findFirst({
    where: { id: userId, ...scope },
    select: { organizationId: true },
  });
  if (!member?.organizationId) {
    throw new HttpError(404, "That member does not exist.");
  }

  return summaryFor(member.organizationId, userId, asOf);
}

/* --------------------------------------------------------------- writing -- */

/**
 * Approve or reject a pending request.
 *
 * The load and the write share a transaction, so two admins deciding the same
 * request at once cannot both pass the status check — the same reasoning the
 * overlap check in `createOwnLeaveRequest` gives.
 *
 * The status guard is deliberately inside it and deliberately strict: a
 * decision is terminal. Reversing one would mean re-checking the freed days
 * against everything filed since, which is a reconciliation path this design
 * does not open.
 */
export async function decideLeaveRequest(
  actor: Actor,
  id: string,
  input: DecisionInput,
): Promise<ReviewRequestRecord> {
  // Refusing someone's leave without saying why is the one case worth forcing
  // a sentence for. Checked before the row is loaded: it is a fact about the
  // input, not about the request.
  if (input.decision === LeaveRequestStatus.REJECTED && !input.note) {
    throw new HttpError(400, "A rejection needs a reason.");
  }

  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.leaveRequest.findUnique({
      where: { id },
      select: { organizationId: true, userId: true, status: true },
    });
    // Outside the caller's organization is indistinguishable from nonexistent.
    if (!existing) throw new HttpError(404, "That request does not exist.");
    if (visibleOrgId(actor) !== null && existing.organizationId !== actor.organizationId) {
      throw new HttpError(404, "That request does not exist.");
    }
    // Authorized on the stored columns, never on anything a caller sent.
    if (!canReviewLeave(actor, existing.organizationId, existing.userId)) {
      throw new HttpError(403, "Your role does not permit this action.");
    }
    if (existing.status !== LeaveRequestStatus.PENDING) {
      throw new HttpError(409, "That request has already been decided.");
    }

    return tx.leaveRequest.update({
      where: { id },
      data: {
        status: input.decision,
        decidedAt: new Date(),
        decidedById: actor.id,
        decisionNote: input.note,
      },
      select: REVIEW_FIELDS,
    });
  });

  return toReviewRecord(row);
}
```

- [x] **Step 7: Run the tests and watch them pass**

```bash
npm test -- tests/leave.integration.test.ts
```

Expected: PASS, every block including the ones that were green before Task 1. If `"agrees with the member's own summary for the same date"` fails, `summaryFor` is not actually shared — that test exists precisely to catch a copy.

- [x] **Step 8: Run the whole suite**

```bash
npm test
```

Expected: PASS. `lib/leave-service.ts` changed shape, so anything importing it is now in scope.

- [x] **Step 9: Commit**

```bash
git add lib/leave-review-service.ts lib/leave-service.ts tests/leave.integration.test.ts
git commit -m "Read and decide an organization's leave requests"
```

---

### Task 4: The parser, the route and the actions

**Files:**
- Modify: `lib/leave-input.ts`
- Create: `app/api/leave-requests/[id]/route.ts`
- Modify: `lib/leave-actions.ts`
- Modify: `lib/demo-actions.ts`
- Modify: `components/demo-banner.tsx`
- Test: `tests/leave-actions.test.ts`

**Interfaces:**
- Consumes: `decideLeaveRequest` (Task 3), `withdrawOwnLeaveRequest` (Task 3).
- Produces:
  - `leaveDecisionFrom(body: Record<string, unknown>): DecisionInput`
  - `reviewLeaveRequestAction(form: FormData): Promise<void>`
  - `withdrawOwnRequestAction(form: FormData): Promise<void>`

  Tasks 5 and 6 wire these to the two forms.

- [x] **Step 1: Write the failing tests**

Append to `tests/leave-actions.test.ts`. The file already stubs `redirect`, `revalidatePath` and `currentActor`; reuse them. Add an admin to its `beforeAll` — after the existing `prisma.user.create` for the admin, capture the id:

```ts
  adminId = admin.id;
```

declaring `let adminId = "";` beside the other ids, and add:

```ts
const adminActor = (): Actor => ({
  id: adminId,
  role: Role.ADMIN,
  organizationId: orgId,
});
```

Then append:

```ts
describe("reviewLeaveRequestAction", () => {
  it("approves and returns to the filter it came from", async () => {
    actorRef.current = member;
    const filed = await requests.createOwnLeaveRequest(member, {
      policyId: casualId,
      startDate: "2027-02-01",
      endDate: "2027-02-02",
      reason: null,
    });

    actorRef.current = adminActor();
    const form = new FormData();
    form.set("requestId", filed.id);
    form.set("intent", "approve");
    form.set("filter", "pending");
    form.set("note", "Fine.");

    await expect(actions.reviewLeaveRequestAction(form)).rejects.toThrow(
      "NEXT_REDIRECT",
    );

    expect(nav.redirectedTo).toBe(`/approvals?filter=pending&r=${filed.id}`);
    expect(nav.revalidated).toContain("/approvals");
  });

  it("puts a refusal back on the screen as a readable message", async () => {
    actorRef.current = member;
    const filed = await requests.createOwnLeaveRequest(member, {
      policyId: casualId,
      startDate: "2027-02-08",
      endDate: "2027-02-09",
      reason: null,
    });

    actorRef.current = adminActor();
    const form = new FormData();
    form.set("requestId", filed.id);
    form.set("intent", "reject");
    form.set("filter", "pending");
    form.set("note", "");

    await expect(actions.reviewLeaveRequestAction(form)).rejects.toThrow(
      "NEXT_REDIRECT",
    );

    expect(nav.redirectedTo).toContain("error=");
    expect(decodeURIComponent(nav.redirectedTo)).toContain("needs a reason");
  });
});

describe("withdrawOwnRequestAction", () => {
  it("withdraws and returns to the request", async () => {
    actorRef.current = member;
    const filed = await requests.createOwnLeaveRequest(member, {
      policyId: casualId,
      startDate: "2027-02-15",
      endDate: "2027-02-16",
      reason: null,
    });

    const form = new FormData();
    form.set("requestId", filed.id);

    await expect(actions.withdrawOwnRequestAction(form)).rejects.toThrow(
      "NEXT_REDIRECT",
    );

    expect(nav.redirectedTo).toBe(`/requests?r=${filed.id}`);
    expect(nav.revalidated).toContain("/requests");
  });
});
```

Add `const requests = await import("@/lib/leave-service");` beside the existing `actions` import if the file does not already have it.

- [x] **Step 2: Run them and watch them fail**

```bash
npm test -- tests/leave-actions.test.ts
```

Expected: FAIL — `actions.reviewLeaveRequestAction is not a function`.

- [x] **Step 3: Add the parser to `lib/leave-input.ts`**

```ts
/** Long enough to explain a refusal, short enough that the column is not a dumping ground. */
const MAX_NOTE = 500;

/** The form's button values, and the statuses they mean. */
const DECISIONS: Record<string, Decision> = {
  approve: "APPROVED",
  reject: "REJECTED",
};

/**
 * A decision body, shared by `PATCH /api/leave-requests/[id]` and the Server
 * Action behind /approvals — the rule every `lib/*-input.ts` follows, so a
 * form post and a JSON call cannot drift.
 *
 * Both spellings are accepted: the form submits its button's value
 * (`approve`), an API caller sends the status (`APPROVED`). Neither is
 * translated at a call site, where the mapping would eventually be duplicated.
 */
export function leaveDecisionFrom(body: Record<string, unknown>): DecisionInput {
  const raw = requiredString(body, "intent").toLowerCase();
  const decision =
    DECISIONS[raw] ?? (raw === "approved" || raw === "rejected"
      ? (raw.toUpperCase() as Decision)
      : undefined);

  if (!decision) {
    throw new HttpError(400, '"intent" must be one of: approve, reject.');
  }

  const note = optionalString(body, "note");
  if (note !== null && note.length > MAX_NOTE) {
    throw new HttpError(400, `"note" must be ${MAX_NOTE} characters or fewer.`);
  }

  // The "a rejection needs a reason" rule lives in `decideLeaveRequest`, not
  // here: it is a policy about a transition, and this file only knows shapes.
  return { decision, note };
}
```

Add to the imports at the top of the file:

```ts
import type { Decision, DecisionInput } from "@/lib/leave-review-service";
```

- [x] **Step 4: Create `app/api/leave-requests/[id]/route.ts`**

```ts
import { errorResponse, readJson } from "@/lib/api";
import { currentActor } from "@/lib/auth";
import { leaveDecisionFrom } from "@/lib/leave-input";
import { decideLeaveRequest } from "@/lib/leave-review-service";
import { withdrawOwnLeaveRequest } from "@/lib/leave-service";
import { requireActor } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Decide a request, or withdraw one's own.
 *
 * One handler for two verbs because they are the same transition from the
 * caller's side — "this request is finished" — and which one they are
 * entitled to is a policy question, answered in the service rather than by
 * the shape of the URL.
 */
export async function PATCH(request: Request, ctx: Ctx): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const { id } = await ctx.params;
    const body = await readJson(request);

    if (body["intent"] === "withdraw") {
      return Response.json(await withdrawOwnLeaveRequest(actor, id));
    }

    return Response.json(
      await decideLeaveRequest(actor, id, leaveDecisionFrom(body)),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
```

- [x] **Step 5: Add the two actions to `lib/leave-actions.ts`**

```ts
/**
 * The Server Action behind the Approvals screen.
 *
 * Lands back on the same filter and the same request, so an admin working a
 * queue keeps their place and can read the decision they just made rather
 * than being bounced to the top of a list that no longer contains it.
 */
export async function reviewLeaveRequestAction(form: FormData): Promise<void> {
  const body = formBody(form);
  const requestId = field(form, "requestId");
  const filter = field(form, "filter") || "pending";
  const back = `/approvals?filter=${filter}${requestId ? `&r=${requestId}` : ""}`;

  try {
    const actor = requireActor(await currentActor());
    await decideLeaveRequest(actor, requestId, leaveDecisionFrom(body));
  } catch (error) {
    backWithError(back, error);
  }

  revalidatePath("/approvals");
  redirect(back);
}

/** The Server Action behind the member's own Withdraw button. */
export async function withdrawOwnRequestAction(form: FormData): Promise<void> {
  const requestId = field(form, "requestId");
  const back = `/requests${requestId ? `?r=${requestId}` : ""}`;

  try {
    const actor = requireActor(await currentActor());
    await withdrawOwnLeaveRequest(actor, requestId);
  } catch (error) {
    backWithError(back, error);
  }

  revalidatePath("/requests");
  redirect(back);
}
```

Extend the file's imports:

```ts
import { backWithError, field, formBody } from "@/lib/form";
import { leaveDecisionFrom, leaveRequestInputFrom } from "@/lib/leave-input";
import { decideLeaveRequest } from "@/lib/leave-review-service";
import { createOwnLeaveRequest, withdrawOwnLeaveRequest } from "@/lib/leave-service";
```

- [x] **Step 6: Delete the demo stand-ins** — **DEFERRED to Task 6 Step 4.**

> Deleting them here leaves `app/(leave)/approvals/page.tsx` and
> `app/(member)/requests/page.tsx` importing functions that no longer exist, so
> `tsc --noEmit` and `npm run build` fail until Task 6 rewrites the second of
> them. Vitest does not typecheck, so this step's own test command stays green
> and hides it. The deletion itself is unchanged, just moved to the task where
> the last caller actually disappears; every commit compiles that way.
> **Skip the deletion here — do it in Task 6 Step 4.**

From `lib/demo-actions.ts`, delete `demoReviewRequest` (with its `/* --- approvals --- */` banner) and `demoUpdateOwnRequest`. Update the file's header comment, which lists which screens have left the fixture:

```
 * Attendance has left: it is backed by `orgapp.Attendance` and writes through
 * lib/attendance-actions.ts. Team left before it, then the holiday calendar,
 * then Apply, and now the approvals loop — /approvals and /requests both write
 * through lib/leave-actions.ts. The rest go the same way: each needs a real
 * data source first, not a different action.
```

From `components/demo-banner.tsx`, delete the now-unreachable keys `approve`, `reject`, `comment` and `reply` from `MESSAGES`.

- [x] **Step 7: Run the tests and watch them pass**

```bash
npm test -- tests/leave-actions.test.ts
```

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add lib/leave-input.ts lib/leave-actions.ts lib/demo-actions.ts \
        components/demo-banner.tsx app/api/leave-requests tests/leave-actions.test.ts
git commit -m "Approve, reject and withdraw a leave request for real"
```

---

### Task 5: The approvals screen

**Files:**
- Modify: `lib/ui.ts`
- Modify: `components/ui.tsx`
- Modify: `app/(leave)/approvals/page.tsx`
- Modify: `app/(leave)/layout.tsx`

**Interfaces:**
- Consumes: `listLeaveRequests`, `findLeaveRequest`, `countPendingLeaveRequests`, `leaveSummaryFor` (Task 3); `reviewLeaveRequestAction` (Task 4).
- Produces: `STATUS_STYLE` re-keyed to `LeaveRequestStatus`; `StatusBadge({ status: LeaveRequestStatus })`. Task 6 renders the same badge.

- [x] **Step 1: Re-key `STATUS_STYLE`** — and add a legacy twin for `/requests`

> Re-keying alone breaks `app/(member)/requests/page.tsx`, which is still on the
> fixture's lowercase `RequestStatus` until Task 6, so `tsc` and `npm run build`
> fail in between while `npm test` stays green — vitest does not typecheck and
> neither page is imported by a test. Step 8's "all clean" and Step 2's "errors
> in both files" cannot both be true.
>
> Resolved the way attendance already resolved it: `LEGACY_STATUS_STYLE` in
> `lib/ui.ts` and `LegacyStatusBadge` in `components/ui.tsx` live beside the
> real ones until the fixture screen goes, exactly as `LEGACY_ATTENDANCE_STYLE`
> does. Both are deleted in **Task 6 Step 1**. Deliberately not a cast at the
> call site: the two unions spell the same four states today, so a cast would
> compile, and a fixture status with no database counterpart would then reach
> `STATUS_STYLE[status]` as `undefined` and crash on `.className`. A second
> `Record` makes that a type error instead.

`lib/ui.ts` keys it by the fixture's lowercase `RequestStatus`; the database gives `"PENDING"`. `StatusBadge` would index `undefined` and crash on `style.className`.

Attendance has already been here: `ATTENDANCE_STYLE` is keyed by the database enums and `LEGACY_ATTENDANCE_STYLE` carries the note *"Deleted when those screens move to real data."* Leave has no screen left on the lowercase union after this task, so it re-keys in place rather than gaining a legacy twin.

In `lib/ui.ts`:

```ts
import { LeaveRequestStatus } from "@/generated/prisma/enums";

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
```

Drop `RequestStatus` from that file's import of `@/lib/types` if nothing else there uses it.

In `components/ui.tsx`:

```ts
export function StatusBadge({ status }: { status: LeaveRequestStatus }) {
```

with `import { LeaveRequestStatus } from "@/generated/prisma/enums";` and the `RequestStatus` import removed if now unused.

- [x] **Step 2: Check what else that breaks**

```bash
npx tsc --noEmit
```

Expected: errors only in `app/(leave)/approvals/page.tsx` and `app/(member)/requests/page.tsx` — the two files this task and Task 6 rewrite. **An error anywhere else means another fixture screen renders a `StatusBadge`; leave that screen alone and keep `LEGACY_STATUS_STYLE` for it rather than changing what it shows.**

- [x] **Step 3: Rewrite the page's data layer**

In `app/(leave)/approvals/page.tsx`, replace the imports and the top of the component. The filter keys become database statuses; `all` stays a sentinel meaning no filter:

```tsx
// One import from the enums module, not two — `no-duplicate-imports` is on.
import { LeaveRequestStatus, Role } from "@/generated/prisma/enums";
import { initialsFor } from "@/lib/domain";
import { unitNoun } from "@/lib/leave";
import { reviewLeaveRequestAction } from "@/lib/leave-actions";
import {
  findLeaveRequest,
  leaveSummaryFor,
  listLeaveRequests,
} from "@/lib/leave-review-service";
import { requirePageRole } from "@/lib/page-guards";
```

`initialsFor` is the sanctioned source: the `User` model's comment says `initials` is deliberately not a column because *"it is derived from `name` by `initialsFor()` in lib/domain.ts, and a stored copy would drift on rename."*

Delete the imports of `seedDb`, `demoReviewRequest`, `DemoBanner`, `RequestThread`, `balanceOf`, `formatBalance`, `personOrFallback`, `requestDays`, `dayCountLabel` and `RequestStatus`, and delete the page's demo header comment along with the `<DemoBanner />` element and the `demo` search param.

The filter table:

```tsx
const FILTERS = [
  { key: "pending", label: "Pending", status: LeaveRequestStatus.PENDING },
  { key: "approved", label: "Approved", status: LeaveRequestStatus.APPROVED },
  { key: "rejected", label: "Rejected", status: LeaveRequestStatus.REJECTED },
  // No status: All includes WITHDRAWN, which is reachable now that a member
  // can actually take a request back.
  { key: "all", label: "All", status: undefined },
] as const;
```

The body:

```tsx
  const actor = await requirePageRole(Role.ADMIN);
  const params = await searchParams;
  const option =
    FILTERS.find((f) => f.key === params.filter) ?? FILTERS[0];

  const queue = await listLeaveRequests(actor, { status: option.status });

  // Scoped in the query, so an id from another organization comes back null
  // down the same path a nonexistent one does. Falling back to the head of
  // the queue keeps the panel filled when a decision drops a request out of
  // the current filter.
  const selected =
    (params.r ? await findLeaveRequest(actor, params.r) : null) ?? queue[0] ?? null;

  const summary = selected
    ? await leaveSummaryFor(actor, selected.applicant.id)
    : null;
```

- [x] **Step 4: Rewrite the list rows**

Inside the `queue.map`, replace the fixture lookups:

```tsx
              const active = selected?.id === request.id;
              return (
                <Link
                  key={request.id}
                  href={href(request.id)}
                  className={/* unchanged */}
                >
                  <span className="flex items-center gap-2.5">
                    <Avatar initials={initialsFor(request.applicant.name)} size={28} />
                    <span className="text-sm font-semibold text-ink">
                      {request.applicant.name}
                    </span>
                    <span className="text-xs text-muted">{request.policy.name}</span>
                  </span>
                  <StatusBadge status={request.status} />
                  <span className="col-start-1 font-mono text-[13px] text-ink-2">
                    {formatRange(request.startDate, request.endDate)}
                  </span>
                  <span className="text-[13px] text-muted">
                    {request.cost} {unitNoun(request.policy.unit, request.cost)}
                  </span>
                </Link>
              );
```

`unitNoun` is used rather than `dayCountLabel` because a `USES` policy is counted in occurrences, not days — the distinction `/apply` already draws.

- [x] **Step 5: Rewrite the detail panel**

**Branch on three states, not two.** `status` has four members and only
`PENDING` gets the form, so the else-branch catches `APPROVED`, `REJECTED`
**and `WITHDRAWN`**. Withdrawal is not a decision: `withdrawOwnLeaveRequest`
writes `status` alone, leaving `decidedAt`, `decidedById` and `decisionNote`
null. A bare `decidedBy?.name ?? "An admin who has since left"` would therefore
render a member's own withdrawal as a departed admin's decision — inventing a
person. The fallback is right for the case it was written for, since
`decidedById` is `SetNull` and a real decision by a deleted admin does lose its
name; it is only wrong to reach it from a status that never had a decider.
`WITHDRAWN` became reachable in Task 3, so no screen had to render it before.

Replace the whole IIFE body. `BALANCE AFTER` uses the applicant's real summary; because `PENDING` already counts as spent, a pending request's days are *already* out of the balance and the figure is simply what remains:

```tsx
              const policy = summary?.balances.find(
                (b) => b.id === selected.policy.id,
              );
              const after = policy
                ? `${policy.balance} ${unitNoun(policy.unit, policy.balance)}`
                : "—";

              return (
                <>
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-[17px] font-semibold">
                        {selected.applicant.name}
                      </h2>
                      <StatusBadge status={selected.status} />
                    </div>

                    <dl className="grid grid-cols-3 gap-3 rounded-[9px] bg-subtle p-3.5">
                      {[
                        { label: "TYPE", value: selected.policy.name },
                        {
                          label: "DATES",
                          value: formatRange(selected.startDate, selected.endDate),
                        },
                        // Pending days are already spent — see `SPENT` in
                        // lib/leave-service.ts — so this is what is left
                        // whether or not this request is approved.
                        { label: "BALANCE LEFT", value: after },
                      ].map((cell) => (
                        <div key={cell.label} className="flex flex-col gap-1">
                          <dt className="text-[11px] tracking-[0.06em] text-muted">
                            {cell.label}
                          </dt>
                          <dd className="text-[13px] font-semibold">{cell.value}</dd>
                        </div>
                      ))}
                    </dl>

                    <p className="text-sm leading-relaxed text-ink text-pretty">
                      {selected.reason ?? "No reason given."}
                    </p>
                  </div>

                  {selected.status === LeaveRequestStatus.PENDING ? (
                    <form
                      action={reviewLeaveRequestAction}
                      className="flex flex-col gap-4"
                    >
                      <input type="hidden" name="requestId" value={selected.id} />
                      <input type="hidden" name="filter" value={option.key} />

                      <div className="flex flex-col gap-3 border-t border-line pt-4">
                        <MonoLabel>NOTE</MonoLabel>
                        <textarea
                          name="note"
                          rows={3}
                          placeholder="Required when rejecting…"
                          className={`${textareaClass} bg-surface`}
                        />
                      </div>

                      <div className="flex flex-1 gap-2">
                        <button
                          type="submit"
                          name="intent"
                          value="approve"
                          className={`${primaryButtonClass} flex-1`}
                        >
                          Approve
                        </button>
                        <button
                          type="submit"
                          name="intent"
                          value="reject"
                          className={`${dangerButtonClass} flex-1`}
                        >
                          Reject
                        </button>
                      </div>
                    </form>
                  ) : (
                    <div className="flex flex-col gap-2 border-t border-line pt-4">
                      <MonoLabel>DECISION</MonoLabel>
                      <p className="text-[13px] text-muted">
                        {/*
                          WITHDRAWN is not a decision and has no decider — the
                          member took it back. Saying "an admin who has since
                          left" here, which is what a bare `decidedBy` fallback
                          does, would invent one.
                        */}
                        {selected.status === LeaveRequestStatus.WITHDRAWN
                          ? "Withdrawn by the member."
                          : `${
                              selected.decidedBy?.name ??
                              "An admin who has since left"
                            } · ${selected.decidedAt?.slice(0, 10) ?? "—"}`}
                      </p>
                      {selected.decisionNote ? (
                        <p className="text-sm leading-relaxed text-ink text-pretty">
                          {selected.decisionNote}
                        </p>
                      ) : null}
                    </div>
                  )}
                </>
              );
```

Add the `?error=` strip below `<PageHeader>`, matching `/apply`:

```tsx
      {params.error ? (
        <p className="rounded-lg border border-danger-line bg-danger-tint px-3.5 py-2.5 text-sm text-danger">
          {params.error}
        </p>
      ) : null}
```

and widen the props type to `{ filter?: string; r?: string; error?: string }`.

- [x] **Step 6: Make the sidebar badge real**

In `app/(leave)/layout.tsx`, replace `const pending = pendingRequests(seedDb()).length;` with:

```tsx
  const pending = await countPendingLeaveRequests(actor);
```

Import `countPendingLeaveRequests` from `@/lib/leave-review-service`, drop the `pendingRequests` import from `@/lib/domain`, and keep `COMPANY_NAME` from `@/lib/seed` — it is the only thing that file still supplies here.

- [x] **Step 7: Verify by hand**

```bash
docker compose up -d
npm run dev
```

Sign in as a member, file a request at `/apply`, sign out, sign in as an admin of the same organization. Confirm:

1. `/approvals` lists the real request under the member's real name, with the real day count.
2. The sidebar badge matches the pending count.
3. Approving lands back on `?filter=pending&r=<id>`, and the request moves to the Approved filter with the deciding admin's name and the date on the panel.
4. Rejecting with an empty note comes back with **"A rejection needs a reason."** in the error strip.
5. Rejecting with a note succeeds, and the member's balance on `/apply` returns to what it was before they filed.

- [x] **Step 8: Check types and lint**

```bash
npx tsc --noEmit && npm run lint && npm test
```

Expected: all clean.

- [x] **Step 9: Commit**

```bash
git add lib/ui.ts components/ui.tsx "app/(leave)/approvals/page.tsx" "app/(leave)/layout.tsx"
git commit -m "Put the approvals queue on the organization's real requests"
```

---

### Task 6: The member's side

**Files:**
- Modify: `app/(member)/requests/page.tsx`
- Modify: `app/(member)/apply/page.tsx`
- Modify: `lib/leave-actions.ts`

**Interfaces:**
- Consumes: `listOwnLeaveRequests`, `findOwnLeaveRequest` (existing); `withdrawOwnRequestAction` (Task 4); `StatusBadge` (Task 5).
- Produces: nothing further.

- [x] **Step 1: Rewrite `/requests`, and retire the legacy badge**

This page is the last consumer of the fixture's lowercase status, so once it
reads `listOwnLeaveRequests` its status is already a `LeaveRequestStatus`.
Delete `LEGACY_STATUS_STYLE` from `lib/ui.ts` and `LegacyStatusBadge` from
`components/ui.tsx` — both added in Task 5 Step 1 — and use `StatusBadge`.
`RequestStatus` in `lib/types.ts` stays; the other fixture screens still use it.

Replace the whole of `app/(member)/requests/page.tsx`:

```tsx
import Link from "next/link";

import { LeaveRequestStatus } from "@/generated/prisma/enums";
import { PageHeader } from "@/components/page-header";
import { Card, EmptyPanel, MonoLabel, StatusBadge } from "@/components/ui";
import { formatRange } from "@/lib/date";
import { unitNoun } from "@/lib/leave";
import { withdrawOwnRequestAction } from "@/lib/leave-actions";
import { listOwnLeaveRequests } from "@/lib/leave-service";
import { requirePageActor } from "@/lib/page-guards";

/**
 * Member: every request this person has filed, and what became of it.
 *
 * Self-scoped, like /apply and /calendar: `listOwnLeaveRequests` takes no user
 * id at all — the applicant is the session — so there is no id in the URL for
 * a member to change into a colleague's.
 *
 * The approver's decision note takes the place of the fixture's feedback
 * thread. A real back-and-forth needs a table, and there isn't one; a single
 * recorded reason is what a decision actually carries today.
 */
export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ r?: string; error?: string }>;
}) {
  const actor = await requirePageActor();
  const params = await searchParams;

  const mine = await listOwnLeaveRequests(actor);
  const selected = mine.find((request) => request.id === params.r) ?? mine[0] ?? null;

  return (
    <>
      <PageHeader
        title="My requests"
        subtitle="Every request you have filed, and what became of it."
        meta="MEMBER VIEW"
      />

      {params.error ? (
        <p className="rounded-lg border border-danger-line bg-danger-tint px-3.5 py-2.5 text-sm text-danger">
          {params.error}
        </p>
      ) : null}

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card className="overflow-hidden">
          {mine.map((request) => {
            const active = selected?.id === request.id;
            return (
              <Link
                key={request.id}
                href={`/requests?r=${request.id}`}
                className={`grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 border-b border-line px-4 py-3.5 text-left no-underline transition-colors last:border-b-0 ${
                  active ? "bg-brand-tint" : "bg-surface hover:bg-subtle"
                }`}
              >
                <span className="text-sm font-semibold text-ink">
                  {request.policy.name}
                </span>
                <StatusBadge status={request.status} />
                <span className="font-mono text-[13px] text-ink-2">
                  {formatRange(request.startDate, request.endDate)}
                </span>
                <span className="text-[13px] text-muted">
                  {request.cost} {unitNoun(request.policy.unit, request.cost)}
                </span>
              </Link>
            );
          })}

          {mine.length === 0 ? (
            <div className="px-4 py-11 text-center text-sm text-muted">
              No requests yet — file one from Apply for leave.
            </div>
          ) : null}
        </Card>

        {selected ? (
          <Card className="sticky top-6 flex flex-col gap-4.5 p-5.5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[17px] font-semibold">
                {selected.policy.name} ·{" "}
                {formatRange(selected.startDate, selected.endDate)}
              </h2>
              <StatusBadge status={selected.status} />
            </div>

            <p className="text-sm leading-relaxed text-ink text-pretty">
              {selected.reason ?? "No reason given."}
            </p>

            {selected.status === LeaveRequestStatus.PENDING ? (
              <form action={withdrawOwnRequestAction} className="border-t border-line pt-4">
                <input type="hidden" name="requestId" value={selected.id} />
                <p className="mb-3 text-[13px] text-muted">
                  With {selected.approver?.name ?? "your admin"} now.
                </p>
                <button
                  type="submit"
                  className="w-full cursor-pointer rounded-lg border border-line bg-surface px-3 py-2.5 text-[13px] text-danger transition-colors hover:bg-danger-tint"
                >
                  Withdraw request
                </button>
              </form>
            ) : (
              <div className="flex flex-col gap-2 border-t border-line pt-4">
                <MonoLabel>DECISION</MonoLabel>
                <p className="text-[13px] text-muted">
                  {selected.status === LeaveRequestStatus.WITHDRAWN
                    ? "You took this back."
                    : `${selected.approver?.name ?? "Your admin"} decided this.`}
                </p>
              </div>
            )}
          </Card>
        ) : (
          <EmptyPanel>Select a request to see what became of it.</EmptyPanel>
        )}
      </div>
    </>
  );
}
```

- [x] **Step 2: Show the reason, not just the status**

`decisionNote` is already on `LeaveRequestRecord` from Task 3 Step 3, so the member's own read carries it. Render it in the decided branch of the panel above, after the `<p>`:

```tsx
                {selected.decisionNote ? (
                  <p className="text-sm leading-relaxed text-ink text-pretty">
                    {selected.decisionNote}
                  </p>
                ) : null}
```

A rejected request the member can see but cannot read the reason for is the fixture's silence wearing a real status.

- [x] **Step 3: Send a new filing to `/requests`**

`submitLeaveRequestAction` in `lib/leave-actions.ts` lands on `/apply?submitted=<id>` and says why in a comment: *"`/requests` is still on the fixture in this scope, so redirecting there would show a stranger's thread instead of the filing just made."* That reason expires here.

```ts
  // /requests is real now, so the filing lands where the member will look for
  // it again — beside every other request they have made, with its status.
  revalidatePath("/requests");
  redirect(`/requests?r=${id}`);
```

- [x] **Step 4: Remove the confirmation strip from `/apply`, and delete the demo stand-ins**

Deferred here from Task 4 Step 6, because this is where the last caller goes.
From `lib/demo-actions.ts`, delete `demoReviewRequest` (with its
`/* --- approvals --- */` banner) and `demoUpdateOwnRequest`, and update the
file's header comment, which lists which screens have left the fixture:

```
 * Attendance has left: it is backed by `orgapp.Attendance` and writes through
 * lib/attendance-actions.ts. Team left before it, then the holiday calendar,
 * then Apply, and now the approvals loop — /approvals and /requests both write
 * through lib/leave-actions.ts. The rest go the same way: each needs a real
 * data source first, not a different action.
```

From `components/demo-banner.tsx`, delete the now-unreachable keys `approve`,
`reject`, `comment` and `reply` from `MESSAGES`.

Then, in `app/(member)/apply/page.tsx`:

In `app/(member)/apply/page.tsx`, delete the `submitted` block, the `findOwnLeaveRequest` call and its import, the `formatRange` and `unitNoun` imports if now unused, and drop `submitted` from the `searchParams` type. The `?error=` strip stays — `backWithError` still sends failures there.

- [x] **Step 5: Fix the action test that asserted the old redirect**

`tests/leave-actions.test.ts` asserts `?submitted=` on the success path. Update that expectation:

```ts
    expect(url).toBe(`/requests?r=${stored?.id}`);
    expect(nav.revalidated).toContain("/requests");
```

Kept as an exact match on the stored id rather than the `toMatch(/^\/requests\?r=/)`
this step first specified: the test is named *"writes the row and comes back
with its id"*, and a prefix regex would stop proving the half after the comma.

- [x] **Step 6: Run everything**

```bash
npx tsc --noEmit && npm run lint && npm test
```

Expected: all clean. `LeaveRequestRecord` gained two fields, so any stale spread shows up here.

- [x] **Step 7: Verify by hand**

```bash
npm run dev
```

As a member: file a request and confirm you land on `/requests` with it selected and PENDING. Withdraw it; confirm the status and that `/apply` shows the days back. File another, decide it as an admin with a note, and confirm the member sees the status **and the note**. Confirm the Withdraw button is gone once decided.

- [x] **Step 8: Commit**

```bash
git add "app/(member)/requests/page.tsx" "app/(member)/apply/page.tsx" \
        lib/leave-actions.ts lib/leave-service.ts lib/leave-review-service.ts \
        tests/leave-actions.test.ts
git commit -m "Show a member what became of their own request"
```

---

## 5. Verification

Run in order from a clean tree:

```bash
docker compose up -d
npx prisma migrate dev
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Then the loop end to end, in one browser session each:

| # | As | Do | Expect |
|---|----|----|--------|
| 1 | member | file at `/apply` | lands on `/requests?r=<id>`, PENDING, balance reduced |
| 2 | admin (same org) | open `/approvals` | the request, under the member's real name, badge count matches |
| 3 | admin | Reject with an empty note | `"A rejection needs a reason."` in the error strip |
| 4 | admin | Reject with a note | status REJECTED, decider and date on the panel |
| 5 | member | open `/requests` | REJECTED, with the admin's note |
| 6 | member | open `/apply` | the days are back |
| 7 | member | file again, then Withdraw | WITHDRAWN, days back, no Withdraw button after |
| 8 | admin (**other** org) | open `/approvals` | none of the above is visible |

> **If one is already running, stop it first — Next 16 refuses a second dev server in the same directory.**

## 6. What is still fixture after this

`/overview`, `/score`, `/scores`, `/setup`, and `/profile`'s documents. `/setup` is the notable one: leave policies are a real table with a real API, and the screen that edits them still posts to `demoUpdatePolicy`.

`RequestThread` and `ThreadMessage` stay in the tree, unused, for the comment thread in §8.

## 7. Known contradiction, accepted

**An approved leave day still reads as unmarked on `/attendance`, and `mark-all-present` will happily mark it PRESENT.** `AttendanceStatus.LEAVE` exists and nothing sets it. Connecting the two makes approval a multi-table transaction with real reconciliation edges — what if the day is already marked? — and it earns its own plan rather than a corner of this one.

## 8. Out of scope

- **A comment thread** (`LeaveRequestComment`). The decision note carries the one message that has to exist.
- **The attendance link** — §7.
- **Notifying anybody.** No email, no in-app notification; the member learns the outcome by opening `/requests`.
- **Reversing a decision.**
- **Bulk approve.**
- **Approval rules** — the multi-step routing `/setup` renders a toggle for. `approverId` is one person, chosen at submit.
