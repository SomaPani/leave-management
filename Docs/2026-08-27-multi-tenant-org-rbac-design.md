# Multi-Tenant Organization Management Backbone — Design

**Date:** 2026-08-27
**Status:** Approved design (pre-implementation)

## Purpose

A greenfield Next.js application providing a role-based, multi-tenant
organization management backbone:

- A **SuperAdmin** (created only via CLI) manages the whole system.
- SuperAdmin creates **Organizations** and creates **Admins** assigned to an org.
- Each **Admin** creates **Members** inside their own organization only.

This first cut is **backbone only**: prove the full hierarchy end-to-end with
functional (unstyled) pages, role-gated APIs, and a Dockerized database. No
polished UI, no email service.

## Scope

**In scope**
- PostgreSQL in Docker (`docker-compose.yml`).
- Next.js (App Router, TypeScript) app.
- Prisma ORM: schema, migrations, typed client singleton.
- Auth.js (NextAuth) Credentials login with JWT sessions.
- CLI script to create SuperAdmin(s) from environment variables.
- Seed script that creates a default **"Stacx"** organization + one Admin.
- Role-gated CRUD: Organizations, Admins, Members.
- Minimal functional pages: login + one dashboard area per role.
- Unit + integration tests for RBAC and API authorization.

**Out of scope (YAGNI for now)**
- Styled/polished UI (Tailwind/shadcn dashboards).
- Email invites / password reset flows.
- Multiple organizations per user.
- Schema-per-tenant isolation.
- Refunds/billing/any domain feature beyond the hierarchy.

## Architecture

- **Single Next.js app** (App Router) serves UI pages and API route handlers.
- **PostgreSQL in Docker** — one service, named volume for persistence,
  credentials from env.
- **Prisma** — schema + migrations; a client singleton (`src/lib/prisma.ts`)
  to survive Next.js hot-reload.
- **Auth.js (NextAuth)** — Credentials provider + Prisma adapter. Credentials
  requires **JWT session strategy**; `role` and `organizationId` are baked into
  the JWT so `middleware.ts` can authorize without a DB round-trip.
- **CLI script** — the *only* way to mint a SuperAdmin; reads credentials from
  environment variables.

## Data Model (Prisma)

```prisma
enum Role {
  SUPERADMIN
  ADMIN
  MEMBER
}

model Organization {
  id        String   @id @default(cuid())
  name      String
  createdAt DateTime @default(now())
  users     User[]
}

model User {
  id             String        @id @default(cuid())
  name           String
  email          String        @unique
  passwordHash   String
  role           Role
  organizationId String?       // null ONLY for SUPERADMIN; required for ADMIN/MEMBER
  organization   Organization? @relation(fields: [organizationId], references: [id])
  createdById    String?       // audit: who created this user
  createdAt      DateTime      @default(now())
}
```

- **Shared DB, row-level tenancy:** every ADMIN/MEMBER carries `organizationId`.
  SuperAdmin has `organizationId = null` → global visibility.
- Application-level invariant: ADMIN and MEMBER **must** have a non-null
  `organizationId`; SUPERADMIN must have null. Enforced in creation logic.
- Passwords stored **only** as bcrypt hashes.

## Roles & Permissions

| Actor | Can create | Scope |
|-------|-----------|-------|
| **SuperAdmin** | Organizations; Admins (assigned to an org) | All orgs, everything |
| **Admin** | Members (own org only) | Own org only |
| **Member** | nothing | Own profile/dashboard |

**Enforcement rules**
- Every mutation re-checks `role` + `organizationId` from the session
  server-side. The client is never trusted.
- When an Admin creates a Member, `organizationId` is **derived from the
  Admin's own session**, never taken from the request body.
- Cross-org actions are rejected with 403 (e.g., Admin creating a Member in a
  different org). Member attempting any create → 403.

## Component / File Layout

```
docker-compose.yml                      # postgres service + volume
.env / .env.example                     # DATABASE_URL, NEXTAUTH_SECRET, SUPERADMIN_*
prisma/schema.prisma
scripts/create-superadmin.ts            # CLI (env-driven)
prisma/seed.ts                          # seed: default Stacx org + admin
src/lib/prisma.ts                       # Prisma client singleton
src/lib/auth.ts                         # Auth.js config (Credentials + JWT callbacks)
src/lib/rbac.ts                         # requireRole() / requireOrg() guards
src/lib/password.ts                     # bcrypt hash/verify
middleware.ts                           # route-group gate by role
src/app/login/                          # login page
src/app/(superadmin)/                   # org list/create, admin create
src/app/(admin)/                        # member list/create
src/app/(member)/                       # member dashboard
src/app/api/organizations/route.ts      # POST/GET (superadmin)
src/app/api/admins/route.ts             # POST (superadmin)
src/app/api/members/route.ts            # POST/GET (admin, own org)
```

Each API route is a small single-purpose handler: call a guard first, then run
a Prisma query scoped to the caller's role/org. UI pages are minimal but
functional (plain HTML forms + tables).

## Environment Variables

```
DATABASE_URL=postgresql://appuser:apppass@localhost:5432/appdb
NEXTAUTH_SECRET=<random-strong-secret>
SUPERADMIN_NAME=Super Admin
SUPERADMIN_EMAIL=super@admin.com
SUPERADMIN_PASSWORD=<strong-password>

# Seed: default Stacx organization + its admin
STACX_ORG_NAME=Stacx
STACX_ADMIN_NAME=Stacx Admin
STACX_ADMIN_EMAIL=admin@stacx.com
STACX_ADMIN_PASSWORD=<strong-password>
```

The same DB credentials feed `docker-compose.yml` and `DATABASE_URL`.

## CLI: create-superadmin

- Command: `npm run create-superadmin`.
- Reads `SUPERADMIN_NAME`, `SUPERADMIN_EMAIL`, `SUPERADMIN_PASSWORD` from env.
- **Fails fast** with a clear message if any is missing.
- Bcrypt-hashes the password; **upserts** by email a `User` with
  `role = SUPERADMIN`, `organizationId = null`.
- **Idempotent / re-runnable**: same email updates the existing record; a new
  email creates an additional SuperAdmin (multiple SuperAdmins allowed).

## Seed: default Stacx organization + admin

- Command: `npm run seed` (or `npx prisma db seed`).
- Reads `STACX_ORG_NAME`, `STACX_ADMIN_NAME`, `STACX_ADMIN_EMAIL`,
  `STACX_ADMIN_PASSWORD` from env; **fails fast** if any is missing.
- Steps (in one transaction):
  1. Upsert `Organization { name: STACX_ORG_NAME }`.
  2. Upsert a `User` with `role = ADMIN`, `organizationId = <Stacx id>`,
     bcrypt-hashed password.
- **Idempotent / re-runnable**: upsert by org name and by admin email — running
  it repeatedly does not create duplicates.
- The seed creates **only** the Stacx org + admin. The SuperAdmin remains
  **CLI-only** and is not touched by the seed.

## Key Flows

1. **Bootstrap:** `docker compose up -d` → `npx prisma migrate dev` →
   `npm run create-superadmin` (SuperAdmin) → `npm run seed` (Stacx org +
   admin).
2. **SuperAdmin:** logs in → creates an Organization → creates an Admin (selects
   the org, sets the Admin's initial password).
3. **Admin:** logs in → sees only their own org → creates Members (org derived
   from session, sets each Member's initial password).
4. **Member:** logs in → dashboard scoped to their own org.

New users (Admin/Member) receive an **initial password set by their creator**
at creation time and can log in immediately.

## Error Handling

- Missing/invalid env on CLI → exit non-zero with explicit message.
- Unauthenticated request to a guarded route → redirect to `/login` (pages) or
  401 (API).
- Authenticated but wrong role/org → 403.
- Duplicate email on user creation → 409 with a clear message.
- Validation errors (missing fields, weak/empty password) → 400.

## Testing

- **Unit**
  - `rbac` guards: full allow/deny matrix per role.
  - `password`: hash + verify round-trip.
  - CLI logic: missing env fails; upsert idempotency.
  - Seed logic: missing env fails; creates Stacx org + admin; re-running does
    not duplicate; seeded admin belongs to the Stacx org.
- **Integration** (against Dockerized Postgres)
  - `POST /api/organizations`: superadmin allowed; admin/member 403.
  - `POST /api/admins`: superadmin allowed, org assignment correct; others 403.
  - `POST /api/members`: admin allowed **only in own org**; cross-org 403;
    member/superadmin behavior per rules.
  - `GET` list routes scoped correctly (admin sees only own org; superadmin
    sees all).

## Success Criteria

- `docker compose up` + migrate + CLI produces a working SuperAdmin login.
- `npm run seed` produces a working **Stacx** org with a login-ready Admin.
- The full chain works end-to-end: SuperAdmin → Org → Admin → Member, each
  logging in and seeing only what their role/org permits.
- Authorization tests (including cross-org denials) pass against the Docker DB.
