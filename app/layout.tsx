import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Stacx24 · Leave Management",
  description:
    "Apply, approve, and settle leave in one place. Balances update the moment a request is decided.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className="min-h-full font-sans">{children}</body>
    </html>
  );
}
