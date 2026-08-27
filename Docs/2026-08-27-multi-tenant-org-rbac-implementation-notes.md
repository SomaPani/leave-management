# Multi-Tenant Organization Backbone — Implementation Notes

**Date:** 2026-08-27
**Status:** Implemented
**Design:** [`2026-08-27-multi-tenant-org-rbac-design.md`](./2026-08-27-multi-tenant-org-rbac-design.md)

Built inside the existing `leave-management` repo, side by side with the leave
screens rather than as a separate greenfield app. Everything in the design's
scope is in place: Prisma schema + migration, Auth.js credentials login, the
CLI, the seed, role-gated APIs, functional pages, and unit + integration tests.

This file records where the implementation departs from the design and why.
Nothing here changes what the design asked for; each item is either forced by
the host repo, by a newer version of a dependency, or by an internal
contradiction in the design itself.

## Deviations

### `middleware.ts` → `proxy.ts`

Next.js 16 renamed the file convention (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/middleware.md`
now reads "deprecated ... renamed to `proxy.js`"). Same behaviour, and it
defaults to the Node.js runtime, so reading the JWT there is straightforward.

Per the Next docs, the proxy is treated as an **optimistic** gate only. Every
page and route handler re-checks the session, because a Server Action posts to
its page's own path and a matcher change would silently drop coverage.

### `src/` layout → repo root

The design's file layout is `src/app/...`; this repo has `app/` at the root and
Next.js accepts one or the other, not both. Paths were remapped accordingly
(`src/lib/prisma.ts` → `lib/prisma.ts`, and so on).

### No Prisma adapter for Auth.js

The design pairs the Credentials provider with the Prisma adapter. With
Credentials the session strategy must be JWT — which the design also states —
and under JWT the adapter is never called: there are no OAuth accounts and no
session rows. Wiring it in would only oblige us to add Auth.js's `Account`,
`Session`, and `VerificationToken` tables for nothing, against the design's own
YAGNI list. Users are still read from Postgres through Prisma, directly in
`authorize()`.

### `Organization.name` is unique

The design's model has no unique constraint on it, but the seed is specified to
"upsert by org name" and be re-runnable. Prisma's `upsert` requires a unique
field, so the constraint is what makes the stated seed behaviour expressible.

### Tables live in an `orgapp` Postgres schema

Rather than the design's separate `appdb` database, the models live in an
`orgapp` schema inside the existing one, so a single `DATABASE_URL` drives
everything. `lib/prisma-url.ts` pins the schema for the CLI, and the runtime
passes `{ schema }` to the `PrismaPg` adapter.

### `bcryptjs` rather than `bcrypt`

Same algorithm and hash format, pure JavaScript. No node-gyp build on Windows
and no rebuild when Node changes.

### SuperAdmin cannot create Members

The design is ambiguous here: the permissions table lists only "Organizations;
Admins" under what a SuperAdmin creates, while its scope column says "All orgs,
everything". The strict reading won, matching the Purpose section's creation
chain — SuperAdmin → Organization → Admin → Member. A SuperAdmin still *sees*
every organization and every member.

This is one line in `lib/rbac.ts` (`canCreateMember`) if you want it widened;
`tests/rbac.test.ts` and `tests/api.integration.test.ts` both pin the current
behaviour, so flipping it will show up as two failing tests rather than a silent
change.

### Sign-in is at `/signin`, not `/login`

`/login` was already taken by the leave-management account picker, which is
still in the tree. `/signin` is the backbone's email + password form.

## One auth system

Auth.js JWT sessions, signed in at `/signin`, guarded by `lib/rbac.ts` and
`proxy.ts`. The leave-management app's separate `lm_user` cookie session
(`lib/session.ts`, `/login`) is still in the tree but inert — see "Scope
narrowed to the design doc" below.


## Scope narrowed to the design doc

*Requested after the initial build: implement only what this design specifies,
and remove the public-table schema.*

The repo previously also ran a leave-management app whose 10 tables lived in the
`public` schema. Those tables have been **dropped from the database**, and the
`public` models removed from `prisma/schema.prisma`. Prisma now manages exactly
what the design describes: `orgapp`, holding `Organization`, `User` and `Role`.

The migration is a single `20260827100000_baseline`, fully schema-qualified
(`CREATE TABLE "orgapp"."User"`, not bare `"User"`) so that applying it does not
depend on the `schema=orgapp` connection parameter setting the search path — the
bug the original generated migration would have had on a fresh database.

**What this deleted.** 8 people, 5 leave requests, 53 attendance marks and 23
leave-usage rows. A full `pg_dump` was taken immediately beforehand and is in
the session scratchpad as `FINAL-backup-<timestamp>.sql`; restoring is
`psql -U leave -d leave_management -f <that file>`. Scratchpad files are not
permanent — copy it somewhere durable if it might be wanted.

**The leave-management code is still in the repo** and still compiles: it was
kept deliberately, not overlooked. It cannot run, because the tables it queries
are gone. `lib/store.ts` detects this and raises a message saying so instead of
a bare Postgres error, so `/overview`, `/team`, `/approvals` and the rest return
a 500 rather than a confusing stack trace. Deleting that code is a separate
decision.

## Update and delete endpoints

The design's Scope line asks for "role-gated CRUD" while its file layout
specifies only `POST`/`GET`. The layout was built first; `PATCH` and `DELETE`
have now been added under `[id]` routes, which the layout does not mention but
which any update or delete needs in order to name its target:

| Route | Verbs |
|---|---|
| `/api/organizations` | POST, GET |
| `/api/organizations/[id]` | PATCH, DELETE |
| `/api/admins` | POST |
| `/api/admins/[id]` | PATCH, DELETE |
| `/api/members` | POST, GET |
| `/api/members/[id]` | PATCH, DELETE |

Permissions follow the existing matrix exactly: SuperAdmin updates and deletes
organizations and admins; the Admin of an organization updates and deletes its
members; nobody else can. Members and SuperAdmins are both refused on member
mutations, matching `canCreateMember`.

Three decisions worth recording:

**Deleting an organization is refused while it still holds users.**
`User.organizationId` is `ON DELETE SET NULL`, so an unguarded delete would not
error — it would silently strip the organization off every admin and member in
it, leaving accounts that are neither scoped nor SuperAdmin, a state
`assertOrgInvariant` treats as impossible. Emptying an organization first has to
be deliberate, so a non-empty delete returns 409.

**An id is resolved to a user of the expected role before anything happens.**
Without that, `/api/admins/[id]` could be pointed at a member or at a SuperAdmin
and the role check on the route would be decorative. Both cases return 404, and
SuperAdmins stay unreachable over HTTP — they exist only through the CLI.

**Members cannot be moved between organizations.** There is no patchable
`organizationId` on `/api/members/[id]`; sending one is ignored, not honoured.
Allowing it would let an admin place a member outside their own organization,
which is the rule member creation exists to enforce.

## Verified

- `npm test` — 92 tests, 4 files: RBAC matrix (create, update, delete, list),
  password round-trip, API authorization against Docker Postgres including every
  PATCH/DELETE path, CLI/seed subprocesses.
- Full chain over HTTP against a production build: SuperAdmin signs in → creates
  an Organization → creates an Admin → that Admin signs in → creates a Member →
  that Member signs in. Cross-org member creation rejected with 403;
  unauthenticated page → redirect to `/signin`, API → 401; wrong role → redirect
  to that role's own home.
- A fresh database built from the migration alone contains `orgapp` and nothing
  else; `create-superadmin` and `seed` then both succeed against it.
- Seeded `admin@stacx.com` and CLI `super@admin.com` both sign in and land in
  the right scope.

## Known gaps

- **`npm audit` reports 3 high advisories** in `deepmerge-ts`, reached through
  `@prisma/config` → `prisma`. That is the Prisma CLI toolchain, a
  devDependency; it is not in the application's runtime path. It clears when
  Prisma ships an updated `@prisma/config`.
- **Prisma 8.0.0-rc is tagged `latest`** on npm while `@prisma/client` is still
  7.10.0. Both are pinned to 7.10.0 here so they match; don't run
  `npm i prisma@latest` without moving the client too.
- No password reset or email invites — out of scope by design; a creator sets
  each new user's initial password.
