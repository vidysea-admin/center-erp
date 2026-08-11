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
  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));

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
      if (failed.length) setError(`${res.assigned} assigned; ${failed.length} failed: ${failed[0].error}`);
      setSelected(new Set()); setDrawer(""); load();
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
          { key: "source", label: "Source" },
        ]} empty="No candidates — add or import." />

      <Drawer open={drawer === "add"} onClose={() => setDrawer("")} title="Add Candidate">
        <div className="space-y-3">
          <Field label="Name" required><input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone" required><input className={inputCls} value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} /></Field>
            <Field label="Alt phone"><input className={inputCls} value={form.alt_phone ?? ""} onChange={(e) => set("alt_phone", e.target.value)} /></Field>
          </div>
          <Field label="Gender">
            <select className={inputCls} value={form.gender ?? ""} onChange={(e) => set("gender", e.target.value)}>
              <option value="">—</option><option>Female</option><option>Male</option><option>Other</option>
            </select>
          </Field>
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
            </>
          )}
        </div>
      </Drawer>
    </div>
  );
}
