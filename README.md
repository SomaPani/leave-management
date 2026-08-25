# Stacx24 — Attendance & Leave Management

A Next.js 16 App Router implementation of the Claude Design project in [`design/`](./design).

Apply, approve, and settle leave in one place. Balances update the moment a request is decided.

## Running it

```bash
npm run dev     # http://localhost:3000
npm run build   # production build
npm start
```

Sign in by picking one of three seeded accounts — no password. **Ananya Rao** is the
admin; **Dev Menon** and **Priya Shah** are members.

## Routes

| Route         | Who     | What                                                          |
| ------------- | ------- | ------------------------------------------------------------- |
| `/login`      | anyone  | Account picker                                                |
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
  store.ts          JSON-file persistence (swap this for a database)
  session.ts        cookie session + requireUser / requireAdmin / requireMember
  domain.ts         balances, attendance resolution, calendar grids
  actions.ts        every Server Action
  date.ts           UTC-only date helpers
  ui.ts             status + attendance colour scales
components/         shared UI, plus the three Client Components
```

Only three components run on the client: the sidebar's active-link highlighting, the
attendance date picker, and the apply form's live summary.

### Data

Everything persists to `.data/db.json` through [`lib/store.ts`](./lib/store.ts), which
serialises writes and commits them atomically. To move to a real database, reimplement
`readDb` and `mutateDb` — nothing else reads or writes storage.

Delete `.data/db.json` to reset to the seed — it is rebuilt on the next request.

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
