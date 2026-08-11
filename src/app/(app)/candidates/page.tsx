"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/client";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, NameCell, inputCls } from "@/components/ui";
import { useLocationCtx } from "@/components/shell";
import { BASE_PATH } from "@/lib/base-path";

export default function CandidatesPage() {
  return <Suspense><CandidatesInner /></Suspense>;
}

function CandidatesInner() {
  const sp = useSearchParams();
  const [items, setItems] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [programs, setPrograms] = useState<any[]>([]);
  const [batches, setBatches] = useState<any[]>([]);
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [ctxLoc] = useLocationCtx();
  const [fLoc, setFLoc] = useState("");
  useEffect(() => { setFLoc(ctxLoc); }, [ctxLoc]);
  const [fStatus, setFStatus] = useState(sp.get("lifecycle_status") ?? "");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drawer, setDrawer] = useState<"" | "add" | "import" | "assign">("");
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
    const params = new URLSearchParams({ q, limit: "200" });
    if (fLoc) params.set("location", fLoc);
    if (fStatus) params.set("lifecycle_status", fStatus);
    return Promise.all([
      api(`/api/candidates?${params}`).then((d) => setItems(d.items)),
      api("/api/locations?limit=200").then((d) => setLocations(d.items)),
      api("/api/programs?limit=100").then((d) => setPrograms(d.items)),
      api("/api/batches").then((d) => setBatches(d.items.filter((b: any) => ["Planning", "Ready", "Active"].includes(b.status)))),
    ]).catch((e) => setError(e.message));
  };
  useEffect(() => { load(); }, [q, fLoc, fStatus]);

  function toggle(id: string) {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id); else s.add(id);
    setSelected(s);
  }

  async function saveCandidate() {
    try { await api("/api/candidates", { method: "POST", json: form }); setDrawer(""); setForm({}); load(); }
    catch (e: any) { setError(e.message); }
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

  // 2026-08-11: SIDH registration link per candidate — WhatsApp deep link + status flip.
  async function sendSidhLink(c: any) {
    try {
      const d = await api("/api/defaults");
      const url = d.item?.sidh_url || "https://www.skillindiadigital.gov.in/";
      const msg = encodeURIComponent(`Namaste ${c.name}! Please register for your training on the Skill India portal: ${url}`);
      const phone = String(c.phone ?? "").replace(/\D/g, "").slice(-10);
      window.open(`https://wa.me/91${phone}?text=${msg}`, "_blank");
      await api(`/api/candidates/${c._id}`, { method: "PATCH", json: { sidh_status: "Link Sent", sidh_link_sent_at: new Date().toISOString() } });
      load();
    } catch (e: any) { setError(e.message); }
  }

  async function markSidhRegistered(c: any) {
    try {
      await api(`/api/candidates/${c._id}`, { method: "PATCH", json: { sidh_status: "Registered", sidh_registered_on: new Date().toISOString() } });
      load();
    } catch (e: any) { setError(e.message); }
  }

  // 2026-08-11: per-location public self-registration link.
  async function shareRegistrationLink() {
    if (!fLoc) { setError("Pick a location filter first — the link is per location."); return; }
    try {
      const existing = await api(`/api/public-tokens?purpose=register&location=${fLoc}`);
      const active = existing.items?.find((t: any) => t.active);
      const t = active ?? (await api("/api/public-tokens", { method: "POST", json: { purpose: "register", location: fLoc } })).item;
      const link = `${window.location.origin}${BASE_PATH}/p/register/${t.token}`;
      await navigator.clipboard.writeText(link);
      setError(""); alert(`Self-registration link copied:\n${link}\n\nShare it on WhatsApp — candidates fill their own details.`);
    } catch (e: any) { setError(e.message); }
  }

  // Excel import steps
  async function importUpload(file: File) {
    const fd = new FormData();
    fd.append("file", file); fd.append("location", importState.location); fd.append("program", importState.program);
    try {
      const res = await api("/api/candidates/import", { method: "POST", body: fd });
      setImportState((s: any) => ({ ...s, file, columns: res.columns, mapping: {}, total: res.total }));
    } catch (e: any) { setError(e.message); }
  }
  async function importConfirm(preview: boolean) {
    const fd = new FormData();
    fd.append("file", importState.file); fd.append("location", importState.location); fd.append("program", importState.program);
    fd.append("mapping", JSON.stringify(importState.mapping));
    if (!preview) fd.append("confirm", "1");
    try {
      const res = await api("/api/candidates/import", { method: "POST", body: fd });
      if (preview) setImportState((s: any) => ({ ...s, preview: res }));
      else { setDrawer(""); setImportState({}); load(); }
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Candidates <span className="text-sm font-normal text-gray-400">(pool)</span></h1>
        <div className="flex flex-wrap gap-2">
          <input className={inputCls + " max-w-44"} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className={inputCls + " max-w-40"} value={fLoc} onChange={(e) => setFLoc(e.target.value)}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}
          </select>
          <select className={inputCls + " max-w-36"} value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
            <option value="">All statuses</option>
            {["Unassigned", "Assigned", "Enrolled", "Dropped", "Completed"].map((s) => <option key={s}>{s}</option>)}
          </select>
          <Btn kind="ghost" onClick={() => { setImportState({}); setDrawer("import"); }}>Import Excel</Btn>
          <Btn kind="ghost" onClick={shareRegistrationLink}>Self-reg link</Btn>
          <a href={`${BASE_PATH}/api/candidates/export-sidh${fLoc ? `?location=${fLoc}` : ""}`}
            className="flex h-9 items-center rounded-lg border border-gray-200 bg-white px-3 text-sm font-medium text-gray-700 hover:border-blue-300 hover:text-blue-700"
            title="Excel in the SIDH CRM's format — upload it in the assisted-registration console">
            Export for SIDH CRM
          </a>
          <Btn onClick={() => setDrawer("add")}>Add Candidate</Btn>
        </div>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      {selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Btn small onClick={() => setDrawer("assign")}>Assign to Batch</Btn>
          <Btn small kind="ghost" onClick={() => setSelected(new Set())}>Clear</Btn>
        </div>
      )}
      <DataTable rows={items}
        cardTitle={(r: any) => r.name}
        columns={[
          { key: "_sel", label: "", mobile: false, render: (r: any) => <input type="checkbox" checked={selected.has(r._id)} onChange={() => toggle(r._id)} onClick={(e) => e.stopPropagation()} disabled={r.lifecycle_status !== "Unassigned" && r.lifecycle_status !== "Dropped"} /> },
          { key: "name", label: "Name", render: (r: any) => <NameCell name={r.name} sub={r.gender} /> },
          { key: "phone", label: "Phone" },
          { key: "location", label: "Location", render: (r: any) => r.location?.name },
          { key: "program", label: "Program", render: (r: any) => r.program?.name },
          { key: "lifecycle_status", label: "Status", render: (r: any) => <Chip value={r.lifecycle_status} /> },
          {
            key: "eligibility", label: "Eligible", render: (r: any) => r.eligibility ? (
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
                {r.sidh_status !== "Registered" && (
                  <>
                    <button className="text-[11px] font-medium text-blue-700 hover:underline" title="Send registration link on WhatsApp"
                      onClick={(e) => { e.stopPropagation(); sendSidhLink(r); }}>Send link</button>
                    <button className="text-[11px] font-medium text-green-700 hover:underline" title="Mark as registered on the SIDH portal"
                      onClick={(e) => { e.stopPropagation(); markSidhRegistered(r); }}>✓ Reg.</button>
                  </>
                )}
              </span>
            ),
          },
          { key: "source", label: "Source", mobile: false },
        ]} empty="No candidates — add or import." />

      <Drawer open={drawer === "add"} onClose={() => setDrawer("")} title="Add Candidate">
        <div className="space-y-3">
          <Field label="Name" required><input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone" required><input className={inputCls} value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} /></Field>
            <Field label="Alt phone"><input className={inputCls} value={form.alt_phone ?? ""} onChange={(e) => set("alt_phone", e.target.value)} /></Field>
          </div>
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
          <Field label="Location" required>
            <select className={inputCls} value={form.location ?? ""} onChange={(e) => set("location", e.target.value)}>
              <option value="">Select…</option>
              {locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}
            </select>
          </Field>
          <Field label="Program" required>
            <select className={inputCls} value={form.program ?? ""} onChange={(e) => set("program", e.target.value)}>
              <option value="">Select…</option>
              {programs.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
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
          {/* 2026-08-11: "कौन से program में interested… कौन-कौन सी location में" — for fast shortlisting later */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Interested programs (Ctrl-click for many)">
              <select multiple className={inputCls + " h-20"} value={form.interested_programs ?? []}
                onChange={(e) => set("interested_programs", Array.from(e.target.selectedOptions).map((o) => o.value))}>
                {programs.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
              </select>
            </Field>
            <Field label="Interested locations">
              <select multiple className={inputCls + " h-20"} value={form.interested_locations ?? []}
                onChange={(e) => set("interested_locations", Array.from(e.target.selectedOptions).map((o) => o.value))}>
                {locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Source (mobiliser / campaign)"><input className={inputCls} value={form.source ?? ""} onChange={(e) => set("source", e.target.value)} /></Field>
          <Btn onClick={saveCandidate} disabled={!form.name || !form.phone || !form.location || !form.program}>Add</Btn>
        </div>
      </Drawer>

      <Drawer open={drawer === "assign"} onClose={() => setDrawer("")} title={`Assign ${selected.size} candidates to batch`}>
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

      <Drawer open={drawer === "import"} onClose={() => setDrawer("")} title="Import candidates from Excel" wide>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Location" required>
              <select className={inputCls} value={importState.location ?? ""} onChange={(e) => setImportState({ ...importState, location: e.target.value })}>
                <option value="">Select…</option>
                {locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}
              </select>
            </Field>
            <Field label="Program" required>
              <select className={inputCls} value={importState.program ?? ""} onChange={(e) => setImportState({ ...importState, program: e.target.value })}>
                <option value="">Select…</option>
                {programs.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
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
              <div className="grid grid-cols-2 gap-2">
                {importState.columns.map((c: string) => (
                  <Field key={c} label={c}>
                    <select className={inputCls} value={importState.mapping?.[c] ?? ""} onChange={(e) => setImportState({ ...importState, mapping: { ...importState.mapping, [c]: e.target.value } })}>
                      <option value="">Ignore</option>
                      {["name", "phone", "alt_phone", "gender", "source"].map((f) => <option key={f}>{f}</option>)}
                    </select>
                  </Field>
                ))}
              </div>
              <div className="flex gap-2">
                <Btn kind="ghost" onClick={() => importConfirm(true)}>Preview</Btn>
                {importState.preview && <Btn onClick={() => importConfirm(false)}>Import {importState.preview.valid} candidates</Btn>}
              </div>
              {importState.preview && (
                <p className="text-sm text-gray-600">{importState.preview.valid} valid, {importState.preview.skipped} skipped (missing name/phone).</p>
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
