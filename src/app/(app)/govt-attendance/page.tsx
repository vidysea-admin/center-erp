"use client";
// Government portal attendance (2026-08-12). The boss's ask: Manish uploads the portal export
// "in whatever format" and the system reads it and matches it to our own records. The portal's
// day count is the contractual one, so what this screen exists to surface is the VARIANCE —
// where the portal and the centre's own daily logs disagree about who attended.
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, fmtDT, fmtDate, offerable } from "@/lib/client";
import { BASE_PATH } from "@/lib/base-path";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, Section, inputCls } from "@/components/ui";
import { useLocationCtx, usePerms } from "@/components/shell";

const MATCH_STYLE: Record<string, string> = {
  Matched: "bg-green-50 text-green-700 border-green-200",
  Ambiguous: "bg-amber-50 text-amber-700 border-amber-200",
  Unmatched: "bg-red-50 text-red-700 border-red-200",
};

export default function GovtAttendancePage() {
  return <Suspense><Inner /></Suspense>;
}

function Inner() {
  const sp = useSearchParams();
  const [ctxLoc] = useLocationCtx();
  // QA-153 (-83): a view-level holder reads the imports; the upload controls exist only
  // for edit-level — the route guard already keeps everyone else off this screen.
  const { can, loaded: permsLoaded } = usePerms();
  const canImport = !permsLoaded || can("attendance.govt", "edit");
  const [imports, setImports] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(sp.get("import"));
  const [detail, setDetail] = useState<any>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [upload, setUpload] = useState<any>(null); // { file, preview, counts… }
  // -154 (QA-438): the operator's explicit "yes, import the suspicious layout anyway".
  const [acceptShift, setAcceptShift] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resolve, setResolve] = useState<any>(null); // -102: the Ambiguous/Unmatched row being resolved
  // 2026-08-13: per-batch import ("har batch ke andar daily basis pe upload attendance") —
  // arriving via a batch page carries ?batch=, which scopes the match to that batch's roster.
  const batchParam = sp.get("batch");
  const [batchInfo, setBatchInfo] = useState<any>(null);
  // …and a manual centre picker, because a file whose TC ID is not on any location used to
  // dead-end with "Pick the centre manually" while the page offered no way to do that.
  const [manualLoc, setManualLoc] = useState("");
  const [locations, setLocations] = useState<any[]>([]);

  const load = () =>
    api(`/api/govt-attendance${ctxLoc ? `?location=${ctxLoc}` : ""}`)
      .then((d) => setImports(d.items)).catch((e) => setError(e.message)).finally(() => setLoading(false));
  useEffect(() => { load(); }, [ctxLoc]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api("/api/locations?limit=2000").then((d) => setLocations(d.items)).catch(() => {}); }, []);
  useEffect(() => {
    if (batchParam) api(`/api/batches/${batchParam}`).then((d) => setBatchInfo(d.item)).catch(() => {});
  }, [batchParam]);

  useEffect(() => {
    if (!open) { setDetail(null); return; }
    api(`/api/govt-attendance/${open}${filter ? `?filter=${filter}` : ""}`)
      .then(setDetail).catch((e) => setError(e.message));
  }, [open, filter]);

  // Two-step by design: preview shows what matched before anything is written, because an
  // unmatched row means the portal knows a candidate we do not — that is worth looking at.
  async function preview(file: File) {
    setBusy(true); setError("");
    const fd = new FormData();
    fd.append("file", file);
    if (batchParam) fd.append("batch", batchParam);
    if (manualLoc) fd.append("location", manualLoc);
    try {
      const res = await api("/api/govt-attendance", { method: "POST", body: fd });
      setUpload({ file, ...res });
      setAcceptShift(false); // a fresh file starts with no override, whatever the last one did
    } catch (e: any) { setError(e.message); setUpload(null); }
    setBusy(false);
  }

  async function commit() {
    setBusy(true);
    const fd = new FormData();
    fd.append("file", upload.file); fd.append("confirm", "1");
    if (acceptShift) fd.append("accept_column_shift", "1");
    if (batchParam) fd.append("batch", batchParam);
    if (manualLoc) fd.append("location", manualLoc);
    if (upload.period_label) fd.append("period_label", upload.period_label);
    try {
      const res = await api("/api/govt-attendance", { method: "POST", body: fd });
      setUpload(null); setOpen(res._id); load();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  async function remove(id: string) {
    if (!confirm("Delete this import? The rows go with it — re-upload the file to restore them.")) return;
    try { await api(`/api/govt-attendance/${id}`, { method: "DELETE" }); setOpen(null); load(); }
    catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Government Attendance</h1>
        {batchParam && (
          <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-700">
            importing for batch {batchInfo?.code ?? "…"}
          </span>
        )}
        {canImport && <div className="ml-auto flex items-center gap-2">
          {/* QA-028: every importer offers its sample sheet. */}
          <a href={`${BASE_PATH}/templates/govt-attendance-sample.csv`} download className="text-xs font-medium text-blue-700 hover:underline">⬇ sample format</a>
          <select className={inputCls + " max-w-56 text-xs"} value={manualLoc} onChange={(e) => setManualLoc(e.target.value)} title="Used when the file's TC ID matches no centre">
            <option value="">Centre: auto-detect from file</option>
            {offerable(locations, manualLoc).map((l: any) => <option key={l._id} value={l._id}>{l.name}</option>)}
          </select>
          <label>
            <input type="file" accept=".csv,.xlsx,.xls" className="hidden" disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) preview(f); e.currentTarget.value = ""; }} />
            <span className="cursor-pointer rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
              {busy ? "Reading…" : "Upload portal export"}
            </span>
          </label>
        </div>}
        {!canImport && <span className="ml-auto text-xs text-gray-400">read-only</span>}
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />

      {!open && (
        <Section title="Imports">
          <DataTable rows={imports} onRowClick={(r: any) => { setFilter(""); setOpen(r._id); }}
            loading={loading}
            defaultSort={{ key: "imported_at", dir: "desc" }} columns={[
            { key: "period_label", label: "Period", sortable: true, sortValue: (r: any) => r.period_label || r.file_name, render: (r: any) => <span className="font-medium">{r.period_label || r.file_name}</span> },
            { key: "location", label: "Centre", sortable: true, sortValue: (r: any) => r.location?.name, render: (r: any) => `${r.location?.name ?? "—"}${r.tc_id ? ` · ${r.tc_id}` : ""}` },
            // QA-159 (-86): the record carries the batch; the table never showed it — from the
            // import side nobody could tell which batch an upload went to.
            { key: "batch", label: "Batch", sortable: true, sortValue: (r: any) => r.batch?.code ?? "", render: (r: any) => r.batch?.code
              ? <Link className="text-blue-700 hover:underline" href={`/batches/${r.batch._id ?? r.batch}?tab=Attendance`} onClick={(e) => e.stopPropagation()}>{r.batch.code}</Link>
              : <span className="text-gray-400">centre-wide</span> },
            { key: "row_count", label: "Rows", sortable: true },
            // QA-023: the counts on the list open the import pre-filtered to that subset.
            { key: "matched_count", label: "Matched", sortable: true, render: (r: any) => (
              <button className="font-medium text-blue-700 hover:underline" onClick={(e) => { e.stopPropagation(); setFilter("matched"); setOpen(r._id); }}>
                {r.matched_count}/{r.row_count}
              </button>
            ) },
            {
              // -143 (QA-300, checker's PARTIAL on -142): -142 changed the wording the row quoted -
              // the upload preview, seen once while committing. THIS is the column an operator meets
              // first and every time, and it was still a bold amber number for imports where every
              // row reads "OUR DAYS 0 / 0". Amber is a claim that our logs and the portal disagree;
              // with no logs of ours there is nothing to disagree with, so it is not a discrepancy
              // and it is not coloured like one. The count is still reachable - it is a real count
              // of rows the portal has and we do not - it just no longer poses as an alarm.
              key: "variance_count", label: "Variance", sortable: true, render: (r: any) =>
                !r.variance_count
                  ? <span className="text-gray-400">none</span>
                  : r.have_local_logs
                    ? <button className="font-semibold text-amber-700 hover:underline" onClick={(e) => { e.stopPropagation(); setFilter("variance"); setOpen(r._id); }}>{r.variance_count}</button>
                    : <button className="text-gray-500 hover:underline" title="No attendance of our own has been logged for this period, so there is nothing to compare the portal against. These are the rows the portal counted days for."
                        onClick={(e) => { e.stopPropagation(); setFilter("variance"); setOpen(r._id); }}>nothing to compare</button>,
            },
            { key: "imported_at", label: "Imported", mobile: false, sortable: true, sortValue: (r: any) => r.imported_at ? new Date(r.imported_at).getTime() : null, render: (r: any) => `${fmtDT(r.imported_at)} · ${r.imported_by?.name ?? "—"}` },
          ]} empty="No portal attendance imported yet — upload the export Manish downloads from the portal." />
        </Section>
      )}

      {open && detail && (
        <Section
          title={`${detail.item.period_label || detail.item.file_name} — ${detail.item.org_name || detail.item.location?.name || ""}`}
          actions={
            <span className="flex gap-2">
              <Btn small kind="ghost" onClick={() => setOpen(null)}>← All imports</Btn>
                {canImport ? (
                  /* -142 (QA-297): the label is TYPED, not derived — measured before building this, because
                     the row could not tell and the answer decided whether there was a bug at all. There is
                     not: "Guguram" was somebody's mistype. What was missing is any way to correct it. The
                     import stays uneditable (it records what the portal said); the NAME is ours. */
                  <button className="text-xs font-medium text-blue-700 hover:underline"
                    onClick={async () => {
                      const next = window.prompt("Rename this import — this is our own name for it, not anything the portal sent.", detail.item.period_label || detail.item.file_name);
                      if (next == null || !next.trim() || next.trim() === detail.item.period_label) return;
                      try { await api(`/api/govt-attendance/${detail.item._id}`, { method: "PATCH", json: { period_label: next.trim() } }); load(); setOpen(detail.item._id); }
                      catch (e: any) { setError(e.message); }
                    }}>rename</button>
                ) : null}
              <Btn small kind="danger" onClick={() => remove(open)}>Delete</Btn>
            </span>
          }>
          {/* QA-023: every summary count is a clickable filter of the rows below. */}
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            {[["", `All ${detail.item.row_count}`],
              ["matched", `Matched ${detail.item.matched_count}`],
              ["ambiguous", `Ambiguous ${detail.item.ambiguous_count}`],
              ["unmatched", `Unmatched ${detail.item.unmatched_count}`],
              // -143 (QA-300): the third surface. Grey, so it never looked like an alarm - but it
              // named a comparison that was not made. It stays clickable (QA-023: every count on
              // this summary is its own filter) and now says which question it actually answers.
              ["variance", detail.item.have_local_logs
                ? `Differ from our logs ${detail.item.variance_count}`
                : `Days on the portal, none of ours ${detail.item.variance_count}`]].map(([v, label]) => (
              <button key={v} onClick={() => setFilter(filter === v ? "" : (v as string))}
                className={`rounded-full border px-3 py-1 font-medium ${filter === v ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
                {label}
              </button>
            ))}
          </div>
          {/* -102 (Manish 17/08 [11:51] "qualify ka rule kya hai?" → "60 plus hours, 60 or above…
              60 se niche not eligible"): the bar is stated once, in the client's own terms, with
              where it came from — the scheme master or the Defaults fallback. */}
          {detail.required_hours != null && (
            <p className="mb-3 text-xs text-gray-500">
              <b>Qualified</b> = at least <b>{detail.required_hours} hours</b> on the government portal&apos;s own hour meter
              {detail.min_attendance_pct ? ` (${detail.min_attendance_pct}% of the programme)` : ""} —{" "}
              {detail.min_attendance_source === "scheme" ? "from the scheme master" : "from Defaults, until the scheme master carries hours"}.
              {" "}<span className="cursor-help underline decoration-dotted" title="While the course runs, a student below the bar is still in progress; a student whose portal hours are not imported yet is unknown. Neither is a verdict — &ldquo;not eligible&rdquo; is only said once the course is over.">&ldquo;Not eligible&rdquo; is only said once the course is over.</span>
              <span className="block text-gray-500">
                <span className="text-green-700">Qualified {detail.qualified_count}</span>
                {detail.in_progress_count > 0 && <> · <span className="text-amber-700">{detail.in_progress_count} still short (course running)</span></>}
                {detail.no_hours_count > 0 && <> · {detail.no_hours_count} with no hours in this file</>}
                {detail.not_eligible_count > 0 && <> · <span className="text-red-700">{detail.not_eligible_count} not eligible</span></>}
                {detail.not_enrolled_count > 0 && <> · {detail.not_enrolled_count} not matched to an enrolled student</>}
                {/* -127 (QA-180): the export carries the centre's own trainers. They were being
                    counted inside a student bucket, so this strip quietly overstated how many
                    students still needed chasing. Said out loud now, and excluded from the rest. */}
                {detail.trainer_count > 0 && <> · {detail.trainer_count} trainer{detail.trainer_count > 1 ? "s" : ""} (not assessed)</>}
              </span>
            </p>
          )}
          <DataTable rows={detail.rows} defaultSort={{ key: "name", dir: "asc" }} columns={[
            { key: "name", label: "Name", sortable: true, render: (r: any) => <span className="font-medium">{r.name}</span> },
            { key: "govt_candidate_id", label: "Portal ID", mobile: false, sortable: true },
            { key: "candidate_type", label: "Type", mobile: false, sortable: true },
            { key: "total_days_present", label: "Portal days", sortable: true, render: (r: any) => `${r.total_days_present ?? "—"} / ${r.total_working_days ?? "—"}` },
            { key: "internal_days_present", label: "Our logs", sortable: true, render: (r: any) => r.internal_days_present ?? <span className="text-gray-400">—</span> },
            {
              key: "variance_days", label: "Variance", sortable: true, render: (r: any) =>
                r.variance_days == null ? <span className="text-gray-400">—</span>
                  : r.variance_days === 0 ? <span className="text-green-700">0</span>
                    : <span className="font-semibold text-amber-700">{r.variance_days > 0 ? `+${r.variance_days}` : r.variance_days}</span>,
            },
            { key: "total_hours_raw", label: "Hours", mobile: false },
            {
              // -102: the verdict those hours produce — the column Manish found missing.
              // -109 (Umesh 17/08): this column used to be two-way — Qualified, or "Not eligible"
              // for everyone else. That called 31 Bhadohi students not-eligible three days into a
              // fifteen-day course, 45 more over a parse failure, and 20 on DST-01 who simply were
              // not in the import. The verdict comes from the shared eligibilityVerdict now, which
              // separates "still short, course running" and "no hours imported" from an actual
              // verdict — and only says "Not eligible" once the course is over.
              key: "qualified", label: "Qualification", sortable: true,
              // -127 (QA-180): a trainer sorts ABOVE every student state rather than falling to 0
              // beside "not eligible" — the column is a student ladder and a trainer is not on it.
              sortValue: (r: any) => ({ trainer: 5, qualified: 4, in_progress: 3, no_hours: 2, not_enrolled: 1, not_eligible: 0 } as any)[r.verdict?.state] ?? 0,
              filterText: (r: any) => r.verdict?.label ?? "",
              render: (r: any) => {
                const v = r.verdict;
                if (!v) return <span className="whitespace-nowrap text-[11px] text-gray-400">—</span>;
                const tone = v.state === "qualified" ? "border-green-200 bg-green-50 text-green-700 font-medium"
                  : v.state === "in_progress" ? "border-amber-200 bg-amber-50 text-amber-700"
                    : v.state === "not_eligible" ? "border-red-200 bg-red-50 text-red-700 font-medium"
                      : "border-gray-200 bg-gray-50 text-gray-500";
                return <span title={v.detail} className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] ${tone}`}>{v.label}</span>;
              },
            },
            {
              key: "match_status", label: "Match", sortable: true, render: (r: any) => (
                // -102 (Manish 17/08 [11:34] "ambiguous name pe aisa hona chahiye ki wo click ho
                // to uske baare me pata chal jaye ki kya issue hai"): a decided row states itself;
                // an undecided one is a button into the reason and the fix.
                r.match_status === "Matched" ? (
                  <span title={r.match_note ?? ""} className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${MATCH_STYLE[r.match_status]}`}>
                    {r.match_status}{r.match_by ? ` · ${r.match_by}` : ""}
                  </span>
                ) : (
                  <button onClick={(e) => { e.stopPropagation(); setResolve(r); }}
                    title={r.match_note ? `${r.match_note} — click to see and resolve` : "Click to see why and resolve"}
                    className={`rounded-full border px-2 py-0.5 text-[11px] font-medium underline decoration-dotted ${MATCH_STYLE[r.match_status]}`}>
                    {r.match_status}{r.match_by ? ` · ${r.match_by}` : ""} — why?
                  </button>
                )
              ),
            },
          ]} empty="No rows for this filter." />
          {detail.rows.some((r: any) => r.match_note) && (
            <ul className="mt-3 space-y-1 text-xs text-gray-500">
              {detail.rows.filter((r: any) => r.match_note).slice(0, 10).map((r: any) => (
                <li key={String(r._id)}>• <span className="font-medium">{r.name}</span> — {r.match_note}</li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <Drawer error={error} open={!!upload} onClose={() => setUpload(null)} title="Confirm portal attendance import">
        {upload && (
          <div className="space-y-3 text-sm">
            <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
              <div><span className="text-gray-500">File:</span> {upload.file?.name}</div>
              <div><span className="text-gray-500">Centre:</span> {upload.resolved_location
                ? `${upload.resolved_location.name} (${upload.tc_id})`
                : <span className="text-amber-700">not auto-detected{upload.tc_id ? ` — TC ${upload.tc_id} is not on any location` : ""}</span>}</div>
              <div className="mt-1 flex flex-wrap gap-3">
                <span>{upload.row_count} rows</span>
                <span className="text-green-700">{upload.matched_count} matched</span>
                {!!upload.ambiguous_count && <span className="text-amber-700">{upload.ambiguous_count} ambiguous</span>}
                {!!upload.unmatched_count && <span className="text-red-700">{upload.unmatched_count} unmatched</span>}
                {/* -142 (QA-300): "35 differ from our logs" in orange, at a centre whose batch says
                    "Our logs: 0 days" and whose every candidate reads "OUR DAYS 0 / 0". True, and
                    meaningless — nothing was being compared, and the variance column was the portal's
                    own figure copied across with a + sign. An alarming number that cannot mean what it
                    says is worse than no number: it sends somebody looking for a discrepancy. */}
                {!!upload.variance_count && (upload.have_local_logs
                  ? <span className="text-amber-700">{upload.variance_count} differ from our logs</span>
                  : <span className="text-gray-500">no attendance of our own to compare against yet</span>)}
              </div>
            </div>
            <Field label="Period label"><input className={inputCls} placeholder="e.g. till 11 Aug"
              value={upload.period_label ?? ""} onChange={(e) => setUpload({ ...upload, period_label: e.target.value })} /></Field>
            {!!upload.unmatched_count && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                Unmatched rows are still saved — they are the record of candidates the portal knows and the ERP does not.
                Setting the portal Candidate ID on those candidates makes the next import match them automatically.
              </p>
            )}
            {/* -106: a live Bhadohi import carried its hours as decimals and its days-present column
                under a name we did not know, so it imported "fine" and then showed a whole batch of
                blanks. Say what this file is missing BEFORE it is committed. */}
            {!!upload.missing_columns?.length && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                This file has no {upload.missing_columns.map((m: string, i: number) => (
                  <span key={m}>{i > 0 ? (i === upload.missing_columns.length - 1 ? " or " : ", ") : ""}<b>{m}</b></span>
                ))} column{upload.missing_columns.length > 1 ? "s" : ""} that we recognise, so {upload.missing_columns.length > 1 ? "those columns" : "that column"} will
                read blank on the grid. The rest still imports. If the portal renamed it, send the file over and the reader can learn the new name.
              </p>
            )}
            {/* -108: the portal ID this import will write onto a candidate, named before it is
                written. The evidence is a NAME match (a row matched on the ID means the candidate
                already has one), so the operator gets to see and refuse it rather than find out
                from an audit row afterwards. */}
            {!!upload.portal_ids_to_link?.length && (
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-2 text-xs text-blue-900">
                <b>{upload.portal_ids_to_link.length} candidate{upload.portal_ids_to_link.length === 1 ? "" : "s"} will also get their portal ID from this file</b>{" "}
                — which is what lets certificates named <span className="font-mono">CAN_….pdf</span> land on them later.
                <details className="mt-1">
                  <summary className="cursor-pointer">See exactly who, and on what evidence</summary>
                  <ul className="mt-1 space-y-0.5">
                    {upload.portal_ids_to_link.map((p: any, i: number) => (
                      <li key={i}>• <b>{p.name}</b> → <span className="font-mono">{p.id}</span> <span className="text-blue-700">(matched by {p.matched_by})</span></li>
                    ))}
                  </ul>
                  <p className="mt-1 text-blue-800">
                    A candidate who already has an ID is never changed, and a name shared by two candidates is never stamped at all.
                  </p>
                </details>
              </div>
            )}
            {/* -154 (QA-438, S1): the shifted-column signature, named where the operator can still
                act on it. The 20-08 file put two genuinely qualified students below the 60-hour
                bar because its days-attended column sat in the working-days field - and nothing
                said a word until the count moved. The import button holds until the box is
                ticked; a genuine file never shows this block at all. */}
            {upload.column_shift_suspected && (
              <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-xs text-red-900">
                <b>This file looks column-shifted — check it before importing.</b>{" "}
                {upload.column_shift_detail?.days_present_empty ?? "All"} of {upload.column_shift_detail?.rows ?? upload.row_count} rows have nothing in
                {" "}<b>Total Days Present</b>, while <b>Total Working days</b> differs per student
                ({(upload.column_shift_detail?.distinct_working_days ?? []).join(", ")}) — a genuine export carries one
                working-day figure for the whole batch. This is the layout that read two qualified students as below the
                60-hour bar on 20-08. If the portal really produced it this way, tick to import anyway:
                <label className="mt-2 flex cursor-pointer items-center gap-2 font-medium">
                  <input type="checkbox" checked={acceptShift} onChange={(e) => setAcceptShift(e.target.checked)} />
                  I have checked the file — import it as it is
                </label>
              </div>
            )}
            {upload.hours_parsed === 0 && upload.row_count > 0 && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                <b>No hour figure could be read from any row</b>, so nobody in this file can be judged qualified
                (qualification is decided on the portal&apos;s hours). Accepted shapes are <code>63:25:43</code> and <code>73.99</code>.
              </p>
            )}
            <div className="max-h-60 overflow-y-auto rounded-lg border border-gray-200">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-left text-gray-500"><tr><th className="p-2">Name</th><th className="p-2">Portal ID</th><th className="p-2">Days</th><th className="p-2">Match</th></tr></thead>
                <tbody>
                  {upload.preview?.map((r: any, i: number) => (
                    <tr key={i} className="border-t border-gray-100">
                      <td className="p-2">{r.name}</td><td className="p-2 text-gray-500">{r.govt_candidate_id}</td>
                      <td className="p-2">{r.total_days_present}/{r.total_working_days}</td>
                      <td className="p-2"><Chip value={r.match_status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Btn onClick={commit} disabled={busy || (upload.column_shift_suspected && !acceptShift)}>{busy ? "Importing…" : upload.column_shift_suspected && !acceptShift ? "Held — check the red box above" : `Import ${upload.row_count} rows`}</Btn>
          </div>
        )}
      </Drawer>

      <ResolveDrawer importId={open} row={resolve} canEdit={canImport} error={error} setError={setError}
        onClose={() => setResolve(null)}
        onResolved={() => {
          setResolve(null);
          api(`/api/govt-attendance/${open}${filter ? `?filter=${filter}` : ""}`).then(setDetail).catch((e) => setError(e.message));
          load(); // the import's own matched/ambiguous counts moved
        }} />
    </div>
  );
}

// -102, Manish 17/08 ([11:21]–[11:43]): "ambiguous name kaha se aa gaya — Sachin, Sachin… pata nahi
// kyun aa rahe hai ye, jab dono qualify kar hi chuke hain… ambiguous name pe aisa hona chahiye ki wo
// click ho to uske baare me pata chal jaye ki kya issue hai."
//
// So the drawer answers in that order: the row exactly as the portal sent it, then the importer's
// own reason for refusing to guess, then the candidates it could be — the colliding ones first,
// labelled with WHY they collide. Choosing one is a manual match: recorded as Manual, with the
// operator's reason, and audited.
function ResolveDrawer({ importId, row, canEdit, onClose, onResolved, error, setError }: any) {
  const [data, setData] = useState<any>(null);
  const [pick, setPick] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setData(null); setPick(""); setReason("");
    if (!row || !importId) return;
    api(`/api/govt-attendance/${importId}/rows/${row._id}/match`)
      .then(setData).catch((e) => setError(e.message));
  }, [row?._id, importId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!row) return null;

  async function save() {
    setBusy(true);
    try {
      await api(`/api/govt-attendance/${importId}/rows/${row._id}/match`, { method: "POST", json: { candidate: pick, reason } });
      onResolved();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  return (
    <Drawer open onClose={onClose} title={`${row.match_status} — ${row.name}`} wide error={error}>
      <div className="space-y-4 text-sm">
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs">
          <div className="mb-1 font-medium text-gray-600">What the portal sent</div>
          <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <div><span className="text-gray-500">Name:</span> {row.name}</div>
            <div><span className="text-gray-500">Portal ID:</span> {row.govt_candidate_id || <span className="text-gray-400">none</span>}</div>
            <div><span className="text-gray-500">Type:</span> {row.candidate_type || "—"}{row.designation ? ` · ${row.designation}` : ""}</div>
            <div><span className="text-gray-500">Days:</span> {row.total_days_present ?? "—"} of {row.total_working_days ?? "—"}</div>
            <div><span className="text-gray-500">Hours:</span> {row.total_hours_raw || "—"}</div>
            <div><span className="text-gray-500">Row:</span> #{row.sl_no ?? "—"}</div>
          </div>
        </div>

        <div className={`rounded-lg border p-3 text-xs ${row.match_status === "Ambiguous" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-red-200 bg-red-50 text-red-900"}`}>
          <div className="mb-1 font-medium">Why the import did not decide</div>
          <p>{data?.reason ?? row.match_note ?? "No reason recorded."}</p>
          {row.match_status === "Ambiguous" && (
            <p className="mt-1 text-amber-800">
              Two or more candidates on this {data?.scope === "batch" ? "batch's roster" : "centre"} answer to the same thing,
              so guessing would put a student&apos;s attendance on someone else&apos;s record. Naming the right one below is the fix,
              and it is recorded as a manual decision.
            </p>
          )}
        </div>

        {!canEdit ? (
          <p className="text-xs text-gray-500">You have read-only access to government attendance, so this row cannot be resolved from here.</p>
        ) : !data ? (
          <p className="text-xs text-gray-400">Loading the candidates on this {"roster"}…</p>
        ) : !data.options?.length ? (
          <p className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
            No candidate is enrolled on this {data.scope === "batch" ? "batch" : "centre"} yet, so there is nothing to attach this row to.
            Enroll the roster first, then re-import — or set the portal Candidate ID on the candidate and the next import matches it on its own.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="text-xs font-medium text-gray-600">
              Which candidate is this? {data.collisions > 0 && <span className="font-normal text-amber-700">({data.collisions} collided with this row — shown first)</span>}
            </div>
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-1">
              {data.options.map((o: any) => (
                <label key={String(o.candidate)} className={`flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs ${pick === String(o.candidate) ? "bg-blue-50" : "hover:bg-gray-50"}`}>
                  <input type="radio" name="cand" checked={pick === String(o.candidate)} onChange={() => setPick(String(o.candidate))} />
                  {/* -104: two same-name candidates with no portal ID used to render as two
                      IDENTICAL rows, which made this screen unusable for the one case it exists
                      for. The phone separates them (required, one per candidate) and the enrolment
                      date is how a centre register is ordered — the same things Manish uses to tell
                      his two Sachins apart. */}
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{o.name}</span>
                    {o.sidh_candidate_id && <span className="text-gray-500"> · {o.sidh_candidate_id}</span>}
                    {o.phone && <span className="text-gray-500"> · {o.phone}</span>}
                    <span className="block text-[11px] text-gray-400">
                      {o.batch ?? "—"}
                      {o.joined_on ? ` · enrolled ${fmtDate(o.joined_on)}` : ""}
                      {o.enrollment_status ? ` · ${o.enrollment_status}` : ""}
                      {o.left_on ? <span className="text-red-600"> · dropped {fmtDate(o.left_on)}</span> : null}
                    </span>
                  </span>
                  {o.collides && <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800">{o.collides}</span>}
                </label>
              ))}
            </div>
            <Field label="How was this decided? (recorded in the audit trail)">
              <input className={inputCls} placeholder="e.g. checked the centre register — this is the Sachin with TR ID …"
                value={reason} onChange={(e) => setReason(e.target.value)} />
            </Field>
            <div className="flex items-center gap-3">
              <Btn onClick={save} disabled={busy || !pick}>{busy ? "Saving…" : "This one — match it"}</Btn>
              <span className="text-xs text-gray-400">
                The row becomes <b>Matched · Manual</b> and is reconciled against our own daily logs, exactly as an automatic match is.
              </span>
            </div>
          </div>
        )}
      </div>
    </Drawer>
  );
}
