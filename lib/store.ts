import { promises as fs } from "node:fs";
import path from "node:path";

import { WRITE_LOCK, pool, withTransaction } from "@/lib/db";
import { seedDb } from "@/lib/seed";
import type {
  AttendanceMark,
  Db,
  DocumentRecord,
  LeaveRequest,
  Person,
} from "@/lib/types";
import type { PoolClient } from "pg";

/**
 * The app's data store, backed by Postgres.
 *
 * Everything the app reads and writes still goes through `readDb` / `mutateDb`,
 * so pages and Server Actions keep working against a plain `Db` object. A read
 * assembles that object in a single query; a write diffs the mutated object
 * against its snapshot and rewrites only the sections that actually changed,
 * inside one transaction guarded by an advisory lock.
 *
 * The dataset is a single company's roster, so rewriting a whole section costs
 * less than tracking per-row deltas. If this grows past a few hundred people,
 * `saveDb` is the seam to change — nothing above it has to move.
 */

/* --------------------------------------------------------------- reading -- */

/**
 * `jsonb_strip_nulls` drops absent columns rather than surfacing them as
 * `null`, which keeps optional fields (`Person.region`, `Policy.unit`, ...)
 * genuinely absent the way the TypeScript types declare them.
 */
const READ_SQL = `
select jsonb_strip_nulls(jsonb_build_object(
  'people', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', p.id,
      'name', p.name,
      'initials', p.initials,
      'email', p.email,
      'title', p.title,
      'role', p.role,
      'region', p.region,
      'workMode', p.work_mode,
      'empId', p.emp_id,
      'joined', p.joined,
      'personalEmail', p.personal_email,
      'phone', p.phone,
      'address', p.address,
      'emergencyName', p.emergency_name,
      'emergencyPhone', p.emergency_phone,
      'manager', p.manager
    ) order by p.position) from people p
  ), '[]'::jsonb),

  'requests', coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id,
      'userId', r.user_id,
      'type', r.type,
      'from', to_char(r.from_date, 'YYYY-MM-DD'),
      'to', to_char(r.to_date, 'YYYY-MM-DD'),
      'reason', r.reason,
      'status', r.status,
      'thread', coalesce((
        select jsonb_agg(jsonb_build_object('by', m.author, 'text', m.body, 'at', m.at)
               order by m.position)
        from request_messages m where m.request_id = r.id
      ), '[]'::jsonb)
    ) order by r.position) from requests r
  ), '[]'::jsonb),

  'used', coalesce((
    select jsonb_object_agg(u.user_id, u.amounts) from (
      select user_id, jsonb_object_agg(policy_name, amount) as amounts
      from leave_usage group by user_id
    ) u
  ), '{}'::jsonb),

  'attendance', coalesce((
    select jsonb_object_agg(a.user_id, a.marks) from (
      select user_id, jsonb_object_agg(
        to_char(date, 'YYYY-MM-DD'),
        case when cardinality(marks) = 1
             then to_jsonb(marks[1])
             else to_jsonb(marks)
        end
      ) as marks
      from attendance group by user_id
    ) a
  ), '{}'::jsonb),

  'documents', coalesce((
    select jsonb_object_agg(d.user_id, d.files) from (
      select user_id, jsonb_agg(
        jsonb_build_object('id', id, 'name', name, 'size', size) order by position
      ) as files
      from documents group by user_id
    ) d
  ), '{}'::jsonb),

  'policies', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', name, 'note', note, 'days', days, 'carry', carry, 'unit', unit
    ) order by position) from policies
  ), '[]'::jsonb),

  'wfhPolicy', coalesce((
    select jsonb_build_object('perMonth', wfh_per_month, 'needsApproval', wfh_needs_approval)
    from app_settings
  ), jsonb_build_object('perMonth', 0, 'needsApproval', false)),

  'holidays', coalesce((
    select jsonb_agg(jsonb_build_object(
      'name', name,
      'date', to_char(date, 'YYYY-MM-DD'),
      'days', days,
      'region', region,
      'note', note
    ) order by position) from holidays
  ), '[]'::jsonb),

  'holidayRegion', coalesce(
    (select to_jsonb(holiday_region) from app_settings), '"Chennai"'::jsonb
  ),

  'rules', coalesce((
    select jsonb_agg(jsonb_build_object('label', label, 'on', enabled) order by position)
    from rules
  ), '[]'::jsonb)
)) as db
`;

async function loadDb(client: Pick<PoolClient, "query">): Promise<Db> {
  const { rows } = await client.query<{ db: Db }>(READ_SQL);
  return rows[0]!.db;
}

/* --------------------------------------------------------------- writing -- */

/** One unit of write-back. */
const SECTIONS = [
  "people",
  "policies",
  "rules",
  "holidays",
  "settings",
  "requests",
  "used",
  "attendance",
  "documents",
] as const;

type Section = (typeof SECTIONS)[number];

/** Sections a change to `people` can invalidate through its foreign keys. */
const PEOPLE_DEPENDENTS: Section[] = ["requests", "used", "attendance", "documents"];

/** A cheap value snapshot per section, compared before and after the mutator. */
function snapshot(db: Db): Record<Section, string> {
  return {
    people: JSON.stringify(db.people),
    policies: JSON.stringify(db.policies),
    rules: JSON.stringify(db.rules),
    holidays: JSON.stringify(db.holidays),
    settings: JSON.stringify([db.wfhPolicy, db.holidayRegion]),
    requests: JSON.stringify(db.requests),
    used: JSON.stringify(db.used),
    attendance: JSON.stringify(db.attendance),
    documents: JSON.stringify(db.documents),
  };
}

function changedSections(
  before: Record<Section, string>,
  after: Record<Section, string>,
): ReadonlySet<Section> {
  const changed = new Set<Section>(SECTIONS.filter((s) => before[s] !== after[s]));
  if (changed.has("people")) for (const s of PEOPLE_DEPENDENTS) changed.add(s);
  return changed;
}

type Row = Record<string, unknown>;

/**
 * Table and column names below are module constants, never user input — only
 * values are parameterised.
 */
async function insertRows(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: Row[],
  conflictKey?: string,
): Promise<void> {
  if (rows.length === 0) return;

  const params: unknown[] = [];
  const tuples = rows.map(
    (row) => `(${columns.map((c) => `$${params.push(row[c] ?? null)}`).join(", ")})`,
  );
  const upsert = conflictKey
    ? ` on conflict (${conflictKey}) do update set ${columns
        .filter((c) => c !== conflictKey)
        .map((c) => `${c} = excluded.${c}`)
        .join(", ")}`
    : "";

  await client.query(
    `insert into ${table} (${columns.join(", ")}) values ${tuples.join(", ")}${upsert}`,
    params,
  );
}

async function replaceTable(
  client: PoolClient,
  table: string,
  columns: string[],
  rows: Row[],
): Promise<void> {
  await client.query(`delete from ${table}`);
  await insertRows(client, table, columns, rows);
}

const PEOPLE_COLUMNS = [
  "id",
  "position",
  "name",
  "initials",
  "email",
  "title",
  "role",
  "region",
  "work_mode",
  "emp_id",
  "joined",
  "personal_email",
  "phone",
  "address",
  "emergency_name",
  "emergency_phone",
  "manager",
];

function personRow(person: Person, position: number): Row {
  return {
    id: person.id,
    position,
    name: person.name,
    initials: person.initials,
    email: person.email,
    title: person.title,
    role: person.role,
    region: person.region,
    work_mode: person.workMode,
    emp_id: person.empId,
    joined: person.joined,
    personal_email: person.personalEmail,
    phone: person.phone,
    address: person.address,
    emergency_name: person.emergencyName,
    emergency_phone: person.emergencyPhone,
    manager: person.manager,
  };
}

function requestRow(request: LeaveRequest, position: number): Row {
  return {
    id: request.id,
    position,
    user_id: request.userId,
    type: request.type,
    from_date: request.from,
    to_date: request.to,
    reason: request.reason,
    status: request.status,
  };
}

function messageRows(requests: LeaveRequest[]): Row[] {
  return requests.flatMap((request) =>
    request.thread.map((message, position) => ({
      request_id: request.id,
      position,
      author: message.by,
      body: message.text,
      at: message.at,
    })),
  );
}

function usageRows(used: Db["used"]): Row[] {
  return Object.entries(used).flatMap(([userId, amounts]) =>
    Object.entries(amounts).map(([policyName, amount]) => ({
      user_id: userId,
      policy_name: policyName,
      amount,
    })),
  );
}

function markArray(mark: AttendanceMark | undefined): string[] {
  if (!mark) return [];
  return Array.isArray(mark) ? mark : [mark];
}

function attendanceRows(attendance: Db["attendance"]): Row[] {
  const rows: Row[] = [];
  for (const [userId, record] of Object.entries(attendance)) {
    for (const [date, mark] of Object.entries(record)) {
      const marks = markArray(mark);
      if (marks.length > 0) rows.push({ user_id: userId, date, marks });
    }
  }
  return rows;
}

function documentRows(documents: Db["documents"]): Row[] {
  return Object.entries(documents).flatMap(([userId, files]) =>
    (files as DocumentRecord[]).map((file, position) => ({
      id: file.id,
      user_id: userId,
      position,
      name: file.name,
      size: file.size,
    })),
  );
}

async function saveDb(
  client: PoolClient,
  db: Db,
  sections: ReadonlySet<Section>,
): Promise<void> {
  if (sections.has("people")) {
    // Upsert rather than delete-all: the dependent tables cascade, so wiping
    // `people` to rebuild it would take every request and mark with it. Only
    // people genuinely gone from the roster get removed.
    await client.query(`delete from people where id <> all($1::text[])`, [
      db.people.map((p) => p.id),
    ]);
    await insertRows(client, "people", PEOPLE_COLUMNS, db.people.map(personRow), "id");
  }

  if (sections.has("policies")) {
    await replaceTable(
      client,
      "policies",
      ["name", "position", "note", "days", "carry", "unit"],
      db.policies.map((policy, position) => ({ ...policy, position })),
    );
  }

  if (sections.has("rules")) {
    await replaceTable(
      client,
      "rules",
      ["position", "label", "enabled"],
      db.rules.map((rule, position) => ({
        position,
        label: rule.label,
        enabled: rule.on,
      })),
    );
  }

  if (sections.has("holidays")) {
    await replaceTable(
      client,
      "holidays",
      ["position", "name", "date", "days", "region", "note"],
      db.holidays.map((holiday, position) => ({ ...holiday, position })),
    );
  }

  if (sections.has("settings")) {
    await client.query(
      `insert into app_settings (id, wfh_per_month, wfh_needs_approval, holiday_region)
       values (true, $1, $2, $3)
       on conflict (id) do update set
         wfh_per_month = excluded.wfh_per_month,
         wfh_needs_approval = excluded.wfh_needs_approval,
         holiday_region = excluded.holiday_region`,
      [db.wfhPolicy.perMonth, db.wfhPolicy.needsApproval, db.holidayRegion],
    );
  }

  if (sections.has("requests")) {
    // request_messages cascades from this delete, and is reinserted below.
    await replaceTable(
      client,
      "requests",
      ["id", "position", "user_id", "type", "from_date", "to_date", "reason", "status"],
      db.requests.map(requestRow),
    );
    await insertRows(
      client,
      "request_messages",
      ["request_id", "position", "author", "body", "at"],
      messageRows(db.requests),
    );
  }

  if (sections.has("used")) {
    await replaceTable(
      client,
      "leave_usage",
      ["user_id", "policy_name", "amount"],
      usageRows(db.used),
    );
  }

  if (sections.has("attendance")) {
    await replaceTable(
      client,
      "attendance",
      ["user_id", "date", "marks"],
      attendanceRows(db.attendance),
    );
  }

  if (sections.has("documents")) {
    await replaceTable(
      client,
      "documents",
      ["id", "user_id", "position", "name", "size"],
      documentRows(db.documents),
    );
  }
}

/* ------------------------------------------------------------- bootstrap -- */

declare global {
  var __leaveReady: Promise<void> | undefined;
}

const LEGACY_JSON_FILE = path.join(process.cwd(), ".data", "db.json");

/**
 * Carries the prototype's JSON file over on first run so an existing roster
 * isn't thrown away. Returns `null` when there's nothing usable to import.
 */
async function importLegacyFile(): Promise<Db | null> {
  let parsed: Partial<Db>;
  try {
    parsed = JSON.parse(await fs.readFile(LEGACY_JSON_FILE, "utf8")) as Partial<Db>;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.people) || parsed.people.length === 0) return null;

  const fallback = seedDb();
  return {
    people: parsed.people,
    requests: parsed.requests ?? fallback.requests,
    used: parsed.used ?? fallback.used,
    attendance: parsed.attendance ?? fallback.attendance,
    documents: parsed.documents ?? fallback.documents,
    policies: parsed.policies ?? fallback.policies,
    wfhPolicy: parsed.wfhPolicy ?? fallback.wfhPolicy,
    holidays: parsed.holidays ?? fallback.holidays,
    holidayRegion: parsed.holidayRegion ?? fallback.holidayRegion,
    rules: parsed.rules ?? fallback.rules,
  };
}

/**
 * These tables no longer exist.
 *
 * The `public` schema was dropped when the repo was narrowed to the
 * organization backbone, and nothing creates it any more: `prisma/migrations`
 * covers `orgapp` only. This module and the screens above it are kept as
 * reference, but they cannot run against the current database — so fail with
 * that fact rather than a bare "relation does not exist".
 *
 * See Docs/2026-08-27-multi-tenant-org-rbac-implementation-notes.md for what
 * was removed and where the data went.
 */
async function assertMigrated(client: PoolClient): Promise<void> {
  const { rows } = await client.query<{ present: boolean }>(
    "select to_regclass('public.people') is not null as present",
  );
  if (!rows[0]!.present) {
    throw new Error(
      "The leave-management tables were removed from this database; only the " +
        "organization backbone (/signin) remains. See Docs/2026-08-27-multi-tenant-org-rbac-implementation-notes.md.",
    );
  }
}

async function bootstrap(): Promise<void> {
  await withTransaction(async (client) => {
    // Two processes starting at once must not both seed.
    await client.query("select pg_advisory_xact_lock($1)", [WRITE_LOCK]);
    await assertMigrated(client);

    const { rows } = await client.query<{ count: number }>(
      "select count(*)::int as count from people",
    );
    if (rows[0]!.count > 0) return;

    const imported = await importLegacyFile();
    await saveDb(client, imported ?? seedDb(), new Set(SECTIONS));
    console.log(
      imported
        ? `[store] imported ${imported.people.length} people from .data/db.json`
        : "[store] seeded a fresh database",
    );
  });
}

/** Loads the initial data, once per process. The schema itself is migrated. */
function ensureReady(): Promise<void> {
  return (globalThis.__leaveReady ??= bootstrap().catch((error: unknown) => {
    // Let the next request retry rather than wedging the process.
    globalThis.__leaveReady = undefined;
    throw error;
  }));
}

/* ------------------------------------------------------------------- api -- */

/** Read the whole database. Seeds it on first use. */
export async function readDb(): Promise<Db> {
  await ensureReady();
  return loadDb(pool());
}

/**
 * Read, mutate in place, and persist — atomically with respect to other
 * `mutateDb` calls, including ones in other processes. The callback's return
 * value is passed through.
 */
export async function mutateDb<T>(mutator: (db: Db) => T): Promise<T> {
  await ensureReady();
  return withTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock($1)", [WRITE_LOCK]);
    const db = await loadDb(client);
    const before = snapshot(db);
    const result = mutator(db);
    await saveDb(client, db, changedSections(before, snapshot(db)));
    return result;
  });
}
