"use client";
import { Suspense, use, useEffect, useState } from "react";
import { api, fmtDate, offerable } from "@/lib/client";
import { useSearchParams } from "next/navigation";
import { BackLink, Btn, Chip, CopyBtn, DataTable, Drawer, ErrorBanner, Field, Section, Tabs, inputCls } from "@/components/ui";
import { Activity } from "@/components/activity";
import { usePerms } from "@/components/shell";
import Link from "next/link";
// QA-1749 (REQ-389a): this screen renders a numbered trainer list an operator acts on.
import { trainerLabel } from "@/lib/person";

// -115 (QA-221): a RETIRED programme (active === false) leaves the pickers where something new is
// created, but never disappears from a record that already points at one — editing such a record must
// not silently blank the field. Retiring is a decision about what may be started, not about history.


const TABS = ["Overview", "Contacts & Notes", "Capacity & Target", "Trainers & Infra", "Batches", "Activity"];

export default function LocationDetail({ params }: { params: Promise<{ id: string }> }) {
  return <Suspense><LocationDetailInner params={params} /></Suspense>;
}

function LocationDetailInner({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  // QA-223 (Manish 17/08 M4-08): the tab lived in local state, so nothing could link INTO a tab —
  // which is exactly why the Locations table's "Trainer Required" cell had nowhere useful to send
  // anyone. ?tab= opens the right one, the same shape the batch page already uses.
  const sp = useSearchParams();
  const wanted = sp.get("tab");
  const [tab, setTab] = useState(wanted && TABS.includes(wanted) ? wanted : "Overview");
  const [loc, setLoc] = useState<any>(null);
  const [error, setError] = useState("");

  const load = () => api(`/api/locations/${id}`).then((d) => setLoc(d.item)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);

  if (!loc) return error ? <ErrorBanner msg={error} /> : <div className="p-8 text-center text-gray-400">Loading…</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <BackLink fallback="/locations" label="Locations" />
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
        "institution_id", // QA-117
        "district", "tc_id", "tc_status", "tc_password",
        "mobile_otp", "aebas_link", "aebas_id", "aebas_password",
        "operating_partner", "cluster_head_name", "cluster_head_phone"]) {
        if (form[f] !== loc[f]) patch[f] = form[f];
      }
      const res = await api(`/api/locations/${loc._id}`, { method: "PATCH", json: patch });
      // R-F: a centre login's edit parks for Admin approval — the 202 carries the message.
      if (res?.error) setError(res.error);
      onSaved();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <Section title="Master fields" actions={<Btn small onClick={save}>Save</Btn>}>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name"><input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="External ID"><input className={inputCls} value={form.external_id ?? ""} onChange={(e) => set("external_id", e.target.value)} /></Field>
        <Field label="Institution ID (unique)"><input className={inputCls} placeholder="e.g. INST-0001" value={form.institution_id ?? ""} onChange={(e) => set("institution_id", e.target.value)} /></Field>
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
        {/* 2026-08-31: client added 4 columns to the same OneDrive workbook — a second govt
            portal login (AEBAS, biometric attendance), separate from TC ID/Password above. */}
        <Field label="Mobile number (OTP)"><input className={inputCls} value={form.mobile_otp ?? ""} onChange={(e) => set("mobile_otp", e.target.value)} /></Field>
        <Field label="AEBAS link"><input className={inputCls} value={form.aebas_link ?? ""} onChange={(e) => set("aebas_link", e.target.value)} /></Field>
        <Field label="AEBAS ID"><input className={inputCls} value={form.aebas_id ?? ""} onChange={(e) => set("aebas_id", e.target.value)} /></Field>
        <Field label="AEBAS password (visible to locations.manage only)">
          <input type="password" className={inputCls} value={form.aebas_password ?? ""} onChange={(e) => set("aebas_password", e.target.value)} />
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
      // QA-622: `_id` travels back. Mongoose replaces a document array wholesale on assign, so an
      // entry arriving without one is given a NEW id - which meant adding a single contact silently
      // renamed every contact in the list. Nothing on this screen showed it; what it broke was the
      // plan share, which identifies a recipient by that id, so after any edit a person's own link
      // stopped being theirs and re-sending to them left two live links instead of replacing one.
      //
      // QA-627: -195's fix sent `_id` on the way OUT but never read it back on the way IN. `next`
      // is built from LOCAL state, so a contact added earlier in this same visit still has no
      // `_id` in it - only the server, on save, mints one. Seeding local state from the PATCH
      // response (which carries the saved document, ids and all) instead of from `next` is what
      // actually closes this: the id a share link is keyed on now matches what state holds before
      // the very next save, not just after a page reload.
      const res = await api(`/api/locations/${loc._id}`, { method: "PATCH", json: { contacts: next.map(({ _id, name, phone, role_label, user }) => ({ _id, name, phone, role_label, user })) } });
      // R-F: a centre login's edit parks for Admin approval - the 202 carries the message and
      // no `item`. Overview.save() below can just leave its typed form as-is when this happens;
      // this screen cannot, because it ADOPTS the response into what it shows next. Falling
      // through to `next` here would display an unsaved, un-minted-id draft as if it had gone
      // through - the exact QA-627 staleness this function exists to prevent, reopened by the
      // one save path that never reaches `res.item` at all.
      if (res?.error) { setError(res.error); return; }
      setContacts(res?.item?.contacts ?? next); onSaved();
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
                    <CopyBtn text={shareText} />
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
  // QA-496: the row that is on the WRONG job role, and where it should go. The move door
  // (PATCH .../targets) shipped in -163 and has had no screen since — `grep from_program
  // --include=*.tsx` returned nothing — so the one defect it was built to repair (560 of
  // government-approved target filed under a job role the client sheet does not even have) could
  // not be repaired by anybody. A verb nobody can press is a verb that does not exist.
  const [mv, setMv] = useState<any>(null);
  const [mvTo, setMvTo] = useState("");
  const [mvReason, setMvReason] = useState("");
  const [mvBusy, setMvBusy] = useState(false);
  const [mvErr, setMvErr] = useState("");
  // The SAME right the route asks for (requirePerm(user, "locations.manage")), not a role literal —
  // QA-798 / QA-1144 are the standing rows for controls that decide from a role while the server
  // decides from a permission, and they disagree the moment the matrix is edited.
  const { can, loaded: permsLoaded } = usePerms();
  const canMove = !permsLoaded || can("locations.manage", "edit");

  const load = () => Promise.all([
    api(`/api/locations/${locationId}/targets`).then((d) => setItems(d.items)),
    api("/api/programs?limit=1000").then((d) => setPrograms(d.items)),
  ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [locationId]);

  async function save() {
    try {
      const res = await api(`/api/locations/${locationId}/targets`, { method: "PUT", json: form });
      // R-F: a centre login's target change parks for Admin approval (202, queued).
      if (res?.queued) setError(`Sent to the Admin for approval — the target updates once approved.`);
      setForm({}); load();
    } catch (e: any) { setError(e.message); }
  }

  // QA-496: a MOVE, not a delete-and-retype — the row carries its own tc_id, tc_status and the
  // sheet's claimed counts, and re-keying it by hand would lose all of that. The refusal the server
  // gives when the destination already has a row is shown VERBATIM and nothing is decided here:
  // merging two government targets is a decision about which figures survive, and that belongs to
  // the person, not to write order.
  async function moveRow() {
    if (!mv) return;
    setMvErr(""); setMvBusy(true);
    try {
      await api(`/api/locations/${locationId}/targets`, {
        method: "PATCH",
        json: { from_program: mv.program?._id ?? mv.program, to_program: mvTo, reason: mvReason.trim() },
      });
      setMv(null); setMvTo(""); setMvReason(""); load();
    } catch (e: any) { setMvErr(e.message); }
    finally { setMvBusy(false); }
  }

  return (
    <div className="space-y-4">
      <Section title="Program-wise targets">
        <DataTable rows={items}
          cardTitle={(r: any) => r.program?.name}
          columns={[
            { key: "program", label: "Program", render: (r: any) => <span>{r.program?.name ?? "?"}{r.program?.scheme ? <span className="text-xs text-gray-400"> ({r.program.scheme})</span> : null}</span> },
            {
              // 2026-08-13 (Manish: "31 approved"): each job-role row has its OWN TC id + verdict.
              key: "tc", label: "TC (per job role)", filterText: (r: any) => `${r.tc_id ?? ""} ${r.tc_status ?? ""}`,
              render: (r: any) => (
                <span className="text-xs">
                  {r.tc_id ?? <span className="text-gray-400">no TC ID</span>}
                  <span className="block">{r.tc_status ? <Chip value={r.tc_status} /> : <span className="text-gray-400">status —</span>}</span>
                </span>
              ),
            },
            {
              // 2026-08-31: the row's own AEBAS login, same reasoning as the TC column above.
              // Never renders the raw password (QA-289's "not on screen unless asked" — the same
              // rule the centre-level door already follows), just whether one is set.
              key: "aebas", label: "AEBAS (per job role)", mobile: false,
              filterText: (r: any) => `${r.aebas_id ?? ""} ${r.mobile_otp ?? ""}`,
              render: (r: any) => (
                <span className="text-xs">
                  {r.aebas_id ?? <span className="text-gray-400">no AEBAS ID</span>}
                  <span className="block text-gray-400">
                    {(r.aebas_password || r.aebas_password_set) ? "password set" : "password —"}
                  </span>
                </span>
              ),
            },
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
              key: "trainers", label: "Trainers (ours)", render: (r: any) => r.trainers ? (
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
              // 2026-08-13 (Karunn): the sheet's CLAIMED trainer counts, shown beside ours so
              // the match/variance reads at a glance — soft data, never merged into our figure.
              key: "trainers_sheet", label: "Trainers (sheet says)", mobile: false,
              render: (r: any) => (r.nominations_received_reported ?? r.nominated_nsdc_reported ?? r.trainers_certified_reported) == null
                ? <span className="text-xs text-gray-400">—</span> : (
                  <span className="text-xs text-gray-600">
                    {r.trainers_certified_reported ?? 0} certified
                    <span className="block text-gray-400">
                      {r.nominations_received_reported ?? 0} nominations · {r.nominated_nsdc_reported ?? 0} to NSDC
                    </span>
                    {r.trainers && r.trainers_certified_reported != null && r.trainers_certified_reported !== r.trainers.certified && (
                      <span className="block font-medium text-amber-700">ours: {r.trainers.certified}</span>
                    )}
                  </span>
                ),
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
            {
              // QA-496: the repair for a row filed under the wrong job role. It sits ON the row
              // because that is the only place a person can see WHICH row is wrong — the job role,
              // its TC ID and its verdict are all one line to the left.
              key: "_move", label: "", render: (r: any) => (
                <Btn small kind="ghost" disabled={!canMove}
                  onClick={() => { setMv(r); setMvTo(""); setMvReason(""); setMvErr(""); }}>
                  Move job role
                </Btn>
              ),
            },
          ]}
          empty="No targets yet."
        />
      </Section>
      <Section title="Set / update target">
        <div className="grid gap-3 md:grid-cols-4">
          <Field label="Program" required>
            <select className={inputCls} value={form.program ?? ""} onChange={(e) => setForm({ ...form, program: e.target.value })}>
              <option value="">Select…</option>
              {offerable(programs, form.program).map((p) => <option key={p._id} value={p._id}>{p.name}{p.scheme ? ` (${p.scheme})` : p.code ? ` (${p.code})` : ""}</option>)}
            </select>
          </Field>
          <Field label="Approved target"><input type="number" className={inputCls} value={form.approved_target ?? ""} onChange={(e) => setForm({ ...form, approved_target: +e.target.value })} /></Field>
          <Field label="Allocated target"><input type="number" className={inputCls} value={form.allocated_target ?? ""} onChange={(e) => setForm({ ...form, allocated_target: +e.target.value })} /></Field>
          <Field label="Trainers required"><input type="number" className={inputCls} value={form.trainers_required ?? ""} onChange={(e) => setForm({ ...form, trainers_required: +e.target.value })} /></Field>
          {/* 2026-08-13 parity: the "sheet says" reported figures were API-writable but had no
              form — a centre working without the sheet could never key them. */}
          <Field label="Enrolled (client-reported)"><input type="number" className={inputCls} value={form.enrolled_reported ?? ""} onChange={(e) => setForm({ ...form, enrolled_reported: e.target.value === "" ? undefined : +e.target.value })} /></Field>
          <Field label="Pending (client-reported)"><input type="number" className={inputCls} value={form.pending_reported ?? ""} onChange={(e) => setForm({ ...form, pending_reported: e.target.value === "" ? undefined : +e.target.value })} /></Field>
          <div className="flex items-end"><Btn onClick={save} disabled={!form.program}>Save target</Btn></div>
        </div>
      </Section>
      {/* QA-496. The drawer says what is actually happening — a government approval is being moved
          from one job role to another — because "Move job role" on its own reads like a typo fix. */}
      <Drawer open={!!mv} onClose={() => setMv(null)} error={mvErr}
        title={`Move ${mv?.program?.name ?? "this target"} to another job role`}>
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            This moves the SAME row — its TC ID{mv?.tc_id ? ` (${mv.tc_id})` : ""}, its government
            verdict{mv?.tc_status ? ` (${mv.tc_status})` : ""} and the sheet&apos;s reported figures all travel
            with it. The centre&apos;s total does not change; only which job role holds
            {typeof mv?.approved_target === "number" ? ` these ${mv.approved_target}` : " this target"}.
          </p>
          <Field label="Move it to" required>
            <select className={inputCls} value={mvTo} onChange={(e) => setMvTo(e.target.value)}>
              <option value="">Select the job role the sheet actually names…</option>
              {offerable(programs, mvTo)
                .filter((p: any) => String(p._id) !== String(mv?.program?._id ?? mv?.program))
                .map((p: any) => <option key={p._id} value={p._id}>{p.name}{p.scheme ? ` (${p.scheme})` : p.code ? ` (${p.code})` : ""}</option>)}
            </select>
          </Field>
          {/* The server refuses without this and says why; the form asks for it up front rather
              than letting the person write the whole thing and then be told. */}
          <Field label="Reason" required>
            <input className={inputCls} value={mvReason} onChange={(e) => setMvReason(e.target.value)}
              placeholder="e.g. the client sheet names this centre Drone Software Technician, never Drone Service" />
          </Field>
          <Btn onClick={moveRow} disabled={mvBusy || !mvTo || !mvReason.trim()}>
            {mvBusy ? "Moving…" : "Move this target"}
          </Btn>
        </div>
      </Drawer>
    </div>
  );
}

function TrainersInfra({ locationId, setError }: any) {
  const [rooms, setRooms] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  const [programs, setPrograms] = useState<any[]>([]);
  const [readiness, setReadiness] = useState<any[]>([]);
  const [trainers, setTrainers] = useState<any[]>([]);
  // QA-1262b: the pool a centre may nominate FROM. The list above is only who is already nominated
  // here, so it can never answer "who could I put on this vacancy". Server-scoped, so a SPOC sees
  // their own centres' people and nothing else.
  const [pool, setPool] = useState<any[]>([]);
  const [nomPick, setNomPick] = useState<Record<string, string>>({});
  const [nomBusy, setNomBusy] = useState<string | null>(null);
  const [nomMsg, setNomMsg] = useState("");
  const [roomForm, setRoomForm] = useState<any>({ type: "Classroom" });
  const [roomEdit, setRoomEdit] = useState<any>(null);
  const [reqForm, setReqForm] = useState<any>({});

  const load = () => Promise.all([
    api(`/api/locations/${locationId}/rooms`).then((d) => setRooms(d.items)),
    api(`/api/trainer-requests?location=${locationId}`).then((d) => setRequests(d.items)),
    api("/api/programs?limit=1000").then((d) => setPrograms(d.items)),
    api(`/api/mapping/readiness?location=${locationId}`).then((d) => setReadiness(d.items ?? [])).catch(() => setReadiness([])),
    api(`/api/trainers?nominated_for_location=${locationId}&limit=1000`).then((d) => setTrainers(d.items ?? [])).catch(() => setTrainers([])),
    // Silently optional: a role without trainers.manage is 403'd here and simply gets no picker.
    api("/api/trainers?limit=1000").then((d) => setPool(d.items ?? [])).catch(() => setPool([])),
  ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [locationId]);

  async function addRoom() {
    try { await api(`/api/locations/${locationId}/rooms`, { method: "POST", json: roomForm }); setRoomForm({ type: "Classroom" }); load(); }
    catch (e: any) { setError(e.message); }
  }
  async function saveRoom() {
    try {
      const { _id, ...patch } = roomEdit;
      await api(`/api/rooms/${_id}`, { method: "PATCH", json: { ...patch, capacity: patch.capacity === "" ? undefined : patch.capacity } });
      setRoomEdit(null); load();
    } catch (e: any) { setError(e.message); }
  }
  async function addRequest() {
    try { await api("/api/trainer-requests", { method: "POST", json: { ...reqForm, location: locationId } }); setReqForm({}); load(); }
    catch (e: any) { setError(e.message); }
  }
  // F-A9: one click turns this centre's empty trainer slots into TrainerRequests —
  // the endpoint refuses halted/unapproved centres and never doubles an Open request.
  // QA-1262b (client, 25/08): "ab humare paas yaha yeh request aani chahiye, isko add karne ka option
  // aana chahiye apne paas, edit karne ka. Ki main yaha se bhi kar pau." NO NEW DOOR — this is the
  // trainer PATCH route the trainer's own page already uses, which accepts these two fields, is
  // gated on `trainers.manage`, and already runs assertLocationOperational. Rule T3 is untouched: a
  // nomination is still against one specific vacancy, it is just reachable from the vacancy now.
  async function nominate(programId: string) {
    const trainerId = nomPick[programId];
    if (!trainerId) return;
    setNomBusy(programId); setNomMsg("");
    try {
      await api(`/api/trainers/${trainerId}`, { method: "PATCH", json: { nominated_for_location: locationId, nominated_for_program: programId } });
      setNomPick({ ...nomPick, [programId]: "" });
      setNomMsg("Nominated. The slot below and the Locations grid both count it now.");
      load();
    } catch (e: any) { setError(e.message); }
    finally { setNomBusy(null); }
  }

  const [shortfallMsg, setShortfallMsg] = useState("");
  async function raiseShortfall() {
    try {
      const res = await api("/api/trainer-requests/from-shortfall", { method: "POST", json: { location: locationId } });
      const skipNote = res.skipped?.length ? ` · ${res.skipped.length} skipped: ${res.skipped[0].reason}` : "";
      setShortfallMsg(`${res.summary?.created ?? 0} request${(res.summary?.created ?? 0) === 1 ? "" : "s"} raised${skipNote}`);
      load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      {/* 2026-08-08: "wo trainer jitne chahiye — Trainer 1, Trainer 2, Trainer 3 — iske aage
          dikhne lag jaye ki kya-kya kahani hai." One slot per required trainer, each filled by a
          named person at their pipeline stage; an empty slot is unstarted hiring, said plainly. */}
      {readiness.length > 0 && (
        <Section title="Trainer slots — required vs who is actually filling them"
          actions={<span className="flex items-center gap-2">
            {nomMsg && <span className="text-xs text-green-700">{nomMsg}</span>}
            {shortfallMsg && <span className="text-xs text-green-700">{shortfallMsg}</span>}
            <Btn small kind="ghost" onClick={raiseShortfall}>⚑ Raise requests for gaps</Btn>
          </span>}>
          <div className="space-y-3">
            {readiness.map((r: any) => {
              const progId = r.program?._id;
              // QA-1262b (client, 25/08: "jaise hi main is location ko trainer assign karta hu, wo
              // bhi aa jaye"): the names come from the READINESS row now, which derives them through
              // `trainerTiesFor` — so a trainer running this centre's batch appears here even with no
              // nomination, and the count above the list can no longer disagree with the list itself.
              // Falls back to the separately-loaded nominated set if an older API is answering.
              const people: any[] = (r.trainers?.people ?? []).length
                ? r.trainers.people.filter((t: any) => t.stage !== "Dropped")
                : trainers.filter((t: any) => (t.nominated_for_program?._id ?? t.nominated_for_program) === progId && t.pipeline_status !== "Dropped")
                    .map((t: any) => ({ _id: t._id, name: t.name, label: trainerLabel(t), stage: t.pipeline_status }));
              const named = people;
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
                            {t.label || t.name}
                            <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-semibold ${
                              t.stage === "Certified" ? "border-green-200 bg-green-50 text-green-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
                              {t.stage || "—"}
                            </span>
                          </Link>
                        ) : (
                          <span className="text-xs text-gray-400">empty — hiring not started (raise a trainer request below)</span>
                        )}
                      </li>
                    ))}
                  </ol>
                  {pool.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2">
                      <span className="text-xs text-gray-500">Nominate for this job role:</span>
                      <select className={inputCls + " h-8 w-auto py-0 text-xs"} value={nomPick[progId] ?? ""}
                        onChange={(e) => setNomPick({ ...nomPick, [progId]: e.target.value })}>
                        <option value="">Select a trainer…</option>
                        {pool
                          .filter((t: any) => t.active !== false && t.pipeline_status !== "Dropped")
                          .filter((t: any) => !named.some((n: any) => String(n._id) === String(t._id)))
                          .map((t: any) => (
                            <option key={t._id} value={t._id}>
                              {t.name}{t.pipeline_status ? ` — ${t.pipeline_status}` : ""}
                              {t.nominated_for_location?.name ? ` (now at ${t.nominated_for_location.name})` : ""}
                            </option>
                          ))}
                      </select>
                      <Btn small kind="ghost" disabled={!nomPick[progId] || nomBusy === progId} onClick={() => nominate(progId)}>
                        {nomBusy === progId ? "Saving…" : "Nominate"}
                      </Btn>
                      {/* Said out loud rather than left to be discovered: re-pointing a nomination
                          MOVES it, because a trainer carries one. The option text above already
                          names the centre they are currently up for. */}
                      <span className="text-[10px] text-gray-400">a trainer holds one nomination — picking someone already nominated elsewhere moves them here</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <Section title="Rooms (each room is booked per batch — name them so clashes are visible)">
        {/* 2026-08-13 parity: the PATCH route existed with zero UI callers — a mistyped room
            name or a room taken out of service could only be fixed in Mongo, while rooms are a
            hard readiness blocker. Row click edits in place. */}
        <DataTable rows={rooms}
          cardTitle={(r: any) => r.name}
          onRowClick={(r: any) => setRoomEdit({ _id: r._id, name: r.name, type: r.type, capacity: r.capacity ?? "", active: r.active !== false })}
          columns={[
            { key: "name", label: "Name" },
            { key: "type", label: "Type", render: (r: any) => <Chip value={r.type} /> },
            { key: "capacity", label: "Capacity" },
            { key: "active", label: "Active", render: (r: any) => (r.active ? "Yes" : "No") },
          ]} empty="No rooms yet." />
        {roomEdit && (
          <div className="mt-3 grid gap-3 rounded-lg border border-blue-200 bg-blue-50 p-3 md:grid-cols-5">
            <Field label="Room name"><input className={inputCls} value={roomEdit.name} onChange={(e) => setRoomEdit({ ...roomEdit, name: e.target.value })} /></Field>
            <Field label="Type">
              <select className={inputCls} value={roomEdit.type} onChange={(e) => setRoomEdit({ ...roomEdit, type: e.target.value })}>
                <option>Classroom</option><option>Lab</option>
              </select>
            </Field>
            <Field label="Capacity"><input type="number" className={inputCls} value={roomEdit.capacity} onChange={(e) => setRoomEdit({ ...roomEdit, capacity: e.target.value === "" ? "" : +e.target.value })} /></Field>
            <Field label="In service?">
              <select className={inputCls} value={roomEdit.active ? "yes" : "no"} onChange={(e) => setRoomEdit({ ...roomEdit, active: e.target.value === "yes" })}>
                <option value="yes">Yes</option><option value="no">No (out of service)</option>
              </select>
            </Field>
            <div className="flex items-end gap-2">
              <Btn small onClick={saveRoom} disabled={!roomEdit.name}>Save</Btn>
              <Btn small kind="ghost" onClick={() => setRoomEdit(null)}>Cancel</Btn>
            </div>
          </div>
        )}
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
              {offerable(programs, reqForm.program).map((p) => <option key={p._id} value={p._id}>{p.name}{p.scheme ? ` (${p.scheme})` : p.code ? ` (${p.code})` : ""}</option>)}
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

