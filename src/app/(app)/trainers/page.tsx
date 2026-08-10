"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, fmtDate } from "@/lib/client";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, NameCell, Tabs, inputCls } from "@/components/ui";

export default function TrainersPage() {
  return <Suspense><TrainersInner /></Suspense>;
}

function TrainersInner() {
  const sp = useSearchParams();
  const [tab, setTab] = useState(sp.get("tab") === "Requests" ? "Requests" : "Trainers");
  const [items, setItems] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [form, setForm] = useState<any>({ max_concurrent_batches: 1, status: "Available" });
  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));

  const load = () => Promise.all([
    api(`/api/trainers?q=${encodeURIComponent(q)}&limit=200`).then((d) => setItems(d.items)),
    api("/api/trainer-requests?limit=200").then((d) => setRequests(d.items)),
    api("/api/locations?limit=200").then((d) => setLocations(d.items)),
  ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [q]);

  function openEdit(t: any) {
    setEdit(t);
    setForm({ ...t, home_location: t.home_location?._id ?? "", skills: t.skills ?? [] });
    setDrawer(true);
  }

  async function save() {
    try {
      const json = { ...form, skills: typeof form.skills === "string" ? form.skills.split(",").map((s: string) => s.trim()).filter(Boolean) : form.skills, home_location: form.home_location || undefined };
      if (edit) await api(`/api/trainers/${edit._id}`, { method: "PATCH", json });
      else await api("/api/trainers", { method: "POST", json });
      setDrawer(false); setEdit(null); setForm({ max_concurrent_batches: 1, status: "Available" }); load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Trainers</h1>
        <div className="flex gap-2">
          <input className={inputCls + " max-w-52"} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Btn onClick={() => { setEdit(null); setForm({ max_concurrent_batches: 1, status: "Available" }); setDrawer(true); }}>Add Trainer</Btn>
        </div>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      <Tabs tabs={["Trainers", `Requests (${requests.filter((r) => ["Open", "In Progress"].includes(r.status)).length})`]} active={tab.startsWith("Requests") ? `Requests (${requests.filter((r) => ["Open", "In Progress"].includes(r.status)).length})` : tab} onChange={(t) => setTab(t.startsWith("Requests") ? "Requests" : t)} />
      {tab === "Trainers" ? (
        <DataTable rows={items} onRowClick={openEdit}
          cardTitle={(r: any) => r.name}
          columns={[
            { key: "name", label: "Name", mobile: false, render: (r: any) => <NameCell name={r.name} sub={r.phone} /> },
            { key: "skills", label: "Skills", render: (r: any) => (r.skills ?? []).join(", ") },
            { key: "home_location", label: "Home location", render: (r: any) => r.home_location?.name ?? "—" },
            { key: "status", label: "Status", render: (r: any) => <Chip value={r.status} /> },
            { key: "available_from", label: "Available from", render: (r: any) => fmtDate(r.available_from) },
            { key: "max_concurrent_batches", label: "Max batches" },
          ]} empty="No trainers yet." />
      ) : (
        <DataTable rows={requests}
          cardTitle={(r: any) => `${r.location?.name} · ${r.program?.name}`}
          columns={[
            { key: "location", label: "Location", render: (r: any) => r.location?.name },
            { key: "program", label: "Program", render: (r: any) => r.program?.name },
            { key: "required_by_date", label: "Required by", render: (r: any) => fmtDate(r.required_by_date) },
            { key: "status", label: "Status", render: (r: any) => <RequestStatus r={r} onChanged={load} setError={setError} /> },
            { key: "tot_done_on", label: "TOT done", render: (r: any) => fmtDate(r.tot_done_on) },
            { key: "fulfilled_by_trainer", label: "Fulfilled by", render: (r: any) => r.fulfilled_by_trainer?.name ?? "—" },
          ]} empty="No trainer requests." />
      )}

      <Drawer open={drawer} onClose={() => setDrawer(false)} title={edit ? `Edit ${edit.name}` : "Add Trainer"}>
        <div className="space-y-3">
          <Field label="Name" required><input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone" required><input className={inputCls} value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} /></Field>
            <Field label="Email"><input className={inputCls} value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} /></Field>
          </div>
          <Field label="Skills (comma-separated, must match Program trainer skills)" required>
            <input className={inputCls} value={Array.isArray(form.skills) ? form.skills.join(", ") : form.skills ?? ""} onChange={(e) => set("skills", e.target.value)} />
          </Field>
          <Field label="Home location">
            <select className={inputCls} value={form.home_location ?? ""} onChange={(e) => set("home_location", e.target.value)}>
              <option value="">—</option>
              {locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Status">
              <select className={inputCls} value={form.status} onChange={(e) => set("status", e.target.value)}>
                {["Available", "Assigned", "Unavailable"].map((s) => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Available from"><input type="date" className={inputCls} value={form.available_from?.slice?.(0, 10) ?? ""} onChange={(e) => set("available_from", e.target.value)} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Day rate (₹)"><input type="number" className={inputCls} value={form.day_rate ?? ""} onChange={(e) => set("day_rate", +e.target.value)} /></Field>
            <Field label="Max concurrent batches"><input type="number" className={inputCls} value={form.max_concurrent_batches ?? 1} onChange={(e) => set("max_concurrent_batches", +e.target.value)} /></Field>
          </div>
          <Btn onClick={save} disabled={!form.name || !form.phone}>{edit ? "Save changes" : "Add Trainer"}</Btn>
        </div>
      </Drawer>
    </div>
  );
}

function RequestStatus({ r, onChanged, setError }: any) {
  async function update(status: string) {
    try { await api(`/api/trainer-requests/${r._id}`, { method: "PATCH", json: { status } }); onChanged(); }
    catch (e: any) { setError(e.message); }
  }
  return (
    <select className="rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs" value={r.status} onChange={(e) => update(e.target.value)}>
      {["Open", "In Progress", "Fulfilled", "Cancelled"].map((s) => <option key={s}>{s}</option>)}
    </select>
  );
}
