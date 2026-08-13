"use client";
import { useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, inputCls } from "@/components/ui";

const ACTIONS = ["No action", "Update target", "Start location", "Put on hold", "Stop location", "Close location"];

export default function SyncInboxPage() {
  const [items, setItems] = useState<any[]>([]);
  const [status, setStatus] = useState("Open");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<any>(null);
  const [action, setAction] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const load = () => api(`/api/sheet-changes?status=${status}`).then((d) => { setItems(d.items); setSelected(new Set()); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [status]);

  function toggle(id: string) {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  }

  async function bulkIgnore() {
    try { await api("/api/sheet-changes/bulk-ignore", { method: "POST", json: { ids: [...selected] } }); load(); }
    catch (e: any) { setError(e.message); }
  }

  async function apply() {
    try {
      const res = await api(`/api/sheet-changes/${review._id}/apply`, { method: "POST", json: { action, note } });
      setInfo(res.followUps > 0 ? `Applied. ${res.followUps} follow-up actions generated — change stays open until they are resolved (Rule 7).` : "Applied & acknowledged.");
      setReview(null); setAction(""); setNote(""); load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Sync Inbox</h1>
          <p className="text-sm text-gray-500">External sheet changes — review, act, acknowledge</p>
        </div>
        <select className={inputCls + " max-w-36"} value={status} onChange={(e) => setStatus(e.target.value)}>
          {["Open", "Actioned", "Ignored", "all"].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      {info && <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-700">{info} <button className="ml-2 font-bold" onClick={() => setInfo("")}>×</button></div>}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Btn small kind="ghost" onClick={bulkIgnore}>Bulk Ignore (No action)</Btn>
        </div>
      )}
      <DataTable rows={items} onRowClick={(r: any) => r.status === "Open" && setReview(r)}
        cardTitle={(r: any) => r.location?.name ?? "Unmatched row"}
        columns={[
          { key: "_sel", label: "", mobile: false, render: (r: any) => r.status === "Open" ? <input type="checkbox" checked={selected.has(r._id)} onChange={() => toggle(r._id)} onClick={(e) => e.stopPropagation()} /> : null },
          { key: "location", label: "Location", render: (r: any) => r.location?.name ?? <span className="text-amber-600">Unmatched</span> },
          { key: "field_name", label: "Field" },
          { key: "change", label: "Old → New", render: (r: any) => <span className="text-xs">{r.old_value || "∅"} → <b>{r.new_value}</b></span> },
          { key: "detected_at", label: "Detected", render: (r: any) => fmtDate(r.detected_at) },
          { key: "status", label: "Status", render: (r: any) => <span className="flex items-center gap-1"><Chip value={r.status} />{r.pending_followups > 0 && <span className="text-xs text-amber-600">{r.pending_followups} follow-ups</span>}</span> },
          { key: "action_taken", label: "Action", render: (r: any) => r.action_taken ?? "—", mobile: false },
          {
            // 2026-08-13 (Umesh): rollback. Only an applied target update is a plain value swap;
            // status actions carry follow-ups and are undone on the location screen with a reason.
            key: "_revert", label: "", mobile: false, render: (r: any) =>
              r.status === "Actioned" && r.action_taken === "Update target" ? (
                <button className="text-[11px] font-medium text-red-600 hover:underline"
                  title={`Put the target back to "${r.old_value || "unset"}"`}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!window.confirm(`Revert ${r.location?.name ?? "this centre"}'s target back to "${r.old_value || "unset"}"?`)) return;
                    try { await api(`/api/sheet-changes/${r._id}/revert`, { method: "POST", json: {} }); load(); }
                    catch (err: any) { setError(err.message); }
                  }}>↩ Revert</button>
              ) : null,
          },
        ]} empty="Inbox zero — no changes to review." />

      <Drawer open={!!review} onClose={() => setReview(null)} title="Review change" wide>
        {review && (
          <div className="space-y-4">
            <div className="rounded-lg bg-gray-50 p-4 text-sm">
              <div className="font-medium">{review.location?.name ?? "Unmatched location"}</div>
              <div className="mt-1">Field <b>{review.field_name}</b>: <span className="text-gray-500">{review.old_value || "∅"}</span> → <b>{review.new_value}</b></div>
              <div className="mt-1 text-xs text-gray-400">Detected {new Date(review.detected_at).toLocaleString("en-IN")}</div>
            </div>
            {review.impact_snapshot && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
                <div className="mb-1 font-medium text-amber-800">Impact at detection time (Rule 3)</div>
                <ul className="grid grid-cols-2 gap-1 text-amber-900">
                  <li>Active batches: <b>{review.impact_snapshot.active_batches}</b></li>
                  <li>Assigned trainers: <b>{review.impact_snapshot.assigned_trainers}</b></li>
                  <li>Open trainer requests: <b>{review.impact_snapshot.open_trainer_requests}</b></li>
                  <li>Active candidates: <b>{review.impact_snapshot.active_candidates}</b></li>
                </ul>
              </div>
            )}
            <Field label="Action" required>
              <select className={inputCls} value={action} onChange={(e) => setAction(e.target.value)}>
                <option value="">Select…</option>
                {ACTIONS.map((a) => <option key={a}>{a}</option>)}
              </select>
            </Field>
            <Field label={["Put on hold", "Stop location", "Close location"].includes(action) ? "Reason (required)" : "Note"}>
              <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            {["Stop location", "Close location"].includes(action) && (
              <p className="text-xs text-amber-700">This will generate follow-up actions (stop batches, release trainers, cancel requests, return candidates). Nothing is cascaded silently — each follow-up needs an owner to resolve it (Rule 8).</p>
            )}
            <Btn onClick={apply} disabled={!action}>Apply & Acknowledge</Btn>
          </div>
        )}
      </Drawer>
    </div>
  );
}
