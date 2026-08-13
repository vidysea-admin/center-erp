"use client";
import { use, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, fmtDate, toInputDate } from "@/lib/client";
import { Btn, Chip, CopyBtn, DataTable, Drawer, ErrorBanner, Field, HealthBanner, NameCell, Section, Tabs, inputCls } from "@/components/ui";
import { Activity } from "@/components/activity";
import { flushQueue, getQueue, uploadWithRetry } from "@/lib/upload";
import { BASE_PATH } from "@/lib/base-path";
import { bulkSmsCsv, smsLink, waLink } from "@/lib/messaging";

const TABS = ["Overview", "Candidates", "Enrollment", "Daily Execution", "Closure", "Feedback", "Costs", "Activity"];

export default function BatchDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const sp = useSearchParams();
  const [tab, setTab] = useState(sp.get("tab") && TABS.includes(sp.get("tab")!) ? sp.get("tab")! : "Overview");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  const load = () => api(`/api/batches/${id}`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);

  if (!data) return <div className="p-8 text-center text-gray-400">{error || "Loading…"}</div>;
  const b = data.item;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{b.code}</h1>
        <Chip value={b.status} />
        <span className="text-sm text-gray-500">{b.program?.name} · {fmtDate(b.planned_start)} → {fmtDate(b.planned_end)}</span>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      <HealthBanner health={data.health} />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {tab === "Overview" && <Overview data={data} onChanged={load} setError={setError} />}
      {tab === "Candidates" && <Roster batchId={id} batch={b} setError={setError} onChanged={load} />}
      {tab === "Enrollment" && <Enrollment batchId={id} setError={setError} />}
      {tab === "Daily Execution" && <DailyExecution batchId={id} batch={b} setError={setError} />}
      {tab === "Closure" && <ClosureTab batchId={id} batch={b} setError={setError} onChanged={load} />}
      {tab === "Feedback" && <FeedbackTab batchId={id} setError={setError} />}
      {tab === "Costs" && <CostsTab batchId={id} batch={b} setError={setError} />}
      {tab === "Activity" && <Activity entity="Batch" id={id} />}
    </div>
  );
}

// ---------- Overview: readiness checklist (Rule 16) + transitions ----------
function Overview({ data, onChanged, setError }: any) {
  const b = data.item;
  const r = data.readiness;
  const [reason, setReason] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);

  async function transition(target: string) {
    try {
      await api(`/api/batches/${b._id}/transition`, { method: "POST", json: { target, reason } });
      setConfirmCancel(false); setReason(""); onChanged();
    } catch (e: any) { setError(e.message); }
  }

  const CHECKS: [string, string, boolean][] = [
    ["location_approved", "Location approved", r.checks.location_approved],
    ["room_assigned", "Room assigned (Lab if required)", r.checks.room_assigned],
    ["trainer_ready", "Trainer assigned & available", r.checks.trainer_ready],
    ["roster_80pct", `Roster ≥ 80% of target (${r.roster_count}/${b.target_size})`, r.checks.roster_80pct],
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* The count used to be hardcoded "/4" while five checks were rendered, so it silently
          excluded the enrollment gate — the one that actually blocks Start Batch (audit F-005). */}
      <Section title={`Readiness checklist (${CHECKS.filter(([, , v]) => v).length + (r.enrollment_ok ? 1 : 0)}/${CHECKS.length + 1})`}>
        <ul className="space-y-2 text-sm">
          {CHECKS.map(([k, label, ok]) => (
            <li key={k} className="flex items-center gap-2">
              <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${ok ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"}`}>{ok ? "✓" : "○"}</span>
              {label}
            </li>
          ))}
          <li className="flex items-center gap-2 border-t pt-2">
            <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${r.enrollment_ok ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"}`}>{r.enrollment_ok ? "✓" : "○"}</span>
            Enrolled ≥ threshold for start ({r.enrolled_count}/{r.enrollment_threshold})
          </li>
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">
          {b.status === "Planning" && <Btn onClick={() => transition("Ready")} disabled={!r.ready}>Mark Ready</Btn>}
          {b.status === "Ready" && <Btn onClick={() => transition("Active")}>Start Batch</Btn>}
          {b.status === "Ready" && <Btn kind="ghost" onClick={() => transition("Planning")}>Back to Planning</Btn>}
          {b.status === "Active" && <Btn onClick={() => transition("Closing")}>Move to Closing</Btn>}
          {b.status === "Closing" && <Btn onClick={() => transition("Completed")}>Complete Batch</Btn>}
          {["Planning", "Ready", "Active"].includes(b.status) && <Btn kind="danger" onClick={() => setConfirmCancel(true)}>Cancel Batch</Btn>}
        </div>
      </Section>
      <Section title="Details">
        <EditDetails b={b} onChanged={onChanged} setError={setError} />
      </Section>
      {(b.milestones?.length ?? 0) > 0 && (
        <Section title="Backward plan (2026-08-11)" actions={b.status === "Planning" ? (
          <Btn small kind="ghost" onClick={async () => {
            try { await api(`/api/batches/${b._id}/milestones`, { method: "PATCH", json: { regenerate: true } }); onChanged(); }
            catch (e: any) { setError(e.message); }
          }}>Regenerate</Btn>
        ) : undefined}>
          <ul className="space-y-2 text-sm">
            {b.milestones.map((m: any) => {
              const overdue = !m.done_on && m.due_date && new Date(m.due_date) < new Date(new Date().toDateString());
              return (
                <li key={m.key} className="flex items-center gap-2">
                  <input type="checkbox" checked={!!m.done_on}
                    disabled={["Completed", "Cancelled"].includes(b.status)}
                    onChange={async (e) => {
                      try { await api(`/api/batches/${b._id}/milestones`, { method: "PATCH", json: { key: m.key, done: e.target.checked } }); onChanged(); }
                      catch (err: any) { setError(err.message); }
                    }} />
                  <span className={m.done_on ? "text-gray-400 line-through" : ""}>{m.label}</span>
                  <span className={`ml-auto text-xs ${overdue ? "font-semibold text-red-600" : "text-gray-500"}`}>
                    due {fmtDate(m.due_date)}{overdue ? " — overdue" : ""}{m.done_on ? ` · done ${fmtDate(m.done_on)}` : ""}
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}
      <Drawer open={confirmCancel} onClose={() => setConfirmCancel(false)} title={`Cancel batch ${b.code}?`}>
        <div className="space-y-3">
          <p className="text-sm text-gray-600">This is destructive. Rule 19: a batch with daily logs can only be force-closed by Admin. Provide a reason.</p>
          <Field label="Reason" required><input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Btn kind="danger" onClick={() => transition("Cancelled")} disabled={!reason}>Confirm Cancel</Btn>
        </div>
      </Drawer>
    </div>
  );
}

function EditDetails({ b, onChanged, setError }: any) {
  const [trainers, setTrainers] = useState<any[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [allLocations, setAllLocations] = useState<any[]>([]);
  const [allPrograms, setAllPrograms] = useState<any[]>([]);
  const [form, setForm] = useState<any>({
    trainer: b.trainer?._id ?? "", room: b.room?._id ?? "", session: b.session,
    planned_start: toInputDate(b.planned_start), planned_end: toInputDate(b.planned_end), target_size: b.target_size,
    slot_start: b.slot_start ?? "", slot_end: b.slot_end ?? "",
    govt_batch_id: b.govt_batch_id ?? "", drive_folder_url: b.drive_folder_url ?? "",
    location: b.location?._id ?? b.location ?? "", program: b.program?._id ?? b.program ?? "",
  });
  const [driveRoot, setDriveRoot] = useState("");
  const planning = b.status === "Planning";
  useEffect(() => {
    api("/api/trainers?limit=2000").then((d) => setTrainers(d.items)).catch(() => {});
    const locId = b.location?._id ?? b.location;
    api(`/api/locations/${locId}/rooms`).then((d) => setRooms(d.items)).catch(() => {});
    api("/api/defaults").then((d) => setDriveRoot(d.item?.drive_root_url ?? "")).catch(() => {});
    if (planning) {
      api("/api/locations?limit=2000").then((d) => setAllLocations(d.items)).catch(() => {});
      api("/api/programs?limit=1000").then((d) => setAllPrograms(d.items)).catch(() => {});
    }
  }, [b]);

  async function save() {
    try {
      const json: any = { ...form, trainer: form.trainer || null, room: form.room || null };
      // location/program travel only when actually changed — otherwise every ordinary save on a
      // Planning batch with a roster would trip the empty-roster guard on the API.
      if (json.location === String(b.location?._id ?? b.location ?? "")) delete json.location;
      if (json.program === String(b.program?._id ?? b.program ?? "")) delete json.program;
      await api(`/api/batches/${b._id}`, { method: "PATCH", json });
      onChanged();
    } catch (e: any) { setError(e.message); }
  }

  const idOf = (v: any) => (v?._id ?? v) as string | undefined;
  const locId = idOf(b.location), progId = idOf(b.program);
  const eligible = (t: any) => {
    if (t.pipeline_status !== "Certified" || !t.tr_id) return false;
    const nomLoc = idOf(t.nominated_for_location), nomProg = idOf(t.nominated_for_program);
    if (nomLoc || nomProg) return nomLoc === locId && nomProg === progId;
    return (t.capable_locations ?? []).some((l: any) => idOf(l) === locId);
  };
  const certified = trainers.filter(eligible);
  const others = trainers.filter((t) => !eligible(t));

  return (
    <div className="space-y-3">
      {planning && (
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-amber-200 bg-amber-50/50 p-3">
          {/* Sheet-imported batches can carry a wrong fuzzy match for centre or job role.
              Correctable only while Planning with an empty roster — the API enforces the roster. */}
          <Field label="Location (correct a wrong import match)">
            <select className={inputCls} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })}>
              {allLocations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}
            </select>
          </Field>
          <Field label="Program / job role">
            <select className={inputCls} value={form.program} onChange={(e) => setForm({ ...form, program: e.target.value })}>
              {allPrograms.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
            </select>
          </Field>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        {/* Same TR-ID gate as batch creation — reassigning a trainer here must not quietly
            sidestep the rule the create drawer enforces. */}
        <Field label="Trainer">
          <select className={inputCls} value={form.trainer} onChange={(e) => setForm({ ...form, trainer: e.target.value })}>
            <option value="">—</option>
            {certified.length > 0 && (
              <optgroup label="Certified — has a TR ID and is cleared for this centre">
                {certified.map((t) => <option key={t._id} value={t._id}>{t.name} · TR {t.tr_id}</option>)}
              </optgroup>
            )}
            {others.length > 0 && (
              <optgroup label="Not yet certified — NSDC will not accept these on a batch">
                {others.map((t) => <option key={t._id} value={t._id}>{t.name} ({t.pipeline_status ?? t.status})</option>)}
              </optgroup>
            )}
          </select>
        </Field>
        <Field label="Room">
          <select className={inputCls} value={form.room} onChange={(e) => setForm({ ...form, room: e.target.value })}>
            <option value="">—</option>
            {rooms.map((r) => <option key={r._id} value={r._id}>{r.name} ({r.type})</option>)}
          </select>
        </Field>
        <Field label="Planned start"><input type="date" className={inputCls} value={form.planned_start} onChange={(e) => setForm({ ...form, planned_start: e.target.value })} /></Field>
        <Field label="Planned end"><input type="date" className={inputCls} value={form.planned_end} onChange={(e) => setForm({ ...form, planned_end: e.target.value })} /></Field>
        <Field label="Session">
          <select className={inputCls} value={form.session} onChange={(e) => setForm({ ...form, session: e.target.value })}>
            {["Full Day", "Morning", "Afternoon"].map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Target size"><input type="number" className={inputCls} value={form.target_size} onChange={(e) => setForm({ ...form, target_size: +e.target.value })} /></Field>
        <Field label="Time slot start"><input type="time" className={inputCls} value={form.slot_start} onChange={(e) => setForm({ ...form, slot_start: e.target.value })} /></Field>
        <Field label="Time slot end"><input type="time" className={inputCls} value={form.slot_end} onChange={(e) => setForm({ ...form, slot_end: e.target.value })} /></Field>
      </div>
      {/* The portal's own identifiers. Batch formation happens on SIDH, so the ERP has to hold
          the key that links our row to theirs — and the Drive folder Manish keeps in parallel
          with the NSDC upload, which is the only copy if the portal upload is ever questioned. */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Government batch ID (SIDH)">
          <input className={inputCls} value={form.govt_batch_id} placeholder="as shown on the portal"
            onChange={(e) => setForm({ ...form, govt_batch_id: e.target.value })} />
        </Field>
        <Field label="Drive evidence folder">
          <input className={inputCls} value={form.drive_folder_url} placeholder="https://drive.google.com/…"
            onChange={(e) => setForm({ ...form, drive_folder_url: e.target.value })} />
          {/* RPL project → All Locations → District — this batch's folder lives under here. */}
          {driveRoot && (
            <a href={form.drive_folder_url || driveRoot} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-blue-700 hover:underline">
              {form.drive_folder_url ? "Open this batch's folder ↗" : "Open the project Drive to create it ↗"}
            </a>
          )}
        </Field>
      </div>
      <div className="text-xs text-gray-500">Actual: {fmtDate(b.actual_start)} → {fmtDate(b.actual_end)}</div>
      <Btn onClick={save}>Save details</Btn>
    </div>
  );
}

// ---------- Candidates tab: roster ----------
function Roster({ batchId, batch, setError, onChanged }: any) {
  const [members, setMembers] = useState<any[]>([]);
  const [pool, setPool] = useState<any[]>([]);
  const [showPool, setShowPool] = useState(false);
  const [dropTarget, setDropTarget] = useState<any>(null);
  const [dropForm, setDropForm] = useState<any>({});
  const [dropReasons, setDropReasons] = useState<any[]>([]);
  const [attLinks, setAttLinks] = useState<any[] | null>(null);
  const [attBusy, setAttBusy] = useState(false);

  // 2026-08-13 (Manish): "bacche baar-baar puchte hain sir mera kitna ho gaya attendance" —
  // one capability link per active member, student sees their own days/hours/eligibility.
  async function generateAttendanceLinks() {
    setAttBusy(true);
    try {
      const res = await api("/api/public-tokens", { method: "POST", json: { purpose: "attendance", batch: batchId } });
      setAttLinks(res.items);
    } catch (e: any) { setError(e.message); }
    setAttBusy(false);
  }

  const load = () => Promise.all([
    api(`/api/batches/${batchId}/members`).then((d) => setMembers(d.items)),
    // 2026-08-13 (Manish hit this live — Prem Kumar/Lalit from another job role in the pool):
    // the pool is this location AND this job role. Program-less candidates (bulk imports)
    // stay eligible — they inherit the batch's programme on enrol; the server enforces both.
    api(`/api/candidates?location=${batch.location?._id ?? batch.location}&limit=2000`).then((d) =>
      setPool(d.items.filter((c: any) => ["Unassigned", "Dropped"].includes(c.lifecycle_status)
        && (!c.program || String(c.program?._id ?? c.program) === String(batch.program?._id ?? batch.program))))),
    api("/api/master-lists/drop-reasons").then((d) => setDropReasons(d.items)),
  ]).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, [batchId]);

  async function add(candidateId: string) {
    try { await api(`/api/batches/${batchId}/members`, { method: "POST", json: { candidate: candidateId } }); load(); onChanged(); }
    catch (e: any) { setError(e.message); }
  }
  async function drop() {
    try {
      await api(`/api/members/${dropTarget._id}/drop`, { method: "POST", json: dropForm });
      setDropTarget(null); setDropForm({}); load(); onChanged();
    } catch (e: any) { setError(e.message); }
  }

  const active = members.filter((m) => !m.left_on);
  return (
    <div className="space-y-4">
      <Section title={`Roster (${active.length} active / ${members.length} total)`} actions={
        <div className="flex items-center gap-2">
          <Btn small kind="ghost" disabled={attBusy} onClick={generateAttendanceLinks}>Attendance links</Btn>
          <Btn small onClick={() => setShowPool(true)}>Add from pool</Btn>
        </div>
      }>
        {attLinks && (
          <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
            <div className="mb-2 font-medium text-blue-800">One attendance link per candidate — student sees their own days, hours and exam eligibility:</div>
            <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
              {attLinks.map((t: any) => {
                const name = t.batch_member?.candidate?.name ?? "?";
                const phone = t.batch_member?.candidate?.phone;
                const url = `${window.location.origin}${BASE_PATH}/p/attendance/${t.token}`;
                const msg = `Namaste ${name}! Apni attendance aur exam eligibility yahan dekhein: ${url}`;
                const wa = waLink(phone, msg), sms = smsLink(phone, msg);
                return (
                  <li key={t._id ?? t.token} className="flex items-center gap-2">
                    <span className="font-medium">{name}</span>
                    <CopyBtn text={url} className="text-blue-700 hover:underline">copy link</CopyBtn>
                    {wa && <a className="text-green-700 hover:underline" href={wa} target="_blank" rel="noreferrer">WhatsApp</a>}
                    {sms && <a className="text-indigo-700 hover:underline" href={sms}>SMS</a>}
                    {!wa && <span className="text-gray-400">no mobile number</span>}
                  </li>
                );
              })}
            </ul>
            <button className="mt-2 text-xs font-medium text-indigo-700 hover:underline"
              onClick={() => {
                const targets = attLinks.map((t: any) => ({ name: t.batch_member?.candidate?.name, phone: t.batch_member?.candidate?.phone, url: `${window.location.origin}${BASE_PATH}/p/attendance/${t.token}` }));
                const csv = bulkSmsCsv(targets, (t: any) => `Namaste ${t.name}! Apni attendance aur exam eligibility yahan dekhein: ${t.url}`);
                const a = document.createElement("a");
                a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                a.download = "sms-attendance-links.csv"; a.click();
              }}>Download bulk SMS file</button>
          </div>
        )}
        <DataTable rows={members}
          cardTitle={(r: any) => r.candidate?.name}
          columns={[
            { key: "candidate", label: "Candidate", render: (r: any) => r.candidate?.name },
            { key: "phone", label: "Phone", render: (r: any) => r.candidate?.phone, mobile: false },
            { key: "joined_on", label: "Joined", render: (r: any) => fmtDate(r.joined_on) },
            { key: "enrollment_status", label: "Enrollment", render: (r: any) => <Chip value={r.enrollment_status} /> },
            {
              // GD-102: running attendance per candidate, from the daily logs.
              key: "attendance", label: "Attendance", render: (r: any) => r.attendance?.days_held
                ? <span className={`text-xs tabular-nums ${r.attendance.pct < 70 ? "font-semibold text-red-600" : "text-gray-700"}`}>
                    {r.attendance.present}/{r.attendance.days_held} ({r.attendance.pct}%)
                  </span>
                : <span className="text-xs text-gray-400">—</span>,
            },
            {
              // 2026-08-13: the portal's cumulative meter beside the internal one.
              key: "govt_attendance", label: "Govt days", mobile: false, render: (r: any) => r.govt_attendance
                ? <span className="text-xs tabular-nums text-gray-700">{r.govt_attendance.days_present}/{r.govt_attendance.working_days}</span>
                : <span className="text-xs text-gray-400">—</span>,
            },
            { key: "left_on", label: "Left", render: (r: any) => r.left_on ? `${fmtDate(r.left_on)} (${r.drop_reason})` : "—" },
            { key: "_act", label: "", render: (r: any) => !r.left_on ? <Btn small kind="ghost" onClick={() => setDropTarget(r)}>Drop</Btn> : null },
          ]} empty="No members yet — add from the candidate pool." />
      </Section>

      <Drawer open={showPool} onClose={() => setShowPool(false)} title="Candidate pool (this location)">
        <div className="space-y-2">
          {pool.map((c) => (
            <div key={c._id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
              <span>{c.name} <span className="text-gray-400">· {c.phone}</span></span>
              <Btn small onClick={() => add(c._id)}>Add</Btn>
            </div>
          ))}
          {pool.length === 0 && <p className="text-sm text-gray-400">No unassigned candidates at this location.</p>}
        </div>
      </Drawer>

      <Drawer open={!!dropTarget} onClose={() => setDropTarget(null)} title={`Drop ${dropTarget?.candidate?.name}?`}>
        <div className="space-y-3">
          <Field label="Left on" required><input type="date" className={inputCls} value={dropForm.left_on ?? ""} onChange={(e) => setDropForm({ ...dropForm, left_on: e.target.value })} /></Field>
          <Field label="Drop reason" required>
            <select className={inputCls} value={dropForm.drop_reason ?? ""} onChange={(e) => setDropForm({ ...dropForm, drop_reason: e.target.value })}>
              <option value="">Select…</option>
              {dropReasons.map((r) => <option key={r._id}>{r.name}</option>)}
            </select>
          </Field>
          <Btn kind="danger" onClick={drop} disabled={!dropForm.left_on || !dropForm.drop_reason}>Confirm Drop</Btn>
        </div>
      </Drawer>
    </div>
  );
}

// ---------- Enrollment worklist (phone-first; Rules 22–24) ----------
function Enrollment({ batchId, setError }: any) {
  const [members, setMembers] = useState<any[]>([]);
  const [idx, setIdx] = useState(0);

  const load = () => api(`/api/batches/${batchId}/members`).then((d) => setMembers(d.items.filter((m: any) => !m.left_on))).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, [batchId]);

  async function update(m: any, patch: any) {
    try {
      const res = await api(`/api/members/${m._id}`, { method: "PATCH", json: patch });
      setMembers((ms) => ms.map((x) => (x._id === m._id ? { ...x, ...res.item } : x)));
    } catch (e: any) { setError(e.message); }
  }

  const StepToggle = ({ m, field, label }: any) => (
    <button onClick={() => update(m, { [field]: !m[field] })}
      className={`rounded-lg border px-3 py-2 text-sm font-medium ${m[field] ? "border-green-300 bg-green-50 text-green-700" : "border-gray-300 bg-white text-gray-500"}`}>
      {m[field] ? "✓ " : ""}{label}
    </button>
  );

  const Card = ({ m }: any) => (
    <div className="space-y-3 rounded-xl border bg-white p-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-semibold">{m.candidate?.name}</div>
          <div className="text-sm text-gray-500">{m.candidate?.phone}</div>
        </div>
        <Chip value={m.enrollment_status} />
      </div>
      <div className="flex flex-wrap gap-2">
        <StepToggle m={m} field="reg_done" label="Registration" />
        <StepToggle m={m} field="kyc_done" label="e-KYC" />
        <StepToggle m={m} field="accept_done" label="Batch Accept" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" value={m.issue ?? ""}
          onChange={(e) => e.target.value ? update(m, { failed: true, issue: e.target.value }) : update(m, { failed: false, issue: null })}>
          <option value="">No issue</option>
          {["OTP not received", "Already registered", "KYC failed", "Portal error", "Duplicate", "Other"].map((i) => <option key={i}>{i}</option>)}
        </select>
        {m.enrollment_status === "Failed" && <Btn small kind="ghost" onClick={() => update(m, { failed: false, issue: null })}>Clear failure</Btn>}
        <span className="ml-auto text-xs text-gray-400">{m.source}</span>
      </div>
    </div>
  );

  if (!members.length) return <p className="p-6 text-center text-sm text-gray-400">No active members to enroll.</p>;
  const done = members.filter((m) => m.enrollment_status === "Completed").length;

  return (
    <div className="space-y-3">
      <div className="text-sm text-gray-600">{done}/{members.length} enrolled · Failed: {members.filter((m) => m.enrollment_status === "Failed").length}</div>
      {/* Desktop: all cards. Mobile: one at a time with prev/next (spec §0 Rule B) */}
      <div className="hidden gap-3 md:grid md:grid-cols-2 xl:grid-cols-3">
        {members.map((m) => <Card key={m._id} m={m} />)}
      </div>
      <div className="md:hidden">
        <Card m={members[Math.min(idx, members.length - 1)]} />
        <div className="mt-3 flex items-center justify-between">
          <Btn kind="ghost" onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0}>← Prev</Btn>
          <span className="text-sm text-gray-500">{idx + 1} / {members.length}</span>
          <Btn kind="ghost" onClick={() => setIdx((i) => Math.min(members.length - 1, i + 1))} disabled={idx >= members.length - 1}>Next →</Btn>
        </div>
      </div>
    </div>
  );
}

// ---------- Daily Execution (phone-first; Rules 26–33) ----------
function DailyExecution({ batchId, batch, setError }: any) {
  const [logs, setLogs] = useState<any[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ log_date: toInputDate(new Date()), present: new Set<string>(), photos: [], videos: [] });
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(0);
  const [editLog, setEditLog] = useState<any>(null);

  const load = () => Promise.all([
    api(`/api/batches/${batchId}/logs`).then((d) => setLogs(d.items)),
    api(`/api/batches/${batchId}/members`).then((d) => setMembers(d.items.filter((m: any) => !m.left_on))),
  ]).catch((e: any) => setError(e.message));
  useEffect(() => { load(); setQueued(getQueue().length); }, [batchId]);

  function togglePresent(id: string) {
    const s = new Set<string>(form.present);
    if (s.has(id)) s.delete(id); else s.add(id);
    setForm({ ...form, present: s });
  }

  async function uploadFile(file: File, kind: "photos" | "videos" | "govt_screenshot") {
    try {
      const url = await uploadWithRetry(file, kind); // compressed + 3 retries + offline queue
      if (kind === "photos") setForm((f: any) => ({ ...f, photos: [...f.photos, url] }));
      else if (kind === "videos") setForm((f: any) => ({ ...f, videos: [...f.videos, url] }));
      else setForm((f: any) => ({ ...f, govt_screenshot: url }));
    } catch (e: any) { setError(e.message); setQueued(getQueue().length); }
  }

  async function retryQueued() {
    const done = await flushQueue();
    for (const d of done) {
      if (d.kind === "photos") setForm((f: any) => ({ ...f, photos: [...f.photos, d.url] }));
      else if (d.kind === "videos") setForm((f: any) => ({ ...f, videos: [...f.videos, d.url] }));
      else setForm((f: any) => ({ ...f, govt_screenshot: d.url }));
    }
    setQueued(getQueue().length);
  }

  async function save() {
    setBusy(true);
    try {
      await api(`/api/batches/${batchId}/logs`, {
        method: "POST",
        json: {
          log_date: form.log_date,
          planned_topic: form.planned_topic, actual_topic: form.actual_topic,
          present_member_ids: [...form.present],
          trainer_present: form.trainer_present !== false, // default true; unticking blocks student marks (portal rule)
          govt_present: form.govt_present === "" || form.govt_present == null ? null : +form.govt_present,
          govt_screenshot: form.govt_screenshot,
          photos: form.photos, videos: form.videos, note: form.note,
        },
      });
      setForm({ log_date: toInputDate(new Date()), present: new Set(), photos: [], videos: [] });
      load();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  if (!["Active", "Closing"].includes(batch.status)) {
    return <p className="p-6 text-center text-sm text-gray-400">Daily logs open once the batch is Active.</p>;
  }

  return (
    <div className="space-y-4">
      <Section title="Today's entry">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date" required><input type="date" className={inputCls} value={form.log_date} onChange={(e) => setForm({ ...form, log_date: e.target.value })} /></Field>
            <Field label="Govt portal present (blank = not verified)"><input type="number" className={inputCls} value={form.govt_present ?? ""} onChange={(e) => setForm({ ...form, govt_present: e.target.value })} /></Field>
            <Field label="Planned topic"><input className={inputCls} value={form.planned_topic ?? ""} onChange={(e) => setForm({ ...form, planned_topic: e.target.value })} /></Field>
            <Field label="Actual topic"><input className={inputCls} value={form.actual_topic ?? ""} onChange={(e) => setForm({ ...form, actual_topic: e.target.value })} /></Field>
          </div>
          {/* 2026-08-13 (Manish): the govt portal takes student attendance only on a day the
              trainer's own attendance exists — same ordering here. Default ticked. */}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.trainer_present !== false}
              onChange={(e) => setForm({ ...form, trainer_present: e.target.checked })} />
            <span className="font-medium">Trainer present today</span>
            <span className="text-xs text-gray-400">(portal rule: students can be marked only when the trainer attended)</span>
          </label>
          <div>
            <div className="mb-1.5 text-xs font-medium text-gray-600">Attendance — tap present ({form.present.size}/{members.length})</div>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
              {members.map((m) => (
                <button key={m._id} onClick={() => togglePresent(m._id)}
                  className={`rounded-lg border px-2 py-2.5 text-left text-sm ${form.present.has(m._id) ? "border-green-300 bg-green-50 text-green-800" : "border-gray-200 bg-white text-gray-500"}`}>
                  {form.present.has(m._id) ? "✓ " : ""}{m.candidate?.name}
                </button>
              ))}
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label={`Photos (${form.photos.length})`}>
              <input type="file" accept="image/*" capture="environment" className={inputCls} onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0], "photos")} />
            </Field>
            <Field label={`Videos (${form.videos.length})`}>
              <input type="file" accept="video/mp4,video/*" capture="environment" className={inputCls} onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0], "videos")} />
            </Field>
            <Field label={`Govt attendance screenshot${form.govt_screenshot ? " ✓" : ""}`}>
              <input type="file" accept="image/*" className={inputCls} onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0], "govt_screenshot")} />
            </Field>
          </div>
          <Field label="Note"><input className={inputCls} value={form.note ?? ""} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
          <div className="flex items-center gap-3">
            <Btn onClick={save} disabled={busy}>{busy ? "Saving…" : "Save Daily Log"}</Btn>
            {queued > 0 && (
              <button onClick={retryQueued} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-700">
                {queued} upload{queued > 1 ? "s" : ""} pending — Retry now
              </button>
            )}
          </div>
        </div>
      </Section>

      {/* 2026-08-13: "har batch ke andar daily basis pe upload attendance" — the portal CSV
          imports from here with this batch preselected (the engine batch-scopes the match).
          Umesh (13/08): "bulk sheet upload wali functionality show nahi ho rahi" — a text link
          was invisible; it is a real button now. */}
      <Section title="History" actions={
        <a className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700" href={`${BASE_PATH}/govt-attendance?batch=${batchId}`}>
          ⬆ Upload attendance sheet (bulk)
        </a>
      }>
        <DataTable rows={logs}
          cardTitle={(r: any) => fmtDate(r.log_date)}
          columns={[
            // mobile:false — the card already leads with this date as its title (audit F-005).
            { key: "log_date", label: "Date", render: (r: any) => fmtDate(r.log_date), mobile: false },
            { key: "trainer_present", label: "Trainer", mobile: false, render: (r: any) => r.trainer_present === false ? <span className="font-semibold text-red-600">✗</span> : r.trainer_present ? <span className="text-green-700">✓</span> : <span className="text-gray-400">—</span> },
            { key: "internal_present", label: "Internal", render: (r: any) => `${r.internal_present}/${r.roster_count} (${r.roster_count ? Math.round((100 * r.internal_present) / r.roster_count) : 0}%)` },
            { key: "govt_present", label: "Govt", render: (r: any) => r.govt_present == null ? <span className="text-gray-400">Not verified</span> : `${r.govt_present}/${r.roster_count} (${Math.round((100 * r.govt_present) / r.roster_count)}%)` },
            { key: "gap", label: "Gap", render: (r: any) => <Gap r={r} /> },
            { key: "actual_topic", label: "Topic", render: (r: any) => r.actual_topic ?? r.planned_topic ?? "—", mobile: false },
            { key: "photos", label: "Media", render: (r: any) => <MediaCell r={r} /> },
            { key: "_edit", label: "", render: (r: any) => <Btn small kind="ghost" onClick={() => setEditLog(r)}>Edit</Btn> },
          ]} empty="No logs yet." />
      </Section>
      <LogEditDrawer log={editLog} members={members} onClose={() => setEditLog(null)} onSaved={() => { setEditLog(null); load(); }} setError={setError} />
    </div>
  );
}

// Rule 27: 48h window for enterer, anytime for Ops/Admin — server enforces; UI just offers the form.
function LogEditDrawer({ log, members, onClose, onSaved, setError }: any) {
  const [form, setForm] = useState<any>(null);
  useEffect(() => {
    if (log) setForm({
      planned_topic: log.planned_topic ?? "", actual_topic: log.actual_topic ?? "",
      govt_present: log.govt_present ?? "", note: log.note ?? "",
      trainer_present: log.trainer_present,
      present: new Set((log.present_member_ids ?? []).map(String)),
    });
  }, [log]);
  if (!log || !form) return null;

  const toggle = (id: string) => {
    const s = new Set<string>(form.present);
    if (s.has(id)) s.delete(id); else s.add(id);
    setForm({ ...form, present: s });
  };

  async function save() {
    try {
      await api(`/api/logs/${log._id}`, {
        method: "PATCH",
        json: {
          planned_topic: form.planned_topic, actual_topic: form.actual_topic,
          present_member_ids: [...form.present],
          trainer_present: form.trainer_present !== false,
          govt_present: form.govt_present === "" ? null : +form.govt_present,
          note: form.note,
        },
      });
      onSaved();
    } catch (e: any) { setError(e.message); onClose(); }
  }

  return (
    <Drawer open onClose={onClose} title={`Edit log — ${fmtDate(log.log_date)}`} wide>
      <div className="space-y-4">
        <p className="text-xs text-gray-500">Edits allowed 48h by the person who entered it, anytime by Operations/Admin. Every change is audited (Rule 27). Roster count stays frozen at {log.roster_count} (Rule 28).</p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Planned topic"><input className={inputCls} value={form.planned_topic} onChange={(e) => setForm({ ...form, planned_topic: e.target.value })} /></Field>
          <Field label="Actual topic"><input className={inputCls} value={form.actual_topic} onChange={(e) => setForm({ ...form, actual_topic: e.target.value })} /></Field>
          <Field label="Govt present (blank = not verified)"><input type="number" className={inputCls} value={form.govt_present} onChange={(e) => setForm({ ...form, govt_present: e.target.value })} /></Field>
          <Field label="Note"><input className={inputCls} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.trainer_present !== false}
            onChange={(e) => setForm({ ...form, trainer_present: e.target.checked })} />
          <span className="font-medium">Trainer present</span>
        </label>
        <div>
          <div className="mb-1.5 text-xs font-medium text-gray-600">Present ({form.present.size})</div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {members.map((m: any) => (
              <button key={m._id} onClick={() => toggle(String(m._id))}
                className={`rounded-lg border px-2 py-2 text-left text-sm ${form.present.has(String(m._id)) ? "border-green-300 bg-green-50 text-green-800" : "border-gray-200 bg-white text-gray-500"}`}>
                {form.present.has(String(m._id)) ? "✓ " : ""}{m.candidate?.name}
              </button>
            ))}
          </div>
        </div>
        <Btn onClick={save}>Save changes</Btn>
      </div>
    </Drawer>
  );
}

// Evidence must be viewable, not just counted — the daily verification loop depends on
// someone opening the govt screenshot (transcript 13:12–14:33).
function MediaCell({ r }: any) {
  const photos: string[] = r.photos ?? [];
  const videos: string[] = r.videos ?? [];
  if (!photos.length && !videos.length && !r.govt_screenshot) return <span className="text-gray-400">—</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {photos.map((p, i) => (
        <a key={p} href={p} target="_blank" rel="noreferrer" title={`Photo ${i + 1}`}>
          <img src={p} alt={`Photo ${i + 1}`} className="h-8 w-8 rounded border border-gray-200 object-cover" />
        </a>
      ))}
      {videos.map((v, i) => (
        <a key={v} href={v} target="_blank" rel="noreferrer" title={`Video ${i + 1}`}
          className="rounded border border-gray-200 bg-gray-50 px-1.5 py-1 text-xs text-gray-600">▶ {i + 1}</a>
      ))}
      {r.govt_screenshot && (
        <a href={r.govt_screenshot} target="_blank" rel="noreferrer" title="Govt attendance proof"
          className="rounded border border-amber-300 bg-amber-50 px-1.5 py-1 text-xs font-medium text-amber-700">proof</a>
      )}
    </span>
  );
}

function Gap({ r }: any) {
  if (r.govt_present == null || !r.roster_count) return <span className="text-gray-400">—</span>;
  const gap = Math.round((100 * r.internal_present) / r.roster_count) - Math.round((100 * r.govt_present) / r.roster_count);
  const cls = gap > 10 ? "text-red-600 font-semibold" : gap >= 5 ? "text-amber-600 font-semibold" : "text-gray-600";
  return <span className={cls}>{gap > 0 ? `−${gap}` : gap} pts</span>;
}

// ---------- Closure tab (Rules 34–36, 41–47) ----------
function ClosureTab({ batchId, batch, setError, onChanged }: any) {
  const [closure, setClosure] = useState<any>(null);
  const [invoice, setInvoice] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const [invForm, setInvForm] = useState<any>({});
  const [legacy, setLegacy] = useState(true);
  const [summary, setSummary] = useState<any>(null);
  const [perCandidate, setPerCandidate] = useState(false);

  const load = () => api(`/api/batches/${batchId}/closure`).then((d) => {
    setClosure(d.closure); setInvoice(d.invoice);
    setForm(d.closure ?? {}); setInvForm(d.invoice ?? {});
    setLegacy(d.legacy !== false);
    setSummary(d.results_summary ?? null);
    if (d.legacy === false) setPerCandidate(true);
  }).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, [batchId]);

  async function saveClosure(patch: any) {
    try { await api(`/api/batches/${batchId}/closure`, { method: "PUT", json: patch }); load(); onChanged(); }
    catch (e: any) { setError(e.message); }
  }
  async function saveInvoice(patch: any) {
    try { await api(`/api/batches/${batchId}/invoice`, { method: "PATCH", json: patch }); load(); }
    catch (e: any) { setError(e.message); }
  }

  const closed = ["Completed", "Cancelled"].includes(batch?.status);

  return (
    <div className="space-y-4">
      {/* Per-candidate marking gets the full width — it is a data-entry grid, not a side panel. */}
      {perCandidate && (
        <CandidateResults batchId={batchId} batch={batch} setError={setError} onChanged={() => { load(); onChanged(); }} />
      )}
      <div className="grid gap-4 lg:grid-cols-2">
      <Section
        title={`Assessment — ${closure?.assessment_status ?? "Pending"}`}
        actions={legacy && !perCandidate && !closed ? <Btn small kind="ghost" onClick={() => setPerCandidate(true)}>Start per-candidate marking</Btn> : undefined}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Assessment date"><input type="date" className={inputCls} value={toInputDate(form.assessment_date)} onChange={(e) => setForm({ ...form, assessment_date: e.target.value })} /></Field>
          <div />
          {legacy && !perCandidate ? (
            <>
              <Field label="Appeared"><input type="number" className={inputCls} value={form.appeared ?? ""} onChange={(e) => setForm({ ...form, appeared: +e.target.value })} /></Field>
              <Field label="Passed"><input type="number" className={inputCls} value={form.passed ?? ""} onChange={(e) => setForm({ ...form, passed: +e.target.value })} /></Field>
            </>
          ) : (
            <>
              <Field label="Appeared"><div className={inputCls + " bg-gray-50 text-gray-700"}>{closure?.appeared ?? 0} <span className="text-xs text-gray-400">derived</span></div></Field>
              <Field label="Passed"><div className={inputCls + " bg-gray-50 text-gray-700"}>{closure?.passed ?? 0} <span className="text-xs text-gray-400">derived</span></div></Field>
            </>
          )}
        </div>
        {/* DEC-4 (2026-08-13): dropped-but-passed never bill. Show the split whenever it exists. */}
        {!legacy && (closure?.dropped_passed ?? 0) > 0 && (
          <p className="mt-2 text-xs text-amber-700">
            {closure.dropped_passed} passed candidate(s) had dropped out — billable passed is <span className="font-semibold">{closure.billable_passed ?? Math.max(0, (closure.passed ?? 0) - closure.dropped_passed)}</span>, not {closure.passed} (dropped-but-passed are never invoiced).
          </p>
        )}
        {legacy && !perCandidate && (
          <p className="mt-2 text-xs text-gray-500">Batch-level figures (recorded before per-candidate marking existed).</p>
        )}
        <div className="mt-3 flex gap-2">
          <Btn small kind="ghost" onClick={() => saveClosure({ assessment_date: form.assessment_date, ...(legacy && !perCandidate ? { appeared: form.appeared, passed: form.passed } : {}) })}>Save</Btn>
          <Btn small onClick={() => saveClosure({ assessment_status: "Completed", assessment_date: form.assessment_date ?? new Date(), ...(legacy && !perCandidate ? { appeared: form.appeared, passed: form.passed } : {}) })} disabled={closure?.assessment_status === "Completed"}>Mark Completed</Btn>
        </div>
      </Section>
      <Section title={`Certification — ${closure?.certification_status ?? "Pending"}`}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Certification date"><input type="date" className={inputCls} value={toInputDate(form.certification_date)} onChange={(e) => setForm({ ...form, certification_date: e.target.value })} /></Field>
          {legacy && !perCandidate
            ? <Field label="Certificates issued"><input type="number" className={inputCls} value={form.certificates_issued ?? ""} onChange={(e) => setForm({ ...form, certificates_issued: +e.target.value })} /></Field>
            : <Field label="Certificates issued"><div className={inputCls + " bg-gray-50 text-gray-700"}>{closure?.certificates_issued ?? 0} <span className="text-xs text-gray-400">derived</span></div></Field>}
        </div>
        {!legacy && summary && summary.passed > summary.certificates_issued && (
          <p className="mt-2 text-xs text-amber-700">{summary.passed - summary.certificates_issued} passed candidate(s) still need an issued certificate (Rule 46).</p>
        )}
        <div className="mt-3 flex gap-2">
          <Btn small kind="ghost" onClick={() => saveClosure({ certification_date: form.certification_date, ...(legacy ? { certificates_issued: form.certificates_issued } : {}) })}>Save</Btn>
          <Btn small onClick={() => saveClosure({ certification_status: "Completed", certification_date: form.certification_date ?? new Date(), ...(legacy ? { certificates_issued: form.certificates_issued } : {}) })} disabled={closure?.certification_status === "Completed"}>Mark Completed</Btn>
        </div>
      </Section>
      <Section title={`Invoice — ${invoice?.status ?? "Not Ready"}`}>
        <div className="space-y-3">
          {!closure?.ready_for_invoice && (
            <Btn onClick={() => saveClosure({ ready_for_invoice: true })} disabled={closure?.certification_status !== "Completed"}>
              Mark Ready for Invoice {closure?.certification_status !== "Completed" && "(needs certification)"}
            </Btn>
          )}
          {invoice && (closure?.billable_passed != null || closure?.passed != null) && (
            <p className="text-xs text-gray-600">
              Invoice for <span className="font-semibold">{closure?.billable_passed ?? closure?.passed}</span> billable passed candidate(s){(closure?.dropped_passed ?? 0) > 0 ? ` — ${closure.dropped_passed} dropped-but-passed excluded (2026-08-13 decision)` : ""}.
            </p>
          )}
          {invoice && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount (₹)"><input type="number" className={inputCls} value={invForm.amount ?? ""} onChange={(e) => setInvForm({ ...invForm, amount: +e.target.value })} /></Field>
              <Field label="Invoice no"><input className={inputCls} value={invForm.invoice_no ?? ""} onChange={(e) => setInvForm({ ...invForm, invoice_no: e.target.value })} /></Field>
              <Field label="Raised on"><input type="date" className={inputCls} value={toInputDate(invForm.raised_on)} onChange={(e) => setInvForm({ ...invForm, raised_on: e.target.value })} /></Field>
              <Field label="Paid on"><input type="date" className={inputCls} value={toInputDate(invForm.paid_on)} onChange={(e) => setInvForm({ ...invForm, paid_on: e.target.value })} /></Field>
            </div>
          )}
          {invoice && (
            <div className="flex gap-2">
              <Btn small onClick={() => saveInvoice({ ...invForm, status: "Raised" })} disabled={invoice.status !== "Ready"}>Mark Raised</Btn>
              <Btn small onClick={() => saveInvoice({ ...invForm, status: "Paid" })} disabled={invoice.status !== "Raised"}>Mark Paid</Btn>
            </div>
          )}
        </div>
      </Section>
      </div>
    </div>
  );
}

// ---------- Per-candidate assessment & certification (RPL M17/M18) ----------
function CandidateResults({ batchId, batch, setError, onChanged }: any) {
  const [items, setItems] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [reasons, setReasons] = useState<any[]>([]);
  const [view, setView] = useState<"mark" | "review">("mark");
  const [bulk, setBulk] = useState<any>({ assessed_on: toInputDate(new Date()), assessor: "" });
  const [certDrawer, setCertDrawer] = useState(false);
  const [certForm, setCertForm] = useState<any>({});
  const [idx, setIdx] = useState(0);
  const closed = ["Completed", "Cancelled"].includes(batch?.status);

  const load = () => Promise.all([
    api(`/api/batches/${batchId}/results`).then((d) => { setItems(d.items); setSummary(d.summary); }),
    api("/api/master-lists/failure-reasons").then((d) => setReasons(d.items)).catch(() => setReasons([])),
  ]).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, [batchId]);

  async function mark(member: string, patch: any) {
    try {
      await api(`/api/batches/${batchId}/results`, { method: "PUT", json: { rows: [{ member, assessed_on: bulk.assessed_on, assessor: bulk.assessor || undefined, ...patch }] } });
      await load(); onChanged();
    } catch (e: any) { setError(e.message); }
  }
  async function bulkApply(rows: any[]) {
    if (!rows.length) return;
    try { await api(`/api/batches/${batchId}/results`, { method: "PUT", json: { rows } }); await load(); onChanged(); }
    catch (e: any) { setError(e.message); }
  }
  async function certPatch(resultId: string, patch: any) {
    try { await api(`/api/results/${resultId}`, { method: "PATCH", json: patch }); await load(); onChanged(); }
    catch (e: any) { setError(e.message); }
  }

  const active = items.filter((i) => !i.left_on);
  const pending = active.filter((i) => !i.result || i.result.result === "Pending");
  const passes = items.filter((i) => i.result?.result === "Pass");

  const ResultButtons = ({ i }: any) => (
    <div className="flex flex-wrap gap-1.5">
      {["Pass", "Fail", "Absent"].map((r) => {
        const on = i.result?.result === r;
        const tone = r === "Pass" ? "border-green-300 bg-green-50 text-green-700"
          : r === "Fail" ? "border-red-300 bg-red-50 text-red-700" : "border-amber-300 bg-amber-50 text-amber-700";
        return (
          <button key={r} disabled={closed}
            onClick={() => r === "Fail" ? mark(i.member, { result: "Fail", failure_reason: i.result?.failure_reason || reasons[0]?.name || "Below cut-off" }) : mark(i.member, { result: r })}
            className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50 ${on ? tone : "border-gray-200 bg-white text-gray-500"}`}>
            {on ? "✓ " : ""}{r}
          </button>
        );
      })}
    </div>
  );

  const Card = ({ i }: any) => (
    <div className="space-y-2 rounded-xl border bg-white p-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium">{i.candidate?.name}</div>
          <div className="text-xs text-gray-500">{i.candidate?.phone}{i.left_on ? " · dropped" : ""}</div>
        </div>
        <Chip value={i.result?.result ?? "Pending"} />
      </div>
      <ResultButtons i={i} />
      <div className="flex flex-wrap items-center gap-2">
        <input type="number" placeholder="Score" disabled={closed}
          className="w-24 rounded-lg border border-gray-300 px-2 py-1 text-sm"
          defaultValue={i.result?.score ?? ""}
          onBlur={(e) => e.target.value !== String(i.result?.score ?? "") && mark(i.member, { score: +e.target.value })} />
        {i.result?.result === "Fail" && (
          <select className="rounded-lg border border-gray-300 px-2 py-1 text-sm" disabled={closed}
            value={i.result?.failure_reason ?? ""}
            onChange={(e) => mark(i.member, { result: "Fail", failure_reason: e.target.value })}>
            {reasons.map((r) => <option key={r._id}>{r.name}</option>)}
            {!reasons.length && <option>Below cut-off</option>}
          </select>
        )}
        {i.result?.certificate_status && i.result.certificate_status !== "Pending" && <Chip value={i.result.certificate_status} />}
      </div>
    </div>
  );

  return (
    <Section
      title={`Candidate results — ${summary?.final ?? 0}/${active.length} marked${summary?.pending ? ` · ${summary.pending} pending` : ""}`}
      actions={<Btn small kind="ghost" onClick={() => setView(view === "mark" ? "review" : "mark")}>{view === "mark" ? "Review table" : "Mark results"}</Btn>}
    >
      {pending.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Still pending: {pending.map((p) => p.candidate?.name).slice(0, 6).join(", ")}
          {pending.length > 6 ? ` +${pending.length - 6} more` : ""} — assessment cannot be marked Completed until every candidate has a final result (Rule 43).
        </div>
      )}

      {!closed && (
        <div className="mb-3 flex flex-wrap items-end gap-2 rounded-lg bg-gray-50 p-3">
          <Field label="Assessment date (applies to marks)">
            <input type="date" className={inputCls + " max-w-40"} value={bulk.assessed_on} onChange={(e) => setBulk({ ...bulk, assessed_on: e.target.value })} />
          </Field>
          <Field label="Assessor">
            <input className={inputCls + " max-w-44"} value={bulk.assessor} onChange={(e) => setBulk({ ...bulk, assessor: e.target.value })} placeholder="Assessor name" />
          </Field>
          <Btn small kind="ghost" onClick={() => bulkApply(pending.map((i) => ({ member: i.member, result: "Pass", assessed_on: bulk.assessed_on, assessor: bulk.assessor || undefined })))} disabled={!pending.length}>
            Mark {pending.length} pending as Pass
          </Btn>
          <Btn small kind="ghost" onClick={async () => {
            // Absentees = members missing from the most recent daily log (data we already hold).
            const logs = await api(`/api/batches/${batchId}/logs`).then((d) => d.items).catch(() => []);
            const present = new Set((logs[0]?.present_member_ids ?? []).map(String));
            const absent = pending.filter((i) => logs.length && !present.has(String(i.member)));
            bulkApply(absent.map((i) => ({ member: i.member, result: "Absent", assessed_on: bulk.assessed_on })));
          }} disabled={!pending.length}>Mark absentees from last log</Btn>
          <Btn small onClick={() => { setCertForm({ certificate_date: toInputDate(new Date()), prefix: "RPL/2026/", numbers: {} }); setCertDrawer(true); }} disabled={!passes.length}>
            Issue certificates ({passes.length})
          </Btn>
        </div>
      )}

      {view === "review" ? (
        <DataTable rows={items}
          cardTitle={(r: any) => r.candidate?.name}
          columns={[
            { key: "candidate", label: "Candidate", render: (r: any) => <NameCell name={r.candidate?.name} sub={r.candidate?.phone} /> },
            { key: "result", label: "Result", render: (r: any) => <Chip value={r.result?.result ?? "Pending"} /> },
            { key: "score", label: "Score", render: (r: any) => r.result?.score ?? "—" },
            { key: "assessor", label: "Assessor", render: (r: any) => r.result?.assessor ?? "—", mobile: false },
            { key: "failure_reason", label: "Failure reason", render: (r: any) => r.result?.failure_reason ?? "—" },
            { key: "cert", label: "Certificate", render: (r: any) => r.result?.certificate_no ? `${r.result.certificate_no} (${r.result.certificate_status})` : (r.result?.certificate_status ?? "—") },
          ]} empty="No members on this batch." />
      ) : (
        <>
          <div className="hidden gap-3 md:grid md:grid-cols-2 xl:grid-cols-3">
            {items.map((i) => <Card key={i.member} i={i} />)}
          </div>
          <div className="md:hidden">
            {items.length > 0 && <Card i={items[Math.min(idx, items.length - 1)]} />}
            <div className="mt-3 flex items-center justify-between">
              <Btn kind="ghost" onClick={() => setIdx((v) => Math.max(0, v - 1))} disabled={idx === 0}>← Prev</Btn>
              <span className="text-sm text-gray-500">{idx + 1} / {items.length}</span>
              <Btn kind="ghost" onClick={() => setIdx((v) => Math.min(items.length - 1, v + 1))} disabled={idx >= items.length - 1}>Next →</Btn>
            </div>
          </div>
        </>
      )}

      <Drawer open={certDrawer} onClose={() => setCertDrawer(false)} title="Issue certificates" wide>
        <div className="space-y-3">
          <p className="text-sm text-gray-600">Only candidates who passed appear here — no certificate without a Pass (Rule 45).</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Certificate date"><input type="date" className={inputCls} value={certForm.certificate_date ?? ""} onChange={(e) => setCertForm({ ...certForm, certificate_date: e.target.value })} /></Field>
            <Field label="Number prefix (auto-fill)">
              <div className="flex gap-2">
                <input className={inputCls} value={certForm.prefix ?? ""} onChange={(e) => setCertForm({ ...certForm, prefix: e.target.value })} />
                <Btn small kind="ghost" onClick={() => {
                  const numbers: any = {};
                  passes.forEach((p, n) => { numbers[p.result._id] = `${certForm.prefix}${String(n + 1).padStart(3, "0")}`; });
                  setCertForm({ ...certForm, numbers });
                }}>Fill</Btn>
              </div>
            </Field>
          </div>
          {passes.map((p) => (
            <div key={p.result._id} className="flex items-center gap-2 rounded-lg border px-3 py-2">
              <span className="w-40 truncate text-sm font-medium">{p.candidate?.name}</span>
              <input className={inputCls} placeholder="Certificate number"
                value={certForm.numbers?.[p.result._id] ?? p.result.certificate_no ?? ""}
                onChange={(e) => setCertForm({ ...certForm, numbers: { ...certForm.numbers, [p.result._id]: e.target.value } })} />
              <Chip value={p.result.certificate_status} />
            </div>
          ))}
          <Btn onClick={async () => {
            for (const p of passes) {
              const no = certForm.numbers?.[p.result._id] ?? p.result.certificate_no;
              if (!no) continue;
              try {
                if (p.result.certificate_status === "Pending") await api(`/api/results/${p.result._id}`, { method: "PATCH", json: { certificate_status: "Processing" } });
                if (["Pending", "Processing"].includes(p.result.certificate_status)) {
                  await api(`/api/results/${p.result._id}`, { method: "PATCH", json: { certificate_status: "Generated", certificate_no: no, certificate_date: certForm.certificate_date } });
                }
                await api(`/api/results/${p.result._id}`, { method: "PATCH", json: { certificate_status: "Issued" } });
              } catch (e: any) { setError(`${p.candidate?.name}: ${e.message}`); }
            }
            setCertDrawer(false); await load(); onChanged();
          }}>Generate &amp; issue</Btn>
        </div>
      </Drawer>
    </Section>
  );
}

// ---------- Costs tab ----------
// ---------- Feedback tab (2026-08-11: "हर बच्चा… feedback दे पाए") ----------
function FeedbackTab({ batchId, setError }: any) {
  const [data, setData] = useState<any>(null);
  const [links, setLinks] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api(`/api/batches/${batchId}/feedback`).then(setData).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, [batchId]);

  async function generateLinks() {
    setBusy(true);
    try {
      const res = await api("/api/public-tokens", { method: "POST", json: { purpose: "feedback", batch: batchId } });
      setLinks(res.items);
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  const linkFor = (t: any) => `${window.location.origin}${BASE_PATH}/p/feedback/${t.token}`;

  return (
    <div className="space-y-4">
      <Section title={`Feedback${data?.count ? ` — ${data.count} response${data.count === 1 ? "" : "s"}, average ${data.average}★` : ""}`}
        actions={<Btn small kind="ghost" disabled={busy} onClick={generateLinks}>Get feedback links</Btn>}>
        {links && (
          <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
            {/* 2026-08-12 (Manish): SMS alongside WhatsApp — rural candidates are not reliably on WhatsApp. */}
            <div className="mb-2 font-medium text-blue-800">One link per candidate — send on WhatsApp or SMS:</div>
            <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
              {links.map((t: any) => {
                const name = t.batch_member?.candidate?.name ?? "?";
                const phone = t.batch_member?.candidate?.phone;
                const url = linkFor(t);
                const msg = `Namaste ${name}! Please share your training feedback: ${url}`;
                const wa = waLink(phone, msg), sms = smsLink(phone, msg);
                return (
                  <li key={t._id ?? t.token} className="flex items-center gap-2">
                    <span className="font-medium">{name}</span>
                    <CopyBtn text={url} className="text-blue-700 hover:underline">copy link</CopyBtn>
                    {wa && <a className="text-green-700 hover:underline" href={wa} target="_blank" rel="noreferrer">WhatsApp</a>}
                    {sms && <a className="text-indigo-700 hover:underline" href={sms}>SMS</a>}
                    {!wa && <span className="text-gray-400">no mobile number</span>}
                  </li>
                );
              })}
            </ul>
            <button className="mt-2 text-xs font-medium text-indigo-700 hover:underline"
              onClick={() => {
                const targets = links.map((t: any) => ({ name: t.batch_member?.candidate?.name, phone: t.batch_member?.candidate?.phone, url: linkFor(t) }));
                const csv = bulkSmsCsv(targets, (t: any) => `Namaste ${t.name}! Please share your training feedback: ${t.url}`);
                const a = document.createElement("a");
                a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                a.download = "sms-feedback-links.csv"; a.click();
              }}>Download bulk SMS file</button>
          </div>
        )}
        <DataTable rows={data?.items ?? []}
          cardTitle={(r: any) => r.batch_member?.candidate?.name ?? "?"}
          columns={[
            { key: "candidate", label: "Candidate", render: (r: any) => r.batch_member?.candidate?.name ?? "?" },
            { key: "rating", label: "Rating", render: (r: any) => "⭐".repeat(r.rating) },
            { key: "liked", label: "Liked", render: (r: any) => <span className="text-xs">{r.liked || "—"}</span> },
            { key: "suggestions", label: "Suggestions", render: (r: any) => <span className="text-xs">{r.suggestions || "—"}</span> },
            { key: "submitted_at", label: "When", render: (r: any) => fmtDate(r.submitted_at), mobile: false },
          ]} empty="No feedback yet — generate links and share them with the candidates." />
      </Section>
    </div>
  );
}

function CostsTab({ batchId, batch, setError }: any) {
  const [items, setItems] = useState<any[]>([]);
  const [cats, setCats] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ entry_date: toInputDate(new Date()) });
  const [suggest, setSuggest] = useState<any>(null);

  const load = () => Promise.all([
    api(`/api/costs?batch=${batchId}`).then((d) => setItems(d.items)),
    api("/api/master-lists/cost-categories").then((d) => setCats(d.items)),
  ]).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, [batchId]);

  // Trainer fee suggestion: day_rate × distinct training days (DailyLog dates).
  // Suggestion only — nothing is written until the user adds it.
  useEffect(() => {
    const trainerId = batch.trainer?._id ?? batch.trainer;
    if (!trainerId) return;
    Promise.all([api(`/api/trainers/${trainerId}`), api(`/api/batches/${batchId}/logs`)])
      .then(([t, l]) => {
        const rate = t.item?.day_rate;
        const days = l.items?.length ?? 0;
        if (rate > 0 && days > 0) setSuggest({ trainer: trainerId, name: t.item.name, rate, days, amount: rate * days });
      })
      .catch(() => {});
  }, [batchId, batch]);

  async function addSuggested() {
    const cat = cats.find((c: any) => c.name === "Trainer Fee");
    if (!cat) { setError('Cost category "Trainer Fee" not found — add it in Admin → Master Lists.'); return; }
    try {
      await api("/api/costs", {
        method: "POST",
        json: {
          entry_date: toInputDate(new Date()), batch: batchId, location: batch.location?._id ?? batch.location,
          trainer: suggest.trainer, category: cat._id, amount: suggest.amount,
          note: `Auto-suggested: ₹${suggest.rate}/day × ${suggest.days} training days (${suggest.name})`,
        },
      });
      setSuggest(null); load();
    } catch (e: any) { setError(e.message); }
  }

  async function save() {
    try {
      await api("/api/costs", { method: "POST", json: { ...form, batch: batchId, location: batch.location?._id ?? batch.location } });
      setForm({ entry_date: toInputDate(new Date()) }); load();
    } catch (e: any) { setError(e.message); }
  }
  const total = items.reduce((s, i) => s + (i.amount ?? 0), 0);

  const hasTrainerFee = items.some((i) => i.category?.name === "Trainer Fee");

  return (
    <Section title={`Cost entries — total ₹${total.toLocaleString("en-IN")}`}>
      {suggest && !hasTrainerFee && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          <span>Trainer fee suggestion: <b>₹{suggest.amount.toLocaleString("en-IN")}</b> — ₹{suggest.rate}/day × {suggest.days} training day{suggest.days === 1 ? "" : "s"} ({suggest.name})</span>
          <Btn small onClick={addSuggested}>Add as cost entry</Btn>
        </div>
      )}
      <DataTable rows={items}
        cardTitle={(r: any) => `₹${r.amount} · ${r.category?.name}`}
        columns={[
          { key: "entry_date", label: "Date", render: (r: any) => fmtDate(r.entry_date) },
          { key: "category", label: "Category", render: (r: any) => r.category?.name },
          { key: "amount", label: "Amount", render: (r: any) => `₹${(r.amount ?? 0).toLocaleString("en-IN")}` },
          { key: "note", label: "Note" },
          { key: "entered_by", label: "By", render: (r: any) => r.entered_by?.name, mobile: false },
        ]} empty="No costs recorded." />
      <div className="mt-3 grid gap-3 md:grid-cols-5">
        <Field label="Date"><input type="date" className={inputCls} value={form.entry_date} onChange={(e) => setForm({ ...form, entry_date: e.target.value })} /></Field>
        <Field label="Category" required>
          <select className={inputCls} value={form.category ?? ""} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            <option value="">Select…</option>
            {cats.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Amount (₹)" required><input type="number" className={inputCls} value={form.amount ?? ""} onChange={(e) => setForm({ ...form, amount: +e.target.value })} /></Field>
        <Field label="Note"><input className={inputCls} value={form.note ?? ""} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
        <div className="flex items-end"><Btn onClick={save} disabled={!form.category || !form.amount}>Add Cost</Btn></div>
      </div>
    </Section>
  );
}
