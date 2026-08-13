"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/client";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, FilterPills, SourceCell, inputCls } from "@/components/ui";

export default function LocationsPage() {
  return <Suspense><LocationsInner /></Suspense>;
}

function LocationsInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const [items, setItems] = useState<any[]>([]);
  // 2026-08-13: the Approved-Locations KPI deep-links here — the pill presets from the URL so
  // the number clicked and the rows shown are the same population.
  const [tag, setTag] = useState(sp.get("approval_status") ?? "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [form, setForm] = useState<any>({ approval_status: "Pending" });
  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));

  // Text search moved into DataTable (all-column, client-side over the full fetch).
  const load = () => api(`/api/locations?limit=2000`).then((d) => setItems(d.items)).catch((e) => setError(e.message)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    try {
      await api("/api/locations", { method: "POST", json: form });
      setDrawer(false); setForm({ approval_status: "Pending" }); load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Locations</h1>
        <div className="flex gap-2">
          <Btn onClick={() => setDrawer(true)}>New Location</Btn>
        </div>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      <FilterPills active={tag} onChange={(v) => setTag(v === tag ? "" : v)}
        options={[
          { value: "", label: "All", count: items.length },
          ...["Approved", "Pending", "Rejected"].map((s) => ({ value: s, label: s, count: items.filter((l) => l.approval_status === s).length })),
        ]} />
      <DataTable
        rows={tag ? items.filter((l) => l.approval_status === tag) : items}
        loading={loading}
        onRowClick={(r) => router.push(`/locations/${r._id}`)}
        cardTitle={(r: any) => <>{r.name} <span className="text-xs text-gray-400">({r.code})</span></>}
        defaultSort={{ key: "name", dir: "asc" }}
        columns={[
          { key: "code", label: "Code", mobile: false, sortable: true, sortValue: (r: any) => r.code },
          { key: "name", label: "Name", mobile: false, sortable: true, sortValue: (r: any) => r.name, minWidth: 220 },
          { key: "city", label: "City", mobile: false, sortable: true, sortValue: (r: any) => r.city },
          {
            // 2026-08-13 (Manish): "Ongoing scheme bhi saath mein dikhana must hai" — the scheme
            // travels with every job role, and the funnel filters by it.
            key: "schemes", label: "Ongoing scheme", filterable: true,
            filterText: (r: any) => (r.schemes ?? []).join(" · "),
            render: (r: any) => (r.schemes ?? []).length
              ? <span className="flex flex-wrap gap-1">{r.schemes.map((s: string) => <Chip key={s} value={s} />)}</span>
              : <span className="text-gray-400">—</span>,
          },
          {
            key: "job_roles", label: "Job roles (approved)", minWidth: 240,
            filterText: (r: any) => (r.job_roles ?? []).map((j: any) => `${j.program} ${j.tc_status ?? ""}`).join(" · "),
            render: (r: any) => (r.job_roles ?? []).length ? (
              <span className="text-xs">
                <span className="font-medium text-gray-900">{r.approved_job_roles}</span> of {r.job_roles.length} approved
                <span className="block text-gray-400">{r.job_roles.map((j: any) => j.code ?? j.program).join(" · ")}</span>
              </span>
            ) : <span className="text-gray-400">no targets</span>,
          },
          { key: "approval_status", label: "Approval", sortable: true, sortValue: (r: any) => r.approval_status, render: (r: any) => <Chip value={r.approval_status} /> },
          { key: "operational_status", label: "Operational", sortable: true, sortValue: (r: any) => r.operational_status, render: (r: any) => <Chip value={r.operational_status} /> },
          { key: "spoc_name", label: "SPOC" },
          // Centres come from the workbook's Location_Master tab; external_id is that row's TC ID.
          { key: "source", label: "Source", mobile: false, filterText: (r: any) => r.external_id ? "AVPL Location_Master" : "Entered in ERP", render: (r: any) => <SourceCell source={r.external_id ? "AVPL Location_Master" : ""} /> },
        ]}
        empty="No locations yet — create the first one."
      />
      <Drawer open={drawer} onClose={() => setDrawer(false)} title="New Location">
        <div className="space-y-3">
          <Field label="Code" required><input className={inputCls} value={form.code ?? ""} onChange={(e) => set("code", e.target.value)} /></Field>
          <Field label="External ID (sheet key)"><input className={inputCls} value={form.external_id ?? ""} onChange={(e) => set("external_id", e.target.value)} /></Field>
          <Field label="Name" required><input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="City"><input className={inputCls} value={form.city ?? ""} onChange={(e) => set("city", e.target.value)} /></Field>
            <Field label="State"><input className={inputCls} value={form.state ?? ""} onChange={(e) => set("state", e.target.value)} /></Field>
          </div>
          <Field label="Approval status">
            <select className={inputCls} value={form.approval_status} onChange={(e) => set("approval_status", e.target.value)}>
              {["Pending", "Approved", "Rejected"].map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="SPOC name"><input className={inputCls} value={form.spoc_name ?? ""} onChange={(e) => set("spoc_name", e.target.value)} /></Field>
            <Field label="SPOC phone"><input className={inputCls} value={form.spoc_phone ?? ""} onChange={(e) => set("spoc_phone", e.target.value)} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Principal name"><input className={inputCls} value={form.principal_name ?? ""} onChange={(e) => set("principal_name", e.target.value)} /></Field>
            <Field label="Principal phone"><input className={inputCls} value={form.principal_phone ?? ""} onChange={(e) => set("principal_phone", e.target.value)} /></Field>
          </div>
          <Btn onClick={save} disabled={!form.code || !form.name}>Create Location</Btn>
        </div>
      </Drawer>
    </div>
  );
}
