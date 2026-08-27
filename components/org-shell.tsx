import Link from "next/link";

import type { Role } from "@/generated/prisma/enums";
import { signOutAction } from "@/lib/org-actions";

/**
 * Shared chrome for the organization backbone pages.
 *
 * Deliberately unstyled beyond browser defaults and a little spacing — the
 * design calls this cut "functional (unstyled) pages", and the polished
 * dashboard is explicitly out of scope. The leave-management screens keep their
 * own Tailwind shell.
 */

const NAV: Record<Role, { href: string; label: string }[]> = {
  SUPERADMIN: [
    { href: "/organizations", label: "Organizations" },
    { href: "/admins", label: "Admins" },
  ],
  ADMIN: [{ href: "/members", label: "Members" }],
  MEMBER: [{ href: "/account", label: "My account" }],
};

export function OrgShell({
  title,
  role,
  email,
  error,
  children,
}: {
  title: string;
  role: Role;
  email: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <main style={{ maxWidth: "60rem", margin: "0 auto", padding: "2rem 1.5rem" }}>
      <header
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "1rem",
          borderBottom: "1px solid #ccc",
          paddingBottom: "0.75rem",
          marginBottom: "1.5rem",
        }}
      >
        <strong>{title}</strong>
        <nav style={{ display: "flex", gap: "0.75rem" }}>
          {NAV[role].map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>
        <span style={{ marginLeft: "auto", fontSize: "0.875rem" }}>
          {email} ({role.toLowerCase()})
        </span>
        <form action={signOutAction}>
          <button type="submit">Sign out</button>
        </form>
      </header>

      {error ? (
        <p role="alert" style={{ color: "#b00020", marginBottom: "1rem" }}>
          {error}
        </p>
      ) : null}

      {children}
    </main>
  );
}

/** A labelled input row, so the forms below stay readable. */
export function Field({
  label,
  name,
  type = "text",
  required = true,
  ...rest
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label style={{ display: "block", marginBottom: "0.5rem" }}>
      <span style={{ display: "block", fontSize: "0.875rem" }}>{label}</span>
      <input name={name} type={type} required={required} {...rest} />
    </label>
  );
}

export function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: "2.5rem" }}>
      <h2 style={{ fontSize: "1.05rem", marginBottom: "0.75rem" }}>{heading}</h2>
      {children}
    </section>
  );
}
