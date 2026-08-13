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
      {/* 2026-08-14 (Umesh: "31 approved / 57 total vs tumhara 13/21 — blunder?"): the pills
          count CENTRES; the sheet's own arithmetic counts ROWS. Show BOTH, named, from the
          same API rollups — so the two countings can never look like a contradiction again. */}
      <FilterPills active={tag} onChange={(v) => setTag(v === tag ? "" : v)}
        options={[
          { value: "", label: "All centres", count: items.length },
          ...["Approved", "Pending", "Rejected"].map((s) => ({ value: s, label: `${s} centres`, count: items.filter((l) => l.approval_status === s).length })),
        ]} />
      {items.length > 0 && (
        <p className="text-xs text-gray-500">
          Sheet arithmetic:{" "}
          <span className="font-semibold text-gray-900">{items.reduce((s, l) => s + (l.job_roles?.length ?? 0), 0)}</span> job-role rows ·{" "}
          <span className="font-semibold text-green-700">{items.reduce((s, l) => s + (l.approved_job_roles ?? 0), 0)} approved rows</span> ·{" "}
          {items.length} centres ({items.filter((l) => l.approval_status === "Approved").length} with ≥1 approved row)
        </p>
      )}
      {/* 2026-08-13 (Umesh): "iss [OneDrive] sheet ke exact column and data chahiye iss
          Location Master mein, aur koi nahi." Columns mirror Vidysea-RPL.xlsx in ITS order
          (S.N. dropped — a row number). One row per centre = the sheet's merged cells;
          per-row breakup lives in the detail "Capacity & Target" tab. Appended at the end:
          Trainers (ours, live) — the fulfilment ask — and Source (Manish's provenance).
          The Columns picker trims; Code/City/Approval start hidden (Approval = TC Status). */}
      <DataTable
        storageKey="locations"
        rows={tag ? items.filter((l) => l.approval_status === tag) : items}
        loading={loading}
        onRowClick={(r) => router.push(`/locations/${r._id}`)}
        cardTitle={(r: any) => <>{r.name} <span className="text-xs text-gray-400">({r.code})</span></>}
        defaultSort={{ key: "name", dir: "asc" }}
        columns={[
          { key: "spoc_name", label: "SPOC Name", sortable: true, sortValue: (r: any) => r.spoc_name },
          { key: "cluster_head_phone", label: "Cluster Head Contact", mobile: false },
          { key: "state", label: "State", mobile: false, sortable: true, sortValue: (r: any) => r.state },
          { key: "district", label: "District", sortable: true, sortValue: (r: any) => r.district ?? r.city, render: (r: any) => r.district ?? r.city ?? "—" },
          { key: "name", label: "Institution Name", sortable: true, sortValue: (r: any) => r.name, minWidth: 240 },
          // Karunn 13/08: the sheet's Operational claim is unreliable ("chal raha bhi Operational,
          // nahi chal raha bhi") — approval drives; column stays available via the picker.
          { key: "operational_status", label: "Operational", hidden: true, sortable: true, sortValue: (r: any) => r.operational_status, render: (r: any) => <Chip value={r.operational_status} /> },
          { key: "operating_partner", label: "Operating Partner", mobile: false },
          {
            // 2026-08-13 (Manish): "Ongoing scheme bhi saath mein dikhana must hai" — the scheme
            // travels with every job role, and the funnel filters by it.
            key: "schemes", label: "Ongoing Scheme", filterable: true,
            filterText: (r: any) => (r.schemes ?? []).join(" · "),
            render: (r: any) => (r.schemes ?? []).length
              ? <span className="flex flex-wrap gap-1">{r.schemes.map((s: string) => <Chip key={s} value={s} />)}</span>
              : <span className="text-gray-400">—</span>,
          },
          {
            key: "job_roles", label: "Job Role", minWidth: 220,
            filterText: (r: any) => (r.job_roles ?? []).map((j: any) => `${j.program} ${j.tc_status ?? ""}`).join(" · "),
            render: (r: any) => (r.job_roles ?? []).length ? (
              <span className="block text-xs text-gray-600">{r.job_roles.map((j: any) => j.code ?? j.program).join(" · ")}</span>
            ) : <span className="text-gray-400">no targets</span>,
          },
          { key: "total_target", label: "Total Target", sortable: true, sortValue: (r: any) => r.total_target ?? 0 },
          // Karunn 13/08: "Already Enrolled + Pending Enrollment dono hata do" — the sheet's
          // enrolment claims are junk (only BECIL ever filled them; enrolment is OURS to count).
          // Columns removed outright; the *_reported fields stay in DB/API for the detail tab.
          {
            key: "tc_ids", label: "TC ID", mobile: false, minWidth: 150,
            filterText: (r: any) => (r.tc_ids ?? []).join(" ") || (r.tc_id ?? ""),
            render: (r: any) => { const ids = (r.tc_ids ?? []).length ? r.tc_ids : (r.tc_id ? [r.tc_id] : []);
              return ids.length ? <span className="font-mono text-xs">{ids.join(" · ")}</span> : <span className="text-gray-400">—</span>; },
          },
          {
            // Live credential — the server already strips it for anyone without
            // locations.manage, so non-managers see a dash, never the secret.
            key: "tc_password", label: "TC Password", mobile: false, filterable: false,
            render: (r: any) => r.tc_password ? <span className="font-mono text-xs">{r.tc_password}</span> : <span className="text-gray-300">—</span>,
          },
          {
            key: "tc_status_roll", label: "TC Status", filterable: true,
            filterText: (r: any) => (r.job_roles ?? []).length ? `${r.approved_job_roles} of ${r.job_roles.length} approved` : (r.tc_status ?? ""),
            render: (r: any) => (r.job_roles ?? []).length ? (
              <span className="text-xs"><span className="font-medium text-gray-900">{r.approved_job_roles}</span> of {r.job_roles.length} approved</span>
            ) : <Chip value={r.tc_status} />,
          },
          { key: "trainers_required_total", label: "Trainer Required", sortable: true, sortValue: (r: any) => r.trainers_required_total ?? 0 },
          { key: "nominations_received_reported_total", label: "Nomination Received (sheet)", mobile: false },
          { key: "nominated_nsdc_reported_total", label: "Nominated to NSDC (sheet)", mobile: false },
          { key: "trainers_certified_reported_total", label: "Trainer Certified (sheet)", mobile: false },
          {
            // Umesh (voice note): "jaise-jaise hamare trainer approve hote jayenge, count
            // update ho jana chahiye — kitne chahiye, kitne mil gaye". DERIVED from Trainer
            // rows on every fetch; the sheet's claim sits in the three columns before this.
            key: "trainers_ours", label: "Trainers (ours, live)", minWidth: 150,
            sortable: true, sortValue: (r: any) => r.trainers_certified_total ?? 0,
            filterText: (r: any) => `${r.trainers_certified_total ?? 0} certified of ${r.trainers_required_total ?? 0} required`,
            render: (r: any) => { const need = r.trainers_required_total ?? 0, got = r.trainers_certified_total ?? 0;
              return (
                <span className={`text-xs font-medium ${need && got < need ? "text-amber-600" : "text-green-700"}`}>
                  {got} certified / {need} required
                  {(r.trainers_nominated_total ?? 0) > 0 && <span className="block font-normal text-gray-400">{r.trainers_nominated_total} nominated</span>}
                </span>
              ); },
          },
          // Centres come from the OneDrive truth workbook; external_id is that row's TC ID.
          { key: "source", label: "Source", mobile: false, filterText: (r: any) => r.external_id ? "Vidysea-RPL (OneDrive)" : "Entered in ERP", render: (r: any) => <SourceCell source={r.external_id ? "AVPL Location_Master" : ""} /> },
          // ERP-internal columns — available in the picker, hidden by default.
          { key: "code", label: "Code", mobile: false, hidden: true, sortable: true, sortValue: (r: any) => r.code },
          { key: "city", label: "City", mobile: false, hidden: true, sortable: true, sortValue: (r: any) => r.city },
          { key: "approval_status", label: "Approval", hidden: true, sortable: true, sortValue: (r: any) => r.approval_status, render: (r: any) => <Chip value={r.approval_status} /> },
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
