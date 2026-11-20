import { formatPercent, type TrendPoint } from "@/lib/attendance-report";

/**
 * The Employee dashboard's two charts, as server-rendered SVG — no chart
 * library and no client script. Hover detail is the SVG `<title>` tooltip;
 * every chart has the same numbers as text beside it or in a screen-reader
 * table, so nothing is read from colour alone.
 */

const BRAND = "#2e8b57";
const TRACK = "#e2e8f0";

/**
 * Overall attendance as a single-value ring.
 *
 * Deliberately one colour: the four status colours (green, red, blue, amber)
 * cannot sit next to each other in a ring and stay distinguishable for
 * colour-blind readers, so the per-status split is the labelled list beside
 * it instead.
 */
export function AttendanceRing({ percent }: { percent: number | null }) {
  const r = 52;
  const circumference = 2 * Math.PI * r;
  const filled = percent === null ? 0 : (Math.min(percent, 100) / 100) * circumference;

  return (
    <figure className="relative m-0 h-[148px] w-[148px] shrink-0">
      <svg viewBox="0 0 148 148" className="h-full w-full -rotate-90" aria-hidden="true">
        <circle cx="74" cy="74" r={r} fill="none" stroke={TRACK} strokeWidth="14" />
        {filled > 0 ? (
          <circle
            cx="74"
            cy="74"
            r={r}
            fill="none"
            stroke={BRAND}
            strokeWidth="14"
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circumference}`}
          >
            <title>{`Overall attendance ${formatPercent(percent)}`}</title>
          </circle>
        ) : null}
      </svg>
      <figcaption className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="text-[19px] leading-none font-semibold tabular-nums">{formatPercent(percent)}</span>
        <span className="mt-1 text-[11px] leading-tight text-muted">
          Overall
          <br />
          attendance
        </span>
      </figcaption>
    </figure>
  );
}

/** Attendance % over the period, one series. Empty buckets are gaps. */
export function TrendChart({ points, caption }: { points: TrendPoint[]; caption: string }) {
  const W = 560;
  const H = 220;
  const pad = { top: 12, right: 30, bottom: 30, left: 44 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;

  const x = (i: number) =>
    pad.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (p: number) => pad.top + innerH - (p / 100) * innerH;

  // Break the line wherever a bucket has no figure.
  let d = "";
  let drawing = false;
  points.forEach((point, i) => {
    if (point.percent === null) {
      drawing = false;
      return;
    }
    d += `${drawing ? "L" : "M"}${x(i).toFixed(1)},${y(point.percent).toFixed(1)} `;
    drawing = true;
  });

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={caption}>
        {[0, 25, 50, 75, 100].map((tick) => (
          <g key={tick}>
            <line
              x1={pad.left}
              x2={W - pad.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke={TRACK}
              strokeWidth="1"
            />
            <text
              x={pad.left - 8}
              y={y(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-muted text-[11px]"
            >
              {tick}%
            </text>
          </g>
        ))}

        {points.map((point, i) => (
          <text
            key={point.label}
            x={x(i)}
            y={H - 8}
            textAnchor="middle"
            className="fill-muted text-[11px]"
          >
            {point.label}
          </text>
        ))}

        {d ? (
          <path d={d} fill="none" stroke={BRAND} strokeWidth="2" strokeLinejoin="round" />
        ) : null}

        {points.map((point, i) =>
          point.percent === null ? null : (
            <g key={point.label}>
              {/* A bigger invisible target than the dot, for the tooltip. */}
              <circle cx={x(i)} cy={y(point.percent)} r="12" fill="transparent">
                <title>{`${point.label}: ${formatPercent(point.percent)}`}</title>
              </circle>
              <circle
                cx={x(i)}
                cy={y(point.percent)}
                r="4.5"
                fill={BRAND}
                stroke="#ffffff"
                strokeWidth="2"
                pointerEvents="none"
              />
            </g>
          ),
        )}
      </svg>

      <table className="sr-only">
        <caption>{caption}</caption>
        <tbody>
          {points.map((point) => (
            <tr key={point.label}>
              <th scope="row">{point.label}</th>
              <td>{formatPercent(point.percent)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
