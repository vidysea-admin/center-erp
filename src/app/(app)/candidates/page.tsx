"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { api, offerable } from "@/lib/client";
import { emailError, phoneError } from "@/lib/validate";
import { FRESH_TAGS, JOURNEY_TAGS, isFreshCandidate, freshJourneyOf as sharedFreshJourneyOf, journeyOf as sharedJourneyOf } from "@/lib/candidate-journey";
import { Btn, Chip, CopyBtn, DataTable, Drawer, ErrorBanner, Field, FilterPills, NameCell, ShareLinkPanel, SourceCell, copyText, inputCls , Tabs} from "@/components/ui";
import { useLocationCtx } from "@/components/shell";
import { BASE_PATH } from "@/lib/base-path";
import { bulkSmsCsv, smsLink, unsendableCount, waLink } from "@/lib/messaging";
import { uploadWithRetry } from "@/lib/upload";

// -115 (QA-221): a RETIRED programme (active === false) leaves the pickers where something new is
// created, but never disappears from a record that already points at one — editing such a record must
// not silently blank the field. Retiring is a decision about what may be started, not about history.


export default function CandidatesPage() {
  return <Suspense><CandidatesInner /></Suspense>;
}

function CandidatesInner() {
  const sp = useSearchParams();
  // R-H (CEO [27:45], in the enrollment worklist): "Remove the source from here — we don't
  // need it once the data is included here." Admin/Ops keep provenance; Enrollment doesn't.
  const { data: session } = useSession();
  const role = (session?.user as any)?.role;
  const [items, setItems] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [programs, setPrograms] = useState<any[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
  const [ctxLoc] = useLocationCtx();
  const [fLoc, setFLoc] = useState("");
  useEffect(() => { setFLoc(ctxLoc); }, [ctxLoc]);
  // 2026-08-13 (Umesh): status TAG pills with counts instead of a dropdown — including the
  // states nobody could see before: "No programme" (bulk-imported rows), "Multi-interest",
  // "Failed". Pills filter client-side so every count is visible at once; deep links
  // /candidates?lifecycle_status=Enrolled and ?program=null preset the pill.
  const [tag, setTag] = useState(sp.get("lifecycle_status") ?? (sp.get("program") === "null" ? "No programme" : ""));
  // Bucket deep-links: /candidates?bucket=Enrolled, and lifecycle presets pick their bucket.
  const [bucket, setBucket] = useState<"Fresh" | "Enrolled">(
    sp.get("bucket") === "Enrolled" || ["Assigned", "Enrolled", "Completed", "Failed"].includes(sp.get("lifecycle_status") ?? "") ? "Enrolled" : "Fresh");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [shareLink, setShareLink] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<"" | "add" | "edit" | "import" | "assign">("");
  // QA-021: the drop drawer's state.
  const [dropT, setDropT] = useState<any>(null);
  const [dropForm, setDropForm] = useState<any>({});
  const [dropReasons, setDropReasons] = useState<any[]>([]);
  const [editId, setEditId] = useState<string>("");
  const [form, setForm] = useState<any>({});
  const [importState, setImportState] = useState<any>({});
  const [dupes, setDupes] = useState<any[]>([]);
  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));

  // Rule 7: advisory duplicate lookup while the operator types. Never blocks the save.
  useEffect(() => {
    const phone = String(form.phone ?? "").replace(/\D/g, "");
    if (drawer !== "add" || phone.length < 7) { setDupes([]); return; }
    const t = setTimeout(() => {
      api("/api/candidates/check-duplicate", { method: "POST", json: { name: form.name, phone: form.phone, dob: form.dob } })
        .then((d) => setDupes(d.duplicates ?? []))
        .catch(() => setDupes([]));
    }, 400);
    return () => clearTimeout(t);
  }, [form.phone, form.name, form.dob, drawer]);

  const load = () => {
    // Search moved into DataTable (all-column, client-side) — the fetch brings the full
    // scoped set anyway. ?q= deep links from global search land via initialSearch below.
    const params = new URLSearchParams({ limit: "2000" });
    if (fLoc) params.set("location", fLoc);
    return Promise.all([
      api(`/api/candidates?${params}`).then((d) => setItems(d.items)),
      api("/api/locations?limit=2000").then((d) => setLocations(d.items)),
      api("/api/programs?limit=1000").then((d) => setPrograms(d.items)),
      api("/api/batches").then((d) => setBatches(d.items.filter((b: any) => ["Planning", "Ready", "Active"].includes(b.status)))),
      // QA-021: the drop drawer offers the master's reasons (free text stays available —
      // the master ships empty until Admin/Manish fill it).
      api("/api/master-lists/drop-reasons").then((d) => setDropReasons(d.items ?? [])).catch(() => {}),
    ]).catch((e) => setError(e.message)).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [fLoc]);

  // 2026-08-14 (CEO): "do bucket banao — FRESH (inquiry, jab tak batch assign nahi) aur
  // ENROLLED (batch se billing tak ki poori journey, current status ke saath)".
  // QA-021 (-68): the whole derivation moved VERBATIM to lib/candidate-journey.ts — the drop
  // verb stamps "Dropped (at <stage>)" with the same function this page renders with, so the
  // two can never disagree (the QA-133/138 dual-copy lesson, third time). Comments preserved
  // there: CEO 14/08 [28:12] dropout vs Fresh, QA-069 result-outranks-lifecycle, [29:36]
  // Fresh's own journey, 15/08 fee-stage removal.
  const isFresh = (r: any) => isFreshCandidate(r);
  const freshItems = items.filter(isFresh);
  const enrolledItems = items.filter((r: any) => !isFresh(r));
  const bucketItems = bucket === "Fresh" ? freshItems : enrolledItems;
  const journeyOf = (r: any): string => sharedJourneyOf({ ...r, active_batch_status: r.active_batch?.status });
  const freshJourneyOf = (r: any): string => sharedFreshJourneyOf(r);
  const LIFECYCLE_TAGS = bucket === "Fresh" ? FRESH_TAGS : JOURNEY_TAGS;
  // 2026-08-13 (Umesh): a candidate in a batch HAS that batch's programme — "No programme"
  // only when neither the row nor an active membership carries one.
  const progOf = (r: any) => r.program ?? r.active_batch?.program ?? null;
  const tagOf = (r: any): string[] => {
    const tags = [bucket === "Fresh" ? freshJourneyOf(r) : journeyOf(r)];
    if (!progOf(r)) tags.push("No programme");
    if ((r.interested_programs?.length ?? 0) > 1) tags.push("Multi-interest");
    return tags;
  };
  const tagCount = (t: string) => bucketItems.filter((r) => tagOf(r).includes(t)).length;
  const shown = tag ? bucketItems.filter((r) => tagOf(r).includes(tag)) : bucketItems;

  function toggle(id: string) {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  }

  // QA-141 rider (-72): in-flight guard against double-submit.
  const [savingC, setSavingC] = useState(false);
  async function saveCandidate() {
    if (savingC) return;
    setSavingC(true);
    try {
      if (drawer === "edit" && editId) {
        // PATCH is partial: a blank select/date means "not changing this", never "cast '' to
        // ObjectId/Date" (imported rows legitimately have location/program/dob still empty).
        const json = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ""));
        await api(`/api/candidates/${editId}`, { method: "PATCH", json });
      } else await api("/api/candidates", { method: "POST", json: form });
      setDrawer(""); setForm({}); setEditId(""); load();
    } catch (e: any) { setError(e.message); }
    setSavingC(false);
  }

  // Sheet-imported rows carry sheet mistakes (wrong phone, synthetic DOB from an "age" column,
  // fuzzy-matched location) — the row itself opens the same form for correction.
  function openEdit(r: any) {
    setEditId(r._id);
    setForm({
      name: r.name ?? "", phone: r.phone ?? "", alt_phone: r.alt_phone ?? "", email: r.email ?? "", gender: r.gender ?? "",
      custom_fields: r.custom_fields, // read-only display; the PATCH whitelist ignores it
      dob: r.dob ? String(r.dob).slice(0, 10) : "",
      location: r.location?._id ?? r.location ?? "", program: r.program?._id ?? r.program ?? "",
      education: r.education ?? "", source: r.source ?? "",
      last_training_date: r.last_training_date ? String(r.last_training_date).slice(0, 10) : "",
      sidh_candidate_id: r.sidh_candidate_id ?? "",
      // -116 (SS-01): the government-portal fields ride the edit form too, or opening a record and
      // saving it would silently drop everything typed into that section.
      ...Object.fromEntries(["salutation", "father_name", "mother_name", "marital_status", "religion",
        "social_category", "state", "district", "sub_district"]
        .map((f) => [f, r[f] ?? ""])),
      interested_programs: (r.interested_programs ?? []).map((x: any) => x?._id ?? x),
      interested_locations: (r.interested_locations ?? []).map((x: any) => x?._id ?? x),
    });
    setDrawer("edit");
  }

  async function bulkAssign(batchId: string) {
    try {
      const res = await api("/api/candidates/assign", { method: "POST", json: { batch: batchId, candidate_ids: [...selected] } });
      const failed = res.results.filter((r: any) => !r.ok);
      const notes: string[] = [];
      if (failed.length) notes.push(`${failed.length} failed: ${failed[0].error}`);
      if (res.warnings?.length) notes.push(`Eligibility warnings — ${res.warnings.join(" · ")}`);
      if (notes.length) setError(`${res.assigned} assigned. ${notes.join(" | ")}`);
      setSelected(new Set()); setDrawer(""); load();
    } catch (e: any) { setError(e.message); }
  }

  // 2026-08-11: SIDH registration link per candidate. 2026-08-12 (Manish): rural candidates are
  // not reliably on WhatsApp, so the same link goes out over SMS too — `channel` picks which.
  async function sendSidhLink(c: any, channel: "wa" | "sms") {
    try {
      const d = await api("/api/defaults");
      const url = d.item?.sidh_url || "https://www.skillindiadigital.gov.in/";
      const msg = `Hello ${c.name}! Please register for your training on the Skill India portal: ${url}`;
      const href = channel === "wa" ? waLink(c.phone, msg) : smsLink(c.phone, msg);
      if (!href) { setError(`${c.name} has no usable 10-digit mobile number.`); return; }
      window.open(href, "_blank");
      await api(`/api/candidates/${c._id}`, { method: "PATCH", json: { sidh_status: "Link Sent", sidh_link_sent_at: new Date().toISOString() } });
      load();
    } catch (e: any) { setError(e.message); }
  }

  // Bulk SMS for the filtered list — the gateway-ready CSV, since sending 60 links by hand is
  // not a thing anyone will do.
  async function downloadBulkSms() {
    try {
      const d = await api("/api/defaults");
      const url = d.item?.sidh_url || "https://www.skillindiadigital.gov.in/";
      const targets = items.filter((r: any) => r.sidh_status !== "Registered");
      if (!targets.length) { setError("Every candidate in this view is already registered."); return; }
      const csv = bulkSmsCsv(targets, (t: any) => `Hello ${t.name}! Please register for your training on the Skill India portal: ${url}`);
      const skipped = unsendableCount(targets);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      a.download = `sms-sidh-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      setError(skipped ? `Downloaded. ${skipped} candidate(s) skipped — no usable mobile number.` : "");
    } catch (e: any) { setError(e.message); }
  }

  async function markSidhRegistered(c: any) {
    try {
      await api(`/api/candidates/${c._id}`, { method: "PATCH", json: { sidh_status: "Registered", sidh_registered_on: new Date().toISOString(), sidh_failure_reason: "" } });
      load();
    } catch (e: any) { setError(e.message); }
  }

  // GD-81: a refused registration goes into its own queue WITH the why — "registration ho hi
  // nahi paya, to main time kyun waste karun… doosri queue mein dalunga".
  async function markSidhFailed(c: any) {
    const reason = window.prompt(`Why did the portal refuse ${c.name}'s registration?\n(e.g. OTP not received, Aadhaar mismatch, already registered elsewhere)`);
    if (reason == null) return; // cancelled
    if (!reason.trim()) { setError("A failed registration needs the reason — the queue is useless without it."); return; }
    try {
      await api(`/api/candidates/${c._id}`, { method: "PATCH", json: { sidh_status: "Registration Failed", sidh_failure_reason: reason.trim() } });
      load();
    } catch (e: any) { setError(e.message); }
  }

  // GD-70: one click from the row to the portal itself. Cross-site prefill is not possible from
  // a browser; opening the right portal with the row on screen is the practical version.
  async function openSidhPortal() {
    try {
      const d = await api("/api/defaults");
      window.open(d.item?.sidh_url || "https://www.skillindiadigital.gov.in/", "_blank");
    } catch (e: any) { setError(e.message); }
  }

  // 2026-08-11: per-location public self-registration link. 2026-08-13 (Umesh): alert()
  // text can't be selected — the link now lands in a panel with a selectable input.
  async function shareRegistrationLink() {
    if (!fLoc) { setError("Pick a location filter first — the link is per location."); return; }
    try {
      const existing = await api(`/api/public-tokens?purpose=register&location=${fLoc}`);
      const active = existing.items?.find((t: any) => t.active);
      const t = active ?? (await api("/api/public-tokens", { method: "POST", json: { purpose: "register", location: fLoc } })).item;
      const link = `${window.location.origin}${BASE_PATH}/p/register/${t.token}`;
      await copyText(link); // best-effort auto-copy; the panel is the guarantee
      setError(""); setShareLink(link);
    } catch (e: any) { setError(e.message); }
  }

  // QA-105: document section for the edit drawer — list + multi-upload + delete.
  function CandidateDocs({ candidateId, setError }: { candidateId: string; setError: (m: string) => void }) {
    const [docs, setDocs] = useState<any[]>([]);
    const [busy, setBusy] = useState(false);
    const loadDocs = () => api(`/api/candidates/${candidateId}/documents`).then((d) => setDocs(d.items ?? [])).catch(() => setDocs([]));
    useEffect(() => { loadDocs(); }, [candidateId]); // eslint-disable-line react-hooks/exhaustive-deps
    const guess = (name: string): string => {
      const n = name.toLowerCase();
      if (/aadhaar|aadhar/.test(n)) return "Aadhaar";
      if (/pan/.test(n)) return "PAN";
      if (/photo|passport|selfie/.test(n)) return "Photo";
      if (/edu|degree|marksheet|certificate|qual/.test(n)) return "Educational Qualification";
      if (/bank|passbook/.test(n)) return "Bank Passbook";
      return "Other";
    };
    async function addFiles(files: FileList | null) {
      if (!files?.length) return;
      setBusy(true);
      try {
        for (const file of Array.from(files)) {
          const url = await uploadWithRetry(file, "candidate-doc", { folder_centre: "_candidates", folder_kind: "documents", entity: "Candidate", entity_id: candidateId });
          await api(`/api/candidates/${candidateId}/documents`, { method: "POST", json: { doc_type: guess(file.name), file_url: url, original_name: file.name } });
        }
        await loadDocs();
      } catch (e: any) { setError(e.message); }
      setBusy(false);
    }
    return (
      <div className="rounded-lg border border-gray-200 px-3 py-2">
        <div className="mb-1 text-xs font-medium text-gray-500">Documents</div>
        {docs.length === 0 && <p className="mb-1 text-xs text-gray-400">No documents yet.</p>}
        <ul className="mb-2 space-y-1 text-sm">
          {docs.map((d) => (
            <li key={d._id} className="flex items-center justify-between gap-2">
              <a className="min-w-0 truncate text-blue-700 underline" href={d.file_url} target="_blank" rel="noreferrer">{d.doc_type}{d.original_name ? ` — ${d.original_name}` : ""}</a>
              <button type="button" className="shrink-0 text-xs text-red-600 hover:underline" onClick={async () => {
                if (!window.confirm(`Delete this ${d.doc_type}? The audit log keeps a record.`)) return;
                try { await api(`/api/candidates/${candidateId}/documents/${d._id}`, { method: "DELETE" }); await loadDocs(); }
                catch (e: any) { setError(e.message); }
              }}>Delete</button>
            </li>
          ))}
        </ul>
        <input type="file" multiple disabled={busy} accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp,.heic" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
        <p className="mt-1 text-[11px] text-gray-400">Pick several files at once — the type is detected from each filename. Wrong type? Delete the document and upload it again.</p>
      </div>
    );
  }

  // Excel import steps
  // QA-110: the same sheet shape shouldn't be re-mapped by hand every time — the last
  // mapping is remembered per column-set (localStorage; purely a convenience, server unchanged).
  // QA-146: key bumped to -v2 — the old key held the poisoned CHI-ITI mapping (real phone
  // under __EMPTY_4) in the operator's browser and would have re-applied it silently.
  const mapMemory = (columns: string[]) => {
    try {
      localStorage.removeItem("erp-import-map-candidates");
      const saved = JSON.parse(localStorage.getItem("erp-import-map-candidates-v2") ?? "null");
      if (saved?.sig === [...columns].sort().join("|")) return saved.mapping as Record<string, string>;
    } catch {}
    return null;
  };
  const clearMapMemory = () => { try { localStorage.removeItem("erp-import-map-candidates-v2"); } catch {}; setImportState((s: any) => ({ ...s, mapping: {}, remembered: false })); };
  async function importUpload(file: File) {
    const fd = new FormData();
    fd.append("file", file); fd.append("location", importState.location); fd.append("program", importState.program);
    try {
      const res = await api("/api/candidates/import", { method: "POST", body: fd });
      const remembered = mapMemory(res.columns ?? []);
      setImportState((s: any) => ({ ...s, file, columns: res.columns, mapping: remembered ?? {}, remembered: !!remembered, total: res.total }));
    } catch (e: any) { setError(e.message); }
  }
  async function importConfirm(preview: boolean) {
    const fd = new FormData();
    fd.append("file", importState.file); fd.append("location", importState.location); fd.append("program", importState.program);
    fd.append("mapping", JSON.stringify(importState.mapping));
    // 15/08 (Umesh): unknown columns are accepted by default — the operator unticks to ignore.
    if (importState.accept_unknown !== false) fd.append("accept_unknown", "1");
    if (!preview) fd.append("confirm", "1");
    try {
      const res = await api("/api/candidates/import", { method: "POST", body: fd });
      if (preview) setImportState((s: any) => ({ ...s, preview: res, force_bad: false }));
      else {
        // QA-146: never MEMORIZE a mapping whose preview showed majority-invalid phones —
        // the remembered CHI-ITI mapping would have re-applied itself to every next sheet.
        const bad = (res.phone_invalid_count ?? importState.preview?.phone_invalid_count ?? 0) >= Math.max(1, Math.ceil((importState.preview?.valid ?? 0) / 2));
        if (!bad) { try { localStorage.setItem("erp-import-map-candidates-v2", JSON.stringify({ sig: [...(importState.columns ?? [])].sort().join("|"), mapping: importState.mapping ?? {} })); } catch {} }
        setDrawer(""); setImportState({}); load();
      }
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Candidates <span className="text-sm font-normal text-gray-400">(pool)</span></h1>
        <div className="flex flex-wrap gap-2">
          <select className={inputCls + " max-w-64"} value={fLoc} onChange={(e) => setFLoc(e.target.value)}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l._id} value={l._id} title={l.name}>{l.name}</option>)}
          </select>
          <Btn kind="ghost" onClick={() => { setImportState({}); setDrawer("import"); }}>Import Excel</Btn>
          <Btn kind="ghost" onClick={shareRegistrationLink}>Self-reg link</Btn>
          {/* 2026-08-13 (Umesh): one public door for every candidate — share it anywhere. */}
          <CopyBtn text={`${typeof window !== "undefined" ? window.location.origin : ""}${BASE_PATH}/p/me`}
            className="rounded-lg border border-gray-300 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 whitespace-nowrap">
            Candidate portal link
          </CopyBtn>
          <Btn kind="ghost" onClick={downloadBulkSms}>Bulk SMS file</Btn>
          <a href={`${BASE_PATH}/api/candidates/export-sidh${fLoc ? `?location=${fLoc}` : ""}`}
            className="flex h-9 items-center rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:border-blue-300 hover:text-blue-700"
            title="Excel in the SIDH CRM's format — upload it in the assisted-registration console">
            Export for SIDH CRM
          </a>
          <Btn onClick={() => setDrawer("add")}>Add Candidate</Btn>
        </div>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      {shareLink && (
        <ShareLinkPanel label="Self-registration link" link={shareLink}
          hint="Share it on WhatsApp — candidates fill their own details."
          onDismiss={() => setShareLink("")} />
      )}
      {/* CEO: Fresh = inquiry se batch-assign tak; Enrolled = batch se billing tak. */}
      <Tabs tabs={[`Fresh Candidates (${freshItems.length})`, `Enrolled Candidates (${enrolledItems.length})`]}
        active={bucket === "Fresh" ? `Fresh Candidates (${freshItems.length})` : `Enrolled Candidates (${enrolledItems.length})`}
        onChange={(t) => { setBucket(t.startsWith("Fresh") ? "Fresh" : "Enrolled"); setTag(""); }} />
      <FilterPills active={tag} onChange={(v) => setTag(v === tag ? "" : v)}
        options={[
          { value: "", label: "All", count: bucketItems.length },
          ...LIFECYCLE_TAGS.map((t) => ({
            value: t, label: t, count: tagCount(t),
            // Mutually exclusive CURRENT states — a zero on an earlier stage while a later
            // one is full means everyone moved through, not a broken funnel (N02).
            title: {
              "Fresh Lead": "Inquiry stage — Skill India registration not started",
              "Portal Link Sent": "Registration link sent (WhatsApp/SMS) — waiting on the candidate",
              "Registered on Portal": "Skill India registration done — ready for batch assignment",
              "Dropped": "Left/removed",
              "Enrollment in progress": "Placed into a batch; registration/KYC/acceptance still running",
              "Training Ongoing": "Enrolled on a batch that is currently Active",
              "Training Completed": "Their batch finished training; result not final yet",
              "Result Awaited": "Assessment done, awaiting the recorded result",
              "Certified": "Passed — certificate issued or on its way",
              "Dropout": "Enrolled but left before completing the training (CEO stage, set from admin via the roster drop)",
              "Failed": "Completed the training and did not pass",
              "Absent at Assessment": "Did not appear for the assessment — result recorded as Absent",
            }[t as string],
          })),
          { value: "No programme", label: "No programme", count: tagCount("No programme") },
          { value: "Multi-interest", label: "Multi-interest", count: tagCount("Multi-interest") },
        ]} />
      {selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Btn small onClick={() => setDrawer("assign")}>Assign to Batch</Btn>
          <Btn small kind="ghost" onClick={() => setSelected(new Set())}>Clear</Btn>
        </div>
      )}
      <DataTable rows={shown}
        cardTitle={(r: any) => r.name}
        onRowClick={openEdit}
        loading={loading}
        defaultSort={{ key: "name", dir: "asc" }}
        initialSearch={sp.get("q") ?? ""}
        columns={[
          { key: "_sel", label: "", mobile: false, render: (r: any) => <input type="checkbox" checked={selected.has(r._id)} onChange={() => toggle(r._id)} onClick={(e) => e.stopPropagation()} disabled={r.lifecycle_status !== "Unassigned" && r.lifecycle_status !== "Dropped"} /> },
          { key: "name", label: "Name", sortable: true, sortValue: (r: any) => r.name, render: (r: any) => <NameCell name={r.name} sub={r.gender} /> },
          { key: "phone", label: "Phone" },
          {
            // R-H (CEO [11:29]): "If I click on location, I should be able to see the
            // location detail" — the cell is a real link, the row still opens the candidate.
            key: "location", label: "Location", sortable: true, sortValue: (r: any) => r.location?.name,
            render: (r: any) => r.location
              ? <Link className="text-blue-700 hover:underline" href={`/locations/${r.location._id ?? r.location}`} onClick={(e) => e.stopPropagation()}>{r.location.name}</Link>
              : "—",
          },
          {
            // R-H (CEO [12:00]): "you also mention here as a data point, batch number — and
            // when I click on that batch number, I should be able to see all the details".
            key: "batch", label: "Batch", mobile: false, sortable: true, sortValue: (r: any) => r.active_batch?.code ?? "",
            filterText: (r: any) => r.active_batch?.code ?? "",
            render: (r: any) => r.active_batch
              ? <Link className="text-blue-700 hover:underline" href={`/batches/${r.active_batch._id}`} onClick={(e) => e.stopPropagation()}>{r.active_batch.code}</Link>
              : <span className="text-gray-400">—</span>,
          },
          {
            key: "program", label: "Program", sortable: true, filterable: true, sortValue: (r: any) => progOf(r)?.name ?? "",
            // R-K (CEO [11:29]): the programme cell links to its detail page.
            render: (r: any) => r.program
              ? <Link className="text-blue-700 hover:underline" href={`/programs/${r.program._id ?? r.program}`} onClick={(e) => e.stopPropagation()}>{r.program.name}</Link>
              : (r.active_batch?.program
                ? <span title={`Via batch ${r.active_batch.code} — the row itself has no programme yet`}>{r.active_batch.program.name} <span className="text-[10px] text-gray-400">via {r.active_batch.code}</span></span>
                : <Chip value="No programme" />),
          },
          {
            // CEO terminology: Fresh bucket shows the pool state; Enrolled bucket shows the
            // JOURNEY (Enrollment in progress → Training Ongoing → Training Completed →
            // Result Awaited → Certified / Dropout / Failed).
            // QA-021: a dropped row NAMES the stage the journey ended at, trainer-style.
            key: "lifecycle_status", label: bucket === "Fresh" ? "Stage" : "Journey status", sortable: true,
            sortValue: (r: any) => bucket === "Fresh" ? freshJourneyOf(r) : journeyOf(r),
            filterText: (r: any) => bucket === "Fresh" ? freshJourneyOf(r) : journeyOf(r),
            render: (r: any) => {
              const j = bucket === "Fresh" ? freshJourneyOf(r) : journeyOf(r);
              return ["Dropped", "Dropout"].includes(j) && r.dropped_from_stage
                ? <span title={r.dropped_reason ? `Reason: ${r.dropped_reason}` : undefined}><Chip value={`${j} (at ${r.dropped_from_stage})`} /></span>
                : <Chip value={j} />;
            },
          },
          {
            key: "eligibility", label: "Eligible",
            filterText: (r: any) => r.eligibility ? (r.eligibility.eligible ? (r.eligibility.unknown?.length ? "Unverified" : "Eligible") : "Not eligible") : "",
            render: (r: any) => r.eligibility ? (
              r.eligibility.eligible
                ? (r.eligibility.unknown?.length
                  ? <span className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-[11px] text-gray-500" title={r.eligibility.unknown.join("; ")}>Unverified</span>
                  : <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] font-semibold text-green-700">Eligible</span>)
                : <span className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700" title={r.eligibility.reasons.join("; ")}>Not eligible</span>
            ) : null,
          },
          {
            key: "sidh_status", label: "SIDH", render: (r: any) => (
              <span className="flex items-center gap-1.5">
                <Chip value={r.sidh_status ?? "Not Registered"} />
                {r.sidh_status === "Registration Failed" && r.sidh_failure_reason && (
                  <span className="text-[11px] text-red-600" title={r.sidh_failure_reason}>({r.sidh_failure_reason.slice(0, 24)}{r.sidh_failure_reason.length > 24 ? "…" : ""})</span>
                )}
                {r.sidh_status !== "Registered" && (
                  <>
                    <button className="text-[11px] font-medium text-blue-700 hover:underline" title="Send registration link on WhatsApp"
                      onClick={(e) => { e.stopPropagation(); sendSidhLink(r, "wa"); }}>WhatsApp</button>
                    <button className="text-[11px] font-medium text-indigo-700 hover:underline" title="Send the same link by SMS — for candidates who do not use WhatsApp"
                      onClick={(e) => { e.stopPropagation(); sendSidhLink(r, "sms"); }}>SMS</button>
                    <button className="text-[11px] font-medium text-gray-600 hover:underline" title="Open the SIDH portal"
                      onClick={(e) => { e.stopPropagation(); openSidhPortal(); }}>Portal↗</button>
                    <button className="text-[11px] font-medium text-green-700 hover:underline" title="Mark as registered on the SIDH portal"
                      onClick={(e) => { e.stopPropagation(); markSidhRegistered(r); }}>✓ Reg.</button>
                    {r.sidh_status !== "Registration Failed" && (
                      <button className="text-[11px] font-medium text-red-600 hover:underline" title="The portal refused this registration — record why"
                        onClick={(e) => { e.stopPropagation(); markSidhFailed(r); }}>✗ Failed</button>
                    )}
                  </>
                )}
              </span>
            ),
          },
          ...(role === "Enrollment" ? [] : [
            { key: "source", label: "Source", mobile: false, filterable: true, filterText: (r: any) => r.source ?? "Entered in ERP", render: (r: any) => <SourceCell source={r.source} /> },
          ]),
          {
            // QA-021 (-68): Dropout is reachable from ANY stage now, not only a batch roster.
            key: "_drop", label: "", render: (r: any) => (
              <span onClick={(e) => e.stopPropagation()}>
                {r.lifecycle_status === "Dropped"
                  ? <Btn small kind="ghost" onClick={async () => {
                      if (!window.confirm(`Reinstate ${r.name}? They go back to Unassigned in the Fresh pool.`)) return;
                      try { await api(`/api/candidates/${r._id}/drop`, { method: "POST", json: { undo: true } }); load(); }
                      catch (e: any) { setError(e.message); }
                    }}>Reinstate</Btn>
                  : <Btn small kind="ghost" onClick={() => { setDropT(r); setDropForm({}); }}>Drop…</Btn>}
              </span>
            ),
          },
        ]} empty="No candidates — add or import." />

      <Drawer error={error} open={!!dropT} onClose={() => setDropT(null)} title={dropT ? `Drop ${dropT.name}?` : ""}>
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Currently at <b>{dropT ? (isFresh(dropT) ? freshJourneyOf(dropT) : journeyOf(dropT)) : ""}</b> — the drop
            is recorded at this stage, with your reason. {dropT?.active_batch ? "They are on a batch roster; the roster drop happens too (results already recorded stay)." : ""}
          </p>
          <Field label="Reason" required>
            {dropReasons.length > 0 && (
              <select className={inputCls} value={dropForm.pick ?? ""} onChange={(e) => setDropForm({ ...dropForm, pick: e.target.value, reason: e.target.value === "__other__" ? "" : e.target.value })}>
                <option value="">Select…</option>
                {dropReasons.map((d: any) => <option key={d._id} value={d.name}>{d.name}</option>)}
                <option value="__other__">Other…</option>
              </select>
            )}
            {(dropReasons.length === 0 || dropForm.pick === "__other__") && (
              <input className={inputCls + (dropReasons.length ? " mt-1.5" : "")} placeholder="Why did they leave?"
                value={dropForm.pick === "__other__" || dropReasons.length === 0 ? (dropForm.reason ?? "") : ""}
                onChange={(e) => setDropForm({ ...dropForm, reason: e.target.value })} />
            )}
          </Field>
          <Field label="Date (blank = today)"><input type="date" className={inputCls} value={dropForm.date ?? ""} onChange={(e) => setDropForm({ ...dropForm, date: e.target.value })} /></Field>
          <div className="flex gap-2">
            <Btn kind="danger" disabled={!(dropForm.reason ?? "").trim()} onClick={async () => {
              try {
                await api(`/api/candidates/${dropT._id}/drop`, { method: "POST", json: { reason: dropForm.reason.trim(), date: dropForm.date || undefined } });
                setDropT(null); load();
              } catch (e: any) { setError(e.message); }
            }}>Confirm Drop</Btn>
            <Btn kind="ghost" onClick={() => setDropT(null)}>Cancel</Btn>
          </div>
        </div>
      </Drawer>

      <Drawer error={error} open={drawer === "add" || drawer === "edit"} onClose={() => { setDrawer(""); setEditId(""); }}
        title={drawer === "edit" ? `Edit Candidate — ${form.name || ""}` : "Add Candidate"}>
        <div className="space-y-3">
          <Field label="Name" required><input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            {/* QA-141: same checks the API refuses with — shown while typing. */}
            <Field label="Phone" required>
              <input className={inputCls} value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} />
              {form.phone && phoneError(form.phone) && <p className="mt-1 text-xs text-red-600">{phoneError(form.phone)}</p>}
            </Field>
            <Field label="Alt phone">
              <input className={inputCls} value={form.alt_phone ?? ""} onChange={(e) => set("alt_phone", e.target.value)} />
              {form.alt_phone && phoneError(form.alt_phone, { optional: true }) && <p className="mt-1 text-xs text-red-600">{phoneError(form.alt_phone, { optional: true })}</p>}
            </Field>
          </div>
          {/* 15/08 (Umesh): mandatory only on SELF-registration; staff may fill or fix it here. */}
          <Field label="Email">
            <input className={inputCls} type="email" value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} />
            {form.email && emailError(form.email, { optional: true }) && <p className="mt-1 text-xs text-red-600">{emailError(form.email, { optional: true })}</p>}
          </Field>
          {dupes.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <div className="font-medium">Possible duplicate — check before saving</div>
              <ul className="mt-1 space-y-0.5 text-xs">
                {dupes.map((d: any) => <li key={d.candidate_id}>• {d.message}</li>)}
              </ul>
              <div className="mt-1 text-xs text-amber-700">You can still save — one phone number often serves a whole family.</div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Gender">
              <select className={inputCls} value={form.gender ?? ""} onChange={(e) => set("gender", e.target.value)}>
                <option value="">—</option><option>Female</option><option>Male</option><option>Other</option>
              </select>
            </Field>
            <Field label="Date of birth"><input type="date" className={inputCls} value={form.dob ?? ""} onChange={(e) => set("dob", e.target.value)} /></Field>
          </div>
          {/* -124 (M4-04, Manish 17/08 [01:50] "ye location nahi hogi, user ka koi bhi location ho
              sakta hai"): a walk-in belongs to no centre yet. The field stays — most entries DO know
              their centre and picking it here saves a step — but it is no longer required, and the
              blank option says what blank means rather than looking like an unfinished form. */}
          <Field label="Location">
            <select className={inputCls} value={form.location ?? ""} onChange={(e) => set("location", e.target.value)}>
              <option value="">Not tied to a centre yet (walk-in)</option>
              {offerable(locations, form.location).map((l) => <option key={l._id} value={l._id} title={l.name}>{l.name}</option>)}
            </select>
            {!form.location && (
              <span className="mt-0.5 block text-[11px] text-gray-500">They get their centre when they are enrolled on a batch. Until then only Admin and Operations can see them.</span>
            )}
          </Field>
          <Field label="Program" required>
            <select className={inputCls} value={form.program ?? ""} onChange={(e) => set("program", e.target.value)}>
              <option value="">Select…</option>
              {offerable(programs, form.program).map((p) => { const t = `${p.name}${p.scheme ? ` (${p.scheme})` : p.code ? ` (${p.code})` : ""}`; return <option key={p._id} value={p._id} title={t}>{t}</option>; })}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Education">
              <select className={inputCls} value={form.education ?? ""} onChange={(e) => set("education", e.target.value)}>
                <option value="">—</option>
                {["Below 10th", "10th Pass", "12th Pass", "Graduate", "Post Graduate"].map((l) => <option key={l}>{l}</option>)}
              </select>
            </Field>
            <Field label="Last govt training (if any)"><input type="date" className={inputCls} value={form.last_training_date ?? ""} onChange={(e) => set("last_training_date", e.target.value)} /></Field>
          </div>
          {/* 2026-08-12: the portal attendance export keys on this ID — filling it in makes every
              future import match this candidate automatically instead of falling back to the name. */}
          <Field label="Portal Candidate ID (from the government portal, e.g. CAN_40918461)">
            <input className={inputCls} placeholder="CAN_…" value={form.sidh_candidate_id ?? ""} onChange={(e) => set("sidh_candidate_id", e.target.value)} />
          </Field>
          {/* 2026-08-11: "कौन से program में interested… कौन-कौन सी location में" — for fast shortlisting later.
              2026-08-13 (Umesh): stacked full-width — side-by-side clipped "Govt. ITI Charthwal, Muzaff…"
              and selection was guesswork; title = hover reveal for anything that still clips. */}
          <Field label="Interested programs (Ctrl-click for many)">
            <select multiple className={inputCls + " h-28"} value={form.interested_programs ?? []}
              onChange={(e) => set("interested_programs", Array.from(e.target.selectedOptions).map((o) => o.value))}>
              {offerable(programs, form.interested_programs).map((p) => { const t = `${p.name}${p.scheme ? ` (${p.scheme})` : p.code ? ` (${p.code})` : ""}`; return <option key={p._id} value={p._id} title={t}>{t}</option>; })}
            </select>
          </Field>
          <Field label="Interested locations (Ctrl-click for many)">
            <select multiple className={inputCls + " h-28"} value={form.interested_locations ?? []}
              onChange={(e) => set("interested_locations", Array.from(e.target.selectedOptions).map((o) => o.value))}>
              {offerable(locations, form.interested_locations).map((l) => <option key={l._id} value={l._id} title={l.name}>{l.name}</option>)}
            </select>
          </Field>
          {/* -116 (M4-06, Manish 17/08 [02:21] "इसको अगर ड्रॉप डाउन कर सकते हो, सोर्स को — तो ड्रॉप
              डाउन कर दो। रेफरल और कैंपेन"): a list, not a hard enum. Umesh's own issue sheet flags the
              wording as unreliable — three transcripts give "referral", "franchiser" and "mobiliser" —
              so a closed enum would freeze a guess into the data model. A datalist offers exactly what
              he named, still accepts anything typed, and loses nothing already stored. It becomes a
              closed list the day Manish confirms the wording. */}
          <Field label="Source (mobiliser / campaign)">
            <input className={inputCls} list="candidate-source-options" value={form.source ?? ""} onChange={(e) => set("source", e.target.value)} placeholder="Pick one, or type another" />
            <datalist id="candidate-source-options">
              {["Mobiliser", "Campaign", "Referral", "Franchisee", "Walk-in", "Government portal"].map((o) => <option key={o} value={o} />)}
            </datalist>
          </Field>
          {/* -116 (SS-01, Shivshakti 17/08 13:00): he filled THIS form, then opened the government's
              "Skilling Program Application" beside it to show what we do not ask for. He named eight
              out loud — religion, category, state, district, sub-district, father's name, mother's
              name, marital status — and three more are visible on that portal screen which he never
              said: salutation, urban/rural, and the differently-abled flag. Our candidates have to be
              registered there anyway, so this is data somebody types either way; asking here means
              typing it once instead of chasing it at registration time.
              -126 (S18-01, Shivshakti 18/08 15:56): he was explicit that the FIELDS are right and the
              placement was not — "ye jo aapne alag se banaya hua hai… options sahi hain, lekin isko
              yahan add kar dijiye". Walled off in a collapsed block it took two passes to fill a
              candidate, so the block is inline now: same fields, same grid, no lid.
              -126 (S18-03): "ye dono option hata do" — Address type and Differently abled are GONE.
              Worth remembering why they existed: they were never in his spoken list of eight. He named
              eight; I read three more off the portal screenshot and added them. His spoken request
              stands, my inference did not. Salutation is not in the removal and stays.
              Every field optional — no existing record becomes invalid and no import breaks. The
              portal's "Education & Employment" section was never expanded on screen, so its fields
              stay unknown rather than guessed at. */}
          <div className="text-sm font-medium text-gray-700">Government portal details (Skill India registration)</div>
          <p className="-mt-2 text-xs text-gray-500">Everything the Skilling Program Application asks for. All optional here — filling it now saves re-collecting it at registration.</p>
          <div className="grid gap-3 md:grid-cols-3">
              <Field label="Salutation">
                <input className={inputCls} list="cand-salutation" value={form.salutation ?? ""} onChange={(e) => set("salutation", e.target.value)} />
                <datalist id="cand-salutation">{["Mr.", "Mrs.", "Ms.", "Dr."].map((o) => <option key={o} value={o} />)}</datalist>
              </Field>
              <Field label="Father&apos;s name"><input className={inputCls} value={form.father_name ?? ""} onChange={(e) => set("father_name", e.target.value)} /></Field>
              <Field label="Mother&apos;s name"><input className={inputCls} value={form.mother_name ?? ""} onChange={(e) => set("mother_name", e.target.value)} /></Field>
              <Field label="Marital status">
                <input className={inputCls} list="cand-marital" value={form.marital_status ?? ""} onChange={(e) => set("marital_status", e.target.value)} />
                <datalist id="cand-marital">{["Single", "Married", "Widowed", "Divorced"].map((o) => <option key={o} value={o} />)}</datalist>
              </Field>
              <Field label="Religion">
                <input className={inputCls} list="cand-religion" value={form.religion ?? ""} onChange={(e) => set("religion", e.target.value)} />
                <datalist id="cand-religion">{["Hindu", "Muslim", "Christian", "Sikh", "Buddhist", "Jain", "Parsi", "Other"].map((o) => <option key={o} value={o} />)}</datalist>
              </Field>
              <Field label="Category">
                <input className={inputCls} list="cand-category" value={form.social_category ?? ""} onChange={(e) => set("social_category", e.target.value)} />
                <datalist id="cand-category">{["General", "OBC", "SC", "ST", "EWS"].map((o) => <option key={o} value={o} />)}</datalist>
              </Field>
              <Field label="State"><input className={inputCls} value={form.state ?? ""} onChange={(e) => set("state", e.target.value)} /></Field>
              <Field label="District"><input className={inputCls} value={form.district ?? ""} onChange={(e) => set("district", e.target.value)} /></Field>
            <Field label="Sub-district"><input className={inputCls} value={form.sub_district ?? ""} onChange={(e) => set("sub_district", e.target.value)} /></Field>
          </div>
          {/* 15/08 (Umesh): no candidate fee in this programme — the fee inputs left the
              drawer. Schema + Rule 54 toggle stay dormant for a future paid scheme. */}
          {/* QA-105 (15/08): the candidate document store — multi-pick, type guessed from
              each filename (trainer pattern), delete from day one. Edit mode only: the
              candidate must exist before files can hang on them. */}
          {drawer === "edit" && editId && <CandidateDocs candidateId={editId} setError={setError} />}
          {/* 15/08 (Umesh): columns the import didn't recognise, accepted by the operator —
              shown as facts, edited only by re-import. */}
          {/* -115 (QA-146, measured on live 18/08): the 45 CHI-ITI rows are correct again — name,
              phone and email all read right — but 45 of them still carry the junk keys the bad header
              row produced, and "__EMPTY_4" is SheetJS's name for a column whose header cell was blank,
              not a fact about the student. It was being shown to staff as an "extra column" with a
              value beside it. A key that is only a spreadsheet artefact is now named as one and the
              value still shown, so nothing is hidden and nothing is dressed up as data. */}
          {form.custom_fields && Object.keys(form.custom_fields).length > 0 && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
              <div className="mb-1 text-xs font-medium text-gray-500">Extra columns (from import)</div>
              {Object.entries(form.custom_fields).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <span className="text-gray-500">
                    {/^__EMPTY/.test(k)
                      ? <span title="The spreadsheet column this came from had no header, so the importer had no name for it. It is kept as-is; correct it by re-importing with a fixed header row.">unnamed column {k.replace(/^__EMPTY_?/, "") || "1"}</span>
                      : k}
                  </span>
                  <span className="text-right">{String(v)}</span>
                </div>
              ))}
            </div>
          )}
          {/* Edit mode: location/program may legitimately be blank on a sheet-imported row — the
              save must not be held hostage to fields the user is not correcting. */}
          <Btn onClick={saveCandidate} disabled={savingC || (drawer === "add" ? (!form.name || !form.phone || !form.program) : (!form.name || !form.phone))
            || !!phoneError(form.phone) || !!phoneError(form.alt_phone, { optional: true }) || !!emailError(form.email, { optional: true })}>
            {drawer === "edit" ? "Save changes" : "Add"}
          </Btn>
          {/* -84 (QA-146 part 2): junk rows (a sheet's own header/description lines) need a way
              out — Admin only; the API refuses anyone with batch history (drop those instead). */}
          {drawer === "edit" && editId && role === "Admin" && (
            <Btn kind="ghost" onClick={async () => {
              if (!window.confirm(`Delete "${form.name}" (${form.phone}) permanently? Their documents go too. A candidate with batch history should be dropped from the batch, not deleted.`)) return;
              try { await api(`/api/candidates/${editId}`, { method: "DELETE" }); setDrawer(""); setEditId(""); load(); }
              catch (e: any) { setError(e.message); }
            }}>Delete</Btn>
          )}
        </div>
      </Drawer>

      <Drawer error={error} open={drawer === "assign"} onClose={() => setDrawer("")} title={`Assign ${selected.size} candidates to batch`}>
        <div className="space-y-2">
          {batches.map((b) => (
            <button key={b._id} onClick={() => bulkAssign(b._id)} className="flex w-full items-center justify-between rounded-lg border px-4 py-3 text-left text-sm hover:bg-blue-50">
              <span><span className="font-medium">{b.code}</span> · {b.location?.name} · {b.program?.name}</span>
              <span className="text-xs text-gray-500">{b.roster_count}/{b.target_size} · <Chip value={b.status} /></span>
            </button>
          ))}
          {batches.length === 0 && <p className="text-sm text-gray-400">No open batches.</p>}
        </div>
      </Drawer>

      <Drawer error={error} open={drawer === "import"} onClose={() => setDrawer("")} title="Import candidates from Excel" wide>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Location" required>
              <select className={inputCls} value={importState.location ?? ""} onChange={(e) => setImportState({ ...importState, location: e.target.value })}>
                <option value="">Select…</option>
                {offerable(locations, importState.location).map((l) => <option key={l._id} value={l._id} title={l.name}>{l.name}</option>)}
              </select>
            </Field>
            <Field label="Program" required>
              <select className={inputCls} value={importState.program ?? ""} onChange={(e) => setImportState({ ...importState, program: e.target.value })}>
                <option value="">Select…</option>
                {offerable(programs).map((p) => { const t = `${p.name}${p.scheme ? ` (${p.scheme})` : p.code ? ` (${p.code})` : ""}`; return <option key={p._id} value={p._id} title={t}>{t}</option>; })}
              </select>
            </Field>
          </div>
          <a href={`${BASE_PATH}/api/candidates/template`} className="inline-block text-sm font-medium text-blue-700 hover:underline">⬇ Download sample sheet format</a>
          {importState.location && importState.program && !importState.columns && (
            <Field label="Excel file (.xlsx)" required>
              <input type="file" accept=".xlsx,.xls,.csv" className={inputCls} onChange={(e) => e.target.files?.[0] && importUpload(e.target.files[0])} />
            </Field>
          )}
          {importState.columns && (
            <>
              <p className="text-sm text-gray-600">{importState.total} rows found. Map columns → fields (name and phone required):</p>
              {importState.remembered && (
                <p className="text-xs text-blue-700">
                  Mapping pre-filled from your last import of this sheet shape — check it still fits.{" "}
                  <button className="underline" onClick={clearMapMemory}>Clear</button>
                </p>
              )}
              {/* QA-146: the CHI-ITI sheet had a blank header cell — SheetJS names such a column
                  __EMPTY_n and the real phone number lived there while the visible labels shifted
                  one over. Say it loudly instead of listing "__EMPTY_4" as if it were a name. */}
              {importState.columns.some((c: string) => /^__EMPTY/.test(c)) && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <b>This sheet&apos;s header row has blank cells.</b> The columns marked &quot;unnamed&quot; below had no
                  header, so the labels may not line up with the data — check the preview values, not the names.
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                {importState.columns.map((c: string) => (
                  <Field key={c} label={/^__EMPTY/.test(c) ? `(unnamed column — header was blank)` : c}>
                    <select className={inputCls} value={importState.mapping?.[c] ?? ""} onChange={(e) => setImportState({ ...importState, mapping: { ...importState.mapping, [c]: e.target.value } })}>
                      <option value="">Ignore</option>
                      {/* F-B4: the eligibility fields (dob · education · last_training_date) are mappable now. */}
                      {["name", "phone", "alt_phone", "email", "gender", "source", "id_reference", "dob", "education", "last_training_date", "interested_programs", "interested_locations"].map((f) => <option key={f}>{f}</option>)}
                    </select>
                  </Field>
                ))}
              </div>
              {(() => {
                // QA-146: when MOST phones are invalid the mapping itself is almost certainly wrong
                // (CHI-ITI: 45/45 invalid, imported anyway). The report stays a report — but the
                // button waits for an explicit, informed confirmation.
                const badMapping = (importState.preview?.phone_invalid_count ?? 0) >= Math.max(1, Math.ceil((importState.preview?.valid ?? 0) / 2));
                return (
                  <>
                    {badMapping && (
                      <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
                        <b>{importState.preview.phone_invalid_count} of {importState.preview.valid} phone numbers are invalid — the column mapping is probably wrong.</b>{" "}
                        Check which column really holds the phone number (a blank header shifts everything), fix the mapping above and preview again.
                        <label className="mt-1.5 flex items-center gap-2 font-normal">
                          <input type="checkbox" checked={!!importState.force_bad}
                            onChange={(e) => setImportState({ ...importState, force_bad: e.target.checked })} />
                          I have checked the mapping — import anyway
                        </label>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <Btn kind="ghost" onClick={() => importConfirm(true)}>Preview</Btn>
                      {importState.preview && <Btn disabled={badMapping && !importState.force_bad} onClick={() => importConfirm(false)}>Import {importState.preview.valid} candidates</Btn>}
                    </div>
                  </>
                );
              })()}
              {importState.preview && (
                <p className="text-sm text-gray-600">{importState.preview.valid} valid, {importState.preview.skipped} skipped (missing name/phone{importState.preview.template_rows_skipped_count ? " or template/description rows" : ""}).</p>
              )}
              {importState.preview?.template_rows_skipped_count > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <b>{importState.preview.template_rows_skipped_count} template/description row{importState.preview.template_rows_skipped_count === 1 ? "" : "s"} skipped</b> — the sheet's own header/instruction lines, not candidates: {importState.preview.template_rows_skipped.join("; ")}
                </div>
              )}
              {/* QA-110: an operator who forgets to map a column must be able to notice. */}
              {importState.preview?.ignored_columns?.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  {importState.preview.ignored_columns.length} column{importState.preview.ignored_columns.length > 1 ? "s" : ""} will be IGNORED — their values are not imported: {importState.preview.ignored_columns.join(" · ")}
                </div>
              )}
              {/* 15/08 (Umesh): naye columns restrict nahi hote — accept (default) → har row ka
                  data un columns ke naam se store, candidate par "Extra columns" me dikhta hai. */}
              {importState.preview?.unknown_columns?.length > 0 && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                  <div className="font-medium">New columns the ERP doesn&apos;t know: {importState.preview.unknown_columns.join(" · ")}</div>
                  <label className="mt-1 flex items-center gap-2">
                    <input type="checkbox" checked={importState.accept_unknown !== false}
                      onChange={(e) => setImportState({ ...importState, accept_unknown: e.target.checked })} />
                    Accept as new columns — their values are stored and shown on each candidate
                  </label>
                  <div className="mt-0.5 text-blue-700">Or map them to an existing field above; unticked = ignored.</div>
                </div>
              )}
              {importState.preview?.interest_unmatched?.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Interest names not recognised (must match a centre / job-role name exactly, comma-separated): {importState.preview.interest_unmatched.join(" · ")}
                </div>
              )}
              {importState.preview?.education_unmatched?.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  Education values not recognised (left blank, never guessed): {importState.preview.education_unmatched.join(" · ")} —
                  valid values are Below 10th · 10th Pass · 12th Pass · Graduate · Post Graduate.
                </div>
              )}
              {importState.preview?.duplicate_count > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  <div className="font-medium">{importState.preview.duplicate_count} possible duplicate{importState.preview.duplicate_count > 1 ? "s" : ""} — review before importing</div>
                  <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto text-xs">
                    {importState.preview.duplicates.map((d: string, i: number) => <li key={i}>• {d}</li>)}
                  </ul>
                  <div className="mt-1 text-xs text-amber-700">Importing anyway is allowed — these are flagged, not blocked.</div>
                </div>
              )}
            </>
          )}
        </div>
      </Drawer>
    </div>
  );
}
