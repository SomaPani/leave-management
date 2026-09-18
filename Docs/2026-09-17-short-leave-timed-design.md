# Timed Short Leave — Design

**Date:** 2026-09-17
**Status:** Approved design (pre-plan)
**Goal:** Make **Short leave** what its name promises: a slice of one day. The member picks today — and only today — chooses a range like 3:00 PM to 5:00 PM, and their manager approves it exactly as they approve any other request.

**Builds on:**
[`2026-09-04-apply-for-leave-real-data-plan.md`](./2026-09-04-apply-for-leave-real-data-plan.md),
[`2026-09-07-leave-approvals-real-data-design.md`](./2026-09-07-leave-approvals-real-data-design.md),
[`2026-09-04-leave-accrual-design.md`](./2026-09-04-leave-accrual-design.md).

---

## 1. Where things stand

Short leave is already its own kind of request. It is the organization's one `USES`-unit policy, and `components/apply-form.tsx:97` disables the **To** field when a `USES` policy is selected, so the request stores `startDate == endDate` and costs one *use* rather than a day. `effectiveEndDate` (`lib/leave.ts:90`) enforces that server-side.

What is missing is everything that makes it *short*.

| # | Gap | Where |
|---|-----|-------|
| G1 | The date is not pinned. `from` defaults to `addDays(today, 7)` and stays editable for every type, Short leave included. A short leave can be filed for next month. | `app/(member)/apply/page.tsx:82`, `components/apply-form.tsx:41` |
| G2 | There is nowhere to record a time. `startDate` and `endDate` are `@db.Date`, and no column on `LeaveRequest` holds hours. | `prisma/schema.prisma:382` |
| G3 | The overlap check compares dates only, so any second request touching that calendar day is refused 409 — including a short leave at an unrelated hour. | `lib/leave-service.ts:472` |
| G4 | `/approvals` and `/requests` render a date range. A manager deciding a short leave would see the day and not the hours they are approving. | `components/approval-queue.tsx`, `app/(member)/requests/page.tsx` |
| G5 | `LeaveRequestRecord` has no time fields, so nothing downstream could display them even if they were stored. | `lib/leave-service.ts:144` |

## 2. The rules this implements

Settled during design on 2026-09-17.

1. **Times belong to `USES` policies, and only to them.** A `USES` request requires a start and an end; a `DAYS` request sent times is refused. Keyed on `unit` rather than on the name "Short leave", so renaming the policy cannot quietly turn the feature off — the rule `accrual === "EARNED"` already follows for comp-off.

2. **A short leave is for today.** `startDate` must equal the server's today. The form locks the input to today and disables it; the service re-checks, because a disabled input is a courtesy and never a control.

3. **The end is after the start, and the span is at most four hours.** Past four hours it is half a day, which is a different leave type and a different conversation. The cap is one named constant, `MAX_SHORT_LEAVE_MINUTES`.

4. **The hours are never compared to the clock.** Filing at 5 PM for 3:00–5:00 PM is accepted. People step out first and file afterwards, a manager still approves it, and a rule that behaves differently depending on when the page was loaded is a rule nobody can predict.

5. **Two short leaves on one day stand when their hours do not.** 9:00–10:00 and 3:00–5:00 are both legitimate. Overlapping hours answer 409, exactly as an overlapping date range does today.

6. **A short leave always clashes with a day-based request on that date.** If the member is on approved annual leave, there is no afternoon to take off.

7. **Adjacency is not overlap.** 10:00–11:00 and 11:00–12:00 do not clash. The test is `aStart < bEnd && bStart < aEnd`, and the boundary case is the one worth a test of its own.

8. **The cost does not change.** One short leave is one *use*, as it is today. Times say when within the day, not how much is spent.

## 3. Approach

### 3.1 Two nullable time columns on `LeaveRequest`

A short leave stays one `LeaveRequest` row with `startDate == endDate` and `cost = 1`. Two new nullable columns say when within that day. Null on every day-based request, and always null or both set.

Nothing about balances, accrual, the approval lifecycle, `chargeYear` or `balanceAsOf` changes — which is the point. The feature is a refinement of one field group on an existing row, not a new kind of thing.

**Minutes from midnight as `Int?`**, not `@db.Time`:

- The overlap test is `aStart < bEnd && bStart < aEnd` — integer comparison, no date library, no parsing in the hot path.
- The four-hour cap is `end - start <= 240`.
- A `@db.Time` column invites the question of which timezone 3 PM is in. These are wall-clock marks with no timezone: 3 PM is 3 PM wherever the member sits, and the column should not pretend otherwise.

The display format (`3:00 PM`) is a rendering concern, handled by one formatter shared by every screen.

### 3.2 Rejected: a separate `ShortLeave` table

A clean separation on paper. In practice it forks the approval queue, the member's request list, the balance arithmetic and the overlap check into two parallel implementations of one lifecycle, and every later change to leave has to be made twice. This is the same trade `2026-09-10-comp-off-design.md` §3.2 rejected a ledger table for, and it fails for the same reason.

### 3.3 Rejected: promote `startDate`/`endDate` to timestamps

Changing `@db.Date` to `@db.Timestamp` would carry the time without new columns. It also rewrites every existing row, every date comparison in the codebase, `chargeYear`, `datesInRange`, `offDates`, the attendance join and the holiday overlap query — an enormous blast radius to serve one leave type, and a permanent invitation to timezone bugs in a system that has none today.

## 4. Data model

```prisma
  /// Minutes from midnight, for a USES request that occupies part of a day:
  /// 15:00 is 900. Null on every day-based request.
  ///
  /// Int rather than @db.Time because these are wall-clock marks with no
  /// timezone — 3 PM is 3 PM wherever the member sits — and because the
  /// overlap test and the four-hour cap are then plain integer arithmetic.
  ///
  /// Both set or both null: the CHECK below enforces it, so no reader has to
  /// handle a half-timed row.
  startTime Int?
  endTime   Int?
```

Two CHECK constraints, appended by hand to the generated migration as `20260904110559_leave_accrual` does:

```sql
ALTER TABLE "orgapp"."LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_times_paired"
  CHECK (("startTime" IS NULL) = ("endTime" IS NULL));

ALTER TABLE "orgapp"."LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_times_ordered"
  CHECK (
    "startTime" IS NULL
    OR ("startTime" >= 0 AND "endTime" <= 1440 AND "startTime" < "endTime")
  );
```

Both columns are nullable with no default, so the migration is a single `ALTER` with no data step: every existing request is day-based and correctly reads null.

No index. The overlap query already filters by `userId` and a date range; the times are compared inside that handful of rows.

## 5. The arithmetic

`lib/leave.ts` gains four pure helpers, all client-safe so the form refuses before the round trip using the same code the service refuses with:

```ts
/** Four hours. Past this it is half a day, which is a different leave type. */
export const MAX_SHORT_LEAVE_MINUTES = 240;

/** "15:00" -> 900. Null when the value is not a real clock time. */
export function parseClockTime(value: string): number | null;

/** 900 -> "3:00 PM". The one place the display format is decided. */
export function formatClockTime(minutes: number): string;

/** Half-open: adjacency is not overlap. 10-11 and 11-12 do not clash. */
export function timesOverlap(
  aStart: number, aEnd: number, bStart: number, bEnd: number,
): boolean;

/**
 * Whether these times may be filed against this policy on this date: the
 * refusal to show the member, or null when they may.
 *
 * A sentence rather than a boolean because both callers must say why — the
 * form beside the inputs, the service in a 400. The shape `claimableDay` in
 * lib/comp-off.ts already established.
 */
export function shortLeaveTimes(
  unit: LeaveUnitName,
  startTime: number | null,
  endTime: number | null,
  startDate: string,
  today: string,
): string | null;
```

`shortLeaveTimes` carries rules 1, 2 and 3 together, because they are one question from the caller's side — *may this request be filed?* — and splitting them would put three refusals in three places that must agree.

## 6. The overlap check

`lib/leave-service.ts:472` keeps its transaction and its honesty about the race it narrows rather than closes. The date query is unchanged; a time comparison is applied to what it returns:

- A clash row with null times is a day-based request → it always clashes (rule 6).
- A clash row with times, when the new request also has times → compare with `timesOverlap` (rules 5, 7).
- A clash row with times, when the new request is day-based → it clashes (rule 6, from the other side).

The candidate query therefore selects `startTime`/`endTime` alongside the id, and refuses only when the time test says so. The message stays specific: overlapping hours read "You already have a short leave covering those hours," which is the refusal a member will actually meet.

## 7. Modules

| File | Change |
|------|--------|
| `lib/leave.ts` | The four helpers above. No Prisma import, as today. |
| `lib/leave-input.ts` | `leaveRequestInputFrom` parses `startTime`/`endTime` into minutes; malformed values are refused here, as every other field's shape already is. |
| `lib/leave-service.ts` | `LeaveRequestInput` and `LeaveRequestRecord` carry the times; `createOwnLeaveRequest` validates with `shortLeaveTimes` and writes them; the overlap check gains the time branch; `REQUEST_FIELDS` selects them. |
| `components/apply-form.tsx` | On a `USES` policy: the date is forced to today and disabled, two `<input type="time">` appear, and the live refusal and duration read out beside them. |
| `components/approval-queue.tsx` | The row and the detail panel render `3:00 PM – 5:00 PM` under the date. |
| `app/(member)/requests/page.tsx` | The same on the member's own list. |
| `app/(member)/apply/page.tsx` | Passes `today` to the form, which it already computes. |

The apply form is the file that grows most. It is 170 lines and gains one conditional field group; if it passes roughly 220, the timed branch moves to a `components/short-leave-fields.tsx` sibling rather than being allowed to sprawl.

## 8. Screens

- **`/apply`** — picking Short leave snaps **From** to today and disables it, hides **To** as it already does, and reveals **Start** and **End** time inputs. The panel on the right reads "1 use · 2 hours" instead of a working-day count. A refusal — end before start, or over four hours — appears beside the inputs and disables the button, the pattern `components/comp-off-form.tsx` already uses.
- **`/approvals`** — the manager sees `Today · 3:00 PM – 5:00 PM` where a day-based request shows its date range. Nothing else about deciding changes: routing, `canReviewLeave`, and the Approve/Reject affordances are untouched.
- **`/requests`** — the member's own list shows the same range.

## 9. Testing

- `tests/leave.test.ts` — `parseClockTime` on valid, malformed and out-of-range input; `formatClockTime` at noon, midnight and 12:30 AM, the three places a 12-hour clock goes wrong; `timesOverlap` at the adjacency boundary in both directions; `shortLeaveTimes` across a `DAYS` policy sent times, a `USES` policy sent none, a past date, a future date, an inverted range and a span one minute over the cap.
- `tests/leave.integration.test.ts` — a short leave today stores both times; yesterday and tomorrow answer 400; over four hours answers 400; a second short leave at non-overlapping hours succeeds; at overlapping hours answers 409; a short leave clashes with a full-day leave on the same date; a `DAYS` request sent times answers 400; an approved short leave still costs one use and moves the balance by one.
- `tests/leave-actions.test.ts` — the form post carrying times, and its refusal path back to `/apply`.

## 10. Out of scope

- **Recurring or repeating short leave.**
- **Short leave in attendance or the score pipeline.** Those are upstream and are not told about hours.
- **Times on a `DAYS` policy**, including half-day leave as a distinct type.
- **Any change to the four-uses-a-year allowance**, or to how uses accrue.
- **A minimum duration.** Nothing stops a one-minute short leave; the approver is the check on that, and a floor would be as arbitrary as it is unnecessary.
