"use client";
import { Fragment, useEffect, useState } from "react";
import { api, fmtDate } from "@/lib/client";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, Section, Tabs, inputCls } from "@/components/ui";

const TABS = ["Programs", "Users & Access", "Permissions", "Sync Source", "Approvals", "Master Lists", "Defaults"];

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
      {tab === "Permissions" && <Permissions setError={setError} />}
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

  // 2026-08-11 (CEO): self-signups queue here until an Admin approves them.
  const pending = items.filter((u) => u.approval_status === "Pending");
  async function decide(u: any, approval: "approve" | "reject") {
    try {
      await api(`/api/users/${u._id}`, { method: "PATCH", json: { approval } });
      load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <Section title="Users & Access" actions={<Btn small onClick={() => open()}>Add User</Btn>}>
      {pending.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="mb-2 text-sm font-semibold text-amber-800">🔔 {pending.length} signup{pending.length > 1 ? "s" : ""} awaiting approval</div>
          <ul className="space-y-2">
            {pending.map((u) => (
              <li key={u._id} className="flex flex-wrap items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm">
                <span className="font-medium">{u.name}</span>
                <span className="text-gray-500">{u.email}{u.phone ? ` · ${u.phone}` : ""}</span>
                <Chip value={u.requested_role ?? u.role} />
                {(u.location_scope ?? []).length > 0 && <span className="text-xs text-gray-500">wants: {(u.location_scope ?? []).map((l: any) => l.name ?? l.code).join(", ")}</span>}
                <span className="ml-auto flex gap-1.5">
                  <Btn small kind="ghost" onClick={() => open(u)}>Review & edit…</Btn>
                  <Btn small onClick={() => decide(u, "approve")}>Approve</Btn>
                  <Btn small kind="danger" onClick={() => decide(u, "reject")}>Reject</Btn>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-amber-700">"Review &amp; edit…" lets you correct the role/scope before approving. Approval activates the account; the role's toggled rights (Permissions tab) apply immediately.</p>
        </div>
      )}
      <DataTable rows={items.filter((u) => u.approval_status !== "Pending")} onRowClick={open}
        cardTitle={(r: any) => r.name}
        columns={[
          { key: "name", label: "Name" },
          { key: "email", label: "Email" },
          { key: "role", label: "Role", render: (r: any) => <Chip value={r.role} /> },
          { key: "location_scope", label: "Scope", render: (r: any) => ["Location", "Trainer"].includes(r.role) ? (r.location_scope ?? []).map((l: any) => l.name ?? l.code).join(", ") || "none" : "All" },
          { key: "can_edit", label: "Can edit", render: (r: any) => (r.can_edit ? "Yes" : "View only") },
          { key: "extra_permissions", label: "Special rights", render: (r: any) => (r.extra_permissions ?? []).length ? `${r.extra_permissions.length} extra` : "—", mobile: false },
          { key: "active", label: "Active", render: (r: any) => (r.active ? "Yes" : r.approval_status === "Rejected" ? "Rejected" : "No") },
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
              {["Admin", "Operations", "Location", "Enrollment", "Trainer"].map((r) => <option key={r}>{r}</option>)}
            </select>
          </Field>
          {["Location", "Trainer"].includes(form.role) && (
            <Field label="Location scope (Rule 38 — server-enforced)">
              <select multiple className={inputCls + " h-32"} value={form.location_scope ?? []}
                onChange={(e) => set("location_scope", [...e.target.selectedOptions].map((o) => o.value))}>
                {locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}
              </select>
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!form.can_edit} onChange={(e) => set("can_edit", e.target.checked)} /> Can edit (off = view only, Rule 39)</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active ?? true} onChange={(e) => set("active", e.target.checked)} /> Active</label>
          {/* 2026-08-11 (CEO): "किसी को special देने तो admin दे पाएगा" */}
          {edit && <SpecialGrants form={form} set={set} />}
          {edit?.approval_status === "Pending" && (
            <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <Btn onClick={async () => { try { await api(`/api/users/${edit._id}`, { method: "PATCH", json: { ...form, password: form.password || undefined, approval: "approve" } }); setDrawer(false); load(); } catch (e: any) { setError(e.message); } }}>Approve with these settings</Btn>
              <Btn kind="danger" onClick={async () => { try { await api(`/api/users/${edit._id}`, { method: "PATCH", json: { approval: "reject" } }); setDrawer(false); load(); } catch (e: any) { setError(e.message); } }}>Reject</Btn>
            </div>
          )}
          <Btn onClick={save} disabled={!form.name || !form.email || (!edit && !form.password)}>{edit ? "Save" : "Add User"}</Btn>
        </div>
      </Drawer>
    </Section>
  );
}

// Per-user special grants on top of the role's toggled set (2026-08-11, CEO).
function SpecialGrants({ form, set }: any) {
  const [catalog, setCatalog] = useState<any[]>([]);
  useEffect(() => { api("/api/permissions").then((d) => setCatalog(d.catalog)).catch(() => {}); }, []);
  if (!catalog.length) return null;
  const extra: string[] = form.extra_permissions ?? [];
  const toggle = (key: string) =>
    set("extra_permissions", extra.includes(key) ? extra.filter((k) => k !== key) : [...extra, key]);
  return (
    <details className="rounded-lg border border-gray-200 p-3">
      <summary className="cursor-pointer text-sm font-medium">Special rights ({extra.length} granted) — on top of the role's set</summary>
      <div className="mt-2 grid gap-1.5 md:grid-cols-2">
        {catalog.map((p) => (
          <label key={p.key} className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={extra.includes(p.key)} onChange={() => toggle(p.key)} />
            <span><b>{p.group}</b> · {p.label}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

// Permission matrix (2026-08-11, CEO — AWS-style group toggles): each role is a group;
// tick which feature-rights it carries. Applies within seconds, no re-login needed.
function Permissions({ setError }: any) {
  const [catalog, setCatalog] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [saving, setSaving] = useState("");

  const load = () => api("/api/permissions").then((d) => { setCatalog(d.catalog); setRoles(d.roles); }).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function toggle(role: string, key: string) {
    const r = roles.find((x) => x.role === role);
    if (!r) return;
    const next = r.permissions.includes(key) ? r.permissions.filter((k: string) => k !== key) : [...r.permissions, key];
    setSaving(role + key);
    try {
      await api("/api/permissions", { method: "PUT", json: { role, permissions: next } });
      load();
    } catch (e: any) { setError(e.message); }
    setSaving("");
  }

  const groups = [...new Set(catalog.map((p) => p.group))];
  const editableRoles = roles.filter((r) => r.role !== "Admin");

  return (
    <Section title="Role permissions — what each role's group can do">
      <p className="mb-3 text-sm text-gray-500">
        Tick a box to grant that right to everyone in the role; untick to revoke. Admin always has everything.
        Individual users can get <b>special rights</b> on top via Users &amp; Access → open the user.
        The key control the CEO asked for — <b>who approves sheet changes</b> — is the first row.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-gray-500">
              <th className="py-2 pr-3">Right</th>
              {editableRoles.map((r) => <th key={r.role} className="px-2 py-2 text-center">{r.role}</th>)}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g}>
                <tr className="bg-gray-50"><td colSpan={1 + editableRoles.length} className="px-2 py-1.5 text-xs font-semibold text-gray-600">{g}</td></tr>
                {catalog.filter((p) => p.group === g).map((p) => (
                  <tr key={p.key} className="border-b border-gray-100">
                    <td className="py-1.5 pr-3">{p.label}</td>
                    {editableRoles.map((r) => (
                      <td key={r.role} className="px-2 py-1.5 text-center">
                        <input type="checkbox" disabled={saving === r.role + p.key}
                          checked={r.permissions.includes(p.key)}
                          onChange={() => toggle(r.role, p.key)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
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
      const json = {
        ...form,
        field_mappings: form.mode === "watch" ? {} : JSON.parse(mapping),
        key_columns: typeof form.key_columns === "string"
          ? form.key_columns.split(",").map((s: string) => s.trim()).filter(Boolean)
          : form.key_columns,
      };
      if (edit) await api(`/api/sync-sources/${edit._id}`, { method: "PATCH", json });
      else await api("/api/sync-sources", { method: "POST", json });
      setEdit(null); setForm({ frequency: "Manual only" }); load();
    } catch (e: any) { setError(e.message.includes("JSON") ? "Field mappings must be valid JSON" : e.message); }
  }
  async function run(id: string) {
    setRunning(id); setResult("");
    try {
      const r = await api(`/api/sync-sources/${id}/run`, { method: "POST" });
      setResult(r.tabs !== undefined
        ? `Status ${r.status}: ${r.changes} cell change(s) across ${r.tabs} tab(s)${r.error ? " — " + r.error : ""}`
        : `Status ${r.status}: ${r.created} changes detected${r.error ? " — " + r.error : ""}`);
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
            { key: "mode", label: "Mode", render: (r: any) => r.mode === "watch" ? <span className="rounded-full border border-purple-200 bg-purple-50 px-2 py-0.5 text-[11px] font-semibold text-purple-700">Watch · {r.interval_minutes ?? 30}m</span> : <span className="text-xs text-gray-500">Mapped</span> },
            { key: "source_url", label: "URL", render: (r: any) => <span className="block max-w-64 truncate text-xs">{r.source_url}</span> },
            { key: "frequency", label: "Frequency", mobile: false },
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
          <Field label="URL (CSV export, xlsx, or OneDrive share link)" required><input className={inputCls} value={form.source_url ?? ""} onChange={(e) => setForm({ ...form, source_url: e.target.value })} placeholder="https://… (OneDrive share links work as-is)" /></Field>
          <Field label="Mode">
            <select className={inputCls} value={form.mode ?? "mapped"} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
              <option value="mapped">Mapped (writes review queue for Location fields)</option>
              <option value="watch">Watch (track every tab & cell — Sheet Watch)</option>
            </select>
          </Field>
        </div>
        {form.mode === "watch" ? (
          <div className="mt-3 grid gap-3 md:grid-cols-3">
            <Field label="Poll every (minutes)">
              <input type="number" className={inputCls} value={form.interval_minutes ?? 30} onChange={(e) => setForm({ ...form, interval_minutes: +e.target.value })} />
            </Field>
            <Field label="Row identity columns (comma-separated)">
              <input className={inputCls}
                value={Array.isArray(form.key_columns) ? form.key_columns.join(", ") : form.key_columns ?? ""}
                onChange={(e) => setForm({ ...form, key_columns: e.target.value })}
                placeholder="Institution Name, Job role" />
            </Field>
          </div>
        ) : (
          <>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <Field label="Frequency">
                <select className={inputCls} value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
                  <option>Manual only</option><option>Daily</option>
                </select>
              </Field>
            </div>
            <Field label='Field mappings (JSON: "Sheet Column" → erp_field; one column must map to external_id; targets as "approved_target:<PROGRAM_CODE>")'>
              <textarea className={inputCls + " mt-1 h-40 font-mono text-xs"} value={mapping} onChange={(e) => setMapping(e.target.value)} />
            </Field>
          </>
        )}
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
  // 2026-08-11 meeting tunables
  const ELIGIBILITY: [string, string][] = [
    ["min_age", "Minimum age"], ["max_age", "Maximum age"], ["training_cooldown_months", "Training cooldown (months)"],
  ];
  const LEADS: [string, string][] = [
    ["lead_trainer_found_days", "Trainer identified (days before start)"],
    ["lead_tot_done_days", "TOT done (days before start)"],
    ["lead_mobilization_days", "Mobilization done (days before start)"],
    ["lead_trainer_ready_days", "Trainer ready (days before start)"],
    ["lead_enrollment_days", "Registration & enrollment done (days before start)"],
  ];
  return (
    <div className="space-y-4">
      <Section title="Planning defaults (§8)" actions={<Btn small onClick={save}>Save</Btn>}>
        <div className="grid gap-3 md:grid-cols-3">
          {FIELDS.map(([k, label]) => (
            <Field key={k} label={label}>
              <input type="number" className={inputCls} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: +e.target.value })} />
            </Field>
          ))}
        </div>
      </Section>
      <Section title="Candidate eligibility (2026-08-11)" actions={<Btn small onClick={save}>Save</Btn>}>
        <div className="grid gap-3 md:grid-cols-3">
          {ELIGIBILITY.map(([k, label]) => (
            <Field key={k} label={label}>
              <input type="number" className={inputCls} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: +e.target.value })} />
            </Field>
          ))}
          <Field label="Min daily photo/video uploads">
            <input type="number" className={inputCls} value={form.min_daily_evidence ?? ""} onChange={(e) => setForm({ ...form, min_daily_evidence: +e.target.value })} />
          </Field>
          <Field label="SIDH portal URL">
            <input className={inputCls} value={form.sidh_url ?? ""} onChange={(e) => setForm({ ...form, sidh_url: e.target.value })} />
          </Field>
        </div>
      </Section>
      <Section title="Backward batch plan — lead times (2026-08-11)" actions={<Btn small onClick={save}>Save</Btn>}>
        <div className="grid gap-3 md:grid-cols-3">
          {LEADS.map(([k, label]) => (
            <Field key={k} label={label}>
              <input type="number" className={inputCls} value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: +e.target.value })} />
            </Field>
          ))}
        </div>
      </Section>
    </div>
  );
}
