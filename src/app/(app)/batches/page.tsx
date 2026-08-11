"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, fmtDate } from "@/lib/client";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, HealthChip, inputCls } from "@/components/ui";
import { useLocationCtx } from "@/components/shell";

export default function BatchesPage() {
  return <Suspense><BatchesInner /></Suspense>;
}

function BatchesInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const [items, setItems] = useState<any[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  const [programs, setPrograms] = useState<any[]>([]);
  const [trainers, setTrainers] = useState<any[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [fStatus, setFStatus] = useState(sp.get("status") ?? "");
  const [ctxLoc] = useLocationCtx();
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [form, setForm] = useState<any>({ session: "Full Day" });
  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));
  // 2026-08-11: standalone backward-plan calculator — the shareable "इस-इस date तक ये काम" sheet
  const [planner, setPlanner] = useState<{ open: boolean; start?: string; plan?: any[] }>({ open: false });
  const [info, setInfo] = useState("");

  const load = () => Promise.all([
    api(`/api/batches?${new URLSearchParams({ ...(fStatus ? { status: fStatus } : {}), ...(ctxLoc ? { location: ctxLoc } : {}) })}`).then((d) => setItems(d.items)),
    api("/api/locations?limit=200").then((d) => setLocations(d.items)),
    api("/api/programs?limit=100").then((d) => setPrograms(d.items)),
    api("/api/trainers?limit=200").then((d) => setTrainers(d.items)),
  ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [fStatus, ctxLoc]);

  useEffect(() => {
    if (form.location) api(`/api/locations/${form.location}/rooms`).then((d) => setRooms(d.items)).catch(() => setRooms([]));
    else setRooms([]);
  }, [form.location]);

  const program = programs.find((p) => p._id === form.program);
  const matchingTrainers = trainers.filter((t) => !program || (t.skills ?? []).includes(program.trainer_skill));

  // §5 earliest_possible_start = max(trainer.available_from, today + mobilisation_lead_days)
  const [defaults, setDefaults] = useState<any>(null);
  useEffect(() => { api("/api/defaults").then((d) => setDefaults(d.item)).catch(() => {}); }, []);
  const selTrainer = trainers.find((t) => t._id === form.trainer);
  const earliestStart = (() => {
    if (!defaults) return null;
    const mob = new Date(); mob.setDate(mob.getDate() + (defaults.mobilisation_lead_days ?? 7));
    const avail = selTrainer?.available_from ? new Date(selTrainer.available_from) : null;
    const d = avail && avail > mob ? avail : mob;
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  })();

  async function save() {
    try {
      const res = await api("/api/batches", { method: "POST", json: { ...form, trainer: form.trainer || undefined, room: form.room || undefined } });
      if (res.warning) setInfo(res.warning);
      setDrawer(false); setForm({ session: "Full Day" }); load();
    } catch (e: any) { setError(e.message); }
  }

  async function runPlanner(start: string) {
    setPlanner((p) => ({ ...p, start }));
    if (!start) return;
    try {
      const d = await api(`/api/plan-batch?start=${start}`);
      setPlanner((p) => ({ ...p, plan: d.milestones }));
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Batches</h1>
        <div className="flex gap-2">
          <select className={inputCls + " max-w-36"} value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
            <option value="">All statuses</option>
            {["Planning", "Ready", "Active", "Closing", "Completed", "Cancelled"].map((s) => <option key={s}>{s}</option>)}
          </select>
          <Btn kind="ghost" onClick={() => setPlanner({ open: true })}>Plan a batch</Btn>
          <Btn onClick={() => setDrawer(true)}>New Batch</Btn>
        </div>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      {info && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          ⚠ {info} <button className="ml-2 font-bold" onClick={() => setInfo("")}>×</button>
        </div>
      )}
      <DataTable rows={items} onRowClick={(r) => router.push(`/batches/${r._id}`)}
        cardTitle={(r: any) => <>{r.code} <Chip value={r.status} /></>}
        columns={[
          { key: "code", label: "Code", mobile: false },
          { key: "location", label: "Location", render: (r: any) => r.location?.name },
          { key: "program", label: "Program", render: (r: any) => r.program?.name, mobile: false },
          { key: "status", label: "Status", render: (r: any) => <Chip value={r.status} />, mobile: false },
          { key: "health", label: "Health", render: (r: any) => <HealthChip health={r.health} /> },
          { key: "roster", label: "Enrolled / Roster / Target", render: (r: any) => `${r.enrolled_count} / ${r.roster_count} / ${r.target_size}` },
          { key: "trainer", label: "Trainer", render: (r: any) => r.trainer?.name ?? "—" },
          { key: "planned_start", label: "Start", render: (r: any) => fmtDate(r.planned_start) },
        ]} empty="No batches — plan the first one." />

      <Drawer open={drawer} onClose={() => setDrawer(false)} title="New Batch">
        <div className="space-y-3">
          <Field label="Location" required>
            <select className={inputCls} value={form.location ?? ""} onChange={(e) => set("location", e.target.value)}>
              <option value="">Select…</option>
              {locations.map((l) => <option key={l._id} value={l._id}>{l.name} ({l.approval_status})</option>)}
            </select>
          </Field>
          <Field label="Program" required>
            <select className={inputCls} value={form.program ?? ""} onChange={(e) => set("program", e.target.value)}>
              <option value="">Select…</option>
              {programs.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Planned start" required><input type="date" className={inputCls} value={form.planned_start ?? ""} onChange={(e) => set("planned_start", e.target.value)} /></Field>
            <Field label="Session">
              <select className={inputCls} value={form.session} onChange={(e) => set("session", e.target.value)}>
                {["Full Day", "Morning", "Afternoon"].map((s) => <option key={s}>{s}</option>)}
              </select>
            </Field>
          </div>
          {/* 2026-08-11: time slots — a trainer runs up to 4 parallel batches with the day divided */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Time slot start (optional)"><input type="time" className={inputCls} value={form.slot_start ?? ""} onChange={(e) => set("slot_start", e.target.value)} /></Field>
            <Field label="Time slot end"><input type="time" className={inputCls} value={form.slot_end ?? ""} onChange={(e) => set("slot_end", e.target.value)} /></Field>
          </div>
          <Field label={`Trainer${program ? ` (skill: ${program.trainer_skill})` : ""}`}>
            <select className={inputCls} value={form.trainer ?? ""} onChange={(e) => set("trainer", e.target.value)}>
              <option value="">— assign later —</option>
              {matchingTrainers.map((t) => <option key={t._id} value={t._id}>{t.name} ({t.status})</option>)}
            </select>
          </Field>
          <Field label={`Room${program?.requires_lab ? " (program requires a Lab)" : ""}`}>
            <select className={inputCls} value={form.room ?? ""} onChange={(e) => set("room", e.target.value)}>
              <option value="">— assign later —</option>
              {rooms.map((r) => <option key={r._id} value={r._id}>{r.name} ({r.type})</option>)}
            </select>
          </Field>
          <Field label={`Target size (default ${program?.default_batch_size ?? 30})`}>
            <input type="number" className={inputCls} value={form.target_size ?? ""} onChange={(e) => set("target_size", +e.target.value)} placeholder={String(program?.default_batch_size ?? 30)} />
          </Field>
          {earliestStart && (
            <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700">
              Earliest possible start: <b>{earliestStart}</b> (mobilisation lead {defaults?.mobilisation_lead_days ?? 7}d{selTrainer?.available_from ? `, trainer available ${new Date(selTrainer.available_from).toLocaleDateString("en-IN")}` : ""})
            </p>
          )}
          <p className="text-xs text-gray-500">Planned end auto-computes: start + duration + buffer (Rule 15). Trainer/room conflicts are hard-blocked on save (Rules 10, 13).</p>
          <Btn onClick={save} disabled={!form.location || !form.program || !form.planned_start}>Create Batch</Btn>
        </div>
      </Drawer>

      {/* 2026-08-11: backward-plan calculator — printable, shareable, no batch needed */}
      <Drawer open={planner.open} onClose={() => setPlanner({ open: false })} title="Backward batch plan">
        <div className="space-y-4">
          <Field label="Batch start date" required>
            <input type="date" className={inputCls} value={planner.start ?? ""} onChange={(e) => runPlanner(e.target.value)} />
          </Field>
          {planner.plan && (
            <>
              <div className="overflow-hidden rounded-lg border">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs text-gray-500">
                    <tr><th className="px-3 py-2">Due date</th><th className="px-3 py-2">Milestone</th></tr>
                  </thead>
                  <tbody>
                    {planner.plan.map((m: any) => (
                      <tr key={m.key} className="border-t">
                        <td className="px-3 py-2 font-medium">{fmtDate(m.due_date)}</td>
                        <td className="px-3 py-2">{m.label}</td>
                      </tr>
                    ))}
                    <tr className="border-t bg-blue-50">
                      <td className="px-3 py-2 font-semibold">{fmtDate(planner.start!)}</td>
                      <td className="px-3 py-2 font-semibold">Batch starts</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="flex gap-2">
                <Btn kind="ghost" onClick={() => {
                  const lines = planner.plan!.map((m: any) => `${fmtDate(m.due_date)} — ${m.label}`);
                  navigator.clipboard.writeText(`Batch plan (start ${fmtDate(planner.start!)}):\n${lines.join("\n")}\n${fmtDate(planner.start!)} — Batch starts`);
                }}>Copy as text</Btn>
                <Btn kind="ghost" onClick={() => window.print()}>Print</Btn>
              </div>
              <p className="text-xs text-gray-500">Lead times are configurable in Admin → Defaults. Creating a batch stores this checklist on the batch, tick-off-able.</p>
            </>
          )}
        </div>
      </Drawer>
    </div>
  );
}
