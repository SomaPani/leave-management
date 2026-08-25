import { ApplyForm, type ApplyOption } from "@/components/apply-form";
import { PageHeader } from "@/components/page-header";
import { submitLeaveRequest } from "@/lib/actions";
import { TODAY, addDays } from "@/lib/date";
import { balanceOf } from "@/lib/domain";
import { requireMember } from "@/lib/session";
import { readDb } from "@/lib/store";

export default async function ApplyPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireMember();
  const { error } = await searchParams;
  const db = await readDb();

  const options: ApplyOption[] = db.policies.map((policy) => ({
    name: policy.name,
    unit: policy.unit === "uses" ? "uses" : "days",
    balance: balanceOf(db, user.id, policy.name),
  }));

  const approver =
    db.people.find((p) => p.name === user.manager) ??
    db.people.find((p) => p.role === "admin");

  return (
    <>
      <PageHeader
        title="Apply for leave"
        subtitle="Two weeks' notice for anything over five days."
        meta="MEMBER VIEW"
      />

      {error ? (
        <p className="rounded-lg border border-danger-line bg-danger-tint px-3.5 py-2.5 text-sm text-danger">
          {error === "range"
            ? "That range has no working days in it. Pick a weekday span."
            : "Something in that request didn't look right. Check the type and dates."}
        </p>
      ) : null}

      <ApplyForm
        action={submitLeaveRequest}
        options={options}
        approverName={approver?.name ?? "your admin"}
        defaultFrom={addDays(TODAY, 7)}
        defaultTo={addDays(TODAY, 9)}
      />
    </>
  );
}
