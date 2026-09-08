import { ApplyForm, type ApplyOption } from "@/components/apply-form";
import { PageHeader } from "@/components/page-header";
import { EmptyPanel } from "@/components/ui";
import { todayIso } from "@/lib/attendance";
import { addDays } from "@/lib/date";
import { listHolidays } from "@/lib/holiday-service";
import { chargeYear, offDates } from "@/lib/leave";
import { submitLeaveRequestAction } from "@/lib/leave-actions";
import { listOwnLeaveSummary } from "@/lib/leave-service";
import { requirePageActor } from "@/lib/page-guards";

/**
 * Member: apply for leave.
 *
 * Reads the signed-in member's own policies, balances and approver through
 * `listOwnLeaveSummary`, which takes no user id at all — the member is the
 * session, the same contract `listMemberMonth` has on /calendar.
 *
 * The day count comes from lib/leave.ts and is shared with the form below, so
 * the figure the member sees while picking dates and the figure written to
 * the row are one function rather than two that agree by luck.
 */
export default async function ApplyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const actor = await requirePageActor();
  const params = await searchParams;

  const today = todayIso();
  const year = chargeYear(today);

  const [summary, holidays] = await Promise.all([
    listOwnLeaveSummary(actor),
    // This year and the next: somebody planning in December is picking dates
    // in January, and a preview that quietly stopped counting holidays at the
    // year boundary would be wrong exactly when it matters most.
    listHolidays(actor, { from: `${year}-01-01`, to: `${year + 1}-12-31` }),
  ]);

  const options: ApplyOption[] = summary.balances.map((policy) => ({
    id: policy.id,
    name: policy.name,
    unit: policy.unit,
    balance: policy.balance,
  }));

  const approverName = summary.approver?.name ?? "your admin";

  return (
    <>
      <PageHeader
        title="Apply for leave"
        subtitle="Two weeks' notice for anything over five days."
        meta="MEMBER VIEW"
      />

      {params.error ? (
        <p className="rounded-lg border border-danger-line bg-danger-tint px-3.5 py-2.5 text-sm text-danger">
          {params.error}
        </p>
      ) : null}

      {options.length === 0 ? (
        <EmptyPanel>
          No leave types yet — your admin has not set up any policies for this
          organization.
        </EmptyPanel>
      ) : (
        <ApplyForm
          action={submitLeaveRequestAction}
          options={options}
          approverName={approverName}
          holidayDates={[...offDates(holidays)]}
          defaultFrom={addDays(today, 7)}
          defaultTo={addDays(today, 9)}
        />
      )}
    </>
  );
}
