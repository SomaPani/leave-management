/**
 * The standing "this isn't real data" notice on the admin screens, plus the
 * per-action line shown after a button that cannot persist anything.
 */

const MESSAGES: Record<string, string> = {
  add: "the new team member was not saved.",
  policy: "the policy change was not saved.",
  wfh: "the work-from-home policy change was not saved.",
  rule: "the approval rule was not saved.",
  upload: "the document was not uploaded.",
  remove: "the document was not removed.",
};

export function DemoBanner({ action }: { action?: string }) {
  const detail = action ? MESSAGES[action] : undefined;

  return (
    <p className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-2.5 text-[13px] text-warn-ink">
      {detail
        ? `Sample data — ${detail}`
        : "Sample data — nothing on this screen is saved."}
    </p>
  );
}
