# Leave Types and Accrual — Design

**Date:** 2026-09-04
**Status:** Proposed design (pre-plan)
**Supersedes:** the four-policy fixture seeded by
[`2026-09-04-apply-for-leave-real-data-plan.md`](./2026-09-04-apply-for-leave-real-data-plan.md),
which is implemented and shipped. This document changes what the policies *are*
and how a balance is computed; it does not revisit the tables, the service
boundary, the API or the screen.

**Goal:** Replace the four seeded leave types with three — Casual Leave (CL),
Earned Leave (EL) and Short leave — and teach the balance to respect a **credit
schedule**, so that EL shows the days that have actually been credited rather
than the whole year's entitlement on 1 January.

---

## 1. Why the current model cannot express this

`LeavePolicy` stores a single `allowance`, and `listOwnLeaveSummary` computes
`allowance − used`. That is a flat entitlement: every day of the year's
allowance is available from the first moment of the year.

EL is not flat. It is one day credited on the 1st of each month. On 4 September
a member has **one** EL day, not twelve. The current model has no way to say so,
and would overstate every EL balance for eleven months of the year.

CL is *nearly* flat — the whole 6 days land at once — but not quite: a member
who joins mid-year, or a scheme that starts mid-year, gets a pro-rated share.

## 2. The rules

Confirmed with the product owner on 2026-09-04.

### 2.1 The three policies

| Policy | Annual | Credited | Carries? |
|---|---|---|---|
| **Casual Leave (CL)** | 6 days | The whole year's share at once, on 1 January | No — lapses 31 Dec |
| **Earned Leave (EL)** | 12 days | 1 day on the 1st of every month | Yes, capped at **20 days** |
| **Short leave** | 4 uses | All 4 at once, never pro-rated | No — lapses 31 Dec |

`Sick` and `Paid / annual` are withdrawn. ("Paid / annual" was already 18 days
carrying the note *"Accrues monthly"* — EL is what it was reaching for, with a
model that can actually express it.)

### 2.2 When the scheme starts

The leave scheme goes live on **1 September 2026**, organization-wide. 2026 is
therefore a four-month year (September–December) for **every** member,
regardless of how long they have been employed — soma Pani, who joined July
2026, and Stacx Member, employed since February 2024, are treated alike.

A member's **accrual start** is the later of:

- the policy's scheme start date, and
- the first of the month the member joined.

So the join month only matters for people who join *after* the scheme begins. A
member with no `joinedOn` recorded — which today is every ADMIN — accrues from
the scheme start.

### 2.3 What is credited, exactly

**UPFRONT policies (CL, Short leave)** credit once per year, on the later of 1
January and the accrual start. Nothing is credited for a year that ends before
the accrual start, and nothing is credited before the credit date has passed.

For a **pro-rated** policy (CL), the credit is scaled by the months remaining in
the year from the credit date, **rounded down**:

```
remainingMonths = 13 - month(creditDate)        // January -> 12, September -> 4
credited        = floor(allowance × remainingMonths / 12)
```

Short leave is **not** pro-rated: 4 uses each year, whenever the year starts.

**MONTHLY policies (EL)** credit `allowance / 12` on the first of each month.
The number credited in a year is the count of month-firsts that fall inside
both the year and the accrual period, and that have already passed.

`allowance / 12` must divide evenly — a half-day credit is not a thing this
schema can store, and a policy that tried would silently round. A CHECK
constraint refuses it rather than letting it be configured.

### 2.4 Worked example — soma Pani on 4 September 2026

She joined 2026-07-02, so her accrual start is `max(2026-09-01, 2026-07-01)` =
**2026-09-01**.

| Policy | Credited | Working |
|---|---|---|
| Casual Leave (CL) | **2** | credit date 1 Sep → 4 months → `floor(6 × 4/12)` |
| Earned Leave (EL) | **1** | only 1 Sep has passed; 1 Oct, 1 Nov, 1 Dec still to come |
| Short leave | **4** | not pro-rated |

By 1 December her EL reads 4. This is the point of the change: **EL shows 1
today, not 4** — the four days arrive one at a time.

Stacx Member, employed since 2024, gets exactly the same figures, because the
scheme start governs.

### 2.5 Year end

On 31 December, CL and Short leave lapse. EL carries forward, and **the cap is
applied at that boundary**:

```
opening(Y)  = 0                                            if Y is the accrual-start year
            = min(cap, opening(Y-1) + credited(Y-1) - used(Y-1))   otherwise

balance(Y)  = opening(Y) + creditedSoFar(Y) - used(Y)
```

**A correction to what was proposed in discussion.** The design first floated
applying the cap continuously — `min(cap, creditedEver − usedEver)`. That is
wrong, and the arithmetic shows it plainly: with a cap of 20, a member who has
been credited 36 and used 10 computes `min(20, 26) = 20`. They spent ten days
and their balance did not move, because the days the cap had discarded flowed
back in to replace them. Capping at the year boundary instead means a discarded
day is discarded for good.

A consequence worth stating rather than discovering: because the cap applies to
what *carries*, a member may exceed 20 **within** a year — opening at 20 and
accruing 12 more reaches 32 — and loses the excess on 31 December. That is
ordinary use-it-or-lose-it behaviour, and the screen should eventually say so,
though not in this change.

### 2.6 Unchanged

Everything decided for the Apply screen still holds. Over-balance requests are
**filed, not refused** — the balance drives the displayed figure and the "Over
your balance" hint, and nothing blocks. Overlapping requests are still refused
with a 409. Past dates and notice periods are still unenforced. Cost is still
frozen at submit.

That matters here: an accrued balance is advisory. Getting EL wrong would
mislead a member, but it cannot wrongly reject them.

---

## 3. Approach

Two ways to know what has been credited.

**A — computed schedule (chosen).** The credit dates are a pure function of
`(policy, joinedOn, date)`. Nothing is stored per credit; the balance is
recomputed from first principles on every read.

**B — a materialised `LeaveCredit` ledger.** One row per credit event, written
by a job on the 1st of each month. Gives a real audit trail, and history
survives a later change to the policy's allowance.

**A is chosen.** B needs something to *run* every month, and this application
has no job runner. If that job silently failed, every balance would be quietly
wrong — a bad failure mode for a number members rely on. A recomputes correctly
whether or not anything ran, matches how `lib/leave.ts` and
`lib/attendance-month.ts` are already built (pure modules, exhaustively unit
tested), and needs no new table.

A's real cost is that changing a policy's `allowance` retroactively re-prices
past *balances*. Two things contain it: request `cost` is already frozen at
submit, so history itself does not move; and there is no policy-editing UI —
`/setup` is still fixture-backed and out of scope. If an audit trail is ever
needed, B is additive on top of A rather than a replacement.

---

## 4. Schema

`LeavePolicy` gains four columns. `carry`, which has existed unused since the
table was created, finally means something.

```prisma
/// How a policy's entitlement arrives.
enum LeaveAccrual {
  /// The whole year's share at once, on 1 January or the accrual start.
  UPFRONT
  /// One-twelfth on the first of each month.
  MONTHLY
}

// on LeavePolicy:
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

Constraints Prisma cannot express:

```sql
-- A monthly credit of half a day is not storable, so it is not configurable.
ALTER TABLE "orgapp"."LeavePolicy" ADD CONSTRAINT "LeavePolicy_monthly_divisible"
  CHECK ("accrual" <> 'MONTHLY' OR "allowance" % 12 = 0);

ALTER TABLE "orgapp"."LeavePolicy" ADD CONSTRAINT "LeavePolicy_cap_nonnegative"
  CHECK ("cap" IS NULL OR "cap" >= 0);
```

The three policies are then:

| | allowance | accrual | prorated | carry | cap | effectiveFrom |
|---|---|---|---|---|---|---|
| Casual Leave (CL) | 6 | UPFRONT | true | false | — | 2026-09-01 |
| Earned Leave (EL) | 12 | MONTHLY | — | true | 20 | 2026-09-01 |
| Short leave | 4 (uses) | UPFRONT | false | false | — | 2026-09-01 |

**Not added:** a per-member accrual-start column. It is derived from
`joinedOn` and `effectiveFrom`; storing it would be a third copy to drift.

---

## 5. Where the code changes

The service boundary, the API and the screen keep their shapes. Only the
arithmetic behind `LeaveBalanceRecord.balance` changes, plus the one query that
feeds it.

| File | Change |
|---|---|
| `prisma/schema.prisma` | The enum and four columns |
| `prisma/migrations/<ts>_leave_accrual/` | Columns, two CHECKs, and the data fix-ups in §6 |
| `lib/leave.ts` | **The new arithmetic.** `accrualStart`, `creditedInYear`, `balanceAsOf`. Stays pure and client-safe |
| `lib/leave-service.ts` | `listOwnLeaveSummary` reads `joinedOn` and the four new columns, and buckets usage by year rather than filtering to one |
| `prisma/seed.ts` | Three policies with their accrual configuration |
| `tests/leave.test.ts` | The credit schedule, exhaustively |
| `tests/leave.integration.test.ts` | Balances for members either side of the scheme start |

`components/apply-form.tsx` and `app/(member)/apply/page.tsx` need **no
change**: they render `balance` and `unit` from the summary and never compute
an entitlement themselves. That is the payoff from keeping the arithmetic in
one module.

### 5.1 The usage query has to widen

Today usage is fetched with a `groupBy` narrowed to one calendar year. A
carrying policy needs usage **per year, from the accrual start to now**, so the
year chain in §2.5 can be walked.

The service will fetch the member's spent requests since the earliest accrual
start — a small set, bounded by one person's leave history — as
`(policyId, startDate, cost)` rows, and hand them to the pure module to bucket
by `chargeYear`. One query, and every piece of arithmetic stays testable
without a database.

---

## 6. Migrating the existing policies

`LeaveRequest.policyId` is `ON DELETE RESTRICT`, so a policy with history is
retired, never deleted. That mechanism exists for exactly this moment.

`effectiveFrom` is `NOT NULL` with no default, so the migration must add it
nullable, backfill every existing row to **2026-09-01**, then set `NOT NULL` —
the three-step dance any required column needs on a populated table. The other
three columns have defaults and need no backfill.

1. **`Casual` → `Casual Leave (CL)`**, renamed in place. It is the same
   entitlement at the same 6 days, so its existing requests stay valid and
   attached. Set `prorated = true`.
2. **`Sick`** → `active = false`. Withdrawn, but any request ever filed against
   it stays readable.
3. **`Paid / annual`** → `active = false`. Superseded by EL. Not *converted*
   into EL: the entitlement changes from 18 days to 12 and the crediting rule
   changes entirely, so reusing the row would misdescribe every request already
   attached to it.
4. **`Earned Leave (EL)`** is created by the seed, which is idempotent by
   `(organizationId, name)`.

Deployment is therefore `prisma migrate deploy` followed by `prisma db seed` —
the sequence already in use.

**Effect on existing data.** The one PENDING request in the development
database (soma Pani, Casual, 9–11 Nov, cost 2) stays attached to the renamed CL
policy. Under the new rules her 2026 CL credit is 2 and her usage is 2, so the
screen will show a balance of **0** — which is correct, and a usefully visible
check that the change works.

---

## 7. Testing

**Pure (`tests/leave.test.ts`)** — where nearly all the risk is:

- `accrualStart` for a member who joined before the scheme, after it, in the
  same month, and with `joinedOn` null.
- UPFRONT credit: a full year; the pro-rated partial year (September → 2); a
  year entirely before the accrual start (0); a credit date in the future (0);
  the rounding-down boundary — 5 remaining months of a 6-day policy is 2, not
  2.5 or 3.
- MONTHLY credit: 1 on 4 September; 4 on 31 December; 12 across a full year; 0
  before the scheme.
- The year chain: EL closing 2026 at 4 opens 2027 at 4; a closing balance above
  the cap opens at 20; a within-year balance is allowed to exceed 20.
- The regression the correction in §2.5 is about: credited 36, used 10, cap 20
  must **not** yield 20.

**Integration (`tests/leave.integration.test.ts`)** — that the service reads
`joinedOn` and the new columns and reaches the same numbers as the pure module,
for a member who joined before the scheme and one who joined after.

---

## 8. Out of scope

- **Telling a member their EL is about to lapse.** The screen shows a balance;
  it does not yet warn about the year boundary or an over-cap position.
- **Editing policies.** `/setup` is still fixture-backed.
- **Encashment** of unused EL.
- **A credit audit trail** — approach B above, if it is ever wanted.
- **Approving, rejecting or withdrawing**, still `/approvals`' business.
- **Back-crediting anyone for service before 1 September 2026.** The scheme
  starts when it starts.
