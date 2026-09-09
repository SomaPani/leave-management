# Team Screen on Real Data — Implementation Plan

**Date:** 2026-09-01
**Status:** Proposed plan (pre-implementation)
**Scope:** The `/team` screen only. No other leave-management screen is touched.
**Related:** [`2026-08-27-multi-tenant-org-rbac-design.md`](./2026-08-27-multi-tenant-org-rbac-design.md),
[`2026-08-27-multi-tenant-org-rbac-implementation-notes.md`](./2026-08-27-multi-tenant-org-rbac-implementation-notes.md)

---

## 1. Where things stand

`/team` is ADMIN-only and already correctly gated — `proxy.ts` lists the prefix,
and `app/(leave)/layout.tsx` calls `requirePageRole(Role.ADMIN)`. The gate is
not the problem.

The data is. `app/(leave)/team/page.tsx` calls `seedDb()` from `lib/seed.ts`, an
in-memory fixture holding six hardcoded people (`u1`–`u6`). The "Add new" button
posts to `demoAddTeamMember` in `lib/demo-actions.ts`, which redirects to
`/team?demo=add` so `<DemoBanner />` can say the change was not saved.

The reason is recorded in the implementation notes: the original
leave-management tables (`people`, `requests`, `attendance`, `leave_usage`, …)
in the `public` schema were **dropped** when the repo was narrowed to the
organization backbone. `lib/store.ts`, `lib/actions.ts` and `lib/db.ts` still
compile but cannot run — `assertMigrated()` in `lib/store.ts` throws a
deliberate, explanatory error rather than a bare "relation does not exist".

The only real tables that remain are `orgapp.Organization` and `orgapp.User`,
managed by Prisma.

**Therefore:** making Team real means giving it tables in the `orgapp` schema and
wiring the screen to the existing Prisma → services → RBAC stack. It does not
mean reviving `lib/store.ts`.

---

## 2. What "Team" means in real data

A team member **is** a `User` with `role = MEMBER` inside the signed-in admin's
organization. That already exists: `member@stacx.com` is one, and
`app/(admin)/members/page.tsx` already lists them in an unstyled table.

So Team is not a new entity. It is the existing member roster **plus the HR
profile fields the design shows** — title, region, work mode, employee ID,
joining date, manager, contact details. Those are the fields on the `Person`
type in `lib/types.ts` that have no database column today.

This also means the existing `/api/members` endpoints are the right home for the
work. A parallel `/api/team` surface would duplicate the same authorization
rules against the same rows.

---

## 3. Decisions to make first

These change the shape of the work. Recommendation is listed first in each row.

| # | Decision | Recommendation | Why |
|---|---|---|---|
| 1 | Extend `User` with HR columns, **or** add a separate 1-1 `EmployeeProfile` table? | **Extend `User`** | One query, no join; `USER_FIELDS` in `lib/services.ts` simply grows. A SuperAdmin carries nulls, which is already how `organizationId` behaves. A profile table buys a separation this app does not need at its size. |
| 2 | Is `region` a real table or a plain string column? | **Real `Region` table, org-scoped** | The page groups by region and the add-form has a dropdown. A hardcoded `REGIONS` const is still dummy data, which is the thing we are removing. Cheaper alternative: a `String?` column plus the existing const. |
| 3 | "Remove from team" — hard delete or deactivate? | **Deactivate** (`status ACTIVE / INACTIVE`) | Leave requests and attendance will foreign-key to these rows later; hard-deleting a person destroys their history. `deleteMember` in `lib/services.ts` already hard-deletes — leave that for the API and add deactivate for the Team UI. |
| 4 | The add-form has no password field, but `createMember` requires one (min 8 chars, `lib/password.ts`). | **Add a password field**, same as `/members` | The alternative — generate a temporary password and show it once — is more code with no email system to deliver it. |

Decision 4 is the only one that changes the visible form.

---

## 4. Database tables required

Everything lands in the `orgapp` Postgres schema, declared in
`prisma/schema.prisma`.

### 4.1 New enums

```prisma
enum WorkMode {
  WFO
  WFH
}

enum EmploymentStatus {
  ACTIVE
  INACTIVE
}
```

### 4.2 New table — `Region`

Only required if you take decision #2.

```prisma
model Region {
  id             String       @id @default(cuid())
  name           String
  organizationId String
  organization   Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  users          User[]
  createdAt      DateTime     @default(now())

  // "Chennai" may exist once per organization, not once globally.
  @@unique([organizationId, name])
  @@index([organizationId])
}
```

`Organization` gains `regions Region[]`.

### 4.3 Changed table — `User`

All new columns are nullable (except `status`), so existing rows and the
SuperAdmin remain valid without a backfill.

| Column | Type | Notes |
|---|---|---|
| `title` | `String?` | e.g. "Copywriter" |
| `empId` | `String?` | e.g. "STX-0142". Add `@@unique([organizationId, empId])` |
| `joinedOn` | `DateTime?` | A real date, not the fixture's `"3 Feb 2024"` string |
| `workMode` | `WorkMode?` | Will drive the WFH default when attendance lands |
| `status` | `EmploymentStatus @default(ACTIVE)` | Not nullable — see decision #3 |
| `regionId` | `String?` | FK → `Region`, `onDelete: SetNull` |
| `managerId` | `String?` | Self-relation FK → `User`, `onDelete: SetNull` |
| `phone` | `String?` | |
| `personalEmail` | `String?` | |
| `address` | `String?` | |
| `emergencyName` | `String?` | |
| `emergencyPhone` | `String?` | |

Plus the relation fields and `@@index([regionId])`.

The self-relation needs an explicit name:

```prisma
manager User?  @relation("UserManager", fields: [managerId], references: [id], onDelete: SetNull)
reports User[] @relation("UserManager")
```

### 4.4 Deliberately NOT stored

- **`initials`** — derive it with `initialsFor()` from `lib/domain.ts`. Storing a
  derived value invites it to drift from `name`.
- **`manager` as a name string** — the fixture stores `"Ananya Rao"`. Use
  `managerId` so a rename does not orphan the reference.

### 4.5 NOT needed for Team

These belong to features explicitly out of scope for this pass:
`Policy`, `LeaveUsage`, `LeaveRequest`, `RequestMessage`, `Attendance`,
`Holiday`, `Rule`, `Document`, `ScoreCard`.

### 4.6 Migration gotcha

The baseline migration is **fully schema-qualified** (`CREATE TABLE
"orgapp"."User"`, not bare `"User"`) on purpose. The implementation notes record
that Prisma's generated SQL would otherwise emit unqualified names and land in
the wrong schema on a fresh database.

After running `npm run migrate`, **open the generated `migration.sql` and confirm
every object is `"orgapp"."…"`.** Qualify it by hand if it is not. This is the
step most likely to fail silently.

---

## 5. APIs required

No new REST surface for members — a team member *is* a member, so the same
endpoints, the same RBAC, one place for the rules.

| Route | Verb | Change |
|---|---|---|
| `/api/members` | `POST` | Accept `title`, `regionId`, `workMode`, `empId`, `joinedOn`, `managerId`, contact fields |
| `/api/members` | `GET` | Return the new fields; optional `?region=` / `?status=` filters |
| `/api/members/[id]` | `PATCH` | All new fields patchable, including `status` (deactivate / reactivate) |
| `/api/members/[id]` | `DELETE` | Unchanged |
| `/api/regions` | `GET`, `POST` | **New** — org-scoped, feeds the region dropdown |
| `/api/regions/[id]` | `PATCH`, `DELETE` | **New** — `DELETE` returns 409 while anyone is still in the region, mirroring `deleteOrganization` |

### Two entry points, one policy

The page uses **Server Actions**, not `fetch`. The REST routes are a parallel
surface for API clients. Both call `lib/services.ts`, which is where
authorization is decided exactly once per operation. Keep it that way — it is
the existing convention and the reason the RBAC matrix is unit-testable.

### Trust rule

`regionId` and `managerId` arrive from the client. Both must be validated as
belonging to `actor.organizationId` before use, exactly as
`memberOrganizationFor()` refuses a claimed cross-org `organizationId`. An org
boundary is never taken from a request body.

---

## 6. Step-by-step implementation

### Step 1 — Schema and migration

1. Edit `prisma/schema.prisma`: add the enums, `Region`, and the `User` columns
   from section 4.
2. `npm run migrate -- --name team_profiles`
3. Inspect the generated SQL for schema qualification (section 4.6).
4. `npm run prisma:generate`

### Step 2 — RBAC (`lib/rbac.ts`)

- Add `canManageRegions(actor, organizationId)` — same shape as
  `canCreateMember`: the Admin of that organization, and nobody else.
- No change needed for members. `canCreateMember`, `canUpdateMember` and
  `canDeleteMember` already describe the Team screen exactly.

### Step 3 — Services (`lib/services.ts`)

- Add the profile fields to the `createMember` and `updateMember` inputs.
- Validate `regionId` and `managerId` against `actor.organizationId`; reject a
  mismatch with `HttpError` 400/403 rather than silently rewriting it.
- Extend `USER_FIELDS` with the new columns plus
  `region: { select: { id: true, name: true } }` and
  `manager: { select: { id: true, name: true } }`.
- Add `listRegions`, `createRegion`, `updateRegion`, `deleteRegion`.
- Add `setMemberStatus(actor, id, status)` for deactivate / reactivate.
- `listMembers` defaults to `status: ACTIVE` and orders by name.

### Step 4 — API routes

- Extend `app/api/members/route.ts` and `app/api/members/[id]/route.ts` using the
  helpers in `lib/api.ts`. You will need to add a `patchDate` and a `patchEnum`
  helper there — the existing file has `patchString` and `patchEmail` to copy.
- Create `app/api/regions/route.ts` and `app/api/regions/[id]/route.ts`, using
  the same `try` / `errorResponse(error)` shape as the members routes.

### Step 5 — Server Actions

Create `lib/team-actions.ts` — a new file, so `lib/org-actions.ts` stays about
the backbone:

- `createTeamMemberAction`
- `updateTeamMemberAction`
- `deactivateTeamMemberAction`
- `createRegionAction`

Follow the existing pattern precisely: re-authenticate with
`requireActor(await currentActor())` rather than trusting `proxy.ts`, call the
service, `backWithError("/team", error)` on failure, `revalidatePath("/team")`
on success.

### Step 6 — The page (`app/(leave)/team/page.tsx`)

- Replace `seedDb()` / `roster(db)` with `await listMembers(actor)` and
  `await listRegions(actor)`.
- Group by the real regions instead of the `REGIONS` const.
- Swap `demoAddTeamMember` → `createTeamMemberAction`; add the password field
  (decision #4).
- Remove `<DemoBanner />` **from this page only** — every other admin screen is
  still a fixture and still needs it.
- Derive the avatar with `initialsFor(member.name)`.

### Step 7 — Seed (`prisma/seed.ts`)

Extend the seed to upsert the two regions for the Stacx organization and give
`member@stacx.com` a title, region and work mode, so a fresh database does not
render an empty screen. Keep it **idempotent** — re-runnability is the file's
existing contract.

### Step 8 — Tests

- `tests/rbac.test.ts` — add the `canManageRegions` allow/deny matrix. Pure
  functions, no database, matching the file's style.
- `tests/api.integration.test.ts` — cross-org `regionId` rejected, cross-org
  `managerId` rejected, `PATCH status` round-trip, region `DELETE` returning 409
  while occupied.

---

## 7. What is still dummy after this, and why

The Team table has six columns. Only some can be real without building features
that are out of scope for this pass.

| Column | After this work | Filled in by |
|---|---|---|
| PERSON (name, title, avatar) | **Real** | — |
| Region grouping | **Real** | — |
| SCORE | `—` | Employee score feature |
| CASUAL / SICK / PAID balances | `—` | Leave policy + leave usage feature |
| STATUS TODAY | `—` | Attendance feature |

**Recommendation:** render those four cells as `—` with a one-line footnote
rather than deleting the columns. The layout stays intact and the screen is
honest about what is not wired yet. `SCORES`, `balanceOf`, `allowance` and
`attendanceCodes` all read the fixture, so they must come out of this page
regardless of which option you pick.

Also note: the Approvals badge in `app/(leave)/layout.tsx` still calls
`pendingRequests(seedDb())`. That belongs to the Approvals feature — leave it
alone in this pass.

---

## 8. Verification

```bash
npm run migrate && npm run prisma:generate
npm test                       # 92 tests today, plus the ones added in Step 8
npm run dev
```

Manual check:

1. Sign in as `admin@stacx.com` → `/team` shows real members read from
   `orgapp.User`, grouped by real regions.
2. Add a team member → the row persists across a server restart, and the
   "not saved" banner is gone.
3. Deactivate a member → they leave the default roster but the row survives.
4. Sign in as `admin@acme.com` → a different roster, with no cross-organization
   leakage in either direction.
5. `GET /api/members` unauthenticated → 401; as a MEMBER → 403.

---

## 9. Out of scope for this pass

Stated explicitly so the boundary is not argued later:

- Leave policies, balances and leave requests
- Attendance marking and the attendance grid
- Employee score board
- Holidays and approval rules
- Member self-service profile editing
- Reviving `lib/store.ts`, `lib/actions.ts` or `lib/db.ts`
