# Comp-off Claims — Design

**Date:** 2026-09-10
**Status:** Approved design (pre-plan)
**Goal:** Add **Comp-off** as a leave type a member can apply for, entitled not by a yearly allowance but by days they actually worked: the member claims a worked non-working day, an admin approves it, and the approved claim is the credit they spend.

**Builds on:**
[`2026-09-04-leave-accrual-design.md`](./2026-09-04-leave-accrual-design.md),
[`2026-09-07-leave-approvals-real-data-design.md`](./2026-09-07-leave-approvals-real-data-design.md),
[`2026-08-27-multi-tenant-org-rbac-design.md`](./2026-08-27-multi-tenant-org-rbac-design.md).

---

## 1. Where things stand

A leave type is not code. It is a `LeavePolicy` row, and `policiesIn` (`lib/leave-service.ts:265`) hands the Apply select every `active` policy in the member's organization, ordered by `position`. `components/apply-form.tsx:72` renders whatever arrives and drives the rest of the form off the policy's `unit`. **Adding a leave type therefore needs no component change at all** — which is why the interesting part of this work is not the type but the entitlement behind it.

| # | Gap | Where |
|---|-----|-------|
| G1 | Entitlement is a *schedule*: a whole-year `allowance` credited `UPFRONT` or `MONTHLY`. There is no way to express "this member has one day because they worked Sunday 12 October". | `prisma/schema.prisma:302`, `lib/leave.ts:190` |
| G2 | `balanceAsOf` derives credit purely from `CreditRule`. Every input is a policy column; nothing per-member but `joinedOn` reaches it. | `lib/leave.ts:241` |
| G3 | Nothing in the application creates a `LeavePolicy`. The only writer is the seed, idempotent on name. There is no admin editor for leave types, and this design does not add one. | `prisma/seed.ts:319` |
| G4 | There is no record anywhere of a member having worked a non-working day. `Attendance` records presence, but nothing marks that presence as *earning* something. | `prisma/schema.prisma:187` |
| G5 | `lib/rbac.ts` has no comp-off predicate, and `/approvals` has exactly one queue. | `lib/rbac.ts`, `app/(leave)/approvals/page.tsx` |

## 2. The rules this implements

Settled during design on 2026-09-10.

1. **A comp-off credit is earned, never scheduled.** It exists because a specific day was worked. This is the one entitlement in the system with no relationship to the calendar year's start, to `joinedOn`, or to `allowance`.

2. **One approved claim is one day.** No half-day comp-off, no claim earning two days for a long Sunday. If that is ever wanted it is a `days` column and a form field, and nothing else in this design changes.

3. **Credits lapse on 31 December.** A claim belongs to the year its *worked day* falls in — `chargeYear(workedOn)` — and the Comp-off policy carries `carry = false`. This is why the table needs no `expiresOn` column and no sweeping job: the existing year bucketing already expires it. A credit earned in December is worth less than one earned in January, and that is accepted.

4. **Only a non-working day can be claimed.** A weekend (`isWeekend`, `lib/date.ts:71`) or a holiday in the claimant's own region. Claiming an ordinary Tuesday is refused: comp-off compensates for time that was not owed, and an ordinary working day was owed.

5. **The worked day must not be in the future.** You cannot claim for a Sunday you have not yet worked.

6. **A day may not be claimed twice.** The check is on `PENDING` and `APPROVED` claims, not on every row, so a rejected claim can be re-filed with a better reason. This mirrors the overlap check in `createOwnLeaveRequest` exactly — including its honesty about the race: the check and the insert share a transaction, which narrows the window rather than closing it.

7. **The claimant never decides their own claim.** `canReviewCompOff` excludes the claimant for the same reason `canReviewLeave` does, and accepts the same consequence: in a one-admin organization that admin's own claim cannot be decided by anybody, which is the better of the two failures.

8. **The member read takes no user id.** `listOwnCompOffClaims(actor)` has no id parameter, the convention `listOwnLeaveRequests` set. A member cannot read a colleague's claims because there is no way to ask, not because a check refuses.

9. **The balance stays one function.** `/apply` and `/approvals` must agree to the day — `lib/leave.ts:225` and `app/(leave)/approvals/page.tsx:35` both say so. Comp-off enters through `balanceAsOf`, not around it.

## 3. Approach

### 3.1 The approved claim *is* the credit

One new table, `CompOffClaim`, deliberately shaped like `LeaveRequest`: subject, worked date, status, reason, routing and decision columns. There is no second "credit" table. The comp-off credit for year *Y* is

```
credited(Y) = count(claims where status = APPROVED and chargeYear(workedOn) = Y)
```

and the balance is that, minus days already spent against the Comp-off policy in *Y* — which the existing `usedByPolicy` map already computes for every policy.

Nothing is copied on approval, so a claim and its credit cannot disagree; there is no state to reconcile and no transaction that must write two rows.

### 3.2 Rejected: a separate `LeaveCredit` ledger

Approving a claim would write a credit row. The indirection buys one thing — credits arriving from a source that is not a claim (auto-derived attendance, an admin correction, an import). That flexibility is speculative today, and it costs a second table, a two-row transaction on every approval, and a class of bug where the ledger and the claims disagree. If auto-earning ever arrives it fits §3.1 as a `source` column on the claim with an auto-approved status, which is a strictly smaller change than maintaining two tables from the start.

### 3.3 Rejected: derive from attendance, with no claim at all

Balance would be `Attendance` rows on non-working days, minus comp-off taken. Nothing to store, nothing to approve — and nowhere to record a decision, which the agreed member-claims/admin-approves flow requires. It would also silently convert every weekend attendance mark ever made into an entitlement.

## 4. Data model

A dedicated status enum rather than reuse of `LeaveRequestStatus`. The four values coincide today, but a claim and a leave request are independent lifecycles, and a value added to one for its own reasons must not silently appear in the other.

```prisma
/// The lifecycle of a comp-off claim. Deliberately not `LeaveRequestStatus`:
/// the values coincide today, but the two lifecycles are independent and a
/// value added to one must not appear in the other by accident.
enum CompOffClaimStatus {
  PENDING
  APPROVED
  REJECTED
  WITHDRAWN
}

/// One member's claim that they worked a day they were not owed.
///
/// An APPROVED claim *is* the credit — there is no separate ledger. The
/// comp-off balance for a year is the count of approved claims whose
/// `workedOn` falls in it, less the days spent against the Comp-off policy.
/// See the design, section 3.1.
model CompOffClaim {
  id String @id @default(cuid())

  /// Denormalised from the claimant's own `User` row, never from a request
  /// body — the rule lib/attendance-service.ts and LeaveRequest both follow.
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  userId String
  user   User   @relation("CompOffClaimSubject", fields: [userId], references: [id], onDelete: Cascade)

  /// The non-working day that was worked: a weekend, or a holiday in the
  /// claimant's region, validated at submit. Never in the future.
  workedOn DateTime @db.Date

  /// What was worked on. Optional, but it is what an approver decides against.
  reason String?

  status CompOffClaimStatus @default(PENDING)

  /// Who it went to at submit — the claimant's manager, or an admin. Routing,
  /// not permission: see `LeaveRequest.approverId`.
  approverId String?
  approver   User?   @relation("CompOffClaimApprover", fields: [approverId], references: [id], onDelete: SetNull)

  /// When the decision was made. Null while PENDING, and distinct from
  /// `updatedAt`, which moves for any write.
  decidedAt DateTime?

  /// The admin who decided — not necessarily `approverId`. Null means that
  /// admin is gone, never "undecided": `status` and `decidedAt` answer that.
  decidedById String?
  decidedBy   User?   @relation("CompOffClaimDecider", fields: [decidedById], references: [id], onDelete: SetNull)

  /// Why. Required by the service on a rejection, optional on an approval —
  /// a policy about one transition, not an invariant of the row.
  decisionNote String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  /// The credit query: one member's claims, filtered by status.
  @@index([userId, status])
  /// The approvals section: one organization in one state, oldest first.
  @@index([organizationId, status, createdAt])
}
```

**No `@@unique([userId, workedOn])`.** Rule 6 permits re-filing a rejected claim, which a hard unique index would forbid. The real constraint is *"no PENDING or APPROVED claim for this day"* — a partial index — and it is enforced in the service inside the same transaction as the insert, exactly as the leave overlap check is.

### 4.1 The accrual kind

```prisma
enum LeaveAccrual {
  UPFRONT
  MONTHLY
  /// Credit comes from approved CompOffClaim rows, not from a schedule.
  /// `allowance` is ignored; `carry` must be false.
  EARNED
}
```

### 4.2 The policy row

Appended to `SEED_LEAVE_POLICIES` (`prisma/seed.ts:290`), which is idempotent on name, so re-running the seed adds it to organizations that lack it and leaves the rest alone:

```ts
{
  name: "Comp-off",
  note: "A day off earned by working a weekend or a holiday. Claim the day you worked; the balance appears once an admin approves it.",
  allowance: 0,        // ignored for EARNED — see lib/leave.ts
  accrual: "EARNED",
  carry: false,
}
```

`unit` stays `DAYS`: a comp-off is a full day off, charged against working days like any other day of leave.

## 5. The arithmetic

`balanceAsOf` gains a fourth map beside the `usedByYear` it already takes:

```ts
export function balanceAsOf(
  rule: CreditRule,
  joinedOn: string | null,
  asOf: string,
  usedByYear: ReadonlyMap<number, number>,
  earnedByYear: ReadonlyMap<number, number> = NO_EARNED,
): { credited: number; used: number; balance: number }
```

`NO_EARNED` is a new empty-map constant in `lib/leave.ts`; the existing `NO_USAGE` lives in `lib/leave-service.ts` and is not importable here without inverting the dependency.

and `creditedInYear` answers `earnedByYear.get(year) ?? 0` for an `EARNED` rule, ignoring `allowance`, `prorated` and `accrualStart` entirely — a day earned in a member's first week is theirs regardless of when the scheme began.

Because rule 3 makes `carry` false for comp-off, the carry walk in `balanceAsOf` is never entered for an `EARNED` rule, and no year-boundary cap interacts with earned credit. `EARNED` under `carry: true` is undefined behaviour, and it is forbidden in the database rather than merely avoided — a CHECK constraint beside the two `LeavePolicy` already carries:

```sql
ALTER TABLE "orgapp"."LeavePolicy"
  ADD CONSTRAINT "LeavePolicy_earned_lapses"
  CHECK ("accrual" <> 'EARNED' OR "carry" = false);
```

Both callers keep calling one function: `summaryFor` (`lib/leave-service.ts:309`) builds an `earnedByPolicy` map beside its existing `usedByPolicy` and passes it in, so `/apply` and `/approvals` cannot drift (rule 9).

## 6. Modules

Following the layering the codebase already uses — pure logic, input parsing, service, action:

| File | Contents |
|------|----------|
| `lib/comp-off.ts` (new) | Pure: `CompOffClaimStatusName`, `claimableDay(workedOn, today, offDates)` returning a refusal reason or `null`, `earnedByYearFrom(claims)`. No Prisma import, so the Apply form can share the validation. |
| `lib/comp-off-input.ts` (new) | `compOffClaimInputFrom(body)` and `compOffDecisionFrom(body)`, mirroring `lib/leave-input.ts` so a form post and an API call cannot drift. |
| `lib/comp-off-service.ts` (new) | `createOwnCompOffClaim`, `listOwnCompOffClaims`, `withdrawOwnCompOffClaim`, `listCompOffClaims`, `decideCompOffClaim`, `countPendingCompOffClaims`, and `earnedByYearFor(userId)`. Every entry point authorizes in exactly one place. |
| `lib/comp-off-actions.ts` (new) | The three Server Actions, mirroring `lib/leave-actions.ts`. |
| `lib/leave-service.ts` | `summaryFor` gains the earned map. Only change. |
| `lib/leave.ts` | `EARNED` in `LeaveAccrualName`, `creditedInYear`, `balanceAsOf`. |

`earnedByYearFor` living in the comp-off service and being called by the leave service — rather than the leave service querying `CompOffClaim` directly — keeps the claim table's read rules in one file.

## 7. RBAC

Three predicates in `lib/rbac.ts`, each documented in the style of its neighbours:

```ts
/** Filing a claim follows `canApplyForLeave`: an admin is a person who works weekends too. */
export function canClaimCompOff(actor: Actor): boolean

/** Deciding follows `canReviewLeave`: claimant excluded, organization matched on the stored column. */
export function canReviewCompOff(actor, claimOrganizationId, claimantId): boolean

/** Reading the queue follows `canListLeaveRequests`: ADMIN or SUPERADMIN, scoped by `visibleOrgId`. */
export function canListCompOffClaims(actor: Actor): boolean
```

## 8. Screens

- **`/apply`** gains a second card below the leave form, *"Claim a comp-off"*: a date input, a reason, and the client-side half of `claimableDay` so an ordinary Tuesday is refused before the round trip. The Comp-off balance itself needs no work — it arrives through the existing policy list.
- **`/requests`** lists the member's own claims with their status alongside their leave requests, and offers Withdraw on a `PENDING` one.
- **`/approvals`** gains a **Comp-off claims** section above the leave queue, with its own filter chips and the same Approve/Reject affordances. `app/(leave)/approvals/page.tsx` is 268 lines and will not absorb a second queue cleanly, so the leave rows move to `components/approval-queue.tsx` and the claims render through a sibling `components/comp-off-queue.tsx`. The page keeps the data loading and hands each section its rows.
- **`app/(leave)/layout.tsx:40`** sums both pending counts into the one nav badge — an admin has one number to act on, not two.

## 9. Testing

- `tests/comp-off.test.ts` — pure: `claimableDay` across weekend, holiday, ordinary weekday and future date; `earnedByYearFrom` bucketing on `workedOn`, including a December claim landing in the year it was worked.
- `tests/leave.test.ts` — extended: `creditedInYear` and `balanceAsOf` for an `EARNED` rule; that `allowance` and `joinedOn` are ignored; that an over-spend goes negative rather than being refused, as it does for every other policy.
- `tests/comp-off.integration.test.ts` — claim → approve → the day appears in `/apply`'s Comp-off balance; claim → reject → it does not; re-filing a rejected day succeeds; re-filing a pending or approved day answers 409; a second admin decides and the claimant cannot; cross-organization reads answer 404.
- `tests/rbac.test.ts` — the three predicates against every role, including the claimant-is-the-admin case.
- `tests/comp-off-actions.test.ts` — the Server Actions' redirect and error paths, mirroring `tests/leave-actions.test.ts`.

## 10. Out of scope

- **Auto-earning from attendance** (design option C). Fits §3.1 later as a `source` column.
- **Half-day comp-off**, and any claim earning more than one day.
- **Per-credit expiry windows.** Rule 3 chose the year boundary; a 45-day window would need the `expiresOn` column this design deliberately omits.
- **An admin editor for leave policies.** G3 stands; Comp-off arrives by seed like every other type.
- **Comp-off in the scorecard.** The score pipeline is upstream and is not told about claims.
