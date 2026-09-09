/**
 * Where the Prisma-managed tables live.
 *
 * The leave-management tables (`people`, `requests`, ...) are created at
 * runtime by lib/db.ts and live in `public`. Prisma owns a separate Postgres
 * schema in the same database, so `prisma migrate` only ever sees its own
 * tables — without this, migrate would read the leave tables as drift and
 * offer to reset the database.
 */
export const PRISMA_SCHEMA = "orgapp";

/** `DATABASE_URL` with the Prisma schema pinned onto it. */
export function prismaDatabaseUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and start Postgres with `docker compose up -d`.",
    );
  }
  const url = new URL(base);
  url.searchParams.set("schema", PRISMA_SCHEMA);
  return url.toString();
}
