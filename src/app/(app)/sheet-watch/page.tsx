"use client";
// Sheet Watch (2026-08-11 meeting): the client edits their workbook in place and tells
// nobody. Every cell change the poller detects lands here — old → new, highlighted, with
// row and column named — for the team to mark Seen/Accepted. Advisory only: nothing here
// writes to ERP records.
import { useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client";
import { Btn, Chip, DataTable, ErrorBanner, inputCls } from "@/components/ui";

const TYPE_STYLE: Record<string, string> = {
  Added: "bg-green-50 text-green-700 border-green-200",
  Removed: "bg-red-50 text-red-700 border-red-200",
  Modified: "bg-amber-50 text-amber-700 border-amber-200",
};

export default function SheetWatchPage() {
  const [items, setItems] = useState<any[]>([]);
  const [tabs, setTabs] = useState<string[]>([]);
  const [status, setStatus] = useState("New");
  const [tab, setTab] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    api(`/api/workbook-changes?status=${status}${tab ? `&tab=${encodeURIComponent(tab)}` : ""}`)
      .then((d) => { setItems(d.items); setTabs(d.tabs ?? []); setSelected(new Set()); })
      .catch((e) => setError(e.message));
  useEffect(() => { load(); }, [status, tab]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(id: string) {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  }

  async function mark(newStatus: "Seen" | "Accepted", ids: string[]) {
    setBusy(true);
    try {
      for (const id of ids) await api(`/api/workbook-changes/${id}`, { method: "PATCH", json: { status: newStatus } });
      load();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Sheet Watch</h1>
          <p className="text-sm text-gray-500">Every change the client makes in the shared workbook — row, column, old → new</p>
        </div>
        <div className="flex gap-2">
          <select className={inputCls + " max-w-40"} value={tab} onChange={(e) => setTab(e.target.value)}>
            <option value="">All tabs</option>
            {tabs.map((t) => <option key={t}>{t}</option>)}
          </select>
          <select className={inputCls + " max-w-32"} value={status} onChange={(e) => setStatus(e.target.value)}>
            {["New", "Seen", "Accepted", "all"].map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      {selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Btn small kind="ghost" disabled={busy} onClick={() => mark("Seen", [...selected])}>Mark Seen</Btn>
          <Btn small disabled={busy} onClick={() => mark("Accepted", [...selected])}>Accept</Btn>
        </div>
      )}
      <DataTable rows={items}
        cardTitle={(r: any) => r.row_key}
        columns={[
          { key: "_sel", label: "", mobile: false, render: (r: any) => r.status !== "Accepted" ? <input type="checkbox" checked={selected.has(r._id)} onChange={() => toggle(r._id)} onClick={(e) => e.stopPropagation()} /> : null },
          { key: "tab", label: "Tab", mobile: false },
          { key: "row_key", label: "Row", render: (r: any) => <span className="text-[13px] font-medium">{r.row_key}</span> },
          { key: "change_type", label: "Type", render: (r: any) => <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TYPE_STYLE[r.change_type] ?? ""}`}>{r.change_type}</span> },
          { key: "column", label: "Column", render: (r: any) => r.column ?? <span className="text-gray-400">whole row</span> },
          {
            key: "change", label: "Old → New", render: (r: any) => (
              <span className="text-xs">
                <span className="rounded bg-red-50 px-1 text-red-700 line-through decoration-red-300">{r.old_value || "∅"}</span>
                {" → "}
                <span className="rounded bg-green-50 px-1 font-semibold text-green-800">{r.new_value || "∅"}</span>
              </span>
            ),
          },
          { key: "detected_at", label: "Detected", render: (r: any) => fmtDate(r.detected_at), mobile: false },
          { key: "status", label: "Status", render: (r: any) => <Chip value={r.status} /> },
          {
            key: "_act", label: "", render: (r: any) => r.status === "New" ? (
              <span className="flex gap-1">
                <Btn small kind="ghost" disabled={busy} onClick={() => mark("Seen", [r._id])}>Seen</Btn>
                <Btn small disabled={busy} onClick={() => mark("Accepted", [r._id])}>Accept</Btn>
              </span>
            ) : r.status === "Seen" ? (
              <Btn small disabled={busy} onClick={() => mark("Accepted", [r._id])}>Accept</Btn>
            ) : null,
          },
        ]} empty="No workbook changes detected — the client's sheet matches the last snapshot." />
    </div>
  );
}
