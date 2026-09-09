import { DateNav } from "@/components/date-nav";
import { PageHeader } from "@/components/page-header";
import {
  Avatar,
  Card,
  EmptyPanel,
  inputClass,
  primaryButtonClass,
} from "@/components/ui";
import { AttendanceStatus, AttendanceModifier, WorkMode } from "@/generated/prisma/enums";
import {
  codeLabel,
  describeState,
  isActiveCode,
  isFutureDate,
  todayIso,
  ATTENDANCE_CODES,
} from "@/lib/attendance";
import {
  markAttendanceAction,
  markEveryonePresentAction,
} from "@/lib/attendance-actions";
import { listDayAttendance, type AttendanceDayRow } from "@/lib/attendance-service";
import { formatHeader, formatLong, isValidDate, isWeekend } from "@/lib/date";
import { initialsFor } from "@/lib/domain";
import { requirePageActor } from "@/lib/page-guards";
import { ATTENDANCE_STYLE } from "@/lib/ui";

/**
 * Admin: mark the day for the organization's roster.
 *
 * Reads `orgapp.Attendance` through lib/attendance-service.ts — the same
 * functions `/api/attendance` calls — so the screen and the API cannot drift.
 *
 * The date defaults to today and is clamped: the service refuses a future day,
 * and this page does not offer the buttons for one either.
 */

const MODES: { key: WorkMode; label: string }[] = [
  { key: WorkMode.WFO, label: "Work from office" },
  { key: WorkMode.WFH, label: "Work from home" },
];

/** The four bases, in the order the pills read. */
const STATUS_PILLS = [
  AttendanceStatus.PRESENT,
  AttendanceStatus.WFH,
  AttendanceStatus.ABSENT,
  AttendanceStatus.LEAVE,
] as const;

const MODIFIER_PILLS = [
  AttendanceModifier.HALF_DAY,
  AttendanceModifier.SHORT_LEAVE,
] as const;

/**
 * Status counts sum to headcount. The two add-on counts deliberately overlap
 * them — a Present + Half day person is one of the Present — so they are
 * rendered as a separate, labelled row rather than mixed into one line that
 * appears not to add up.
 */
function summarize(rows: AttendanceDayRow[]) {
  const status: Record<AttendanceStatus, number> = {
    PRESENT: 0,
    WFH: 0,
    ABSENT: 0,
    LEAVE: 0,
  };
  const modifier: Record<AttendanceModifier, number> = {
    HALF_DAY: 0,
    SHORT_LEAVE: 0,
  };
  let unmarked = 0;

  for (const row of rows) {
    if (!row.state) {
      unmarked++;
      continue;
    }
    status[row.state.status]++;
    if (row.state.modifier) modifier[row.state.modifier]++;
  }

  return { status, modifier, unmarked };
}

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string; error?: string }>;
}) {
  const actor = await requirePageActor();
  const params = await searchParams;

  const today = todayIso();
  const requested = params.date && isValidDate(params.date) ? params.date : today;
  // A future date in the URL falls back to today rather than erroring: the page
  // is linkable, and a stale link should still open on something useful.
  const date = isFutureDate(requested, today) ? today : requested;

  const rows = await listDayAttendance(actor, date);
  const counts = summarize(rows);
  const anyModifiers = MODIFIER_PILLS.some((code) => counts.modifier[code] > 0);

  return (
    <>
      <PageHeader
        title="Attendance"
        subtitle="Mark the day for everyone. Today and any past day can be corrected."
        meta={formatHeader(date)}
      />

      {params.error ? (
        <p className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-2.5 text-[13px] text-warn-ink">
          {params.error}
        </p>
      ) : null}

      <div className="flex max-w-[900px] flex-col gap-5">
        <Card className="flex flex-wrap items-center gap-5 px-5 py-4.5">
          <label
            className="flex flex-col gap-1.5 font-mono text-[11px] tracking-[0.06em] text-muted"
            htmlFor="attendance-date"
          >
            DATE
            <DateNav
              id="attendance-date"
              value={date}
              max={today}
              className={inputClass}
            />
          </label>

          <span className="flex flex-1 flex-col gap-1.5">
            <span className="text-[15px] font-semibold">{formatLong(date)}</span>

            <span className="flex flex-wrap gap-2">
              {STATUS_PILLS.map((code) => (
                <span
                  key={code}
                  className={`flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-xs ${ATTENDANCE_STYLE[code].chip}`}
                >
                  <span className="font-mono font-semibold">{counts.status[code]}</span>
                  {codeLabel(code)}
                </span>
              ))}
              <span className="flex items-center gap-1.5 rounded-full bg-line px-2.5 py-[3px] text-xs text-muted">
                <span className="font-mono font-semibold">{counts.unmarked}</span>
                Unmarked
              </span>
            </span>

            {anyModifiers ? (
              <span className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                of whom
                {MODIFIER_PILLS.map((code) => (
                  <span
                    key={code}
                    className={`flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-xs ${ATTENDANCE_STYLE[code].chip}`}
                  >
                    <span className="font-mono font-semibold">
                      {counts.modifier[code]}
                    </span>
                    {codeLabel(code)}
                  </span>
                ))}
              </span>
            ) : null}
          </span>

          <form action={markEveryonePresentAction}>
            <input type="hidden" name="date" value={date} />
            <button type="submit" className={`${primaryButtonClass} whitespace-nowrap`}>
              Mark all present
            </button>
          </form>
        </Card>

        {isWeekend(date) ? (
          <div className="rounded-[10px] border border-warn-line bg-warn-tint px-4 py-3 text-[13px] text-warn-ink">
            That&apos;s a weekend — most agencies leave it unmarked.
          </div>
        ) : null}

        {rows.length === 0 ? (
          <EmptyPanel>
            No team members yet. Add people on the Team screen and they will appear
            here.
          </EmptyPanel>
        ) : null}

        {MODES.map((mode) => {
          // A member with no work mode set is treated as office-based, which is
          // the default an agency assumes.
          const inMode = rows.filter(
            (row) => (row.member.workMode ?? WorkMode.WFO) === mode.key,
          );
          if (inMode.length === 0) return null;

          return (
            <section key={mode.key} className="flex flex-col gap-2.5">
              <h2 className="text-[15px] font-semibold tracking-[-0.01em]">
                {mode.label}
              </h2>

              <Card className="overflow-hidden">
                {inMode.map(({ member, state }) => (
                  <div
                    key={member.id}
                    className="flex flex-wrap items-center gap-4 border-b border-line px-4.5 py-3.5 last:border-b-0"
                  >
                    <Avatar initials={initialsFor(member.name)} size={32} />
                    <span className="flex flex-1 flex-col gap-0.5">
                      <span className="text-sm font-semibold">{member.name}</span>
                      <span className="text-xs text-muted">{describeState(state)}</span>
                    </span>

                    <span
                      className="flex flex-wrap gap-1.5"
                      role="group"
                      aria-label={`Attendance for ${member.name}`}
                    >
                      {ATTENDANCE_CODES.map((code) => {
                        const active = isActiveCode(state, code);
                        const style = ATTENDANCE_STYLE[code];
                        return (
                          <form key={code} action={markAttendanceAction}>
                            <input type="hidden" name="userId" value={member.id} />
                            <input type="hidden" name="date" value={date} />
                            <input type="hidden" name="code" value={code} />
                            <button
                              type="submit"
                              aria-pressed={active}
                              className={`cursor-pointer rounded-[7px] border px-3 py-1.5 text-[12.5px] transition-colors ${
                                active
                                  ? `${style.chip} ${style.border}`
                                  : "border-line bg-surface text-muted hover:border-muted"
                              }`}
                            >
                              {codeLabel(code)}
                            </button>
                          </form>
                        );
                      })}
                    </span>
                  </div>
                ))}
              </Card>
            </section>
          );
        })}
      </div>
    </>
  );
}
