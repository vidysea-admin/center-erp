"use client";
import { use, useEffect, useState } from "react";
import Link from "next/link";
import { api, fmtDate } from "@/lib/client";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, Section, Tabs, inputCls } from "@/components/ui";
import { uploadWithRetry } from "@/lib/upload";

// Trainer detail (2026-08-12). The list + drawer had nowhere to show the hiring journey Manish
// described, so this is the host surface for it: where the stage is moved, documents are
// collected, and the NSDC round-trip is recorded.

const TABS = ["Pipeline", "Documents", "Profile", "Assignments"];

// The order the journey actually runs in, for the progress rail.
const JOURNEY = [
  "Applied", "CV Reviewed", "Shortlisted", "Docs Pending", "Docs Complete",
  "Nomination Prepared", "Submitted to NSDC", "NSDC Approved",
  "Payment Done", "TOT Scheduled", "TOT In Progress", "Certified",
];

const DOC_TYPES = ["Aadhaar", "PAN", "Photo", "CV", "Educational Qualification",
  "CIPSA Certificate", "Industry Experience", "Teaching Experience", "Other"];

const fmt = (d?: string | null) => (d ? fmtDate(d) : "—");

export default function TrainerDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [tab, setTab] = useState("Pipeline");
  const [t, setT] = useState<any>(null);
  const [docs, setDocs] = useState<any>({ items: [], summary: null });
  const [batches, setBatches] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const [move, setMove] = useState<any>(null);   // the transition drawer
  const [docDrawer, setDocDrawer] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [{ item }, d] = await Promise.all([
        api(`/api/trainers/${id}`),
        api(`/api/trainers/${id}/documents`),
      ]);
      setT(item); setDocs(d);
      const b = await api(`/api/batches?trainer=${id}&limit=50`).catch(() => ({ items: [] }));
      setBatches(b.items ?? []);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function doMove() {
    setBusy(true);
    try {
      await api(`/api/trainers/${id}/transition`, {
        method: "POST",
        json: {
          target: move.target,
          reason: move.reason || undefined,
          remarks: move.remarks || undefined,
          payload: { tr_id: move.tr_id || undefined, tot_certificate_no: move.tot_certificate_no || undefined, payment_reference: move.payment_reference || undefined },
        },
      });
      setMove(null); await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function addDoc(file: File, doc_type: string) {
    setBusy(true);
    try {
      const url = await uploadWithRetry(file, "document");
      await api(`/api/trainers/${id}/documents`, { method: "POST", json: { doc_type, file_url: url, original_name: file.name } });
      setDocDrawer(false); await load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  if (!t) return <div className="p-6 text-sm text-gray-500">Loading…</div>;

  const stage = t.pipeline_status ?? "Applied";
  const stageIdx = JOURNEY.indexOf(stage);
  const isOff = stage === "NSDC Rejected" || stage === "Dropped";

  return (
    <div className="space-y-4">
      {err && <ErrorBanner msg={err} onDismiss={() => setErr("")} />}

      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="font-serif text-2xl font-semibold">{t.name}</h1>
        <Chip value={t.status} />
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
          stage === "Certified" ? "border-green-200 bg-green-50 text-green-700"
            : isOff ? "border-red-200 bg-red-50 text-red-700"
              : "border-amber-200 bg-amber-50 text-amber-700"}`}>{stage}</span>
        <span className="text-sm text-gray-500">{t.phone}{t.tr_id ? ` · TR ID ${t.tr_id}` : ""}</span>
      </div>

      {/* The rejection is the thing an operator must act on, so it is stated, not buried. */}
      {stage === "NSDC Rejected" && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
          <div className="font-semibold text-red-800">NSDC sent this profile back</div>
          <div className="mt-1 text-red-700">{t.nsdc_remarks || "No remarks recorded."}</div>
          <div className="mt-2 text-red-700">Correct the documents, then move back to <strong>Docs Pending</strong> and resubmit.</div>
        </div>
      )}

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === "Pipeline" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="Hiring journey">
            <ol className="space-y-1.5 text-sm">
              {JOURNEY.map((s, i) => {
                const done = stageIdx >= 0 && i < stageIdx;
                const here = s === stage;
                return (
                  <li key={s} className="flex items-center gap-2">
                    <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                      done ? "bg-green-100 text-green-700" : here ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-400"}`}>
                      {done ? "✓" : here ? "•" : "○"}
                    </span>
                    <span className={here ? "font-semibold" : done ? "text-gray-600" : "text-gray-400"}>{s}</span>
                  </li>
                );
              })}
            </ol>
            <div className="mt-4">
              <Btn onClick={() => setMove({ target: "" })}>Move to next stage</Btn>
            </div>
          </Section>

          <Section title="Nomination & TOT">
            <dl className="grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-gray-500">Nominated for</dt>
              <dd>{t.nominated_for_program?.name ?? "—"}{t.nominated_for_location?.name ? ` at ${t.nominated_for_location.name}` : ""}</dd>
              <dt className="text-gray-500">Nomination sent</dt><dd>{fmt(t.nomination_sent_on)}</dd>
              <dt className="text-gray-500">Submitted to NSDC</dt><dd>{fmt(t.nsdc_submitted_on)}</dd>
              <dt className="text-gray-500">NSDC result</dt><dd>{fmt(t.nsdc_result_on)}</dd>
              <dt className="text-gray-500">Eligibility payment</dt>
              <dd>{t.paid_on ? `₹${t.eligibility_payment_amount ?? 3250} on ${fmt(t.paid_on)}` : "—"}</dd>
              <dt className="text-gray-500">TOT scheduled</dt><dd>{fmt(t.tot_scheduled_on)}</dd>
              <dt className="text-gray-500">TOT completed</dt><dd>{fmt(t.tot_done_on)}</dd>
              <dt className="text-gray-500">TR ID</dt><dd>{t.tr_id || "—"}</dd>
            </dl>
          </Section>
        </div>
      )}

      {tab === "Documents" && (
        <Section title="Documents" actions={<Btn onClick={() => setDocDrawer(true)}>Add document</Btn>}>
          {docs.summary && !docs.summary.complete && (
            <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              Still needed before a nomination: <strong>{docs.summary.missing.join(", ")}</strong>
            </div>
          )}
          <DataTable
            rows={docs.items ?? []}
            cardTitle={(r: any) => r.doc_type}
            columns={[
              { key: "doc_type", label: "Document", mobile: false },
              { key: "original_name", label: "File", render: (r: any) => (
                <a className="text-blue-700 underline" href={r.file_url} target="_blank" rel="noreferrer">{r.original_name || "open"}</a>) },
              { key: "uploaded_by", label: "Uploaded by", render: (r: any) => r.uploaded_by?.name ?? "—", mobile: false },
              { key: "createdAt", label: "On", render: (r: any) => fmt(r.createdAt), mobile: false },
            ]}
            empty="No documents yet."
          />
        </Section>
      )}

      {tab === "Profile" && (
        <Section title="Profile">
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-gray-500">Phone</dt><dd>{t.phone}</dd>
            <dt className="text-gray-500">Email</dt><dd>{t.email || "—"}</dd>
            <dt className="text-gray-500">Job roles</dt><dd>{(t.skills ?? []).join(", ") || "—"}</dd>
            <dt className="text-gray-500">Home centre</dt><dd>{t.home_location?.name ?? "—"}</dd>
            <dt className="text-gray-500">Qualification</dt><dd>{t.qualification || "—"}</dd>
            <dt className="text-gray-500">Industry experience</dt><dd>{t.industry_experience_years != null ? `${t.industry_experience_years} yrs` : "—"}</dd>
            <dt className="text-gray-500">Teaching experience</dt><dd>{t.teaching_experience_years != null ? `${t.teaching_experience_years} yrs` : "—"}</dd>
            <dt className="text-gray-500">Where CV came from</dt><dd>{t.source || "—"}</dd>
          </dl>
          <div className="mt-3"><Link className="text-sm text-blue-700 underline" href="/trainers">Edit on the trainers list</Link></div>
        </Section>
      )}

      {tab === "Assignments" && (
        <Section title="Batches">
          <DataTable
            rows={batches}
            cardTitle={(r: any) => r.code}
            columns={[
              { key: "code", label: "Batch", mobile: false },
              { key: "location", label: "Centre", render: (r: any) => r.location?.name ?? "—" },
              { key: "status", label: "Status", render: (r: any) => <Chip value={r.status} /> },
              { key: "planned_start", label: "Starts", render: (r: any) => fmt(r.planned_start), mobile: false },
            ]}
            onRowClick={(r: any) => { window.location.href = `/erp/batches/${r._id}`; }}
            empty="Not assigned to any batch yet."
          />
        </Section>
      )}

      {move && (
        <Drawer open onClose={() => setMove(null)} title={`Move ${t.name}`}>
          <Field label="Move to" required>
            <select className={inputCls} value={move.target} onChange={(e) => setMove({ ...move, target: e.target.value })}>
              <option value="">Choose…</option>
              {[...JOURNEY, "NSDC Rejected", "Dropped"].map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          {/* Only ask for what this particular move actually requires. */}
          {move.target === "NSDC Rejected" && (
            <Field label="What did NSDC say was wrong?" required>
              <input className={inputCls} value={move.remarks ?? ""} onChange={(e) => setMove({ ...move, remarks: e.target.value })} />
            </Field>
          )}
          {move.target === "Certified" && (
            <>
              <Field label="TR ID" required><input className={inputCls} value={move.tr_id ?? ""} onChange={(e) => setMove({ ...move, tr_id: e.target.value })} /></Field>
              <Field label="TOT certificate no."><input className={inputCls} value={move.tot_certificate_no ?? ""} onChange={(e) => setMove({ ...move, tot_certificate_no: e.target.value })} /></Field>
            </>
          )}
          {move.target === "Payment Done" && (
            <Field label="Payment reference"><input className={inputCls} value={move.payment_reference ?? ""} onChange={(e) => setMove({ ...move, payment_reference: e.target.value })} /></Field>
          )}
          {move.target === "Dropped" && (
            <Field label="Reason" required><input className={inputCls} value={move.reason ?? ""} onChange={(e) => setMove({ ...move, reason: e.target.value })} /></Field>
          )}
          <div className="mt-4"><Btn onClick={doMove} disabled={!move.target || busy}>{busy ? "Saving…" : "Move"}</Btn></div>
        </Drawer>
      )}

      {docDrawer && (
        <Drawer open onClose={() => setDocDrawer(false)} title="Add document">
          <Field label="Document type" required>
            <select className={inputCls} id="dt" defaultValue="Aadhaar">
              {DOC_TYPES.map((d) => <option key={d}>{d}</option>)}
            </select>
          </Field>
          <Field label="File" required>
            <input type="file" className={inputCls} disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                const sel = document.getElementById("dt") as HTMLSelectElement | null;
                if (f && sel) addDoc(f, sel.value);
              }} />
          </Field>
          {busy && <p className="mt-2 text-sm text-gray-500">Uploading…</p>}
        </Drawer>
      )}
    </div>
  );
}
