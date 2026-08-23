"use client";
import { useEffect, useState } from "react";
import { api, fmtDate, fmtDT } from "@/lib/client";
import { usePerms } from "@/components/shell";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, RouteTabs, inputCls } from "@/components/ui";

const ACTIONS = ["No action", "Update target", "Apply value", "Start location", "Put on hold", "Stop location", "Close location"];
// Entity changes (tab mappings on trainers/candidates) are value swaps — the location status
// machinery does not apply to them.
const ENTITY_ACTIONS = ["No action", "Apply value"];

// Who/what a change is about: the centre for the classic mapped sync, the named row for
// tab-mapping changes on trainers/candidates.
const rowLabel = (r: any) =>
  r.entity_type && r.entity_type !== "Location"
    ? `${r.impact_snapshot?.row_label ?? "row"} (${r.entity_type}${r.tab ? ` · ${r.tab}` : ""})`
    : r.location?.name ?? null;

export default function SyncInboxPage() {
  const [items, setItems] = useState<any[]>([]);
  const [status, setStatus] = useState("Open");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<any>(null);
  const [action, setAction] = useState("");
  const [note, setNote] = useState("");
  const [openCounts, setOpenCounts] = useState<{ watch?: number; sync?: number }>({});
  useEffect(() => {
    api("/api/workbook-changes?count=1").then((d) => setOpenCounts((c) => ({ ...c, watch: d.count ?? 0 }))).catch(() => {});
    api("/api/sheet-changes?count=1").then((d) => setOpenCounts((c) => ({ ...c, sync: d.count ?? 0 }))).catch(() => {});
  }, []);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(true);

  const load = () => api(`/api/sheet-changes?status=${status}`).then((d) => { setItems(d.items); setSelected(new Set()); }).catch((e) => setError(e.message)).finally(() => setLoading(false));
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

  // -218 (Umesh, 23/08): "there is still no edit button to ignored status of sync messages… ek baar
  // jo admin ne mark kar diya status, woh baad me chahe toh edit kar sakta hai, with confirmation."
  //
  // `Ignored` was terminal at BOTH layers: the row was not clickable, had no checkbox, and no route
  // brought anything back out of it. A wrong press of "Bulk Ignore (No action)" was permanent.
  //
  // Both controls below are gated on `sheet.approve` / `sheet.sources` — the SAME keys their doors
  // check. Six times in eight releases a control was gated on one thing while its server checked
  // another, and every one of those was a button someone could see and not press.
  const { can, loaded: permsReady } = usePerms();
  const canApprove = !permsReady || can("sheet.approve", "edit");
  const canRunSources = !permsReady || can("sheet.sources", "edit");
  const [busyRow, setBusyRow] = useState<string | null>(null);

  // Why a row is in Ignored decides what re-opening MEANS, so the confirmation says the true thing
  // for that row rather than one generic warning.
  function reopenWarning(r: any): string {
    const who = rowLabel(r) ?? "this record";
    if (r.status === "Ignored" && (r.action_taken === "No action" || !r.action_taken)) {
      return `Re-open this change for ${who}?

Nobody acted on it — it was dismissed. It goes back to the review queue exactly as it arrived.`;
    }
    if (/Revert/i.test(String(r.note ?? ""))) {
      return `Re-open this change for ${who}?

This one was applied and then REVERTED. Re-opening puts it back on the review queue as a change waiting to be applied again.`;
    }
    return `Re-open this change for ${who}?

CAREFUL: this change was already APPLIED${r.actioned_at ? ` on ${fmtDate(r.actioned_at)}` : ""} (${r.action_taken}). The record already carries that value. Re-opening puts it back on the queue, where applying it again would write "${r.new_value ?? ""}" a second time.`;
  }

  async function changeStatus(r: any, next: "Open" | "Ignored") {
    const msg = next === "Open"
      ? reopenWarning(r)
      : `Close this change for ${rowLabel(r) ?? "this record"} as ignored?

It leaves the review queue. You can re-open it later from the Ignored list.`;
    if (!window.confirm(msg)) return;
    const reason = window.prompt("Reason (optional) — it is recorded against the change:", "") ?? "";
    setBusyRow(String(r._id)); setError(""); setInfo("");
    try {
      const res = await api(`/api/sheet-changes/${r._id}/status`, { method: "PATCH", json: { status: next, reason } });
      setInfo(`Moved to ${next}.${res?.cleared_no_action ? " The “No action” mark was cleared, because nobody had acted on it." : ""}`);
      load();
    } catch (e: any) { setError(e.message); }
    finally { setBusyRow(null); }
  }

  // -218: "sync now ki bhi functionality bana ke deni hai — ek button jiski help se Admin usi samay
  // sheet sync kar lega, poora cron ka wait na karke."
  //
  // The door already exists (POST /api/sync-sources/[id]/run) and is already used by the Admin
  // page. It was simply not on THIS screen, which is where the pending changes are read — the same
  // shape as QA-770 and QA-748: the capability lives where the pain is not. No new server route.
  const [syncing, setSyncing] = useState(false);
  async function syncNow() {
    if (syncing) return;
    setSyncing(true); setError(""); setInfo("");
    try {
      const srcs = ((await api("/api/sync-sources")).items ?? []).filter((x: any) => x.active !== false);
      if (!srcs.length) { setInfo("No active sync source is configured."); return; }
      const lines: string[] = [];
      for (const src of srcs) {
        try {
          const r = await api(`/api/sync-sources/${src._id}/run`, { method: "POST" });
          const n = r?.changes ?? r?.created ?? r?.new_changes ?? 0;
          lines.push(`${src.name}: ${n} new change${n === 1 ? "" : "s"}`);
        } catch (e: any) {
          // Named per source, because "sync failed" over four sources tells nobody which one.
          lines.push(`${src.name}: ${e.message}`);
        }
      }
      setInfo(lines.join(" · "));
      load();
    } catch (e: any) { setError(e.message); }
    finally { setSyncing(false); }
  }

  async function apply() {
    try {
      const res = await api(`/api/sheet-changes/${review._id}/apply`, { method: "POST", json: { action, note } });
      setInfo(res.followUps > 0 ? `Applied. ${res.followUps} follow-up actions generated — the change stays open until they are resolved.` : "Applied & acknowledged.");
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
        {/* -218: rendered only for a login whose `sheet.sources` right the RUN door will accept -
            a control that appears and then 403s is the class that has shipped six times. */}
        {canRunSources && (
          <Btn small onClick={syncNow} disabled={syncing}>{syncing ? "Syncing…" : "⟳ Sync now"}</Btn>
        )}
        <select className={inputCls + " max-w-36"} value={status} onChange={(e) => setStatus(e.target.value)}>
          {["Open", "Actioned", "Ignored", "all"].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      {/* 2026-08-14 (Umesh): one nav entry "Sheet Sync" — this page is its second tab. */}
      {/* -111: the sidebar badge sums BOTH inboxes; here each tab carries its own open count so a
          stale pile in one can never hide behind the total again (38 = 1 + 37, measured 18/08). */}
      <RouteTabs active="/sync" tabs={[
        { href: "/sheet-watch", label: "Sheet Watch (cell changes)", count: openCounts.watch },
        { href: "/sync", label: "Sync Inbox (apply suggestions)", count: openCounts.sync },
      ]} />
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      {info && <div className="rounded-lg border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-700">{info} <button className="ml-2 font-bold" onClick={() => setInfo("")}>×</button></div>}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          {/* -218: this door has always needed `sheet.approve`; the button never asked. Same key,
              same answer, so nobody presses it into a 403. */}
          {canApprove
            ? <Btn small kind="ghost" onClick={bulkIgnore}>Bulk Ignore (No action)</Btn>
            : <span className="text-xs text-gray-600">Closing these needs the sheet-approval right.</span>}
        </div>
      )}
      {/* -218: every row opens now. It used to be `r.status === "Open" && ...`, so an Ignored change
          could not even be READ - which is half of why the state felt like a trap. The drawer's
          action controls still key off Open; this only lets a person look. */}
      <DataTable rows={items} loading={loading} onRowClick={(r: any) => setReview(r)}
        cardTitle={(r: any) => rowLabel(r) ?? "Unmatched row"}
        columns={[
          { key: "_sel", label: "", mobile: false, render: (r: any) => r.status === "Open" ? <input type="checkbox" checked={selected.has(r._id)} onChange={() => toggle(r._id)} onClick={(e) => e.stopPropagation()} /> : null },
          { key: "location", label: "About", render: (r: any) => rowLabel(r) ?? <span className="text-amber-600">Unmatched</span> },
          { key: "field_name", label: "Field" },
          { key: "change", label: "Old → New", minWidth: 280, filterText: (r: any) => `${r.old_value ?? ""} ${r.new_value ?? ""}`, render: (r: any) => <span className="text-xs">{r.old_value || "∅"} → <b>{r.new_value}</b></span> },
          { key: "detected_at", label: "Detected", render: (r: any) => fmtDT(r.detected_at) },
          {
            key: "status", label: "Status",
            render: (r: any) => (
              <span className="flex flex-wrap items-center gap-1">
                <Chip value={r.status} />
                {r.pending_followups > 0 && <span className="text-xs text-amber-600">{r.pending_followups} follow-ups</span>}
                {/* -218 (Umesh): the status is editable AFTER the fact, with confirmation. Before
                    this, `Ignored` was terminal at both layers - the row would not open, had no
                    checkbox, and no route brought anything back - so a wrong Bulk Ignore was
                    permanent. Shown only to a login the door will accept. */}
                {canApprove && r.status !== "Open" && (
                  <button className="text-[11px] font-medium text-blue-700 hover:underline disabled:text-gray-400"
                    disabled={busyRow === String(r._id)}
                    title="Put this change back on the review queue"
                    onClick={(e) => { e.stopPropagation(); changeStatus(r, "Open"); }}>
                    {busyRow === String(r._id) ? "…" : "Re-open"}
                  </button>
                )}
                {canApprove && r.status === "Open" && (
                  <button className="text-[11px] font-medium text-gray-600 hover:underline disabled:text-gray-400"
                    disabled={busyRow === String(r._id)}
                    title="Close this change without acting on it"
                    onClick={(e) => { e.stopPropagation(); changeStatus(r, "Ignored"); }}>
                    {busyRow === String(r._id) ? "…" : "Ignore"}
                  </button>
                )}
              </span>
            ),
          },
          { key: "action_taken", label: "Action", render: (r: any) => r.action_taken ?? "—", mobile: false },
          {
            // 2026-08-13 (Umesh): rollback. Only an applied target update is a plain value swap;
            // status actions carry follow-ups and are undone on the location screen with a reason.
            key: "_revert", label: "", mobile: false, render: (r: any) =>
              r.status === "Actioned" && ["Update target", "Apply value"].includes(r.action_taken) ? (
                <button className="text-[11px] font-medium text-red-600 hover:underline"
                  title={`Put ${r.field_name} back to "${r.old_value || "unset"}"`}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (!window.confirm(`Revert ${rowLabel(r) ?? "this record"}'s ${r.field_name} back to "${r.old_value || "unset"}"?`)) return;
                    try { await api(`/api/sheet-changes/${r._id}/revert`, { method: "POST", json: {} }); load(); }
                    catch (err: any) { setError(err.message); }
                  }}>↩ Revert</button>
              ) : null,
          },
        ]} empty="Inbox zero — no changes to review." />

      <Drawer error={error} open={!!review} onClose={() => setReview(null)} title="Review change" wide>
        {review && (
          <div className="space-y-4">
            <div className="rounded-lg bg-gray-50 p-4 text-sm">
              <div className="font-medium">{rowLabel(review) ?? "Unmatched location"}</div>
              <div className="mt-1">Field <b>{review.field_name}</b>: <span className="text-gray-500">{review.old_value || "∅"}</span> → <b>{review.new_value}</b></div>
              <div className="mt-1 text-xs text-gray-400">Detected {fmtDT(review.detected_at)}</div>
            </div>
            {review.impact_snapshot && review.impact_snapshot.active_batches !== undefined && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm">
                <div className="mb-1 font-medium text-amber-800">Impact at detection time</div>
                <ul className="grid grid-cols-2 gap-1 text-amber-900">
                  <li>Active batches: <b>{review.impact_snapshot.active_batches}</b></li>
                  <li>Assigned trainers: <b>{review.impact_snapshot.assigned_trainers}</b></li>
                  <li>Open trainer requests: <b>{review.impact_snapshot.open_trainer_requests}</b></li>
                  <li>Active candidates: <b>{review.impact_snapshot.active_candidates}</b></li>
                </ul>
              </div>
            )}
            {/* -218: this drawer now opens for a settled row too, so a person can READ one - which
                is half of why Ignored felt like a trap. But the APPLY controls belong to an Open
                change only, and the door refuses anything else. Rendering them here for a settled
                row would be a fresh instance of the class that has shipped six times this week:
                a control offered to someone the server will refuse. So they are not rendered, and
                the reason is on screen instead of the row silently doing nothing. */}
            {review.status !== "Open" ? (
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm text-gray-700">
                This change is <b>{review.status}</b>{review.action_taken ? <> — recorded as <b>{review.action_taken}</b></> : null}
                {review.actioned_at ? <> on {fmtDate(review.actioned_at)}</> : null}. It is not on the review queue, so there is nothing to apply here.
                {canApprove && <> Use <b>Re-open</b> on its row to put it back.</>}
              </div>
            ) : (<>
            <Field label="Action" required>
              <select className={inputCls} value={action} onChange={(e) => setAction(e.target.value)}>
                <option value="">Select…</option>
                {(review.entity_type && review.entity_type !== "Location" ? ENTITY_ACTIONS : ACTIONS).map((a) => <option key={a}>{a}</option>)}
              </select>
            </Field>
            <Field label={["Put on hold", "Stop location", "Close location"].includes(action) ? "Reason (required)" : "Note"}>
              <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            {["Stop location", "Close location"].includes(action) && (
              <p className="text-xs text-amber-700">This will generate follow-up actions (stop batches, release trainers, cancel requests, return candidates). Nothing is cascaded silently — each follow-up needs an owner to resolve it.</p>
            )}
            {/* the apply door itself needs sheet.approve; the button obeys the same key */}
            {canApprove && <Btn onClick={apply} disabled={!action}>Apply & Acknowledge</Btn>}
            {!canApprove && <p className="text-xs text-gray-600">You can read this change. Acting on it needs the sheet-approval right.</p>}
            </>)}
          </div>
        )}
      </Drawer>
    </div>
  );
}
