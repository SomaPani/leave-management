import Link from "next/link";

import type { ScoreDayRecord } from "@/lib/score";

/**
 * A bar per day of the month.
 *
 * Two things the fixture chart got wrong and this does not:
 *
 * Bars scale against the highest total actually in the month, not a fixed
 * ceiling. The old chart mapped 100 to 56px, so a real 82-to-88 spread rendered
 * as three pixels and every bar looked the same height.
 *
 * A day that was not scored renders as a dashed gap with no bar at all.
 * Drawing it as a zero-height bar would say the person scored nothing, which is
 * the one thing `Not Scored` must never be mistaken for.
 */
export function ScoreChart({
  days,
  height = 96,
  hrefFor,
}: {
  days: ScoreDayRecord[];
  height?: number;
  /** When given, each bar links to its own day's breakdown. */
  hrefFor?: (date: string) => string;
}) {
  const totals = days
    .filter((day) => day.status === "SCORED" && day.total !== null)
    .map((day) => day.total as number);

  if (totals.length === 0) {
    return (
      <span
        className="flex items-center justify-center text-xs text-muted"
        style={{ height }}
      >
        Nothing scored this month yet.
      </span>
    );
  }

  // Never below 100, so an ordinary month is not stretched to look dramatic,
  // and never below the observed max, so a 110 still fits.
  const ceiling = Math.max(100, ...totals);
  const barMax = height - 28;

  return (
    <span className="flex items-end gap-1" style={{ height }}>
      {days.map((day) => {
        const scored = day.status === "SCORED" && day.total !== null;
        const dayOfMonth = Number(day.date.slice(8));
        const title = scored
          ? `${day.date} — ${day.total} / 100`
          : `${day.date} — not scored: ${day.reason ?? "unknown"}`;

        const inner = (
          <>
            {scored ? (
              <span
                className="w-full rounded-t-md rounded-b-sm bg-accent"
                style={{
                  height: Math.max(3, ((day.total as number) / ceiling) * barMax),
                }}
              />
            ) : (
              <span className="w-full border-b border-dashed border-line" />
            )}
            <span className="text-[10px] text-muted">{dayOfMonth}</span>
          </>
        );

        const className =
          "flex flex-1 flex-col items-center justify-end gap-1.5 no-underline";

        return hrefFor ? (
          <Link key={day.date} href={hrefFor(day.date)} className={className} title={title}>
            {inner}
          </Link>
        ) : (
          <span key={day.date} className={className} title={title}>
            {inner}
          </span>
        );
      })}
    </span>
  );
}
