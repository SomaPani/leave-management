# Comp-off Admin Grant — Design

**Date:** 2026-09-16
**Status:** Approved design
**Goal:** Let an admin credit a comp-off day directly, from a **Comp-off** section on `/setup`: pick a member, pick the non-working day they worked, grant it. The member's balance moves immediately, with no claim to file and nothing to approve.

**Builds on:** [`2026-09-10-comp-off-design.md`](./2026-09-10-comp-off-design.md).

---

## 1. Where things stand

Comp-off today runs in exactly one direction. A member files a `CompOffClaim` on `/apply`, an admin decides it on `/approvals`, and the `APPROVED` claim *is* the credit — there is no separate ledger (`2026-09-10-comp-off-design.md` §3.1).

That leaves the common case unserved: the admin already knows a member worked the Sunday, and asking them to chase that member into filing a claim so the admin can approve it is ceremony, not control.

| # | Gap | Where |
|---|-----|-------|
| G1 | Every claim row is initiated by its subject. Nothing records that a credit came from an admin instead. | `prisma/schema.prisma:458` |
| G2 | Every write path to `CompOffClaim` is self-scoped — `createOwnCompOffClaim` takes no user id and files as `actor.id`. There is no way to create a row *for* somebody. | `lib/comp-off-service.ts:156` |
| G3 | `withdrawOwnCompOffClaim` is `PENDING`-only and claimant-scoped, so it cannot undo an approved credit. | `lib/comp-off-service.ts:237` |
| G4 | `listMembers` hard-filters `role: MEMBER`, so it cannot back a picker that must also offer admins. | `lib/services.ts:297` |
| G5 | `/setup` is entirely demo: it reads `seedDb()` and posts to `lib/demo-actions.ts`. Its banner claims nothing on the screen is saved. | `app/(leave)/setup/page.tsx` |

## 2. The rules this implements

Settled during design on 2026-09-16.

1. **A grant is a claim the admin filed on someone's behalf.** It is one `CompOffClaim` row, `APPROVED` at birth, carrying `source = ADMIN_GRANT`. Every rule the 2026-09-10 design settled — one claim is one day, credit bucketed by `chargeYear(workedOn)`, lapsing on 31 December — applies unchanged, because it is the same row in the same table.

2. **A grant obeys the same day rules as a claim.** `claimableDay` decides, against the *grantee's* region: a weekend or a holiday, never a future day. An admin does not get an override, because the rule is about what comp-off compensates for, not about who is asking.

3. **An admin may not grant to themselves.** The reason `canReviewCompOff` excludes the claimant: nobody creates their own entitlement. An admin who worked a Sunday files a claim like anyone else, and another admin approves it.

4. **Any colleague in the organization may be granted to, admins included.** The picker is every active user in the admin's own organization except themselves. An admin is a person who works weekends too — the same reasoning that admits them to `canClaimCompOff`.

5. **A day already held may not be granted.** The `PENDING`-or-`APPROVED` duplicate check is the one `createOwnCompOffClaim` runs, in the same transaction as the insert, for the same reason and with the same honesty about the race.

6. **A grant is revocable; a claim is not revocable this way.** Revoking sets `WITHDRAWN`, scoped to `source = ADMIN_GRANT` and `status = APPROVED`. A member-filed claim is never touched by it — undoing a member's approved claim is a decision with a claimant on the other end of it, and it does not belong on a setup screen.

7. **Revoking a spent credit drives the balance negative.** It is not refused. Every policy in the system already goes negative on an over-spend rather than blocking, and comp-off is not the place to invent a second answer.

8. **The `/setup` banner stops lying.** It currently says nothing on the screen is saved. Once one section saves, it names the sections that are still sample data instead.

## 3. Approach

### 3.1 A `source` column, and nothing else

```
credited(Y) = count(claims where status = APPROVED and chargeYear(workedOn) = Y)
```

is already the credit (§3.1 of the 2026-09-10 design), and it does not mention `source`. That is the point: a granted day and a claimed day are the same credit, so the arithmetic, the lapse rule, `earnedByYearFor`, `balanceAsOf` and both screens that read a balance need **no change at all**. The column records provenance for the audit and for the revoke scope, and is read by nothing else.

The 2026-09-10 design predicted this shape in §3.2, when it rejected a separate ledger: *"If auto-earning ever arrives it fits §3.1 as a `source` column on the claim with an auto-approved status."* An admin grant is that case.

### 3.2 Rejected: no schema change, grant by create-then-decide

`createOwnCompOffClaim` cannot file for somebody else, but a grant could insert a `PENDING` row and immediately call `decideCompOffClaim`. No migration, no new column.

It loses the only thing worth keeping. The row would be indistinguishable from one the member filed: `/requests` would show it as the member's own claim, nothing could answer "did she claim this or did an admin give it to her?", and the revoke in rule 6 would have no scope to stand on — it could just as easily withdraw a real claim. Provenance is the whole point of an audit trail on a credit somebody did not ask for.

### 3.3 Rejected: a free-floating credit with no date

"Give this member 2 days" is simpler to operate. But a credit with no worked day has no year to lapse in, no duplicate to check against, and nothing for the member to recognise on their own screen. It would need its own arithmetic, its own expiry rule and its own table — every cost §3.2 of the 2026-09-10 design rejected a ledger for.

## 4. Data model

```prisma
/// Where a credit came from. A CLAIM is the member asking for a day they
/// worked; an ADMIN_GRANT is an admin crediting it without being asked.
///
/// The credit itself is identical — `earnedByYearFrom` counts both and does
/// not read this column. It exists for the audit, and to scope the revoke on
/// /setup so it can never withdraw a claim a member actually filed.
enum CompOffSource {
  CLAIM
  ADMIN_GRANT
}
```

One column on `CompOffClaim`:

```prisma
  source CompOffSource @default(CLAIM)

  /// The /setup grant list: one organization's grants, newest first.
  @@index([organizationId, source, createdAt])
```

The default is what makes the migration a single `ALTER TABLE` with no data step: every row that exists was filed by its subject, which is exactly `CLAIM`.

No other column. `reason` already holds the admin's note, and `decidedById` already records who did it — a grant sets both at insert.

## 5. Modules

| File | Change |
|------|--------|
| `lib/rbac.ts` | `canGrantCompOff(actor, granteeId)` and `canRevokeCompOffGrant(actor, grantOrganizationId)`. |
| `lib/comp-off.ts` | `CompOffSourceName`, the client-safe union, beside `CompOffClaimStatusName`. |
| `lib/comp-off-input.ts` | `compOffGrantInputFrom(body)` — `userId`, `workedOn`, `reason`. |
| `lib/comp-off-service.ts` | `listCompOffGrantees`, `grantCompOff`, `listCompOffGrants`, `revokeCompOffGrant`. |
| `lib/comp-off-actions.ts` | `grantCompOffAction`, `revokeCompOffGrantAction`. |
| `components/comp-off-grant.tsx` | The section: picker, date, reason, Grant, and the recent-grants list with Revoke. |
| `components/demo-banner.tsx` | The reworded standing notice (rule 8). |
| `app/(leave)/setup/page.tsx` | Loads the real data for the one real section; the other four stay on `seedDb()`. |

`grantCompOff` deliberately does **not** reuse `createOwnCompOffClaim` with an id parameter. That function's whole contract is that it has no id to tamper with (rule 8 of the 2026-09-10 design); adding one to serve a different caller would hand every future reader the question of whether a member can pass somebody else's. Two entry points, each authorizing once, is the cheaper honesty.

## 6. RBAC

```ts
/**
 * Granting excludes the grantee being the grantor, for the reason
 * `canReviewCompOff` excludes the claimant: nobody mints their own credit.
 * ADMIN only — a SUPERADMIN belongs to no organization and has no roster.
 */
export function canGrantCompOff(actor: Actor, granteeId: string): boolean

/** Revoking follows granting, minus the grantee: it is the same authority. */
export function canRevokeCompOffGrant(actor: Actor, grantOrganizationId: string): boolean
```

## 7. Screen

A **Comp-off** card on `/setup`, below WFH and above the holiday calendar:

- A member `<select>` from `listCompOffGrantees`, a date input capped at today, a reason field, and a **Grant** button.
- Beneath it, the organization's most recent grants — grantee, worked day, reason, who granted it — each with **Revoke**.
- Client-side `claimableDay` beside the date, exactly as `components/comp-off-form.tsx` does it, so a Tuesday is refused before the round trip by the same function the service refuses with.

The page becomes a hybrid: `seedDb()` for four demo sections, a real session read for this one. The banner names what is still sample data rather than claiming the screen is.

## 8. Testing

- `tests/rbac.test.ts` — both predicates across every role, including admin-grants-to-self and admin-grants-to-admin.
- `tests/comp-off-input.test.ts` — `compOffGrantInputFrom`: a missing `userId`, an over-long reason, a malformed date.
- `tests/comp-off.integration.test.ts` — grant credits the grantee's balance; a working day is refused 400; a future day 400; a day already claimed 409; granting to self 403; granting across organizations 404; a member granting 403; revoke removes the credit; revoke refuses a member-filed claim; revoke twice answers 409; the grantee list excludes the actor and other organizations.
- `tests/comp-off-actions.test.ts` — both actions' redirect and error paths.

## 9. Out of scope

- **Bulk grants** — one admin, many members, one submit.
- **Editing a grant in place.** Revoke and re-grant.
- **A grant worth more than one day.** Rule 2 of the 2026-09-10 design still holds.
- **The other four `/setup` sections.** They stay on `seedDb()`; G3 of the 2026-09-10 design stands.
- **Notifying the member** that they were granted a day.
