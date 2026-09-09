# Stacx24 — Organization Backbone

A Next.js 16 App Router app providing a role-based, multi-tenant organization
management backbone: SuperAdmin → Organization → Admin → Member. Designed in
[`Docs/2026-08-27-multi-tenant-org-rbac-design.md`](./Docs/2026-08-27-multi-tenant-org-rbac-design.md).

The repo also contains an earlier leave-management app, built from the Claude
Design project in [`design/`](./design). Its code is still here but it no longer
runs — see the note under "Running it".

## Running it

```bash
cp .env.example .env        # DATABASE_URL, AUTH_SECRET, SUPERADMIN_*, STACX_*
docker compose up -d        # postgres 18 on localhost:5432
npm run migrate             # creates the `orgapp` schema and its tables
npm run create-superadmin   # CLI-only; reads SUPERADMIN_* from .env
npm run seed                # default Stacx organization + its admin
npm run dev                 # http://localhost:3000/login
```

`npm run build` / `npm start` for production, `npm test` for the test suite.

> **The leave-management app no longer runs.** Its `public` tables were dropped
> when this repo was narrowed to the organization backbone. The code is still
> here (`app/(dashboard)`, `lib/store.ts`, `lib/db.ts`,
> `lib/domain.ts`, `lib/seed.ts`, `lib/session.ts`) and still compiles, but every
> one of those screens errors, because the tables it queries are gone. See
> [the implementation notes](./Docs/2026-08-27-multi-tenant-org-rbac-implementation-notes.md)
> for what was removed and how to restore it.

## Routes — leave-management (inert)

These screens are the earlier app. They still compile, but every one of them
errors at runtime: the `public` tables they query were dropped.

| Route         | Who     | What                                                          |
| ------------- | ------- | ------------------------------------------------------------- |
| `/approvals`  | admin   | Request queue, filters, decision + feedback thread            |
| `/attendance` | admin   | Mark a day for the whole team                                 |
| `/team`       | admin   | Roster by region, balances, add a teammate                    |
| `/setup`      | admin   | Leave policies, WFH policy, holiday calendar, approval rules  |
| `/scores`     | admin   | Per-employee score board                                      |
| `/overview`   | member  | Balances, replies waiting on you, who's out                   |
| `/calendar`   | member  | Your attendance month by month                                |
| `/apply`      | member  | Request leave, with a live cost/balance summary               |
| `/requests`   | member  | Your requests and their feedback threads                      |
| `/score`      | member  | Your own score board                                          |
| `/profile`    | member  | Your record on file, plus document uploads                    |

`/` redirects to the sign-in screen, or to the right home page if you're already signed in.

## How it's put together

Pages are Server Components; every mutation is a Server Action in
[`lib/actions.ts`](./lib/actions.ts). View state that should survive a reload or be
linkable — the selected request, the attendance date, the calendar month, the picked
employee — lives in the URL rather than in component state, so most screens ship no
client JavaScript at all.

```
app/
  layout.tsx        root layout: <html>, global CSS, metadata
  login/            sign-in screen — no sidebar, no session required
  (dashboard)/      route group: the sidebar shell + the 10 signed-in routes
                    (the parentheses keep it out of the URL)
lib/
  types.ts          the data model
  seed.ts           seed roster, policies, holidays, requests, scores
  db.ts             Postgres pool, transactions, schema
  store.ts          the Db object <-> tables mapping (readDb / mutateDb)
  prisma.ts         Prisma client singleton (organization backbone)
  auth.ts           Auth.js config: credentials + JWT callbacks
  rbac.ts           the allow/deny matrix, as pure functions
  services.ts       organization/admin/member operations, authorized once
  password.ts       bcrypt hash + verify
  session.ts        cookie session + requireUser / requireAdmin / requireMember
  domain.ts         balances, attendance resolution, calendar grids
  actions.ts        every Server Action
  date.ts           UTC-only date helpers
  ui.ts             status + attendance colour scales
components/         shared UI, plus the three Client Components
```

Only three components run on the client: the sidebar's active-link highlighting, the
attendance date picker, and the apply form's live summary.

### Data (inert)

The leave-management screens persisted to Postgres through
[`lib/store.ts`](./lib/store.ts), against tables in the `public` schema. Those
tables no longer exist, so this whole layer raises on first use. What follows
describes how it worked.

Pages and Server Actions work against a plain `Db` object rather than issuing their own
queries. `readDb()` assembles that object in a single query; `mutateDb(db => ...)` runs
inside one transaction — advisory lock, read, mutate, write back only the sections the
mutator actually changed. That keeps the read-modify-write cycles in `lib/actions.ts`
serialised across processes, and it means a screen never has to know which tables it
touches. Rewriting a whole section per write suits one company's roster; past a few
hundred people, `saveDb` is the seam to swap for per-row updates.

Restoring it means recreating those tables and reloading the data; the backup
and the details are in
[the implementation notes](./Docs/2026-08-27-multi-tenant-org-rbac-implementation-notes.md).

## Organization backbone

The running app: a role-based multi-tenant hierarchy of
SuperAdmin -> Organization -> Admin -> Member. Designed in
[`Docs/2026-08-27-multi-tenant-org-rbac-design.md`](./Docs/2026-08-27-multi-tenant-org-rbac-design.md);
where the implementation departs from that design, and why, is recorded in
[`Docs/2026-08-27-multi-tenant-org-rbac-implementation-notes.md`](./Docs/2026-08-27-multi-tenant-org-rbac-implementation-notes.md).

| Route            | Who        | What                                    |
| ---------------- | ---------- | --------------------------------------- |
| `/login`         | anyone     | Email + password log-in                 |
| `/organizations` | superadmin | Every organization, and create one      |
| `/admins`        | superadmin | Create an admin, assigned to an org     |
| `/members`       | admin      | Their own org's members, and add one    |
| `/account`       | member     | Their own record                        |

The same operations are available over HTTP:

| Endpoint | Verbs | Who |
| --- | --- | --- |
| `/api/organizations` | POST, GET | superadmin |
| `/api/organizations/[id]` | PATCH, DELETE | superadmin |
| `/api/admins` | POST | superadmin |
| `/api/admins/[id]` | PATCH, DELETE | superadmin |
| `/api/members` | POST, GET | admin (own org); GET also superadmin |
| `/api/members/[id]` | PATCH, DELETE | admin (own org) |

Both entry points go through [`lib/services.ts`](./lib/services.ts), so each
operation is authorized in exactly one place. Deleting an organization is
refused while it still holds users — `organizationId` is `ON DELETE SET NULL`,
so an unguarded delete would silently orphan its admins and members rather than
fail.

The pages are deliberately unstyled — this cut is a working backbone, not a
dashboard. It runs on its own Auth.js JWT session, separate from the leave
screens' `lm_user` cookie; the two coexist rather than one replacing the other.

Authorization lives in [`lib/rbac.ts`](./lib/rbac.ts) as pure predicates, so the
whole allow/deny matrix is unit-testable without a database or a session.
[`proxy.ts`](./proxy.ts) (Next.js 16's rename of `middleware.ts`) keeps the wrong
role off a page, but it is an optimistic gate only: every page and route handler
re-checks, because a Server Action posts to its own page's path.

The backbone's tables live in a separate `orgapp` Postgres schema, alongside
`public`; [`prisma/schema.prisma`](./prisma/schema.prisma) declares both and
`prisma migrate` manages both.

### The demo clock

The seeded roster, attendance and requests are anchored to a fixed "today" —
`TODAY` in [`lib/date.ts`](./lib/date.ts), set to **17 Aug 2026**. Swap it for
`new Date()` when the app is backed by live data.

### Authorisation

Server Actions are reachable by direct POST, not just through the UI, so every action
re-checks the session: `requireAdmin()` for admin operations, and ownership checks
before a member can reply to or withdraw a request.

## Known gaps

- **Desktop-first.** The sidebar shell assumes a wide viewport, matching the source design.
- **Document uploads store metadata only** — filename and size. Wiring up blob storage
  is the next step. `serverActions.bodySizeLimit` is raised to 8 MB in `next.config.ts`
  to fit an ordinary scanned PDF.
- **Score boards are static figures**, as in the design.
- **Profile photos** render as initials; the design's photo-upload slot is not wired up.
