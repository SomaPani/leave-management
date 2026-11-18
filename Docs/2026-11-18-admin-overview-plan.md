# Admin Overview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new **Overview** screen in the admin panel, first in the sidebar above **Approvals**, that shows how many people are **Present, WFH, Absent and On leave** today; clicking an employee's name opens their history for a **month, quarter or year** — which dates they were present, WFH, absent or on leave — with an **Export** button that downloads it.

**Architecture:** One pure module decides what a day *is* for a person (attendance mark, approved leave, holiday, weekend). One service reads the rows for a day or a range and runs them through it. A page at `/dashboard` shows the today cards and the people list; `/dashboard/[userId]` shows one person's period; `GET /api/attendance/export` returns the same period as a CSV file (opens in Excel / Google Sheets). Nothing new is stored — no migration.

**Tech Stack:** Next.js 16 App Router (server components, route handler), Prisma 7 + Postgres, Tailwind, Vitest.

**Spec:** the user's request of 2026-11-18 and the Team screen screenshot (admin sidebar: Approvals, Attendance, Team, Leave setup, Employee score board, Holiday calendar).

## What it will look like

```
STACX24            Overview                                   Wed, Nov 18
                   Who is in today, at a glance.               ADMIN VIEW
▸ Overview        ┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌──────────┐
  Approvals  (2)  │ Present  ││   WFH    ││  Absent  ││ On leave ││Not marked│
  Attendance      │    4     ││    1     ││    0     ││    1     ││    1     │
  Team            │ of 7     ││          ││          ││          ││ Mark now→│
  ...             └──────────┘└──────────┘└──────────┘└──────────┘└──────────┘

                   [All] [Present] [WFH] [Absent] [On leave] [Not marked]
                   PERSON                       REGION    TODAY
                   Gokul N  · Ai Engineer       Chennai   Present
                   Kavin N  · FDE               Chennai   On leave (EL)
                   Sahil Thakur · Developer     Delhi     WFH
```

Clicking **Gokul N** opens `/dashboard/<id>`:

```
← Overview      Gokul N · Ai Engineer · STX-008 · Chennai
                [Month] [Quarter] [Year]     ‹  November 2026  ›     [Export CSV]

                Present 12   WFH 3   Absent 1   On leave 2   Not marked 0
                (working days so far: 18 · holidays 1 · weekends excluded)

                DATE          DAY   STATUS       DETAIL
                Nov 2         Mon   Present
                Nov 3         Tue   WFH
                Nov 4         Wed   On leave     Earned Leave (EL) — approved
                Nov 5         Thu   Present      Half day
                Nov 6         Fri   Absent
                ...
```

The CSV has the same table: `Date, Day, Status, Detail`, then a blank line and the totals, file name `Gokul-N_2026-11.csv` / `Gokul-N_2026-Q4.csv` / `Gokul-N_2026.csv`.

## Decisions (made here; change them before Task 1 if you disagree)

1. **URL `/dashboard`, label "Overview".** `/overview` already belongs to the member screens (`app/(member)/overview`); two route groups cannot both own one path.
2. **It becomes the admin's home page.** `HOME_FOR_ROLE.ADMIN` changes from `/approvals` to `/dashboard`, so logging in lands on Overview. Approvals keeps its badge.
3. **What a day is, in this order — first match wins:**
   1. A future date → not counted.
   2. An **attendance mark** exists → that mark (`PRESENT`, `WFH`, `ABSENT`, `LEAVE`). The admin's mark is what actually happened, so it beats everything below. `HALF_DAY` / `SHORT_LEAVE` modifiers stay with their base status and appear in Detail.
   3. An **approved leave request** for a **day-based** policy covers the date → **On leave** (Detail = policy name). Short leave (`USES` policy) does not make a day "on leave".
   4. A **holiday** for the whole org or the person's region → **Holiday**.
   5. Saturday or Sunday → **Weekend**.
   6. Otherwise → **Not marked**.
   Holiday and Weekend are listed in the day table (so the CSV is a full calendar) but are not in the five counts.
4. **Quarters are calendar quarters** (Q1 = Jan–Mar … Q4 = Oct–Dec). If the company counts Apr–Mar, that is one constant in Task 1.
5. **Periods stop at today.** November 2026 on Nov 18 covers Nov 1–18. A past month is complete.
6. **Who is listed:** active members of the admin's own organization (`role MEMBER`, `status ACTIVE`), like the Attendance screen. Past members are reachable by URL for their history but not listed.
7. **Export is CSV**, not .xlsx — no new library, opens directly in Excel and Google Sheets.

## Global Constraints

- Admin only. The page sits under `app/(leave)/` (guarded by `requirePageRole(Role.ADMIN)`); the service and the export route check `canListAttendance(actor)` and scope by `visibleOrgId(actor)`. A `userId` from another organization returns **404**, never data.
- Dates are ISO strings `YYYY-MM-DD` in `ATTENDANCE_TIMEZONE` (Asia/Kolkata) via `todayIso()`; DB dates through `toDbDate` / `fromDbDate` (`lib/attendance.ts`).
- At most four queries per page whatever the period: members, attendance marks in range, approved DAYS leave overlapping the range, holidays in range. No query per day.
- CSV cells are escaped (quotes doubled, cells with `,` `"` or newline wrapped in quotes) and any cell starting with `= + - @` is prefixed with `'` (spreadsheet formula injection — names and policy names are typed by people).
- Look of the page follows the existing screens: `components/ui.tsx` primitives, the Team table style, brand colours already in `app/globals.css`.
- `npm test`, `npx tsc --noEmit`, `npm run lint` clean after every task.

## Review Focus

- Leave approved **and** an attendance mark on the same day → the mark wins. Tested in Task 1.
- A holiday for **another region** must not turn this person's day into Holiday. Tested in Task 1.
- Multi-day leave that **starts before** the period or **ends after** it → only the days inside the period count. Tested in Task 2.
- A person who **joined mid-period** → days before `joinedOn` (if set) are not "Not marked". Tested in Task 1 (`resolveDay` takes `joinedOn`).
- An admin opening `/dashboard/<id>` or the export for **another org's member** → 404. Tested in Task 2 and Task 4.

---

### Task 1: `lib/day-status.ts` — what a day is (pure)

**Files:**
- Create: `lib/day-status.ts`
- Create: `tests/day-status.test.ts`

**Interfaces:**
- Produces:
  - `type DayKind = "PRESENT" | "WFH" | "ABSENT" | "LEAVE" | "NOT_MARKED" | "HOLIDAY" | "WEEKEND"`
  - `type DayFacts = { date: string; today: string; joinedOn: string | null; mark: { status: AttendanceStatus; modifier: AttendanceModifier | null } | null; leave: { policyName: string } | null; holiday: { name: string } | null }`
  - `type ResolvedDay = { date: string; kind: DayKind; detail: string | null }`
  - `resolveDay(facts: DayFacts): ResolvedDay | null` — null for a future date or a date before `joinedOn`.
  - `type Period = "month" | "quarter" | "year"`
  - `periodRange(period: Period, anchor: string, today: string): { from: string; to: string; label: string }` — `anchor` is any date inside the period; `to` is clipped to `today`; labels `November 2026`, `Q4 2026`, `2026`.
  - `shiftPeriod(period: Period, anchor: string, steps: number): string` — for the ‹ › arrows.
  - `countDays(days: ResolvedDay[]): Record<"PRESENT" | "WFH" | "ABSENT" | "LEAVE" | "NOT_MARKED", number>`
  - `QUARTER_START_MONTH = 1` (January; change to 4 for Apr–Mar).

- [ ] **Step 1: Failing tests** — `tests/day-status.test.ts`:
  - mark `PRESENT` + approved leave on the same date → `PRESENT`.
  - mark `PRESENT` with `HALF_DAY` → kind `PRESENT`, detail `"Half day"`.
  - no mark + leave `{ policyName: "Earned Leave (EL)" }` → `LEAVE`, detail `"Earned Leave (EL)"`.
  - no mark + holiday → `HOLIDAY` with its name; no mark on a Saturday → `WEEKEND`; no mark on a weekday → `NOT_MARKED`.
  - leave on a weekend with no mark → `WEEKEND` (leave is charged in working days only).
  - date after `today` → `null`; date before `joinedOn` → `null`.
  - `periodRange("month", "2026-11-05", "2026-11-18")` → `{ from: "2026-11-01", to: "2026-11-18", label: "November 2026" }`.
  - `periodRange("quarter", "2026-08-10", "2026-11-18")` → `{ from: "2026-07-01", to: "2026-09-30", label: "Q3 2026" }`.
  - `periodRange("year", "2025-03-01", "2026-11-18")` → `{ from: "2025-01-01", to: "2025-12-31", label: "2025" }`.
  - `shiftPeriod("month", "2026-01-15", -1)` → a date in December 2025; `shiftPeriod("quarter", "2026-11-18", 1)` → a date in Q1 2027.
  - `countDays` ignores `HOLIDAY` and `WEEKEND`.
- [ ] **Step 2: Run, watch fail** — `npx vitest run tests/day-status.test.ts`
- [ ] **Step 3: Implement.** Weekday from the existing `dayOfWeek` in `lib/date.ts`. `lib/day-status.ts` imports only `lib/date.ts` and Prisma enums (keep `tests/module-graph.test.ts` green).
- [ ] **Step 4: Run, commit** — `git commit -m "Decide what a day is for a person: mark, leave, holiday or weekend"`

---

### Task 2: `lib/overview-service.ts` — today's roster and one person's period

**Files:**
- Create: `lib/overview-service.ts`
- Create: `tests/overview.integration.test.ts`

**Interfaces:**
- Consumes: Task 1; `canListAttendance`, `visibleOrgId`, `HttpError` (`lib/rbac.ts`); `toDbDate`, `fromDbDate`, `todayIso` (`lib/attendance.ts`).
- Produces:
  - `type OverviewPerson = { id: string; name: string; title: string | null; empId: string | null; region: string | null; today: ResolvedDay }`
  - `todayOverview(actor: Actor, today?: string): Promise<{ date: string; counts: ReturnType<typeof countDays>; total: number; people: OverviewPerson[] }>` — people sorted by name; a person whose today resolves to HOLIDAY/WEEKEND keeps that kind.
  - `memberPeriod(actor: Actor, userId: string, period: Period, anchor: string, today?: string): Promise<{ member: { id; name; title; empId; region }; range: { from; to; label }; days: ResolvedDay[]; counts: ReturnType<typeof countDays> }>` — `days` newest first; 404 when the member is not in the caller's organization.
  - Shared private helper `factsFor(members, from, to)` doing the four range queries (members, `attendance` in range, `leaveRequest` with `status APPROVED`, policy `unit DAYS`, `startDate <= to`, `endDate >= from`, and `holiday` in range with `regionId null or = member.regionId`).

- [ ] **Step 1: Failing integration tests** (pattern: `tests/leave-notifications.integration.test.ts` — create an org, an admin, 3 members, a DAYS and a USES policy, a region holiday):
  - `todayOverview` with today `2026-11-18`: member A marked PRESENT, B marked WFH, C with approved EL covering the date and no mark → counts `{ PRESENT: 1, WFH: 1, LEAVE: 1, ABSENT: 0, NOT_MARKED: 0 }`, `total` 3.
  - A **pending** or **rejected** leave does not count as LEAVE; an approved **short leave** does not either.
  - `memberPeriod(..., "month", "2026-11-05", "2026-11-18")` for C with EL 2026-10-30 → 2026-11-03 → only Nov 2 and Nov 3 are LEAVE (Nov 1 is a Sunday), days stop at Nov 18.
  - Region holiday for **Delhi** does not mark a **Chennai** member's day HOLIDAY; an org-wide holiday does.
  - Another org's admin calling `memberPeriod` for C → rejects with status 404; a MEMBER actor → 403.
- [ ] **Step 2: Run, watch fail** — `npx vitest run tests/overview.integration.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, commit** — `git commit -m "Read today's overview and one member's period"`

---

### Task 3: The Overview page and the sidebar

**Files:**
- Create: `app/(leave)/dashboard/page.tsx`
- Create: `app/(leave)/dashboard/[userId]/page.tsx`
- Modify: `app/(leave)/layout.tsx` (NAV: add `{ href: "/dashboard", label: "Overview" }` **first**, above Approvals)
- Modify: `components/sidebar.tsx` (`ADMIN_NAV`, same item first — the legacy sidebar, kept in step)
- Modify: `lib/page-guards.ts` (`HOME_FOR_ROLE.ADMIN = "/dashboard"`)
- Modify: tests that assert the admin home (`grep -rn '"/approvals"' tests` — update the expectation)

**Interfaces:**
- Consumes: `todayOverview`, `memberPeriod` (Task 2); `Period`, `shiftPeriod` (Task 1).

- [ ] **Step 1: `/dashboard`** — header "Overview", subtitle "Who is in today, at a glance.", today's date on the right. Five count cards (Present, WFH, Absent, On leave, Not marked) in a responsive grid (5 across on desktop, 2 on phone); "Not marked" links to `/attendance` when > 0. Filter chips via `?show=present|wfh|absent|leave|unmarked` (server-side filter, no client JS). Table: name (link to `/dashboard/<id>`), title · empId, region, today's status as a coloured badge with detail. Empty org → the same empty state wording the Team screen uses.
- [ ] **Step 2: `/dashboard/[userId]`** — reads `?period=month|quarter|year` (default month) and `?at=YYYY-MM-DD` (default today); invalid values fall back to the defaults. Period tabs, ‹ › links built with `shiftPeriod` (› disabled when the next period starts after today), the five counts, the day table (Date, Day, Status, Detail) and an **Export CSV** link to `/api/attendance/export?userId=…&period=…&at=…`. A 404 from the service renders `notFound()`.
- [ ] **Step 3: Sidebar + home** as listed above.
- [ ] **Step 4: Verify in the browser** (dev server): log in as an admin → lands on Overview; Overview is above Approvals and highlighted; counts match the Attendance screen for today; click a name → month view; switch Quarter and Year; arrows move periods.
- [ ] **Step 5: `npm test`, tsc, lint; commit** — `git commit -m "Add the admin Overview screen with per-person history"`

---

### Task 4: Export

**Files:**
- Create: `lib/csv.ts` + `tests/csv.test.ts`
- Create: `app/api/attendance/export/route.ts`
- Create: `tests/attendance-export.integration.test.ts`

**Interfaces:**
- Produces: `toCsv(rows: (string | number)[][]): string` (CRLF line ends, escaping and formula guard per Global Constraints); `GET /api/attendance/export?userId&period&at` → `200 text/csv; charset=utf-8` with a UTF-8 BOM (so Excel shows non-ASCII names), `Content-Disposition: attachment; filename="<Name>_<label>.csv"` (name with spaces → `-`, anything outside `[A-Za-z0-9-_]` dropped).

- [ ] **Step 1: Failing tests** — `toCsv`: a cell with a comma, a quote and a newline; a cell `=SUM(A1)` comes out `'=SUM(A1)`. Route: admin → 200, header filename `Run-Member_2026-11.csv`, body starts with BOM + `Date,Day,Status,Detail`, contains a totals block; member actor → 403; other org's admin → 404; bad `period` → 400.
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement** — route calls `memberPeriod`, maps `days` (oldest first in the file) to rows, appends a blank row and `Present,<n>` … `Not marked,<n>`; `errorResponse` for failures (as `app/api/leave-requests/[id]/route.ts` does).
- [ ] **Step 4: Run, commit** — `git commit -m "Export one person's month, quarter or year as CSV"`

---

### Task 5: Ship

- [ ] Full suite, tsc, lint clean. PR → merge to `main`.
- [ ] Server: back up the DB; `cd /opt/leave-management && git pull && npm ci && npm run build && pm2 restart leave-management`. **No migration.**
- [ ] On https://leave-management.stacx24.com as an admin: lands on Overview; counts match today's Attendance; open a person; Month / Quarter / Year; Export opens in Excel with the right dates.

## Out of scope

- A whole-team export (everyone × every day) — easy follow-up on the same service.
- Charts / trends over time.
- Member-side changes (`/overview` for members stays as it is).
- Automatically writing `LEAVE` attendance marks when leave is approved (this plan *reads* approved leave instead, so nothing is written twice).
