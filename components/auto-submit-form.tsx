"use client";

import { useRef, type ReactNode } from "react";

/**
 * A form that submits itself whenever one of its controls changes, so selects,
 * date pickers and number fields save without a separate "Save" button.
 *
 * `change` bubbles, so this covers every control inside the form. Text and
 * number inputs fire it on blur (or Enter), selects and date pickers fire it
 * immediately — which matches how the design behaves.
 */
export function AutoSubmitForm({
  action,
  children,
  className,
}: {
  action: (formData: FormData) => void | Promise<void>;
  children: ReactNode;
  className?: string;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <form
      ref={formRef}
      action={action}
      className={className}
      onChange={() => formRef.current?.requestSubmit()}
    >
      {children}
      {/* Keeps the form usable before hydration and with JS disabled. */}
      <noscript>
        <button type="submit" className="text-xs underline">
          Save
        </button>
      </noscript>
    </form>
  );
}
