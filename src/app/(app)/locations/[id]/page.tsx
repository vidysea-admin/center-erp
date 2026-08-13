"use client";
import { use, useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client";
import { Btn, Chip, DataTable, ErrorBanner, Field, Section, Tabs, inputCls } from "@/components/ui";
import { Activity } from "@/components/activity";
import Link from "next/link";

const TABS = ["Overview", "Contacts & Notes", "Capacity & Target", "Trainers & Infra", "Batches", "Activity"];

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
      {tab === "Contacts & Notes" && <ContactsNotes loc={loc} onSaved={load} setError={setError} />}
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
      // Diff-based: only touched fields travel. That also protects tc_password — for readers
      // without locations.manage the API strips it, the input stays empty, and an unchanged
      // empty value is never sent (and their PATCH would 403 anyway).
      for (const f of ["name", "city", "state", "address", "approval_status", "operational_status", "status_reason", "spoc_name", "spoc_phone", "principal_name", "principal_phone", "external_id",
        "district", "tc_id", "tc_status", "tc_password", "operating_partner", "cluster_head_name", "cluster_head_phone"]) {
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
        <Field label="District"><input className={inputCls} value={form.district ?? ""} onChange={(e) => set("district", e.target.value)} /></Field>
        {/* Government-portal identity for this centre (sheet columns TC ID / TC Status / TC
            Password). The password is a live portal credential: the API strips it for anyone
            without locations.manage, so this input is simply empty for them. */}
        <Field label="TC ID (govt portal)"><input className={inputCls} value={form.tc_id ?? ""} onChange={(e) => set("tc_id", e.target.value)} /></Field>
        <Field label="TC status"><input className={inputCls} value={form.tc_status ?? ""} onChange={(e) => set("tc_status", e.target.value)} placeholder="Approved / …" /></Field>
        <Field label="TC password (visible to locations.manage only)">
          <input type="password" className={inputCls} value={form.tc_password ?? ""} onChange={(e) => set("tc_password", e.target.value)} />
        </Field>
        <Field label="Operating partner"><input className={inputCls} value={form.operating_partner ?? ""} onChange={(e) => set("operating_partner", e.target.value)} /></Field>
        <Field label="Cluster head"><input className={inputCls} value={form.cluster_head_name ?? ""} onChange={(e) => set("cluster_head_name", e.target.value)} /></Field>
        <Field label="Cluster head phone"><input className={inputCls} value={form.cluster_head_phone ?? ""} onChange={(e) => set("cluster_head_phone", e.target.value)} /></Field>
      </div>
    </Section>
  );
}

// 2026-08-11 meeting: multiple SPOCs/contact persons per location, plus dated meeting notes
// so Admin and Ops both know who was spoken to, where, and when.
function ContactsNotes({ loc, onSaved, setError }: any) {
  const [contacts, setContacts] = useState<any[]>(loc.contacts ?? []);
  const [cForm, setCForm] = useState<any>({ role_label: "Contact" });
  const [notes, setNotes] = useState<any[]>([]);
  const [nForm, setNForm] = useState<any>({ meeting_date: new Date().toISOString().slice(0, 10) });

  const loadNotes = () => api(`/api/locations/${loc._id}/notes`).then((d) => setNotes(d.items)).catch((e) => setError(e.message));
  useEffect(() => { loadNotes(); }, [loc._id]);

  async function saveContacts(next: any[]) {
    try {
      await api(`/api/locations/${loc._id}`, { method: "PATCH", json: { contacts: next.map(({ name, phone, role_label, user }) => ({ name, phone, role_label, user })) } });
      setContacts(next); onSaved();
    } catch (e: any) { setError(e.message); }
  }

  async function addContact() {
    if (!cForm.name?.trim()) { setError("Contact name is required."); return; }
    await saveContacts([...contacts, { ...cForm, name: cForm.name.trim() }]);
    setCForm({ role_label: "Contact" });
  }

  async function addNote() {
    try {
      await api(`/api/locations/${loc._id}/notes`, { method: "POST", json: nForm });
      setNForm({ meeting_date: new Date().toISOString().slice(0, 10) });
      loadNotes();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      <Section title="Contact persons">
        <div className="mb-3 grid gap-3 md:grid-cols-4">
          <Field label="Name" required><input className={inputCls} value={cForm.name ?? ""} onChange={(e) => setCForm({ ...cForm, name: e.target.value })} /></Field>
          <Field label="Phone"><input className={inputCls} value={cForm.phone ?? ""} onChange={(e) => setCForm({ ...cForm, phone: e.target.value })} /></Field>
          <Field label="Role">
            <select className={inputCls} value={cForm.role_label} onChange={(e) => setCForm({ ...cForm, role_label: e.target.value })}>
              {["SPOC", "Principal", "Cluster Head", "Contact"].map((r) => <option key={r}>{r}</option>)}
            </select>
          </Field>
          <div className="flex items-end"><Btn onClick={addContact}>Add contact</Btn></div>
        </div>
        <DataTable rows={[
          ...(loc.spoc_name ? [{ _id: "_spoc", name: loc.spoc_name, phone: loc.spoc_phone, role_label: "SPOC (primary)", legacy: true }] : []),
          ...(loc.principal_name ? [{ _id: "_principal", name: loc.principal_name, phone: loc.principal_phone, role_label: "Principal (primary)", legacy: true }] : []),
          ...contacts.map((c, i) => ({ ...c, _id: c._id ?? `c${i}`, _idx: i })),
        ]}
          cardTitle={(r: any) => r.name}
          columns={[
            { key: "name", label: "Name" },
            { key: "role_label", label: "Role" },
            { key: "phone", label: "Phone", render: (r: any) => r.phone || "—" },
            { key: "_rm", label: "", render: (r: any) => r.legacy ? <span className="text-[11px] text-gray-400">from master fields</span> : <Btn small kind="ghost" onClick={() => saveContacts(contacts.filter((_, i) => i !== r._idx))}>Remove</Btn> },
          ]} empty="No contacts yet — add SPOCs and location contacts here." />
      </Section>

      <Section title="Meeting notes">
        <div className="mb-3 grid gap-3 md:grid-cols-4">
          <Field label="Date"><input type="date" className={inputCls} value={nForm.meeting_date} onChange={(e) => setNForm({ ...nForm, meeting_date: e.target.value })} /></Field>
          <Field label="Met with"><input className={inputCls} value={nForm.met_with ?? ""} onChange={(e) => setNForm({ ...nForm, met_with: e.target.value })} placeholder="Principal, SPOC…" /></Field>
          <Field label="Notes" required><input className={inputCls} value={nForm.note ?? ""} onChange={(e) => setNForm({ ...nForm, note: e.target.value })} placeholder="What was discussed / agreed" /></Field>
          <div className="flex items-end"><Btn onClick={addNote} disabled={!nForm.note?.trim()}>Add note</Btn></div>
        </div>
        <div className="space-y-2">
          {notes.length === 0 && <p className="py-6 text-center text-sm text-gray-400">No meeting notes yet.</p>}
          {notes.map((n) => {
            const shareText = `Meeting note — ${loc.name} (${fmtDate(n.meeting_date)})${n.met_with ? ` with ${n.met_with}` : ""}:\n${n.note}`;
            return (
              <div key={n._id} className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  <span className="font-medium text-gray-800">{fmtDate(n.meeting_date)}</span>
                  {n.met_with && <span>· with <b>{n.met_with}</b></span>}
                  <span className="ml-auto flex items-center gap-2">
                    {/* 2026-08-11: "उनको notes भेज पाऊं" */}
                    <button className="font-medium text-blue-700 hover:underline" onClick={() => navigator.clipboard.writeText(shareText)}>Copy</button>
                    <a className="font-medium text-green-700 hover:underline" target="_blank" rel="noreferrer"
                      href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}>WhatsApp</a>
                    <span>logged by {n.logged_by?.name ?? "—"}</span>
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm text-gray-800">{n.note}</p>
              </div>
            );
          })}
        </div>
      </Section>
    </div>
  );
}

function Targets({ locationId, setError }: any) {
  const [items, setItems] = useState<any[]>([]);
  const [programs, setPrograms] = useState<any[]>([]);
  const [form, setForm] = useState<any>({});

  const load = () => Promise.all([
    api(`/api/locations/${locationId}/targets`).then((d) => setItems(d.items)),
    api("/api/programs?limit=1000").then((d) => setPrograms(d.items)),
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
            {
              key: "achieved", label: "Achieved",
              render: (r: any) => r.achieved ? (
                <span className="text-xs">
                  <span className="font-medium text-gray-900">{r.achieved.enrolled}</span> enrolled ·{" "}
                  <span className="font-medium text-gray-900">{r.achieved.certified}</span> certified
                  <span className="block text-gray-400">
                    {r.achieved.batches_created} batch{r.achieved.batches_created === 1 ? "" : "es"} · remaining {r.achieved.remaining_by_certified}
                  </span>
                </span>
              ) : "—",
            },
            {
              // Trainers counted from our own records, with the sheet's requirement beside them.
              key: "trainers", label: "Trainers", render: (r: any) => r.trainers ? (
                <span className="text-xs">
                  <span className={`font-medium ${r.trainers.shortfall ? "text-amber-700" : "text-gray-900"}`}>
                    {r.trainers.certified}
                  </span>
                  {r.trainers.required != null ? ` / ${r.trainers.required} needed` : " certified"}
                  <span className="block text-gray-400">
                    {r.trainers.nominated} nominated · {r.trainers.in_pipeline} in pipeline
                  </span>
                </span>
              ) : "—",
            },
            {
              // The client sheet's own figure, never merged into ours. A variance is the story.
              key: "reported", label: "Sheet says", mobile: false, render: (r: any) =>
                r.reported?.enrolled == null ? <span className="text-xs text-gray-400">—</span> : (
                  <span className="text-xs">
                    {r.reported.enrolled} enrolled
                    {r.reported.enrolled_variance ? (
                      <span className="block font-medium text-amber-700">
                        we count {r.reported.enrolled_variance > 0 ? "+" : ""}{r.reported.enrolled_variance}
                      </span>
                    ) : <span className="block text-gray-400">matches ours</span>}
                  </span>
                ),
            },
            { key: "capacity", label: "Capacity math", mobile: false, render: (r: any) => <span className="text-xs text-gray-600">{r.capacity?.sentence ?? "—"}</span> },
          ]}
          empty="No targets yet."
        />
      </Section>
      <Section title="Set / update target">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Program" required>
            <select className={inputCls} value={form.program ?? ""} onChange={(e) => setForm({ ...form, program: e.target.value })}>
              <option value="">Select…</option>
              {programs.map((p) => <option key={p._id} value={p._id}>{p.name}{p.scheme ? ` (${p.scheme})` : p.code ? ` (${p.code})` : ""}</option>)}
            </select>
          </Field>
          <Field label="Approved target"><input type="number" className={inputCls} value={form.approved_target ?? ""} onChange={(e) => setForm({ ...form, approved_target: +e.target.value })} /></Field>
          <Field label="Allocated target"><input type="number" className={inputCls} value={form.allocated_target ?? ""} onChange={(e) => setForm({ ...form, allocated_target: +e.target.value })} /></Field>
          <Field label="Trainers required"><input type="number" className={inputCls} value={form.trainers_required ?? ""} onChange={(e) => setForm({ ...form, trainers_required: +e.target.value })} /></Field>
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
  const [readiness, setReadiness] = useState<any[]>([]);
  const [trainers, setTrainers] = useState<any[]>([]);
  const [roomForm, setRoomForm] = useState<any>({ type: "Classroom" });
  const [reqForm, setReqForm] = useState<any>({});

  const load = () => Promise.all([
    api(`/api/locations/${locationId}/rooms`).then((d) => setRooms(d.items)),
    api(`/api/trainer-requests?location=${locationId}`).then((d) => setRequests(d.items)),
    api("/api/programs?limit=1000").then((d) => setPrograms(d.items)),
    api(`/api/mapping/readiness?location=${locationId}`).then((d) => setReadiness(d.items ?? [])).catch(() => setReadiness([])),
    api(`/api/trainers?nominated_for_location=${locationId}&limit=1000`).then((d) => setTrainers(d.items ?? [])).catch(() => setTrainers([])),
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
      {/* 2026-08-08: "wo trainer jitne chahiye — Trainer 1, Trainer 2, Trainer 3 — iske aage
          dikhne lag jaye ki kya-kya kahani hai." One slot per required trainer, each filled by a
          named person at their pipeline stage; an empty slot is unstarted hiring, said plainly. */}
      {readiness.length > 0 && (
        <Section title="Trainer slots — required vs who is actually filling them">
          <div className="space-y-3">
            {readiness.map((r: any) => {
              const progId = r.program?._id;
              const named = trainers.filter((t: any) => (t.nominated_for_program?._id ?? t.nominated_for_program) === progId && t.pipeline_status !== "Dropped");
              const required = r.trainers?.required ?? Math.max(named.length, 1);
              const slots = Array.from({ length: Math.max(required, named.length) }, (_, i) => named[i] ?? null);
              return (
                <div key={progId} className="rounded-lg border border-gray-200 p-3">
                  <div className="mb-2 flex items-baseline justify-between">
                    <span className="text-sm font-medium">{r.program?.name}</span>
                    <span className="text-xs text-gray-500">{r.trainers?.certified ?? 0} certified of {r.trainers?.required ?? "?"} required</span>
                  </div>
                  <ol className="grid gap-1.5 text-sm md:grid-cols-2">
                    {slots.map((t: any, i: number) => (
                      <li key={i} className="flex items-center gap-2">
                        <span className="w-16 shrink-0 text-xs text-gray-400">Trainer {i + 1}</span>
                        {t ? (
                          <Link href={`/trainers/${t._id}`} className="flex items-center gap-1.5 text-blue-700 hover:underline">
                            {t.name}
                            <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${
                              t.pipeline_status === "Certified" ? "border-green-200 bg-green-50 text-green-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
                              {t.pipeline_status === "Certified" ? "Certified (Ready to Train)" : t.pipeline_status}
                            </span>
                          </Link>
                        ) : (
                          <span className="text-xs text-gray-400">empty — hiring not started (raise a trainer request below)</span>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </div>
        </Section>
      )}

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
              {programs.map((p) => <option key={p._id} value={p._id}>{p.name}{p.scheme ? ` (${p.scheme})` : p.code ? ` (${p.code})` : ""}</option>)}
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

