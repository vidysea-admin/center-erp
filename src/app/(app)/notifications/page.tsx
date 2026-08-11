"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/client";
import { Btn, Chip, ErrorBanner, Section, Tabs } from "@/components/ui";

const SEVERITY_STYLE: Record<string, string> = {
  critical: "border-red-200 bg-red-50 text-red-800",
  warning: "border-amber-200 bg-amber-50 text-amber-800",
  info: "border-blue-200 bg-blue-50 text-blue-800",
};

export default function NotificationsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [tab, setTab] = useState("Open");
  const [error, setError] = useState("");

  const load = () => api(`/api/notifications?status=${tab === "Open" ? "open" : tab === "Resolved" ? "Resolved" : "all"}`)
    .then((d) => setItems(d.items)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [tab]);

  async function act(id: string, status: string) {
    try { await api(`/api/notifications/${id}`, { method: "POST", json: { status } }); load(); }
    catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Alerts</h1>
        <p className="text-sm text-gray-500">Conditions the system is watching for you — raised automatically, cleared when they no longer hold</p>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      <Tabs tabs={["Open", "Resolved", "All"]} active={tab} onChange={setTab} />
      <Section title={`${items.length} alert${items.length === 1 ? "" : "s"}`}>
        {items.length === 0 ? (
          <p className="text-sm text-gray-400">Nothing to act on. 🎉</p>
        ) : (
          <ul className="space-y-2">
            {items.map((n) => (
              <li key={n._id} className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 ${SEVERITY_STYLE[n.severity] ?? SEVERITY_STYLE.info}`}>
                <div className="min-w-0">
                  <div className="text-sm font-medium">{n.message}</div>
                  <div className="mt-0.5 text-xs opacity-70">
                    {n.location?.name ? `${n.location.name} · ` : ""}
                    {new Date(n.createdAt).toLocaleString("en-IN")}
                    {n.acknowledged_by?.name ? ` · acknowledged by ${n.acknowledged_by.name}` : ""}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Chip value={n.status} />
                  {n.link && <Link href={n.link}><Btn small kind="ghost">Open</Btn></Link>}
                  {n.status === "New" && <Btn small kind="ghost" onClick={() => act(n._id, "Acknowledged")}>Acknowledge</Btn>}
                  {n.status !== "Resolved" && <Btn small onClick={() => act(n._id, "Resolved")}>Resolve</Btn>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
