# Leave Approvals on Real Data — Design

**Date:** 2026-09-07
**Status:** Approved design (pre-plan)
**Goal:** Close the loop a member's application opens. A request filed at `/apply` is written to `orgapp.LeaveRequest` today and then read by nothing: `/approvals` shows an in-memory fixture, and `/requests` shows a hardcoded stranger. This design puts both screens on the real table and makes Approve, Reject and Withdraw persist.

**Builds on:**
[`2026-09-04-apply-for-leave-real-data-plan.md`](./2026-09-04-apply-for-leave-real-data-plan.md),
[`2026-09-04-leave-accrual-design.md`](./2026-09-04-leave-accrual-design.md),
[`2026-08-27-multi-tenant-org-rbac-design.md`](./2026-08-27-multi-tenant-org-rbac-design.md).

---

## 1. Where things stand

`/apply` is real. `submitLeaveRequestAction` → `createOwnLeaveRequest` writes a genuine row: `PENDING`, cost frozen at submit against weekends and the applicant's region's holidays, approver resolved from `User.managerId` with a fallback to the organization's oldest active `ADMIN`, and an overlap check inside the insert's transaction.

Nothing downstream of that write exists.

| # | Defect | Where |
|---|--------|-------|
| B1 | `/approvals` renders `seedDb()` — the in-memory fixture in `lib/seed.ts`. Every request on the screen is invented; not one real filing is visible to anyone. | `app/(leave)/approvals/page.tsx` |
| B2 | Approve, Reject and Send comment post to `demoReviewRequest`, a bare `redirect("/approvals?…&demo=…")`. Nothing is written, and `DemoBanner` says so. | `lib/demo-actions.ts` |
| B3 | `/requests` renders `demoDb()` and `demoMember(db)` — a hardcoded `"u2"`, Dev Menon. Every member sees a fixture person's request history under their own name, the same defect A1 fixed on `/apply`. | `app/(member)/requests/page.tsx` |
| B4 | Withdraw posts to `demoUpdateOwnRequest`. Also a redirect. `LeaveRequestStatus.WITHDRAWN` exists in the schema and nothing can ever set it. | `lib/demo-actions.ts` |
| B5 | The sidebar's Approvals badge counts `pendingRequests(seedDb())`. An admin is shown a pending count that has no relationship to their organization. | `app/(leave)/layout.tsx` |
| B6 | There is no roster-wide read. `lib/leave-service.ts` is self-scoped by construction and says so at the top: *"There is no `userId` parameter anywhere in it."* Its own comment defers this work: *"The roster-wide read belongs to /approvals and gets its own predicate when that screen moves off the fixture."* | `lib/leave-service.ts`, `lib/rbac.ts` |
| B7 | There is nowhere to record a decision. `status` can be set, but no column holds who decided, when, or why. | `prisma/schema.prisma` |
| B8 | The feedback thread on both screens is `ThreadMessage[]` from `lib/types.ts`. There is no comment table and this design does not add one — see §8. | `components/request-thread.tsx` |

## 2. The rules this implements

Confirmed with the product owner on 2026-09-07.

1. **Any `ADMIN` may decide any request in their own organization.** `LeaveRequest.approverId` records who it was *routed to* at submit; it does not restrict who may act.

   The alternative — only the named approver decides — was rejected because it strands requests. `/approvals` is `ADMIN`-only in both `proxy.ts` and `app/(leave)/layout.tsx`, but `User.managerId` may point at a `MEMBER`: a team lead who is not an admin would be routed requests they cannot open. `approverId` is also `ON DELETE SET NULL`, so an approver who leaves leaves their queue behind as null. Under this rule neither case is a dead letter.

2. **Nobody decides their own request.** `canApplyForLeave` deliberately admits `ADMIN` — *"an admin is a person who takes leave"* — so without this rule an admin could approve themselves.

   The knowingly accepted cost: in a one-admin organization, that admin's own leave cannot be decided by anybody. That is the correct failure. Self-approval is not a lesser problem than an undecidable request, and the fix for the small org is a second admin, not a weaker rule.

3. **A decision is terminal.** `PENDING → APPROVED` and `PENDING → REJECTED`, nothing else. Deciding an already-decided request is a `409`. There is no un-approve: reversing an approval would have to re-check the freed days against everything filed since, which is a reconciliation path this design refuses to open.

4. **A rejection requires a note; an approval's is optional.** Refusing someone's leave without a reason is the one case worth forcing a sentence for.

5. **A member may withdraw their own `PENDING` request.** Not one that has been decided — an approved absence the team has planned around is not the applicant's alone to cancel.

6. **Balances need no new arithmetic.** `listOwnLeaveSummary` already counts `PENDING` alongside `APPROVED` as spent. So:

   - approving is **balance-neutral** — the days were already held,
   - rejecting or withdrawing **returns the days** by falling out of the `SPENT` filter.

   This is the whole payoff of deriving the balance rather than storing it: there is no ledger to reconcile and no reconcile path to get wrong. The existing test *"frees the days again when the request is withdrawn"* already asserts it — by writing the column directly with `prisma.leaveRequest.updateMany`, because no application code path can reach any status but `PENDING` today.

7. **A `SUPERADMIN` may read an organization's requests but not decide them.** The same split `canListAttendance` and `canMarkAttendance` already draw.

8. **Deliberately not changed:** the request's `cost` is never re-priced at decision time. It was frozen at submit and a holiday added since must not move it — the rule stated as A5/§5 in the apply plan.

## 3. Approach

The decision has to be recorded somewhere. Three candidates:

**A. Decision columns on `LeaveRequest`.** `decidedAt`, `decidedById`, `decisionNote`. One table, one migration, one write.

**B. Columns plus an append-only `LeaveRequestEvent` log**, mirroring `AttendanceEvent`.

**C. Drop `status` and derive it from a decisions table.**

**Chosen: A.**

B's precedent looks stronger than it is. `AttendanceEvent` exists because attendance permits unlimited backdated correction — any day can be rewritten at any time, so the row alone cannot tell you what happened to it, and the log is what makes that safe. A leave request is decided exactly once and is then terminal (rule 3). The log would carry one row per request, duplicating three columns that are already on it.

C is strictly worse: `status` is a column today, and the `@@index([userId, status])` behind the balance query and the overlap check depends on it. Discarding it to recompute the same value costs a join on the hottest read in the leave stack.

A's three columns are a strict subset of what B would need, so if a comment thread arrives later (§8) this is not a migration to undo.

## 4. Schema

Three nullable columns on `LeaveRequest`. No new table, no new enum — `LeaveRequestStatus` already has all four members.

```prisma
  /// When the decision was made. Null while PENDING.
  ///
  /// Distinct from `updatedAt`, which moves for any write. Reading "when was
  /// this approved" off `updatedAt` would be wrong the first time anything
  /// else touches the row.
  decidedAt DateTime?

  /// The admin who approved or rejected it — not necessarily `approverId`,
  /// which records who it was *routed* to at submit. Any admin in the
  /// organization may decide, so the two differ routinely.
  ///
  /// Nullable and SetNull for the reason `approverId` and
  /// `Attendance.markedById` give: this is attribution, not ownership. An
  /// admin who leaves is deleted, and neither blocking that delete nor
  /// destroying the organization's leave history with it is acceptable. Null
  /// therefore means "the admin who decided this is gone", never "undecided" —
  /// `status` and `decidedAt` are what answer that.
  decidedById String?
  decidedBy   User?   @relation("LeaveRequestDecider", fields: [decidedById], references: [id], onDelete: SetNull)

  /// Why. Required by the service on a rejection, optional on an approval.
  /// Not enforced by a CHECK: it is a policy about one transition, not an
  /// invariant of the row, and a future status could reasonably not want it.
  decisionNote String?
```

`User` gains the matching back-relation, `leaveDecisions LeaveRequest[] @relation("LeaveRequestDecider")` — the third named relation on that model, alongside the two `LeaveRequest` already has.

**Index.** The approvals queue reads one organization filtered by status, ordered oldest-first. The existing `@@index([organizationId, startDate])` is on the wrong column for the filter and the wrong column for the sort. Add:

```prisma
  /// The approvals queue: one organization's requests in one state, oldest
  /// filing first.
  @@index([organizationId, status, createdAt])
```

The existing index stays — it serves the calendar-shaped reads that ask which requests touch a span.

**Migration.** Every object hand-qualified as `"orgapp"."LeaveRequest"`, per the standing constraint: `prisma migrate diff` emits bare names, which land in `public` on a fresh database. Existing rows need no backfill — all three columns are nullable and every existing row is `PENDING`, for which null is the correct value.

## 5. Where the code changes

### 5.1 Two new predicates in `lib/rbac.ts`

```ts
/**
 * Deciding a request belongs to the ADMIN of the organization it was filed
 * in — the same rule as `canManageHolidays`, and pass the *stored*
 * `LeaveRequest.organizationId`, never one from a request body.
 *
 * The applicant is excluded even when they are that admin. `canApplyForLeave`
 * admits an ADMIN deliberately, so without this an admin approves themselves.
 */
canReviewLeave(actor, requestOrganizationId, applicantId): boolean

/**
 * Reading follows `canListAttendance`, not `canReviewLeave`: a SuperAdmin sees
 * every organization, so they may read the requests inside one even though
 * they cannot decide them. Scope the query with `visibleOrgId`.
 */
canListLeaveRequests(actor): boolean
```

### 5.2 A new module, not a bigger one — `lib/leave-review-service.ts`

`lib/leave-service.ts` opens by declaring an invariant it then enforces file-wide: every operation is self-scoped, there is no `userId` parameter anywhere in it, so there is no id for a member to tamper with and no path that reaches a colleague's leave. That single sentence is what makes the file reviewable at a glance.

A roster-wide read breaks it. Rather than weaken the claim to "self-scoped, except these five functions", everything roster-scoped moves to a new module:

| Function | Scope |
|---|---|
| `listLeaveRequests(actor, { status? })` | org, via `visibleOrgId`; joins applicant name; **oldest first** |
| `findLeaveRequest(actor, id)` | org |
| `decideLeaveRequest(actor, id, { decision, note })` | org; one transaction |
| `countPendingLeaveRequests(actor)` | org; the sidebar badge |
| `leaveSummaryFor(actor, userId)` | org; the detail panel's balance |

`withdrawOwnLeaveRequest` is self-scoped and therefore stays in `lib/leave-service.ts`, where the file's stated invariant still holds over it.

`decideLeaveRequest` loads the row, authorizes against its **stored** `organizationId` and `userId`, refuses a non-`PENDING` status with `409`, requires a note when rejecting, and writes `status`, `decidedAt`, `decidedById` and `decisionNote` together. Load and write share a transaction so two admins deciding at once cannot both pass the status check.

### 5.3 The balance the detail panel needs

`/approvals` shows BALANCE AFTER for the applicant. `listOwnLeaveSummary` cannot serve it — it takes no user id, by design.

`leaveSummaryFor(actor, userId)` is that function with the identity supplied rather than assumed. The two share their whole body; the difference is which id is read and who is allowed to ask. So the shared work is extracted into an internal `summaryFor(organizationId, userId, asOf)` and both become thin authorization wrappers over it. Copying four Prisma queries and the `usedByPolicy` fold into a second module is how the two screens start disagreeing about a member's balance.

This is the largest single piece of the change and the one place a shortcut would cost most.

### 5.4 Routes and actions

- `GET /api/leave-requests` — **unchanged**, still self-scoped, still with no `userId` parameter in any form.
- **New** `GET /api/leave-requests?scope=org` is deliberately *not* added. The roster read is a page-level concern; adding a query parameter that widens the scope of an existing self-scoped endpoint is exactly the shape the route's own comment warns about.
- **New** `PATCH /api/leave-requests/[id]` — decide or withdraw, following `app/api/holidays/[id]/route.ts`. The intent is in the body; the service decides which the caller is entitled to.
- `lib/leave-input.ts` gains `leaveDecisionFrom`, shared by the route and the action so a form post and a JSON call cannot drift on field names — the rule every `lib/*-input.ts` follows.
- `lib/leave-actions.ts` gains `reviewLeaveRequestAction` and `withdrawOwnRequestAction`, both re-authenticating rather than trusting `proxy.ts`.
- `demoReviewRequest` and `demoUpdateOwnRequest` are **deleted** from `lib/demo-actions.ts`, and their `approve` / `reject` / `comment` / `reply` entries removed from `components/demo-banner.tsx`. Defect A8 in the apply plan was a dead second `submitLeaveRequest` left beside the real one; leaving these would recreate it.

### 5.5 The screens

**`/approvals`** — `seedDb()` → `listLeaveRequests`. The four filters map to `LeaveRequestStatus`; **All includes `WITHDRAWN`**, which is now reachable. The `RequestThread` block becomes a decision note field, and once decided the panel shows who decided, when, and what they wrote. `DemoBanner` goes.

**`/requests`** — `demoDb()`/`demoMember()` → `listOwnLeaveRequests`. Withdraw actually withdraws. The panel shows the approver's decision note in place of the thread. `DemoBanner` goes.

**`app/(leave)/layout.tsx`** — the badge calls `countPendingLeaveRequests`.

**`lib/ui.ts`** — `STATUS_STYLE` is keyed by `RequestStatus` from `lib/types.ts`, the fixture's **lowercase** union (`"pending"`), while the database enum is `LeaveRequestStatus.PENDING`. `StatusBadge` would silently index `undefined` and crash on `style.className`.

Re-key it to `LeaveRequestStatus`, which is precisely what attendance already did: `ATTENDANCE_STYLE` is keyed by the database enums and `LEGACY_ATTENDANCE_STYLE` — kept only for the screens still on the fixture — carries the note *"Deleted when those screens move to real data."* Leave has no screen left on the fixture `RequestStatus` after this change, so it re-keys in place rather than gaining a legacy twin.

**`lib/leave-actions.ts`** — `submitLeaveRequestAction` currently lands on `/apply?submitted=…` with a comment explaining why: *"`/requests` is still on the fixture in this scope, so redirecting there would show a stranger's thread."* That reason expires here. The redirect moves to `/requests?r=<id>`, and the confirmation strip on `/apply` and its `findOwnLeaveRequest` call are removed with it.

## 6. Testing

| Test | Covers |
|---|---|
| `rbac.test.ts` | Both predicates. Explicitly: an admin cannot review their own request; a member cannot review at all; a superadmin lists but does not decide. |
| `leave.integration.test.ts` | **An admin of org B can neither see nor decide a request filed in org A** — the case that matters most. Plus: decide writes all four fields; `409` on re-decide; reject without a note is a `400`; withdraw works on `PENDING` and is refused after a decision; a rejected request returns its days to the applicant's balance; `leaveSummaryFor` and `listOwnLeaveSummary` agree for the same member on the same date. |
| `leave-actions.test.ts` | The two new actions redirect where they should and surface `HttpError` messages through `backWithError`. |

## 7. What is still fixture after this

`/overview`, `/score`, `/scores`, `/setup` and `/profile`'s documents. `/setup` is the notable one: leave policies are a real table with a real API, but the screen that edits them still posts to `demoUpdatePolicy`.

## 8. Out of scope

- **A comment thread.** `LeaveRequestComment` and the back-and-forth both screens currently mock. The decision note carries the one message that has to exist; a conversation is a table, two write paths and a read-state problem, and it should follow the loop rather than arrive with it. `RequestThread` and `ThreadMessage` stay in the tree for it.
- **The attendance link.** `AttendanceStatus.LEAVE` exists and nothing sets it, so an approved leave day still reads as unmarked and `mark-all-present` can still mark it `PRESENT`. Connecting the two makes approval a multi-table transaction with real reconciliation edges — what if the day is already marked? — and it earns its own plan. **This is a known contradiction between two screens after this change, accepted deliberately.**
- **Notifying anybody.** No email, no in-app notification. The member learns the outcome by opening `/requests`.
- **Reversing a decision** (rule 3).
- **Bulk approve.**
- **Approval rules** — the multi-step routing `/setup` renders a toggle for. `approverId` is one person, chosen at submit.
