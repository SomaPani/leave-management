# Employee Dashboard (Attendance Report) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an **Employee dashboard** page to the **admin** sidebar, directly under **Holiday calendar**, with the seven sections from the reference mockup *"Attendance Report Dashboard — Step-by-Step Guide"*: filters, overall summary, employee-wise table, attendance percentage, one member's daily calendar, monthly / quarterly / yearly trend, and Excel / PDF export. Members do not get this page.

**Architecture:** Read-only. No schema change and no migration. Everything is computed from tables that already exist (`Attendance`, `Holiday`, `User`, `Region`) through the existing scoped readers in `lib/attendance-service.ts` (`listRangeAttendance`, `listMemberMonth`), so organization scoping and RBAC stay in one place. The aggregation is a new **pure** module (`lib/attendance-report.ts`), unit-tested the same way `lib/attendance-month.ts` is, and it reuses `dayValue()` from that file so the percentage on this page cannot disagree with the member's own calendar. The page is a Server Component driven entirely by URL search params (`?member=&team=&period=&month=&year=&tab=&view=`), so filters are shareable links and need no client state. Export is a Route Handler that returns the same report as a file.

**Tech Stack:** Next.js 16 (App Router, Server Components — read `node_modules/next/dist/docs/` first per AGENTS.md), Prisma 7, Tailwind 4, Vitest. Charts are inline SVG (no chart library is installed and none is needed for one donut and one line).

**Spec:** the user's request of 2026-11-20 — "in admin view, under the holiday calendar, create one more section Employee dashboard" from the attached mockup.

## As built (2026-11-20, branch `feature/employee-dashboard`)

The plan was written against `feature/leave-decision-email`; `main` had since gained the admin Overview (`Docs/2026-11-18-admin-overview-plan.md`). The build reuses it instead of duplicating it:

- Days come from `teamPeriod()` in `lib/overview-service.ts`, which uses the Overview's `resolveRange` + `lib/day-status.ts` rule — so approved leave fills unmarked days, holidays are per region, and days before `joinedOn` or after today are skipped, exactly as on `/dashboard/[userId]`.
- Periods use `periodRange()` from `lib/day-status.ts`; CSV uses `toCsv()` from `lib/csv.ts` (formula guard included).
- All five decisions were taken at their defaults (Team = Region, existing % rule, CSV, print-to-PDF, `/employee-dashboard`).
- Section 4 is a single-value ring (overall %) plus a labelled per-status bar list, not a four-colour donut: the app's green/red/blue/amber failed the colour-blind and normal-vision separation checks when adjacent in a ring.
- Section 6's tabs switch the page's period (one source of numbers), rather than being an independent chart control.
- `/employee-dashboard` is added to `proxy.ts` (ADMIN only). The admin layout hides the sidebar under `print:`.

## How it works, in simple terms

1. **Soma (admin) clicks "Employee dashboard"** in the sidebar, below "Holiday calendar".
2. **The page opens on the current month, all members, all teams.**
3. **Section 1 – Filters:** Employee, Team, Period (Monthly / Quarterly / Yearly), Month (or Quarter), Year, **Apply**. Apply just reloads the page with new URL params. "Last updated" shows the time of the newest attendance change in the range.
4. **Section 2 – Summary cards:** Total working days · Present · Absent · WFH · Leave for the filtered selection.
5. **Section 3 – Table:** one row per member: Name, Team, Total days, Present, Absent, WFH, Leave, Attendance %, with a colour band (green ≥ 90 %, amber 75–89 %, red < 75 %). Clicking a name opens that member in section 5.
6. **Section 4 – Donut:** overall Present / Absent / WFH / Leave split, the overall %, and a one-line **Key insight** worked out from the numbers (e.g. "Attendance is above 90 % this month", "3 members are below 75 %").
7. **Section 5 – Daily details:** the selected member's month as a calendar (P / A / WFH / L, holidays and weekends shown). Reuses `buildMonthCells()` — the same grid the member sees on /calendar.
8. **Section 6 – Trend:** tabs Monthly / Quarterly / Yearly. Monthly = attendance % per week of the month; Quarterly = per month of the quarter; Yearly = per month of the year.
9. **Section 7 – Export:** **Export to Excel** downloads the table; **Export to PDF** opens a print-ready version of the page. Both respect the current filters.

## Decisions to confirm before Task 1

These change what is built. Defaults shown in **bold**; the plan is written for the defaults.

| # | Question | Options | Default |
|---|----------|---------|---------|
| D1 | What is "Team"? `User` has no team/department column. | **Region** (what the Team screen already groups by) · Manager · add a new `department` column (needs a migration) | **Region** |
| D2 | Attendance % formula | **Existing rule** from `lib/attendance-month.ts`: worked ÷ marked non-leave days, half-day = 0.5 (matches the member's own calendar) · Mockup rule: present ÷ total working days | **Existing rule** |
| D3 | Excel format | **CSV with UTF-8 BOM** (opens in Excel, no new dependency) · real `.xlsx` via `exceljs` (adds a dependency) | **CSV** |
| D4 | PDF format | **Print view + browser "Save as PDF"** (no dependency) · server-generated PDF (adds a heavy dependency) | **Print view** |
| D5 | Route path | **`/employee-dashboard`** · `/attendance-report` | **`/employee-dashboard`** |

Note: there is no `/dashboard` route in the app today. `https://leave-management.stacx24.com/dashboard` lands wherever `HOME_FOR_ROLE[ADMIN]` sends it. The new page is added to the existing admin `(leave)` layout, which is the sidebar shown there.

## Global Constraints

- **Admin only.** The page lives under `app/(leave)/`, whose layout already calls `requirePageRole(Role.ADMIN)`. The export route checks the same with `canListAttendance` and returns 403 otherwise.
- **Own organization only.** All reads go through `listRangeAttendance` / `listMemberMonth`, which apply `visibleOrgId`. A member id or region id from another organization returns nothing, never an error that confirms it exists.
- **Read-only.** No writes, no new tables, no migration.
- **Working days** = weekdays in the period, minus holidays that apply to the member's region (org-wide + their region), minus days before `joinedOn`, and not counting future days. Summary "Total working days" uses org-wide holidays only. Reuse `isWeekend` / `lib/holidays.ts`; do not write a second holiday rule.
- **Unmarked past working days** are shown as a separate "Not marked" count, not silently treated as absent.
- **Only ACTIVE members** are listed, like `listDayAttendance`.
- **One source of numbers.** Cards, table, donut, trend and export all come from one `buildReport()` result per request.
- **Filters are validated**: unknown period → monthly; month 1–12; year within 2000–2100; bad ids → ignored. Never thrown back as 500.
- **Export is safe:** a CSV cell that starts with `= + - @` gets a leading `'` (formula injection); `Content-Disposition` filename is built from the filters, not from member names.
- Accessibility: colours always come with a letter or label (P/A/WFH/L, %), the donut has a text legend, the chart has a table fallback.
- `npm test`, `npx tsc --noEmit`, `npm run lint` all clean.

## Files

| File | New / changed | Purpose |
|------|---------------|---------|
| `app/(leave)/layout.tsx` | changed | Add `{ href: "/employee-dashboard", label: "Employee dashboard" }` after Holiday calendar |
| `lib/attendance-report.ts` | new | Pure: filters parsing, period → date range, working days, per-member + overall summary, weekly/monthly trend, insight text, CSV rows |
| `lib/attendance-report-service.ts` | new | Loads members, regions, holidays, marks for the range (via existing services) and calls `buildReport()` |
| `app/(leave)/employee-dashboard/page.tsx` | new | Server Component: reads `searchParams`, renders the 7 sections |
| `components/report/*.tsx` | new | `ReportFilters`, `SummaryCards`, `AttendanceTable`, `AttendanceDonut` (SVG), `MemberMonthGrid`, `TrendChart` (SVG), `ExportPanel` |
| `app/api/attendance/report/route.ts` | new | `GET ?format=csv&…filters` → CSV download |
| `app/(leave)/employee-dashboard/print/page.tsx` (or `@media print` CSS) | new | Print layout for PDF |
| `tests/attendance-report.test.ts` | new | Unit tests for the pure module |
| `tests/attendance-report.integration.test.ts` | new | Service scoping + export route tests |

## Tasks

### Task 1 — Pure report module (TDD)

- [ ] Write failing tests in `tests/attendance-report.test.ts` for:
  - `parseReportFilters(searchParams)` — defaults to current month/year/all; invalid values fall back; quarter derived from month.
  - `periodRange(period, year, month)` → `{ from, to }` for monthly, quarterly (Q of the month), yearly; clipped to today.
  - `workingDays(range, holidays, regionId, joinedOn)` — weekends and region/org holidays excluded; holiday spanning a weekend not double-subtracted.
  - `summarizeMember(marks, workingDays)` — present / absent / wfh / leave / half / notMarked / percent; **reuses `dayValue`** so `PRESENT + HALF_DAY` counts 0.5 once.
  - `summarizeOverall(rows)` — sums, overall % = Σworked ÷ Σcounted (not the average of percentages).
  - `trend(period, marks)` — monthly → weeks of month (Week 1–5); quarterly → 3 months; yearly → 12 months; empty bucket → `null` (gap), not 0.
  - `percentBand(p)` → `good | warn | bad` at 90 / 75 thresholds.
  - `insight(overall, rows)` — at most one sentence; picks: below-75 count, else "above 90 %", else "N days not marked".
  - `toCsvRows(rows)` — header + rows; formula-injection guard.
- [ ] Implement `lib/attendance-report.ts` until green. No Prisma import (the module-graph test should enforce this — add it to the pure-module list in `tests/module-graph.test.ts`).
- [ ] Commit.

### Task 2 — Report service

- [ ] Integration test: an admin of org A sees only org A members; a `member=` id from org B returns an empty table; a `team=` region from org B is ignored; a MEMBER actor gets 403; an INACTIVE member is not listed.
- [ ] Implement `getAttendanceReport(actor, filters)` in `lib/attendance-report-service.ts`:
  - members: ACTIVE `MEMBER`s in the actor's org, optionally filtered by region / id, with `region.name` and `joinedOn`.
  - marks: one `listRangeAttendance(actor, { from, to })` call (filtered in memory by member set), not one query per member.
  - holidays: `listHolidays` for the range.
  - `lastUpdated`: newest `AttendanceEvent.at` in the range for the org.
  - returns `buildReport(...)` result plus the filter option lists (members, regions).
- [ ] Commit.

### Task 3 — Sidebar entry + empty page

- [ ] Read the Next 16 docs on `searchParams` (it is a Promise in recent versions) and on Route Handlers.
- [ ] Add the nav item under Holiday calendar in `app/(leave)/layout.tsx`.
- [ ] Create `app/(leave)/employee-dashboard/page.tsx` with `PageHeader` ("Employee dashboard", subtitle "Track · Analyze · Export") calling the service.
- [ ] Commit.

### Task 4 — Sections 1–2: filters and summary cards

- [ ] `ReportFilters`: a plain `<form method="get">` with selects (Employee, Team, Period, Month/Quarter, Year) and an Apply button — works without JavaScript. Show "Last updated …".
- [ ] `SummaryCards`: five cards (Total working days, Present, Absent, WFH, Leave) plus a small "Not marked" note if > 0. Use existing `ATTENDANCE_STYLE` colours from `lib/ui.ts`.
- [ ] Commit.

### Task 5 — Section 3: employee-wise table

- [ ] `AttendanceTable`: #, Name (link setting `?view=<id>` and keeping other params), Team, Total days, Present, Absent, WFH, Leave, Attendance % pill (band colour). Sorted by name; empty state uses `EmptyPanel`.
- [ ] Commit.

### Task 6 — Section 4: donut + key insight

- [ ] `AttendanceDonut`: inline SVG ring (stroke-dasharray), centre label = overall %, legend with % of marked days per status. Load the `dataviz` skill before writing it.
- [ ] Key insight card from `insight()`.
- [ ] Commit.

### Task 7 — Section 5: one member's daily calendar

- [ ] `MemberMonthGrid`: for `?view=<id>` (default: first member in the table) call `listMemberMonth` + `buildMonthCells()` and render Sun–Sat with P / A / WFH / L / H badges and a legend. In quarterly/yearly mode it shows the selected month of that period, with ‹ › month arrows.
- [ ] Commit.

### Task 8 — Section 6: monthly / quarterly / yearly trend

- [ ] `TrendChart`: tabs are links (`?tab=monthly|quarterly|yearly`), inline SVG line with 0–100 % axis, points, gaps for `null`, plus a visually hidden table of the same numbers. "Select month" + "View report" reuse the filter form.
- [ ] Commit.

### Task 9 — Section 7: export

- [ ] Integration tests for `GET /api/attendance/report?format=csv&…`: 401 signed out, 403 member, 200 admin with `text/csv; charset=utf-8`, BOM present, attachment filename like `attendance-2026-11.csv`, only own-org rows, injection guard.
- [ ] Implement the route with `lib/api.ts` helpers (same pattern as `app/api/attendance/route.ts`).
- [ ] **Export to Excel** = link to the route with current filters. **Export to PDF** = link to the print view (or a button calling `window.print()` with `@media print` hiding the sidebar and filters). Show "Reports are ready to download" once the data has loaded.
- [ ] Commit.

### Task 10 — Verify

- [ ] `npm test`, `npx tsc --noEmit`, `npm run lint`.
- [ ] Run `npm run dev`, sign in as the seeded admin, check: nav position, each filter combination, a member with half days, a month with a holiday, a member who joined mid-month, a future month (shows "—", not 0 %), CSV opens in Excel with correct columns, PDF print preview on one page width.
- [ ] Sign in as a member: no nav item; `/employee-dashboard` and the export URL refused.

## Review Focus

- Percent matches the member's own /calendar figure for the same month (D2). Tested in Task 1.
- Overall % is weighted by days, not an average of members' percentages. Tested in Task 1.
- No cross-organization leakage through `member=`, `team=` or the export URL. Tested in Tasks 2 and 9.
- No N+1 queries: one marks query per request regardless of member count.
- A month nobody has marked shows "—" and "Not marked", never "0 % / all absent".

## Out of scope

- Editing attendance from this page (that stays on /attendance).
- A member-facing version of the dashboard.
- Scheduled / emailed reports.
- A new team/department field (only if D1 is changed).
