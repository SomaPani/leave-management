import Link from "next/link";

import type { ScoreDayRecord } from "@/lib/score";

/**
 * Every day of the month, one row each.
 *
 * The chart shows the shape of a month; this shows the numbers behind it. Both
 * are needed because a bar cannot say *why* a day was 40, and a trend cannot be
 * read off a list.
 *
 * A day that was not scored prints dashes and its reason, never six zeros — the
 * same distinction the pipeline preserves in its own Slack post, and the reason
 * every points column here is nullable.
 */

/** What the day was, when that is not simply "a normal working day". */
function noteFor(day: ScoreDayRecord): string {
  if (day.status !== "SCORED") return `Not scored — ${day.reason ?? "unknown"}`;

  const notes: string[] = [];
  const attendance = day.attendance.toLowerCase();
  if (attendance.includes("half day")) notes.push("half day");
  if (attendance === "absent") notes.push("absent");
  if ((day.points.coordination ?? 0) > 0) notes.push(`+${day.points.coordination} coord`);
  if (day.flags.includes("under_committed")) notes.push("under-committed");
  if (day.flags.includes("unplanned_work")) notes.push("unplanned work");
  return notes.join(" · ");
}

export function ScoreDayTable({
  days,
  selectedDate,
  hrefFor,
}: {
  days: ScoreDayRecord[];
  selectedDate?: string;
  hrefFor: (date: string) => string;
}) {
  if (days.length === 0) {
    return (
      <p className="px-5.5 py-6 text-sm text-muted">
        No days have been scored this month.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13.5px]">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="px-4 py-2.5 font-mono text-[11px] tracking-[0.08em] text-muted uppercase">
              Date
            </th>
            <th className="px-4 py-2.5 text-right font-mono text-[11px] tracking-[0.08em] text-muted uppercase">
              Total
            </th>
            <th className="px-4 py-2.5 text-right font-mono text-[11px] tracking-[0.08em] text-muted uppercase">
              Process
            </th>
            <th className="px-4 py-2.5 text-right font-mono text-[11px] tracking-[0.08em] text-muted uppercase">
              Delivery
            </th>
            <th className="px-4 py-2.5 font-mono text-[11px] tracking-[0.08em] text-muted uppercase">
              Band
            </th>
          </tr>
        </thead>
        <tbody>
          {days.map((day) => {
            const scored = day.status === "SCORED";
            const active = day.date === selectedDate;
            const note = noteFor(day);

            return (
              <tr
                key={day.date}
                className={`border-b border-line last:border-b-0 ${
                  active ? "bg-brand-tint" : "hover:bg-subtle"
                }`}
              >
                <td className="px-4 py-2.5">
                  <Link href={hrefFor(day.date)} className="font-mono no-underline">
                    {day.date}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-right font-mono font-semibold">
                  {scored ? day.total : "—"}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-ink-2">
                  {scored ? day.process : "—"}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-ink-2">
                  {scored ? day.delivery : "—"}
                </td>
                <td className="px-4 py-2.5">
                  <span className={scored ? "text-ink-2" : "text-muted"}>
                    {scored ? day.band : ""}
                  </span>
                  {note ? (
                    <span className="text-muted">
                      {scored && day.band ? " · " : ""}
                      {note}
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
