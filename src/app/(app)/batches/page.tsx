"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, fmtDate } from "@/lib/client";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, FilterPills, HealthChip, Tabs, inputCls } from "@/components/ui";
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
  // B12 fix (2026-08-13): /batches?location=… — emitted by the location page and Home's
  // readiness rows — used to be silently dropped (only localStorage context was read). The URL
  // wins over the context switcher; the header select shows which centre is narrowing the list.
  const [fLoc, setFLoc] = useState(sp.get("location") ?? "");
  useEffect(() => { if (!sp.get("location")) setFLoc(ctxLoc); }, [ctxLoc]); // eslint-disable-line react-hooks/exhaustive-deps
  // 2026-08-13 (Umesh): "Batches | Preparation" — the preparation tab is the full backward-
  // planning view (every location×program target with its readiness gaps).
  const [tab, setTab] = useState(sp.get("tab") === "Preparation" ? "Preparation" : "Batches");
  const [prep, setPrep] = useState<any>(null);
  const [prepFilter, setPrepFilter] = useState("");
  const [error, setError] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [form, setForm] = useState<any>({ session: "Full Day" });
  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));
  // 2026-08-11: standalone backward-plan calculator — the shareable "इस-इस date तक ये काम" sheet
  const [planner, setPlanner] = useState<{ open: boolean; start?: string; plan?: any[] }>({ open: false });
  const [info, setInfo] = useState("");

  // Status is filtered CLIENT-side now so the pill counts always show the whole picture.
  const load = () => Promise.all([
    api(`/api/batches?${new URLSearchParams({ ...(fLoc ? { location: fLoc } : {}) })}`).then((d) => setItems(d.items)),
    api("/api/locations?limit=2000").then((d) => setLocations(d.items)),
    api("/api/programs?limit=1000").then((d) => setPrograms(d.items)),
    api("/api/trainers?limit=2000").then((d) => setTrainers(d.items)),
    api(`/api/mapping/readiness${fLoc ? `?location=${fLoc}` : ""}`).then(setPrep).catch(() => setPrep(null)),
  ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [fLoc]); // eslint-disable-line react-hooks/exhaustive-deps

  const BATCH_STATUSES = ["Planning", "Ready", "Active", "Closing", "Completed", "Cancelled"];
  const statusCount = (s: string) => items.filter((b) => b.status === s).length;
  const shown = fStatus ? items.filter((b) => b.status === fStatus) : items;

  useEffect(() => {
    if (form.location) api(`/api/locations/${form.location}/rooms`).then((d) => setRooms(d.items)).catch(() => setRooms([]));
    else setRooms([]);
  }, [form.location]);

  const program = programs.find((p) => p._id === form.program);
  const matchingTrainers = trainers.filter((t) => !program || (t.skills ?? []).includes(program.trainer_skill));

  // 2026-08-12 (Manish): "dropdown se choose kar lijiye unke TR ID ke basis pe". NSDC only accepts
  // a certified trainer carrying a TR ID, and only at the centre and job role they were nominated
  // for — the nomination is what makes the TR ID usable there. So nomination is the gate, and
  // capable_locations is only a fallback for trainers who predate the hiring pipeline and were
  // never nominated through it. Keying on capable_locations alone hid every certified trainer,
  // because nothing in the journey ever writes that field.
  const idOf = (v: any) => (v?._id ?? v) as string | undefined;
  const eligible = (t: any) => {
    if (t.pipeline_status !== "Certified" || !t.tr_id) return false;
    const nomLoc = idOf(t.nominated_for_location), nomProg = idOf(t.nominated_for_program);
    if (nomLoc || nomProg) {
      return (!form.location || nomLoc === form.location) && (!form.program || nomProg === form.program);
    }
    return !form.location || (t.capable_locations ?? []).some((l: any) => idOf(l) === form.location);
  };
  const readyTrainers = matchingTrainers.filter(eligible);
  const otherTrainers = matchingTrainers.filter((t) => !eligible(t));

  // The three-way mapping, answered before the batch is created rather than after it fails.
  const [readiness, setReadiness] = useState<any>(null);
  useEffect(() => {
    if (!form.location || !form.program) { setReadiness(null); return; }
    api(`/api/mapping/readiness?location=${form.location}`)
      .then((d) => setReadiness((d.items ?? []).find((r: any) => r.program?._id === form.program || r.program === form.program) ?? null))
      .catch(() => setReadiness(null));
  }, [form.location, form.program]);

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
          <select className={inputCls + " max-w-44"} value={fLoc} onChange={(e) => setFLoc(e.target.value)}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}
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
      <Tabs tabs={["Batches", `Preparation${prep ? ` (${prep.blocked_count ?? 0} blocked)` : ""}`]}
        active={tab === "Preparation" ? `Preparation${prep ? ` (${prep.blocked_count ?? 0} blocked)` : ""}` : tab}
        onChange={(t) => setTab(t.startsWith("Preparation") ? "Preparation" : "Batches")} />

      {tab === "Batches" ? (
        <>
          <FilterPills active={fStatus} onChange={(v) => setFStatus(v === fStatus ? "" : v)}
            options={[{ value: "", label: "All", count: items.length },
              ...BATCH_STATUSES.map((s) => ({ value: s, label: s, count: statusCount(s) }))]} />
          <DataTable rows={shown} onRowClick={(r) => router.push(`/batches/${r._id}`)}
            cardTitle={(r: any) => <>{r.code} <Chip value={r.status} /></>}
            defaultSort={{ key: "planned_start", dir: "desc" }}
            columns={[
              { key: "code", label: "Code", mobile: false, sortable: true, sortValue: (r: any) => r.code },
              { key: "location", label: "Location", sortable: true, sortValue: (r: any) => r.location?.name, render: (r: any) => r.location?.name },
              { key: "program", label: "Program", sortable: true, sortValue: (r: any) => r.program?.name, render: (r: any) => r.program?.name, mobile: false },
              { key: "status", label: "Status", sortable: true, sortValue: (r: any) => r.status, render: (r: any) => <Chip value={r.status} />, mobile: false },
              // A Planning batch's gaps show inline — "backward planning chal rahi hai,
              // requirement incomplete" is visible from the LIST, not just the detail page.
              { key: "health", label: "Health", render: (r: any) => <HealthChip health={r.health} inline={r.status === "Planning"} /> },
              { key: "roster", label: "Enrolled / Roster / Target", render: (r: any) => `${r.enrolled_count} / ${r.roster_count} / ${r.target_size}` },
              { key: "trainer", label: "Trainer", sortable: true, sortValue: (r: any) => r.trainer?.name ?? null, render: (r: any) => r.trainer?.name ?? "—" },
              { key: "planned_start", label: "Start", sortable: true, sortValue: (r: any) => r.planned_start ? new Date(r.planned_start).getTime() : null, render: (r: any) => fmtDate(r.planned_start) },
            ]} empty="No batches — plan the first one." />
        </>
      ) : (
        <>
          {/* 2026-08-13 (Umesh): the full backward-planning view — every location×program
              target with what is still missing before a batch can start ("sirf location ready
              hai, ya sirf trainer ready" — ab yahan dikhta hai). Home shows 8 rows; this is all. */}
          <FilterPills active={prepFilter} onChange={(v) => setPrepFilter(v === prepFilter ? "" : v)}
            options={[
              { value: "", label: "All", count: prep?.items?.length ?? 0 },
              { value: "ready", label: "Ready to start", count: prep?.ready_count ?? 0 },
              { value: "blocked", label: "Blocked", count: prep?.blocked_count ?? 0 },
            ]} />
          <DataTable
            rows={(prep?.items ?? []).filter((r: any) => prepFilter === "ready" ? r.ready : prepFilter === "blocked" ? !r.ready : true)}
            cardTitle={(r: any) => `${r.location?.name} · ${r.program?.name}`}
            columns={[
              { key: "location", label: "Location", sortable: true, sortValue: (r: any) => r.location?.name, render: (r: any) => r.location?.name },
              { key: "program", label: "Job role", sortable: true, sortValue: (r: any) => r.program?.name, render: (r: any) => <span>{r.program?.name}{r.program?.scheme ? <span className="text-xs text-gray-400"> ({r.program.scheme})</span> : null}</span> },
              { key: "ready", label: "Ready?", sortable: true, sortValue: (r: any) => (r.ready ? 1 : 0), render: (r: any) => <Chip value={r.ready ? "Ready" : "Not Ready"} /> },
              {
                key: "blockers", label: "Missing before start", render: (r: any) => r.ready
                  ? <span className="text-xs text-green-700">nothing — plan the batch</span>
                  : <span className="flex flex-wrap gap-1">{(r.blockers ?? []).map((b: string, i: number) => (
                      <span key={i} className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800">{b}</span>
                    ))}</span>,
              },
              { key: "trainers", label: "Trainers", mobile: false, render: (r: any) => <span className="text-xs tabular-nums">{r.trainers?.certified ?? 0}/{r.trainers?.required ?? 1} certified{(r.trainers?.in_pipeline ?? 0) > 0 ? ` · ${r.trainers.in_pipeline} in pipeline` : ""}</span> },
              { key: "candidates", label: "Candidates", mobile: false, render: (r: any) => <span className="text-xs tabular-nums">{r.candidates?.registered ?? 0}/{r.candidates?.needed ?? 0} registered · pool {r.candidates?.pool ?? 0}</span> },
              { key: "approved_target", label: "Target", mobile: false, render: (r: any) => r.approved_target ?? "—" },
              {
                key: "_act", label: "", render: (r: any) => (
                  <span onClick={(e) => e.stopPropagation()}>
                    {r.ready
                      ? <Btn small onClick={() => { setForm({ session: "Full Day", location: r.location?._id, program: r.program?._id }); setDrawer(true); }}>Plan batch</Btn>
                      : <Link className="text-xs font-medium text-blue-700 hover:underline" href={`/locations/${r.location?._id}`}>Fix at centre →</Link>}
                  </span>
                ),
              },
            ]} empty="No location×programme targets yet — set targets on the locations." />
        </>
      )}

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
              {/* 2026-08-13 (Manish saw "Drone Service Technician" twice): the same job role
                  exists once per SCHEME — show the scheme so the twins are tellable apart. */}
              {programs.map((p) => <option key={p._id} value={p._id}>{p.name}{p.scheme ? ` (${p.scheme})` : p.code ? ` (${p.code})` : ""}</option>)}
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
          {/* 2026-08-13 (Manish): "ya toh 4 ghante ka rakho ya 8 ghante ka" */}
          <p className="-mt-1 text-xs text-gray-500">Scheme rule: a slot is exactly 4 or 8 hours, inside 09:00–18:00.</p>
          <Field label={`Trainer${program ? ` (skill: ${program.trainer_skill})` : ""}`}>
            <select className={inputCls} value={form.trainer ?? ""} onChange={(e) => set("trainer", e.target.value)}>
              <option value="">— assign later —</option>
              {readyTrainers.length > 0 && (
                <optgroup label="Certified — has a TR ID and is cleared for this centre">
                  {readyTrainers.map((t) => <option key={t._id} value={t._id}>{t.name} · TR {t.tr_id}</option>)}
                </optgroup>
              )}
              {otherTrainers.length > 0 && (
                <optgroup label="Not yet certified — NSDC will not accept these on a batch">
                  {otherTrainers.map((t) => <option key={t._id} value={t._id}>{t.name} ({t.pipeline_status ?? t.status})</option>)}
                </optgroup>
              )}
            </select>
            {form.trainer && otherTrainers.some((t) => t._id === form.trainer) && (
              <p className="mt-1 text-xs font-medium text-amber-700">
                ⚠ This trainer has no TR ID yet. You can plan the batch, but the portal will refuse
                them until the TOT certificate is recorded.
              </p>
            )}
            {program && readyTrainers.length === 0 && (
              <p className="mt-1 text-xs text-gray-500">
                No certified trainer for {program.trainer_skill} at this centre yet — track the hiring
                journey on the <Link href="/trainers" className="underline">Trainers</Link> screen.
              </p>
            )}
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
          {/* Location + trainer + candidate: say which of the three is missing before the batch
              is attempted, not after the portal rejects it. */}
          {readiness && !readiness.ready && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              <div className="font-semibold">Not ready to start yet</div>
              <ul className="mt-1 list-disc pl-4">
                {readiness.blockers.map((b: string) => <li key={b}>{b}</li>)}
              </ul>
            </div>
          )}
          {readiness?.ready && (
            <p className="rounded-lg bg-green-50 px-3 py-2 text-xs text-green-700">
              Centre, trainer and candidates are all in place for this job role.
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
