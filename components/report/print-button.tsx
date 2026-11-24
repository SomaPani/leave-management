"use client";

import { useEffect } from "react";

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

/**
 * Opens the print dialog once the page has rendered. Used by the one-employee
 * PDF export, which opens the dashboard filtered to that person in a new tab.
 */
export function AutoPrint() {
  useEffect(() => {
    const timer = window.setTimeout(() => window.print(), 300);
    return () => window.clearTimeout(timer);
  }, []);
  return null;
}
