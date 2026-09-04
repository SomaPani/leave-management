# Leave Types and Accrual — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-09-04
**Status:** Proposed plan (pre-implementation)
**Goal:** Replace the four seeded leave types with Casual Leave (CL), Earned Leave (EL) and Short leave, and put the balance on a credit schedule, so EL reads the one day credited on 1 September rather than the twelve it will reach by December.

**Architecture:** Four new columns on `LeavePolicy` describe *how* an entitlement arrives — `accrual`, `prorated`, `cap`, `effectiveFrom` — and all the arithmetic that reads them lives in `lib/leave.ts`, which is pure and client-safe. `listOwnLeaveSummary` gains the member's `joinedOn` and a usage query widened from one year to a per-year bucket, then hands both to that module. The screen and the form are untouched: they render a `balance` and have never computed an entitlement.

**Tech Stack:** Next.js 16.3.2 (App Router, Route Handlers), React 19.2, Prisma 7 with `@prisma/adapter-pg`, PostgreSQL, Auth.js v5, Vitest 4, Tailwind 4.

**Spec:** [`2026-09-04-leave-accrual-design.md`](./2026-09-04-leave-accrual-design.md). Builds on
[`2026-09-04-apply-for-leave-real-data-plan.md`](./2026-09-04-apply-for-leave-real-data-plan.md), which is implemented and shipped.

## Global Constraints

- Models live in the **`orgapp`** Postgres schema, set by the `schema` parameter on the connection URL (`lib/prisma-url.ts`). No `@@schema` attribute, no `multiSchema` preview feature.
- Every migration statement is **schema-qualified by hand** (`"orgapp"."LeavePolicy"`). `prisma migrate diff` emits bare names, which would land in `public` on a fresh database.
- Dates are **`YYYY-MM-DD` strings** above the database and `DATE` columns beneath it, converted with `toDbDate` / `fromDbDate` in `lib/attendance.ts`.
- "Today" comes from `todayIso()` (`lib/attendance.ts`), which resolves in `Asia/Kolkata`. Never `new Date()` against a date string. **`TODAY` in `lib/date.ts` is the demo's frozen `"2026-08-17"` and must not be used by anything in this plan.**
- **`lib/leave.ts` is imported by a client component.** It may import `lib/date.ts` and nothing else — no `lib/rbac.ts`, no `lib/attendance.ts`, no `@/generated/prisma/*` — or the Prisma client is pulled into the browser bundle. This is why every function below takes `asOf` as a parameter instead of calling `todayIso()`.
- The scheme start is **2026-09-01**. It is stored per policy in `effectiveFrom`, never hard-coded in application logic — the only literal occurrences are the migration backfill and the seed.
- The EL cap is **20 days**, stored in `LeavePolicy.cap`, never hard-coded.
- Authorization is decided in `lib/rbac.ts` and enforced in the service modules. Nothing in this plan changes an authorization rule.
- Tests: `npm test` (Vitest, `fileParallelism: false`). Integration tests hit the Dockerized Postgres (`docker compose up -d`, service **`postgres`**, user `leave`, database `leave_management`), namespace rows with a per-run prefix, and clean up in `afterAll`.
- Commit after every task.

---

## 1. Where things stand

`/apply` runs on real data as of the previous plan. `LeavePolicy` stores a flat `allowance`, and `lib/leave-service.ts` computes `allowance − used` for a single calendar year. Four seeded policies exist: Casual 6, Sick 6, Paid / annual 18, Short leave 4 uses.

Three things are wrong with that for the rules the product owner confirmed on 2026-09-04:

| # | Defect | Fixed in |
|---|--------|----------|
| B1 | The balance is flat. EL is credited one day per month, so on 4 September a member has **1** day, not 12. The current model overstates EL for eleven months of the year. | Tasks 1, 2, 3 |
| B2 | There is no scheme start. The leave scheme goes live 1 September 2026, making 2026 a four-month year for everyone, and nothing in the schema can say so. | Tasks 1, 2, 3 |
| B3 | `carry` has existed on `LeavePolicy` since the table was created and nothing reads it. EL must carry forward, capped at 20; CL and Short leave must lapse. | Tasks 1, 2, 3 |

The policy set itself is also wrong — `Sick` and `Paid / annual` are withdrawn, and `Paid / annual` was already 18 days annotated *"Accrues monthly"*, which is what EL now expresses properly (Task 1, Task 4).

## 2. The rules this implements

Copied from §2 of the spec, which is the authority.

1. **Casual Leave (CL)** — 6 days, credited whole on 1 January, **pro-rated** in a partial first year, rounded **down**. Lapses 31 December.
2. **Earned Leave (EL)** — 12 days a year at 1 day on the first of each month. **Carries forward, capped at 20.**
3. **Short leave** — 4 uses, credited whole, **never pro-rated**. Lapses 31 December.
4. **Scheme start 1 September 2026**, organization-wide. 2026 is a four-month year for every member regardless of tenure.
5. **Accrual start** = the later of the policy's `effectiveFrom` and the first of the member's join month. A null `joinedOn` — every ADMIN today — accrues from `effectiveFrom`.
6. **The cap applies at the year boundary**, not continuously. See §2.5 of the spec for why the continuous form is wrong; Task 2 Step 1 has the regression test that pins it.
7. **Nothing about requests changes.** Over-balance is still filed rather than refused, overlaps still 409, cost is still frozen at submit.

## 3. What soma Pani should see

The single best check that this works. She joined 2026-07-02, so her accrual start is `max(2026-09-01, 2026-07-01)` = **2026-09-01**.

| Policy | On 2026-09-04 | On 2026-12-31 |
|---|---|---|
| Casual Leave (CL) | 2 credited | 2 credited |
| Earned Leave (EL) | **1** credited | 4 credited |
| Short leave | 4 credited | 4 credited |

She already has a PENDING request against CL costing 2 days, so her CL **balance** reads **0** while her CL **credited** reads 2.

## 4. Database changes

### 4.1 New enum

```prisma
/// How a policy's entitlement arrives.
enum LeaveAccrual {
  /// The whole year's share at once, on 1 January or the accrual start.
  UPFRONT
  /// One-twelfth on the first of each month.
  MONTHLY
}
```

### 4.2 Changed table — `LeavePolicy`

```prisma
  accrual  LeaveAccrual @default(UPFRONT)

  /// Whether a partial first year is scaled down. UPFRONT only; a MONTHLY
  /// policy pro-rates inherently by crediting fewer months.
  prorated Boolean @default(false)

  /// Ceiling on a balance carried across a year boundary. Null means no
  /// ceiling. Only meaningful when `carry` is true — a policy that lapses
  /// has nothing to cap.
  cap Int?

  /// The day this entitlement starts existing — the scheme start. Per policy
  /// rather than per organization, so a policy introduced later simply starts
  /// later, with no separate concept to keep in step.
  effectiveFrom DateTime @db.Date
```

Plus two constraints Prisma cannot express:

```sql
ALTER TABLE "orgapp"."LeavePolicy" ADD CONSTRAINT "LeavePolicy_monthly_divisible"
  CHECK ("accrual" <> 'MONTHLY' OR "allowance" % 12 = 0);

ALTER TABLE "orgapp"."LeavePolicy" ADD CONSTRAINT "LeavePolicy_cap_nonnegative"
  CHECK ("cap" IS NULL OR "cap" >= 0);
```

The first is load-bearing, not decorative: a MONTHLY policy credits `allowance / 12` per month, and an allowance of 13 would credit 1.083 days into an `Int` column. Refusing the configuration is better than rounding it silently.

`effectiveFrom` is `NOT NULL` with no default on a populated table, so it needs the three-step dance: add nullable, backfill, set `NOT NULL`.

### 4.3 Deliberately NOT stored

- **A per-member accrual start.** Derived from `joinedOn` and `effectiveFrom`; a stored copy is a third thing to drift.
- **Credit rows.** Approach B in §3 of the spec, rejected: no job runner exists, and a monthly job that silently failed would leave every balance quietly wrong.
- **An opening balance per year.** Computed by walking the year chain, which is a handful of iterations over one member's history.

### 4.4 Data migration

| Policy | Action | Why |
|---|---|---|
| `Casual` | Rename to `Casual Leave (CL)`, set `prorated = true` | Same entitlement at the same 6 days, so its existing requests stay valid and attached |
| `Sick` | `active = false` | Withdrawn. `LeaveRequest.policyId` is `RESTRICT`, so retiring is the mechanism, not deleting |
| `Paid / annual` | `active = false` | Superseded by EL. **Not** converted: 18 days → 12 and a different crediting rule would misdescribe every request already attached |
| `Earned Leave (EL)` | Created by the seed | The seed is idempotent by `(organizationId, name)` |

Deployment is `prisma migrate deploy` then `prisma db seed`, the sequence already in use.

## 5. File structure

| File | Responsibility |
|------|----------------|
| `prisma/schema.prisma` | *Modify.* The enum and four columns |
| `prisma/migrations/<ts>_leave_accrual/migration.sql` | *Create.* Columns, backfill, data fix-ups, two CHECKs |
| `lib/leave.ts` | *Modify.* **All the new arithmetic.** `accrualStart`, `creditedInYear`, `balanceAsOf`. Stays pure and client-safe |
| `lib/leave-service.ts` | *Modify.* `listLeavePolicies` selects the new columns; `listOwnLeaveSummary` takes `asOf`, reads `joinedOn`, buckets usage by year |
| `prisma/seed.ts` | *Modify.* Three policies with their accrual configuration |
| `app/(member)/apply/page.tsx` | *Modify.* One line — drops an argument |
| `tests/leave.test.ts` | *Modify.* The credit schedule, exhaustively |
| `tests/leave.integration.test.ts` | *Modify.* Fixtures gain `effectiveFrom`; balance tests move onto the schedule |
| `tests/leave-actions.test.ts` | *Modify.* One fixture gains `effectiveFrom` |

`components/apply-form.tsx` is **not** in this list. It renders `balance` and `unit` from the summary and never computes an entitlement — the payoff from having kept the arithmetic in one module.

---

# Tasks

### Task 1: The accrual columns

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_leave_accrual/migration.sql`
- Modify: `tests/leave.integration.test.ts` (fixtures)
- Modify: `tests/leave-actions.test.ts` (one fixture)
- Modify: `prisma/seed.ts` (one line, so `tsc` stays green until Task 4)

**Interfaces:**
- Consumes: the `LeavePolicy` model from the previous plan.
- Produces: `LeaveAccrual` in `@/generated/prisma/enums`; `accrual`, `prorated`, `cap`, `effectiveFrom` on `prisma.leavePolicy`.

The service is not touched in this task, so it still computes `allowance − used` and every existing behaviour test must still pass. Only the fixtures change, because `effectiveFrom` is required.

- [ ] **Step 1: Add the enum and the columns**

Add to `prisma/schema.prisma`, next to the existing `LeaveUnit` enum:

```prisma
/// How a policy's entitlement arrives.
enum LeaveAccrual {
  /// The whole year's share at once, on 1 January or the accrual start.
  UPFRONT
  /// One-twelfth on the first of each month.
  MONTHLY
}
```

And to the `LeavePolicy` model, immediately after the `unit` field:

```prisma
  accrual LeaveAccrual @default(UPFRONT)

  /// Whether a partial first year is scaled down. UPFRONT only; a MONTHLY
  /// policy pro-rates inherently by crediting fewer months.
  prorated Boolean @default(false)

  /// Ceiling on a balance carried across a year boundary. Null means no
  /// ceiling. Only meaningful when `carry` is true — a policy that lapses
  /// has nothing to cap.
  cap Int?

  /// The day this entitlement starts existing — the scheme start. Per policy
  /// rather than per organization, so a policy introduced later simply starts
  /// later, with no separate concept to keep in step.
  effectiveFrom DateTime @db.Date
```

- [ ] **Step 2: Generate the migration without applying it**

```bash
npx prisma migrate dev --create-only --name leave_accrual
```

Keep the generated timestamp directory name. Prisma will emit something for the required column without a default; Step 3 replaces the file wholesale.

- [ ] **Step 3: Rewrite the migration**

Replace the generated `migration.sql` entirely:

```sql
-- Accrual: how a leave entitlement arrives, rather than merely how much of it
-- there is.
--
-- Every object is schema-qualified rather than relying on the `schema=orgapp`
-- parameter to set the search path — same rule as every migration before it.

-- CreateEnum
CREATE TYPE "orgapp"."LeaveAccrual" AS ENUM ('UPFRONT', 'MONTHLY');

-- AlterTable
-- Three columns carry defaults, so existing rows are already correct as
-- UPFRONT, un-prorated and uncapped. `effectiveFrom` cannot: it is NOT NULL
-- with no sensible default, so it arrives nullable and is tightened below.
ALTER TABLE "orgapp"."LeavePolicy"
  ADD COLUMN "accrual" "orgapp"."LeaveAccrual" NOT NULL DEFAULT 'UPFRONT',
  ADD COLUMN "prorated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cap" INTEGER,
  ADD COLUMN "effectiveFrom" DATE;

-- The leave scheme goes live on this date. Every policy that already exists
-- predates the concept, so all of them start here; policies created after this
-- migration set their own.
UPDATE "orgapp"."LeavePolicy"
  SET "effectiveFrom" = DATE '2026-09-01'
  WHERE "effectiveFrom" IS NULL;

ALTER TABLE "orgapp"."LeavePolicy" ALTER COLUMN "effectiveFrom" SET NOT NULL;

-- Casual becomes CL, renamed in place: the same entitlement at the same six
-- days, so every request already filed against it stays valid and attached.
-- It gains pro-rating, which is what makes 2026 a two-day year.
UPDATE "orgapp"."LeavePolicy"
  SET "name" = 'Casual Leave (CL)',
      "note" = 'Six days a year, credited in full on 1 January.',
      "prorated" = true
  WHERE "name" = 'Casual';

-- Withdrawn. Retired rather than deleted, because LeaveRequest.policyId is
-- ON DELETE RESTRICT and any request ever filed against these has to stay
-- readable. "Paid / annual" is deliberately NOT converted into EL: its
-- entitlement changes from 18 days to 12 and its crediting rule changes
-- entirely, so reusing the row would misdescribe its own history.
UPDATE "orgapp"."LeavePolicy"
  SET "active" = false
  WHERE "name" IN ('Sick', 'Paid / annual');

-- A MONTHLY policy credits allowance/12 each month into an INTEGER column.
-- An allowance of 13 would credit 1.083 days and round in silence, so the
-- configuration is refused rather than the arithmetic fudged.
ALTER TABLE "orgapp"."LeavePolicy"
  ADD CONSTRAINT "LeavePolicy_monthly_divisible"
  CHECK ("accrual" <> 'MONTHLY' OR "allowance" % 12 = 0);

ALTER TABLE "orgapp"."LeavePolicy"
  ADD CONSTRAINT "LeavePolicy_cap_nonnegative"
  CHECK ("cap" IS NULL OR "cap" >= 0);
```

- [ ] **Step 4: Give every test fixture an `effectiveFrom`**

Nine `prisma.leavePolicy.create` calls exist and every one breaks on a required column. Find them with:

```bash
git grep -n "leavePolicy.create"
```

Eight are in tests — seven in `tests/leave.integration.test.ts`, one in `tests/leave-actions.test.ts`. The ninth is in `prisma/seed.ts`, and it needs the field here too even though Task 4 rewrites the whole policy list: `tsconfig.json` includes `**/*.ts`, so `prisma/seed.ts` is type-checked, and skipping it would leave every task between here and Task 4 with a red `tsc`.

In `tests/leave.integration.test.ts`, the fixtures in `beforeAll` become:

```ts
  const casual = await prisma.leavePolicy.create({
    data: {
      organizationId: orgId,
      name: "Casual",
      allowance: 6,
      position: 0,
      effectiveFrom: new Date("2026-01-01"),
    },
  });
  casualId = casual.id;

  const short = await prisma.leavePolicy.create({
    data: {
      organizationId: orgId,
      name: "Short leave",
      allowance: 4,
      unit: "USES",
      position: 3,
      effectiveFrom: new Date("2026-01-01"),
    },
  });
  shortId = short.id;

  const foreign = await prisma.leavePolicy.create({
    data: {
      organizationId: otherOrgId,
      name: "Casual",
      allowance: 6,
      effectiveFrom: new Date("2026-01-01"),
    },
  });
  otherPolicyId = foreign.id;
```

`2026-01-01`, not the scheme's `2026-09-01`: these fixtures assert the *existing* flat behaviour, and a scheme starting in January makes 2026 a full year, which keeps every current assertion true. Task 3 adds fixtures that start in September.

The four inline creates further down the file each gain the same field:

```ts
      data: {
        organizationId: orgId,
        name: "Impossible",
        allowance: -1,
        effectiveFrom: new Date("2026-01-01"),
      },
```

```ts
      data: {
        organizationId: orgId,
        name: "Casual",
        allowance: 9,
        effectiveFrom: new Date("2026-01-01"),
      },
```

```ts
      data: {
        organizationId: orgId,
        name: "Sabbatical",
        allowance: 30,
        active: false,
        effectiveFrom: new Date("2026-01-01"),
      },
```

```ts
      data: {
        organizationId: orgId,
        name: "Retired",
        allowance: 5,
        active: false,
        effectiveFrom: new Date("2026-01-01"),
      },
```

And in `tests/leave-actions.test.ts`:

```ts
  const casual = await prisma.leavePolicy.create({
    data: {
      organizationId: orgId,
      name: "Casual",
      allowance: 6,
      effectiveFrom: new Date("2026-01-01"),
    },
  });
```

Finally, one line in `prisma/seed.ts`, inside `seedLeavePolicies`. Task 4 replaces the surrounding policy list; this keeps `tsc` green in the meantime:

```ts
        unit: policy.unit ?? "DAYS",
        effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
        // The array's order is the select's order.
        position,
```

The seeded date is the **scheme start**, not the fixtures' January — these are the real policies, and they begin when the scheme does.

- [ ] **Step 5: Add the constraint tests**

Append to the `describe("the database enforces what the schema cannot say")` block in `tests/leave.integration.test.ts`:

```ts
  it("refuses a MONTHLY allowance that will not divide into twelve months", async () => {
    await expect(
      prisma.leavePolicy.create({
        data: {
          organizationId: orgId,
          name: "Awkward",
          allowance: 13,
          accrual: "MONTHLY",
          effectiveFrom: new Date("2026-01-01"),
        },
      }),
    ).rejects.toThrow();
  });

  it("accepts a MONTHLY allowance that divides evenly", async () => {
    const monthly = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: "Divisible",
        allowance: 12,
        accrual: "MONTHLY",
        effectiveFrom: new Date("2026-01-01"),
      },
    });
    expect(monthly.allowance).toBe(12);
    await prisma.leavePolicy.delete({ where: { id: monthly.id } });
  });

  it("leaves an UPFRONT allowance free of the divisibility rule", async () => {
    const odd = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: "Odd",
        allowance: 13,
        effectiveFrom: new Date("2026-01-01"),
      },
    });
    expect(odd.allowance).toBe(13);
    await prisma.leavePolicy.delete({ where: { id: odd.id } });
  });

  it("refuses a negative cap", async () => {
    await expect(
      prisma.leavePolicy.create({
        data: {
          organizationId: orgId,
          name: "Negative cap",
          allowance: 12,
          cap: -1,
          effectiveFrom: new Date("2026-01-01"),
        },
      }),
    ).rejects.toThrow();
  });
```

- [ ] **Step 6: Run them and watch them fail**

```bash
docker compose up -d
npx vitest run tests/leave.integration.test.ts
```

Expected: FAIL — `accrual` is not a known argument, because the migration has not been applied and the client has not been regenerated.

- [ ] **Step 7: Apply the migration and regenerate**

```bash
npx prisma migrate dev
npx prisma generate
```

`migrate dev` under this repo's `prisma7.config.ts` does **not** always regenerate the client; run `generate` explicitly rather than assuming, or the next step fails with the same error for a different reason.

- [ ] **Step 8: Run them and watch them pass**

```bash
npx vitest run tests/leave.integration.test.ts tests/leave-actions.test.ts
```

Expected: PASS, both files. The service is unchanged, so every existing balance assertion still holds.

- [ ] **Step 9: Verify the data migration by hand**

```bash
docker compose exec -T postgres psql -U leave -d leave_management \
  -c 'SELECT name, allowance, accrual, prorated, carry, cap, "effectiveFrom", active FROM "orgapp"."LeavePolicy" ORDER BY position;'
```

Expected: `Casual Leave (CL)` present with `prorated = t` and `active = t`; `Sick` and `Paid / annual` with `active = f`; every row with `effectiveFrom = 2026-09-01`. `Casual` must **not** appear — if it does, the rename did not run.

- [ ] **Step 10: Commit**

```bash
git add prisma/schema.prisma prisma/migrations prisma/seed.ts tests/leave.integration.test.ts tests/leave-actions.test.ts
git commit -m "Add accrual, pro-rating, cap and effective date to leave policies"
```

---

### Task 2: The credit schedule — `lib/leave.ts`

**Files:**
- Modify: `lib/leave.ts`
- Modify: `tests/leave.test.ts`

**Interfaces:**
- Consumes: `chargeYear(startDate: string): number` — already exported from this module.
- Produces:
  - `type LeaveAccrualName = "UPFRONT" | "MONTHLY"`
  - `type CreditRule = { allowance: number; accrual: LeaveAccrualName; prorated: boolean; carry: boolean; cap: number | null; effectiveFrom: string }`
  - `accrualStart(rule: CreditRule, joinedOn: string | null): string`
  - `creditedInYear(rule: CreditRule, joinedOn: string | null, year: number, asOf: string): number`
  - `balanceAsOf(rule: CreditRule, joinedOn: string | null, asOf: string, usedByYear: ReadonlyMap<number, number>): { credited: number; used: number; balance: number }`

This module is imported by `components/apply-form.tsx`. It may import `lib/date.ts` and nothing else, which is why `asOf` is a parameter rather than a call to `todayIso()`.

- [ ] **Step 1: Write the failing tests**

Add these imports to the existing list at the top of `tests/leave.test.ts`:

```ts
import {
  accrualStart,
  balanceAsOf,
  chargeYear,
  chargeableDays,
  costFrom,
  creditedInYear,
  datesInRange,
  effectiveEndDate,
  offDates,
  unitNoun,
} from "@/lib/leave";
```

Then append the suites. The rules under test are §2 of the spec.

```ts
/* ------------------------------------------------------- the credit rules -- */

/** Casual Leave: 6 days at once, pro-rated in a partial first year. */
const CL: CreditRule = {
  allowance: 6,
  accrual: "UPFRONT",
  prorated: true,
  carry: false,
  cap: null,
  effectiveFrom: "2026-09-01",
};

/** Earned Leave: one day on the first of each month, banked up to 20. */
const EL: CreditRule = {
  allowance: 12,
  accrual: "MONTHLY",
  prorated: false,
  carry: true,
  cap: 20,
  effectiveFrom: "2026-09-01",
};

/** Short leave: four uses a year, never pro-rated. */
const SHORT: CreditRule = {
  allowance: 4,
  accrual: "UPFRONT",
  prorated: false,
  carry: false,
  cap: null,
  effectiveFrom: "2026-09-01",
};

const NO_USE: ReadonlyMap<number, number> = new Map();

describe("accrualStart", () => {
  it("uses the scheme start for somebody who was already here", () => {
    // Employed since 2024; the scheme still begins when it begins.
    expect(accrualStart(CL, "2024-02-03")).toBe("2026-09-01");
  });

  it("uses the scheme start for somebody who joined earlier the same year", () => {
    expect(accrualStart(CL, "2026-07-02")).toBe("2026-09-01");
  });

  it("uses the join month for somebody who joins after the scheme starts", () => {
    expect(accrualStart(CL, "2027-03-15")).toBe("2027-03-01");
  });

  it("falls back to the scheme start when no join date is recorded", () => {
    // Every ADMIN today. They were here when the scheme began.
    expect(accrualStart(CL, null)).toBe("2026-09-01");
  });

  it("takes the first of the join month, not the join day", () => {
    expect(accrualStart(CL, "2027-03-31")).toBe("2027-03-01");
  });
});

describe("creditedInYear — UPFRONT", () => {
  it("pro-rates the scheme's first partial year down to two days", () => {
    // September to December is four months: floor(6 x 4/12).
    expect(creditedInYear(CL, "2026-07-02", 2026, "2026-09-04")).toBe(2);
  });

  it("credits the whole entitlement in the first full year", () => {
    expect(creditedInYear(CL, "2026-07-02", 2027, "2027-01-01")).toBe(6);
  });

  it("credits nothing for a year that ended before the scheme started", () => {
    expect(creditedInYear(CL, "2024-02-03", 2025, "2025-12-31")).toBe(0);
  });

  it("credits nothing before the credit date has actually passed", () => {
    // 31 August is inside 2026, but the scheme starts the next day.
    expect(creditedInYear(CL, "2026-07-02", 2026, "2026-08-31")).toBe(0);
  });

  it("credits on the credit date itself", () => {
    expect(creditedInYear(CL, "2026-07-02", 2026, "2026-09-01")).toBe(2);
  });

  it("rounds a fractional share down rather than up", () => {
    // A member joining in August has five months left: 6 x 5/12 is 2.5.
    expect(creditedInYear(CL, "2027-08-10", 2027, "2027-12-31")).toBe(2);
  });

  it("does not pro-rate a policy that opted out", () => {
    // Short leave is four uses whenever the year starts.
    expect(creditedInYear(SHORT, "2026-07-02", 2026, "2026-09-04")).toBe(4);
  });

  it("pro-rates a late joiner in an ordinary year", () => {
    // March onward is ten months: floor(6 x 10/12) = 5.
    expect(creditedInYear(CL, "2027-03-15", 2027, "2027-12-31")).toBe(5);
  });
});

describe("creditedInYear — MONTHLY", () => {
  it("has credited exactly one day four days into the scheme", () => {
    // The whole point of the change: EL reads 1 on 4 September, not 12.
    expect(creditedInYear(EL, "2026-07-02", 2026, "2026-09-04")).toBe(1);
  });

  it("reaches four by the end of the scheme's first year", () => {
    expect(creditedInYear(EL, "2026-07-02", 2026, "2026-12-31")).toBe(4);
  });

  it("counts a month from its first, not from the day asked about", () => {
    // 1 October has passed, so October is credited in full.
    expect(creditedInYear(EL, "2026-07-02", 2026, "2026-10-01")).toBe(2);
  });

  it("credits a full twelve across a whole year", () => {
    expect(creditedInYear(EL, "2026-07-02", 2027, "2027-12-31")).toBe(12);
  });

  it("credits only the months elapsed so far in the current year", () => {
    expect(creditedInYear(EL, "2026-07-02", 2027, "2027-06-15")).toBe(6);
  });

  it("credits nothing before the scheme starts", () => {
    expect(creditedInYear(EL, "2026-07-02", 2026, "2026-08-31")).toBe(0);
  });

  it("counts from the join month for somebody who joins mid-year", () => {
    // March to December inclusive is ten months.
    expect(creditedInYear(EL, "2027-03-15", 2027, "2027-12-31")).toBe(10);
  });
});

describe("balanceAsOf — policies that lapse", () => {
  it("is the credit less what has been spent this year", () => {
    const used = new Map([[2026, 2]]);
    expect(balanceAsOf(CL, "2026-07-02", "2026-09-04", used)).toEqual({
      credited: 2,
      used: 2,
      balance: 0,
    });
  });

  it("goes negative when more was filed than credited", () => {
    // Over-balance requests are filed, not refused, so this is reachable.
    const used = new Map([[2026, 5]]);
    expect(balanceAsOf(CL, "2026-07-02", "2026-09-04", used).balance).toBe(-3);
  });

  it("does not carry last year's unused days into this one", () => {
    // 2026 credited 2 and spent nothing; 2027 still opens at its own 6.
    const used = new Map([[2026, 0]]);
    expect(balanceAsOf(CL, "2026-07-02", "2027-01-01", used)).toEqual({
      credited: 6,
      used: 0,
      balance: 6,
    });
  });
});

describe("balanceAsOf — policies that carry", () => {
  it("carries an unused closing balance into the next year", () => {
    // 2026 closes at 4; 1 January 2027 credits one more.
    expect(balanceAsOf(EL, "2026-07-02", "2027-01-15", NO_USE)).toEqual({
      credited: 5,
      used: 0,
      balance: 5,
    });
  });

  it("carries a closing balance net of what was spent", () => {
    const used = new Map([[2026, 3]]);
    // 2026: credited 4, used 3, closes at 1. 2027 adds January.
    expect(balanceAsOf(EL, "2026-07-02", "2027-01-15", used).balance).toBe(2);
  });

  it("applies the cap at the year boundary", () => {
    const banked: CreditRule = { ...EL, effectiveFrom: "2024-01-01" };
    // 2024 closes 12, 2025 would close 24 but carries 20, 2026 adds January.
    expect(balanceAsOf(banked, null, "2026-01-15", NO_USE).balance).toBe(21);
  });

  it("lets a balance exceed the cap within a year", () => {
    const banked: CreditRule = { ...EL, effectiveFrom: "2024-01-01" };
    // Opening 20 plus a full 12 accrued, with nothing spent, reaches 32.
    expect(balanceAsOf(banked, null, "2026-12-31", NO_USE).balance).toBe(32);
  });

  it("does not hand back days the cap already discarded", () => {
    // THE REGRESSION. Credited 36 across three years, spent 10, cap 20.
    // Capping continuously computes min(20, 36 - 10) = 20 — the member
    // spends ten days and their balance does not move, because the days the
    // cap threw away flow back in to replace them. Capping at the boundary
    // gives 20 opening + 12 accrued - 10 spent = 22.
    const banked: CreditRule = { ...EL, effectiveFrom: "2024-01-01" };
    const used = new Map([[2026, 10]]);
    expect(balanceAsOf(banked, null, "2026-12-31", used).balance).toBe(22);
  });

  it("carries an overdrawn balance forward as a debt", () => {
    const used = new Map([[2026, 6]]);
    // 2026: credited 4, used 6, closes at -2. 2027 adds January.
    expect(balanceAsOf(EL, "2026-07-02", "2027-01-15", used).balance).toBe(-1);
  });

  it("reports this year's usage, not the running total", () => {
    const used = new Map([
      [2026, 3],
      [2027, 1],
    ]);
    const result = balanceAsOf(EL, "2026-07-02", "2027-01-15", used);
    expect(result.used).toBe(1);
    // Opening 1 (4 credited less 3 spent) plus January's day, less this
    // year's one day spent.
    expect(result.balance).toBe(1);
  });

  it("is empty before accrual has started at all", () => {
    expect(balanceAsOf(EL, "2027-03-15", "2026-12-31", NO_USE)).toEqual({
      credited: 0,
      used: 0,
      balance: 0,
    });
  });
});
```

Add `CreditRule` to that file's type imports:

```ts
import type { CreditRule } from "@/lib/leave";
```

- [ ] **Step 2: Run them and watch them fail**

```bash
npx vitest run tests/leave.test.ts
```

Expected: FAIL — `accrualStart`, `creditedInYear` and `balanceAsOf` are not exported.

- [ ] **Step 3: Write the arithmetic into `lib/leave.ts`**

Append to `lib/leave.ts`, after `chargeYear`:

```ts
/* ------------------------------------------------------ credit schedule -- */

/**
 * Mirrors the `LeaveAccrual` enum in the schema. Declared here as a string
 * union rather than imported from the generated client, for the same
 * client-safety reason as `LeaveUnitName`.
 */
export type LeaveAccrualName = "UPFRONT" | "MONTHLY";

/**
 * A policy's crediting configuration — everything the arithmetic below needs
 * and nothing it does not. `lib/leave-service.ts` builds one of these from a
 * `LeavePolicy` row.
 */
export type CreditRule = {
  /** Days (or uses) for a whole year. */
  allowance: number;
  accrual: LeaveAccrualName;
  /** UPFRONT only: scale a partial first year down. */
  prorated: boolean;
  /** Whether an unused balance survives 31 December. */
  carry: boolean;
  /** Ceiling on a carried balance. Null means none. */
  cap: number | null;
  /** The day this entitlement starts existing, `YYYY-MM-DD`. */
  effectiveFrom: string;
};

/** The first of the month a date falls in. */
function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Months since year zero, so two dates can be subtracted by month. */
function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

/** 1-based month number: January is 1. */
function monthOf(date: string): number {
  return Number(date.slice(5, 7));
}

/**
 * The first day a member accrues under a policy: the later of the scheme
 * start and the first of their join month.
 *
 * The join month therefore only matters for somebody who joins *after* the
 * scheme begins. Everyone already employed starts together on the scheme
 * date, however long they have been here — that is what makes 2026 a
 * four-month year for the whole organization rather than a different one per
 * person.
 *
 * A member with no recorded join date accrues from the scheme start. That is
 * every ADMIN today, and it is the right answer for them: they were here.
 *
 * Both ends are normalised to a month boundary, so a scheme configured to
 * start mid-month still credits from that month's first.
 */
export function accrualStart(rule: CreditRule, joinedOn: string | null): string {
  const scheme = firstOfMonth(rule.effectiveFrom);
  if (!joinedOn) return scheme;

  const joined = firstOfMonth(joinedOn);
  return joined > scheme ? joined : scheme;
}

/**
 * How much of `year`'s entitlement has actually been credited by `asOf`.
 *
 * Not the same question as "what is this member entitled to this year": a
 * MONTHLY policy answers 1 on 4 September and 4 on 31 December for the same
 * year, because the days arrive one at a time.
 */
export function creditedInYear(
  rule: CreditRule,
  joinedOn: string | null,
  year: number,
  asOf: string,
): number {
  const start = accrualStart(rule, joinedOn);
  const january = `${year}-01-01`;
  const december = `${year}-12-31`;

  // The first day of this year the member accrues on.
  const from = start > january ? start : january;

  // Accrual begins after this year ends, or has not reached `asOf` yet.
  if (from > december || from > asOf) return 0;

  if (rule.accrual === "MONTHLY") {
    const to = asOf < december ? asOf : december;
    const months = monthIndex(to) - monthIndex(from) + 1;
    // Multiply before dividing so a whole year is exact. The
    // LeavePolicy_monthly_divisible CHECK keeps allowance/12 a whole number
    // in the database; flooring here means a misconfiguration reaching this
    // function degrades to a smaller credit rather than a fractional day.
    return Math.floor((rule.allowance * months) / 12);
  }

  if (!rule.prorated) return rule.allowance;

  // January leaves 12 months, September leaves 4.
  const remainingMonths = 13 - monthOf(from);
  return Math.floor((rule.allowance * remainingMonths) / 12);
}

/**
 * One policy's balance for one member, as of a date.
 *
 * `usedByYear` maps a calendar year to the days already spent in it. A
 * request is bucketed by the year its *start date* falls in, which is what
 * `chargeYear` decides.
 *
 * A policy that lapses is one subtraction. A policy that carries has to walk
 * the years from its accrual start, because the cap applies at each boundary
 * and a single lifetime subtraction cannot express that: capping
 * `creditedEver - usedEver` lets the days the cap discarded flow back in to
 * replace days the member later spends, so spending ten days would leave a
 * capped balance unmoved. See §2.5 of the design.
 *
 * `balance` may exceed the cap within a year — an opening of 20 plus a fresh
 * 12 reaches 32 — and may go negative, because an over-balance request is
 * filed rather than refused.
 */
export function balanceAsOf(
  rule: CreditRule,
  joinedOn: string | null,
  asOf: string,
  usedByYear: ReadonlyMap<number, number>,
): { credited: number; used: number; balance: number } {
  const year = chargeYear(asOf);
  const used = usedByYear.get(year) ?? 0;
  const thisYear = creditedInYear(rule, joinedOn, year, asOf);

  if (!rule.carry) {
    return { credited: thisYear, used, balance: thisYear - used };
  }

  let opening = 0;
  for (let y = chargeYear(accrualStart(rule, joinedOn)); y < year; y++) {
    const closing =
      opening + creditedInYear(rule, joinedOn, y, `${y}-12-31`) - (usedByYear.get(y) ?? 0);
    opening = rule.cap === null ? closing : Math.min(rule.cap, closing);
  }

  return {
    credited: opening + thisYear,
    used,
    balance: opening + thisYear - used,
  };
}
```

- [ ] **Step 4: Run them and watch them pass**

```bash
npx vitest run tests/leave.test.ts
```

Expected: PASS, all of them — the 22 from the previous plan plus the 30 added here.

- [ ] **Step 5: Confirm the module is still client-safe**

```bash
grep -n "^import" lib/leave.ts
```

Expected: exactly one line, `import { addDays, isWeekend } from "@/lib/date";`. Anything else — `lib/rbac.ts`, `lib/attendance.ts`, `@/generated/prisma/*` — drags the Prisma client into the browser bundle through `components/apply-form.tsx`.

- [ ] **Step 6: Commit**

```bash
git add lib/leave.ts tests/leave.test.ts
git commit -m "Add the leave credit schedule as pure arithmetic"
```

---

### Task 3: The service on the credit schedule

**Files:**
- Modify: `lib/leave-service.ts`
- Modify: `tests/leave.integration.test.ts`

**Interfaces:**
- Consumes: `accrualStart`, `balanceAsOf`, `chargeYear`, `type LeaveAccrualName` from `@/lib/leave` (Task 2); `accrual`, `prorated`, `cap`, `effectiveFrom` on `prisma.leavePolicy` (Task 1).
- Produces:
  - `LeavePolicyRecord` gains `accrual: LeaveAccrualName`, `prorated: boolean`, `cap: number | null`, `effectiveFrom: string`.
  - `LeaveBalanceRecord` gains `credited: number`.
  - `LeaveSummary` gains `asOf: string`.
  - **`listOwnLeaveSummary(actor: Actor, asOf?: string)`** — the second parameter changes from a `year: number` to an ISO date, defaulting to `todayIso()`.

A `LeavePolicyRecord` structurally satisfies `CreditRule` — it carries all six of `allowance`, `accrual`, `prorated`, `carry`, `cap` and `effectiveFrom` — so it can be passed to `balanceAsOf` with no adapter and no cast.

- [ ] **Step 1: Update the seven existing summary calls**

The signature changes from a year to a date, so in `tests/leave.integration.test.ts` every `listOwnLeaveSummary(memberActor(), 2026)` becomes `listOwnLeaveSummary(memberActor(), "2026-12-31")`, and the pair in the year-spanning test become `"2026-12-31"` and `"2027-12-31"`. The call inside `describe("falls back to an admin...")` becomes:

```ts
    const summary = await service.listOwnLeaveSummary(
      { id: managerId, role: Role.MEMBER, organizationId: orgId },
      "2026-12-31",
    );
```

Those fixtures have `effectiveFrom: 2026-01-01` and are not pro-rated, so a date at the end of 2026 credits the full allowance and every existing assertion stays true.

- [ ] **Step 2: Write the failing tests**

Append to `tests/leave.integration.test.ts`. These use their own policies and their own `joinedOn`, and clean both up, so the assertions in the earlier suites — which check an exact list of policy names — keep passing.

```ts
describe("balances on a credit schedule", () => {
  let clId = "";
  let elId = "";

  /** One policy's row out of a summary, by name. */
  function policyIn(
    summary: {
      balances: { name: string; credited: number; used: number; balance: number }[];
    },
    name: string,
  ): { credited: number; used: number; balance: number } {
    const row = summary.balances.find((balance) => balance.name === name);
    if (!row) throw new Error(`No policy named ${name} in the summary.`);
    return row;
  }

  beforeAll(async () => {
    const cl = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: "Scheme CL",
        allowance: 6,
        prorated: true,
        position: 10,
        effectiveFrom: new Date("2026-09-01"),
      },
    });
    clId = cl.id;

    const el = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: "Scheme EL",
        allowance: 12,
        accrual: "MONTHLY",
        carry: true,
        cap: 20,
        position: 11,
        effectiveFrom: new Date("2026-09-01"),
      },
    });
    elId = el.id;

    // The member joined two months before the scheme; the manager two years.
    await prisma.user.update({
      where: { id: memberId },
      data: { joinedOn: new Date("2026-07-02") },
    });
    await prisma.user.update({
      where: { id: managerId },
      data: { joinedOn: new Date("2024-02-03") },
    });
  });

  afterAll(async () => {
    await prisma.leaveRequest.deleteMany({
      where: { policyId: { in: [clId, elId] } },
    });
    await prisma.leavePolicy.deleteMany({ where: { id: { in: [clId, elId] } } });
    await prisma.user.update({
      where: { id: memberId },
      data: { joinedOn: null },
    });
    await prisma.user.update({
      where: { id: managerId },
      data: { joinedOn: null },
    });
  });

  it("credits CL two days and EL one on the fourth of September", async () => {
    await clearRequests();
    const summary = await service.listOwnLeaveSummary(memberActor(), "2026-09-04");

    expect(summary.asOf).toBe("2026-09-04");
    expect(summary.year).toBe(2026);
    // The whole point of the change: EL reads 1, not 12.
    expect(policyIn(summary, "Scheme CL")).toMatchObject({ credited: 2, balance: 2 });
    expect(policyIn(summary, "Scheme EL")).toMatchObject({ credited: 1, balance: 1 });
  });

  it("has credited EL four days by the end of the scheme's first year", async () => {
    const summary = await service.listOwnLeaveSummary(memberActor(), "2026-12-31");
    expect(policyIn(summary, "Scheme EL")).toMatchObject({ credited: 4, balance: 4 });
  });

  it("credits nothing before the scheme starts", async () => {
    const summary = await service.listOwnLeaveSummary(memberActor(), "2026-08-31");
    expect(policyIn(summary, "Scheme CL")).toMatchObject({ credited: 0, balance: 0 });
    expect(policyIn(summary, "Scheme EL")).toMatchObject({ credited: 0, balance: 0 });
  });

  it("gives a member employed since 2024 the same four-month year", async () => {
    // Tenure does not buy a bigger 2026: the scheme start governs.
    const summary = await service.listOwnLeaveSummary(
      { id: managerId, role: Role.MEMBER, organizationId: orgId },
      "2026-09-04",
    );
    expect(policyIn(summary, "Scheme CL")).toMatchObject({ credited: 2 });
    expect(policyIn(summary, "Scheme EL")).toMatchObject({ credited: 1 });
  });

  it("counts a filed request against the credited amount", async () => {
    await clearRequests();
    await service.createOwnLeaveRequest(memberActor(), {
      policyId: clId,
      startDate: "2026-09-07",
      endDate: "2026-09-08",
      reason: null,
    });

    const summary = await service.listOwnLeaveSummary(memberActor(), "2026-09-09");
    expect(policyIn(summary, "Scheme CL")).toMatchObject({
      credited: 2,
      used: 2,
      balance: 0,
    });
  });

  it("carries EL into the next year, net of what was spent", async () => {
    await clearRequests();
    await prisma.leaveRequest.create({
      data: {
        organizationId: orgId,
        userId: memberId,
        policyId: elId,
        startDate: new Date("2026-12-07"),
        endDate: new Date("2026-12-07"),
        cost: 1,
      },
    });

    const summary = await service.listOwnLeaveSummary(memberActor(), "2027-01-15");
    // 2026 closed at 4 credited less 1 spent; January 2027 adds one more.
    expect(policyIn(summary, "Scheme EL")).toMatchObject({
      credited: 4,
      used: 0,
      balance: 4,
    });
  });

  it("lapses CL at the year boundary", async () => {
    // The same read as above: 2026's unused CL is gone, 2027 opens at six.
    const summary = await service.listOwnLeaveSummary(memberActor(), "2027-01-15");
    expect(policyIn(summary, "Scheme CL")).toMatchObject({ credited: 6, balance: 6 });
  });

  it("defaults to today when no date is given", async () => {
    await clearRequests();
    const summary = await service.listOwnLeaveSummary(memberActor());
    expect(summary.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

```bash
npx vitest run tests/leave.integration.test.ts
```

Expected: FAIL — the summary has no `asOf` and no `credited`, and the second argument is still a year.

- [ ] **Step 4: Widen the policy read in `lib/leave-service.ts`**

Add `LeaveAccrual` to the generated-enums import and `accrualStart` is not needed here, but `balanceAsOf` and `chargeYear` are:

```ts
import {
  EmploymentStatus,
  type LeaveAccrual,
  LeaveRequestStatus,
  type LeaveUnit,
  Role,
} from "@/generated/prisma/enums";
```

```ts
import {
  type LeaveAccrualName,
  type LeaveUnitName,
  balanceAsOf,
  chargeYear,
  costFrom,
  effectiveEndDate,
  offDates,
} from "@/lib/leave";
```

Add the four columns to `POLICY_FIELDS`:

```ts
const POLICY_FIELDS = {
  id: true,
  name: true,
  note: true,
  allowance: true,
  unit: true,
  carry: true,
  accrual: true,
  prorated: true,
  cap: true,
  effectiveFrom: true,
} as const;
```

Widen the record type, and note what it now is:

```ts
/**
 * A policy as the rest of the app sees it.
 *
 * This shape deliberately satisfies `CreditRule` in lib/leave.ts — allowance,
 * accrual, prorated, carry, cap and effectiveFrom — so it can be handed
 * straight to `balanceAsOf` with no adapter to keep in step.
 */
export type LeavePolicyRecord = {
  id: string;
  name: string;
  note: string | null;
  allowance: number;
  unit: LeaveUnitName;
  carry: boolean;
  accrual: LeaveAccrualName;
  prorated: boolean;
  cap: number | null;
  /** `YYYY-MM-DD`. */
  effectiveFrom: string;
};

export type LeaveBalanceRecord = LeavePolicyRecord & {
  /** How much of the entitlement has actually been credited by `asOf`. */
  credited: number;
  /** Days (or uses) spent in the calendar year `asOf` falls in. */
  used: number;
  /**
   * May exceed `cap` within a year, and may go negative: an over-balance
   * request is filed rather than refused.
   */
  balance: number;
};

export type LeaveSummary = {
  /** The calendar year `asOf` falls in. */
  year: number;
  /** The date these balances were computed against, `YYYY-MM-DD`. */
  asOf: string;
  balances: LeaveBalanceRecord[];
  approver: ApproverRecord;
};
```

Add the enum converter next to `unitName`:

```ts
/**
 * The schema's enum as the client-safe union lib/leave.ts speaks — the same
 * trick, and the same reason, as `unitName` above.
 */
function accrualName(accrual: LeaveAccrual): LeaveAccrualName {
  return accrual;
}
```

And a module constant beside `SPENT`:

```ts
/** Shared empty map, so a policy with no history allocates nothing. */
const NO_USAGE: ReadonlyMap<number, number> = new Map();
```

Then map the two new conversions in `listLeavePolicies`:

```ts
  return rows.map((row) => ({
    ...row,
    unit: unitName(row.unit),
    accrual: accrualName(row.accrual),
    effectiveFrom: fromDbDate(row.effectiveFrom),
  }));
```

- [ ] **Step 5: Rewrite `listOwnLeaveSummary`**

Replace the whole function. `yearWindow` becomes unused — **delete it** along with the function, or the linter will flag it.

```ts
/**
 * Every policy with what this member has left of it, plus who their requests
 * go to — one call, because the Apply screen needs all of it at once.
 *
 * The balance is derived rather than stored, and now respects a credit
 * schedule: an EL day exists once its month has begun, so this answers 1 on
 * 4 September and 4 on 31 December for the same year. All of that arithmetic
 * is in lib/leave.ts; this function's job is to fetch what it needs.
 *
 * `asOf` is a parameter rather than always `todayIso()` so the schedule can be
 * tested at a chosen date without touching the clock.
 */
export async function listOwnLeaveSummary(
  actor: Actor,
  asOf: string = todayIso(),
): Promise<LeaveSummary> {
  const organizationId = applicantOrgFor(actor);

  const applicant = await prisma.user.findUnique({
    where: { id: actor.id },
    select: {
      joinedOn: true,
      manager: { select: { id: true, name: true } },
    },
  });
  if (!applicant) throw new HttpError(401, "Your account no longer exists.");

  const [policies, spent, approver] = await Promise.all([
    listLeavePolicies(actor),
    // Every spent request, not one year's. A carrying policy needs each year's
    // usage from its accrual start, because the cap is applied at every year
    // boundary and cannot be collapsed into one subtraction. This is a single
    // person's leave history, so it stays small.
    prisma.leaveRequest.findMany({
      where: { userId: actor.id, status: { in: SPENT } },
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
```

- [ ] **Step 6: Run them and watch them pass**

```bash
npx vitest run tests/leave.integration.test.ts
```

Expected: PASS, the whole file.

- [ ] **Step 7: Type-check and lint**

```bash
npx tsc --noEmit
npx eslint .
```

Expected: one `tsc` error, in `app/(member)/apply/page.tsx` — it still passes a `year: number` where an ISO string is now wanted. Task 4 fixes it. If `eslint` reports `yearWindow` as unused, it was not deleted in Step 5.

- [ ] **Step 8: Commit**

```bash
git add lib/leave-service.ts tests/leave.integration.test.ts
git commit -m "Put leave balances on the credit schedule"
```

---

### Task 4: The seed, the screen, and verification

**Files:**
- Modify: `prisma/seed.ts`
- Modify: `app/(member)/apply/page.tsx`

**Interfaces:**
- Consumes: `listOwnLeaveSummary(actor, asOf?)` (Task 3); the four new columns (Task 1).
- Produces: nothing new.

- [ ] **Step 1: Reseed the three policies**

In `prisma/seed.ts`, replace `SEED_LEAVE_POLICIES` and add the scheme date above it:

```ts
/**
 * The day the leave scheme goes live.
 *
 * The only place this date is written other than the migration that
 * backfilled it. Application code reads `LeavePolicy.effectiveFrom` and never
 * a literal.
 */
const LEAVE_SCHEME_START = "2026-09-01";

/**
 * The leave entitlements granted to the seeded organization.
 *
 * Idempotent by (organizationId, name) — the unique index — so re-running the
 * seed adds nothing and does not reset an allowance an admin has edited. The
 * migration renamed `Casual` to `Casual Leave (CL)`, so that entry is skipped
 * on an existing database and only `Earned Leave (EL)` is added.
 */
const SEED_LEAVE_POLICIES: {
  name: string;
  note: string;
  allowance: number;
  unit?: "USES";
  accrual?: "MONTHLY";
  prorated?: boolean;
  carry?: boolean;
  cap?: number;
}[] = [
  {
    name: "Casual Leave (CL)",
    note: "Six days a year, credited in full on 1 January.",
    allowance: 6,
    prorated: true,
  },
  {
    name: "Earned Leave (EL)",
    note: "One day credited on the first of every month, carried forward up to 20.",
    allowance: 12,
    accrual: "MONTHLY",
    carry: true,
    cap: 20,
  },
  {
    name: "Short leave",
    note: "A couple of hours off. Counted per use, not per day.",
    allowance: 4,
    unit: "USES",
  },
];
```

And the `create` inside `seedLeavePolicies`:

```ts
    await prisma.leavePolicy.create({
      data: {
        organizationId,
        name: policy.name,
        note: policy.note,
        allowance: policy.allowance,
        unit: policy.unit ?? "DAYS",
        accrual: policy.accrual ?? "UPFRONT",
        prorated: policy.prorated ?? false,
        carry: policy.carry ?? false,
        cap: policy.cap ?? null,
        effectiveFrom: new Date(`${LEAVE_SCHEME_START}T00:00:00.000Z`),
        // The array's order is the select's order.
        position,
      },
    });
```

- [ ] **Step 2: Fix the page's one line**

In `app/(member)/apply/page.tsx`, the summary call loses its argument — the service defaults to today, which is what the page wanted anyway:

```ts
  const [summary, holidays] = await Promise.all([
    listOwnLeaveSummary(actor),
    // This year and the next: somebody planning in December is picking dates
    // in January, and a preview that quietly stopped counting holidays at the
    // year boundary would be wrong exactly when it matters most.
    listHolidays(actor, { from: `${year}-01-01`, to: `${year + 1}-12-31` }),
  ]);
```

`year` stays — the holiday window still uses it. Nothing else on the page changes, and `components/apply-form.tsx` is not touched at all: it renders `balance` and has never computed an entitlement.

- [ ] **Step 3: Run the seed twice**

```bash
npx prisma db seed
npx prisma db seed
```

Expected: `Leave policies: 1 added.` the first time — only EL is new, because the migration renamed Casual and Short leave already existed — then `0 added.`

- [ ] **Step 4: Confirm the policy table**

```bash
docker compose exec -T postgres psql -U leave -d leave_management \
  -c 'SELECT name, allowance, unit, accrual, prorated, carry, cap, active FROM "orgapp"."LeavePolicy" ORDER BY active DESC, position;'
```

Expected: three active rows — `Casual Leave (CL)` 6 UPFRONT prorated, `Earned Leave (EL)` 12 MONTHLY carry cap 20, `Short leave` 4 USES — and two inactive, `Sick` and `Paid / annual`.

- [ ] **Step 5: Run the whole suite, the linter and the type checker**

```bash
docker compose up -d
npx vitest run
npx eslint .
npx tsc --noEmit
```

Expected: all clean.

- [ ] **Step 6: Verify in the running app**

The Prisma client was regenerated in Task 1, so a dev server started before that holds a stale client and will fail with `Cannot read properties of undefined`. **Restart it** rather than relying on hot reload:

```bash
# If one is already running, stop it first — Next 16 refuses a second dev
# server in the same directory.
npm run dev
```

Sign in as the seeded **member** and open `http://localhost:3000/apply`:

1. The select offers exactly three types: `Casual Leave (CL)`, `Earned Leave (EL)`, `Short leave`. No `Sick`, no `Paid / annual`.
2. Choosing **Casual Leave (CL)** shows a balance of **0 days** for soma Pani — 2 credited, 2 already spent by the existing PENDING request from the previous plan.
3. Choosing **Earned Leave (EL)** shows **1 day**, not 12 and not 4. This is the change: the other three days arrive on 1 October, 1 November and 1 December.
4. Choosing **Short leave** shows **4 uses** — not pro-rated.
5. Submitting an EL request for two days shows "Over your balance — admin will see the shortfall" and still files, because over-balance is not refused.

- [ ] **Step 7: Commit**

```bash
git add prisma/seed.ts "app/(member)/apply/page.tsx"
git commit -m "Seed CL, EL and Short leave, and read the summary as of today"
```

---

## 6. Verification

Done when all of the following hold:

- `npx vitest run` passes; `npx eslint .` and `npx tsc --noEmit` are clean.
- `npx prisma db seed` run twice adds one policy and then none.
- Three active policies and two retired ones, as in Task 4 Step 4.
- `/apply` shows EL at **1 day** on 4 September 2026 — the single clearest sign the schedule works, since the old flat model would show 12.
- The scheme date appears in exactly two places outside documentation:

  ```bash
  git grep -n "2026-09-01" -- ':!Docs'
  ```

  Expected: the migration and `LEAVE_SCHEME_START` in `prisma/seed.ts`. Any occurrence in `lib/` or `app/` means a literal was hard-coded instead of reading `effectiveFrom`.

- `lib/leave.ts` still imports only `lib/date.ts`.

## 7. What is still fixture after this, and why

`/requests`, `/approvals`, `/overview`, `/score` and `/setup` remain on `seedDb()`. `/setup` is the notable one now: it renders the *fixture's* four policies, so it will disagree with `/apply`'s three until it moves. That screen is the natural next plan, and it is where editing a policy — and therefore an admin-facing view of `accrual`, `cap` and `effectiveFrom` — belongs.

## 8. Out of scope

- **Warning a member that EL is about to lapse or is over the cap.** The screen shows a balance; it says nothing about the year boundary. Worth doing once someone is actually near a boundary.
- **Showing "2 of 6 credited"** on the Apply screen. `credited` is now returned and nothing renders it; a deliberate hold, not an oversight.
- **Editing policies** — `/setup`'s business.
- **Encashing** unused EL.
- **A credit audit trail** — approach B in §3 of the design, if it is ever wanted.
- **Back-crediting anyone for service before 1 September 2026.** The scheme starts when it starts.
