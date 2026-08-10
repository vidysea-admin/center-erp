"use client";
import { use, useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client";
import { Btn, Chip, DataTable, ErrorBanner, Field, Section, Tabs, inputCls } from "@/components/ui";
import { Activity } from "@/components/activity";
import Link from "next/link";

const TABS = ["Overview", "Capacity & Target", "Trainers & Infra", "Batches", "Activity"];

export default function LocationDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [tab, setTab] = useState("Overview");
  const [loc, setLoc] = useState<any>(null);
  const [error, setError] = useState("");

  const load = () => api(`/api/locations/${id}`).then((d) => setLoc(d.item)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);

  if (!loc) return error ? <ErrorBanner msg={error} /> : <div className="p-8 text-center text-gray-400">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{loc.name} <span className="text-sm font-normal text-gray-400">({loc.code})</span></h1>
        <Chip value={loc.approval_status} />
        <Chip value={loc.operational_status} />
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === "Overview" && <Overview loc={loc} onSaved={load} setError={setError} />}
      {tab === "Capacity & Target" && <Targets locationId={id} setError={setError} />}
      {tab === "Trainers & Infra" && <TrainersInfra locationId={id} setError={setError} />}
      {tab === "Batches" && <LocBatches locationId={id} />}
      {tab === "Activity" && <Activity entity="Location" id={id} />}
    </div>
  );
}

function Overview({ loc, onSaved, setError }: any) {
  const [form, setForm] = useState<any>({ ...loc });
  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));
  const statusChanged = form.operational_status !== loc.operational_status;

  async function save() {
    try {
      const patch: any = {};
      for (const f of ["name", "city", "state", "address", "approval_status", "operational_status", "status_reason", "spoc_name", "spoc_phone", "principal_name", "principal_phone", "external_id"]) {
        if (form[f] !== loc[f]) patch[f] = form[f];
      }
      await api(`/api/locations/${loc._id}`, { method: "PATCH", json: patch });
      onSaved();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <Section title="Master fields" actions={<Btn small onClick={save}>Save</Btn>}>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name"><input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="External ID"><input className={inputCls} value={form.external_id ?? ""} onChange={(e) => set("external_id", e.target.value)} /></Field>
        <Field label="Approval status">
          <select className={inputCls} value={form.approval_status} onChange={(e) => set("approval_status", e.target.value)}>
            {["Pending", "Approved", "Rejected"].map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="City"><input className={inputCls} value={form.city ?? ""} onChange={(e) => set("city", e.target.value)} /></Field>
        <Field label="State"><input className={inputCls} value={form.state ?? ""} onChange={(e) => set("state", e.target.value)} /></Field>
        <Field label="Operational status">
          <select className={inputCls} value={form.operational_status} onChange={(e) => set("operational_status", e.target.value)}>
            {["Not Started", "Active", "On Hold", "Stopped", "Closed"].map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        {statusChanged && (
          <Field label="Reason for status change" required>
            <input className={inputCls} value={form.status_reason ?? ""} onChange={(e) => set("status_reason", e.target.value)} placeholder="Required" />
          </Field>
        )}
        <Field label="SPOC name"><input className={inputCls} value={form.spoc_name ?? ""} onChange={(e) => set("spoc_name", e.target.value)} /></Field>
        <Field label="SPOC phone"><input className={inputCls} value={form.spoc_phone ?? ""} onChange={(e) => set("spoc_phone", e.target.value)} /></Field>
        <Field label="Principal name"><input className={inputCls} value={form.principal_name ?? ""} onChange={(e) => set("principal_name", e.target.value)} /></Field>
        <Field label="Principal phone"><input className={inputCls} value={form.principal_phone ?? ""} onChange={(e) => set("principal_phone", e.target.value)} /></Field>
        <Field label="Address"><input className={inputCls} value={form.address ?? ""} onChange={(e) => set("address", e.target.value)} /></Field>
      </div>
    </Section>
  );
}

function Targets({ locationId, setError }: any) {
  const [items, setItems] = useState<any[]>([]);
  const [programs, setPrograms] = useState<any[]>([]);
  const [form, setForm] = useState<any>({});

  const load = () => Promise.all([
    api(`/api/locations/${locationId}/targets`).then((d) => setItems(d.items)),
    api("/api/programs?limit=100").then((d) => setPrograms(d.items)),
  ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [locationId]);

  async function save() {
    try {
      await api(`/api/locations/${locationId}/targets`, { method: "PUT", json: form });
      setForm({}); load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      <Section title="Program-wise targets">
        <DataTable rows={items}
          cardTitle={(r: any) => r.program?.name}
          columns={[
            { key: "program", label: "Program", render: (r: any) => r.program?.name ?? "?" },
            { key: "approved_target", label: "Approved (external)" },
            { key: "allocated_target", label: "Allocated (internal)" },
            { key: "capacity", label: "Capacity math", render: (r: any) => <span className="text-xs text-gray-600">{r.capacity?.sentence ?? "—"}</span> },
          ]}
          empty="No targets yet."
        />
      </Section>
      <Section title="Set / update target">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Program" required>
            <select className={inputCls} value={form.program ?? ""} onChange={(e) => setForm({ ...form, program: e.target.value })}>
              <option value="">Select…</option>
              {programs.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Approved target"><input type="number" className={inputCls} value={form.approved_target ?? ""} onChange={(e) => setForm({ ...form, approved_target: +e.target.value })} /></Field>
          <Field label="Allocated target"><input type="number" className={inputCls} value={form.allocated_target ?? ""} onChange={(e) => setForm({ ...form, allocated_target: +e.target.value })} /></Field>
          <div className="flex items-end"><Btn onClick={save} disabled={!form.program}>Save target</Btn></div>
        </div>
      </Section>
    </div>
  );
}

function TrainersInfra({ locationId, setError }: any) {
  const [rooms, setRooms] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [programs, setPrograms] = useState<any[]>([]);
  const [roomForm, setRoomForm] = useState<any>({ type: "Classroom" });
  const [reqForm, setReqForm] = useState<any>({});

  const load = () => Promise.all([
    api(`/api/locations/${locationId}/rooms`).then((d) => setRooms(d.items)),
    api(`/api/trainer-requests?location=${locationId}`).then((d) => setRequests(d.items)),
    api("/api/programs?limit=100").then((d) => setPrograms(d.items)),
  ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [locationId]);

  async function addRoom() {
    try { await api(`/api/locations/${locationId}/rooms`, { method: "POST", json: roomForm }); setRoomForm({ type: "Classroom" }); load(); }
    catch (e: any) { setError(e.message); }
  }
  async function addRequest() {
    try { await api("/api/trainer-requests", { method: "POST", json: { ...reqForm, location: locationId } }); setReqForm({}); load(); }
    catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      <Section title="Rooms (identity matters for conflicts — Rule 13)">
        <DataTable rows={rooms}
          cardTitle={(r: any) => r.name}
          columns={[
            { key: "name", label: "Name" },
            { key: "type", label: "Type", render: (r: any) => <Chip value={r.type} /> },
            { key: "capacity", label: "Capacity" },
            { key: "active", label: "Active", render: (r: any) => (r.active ? "Yes" : "No") },
          ]} empty="No rooms yet." />
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <Field label="Room name"><input className={inputCls} value={roomForm.name ?? ""} onChange={(e) => setRoomForm({ ...roomForm, name: e.target.value })} placeholder="Classroom 1" /></Field>
          <Field label="Type">
            <select className={inputCls} value={roomForm.type} onChange={(e) => setRoomForm({ ...roomForm, type: e.target.value })}>
              <option>Classroom</option><option>Lab</option>
            </select>
          </Field>
          <Field label="Capacity"><input type="number" className={inputCls} value={roomForm.capacity ?? ""} onChange={(e) => setRoomForm({ ...roomForm, capacity: +e.target.value })} /></Field>
          <div className="flex items-end"><Btn onClick={addRoom} disabled={!roomForm.name}>Add Room</Btn></div>
        </div>
      </Section>
      <Section title="Trainer requests (hiring / TOT pipeline)">
        <DataTable rows={requests}
          cardTitle={(r: any) => r.program?.name}
          columns={[
            { key: "program", label: "Program", render: (r: any) => r.program?.name },
            { key: "required_by_date", label: "Required by", render: (r: any) => fmtDate(r.required_by_date) },
            { key: "status", label: "Status", render: (r: any) => <Chip value={r.status} /> },
            { key: "tot_done_on", label: "TOT done", render: (r: any) => fmtDate(r.tot_done_on) },
            { key: "expected_available_from", label: "Expected avail.", render: (r: any) => fmtDate(r.expected_available_from) },
          ]} empty="No trainer requests." />
        <div className="mt-3 grid gap-3 md:grid-cols-4">
          <Field label="Program" required>
            <select className={inputCls} value={reqForm.program ?? ""} onChange={(e) => setReqForm({ ...reqForm, program: e.target.value })}>
              <option value="">Select…</option>
              {programs.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Required by" required><input type="date" className={inputCls} value={reqForm.required_by_date ?? ""} onChange={(e) => setReqForm({ ...reqForm, required_by_date: e.target.value })} /></Field>
          <Field label="Expected available from"><input type="date" className={inputCls} value={reqForm.expected_available_from ?? ""} onChange={(e) => setReqForm({ ...reqForm, expected_available_from: e.target.value })} /></Field>
          <div className="flex items-end"><Btn onClick={addRequest} disabled={!reqForm.program || !reqForm.required_by_date}>Raise Request</Btn></div>
        </div>
      </Section>
    </div>
  );
}

function LocBatches({ locationId }: any) {
  const [items, setItems] = useState<any[]>([]);
  useEffect(() => { api(`/api/batches?location=${locationId}`).then((d) => setItems(d.items)).catch(() => {}); }, [locationId]);
  return (
    <Section title="Batches at this location" actions={<Link href={`/batches?location=${locationId}`}><Btn small kind="ghost">New Batch</Btn></Link>}>
      <DataTable rows={items}
        cardTitle={(r: any) => r.code}
        columns={[
          { key: "code", label: "Code", render: (r: any) => <Link className="text-blue-700 hover:underline" href={`/batches/${r._id}`}>{r.code}</Link> },
          { key: "program", label: "Program", render: (r: any) => r.program?.name },
          { key: "status", label: "Status", render: (r: any) => <Chip value={r.status} /> },
          { key: "roster_count", label: "Roster", render: (r: any) => `${r.roster_count}/${r.target_size}` },
          { key: "planned_start", label: "Start", render: (r: any) => fmtDate(r.planned_start) },
        ]} empty="No batches yet." />
    </Section>
  );
}

