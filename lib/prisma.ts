import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { PRISMA_SCHEMA } from "@/lib/prisma-url";

/**
 * Prisma client singleton for the organization backbone.
 *
 * Prisma 7 has no Rust query engine — it talks to Postgres through a driver
 * adapter, so the connection is a `pg` pool like the one in lib/db.ts. The
 * `schema` option scopes every generated query to `orgapp`, leaving the
 * leave-management tables in `public` alone.
 */

declare global {
  // Reused across `next dev` hot reloads so HMR doesn't leak a client per edit.
  var __orgPrisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and start Postgres with `docker compose up -d`.",
    );
  }

  const adapter = new PrismaPg({ connectionString }, { schema: PRISMA_SCHEMA });
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = globalThis.__orgPrisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__orgPrisma = prisma;
}
