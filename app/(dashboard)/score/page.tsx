import { PageHeader } from "@/components/page-header";
import { Card, Meter, MonoLabel } from "@/components/ui";
import { MY_SCORE } from "@/lib/seed";
import { requireMember } from "@/lib/session";

const CHART_HEIGHT = 96;

export default async function ScorePage() {
  await requireMember();

  return (
    <>
      <PageHeader
        title="My score board"
        subtitle="Your year at Stacx24, 2026."
        meta="MEMBER VIEW"
      />

      <div className="flex max-w-[940px] flex-col gap-5">
        <div className="grid items-stretch gap-5 lg:grid-cols-[280px_1fr]">
          <Card className="flex flex-col gap-3.5 p-6">
            <MonoLabel>SCORE 2026</MonoLabel>
            <span className="flex items-baseline gap-2">
              <span className="text-[64px] leading-none font-semibold tracking-[-0.03em]">
                {MY_SCORE.total}
              </span>
              <span className="text-sm text-muted">/ 100</span>
            </span>
            <span className="self-start rounded-full bg-brand-tint px-3 py-[5px] text-[13px] text-brand-dark">
              {MY_SCORE.grade}
            </span>
            <span className="mt-auto text-xs leading-relaxed text-muted">
              {MY_SCORE.note}
            </span>
          </Card>

          <Card className="grid gap-5 p-5.5 sm:grid-cols-2">
            {MY_SCORE.metrics.map((metric) => (
              <div key={metric.label} className="flex flex-col gap-2.5">
                <span className="flex items-baseline justify-between gap-2.5">
                  <span className="text-[13px] text-muted">{metric.label}</span>
                  <span className="text-[19px] font-semibold tracking-[-0.015em]">
                    {metric.value}
                  </span>
                </span>
                <Meter percent={metric.pct} />
                <span className="text-xs text-muted">{metric.detail}</span>
              </div>
            ))}
          </Card>
        </div>

        <div className="grid items-start gap-5 lg:grid-cols-2">
          <Card className="flex flex-col gap-4.5 p-5.5">
            <MonoLabel>BY QUARTER</MonoLabel>
            <div className="flex items-end gap-4.5" style={{ height: CHART_HEIGHT }}>
              {MY_SCORE.quarters.map((quarter) => (
                <span
                  key={quarter.label}
                  className="flex flex-1 flex-col items-center justify-end gap-2"
                >
                  <span className="font-mono text-[13px] font-semibold text-ink-2">
                    {quarter.value}
                  </span>
                  <span
                    className="w-full rounded-t-md rounded-b-sm bg-accent"
                    style={{
                      height: Math.max(6, (quarter.value / 100) * (CHART_HEIGHT - 40)),
                    }}
                  />
                  <span className="text-xs text-muted">{quarter.label}</span>
                </span>
              ))}
            </div>
          </Card>

          <Card className="flex flex-col px-5.5 pt-1.5 pb-3">
            {MY_SCORE.ledger.map((row) => (
              <span
                key={row.label}
                className="flex items-center justify-between gap-3 border-b border-line py-2.5 last:border-b-0"
              >
                <span className="text-[13.5px] text-ink-2">{row.label}</span>
                <span className="font-mono text-[13.5px] font-semibold">
                  {row.value}
                </span>
              </span>
            ))}
          </Card>
        </div>
      </div>
    </>
  );
}
