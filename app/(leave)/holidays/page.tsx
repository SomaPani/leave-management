import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import {
  Card,
  EmptyPanel,
  dangerButtonClass,
  ghostButtonClass,
  inputClass,
  primaryButtonClass,
  selectClass,
} from "@/components/ui";
import { todayIso } from "@/lib/attendance";
import { formatDayMonth, formatWeekdayShort } from "@/lib/date";
import {
  createHolidayAction,
  deleteHolidayAction,
  updateHolidayAction,
} from "@/lib/holiday-actions";
import { listHolidays } from "@/lib/holiday-service";
import type { HolidayRecord } from "@/lib/holidays";
import { requirePageRole } from "@/lib/page-guards";
import { Role } from "@/generated/prisma/enums";
import { listRegions } from "@/lib/services";

/**
 * Admin: the organization's holiday calendar, region by region.
 *
 * Reads and writes `orgapp.Holiday` through lib/holiday-service.ts — the same
 * functions `/api/holidays` calls — so the screen and the API cannot disagree
 * about scope. The organization comes from the admin's session; no
 * organization id is ever read from this page's URL.
 *
 * A holiday with no region applies to everyone in the organization. That is
 * the default the form offers, because most public holidays are org-wide and a
 * regional one is the exception worth choosing deliberately.
 */

const COLUMNS = "grid-cols-[minmax(150px,0.9fr)_1.5fr_0.8fr_1fr_auto]";

type Region = Awaited<ReturnType<typeof listRegions>>[number];

/** `2026-11-08` + `2026-11-09` reads as `8 Nov – 9 Nov`; one day as `8 Nov`. */
function formatSpan(holiday: HolidayRecord): string {
  return holiday.startDate === holiday.endDate
    ? formatDayMonth(holiday.startDate)
    : `${formatDayMonth(holiday.startDate)} – ${formatDayMonth(holiday.endDate)}`;
}

/** Whole days covered, inclusive of both ends. */
function spanDays(holiday: HolidayRecord): number {
  const start = Date.parse(`${holiday.startDate}T00:00:00.000Z`);
  const end = Date.parse(`${holiday.endDate}T00:00:00.000Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

function Labelled({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-xs text-muted">
      {label}
      {children}
    </label>
  );
}

/**
 * The add and edit forms are the same five fields.
 *
 * On edit every input carries the holiday's current value, which is what makes
 * an emptied box mean "clear this" — the shared parser reads an empty string
 * as null. The region select's first option is the organization-wide case, and
 * its empty value is what produces a null `regionId`.
 */
function HolidayFields({
  holiday,
  regions,
}: {
  holiday?: HolidayRecord;
  regions: Region[];
}) {
  return (
    <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
      <Labelled label="Holiday name">
        <input
          name="name"
          required
          defaultValue={holiday?.name ?? ""}
          placeholder="e.g. Diwali"
          className={inputClass}
        />
      </Labelled>

      <Labelled label="First day">
        <input
          name="startDate"
          type="date"
          required
          defaultValue={holiday?.startDate ?? ""}
          className={inputClass}
        />
      </Labelled>

      <Labelled label="Last day (leave blank for one day)">
        <input
          name="endDate"
          type="date"
          defaultValue={holiday?.endDate ?? ""}
          className={inputClass}
        />
      </Labelled>

      <Labelled label="Region">
        <select
          name="regionId"
          defaultValue={holiday?.region?.id ?? ""}
          className={selectClass}
        >
          <option value="">All regions</option>
          {regions.map((region) => (
            <option key={region.id} value={region.id}>
              {region.name}
            </option>
          ))}
        </select>
      </Labelled>

      <Labelled label="Note (optional)">
        <input
          name="note"
          defaultValue={holiday?.note ?? ""}
          placeholder="e.g. Office closed"
          className={`${inputClass} sm:col-span-2`}
        />
      </Labelled>
    </div>
  );
}

export default async function HolidaysPage({
  searchParams,
}: {
  searchParams: Promise<{
    y?: string;
    region?: string;
    add?: string;
    edit?: string;
    error?: string;
  }>;
}) {
  const actor = await requirePageRole(Role.ADMIN);
  const params = await searchParams;

  const currentYear = Number(todayIso().slice(0, 4));
  const parsedYear = Number.parseInt(params.y ?? "", 10);
  const year =
    Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100
      ? parsedYear
      : currentYear;

  const regions = await listRegions(actor);

  // Only a region that actually belongs to this organization narrows the list;
  // anything else is ignored rather than rejected, the same way the service
  // treats a member's `?region=`.
  const filter = regions.some((region) => region.id === params.region)
    ? params.region
    : undefined;

  const holidays = await listHolidays(actor, { year, regionId: filter });
  const editing = params.edit
    ? holidays.find((holiday) => holiday.id === params.edit)
    : undefined;

  const totalDays = holidays.reduce((days, holiday) => days + spanDays(holiday), 0);
  const yearHref = (delta: number) => {
    const next = `/holidays?y=${year + delta}`;
    return filter ? `${next}&region=${filter}` : next;
  };

  return (
    <>
      <PageHeader
        title="Holiday calendar"
        subtitle="Public holidays your team sees on their attendance screen."
        meta="ADMIN VIEW"
      />

      {params.error ? (
        <p
          role="alert"
          className="rounded-lg border border-danger-line bg-danger-tint px-3.5 py-2.5 text-[13px] text-danger"
        >
          {params.error}
        </p>
      ) : null}

      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <span className="flex items-center gap-3">
            <Link
              href={yearHref(-1)}
              aria-label="Previous year"
              className="flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 no-underline hover:border-muted"
            >
              ‹
            </Link>
            <h2 className="text-[17px] font-semibold tracking-[-0.01em]">{year}</h2>
            <Link
              href={yearHref(1)}
              aria-label="Next year"
              className="flex size-8 items-center justify-center rounded-lg border border-line bg-surface text-ink-2 no-underline hover:border-muted"
            >
              ›
            </Link>
            <span className="text-[13px] text-muted">
              {holidays.length} {holidays.length === 1 ? "holiday" : "holidays"} ·{" "}
              {totalDays} {totalDays === 1 ? "day" : "days"}
            </span>
          </span>

          <span className="flex flex-wrap items-center gap-2.5">
            {/* A GET form, so picking a region is a plain navigation and the
                choice survives in the URL — no client state to keep in sync. */}
            <form method="get" action="/holidays" className="flex items-center gap-2">
              <input type="hidden" name="y" value={year} />
              <label htmlFor="region-filter" className="text-xs text-muted">
                Region
              </label>
              <select
                id="region-filter"
                name="region"
                defaultValue={filter ?? ""}
                className={selectClass}
              >
                <option value="">Every region</option>
                {regions.map((region) => (
                  <option key={region.id} value={region.id}>
                    {region.name}
                  </option>
                ))}
              </select>
              <button type="submit" className={ghostButtonClass}>
                Show
              </button>
            </form>

            {params.add === "1" ? null : (
              <Link
                href={`/holidays?y=${year}&add=1`}
                className={`${primaryButtonClass} no-underline hover:text-white`}
              >
                Add holiday
              </Link>
            )}
          </span>
        </div>

        {params.add === "1" ? (
          <Card className="border-brand p-5">
            <form action={createHolidayAction} className="flex flex-col gap-4">
              <span className="text-[15px] font-semibold">Add a holiday</span>

              <HolidayFields regions={regions} />

              <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-3.5">
                <button type="submit" className={primaryButtonClass}>
                  Add holiday
                </button>
                <Link
                  href={`/holidays?y=${year}`}
                  className={`${ghostButtonClass} no-underline hover:text-ink`}
                >
                  Cancel
                </Link>
                <span className="text-[12.5px] text-muted">
                  Left on “All regions”, it applies to everyone in the organization.
                </span>
              </div>
            </form>
          </Card>
        ) : null}

        {editing ? (
          <Card className="border-brand p-5">
            <form action={updateHolidayAction} className="flex flex-col gap-4">
              <input type="hidden" name="id" value={editing.id} />
              <span className="text-[15px] font-semibold">Edit {editing.name}</span>

              <HolidayFields holiday={editing} regions={regions} />

              <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-3.5">
                <button type="submit" className={primaryButtonClass}>
                  Save changes
                </button>
                <Link
                  href={`/holidays?y=${year}`}
                  className={`${ghostButtonClass} no-underline hover:text-ink`}
                >
                  Cancel
                </Link>
                <span className="text-[12.5px] text-muted">
                  Clearing the note empties it.
                </span>
              </div>
            </form>
          </Card>
        ) : null}

        {holidays.length === 0 ? (
          <EmptyPanel>
            No holidays on the {year} calendar yet. Add one and everyone in the
            region will see it on their attendance screen.
          </EmptyPanel>
        ) : (
          <Card className="overflow-x-auto">
            <div className="min-w-[760px]">
              <div
                className={`grid ${COLUMNS} gap-4 border-b border-line bg-subtle px-4.5 py-3 font-mono text-[11px] tracking-[0.08em] text-muted`}
              >
                <span>DATE</span>
                <span>HOLIDAY</span>
                <span>REGION</span>
                <span>NOTE</span>
                <span />
              </div>

              {holidays.map((holiday) => {
                const days = spanDays(holiday);

                return (
                  <div
                    key={holiday.id}
                    className={`grid ${COLUMNS} items-center gap-4 border-b border-line px-4.5 py-3 last:border-b-0`}
                  >
                    <span className="flex flex-col gap-0.5">
                      <span className="font-mono text-[13px]">
                        {formatSpan(holiday)}
                      </span>
                      <span className="font-mono text-[11px] text-muted">
                        {formatWeekdayShort(holiday.startDate)}
                        {days > 1 ? ` · ${days} days` : ""}
                      </span>
                    </span>

                    <span className="text-[14px] font-medium">{holiday.name}</span>

                    <span className="text-[13px]">
                      {holiday.region ? (
                        holiday.region.name
                      ) : (
                        <span className="text-muted">All regions</span>
                      )}
                    </span>

                    <span className="truncate text-[13px] text-muted">
                      {holiday.note ?? "—"}
                    </span>

                    <span className="flex items-center gap-2 justify-self-end">
                      <Link
                        href={`/holidays?y=${year}&edit=${holiday.id}`}
                        className={`${ghostButtonClass} px-3 py-1.5 text-[13px] no-underline hover:text-ink`}
                      >
                        Edit
                      </Link>
                      {/* The displayed year rides along so removing a row
                          returns to the year being viewed, not this one. */}
                      <form action={deleteHolidayAction}>
                        <input type="hidden" name="id" value={holiday.id} />
                        <input type="hidden" name="year" value={String(year)} />
                        <button
                          type="submit"
                          className={`${dangerButtonClass} px-3 py-1.5 text-[13px]`}
                        >
                          Remove
                        </button>
                      </form>
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
