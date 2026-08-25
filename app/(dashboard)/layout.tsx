import { Sidebar } from "@/components/sidebar";
import { requireUser } from "@/lib/session";
import { readDb } from "@/lib/store";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  const db = await readDb();

  return (
    <div className="grid min-h-screen grid-cols-[236px_minmax(0,1fr)]">
      <Sidebar user={user} db={db} />
      <main className="flex min-w-0 max-w-[1180px] flex-col gap-7 px-10 pt-9 pb-16">
        {children}
      </main>
    </div>
  );
}
