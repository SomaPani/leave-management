"use client";

/**
 * "Export to PDF": the browser's own print dialog, where "Save as PDF" is a
 * destination. The page hides its sidebar and controls under `print:`.
 */
export function PrintButton({ className }: { className: string }) {
  return (
    <button type="button" onClick={() => window.print()} className={className}>
      Export to PDF
    </button>
  );
}
