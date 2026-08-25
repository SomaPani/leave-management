import { AutoSubmitForm } from "@/components/auto-submit-form";
import { PageHeader } from "@/components/page-header";
import { Card } from "@/components/ui";
import {
  setHolidayRegion,
  toggleApprovalRule,
  updatePolicy,
  updateWfhPolicy,
} from "@/lib/actions";
import { formatDayMonth, formatWeekdayShort, isWeekend } from "@/lib/date";
import { holidayYearGrid, holidaysForRegion } from "@/lib/domain";
import { REGIONS } from "@/lib/seed";
import { requireAdmin } from "@/lib/session";
import { readDb } from "@/lib/store";

const HOLIDAY_YEAR = 2026;

const numberFieldClass =
  "w-[88px] rounded-lg border border-line bg-subtle px-2.5 py-2 font-mono text-sm text-ink";

const fieldLabelClass =
  "flex flex-col gap-1.5 font-mono text-[11px] tracking-[0.06em] text-muted";

export default async function SetupPage() {
  await requireAdmin();

  const db = await readDb();
  const region = db.holidayRegion;
  const holidays = holidaysForRegion(db, region);
  const totalHolidayDays = holidays.reduce((n, h) => n + h.days, 0);
  const months = holidayYearGrid(holidays, HOLIDAY_YEAR);

  return (
    <>
      <PageHeader
        title="Leave setup"
        subtitle="Policy the whole agency runs on."
        meta="ADMIN VIEW"
      />

      <div className="flex max-w-[940px] flex-col gap-5">
        {db.policies.map((policy, index) => (
          <Card
            key={policy.name}
            className="grid items-center gap-5 p-5 sm:grid-cols-[1fr_auto_auto]"
          >
            <span className="flex flex-col gap-1.5">
              <span className="text-[15px] font-semibold">{policy.name}</span>
              <span className="text-[13px] text-muted">{policy.note}</span>
            </span>

            <AutoSubmitForm action={updatePolicy} className={fieldLabelClass}>
              <input type="hidden" name="index" value={index} />
              <input type="hidden" name="intent" value="days" />
              <span>{policy.unit === "uses" ? "USES / YEAR" : "DAYS / YEAR"}</span>
              <input
                type="number"
                name="days"
                min={0}
                defaultValue={policy.days}
                aria-label={`${policy.name} allowance`}
                className={numberFieldClass}
              />
            </AutoSubmitForm>

            <form action={updatePolicy} className={fieldLabelClass}>
              <input type="hidden" name="index" value={index} />
              <input type="hidden" name="intent" value="carry" />
              <span>CARRY OVER</span>
              <button
                type="submit"
                aria-pressed={policy.carry}
                className={`w-[88px] cursor-pointer rounded-lg border border-line px-2.5 py-2 text-[13px] ${
                  policy.carry
                    ? "bg-brand-tint text-brand"
                    : "bg-surface text-muted"
                }`}
              >
                {policy.carry ? "Allowed" : "Lapses"}
              </button>
            </form>
          </Card>
        ))}

        <Card className="grid items-center gap-5 p-5 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
          <span className="flex flex-col gap-1.5">
            <span className="text-[15px] font-semibold">WFH</span>
            <span className="text-[13px] text-muted">
              Two days a month, booked a day ahead. Resets on the 1st —{" "}
              {db.wfhPolicy.perMonth * 12} days a year.
            </span>
          </span>

          <AutoSubmitForm action={updateWfhPolicy} className={fieldLabelClass}>
            <input type="hidden" name="intent" value="days" />
            <span>DAYS / MONTH</span>
            <input
              type="number"
              name="perMonth"
              min={0}
              defaultValue={db.wfhPolicy.perMonth}
              aria-label="WFH days per month"
              className={numberFieldClass}
            />
          </AutoSubmitForm>

          <form action={updateWfhPolicy} className={fieldLabelClass}>
            <input type="hidden" name="intent" value="approval" />
            <span>APPROVAL</span>
            <button
              type="submit"
              aria-pressed={db.wfhPolicy.needsApproval}
              className={`w-[110px] cursor-pointer rounded-lg border border-line px-2.5 py-2 text-[13px] ${
                db.wfhPolicy.needsApproval
                  ? "bg-brand-tint text-brand-dark"
                  : "bg-surface text-muted"
              }`}
            >
              {db.wfhPolicy.needsApproval ? "Required" : "Not needed"}
            </button>
          </form>
        </Card>

        <Card className="flex flex-col gap-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-baseline gap-2.5">
              <h2 className="text-[15px] font-semibold">
                Holiday calendar {HOLIDAY_YEAR}
              </h2>
              <span className="font-mono text-xs text-muted">
                {region} · {totalHolidayDays} DAYS
              </span>
            </span>

            <div className="flex gap-1.5">
              {REGIONS.map((option) => {
                const active = option === region;
                return (
                  <form key={option} action={setHolidayRegion}>
                    <input type="hidden" name="region" value={option} />
                    <button
                      type="submit"
                      aria-pressed={active}
                      className={`cursor-pointer rounded-full border px-3.5 py-[5px] text-xs ${
                        active
                          ? "border-brand bg-brand text-white"
                          : "border-line bg-surface text-ink-2 hover:border-muted"
                      }`}
                    >
                      {option}
                    </button>
                  </form>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-x-5 gap-y-4.5">
            {months.map((month) => (
              <div key={month.key} className="flex flex-col gap-1.5">
                <span
                  className={`font-mono text-[11px] tracking-[0.12em] ${
                    month.hasHolidays ? "text-ink" : "text-[#cbd5e1]"
                  }`}
                >
                  {month.label}
                </span>
                <div className="grid grid-cols-7 gap-0.5">
                  {month.cells.map((cell) => (
                    <span
                      key={cell.key}
                      title={cell.holiday ?? undefined}
                      className={`flex aspect-square items-center justify-center rounded-full text-[9.5px] ${
                        cell.holiday
                          ? "bg-accent font-semibold text-white"
                          : "text-ink-2"
                      }`}
                    >
                      {cell.day ?? ""}
                    </span>
                  ))}
                </div>
                <span className="flex min-h-3.5 flex-col gap-px">
                  {month.names.map((name) => (
                    <span
                      key={name}
                      className="text-[10.5px] leading-tight text-accent-ink"
                    >
                      {name}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>

          <ul className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-x-6 border-t border-line pt-1.5">
            {holidays.map((holiday) => {
              const weekend = isWeekend(holiday.date);
              return (
                <li
                  key={`${holiday.name}-${holiday.date}`}
                  className="flex items-center gap-2.5 border-b border-line py-2.5"
                >
                  <span className="size-1.5 shrink-0 rounded-full bg-accent" />
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span
                      className={`text-[12.5px] font-semibold ${
                        weekend ? "text-muted" : "text-ink"
                      }`}
                    >
                      {holiday.name}
                    </span>
                    <span className="text-[11px] text-muted">
                      {holiday.note ?? (weekend ? "Falls on a weekend" : "")}
                    </span>
                  </span>
                  <span className="font-mono text-[11.5px] whitespace-nowrap text-muted">
                    {formatDayMonth(holiday.date)} · {formatWeekdayShort(holiday.date)}
                  </span>
                  <span
                    className={`rounded-full px-2 py-[2px] text-[10.5px] whitespace-nowrap ${
                      holiday.days === 2
                        ? "bg-warn-tint text-[#d97706]"
                        : "bg-[#f1f5f9] text-muted"
                    }`}
                  >
                    {holiday.days === 2 ? "2 days" : "1 day"}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card className="flex flex-col gap-3.5 p-5">
          <h2 className="text-[15px] font-semibold">Approval rules</h2>
          {db.rules.map((rule, index) => (
            <form key={rule.label} action={toggleApprovalRule}>
              <input type="hidden" name="index" value={index} />
              <button
                type="submit"
                role="switch"
                aria-checked={rule.on}
                className="flex cursor-pointer items-center gap-3 border-0 bg-transparent p-0 text-left"
              >
                <span
                  className={`flex h-[22px] w-[38px] rounded-full p-[3px] transition-colors ${
                    rule.on ? "justify-end bg-accent" : "justify-start bg-[#d6d4ce]"
                  }`}
                >
                  <span className="size-4 rounded-full bg-white" />
                </span>
                <span className="text-sm text-ink">{rule.label}</span>
              </button>
            </form>
          ))}
        </Card>
      </div>
    </>
  );
}
