"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import { api, fmtDate, toInputDate, offerable } from "@/lib/client";
import { trainerSelectGroups } from "@/lib/trainer-select";
import { slotGuidelineErrors } from "@/lib/slot-rules";
import { BASE_PATH } from "@/lib/base-path";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, FilterPills, HealthChip, SourceCell, Tabs, inputCls, statusLabel, useCopied } from "@/components/ui";
import { useLocationCtx, usePerms } from "@/components/shell";

// -115 (QA-221): a RETIRED programme (active === false) leaves the pickers where something new is
// created, but never disappears from a record that already points at one — editing such a record must
// not silently blank the field. Retiring is a decision about what may be started, not about history.


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
  // R-I (CEO [38:54-39:10], trainer persona): "these are my batches assigned to me … or if
  // I am going into a batch as a guest faculty, then I should be able to see a batch which
  // is not assigned to me … and should be able to select." Default = mine; one click widens
  // to the centre's other batches (still Rule 38 — never another centre's).
  const { data: session } = useSession();
  const role = (session?.user as any)?.role;
  const [mineFilter, setMineFilter] = useState<"mine" | "all">("mine");
  const [ctxLoc] = useLocationCtx();
  // B12 fix (2026-08-13): /batches?location=… — emitted by the location page and Home's
  // readiness rows — used to be silently dropped (only localStorage context was read). The URL
  // wins over the context switcher; the header select shows which centre is narrowing the list.
  const [fLoc, setFLoc] = useState(sp.get("location") ?? "");
  useEffect(() => { if (!sp.get("location")) setFLoc(ctxLoc); }, [ctxLoc]); // eslint-disable-line react-hooks/exhaustive-deps
  // 2026-08-13 (Umesh): "Batches | Preparation" — the preparation tab is the full backward-
  // planning view (every location×program target with its readiness gaps).
  // -171 (QA-399): a third tab, not a third route. Karunn sir's Back-dated Planning table lives
  // beside the batches it describes, because it IS those batches read the other way round.
  // -196: two tabs, not three. A deep link that still says ?tab=Preparation lands on Planning -
  // that tab's job (what is blocking this centre x job role) is now answered inside Planning's
  // create strip, so the old link goes where its answer went rather than 404-ing into Batches.
  const [tab, setTab] = useState(
    sp.get("tab") === "Planning" || sp.get("tab") === "Preparation" ? "Planning" : "Batches",
  );
  const [track, setTrack] = useState<any[] | null>(null);
  // QA-642: this used to be an effect keyed on [tab] with `if (track) return`, and the only way to
  // ask for fresh rows was setTrack(null) - which changes state the effect does not depend on, so
  // React never re-ran it. The table went to its loading skeleton and stayed there until a tab
  // round-trip. Every write this screen makes went through that path, so -196 shipped an Edit mode
  // whose first save emptied the table it was editing. Refetching is now a FUNCTION anyone can
  // call; nothing signals "reload" by blanking state any more.
  const loadTrack = () => api("/api/plan-tracker")
    .then((d) => setTrack(d.rows ?? []))
    .catch((e) => setError(String(e?.message ?? e)));
  useEffect(() => {
    if (tab !== "Planning" || track) return;
    loadTrack();
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps
  const [prep, setPrep] = useState<any>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [drawer, setDrawer] = useState(false);
  // QA-028 second half: batch bulk import — upload → map → preview → confirm.
  const [imp, setImp] = useState<any>(null);
  async function batchImport(previewOnly: boolean) {
    const fd = new FormData();
    fd.append("file", imp.file);
    fd.append("mapping", JSON.stringify(imp.mapping ?? {}));
    // 15/08 (Umesh): unknown columns accepted by default; the operator unticks to ignore.
    if (imp.accept_unknown !== false) fd.append("accept_unknown", "1");
    if (!previewOnly) fd.append("confirm", "1");
    try {
      const res = await fetch(`${BASE_PATH}/api/batches/import`, { method: "POST", body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Import failed");
      if (previewOnly) setImp({ ...imp, result: d });
      else {
        // QA-110 memory (QA-146: -v2 key — old key could hold a poisoned mapping).
        try { localStorage.setItem("erp-import-map-batches-v2", JSON.stringify({ sig: [...(imp.columns ?? [])].sort().join("|"), mapping: imp.mapping ?? {} })); } catch {}
        setImp(null); setInfo(`Imported ${d.created?.length ?? 0} batch(es)${d.refused?.length ? ` — ${d.refused.length} refused` : ""}${d.skipped_count ? ` — ${d.skipped_count} rows skipped` : ""}`); load();
      }
    } catch (e: any) { setError(e.message); }
  }
  const [form, setForm] = useState<any>({ session: "Full Day" });
  const [trainerReq, setTrainerReq] = useState(""); // F-A2: "" | "busy" | "done"
  useEffect(() => { setTrainerReq(""); }, [form.location, form.program]); // a different centre/role = a different request
  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));
  // 2026-08-11: standalone backward-plan calculator — the shareable "इस-इस date तक ये काम" sheet
  // -174 (QA-501): the drawer now carries WHICH CENTRE, and what that centre can actually do -
  // the earliest it could start, whether any date works at all, and whose trainer the plan used.
  // -196: no `open` any more — the planner is not a drawer, it is the strip at the top of the
  // Planning tab. `target` is his new input: "batch mein kitne target persons lena chahte ho,
  // n number of candidates" — the one thing the old calculator could not carry into the batch.
  const [planner, setPlanner] = useState<{
    start?: string; plan?: any[]; target?: string;
    location?: string; program?: string; eps?: any; tooSoon?: boolean | null; scopedTo?: any;
  }>({});
  const { copied: planCopied, copy: copyPlan } = useCopied();
  // -198/-199: the strip's open/closed state lives here, not inside PlanningCreate, so the header's
  // single "Plan a batch" can switch tab AND open the form in one click. That is what lets the
  // strip render NOTHING when it is closed, which is how there came to be only one such button.
  const [planOpen, setPlanOpen] = useState(false);
  const [info, setInfo] = useState("");

  // Status is filtered CLIENT-side now so the pill counts always show the whole picture.
  const load = () => Promise.all([
    api(`/api/batches?${new URLSearchParams({ ...(fLoc ? { location: fLoc } : {}) })}`).then((d) => setItems(d.items)),
    // QA-095/R2: Trainer (and Enrollment, for trainers) get 403 on these directories now —
    // they only feed the create-form dropdowns those roles cannot use, so an empty list is
    // the right answer, not an error banner.
    api("/api/locations?limit=2000").then((d) => setLocations(d.items)).catch(() => setLocations([])),
    api("/api/programs?limit=1000").then((d) => setPrograms(d.items)),
    api("/api/trainers?limit=2000").then((d) => setTrainers(d.items)).catch(() => setTrainers([])),
    api(`/api/mapping/readiness${fLoc ? `?location=${fLoc}` : ""}`).then(setPrep).catch(() => setPrep(null)),
  ]).catch((e) => setError(e.message)).finally(() => setLoading(false));
  useEffect(() => { load(); }, [fLoc]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Closed" (Rule 52) included so settled batches can be isolated and counted (audit find).
  const BATCH_STATUSES = ["Planning", "Ready", "Active", "Closing", "Completed", "Closed", "Cancelled"];
  const trainerScoped = role === "Trainer" && mineFilter === "mine" ? items.filter((b) => b.is_mine) : items;
  const statusCount = (s: string) => trainerScoped.filter((b) => b.status === s).length;
  // QA-027 (-71): the client spec wanted Trainer Required / Candidate Shortage /
  // Infrastructure Pending as REPORTABLE states. They stay computed (no enum fork) but are
  // FILTERABLE now — a Planning batch joins its Preparation-board row by centre×role.
  const [fBlock, setFBlock] = useState("");
  const blockersOf = (b: any): Set<string> => {
    const row = (prep?.items ?? []).find((r: any) =>
      String(r.location?._id ?? r.location) === String(b.location?._id ?? b.location) &&
      String(r.program?._id ?? r.program) === String(b.program?._id ?? b.program));
    const cats = new Set<string>();
    for (const bl of row?.blockers ?? []) {
      cats.add(/trainer/i.test(bl) ? "trainer" : /candidate/i.test(bl) ? "candidates" : /room|lab|infra/i.test(bl) ? "infrastructure" : "other");
    }
    return cats;
  };
  const blockCount = (c: string) => trainerScoped.filter((b) => b.status === "Planning" && blockersOf(b).has(c)).length;
  const statusShown = fStatus ? trainerScoped.filter((b) => b.status === fStatus) : trainerScoped;
  // -86: "no attendance yet" = no day-wise log AND no matched portal import.
  const noAttendance = (b: any) => !(b.attendance_days > 0) && !b.portal_as_of;
  const shown = fBlock === "no-attendance"
    ? statusShown.filter((b) => noAttendance(b) && ["Ready", "Active", "Closing", "Completed"].includes(b.status))
    : fBlock ? statusShown.filter((b) => b.status === "Planning" && blockersOf(b).has(fBlock)) : statusShown;
  const noAttendanceCount = trainerScoped.filter((b) => noAttendance(b) && ["Ready", "Active", "Closing", "Completed"].includes(b.status)).length;

  useEffect(() => {
    if (form.location) api(`/api/locations/${form.location}/rooms`).then((d) => {
      setRooms(d.items);
      // -117 (M4-09, Manish 17/08 [03:44] "मान के चलो रूम वन ही होगा"): when the centre has exactly
      // one room that suits the programme, there is no decision to make — take it, and let the
      // operator change it. With SEVERAL rooms it stays unchosen on purpose: picking one for them is
      // how two batches quietly end up in the same room on the same days (Rule 13).
      const usable = (d.items ?? []).filter((r: any) => !program?.requires_lab || r.type === "Lab");
      if (usable.length === 1) set("room", usable[0]._id);
    }).catch(() => setRooms([]));
    else setRooms([]);
  }, [form.location, form.program]);

  const program = programs.find((p) => p._id === form.program);

  // QA-133 (15/08): the skill-string filter that used to sit here is GONE — nobody asked for
  // it (CEO transcript checked), it duplicated what the nomination already says precisely,
  // and its exact match silently hid a certified trainer over a two-word difference. The
  // gates that remain — TR ID (Manish: "dropdown se choose kar lijiye unke TR ID ke basis
  // pe") and the nomination centre×role tie — live in the ONE shared predicate both batch
  // forms use, and nothing is ever hidden: a trainer that fails a gate is offered with the
  // failing gate named. Which skills matter for the batch is the operator's own recorded
  // pick now (relevant_skills below), not a hidden string comparison.
  const { ready: readyTrainers, others: otherTrainers } = trainerSelectGroups(trainers, {
    locationId: form.location, programId: form.program, currentTrainerId: form.trainer,
  });
  // The multi-select's option pool: every skill the system has seen, operator decides.
  const skillOptions = Array.from(new Set([
    ...programs.map((p) => p.trainer_skill).filter(Boolean),
    ...trainers.flatMap((t) => t.skills ?? []),
  ])).sort();

  // The three-way mapping, answered before the batch is created rather than after it fails.
  const [readiness, setReadiness] = useState<any>(null);
  useEffect(() => {
    if (!form.location || !form.program) { setReadiness(null); return; }
    api(`/api/mapping/readiness?location=${form.location}`)
      .then((d) => setReadiness((d.items ?? []).find((r: any) => r.program?._id === form.program || r.program === form.program) ?? null))
      .catch(() => setReadiness(null));
  }, [form.location, form.program]);

  // QA-509 (-168): this used to compute max(trainer.available_from, today + mobilisation lead) IN
  // THE BROWSER - the fourth of four "earliest possible start" implementations, and the only one a
  // user reads. It knew nothing about rooms or the trainer's concurrency cap, so the hint on this
  // screen and the warning the server returned on save were answering one question with two
  // formulas. It now asks the server for the same figure the server will judge the save by.
  const [defaults, setDefaults] = useState<any>(null);
  useEffect(() => { api("/api/defaults").then((d) => setDefaults(d.item)).catch(() => {}); }, []);
  const selTrainer = trainers.find((t) => t._id === form.trainer);
  const [eps, setEps] = useState<any>(null);
  useEffect(() => {
    // Needs a centre: rooms are half the answer, and a figure that silently leaves them out is the
    // defect this replaces. Until one is picked there is nothing honest to show.
    if (!form.location) { setEps(null); return; }
    const q = new URLSearchParams({ start: form.planned_start || new Date().toISOString().slice(0, 10), location: String(form.location) });
    if (form.program) q.set("program", String(form.program));
    if (form.trainer) q.set("trainer", String(form.trainer));
    let live = true;
    api(`/api/plan-batch?${q.toString()}`)
      .then((d) => { if (live) setEps(d.earliest_possible_start ?? null); })
      .catch(() => { if (live) setEps(null); });
    return () => { live = false; };
  }, [form.location, form.program, form.trainer, form.planned_start]);
  const earliestStartDate = eps?.date ? new Date(eps.date) : null;
  const earliestStart = earliestStartDate
    ? earliestStartDate.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : null;
  // QA-139: advice that can be silently ignored is not advice — the same date now warns
  // (never blocks) when the chosen start is before it. The server repeats the warning.
  const dayFloor = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  // QA-506: `blocked` means a constraint cannot be met at all (no room at this centre), so every
  // date is too early - saying otherwise would be the screen agreeing with a date the server has
  // already called impossible.
  const startsTooEarly = !!(eps?.blocked || (earliestStartDate && form.planned_start && new Date(form.planned_start) < dayFloor(earliestStartDate)));
  // QA-138: the slot rule runs while the operator types — same function the API blocks with
  // (slot-rules.ts), so the two can never disagree.
  const slotErrs = slotGuidelineErrors({ slot_start: form.slot_start, slot_end: form.slot_end }, defaults ?? {});

  async function save() {
    try {
      const res = await api("/api/batches", { method: "POST", json: { ...form, trainer: form.trainer || undefined, room: form.room || undefined } });
      if (res.warning) setInfo(res.warning);
      setDrawer(false); setForm({ session: "Full Day" }); load();
    } catch (e: any) { setError(e.message); }
  }

  // -174 (QA-501): this drawer asked for a DATE and nothing else, so everything -164, -165 and
  // -168 built never reached the one screen a person opens to plan. It could not know the centre,
  // so it could not know the centre could not START then, and it printed TOT steps for a trainer
  // who was already certified - the very thing QA-460 fixed, still wrong here.
  //
  // The centre stays OPTIONAL. People use this before a centre is picked ("main jab chahun ek
  // batch planning nikaal ke kisi ko bhi share kar sakun"), and there the full plan is the honest
  // answer. Name a centre and it gets sharper, which is the point.
  // QA-528: the planner's own lists, narrowed to what the government has actually approved.
  // Derived here rather than fetched again — the page already holds `locations`, and the server
  // already decided what "approved" means (rules.ts tcVerdict, surfaced as job_roles[].tc_verdict).
  // Re-testing the string in this file would be the second copy the anti-drift map warns about.
  const plannerLocations = locations.filter((l: any) => l.approval_status === "Approved");
  const plannerHidden = locations.length - plannerLocations.length;
  const plannerRoles = (() => {
    const loc = locations.find((l: any) => String(l._id) === String(planner.location));
    return (loc?.job_roles ?? [])
      .filter((r: any) => r.tc_verdict === "approved" && r.program_id)
      .map((r: any) => ({ _id: String(r.program_id), name: r.program ?? r.code }));
  })();

  async function runPlanner(next: { start?: string; location?: string; program?: string; target?: string }) {
    const s = { ...planner, ...next };
    setPlanner(s);
    if (!s.start) return;
    try {
      const q = new URLSearchParams({ start: s.start });
      if (s.location) q.set("location", String(s.location));
      if (s.program) q.set("program", String(s.program));
      const d = await api(`/api/plan-batch?${q.toString()}`);
      setPlanner((p) => ({ ...p, plan: d.milestones, eps: d.earliest_possible_start ?? null, tooSoon: d.starts_too_soon ?? null, scopedTo: d.scoped_to ?? null }));
    } catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Batches</h1>
        {/* QA-120: wrap on narrow screens — this row was the batch list's only horizontal overflow. */}
        <div className="flex flex-wrap gap-2">
          <select className={inputCls + " max-w-44"} value={fLoc} onChange={(e) => setFLoc(e.target.value)}>
            <option value="">All locations</option>
            {locations.map((l) => <option key={l._id} value={l._id}>{l.name}</option>)}
          </select>
          <Btn kind="ghost" onClick={() => setImp({})}>Import (Excel)</Btn>
          {/* -196: "plan a batch pr sidha planning wala hi tab open ho" — no drawer in between.
              -199 (Umesh, second screenshot): "agar tujhe header wala hi rakhna hai toh header wala
              rakh. Uske baad koi dousra wala create hi mat kar ... ek remove krr". THIS is the one
              button. -198 had kept the strip's copy and hidden this one on the Planning tab, which
              is the opposite of what he asked for. It renders on both tabs, and one click both
              opens the Planning tab and opens the form — there is no second control to press. */}
          <Btn kind="ghost" onClick={() => { setTab("Planning"); setPlanOpen(true); }}>Plan a batch</Btn>
          <Btn onClick={() => setDrawer(true)}>New Batch</Btn>
        </div>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      {info && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          ⚠ {info} <button className="ml-2 font-bold" onClick={() => setInfo("")}>×</button>
        </div>
      )}
      {/* -196 (Umesh, 2026-08-22): "ek hi planning tab aaye aur usme bhi proper only 1 table only".
          The `Preparation` tab is gone. It answered "what is blocking this centre × job role", which
          is a question you ask WHILE planning a batch — so that answer moved into the Planning
          tab's create strip, where it is read at the moment it changes a decision. The endpoint
          (/api/mapping/readiness) stays: Home reads it, and so does the strip. */}
      <Tabs tabs={["Batches", "Planning"]} active={tab}
        onChange={(t) => setTab(t === "Planning" ? "Planning" : "Batches")} />

      {tab === "Planning" && (
        <>
          <PlanningCreate
            locations={locations} planner={planner} runPlanner={runPlanner}
            plannerLocations={plannerLocations} plannerHidden={plannerHidden} plannerRoles={plannerRoles}
            planCopied={planCopied} copyPlan={copyPlan} open={planOpen} setOpen={setPlanOpen}
            onError={setError} onInfo={setInfo}
            onCreated={() => { setPlanOpen(false); loadTrack(); load(); }} />
          <PlanningTable rows={track} onSaved={loadTrack} onError={setError} />
        </>
      )}

      {tab === "Batches" && (
        <>
          {/* QA-030: the main list says out loud what is holding centres back. -196: the click now
              lands on Planning — the tab that both explains a blocker and lets you act on it. */}
          {(prep?.blocked_count ?? 0) > 0 && (() => {
            // QA-030: name the REASONS on the main screen, not just the count — post-reset
            // every position is blocked and a bare number reads as noise, not a stall.
            const why = new Map<string, number>();
            for (const row of prep.items ?? []) {
              for (const b of row.blockers ?? []) {
                const k = /trainer/i.test(b) ? "trainer" : /candidate/i.test(b) ? "candidates" : /room|lab|infra/i.test(b) ? "infrastructure" : "other";
                why.set(k, (why.get(k) ?? 0) + 1);
              }
            }
            const parts = [...why.entries()].map(([k, n]) => `${k} ${n}`).join(" · ");
            return (
              <button onClick={() => setTab("Planning")}
                className="w-full rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-left text-sm text-amber-800 hover:border-amber-300">
                ⚑ <b>{prep.blocked_count}</b> of {(prep.items ?? []).length} centre × job-role position{prep.blocked_count === 1 ? " is" : "s are"} blocked{parts ? ` — ${parts}` : ""} — open Planning and pick the centre to see what it needs.
              </button>
            );
          })()}
          {role === "Trainer" && (
            <FilterPills active={mineFilter} onChange={(v) => setMineFilter((v || "mine") as any)}
              options={[
                { value: "mine", label: "My batches", count: items.filter((b) => b.is_mine).length },
                { value: "all", label: "Guest faculty — other batches at my centre", count: items.length },
              ]} />
          )}
          <FilterPills active={fStatus} onChange={(v) => setFStatus(v === fStatus ? "" : v)}
            options={[{ value: "", label: "All", count: trainerScoped.length },
              // -102: filter VALUE stays the stored enum; only the pill's wording is the
              // client's ("Closing" → "Result Awaited"), so deep links keep working.
              ...BATCH_STATUSES.map((s) => ({ value: s, label: statusLabel(s), count: statusCount(s) }))]} />
          {/* QA-027 (-71): the spec's blocker states, filterable — computed, never an enum. */}
          {(blockCount("trainer") + blockCount("candidates") + blockCount("infrastructure") + blockCount("other") + noAttendanceCount) > 0 && (
            <FilterPills active={fBlock} onChange={(v) => setFBlock(v === fBlock ? "" : v)}
              options={[
                { value: "trainer", label: "Trainer required", count: blockCount("trainer") },
                { value: "candidates", label: "Candidate shortage", count: blockCount("candidates") },
                { value: "infrastructure", label: "Infrastructure pending", count: blockCount("infrastructure") },
                // -86 (Umesh): which running/finished batches still have NO attendance on record
                { value: "no-attendance", label: "No attendance yet", count: noAttendanceCount },
              ].filter((o) => o.count > 0)} />
          )}
          <DataTable rows={shown} storageKey="batches" onRowClick={(r) => router.push(`/batches/${r._id}`)}
            cardTitle={(r: any) => <>{r.code} <Chip value={r.status} /></>}
            loading={loading}
            defaultSort={{ key: "planned_start", dir: "desc" }}
            columns={[
              { key: "code", label: "Code", mobile: false, sortable: true, sortValue: (r: any) => r.code },
              { key: "location", label: "Location", sortable: true, sortValue: (r: any) => r.location?.name, render: (r: any) => r.location?.name },
              { key: "program", label: "Program", sortable: true, filterable: true, sortValue: (r: any) => r.program?.name, mobile: false,
                // R-K: the programme cell is a door to its detail page.
                render: (r: any) => r.program
                  ? <Link className="text-blue-700 hover:underline" href={`/programs/${r.program._id}`} onClick={(e) => e.stopPropagation()}>{r.program.name}</Link>
                  : "—" },
              {
                // QA-048: after Completed the money chain shows WHERE the batch stands
                // (derived from Closure+Invoice — the same facts Rule 52 gates closing on).
                // -102 (Manish 17/08 [15:23]: "health-wealth se accha hai ki aap status dikha de,
                // batch status to hai hi idhar, iske bagal me daal dijiye") — the status is the
                // column he reads the list by, so it is no longer hidden on a phone.
                key: "status", label: "Status", sortable: true, sortValue: (r: any) => r.status,
                // -104: searchable by BOTH words — the client types "Result Awaited", an engineer
                // reading an audit row types "Closing", and either must find the row.
                filterText: (r: any) => [statusLabel(r.status), r.status === statusLabel(r.status) ? "" : r.status, r.settlement_stage].filter(Boolean).join(" — "),
                render: (r: any) => (
                  <span className="flex flex-col gap-0.5">
                    <Chip value={r.status} />
                    {r.settlement_stage && <span className="text-[10px] font-medium leading-3 text-gray-500">{r.settlement_stage}</span>}
                  </span>
                ),
              },
              // A Planning batch's gaps show inline — "backward planning chal rahi hai,
              // requirement incomplete" is visible from the LIST, not just the detail page.
              // -102 (Manish 17/08 [04:10]: "ye health-wealth hum kyu dikha rahe hai"): on a
              // RUNNING or finished batch the chip was pure noise — 4 of 5 live batches read Red
              // only because the daily logs Manish was about to enter were not in yet, and the
              // batch's real state is the Status column beside it. The chip earns its place while
              // a batch is still being prepared, where its gap list IS the backward-planning
              // signal; after that the row says nothing rather than crying red.
              { key: "health", label: "Readiness", filterText: (r: any) => ["Planning", "Ready"].includes(r.status) ? String(r.health?.score ?? "") : "",
                render: (r: any) => ["Planning", "Ready"].includes(r.status)
                  ? <HealthChip health={r.health} inline={r.status === "Planning"} />
                  : <span className="text-xs text-gray-300" title="Readiness is a preparation check — a running or finished batch is described by its Status.">—</span> },
              { key: "roster", label: "Enrolled / Roster / Target", render: (r: any) => `${r.enrolled_count} / ${r.roster_count} / ${r.target_size}` },
              // -86 (Umesh 15/08): "kis batch ki kitne din ki attendance available hai" — our
              // day-wise logs and the portal import, per row; "none yet" says so in grey.
              // -99 (QA-159, second half): a batch whose attendance came from the portal read
              // "0 days" in bold with "(36)" beside it — 36 was STUDENTS, not days, so the row
              // still could not answer "kitne din". The portal's own working-day meter is now
              // the headline for such a row, students move into the label, and sorting counts
              // whichever source actually has days.
              { key: "attendance", label: "Attendance", sortable: true, sortValue: (r: any) => Math.max(r.attendance_days ?? 0, r.portal_days ?? 0) * 1e6 + (r.portal_as_of ? new Date(r.portal_as_of).getTime() / 1e9 : 0),
                filterText: (r: any) => (r.attendance_days > 0 || r.portal_as_of) ? `${r.attendance_days} days ours${r.portal_as_of ? ` ${r.portal_days ?? 0} days portal ${r.portal_rows ?? 0} students` : ""}` : "none yet",
                render: (r: any) => (r.attendance_days > 0 || r.portal_as_of) ? (
                  <span className="text-xs leading-4">
                    {r.attendance_days > 0
                      ? <span className="font-medium">{r.attendance_days} day{r.attendance_days === 1 ? "" : "s"} <span className="font-normal text-gray-500">ours</span></span>
                      : <span className={r.portal_days > 0 ? "text-gray-500" : "text-gray-400"} title="Day-wise logs marked in this system">0 days ours</span>}
                    {r.attendance_last && <span className="text-gray-500"> · last {fmtDate(r.attendance_last)}</span>}
                    {r.portal_as_of && <div className="text-blue-700" title={`Government portal working days, imported ${fmtDate(r.portal_as_of)}`}>
                      {r.portal_days > 0
                        ? <><span className="font-medium">portal {r.portal_days} day{r.portal_days === 1 ? "" : "s"}</span>{r.portal_rows ? ` · ${r.portal_rows} student${r.portal_rows === 1 ? "" : "s"}` : ""}</>
                        : <>portal {fmtDate(r.portal_as_of)}{r.portal_rows ? ` (${r.portal_rows} student${r.portal_rows === 1 ? "" : "s"})` : ""}</>}
                    </div>}
                  </span>
                ) : <span className="text-xs text-gray-400">— none yet</span> },
              { key: "trainer", label: "Trainer", sortable: true, sortValue: (r: any) => r.trainer?.name ?? null, render: (r: any) => r.trainer?.name ?? "—" },
              { key: "planned_start", label: "Start", sortable: true, sortValue: (r: any) => r.planned_start ? new Date(r.planned_start).getTime() : null, render: (r: any) => fmtDate(r.planned_start) },
              // 2026-08-13 (Manish): source link per row — click lands on that sheet tab.
              // QA-022: "Entered in ERP" told nobody anything — an app-created row's
              // provenance IS its creator, so the Source cell says so by name.
              { key: "source", label: "Source", mobile: false, filterable: true,
                filterText: (r: any) => r.source ?? `Entered by ${r.created_by?.name ?? "?"}`,
                render: (r: any) => r.source
                  ? <SourceCell source={r.source} />
                  : <span className="text-xs text-gray-500">Entered by {r.created_by?.name ?? <span className="text-gray-400">(seed/import)</span>}</span> },
              // 2026-08-14 (Umesh): "entered into ERP dikhana is really not right — KISNE
              // daala, 4 me se kaun". The creator by name; seeded rows honestly say so.
              // Checker caught the first ship hiding this behind the picker — visible by default.
              { key: "created_by", label: "Entered by", mobile: false, filterable: true,
                sortValue: (r: any) => r.created_by?.name ?? "", filterText: (r: any) => r.created_by?.name ?? "(seed/import)",
                render: (r: any) => r.created_by?.name ?? <span className="text-gray-400">(seed/import)</span> },
            ]} empty="No batches — plan the first one." />
        </>
      )}

      <Drawer error={error} open={drawer} onClose={() => setDrawer(false)} title="New Batch">
        <div className="space-y-3">
          <Field label="Location" required>
            <select className={inputCls} value={form.location ?? ""} onChange={(e) => set("location", e.target.value)}>
              <option value="">Select…</option>
              {offerable(locations, form.location).map((l) => <option key={l._id} value={l._id} title={`${l.name} (${l.approval_status})`}>{l.name} ({l.approval_status})</option>)}
            </select>
          </Field>
          <Field label="Program" required>
            <select className={inputCls} value={form.program ?? ""} onChange={(e) => set("program", e.target.value)}>
              <option value="">Select…</option>
              {/* 2026-08-13 (Manish saw "Drone Service Technician" twice): the same job role
                  exists once per SCHEME — show the scheme so the twins are tellable apart. */}
              {offerable(programs, form.program).map((p) => { const t = `${p.name}${p.scheme ? ` (${p.scheme})` : p.code ? ` (${p.code})` : ""}`; return <option key={p._id} value={p._id} title={t}>{t}</option>; })}
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
            {/* -116 (M4-10, Manish 17/08 [03:54] "टाइम स्लॉट भी डिफाइंड है, टाइम स्लॉट हम चेंज कर सकते
                हैं"): presets that FILL these inputs and leave them editable, exactly as he said. Only
                the three slots Umesh's sheet marks reliable are offered — the transcripts disagree on a
                fourth (9:30-4:30 vs 9:30-9:30 vs a duplicate), and a wrong preset would be typed into
                every batch. The fourth is one line to add once he confirms it. */}
            <div className="md:col-span-2">
              <span className="mr-2 text-xs text-gray-500">Usual slots:</span>
              {[["09:00", "18:00"], ["09:00", "17:00"], ["09:30", "17:30"]].map(([a, b2]) => (
                <button key={a + b2} type="button" onClick={() => { set("slot_start", a); set("slot_end", b2); }}
                  className="mr-1.5 rounded-full border border-gray-200 px-2 py-0.5 text-xs hover:bg-gray-50">
                  {a}–{b2}
                </button>
              ))}
              <span className="text-[11px] text-gray-400">or type your own below</span>
            </div>
            <Field label="Time slot start (optional)"><input type="time" className={inputCls} value={form.slot_start ?? ""} onChange={(e) => set("slot_start", e.target.value)} /></Field>
            <Field label="Time slot end"><input type="time" className={inputCls} value={form.slot_end ?? ""} onChange={(e) => set("slot_end", e.target.value)} /></Field>
          </div>
          {/* 2026-08-13 (Manish): "ya toh 4 ghante ka rakho ya 8 ghante ka" */}
          <p className="-mt-1 text-xs text-gray-500">Scheme rule: a slot is exactly 4 or 8 hours, inside 09:00–18:00.</p>
          {/* QA-138: the same errors the API would refuse with, shown while typing. */}
          {slotErrs.length > 0 && (
            <div className="-mt-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {slotErrs.map((e) => <div key={e}>⚠ {e}</div>)}
            </div>
          )}
          <Field label="Trainer">
            <select className={inputCls} value={form.trainer ?? ""} onChange={(e) => set("trainer", e.target.value)}>
              <option value="">— assign later —</option>
              {readyTrainers.length > 0 && (
                <optgroup label="Certified — has a TR ID and is cleared for this centre">
                  {readyTrainers.map((t) => <option key={t._id} value={t._id} title={`${t.name} · TR ${t.tr_id}`}>{t.name} · TR {t.tr_id}</option>)}
                </optgroup>
              )}
              {otherTrainers.length > 0 && (
                // QA-133: the reason sits next to each name — nobody is silently dropped.
                <optgroup label="Not portal-ready — the reason is next to each name">
                  {otherTrainers.map(({ t, reason }) => <option key={t._id} value={t._id} title={`${t.name} — ${reason}`}>{t.name} — {reason}</option>)}
                </optgroup>
              )}
            </select>
            {form.trainer && otherTrainers.some(({ t }) => t._id === form.trainer) && (
              <p className="mt-1 text-xs font-medium text-amber-700">
                ⚠ {otherTrainers.find(({ t }) => t._id === form.trainer)?.reason} — you can plan the
                batch, but NSDC&apos;s portal will refuse this trainer until they are Certified with a TR ID.
              </p>
            )}
            {/* QA-133: the old message said "no certified trainer at this centre" while one stood
                right there, filtered out — it must never claim an absence it did not check. */}
            {program && readyTrainers.length === 0 && otherTrainers.length > 0 && (
              <p className="mt-1 text-xs text-gray-500">
                {otherTrainers.length} trainer{otherTrainers.length === 1 ? " is" : "s are"} listed above but
                not portal-ready yet — the reason sits next to each name. Fix their journey on the{" "}
                <Link href="/trainers" className="underline">Trainers</Link> screen.
              </p>
            )}
            {program && readyTrainers.length === 0 && otherTrainers.length === 0 && (
              <div className="mt-1 space-y-1.5">
                <p className="text-xs text-gray-500">
                  No trainer for this centre yet — track the hiring
                  journey on the <Link href="/trainers" className="underline">Trainers</Link> screen.
                </p>
                {/* F-A2 (Manish): the drawer used to dead-end here — raise the trainer request
                    without leaving it. Ops/Admin get the in-app alert the moment it lands. */}
                {trainerReq === "done" ? (
                  <p className="text-xs font-medium text-green-700">✓ Trainer request raised — Operations has been alerted.</p>
                ) : form.location ? (
                  <Btn small kind="ghost" disabled={trainerReq === "busy"} onClick={async () => {
                    setTrainerReq("busy");
                    try {
                      await api("/api/trainer-requests", { method: "POST", json: {
                        location: form.location, program: form.program,
                        required_by_date: form.planned_start || toInputDate(new Date()),
                        note: "Raised from the New Batch drawer",
                      } });
                      setTrainerReq("done");
                    } catch (e: any) { setTrainerReq(""); setError(e.message); }
                  }}>{trainerReq === "busy" ? "Requesting…" : "⚑ Request a trainer for this centre"}</Btn>
                ) : null}
              </div>
            )}
          </Field>
          {/* QA-133 (Umesh, 15/08): which skills matter for this batch is the operator's own
              multi-select — a recorded fact on the batch, never a filter on the dropdown. */}
          <Field label="Skills relevant to this batch (optional — your pick, never a filter)">
            <select multiple className={inputCls + " h-24"} value={form.relevant_skills ?? []}
              onChange={(e) => set("relevant_skills", Array.from(e.target.selectedOptions).map((o) => o.value))}>
              {skillOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
          {/* -118 (M4-09, and the measurement that corrected me). -117 pre-assigned the room when a
              centre had exactly ONE — then I measured production: of 21 centres, ZERO have exactly one
              room and EIGHTEEN have none at all. So Manish's "यहां पे कुछ आता नहीं है" was mostly not
              about nothing being pre-selected; for most centres the dropdown is EMPTY, which is the
              same thing QA-147 found on the batch page ("room assign karne ka kahin koi option hi nahi
              aa raha" — CHI-ITI simply had no rooms). An empty dropdown that says "— assign later —"
              looks like a choice being offered. It is not. Say so, and give the way out — the batch
              page has had exactly this since QA-147; the form it starts from had not caught up. */}
          <Field label={`Room${program?.requires_lab ? " (program requires a Lab)" : ""}`}>
            <select className={inputCls} value={form.room ?? ""} onChange={(e) => set("room", e.target.value)}
              disabled={!!form.location && rooms.length === 0}>
              <option value="">{form.location && rooms.length === 0 ? "— this centre has no rooms —" : "— assign later —"}</option>
              {rooms.map((r) => <option key={r._id} value={r._id}>{r.name} ({r.type})</option>)}
            </select>
            {form.location && rooms.length === 0 && (
              <span className="mt-0.5 block text-[11px] text-amber-700">
                No rooms recorded at this centre, so a batch created now cannot pass its readiness check.
                Add one on the centre&apos;s <Link className="underline" href={`/locations/${form.location}?tab=${encodeURIComponent("Trainers & Infra")}`}>Trainers &amp; Infra</Link> tab — it takes a name and a type.
              </span>
            )}
            {form.location && rooms.length > 1 && (
              <span className="mt-0.5 block text-[11px] text-gray-500">
                {rooms.length} rooms here — pick one. Two batches in the same room on the same days is refused on save.
              </span>
            )}
          </Field>
          <Field label={`Target size (default ${program?.default_batch_size ?? 45})`}>
            <input type="number" className={inputCls} value={form.target_size ?? ""} onChange={(e) => set("target_size", +e.target.value)} placeholder={String(program?.default_batch_size ?? 45)} />
            {program && program.default_batch_size !== 45 && (
              <span className="mt-0.5 block text-[11px] text-gray-500">
                {program.name} is set to {program.default_batch_size} — change it in Admin → Programs if 45 is right for it too.
              </span>
            )}
          </Field>
          {earliestStart && !startsTooEarly && (
            <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-700">
              Earliest possible start: <b>{earliestStart}</b> ({eps?.note})
            </p>
          )}
          {/* QA-139: same fact, amber, when the chosen date ignores it. Creating still works. */}
          {startsTooEarly && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
              {eps?.blocked
                ? <>⚠ This centre cannot start a batch yet ({eps?.note}). You can still create it — but nothing will make that date work until the blocker is cleared.</>
                : <>⚠ Planned start is before the earliest possible start <b>{earliestStart}</b> ({eps?.note}).
                  You can still create the batch — but mobilisation says it will not be ready by then.</>}
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
          <p className="text-xs text-gray-500">Planned end = start + duration + buffer. A trainer or room already booked for these dates blocks the save.</p>
          {/* 2026-08-13 (Umesh): "2 buttons — create batch AND create plan" — the backward plan
              ("itti date tak ye sab ho jana chahiye") straight from the same form, shareable.
              -196: the second button now carries what this form already knows into the Planning
              strip, which is the one place that both plans and creates. */}
          <div className="flex gap-2">
            <Btn onClick={save} disabled={!form.location || !form.program || !form.planned_start}>Create Batch</Btn>
            <Btn kind="ghost" disabled={!form.planned_start}
              onClick={() => { setDrawer(false); setTab("Planning"); runPlanner({ start: form.planned_start, location: form.location, program: form.program }); }}>
              Create backward plan
            </Btn>
          </div>
        </div>
      </Drawer>

      {/* -196 (Umesh, 2026-08-22): the "Backward batch plan" drawer that stood here is GONE.
          "tho 2 hai kyu ... shutter wala hta hi do" - it was a calculator that could not create
          the batch it planned, so a person planned twice: once in the drawer, once in New Batch.
          Its inputs, its earliest-start warning and its milestone preview now live inline above
          the Planning table (PlanningCreate), where Save makes the batch AND attaches the plan. */}

      {/* QA-028: batch bulk import — same contract as the candidate/trainer importers. */}
      <Drawer error={error} open={!!imp} onClose={() => setImp(null)} title="Import batches (Excel)" wide>
        {imp && (
          <div className="space-y-3">
            <a href={`${BASE_PATH}/templates/batches-sample.csv`} download className="inline-block text-sm font-medium text-blue-700 hover:underline">⬇ Download sample sheet format</a>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={async (e) => {
              const file = e.target.files?.[0]; e.target.value = "";
              if (!file) return;
              const fd = new FormData(); fd.append("file", file);
              try {
                const res = await fetch(`${BASE_PATH}/api/batches/import`, { method: "POST", body: fd });
                const d = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(d.error ?? "Could not read the file");
                // QA-110: a remembered mapping for this exact column-set beats the name heuristic.
                // QA-146: -v2 key; old key dropped.
                let remembered: any = null;
                try {
                  localStorage.removeItem("erp-import-map-batches");
                  const saved = JSON.parse(localStorage.getItem("erp-import-map-batches-v2") ?? "null");
                  if (saved?.sig === [...(d.columns ?? [])].sort().join("|")) remembered = saved.mapping;
                } catch {}
                setImp({ file, columns: d.columns, remembered: !!remembered, mapping: remembered ?? Object.fromEntries(d.columns.map((c: string) => {
                  const k = c.toLowerCase();
                  if (/centre|center|institution|location/.test(k)) return [c, "location"];
                  if (/job role|program|course/.test(k)) return [c, "program"];
                  if (/start/.test(k)) return [c, "planned_start"];
                  if (/target|size|capacity/.test(k)) return [c, "target_size"];
                  if (/session/.test(k)) return [c, "session"];
                  return [c, ""];
                })) });
              } catch (err: any) { setError(err.message); }
            }} />
            {imp.columns && (
              <>
                {/* QA-146: blank header cells shift labels — warn. */}
                {imp.columns.some((c: string) => /^__EMPTY/.test(c)) && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    <b>This sheet&apos;s header row has blank cells.</b> Columns marked &quot;unnamed&quot; had no header — check the preview values, not the labels.
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  {imp.columns.map((c: string) => (
                    <Field key={c} label={/^__EMPTY/.test(c) ? "(unnamed column — header was blank)" : c}>
                      <select className={inputCls} value={imp.mapping?.[c] ?? ""} onChange={(e) => setImp({ ...imp, mapping: { ...imp.mapping, [c]: e.target.value } })}>
                        <option value="">(ignore)</option>
                        {["location", "program", "planned_start", "target_size", "session"].map((f) => <option key={f} value={f}>{f}</option>)}
                      </select>
                    </Field>
                  ))}
                </div>
                <Btn kind="ghost" onClick={() => batchImport(true)}>Preview</Btn>
              </>
            )}
            {imp.remembered && <p className="text-xs text-blue-700">Mapping pre-filled from your last import of this sheet shape — check it still fits.</p>}
            {imp.result && (
              <div className="space-y-2 text-sm">
                <p><b>{imp.result.valid}</b> importable · {imp.result.skipped_count} rows skipped</p>
                {/* QA-110: an operator who forgets to map a column must be able to notice. */}
                {(imp.result.ignored_columns?.length ?? 0) > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                    {imp.result.ignored_columns.length} column{imp.result.ignored_columns.length > 1 ? "s" : ""} will be IGNORED — their values are not imported: {imp.result.ignored_columns.join(" · ")}
                  </div>
                )}
                {/* 15/08 (Umesh): unknown columns accepted by default, stored per batch. */}
                {(imp.result.unknown_columns?.length ?? 0) > 0 && (
                  <div className="rounded-lg border border-blue-200 bg-blue-50 p-2 text-xs text-blue-800">
                    <div className="font-medium">New columns the ERP doesn&apos;t know: {imp.result.unknown_columns.join(" · ")}</div>
                    <label className="mt-1 flex items-center gap-2">
                      <input type="checkbox" checked={imp.accept_unknown !== false}
                        onChange={(e) => setImp({ ...imp, accept_unknown: e.target.checked })} />
                      Accept as new columns — their values are stored and shown on each batch
                    </label>
                    <div className="mt-0.5 text-blue-700">Or map them to an existing field above; unticked = ignored.</div>
                  </div>
                )}
                {(imp.result.location_unmatched?.length ?? 0) > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                    Unknown centres (left out, fix the sheet or the Location Master): {imp.result.location_unmatched.join(" · ")}
                  </div>
                )}
                {(imp.result.program_unmatched?.length ?? 0) > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                    Unknown job roles: {imp.result.program_unmatched.join(" · ")}
                  </div>
                )}
                {(imp.result.skipped?.length ?? 0) > 0 && (
                  <ul className="max-h-32 space-y-0.5 overflow-y-auto text-xs text-gray-500">
                    {imp.result.skipped.map((s: string, i: number) => <li key={i}>• {s}</li>)}
                  </ul>
                )}
                <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 text-left text-gray-500"><tr><th className="p-2">Centre</th><th className="p-2">Job role</th><th className="p-2">Start</th><th className="p-2">Size</th><th className="p-2">Session</th></tr></thead>
                    <tbody>
                      {imp.result.preview?.map((r: any, i: number) => (
                        <tr key={i} className="border-t border-gray-100">
                          <td className="p-2">{r.location}</td><td className="p-2">{r.program}</td>
                          <td className="p-2">{fmtDate(r.planned_start)}</td><td className="p-2">{r.target_size}</td><td className="p-2">{r.session}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Btn onClick={() => batchImport(false)} disabled={!imp.result.valid}>Import {imp.result.valid} batch(es)</Btn>
              </div>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}

// -196 (Umesh, 2026-08-22) — the create strip that replaced the "Backward batch plan" drawer.
//
// The drawer could compute a plan and could not create the batch it planned, so the plan and the
// batch were two separate acts and the plan was thrown away between them. This asks the same four
// questions (centre · job role · start date · how many candidates), shows the same backward plan,
// and its Save does BOTH: POST /api/batches makes the batch in `Planning` status, then
// PATCH …/milestones {create:true} attaches the plan to it. The new row appears in the table below
// immediately, because that table shows exactly the batches that have not started yet.
//
// The preview is a list, NOT a table. His words were "usme bhi proper only 1 table only", and a
// second bordered grid above the grid is the thing he was pointing at.
function PlanningCreate({ locations, planner, runPlanner, plannerLocations, plannerHidden, plannerRoles, planCopied, copyPlan, open, setOpen, onError, onInfo, onCreated }: {
  locations: any[]; planner: any; runPlanner: (n: any) => void;
  plannerLocations: any[]; plannerHidden: number; plannerRoles: any[];
  planCopied: boolean; copyPlan: (t: string) => void;
  open: boolean; setOpen: (v: boolean) => void;
  onError: (m: string) => void; onInfo: (m: string) => void; onCreated: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const canSave = !!(planner.location && planner.program && planner.start) && !saving;

  // What the removed Preparation tab used to answer, asked at the moment it matters: this centre,
  // this job role, what is still missing.
  //
  // QA-647: -196 read this off the PAGE's `prep`, which is fetched with ?location=<the header
  // filter>. The strip's own centre dropdown is not filtered, so the moment the two named different
  // centres the sentence simply vanished - no blockers, no "nothing is blocking", nothing - and a
  // silent line reads as "there is nothing to say" rather than "I did not look". The strip asks for
  // its OWN centre now, so the answer belongs to the row being planned and to nothing else.
  const [prepRow, setPrepRow] = useState<any>(null);
  const [prepLoading, setPrepLoading] = useState(false);
  useEffect(() => {
    if (!planner.location || !planner.program) { setPrepRow(null); setPrepLoading(false); return; }
    let live = true;
    setPrepLoading(true);
    api(`/api/mapping/readiness?location=${planner.location}`)
      .then((d) => { if (!live) return;
        setPrepRow((d.items ?? []).find((r: any) => String(r.program?._id ?? r.program) === String(planner.program)) ?? null);
        setPrepLoading(false); })
      .catch(() => { if (live) { setPrepRow(null); setPrepLoading(false); } });
    return () => { live = false; };
  }, [planner.location, planner.program]);

  const planText = () => {
    const lines = (planner.plan ?? []).map((m: any) => `${fmtDate(m.due_date)} — ${m.label}`);
    return `Batch plan (start ${fmtDate(planner.start)}):\n${lines.join("\n")}\n${fmtDate(planner.start)} — Batch starts`;
  };

  async function save() {
    setSaving(true);
    try {
      // QA-654 (-198): the batch is created WITH the trainer the preview counted the plan for.
      // Found by running this on live: /api/plan-batch scopes the preview to whoever teaches at the
      // centre now, so it correctly dropped the TOT steps for an already-certified trainer and
      // showed six milestones - and then Save sent no trainer at all, so the plan attached to the
      // batch was rebuilt with trainer null and came back with eight, TOT included. The plan a
      // person approves has to be the plan that gets stored. This path is already guarded: the POST
      // runs assertTrainerAvailableForBatch and trainerBookingWarnings, so a trainer who is not
      // free is refused or warned rather than quietly attached.
      const res = await api("/api/batches", {
        method: "POST",
        json: {
          location: planner.location, program: planner.program, planned_start: planner.start,
          session: "Full Day",
          ...(planner.scopedTo?.trainer?._id ? { trainer: planner.scopedTo.trainer._id } : {}),
          ...(planner.target ? { target_size: Number(planner.target) } : {}),
        },
      });
      const id = res?.item?._id ?? res?._id;
      // QA-152: {create:true} is the ONE way a batch gets its plan. The batch is born in Planning,
      // which is the status that route requires, so this is the moment it can be attached at all.
      if (id) await api(`/api/batches/${id}/milestones`, { method: "PATCH", json: { create: true } });
      onInfo(`${res?.item?.code ?? "Batch"} planned${res?.warning ? ` — ${res.warning}` : ""}`);
      runPlanner({ start: undefined, location: undefined, program: undefined, target: undefined });
      onCreated();   // the page closes the strip - see setPlanOpen(false) at the call site
    } catch (e: any) { onError(String(e?.message ?? e)); }
    finally { setSaving(false); }
  }

  // -199: closed means GONE, not a prompt. This used to render a slate strip repeating the words
  // "Plan a batch" with a button of the same name a few rows under the header's — "do button eek
  // jighe kya kama karenge ... ek remove krr". The header button is the way in; when the form is
  // closed there is nothing here at all, so the Planning tab is the table and only the table.
  if (!open) return null;

  return (
    <div className="space-y-3 rounded-xl border border-blue-200 bg-blue-50/40 px-4 py-3">
      <div className="flex items-center justify-between">
        {/* QA-663 (-200): -199 deleted the collapsed prompt, and the one sentence that said what
            this DOES went with it - the replacement pointer lives in the table's `empty=` prop,
            which only renders at zero rows, so anybody with batches on screen never saw either.
            It belongs here, where the form is, and it is now the only place it needs to be. */}
        <div>
          <h2 className="text-sm font-semibold text-gray-800">Plan a batch</h2>
          <p className="text-xs text-gray-500">
            Pick the centre and job role and choose the start date — the backward plan is counted for
            you, and saving creates the batch with that plan on it as a tick-off checklist.
          </p>
        </div>
        <button className="text-xs font-medium text-gray-500 hover:text-gray-800" onClick={() => setOpen(false)}>Close</button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Centre" required>
          <select className={inputCls} value={planner.location ?? ""} onChange={(e) => runPlanner({ location: e.target.value, program: "" })}>
            <option value="">Select…</option>
            {plannerLocations.map((l: any) => <option key={l._id} value={l._id}>{l.name}</option>)}
          </select>
        </Field>
        <Field label="Job role" required>
          <select className={inputCls} value={planner.program ?? ""} disabled={!planner.location} onChange={(e) => runPlanner({ program: e.target.value })}>
            <option value="">{planner.location ? "Select…" : "Pick a centre first"}</option>
            {plannerRoles.map((p: any) => <option key={p._id} value={p._id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Batch start date" required>
          <input type="date" className={inputCls} value={planner.start ?? ""} onChange={(e) => runPlanner({ start: e.target.value })} />
        </Field>
        {/* Umesh, 2026-08-22: "batch mein kitne target persons lena chahte ho, n number of
            candidates". Left blank it falls back to the job role's default batch size, which is
            what the server does today — so the field adds a choice, never a new requirement. */}
        <Field label="Target candidates">
          <input type="number" min={1} className={inputCls} placeholder="job role default"
            value={planner.target ?? ""} onChange={(e) => runPlanner({ target: e.target.value })} />
        </Field>
      </div>

      {/* QA-664 (-200): a Trainer sees the one Plan-a-batch button, presses it, and lands on a
          Centre select whose only option is "Select…" - a dead end with nothing said. The answer is
          NOT to hide the button from them (that would put a role gate back on the single control),
          it is for the form to say why it is empty. Their scope is the batches they teach, not a
          centre they can plan against, and that sentence is the whole explanation. */}
      {plannerLocations.length === 0 && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          There is no centre here you can plan a batch for. Planning is offered for centres the
          government has approved and that your login covers — if you teach at a centre rather than
          running one, your batches are on the <b>Batches</b> tab.
        </p>
      )}

      {/* QA-528: Karunn sir's word was ONLY - "ek batch ki plan, and that is to be ONLY FOR
          APPROVE LOCATION AND APPROVE COURSES" (20/08, 08:21). What is left out is COUNTED here
          rather than quietly dropped: a list that silently shrinks is how somebody concludes a
          centre was deleted. */}
      {plannerHidden > 0 && (
        <p className="text-xs text-gray-500">
          {plannerHidden} of {locations.length} centres are not offered here because the government has not approved them yet.
          A batch can still be created for them from <b>New Batch</b> — planning an unapproved centre is planning something that cannot run.
        </p>
      )}
      {planner.location && plannerRoles.length === 0 && (
        <p className="text-xs text-amber-800">This centre has no job role approved on the client sheet yet, so there is nothing to plan against here.</p>
      )}

      {/* The old Preparation tab, in one line, about the row you are actually planning. */}
      {planner.location && planner.program && !prepLoading && !prepRow && (
        <p className="text-xs text-gray-500">
          No readiness row exists for this centre and job role yet, so there is nothing recorded about what it still needs.
        </p>
      )}
      {prepRow && (
        prepRow.ready
          ? <p className="text-xs text-green-700">Nothing is blocking this centre × job role — {prepRow.trainers?.certified ?? 0}/{prepRow.trainers?.required ?? 1} trainers certified, {prepRow.candidates?.registered ?? 0}/{prepRow.candidates?.needed ?? 0} candidates registered.</p>
          : (
            <p className="flex flex-wrap items-center gap-1 text-xs text-amber-800">
              Still missing before this can start:
              {(prepRow.blockers ?? []).map((b: string, i: number) => (
                <span key={i} className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5">{b}</span>
              ))}
              <Link className="font-medium text-blue-700 hover:underline" href={`/locations/${prepRow.location?._id}`}>Fix at centre →</Link>
            </p>
          )
      )}

      {planner.eps && (
        // -168 wrote this sentence once so every screen says it the same way.
        <p className={"rounded-lg px-3 py-2 text-xs " + (planner.tooSoon ? "border border-amber-200 bg-amber-50 font-medium text-amber-800" : "bg-blue-50 text-blue-700")}>
          {planner.eps.blocked
            ? <>⚠ This centre cannot start a batch yet ({planner.eps.note}). Any date you pick here will miss.</>
            : planner.tooSoon
              ? <>⚠ {fmtDate(planner.start)} is before the earliest this centre could start — <b>{fmtDate(planner.eps.date)}</b> ({planner.eps.note}). The dates below are still counted back from your date, so they have already passed.</>
              : <>Earliest this centre could start: <b>{fmtDate(planner.eps.date)}</b> ({planner.eps.note})</>}
        </p>
      )}
      {planner.scopedTo?.trainer && (
        <p className="text-xs text-gray-500">
          Using <b>{planner.scopedTo.trainer.name}</b>, who teaches here now
          {/* QA-654: this sentence used to describe only the CALCULATION while the saved batch got
              nobody, so the stored checklist disagreed with the one on screen. It now describes the
              result too, because that is what the save does. */}
          {" "}— they will be assigned to this batch.
          {(planner.scopedTo.trainer.pipeline_status === "Certified" || planner.scopedTo.trainer.tot_done_on)
            && " They are already certified, so the TOT steps are not in this plan."}
        </p>
      )}

      {planner.plan && (
        <>
          <div className="flex flex-wrap gap-1.5">
            {planner.plan.map((m: any) => (
              <span key={m.key} className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-[11px] leading-tight">
                <b className="tabular-nums">{fmtDate(m.due_date)}</b> <span className="text-gray-600">{m.label}</span>
              </span>
            ))}
            <span className="rounded-lg border border-blue-300 bg-blue-100 px-2 py-1 text-[11px] font-semibold leading-tight">
              <span className="tabular-nums">{fmtDate(planner.start)}</span> Batch starts
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Btn onClick={save} disabled={!canSave}>{saving ? "Saving…" : "Save plan & create batch"}</Btn>
            <Btn kind="ghost" onClick={() => copyPlan(planText())}>{planCopied ? "Copied ✓" : "Copy as text"}</Btn>
            {/* Shareable = it reaches the team where they talk, not just the clipboard. */}
            <a className="rounded-lg border border-gray-300 px-3.5 py-2 text-sm font-medium text-green-700 hover:bg-green-50" target="_blank" rel="noreferrer"
              href={`https://wa.me/?text=${encodeURIComponent(planText())}`}>WhatsApp</a>
            <Btn kind="ghost" onClick={() => window.print()}>Print</Btn>
          </div>
          {!planner.program && <p className="text-xs text-gray-500">Pick a job role to save this as a batch — the plan above is already correct without one.</p>}
          <p className="text-xs text-gray-500">Lead times are configurable in Admin → Defaults. Saving stores this checklist on the batch, tick-off-able, and the batch appears in the table below.</p>
        </>
      )}
    </div>
  );
}

// -171 (QA-399) — Karunn sir's Back-dated Planning table, all 18 of his columns.
//
// The three trainer dates (his columns 5, 6 and 13) are editable RIGHT HERE, because this is where
// he works. Putting them only on the trainer form would mean they never get filled, and a tracker
// with three permanently empty columns teaches people to go back to the spreadsheet.
//
// Every trainer column reads the TRAINER, so one trainer on two batches shows one TOT date on both
// rows — it is the same date, not two copies of it. "Not needed" is his own word for a batch whose
// trainer is already certified; the cell says it rather than sitting blank, because blank reads as
// "nobody has done this yet".
// QA-640: the client's "Back-dated Planning" headings, VERBATIM.
// (These comments said QA-607 until -198. Ledger QA-607 is a DIFFERENT, still-open issue - plan
//  sharing cannot be used on any batch that exists today - and the column work had no row of its
//  own at all. A checker caught the mislabel as QA-619; the id was written from memory instead of
//  read from the ledger. QA-653 is the row for the fact that the wrong id survived in twelve
//  places, two of them e2e assertion names, so every wall run printed it.) The typos are his sheet's
// ("verificaiton", "experiene") and they are kept deliberately - this map exists so a reader can
// match a column here to a column there without wondering whether a tidier wording means the same
// thing. Tidying it is exactly the edit that would put the doubt back.
// Source: AVPL - RPL (Recognition of Prior Learning) Project · tab "Back-dated Planning", row 1.
const PLAN_COLUMN_SOURCE: Record<string, string> = {
  sl: "SL#",
  location: "Location",
  job_role: "Job Role",
  trainer: "Trainer Name",
  sidh_profile_verified_on: "Trainer Profile/documents etc verificaiton and Generate TR ID and experiene letter (Industry + Teaching) on SIDH portal.",
  eligibility_checked_on: "Trainer Eligibility Check? Yes/No",
  ready_for_tot: "Trainer Available & Ready for TOT?",
  nsdc_submitted_on: "Trainer profile submitted Date to SSC/NSDC?",
  nsdc_result_on: "Is SSC/NSDC approved the trainer profile for TOT?",
  paid_on: "Approved candidate TOT fee paid to SSC/NSDC?",
  tot_start: "Start date for TOT?",
  tot_done_on: "End date for TOT?",
  tot_result_expected_on: "Expected date of TOT result and certificate?",
  trainer_mapped_sidh: "Date for Trainer Mapping on SIDH Portal?",
  mobilization: "Is Mobilization done for this batch?",
  enrollment_done: "Dates for candidates registration & enrollment done on SIDH portal?",
  planned_start: "Expected Batch Start date",
  planned_end: "Expected Batch End Date",
  // `batch` has no counterpart: the sheet identifies a row by centre + job role and never names the
  // batch. It is ours, and saying so is more honest than inventing a heading for it.
};

// 2026-08-24 (QA-904): `role` left this signature when the delete gate stopped being a role test.
// Removed rather than left dangling - a prop nothing reads is a question the next reader has to answer.
function PlanningTable({ rows, onSaved, onError }: { rows: any[] | null; onSaved: () => void; onError: (m: string) => void }) {
  const [editing, setEditing] = useState<{ id: string; field: string } | null>(null);
  const [value, setValue] = useState("");
  // -196 (Umesh, 2026-08-22): "edit ka button nhi aa rha yaha par". Three cells have been clickable
  // since -171 and nothing on screen said so, so nobody found them. The switch is the whole answer:
  // OFF the table reads like a report, ON every writable cell is visibly writable. It is shown to
  // everyone — the API decides who may actually save, and a save that is refused says why, which is
  // more honest than a control that quietly is not there.
  const [editMode, setEditMode] = useState(false);
  const d = (v: any) => (v == null || v === "" ? <span className="text-gray-300">·</span> : v === "Not needed" ? <span className="text-[10px] uppercase tracking-wide text-gray-400">Not needed</span> : fmtDate(v));

  const save = async (trainerId: string, field: string) => {
    try {
      await api(`/api/trainers/${trainerId}`, { method: "PATCH", body: JSON.stringify({ [field]: value || null }) });
      setEditing(null); setValue(""); onSaved();
    } catch (e: any) { setEditing(null); onError(String(e?.message ?? e)); }
  };
  // The batch's own two dates. Rule 15 lives on the server: change the start and the end is
  // recomputed there, so this never does that arithmetic itself (that would be the second copy).
  const saveBatch = async (batchId: string, field: string) => {
    // A batch without a start or an end is not a batch - every readiness, conflict and settlement
    // calculation reads both. The PATCH route writes whatever it is handed, so the refusal belongs
    // here: clearing is not an edit, it is a hole.
    if (!value) {
      setEditing(null);
      onError("A batch must keep both of its dates. Type the correct one rather than clearing it — to remove the batch entirely, use Delete on the row.");
      return;
    }
    try {
      await api(`/api/batches/${batchId}`, { method: "PATCH", json: { [field]: value } });
      setEditing(null); setValue(""); onSaved();
    } catch (e: any) { setEditing(null); onError(String(e?.message ?? e)); }
  };

  const editable = (id: string | undefined, field: string, shown: any, current: any, commit: (id: string, field: string) => void) => {
    if (!id) return <span className="text-gray-300">·</span>;
    if (!editMode) return shown;
    const on = editing?.id === id && editing?.field === field;
    if (on) {
      return (
        <input type="date" autoFocus className="w-[130px] rounded border border-blue-300 px-1 py-0.5 text-xs"
          value={value} onChange={(e) => setValue(e.target.value)}
          onBlur={() => commit(id, field)}
          onKeyDown={(e) => { if (e.key === "Enter") commit(id, field); if (e.key === "Escape") setEditing(null); }} />
      );
    }
    return (
      <button className="w-full rounded border border-dashed border-blue-300 px-1 text-left hover:bg-blue-50"
        onClick={() => { setEditing({ id, field }); setValue(current ? String(current).slice(0, 10) : ""); }}>
        {shown}
      </button>
    );
  };
  // A trainer date: stored once on the trainer, so one trainer on two batches shows one date twice
  // rather than two copies that can drift.
  const cell = (r: any, field: string) => {
    if (!r.trainer) return <span className="text-gray-300">·</span>;
    if (r[field] === "Not needed") return d(r[field]);
    return editable(r.trainer._id, field, d(r[field]), r[field], save);
  };
  const bcell = (r: any, field: string) => editable(r.batch?._id, field, d(r[field]), r[field], saveBatch);

  // A batch milestone's own date. The grid shows `done_on ?? due_date` — what happened, else what
  // was planned — so typing here means "this happened, on this day", which is `done` with a date.
  const saveMilestone = async (batchId: string, key: string) => {
    try {
      await api(`/api/batches/${batchId}/milestones`, {
        method: "PATCH",
        json: value ? { key, done: true, done_on: value } : { key, done: false },
      });
      setEditing(null); setValue(""); onSaved();
    } catch (e: any) { setEditing(null); onError(String(e?.message ?? e)); }
  };
  const mcell = (r: any, col: string, key: string) => {
    if (r[col] === "Not needed") return d(r[col]);
    if (!editMode) return d(r[col]);
    const on = editing?.id === r.batch?._id && editing?.field === key;
    if (on) {
      return (
        <input type="date" autoFocus className="w-[130px] rounded border border-blue-300 px-1 py-0.5 text-xs"
          value={value} onChange={(e) => setValue(e.target.value)}
          onBlur={() => saveMilestone(r.batch._id, key)}
          onKeyDown={(e) => { if (e.key === "Enter") saveMilestone(r.batch._id, key); if (e.key === "Escape") setEditing(null); }} />
      );
    }
    return (
      <button className="w-full rounded border border-dashed border-blue-300 px-1 text-left hover:bg-blue-50"
        onClick={() => { setEditing({ id: r.batch._id, field: key }); setValue(r[col] ? String(r[col]).slice(0, 10) : ""); }}>
        {d(r[col])}
      </button>
    );
  };
  // Five of the eighteen columns are NOT editable here, and the switch says so instead of leaving
  // a dead cell. They are stamped by the trainer's stage transition (/transition), which enforces
  // TRAINER_FLOW — its document gates, the NSDC round-trip, Rule T7. `tot_done_on` is the sharpest
  // case: `totNeeded()` treats a trainer with that date as TOT-complete, so a typed date here would
  // silently drop the TOT steps out of every future plan. The date is real work with a gate in
  // front of it; the grid points at the gate rather than going round it.
  //
  // -202: this link's title has always said "open the trainer to record it there" — and until now
  // there was nothing there to record it WITH, which is the hole Umesh hit on a bypassed trainer.
  // The trainer's Nomination & TOT card now has an Edit mode over all six dates (PATCH on the same
  // /transition door, never on the plain trainer allow-list). The cell stays read-only HERE on
  // purpose: the correction belongs next to the stage that stamped it, where the screen can say
  // what else the change moves. Only the destination changed, not this decision.
  const gated = (r: any, field: string, where: string) => {
    if (r[field] === "Not needed") return d(r[field]);
    if (!editMode || !r.trainer) return d(r[field]);
    return (
      <Link href={`/trainers/${r.trainer._id}`} title={`Written when the trainer moves to "${where}" — open the trainer to record it there.`}
        className="block w-full rounded border border-dashed border-gray-300 px-1 text-gray-500 hover:bg-gray-50">
        {d(r[field])}
      </Link>
    );
  };

  const del = async (r: any) => {
    if (!window.confirm(`Delete ${r.batch.code}? Everything recorded against it — members, daily logs, attendance, costs — goes with it. This cannot be undone.`)) return;
    try {
      await api(`/api/batches/${r.batch._id}`, { method: "DELETE" });
      onSaved();
    } catch (e: any) { onError(String(e?.message ?? e)); }
  };

  // QA-640 — Umesh, 2026-08-22, holding the "Back-dated Planning" tab of the client workbook next to
  // this screen: "yeh saare column hone chahiye". Every one of his eighteen columns was already
  // here; what was not here were his NAMES. The screen showed `Submitted`, `Approved`, `Fee paid`,
  // and `Starts`/`Ends` TWICE - once under TOT and once under Batch - so a person with the sheet in
  // hand could not find their own columns, and two different dates answered to the same word.
  //
  // This is QA-565 again, on a second table. There it was `APPR.` for `Approved` and his own
  // argument settled it: the table already offers resize, hide and horizontal scroll, so the width
  // an abbreviation saves was always the reader's to spend. And there, as here, the EXPORT already
  // wrote the full names - so one column had two names depending on which surface you looked at.
  //
  // PLAN_COLUMN_SOURCE below carries his sheet's heading VERBATIM for each column, typos and all
  // ("verificaiton", "experiene"), because its job is to let a reader match this screen to that
  // sheet with no doubt at all. It is rendered in the disclosure card under the table.
  //
  // The `group:` row is gone on purpose. Groups existed to give the short labels their meaning
  // ("Starts" under "TOT"); once each label says what it is, a grouping row is decoration that
  // his sheet does not have - and it was groups plus repeated labels that let one Columns-picker
  // entry weld two different dates together (QA-580).
  const columns: any[] = [
    { key: "sl", label: "SL#", minWidth: 52, render: (r: any) => r.sl },
    { key: "location", label: "Location", minWidth: 200, sortable: true, sortValue: (r: any) => r.location?.name ?? "", filterText: (r: any) => r.location?.name ?? "", render: (r: any) => r.location?.name ?? "—" },
    { key: "job_role", label: "Job Role", minWidth: 170, sortable: true, filterText: (r: any) => `${r.job_role ?? ""} ${r.scheme ?? ""}`, render: (r: any) => <>{r.job_role ?? "—"}{r.scheme && <span className="block text-[10px] text-gray-400">{r.scheme}</span>}</> },
    { key: "batch", label: "Batch", minWidth: 150, filterText: (r: any) => r.batch?.code ?? "", render: (r: any) => <Link className="text-blue-700 hover:underline" href={`/batches/${r.batch._id}`}>{r.batch.code}</Link> },
    { key: "trainer", label: "Trainer Name", minWidth: 160, sortable: true, sortValue: (r: any) => r.trainer?.name ?? "", filterText: (r: any) => `${r.trainer?.name ?? ""} ${r.trainer?.tr_id ?? ""}`, render: (r: any) => r.trainer ? <>{r.trainer.name}{r.trainer.tr_id && <span className="block text-[10px] text-gray-400">{r.trainer.tr_id}</span>}</> : <span className="text-amber-700">no trainer</span> },
    { key: "sidh_profile_verified_on", label: "Trainer profile verified on SIDH", minWidth: 210, render: (r: any) => cell(r, "sidh_profile_verified_on") },
    { key: "eligibility_checked_on", label: "Trainer eligibility check", minWidth: 170, render: (r: any) => cell(r, "eligibility_checked_on") },
    { key: "ready_for_tot", label: "Trainer available & ready for TOT", minWidth: 218, render: (r: any) => mcell(r, "ready_for_tot", "trainer_ready_for_tot") },
    { key: "nsdc_submitted_on", label: "Profile submitted to SSC/NSDC", minWidth: 202, render: (r: any) => gated(r, "nsdc_submitted_on", "Sent to NSDC") },
    { key: "nsdc_result_on", label: "SSC/NSDC approved the profile", minWidth: 202, render: (r: any) => <>{gated(r, "nsdc_result_on", "NSDC Approved")}{r.nsdc_remarks && <span className="block text-[10px] text-amber-700" title={r.nsdc_remarks}>remarks</span>}</> },
    { key: "paid_on", label: "TOT fee paid to SSC/NSDC", minWidth: 176, render: (r: any) => gated(r, "paid_on", "Fee Paid") },
    { key: "tot_start", label: "TOT start date", minWidth: 122, render: (r: any) => gated(r, "tot_start", "TOT Scheduled") },
    { key: "tot_done_on", label: "TOT end date", minWidth: 118, render: (r: any) => gated(r, "tot_done_on", "TOT Done") },
    { key: "tot_result_expected_on", label: "TOT result & certificate expected", minWidth: 216, render: (r: any) => cell(r, "tot_result_expected_on") },
    { key: "trainer_mapped_sidh", label: "Trainer mapped on SIDH portal", minWidth: 202, render: (r: any) => mcell(r, "trainer_mapped_sidh", "trainer_mapped_sidh") },
    // Derived from the roster and never typed — `trainers_required` already carries the comment
    // explaining why a count kept in two places is a count that disagrees with itself.
    { key: "mobilization", label: "Mobilisation done for this batch", minWidth: 206, filterText: (r: any) => r.mobilization?.status ?? "",
      render: (r: any) => (
        <span title={editMode ? "Counted from the batch roster — enrol candidates onto the batch and this fills itself." : undefined}
          className={editMode ? "text-gray-500" : undefined}>
          {r.mobilization.status}{r.mobilization.count > 0 && <span className="text-gray-400"> · {r.mobilization.count}</span>}
        </span>
      ) },
    { key: "enrollment_done", label: "Registration & enrolment done on SIDH", minWidth: 250, render: (r: any) => mcell(r, "enrollment_done", "enrollment_done") },
    { key: "planned_start", label: "Expected batch start date", minWidth: 176, sortable: true, sortValue: (r: any) => r.planned_start ?? "", render: (r: any) => bcell(r, "planned_start") },
    // Rule 15 recomputes this on the server when the start moves, so a start edit refreshes both.
    { key: "planned_end", label: "Expected batch end date", minWidth: 170, render: (r: any) => bcell(r, "planned_end") },
  ];
  // -196: "batch ko delete krne k liye kuch nhi hai". DELETE /api/batches/:id counts everything
  // hanging off the batch before it goes; the column only appears in Edit mode, so nobody meets a
  // delete button while reading.
  // 2026-08-24 (QA-904, Umesh: "vo bhi respective acess wale persons"): the gate was the Admin role
  // and is now the togglable `batches.delete` right, so Operations - who plan the batches - can clear
  // their own empty shells without an Admin. The server refuses independently; this only decides who
  // is offered the button.
  const { can: canRightP, loaded: rightsLoadedP } = usePerms();
  if (editMode && rightsLoadedP && canRightP("batches.delete", "edit")) {
    columns.push({
      key: "_act", label: "", minWidth: 74,
      render: (r: any) => (
        <button className="rounded border border-red-200 px-2 py-0.5 text-[11px] font-medium text-red-700 hover:bg-red-50"
          onClick={(e: any) => { e.stopPropagation(); del(r); }}>Delete</button>
      ),
    });
  }

  // -196 (Umesh): "jaise batch start ho jayega planning wale se, woh batch wale tab mein shift ho
  // jayega". A batch that has started is no longer being planned, so it leaves this table — the row
  // moves by itself, because its status is what moved. The Batches tab stays the full register of
  // every batch at every status, so nothing disappears from the system, only from this view.
  const NOT_STARTED = ["Planning", "Ready"];
  const shown = (rows ?? []).filter((r: any) => NOT_STARTED.includes(r.batch?.status));
  const started = (rows ?? []).length - shown.length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-blue-600" checked={editMode}
            onChange={(e) => { setEditMode(e.target.checked); setEditing(null); }} />
          <span className="font-medium text-gray-800">Edit mode</span>
          <span className="text-xs text-gray-500">{editMode ? "click any outlined date to change it" : "turn on to change dates"}</span>
        </label>
        {/* QA-526: the man this table was built for keeps it in a spreadsheet today. Without a
            download he reads it once and goes back to Excel, which is the whole thing this replaces.
            QA-643: the export reads all four live statuses; this table shows the two that have not
            started. The download is NOT narrowed to match - the sheet it mirrors is his whole live
            picture, and quietly dropping the running batches out of it would be a worse surprise
            than a longer file. So the button says which of the two it is, in the same breath as the
            line beside it that says how many are missing from the screen. */}
        <span title="The download carries every live batch, including the ones that have started and are no longer listed here.">
          <Btn kind="ghost" onClick={() => { window.location.href = `${BASE_PATH}/api/plan-tracker/export`; }}>Download Excel (all live batches)</Btn>
        </span>
      </div>
      <p className="rounded-lg bg-blue-50 px-3 py-2 text-xs text-blue-800">
        The batches that have not started yet, the way the planning sheet reads it. Each date shows what
        actually happened, and until it has, the backward plan&apos;s target for that step.
        {started > 0 && <> {started} batch{started === 1 ? " has" : "es have"} already started and moved to the <b>Batches</b> tab — the Excel download above still carries {started === 1 ? "it" : "them"}.</>}
        {editMode && <> Dates on a dashed outline are yours to edit here; a greyed one is written where its
        gate is — open the trainer, and recording the stage there fills this in.</>}
      </p>
      {/* QA-640: the same disclosure card the report uses (reports/page.tsx, and the pattern at
          admin/page.tsx:430). Its job is narrow and worth stating: a reader with the client's
          "Back-dated Planning" tab open should be able to match every column here to a column there
          with no doubt. So it quotes that sheet's headings VERBATIM — including their typos — rather
          than a tidied paraphrase, which is the one thing that would put the doubt back. */}
      <details className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
        <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-gray-500">
          Which column of the planning sheet is which
        </summary>
        <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-gray-600">
          {columns.filter((c: any) => PLAN_COLUMN_SOURCE[c.key]).map((c: any) => (
            <div key={c.key}><b>{c.label}</b> — {PLAN_COLUMN_SOURCE[c.key]}</div>
          ))}
        </div>
      </details>
      <DataTable storageKey="plan-tracker" rows={shown} loading={rows === null} columns={columns}
        empty="No batch is being planned right now — use “Plan a batch” at the top of this page to start one."
        cardTitle={(r: any) => <>{r.batch.code} <span className="text-xs text-gray-400">· {r.location?.name}</span></>} />
    </div>
  );
}
