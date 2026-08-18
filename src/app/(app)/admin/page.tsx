"use client";
import { Fragment, useEffect, useState } from "react";
import { api, fmtDT, fmtDate } from "@/lib/client";
import { emailError } from "@/lib/validate";
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
  // Deep links land here from notifications ("New signup awaiting approval" → ?tab=Users),
  // so the query parameter has to choose the tab — it was previously ignored and every
  // link dropped the user on Programs. Prefixes match so ?tab=Users finds "Users & Access".
  // Read the query in an effect, not the initializer: the server renders "Programs" and a
  // window-dependent initial state made every deep link a hydration mismatch (React #418,
  // seen in the production console on /admin?tab=Users, 2026-08-13).
  const [tab, setTab] = useState("Programs");
  useEffect(() => {
    const want = new URLSearchParams(window.location.search).get("tab");
    const match = TABS.find((t) => t === want)
      ?? TABS.find((t) => want && t.toLowerCase().startsWith(want.toLowerCase()));
    if (match) setTab(match);
  }, []);
  const [error, setError] = useState("");
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Admin</h1>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === "Programs" && <Programs error={error} setError={setError} />}
      {tab === "Users & Access" && <Users error={error} setError={setError} />}
      {tab === "Permissions" && <Permissions error={error} setError={setError} />}
      {tab === "Sync Source" && <SyncSources error={error} setError={setError} />}
      {tab === "Approvals" && <Approvals error={error} setError={setError} />}
      {tab === "Master Lists" && <MasterLists error={error} setError={setError} />}
      {tab === "Defaults" && <DefaultsTab error={error} setError={setError} />}
    </div>
  );
}

function Programs({ error, setError }: any) {
  const [items, setItems] = useState<any[]>([]);
  const [drawer, setDrawer] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));

  const load = () => api("/api/programs?limit=1000").then((d) => setItems(d.items)).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, []);
  // QA-118: the job-roles master feeds the skill input as suggestions (free text stays
  // allowed — legacy programmes carry skills the master may not list yet).
  const [jobRoles, setJobRoles] = useState<any[]>([]);
  useEffect(() => { api("/api/master-lists/job-roles").then((d) => setJobRoles(d.items ?? [])).catch(() => {}); }, []);

  function open(p?: any) {
    setEdit(p ?? null);
    setForm(p ?? { duration_days: 15, buffer_days: 5, default_batch_size: 45, completion_deadline_days: 90, requires_lab: false, active: true }); // -117 (M4-09): 45
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
        defaultSort={{ key: "name", dir: "asc" }}
        columns={[
          { key: "code", label: "Code", sortable: true },
          { key: "name", label: "Name", sortable: true },
          // 2026-08-13 (Manish): the same job role exists once per SCHEME — never show one without the other.
          { key: "scheme", label: "Scheme", sortable: true, filterable: true, render: (r: any) => r.scheme ? <Chip value={r.scheme} /> : <span className="text-gray-400">—</span> },
          { key: "default_batch_size", label: "Batch size", sortable: true },
          { key: "duration_days", label: "Duration (d)", sortable: true },
          { key: "buffer_days", label: "Buffer (d)" },
          { key: "completion_deadline_days", label: "Deadline (d)" },
          { key: "trainer_skill", label: "Trainer skill", sortable: true },
          // QA-093: the assessment bar is derived from this. Empty is not neutral — it silently
          // becomes duration_days × 8, and then × the Defaults percentage. Say so where it is fixable.
          { key: "hours", label: "QP hours", sortable: true,
            filterText: (r: any) => (r.hours ? String(r.hours) : "not set"),
            render: (r: any) => r.hours
              ? <span className="tabular-nums">{r.hours}</span>
              : <span className="cursor-help text-amber-700"
                  title={`Not set, so the assessment bar is being derived: ${r.duration_days ?? 15} days × 8 hours = ${(r.duration_days ?? 15) * 8} hours, then the Defaults attendance percentage. Neither number comes from the scheme — enter the QP hours here and the bar becomes the real one.`}>
                  not set → assuming {(r.duration_days ?? 15) * 8}h
                </span> },
          { key: "requires_lab", label: "Lab?", filterText: (r: any) => (r.requires_lab ? "Yes" : "No"), render: (r: any) => (r.requires_lab ? "Yes" : "No") },
          { key: "active", label: "Active", filterText: (r: any) => (r.active ? "Active" : "Closed"), render: (r: any) => <Chip value={r.active ? "Active" : "Closed"} /> },
        ]} empty="No programs — every computed value depends on these." />
      <Drawer error={error} open={drawer} onClose={() => setDrawer(false)} title={edit ? `Edit ${edit.name}` : "Add Program"}>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Code" required><input className={inputCls} value={form.code ?? ""} onChange={(e) => set("code", e.target.value)} /></Field>
            <Field label="Name" required><input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></Field>
          </div>
          <Field label="Trainer skill (matched to Trainer.skills)" required>
            <input className={inputCls} list="job-roles-master" value={form.trainer_skill ?? ""} onChange={(e) => set("trainer_skill", e.target.value)} />
            <datalist id="job-roles-master">{jobRoles.map((j: any) => <option key={j._id} value={j.name} />)}</datalist>
          </Field>
          {/* R-H (CEO [02:56-03:14]): the scheme/job-role master carries its own basic data —
              scheme, QP training hours (drives the assessment-qualification threshold), and
              the amount we receive, which the API shows to Admin alone.
              QA-093: while `hours` is blank the threshold is derived from duration × 8 AND the
              Defaults percentage, so neither half of it comes from the scheme. That sentence belongs
              on screen, not in this comment — see the note under the input below. */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Scheme">
              <select className={inputCls} value={form.scheme ?? ""} onChange={(e) => set("scheme", e.target.value || undefined)}>
                <option value="">—</option>
                {["RPL-AVPL", "RPL-HSL", "PMKVY-BECIL", "DDU-GKY2.0", "DDUGKY 2.0 SPH"].map((s) => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="QP training hours">
              <input type="number" className={inputCls} value={form.hours ?? ""} onChange={(e) => set("hours", e.target.value === "" ? undefined : +e.target.value)} />
              <span className={`mt-0.5 block text-[11px] ${form.hours ? "text-gray-400" : "text-amber-700"}`}>
                Drives &ldquo;qualified for assessments&rdquo; (min-attendance % × these hours).
                {form.hours
                  ? " This programme carries its own figure, so the bar is the scheme's."
                  : ` Blank, so the bar is being ASSUMED: ${(form.duration_days ?? 15)} days × 8 hours = ${(form.duration_days ?? 15) * 8}, then the Defaults percentage. Neither half comes from the scheme.`}
              </span>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Duration days"><input type="number" className={inputCls} value={form.duration_days ?? ""} onChange={(e) => set("duration_days", +e.target.value)} /></Field>
            <Field label="Buffer days"><input type="number" className={inputCls} value={form.buffer_days ?? ""} onChange={(e) => set("buffer_days", +e.target.value)} /></Field>
            <Field label="Default batch size"><input type="number" className={inputCls} value={form.default_batch_size ?? ""} onChange={(e) => set("default_batch_size", +e.target.value)} /></Field>
            <Field label="Completion deadline days"><input type="number" className={inputCls} value={form.completion_deadline_days ?? ""} onChange={(e) => set("completion_deadline_days", +e.target.value)} /></Field>
          </div>
          {/* -115 (QA-221 / Manish 17/08 M4-12: "इनएक्टिव करने का मेरे को ऑप्शन दे दीजिए"): the model
              has carried `active` all along and this table has shown an Active/Closed chip for it —
              but nothing could ever set it, so a wrong or retired course stayed in every dropdown
              forever. Retiring is not deleting: batches, candidates and targets point at the
              programme and history must keep reading. */}
          <Field label="Status">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.active !== false} onChange={(e) => set("active", e.target.checked)} />
              <span>{form.active !== false ? "Active — offered when creating batches, candidates and targets" : "Retired — hidden from those pickers; existing batches, candidates and targets keep it"}</span>
            </label>
          </Field>
          <Field label="Amount we receive (₹ — Admin-only, masked for every other login)">
            <input type="number" className={inputCls} value={form.contract_amount ?? ""} onChange={(e) => set("contract_amount", e.target.value === "" ? undefined : +e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!form.requires_lab} onChange={(e) => set("requires_lab", e.target.checked)} /> Requires Lab</label>
          {/* 2026-08-12 (Manish): experience certificates are mandatory PER JOB ROLE to qualify
              for TVP. Aadhaar/PAN/Photo/CV/Educational Qualification always apply; ticks here add
              to that floor for trainers nominated to this job role. */}
          <Field label="Extra mandatory trainer documents (on top of the standard five)">
            <div className="grid gap-1.5 md:grid-cols-2">
              {["CIPSA Certificate", "Industry Experience", "Teaching Experience", "Other"].map((d) => (
                <label key={d} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={(form.mandatory_trainer_docs ?? []).includes(d)}
                    onChange={() => {
                      const cur: string[] = form.mandatory_trainer_docs ?? [];
                      set("mandatory_trainer_docs", cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]);
                    }} />
                  {d}
                </label>
              ))}
            </div>
          </Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active ?? true} onChange={(e) => set("active", e.target.checked)} /> Active</label>
          <Btn onClick={save} disabled={!form.code || !form.name || !form.trainer_skill}>{edit ? "Save" : "Add Program"}</Btn>
        </div>
      </Drawer>
    </Section>
  );
}

function Users({ error, setError }: any) {
  const [items, setItems] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [drawer, setDrawer] = useState(false);
  const [edit, setEdit] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));

  const load = () => Promise.all([
    api("/api/users").then((d) => setItems(d.items)),
    api("/api/locations?limit=2000").then((d) => setLocations(d.items)),
  ]).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, []);

  function open(u?: any) {
    setEdit(u ?? null);
    setForm(u ? { ...u, location_scope: (u.location_scope ?? []).map((l: any) => l._id ?? l), password: "" } : { role: "Location", can_edit: false, active: true, location_scope: [] });
    setDrawer(true);
  }
  // QA-141 rider (-72): in-flight guard against double-submit.
  const [savingU, setSavingU] = useState(false);
  async function save() {
    if (savingU) return;
    setSavingU(true);
    try {
      const json = { ...form };
      if (!json.password) delete json.password;
      if (edit) await api(`/api/users/${edit._id}`, { method: "PATCH", json });
      else await api("/api/users", { method: "POST", json });
      setDrawer(false); load();
    } catch (e: any) { setError(e.message); }
    setSavingU(false);
  }

  // 2026-08-11 (CEO): self-signups queue here until an Admin approves them.
  const pending = items.filter((u) => u.approval_status === "Pending");
  async function decide(u: any, approval: "approve" | "reject") {
    try {
      await api(`/api/users/${u._id}`, { method: "PATCH", json: { approval } });
      load();
    } catch (e: any) { setError(e.message); }
  }

  // QA-137 (Umesh, 15/08): "Divya ne aaj kya kiya" — a per-person activity drawer, fed by the
  // Admin-only /api/audit/by-user route. Works for dropped accounts too: backtracking is the
  // whole point, and the dropped are exactly who you backtrack.
  const [act, setAct] = useState<any>(null);
  const [actRows, setActRows] = useState<any[]>([]);
  const [actTotal, setActTotal] = useState(0);
  async function openActivity(u: any) {
    try {
      const d = await api(`/api/audit/by-user/${u._id}?limit=200`);
      setActRows(d.items ?? []); setActTotal(d.total ?? 0); setAct(u);
    } catch (e: any) { setError(e.message); }
  }

  // 15/08 (Umesh): DROP — soft delete. History and created-data stay; login dies; the email
  // frees up so a new account can be made. Hidden by default behind a "Show dropped" toggle.
  const [showDropped, setShowDropped] = useState(false);
  const droppedCount = items.filter((u) => u.dropped).length;
  async function dropUser(u: any) {
    if (!window.confirm(`Are you sure? ${u.name} will be DROPPED — they cannot sign in anymore, but the logs keep their history and everything they created stays. You can create a new account with the same email afterwards.`)) return;
    try {
      await api(`/api/users/${u._id}`, { method: "PATCH", json: { drop: true } });
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
      {droppedCount > 0 && (
        <label className="mb-2 flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={showDropped} onChange={(e) => setShowDropped(e.target.checked)} />
          Show dropped ({droppedCount})
        </label>
      )}
      <DataTable rows={items.filter((u) => u.approval_status !== "Pending" && (showDropped || !u.dropped))} onRowClick={(r: any) => { if (!r.dropped) open(r); }}
        cardTitle={(r: any) => r.name}
        defaultSort={{ key: "name", dir: "asc" }}
        columns={[
          { key: "name", label: "Name", sortable: true, render: (r: any) => r.dropped ? <span className="text-gray-400 line-through">{r.name}</span> : r.name },
          { key: "email", label: "Email", sortable: true, render: (r: any) => r.dropped ? <span className="text-gray-400">{r.dropped_email ?? r.email} (dropped)</span> : r.email },
          { key: "role", label: "Role", sortable: true, render: (r: any) => <Chip value={r.role} /> },
          { key: "location_scope", label: "Scope", filterText: (r: any) => ["Location", "Trainer"].includes(r.role) ? (r.location_scope ?? []).map((l: any) => l.name ?? l.code).join(", ") || "none" : "All", render: (r: any) => ["Location", "Trainer"].includes(r.role) ? (r.location_scope ?? []).map((l: any) => l.name ?? l.code).join(", ") || "none" : "All" },
          { key: "can_edit", label: "Can edit", filterText: (r: any) => (r.can_edit ? "Yes" : "View only"), render: (r: any) => (r.can_edit ? "Yes" : "View only") },
          {
            // QA-073: name the rights, not just a count — the cell says which, on hover too.
            key: "extra_permissions", label: "Special rights", mobile: false,
            filterText: (r: any) => [...(r.extra_permissions ?? []), ...(r.revoked_permissions ?? []).map((p: string) => `-${p}`)].join(" "),
            render: (r: any) => {
              const extra: string[] = r.extra_permissions ?? [];
              const revoked: string[] = r.revoked_permissions ?? [];
              if (!extra.length && !revoked.length) return "—";
              return (
                <span title={[extra.length ? `granted: ${extra.join(", ")}` : "", revoked.length ? `removed: ${revoked.join(", ")}` : ""].filter(Boolean).join(" · ")}>
                  {extra.length ? <span className="text-green-700">+{extra.length}</span> : null}
                  {extra.length && revoked.length ? " · " : null}
                  {revoked.length ? <span className="text-red-700">−{revoked.length}</span> : null}
                  <span className="ml-1 text-[10px] text-gray-400">{[...extra.map((p) => p.split(".")[0]), ...revoked.map((p) => p.split(".")[0])].slice(0, 3).join(", ")}{extra.length + revoked.length > 3 ? "…" : ""}</span>
                </span>
              );
            },
          },
          { key: "active", label: "Active", filterText: (r: any) => (r.active ? "Yes" : r.approval_status === "Rejected" ? "Rejected" : "No"), render: (r: any) => (r.active ? "Yes" : r.approval_status === "Rejected" ? "Rejected" : "No") },
          {
            // CEO 14/08 [35:13]: "we should be able to stop access to certain people if need
            // be … right away" — one click on the row, no drawer hunt. API guards apply
            // (Admin-only, never yourself), so the button only renders where it can succeed.
            key: "_stop", label: "", mobile: false,
            render: (r: any) => r.approval_status === "Pending" ? null : (
              <span onClick={(e) => e.stopPropagation()} className="flex gap-1.5">
                {!r.dropped && (
                  <>
                    <Btn small kind={r.active ? "danger" : "ghost"}
                      onClick={async () => {
                        try { await api(`/api/users/${r._id}`, { method: "PATCH", json: { active: !r.active } }); load(); }
                        catch (err: any) { setError(err.message); }
                      }}>{r.active ? "Stop access" : "Reactivate"}</Btn>
                    {/* 15/08 (Umesh): drop = terminal soft-delete with a plain-words confirm. */}
                    <Btn small kind="ghost" onClick={() => dropUser(r)}>Drop…</Btn>
                  </>
                )}
                {/* QA-137: the per-person trail — dropped accounts included, that's the point. */}
                <Btn small kind="ghost" onClick={() => openActivity(r)}>Activity</Btn>
              </span>
            ),
          },
        ]} empty="No users." />
      {/* QA-137: "what did this person do" — read-only, Admin-only, latest 200 actions. */}
      <Drawer error={error} open={!!act} onClose={() => setAct(null)} title={act ? `Activity — ${act.name}` : ""}>
        <p className="mb-2 text-xs text-gray-500">
          {actTotal} recorded action{actTotal === 1 ? "" : "s"} in the audit log{actTotal > 200 ? " (latest 200 shown)" : ""}.
        </p>
        {actRows.length === 0 ? <p className="text-sm text-gray-400">No activity recorded for this account.</p> : (
          <ul className="divide-y text-sm">
            {actRows.map((a: any) => (
              <li key={a._id} className="py-2">
                <span className="text-xs text-gray-400">{fmtDT(a.created_at)} · {a.entity}</span>
                <div>{a.field ?? "event"}: <span className="text-gray-500">{JSON.stringify(a.old_value)} → {JSON.stringify(a.new_value)}</span></div>
              </li>
            ))}
          </ul>
        )}
      </Drawer>
      <Drawer error={error} open={drawer} onClose={() => setDrawer(false)} title={edit ? `Edit ${edit.name}` : "Add User"}>
        <div className="space-y-3">
          <Field label="Name" required><input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></Field>
          {/* QA-141: a mistyped login email is an account nobody can ever mail or reset. */}
          <Field label="Email" required>
            <input type="email" className={inputCls} value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} />
            {form.email && emailError(form.email) && <p className="mt-1 text-xs text-red-600">{emailError(form.email)}</p>}
          </Field>
          <Field label={edit ? "New password (blank = unchanged)" : "Password"} required={!edit}>
            <input type="password" className={inputCls} value={form.password ?? ""} onChange={(e) => set("password", e.target.value)} />
          </Field>
          <Field label="Role (the preset profile — its toggled rights apply on sign-in)">
            <select className={inputCls} value={form.role} onChange={(e) => set("role", e.target.value)}>
              {["Admin", "Operations", "Location", "Enrollment", "Trainer"].map((r) => <option key={r}>{r}</option>)}
            </select>
            <RolePresetSummary role={form.role} />
          </Field>
          {["Location", "Trainer"].includes(form.role) && (
            <Field label="Which centres this account can see">
              <select multiple className={inputCls + " h-32"} value={form.location_scope ?? []}
                onChange={(e) => set("location_scope", [...e.target.selectedOptions].map((o) => o.value))}>
                {locations.map((l) => <option key={l._id} value={l._id} title={l.name}>{l.name}</option>)}
              </select>
              {/* 2026-08-12: an approved Trainer/Location user with no scope signs in to a
                  completely empty app and cannot tell why. Say so at the moment of approval. */}
              {(form.location_scope ?? []).length === 0 && (
                <p className="mt-1 text-xs font-medium text-amber-700">
                  ⚠ No location selected — this user will sign in and see no locations, batches or candidates at all. Pick at least one.
                </p>
              )}
            </Field>
          )}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!form.can_edit} onChange={(e) => set("can_edit", e.target.checked)} /> Can edit (off = view only)</label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active ?? true} onChange={(e) => set("active", e.target.checked)} /> Active</label>
          {/* 2026-08-11 (CEO): "किसी को special देने तो admin दे पाएगा" */}
          {edit && <SpecialGrants form={form} set={set} />}
          {edit && <RevokedRights form={form} set={set} />}
          {edit?.approval_status === "Pending" && (
            <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3">
              <Btn onClick={async () => { try { await api(`/api/users/${edit._id}`, { method: "PATCH", json: { ...form, password: form.password || undefined, approval: "approve" } }); setDrawer(false); load(); } catch (e: any) { setError(e.message); } }}>Approve with these settings</Btn>
              <Btn kind="danger" onClick={async () => { try { await api(`/api/users/${edit._id}`, { method: "PATCH", json: { approval: "reject" } }); setDrawer(false); load(); } catch (e: any) { setError(e.message); } }}>Reject</Btn>
            </div>
          )}
          <Btn onClick={save} disabled={savingU || !form.name || !form.email || !!emailError(form.email) || (!edit && !form.password)}>{savingU ? "Saving…" : edit ? "Save" : "Add User"}</Btn>
        </div>
      </Drawer>
    </Section>
  );
}

// QA-073 (CEO [34:59] "preset profiles"): show what the chosen profile actually carries,
// at the moment of choosing it — the matrix tab remains where it is edited.
function RolePresetSummary({ role }: { role?: string }) {
  const [roles, setRoles] = useState<any[]>([]);
  useEffect(() => { api("/api/permissions").then((d) => setRoles(d.roles ?? [])).catch(() => {}); }, []);
  if (!role || role === "Admin") return role === "Admin" ? <p className="mt-1 text-[11px] text-gray-500">Admin bypasses the matrix — every right, always.</p> : null;
  const set = roles.find((r) => r.role === role)?.permissions ?? [];
  return (
    <p className="mt-1 text-[11px] text-gray-500" title={set.join(", ") || "no rights toggled"}>
      This profile carries <b>{set.length}</b> right{set.length === 1 ? "" : "s"}{set.length ? `: ${set.slice(0, 4).map((p: string) => p.split(".").pop()).join(", ")}${set.length > 4 ? "…" : ""}` : ""} — adjust per-user below after saving, or per-role on the Permissions tab.
    </p>
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

  // 2026-08-12: granting a trusted person everything meant ticking sixteen boxes one at a time.
  // Select all does it in one, and unticks the same way; the box shows a dash while only some
  // are granted, so it never claims a state that isn't true.
  const allKeys = catalog.map((p) => p.key);
  const allOn = allKeys.length > 0 && allKeys.every((k) => extra.includes(k));
  const someOn = !allOn && allKeys.some((k) => extra.includes(k));

  return (
    <details className="rounded-lg border border-gray-200 p-3">
      <summary className="cursor-pointer text-sm font-medium">Special rights ({extra.length} granted) — on top of the role's set</summary>
      <label className="mt-2 flex items-center gap-2 border-b border-gray-200 pb-2 text-xs font-semibold">
        <input
          type="checkbox"
          checked={allOn}
          ref={(el) => { if (el) el.indeterminate = someOn; }}
          onChange={() => set("extra_permissions", allOn ? [] : allKeys)}
        />
        <span>Select all — grant every right ({allKeys.length})</span>
      </label>
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

// CEO 14/08 [35:07]: "give them additional rights OR REMOVE the rights" — the deny half.
// A ticked right here is taken away from THIS user even though their role (or an extra
// grant) carries it. Deny wins; pointless on an Admin, whose role bypasses every check.
function RevokedRights({ form, set }: any) {
  const [catalog, setCatalog] = useState<any[]>([]);
  useEffect(() => { api("/api/permissions").then((d) => setCatalog(d.catalog)).catch(() => {}); }, []);
  if (!catalog.length || form.role === "Admin") return null;
  const revoked: string[] = form.revoked_permissions ?? [];
  const toggle = (key: string) =>
    set("revoked_permissions", revoked.includes(key) ? revoked.filter((k) => k !== key) : [...revoked, key]);
  return (
    <details className="rounded-lg border border-red-200 p-3">
      <summary className="cursor-pointer text-sm font-medium text-red-700">Removed rights ({revoked.length}) — taken away from this user, wins over the role</summary>
      <div className="mt-2 grid gap-1.5 md:grid-cols-2">
        {catalog.map((p) => (
          <label key={p.key} className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={revoked.includes(p.key)} onChange={() => toggle(p.key)} />
            <span><b>{p.group}</b> · {p.label}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

// Permission matrix (2026-08-11, CEO — AWS-style group toggles): each role is a group;
// tick which feature-rights it carries. Applies within seconds, no re-login needed.
function Permissions({ error, setError }: any) {
  const [catalog, setCatalog] = useState<any[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [saving, setSaving] = useState("");

  const load = () => api("/api/permissions").then((d) => { setCatalog(d.catalog); setRoles(d.roles); }).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, []);

  // QA-025 P1: a cell is none / view / edit now. Encoding stays backward-compatible — a
  // bare key means edit (its meaning since day one), "key:view" is the new middle level.
  const levelOf = (r: any, key: string) =>
    r.permissions.includes(key) ? "edit" : r.permissions.includes(`${key}:view`) ? "view" : "none";
  async function setLevel(role: string, key: string, level: string) {
    const r = roles.find((x) => x.role === role);
    if (!r) return;
    const next = r.permissions.filter((k: string) => k !== key && k !== `${key}:view` && k !== `${key}:edit`);
    if (level === "edit") next.push(key);
    if (level === "view") next.push(`${key}:view`);
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
        Each cell is <b>—</b> (no access), <b>view</b> (read-only where the screen supports it) or <b>edit</b> (full right).
        Admin always has everything. Individual users can get <b>special rights</b> on top via Users &amp; Access → open the user.
        The key control the CEO asked for — <b>who approves sheet changes</b> — is the first row.
        View-level enforcement is live on the finance screens (costs, invoices, approvals queue); more screens join phase by phase.
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
                    {editableRoles.map((r) => {
                      const lv = levelOf(r, p.key);
                      return (
                        <td key={r.role} className="px-2 py-1.5 text-center">
                          <select disabled={saving === r.role + p.key}
                            className={`rounded border px-1 py-0.5 text-xs ${lv === "edit" ? "border-green-300 bg-green-50 text-green-800" : lv === "view" ? "border-blue-300 bg-blue-50 text-blue-800" : "border-gray-200 bg-gray-50 text-gray-400"}`}
                            value={lv} onChange={(e) => setLevel(r.role, p.key, e.target.value)}>
                            <option value="none">—</option>
                            <option value="view">view</option>
                            <option value="edit">edit</option>
                          </select>
                        </td>
                      );
                    })}
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

function SyncSources({ error, setError }: any) {
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
      <Section title="Sync sources (external sheets)">
        {result && <p className="mb-2 rounded bg-blue-50 px-3 py-2 text-sm text-blue-700">{result}</p>}
        <DataTable rows={items} onRowClick={open}
          cardTitle={(r: any) => r.name}
          columns={[
            { key: "name", label: "Name", sortable: true },
            { key: "mode", label: "Mode", render: (r: any) => r.mode === "watch" ? <span className="rounded-full border border-purple-200 bg-purple-50 px-2 py-0.5 text-[11px] font-semibold text-purple-700">Watch · {r.interval_minutes ?? 30}m</span> : <span className="text-xs text-gray-500">Mapped</span> },
            { key: "source_url", label: "URL", render: (r: any) => <span className="block max-w-64 truncate text-xs" title={r.source_url}>{r.source_url}</span> },
            // QA-168 (second half): a watch source polls on interval_minutes regardless of its stored
            // frequency — showing "Manual only" here is what misled the QA-166 diagnosis. Say what it does.
            { key: "frequency", label: "Frequency", mobile: false, render: (r: any) => r.mode === "watch" ? `Every ${r.interval_minutes ?? 30} min (auto)` : (r.frequency ?? "—") },
            { key: "last_synced_at", label: "Last sync", sortable: true, sortValue: (r: any) => r.last_synced_at ? new Date(r.last_synced_at).getTime() : null, render: (r: any) => fmtDT(r.last_synced_at) },
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
function Approvals({ error, setError }: any) {
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
                      {r.location?.name ? `${r.location.name} · ` : ""}requested by {r.initiator?.name} · {fmtDT(r.createdAt)}
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

function MasterLists({ error, setError }: any) {
  // QA-118/119 (15/08): job roles and schemes join the editable masters. Schemes carry
  // the hours-and-money facts (Manish's data) that make the assessment threshold honest.
  const [lists, setLists] = useState<any>({ "cost-categories": [], "drop-reasons": [], "job-roles": [], "schemes": [] });
  const [names, setNames] = useState<any>({});
  const TITLES: Record<string, string> = { "cost-categories": "Cost Categories", "drop-reasons": "Drop Reasons", "job-roles": "Job Roles", "schemes": "Schemes (hours & amount)" };

  const load = () => Promise.all(
    Object.keys(lists).map((l) => api(`/api/master-lists/${l}`).then((d) => ({ l, items: d.items }))),
  ).then((rs) => setLists(Object.fromEntries(rs.map((r) => [r.l, r.items])))).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function add(list: string) {
    try { await api(`/api/master-lists/${list}`, { method: "POST", json: { name: names[list] } }); setNames({ ...names, [list]: "" }); load(); }
    catch (e: any) { setError(e.message); }
  }
  async function saveScheme(id: string, patch: any) {
    try { await api(`/api/master-lists/schemes/${id}`, { method: "PATCH", json: patch }); load(); }
    catch (e: any) { setError(e.message); }
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {Object.entries(lists).map(([list, items]: any) => (
        <Section key={list} title={TITLES[list] ?? list}>
          {list === "schemes" ? (
            <div className="mb-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-gray-500">
                  <th className="py-1 pr-2">Scheme</th><th className="py-1 pr-2">Total hrs</th><th className="py-1 pr-2">Min hrs</th><th className="py-1 pr-2">Amount (₹)</th><th></th>
                </tr></thead>
                <tbody>
                  {items.map((s: any) => <SchemeRow key={s._id} s={s} onSave={saveScheme} />)}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-gray-500">Min ÷ total hours sets the assessment threshold for that scheme's batches; blank = the Defaults percentage applies.</p>
            </div>
          ) : (
            <ul className="mb-3 flex flex-wrap gap-1.5">
              {items.map((i: any) => <li key={i._id} className="rounded-full bg-gray-100 px-3 py-1 text-xs">{i.name}</li>)}
            </ul>
          )}
          <div className="flex gap-2">
            <input className={inputCls} placeholder="New entry…" value={names[list] ?? ""} onChange={(e) => setNames({ ...names, [list]: e.target.value })} />
            <Btn small onClick={() => add(list)} disabled={!names[list]}>Add</Btn>
          </div>
        </Section>
      ))}
    </div>
  );
}

function SchemeRow({ s, onSave }: { s: any; onSave: (id: string, patch: any) => void }) {
  const [f, setF] = useState<any>({ total_hours: s.total_hours ?? "", min_required_hours: s.min_required_hours ?? "", amount_received: s.amount_received ?? "" });
  const dirty = String(f.total_hours) !== String(s.total_hours ?? "") || String(f.min_required_hours) !== String(s.min_required_hours ?? "") || String(f.amount_received) !== String(s.amount_received ?? "");
  const cell = "w-20 rounded border border-gray-200 px-2 py-1 text-sm";
  return (
    <tr className="border-t border-gray-100">
      <td className="py-1.5 pr-2 font-medium">{s.name}</td>
      <td className="py-1.5 pr-2"><input type="number" className={cell} value={f.total_hours} onChange={(e) => setF({ ...f, total_hours: e.target.value })} /></td>
      <td className="py-1.5 pr-2"><input type="number" className={cell} value={f.min_required_hours} onChange={(e) => setF({ ...f, min_required_hours: e.target.value })} /></td>
      <td className="py-1.5 pr-2"><input type="number" className={cell} value={f.amount_received} onChange={(e) => setF({ ...f, amount_received: e.target.value })} /></td>
      <td className="py-1.5">{dirty && <Btn small onClick={() => onSave(s._id, f)}>Save</Btn>}</td>
    </tr>
  );
}

function DefaultsTab({ error, setError }: any) {
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
    // 2026-08-13 parity: two of the seven planner milestones had no knob here — the API
    // accepted them, so only script users could tune them.
    ["lead_trainer_ready_for_tot_days", "Trainer ready for TOT (days before start)"],
    ["lead_tot_start_days", "TOT begins (days before start)"],
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
          {/* Manish's evidence backup: RPL project → All Locations → District. The batch screen
              links here so the parallel Drive copy is one click from where evidence is entered. */}
          <Field label="Project Drive folder (evidence backup root)">
            <input className={inputCls} value={form.drive_root_url ?? ""} onChange={(e) => setForm({ ...form, drive_root_url: e.target.value })} placeholder="https://drive.google.com/drive/folders/…" />
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

      {/* -87 (QA-157, Umesh 15/08): every stored file passes one compression door; these are its
          numbers. Turn them after looking at ONE sample — faces and text must stay readable. */}
      <Section title="Media compression (-87)" actions={<Btn small onClick={save}>Save</Btn>}>
        <p className="mb-3 text-xs text-gray-500">
          Applied on the server to every upload (photos, scans, certificates) — no screen can bypass it. Faces and text must stay
          readable for the NSDC audit: change a value, upload one sample, look at it. Video is compressed on the device before upload (coming next).
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="Image longest edge (px)"><input type="number" min={800} max={4000} className={inputCls} value={form.image_max_px ?? ""} onChange={(e) => setForm({ ...form, image_max_px: +e.target.value })} /></Field>
          <Field label="Image quality (30–95)"><input type="number" min={30} max={95} className={inputCls} value={form.image_quality ?? ""} onChange={(e) => setForm({ ...form, image_quality: +e.target.value })} /></Field>
          <Field label="Compress PDFs (Ghostscript /ebook)">
            <select className={inputCls} value={form.pdf_compress === false ? "off" : "on"} onChange={(e) => setForm({ ...form, pdf_compress: e.target.value === "on" })}>
              <option value="on">On</option><option value="off">Off</option>
            </select>
          </Field>
          {/* -91: video is compressed ON THE DEVICE before upload (record in-app at these settings,
              or re-encode a gallery clip in the browser). ~11–12 MB per minute at 720p/1500 kbps. */}
          <Field label="Compress video on the device before upload">
            <select className={inputCls} value={form.video_compress === false ? "off" : "on"} onChange={(e) => setForm({ ...form, video_compress: e.target.value === "on" })}>
              <option value="on">On</option><option value="off">Off (upload as recorded)</option>
            </select>
          </Field>
          <Field label="Video max height (px)"><input type="number" min={360} max={1080} step={120} className={inputCls} value={form.video_max_height ?? ""} onChange={(e) => setForm({ ...form, video_max_height: +e.target.value })} /></Field>
          <Field label="Video bitrate (kbps)"><input type="number" min={400} max={8000} step={100} className={inputCls} value={form.video_bitrate_kbps ?? ""} onChange={(e) => setForm({ ...form, video_bitrate_kbps: +e.target.value })} /></Field>
          <Field label="Audio bitrate (kbps)"><input type="number" min={32} max={192} step={16} className={inputCls} value={form.video_audio_kbps ?? ""} onChange={(e) => setForm({ ...form, video_audio_kbps: +e.target.value })} /></Field>
        </div>
        <p className="mt-2 text-[11px] text-gray-500">Rule of thumb: 720p @ 1500 kbps ≈ 11–12 MB per minute and faces stay recognisable; 480p @ 800 kbps ≈ 6 MB per minute (max compression). Record ONE sample after changing and look at it.</p>
      </Section>

      {/* 2026-08-12 — Manish confirmed these against the scheme guidelines. They are settings
          rather than constants because a circular can move them without a deploy. */}
      <Section title="Scheme timing guidelines (Manish, 2026-08-12)" actions={<Btn small onClick={save}>Save</Btn>}>
        <p className="mb-3 text-xs text-gray-500">
          Batch time slots are validated against these. Confirmed: the day runs 9 to 6, a session may be up to
          4 hours, and two 4-hour batches a day is the sanctioned pattern (three 3-hour batches was refused).
          No minimum break between sessions is prescribed.
        </p>
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Day starts"><input type="time" className={inputCls} value={form.day_start_time ?? "09:00"} onChange={(e) => setForm({ ...form, day_start_time: e.target.value })} /></Field>
          <Field label="Day ends"><input type="time" className={inputCls} value={form.day_end_time ?? "18:00"} onChange={(e) => setForm({ ...form, day_end_time: e.target.value })} /></Field>
          <Field label="Max hours per session">
            <input type="number" className={inputCls} value={form.max_session_hours ?? ""} onChange={(e) => setForm({ ...form, max_session_hours: +e.target.value })} />
            {/* 2026-08-13 (Manish): slots are exactly 4 or 8 hours — that pair is enforced in code;
                this knob no longer drives slot validation and stays only for older documents. */}
            <span className="mt-0.5 block text-[11px] text-gray-400">Superseded: slots are validated as exactly 4 or 8 hours.</span>
          </Field>
          <Field label="Max sessions per day"><input type="number" className={inputCls} value={form.max_batches_per_day ?? ""} onChange={(e) => setForm({ ...form, max_batches_per_day: +e.target.value })} /></Field>
          <Field label="Max teaching hours per trainer per day"><input type="number" className={inputCls} value={form.max_daily_hours ?? ""} onChange={(e) => setForm({ ...form, max_daily_hours: +e.target.value })} /></Field>
          <Field label="Min attendance % for exam">
            <input type="number" className={inputCls} value={form.min_attendance_pct ?? 50} onChange={(e) => setForm({ ...form, min_attendance_pct: +e.target.value })} />
            <span className="mt-0.5 block text-[11px] text-gray-400">Of programme hours — e.g. 60 of 120 hrs at 50%. Drives the student attendance link.</span>
          </Field>
        </div>
      </Section>

      <Section title="Client contract & uploads (Manish, 2026-08-12)" actions={<Btn small onClick={save}>Save</Btn>}>
        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={form.absent_counts_as_appeared !== false}
              onChange={(e) => setForm({ ...form, absent_counts_as_appeared: e.target.checked })} />
            <span>
              <span className="font-medium">Absentees count towards “appeared”</span>
              <span className="block text-xs text-gray-500">Confirmed for the current client: an absentee is not deducted from the appeared figure. Untick only if a contract counts the other way.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={form.dropped_pass_is_billable === true}
              onChange={(e) => setForm({ ...form, dropped_pass_is_billable: e.target.checked })} />
            <span>
              <span className="font-medium">A candidate who dropped out but passed is billable</span>
              <span className="block text-xs text-gray-500">Confirmed off: their result is still kept, but it is excluded from the billable count.</span>
            </span>
          </label>
          {/* R-J (QA-049): the CEO's "enrolled = fees paid", as a switch — OFF for
              government-funded schemes where the candidate pays nothing. */}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={form.fee_required_for_enrollment === true}
              onChange={(e) => setForm({ ...form, fee_required_for_enrollment: e.target.checked })} />
            <span>
              <span className="font-medium">Enrollment requires the fee to be paid</span>
              <span className="block text-xs text-gray-500">On: enrollment cannot complete until a fee payment is recorded on the candidate. Off (default): the fee fields are informational.</span>
            </span>
          </label>
          {/* 15/08 (Umesh): app-side upload cap REMOVED entirely ("koi bhi cap nahi") — the
              knob is gone so nobody thinks the app is the limiter. The only limit left is the
              reverse proxy's body cap (infra, with devops to raise). */}
          <p className="text-xs text-gray-500">
            Upload size is not limited by the app. Very large files can still be refused by the web server in front of
            the app (its body-size cap is being raised by devops).
          </p>
          {/* QA-115: outbound email kill-switch. The transport itself is configured on the
              server (env) — this only mutes/unmutes sending without a redeploy. */}
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={form.email_enabled ?? true}
              onChange={(e) => setForm({ ...form, email_enabled: e.target.checked })} />
            <span>
              <span className="font-medium">Send emails (approvals, confirmations, team alerts)</span>
              <span className="block text-xs text-gray-500">Off: every send is skipped and recorded as skipped. Sending also stays off until the mail credentials are configured on the server.</span>
            </span>
          </label>
          <MailPanel error={error} setError={setError} />
        </div>
      </Section>
    </div>
  );
}

// QA-132 (checker, 15/08): mail attempts were logged but invisible — even the Admin had to
// call the API by hand to answer "mail gayi ki nahi". This panel is that answer, and it is
// honest about what SES can and cannot promise: "sent" means SES ACCEPTED the message; the
// system never learns about a bounce (that needs SNS hooks — devops). Labels say so.
// -97: the "where did it go" table — Admin-only list from /api/files (names/paths, never bytes).
function FilesPanel({ mb }: { mb: (n: number) => string }) {
  const [open, setOpen] = useState(false);
  const [prefix, setPrefix] = useState("");
  const [status, setStatus] = useState("");
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const load = async (pfx = prefix, st = status) => {
    setBusy(true);
    try { setData(await api(`/api/files?limit=100&prefix=${encodeURIComponent(pfx)}&status=${encodeURIComponent(st)}`)); }
    catch (e: any) { setData({ error: e.message }); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (open && !data) load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="mt-2 border-t border-current/20 pt-2 text-gray-800">
      <button type="button" className="text-left font-semibold underline-offset-2 hover:underline" onClick={() => setOpen((o) => !o)}>{open ? "▾" : "▸"} Files — where every upload lives</button>
      {open && (
        <div className="mt-1">
          <div className="text-[11px] text-gray-600">
            Objects are stored at <code>&lt;Centre&gt;/&lt;Batch&gt;/&lt;kind&gt;/&lt;file&gt;</code>{data?.bucket ? <> in bucket <b>{data.bucket}</b> (Vidysea's Google Cloud project) — <a className="text-blue-700 underline" href={data.console_url} target="_blank" rel="noreferrer">open the bucket in the Google Cloud console ↗</a></> : data?.backend ? <> on the <b>{data.backend}</b> backend</> : null}.
            The app serves them through <code>/api/files/&lt;name&gt;</code> (login + rights); nothing in the bucket is public.
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <input className="rounded border px-2 py-1" placeholder="folder prefix — e.g. AVP-GURU/AVP-GURU-RPLAVP-DST-02" value={prefix} onChange={(e) => setPrefix(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") load(); }} style={{ minWidth: 280 }} />
            <select className="rounded border px-2 py-1" value={status} onChange={(e) => { setStatus(e.target.value); load(prefix, e.target.value); }}>
              <option value="">all statuses</option><option value="ready">ready</option><option value="pending">pending</option><option value="failed">failed</option><option value="deleted">deleted</option>
            </select>
            <Btn small kind="ghost" disabled={busy} onClick={() => load()}>{busy ? "Loading…" : "Refresh"}</Btn>
            {data?.by_status && <span className="text-gray-500">{Object.entries(data.by_status).map(([k, v]: any) => `${k}: ${v.n} (${mb(v.bytes ?? 0)})`).join(" · ")}</span>}
          </div>
          {data?.error && <div className="mt-1 text-red-700">{data.error}</div>}
          {Array.isArray(data?.items) && (
            <div className="mt-1 max-h-72 overflow-auto rounded border bg-white">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-gray-50 text-left"><tr><th className="px-2 py-1">When</th><th className="px-2 py-1">Where</th><th className="px-2 py-1">File</th><th className="px-2 py-1">Size</th><th className="px-2 py-1">Compression</th><th className="px-2 py-1">By</th><th className="px-2 py-1">Status</th><th className="px-2 py-1"></th></tr></thead>
                <tbody>
                  {data.items.map((r: any) => (
                    <tr key={r.name} className={`border-t ${r.status === "deleted" ? "text-gray-400 line-through" : ""}`}>
                      <td className="whitespace-nowrap px-2 py-1">{new Date(r.created_at).toLocaleString()}</td>
                      <td className="px-2 py-1 font-mono">{r.folder_path ?? "—"}</td>
                      <td className="px-2 py-1">{(r.original_name ?? r.name).slice(0, 40)}</td>
                      <td className="whitespace-nowrap px-2 py-1">{mb(r.size ?? 0)}{r.original_size && r.original_size > (r.size ?? 0) ? ` (was ${mb(r.original_size)})` : ""}</td>
                      <td className="px-2 py-1">{r.compression ?? "—"}</td>
                      <td className="px-2 py-1">{r.uploaded_by ?? "—"}</td>
                      <td className="px-2 py-1">{r.status}{r.status === "deleted" && r.deleted_by ? ` by ${r.deleted_by}` : ""}</td>
                      <td className="whitespace-nowrap px-2 py-1">
                        {r.status === "ready" && <a className="text-blue-700 underline" href={r.url} target="_blank" rel="noreferrer">open</a>}
                        {r.console_url && <> · <a className="text-blue-700 underline" href={r.console_url} target="_blank" rel="noreferrer" title={r.object_path ?? ""}>folder in console ↗</a></>}
                      </td>
                    </tr>
                  ))}
                  {data.items.length === 0 && <tr><td className="px-2 py-2 text-gray-500" colSpan={8}>No files match.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MailPanel({ error, setError }: any) {
  const [mail, setMail] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [storageCheck, setStorageCheck] = useState<any>(null);
  const [comp, setComp] = useState<any>(null); // -87: compression tools + totals + last 20
  const loadMail = () => api("/api/test-email").then(setMail).catch((e: any) => setError(e.message));
  useEffect(() => { loadMail(); api("/api/test-storage").then(setComp).catch(() => setComp(null)); }, []);
  const mb = (n: number) => n >= 1024 * 1024 * 1024 ? `${(n / 1024 / 1024 / 1024).toFixed(2)} GB` : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
  const STATUS: Record<string, { label: string; cls: string }> = {
    sent: { label: "accepted by SES — delivery not confirmed", cls: "text-green-700" },
    failed: { label: "failed", cls: "text-red-700" },
    skipped: { label: "skipped", cls: "text-gray-500" },
    // QA-132 (-72): once devops points the SES SNS topic at /api/public/ses-notifications,
    // these two arrive on their own and a typo'd address stops looking like a success.
    bounced: { label: "BOUNCED — never delivered", cls: "text-red-700 font-semibold" },
    complained: { label: "marked as spam by the recipient", cls: "text-red-700" },
  };
  return (
    <div className="rounded-lg border p-3">
      {/* QA-145: evidence storage — the loud, honest state. Red until Drive is connected,
          because until then every upload is lost on the next deploy. */}
      {mail?.storage && (
        <div className={`mb-3 rounded-lg border px-3 py-2 text-xs ${mail.storage.configured ? "border-green-200 bg-green-50 text-green-800" : "border-red-300 bg-red-50 text-red-800"}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span><b>Evidence storage:</b> {mail.storage.configured ? (mail.storage.backend === "gcs" ? "Google Cloud Storage connected" : "Google Drive connected") : "NOT CONNECTED"} — {mail.storage.reason}</span>
            {/* QA-145 rider: one click proves the Drive path end to end (write probe → read back). */}
            <Btn small kind="ghost" disabled={busy || !mail.storage.configured} onClick={async () => {
              setBusy(true); setStorageCheck(null);
              try { setStorageCheck(await api("/api/test-storage", { method: "POST", json: {} })); }
              catch (e: any) { setStorageCheck({ ok: false, note: e.message }); } finally { setBusy(false); }
            }}>{busy ? "Checking…" : "Run storage check"}</Btn>
          </div>
          {storageCheck && (
            <div className={`mt-1 ${storageCheck.ok ? "text-green-800" : "text-red-800"}`}>
              {storageCheck.ok ? "✓" : "✗"} {storageCheck.note}{storageCheck.folder_path ? ` — ${storageCheck.folder_path}/ (id ${storageCheck.drive_file_id}, ${storageCheck.ms} ms)` : ""}
              {storageCheck.fix && <div className="mt-0.5"><b>Fix:</b> {storageCheck.fix}</div>}
              {/* -95: the ladder — one rung per thing that can break, so red says WHAT broke. */}
              {Array.isArray(storageCheck.steps) && storageCheck.steps.length > 0 && (
                <ol className="mt-1 space-y-0.5 font-mono text-[11px]">
                  {storageCheck.steps.map((s: any) => (
                    <li key={s.step}>{s.ok ? "✓" : "✗"} {s.step} · {s.ms} ms{!s.ok && typeof s.detail === "string" ? ` — ${s.detail}` : ""}{s.step === "cors" && s.ok ? ` — ${s.detail?.state}` : ""}{s.step === "session-put" && s.ok ? ` — HTTP ${s.detail?.status}` : ""}</li>
                  ))}
                </ol>
              )}
            </div>
          )}
          {/* -95: the bucket's immutable facts (checker 16/08) — location · uniform access · public
              access prevention · CORS. Anything off the expected values is called out in red. */}
          {(storageCheck?.bucket ?? comp?.bucket) && (() => { const b = storageCheck?.bucket ?? comp?.bucket; return (
            <div className="mt-1 text-[11px]">
              <b>Bucket {b.name}:</b> location {b.location ?? "?"} {b.location && b.location.toUpperCase() === b.expected?.location ? "✓" : "✗"} · uniform access {b.ubla === true ? "✓ on" : "✗ off"} · public access prevention {b.pap ?? "?"} {(b.pap ?? "").toLowerCase() === "enforced" ? "✓" : "✗"} · CORS {b.cors_ok ? `✓ ${(b.cors_origins ?? []).join(", ")}` : "✗ not yet"} · checked {new Date(b.checked_at).toLocaleString()}
              {(b.warnings ?? []).length > 0 && <div className="mt-0.5 text-red-700">⚠ {b.warnings.join(" ")}</div>}
            </div>
          ); })()}
          {/* -89: what the container actually holds (names, never values) — the fact that ends the
              ".env me daal diya" guesswork; screenshot this for devops. */}
          {comp?.env && !mail.storage.configured && (
            <div className="mt-2 border-t border-current/20 pt-2">
              <div><b>Why:</b> {comp.env.hint}</div>
              {comp.env.wif && (
                <div className="mt-1 text-[11px]">
                  WIF identity file: {comp.env.wif.present ? `✓ ${comp.env.wif.source}${comp.env.wif.impersonating ? ` → ${comp.env.wif.impersonating}` : ""}` : "✗ not present"} ·
                  AWS: region {comp.env.aws?.region ?? "—"} · task credentials endpoint {comp.env.aws?.container_creds ? "✓ (ECS)" : "✗"} · env {comp.env.aws?.execution_env ?? "—"}
                  {comp.aws_identity && <> · this container's AWS identity: {comp.aws_identity.arn ? <code className="rounded bg-white/60 px-1">{comp.aws_identity.arn}</code> : <span className="text-red-700">unknown ({comp.aws_identity.error})</span>}</>}
                </div>
              )}
              <details className="mt-1"><summary className="cursor-pointer">what this container sees (names only)</summary>
                <ul className="mt-1 columns-2 text-[11px] font-mono">
                  {Object.entries(comp.env.env_seen ?? {}).map(([k, v]: any) => (
                    <li key={k}>{v.present ? (v.length ? "✓" : "∅") : "✗"} {k}{v.present ? ` (${v.length ? `${v.length} chars` : "EMPTY"})` : ""}</li>
                  ))}
                  {(comp.env.other_names ?? []).map((o: any) => <li key={o.name}>? {o.name} ({o.length} chars) — not a name the app reads</li>)}
                </ul>
                <div className="mt-1 text-[11px]">✓ present with a value · ∅ present but empty · ✗ not in this container. Values are never shown.</div>
              </details>
            </div>
          )}
          {/* -87 (QA-157): what the compression door has done — tools present, totals, last 20 files. */}
          {comp && (
            <div className="mt-2 border-t border-current/20 pt-2 text-gray-800">
              <div>
                <b>Compression:</b> images {comp.tools?.sharp ? "✓ sharp" : "✗ sharp missing"} · PDFs {comp.tools?.gs ? "✓ Ghostscript" : "✗ Ghostscript missing (stored as-is, recorded)"}
                {comp.compression?.totals && <> · {comp.compression.totals.files} file{comp.compression.totals.files === 1 ? "" : "s"} · {mb(comp.compression.totals.stored ?? 0)} stored ({mb(comp.compression.totals.original ?? 0)} before) · {comp.compression.totals.compressed} compressed</>}
              </div>
              {(comp.compression?.recent ?? []).length > 0 && (
                <details className="mt-1"><summary className="cursor-pointer">last {comp.compression.recent.length} uploads</summary>
                  <ul className="mt-1 space-y-0.5">
                    {comp.compression.recent.map((r: any) => (
                      <li key={r._id} className="font-mono text-[11px]">{(r.original_name ?? "").slice(0, 40)} · {mb(r.original_size ?? r.size ?? 0)} → {mb(r.size ?? 0)} · {r.compression ?? "—"}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
          {/* -97 (Umesh: "server me kahan ja raha hai, kaise dekhen"): every stored file, where it
              lives (<Centre>/<Batch>/<kind>/<file>), who put it there, and a link to the same folder
              in the Google Cloud console. Deleted rows stay listed as the audit trail. */}
          <FilesPanel mb={mb} />
        </div>
      )}
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm font-medium">Mail — last 20 attempts</span>
        <span className="flex items-center gap-2">
          <span className={`text-xs ${mail?.configured ? "text-green-700" : "text-amber-700"}`}>
            {mail == null ? "…" : mail.configured ? "credentials configured" : "not configured on the server"}
          </span>
          <Btn small kind="ghost" disabled={busy || !mail?.configured} onClick={async () => {
            setBusy(true);
            try { await api("/api/test-email", { method: "POST", json: { send_to_self: true } }); await loadMail(); }
            catch (e: any) { setError(e.message); } finally { setBusy(false); }
          }}>{busy ? "Sending…" : "Send test mail to me"}</Btn>
        </span>
      </div>
      {(mail?.log ?? []).length === 0 ? (
        <p className="text-xs text-gray-400">No mail attempts recorded yet.</p>
      ) : (
        <ul className="divide-y text-xs">
          {(mail.log ?? []).map((m: any) => (
            <li key={m._id} className="flex flex-wrap items-baseline gap-2 py-1.5">
              <span className="text-gray-400">{fmtDT(m.createdAt)}</span>
              <span className="font-medium">{m.to}</span>
              <span className="text-gray-500">{m.subject}</span>
              <span className={`ml-auto ${STATUS[m.status]?.cls ?? ""}`}>{STATUS[m.status]?.label ?? m.status}{m.reason ? ` — ${m.reason}` : ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
