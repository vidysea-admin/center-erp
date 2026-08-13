"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/client";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, FilterPills, inputCls } from "@/components/ui";

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
          { key: "name", label: "Name", mobile: false, sortable: true, sortValue: (r: any) => r.name },
          { key: "city", label: "City", mobile: false, sortable: true, sortValue: (r: any) => r.city },
          { key: "approval_status", label: "Approval", sortable: true, sortValue: (r: any) => r.approval_status, render: (r: any) => <Chip value={r.approval_status} /> },
          { key: "operational_status", label: "Operational", sortable: true, sortValue: (r: any) => r.operational_status, render: (r: any) => <Chip value={r.operational_status} /> },
          { key: "spoc_name", label: "SPOC" },
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
