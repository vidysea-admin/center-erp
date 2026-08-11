"use client";
import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { api, fmtDate, toInputDate } from "@/lib/client";
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
  const [reqEdit, setReqEdit] = useState<any>(null);
  const [reqForm, setReqForm] = useState<any>({});
  const setReq = (k: string, v: unknown) => setReqForm((f: any) => ({ ...f, [k]: v }));

  const load = () => Promise.all([
    api(`/api/trainers?q=${encodeURIComponent(q)}&limit=200`).then((d) => setItems(d.items)),
    api("/api/trainer-requests?limit=200").then((d) => setRequests(d.items)),
    api("/api/locations?limit=200").then((d) => setLocations(d.items)),
  ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [q]);

  function openEdit(t: any) {
    setEdit(t);
    setForm({ ...t, home_location: t.home_location?._id ?? "", skills: t.skills ?? [], capable_locations: (t.capable_locations ?? []).map((l: any) => l?._id ?? l) });
    setDrawer(true);
  }

  async function save() {
    try {
      const json = {
        ...form,
        skills: typeof form.skills === "string" ? form.skills.split(",").map((s: string) => s.trim()).filter(Boolean) : form.skills,
        home_location: form.home_location || undefined,
        compensation_type: form.compensation_type || undefined,
      };
      if (edit) await api(`/api/trainers/${edit._id}`, { method: "PATCH", json });
      else await api("/api/trainers", { method: "POST", json });
      setDrawer(false); setEdit(null); setForm({ max_concurrent_batches: 4, status: "Available" }); load();
    } catch (e: any) { setError(e.message); }
  }

  function openReqEdit(r: any) {
    setReqForm({
      status: r.status,
      hiring_target_date: toInputDate(r.hiring_target_date), tot_scheduled_on: toInputDate(r.tot_scheduled_on),
      tot_done_on: toInputDate(r.tot_done_on), expected_available_from: toInputDate(r.expected_available_from),
      fulfilled_by_trainer: r.fulfilled_by_trainer?._id ?? "", note: r.note ?? "",
    });
    setReqEdit(r);
  }

  async function saveReq() {
    try {
      await api(`/api/trainer-requests/${reqEdit._id}`, { method: "PATCH", json: { ...reqForm, fulfilled_by_trainer: reqForm.fulfilled_by_trainer || null } });
      setReqEdit(null); setReqForm({}); load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Trainers</h1>
        <div className="flex gap-2">
          <input className={inputCls + " max-w-52"} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <Btn onClick={() => { setEdit(null); setForm({ max_concurrent_batches: 4, status: "Available", pipeline_status: "Applied" }); setDrawer(true); }}>Add Trainer</Btn>
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
            { key: "home_location", label: "Home location", render: (r: any) => r.home_location?.name ?? "—", mobile: false },
            {
              key: "pipeline_status", label: "Pipeline", render: (r: any) => (
                <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${r.pipeline_status === "Ready to Train" ? "border-green-200 bg-green-50 text-green-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
                  {r.pipeline_status ?? "Ready to Train"}
                </span>
              ),
            },
            { key: "tr_id", label: "TR ID", render: (r: any) => r.tr_id || "—", mobile: false },
            { key: "status", label: "Status", render: (r: any) => <Chip value={r.status} /> },
            { key: "available_from", label: "Available from", render: (r: any) => fmtDate(r.available_from), mobile: false },
            { key: "max_concurrent_batches", label: "Max batches", mobile: false },
          ]} empty="No trainers yet." />
      ) : (
        <DataTable rows={requests} onRowClick={openReqEdit}
          cardTitle={(r: any) => `${r.location?.name} · ${r.program?.name}`}
          columns={[
            { key: "location", label: "Location", render: (r: any) => r.location?.name },
            { key: "program", label: "Program", render: (r: any) => r.program?.name },
            { key: "required_by_date", label: "Required by", render: (r: any) => fmtDate(r.required_by_date) },
            { key: "status", label: "Status", render: (r: any) => <Chip value={r.status} /> },
            { key: "hiring_target_date", label: "Hiring by", render: (r: any) => fmtDate(r.hiring_target_date), mobile: false },
            { key: "tot_done_on", label: "TOT", render: (r: any) => r.tot_done_on ? `Done ${fmtDate(r.tot_done_on)}` : r.tot_scheduled_on ? `Sched ${fmtDate(r.tot_scheduled_on)}` : "—" },
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
          {/* 2026-08-11: application → shortlist → TOT → Ready to Train, plus NSDC TR ID */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Hiring pipeline">
              <select className={inputCls} value={form.pipeline_status ?? "Ready to Train"} onChange={(e) => set("pipeline_status", e.target.value)}>
                {["Applied", "Shortlisted", "TOT In Progress", "Ready to Train"].map((s) => <option key={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="TR ID (NSDC, after TOT)"><input className={inputCls} value={form.tr_id ?? ""} onChange={(e) => set("tr_id", e.target.value)} /></Field>
          </div>
          <Field label="Can train at (2026-08-11: one, two or ten locations)">
            <select multiple className={inputCls + " h-28"} value={form.capable_locations ?? []}
              onChange={(e) => set("capable_locations", Array.from(e.target.selectedOptions).map((o) => o.value))}>
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
          {/* 2026-08-11: batch-wise or monthly, fixed + performance incentive */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Compensation type">
              <select className={inputCls} value={form.compensation_type ?? ""} onChange={(e) => set("compensation_type", e.target.value)}>
                <option value="">—</option><option>Batch-wise</option><option>Monthly</option>
              </select>
            </Field>
            <Field label={`Fixed amount (₹${form.compensation_type === "Monthly" ? "/month" : form.compensation_type === "Batch-wise" ? "/batch" : ""})`}>
              <input type="number" className={inputCls} value={form.compensation_fixed ?? ""} onChange={(e) => set("compensation_fixed", +e.target.value)} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Day rate (₹)"><input type="number" className={inputCls} value={form.day_rate ?? ""} onChange={(e) => set("day_rate", +e.target.value)} /></Field>
            <Field label="Max concurrent batches"><input type="number" className={inputCls} value={form.max_concurrent_batches ?? 4} onChange={(e) => set("max_concurrent_batches", +e.target.value)} /></Field>
          </div>
          <Field label="Performance incentive note"><input className={inputCls} placeholder="e.g. ₹500/batch completion bonus" value={form.incentive_note ?? ""} onChange={(e) => set("incentive_note", e.target.value)} /></Field>
          <Btn onClick={save} disabled={!form.name || !form.phone}>{edit ? "Save changes" : "Add Trainer"}</Btn>
        </div>
      </Drawer>

      {/* Backward planning per transcript 10:03–11:17: hiring date → TOT → expected availability */}
      <Drawer open={!!reqEdit} onClose={() => setReqEdit(null)} title={reqEdit ? `Request — ${reqEdit.location?.name} · ${reqEdit.program?.name}` : ""}>
        <div className="space-y-3">
          <Field label="Status">
            <select className={inputCls} value={reqForm.status ?? "Open"} onChange={(e) => setReq("status", e.target.value)}>
              {["Open", "In Progress", "Fulfilled", "Cancelled"].map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Hiring target date"><input type="date" className={inputCls} value={reqForm.hiring_target_date ?? ""} onChange={(e) => setReq("hiring_target_date", e.target.value)} /></Field>
            <Field label="TOT scheduled on"><input type="date" className={inputCls} value={reqForm.tot_scheduled_on ?? ""} onChange={(e) => setReq("tot_scheduled_on", e.target.value)} /></Field>
            <Field label="TOT done on"><input type="date" className={inputCls} value={reqForm.tot_done_on ?? ""} onChange={(e) => setReq("tot_done_on", e.target.value)} /></Field>
            <Field label="Expected available from"><input type="date" className={inputCls} value={reqForm.expected_available_from ?? ""} onChange={(e) => setReq("expected_available_from", e.target.value)} /></Field>
          </div>
          <Field label="Fulfilled by trainer">
            <select className={inputCls} value={reqForm.fulfilled_by_trainer ?? ""} onChange={(e) => setReq("fulfilled_by_trainer", e.target.value)}>
              <option value="">—</option>
              {items.map((t) => <option key={t._id} value={t._id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Note"><input className={inputCls} value={reqForm.note ?? ""} onChange={(e) => setReq("note", e.target.value)} /></Field>
          <Btn onClick={saveReq}>Save request</Btn>
        </div>
      </Drawer>
    </div>
  );
}
