import { patchNullableString, patchString, requiredString } from "@/lib/api";
import { parseDateParam } from "@/lib/attendance";
import type { HolidayInput, HolidayPatch } from "@/lib/holiday-service";
import { HttpError } from "@/lib/rbac";

/**
 * Parsing holiday bodies, shared by the three route files — the rule
 * lib/member-input.ts and lib/attendance-input.ts already follow, so a bulk
 * entry and a single POST cannot drift apart on field names or coercion.
 */

/**
 * `endDate` is optional and defaults to `startDate`, so the common case — a
 * one-day holiday — is `{ name, startDate }`.
 */
export function holidayInputFrom(body: Record<string, unknown>): HolidayInput {
  const startDate = parseDateParam(body["startDate"], "startDate");
  const endDate =
    body["endDate"] === undefined || body["endDate"] === null || body["endDate"] === ""
      ? startDate
      : parseDateParam(body["endDate"], "endDate");

  return {
    name: requiredString(body, "name"),
    startDate,
    endDate,
    regionId: patchNullableString(body, "regionId") ?? null,
    note: patchNullableString(body, "note") ?? null,
  };
}

/** Absent keys are left alone; `null` and `""` clear a nullable field. */
export function holidayPatchFrom(body: Record<string, unknown>): HolidayPatch {
  const patch: HolidayPatch = {};

  const name = patchString(body, "name");
  if (name !== undefined) patch.name = name;

  if (body["startDate"] !== undefined) {
    patch.startDate = parseDateParam(body["startDate"], "startDate");
  }
  if (body["endDate"] !== undefined) {
    patch.endDate = parseDateParam(body["endDate"], "endDate");
  }
  if ("regionId" in body) patch.regionId = patchNullableString(body, "regionId") ?? null;
  if ("note" in body) patch.note = patchNullableString(body, "note") ?? null;

  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, "Nothing to update.");
  }
  return patch;
}

/** The `holidays` array on a bulk request. */
export function holidayListFrom(body: Record<string, unknown>): HolidayInput[] {
  const list = body["holidays"];
  if (!Array.isArray(list) || list.length === 0) {
    throw new HttpError(400, '"holidays" must be a non-empty array.');
  }
  if (list.length > 200) {
    throw new HttpError(400, "Load at most 200 holidays in one call.");
  }

  return list.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new HttpError(400, `"holidays[${index}]" must be an object.`);
    }
    return holidayInputFrom(entry as Record<string, unknown>);
  });
}
