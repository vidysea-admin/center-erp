"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, inputCls } from "@/components/ui";

export default function LocationsPage() {
  const router = useRouter();
  const [items, setItems] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [form, setForm] = useState<any>({ approval_status: "Pending" });
  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));

  const load = () => api(`/api/locations?q=${encodeURIComponent(q)}&limit=2000`).then((d) => setItems(d.items)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [q]);

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
          <input className={inputCls + " max-w-52"} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Btn onClick={() => setDrawer(true)}>New Location</Btn>
        </div>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      <DataTable
        rows={items}
        onRowClick={(r) => router.push(`/locations/${r._id}`)}
        cardTitle={(r: any) => <>{r.name} <span className="text-xs text-gray-400">({r.code})</span></>}
        columns={[
          { key: "code", label: "Code", mobile: false },
          { key: "name", label: "Name", mobile: false },
          { key: "city", label: "City", mobile: false },
          { key: "approval_status", label: "Approval", render: (r: any) => <Chip value={r.approval_status} /> },
          { key: "operational_status", label: "Operational", render: (r: any) => <Chip value={r.operational_status} /> },
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
