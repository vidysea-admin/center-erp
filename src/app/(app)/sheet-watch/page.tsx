"use client";
// Sheet Watch (2026-08-11 meeting): the client edits their workbook in place and tells
// nobody. Every cell change the poller detects lands here — old → new, highlighted, with
// row and column named — for the team to mark Seen/Accepted. Advisory only: nothing here
// writes to ERP records.
import { useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, inputCls } from "@/components/ui";
import { SheetSources } from "@/components/sheet-sources";

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
  const [showSources, setShowSources] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

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

  // 2026-08-11 (CEO): a new sheet row never auto-enters the DB — a human opens it here,
  // edits the prefilled values, and only then the Location is created.
  const [createDrawer, setCreateDrawer] = useState<any>(null); // { change, suggested, cells, existing }
  const [locForm, setLocForm] = useState<any>({});

  async function openCreate(change: any) {
    try {
      const d = await api(`/api/workbook-changes/${change._id}/create-location`);
      setLocForm(d.suggested ?? {});
      setCreateDrawer({ change, ...d });
    } catch (e: any) { setError(e.message); }
  }

  async function createLocation() {
    setBusy(true);
    try {
      await api(`/api/workbook-changes/${createDrawer.change._id}/create-location`, { method: "POST", json: locForm });
      setCreateDrawer(null); setLocForm({}); load();
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
          <Btn small kind="ghost" onClick={() => setShowSources((s) => !s)}>{showSources ? "Hide sheets" : "Manage sheets"}</Btn>
          <Btn small kind="ghost" onClick={() => setShowHistory((s) => !s)}>{showHistory ? "Hide history" : "Version history"}</Btn>
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
      {/* 2026-08-12: any sheet can be added here — the feature is no longer one hard-coded URL. */}
      {showSources && <SheetSources onChanged={load} />}
      {showHistory && <VersionHistory setError={setError} />}
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
            key: "_act", label: "", render: (r: any) => (
              <span className="flex gap-1">
                {r.change_type === "Added" && r.status !== "Accepted" && (
                  <Btn small kind="ghost" disabled={busy} onClick={() => openCreate(r)}>Create location…</Btn>
                )}
                {r.status === "New" && <Btn small kind="ghost" disabled={busy} onClick={() => mark("Seen", [r._id])}>Seen</Btn>}
                {r.status !== "Accepted" && <Btn small disabled={busy} onClick={() => mark("Accepted", [r._id])}>Accept</Btn>}
              </span>
            ),
          },
        ]} empty="No workbook changes detected — the client's sheet matches the last snapshot." />

      <Drawer open={!!createDrawer} onClose={() => setCreateDrawer(null)} title="Validate & add location">
        {createDrawer && (
          <div className="space-y-3">
            <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
              Sheet row: <b>{createDrawer.change.row_key}</b> — review the values, edit anything that is wrong, then add. Nothing enters the system without this step.
            </div>
            {createDrawer.existing && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                ⚠ A location like this may already exist: <b>{createDrawer.existing.name}</b> ({createDrawer.existing.code}). Check before creating a duplicate.
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Name" required><input className={inputCls} value={locForm.name ?? ""} onChange={(e) => setLocForm({ ...locForm, name: e.target.value })} /></Field>
              <Field label="Code" required><input className={inputCls} value={locForm.code ?? ""} onChange={(e) => setLocForm({ ...locForm, code: e.target.value })} /></Field>
              <Field label="City / District"><input className={inputCls} value={locForm.city ?? ""} onChange={(e) => setLocForm({ ...locForm, city: e.target.value })} /></Field>
              <Field label="State"><input className={inputCls} value={locForm.state ?? ""} onChange={(e) => setLocForm({ ...locForm, state: e.target.value })} /></Field>
              <Field label="SPOC name"><input className={inputCls} value={locForm.spoc_name ?? ""} onChange={(e) => setLocForm({ ...locForm, spoc_name: e.target.value })} /></Field>
              <Field label="SPOC phone"><input className={inputCls} value={locForm.spoc_phone ?? ""} onChange={(e) => setLocForm({ ...locForm, spoc_phone: e.target.value })} /></Field>
              <Field label="External ID (TC ID)"><input className={inputCls} value={locForm.external_id ?? ""} onChange={(e) => setLocForm({ ...locForm, external_id: e.target.value })} /></Field>
              <Field label="Approval status">
                <select className={inputCls} value={locForm.approval_status ?? "Pending"} onChange={(e) => setLocForm({ ...locForm, approval_status: e.target.value })}>
                  <option>Pending</option><option>Approved</option>
                </select>
              </Field>
            </div>
            <Btn onClick={createLocation} disabled={busy || !locForm.name || !locForm.code}>Validate & add location</Btn>
          </div>
        )}
      </Drawer>
    </div>
  );
}


// 2026-08-13 (Umesh): "Excel ki version history jaisa — before kya tha, after kya tha, rollback
// kar paayein." Every content change stores a full snapshot of the tab; this browses them,
// diffs any two versions with the same engine the watcher uses, and downloads any version as
// CSV — the practical rollback, since the client's own file is not ours to write.
function VersionHistory({ setError }: any) {
  const [sources, setSources] = useState<any[]>([]);
  const [src, setSrc] = useState("");
  const [histTabs, setHistTabs] = useState<any[]>([]);
  const [histTab, setHistTab] = useState("");
  const [versions, setVersions] = useState<any[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [diff, setDiff] = useState<any>(null);

  useEffect(() => { api("/api/sync-sources?limit=1000").then((d) => setSources((d.items ?? []).filter((s: any) => s.mode === "watch"))).catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    setHistTab(""); setVersions([]); setDiff(null);
    if (src) api(`/api/sync-sources/${src}/snapshots`).then((d) => setHistTabs(d.tabs ?? [])).catch((e) => setError(e.message));
    else setHistTabs([]);
  }, [src]);
  useEffect(() => {
    setDiff(null); setFrom(""); setTo("");
    if (src && histTab) api(`/api/sync-sources/${src}/snapshots?tab=${encodeURIComponent(histTab)}`).then((d) => setVersions(d.items ?? [])).catch((e) => setError(e.message));
    else setVersions([]);
  }, [histTab]);

  async function runDiff() {
    try { setDiff(await api(`/api/sync-sources/${src}/snapshots?tab=${encodeURIComponent(histTab)}&from=${from}&to=${to}`)); }
    catch (e: any) { setError(e.message); }
  }
  const when = (d: string) => new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Version history</span>
        <select className={inputCls + " max-w-64"} value={src} onChange={(e) => setSrc(e.target.value)}>
          <option value="">Pick a sheet…</option>
          {sources.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
        </select>
        <select className={inputCls + " max-w-56"} value={histTab} onChange={(e) => setHistTab(e.target.value)} disabled={!src}>
          <option value="">Pick a tab…</option>
          {histTabs.map((t) => <option key={t.tab} value={t.tab}>{t.tab} ({t.versions} version{t.versions === 1 ? "" : "s"})</option>)}
        </select>
      </div>
      {versions.length > 0 && (
        <div className="space-y-3">
          <ul className="divide-y divide-gray-100 text-sm">
            {versions.map((v, i) => (
              <li key={v._id} className="flex items-center justify-between gap-2 py-1.5">
                <span>
                  <b>{i === 0 ? "Current" : `Version −${i}`}</b>
                  <span className="text-gray-500"> · {when(v.taken_at)} · {v.rows} rows · {v.columns} columns</span>
                </span>
                <a className="text-xs font-medium text-blue-700 hover:underline"
                  href={`/erp/api/sync-sources/${src}/snapshots?snap=${v._id}&format=csv`}>Download CSV</a>
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-gray-500">Compare</span>
            <select className={inputCls + " max-w-48"} value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">older version…</option>
              {versions.map((v, i) => <option key={v._id} value={v._id}>{i === 0 ? "Current" : `Version −${i}`} ({when(v.taken_at)})</option>)}
            </select>
            <span className="text-gray-500">→</span>
            <select className={inputCls + " max-w-48"} value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">newer version…</option>
              {versions.map((v, i) => <option key={v._id} value={v._id}>{i === 0 ? "Current" : `Version −${i}`} ({when(v.taken_at)})</option>)}
            </select>
            <Btn small disabled={!from || !to || from === to} onClick={runDiff}>Show changes</Btn>
          </div>
          {diff && (
            <div className="rounded-lg bg-gray-50 p-3 text-sm">
              <div className="mb-2 text-xs text-gray-500">{when(diff.from.taken_at)} → {when(diff.to.taken_at)} · {diff.changes.length} change{diff.changes.length === 1 ? "" : "s"}</div>
              {diff.changes.length === 0 ? <div className="text-gray-400">These two versions are identical.</div> : (
                <ul className="max-h-72 space-y-1 overflow-y-auto">
                  {diff.changes.map((c: any, i: number) => (
                    <li key={i} className="text-xs">
                      <Chip value={c.change_type} /> <b>{c.row_key}</b>{c.column ? <> · {c.column}</> : null}:{" "}
                      <span className="rounded bg-red-50 px-1 text-red-700 line-through decoration-red-300">{c.old_value || "∅"}</span>
                      {" → "}
                      <span className="rounded bg-green-50 px-1 font-semibold text-green-800">{c.new_value || "∅"}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
