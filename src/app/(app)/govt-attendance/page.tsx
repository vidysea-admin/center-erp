"use client";
// Government portal attendance (2026-08-12). The boss's ask: Manish uploads the portal export
// "in whatever format" and the system reads it and matches it to our own records. The portal's
// day count is the contractual one, so what this screen exists to surface is the VARIANCE —
// where the portal and the centre's own daily logs disagree about who attended.
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, fmtDT, fmtDate } from "@/lib/client";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, Section, inputCls } from "@/components/ui";
import { useLocationCtx } from "@/components/shell";

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
  const [imports, setImports] = useState<any[]>([]);
  const [open, setOpen] = useState<string | null>(sp.get("import"));
  const [detail, setDetail] = useState<any>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [upload, setUpload] = useState<any>(null); // { file, preview, counts… }
  const [busy, setBusy] = useState(false);
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
    } catch (e: any) { setError(e.message); setUpload(null); }
    setBusy(false);
  }

  async function commit() {
    setBusy(true);
    const fd = new FormData();
    fd.append("file", upload.file); fd.append("confirm", "1");
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
        <div className="ml-auto flex items-center gap-2">
          <select className={inputCls + " max-w-56 text-xs"} value={manualLoc} onChange={(e) => setManualLoc(e.target.value)} title="Used when the file's TC ID matches no centre">
            <option value="">Centre: auto-detect from file</option>
            {locations.map((l: any) => <option key={l._id} value={l._id}>{l.name}</option>)}
          </select>
          <label>
            <input type="file" accept=".csv,.xlsx,.xls" className="hidden" disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) preview(f); e.currentTarget.value = ""; }} />
            <span className="cursor-pointer rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
              {busy ? "Reading…" : "Upload portal export"}
            </span>
          </label>
        </div>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />

      {!open && (
        <Section title="Imports">
          <DataTable rows={imports} onRowClick={(r: any) => { setFilter(""); setOpen(r._id); }}
            loading={loading}
            defaultSort={{ key: "imported_at", dir: "desc" }} columns={[
            { key: "period_label", label: "Period", sortable: true, sortValue: (r: any) => r.period_label || r.file_name, render: (r: any) => <span className="font-medium">{r.period_label || r.file_name}</span> },
            { key: "location", label: "Centre", sortable: true, sortValue: (r: any) => r.location?.name, render: (r: any) => `${r.location?.name ?? "—"}${r.tc_id ? ` · ${r.tc_id}` : ""}` },
            { key: "row_count", label: "Rows", sortable: true },
            { key: "matched_count", label: "Matched", sortable: true, render: (r: any) => `${r.matched_count}/${r.row_count}` },
            {
              key: "variance_count", label: "Variance", sortable: true, render: (r: any) =>
                r.variance_count ? <span className="font-semibold text-amber-700">{r.variance_count}</span> : <span className="text-gray-400">none</span>,
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
              <Btn small kind="danger" onClick={() => remove(open)}>Delete</Btn>
            </span>
          }>
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            {[["", `All ${detail.item.row_count}`], ["variance", `Variance ${detail.item.variance_count}`], ["unmatched", `Unmatched ${detail.item.unmatched_count + detail.item.ambiguous_count}`]].map(([v, label]) => (
              <button key={v} onClick={() => setFilter(v as string)}
                className={`rounded-full border px-3 py-1 font-medium ${filter === v ? "border-blue-300 bg-blue-50 text-blue-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}>
                {label}
              </button>
            ))}
          </div>
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
              key: "match_status", label: "Match", sortable: true, render: (r: any) => (
                <span title={r.match_note ?? ""} className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${MATCH_STYLE[r.match_status]}`}>
                  {r.match_status}{r.match_by ? ` · ${r.match_by}` : ""}
                </span>
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

      <Drawer open={!!upload} onClose={() => setUpload(null)} title="Confirm portal attendance import">
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
                {!!upload.variance_count && <span className="text-amber-700">{upload.variance_count} differ from our logs</span>}
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
            <Btn onClick={commit} disabled={busy}>{busy ? "Importing…" : `Import ${upload.row_count} rows`}</Btn>
          </div>
        )}
      </Drawer>
    </div>
  );
}
