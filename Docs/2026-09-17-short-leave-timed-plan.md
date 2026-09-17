# Timed Short Leave — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Short leave a slice of one day — the member picks today and only today, chooses a range like 3:00 PM to 5:00 PM, and their manager approves it exactly as they approve any other request.

**Architecture:** Two nullable `Int?` columns on `LeaveRequest` holding minutes from midnight, null on every day-based request. A short leave stays one row with `startDate == endDate` and `cost = 1` use — balances, accrual and the approval lifecycle are untouched. Four pure helpers in `lib/leave.ts` carry the rules, client-safe so the form refuses with the same code the service refuses with.

**Tech Stack:** Next.js 16 (App Router, Server Components, Server Actions), Prisma 7 + Postgres, Vitest, TypeScript, Tailwind 4.

**Spec:** [`2026-09-17-short-leave-timed-design.md`](./2026-09-17-short-leave-timed-design.md)

## Global Constraints

- **Times belong to `USES` policies only.** Keyed on `policy.unit`, never on the name "Short leave". (Spec rule 1)
- **`startDate` must equal the server's today** for a `USES` request. The form locks it; the service re-checks. (Spec rule 2)
- **`endTime > startTime`, and `endTime - startTime <= 240`** — four hours, the constant `MAX_SHORT_LEAVE_MINUTES`. (Spec rule 3)
- **Hours are never compared to the clock.** A range already past is accepted. (Spec rule 4)
- **Adjacency is not overlap.** The test is `aStart < bEnd && bStart < aEnd`; 10:00–11:00 and 11:00–12:00 do not clash. (Spec rules 5, 7)
- **A short leave always clashes with a day-based request on that date**, and vice versa. (Spec rule 6)
- **Cost does not change.** One short leave is one use. (Spec rule 8)
- **Times are minutes from midnight**, `0..1440`, stored `Int?`. Both set or both null.
- Tests: `npm test` (vitest, `fileParallelism: false`). Unit tests are `tests/<n>.test.ts`; database tests are `tests/<n>.integration.test.ts` and mock `@/lib/auth` via `vi.hoisted`.
- Migrations: `npm run migrate` (= `prisma migrate dev`). CHECK constraints are appended by hand to the generated `migration.sql`, as `20260904110559_leave_accrual` does.
- **Restart `next dev` after any migration.** A long-lived dev server holds the Prisma Client it loaded at startup and will throw `Unknown argument` on a new column even though the tests pass.
- Lint and types must be clean: `npm run lint` and `npx tsc --noEmit`.

---

### Task 1: The `startTime` and `endTime` columns

**Files:**
- Modify: `prisma/schema.prisma` (inside `model LeaveRequest`, after the `cost` field at :389)
- Create: `prisma/migrations/<generated>_short_leave_times/migration.sql` (written by Prisma, then edited by hand)

**Interfaces:**
- Produces: `LeaveRequest.startTime` and `LeaveRequest.endTime`, both `Int?`, selectable through Prisma as `startTime: true` / `endTime: true`.

- [ ] **Step 1: Add the two columns**

In `prisma/schema.prisma`, inside `model LeaveRequest`, immediately after the `cost` field:

```prisma
  /// Minutes from midnight, for a USES request that occupies part of a day:
  /// 15:00 is 900. Null on every day-based request.
  ///
  /// Int rather than @db.Time because these are wall-clock marks with no
  /// timezone — 3 PM is 3 PM wherever the member sits — and because the
  /// overlap test and the four-hour cap are then plain integer arithmetic.
  ///
  /// Both set or both null: the LeaveRequest_times_paired CHECK enforces it,
  /// so no reader has to handle a half-timed row.
  startTime Int?
  endTime   Int?
```

- [ ] **Step 2: Generate the migration**

Run: `npm run migrate -- --name short_leave_times`
Expected: a new `prisma/migrations/<timestamp>_short_leave_times/migration.sql` containing a single `ALTER TABLE ... ADD COLUMN` for each column, and a regenerated client. No data step: both columns are nullable with no default, so every existing row correctly reads null.

- [ ] **Step 3: Append the CHECK constraints by hand**

At the end of the generated `migration.sql`, matching the style of `20260904110559_leave_accrual/migration.sql:51`:

```sql
-- A half-timed row has no meaning: a reader would have to guess whether the
-- missing end is midnight or an absent time. Pairing them in the database
-- rather than only in the service means no import, no backfill and no future
-- writer can produce one.
ALTER TABLE "orgapp"."LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_times_paired"
  CHECK (("startTime" IS NULL) = ("endTime" IS NULL));

-- Ordering and range. The four-hour cap is deliberately NOT here: it is a
-- policy about short leave that may reasonably change, and a CHECK would
-- make changing it a migration.
ALTER TABLE "orgapp"."LeaveRequest"
  ADD CONSTRAINT "LeaveRequest_times_ordered"
  CHECK (
    "startTime" IS NULL
    OR ("startTime" >= 0 AND "endTime" <= 1440 AND "startTime" < "endTime")
  );
```

- [ ] **Step 4: Re-apply and verify both constraints exist**

Run: `npm run migrate`
Then: `npx prisma db execute --stdin <<< "SELECT conname FROM pg_constraint WHERE conname LIKE 'LeaveRequest_times%';"`
Expected: both `LeaveRequest_times_paired` and `LeaveRequest_times_ordered` are listed.

- [ ] **Step 5: Confirm nothing else broke**

Run: `npx tsc --noEmit` and `npm test`
Expected: both clean. No behaviour has changed yet.

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "Add startTime and endTime to LeaveRequest"
```

---

### Task 2: `lib/leave.ts` — the pure time rules

**Files:**
- Modify: `lib/leave.ts` (append after `unitNoun` at :110)
- Test: `tests/leave.test.ts`

**Interfaces:**
- Consumes: `LeaveUnitName` from `lib/leave.ts` (already exported at :24).
- Produces:
  - `MAX_SHORT_LEAVE_MINUTES: number` (240)
  - `parseClockTime(value: string): number | null`
  - `formatClockTime(minutes: number): string`
  - `timesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean`
  - `shortLeaveTimes(unit: LeaveUnitName, startTime: number | null, endTime: number | null, startDate: string, today: string): string | null`

- [ ] **Step 1: Write the failing tests**

Append to `tests/leave.test.ts`:

```typescript
describe("parseClockTime", () => {
  it("reads a 24-hour clock value as minutes from midnight", () => {
    expect(parseClockTime("15:00")).toBe(900);
  });

  it("reads midnight as zero", () => {
    expect(parseClockTime("00:00")).toBe(0);
  });

  it("reads a value with minutes", () => {
    expect(parseClockTime("09:45")).toBe(585);
  });

  it("accepts a single-digit hour, which some browsers send", () => {
    expect(parseClockTime("9:45")).toBe(585);
  });

  it("refuses an hour above 23", () => {
    expect(parseClockTime("24:00")).toBeNull();
  });

  it("refuses minutes above 59", () => {
    expect(parseClockTime("10:60")).toBeNull();
  });

  it("refuses a malformed value", () => {
    expect(parseClockTime("3 PM")).toBeNull();
  });

  it("refuses an empty value", () => {
    expect(parseClockTime("")).toBeNull();
  });
});

describe("formatClockTime", () => {
  it("renders an afternoon time on a 12-hour clock", () => {
    expect(formatClockTime(900)).toBe("3:00 PM");
  });

  it("renders a morning time", () => {
    expect(formatClockTime(585)).toBe("9:45 AM");
  });

  it("renders noon as 12 PM, not 0 PM", () => {
    expect(formatClockTime(720)).toBe("12:00 PM");
  });

  it("renders midnight as 12 AM, not 0 AM", () => {
    expect(formatClockTime(0)).toBe("12:00 AM");
  });

  it("renders half past midnight as 12:30 AM", () => {
    expect(formatClockTime(30)).toBe("12:30 AM");
  });
});

describe("timesOverlap", () => {
  it("finds an overlap when one range starts inside the other", () => {
    expect(timesOverlap(540, 660, 600, 720)).toBe(true);
  });

  it("finds an overlap when one range contains the other", () => {
    expect(timesOverlap(540, 780, 600, 660)).toBe(true);
  });

  it("does not treat adjacency as overlap", () => {
    expect(timesOverlap(600, 660, 660, 720)).toBe(false);
  });

  it("does not treat adjacency as overlap in the other direction", () => {
    expect(timesOverlap(660, 720, 600, 660)).toBe(false);
  });

  it("finds no overlap in disjoint ranges", () => {
    expect(timesOverlap(540, 600, 900, 1020)).toBe(false);
  });
});

describe("shortLeaveTimes", () => {
  const TODAY = "2026-09-17";

  it("accepts a two-hour range on a USES policy today", () => {
    expect(shortLeaveTimes("USES", 900, 1020, TODAY, TODAY)).toBeNull();
  });

  it("accepts a range exactly at the four-hour cap", () => {
    expect(shortLeaveTimes("USES", 540, 780, TODAY, TODAY)).toBeNull();
  });

  it("accepts a range already in the past — filed after stepping out", () => {
    expect(shortLeaveTimes("USES", 0, 60, TODAY, TODAY)).toBeNull();
  });

  it("refuses a USES policy with no times", () => {
    expect(shortLeaveTimes("USES", null, null, TODAY, TODAY)).toMatch(/start and an end time/);
  });

  it("refuses a DAYS policy that was sent times", () => {
    expect(shortLeaveTimes("DAYS", 900, 1020, TODAY, TODAY)).toMatch(/whole days/);
  });

  it("accepts a DAYS policy with no times", () => {
    expect(shortLeaveTimes("DAYS", null, null, "2026-09-24", TODAY)).toBeNull();
  });

  it("refuses a short leave dated yesterday", () => {
    expect(shortLeaveTimes("USES", 900, 1020, "2026-09-16", TODAY)).toMatch(/today/);
  });

  it("refuses a short leave dated tomorrow", () => {
    expect(shortLeaveTimes("USES", 900, 1020, "2026-09-18", TODAY)).toMatch(/today/);
  });

  it("refuses an end at or before the start", () => {
    expect(shortLeaveTimes("USES", 1020, 900, TODAY, TODAY)).toMatch(/after the start/);
  });

  it("refuses a zero-length range", () => {
    expect(shortLeaveTimes("USES", 900, 900, TODAY, TODAY)).toMatch(/after the start/);
  });

  it("refuses a span one minute over the cap", () => {
    expect(shortLeaveTimes("USES", 540, 781, TODAY, TODAY)).toMatch(/four hours/);
  });
});
```

Add the new names to the existing import block at the top of `tests/leave.test.ts`:

```typescript
import {
  MAX_SHORT_LEAVE_MINUTES,
  accrualStart,
  balanceAsOf,
  chargeYear,
  chargeableDays,
  costFrom,
  creditedInYear,
  datesInRange,
  effectiveEndDate,
  formatClockTime,
  offDates,
  parseClockTime,
  shortLeaveTimes,
  timesOverlap,
  unitNoun,
} from "@/lib/leave";
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/leave.test.ts`
Expected: FAIL, many cases with `parseClockTime is not a function` and siblings. Confirm the failures are missing functions, not typos in the import block.

- [ ] **Step 3: Write the implementation**

Append to `lib/leave.ts`, after `unitNoun`:

```typescript
/**
 * The longest a short leave may run. Past four hours it is half a day, which
 * is a different leave type and a different conversation.
 *
 * Deliberately not a CHECK constraint: it is a policy that may reasonably
 * change, and enforcing it in the database would make changing it a
 * migration.
 */
export const MAX_SHORT_LEAVE_MINUTES = 240;

/** Minutes in a day, the exclusive upper bound on a clock time. */
const MINUTES_IN_DAY = 24 * 60;

/**
 * `"15:00"` → `900`, or null when the value is not a real clock time.
 *
 * A single-digit hour is accepted because not every browser pads what its
 * `<input type="time">` submits, and refusing `"9:45"` would be a refusal
 * about the browser rather than about the member.
 */
export function parseClockTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

/**
 * `900` → `"3:00 PM"`. The one place the display format is decided, so the
 * apply form, the approvals queue and the member's own list cannot drift.
 *
 * The `% 12 || 12` is what keeps noon from rendering as "0:00 PM" and
 * midnight from rendering as "0:00 AM" — the two cases a 12-hour clock gets
 * wrong, and the reason both have a test.
 */
export function formatClockTime(minutes: number): string {
  const hours24 = Math.floor(minutes / 60);
  const hours12 = hours24 % 12 || 12;
  const rest = String(minutes % 60).padStart(2, "0");
  return `${hours12}:${rest} ${hours24 < 12 ? "AM" : "PM"}`;
}

/**
 * Whether two half-open ranges share any minute.
 *
 * Half-open on purpose: a range that ends at 11:00 and one that starts at
 * 11:00 do not overlap, because the member is back. Touching endpoints is
 * the case this would otherwise get wrong, so it has a test in both
 * directions.
 */
export function timesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Whether these times may be filed against this policy on this date: the
 * refusal to show the member, or null when they may.
 *
 * A sentence rather than a boolean because both callers have to say why — the
 * form beside the inputs, the service in a 400. The shape `claimableDay` in
 * lib/comp-off.ts established.
 *
 * Rules 1, 2 and 3 of the spec live here together because they are one
 * question from a caller's side — may this be filed? — and splitting them
 * would put three refusals in three places that must agree.
 *
 * The hours are never compared to the clock. Filing at 5 PM for 3:00–5:00 PM
 * is accepted: people step out first and file afterwards, an approver still
 * decides it, and a rule that changes with the time of day is one nobody can
 * predict.
 */
export function shortLeaveTimes(
  unit: LeaveUnitName,
  startTime: number | null,
  endTime: number | null,
  startDate: string,
  today: string,
): string | null {
  if (unit !== "USES") {
    return startTime === null && endTime === null
      ? null
      : "That leave type is taken in whole days, not hours.";
  }

  if (startTime === null || endTime === null) {
    return "A short leave needs a start and an end time.";
  }

  if (startDate !== today) {
    return "A short leave can only be taken today.";
  }

  if (endTime <= startTime) {
    return "The end time must be after the start time.";
  }

  if (endTime - startTime > MAX_SHORT_LEAVE_MINUTES) {
    return "A short leave cannot run longer than four hours.";
  }

  return null;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/leave.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Confirm the module stayed client-safe**

Run: `npx vitest run tests/module-graph.test.ts`
Expected: PASS. `lib/leave.ts` must still have no Prisma import — the apply form imports it into the browser.

- [ ] **Step 6: Commit**

```bash
git add lib/leave.ts tests/leave.test.ts
git commit -m "Add the pure short-leave time rules"
```

---

### Task 3: `lib/leave-input.ts` — parsing the two time fields

**Files:**
- Modify: `lib/leave-input.ts:22-48` (`leaveRequestInputFrom`)
- Modify: `lib/leave-service.ts:136-142` (`LeaveRequestInput`)
- Test: `tests/api-input.test.ts`

**Interfaces:**
- Consumes: `parseClockTime` from `lib/leave.ts` (Task 2).
- Produces: `LeaveRequestInput` gains `startTime: number | null` and `endTime: number | null`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/api-input.test.ts`, inside the existing `leaveRequestInputFrom` describe block if there is one, otherwise as a new block at the end of the file:

```typescript
describe("leaveRequestInputFrom — times", () => {
  const base = { policyId: "p1", startDate: "2026-09-17" };

  it("reads a start and end time as minutes from midnight", () => {
    const input = leaveRequestInputFrom({ ...base, startTime: "15:00", endTime: "17:00" });

    expect(input.startTime).toBe(900);
    expect(input.endTime).toBe(1020);
  });

  it("treats missing times as null — a day-based request", () => {
    const input = leaveRequestInputFrom(base);

    expect(input.startTime).toBeNull();
    expect(input.endTime).toBeNull();
  });

  it("treats empty times as null — the form's untouched inputs", () => {
    const input = leaveRequestInputFrom({ ...base, startTime: "", endTime: "" });

    expect(input.startTime).toBeNull();
    expect(input.endTime).toBeNull();
  });

  it("refuses a malformed start time", () => {
    expect(() => leaveRequestInputFrom({ ...base, startTime: "3 PM", endTime: "17:00" })).toThrow(
      /startTime/,
    );
  });

  it("refuses a malformed end time", () => {
    expect(() => leaveRequestInputFrom({ ...base, startTime: "15:00", endTime: "25:00" })).toThrow(
      /endTime/,
    );
  });

  it("refuses a start time with no end time", () => {
    expect(() => leaveRequestInputFrom({ ...base, startTime: "15:00" })).toThrow(/both/);
  });

  it("refuses an end time with no start time", () => {
    expect(() => leaveRequestInputFrom({ ...base, endTime: "17:00" })).toThrow(/both/);
  });
});
```

Ensure `leaveRequestInputFrom` is imported at the top of `tests/api-input.test.ts`; add it to the existing `@/lib/leave-input` import if it is not already there.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/api-input.test.ts`
Expected: FAIL. The first cases fail on `startTime` being `undefined` rather than `900`; the refusal cases fail because nothing throws.

- [ ] **Step 3: Add the fields to `LeaveRequestInput`**

In `lib/leave-service.ts`, replace the `LeaveRequestInput` type at :136:

```typescript
export type LeaveRequestInput = {
  policyId: string;
  startDate: string;
  /** Inclusive. The parser defaults it to `startDate` for a one-day request. */
  endDate: string;
  /**
   * Minutes from midnight for a USES request, null for a day-based one. Both
   * or neither — the parser refuses one without the other, and the
   * LeaveRequest_times_paired CHECK refuses it again.
   */
  startTime: number | null;
  endTime: number | null;
  reason: string | null;
};
```

- [ ] **Step 4: Parse the fields**

In `lib/leave-input.ts`, add this helper above `leaveRequestInputFrom`:

```typescript
/**
 * One `<input type="time">` value as minutes from midnight, or null when it
 * was not filled in.
 *
 * Shape only. Whether a time is *allowed* on this policy, on this date, for
 * this long is `shortLeaveTimes` in lib/leave.ts, called by the service — it
 * needs the policy's unit and the server's today, neither of which a parser
 * has any business fetching.
 */
function clockField(body: Record<string, unknown>, field: string): number | null {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === "") return null;

  if (typeof raw !== "string") {
    throw new HttpError(400, `"${field}" must be a time like "15:00".`);
  }

  const minutes = parseClockTime(raw);
  if (minutes === null) {
    throw new HttpError(400, `"${field}" must be a time like "15:00".`);
  }

  return minutes;
}
```

Then, inside `leaveRequestInputFrom`, after the `endDate < startDate` check at :34-36:

```typescript
  const startTime = clockField(body, "startTime");
  const endTime = clockField(body, "endTime");

  // Pairing is a fact about the shape of the body, so it is refused here.
  // Ordering and the four-hour cap are policy, and live in `shortLeaveTimes`.
  if ((startTime === null) !== (endTime === null)) {
    throw new HttpError(400, "Give both a start time and an end time, or neither.");
  }
```

and add `startTime` and `endTime` to the returned object at :43-48.

Add the import at the top of `lib/leave-input.ts`:

```typescript
import { parseClockTime } from "@/lib/leave";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/api-input.test.ts`
Expected: PASS.

- [ ] **Step 6: Fix the call sites the new required fields broke**

Run: `npx tsc --noEmit`
Expected: errors wherever a `LeaveRequestInput` is built without the two fields — most likely in `tests/leave.integration.test.ts`. Add `startTime: null, endTime: null` to each. Re-run until clean.

- [ ] **Step 7: Confirm the suite is green**

Run: `npm test`
Expected: all pass. Nothing observable has changed yet — the service still ignores the two fields.

- [ ] **Step 8: Commit**

```bash
git add lib/leave-input.ts lib/leave-service.ts tests/api-input.test.ts tests/leave.integration.test.ts
git commit -m "Parse short-leave times from a request body"
```

---

### Task 4: Validate and store the times

**Files:**
- Modify: `lib/leave-service.ts` — `REQUEST_FIELDS` (:72), `LeaveRequestRecord` (:144), `RequestRow` (:167), `toRecord`, and `createOwnLeaveRequest` (:436-499)
- Test: `tests/leave.integration.test.ts`

**Interfaces:**
- Consumes: `shortLeaveTimes` from `lib/leave.ts` (Task 2); `LeaveRequestInput.startTime`/`.endTime` (Task 3).
- Produces: `LeaveRequestRecord` gains `startTime: number | null` and `endTime: number | null`, read by `/approvals` and `/requests` in Task 7.

- [ ] **Step 1: Write the failing tests**

Append to `tests/leave.integration.test.ts`. The suite already creates `orgId`, `memberId` and a `memberActor()`; reuse them. It needs a `USES` policy, so create one in this block's own `beforeAll` rather than depending on another test's fixtures:

```typescript
describe("short leave times", () => {
  let shortPolicyId: string;
  let dayPolicyId: string;
  const TODAY = todayIso();

  beforeAll(async () => {
    const short = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: `${RUN} Short leave`,
        allowance: 4,
        unit: "USES",
        accrual: "UPFRONT",
        carry: false,
        effectiveFrom: new Date(`${TODAY.slice(0, 4)}-01-01T00:00:00.000Z`),
        position: 20,
      },
      select: { id: true },
    });
    shortPolicyId = short.id;

    const day = await prisma.leavePolicy.create({
      data: {
        organizationId: orgId,
        name: `${RUN} Day leave`,
        allowance: 10,
        unit: "DAYS",
        accrual: "UPFRONT",
        carry: false,
        effectiveFrom: new Date(`${TODAY.slice(0, 4)}-01-01T00:00:00.000Z`),
        position: 21,
      },
      select: { id: true },
    });
    dayPolicyId = day.id;
  });

  /** Each test files against its own member, so no two share the day. */
  const freshMember = async (local: string) => {
    const person = await prisma.user.create({
      data: {
        name: `Short ${local}`,
        email: email(`short-${local}`),
        passwordHash: "x",
        role: Role.MEMBER,
        organizationId: orgId,
        regionId: chennaiId,
      },
      select: { id: true },
    });
    return { id: person.id, role: Role.MEMBER, organizationId: orgId } as Actor;
  };

  it("stores both times on a short leave taken today", async () => {
    const actor = await freshMember("store");

    const created = await service.createOwnLeaveRequest(actor, {
      policyId: shortPolicyId,
      startDate: TODAY,
      endDate: TODAY,
      startTime: 900,
      endTime: 1020,
      reason: "Dentist",
    });

    expect(created).toMatchObject({ startTime: 900, endTime: 1020, cost: 1 });
  });

  it("refuses a short leave dated tomorrow with 400", async () => {
    const actor = await freshMember("tomorrow");

    await expect(
      service.createOwnLeaveRequest(actor, {
        policyId: shortPolicyId,
        startDate: addDays(TODAY, 1),
        endDate: addDays(TODAY, 1),
        startTime: 900,
        endTime: 1020,
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a short leave dated yesterday with 400", async () => {
    const actor = await freshMember("yesterday");

    await expect(
      service.createOwnLeaveRequest(actor, {
        policyId: shortPolicyId,
        startDate: addDays(TODAY, -1),
        endDate: addDays(TODAY, -1),
        startTime: 900,
        endTime: 1020,
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a span longer than four hours with 400", async () => {
    const actor = await freshMember("long");

    await expect(
      service.createOwnLeaveRequest(actor, {
        policyId: shortPolicyId,
        startDate: TODAY,
        endDate: TODAY,
        startTime: 540,
        endTime: 781,
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a short leave with no times at all with 400", async () => {
    const actor = await freshMember("notimes");

    await expect(
      service.createOwnLeaveRequest(actor, {
        policyId: shortPolicyId,
        startDate: TODAY,
        endDate: TODAY,
        startTime: null,
        endTime: null,
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("refuses times on a day-based policy with 400", async () => {
    const actor = await freshMember("daytimes");

    await expect(
      service.createOwnLeaveRequest(actor, {
        policyId: dayPolicyId,
        startDate: addDays(TODAY, 7),
        endDate: addDays(TODAY, 8),
        startTime: 900,
        endTime: 1020,
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("leaves a day-based request's times null", async () => {
    const actor = await freshMember("dayclean");

    const created = await service.createOwnLeaveRequest(actor, {
      policyId: dayPolicyId,
      startDate: addDays(TODAY, 14),
      endDate: addDays(TODAY, 15),
      startTime: null,
      endTime: null,
      reason: null,
    });

    expect(created.startTime).toBeNull();
    expect(created.endTime).toBeNull();
  });
});
```

Add `addDays` and `todayIso` to the file's imports if they are not already present:

```typescript
const { todayIso } = await import("@/lib/attendance");
const { addDays } = await import("@/lib/date");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/leave.integration.test.ts`
Expected: FAIL. The storing case fails because `startTime` comes back `undefined`; the four refusal cases fail because nothing throws.

- [ ] **Step 3: Select and carry the columns**

In `lib/leave-service.ts`, add to `REQUEST_FIELDS` at :72, after `cost: true`:

```typescript
  startTime: true,
  endTime: true,
```

Add the same two fields, typed `number | null`, to `RequestRow` at :167 and to `LeaveRequestRecord` at :144 — in the record, just after `cost`:

```typescript
  /**
   * Minutes from midnight for a short leave, null for a day-based request.
   * `formatClockTime` in lib/leave.ts renders them; every screen uses that
   * one formatter so they cannot drift.
   */
  startTime: number | null;
  endTime: number | null;
```

Then copy them through in `toRecord`, beside `cost`:

```typescript
    startTime: row.startTime,
    endTime: row.endTime,
```

- [ ] **Step 4: Validate and write them**

In `createOwnLeaveRequest`, immediately after `const endDate = effectiveEndDate(...)` at :448:

```typescript
  // Rules 1, 2 and 3 in one call, refusing with the same sentence the apply
  // form shows beside the inputs — the form imports this very function.
  const timeRefusal = shortLeaveTimes(
    unit,
    input.startTime,
    input.endTime,
    startDate,
    todayIso(),
  );
  if (timeRefusal) throw new HttpError(400, timeRefusal);
```

and add the two columns to the `tx.leaveRequest.create` data block at :487, after `cost`:

```typescript
        startTime: input.startTime,
        endTime: input.endTime,
```

Add `shortLeaveTimes` to the existing `@/lib/leave` import at the top of the file, and `todayIso` to the existing `@/lib/attendance` import.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/leave.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Confirm the whole suite is green**

Run: `npm test` and `npx tsc --noEmit`
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add lib/leave-service.ts tests/leave.integration.test.ts
git commit -m "Validate and store short-leave times"
```

---

### Task 5: The overlap check compares hours

**Files:**
- Modify: `lib/leave-service.ts:471-484` (the transaction in `createOwnLeaveRequest`)
- Test: `tests/leave.integration.test.ts`

**Interfaces:**
- Consumes: `timesOverlap` from `lib/leave.ts` (Task 2).
- Produces: nothing new. The behaviour of `createOwnLeaveRequest` changes for same-day requests.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("short leave times")` block from Task 4:

```typescript
  it("allows a second short leave at hours that do not overlap", async () => {
    const actor = await freshMember("gap");

    await service.createOwnLeaveRequest(actor, {
      policyId: shortPolicyId,
      startDate: TODAY,
      endDate: TODAY,
      startTime: 540,
      endTime: 600,
      reason: null,
    });

    const second = await service.createOwnLeaveRequest(actor, {
      policyId: shortPolicyId,
      startDate: TODAY,
      endDate: TODAY,
      startTime: 900,
      endTime: 1020,
      reason: null,
    });

    expect(second.startTime).toBe(900);
  });

  it("allows a second short leave that starts exactly when the first ends", async () => {
    const actor = await freshMember("touch");

    await service.createOwnLeaveRequest(actor, {
      policyId: shortPolicyId,
      startDate: TODAY,
      endDate: TODAY,
      startTime: 600,
      endTime: 660,
      reason: null,
    });

    const second = await service.createOwnLeaveRequest(actor, {
      policyId: shortPolicyId,
      startDate: TODAY,
      endDate: TODAY,
      startTime: 660,
      endTime: 720,
      reason: null,
    });

    expect(second.startTime).toBe(660);
  });

  it("refuses a second short leave at overlapping hours with 409", async () => {
    const actor = await freshMember("clash");

    await service.createOwnLeaveRequest(actor, {
      policyId: shortPolicyId,
      startDate: TODAY,
      endDate: TODAY,
      startTime: 540,
      endTime: 660,
      reason: null,
    });

    await expect(
      service.createOwnLeaveRequest(actor, {
        policyId: shortPolicyId,
        startDate: TODAY,
        endDate: TODAY,
        startTime: 600,
        endTime: 720,
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a short leave on a day already covered by a day-based request", async () => {
    const actor = await freshMember("covered");

    await service.createOwnLeaveRequest(actor, {
      policyId: dayPolicyId,
      startDate: TODAY,
      endDate: TODAY,
      startTime: null,
      endTime: null,
      reason: null,
    });

    await expect(
      service.createOwnLeaveRequest(actor, {
        policyId: shortPolicyId,
        startDate: TODAY,
        endDate: TODAY,
        startTime: 900,
        endTime: 1020,
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("refuses a day-based request on a day already holding a short leave", async () => {
    const actor = await freshMember("reverse");

    await service.createOwnLeaveRequest(actor, {
      policyId: shortPolicyId,
      startDate: TODAY,
      endDate: TODAY,
      startTime: 900,
      endTime: 1020,
      reason: null,
    });

    await expect(
      service.createOwnLeaveRequest(actor, {
        policyId: dayPolicyId,
        startDate: TODAY,
        endDate: TODAY,
        startTime: null,
        endTime: null,
        reason: null,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/leave.integration.test.ts`
Expected: FAIL. The two "allows" cases fail with a 409 from the current date-only check; the three "refuses" cases already pass, which is expected — they are there to prove the new branch does not lose the behaviour that already works.

- [ ] **Step 3: Replace the clash query and check**

In `createOwnLeaveRequest`, replace the transaction body at :471-484:

```typescript
  const row = await prisma.$transaction(async (tx) => {
    // Candidates, not a verdict: the date query is what an index can answer,
    // and the time comparison below is over the handful of rows it returns.
    const sameDays = await tx.leaveRequest.findMany({
      where: {
        userId: actor.id,
        status: { in: SPENT },
        // Overlap, not containment: sharing a single day is enough to be a
        // candidate.
        startDate: { lte: toDbDate(endDate) },
        endDate: { gte: toDbDate(startDate) },
      },
      select: { id: true, startTime: true, endTime: true },
    });

    const timed = input.startTime !== null && input.endTime !== null;
    const clash = sameDays.find((existing) => {
      // Either side being a whole-day absence settles it: there is no
      // afternoon to take off a day already spent, and no day left to spend
      // on an afternoon already taken.
      if (!timed || existing.startTime === null || existing.endTime === null) {
        return true;
      }
      return timesOverlap(
        input.startTime as number,
        input.endTime as number,
        existing.startTime,
        existing.endTime,
      );
    });

    if (clash) {
      throw new HttpError(
        409,
        timed && clash.startTime !== null
          ? "You already have a short leave covering those hours."
          : "You already have a request covering those dates.",
      );
    }

    return tx.leaveRequest.create({
      data: {
        organizationId,
        userId: actor.id,
        policyId: policy.id,
        startDate: toDbDate(startDate),
        endDate: toDbDate(endDate),
        startTime: input.startTime,
        endTime: input.endTime,
        cost,
        reason: input.reason,
        approverId: approver?.id ?? null,
      },
      select: REQUEST_FIELDS,
    });
  });
```

Keep the comment above the transaction about the race it narrows rather than closes — it is still true, and still the reason there is no exclusion constraint.

Add `timesOverlap` to the existing `@/lib/leave` import.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/leave.integration.test.ts`
Expected: PASS, all cases including the three that passed before.

- [ ] **Step 5: Confirm the whole suite is green**

Run: `npm test`
Expected: all pass. Watch particularly for existing overlap tests elsewhere in the file — the day-based behaviour must be unchanged.

- [ ] **Step 6: Commit**

```bash
git add lib/leave-service.ts tests/leave.integration.test.ts
git commit -m "Compare hours when two short leaves share a day"
```

---

### Task 6: The apply form pins the date and asks for times

**Files:**
- Modify: `components/apply-form.tsx`
- Modify: `app/(member)/apply/page.tsx:78-85` (the `<ApplyForm>` props)

**Interfaces:**
- Consumes: `parseClockTime`, `formatClockTime`, `shortLeaveTimes`, `MAX_SHORT_LEAVE_MINUTES` from `lib/leave.ts` (Task 2).
- Produces: a form that posts `startTime` and `endTime` as `"HH:MM"` strings, which Task 3's parser reads.

- [ ] **Step 1: Add a `today` prop and pin the date**

In `components/apply-form.tsx`, add `today: string` to the props type and destructuring. Then, below the existing `isUses` line at :50:

```typescript
  // A short leave is for today, so the date stops being a choice. Snapping it
  // in the render rather than in an effect keeps the posted value and the
  // shown value the same on the very first frame — an effect would submit
  // whatever the previous selection left behind if the member is quick.
  const start = isUses ? today : from;
  const end = isUses ? start : to;
```

Replace the existing `const end = isUses ? from : to;` line with the two above, and use `start` in place of `from` for the From input's `value` and for `costFrom`.

Disable the From input when `isUses`:

```tsx
            <input
              type="date"
              name="startDate"
              value={start}
              disabled={isUses}
              onChange={(event) => setFrom(event.target.value)}
              className={`${inputClass} disabled:text-muted`}
            />
```

- [ ] **Step 2: Add the two time inputs and the live refusal**

Add state beside the existing `from`/`to` state:

```typescript
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
```

and, after the `start`/`end` lines:

```typescript
  const startMinutes = parseClockTime(startTime);
  const endMinutes = parseClockTime(endTime);
  // The same function lib/leave-service.ts refuses with, so the sentence the
  // member reads beside the inputs is the sentence the server would have
  // sent — not a second copy of the rule that drifts from it.
  const timeRefusal = isUses
    ? shortLeaveTimes(unit, startMinutes, endMinutes, start, today)
    : null;
  const spanMinutes =
    startMinutes !== null && endMinutes !== null ? endMinutes - startMinutes : 0;
```

Render the inputs immediately after the From/To grid, replacing the existing `{isUses ? ... }` hint block:

```tsx
        {isUses ? (
          <>
            <div className="grid gap-3.5 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5 text-xs text-muted">
                Start time
                <input
                  type="time"
                  name="startTime"
                  value={startTime}
                  required
                  onChange={(event) => setStartTime(event.target.value)}
                  className={inputClass}
                />
              </label>

              <label className="flex flex-col gap-1.5 text-xs text-muted">
                End time
                <input
                  type="time"
                  name="endTime"
                  value={endTime}
                  required
                  onChange={(event) => setEndTime(event.target.value)}
                  className={inputClass}
                />
              </label>
            </div>

            {timeRefusal ? (
              <p className="rounded-lg border border-danger-line bg-danger-tint px-3.5 py-2.5 text-[12.5px] text-danger">
                {timeRefusal}
              </p>
            ) : (
              <p className="rounded-lg bg-subtle px-3 py-2.5 text-[12.5px] text-muted">
                {spanMinutes > 0
                  ? `${formatClockTime(startMinutes as number)} – ${formatClockTime(
                      endMinutes as number,
                    )} today, ${spanMinutes} minutes.`
                  : `Today only, up to ${MAX_SHORT_LEAVE_MINUTES / 60} hours.`}
              </p>
            )}
          </>
        ) : null}
```

- [ ] **Step 3: Disable the button while a refusal is showing**

Replace the submit button:

```tsx
          <button
            type="submit"
            disabled={timeRefusal !== null}
            className={primaryButtonClass}
          >
            Submit request
          </button>
```

Add `MAX_SHORT_LEAVE_MINUTES`, `formatClockTime`, `parseClockTime` and `shortLeaveTimes` to the existing `@/lib/leave` import at the top of the file.

- [ ] **Step 4: Pass `today` from the page**

In `app/(member)/apply/page.tsx`, add `today={today}` to the `<ApplyForm>` props. The page already computes `const today = todayIso();` at :33.

- [ ] **Step 5: Prove the form post actually carries the times**

The action needs no change — `submitLeaveRequestAction` (`lib/leave-actions.ts:28`) already passes `formBody(form)` straight to `leaveRequestInputFrom`. This test exists because that is an assumption, and an untested assumption about the one seam between the browser and the service is the one worth pinning.

Append to `tests/leave-actions.test.ts`, following the fixtures already in that file:

```typescript
describe("submitLeaveRequestAction — short leave", () => {
  it("files a short leave with both times and sends the member to /requests", async () => {
    const form = new FormData();
    form.set("policyId", shortPolicyId);
    form.set("startDate", todayIso());
    form.set("startTime", "15:00");
    form.set("endTime", "17:00");
    form.set("reason", "Dentist");

    await expect(actions.submitLeaveRequestAction(form)).rejects.toThrow("NEXT_REDIRECT");

    const stored = await prisma.leaveRequest.findFirst({
      where: { userId: memberId, policyId: shortPolicyId },
      select: { startTime: true, endTime: true, cost: true },
    });
    expect(stored).toMatchObject({ startTime: 900, endTime: 1020, cost: 1 });
  });

  it("sends a four-hour refusal back to /apply with the message", async () => {
    const form = new FormData();
    form.set("policyId", shortPolicyId);
    form.set("startDate", todayIso());
    form.set("startTime", "09:00");
    form.set("endTime", "14:00");

    await expect(actions.submitLeaveRequestAction(form)).rejects.toThrow("NEXT_REDIRECT");

    expect(nav.redirectedTo).toContain("/apply?error=");
    expect(decodeURIComponent(nav.redirectedTo)).toContain("four hours");
  });
});
```

`shortPolicyId` is a `USES` policy created in this file's `beforeAll` the same way Task 4 creates one; add it if the file has none. Run `npx vitest run tests/leave-actions.test.ts` — expect the first case to fail on null times before Task 6's inputs exist, then pass once the form posts them.

- [ ] **Step 6: Check the file has not grown unwieldy**

Run: `wc -l components/apply-form.tsx`
Expected: under roughly 220 lines. If it is over, move the timed branch into a new `components/short-leave-fields.tsx` taking `{ startTime, endTime, onStartTime, onEndTime, refusal, spanMinutes }` and render it from the form — spec §7 calls for exactly this split at exactly this threshold.

- [ ] **Step 7: Verify types, lint and build**

Run: `npx tsc --noEmit`, `npm run lint`, `npm run build`
Expected: all clean. The build is what proves `lib/leave.ts` is still client-safe now that a client component imports four more of its functions.

- [ ] **Step 8: Commit**

```bash
git add components/apply-form.tsx "app/(member)/apply/page.tsx" tests/leave-actions.test.ts
git commit -m "Pin short leave to today and ask for a time range"
```

---

### Task 7: Show the hours to the approver and the member

**Files:**
- Modify: `lib/leave.ts` (append after `formatClockTime` from Task 2)
- Modify: `components/approval-queue.tsx:91` and `:137`
- Modify: `app/(member)/requests/page.tsx:70` and `:91`
- Test: `tests/leave.test.ts`

**Interfaces:**
- Consumes: `formatClockTime` from `lib/leave.ts` (Task 2); `formatRange` from `lib/date.ts` (:120).
- Produces: `formatWhen(startDate, endDate, startTime, endTime): string`, exported from `lib/leave.ts`.

**Why `lib/leave.ts` and not `lib/date.ts`:** `lib/leave.ts` already imports `addDays` and `isWeekend` from `lib/date.ts`, and `lib/date.ts` imports nothing at all. Putting `formatWhen` in `date.ts` would make it import `formatClockTime` back out of `leave.ts` and close a cycle. It goes where the dependency already points.

- [ ] **Step 1: Write the failing tests**

Append to `tests/leave.test.ts`:

```typescript
describe("formatWhen", () => {
  it("renders a single day with no times as the date alone", () => {
    expect(formatWhen("2026-09-17", "2026-09-17", null, null)).toBe("Sep 17");
  });

  it("renders a span with no times as a date range", () => {
    expect(formatWhen("2026-09-17", "2026-09-21", null, null)).toBe("Sep 17 – Sep 21");
  });

  it("appends the hours to a timed day", () => {
    expect(formatWhen("2026-09-17", "2026-09-17", 900, 1020)).toBe(
      "Sep 17 · 3:00 PM – 5:00 PM",
    );
  });
});
```

Add `formatWhen` to the existing `@/lib/leave` import block at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/leave.test.ts`
Expected: FAIL with `formatWhen is not a function`.

- [ ] **Step 3: Write the formatter**

Append to `lib/leave.ts`, after `formatClockTime`:

```typescript
/**
 * When a leave request happens, for the one line every screen shows.
 *
 * `Sep 17` for a day, `Sep 17 – Sep 21` for a span, and
 * `Sep 17 · 3:00 PM – 5:00 PM` for a short leave. One function rather than
 * two call sites formatting a row each, so /approvals and the member's own
 * list cannot describe the same request two different ways.
 */
export function formatWhen(
  from: string,
  to: string,
  startTime: number | null,
  endTime: number | null,
): string {
  const dates = formatRange(from, to);
  if (startTime === null || endTime === null) return dates;
  return `${dates} · ${formatClockTime(startTime)} – ${formatClockTime(endTime)}`;
}
```

Extend the existing first-line import of `lib/leave.ts` to pull in `formatRange`:

```typescript
import { addDays, formatRange, isWeekend } from "@/lib/date";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/leave.test.ts`
Expected: PASS.

- [ ] **Step 5: Use it on both screens**

In `components/approval-queue.tsx`, replace both call sites:

```tsx
                  {formatWhen(
                    request.startDate,
                    request.endDate,
                    request.startTime,
                    request.endTime,
                  )}
```

at :91, and at :137:

```tsx
                        value: formatWhen(
                          selected.startDate,
                          selected.endDate,
                          selected.startTime,
                          selected.endTime,
                        ),
```

Make the same two replacements in `app/(member)/requests/page.tsx` at :70 and :91. In both files, drop `formatRange` from the `@/lib/date` import if nothing else there uses it, and add `formatWhen` to the `@/lib/leave` import.

- [ ] **Step 6: Verify types, lint and build**

Run: `npx tsc --noEmit`, `npm run lint`, `npm run build`
Expected: all clean. A type error here means `ReviewRequestRecord` in `lib/leave-review-service.ts` does not carry the times — add `startTime` and `endTime` to it and to its field selection the way Task 4 did for `LeaveRequestRecord`.

- [ ] **Step 7: Commit**

```bash
git add lib/leave.ts components/approval-queue.tsx "app/(member)/requests/page.tsx" tests/leave.test.ts
git commit -m "Show short-leave hours on approvals and requests"
```

---

### Task 8: Verification pass

**Files:** none — this task changes nothing and exists to prove the rest.

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: every test passes. Record the count and compare it with the count before this plan started.

- [ ] **Step 2: Types, lint and build**

Run: `npx tsc --noEmit`, `npm run lint`, `npm run build`
Expected: all three silent or clean.

- [ ] **Step 3: Restart the dev server before touching the browser**

Run: stop any running `next dev`, then `npm run dev`.
This is not optional. A dev server started before Task 1's migration holds the old Prisma Client and will throw `Unknown argument 'startTime'` on a page that the test suite proves is correct.

- [ ] **Step 4: Walk the spec's rules against the running app**

Signed in as a member on `/apply`:
- Rule 2: picking Short leave snaps **From** to today and disables it; the To field stays hidden.
- Rule 1: the two time inputs appear for Short leave and for no other type.
- Rule 3: 9:00 AM to 2:00 PM shows the four-hour refusal and disables the button; 9:00 AM to 1:00 PM is accepted.
- Rule 4: a range already past today is accepted.
- Rule 5: file 9:00–10:00, then 3:00–5:00 — both succeed.
- Rule 7: file 10:00–11:00, then 11:00–12:00 — both succeed.
- Overlap: file 9:00–11:00 against the existing 9:00–10:00 — refused, and the message names hours rather than dates.

Then signed in as that member's manager on `/approvals`:
- Rule G4: the queue row and the detail panel both read `<date> · 3:00 PM – 5:00 PM`.
- Approve it, and confirm on the member's `/apply` that the Short leave balance dropped by exactly one use (rule 8).

- [ ] **Step 5: Commit anything the walk corrected, then open the PR**

```bash
git push -u origin <branch>
gh pr create --title "Timed short leave" --body "Implements Docs/2026-09-17-short-leave-timed-design.md"
```
