import { CHECKS, type ScoreDayRecord } from "@/lib/score";

/**
 * One day, check by check.
 *
 * The six lines are the whole rubric, so a person can see where a score came
 * from without opening a spreadsheet. Per-task evidence — which ticket passed
 * which check, with Jira links — is deliberately not here: it lives in the
 * pipeline's Slack DM, and putting it on this panel would turn a readable
 * breakdown into a wall.
 *
 * A day that was not scored says so instead of printing six zeros. That
 * distinction is the whole reason the columns are nullable.
 */
export function ScoreDayPanel({ day }: { day: ScoreDayRecord }) {
  if (day.status !== "SCORED") {
    return (
      <span className="flex flex-col gap-1.5 py-2">
        <span className="text-sm font-semibold">{day.date}</span>
        <span className="text-[13px] text-muted">
          Not scored — {day.reason ?? "reason not recorded"}. This day is left out
          of the month average.
        </span>
      </span>
    );
  }

  return (
    <span className="flex flex-col gap-2.5 py-1">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold">{day.date}</span>
        <span className="text-[13px] text-muted">
          {day.total} / 100 · {day.band}
        </span>
      </span>

      {CHECKS.map((check) => (
        <span key={check.key} className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-ink-2">{check.label}</span>
          <span className="font-mono text-[13px]">
            {day.points[check.key] ?? "—"}
            <span className="text-muted"> / {check.cap}</span>
          </span>
        </span>
      ))}

      {(day.points.coordination ?? 0) > 0 ? (
        <span className="flex items-center justify-between gap-3">
          <span className="text-[13px] text-ink-2">Coordination bonus</span>
          <span className="font-mono text-[13px]">+{day.points.coordination}</span>
        </span>
      ) : null}

      {day.pickedTasks.length > 0 ? (
        <span className="flex flex-wrap gap-1.5 border-t border-line pt-2.5">
          {day.pickedTasks.map((key) => (
            <span
              key={key}
              className="rounded bg-subtle px-2 py-0.5 font-mono text-[12px]"
            >
              {key}
            </span>
          ))}
        </span>
      ) : (
        <span className="border-t border-line pt-2.5 text-[12.5px] text-muted">
          No ticket was named in the stand-up that day.
        </span>
      )}
    </span>
  );
}
