import { Role } from "@/generated/prisma/enums";
import { fromDbDate, toDbDate } from "@/lib/attendance";
import type { HolidayRecord } from "@/lib/holidays";
import { prisma } from "@/lib/prisma";
import {
  type Actor,
  HttpError,
  canListHolidays,
  canManageHolidays,
  visibleOrgId,
} from "@/lib/rbac";
import { assertRegionInOrg } from "@/lib/services";

/**
 * Everything that reads or writes the holiday table.
 *
 * Same contract as lib/services.ts and lib/attendance-service.ts: the route
 * handlers hand in an `Actor` they have already authenticated, and every
 * authorization decision is made here, once per operation.
 */

const HOLIDAY_FIELDS = {
  id: true,
  name: true,
  startDate: true,
  endDate: true,
  note: true,
  region: { select: { id: true, name: true } },
} as const;

export type HolidayInput = {
  name: string;
  startDate: string;
  /** Inclusive. The parser defaults it to `startDate` for a one-day holiday. */
  endDate: string;
  regionId: string | null;
  note: string | null;
};

export type HolidayPatch = Partial<HolidayInput>;

type HolidayRow = {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  note: string | null;
  region: { id: string; name: string } | null;
};

function toRecord(row: HolidayRow): HolidayRecord {
  return {
    id: row.id,
    name: row.name,
    startDate: fromDbDate(row.startDate),
    endDate: fromDbDate(row.endDate),
    note: row.note,
    region: row.region,
  };
}

/** The organization an admin may write holidays into, or a 403. */
function writableOrgFor(actor: Actor): string {
  const organizationId = actor.organizationId;
  if (!organizationId || !canManageHolidays(actor, organizationId)) {
    throw new HttpError(403, "Only an organization admin can manage holidays.");
  }
  return organizationId;
}

function assertOrderedRange(startDate: string, endDate: string): void {
  if (endDate < startDate) {
    throw new HttpError(400, '"endDate" must not be earlier than "startDate".');
  }
}

/* --------------------------------------------------------------- reading -- */

/**
 * Which region a caller's list is narrowed to.
 *
 * A MEMBER always gets their own region and nothing else — a `?region=` they
 * pass is ignored rather than rejected, because there is no legitimate reason
 * for a member to ask and a 403 would only tell them the parameter exists.
 * An ADMIN or SUPERADMIN gets whatever they asked for, or no narrowing.
 *
 * `undefined` means "do not narrow"; a string means "that region, plus the
 * organization-wide holidays".
 */
async function regionScopeFor(
  actor: Actor,
  requested?: string,
): Promise<string | undefined> {
  if (actor.role !== Role.MEMBER) return requested;

  const member = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { regionId: true },
  });
  return member?.regionId ?? undefined;
}

export async function listHolidays(
  actor: Actor,
  filter: { year?: number; from?: string; to?: string; regionId?: string } = {},
): Promise<HolidayRecord[]> {
  if (!canListHolidays(actor)) {
    throw new HttpError(403, "Your role does not permit this action.");
  }

  const orgId = visibleOrgId(actor);
  const regionId = await regionScopeFor(actor, filter.regionId);

  // A year narrows to its bounds; from/to override it when both are given.
  const from = filter.from ?? (filter.year ? `${filter.year}-01-01` : undefined);
  const to = filter.to ?? (filter.year ? `${filter.year}-12-31` : undefined);

  const rows = await prisma.holiday.findMany({
    where: {
      ...(orgId ? { organizationId: orgId } : {}),
      // Overlap, not containment: a break spanning two months belongs to both.
      ...(to ? { startDate: { lte: toDbDate(to) } } : {}),
      ...(from ? { endDate: { gte: toDbDate(from) } } : {}),
      // Organization-wide holidays (null region) always apply.
      ...(regionId ? { OR: [{ regionId }, { regionId: null }] } : {}),
    },
    select: HOLIDAY_FIELDS,
    orderBy: [{ startDate: "asc" }, { name: "asc" }],
  });

  return rows.map(toRecord);
}

/* --------------------------------------------------------------- writing -- */

export async function createHoliday(
  actor: Actor,
  input: HolidayInput,
): Promise<HolidayRecord> {
  const organizationId = writableOrgFor(actor);
  assertOrderedRange(input.startDate, input.endDate);
  if (input.regionId) await assertRegionInOrg(input.regionId, organizationId);

  const row = await prisma.holiday.create({
    data: {
      organizationId,
      regionId: input.regionId,
      name: input.name,
      startDate: toDbDate(input.startDate),
      endDate: toDbDate(input.endDate),
      note: input.note,
    },
    select: HOLIDAY_FIELDS,
  });

  return toRecord(row);
}

/**
 * Load several holidays at once — a whole year in one call.
 *
 * Skips anything already present with the same name, start date and region,
 * so re-running an import is a no-op rather than a duplicate calendar. There
 * is no unique index doing this for us on purpose: two regions legitimately
 * share a holiday name and date, and Postgres treats null `regionId` values as
 * distinct, so an index would only half-enforce the rule and mislead about it.
 */
export async function createHolidays(
  actor: Actor,
  inputs: HolidayInput[],
): Promise<{ created: HolidayRecord[]; skipped: number }> {
  const organizationId = writableOrgFor(actor);

  for (const input of inputs) {
    assertOrderedRange(input.startDate, input.endDate);
    if (input.regionId) await assertRegionInOrg(input.regionId, organizationId);
  }

  const existing = await prisma.holiday.findMany({
    where: { organizationId },
    select: { name: true, startDate: true, regionId: true },
  });
  const seen = new Set(
    existing.map((h) => `${h.name}|${fromDbDate(h.startDate)}|${h.regionId ?? ""}`),
  );

  const created: HolidayRecord[] = [];
  let skipped = 0;

  for (const input of inputs) {
    const key = `${input.name}|${input.startDate}|${input.regionId ?? ""}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);

    const row = await prisma.holiday.create({
      data: {
        organizationId,
        regionId: input.regionId,
        name: input.name,
        startDate: toDbDate(input.startDate),
        endDate: toDbDate(input.endDate),
        note: input.note,
      },
      select: HOLIDAY_FIELDS,
    });
    created.push(toRecord(row));
  }

  return { created, skipped };
}

/**
 * The holiday an admin may act on, or a 404.
 *
 * Scoped by the *stored* organizationId, so an id from another organization is
 * indistinguishable from one that does not exist.
 */
async function findWritable(
  actor: Actor,
  id: string,
): Promise<{ organizationId: string; startDate: Date; endDate: Date }> {
  const organizationId = writableOrgFor(actor);

  const holiday = await prisma.holiday.findUnique({
    where: { id },
    select: { organizationId: true, startDate: true, endDate: true },
  });
  if (!holiday || holiday.organizationId !== organizationId) {
    throw new HttpError(404, "That holiday does not exist.");
  }
  return holiday;
}

export async function updateHoliday(
  actor: Actor,
  id: string,
  patch: HolidayPatch,
): Promise<HolidayRecord> {
  const current = await findWritable(actor, id);

  // The range is validated as it will be after the patch, not as it arrived —
  // moving only one end still has to leave the two in order.
  const startDate = patch.startDate ?? fromDbDate(current.startDate);
  const endDate = patch.endDate ?? fromDbDate(current.endDate);
  assertOrderedRange(startDate, endDate);

  if (patch.regionId) {
    await assertRegionInOrg(patch.regionId, current.organizationId);
  }

  const row = await prisma.holiday.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(patch.regionId !== undefined ? { regionId: patch.regionId } : {}),
      startDate: toDbDate(startDate),
      endDate: toDbDate(endDate),
    },
    select: HOLIDAY_FIELDS,
  });

  return toRecord(row);
}

export async function deleteHoliday(
  actor: Actor,
  id: string,
): Promise<{ id: string; deleted: true }> {
  await findWritable(actor, id);
  await prisma.holiday.delete({ where: { id } });
  return { id, deleted: true as const };
}
