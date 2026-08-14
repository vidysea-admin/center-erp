"use client";
import { use, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { api, fmtDate, toInputDate } from "@/lib/client";
import { BackLink, Btn, Chip, CopyBtn, DataTable, Drawer, ErrorBanner, Field, HealthBanner, NameCell, Section, Tabs, inputCls } from "@/components/ui";
import { Activity } from "@/components/activity";
import { flushQueue, getQueue, uploadWithRetry } from "@/lib/upload";
import { BASE_PATH } from "@/lib/base-path";
import { bulkSmsCsv, smsLink, waLink } from "@/lib/messaging";

const TABS = ["Overview", "Candidates", "Enrollment", "Daily Execution", "Closure", "Feedback", "Costs", "Activity"];

export default function BatchDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const sp = useSearchParams();
  // 2026-08-13 (Umesh role matrix): the tabs a login cannot use are not shown to it —
  // Costs is finance-only (a Location user only ever got a 403 banner from it), and the
  // server remains the real gate either way.
  const { data: session } = useSession();
  const role = (session?.user as any)?.role;
  const tabs = TABS.filter((t) => t !== "Costs" || role === "Admin" || role === "Operations");
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
        <BackLink fallback="/batches" label="Batches" />
        <h1 className="text-xl font-semibold">{b.code}</h1>
        <Chip value={b.status} />
        <span className="text-sm text-gray-500">{b.program?.name} · {fmtDate(b.planned_start)} → {fmtDate(b.planned_end)}</span>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      <HealthBanner health={data.health} />
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      {tab === "Overview" && <Overview data={data} role={role} onChanged={load} setError={setError} />}
      {tab === "Candidates" && <Roster batchId={id} batch={b} setError={setError} onChanged={load} />}
      {tab === "Enrollment" && <Enrollment batchId={id} setError={setError} />}
      {tab === "Daily Execution" && <DailyExecution batchId={id} batch={b} role={role} setError={setError} />}
      {tab === "Closure" && <ClosureTab batchId={id} batch={b} setError={setError} onChanged={load} />}
      {tab === "Feedback" && <FeedbackTab batchId={id} setError={setError} />}
      {tab === "Costs" && (role === "Admin" || role === "Operations") && <CostsTab batchId={id} batch={b} setError={setError} />}
      {tab === "Activity" && <Activity entity="Batch" id={id} />}
    </div>
  );
}

// ---------- Overview: readiness checklist (Rule 16) + transitions ----------
function Overview({ data, role, onChanged, setError }: any) {
  const b = data.item;
  // Umesh role matrix: "no batch edit" for principal/SPOC — the server 403s regardless
  // (batches.manage removed from the Location role); the buttons simply are not offered.
  const canTransition = role !== "Location" && role !== "Trainer" && role !== "Enrollment";
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
        {canTransition ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {b.status === "Planning" && <Btn onClick={() => transition("Ready")} disabled={!r.ready}>Mark Ready</Btn>}
            {b.status === "Ready" && <Btn onClick={() => transition("Active")}>Start Batch</Btn>}
            {b.status === "Ready" && <Btn kind="ghost" onClick={() => transition("Planning")}>Back to Planning</Btn>}
            {b.status === "Active" && <Btn onClick={() => transition("Closing")}>Move to Closing</Btn>}
            {b.status === "Closing" && <Btn onClick={() => transition("Completed")}>Complete Batch</Btn>}
            {/* Rule 52: Completed = training over; Closed = money over (cert + invoice PAID + no dues). */}
            {b.status === "Completed" && <Btn onClick={() => transition("Closed")}>Close Batch (no dues)</Btn>}
            {["Planning", "Ready", "Active"].includes(b.status) && <Btn kind="danger" onClick={() => setConfirmCancel(true)}>Cancel Batch</Btn>}
          </div>
        ) : (
          <p className="mt-4 text-xs text-gray-400">Batch status is moved by Operations/Admin.</p>
        )}
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

  const [loaded, setLoaded] = useState(false);
  const load = () => Promise.all([
    api(`/api/batches/${batchId}/members`).then((d) => setMembers(d.items)),
    // 2026-08-13 (Manish hit this live — Prem Kumar/Lalit from another job role in the pool):
    // the pool is this location AND this job role. Program-less candidates (bulk imports)
    // stay eligible — they inherit the batch's programme on enrol; the server enforces both.
    api(`/api/candidates?location=${batch.location?._id ?? batch.location}&limit=2000`).then((d) =>
      setPool(d.items.filter((c: any) => ["Unassigned", "Dropped"].includes(c.lifecycle_status)
        && (!c.program || String(c.program?._id ?? c.program) === String(batch.program?._id ?? batch.program))))),
    api("/api/master-lists/drop-reasons").then((d) => setDropReasons(d.items)),
  ]).catch((e: any) => setError(e.message)).finally(() => setLoaded(true));
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
                const msg = `Hello ${name}! View your attendance and exam eligibility here: ${url}`;
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
                const csv = bulkSmsCsv(targets, (t: any) => `Hello ${t.name}! View your attendance and exam eligibility here: ${t.url}`);
                const a = document.createElement("a");
                a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                a.download = "sms-attendance-links.csv"; a.click();
              }}>Download bulk SMS file</button>
          </div>
        )}
        <DataTable rows={members} loading={!loaded}
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
// role: a Location (principal/SPOC) login VIEWS attendance like an admin but never marks
// it — "no attendance, attendance trainer karega" (Umesh role matrix, 2026-08-13). The
// entry form and the +Round/Edit affordances are simply not rendered; the server 403s
// regardless (batches.daily_log removed from the Location role).
function DailyExecution({ batchId, batch, role, setError }: any) {
  const canMark = role !== "Location";
  const [logs, setLogs] = useState<any[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ log_date: toInputDate(new Date()), present: new Set<string>(), biometric: new Set<string>(), photos: [], videos: [] });
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(0);
  const [editLog, setEditLog] = useState<any>(null);
  const [roundLog, setRoundLog] = useState<any>(null); // "mark another round" target (Karunn: P-P-P multiple times a day)

  const [loaded, setLoaded] = useState(false);
  const load = () => Promise.all([
    api(`/api/batches/${batchId}/logs`).then((d) => setLogs(d.items)),
    api(`/api/batches/${batchId}/members`).then((d) => setMembers(d.items.filter((m: any) => !m.left_on))),
  ]).catch((e: any) => setError(e.message)).finally(() => setLoaded(true));
  useEffect(() => { load(); setQueued(getQueue().length); }, [batchId]);

  function togglePresent(id: string) {
    const s = new Set<string>(form.present);
    const b = new Set<string>(form.biometric);
    if (s.has(id)) { s.delete(id); b.delete(id); } // Rule 51: un-presenting clears the biometric tick
    else s.add(id);
    setForm({ ...form, present: s, biometric: b });
  }
  function toggleBiometric(id: string) {
    const b = new Set<string>(form.biometric);
    if (b.has(id)) b.delete(id); else if (form.present.has(id)) b.add(id); // biometric only when present
    setForm({ ...form, biometric: b });
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
          biometric_member_ids: [...form.biometric], // Rule 51: subset of present, UI enforces too
          trainer_present: form.trainer_present !== false, // default true; unticking blocks student marks (portal rule)
          govt_present: form.govt_present === "" || form.govt_present == null ? null : +form.govt_present,
          govt_screenshot: form.govt_screenshot,
          photos: form.photos, videos: form.videos, note: form.note,
        },
      });
      setForm({ log_date: toInputDate(new Date()), present: new Set(), biometric: new Set(), photos: [], videos: [] });
      load();
    } catch (e: any) { setError(e.message); }
    setBusy(false);
  }

  if (!["Active", "Closing"].includes(batch.status)) {
    return <p className="p-6 text-center text-sm text-gray-400">Daily logs open once the batch is Active.</p>;
  }

  // CEO 13/08 (3-way): "100% attendance = itne hours; hamare records ke hisaab se itne;
  // govt portal ke hisaab se itne." Expected = operating days elapsed × roster (an
  // approximation against TODAY's roster, said as such); ours/govt summed from the logs.
  const roster = members.length;
  const opDays: number[] = batch.program?.operating_days ?? [1, 2, 3, 4, 5, 6];
  let expDays = 0;
  if (batch.actual_start) {
    const end = batch.actual_end ? new Date(batch.actual_end) : new Date();
    for (let d = new Date(batch.actual_start); d <= end; d.setDate(d.getDate() + 1)) {
      if (opDays.includes(d.getDay())) expDays++;
    }
  }
  const expSD = expDays * roster;
  const oursSD = logs.reduce((s: number, l: any) => s + (l.internal_present ?? 0), 0);
  const govtSD = logs.reduce((s: number, l: any) => s + (l.govt_present ?? 0), 0);
  const hoursPerDay = batch.program?.hours && batch.program?.duration_days ? batch.program.hours / batch.program.duration_days : 8;
  const pct = (n: number) => (expSD > 0 ? Math.round((100 * n) / expSD) : null);

  return (
    <div className="space-y-4">
      {!canMark && (
        <p className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-2.5 text-xs text-gray-500">
          Attendance is marked by the batch trainer — this view is read-only for your role.
        </p>
      )}
      {expSD > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-xl border border-gray-200/80 bg-white p-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-gray-400">Expected so far (100%)</div>
            <div className="text-lg font-semibold text-gray-900">{expSD} <span className="text-xs font-normal text-gray-400">student-days</span></div>
            <div className="text-[11px] text-gray-400">{expDays} operating days × {roster} on roster · ≈{Math.round(expSD * hoursPerDay)} hrs</div>
          </div>
          <div className={`rounded-xl border p-3 ${oursSD < expSD * 0.6 ? "border-amber-300 bg-amber-50" : "border-gray-200/80 bg-white"}`}>
            <div className="text-[11px] font-medium uppercase tracking-wider text-gray-400">Our records (trainer-marked)</div>
            <div className="text-lg font-semibold text-gray-900">{oursSD} <span className="text-xs font-normal text-gray-400">({pct(oursSD)}%)</span></div>
            <div className="text-[11px] text-gray-400">≈{Math.round(oursSD * hoursPerDay)} hrs marked</div>
          </div>
          <div className={`rounded-xl border p-3 ${govtSD > oursSD ? "border-amber-300 bg-amber-50" : "border-gray-200/80 bg-white"}`}>
            <div className="text-[11px] font-medium uppercase tracking-wider text-gray-400">Govt portal</div>
            <div className="text-lg font-semibold text-gray-900">{govtSD} <span className="text-xs font-normal text-gray-400">({pct(govtSD)}%)</span></div>
            <div className="text-[11px] text-gray-400">from verified/imported days only</div>
          </div>
        </div>
      )}
      {canMark && <Section title="Today's entry">
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
            <div className="mb-1.5 text-xs font-medium text-gray-600">
              Attendance — tap present ({form.present.size}/{members.length})
              <span className="ml-2 font-normal text-gray-400">then tap “Bio” if their biometric was done ({form.biometric.size})</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4">
              {/* Karunn 2026-08-13: per-student biometric tick — "done & present" / "not done &
                  present" allowed; "done & NOT present" impossible (Rule 51, server-enforced;
                  the Bio chip only even appears once the student is marked present). */}
              {members.map((m) => (
                <button key={m._id} onClick={() => togglePresent(m._id)}
                  className={`rounded-lg border px-2 py-2.5 text-left text-sm ${form.present.has(m._id) ? "border-green-300 bg-green-50 text-green-800" : "border-gray-200 bg-white text-gray-500"}`}>
                  <span className="flex items-center justify-between gap-1">
                    <span className="min-w-0 truncate">{form.present.has(m._id) ? "✓ " : ""}{m.candidate?.name}</span>
                    {form.present.has(m._id) && (
                      <span onClick={(e) => { e.stopPropagation(); toggleBiometric(m._id); }}
                        title="Biometric done on the govt app?"
                        className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${form.biometric.has(m._id) ? "border-blue-300 bg-blue-100 text-blue-700" : "border-gray-300 bg-white text-gray-400"}`}>
                        Bio{form.biometric.has(m._id) ? " ✓" : ""}
                      </span>
                    )}
                  </span>
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
      </Section>}

      {/* 2026-08-13: "har batch ke andar daily basis pe upload attendance" — the portal CSV
          imports from here with this batch preselected (the engine batch-scopes the match).
          Umesh (13/08): "bulk sheet upload wali functionality show nahi ho rahi" — a text link
          was invisible; it is a real button now. */}
      <Section title="History" actions={
        // Bulk portal import is Admin/Ops work (attendance.govt) — not the trainer's, not the principal's.
        (role === "Admin" || role === "Operations") ? (
          <a className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700" href={`${BASE_PATH}/govt-attendance?batch=${batchId}`}>
            ⬆ Upload attendance sheet (bulk)
          </a>
        ) : undefined
      }>
        <DataTable rows={logs} loading={!loaded}
          cardTitle={(r: any) => fmtDate(r.log_date)}
          columns={[
            // mobile:false — the card already leads with this date as its title (audit F-005).
            { key: "log_date", label: "Date", render: (r: any) => fmtDate(r.log_date), mobile: false },
            { key: "trainer_present", label: "Trainer", mobile: false, render: (r: any) => r.trainer_present === false ? <span className="font-semibold text-red-600">✗</span> : r.trainer_present ? <span className="text-green-700">✓</span> : <span className="text-gray-400">—</span> },
            { key: "internal_present", label: "Internal", render: (r: any) => `${r.internal_present}/${r.roster_count} (${r.roster_count ? Math.round((100 * r.internal_present) / r.roster_count) : 0}%)` },
            {
              // Karunn: rounds with timestamps + who has biometric done — visible per day.
              key: "sessions", label: "Rounds / Bio", mobile: false,
              filterText: (r: any) => `${(r.sessions ?? []).length} rounds`,
              render: (r: any) => (
                <span className="text-xs">
                  {(r.sessions ?? []).length
                    ? <span title={(r.sessions ?? []).map((s: any) => `${new Date(s.at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}${s.correction ? " (correction)" : ""}: ${s.present_member_ids?.length ?? 0} present`).join("\n")}>
                        {(r.sessions ?? []).length}× <span className="text-gray-400">last {new Date(r.sessions[r.sessions.length - 1].at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" })}</span>
                      </span>
                    : <span className="text-gray-400">—</span>}
                  <span className="block text-gray-400">Bio {(r.biometric_member_ids ?? []).length}/{r.internal_present}</span>
                </span>
              ),
            },
            { key: "govt_present", label: "Govt", render: (r: any) => r.govt_present == null ? <span className="text-gray-400">Not verified</span> : `${r.govt_present}/${r.roster_count} (${Math.round((100 * r.govt_present) / r.roster_count)}%)` },
            { key: "gap", label: "Gap", render: (r: any) => <Gap r={r} /> },
            { key: "actual_topic", label: "Topic", render: (r: any) => r.actual_topic ?? r.planned_topic ?? "—", mobile: false },
            { key: "photos", label: "Media", render: (r: any) => <MediaCell r={r} /> },
            { key: "_edit", label: "", render: (r: any) => canMark ? (
              <span className="flex gap-1.5">
                <Btn small kind="ghost" onClick={() => setRoundLog(r)}>+ Round</Btn>
                <Btn small kind="ghost" onClick={() => setEditLog(r)}>Edit</Btn>
              </span>
            ) : null },
          ]} empty="No logs yet." />
      </Section>
      <LogEditDrawer log={editLog} members={members} onClose={() => setEditLog(null)} onSaved={() => { setEditLog(null); load(); }} setError={setError} />
      <RoundDrawer log={roundLog} members={members} onClose={() => setRoundLog(null)} onSaved={() => { setRoundLog(null); load(); }} setError={setError} />
    </div>
  );
}

// Karunn 2026-08-13: "din mein do baar, teen baar, jitni baar bhi P-P-P" — a fresh marking
// round for an existing day. Unions into the day server-side; timestamps kept per round.
function RoundDrawer({ log, members, onClose, onSaved, setError }: any) {
  const [present, setPresent] = useState<Set<string>>(new Set());
  const [biometric, setBiometric] = useState<Set<string>>(new Set());
  useEffect(() => { setPresent(new Set()); setBiometric(new Set()); }, [log]);
  if (!log) return null;
  const already = new Set((log.present_member_ids ?? []).map(String));
  const toggleP = (id: string) => {
    const s = new Set(present), b = new Set(biometric);
    if (s.has(id)) { s.delete(id); b.delete(id); } else s.add(id);
    setPresent(s); setBiometric(b);
  };
  const toggleB = (id: string) => {
    const b = new Set(biometric);
    if (b.has(id)) b.delete(id); else if (present.has(id)) b.add(id);
    setBiometric(b);
  };
  async function save() {
    try {
      await api(`/api/logs/${log._id}/sessions`, { method: "POST", json: { present_member_ids: [...present], biometric_member_ids: [...biometric] } });
      onSaved();
    } catch (e: any) { setError(e.message); onClose(); }
  }
  return (
    <Drawer open onClose={onClose} title={`Marking round — ${fmtDate(log.log_date)}`} wide>
      <div className="space-y-4">
        <p className="text-xs text-gray-500">
          Round {(log.sessions?.length ?? 0) + 1} of the day, timestamped now. A student present in ANY round counts present for the day —
          already marked today: <span className="font-medium text-gray-700">{already.size}</span>. Tap “Bio” where the govt-app biometric was done.
        </p>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {members.map((m: any) => (
            <button key={m._id} onClick={() => toggleP(String(m._id))}
              className={`rounded-lg border px-2 py-2 text-left text-sm ${present.has(String(m._id)) ? "border-green-300 bg-green-50 text-green-800" : already.has(String(m._id)) ? "border-gray-200 bg-gray-50 text-gray-400" : "border-gray-200 bg-white text-gray-500"}`}>
              <span className="flex items-center justify-between gap-1">
                <span className="min-w-0 truncate">{present.has(String(m._id)) ? "✓ " : already.has(String(m._id)) ? "· " : ""}{m.candidate?.name}</span>
                {present.has(String(m._id)) && (
                  <span onClick={(e) => { e.stopPropagation(); toggleB(String(m._id)); }} title="Biometric done on the govt app?"
                    className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${biometric.has(String(m._id)) ? "border-blue-300 bg-blue-100 text-blue-700" : "border-gray-300 bg-white text-gray-400"}`}>
                    Bio{biometric.has(String(m._id)) ? " ✓" : ""}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
        <Btn onClick={save} disabled={present.size === 0 && biometric.size === 0}>Save round ({present.size} present · {biometric.size} bio)</Btn>
      </div>
    </Drawer>
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
      biometric: new Set((log.biometric_member_ids ?? []).map(String)),
    });
  }, [log]);
  if (!log || !form) return null;

  const toggle = (id: string) => {
    const s = new Set<string>(form.present);
    const b = new Set<string>(form.biometric);
    if (s.has(id)) { s.delete(id); b.delete(id); } // Rule 51: un-presenting clears biometric
    else s.add(id);
    setForm({ ...form, present: s, biometric: b });
  };
  const toggleBio = (id: string) => {
    const b = new Set<string>(form.biometric);
    if (b.has(id)) b.delete(id); else if (form.present.has(id)) b.add(id);
    setForm({ ...form, biometric: b });
  };

  async function save() {
    try {
      await api(`/api/logs/${log._id}`, {
        method: "PATCH",
        json: {
          planned_topic: form.planned_topic, actual_topic: form.actual_topic,
          present_member_ids: [...form.present],
          biometric_member_ids: [...form.biometric],
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
          <div className="mb-1.5 text-xs font-medium text-gray-600">Present ({form.present.size}) <span className="font-normal text-gray-400">· Bio done ({form.biometric.size})</span></div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {members.map((m: any) => (
              <button key={m._id} onClick={() => toggle(String(m._id))}
                className={`rounded-lg border px-2 py-2 text-left text-sm ${form.present.has(String(m._id)) ? "border-green-300 bg-green-50 text-green-800" : "border-gray-200 bg-white text-gray-500"}`}>
                <span className="flex items-center justify-between gap-1">
                  <span className="min-w-0 truncate">{form.present.has(String(m._id)) ? "✓ " : ""}{m.candidate?.name}</span>
                  {form.present.has(String(m._id)) && (
                    <span onClick={(e) => { e.stopPropagation(); toggleBio(String(m._id)); }} title="Biometric done on the govt app?"
                      className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${form.biometric.has(String(m._id)) ? "border-blue-300 bg-blue-100 text-blue-700" : "border-gray-300 bg-white text-gray-400"}`}>
                      Bio{form.biometric.has(String(m._id)) ? " ✓" : ""}
                    </span>
                  )}
                </span>
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
// F-A4 (Manish): result_file / certificate_file lived in the schema with no way to put
// anything in them. A slot renders the file when present and offers Upload/Replace until
// the batch closes (post-completion the closure PUT is frozen anyway — DEC-6).
function ClosureFileSlot({ label, value, onUpload, disabled }: any) {
  return (
    <div className="mt-2 flex items-center gap-2 text-xs">
      <span className="text-gray-500">{label}:</span>
      {value ? <a className="text-blue-600 underline" href={value} target="_blank" rel="noreferrer">view file</a> : <span className="text-gray-400">none</span>}
      {!disabled && (
        <label className="cursor-pointer rounded border border-gray-300 px-2 py-0.5 font-medium text-gray-700 hover:bg-gray-50">
          {value ? "Replace" : "Upload"}
          <input type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.webp,.xlsx,.xls,.csv" onChange={onUpload} />
        </label>
      )}
    </div>
  );
}

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
  async function uploadClosureFile(e: any, field: "result_file" | "certificate_file") {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch(`${BASE_PATH}/api/upload`, { method: "POST", body: fd });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { setError(d.error ?? "Upload failed"); return; }
    saveClosure({ [field]: d.url });
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
        <ClosureFileSlot label="Result sheet" value={closure?.result_file} disabled={closed} onUpload={(e: any) => uploadClosureFile(e, "result_file")} />
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
        <ClosureFileSlot label="Certificate bundle" value={closure?.certificate_file} disabled={closed} onUpload={(e: any) => uploadClosureFile(e, "certificate_file")} />
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
          {/* Rule 52 (CEO): payment aane ke baad bhi batch CLOSED tabhi jab SAB dues settle —
              "main khali payment lene mein interested nahi hoon; no dues, tab close". */}
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!closure?.dues_settled}
                onChange={(e) => saveClosure({ dues_settled: e.target.checked })} />
              <span className="font-medium">All dues settled — trainer, centre, vendor: NO dues pending</span>
            </label>
            {closure?.dues_settled && closure?.dues_marked_at && (
              <p className="mt-1 text-xs text-gray-500">Attested {fmtDate(closure.dues_marked_at)}</p>
            )}
            <input className={inputCls + " mt-2"} placeholder="Dues note (optional — what was settled, references)"
              value={closure?.dues_note ?? ""} onChange={(e) => saveClosure({ dues_note: e.target.value })} />
            <p className="mt-2 text-xs text-gray-500">
              Batch closes from the Overview tab once certification is Completed, the invoice is
              PAID, and this attestation is ticked (Rule 52).
            </p>
          </div>
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
  const [certUpload, setCertUpload] = useState<any>(null); // last bulk-upload report
  const [uploading, setUploading] = useState(false);
  const closed = ["Completed", "Cancelled"].includes(batch?.status);

  // 2026-08-14 (CEO 49:33): "sare certificate ek folder mein ID ke saath — upload hote
  // hi bachche ke saamne assign." Multi-file picker → the CAN id in each FILENAME joins
  // to the roster's sidh_candidate_id server-side; the report below names every file
  // that could not be placed and why. Available on Completed batches too — the endpoint
  // only ever FILLS an absent certificate_file there (DEC-6 stays intact).
  async function uploadCertificates(list: FileList | null) {
    if (!list?.length) return;
    setUploading(true);
    try {
      const fd = new FormData();
      for (const f of Array.from(list)) fd.append("files", f);
      const res = await fetch(`${BASE_PATH}/api/batches/${batchId}/certificates`, { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
      setCertUpload(data);
      await load(); onChanged();
    } catch (e: any) { setError(e.message); }
    finally { setUploading(false); }
  }

  const [loaded, setLoaded] = useState(false);
  const load = () => Promise.all([
    api(`/api/batches/${batchId}/results`).then((d) => { setItems(d.items); setSummary(d.summary); }),
    api("/api/master-lists/failure-reasons").then((d) => setReasons(d.items)).catch(() => setReasons([])),
  ]).catch((e: any) => setError(e.message)).finally(() => setLoaded(true));
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

      {batch?.status !== "Cancelled" && (
        <div className="mb-3 rounded-lg border border-gray-200 bg-white p-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium text-white ${uploading ? "bg-gray-400" : "bg-blue-600 hover:bg-blue-700"}`}>
              {uploading ? "Uploading…" : "⬆ Upload certificates (bulk)"}
              <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden" disabled={uploading}
                onChange={(e) => { uploadCertificates(e.target.files); e.target.value = ""; }} />
            </label>
            <span className="text-xs text-gray-500">
              File names carry the candidate id — <span className="font-mono">CAN_12345.pdf</span> lands on that candidate automatically. Pass results only (Rule 45).
            </span>
          </div>
          {certUpload && (
            <div className="mt-2 space-y-1 text-xs">
              <p className="font-medium text-gray-700">
                {certUpload.summary?.matched ?? 0} placed · {certUpload.summary?.unmatched ?? 0} not placed (of {certUpload.summary?.received ?? 0})
              </p>
              {(certUpload.matched ?? []).map((m: any, i: number) => (
                <p key={`m${i}`} className="text-green-700">✓ {m.original} → {m.candidate} ({m.can_id})</p>
              ))}
              {(certUpload.unmatched ?? []).map((u: any, i: number) => (
                <p key={`u${i}`} className="text-amber-700">✗ {u.filename} — {u.reason}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {view === "review" ? (
        <DataTable rows={items} loading={!loaded}
          cardTitle={(r: any) => r.candidate?.name}
          columns={[
            { key: "candidate", label: "Candidate", render: (r: any) => <NameCell name={r.candidate?.name} sub={r.candidate?.phone} /> },
            { key: "result", label: "Result", render: (r: any) => <Chip value={r.result?.result ?? "Pending"} /> },
            { key: "score", label: "Score", render: (r: any) => r.result?.score ?? "—" },
            { key: "assessor", label: "Assessor", render: (r: any) => r.result?.assessor ?? "—", mobile: false },
            { key: "failure_reason", label: "Failure reason", render: (r: any) => r.result?.failure_reason ?? "—" },
            { key: "cert", label: "Certificate", render: (r: any) => (
              <span className="inline-flex items-center gap-1.5">
                {r.result?.certificate_no ? `${r.result.certificate_no} (${r.result.certificate_status})` : (r.result?.certificate_status ?? "—")}
                {r.result?.certificate_file && <a className="text-blue-600 underline" href={r.result.certificate_file} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>file</a>}
              </span>
            ) },
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
                const msg = `Hello ${name}! Please share your training feedback: ${url}`;
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
                const csv = bulkSmsCsv(targets, (t: any) => `Hello ${t.name}! Please share your training feedback: ${t.url}`);
                const a = document.createElement("a");
                a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
                a.download = "sms-feedback-links.csv"; a.click();
              }}>Download bulk SMS file</button>
          </div>
        )}
        <DataTable rows={data?.items ?? []} loading={!data}
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

  const [loaded, setLoaded] = useState(false);
  const load = () => Promise.all([
    api(`/api/costs?batch=${batchId}`).then((d) => setItems(d.items)),
    api("/api/master-lists/cost-categories").then((d) => setCats(d.items)),
  ]).catch((e: any) => setError(e.message)).finally(() => setLoaded(true));
  useEffect(() => { load(); }, [batchId]);

  // Trainer fee suggestion — honours the trainer's compensation model (F-B1):
  // Batch-wise / Fixed → the recorded fixed amount; otherwise day_rate × distinct
  // training days (DailyLog dates). Suggestion only — nothing is written until added.
  useEffect(() => {
    const trainerId = batch.trainer?._id ?? batch.trainer;
    if (!trainerId) return;
    Promise.all([api(`/api/trainers/${trainerId}`), api(`/api/batches/${batchId}/logs`)])
      .then(([t, l]) => {
        const tr = t.item ?? {};
        const days = l.items?.length ?? 0;
        if (["Batch-wise", "Fixed"].includes(tr.compensation_type) && tr.compensation_fixed > 0) {
          setSuggest({ trainer: trainerId, name: tr.name, amount: tr.compensation_fixed,
            basis: tr.compensation_type === "Batch-wise" ? "batch-wise fixed" : "fixed compensation" });
        } else if (tr.day_rate > 0 && days > 0) {
          setSuggest({ trainer: trainerId, name: tr.name, amount: tr.day_rate * days,
            basis: `₹${tr.day_rate}/day × ${days} training day${days === 1 ? "" : "s"}` });
        }
      })
      .catch(() => {});
  }, [batchId, batch]);

  async function addSuggested() {
    // F-B17: case-insensitive — production carried "Trainer fee" alongside "Trainer Fee".
    const cat = cats.find((c: any) => c.name?.toLowerCase() === "trainer fee");
    if (!cat) { setError('Cost category "Trainer Fee" not found — add it in Admin → Master Lists.'); return; }
    try {
      await api("/api/costs", {
        method: "POST",
        json: {
          entry_date: toInputDate(new Date()), batch: batchId, location: batch.location?._id ?? batch.location,
          trainer: suggest.trainer, category: cat._id, amount: suggest.amount,
          note: `Auto-suggested: ${suggest.basis} (${suggest.name})`,
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

  const hasTrainerFee = items.some((i) => i.category?.name?.toLowerCase() === "trainer fee");

  return (
    <Section title={`Cost entries — total ₹${total.toLocaleString("en-IN")}`}>
      {suggest && !hasTrainerFee && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          <span>Trainer fee suggestion: <b>₹{suggest.amount.toLocaleString("en-IN")}</b> — {suggest.basis} ({suggest.name})</span>
          <Btn small onClick={addSuggested}>Add as cost entry</Btn>
        </div>
      )}
      <DataTable rows={items} loading={!loaded}
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
