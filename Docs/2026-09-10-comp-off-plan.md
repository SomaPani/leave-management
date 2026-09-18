# Comp-off Claims — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add **Comp-off** as a leave type entitled by days actually worked — a member claims a worked non-working day, an admin approves it, and the approved claim is the credit the member spends on `/apply`.

**Architecture:** One new table, `CompOffClaim`, shaped like `LeaveRequest`. An `APPROVED` claim *is* the credit; there is no separate ledger. A third `LeaveAccrual` value, `EARNED`, makes the existing `balanceAsOf` read credit from a per-member map of approved claims instead of from a schedule, so `/apply` and `/approvals` keep sharing one arithmetic function.

**Tech Stack:** Next.js 16 (App Router, Server Components, Server Actions), Prisma 7 + Postgres, Vitest, TypeScript, Tailwind 4.

**Spec:** [`docs/2026-09-10-comp-off-design.md`](./2026-09-10-comp-off-design.md)

## Global Constraints

- **One approved claim is one day.** No `days` column, no half-day claims. (Spec rule 2)
- **A claim belongs to the year its `workedOn` falls in**, via `chargeYear(workedOn)`. Comp-off has `carry = false`, so credits lapse on 31 December and there is no `expiresOn` column. (Spec rule 3)
- **Only a weekend or a holiday in the claimant's own region may be claimed**, and never a future day. (Spec rules 4, 5)
- **The duplicate check covers `PENDING` and `APPROVED` only** — a rejected day may be re-filed. (Spec rule 6)
- **`organizationId` is always copied from the stored `User` row**, never read from a request body. (Spec §4)
- **Self-scoped reads take no user id at all.** (Spec rule 8)
- **Comp-off credit enters through `balanceAsOf`, never around it.** (Spec rule 9)
- **`EARNED` ignores `allowance`, `prorated` and `accrualStart`.** (Spec §5)
- Tests: `npm test` (vitest, `fileParallelism: false`). Unit tests are `tests/<n>.test.ts`; database tests are `tests/<n>.integration.test.ts` and mock `@/lib/auth` via `vi.hoisted`.
- Migrations: `npm run migrate` (= `prisma migrate dev`). CHECK constraints are appended by hand to the generated `migration.sql`, as `20260904110559_leave_accrual` does.
- Lint and types must be clean: `npm run lint` and `npx tsc --noEmit`.

---

### Task 1: The `CompOffClaim` table and the `EARNED` accrual

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<generated>/migration.sql` (written by Prisma, then edited by hand)

**Interfaces:**
- Produces: `CompOffClaim` model and `CompOffClaimStatus` enum, importable as `import { CompOffClaimStatus } from "@/generated/prisma/enums"`; a third `LeaveAccrual` member, `EARNED`.

- [ ] **Step 1: Add `EARNED` to the `LeaveAccrual` enum**

In `prisma/schema.prisma`, inside `enum LeaveAccrual`, after `MONTHLY`:

```prisma
  /// Credit comes from approved CompOffClaim rows, not from a schedule.
  /// `allowance` is ignored; `carry` must be false, enforced by the
  /// LeavePolicy_earned_lapses CHECK.
  EARNED
```

- [ ] **Step 2: Add the status enum and the model**

Append after the `LeaveRequest` model. Copy the full block from spec §4 — it carries the comments explaining every nullable column. The essentials:

```prisma
enum CompOffClaimStatus {
  PENDING
  APPROVED
  REJECTED
  WITHDRAWN
}

model CompOffClaim {
  id String @id @default(cuid())

  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  userId String
  user   User   @relation("CompOffClaimSubject", fields: [userId], references: [id], onDelete: Cascade)

  workedOn DateTime @db.Date
  reason   String?

  status CompOffClaimStatus @default(PENDING)

  approverId String?
  approver   User?   @relation("CompOffClaimApprover", fields: [approverId], references: [id], onDelete: SetNull)

  decidedAt    DateTime?
  decidedById  String?
  decidedBy    User?   @relation("CompOffClaimDecider", fields: [decidedById], references: [id], onDelete: SetNull)
  decisionNote String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId, status])
  @@index([organizationId, status, createdAt])
}
```

- [ ] **Step 3: Add the three back-relations to `User` and `Organization`**

Prisma will not validate without them. In `model User`:

```prisma
  compOffClaims         CompOffClaim[] @relation("CompOffClaimSubject")
  compOffClaimsRouted   CompOffClaim[] @relation("CompOffClaimApprover")
  compOffClaimsDecided  CompOffClaim[] @relation("CompOffClaimDecider")
```

In `model Organization`:

```prisma
  compOffClaims CompOffClaim[]
```

- [ ] **Step 4: Generate the migration**

Run: `npm run migrate -- --name comp_off_claims`
Expected: a new `prisma/migrations/<timestamp>_comp_off_claims/migration.sql` and a regenerated client.

- [ ] **Step 5: Append the CHECK constraint by hand**

At the end of the generated `migration.sql`, matching the style of `20260904110559_leave_accrual/migration.sql:51`:

```sql
-- An EARNED policy's credit is per-member and lapses at the year boundary;
-- carrying it would run the cap walk in balanceAsOf over credit that has no
-- schedule behind it.
ALTER TABLE "orgapp"."LeavePolicy"
  ADD CONSTRAINT "LeavePolicy_earned_lapses"
  CHECK ("accrual" <> 'EARNED' OR "carry" = false);
```

- [ ] **Step 6: Re-apply and verify the constraint exists**

Run: `npm run migrate`
Then: `npx prisma db execute --stdin <<< "SELECT conname FROM pg_constraint WHERE conname = 'LeavePolicy_earned_lapses';"`
Expected: the constraint is listed.

- [ ] **Step 7: Confirm nothing else broke**

Run: `npx tsc --noEmit` and `npm test`
Expected: both clean. No behaviour has changed yet.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "Add the CompOffClaim table and the EARNED accrual"
```

---

### Task 2: `lib/comp-off.ts` — the pure rules

**Files:**
- Create: `lib/comp-off.ts`
- Test: `tests/comp-off.test.ts`

**Interfaces:**
- Consumes: `isWeekend` from `@/lib/date`, `chargeYear` from `@/lib/leave`.
- Produces:
  - `type CompOffClaimStatusName = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN"`
  - `claimableDay(workedOn: string, today: string, offDates: ReadonlySet<string>): string | null` — the refusal sentence, or `null` when the day may be claimed.
  - `earnedByYearFrom(claims: ReadonlyArray<{ workedOn: string }>): Map<number, number>`

No Prisma import in this file: the Apply form imports `claimableDay` into the browser.

- [ ] **Step 1: Write the failing tests**

Create `tests/comp-off.test.ts`. 2026-09-07 is a Monday, 2026-09-12 a Saturday, 2026-09-13 a Sunday — the same dates `tests/leave.test.ts` documents at its head.

```ts
import { describe, expect, it } from "vitest";

import { claimableDay, earnedByYearFrom } from "@/lib/comp-off";

const NO_HOLIDAYS: ReadonlySet<string> = new Set();
const TODAY = "2026-09-15";

describe("claimableDay", () => {
  it("accepts a Saturday that has already been worked", () => {
    expect(claimableDay("2026-09-12", TODAY, NO_HOLIDAYS)).toBeNull();
  });

  it("accepts a Sunday", () => {
    expect(claimableDay("2026-09-13", TODAY, NO_HOLIDAYS)).toBeNull();
  });

  it("accepts a weekday that is a holiday in the claimant's region", () => {
    expect(claimableDay("2026-09-07", TODAY, new Set(["2026-09-07"]))).toBeNull();
  });

  it("refuses an ordinary working day", () => {
    expect(claimableDay("2026-09-07", TODAY, NO_HOLIDAYS)).toBe(
      "2026-09-07 was a working day. Comp-off is earned on a weekend or a holiday.",
    );
  });

  it("refuses a day that has not happened yet", () => {
    expect(claimableDay("2026-09-19", TODAY, NO_HOLIDAYS)).toBe(
      "You cannot claim a comp-off for a day you have not worked yet.",
    );
  });

  it("refuses a future day before it checks whether it is a working day", () => {
    // A future Saturday is refused for being future, not accepted for being
    // a Saturday — the order of the two checks matters.
    expect(claimableDay("2026-09-19", TODAY, NO_HOLIDAYS)).toContain("not worked yet");
  });

  it("accepts today itself", () => {
    expect(claimableDay("2026-09-13", "2026-09-13", NO_HOLIDAYS)).toBeNull();
  });
});

describe("earnedByYearFrom", () => {
  it("buckets by the year the day was worked", () => {
    const earned = earnedByYearFrom([
      { workedOn: "2026-09-13" },
      { workedOn: "2026-09-12" },
      { workedOn: "2025-12-27" },
    ]);
    expect(earned.get(2026)).toBe(2);
    expect(earned.get(2025)).toBe(1);
  });

  it("keeps a December claim in the year it was worked", () => {
    const earned = earnedByYearFrom([{ workedOn: "2026-12-26" }]);
    expect(earned.get(2026)).toBe(1);
    expect(earned.get(2027)).toBeUndefined();
  });

  it("is empty for no claims", () => {
    expect(earnedByYearFrom([]).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/comp-off.test.ts`
Expected: FAIL — cannot resolve `@/lib/comp-off`.

- [ ] **Step 3: Write the implementation**

Create `lib/comp-off.ts`:

```ts
import { isWeekend } from "@/lib/date";
import { chargeYear } from "@/lib/leave";

/**
 * The comp-off rules that depend on nothing but dates.
 *
 * No Prisma import, for the same reason lib/leave.ts has none: the Apply
 * form imports `claimableDay` into the browser, so the member is refused an
 * ordinary Tuesday before the round trip, by the same function the service
 * refuses it with afterwards.
 */

/**
 * Mirrors the `CompOffClaimStatus` enum in the schema, declared here as a
 * string union rather than imported from the generated client — the same
 * client-safety reason `LeaveUnitName` gives in lib/leave.ts.
 */
export type CompOffClaimStatusName = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";

/**
 * Whether `workedOn` may be claimed, as a sentence to show the claimant or
 * `null` when it may.
 *
 * A sentence rather than a boolean because both callers need to say why: the
 * form beside the input, the service in a 400.
 *
 * The future check runs first. A future Saturday is refused for being in the
 * future — the more accurate of the two refusals, and the one that does not
 * imply the day would be fine once it is a weekend.
 *
 * `offDates` is the claimant's own region's holidays, built by `offDates` in
 * lib/leave.ts from `listHolidays`.
 */
export function claimableDay(
  workedOn: string,
  today: string,
  offDates: ReadonlySet<string>,
): string | null {
  if (workedOn > today) {
    return "You cannot claim a comp-off for a day you have not worked yet.";
  }

  if (!isWeekend(workedOn) && !offDates.has(workedOn)) {
    return `${workedOn} was a working day. Comp-off is earned on a weekend or a holiday.`;
  }

  return null;
}

/**
 * Approved claims, counted into the calendar year each day was worked in.
 *
 * The shape `balanceAsOf` wants for an EARNED rule. Bucketing on `workedOn`
 * rather than on the decision date is what makes rule 3 work: a Sunday worked
 * in December is a December credit however long the approval took, and it
 * lapses with the rest of that year's.
 */
export function earnedByYearFrom(
  claims: ReadonlyArray<{ workedOn: string }>,
): Map<number, number> {
  const byYear = new Map<number, number>();
  for (const claim of claims) {
    const year = chargeYear(claim.workedOn);
    byYear.set(year, (byYear.get(year) ?? 0) + 1);
  }
  return byYear;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/comp-off.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/comp-off.ts tests/comp-off.test.ts
git commit -m "Add the pure comp-off claim rules"
```

---

### Task 3: `EARNED` in the balance arithmetic

**Files:**
- Modify: `lib/leave.ts:123` (the `LeaveAccrualName` union), `lib/leave.ts:190` (`creditedInYear`), `lib/leave.ts:241` (`balanceAsOf`)
- Test: `tests/leave.test.ts`

**Interfaces:**
- Produces:
  - `LeaveAccrualName` widened to `"UPFRONT" | "MONTHLY" | "EARNED"`.
  - `balanceAsOf(rule, joinedOn, asOf, usedByYear, earnedByYear?)` — a fifth parameter defaulting to an empty map, so every existing call site keeps compiling unchanged.
  - `creditedInYear(rule, joinedOn, year, asOf, earnedByYear?)` — likewise.

- [ ] **Step 1: Write the failing tests**

Append to `tests/leave.test.ts`:

```ts
describe("an EARNED rule", () => {
  const earnedRule: CreditRule = {
    allowance: 0,
    accrual: "EARNED",
    prorated: false,
    carry: false,
    cap: null,
    effectiveFrom: "2026-01-01",
  };

  it("credits the approved claims of that year and nothing else", () => {
    const earned = new Map([[2026, 3]]);
    expect(creditedInYear(earnedRule, null, 2026, "2026-09-15", earned)).toBe(3);
  });

  it("credits nothing in a year with no claims", () => {
    expect(creditedInYear(earnedRule, null, 2025, "2026-09-15", new Map([[2026, 3]]))).toBe(0);
  });

  it("ignores allowance entirely", () => {
    const generous: CreditRule = { ...earnedRule, allowance: 99 };
    expect(creditedInYear(generous, null, 2026, "2026-09-15", new Map())).toBe(0);
  });

  it("ignores joinedOn — a day earned in the first week is still earned", () => {
    const earned = new Map([[2026, 1]]);
    expect(creditedInYear(earnedRule, "2026-09-14", 2026, "2026-09-15", earned)).toBe(1);
  });

  it("ignores prorating", () => {
    const prorated: CreditRule = { ...earnedRule, allowance: 12, prorated: true };
    expect(creditedInYear(prorated, "2026-09-01", 2026, "2026-12-31", new Map([[2026, 2]]))).toBe(2);
  });

  it("balances earned against used", () => {
    expect(
      balanceAsOf(earnedRule, null, "2026-09-15", new Map([[2026, 1]]), new Map([[2026, 3]])),
    ).toEqual({ credited: 3, used: 1, balance: 2 });
  });

  it("goes negative rather than refusing an over-spend, like every other policy", () => {
    expect(
      balanceAsOf(earnedRule, null, "2026-09-15", new Map([[2026, 4]]), new Map([[2026, 1]])),
    ).toEqual({ credited: 1, used: 4, balance: -3 });
  });

  it("does not carry last year's unspent credit into this one", () => {
    const earned = new Map([
      [2025, 5],
      [2026, 1],
    ]);
    expect(balanceAsOf(earnedRule, null, "2026-09-15", new Map(), earned)).toEqual({
      credited: 1,
      used: 0,
      balance: 1,
    });
  });

  it("credits nothing when no earned map is passed at all", () => {
    expect(balanceAsOf(earnedRule, null, "2026-09-15", new Map())).toEqual({
      credited: 0,
      used: 0,
      balance: 0,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/leave.test.ts -t "an EARNED rule"`
Expected: FAIL — `creditedInYear` takes four arguments, and `"EARNED"` is not assignable to `LeaveAccrualName`.

- [ ] **Step 3: Widen the union and add the empty-map constant**

In `lib/leave.ts`, replace the `LeaveAccrualName` declaration at line 123:

```ts
export type LeaveAccrualName = "UPFRONT" | "MONTHLY" | "EARNED";
```

and add beside it:

```ts
/**
 * The default earned map. `NO_USAGE` in lib/leave-service.ts is the same
 * thing for the other direction, and is not importable here without
 * inverting the dependency between the two files.
 */
const NO_EARNED: ReadonlyMap<number, number> = new Map();
```

- [ ] **Step 4: Teach `creditedInYear` the EARNED case**

Add the fifth parameter and return before any schedule arithmetic runs — `accrualStart`, `prorated` and `allowance` must not be consulted at all:

```ts
export function creditedInYear(
  rule: CreditRule,
  joinedOn: string | null,
  year: number,
  asOf: string,
  earnedByYear: ReadonlyMap<number, number> = NO_EARNED,
): number {
  // Earned credit has no schedule: it exists because a day was worked, so
  // neither the scheme start nor the member's join month bears on it. A day
  // earned in a member's first week is theirs.
  if (rule.accrual === "EARNED") return earnedByYear.get(year) ?? 0;

  const start = accrualStart(rule, joinedOn);
  // ... the rest of the existing body, unchanged
```

- [ ] **Step 5: Thread the map through `balanceAsOf`**

```ts
export function balanceAsOf(
  rule: CreditRule,
  joinedOn: string | null,
  asOf: string,
  usedByYear: ReadonlyMap<number, number>,
  earnedByYear: ReadonlyMap<number, number> = NO_EARNED,
): { credited: number; used: number; balance: number } {
  const year = chargeYear(asOf);
  const used = usedByYear.get(year) ?? 0;
  const thisYear = creditedInYear(rule, joinedOn, year, asOf, earnedByYear);

  if (!rule.carry) {
    return { credited: thisYear, used, balance: thisYear - used };
  }
  // ... the carry walk, unchanged except that its creditedInYear call also
  // passes earnedByYear. An EARNED rule cannot reach it — the
  // LeavePolicy_earned_lapses CHECK forbids carry — but passing it keeps the
  // two calls honest rather than relying on that from a distance.
```

Also extend the `CreditRule` doc comment above `allowance` to note that an `EARNED` rule ignores it.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/leave.test.ts`
Expected: PASS — the nine new tests plus every existing one, unchanged.

- [ ] **Step 7: Confirm no call site broke**

Run: `npx tsc --noEmit`
Expected: clean. Both new parameters are optional, so `lib/leave-service.ts:362` still compiles untouched.

- [ ] **Step 8: Commit**

```bash
git add lib/leave.ts tests/leave.test.ts
git commit -m "Credit an EARNED policy from approved claims"
```

---

### Task 4: The three RBAC predicates

**Files:**
- Modify: `lib/rbac.ts` (after `canListLeaveRequests`, around line 235)
- Test: `tests/rbac.test.ts`

**Interfaces:**
- Produces:
  - `canClaimCompOff(actor: Actor): boolean`
  - `canReviewCompOff(actor: Actor, claimOrganizationId: string, claimantId: string): boolean`
  - `canListCompOffClaims(actor: Actor): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `tests/rbac.test.ts`, following the actor helpers already in that file:

```ts
describe("canClaimCompOff", () => {
  it("admits a member of an organization", () => {
    expect(canClaimCompOff({ id: "u1", role: Role.MEMBER, organizationId: "o1" })).toBe(true);
  });

  it("admits an admin — an admin is a person who works weekends too", () => {
    expect(canClaimCompOff({ id: "a1", role: Role.ADMIN, organizationId: "o1" })).toBe(true);
  });

  it("refuses a SUPERADMIN, who belongs to no organization", () => {
    expect(canClaimCompOff({ id: "s1", role: Role.SUPERADMIN, organizationId: null })).toBe(false);
  });

  it("refuses a member with no organization", () => {
    expect(canClaimCompOff({ id: "u1", role: Role.MEMBER, organizationId: null })).toBe(false);
  });
});

describe("canReviewCompOff", () => {
  const admin = { id: "a1", role: Role.ADMIN, organizationId: "o1" };

  it("admits an admin of the claim's own organization", () => {
    expect(canReviewCompOff(admin, "o1", "u1")).toBe(true);
  });

  it("refuses an admin of a different organization", () => {
    expect(canReviewCompOff(admin, "o2", "u1")).toBe(false);
  });

  it("refuses the claimant, even when they are that admin", () => {
    expect(canReviewCompOff(admin, "o1", "a1")).toBe(false);
  });

  it("refuses a MEMBER", () => {
    expect(canReviewCompOff({ id: "u1", role: Role.MEMBER, organizationId: "o1" }, "o1", "u2")).toBe(false);
  });

  it("refuses a SUPERADMIN, who may read a queue but not decide in it", () => {
    expect(canReviewCompOff({ id: "s1", role: Role.SUPERADMIN, organizationId: null }, "o1", "u1")).toBe(false);
  });
});

describe("canListCompOffClaims", () => {
  it("admits an ADMIN", () => {
    expect(canListCompOffClaims({ id: "a1", role: Role.ADMIN, organizationId: "o1" })).toBe(true);
  });

  it("admits a SUPERADMIN", () => {
    expect(canListCompOffClaims({ id: "s1", role: Role.SUPERADMIN, organizationId: null })).toBe(true);
  });

  it("refuses a MEMBER, whose own claims come from a self-scoped read", () => {
    expect(canListCompOffClaims({ id: "u1", role: Role.MEMBER, organizationId: "o1" })).toBe(false);
  });
});
```

Add the three names to the existing `@/lib/rbac` import at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/rbac.test.ts`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Write the predicates**

In `lib/rbac.ts`, after `canListLeaveRequests`:

```ts
/**
 * Filing a comp-off claim follows `canApplyForLeave` exactly: an ADMIN is
 * admitted because an admin is a person, and a person who works a Sunday has
 * earned the same day back. A SUPERADMIN belongs to no organization and works
 * no roster, so there is nothing for them to claim.
 */
export function canClaimCompOff(actor: Actor): boolean {
  return (
    (actor.role === Role.ADMIN || actor.role === Role.MEMBER) &&
    actor.organizationId !== null
  );
}

/**
 * Deciding a claim follows `canReviewLeave`, including its one accepted
 * failure: the claimant is excluded even when they are the admin, so in a
 * one-admin organization that admin's own claim cannot be decided by anybody.
 * Approving your own entitlement is the worse of the two.
 *
 * Pass the *stored* `CompOffClaim.organizationId` and `userId`, never
 * anything from a request body.
 */
export function canReviewCompOff(
  actor: Actor,
  claimOrganizationId: string,
  claimantId: string,
): boolean {
  return (
    actor.role === Role.ADMIN &&
    actor.organizationId === claimOrganizationId &&
    actor.id !== claimantId
  );
}

/**
 * Reading the queue follows `canListLeaveRequests`: a SuperAdmin may read an
 * organization's claims without being able to decide one. Scope the query
 * with `visibleOrgId`.
 *
 * A MEMBER is excluded. Their own claims come from `listOwnCompOffClaims`,
 * which takes no id and therefore has no id to tamper with.
 */
export function canListCompOffClaims(actor: Actor): boolean {
  return actor.role === Role.SUPERADMIN || actor.role === Role.ADMIN;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/rbac.test.ts`
Expected: PASS, 12 new tests.

- [ ] **Step 5: Commit**

```bash
git add lib/rbac.ts tests/rbac.test.ts
git commit -m "Add the comp-off RBAC predicates"
```

---

### Task 5: `lib/comp-off-input.ts` — parsing

**Files:**
- Create: `lib/comp-off-input.ts`
- Test: `tests/comp-off-input.test.ts`

**Interfaces:**
- Consumes: `optionalString` from `@/lib/api`, `parseDateParam` from `@/lib/attendance`, `HttpError` from `@/lib/rbac`, `CompOffClaimStatusName` from `@/lib/comp-off`.
- Produces:
  - `type CompOffClaimInput = { workedOn: string; reason: string | null }`
  - `compOffClaimInputFrom(body: Record<string, unknown>): CompOffClaimInput`
  - `type CompOffDecision = "APPROVED" | "REJECTED"`
  - `type CompOffDecisionInput = { decision: CompOffDecision; note: string | null }`
  - `compOffDecisionFrom(body: Record<string, unknown>): CompOffDecisionInput`

- [ ] **Step 1: Write the failing tests**

Create `tests/comp-off-input.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { compOffClaimInputFrom, compOffDecisionFrom } from "@/lib/comp-off-input";

describe("compOffClaimInputFrom", () => {
  it("reads a date and a reason", () => {
    expect(compOffClaimInputFrom({ workedOn: "2026-09-13", reason: "Release cutover" })).toEqual({
      workedOn: "2026-09-13",
      reason: "Release cutover",
    });
  });

  it("treats a missing reason as null", () => {
    expect(compOffClaimInputFrom({ workedOn: "2026-09-13" }).reason).toBeNull();
  });

  it("treats an empty reason as null", () => {
    expect(compOffClaimInputFrom({ workedOn: "2026-09-13", reason: "" }).reason).toBeNull();
  });

  it("refuses a missing date", () => {
    expect(() => compOffClaimInputFrom({})).toThrow(/workedOn/);
  });

  it("refuses a malformed date", () => {
    expect(() => compOffClaimInputFrom({ workedOn: "13-09-2026" })).toThrow(/workedOn/);
  });

  it("refuses a reason longer than 500 characters", () => {
    expect(() =>
      compOffClaimInputFrom({ workedOn: "2026-09-13", reason: "x".repeat(501) }),
    ).toThrow(/500 characters or fewer/);
  });
});

describe("compOffDecisionFrom", () => {
  it("reads the form's button value", () => {
    expect(compOffDecisionFrom({ decision: "approve" })).toEqual({
      decision: "APPROVED",
      note: null,
    });
  });

  it("reads an API caller's status", () => {
    expect(compOffDecisionFrom({ decision: "REJECTED", note: "Not a rostered day" })).toEqual({
      decision: "REJECTED",
      note: "Not a rostered day",
    });
  });

  it("refuses an unknown decision", () => {
    expect(() => compOffDecisionFrom({ decision: "maybe" })).toThrow(/decision/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/comp-off-input.test.ts`
Expected: FAIL — cannot resolve `@/lib/comp-off-input`.

- [ ] **Step 3: Write the parser**

Create `lib/comp-off-input.ts`, mirroring `lib/leave-input.ts` including its `MAX_REASON`:

```ts
import { optionalString } from "@/lib/api";
import { parseDateParam } from "@/lib/attendance";
import { HttpError } from "@/lib/rbac";

/**
 * Parsing comp-off claim bodies, shared by the Server Actions and any future
 * route handler — the rule lib/leave-input.ts and lib/holiday-input.ts
 * already follow, so a form post and an API call cannot drift apart on field
 * names, defaults or coercion.
 */

/** Long enough for a paragraph, short enough that the column is not a dumping ground. */
const MAX_REASON = 500;

export type CompOffClaimInput = { workedOn: string; reason: string | null };

export function compOffClaimInputFrom(
  body: Record<string, unknown>,
): CompOffClaimInput {
  const workedOn = parseDateParam(body["workedOn"], "workedOn");

  const reason = optionalString(body, "reason");
  if (reason !== null && reason.length > MAX_REASON) {
    throw new HttpError(400, `"reason" must be ${MAX_REASON} characters or fewer.`);
  }

  // Whether the day may be claimed at all is `claimableDay` in lib/comp-off.ts,
  // called by the service: it needs the claimant's region's holidays, which
  // a parser has no way to fetch.
  return { workedOn, reason };
}

export type CompOffDecision = "APPROVED" | "REJECTED";
export type CompOffDecisionInput = { decision: CompOffDecision; note: string | null };

/** The form's button values, and the statuses they mean. */
const DECISIONS: Record<string, CompOffDecision> = {
  approve: "APPROVED",
  reject: "REJECTED",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
};

export function compOffDecisionFrom(
  body: Record<string, unknown>,
): CompOffDecisionInput {
  const raw = body["decision"];
  const decision = typeof raw === "string" ? DECISIONS[raw] : undefined;
  if (!decision) {
    throw new HttpError(400, '"decision" must be approve or reject.');
  }

  const note = optionalString(body, "note");
  if (note !== null && note.length > MAX_REASON) {
    throw new HttpError(400, `"note" must be ${MAX_REASON} characters or fewer.`);
  }

  return { decision, note };
}
```

Before writing `DECISIONS`, open `lib/leave-input.ts:57` and match whatever that file does about accepting both forms — if it accepts only the button values, do the same here and drop the two uppercase keys along with the "reads an API caller's status" test.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/comp-off-input.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add lib/comp-off-input.ts tests/comp-off-input.test.ts
git commit -m "Parse comp-off claim and decision bodies"
```

---

### Task 6: `lib/comp-off-service.ts` — the member's own claims

**Files:**
- Create: `lib/comp-off-service.ts`
- Test: `tests/comp-off.integration.test.ts`

**Interfaces:**
- Consumes: `canClaimCompOff` (Task 4), `claimableDay` (Task 2), `compOffClaimInputFrom`'s `CompOffClaimInput` (Task 5).
- Produces:
  - `type CompOffClaimRecord = { id: string; workedOn: string; reason: string | null; status: CompOffClaimStatusName; decidedAt: string | null; decisionNote: string | null; approver: { id: string; name: string } | null }`
  - `createOwnCompOffClaim(actor: Actor, input: CompOffClaimInput): Promise<CompOffClaimRecord>`
  - `listOwnCompOffClaims(actor: Actor): Promise<CompOffClaimRecord[]>`
  - `withdrawOwnCompOffClaim(actor: Actor, id: string): Promise<CompOffClaimRecord>`
  - `earnedByYearFor(userId: string): Promise<Map<number, number>>`

- [ ] **Step 1: Write the failing integration tests**

Create `tests/comp-off.integration.test.ts`. Copy the `vi.hoisted` session stub, the `RUN` prefix and the `beforeAll`/`afterAll` fixture shape from `tests/leave.integration.test.ts:1-45` verbatim — an organization, an admin, a second admin, a member, a region, and a holiday on a weekday in that region. Then:

```ts
describe("createOwnCompOffClaim", () => {
  it("accepts a worked Sunday", async () => {
    actorRef.current = memberActor();
    const claim = await service.createOwnCompOffClaim(memberActor(), {
      workedOn: SUNDAY,
      reason: "Release cutover",
    });
    expect(claim.status).toBe("PENDING");
    expect(claim.workedOn).toBe(SUNDAY);
  });

  it("accepts a regional holiday that falls on a weekday", async () => {
    const claim = await service.createOwnCompOffClaim(memberActor(), {
      workedOn: REGION_HOLIDAY,
      reason: null,
    });
    expect(claim.status).toBe("PENDING");
  });

  it("refuses an ordinary working day with 400", async () => {
    await expect(
      service.createOwnCompOffClaim(memberActor(), { workedOn: WORKING_DAY, reason: null }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a future day with 400", async () => {
    await expect(
      service.createOwnCompOffClaim(memberActor(), { workedOn: FUTURE_SUNDAY, reason: null }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a second claim for a day already pending, with 409", async () => {
    await service.createOwnCompOffClaim(memberActor(), { workedOn: OTHER_SUNDAY, reason: null });
    await expect(
      service.createOwnCompOffClaim(memberActor(), { workedOn: OTHER_SUNDAY, reason: null }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("copies the organization from the stored user, not from anything sent", async () => {
    const claim = await service.createOwnCompOffClaim(memberActor(), {
      workedOn: THIRD_SUNDAY,
      reason: null,
    });
    const row = await prisma.compOffClaim.findUnique({
      where: { id: claim.id },
      select: { organizationId: true, userId: true },
    });
    expect(row).toEqual({ organizationId: orgId, userId: memberId });
  });

  it("refuses a SUPERADMIN with 403", async () => {
    await expect(
      service.createOwnCompOffClaim(superadminActor(), { workedOn: SUNDAY, reason: null }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe("listOwnCompOffClaims", () => {
  it("returns only the caller's own claims", async () => {
    const mine = await service.listOwnCompOffClaims(memberActor());
    expect(mine.every((c) => c.id !== undefined)).toBe(true);
    const others = await prisma.compOffClaim.count({
      where: { id: { in: mine.map((c) => c.id) }, userId: { not: memberId } },
    });
    expect(others).toBe(0);
  });
});

describe("withdrawOwnCompOffClaim", () => {
  it("withdraws a pending claim", async () => {
    const claim = await service.createOwnCompOffClaim(memberActor(), {
      workedOn: FOURTH_SUNDAY,
      reason: null,
    });
    const withdrawn = await service.withdrawOwnCompOffClaim(memberActor(), claim.id);
    expect(withdrawn.status).toBe("WITHDRAWN");
  });

  it("frees the day for a fresh claim", async () => {
    await expect(
      service.createOwnCompOffClaim(memberActor(), { workedOn: FOURTH_SUNDAY, reason: null }),
    ).resolves.toMatchObject({ status: "PENDING" });
  });

  it("answers 404 for somebody else's claim", async () => {
    const theirs = await service.createOwnCompOffClaim(otherMemberActor(), {
      workedOn: SUNDAY,
      reason: null,
    });
    await expect(
      service.withdrawOwnCompOffClaim(memberActor(), theirs.id),
    ).rejects.toMatchObject({ status: 404 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/comp-off.integration.test.ts`
Expected: FAIL — cannot resolve `@/lib/comp-off-service`.

- [ ] **Step 3: Write the service**

Create `lib/comp-off-service.ts`. Model `createOwnCompOffClaim` on `createOwnLeaveRequest` (`lib/leave-service.ts:420`) step for step: authorize, read the stored user for `organizationId` and `regionId`, fetch that region's holidays, validate with `claimableDay`, resolve the approver, then run the duplicate check and the insert in one transaction.

```ts
/**
 * Everything that reads or writes CompOffClaim.
 *
 * The same contract as lib/leave-service.ts: every entry point authorizes in
 * exactly one place, and the self-scoped reads take no user id, so a member
 * has no id to change into a colleague's.
 */

/** The statuses that hold a day: a withdrawn or rejected claim frees it. */
const HELD: CompOffClaimStatus[] = [CompOffClaimStatus.PENDING, CompOffClaimStatus.APPROVED];

export async function createOwnCompOffClaim(
  actor: Actor,
  input: CompOffClaimInput,
): Promise<CompOffClaimRecord> {
  if (!canClaimCompOff(actor)) {
    throw new HttpError(403, "Only a member of an organization can claim a comp-off.");
  }

  // The organization is read from the stored user, never taken from the
  // request — the rule lib/attendance-service.ts follows for the same reason.
  const claimant = await prisma.user.findUnique({
    where: { id: actor.id },
    select: {
      organizationId: true,
      regionId: true,
      manager: { select: { id: true, name: true } },
    },
  });
  if (!claimant?.organizationId) {
    throw new HttpError(401, "Your account no longer exists.");
  }

  // The claimant's own region's holidays, the same call and the same
  // region-defaulting `createOwnLeaveRequest` uses.
  const holidays = await listHolidays(actor, {
    from: input.workedOn,
    to: input.workedOn,
    regionId: claimant.regionId ?? undefined,
  });

  const refusal = claimableDay(input.workedOn, todayIso(), offDates(holidays));
  if (refusal) throw new HttpError(400, refusal);

  const approver = await approverFor(claimant.manager, claimant.organizationId);

  // The duplicate check and the insert share a transaction, so two submits
  // racing each other cannot both pass it. This narrows the window rather
  // than closing it — the same trade `createOwnLeaveRequest` documents, and
  // the reason there is no unique index: a rejected day may be re-filed.
  const row = await prisma.$transaction(async (tx) => {
    const held = await tx.compOffClaim.findFirst({
      where: { userId: actor.id, workedOn: toDbDate(input.workedOn), status: { in: HELD } },
      select: { id: true },
    });
    if (held) {
      throw new HttpError(409, "You have already claimed that day.");
    }

    return tx.compOffClaim.create({
      data: {
        organizationId: claimant.organizationId,
        userId: actor.id,
        workedOn: toDbDate(input.workedOn),
        reason: input.reason,
        approverId: approver?.id ?? null,
      },
      select: CLAIM_FIELDS,
    });
  });

  return toRecord(row);
}
```

`approverFor` is currently private to `lib/leave-service.ts` — export it there and import it here rather than writing a second copy, so a claim and a leave request route to the same person.

`listOwnCompOffClaims` filters on `userId: actor.id` with no id parameter. `withdrawOwnCompOffClaim` mirrors `withdrawOwnLeaveRequest` (`lib/leave-service.ts:523`): `PENDING` only, scoped by `userId` *inside* the lookup so somebody else's id reports nothing, lookup and update in one transaction.

`earnedByYearFor` is the read the leave service will call in Task 8:

```ts
/**
 * One member's approved claims, counted into the year each was worked in.
 *
 * Lives here rather than in lib/leave-service.ts so the claim table's read
 * rules stay in one file. It takes a plain id and makes no authorization
 * decision: its caller, `summaryFor`, has already made one — the same
 * contract `summaryFor` itself has.
 */
export async function earnedByYearFor(userId: string): Promise<Map<number, number>> {
  const rows = await prisma.compOffClaim.findMany({
    where: { userId, status: CompOffClaimStatus.APPROVED },
    select: { workedOn: true },
  });
  return earnedByYearFrom(rows.map((row) => ({ workedOn: fromDbDate(row.workedOn) })));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/comp-off.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/comp-off-service.ts lib/leave-service.ts tests/comp-off.integration.test.ts
git commit -m "File, list and withdraw a member's own comp-off claims"
```

---

### Task 7: `lib/comp-off-service.ts` — the approver's side

**Files:**
- Modify: `lib/comp-off-service.ts`
- Test: `tests/comp-off.integration.test.ts`

**Interfaces:**
- Consumes: `canListCompOffClaims`, `canReviewCompOff` (Task 4), `visibleOrgId` from `@/lib/rbac`, `CompOffDecisionInput` (Task 5).
- Produces:
  - `type ReviewCompOffRecord = CompOffClaimRecord & { user: { id: string; name: string; email: string } }`
  - `listCompOffClaims(actor: Actor, options?: { status?: CompOffClaimStatus }): Promise<ReviewCompOffRecord[]>`
  - `decideCompOffClaim(actor: Actor, id: string, input: CompOffDecisionInput): Promise<ReviewCompOffRecord>`
  - `countPendingCompOffClaims(actor: Actor): Promise<number>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/comp-off.integration.test.ts`:

```ts
describe("decideCompOffClaim", () => {
  it("approves a pending claim and records who decided it", async () => {
    const claim = await service.createOwnCompOffClaim(memberActor(), {
      workedOn: DECIDE_SUNDAY,
      reason: null,
    });
    const decided = await service.decideCompOffClaim(adminActor(), claim.id, {
      decision: "APPROVED",
      note: null,
    });
    expect(decided.status).toBe("APPROVED");
    expect(decided.decidedAt).not.toBeNull();

    const row = await prisma.compOffClaim.findUnique({
      where: { id: claim.id },
      select: { decidedById: true },
    });
    expect(row?.decidedById).toBe(adminId);
  });

  it("refuses a rejection with no reason, with 400", async () => {
    const claim = await service.createOwnCompOffClaim(memberActor(), {
      workedOn: REJECT_SUNDAY,
      reason: null,
    });
    await expect(
      service.decideCompOffClaim(adminActor(), claim.id, { decision: "REJECTED", note: null }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses to decide the same claim twice, with 409", async () => {
    const claim = await service.createOwnCompOffClaim(memberActor(), {
      workedOn: TWICE_SUNDAY,
      reason: null,
    });
    await service.decideCompOffClaim(adminActor(), claim.id, { decision: "APPROVED", note: null });
    await expect(
      service.decideCompOffClaim(adminActor(), claim.id, { decision: "APPROVED", note: null }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses the claimant deciding their own claim, with 403", async () => {
    const own = await service.createOwnCompOffClaim(adminActor(), {
      workedOn: ADMIN_SUNDAY,
      reason: null,
    });
    await expect(
      service.decideCompOffClaim(adminActor(), own.id, { decision: "APPROVED", note: null }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("lets a second admin decide it", async () => {
    const own = await prisma.compOffClaim.findFirst({
      where: { userId: adminId, status: CompOffClaimStatus.PENDING },
      select: { id: true },
    });
    const decided = await service.decideCompOffClaim(secondAdminActor(), own!.id, {
      decision: "APPROVED",
      note: null,
    });
    expect(decided.status).toBe("APPROVED");
  });

  it("answers 404 for a claim in another organization", async () => {
    const theirs = await service.createOwnCompOffClaim(otherOrgMemberActor(), {
      workedOn: SUNDAY,
      reason: null,
    });
    await expect(
      service.decideCompOffClaim(adminActor(), theirs.id, { decision: "APPROVED", note: null }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("listCompOffClaims", () => {
  it("returns only the caller's organization", async () => {
    const rows = await service.listCompOffClaims(adminActor());
    const foreign = await prisma.compOffClaim.count({
      where: { id: { in: rows.map((r) => r.id) }, organizationId: { not: orgId } },
    });
    expect(foreign).toBe(0);
  });

  it("filters by status", async () => {
    const rows = await service.listCompOffClaims(adminActor(), {
      status: CompOffClaimStatus.APPROVED,
    });
    expect(rows.every((r) => r.status === "APPROVED")).toBe(true);
  });

  it("refuses a MEMBER with 403", async () => {
    await expect(service.listCompOffClaims(memberActor())).rejects.toMatchObject({ status: 403 });
  });
});

describe("countPendingCompOffClaims", () => {
  it("counts this organization's pending claims", async () => {
    const pending = await service.countPendingCompOffClaims(adminActor());
    const expected = await prisma.compOffClaim.count({
      where: { organizationId: orgId, status: CompOffClaimStatus.PENDING },
    });
    expect(pending).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/comp-off.integration.test.ts`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Write the review side**

Append to `lib/comp-off-service.ts`, modelling `decideCompOffClaim` on `decideLeaveRequest` (`lib/leave-review-service.ts:197`) step for step — the note check before the row is loaded, the 404-not-403 for another organization, authorization on the stored columns, the status check, all inside one transaction:

```ts
export async function decideCompOffClaim(
  actor: Actor,
  id: string,
  input: CompOffDecisionInput,
): Promise<ReviewCompOffRecord> {
  // Refusing somebody's earned day without saying why is worth forcing a
  // sentence for. Checked before the row is loaded: it is a fact about the
  // input, not about the claim.
  if (input.decision === "REJECTED" && !input.note) {
    throw new HttpError(400, "A rejection needs a reason.");
  }

  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.compOffClaim.findUnique({
      where: { id },
      select: { organizationId: true, userId: true, status: true },
    });
    // Outside the caller's organization is indistinguishable from nonexistent.
    if (!existing) throw new HttpError(404, "That claim does not exist.");
    if (visibleOrgId(actor) !== null && existing.organizationId !== actor.organizationId) {
      throw new HttpError(404, "That claim does not exist.");
    }
    if (!canReviewCompOff(actor, existing.organizationId, existing.userId)) {
      throw new HttpError(403, "Your role does not permit this action.");
    }
    if (existing.status !== CompOffClaimStatus.PENDING) {
      throw new HttpError(409, "That claim has already been decided.");
    }

    return tx.compOffClaim.update({
      where: { id },
      data: {
        status: input.decision,
        decidedAt: new Date(),
        decidedById: actor.id,
        decisionNote: input.note,
      },
      select: REVIEW_CLAIM_FIELDS,
    });
  });

  return toReviewRecord(row);
}
```

`listCompOffClaims` and `countPendingCompOffClaims` take their scope from a private `scopeFor(actor)` returning `visibleOrgId(actor) === null ? {} : { organizationId: actor.organizationId }`, exactly as `lib/leave-review-service.ts` does, and `listCompOffClaims` throws 403 unless `canListCompOffClaims(actor)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/comp-off.integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/comp-off-service.ts tests/comp-off.integration.test.ts
git commit -m "Decide and list comp-off claims as an approver"
```

---

### Task 8: Earned credit reaches the balance

**Files:**
- Modify: `lib/leave-service.ts:309` (`summaryFor`)
- Test: `tests/comp-off.integration.test.ts`

**Interfaces:**
- Consumes: `earnedByYearFor` (Task 6), `balanceAsOf`'s fifth parameter (Task 3).
- Produces: no new export. `summaryFor`'s `balances` entry for an `EARNED` policy now carries real `credited`, `used` and `balance`.

This is the task that makes the whole feature visible. Until it lands, an approved claim exists and shows nothing on `/apply`.

- [ ] **Step 1: Write the failing test**

Append to `tests/comp-off.integration.test.ts`. Two things this block needs that earlier tasks did not:

- **The Comp-off policy**, which Task 9 seeds — created directly here so this task stands alone.
- **A member of its own**, `balanceMember`, added to the `beforeAll` fixture beside the existing one. The member used in Tasks 6 and 7 already carries claims from those tests, and a balance assertion has to count from a clean start.

Also note the two module aliases in this file: `compOff` is `@/lib/comp-off-service` (called `service` in the Task 6 and 7 blocks — rename that import to `compOff` when you add this block, and update those blocks with it), and `leave` is `@/lib/leave-service`.

```ts
describe("comp-off credit on the balance", () => {
  let compOffPolicyId: string;

  beforeAll(async () => {
    const policy = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: `${RUN} Comp-off`,
        allowance: 0,
        unit: "DAYS",
        accrual: "EARNED",
        carry: false,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        position: 9,
      },
      select: { id: true },
    });
    compOffPolicyId = policy.id;
  });

  it("shows nothing before a claim is approved", async () => {
    const summary = await leave.summaryFor(orgId, balanceMemberId, "2026-09-15");
    const compOff = summary.balances.find((b) => b.id === compOffPolicyId);
    expect(compOff).toMatchObject({ credited: 0, used: 0, balance: 0 });
  });

  it("credits one day per approved claim", async () => {
    const claim = await compOff.createOwnCompOffClaim(balanceMemberActor(), {
      workedOn: "2026-09-13",
      reason: null,
    });
    await compOff.decideCompOffClaim(adminActor(), claim.id, {
      decision: "APPROVED",
      note: null,
    });

    const summary = await leave.summaryFor(orgId, balanceMemberId, "2026-09-15");
    expect(summary.balances.find((b) => b.id === compOffPolicyId)).toMatchObject({
      credited: 1,
      balance: 1,
    });
  });

  it("does not credit a rejected claim", async () => {
    const claim = await compOff.createOwnCompOffClaim(balanceMemberActor(), {
      workedOn: "2026-09-12",
      reason: null,
    });
    await compOff.decideCompOffClaim(adminActor(), claim.id, {
      decision: "REJECTED",
      note: "Not rostered",
    });

    const summary = await leave.summaryFor(orgId, balanceMemberId, "2026-09-15");
    expect(summary.balances.find((b) => b.id === compOffPolicyId)).toMatchObject({
      credited: 1,
    });
  });

  it("spends the credit when a comp-off day is taken", async () => {
    await prisma.leaveRequest.create({
      data: {
        organizationId: orgId,
        userId: balanceMemberId,
        policyId: compOffPolicyId,
        startDate: new Date("2026-09-16T00:00:00.000Z"),
        endDate: new Date("2026-09-16T00:00:00.000Z"),
        cost: 1,
        status: "APPROVED",
      },
    });

    const summary = await leave.summaryFor(orgId, balanceMemberId, "2026-09-17");
    expect(summary.balances.find((b) => b.id === compOffPolicyId)).toMatchObject({
      credited: 1,
      used: 1,
      balance: 0,
    });
  });

  it("does not carry a credit earned last year into this one", async () => {
    const claim = await prisma.compOffClaim.create({
      data: {
        organizationId: orgId,
        userId: balanceMemberId,
        workedOn: new Date("2025-12-28T00:00:00.000Z"),
        status: "APPROVED",
      },
      select: { id: true },
    });
    expect(claim.id).toBeTruthy();

    const summary = await leave.summaryFor(orgId, balanceMemberId, "2026-09-17");
    expect(summary.balances.find((b) => b.id === compOffPolicyId)).toMatchObject({
      credited: 1,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/comp-off.integration.test.ts -t "comp-off credit"`
Expected: FAIL — every balance reads 0, because `summaryFor` does not know about claims.

- [ ] **Step 3: Fetch the earned map in `summaryFor`**

In `lib/leave-service.ts`, add `earnedByYearFor(userId)` to the existing `Promise.all` — it is one more query on the same member, so it costs a round trip and no serialization:

```ts
  const [policies, spent, approver, earned] = await Promise.all([
    policiesIn(organizationId, includeRetired),
    prisma.leaveRequest.findMany({ /* unchanged */ }),
    approverFor(applicant.manager, organizationId),
    // Comp-off credit. Fetched unconditionally rather than only when an
    // EARNED policy is present: the branch would save one small query on a
    // member's own screen and is one more thing to get wrong.
    earnedByYearFor(userId),
  ]);
```

- [ ] **Step 4: Pass it to `balanceAsOf`**

```ts
    balances: policies.map((policy) => ({
      ...policy,
      ...balanceAsOf(
        policy,
        joinedOn,
        asOf,
        usedByPolicy.get(policy.id) ?? NO_USAGE,
        // Every EARNED policy in an organization draws on the same claims.
        // There is one such policy today; if a second is ever added they
        // would share credit, which is the moment to key claims by policy.
        policy.accrual === "EARNED" ? earned : NO_USAGE,
      ),
    })),
```

Watch for an import cycle: `lib/comp-off-service.ts` imports `approverFor` from `lib/leave-service.ts`, which now imports `earnedByYearFor` back. If Vitest or `tsc` reports one, move `approverFor` into `lib/leave.ts` or a small `lib/approver.ts` — do not break the cycle by inlining a second copy of it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/comp-off.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm no other balance changed**

Run: `npm test`
Expected: the whole suite passes, `tests/leave.integration.test.ts` included — a policy that is not `EARNED` is passed `NO_USAGE` and behaves exactly as before.

- [ ] **Step 7: Commit**

```bash
git add lib/leave-service.ts tests/comp-off.integration.test.ts
git commit -m "Credit approved comp-off claims into the leave balance"
```

---

### Task 9: Seed the Comp-off policy

**Files:**
- Modify: `prisma/seed.ts:290` (`SEED_LEAVE_POLICIES`)

**Interfaces:**
- Consumes: the `EARNED` accrual (Task 1).
- Produces: a `Comp-off` `LeavePolicy` row in every seeded organization.

- [ ] **Step 1: Widen the seed entry type**

`SEED_LEAVE_POLICIES`'s inline type currently declares `accrual?: "MONTHLY"`. Widen it:

```ts
  accrual?: "MONTHLY" | "EARNED";
```

- [ ] **Step 2: Append the policy**

As the fourth entry, so `position` puts it last in the Apply select:

```ts
  {
    name: "Comp-off",
    note: "A day off earned by working a weekend or a holiday. Claim the day you worked; the balance appears once an admin approves it.",
    // Ignored for EARNED: credit comes from approved CompOffClaim rows.
    allowance: 0,
    accrual: "EARNED",
  },
```

`carry` defaults to false, which the `LeavePolicy_earned_lapses` CHECK requires.

- [ ] **Step 3: Run the seed**

Run: `npm run seed`
Expected: it reports the new policy created for each organization, and re-running reports none — the loop skips a name it already has.

- [ ] **Step 4: Verify it landed with the right shape**

Run: `npx prisma db execute --stdin <<< "SELECT name, allowance, accrual, carry FROM orgapp.\"LeavePolicy\" WHERE name = 'Comp-off';"`
Expected: `Comp-off | 0 | EARNED | f`

- [ ] **Step 5: Commit**

```bash
git add prisma/seed.ts
git commit -m "Seed the Comp-off leave policy"
```

---

### Task 10: `lib/comp-off-actions.ts` — the Server Actions

**Files:**
- Create: `lib/comp-off-actions.ts`
- Test: `tests/comp-off-actions.test.ts`

**Interfaces:**
- Consumes: the service functions (Tasks 6, 7), the parsers (Task 5), `backWithError`/`field`/`formBody` from `@/lib/form`, `currentActor` from `@/lib/auth`, `requireActor` from `@/lib/rbac`.
- Produces:
  - `submitCompOffClaimAction(form: FormData): Promise<void>`
  - `withdrawCompOffClaimAction(form: FormData): Promise<void>`
  - `reviewCompOffClaimAction(form: FormData): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `tests/comp-off-actions.test.ts`, copying the mock shape of `tests/leave-actions.test.ts` verbatim — it stubs `next/navigation`, `next/cache`, `@/lib/auth` and the service module, then asserts on the redirect target and on what the service was called with.

```ts
describe("submitCompOffClaimAction", () => {
  it("passes the parsed body to the service and redirects to /requests", async () => {
    createOwn.mockResolvedValue({ id: "c1" });
    const form = new FormData();
    form.set("workedOn", "2026-09-13");
    form.set("reason", "Release cutover");

    await expect(actions.submitCompOffClaimAction(form)).rejects.toThrow("NEXT_REDIRECT");

    expect(createOwn).toHaveBeenCalledWith(expect.anything(), {
      workedOn: "2026-09-13",
      reason: "Release cutover",
    });
    expect(redirect).toHaveBeenCalledWith("/requests?c=c1");
  });

  it("sends a refusal back to /apply with the message", async () => {
    createOwn.mockRejectedValue(new HttpError(400, "2026-09-07 was a working day."));
    const form = new FormData();
    form.set("workedOn", "2026-09-07");

    await expect(actions.submitCompOffClaimAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith(
      expect.stringContaining("/apply?error=2026-09-07%20was%20a%20working%20day."),
    );
  });
});

describe("reviewCompOffClaimAction", () => {
  it("lands back on the same filter and the same claim", async () => {
    decide.mockResolvedValue({ id: "c1" });
    const form = new FormData();
    form.set("claimId", "c1");
    form.set("filter", "pending");
    form.set("decision", "approve");

    await expect(actions.reviewCompOffClaimAction(form)).rejects.toThrow("NEXT_REDIRECT");
    expect(redirect).toHaveBeenCalledWith("/approvals?filter=pending&c=c1");
  });
});
```

Check `tests/leave-actions.test.ts` for exactly how `backWithError` surfaces — match its assertions rather than the sketch above if they differ.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/comp-off-actions.test.ts`
Expected: FAIL — cannot resolve `@/lib/comp-off-actions`.

- [ ] **Step 3: Write the actions**

Create `lib/comp-off-actions.ts`, mirroring `lib/leave-actions.ts` including its re-authentication comment:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { currentActor } from "@/lib/auth";
import {
  createOwnCompOffClaim,
  decideCompOffClaim,
  withdrawOwnCompOffClaim,
} from "@/lib/comp-off-service";
import { compOffClaimInputFrom, compOffDecisionFrom } from "@/lib/comp-off-input";
import { backWithError, field, formBody } from "@/lib/form";
import { requireActor } from "@/lib/rbac";

/**
 * The Server Action behind the claim card on /apply.
 *
 * Same contract as lib/leave-actions.ts: re-authenticate rather than trusting
 * proxy.ts, because a Server Action is a POST to the page's own path and a
 * matcher change could remove that gate without any code here changing.
 * Authorization itself lives in lib/comp-off-service.ts.
 *
 * The claim lands on /requests beside the member's leave, under `?c=` rather
 * than the `?r=` a leave request uses, so the two highlights cannot collide.
 */
export async function submitCompOffClaimAction(form: FormData): Promise<void> {
  let id = "";

  try {
    const actor = requireActor(await currentActor());
    const created = await createOwnCompOffClaim(actor, compOffClaimInputFrom(formBody(form)));
    id = created.id;
  } catch (error) {
    backWithError("/apply", error);
  }

  revalidatePath("/requests");
  redirect(`/requests?c=${id}`);
}
```

`withdrawCompOffClaimAction` reads `claimId` and returns to `/requests`; `reviewCompOffClaimAction` mirrors `reviewLeaveRequestAction` exactly, reading `claimId` and `filter` and landing back on `/approvals?filter=<filter>&c=<claimId>`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/comp-off-actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/comp-off-actions.ts tests/comp-off-actions.test.ts
git commit -m "Add the comp-off Server Actions"
```

---

### Task 11: The claim card on `/apply`

**Files:**
- Create: `components/comp-off-form.tsx`
- Modify: `app/(member)/apply/page.tsx`

**Interfaces:**
- Consumes: `submitCompOffClaimAction` (Task 10), `claimableDay` (Task 2), `offDates` from `@/lib/leave`.
- Produces: `<CompOffForm action={...} offDates={string[]} today={string} error={string | null} />`

- [ ] **Step 1: Write the component**

Create `components/comp-off-form.tsx`, a client component modelled on `components/apply-form.tsx`. It holds the date in state, calls `claimableDay(workedOn, today, new Set(offDates))` on every change, shows the refusal sentence inline and disables the submit button while one is showing:

```tsx
"use client";

import { useState } from "react";

import { claimableDay } from "@/lib/comp-off";
import { Card, inputClass, primaryButtonClass, textareaClass } from "@/components/ui";

/**
 * Claim a comp-off.
 *
 * The refusal comes from `claimableDay` — the same function
 * lib/comp-off-service.ts refuses with — so the sentence the member reads
 * beside the input is the sentence the server would have sent, rather than a
 * second copy of the rule that can drift from it.
 *
 * The button is disabled while a refusal is showing, but the server checks
 * again regardless: a disabled button is a courtesy, not a control.
 */
export function CompOffForm({
  action,
  offDates,
  today,
  error,
}: {
  action: (form: FormData) => Promise<void>;
  offDates: string[];
  today: string;
  error: string | null;
}) {
  const [workedOn, setWorkedOn] = useState("");
  const refusal = workedOn ? claimableDay(workedOn, today, new Set(offDates)) : null;

  return (
    <Card>
      <h2 className="text-sm font-medium">Claim a comp-off</h2>
      <p className="mt-1 text-xs text-muted">
        A day off earned by working a weekend or a holiday.
      </p>

      <form action={action} className="mt-4 grid gap-3">
        <label className="grid gap-1 text-xs text-muted">
          Day you worked
          <input
            type="date"
            name="workedOn"
            value={workedOn}
            max={today}
            required
            onChange={(event) => setWorkedOn(event.target.value)}
            className={inputClass}
          />
        </label>

        <label className="grid gap-1 text-xs text-muted">
          What you worked on
          <textarea name="reason" rows={2} maxLength={500} className={textareaClass} />
        </label>

        {refusal ? <p className="text-xs text-danger">{refusal}</p> : null}
        {error ? <p className="text-xs text-danger">{error}</p> : null}

        <button type="submit" disabled={refusal !== null} className={primaryButtonClass}>
          Claim
        </button>
      </form>
    </Card>
  );
}
```

Check `components/apply-form.tsx` for the exact class names and the muted/danger text colours it uses, and match them — the sketch above names the tokens but that file is the authority on them.

The date input takes `max={today}` so the future case is hard to reach in the first place.

- [ ] **Step 2: Render it on `/apply`**

In `app/(member)/apply/page.tsx`, below the existing `ApplyForm`. The page already fetches `holidays` for this year and next and already computes `offDates(holidays)` for the leave preview — pass the same set down rather than fetching again, and pass `todayIso()`, which the page already has as `today`.

- [ ] **Step 3: Check it renders and refuses correctly**

Run: `npm run dev`, sign in as a member, open `/apply`.
Expected: a "Claim a comp-off" card below the leave form. Picking an ordinary weekday shows the working-day sentence and disables the button; picking a Saturday clears it. Submitting a Saturday lands on `/requests`.

- [ ] **Step 4: Confirm types and lint**

Run: `npx tsc --noEmit` and `npm run lint`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add components/comp-off-form.tsx "app/(member)/apply/page.tsx"
git commit -m "Let a member claim a comp-off from /apply"
```

---

### Task 12: Claims on `/requests`

**Files:**
- Modify: `app/(member)/requests/page.tsx`
- Modify: `components/ui.tsx:87` (`StatusBadge`)

**Interfaces:**
- Consumes: `listOwnCompOffClaims` (Task 6), `withdrawCompOffClaimAction` (Task 10).
- Produces: `StatusBadge` accepting `LeaveRequestStatus | CompOffClaimStatus`.

- [ ] **Step 1: Widen `StatusBadge`**

The two enums carry the same four string values, so `STATUS_STYLE` already has every key needed:

```tsx
export function StatusBadge({
  status,
}: {
  // Both claim and request statuses. The enums are deliberately separate —
  // see the CompOffClaimStatus comment in the schema — but they share these
  // four values and therefore share a badge.
  status: LeaveRequestStatus | CompOffClaimStatus;
}) {
  return <Badge {...STATUS_STYLE[status]} />;
}
```

- [ ] **Step 2: Add the claims section**

In `app/(member)/requests/page.tsx`, add `listOwnCompOffClaims(actor)` to the page's existing fetch and render a "Comp-off claims" section below the leave requests: the worked date, the reason, the status badge, the decision note when there is one, and a Withdraw button on a `PENDING` row posting to `withdrawCompOffClaimAction`.

Highlight the row matching `searchParams.c`, the way the page already highlights `searchParams.r`.

- [ ] **Step 3: Check it renders**

Run: `npm run dev`, sign in as the member who claimed in Task 11, open `/requests`.
Expected: the claim appears as PENDING with a Withdraw button. Withdrawing moves it to WITHDRAWN and frees the day for a new claim on `/apply`.

- [ ] **Step 4: Confirm types, lint and tests**

Run: `npx tsc --noEmit`, `npm run lint`, `npm test`
Expected: all clean.

- [ ] **Step 5: Commit**

```bash
git add "app/(member)/requests/page.tsx" components/ui.tsx
git commit -m "Show a member their comp-off claims on /requests"
```

---

### Task 13: The Comp-off section on `/approvals`

**Files:**
- Create: `components/approval-queue.tsx`, `components/comp-off-queue.tsx`
- Modify: `app/(leave)/approvals/page.tsx`

**Interfaces:**
- Consumes: `listCompOffClaims` (Task 7), `reviewCompOffClaimAction` (Task 10).
- Produces: `<ApprovalQueue rows={...} filter={...} selected={...} />` and `<CompOffQueue rows={...} filter={...} selected={...} />`.

`app/(leave)/approvals/page.tsx` is 268 lines and will not absorb a second queue cleanly. Move the leave rows out first, unchanged, so the diff that adds comp-off is small and reviewable.

- [ ] **Step 1: Extract the existing queue with no behaviour change**

Move the leave-request rendering out of `app/(leave)/approvals/page.tsx` into `components/approval-queue.tsx`, taking the rows, the active filter and the selected id as props. The page keeps `requirePageRole`, the filter parsing, `listLeaveRequests`, `findLeaveRequest` and `leaveSummaryFor`.

- [ ] **Step 2: Verify nothing changed**

Run: `npm test` and `npm run dev`, then open `/approvals`.
Expected: the suite passes and the screen looks and behaves exactly as before. Commit this separately so the extraction is reviewable on its own:

```bash
git add "app/(leave)/approvals/page.tsx" components/approval-queue.tsx
git commit -m "Extract the leave approvals queue into a component"
```

- [ ] **Step 3: Write the comp-off queue**

Create `components/comp-off-queue.tsx`: one row per claim with the claimant's avatar and name, the worked date, the reason, the status badge, and Approve/Reject posting to `reviewCompOffClaimAction` with a `note` textarea — the same affordances and the same `dangerButtonClass`/`primaryButtonClass` the leave queue uses.

- [ ] **Step 4: Render it above the leave queue**

In `app/(leave)/approvals/page.tsx`, add `listCompOffClaims(actor, { status: option.status })` to the page's fetch and render `<CompOffQueue />` above `<ApprovalQueue />` under a "Comp-off claims" heading. The existing `FILTERS` array serves both sections: `CompOffClaimStatus` shares the four values, so `option.status` maps across unchanged — assert that with a one-line comment rather than a second array.

Show `EmptyPanel` when there are no claims, so the section does not read as broken on an organization that has none.

- [ ] **Step 5: Check the whole flow end to end**

Run: `npm run dev`. As the member, claim a Saturday. As the admin, open `/approvals`.
Expected: the claim is in the Comp-off section; Approve moves it to APPROVED and lands back on the same filter with the row highlighted; back as the member, `/apply` shows a Comp-off balance of 1, and applying for a comp-off day spends it.

- [ ] **Step 6: Confirm types, lint and tests**

Run: `npx tsc --noEmit`, `npm run lint`, `npm test`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add "app/(leave)/approvals/page.tsx" components/comp-off-queue.tsx
git commit -m "Decide comp-off claims from /approvals"
```

---

### Task 14: One pending badge

**Files:**
- Modify: `app/(leave)/layout.tsx:40`

**Interfaces:**
- Consumes: `countPendingCompOffClaims` (Task 7).

- [ ] **Step 1: Sum both counts**

```tsx
  // One number for one queue of work. An admin does not care which of the two
  // kinds is waiting, only that something is.
  const [pendingLeave, pendingCompOff] = await Promise.all([
    countPendingLeaveRequests(actor),
    countPendingCompOffClaims(actor),
  ]);
  const pending = pendingLeave + pendingCompOff;
```

- [ ] **Step 2: Check the badge**

Run: `npm run dev`, as an admin with one pending leave request and one pending claim.
Expected: the nav badge reads 2. Deciding either drops it to 1.

- [ ] **Step 3: Commit**

```bash
git add "app/(leave)/layout.tsx"
git commit -m "Count pending comp-off claims in the approvals badge"
```

---

### Task 15: Verification pass

**Files:** none — this task changes nothing and exists to prove the rest.

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: every test passes. Record the count.

- [ ] **Step 2: Types and lint**

Run: `npx tsc --noEmit` and `npm run lint`
Expected: both silent.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: a clean production build. This catches a client component importing something server-only — the risk `lib/comp-off.ts` exists to avoid, so it is worth proving rather than assuming.

- [ ] **Step 4: Walk the spec's rules against the running app**

With `npm run dev`, confirm each in turn:
- Rule 4: an ordinary Tuesday is refused on `/apply`, and refused again by the service if the form is bypassed.
- Rule 5: a future Saturday is refused.
- Rule 6: a rejected day can be re-claimed; a pending or approved one answers 409.
- Rule 7: an admin cannot decide their own claim; a second admin can.
- Rule 3: a claim with `workedOn` in 2025 does not credit 2026 — check with a row inserted directly.
- Rule 9: the Comp-off balance an admin reads on `/approvals` matches the one the member reads on `/apply`.

- [ ] **Step 5: Commit anything the walk corrected, then open the PR**

```bash
git push -u origin comp-off-claims
gh pr create --title "Comp-off claims" --body "Implements docs/2026-09-10-comp-off-design.md"
```
