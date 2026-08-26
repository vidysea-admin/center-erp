"use client";
import { useEffect, useState } from "react";
import { api, fmtDate, fmtDT } from "@/lib/client";
import { usePerms } from "@/components/shell";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, RouteTabs, inputCls } from "@/components/ui";

// QA-946 (Umesh, 24/08, screenshot of this screen): the action list is NOT written here any more.
// It used to be two hardcoded arrays — seven actions for every Location row, two for entity rows —
// and the apply door accepts at most ONE of the top two on any given row, because `Update target`
// needs a "<field>:<CODE>" row and `Apply value` needs a bare one, and those are exact complements.
// So one of the first two options was always a guaranteed 400, the screen never said which, and a
// reviewer's only way to learn a row's kind was to pick wrong and read the refusal. He picked
// `Update target` on a `tc_password` row and got "Not a target-row change."
//
// GET /api/sheet-changes now ships one verdict per action, decided by `classifyChange` in
// lib/sync.ts — the SAME predicate the apply door refuses through. A client component cannot
// import it (lib/sync.ts pulls mongoose), so it travels in the payload, the way trainers'
// `allowed_next` already does. Nothing about which action fits which row is decided in this file.
type ActionVerdict = { action: string; ok: boolean; recommended?: boolean; requires_note?: boolean; raises_followups?: boolean; why: string };
const verdicts = (r: any): ActionVerdict[] => (Array.isArray(r?.actions) ? r.actions : []);
const verdictOf = (r: any, action: string): ActionVerdict | undefined => verdicts(r).find((v) => v.action === action);

// A cleared cell arrives as an empty new_value and reads as nothing at all — "Approved →" and then
// silence — while `Apply value` writes that blank into the record (QA-668). Same `∅` the Old column
// and the row list already use, plus the word for what applying it does.
const shownValue = (v: any) => (String(v ?? "").trim() === "" ? "∅ — clears this field" : String(v));

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
  // QA-1026 (S1): a revealed credential, per row, for this page view only. Never persisted, never
  // put in a URL, and gone on reload — a reveal is an act, not a setting (same rule as
  // locations/page.tsx's revealedPw). Read this in preference to r.old_value/r.new_value wherever
  // a masked secret field is rendered.
  const [revealedVal, setRevealedVal] = useState<Record<string, { old_value: string; new_value: string }>>({});
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
  // QA-805 (-219, checker on qa-218): this used to decide the warning by running /Revert/i over
  // `note` — and `note` carries FREE TEXT a person typed. An applied row noted "do NOT revert this"
  // was told it had been reverted, which deleted the one warning that mattered: that re-opening it
  // puts an already-written value in line to be written again. A safety sentence chosen by grepping
  // somebody's sentence is not a safety sentence. It reads FACTS now — `reverted_at` and
  // `action_taken` — and the ordering is deliberate: reverted is checked first, because a reverted
  // row also carries a real `action_taken`.
  // QA-821 (-221, checker on qa-220): QA-812's "disclosed limit" was not a hypothetical hand-typed
  // edge case — it is a BOX ON THIS SCREEN. `changeStatus` below prompts "Reason (optional)", the
  // status route appends that reason verbatim into `note`, and -220's fallback then grepped `note`
  // for `Reverted to "`. So any reviewer who typed that phrase into the Reason box made the row
  // claim, permanently, that it had been reverted and that "the record does NOT carry the value" —
  // QA-805 reincarnated through the same door, two clicks away. The grep got tighter; the trust in
  // free text did not. It is GONE. This reads structural fields only.
  //
  // `reverted_at` is written only by reverts since -219, and there is no backfill (a production
  // write, and Umesh's call). So its absence means "not reverted" ONLY for rows settled after that
  // release. For older rows it means "never recorded" — and guessing in either direction is exactly
  // what QA-812 punished, so those rows get an honest third message instead of a confident wrong one.
  const REVERT_FACT_SINCE = Date.parse("2026-08-25T00:00:00Z");
  function revertRecorded(r: any): boolean {
    const t = Date.parse(String(r.actioned_at ?? ""));
    return Number.isFinite(t) && t >= REVERT_FACT_SINCE;
  }

  function reopenWarning(r: any): string {
    const who = rowLabel(r) ?? "this record";
    if (r.reverted_at) {
      return `Re-open this change for ${who}?

This one was applied and then REVERTED on ${fmtDate(r.reverted_at)}. The record does NOT carry the value now. Re-opening puts it back on the review queue as a change waiting to be applied again.`;
    }
    if (!r.action_taken || r.action_taken === "No action") {
      return `Re-open this change for ${who}?

Nobody acted on it — it was dismissed. It goes back to the review queue exactly as it arrived.`;
    }
    if (!revertRecorded(r)) {
      return `Re-open this change for ${who}?

CAREFUL: this change was APPLIED${r.actioned_at ? ` on ${fmtDate(r.actioned_at)}` : ""} (${r.action_taken}). Whether it was reverted afterwards was NOT recorded for changes settled before 25 Aug 2026 — check the record itself before you apply it again. Re-opening puts it back on the queue, where applying it would write “${r.new_value ?? ""}”.`;
    }
    return `Re-open this change for ${who}?

CAREFUL: this change was already APPLIED${r.actioned_at ? ` on ${fmtDate(r.actioned_at)}` : ""} (${r.action_taken}). The record already carries that value. Re-opening puts it back on the queue, where applying it again would write “${r.new_value ?? ""}” a second time.`;
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
      let failedAny = false;   // QA-804: a run that failed must not land in the green banner
      for (const src of srcs) {
        try {
          const r = await api(`/api/sync-sources/${src._id}/run`, { method: "POST" });
          // QA-804 (-219, checker on qa-218): a FAILED run comes back INSIDE a 200 —
          // `{created: 0, status: "Failed", error: "HTTP 400"}` — so reading only the count printed
          // a dead source as "0 new changes" in the GREEN banner. The Admin screen has read
          // `status` and `error` since it was written (admin/page.tsx:591-593); I had the working
          // pattern one file away and used my own.
          // QA-811 (-220, checker on qa-219): -219 compared `status !== "Success"` and NOTHING in
          // this codebase ever returns "Success" - the word existed in exactly one place, that
          // comparison. So every healthy source was reported as a FAILURE, in red, with its count
          // thrown away. Fixing QA-804's false green, I shipped a universal false red.
          //
          // The real vocabulary, from lib/sync.ts and lib/workbook.ts, written down so nobody
          // invents one again: "OK" - "Partial" - "Failed".
          const n = r?.tabs !== undefined ? (r?.changes ?? 0) : (r?.created ?? 0);
          const unit = r?.tabs !== undefined ? `cell change${n === 1 ? "" : "s"} across ${r.tabs} tab${r.tabs === 1 ? "" : "s"}` : `new change${n === 1 ? "" : "s"}`;
          if (r?.status === "Failed") {
            failedAny = true;
            lines.push(`${src.name}: failed${r.error ? ` - ${r.error}` : ""}`);
          } else if (r?.status === "Partial") {
            // partial is neither success nor silence: it moved something AND hit something.
            failedAny = true;
            lines.push(`${src.name}: ${n} ${unit}, but the run was incomplete${r.error ? ` - ${r.error}` : ""}`);
          } else {
            lines.push(`${src.name}: ${n} ${unit}`);
          }
        } catch (e: any) {
          // Named per source, because "sync failed" over four sources tells nobody which one.
          failedAny = true;
          lines.push(`${src.name}: ${e.message}`);
        }
      }
      // QA-804: green says "this worked". Anything that did not goes to the error banner.
      if (failedAny) setError(lines.join(" · ")); else setInfo(lines.join(" · "));
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
          // QA-987 (checker on qa-234 cycle 1): cycle 1 fixed the DRAWER and left this cell alone,
          // so the list still printed "Ramesh Kumar →" and stopped. QA-668's own `actual` names the
          // LIST first — it is the surface a reviewer scans before opening anything — so half the
          // issue was closed while the half it was reported on stayed broken. Same helper, both
          // places, which is the only way they cannot drift apart again.
          {
            key: "change", label: "Old → New", minWidth: 280, filterText: (r: any) => `${r.old_value ?? ""} ${r.new_value ?? ""}`,
            // QA-1026 (S1): the list ships this row already masked (`••••••`) for a secret field —
            // this render only decides whether a reveal control is worth showing, never whether the
            // value itself is safe to print, which is the server's decision (lib/sync.ts).
            render: (r: any) => {
              const id = String(r._id);
              const shown = revealedVal[id];
              const old_value = shown ? shown.old_value : r.old_value;
              const new_value = shown ? shown.new_value : r.new_value;
              if (!r.secret_revealable || shown) return <span className="text-xs">{old_value || "∅"} → <b>{shownValue(new_value)}</b></span>;
              return (
                <span className="text-xs">
                  {old_value || "∅"} →{" "}
                  <button type="button" className="font-mono text-xs text-blue-700 underline underline-offset-2"
                    onClick={async (e) => {
                      // Same reason as locations/page.tsx's identical guard (QA-1365): without this
                      // the click bubbles to the table's onRowClick and opens the review drawer
                      // instead of revealing.
                      e.stopPropagation();
                      setRevealedVal((m) => ({ ...m, [id]: { old_value: "…", new_value: "…" } }));
                      try {
                        const d: any = await api(`/api/sheet-changes/${id}`);
                        setRevealedVal((m) => ({ ...m, [id]: { old_value: d?.item?.old_value ?? "", new_value: d?.item?.new_value ?? "" } }));
                      } catch {
                        setRevealedVal((m) => ({ ...m, [id]: { old_value: "(refused)", new_value: "(refused)" } }));
                      }
                    }}>{shownValue(new_value)} Show</button>
                </span>
              );
            },
          },
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
                {/* QA-810 (-220, checker on qa-218): this rendered ENABLED next to the screen's own
                    "3 follow-ups", and the door refuses exactly that row (Rule 7). Seventh outing of
                    the dead-control class, and mine, in the release whose subject was that class. */}
                {canApprove && r.status === "Open" && (
                  <button className="text-[11px] font-medium text-gray-600 hover:underline disabled:text-gray-400"
                    title={r.pending_followups > 0 ? `${r.pending_followups} follow-up(s) still outstanding - finish or cancel them first` : "Close this change without acting on it"}
                    disabled={busyRow === String(r._id) || r.pending_followups > 0}
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
            //
            // QA-989 (checker on qa-234 cycle 1): this used to test `action_taken` here, with its
            // own looser copy of the rule — the revert door ALSO requires `approved_target:` for
            // the target case. So every applied `tc_status:<CODE>` / `tc_id:<CODE>` row rendered
            // this button, asked the user to confirm, and then answered 400 "Not a target change."
            // — the literal sibling of the sentence this whole unit exists to have replaced, on
            // this very screen. It reads the server's `revert` verdict now (lib/sync.ts canRevert,
            // the same function the door refuses through), so the button exists exactly when the
            // press will work.
            key: "_revert", label: "", mobile: false, render: (r: any) =>
              r.revert?.ok ? (
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
              <div className="mt-1">
                Field <b>{review.field_name}</b>:{" "}
                {(() => {
                  // QA-1026 (S1): same reveal state as the column — a row already revealed there
                  // stays revealed here, and an unrevealed secret row shows the SAME mask + button
                  // rather than a second, independent leak surface.
                  const id = String(review._id);
                  const shown = revealedVal[id];
                  const old_value = shown ? shown.old_value : review.old_value;
                  const new_value = shown ? shown.new_value : review.new_value;
                  if (!review.secret_revealable || shown) {
                    return <><span className="text-gray-500">{old_value || "∅"}</span> → <b>{shownValue(new_value)}</b></>;
                  }
                  return (
                    <>
                      <span className="text-gray-500">{old_value || "∅"}</span> →{" "}
                      <button type="button" className="font-mono text-xs text-blue-700 underline underline-offset-2"
                        onClick={async () => {
                          setRevealedVal((m) => ({ ...m, [id]: { old_value: "…", new_value: "…" } }));
                          try {
                            const d: any = await api(`/api/sheet-changes/${id}`);
                            setRevealedVal((m) => ({ ...m, [id]: { old_value: d?.item?.old_value ?? "", new_value: d?.item?.new_value ?? "" } }));
                          } catch {
                            setRevealedVal((m) => ({ ...m, [id]: { old_value: "(refused)", new_value: "(refused)" } }));
                          }
                        }}>{shownValue(new_value)} Show</button>
                    </>
                  );
                })()}
              </div>
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
            {(() => {
              const vs = verdicts(review);
              const rec = vs.find((v) => v.recommended);
              const chosen = verdictOf(review, action);
              // The door refuses Put on hold / Stop / Close without a reason (Rule 5, lib/sync.ts).
              // The button used to test `!action` only, so the way to discover that rule was to
              // press Apply and read a 400. `requires_note` comes from the same verdict the door
              // reads, so this can never be the stale half of the pair.
              const noteMissing = !!chosen?.requires_note && !note.trim();
              const snap = review.impact_snapshot;
              const groups: [string, ActionVerdict[]][] = [
                ["Recommended for this row", vs.filter((v) => v.recommended)],
                ["Also possible", vs.filter((v) => v.ok && !v.recommended)],
                ["Doesn't apply to this row", vs.filter((v) => !v.ok)],
              ];
              return (<>
              <Field label="Action" required>
                <select className={inputCls} value={action} onChange={(e) => setAction(e.target.value)}>
                  {/* Deliberately NOT pre-selected to the recommendation (Umesh's call, 24/08):
                      Apply writes to production data, so the recommended step is marked and
                      explained, and the press stays a decision somebody made on purpose. */}
                  <option value="">Select…</option>
                  {groups.map(([label, group]) => group.length === 0 ? null : (
                    <optgroup key={label} label={`── ${label} ──`}>
                      {group.map((v) => (
                        // Disabled, not hidden: an option a reviewer never sees is one they never
                        // learn the shape of. The reason rides in the label because a native
                        // select has no tooltip on touch, and in `title` for when it truncates.
                        <option key={v.action} value={v.action} disabled={!v.ok} title={v.why}>
                          {v.ok ? (v.recommended ? "★ " : "") : "✗ "}{v.action} — {v.why}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </Field>
              {vs.length === 0 && (
                <p className="text-xs text-amber-700">This change did not arrive with its list of applicable actions — reload the page. Applying is blocked rather than guessed at.</p>
              )}
              {!action && rec && (
                <p className="text-xs text-gray-600"><b className="text-gray-800">★ Recommended: {rec.action}</b> — {rec.why}</p>
              )}
              {chosen && (
                <p className={`text-xs ${chosen.ok ? "text-gray-600" : "text-red-700"}`}><b className="text-gray-800">{chosen.action}</b> — {chosen.why}</p>
              )}
              <Field label={chosen?.requires_note ? "Reason (required)" : "Note"}>
                <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              {chosen?.raises_followups && (
                <p className="text-xs text-amber-700">
                  This will generate follow-up actions (stop batches, release trainers, cancel requests, return candidates). Nothing is cascaded silently — each follow-up needs an owner to resolve it, and this change stays Open until they are.
                  {snap && snap.active_batches !== undefined && <> At detection this centre had <b>{snap.active_batches}</b> active batch(es), <b>{snap.assigned_trainers}</b> assigned trainer(s) and <b>{snap.open_trainer_requests}</b> open trainer request(s).</>}
                </p>
              )}
              {/* the apply door itself needs sheet.approve; the button obeys the same key */}
              {canApprove && <Btn onClick={apply} disabled={!action || noteMissing || chosen?.ok === false}>Apply & Acknowledge</Btn>}
              {canApprove && noteMissing && (
                <p className="text-xs text-amber-700">{chosen!.action} needs a reason before it can be applied — it is stored on the centre and carried onto every follow-up it raises.</p>
              )}
              {!canApprove && <p className="text-xs text-gray-600">You can read this change. Acting on it needs the sheet-approval right.</p>}
              </>);
            })()}
            </>)}
          </div>
        )}
      </Drawer>
    </div>
  );
}
