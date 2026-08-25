import { promises as fs } from "node:fs";
import path from "node:path";

import { seedDb } from "@/lib/seed";
import type { Db } from "@/lib/types";

/**
 * A tiny JSON-file store so the prototype has real persistence without pulling
 * in a database. Everything the app reads and writes goes through here, so
 * swapping in Postgres/Prisma later means reimplementing just `readDb` and
 * `mutateDb`.
 *
 * Writes are serialised through a promise queue and committed atomically
 * (write-temp-then-rename) so two concurrent Server Actions cannot interleave a
 * read-modify-write and lose one of the updates.
 */

const DATA_DIR = path.join(process.cwd(), ".data");
const DB_FILE = path.join(DATA_DIR, "db.json");

let queue: Promise<void> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function writeFile(db: Db): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(db, null, 2), "utf8");
  await fs.rename(tmp, DB_FILE);
}

async function loadFile(): Promise<Db> {
  try {
    return JSON.parse(await fs.readFile(DB_FILE, "utf8")) as Db;
  } catch {
    const fresh = seedDb();
    await writeFile(fresh);
    return fresh;
  }
}

/** Read the whole database. Seeds it on first use. */
export function readDb(): Promise<Db> {
  return enqueue(loadFile);
}

/**
 * Read, mutate in place, and persist — atomically with respect to other
 * `mutateDb` / `readDb` calls. The callback's return value is passed through.
 */
export function mutateDb<T>(mutator: (db: Db) => T): Promise<T> {
  return enqueue(async () => {
    const db = await loadFile();
    const result = mutator(db);
    await writeFile(db);
    return result;
  });
}
