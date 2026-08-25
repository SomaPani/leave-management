import { DateNav } from "@/components/date-nav";
import { PageHeader } from "@/components/page-header";
import { Avatar, Card, inputClass, primaryButtonClass } from "@/components/ui";
import { markAttendance, markEveryonePresent } from "@/lib/actions";
import { TODAY, formatLong, isValidDate, isWeekend } from "@/lib/date";
import {
  attendanceCodes,
  attendanceOptionsFor,
  isAutoFilled,
  isRemote,
  onApprovedLeave,
  roster,
} from "@/lib/domain";
import { requireAdmin } from "@/lib/session";
import { readDb } from "@/lib/store";
import { ATTENDANCE_ORDER, ATTENDANCE_STYLE } from "@/lib/ui";
import type { AttendanceCode, WorkMode } from "@/lib/types";

const MODES: { key: WorkMode; label: string }[] = [
  { key: "WFO", label: "Work from office" },
  { key: "WFH", label: "Work from home" },
];

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  await requireAdmin();

  const params = await searchParams;
  const date =
    params.date && isValidDate(params.date) ? params.date : TODAY;

  const db = await readDb();
  const people = roster(db);

  const counts: Record<AttendanceCode | "unmarked", number> = {
    present: 0,
    half: 0,
    wfh: 0,
    absent: 0,
    leave: 0,
    short: 0,
    unmarked: 0,
  };

  for (const person of people) {
    const codes = attendanceCodes(db, person.id, date);
    if (codes.length === 0) counts.unmarked++;
    else for (const code of codes) counts[code]++;
  }

  return (
    <>
      <PageHeader
        title="Attendance"
        subtitle="Mark the day for everyone. Approved leave fills itself in."
      />

      <div className="flex max-w-[900px] flex-col gap-5">
        <Card className="flex flex-wrap items-center gap-5 px-5 py-4.5">
          <label
            className="flex flex-col gap-1.5 font-mono text-[11px] tracking-[0.06em] text-muted"
            htmlFor="attendance-date"
          >
            DATE
            <DateNav id="attendance-date" value={date} className={inputClass} />
          </label>

          <span className="flex flex-1 flex-col gap-1.5">
            <span className="text-[15px] font-semibold">{formatLong(date)}</span>
            <span className="flex flex-wrap gap-2">
              {ATTENDANCE_ORDER.map((code) => (
                <span
                  key={code}
                  className={`flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-xs ${ATTENDANCE_STYLE[code].chip}`}
                >
                  <span className="font-mono font-semibold">{counts[code]}</span>
                  {ATTENDANCE_STYLE[code].label}
                </span>
              ))}
              <span className="flex items-center gap-1.5 rounded-full bg-line px-2.5 py-[3px] text-xs text-muted">
                <span className="font-mono font-semibold">{counts.unmarked}</span>
                Unmarked
              </span>
            </span>
          </span>

          <form action={markEveryonePresent}>
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

        {MODES.map((mode) => {
          const rows = people.filter((p) => (p.workMode ?? "WFO") === mode.key);
          if (rows.length === 0) return null;

          return (
            <section key={mode.key} className="flex flex-col gap-2.5">
              <h2 className="text-[15px] font-semibold tracking-[-0.01em]">
                {mode.label}
              </h2>

              <Card className="overflow-hidden">
                {rows.map((person) => {
                  const codes = attendanceCodes(db, person.id, date);
                  const auto = isAutoFilled(db, person.id, date);
                  const autoLeave = auto && onApprovedLeave(db, person.id, date);
                  const autoWfh = auto && !autoLeave && isRemote(db, person.id);

                  const note = autoLeave
                    ? "Approved leave"
                    : autoWfh
                      ? "Default (WFH)"
                      : codes.length
                        ? codes.map((c) => ATTENDANCE_STYLE[c].label).join(" + ")
                        : "Not marked yet";

                  const noteClass = autoLeave
                    ? "text-[#4338ca]"
                    : autoWfh
                      ? "text-[#16a34a]"
                      : "text-muted";

                  return (
                    <div
                      key={person.id}
                      className="flex flex-wrap items-center gap-4 border-b border-line px-4.5 py-3.5 last:border-b-0"
                    >
                      <Avatar initials={person.initials} size={32} />
                      <span className="flex flex-1 flex-col gap-0.5">
                        <span className="text-sm font-semibold">{person.name}</span>
                        <span className={`text-xs ${noteClass}`}>{note}</span>
                      </span>

                      <span className="flex flex-wrap gap-1.5">
                        {attendanceOptionsFor(db, person.id).map((code) => {
                          const active = codes.includes(code);
                          const style = ATTENDANCE_STYLE[code];
                          return (
                            <form key={code} action={markAttendance}>
                              <input type="hidden" name="userId" value={person.id} />
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
                                {style.label}
                              </button>
                            </form>
                          );
                        })}
                      </span>
                    </div>
                  );
                })}
              </Card>
            </section>
          );
        })}
      </div>
    </>
  );
}
