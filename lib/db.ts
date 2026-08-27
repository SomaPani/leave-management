import { Pool, type PoolClient } from "pg";

/**
 * Postgres connection and schema.
 *
 * Nothing here knows about the `Db` shape — `lib/store.ts` owns the mapping
 * between the app's document-shaped state and these tables.
 */

declare global {
  // Reused across `next dev` hot reloads so HMR doesn't leak a pool per edit.
  var __leavePool: Pool | undefined;
}

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env and start Postgres with `docker compose up -d`.",
    );
  }
  return new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
}

export function pool(): Pool {
  return (globalThis.__leavePool ??= createPool());
}

/** Runs `fn` inside a transaction, rolling back if it throws. */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Held for the length of a transaction so a read-modify-write cycle can't
 * interleave with another one — the same guarantee the old JSON file store got
 * from its in-process promise queue, but across processes.
 */
export const WRITE_LOCK = 918_273_645;
