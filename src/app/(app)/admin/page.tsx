"use client";
import { useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, Section, Tabs, inputCls } from "@/components/ui";

const TABS = ["Programs", "Users & Access", "Sync Source", "Approvals", "Master Lists", "Defaults"];

const APPROVAL_LABELS: Record<string, string> = {
  "location.close": "Close a location",
  "location.stop": "Stop a location",
  "batch.cancel": "Cancel a batch",
  "batch.complete": "Complete a batch",
  "invoice.raise": "Mark an invoice raised",
  "invoice.paid": "Mark an invoice paid",
};

export default function AdminPage() {
  const [tab, setTab] = useState("Programs");
  const [error, setError] = useState("");
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Admin</h1>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === "Programs" && <Programs setError={setError} />}
      {tab === "Users & Access" && <Users setError={setError} />}
      {tab === "Sync Source" && <SyncSources setError={setError} />}
      {tab === "Approvals" && <Approvals setError={setError} />}
      {tab === "Master Lists" && <MasterLists setError={setError} />}
      {tab === "Defaults" && <DefaultsTab setError={setError} />}
    </div>
  );
}

function Programs({ setError }: any) {
  const [items, setItems] = useState<any[]>([]);
  const [drawer, setDrawer] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));

  const load = () => api("/api/programs?limit=100").then((d) => setItems(d.items)).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, []);

  function open(p?: any) {
    setEdit(p ?? null);
    setForm(p ?? { duration_days: 15, buffer_days: 5, default_batch_size: 30, completion_deadline_days: 90, requires_lab: false, active: true });
    setDrawer(true);
  }
  async function save() {
    try {
      if (edit) await api(`/api/programs/${edit._id}`, { method: "PATCH", json: form });
      else await api("/api/programs", { method: "POST", json: form });
      setDrawer(false); load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <Section title="Programs & Courses" actions={<Btn small onClick={() => open()}>Add Program</Btn>}>
      <DataTable rows={items} onRowClick={open}
        cardTitle={(r: any) => r.name}
        columns={[
          { key: "code", label: "Code" },
          { key: "name", label: "Name" },
          { key: "default_batch_size", label: "Batch size" },
          { key: "duration_days", label: "Duration (d)" },
          { key: "buffer_days", label: "Buffer (d)" },
          { key: "completion_deadline_days", label: "Deadline (d)" },
          { key: "trainer_skill", label: "Trainer skill" },
          { key: "requires_lab", label: "Lab?", render: (r: any) => (r.requires_lab ? "Yes" : "No") },
          { key: "active", label: "Active", render: (r: any) => <Chip value={r.active ? "Active" : "Closed"} /> },
        ]} empty="No programs — every computed value depends on these." />
      <Drawer open={drawer} onClose={() => setDrawer(false)} title={edit ? `Edit ${edit.name}` : "Add Program"}>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Code" required><input className={inputCls} value={form.code ?? ""} onChange={(e) => set("code", e.target.value)} /></Field>
            <Field label="Name" required><input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></Field>
          </div>
          <Field label="Trainer skill (matched to Trainer.skills)" required><input className={inputCls} value={form.trainer_skill ?? ""} onChange={(e) => set("trainer_skill", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Duration days"><input type="number" className={inputCls} value={form.duration_days ?? ""} onChange={(e) => set("duration_days", +e.target.value)} /></Field>
            <Field label="Buffer days"><input type="number" className={inputCls} value={form.buffer_days ?? ""} onChange={(e) => set("buffer_days", +e.target.value)} /></Field>
            <Field label="Default batch size"><input type="number" className={inputCls} value={form.default_batch_size ?? ""} onChange={(e) => set("default_batch_size", +e.target.value)} /></Field>
            <Field label="Completion deadline days"><input type="number" className={inputCls} value={form.completion_deadline_days ?? ""} onChange={(e) => set("completion_deadline_days", +e.target.value)} /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!form.requires_lab} onChange={(e) => set("requires_lab", e.target.checked)} /> Requires Lab</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active ?? true} onChange={(e) => set("active", e.target.checked)} /> Active</label>
          <Btn onClick={save} disabled={!form.code || !form.name || !form.trainer_skill}>{edit ? "Save" : "Add Program"}</Btn>
        </div>
      </Drawer>
    </Section>
  );
}

function Users({ setError }: any) {
  const [items, setItems] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [drawer, setDrawer] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));

  const load = () => Promise.all([
    api("/api/users").then((d) => setItems(d.items)),
    api("/api/locations?limit=200").then((d) => setLocations(d.items)),
  ]).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, []);

  function open(u?: any) {
    setEdit(u ?? null);
    setForm(u ? { ...u, location_scope: (u.location_scope ?? []).map((l: any) => l._id ?? l), password: "" } : { role: "Location", can_edit: false, active: true, location_scope: [] });
    setDrawer(true);
  }
  async function save() {
    try {
      const json = { ...form };
      if (!json.password) delete json.password;
      if (edit) await api(`/api/users/${edit._id}`, { method: "PATCH", json });
      else await api("/api/users", { method: "POST", json });
      setDrawer(false); load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <Section title="Users & Access" actions={<Btn small onClick={() => open()}>Add User</Btn>}>
      <DataTable rows={items} onRowClick={open}
        cardTitle={(r: any) => r.name}
        columns={[
          { key: "name", label: "Name" },
          { key: "email", label: "Email" },
          { key: "role", label: "Role", render: (r: any) => <Chip value={r.role} /> },
          { key: "location_scope", label: "Scope", render: (r: any) => r.role === "Location" ? (r.location_scope ?? []).map((l: any) => l.name ?? l.code).join(", ") || "none" : "All" },
          { key: "can_edit", label: "Can edit", render: (r: any) => (r.can_edit ? "Yes" : "View only") },
          { key: "active", label: "Active", render: (r: any) => (r.active ? "Yes" : "No") },
        ]} empty="No users." />
      <Drawer open={drawer} onClose={() => setDrawer(false)} title={edit ? `Edit ${edit.name}` : "Add User"}>
        <div className="space-y-3">
          <Field label="Name" required><input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Email" required><input type="email" className={inputCls} value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} /></Field>
          <Field label={edit ? "New password (blank = unchanged)" : "Password"} required={!edit}>
            <input type="password" className={inputCls} value={form.password ?? ""} onChange={(e) => set("password", e.target.value)} />
          </Field>
          <Field label="Role">
            <select className={inputCls} value={form.role} onChange={(e) => set("role", e.target.value)}>
              {["Admin", "Operations", "Location", "Enrollment"].map((r) => <option key={r}>{r}</option>)}
            </select>
          </Field>
          {form.role === "Location" && (
            <Field label="Location scope (Rule 38 — server-enforced)">
              <select multiple className={inputCls + " h-32"} value={form.location_scope ?? []}
                onChange={(e) => set("location_scope", [...e.target.selectedOptions].map((o) => o.value))}>
                {locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}
              </select>
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!form.can_edit} onChange={(e) => set("can_edit", e.target.checked)} /> Can edit (off = view only, Rule 39)</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active ?? true} onChange={(e) => set("active", e.target.checked)} /> Active</label>
          <Btn onClick={save} disabled={!form.name || !form.email || (!edit && !form.password)}>{edit ? "Save" : "Add User"}</Btn>
        </div>
      </Drawer>
    </Section>
  );
}

function SyncSources({ setError }: any) {
  const [items, setItems] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ frequency: "Manual only" });
  const [mapping, setMapping] = useState("");
  const [edit, setEdit] = useState<any>(null);
  const [running, setRunning] = useState("");
  const [result, setResult] = useState("");

  const load = () => api("/api/sync-sources").then((d) => setItems(d.items)).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, []);

  function open(s?: any) {
    setEdit(s ?? null);
    setForm(s ?? { frequency: "Manual only" });
    setMapping(s ? JSON.stringify(s.field_mappings ?? {}, null, 2) : '{\n  "Center ID": "external_id",\n  "Status": "approval_status",\n  "Target": "approved_target:PROG1"\n}');
  }
  async function save() {
    try {
      const json = { ...form, field_mappings: JSON.parse(mapping) };
      if (edit) await api(`/api/sync-sources/${edit._id}`, { method: "PATCH", json });
      else await api("/api/sync-sources", { method: "POST", json });
      setEdit(null); setForm({ frequency: "Manual only" }); load();
    } catch (e: any) { setError(e.message.includes("JSON") ? "Field mappings must be valid JSON" : e.message); }
  }
  async function run(id: string) {
    setRunning(id); setResult("");
    try {
      const r = await api(`/api/sync-sources/${id}/run`, { method: "POST" });
      setResult(`Status ${r.status}: ${r.created} changes detected${r.error ? " — " + r.error : ""}`);
      load();
    } catch (e: any) { setError(e.message); }
    setRunning("");
  }

  return (
    <div className="space-y-4">
      <Section title="Sync sources (external sheets — Rules 1–2)">
        {result && <p className="mb-2 rounded bg-blue-50 px-3 py-2 text-sm text-blue-700">{result}</p>}
        <DataTable rows={items} onRowClick={open}
          cardTitle={(r: any) => r.name}
          columns={[
            { key: "name", label: "Name" },
            { key: "source_url", label: "URL", render: (r: any) => <span className="block max-w-64 truncate text-xs">{r.source_url}</span> },
            { key: "frequency", label: "Frequency" },
            { key: "last_synced_at", label: "Last sync", render: (r: any) => fmtDate(r.last_synced_at) },
            { key: "last_status", label: "Status", render: (r: any) => <Chip value={r.last_status} /> },
            { key: "_run", label: "", render: (r: any) => <Btn small disabled={running === r._id} onClick={() => run(r._id)}>{running === r._id ? "Syncing…" : "Sync Now"}</Btn> },
          ]} empty="No sync source configured yet — add the SDP sheet CSV URL when access is available." />
        {items.some((i) => i.last_error) && (
          <p className="mt-2 text-xs text-red-600">Last error: {items.find((i) => i.last_error)?.last_error}</p>
        )}
      </Section>
      <Section title={edit ? `Edit ${edit.name}` : "Add sync source"}>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Name" required><input className={inputCls} value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="CSV URL (Google Sheet export link)" required><input className={inputCls} value={form.source_url ?? ""} onChange={(e) => setForm({ ...form, source_url: e.target.value })} placeholder="https://docs.google.com/spreadsheets/d/…/export?format=csv&gid=…" /></Field>
          <Field label="Frequency">
            <select className={inputCls} value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
              <option>Manual only</option><option>Daily</option>
            </select>
          </Field>
        </div>
        <Field label='Field mappings (JSON: "Sheet Column" → erp_field; one column must map to external_id; targets as "approved_target:<PROGRAM_CODE>")'>
          <textarea className={inputCls + " mt-1 h-40 font-mono text-xs"} value={mapping} onChange={(e) => setMapping(e.target.value)} />
        </Field>
        <div className="mt-2 flex gap-2">
          <Btn onClick={save} disabled={!form.name || !form.source_url}>{edit ? "Save" : "Add source"}</Btn>
          {edit && <Btn kind="ghost" onClick={() => open()}>New</Btn>}
        </div>
      </Section>
    </div>
  );
}

// RPL M24 — which actions need a second person, and the queue of requests waiting.
// Everything ships OFF: with no switch enabled the app behaves exactly as before.
function Approvals({ setError }: any) {
  const [config, setConfig] = useState<any[]>([]);
  const [items, setItems] = useState<any[]>([]);
  const [status, setStatus] = useState("Pending");
  const [note, setNote] = useState<Record<string, string>>({});

  const load = () => api(`/api/approvals?status=${status}`).then((d) => { setConfig(d.config); setItems(d.items); })
    .catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, [status]);

  async function toggle(action: string, enabled: boolean, approver_role?: string) {
    try { await api("/api/approvals", { method: "PUT", json: { action, enabled, approver_role } }); load(); }
    catch (e: any) { setError(e.message); }
  }
  async function decide(id: string, decision: string) {
    try { await api(`/api/approvals/${id}`, { method: "POST", json: { decision, note: note[id] } }); load(); }
    catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      <Section title="Which actions need a second person's approval">
        <p className="mb-3 text-sm text-gray-500">
          All off by default. Turn one on and that action stops applying immediately — it is parked
          for the chosen role to approve. An initiator can never approve their own request.
        </p>
        <ul className="divide-y">
          {config.map((c) => (
            <li key={c.action} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <span className="text-sm font-medium">{APPROVAL_LABELS[c.action] ?? c.action}</span>
              <div className="flex items-center gap-3">
                <select className="rounded-lg border border-gray-300 px-2 py-1 text-sm" value={c.approver_role}
                  onChange={(e) => toggle(c.action, c.enabled, e.target.value)}>
                  {["Admin", "Operations"].map((r) => <option key={r}>{r}</option>)}
                </select>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={c.enabled} onChange={(e) => toggle(c.action, e.target.checked, c.approver_role)} />
                  {c.enabled ? "Approval required" : "Off"}
                </label>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <Section title={`Requests — ${items.length}`} actions={
        <select className="rounded-lg border border-gray-300 px-2 py-1 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
          {["Pending", "Approved", "Rejected", "all"].map((s) => <option key={s}>{s}</option>)}
        </select>
      }>
        {items.length === 0 ? <p className="text-sm text-gray-400">Nothing waiting.</p> : (
          <ul className="space-y-2">
            {items.map((r) => (
              <li key={r._id} className="rounded-lg border px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">{r.summary}</div>
                    <div className="text-xs text-gray-500">
                      {r.location?.name ? `${r.location.name} · ` : ""}requested by {r.initiator?.name} · {new Date(r.createdAt).toLocaleString("en-IN")}
                      {r.decided_by?.name ? ` · decided by ${r.decided_by.name}` : ""}
                    </div>
                  </div>
                  <Chip value={r.status} />
                </div>
                {r.status === "Pending" && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <input className={inputCls + " max-w-72"} placeholder="Note (optional)"
                      value={note[r._id] ?? ""} onChange={(e) => setNote({ ...note, [r._id]: e.target.value })} />
                    <Btn small onClick={() => decide(r._id, "Approved")}>Approve &amp; apply</Btn>
                    <Btn small kind="danger" onClick={() => decide(r._id, "Rejected")}>Reject</Btn>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function MasterLists({ setError }: any) {
  const [lists, setLists] = useState<any>({ "cost-categories": [], "drop-reasons": [] });
  const [names, setNames] = useState<any>({});

  const load = () => Promise.all(
    Object.keys(lists).map((l) => api(`/api/master-lists/${l}`).then((d) => ({ l, items: d.items }))),
  ).then((rs) => setLists(Object.fromEntries(rs.map((r) => [r.l, r.items])))).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function add(list: string) {
    try { await api(`/api/master-lists/${list}`, { method: "POST", json: { name: names[list] } }); setNames({ ...names, [list]: "" }); load(); }
    catch (e: any) { setError(e.message); }
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {Object.entries(lists).map(([list, items]: any) => (
        <Section key={list} title={list === "cost-categories" ? "Cost Categories" : "Drop Reasons"}>
          <ul className="mb-3 flex flex-wrap gap-1.5">
            {items.map((i: any) => <li key={i._id} className="rounded-full bg-gray-100 px-3 py-1 text-xs">{i.name}</li>)}
          </ul>
          <div className="flex gap-2">
            <input className={inputCls} placeholder="New entry…" value={names[list] ?? ""} onChange={(e) => setNames({ ...names, [list]: e.target.value })} />
            <Btn small onClick={() => add(list)} disabled={!names[list]}>Add</Btn>
          </div>
        </Section>
      ))}
    </div>
  );
}

function DefaultsTab({ setError }: any) {
  const [form, setForm] = useState<any>(null);
  useEffect(() => { api("/api/defaults").then((d) => setForm(d.item)).catch((e: any) => setError(e.message)); }, []);
  async function save() {
    try { await api("/api/defaults", { method: "PUT", json: form }); }
    catch (e: any) { setError(e.message); }
  }
  if (!form) return null;
  const FIELDS: [string, string][] = [
    ["batch_size", "Default batch size"], ["duration_days", "Duration days"], ["buffer_days", "Buffer days"],
    ["completion_deadline_days", "Completion deadline days"], ["mobilisation_lead_days", "Mobilisation lead days"],
    ["attendance_gap_amber", "Attendance gap amber (pts)"], ["attendance_gap_red", "Attendance gap red (pts)"],
    ["daily_log_edit_window_hours", "Daily log edit window (hrs)"], ["max_concurrent_batches", "Max concurrent batches"],
    ["enrollment_threshold_pct", "Enrollment threshold for start (%)"],
  ];
  return (
    <Section title="Planning defaults (§8)" actions={<Btn small onClick={save}>Save</Btn>}>
      <div className="grid gap-3 md:grid-cols-3">
        {FIELDS.map(([k, label]) => (
          <Field key={k} label={label}>
            <input type="number" className={inputCls} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: +e.target.value })} />
          </Field>
        ))}
      </div>
    </Section>
  );
}
