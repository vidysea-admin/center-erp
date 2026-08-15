"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, fmtDate, pipelineLabel, toInputDate } from "@/lib/client";
import { emailError, phoneError } from "@/lib/validate";
import { Btn, Chip, DataTable, Drawer, ErrorBanner, Field, FilterPills, NameCell, ShareLinkPanel, SourceCell, Tabs, inputCls } from "@/components/ui";
import { BASE_PATH } from "@/lib/base-path";

// 2026-08-13 (Umesh): "10 mein se 5 available, 2 under preparation, 3 not available — sab ke
// saath proper tag with filters". One derived availability tag per trainer: the pipeline says
// whether they are USABLE yet, the status says whether they are FREE.
// CEO 14/08 [06:57]: "instead of assigned, we should have a status called ready or
// certified. Certified is a better word. Assigned should be used when you have assigned a
// batch to them… if a trainer is at capacity … unavailable." The status axis answers "who
// can take a class tomorrow" in exactly those three words.
// QA-031: assignment is read from the LIVE BATCH LINKS (live_batches, attached by the API),
// never from the stored status field — that field said "Assigned 11" while no batch pointed
// at those trainers, and said "Certified 6" were assigned when the real number was different.
const TAG_ORDER = ["Certified", "Under preparation", "Assigned", "Unavailable", "Rejected/Dropped"] as const;
function availabilityTag(t: any): (typeof TAG_ORDER)[number] {
  const p = t.pipeline_status ?? "Fresh Lead";
  if (p === "NSDC Rejected" || p === "Dropped") return "Rejected/Dropped";
  if (p !== "Certified") return "Under preparation";
  if ((t.live_batches?.length ?? 0) > 0) return "Assigned";
  if (t.status === "Unavailable") return "Unavailable";
  return "Certified";
}

export default function TrainersPage() {
  return <Suspense><TrainersInner /></Suspense>;
}

function TrainersInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = useState(["Requests", "Open Positions"].includes(sp.get("tab") ?? "") ? sp.get("tab")! : "Trainers");
  const [items, setItems] = useState<any[]>([]);
  const [requests, setRequests] = useState<any[]>([]);
  // QA-029: recognised job roles (master ∪ programme skills) for the skills input + list flag.
  const [jobRoles, setJobRoles] = useState<any[]>([]);
  const [programSkills, setProgramSkills] = useState<string[]>([]);
  const [locations, setLocations] = useState<any[]>([]);
  // Deep-link presets: /trainers?tag=Available (pill) or ?status=/?pipeline_status= (API-side).
  const [tag, setTag] = useState(sp.get("tag") ?? "");
  const [stageFilter, setStageFilter] = useState("");  // CEO: "har stage pe accepted/rejected dikhe"
  const [reqFilter, setReqFilter] = useState("open"); // KPI counts open ones — the list defaults to match
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [drawer, setDrawer] = useState(false);
  // QA-065: write affordances only for people the server will actually let write —
  // edit-flag on, and not a role whose writes are refused (Enrollment/Trainer).
  const { data: session } = useSession();
  const su: any = session?.user ?? {};
  const canWrite = !!su.can_edit && !["Enrollment", "Trainer"].includes(su.role);
  const [edit, setEdit] = useState<any>(null);
  const [form, setForm] = useState<any>({ max_concurrent_batches: 1, status: "Available" });
  const set = (k: string, v: unknown) => setForm((f: any) => ({ ...f, [k]: v }));
  const [invite, setInvite] = useState<any>(null);         // quick-invite drawer {form, link?}
  const [imp, setImp] = useState<any>(null);               // F-TRAINER-IMPORT drawer state
  async function trainerImport(previewOnly: boolean) {
    if (!imp?.file) return;
    const fd = new FormData();
    fd.append("file", imp.file);
    fd.append("mapping", JSON.stringify(imp.mapping ?? {}));
    // 15/08 (Umesh): unknown columns accepted by default; the operator unticks to ignore.
    if (imp.accept_unknown !== false) fd.append("accept_unknown", "1");
    if (!previewOnly) fd.append("confirm", "1");
    try {
      const res = await fetch(`${BASE_PATH}/api/trainers/import`, { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "import failed");
      if (previewOnly) setImp({ ...imp, preview: d, done: null });
      else {
        // QA-110: remember the mapping per column-set so the same sheet shape is pre-filled next time.
        try { localStorage.setItem("erp-import-map-trainers", JSON.stringify({ sig: [...(imp.columns ?? [])].sort().join("|"), mapping: imp.mapping ?? {} })); } catch {}
        setImp({ ...imp, done: d, preview: null }); load();
      }
    } catch (err: any) { setError(err.message); }
  }
  const [positions, setPositions] = useState<any[]>([]);   // CEO: Open Positions tab
  const [posFilter, setPosFilter] = useState("Open");      // default = only what needs hiring
  // R-G (CEO [09:12]): "by default only approved selected, but I should be able to change
  // to show not approved also" — and [09:01]: a stage count is clickable to SEE the people.
  const [posApproved, setPosApproved] = useState<"approved" | "all">("approved");
  const [posDetail, setPosDetail] = useState<{ pos: any; bucket: string; label: string } | null>(null);
  const [reqEdit, setReqEdit] = useState<any>(null);
  const [reqForm, setReqForm] = useState<any>({});
  const setReq = (k: string, v: unknown) => setReqForm((f: any) => ({ ...f, [k]: v }));

  const load = () => Promise.all([
    // ?status=/?pipeline_status= presets ride through to the API (already filterable there).
    // Text search moved into DataTable (all-column, client-side over the full 2000-row fetch).
    api(`/api/trainers?${sp.get("status") ? `status=${encodeURIComponent(sp.get("status")!)}&` : ""}${sp.get("pipeline_status") ? `pipeline_status=${encodeURIComponent(sp.get("pipeline_status")!)}&` : ""}limit=2000`).then((d) => setItems(d.items)),
    api("/api/trainer-requests?limit=2000").then((d) => setRequests(d.items)),
    api("/api/locations?limit=2000").then((d) => setLocations(d.items)),
    // QA-029 (-69): the job-roles master + programme skills feed the skills input — a trainer
    // without a recognised job role is what blanks the Preparation board at scale.
    api("/api/master-lists/job-roles").then((d) => setJobRoles((d.items ?? []).filter((j: any) => j.active !== false))).catch(() => {}),
    api("/api/programs?limit=1000").then((d) => setProgramSkills([...new Set<string>((d.items ?? []).map((p: any) => String(p.trainer_skill ?? "")).filter(Boolean))])).catch(() => {}),
  ]).catch((e) => setError(e.message)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // QA-029: a skill "counts" when it matches a recognised job role (master ∪ programme
  // skills, case-insensitive). Warn — never block (house rule): the Preparation board and
  // the batch dropdown both key on roles, so an unrecognised-only trainer is invisible there.
  const knownRoles = [...new Set([...jobRoles.map((j: any) => j.name), ...programSkills])];
  const roleMismatch = (skills?: string[]) =>
    knownRoles.length > 0 && (skills ?? []).length > 0 &&
    !(skills ?? []).some((s) => knownRoles.some((k) => String(k).trim().toLowerCase() === String(s).trim().toLowerCase()));
  // Positions load separately so the approved/all toggle refetches just the board.
  useEffect(() => {
    api(`/api/open-positions${posApproved === "all" ? "?approved=all" : ""}`)
      .then((d) => setPositions(d.items)).catch((e) => setError(e.message));
  }, [posApproved]); // eslint-disable-line react-hooks/exhaustive-deps

  const tagCounts = new Map<string, number>();
  for (const t of items) tagCounts.set(availabilityTag(t), (tagCounts.get(availabilityTag(t)) ?? 0) + 1);
  // CEO 13/08: stage-wise counts with rejected-here — the journey as a strip, click = filter.
  const STAGES = ["Fresh Lead", "Shortlisted", "Documents Completed",
    "Sent to NSDC", "NSDC Approved", "NSDC Rejected", "TOT Payment Done", "TOT Scheduled", "TOT In Progress", "Certified"];
  const stageCur = new Map<string, number>();
  const stageRej = new Map<string, number>();
  // QA-046 (CEO): "har stage pe Accepted/Rejected" — accepted-at-a-stage = everyone whose
  // journey moved PAST it (they cleared that gate). Derived from current stage index.
  const stageAcc = new Map<string, number>();
  for (const t of items) {
    stageCur.set(t.pipeline_status ?? "Fresh Lead", (stageCur.get(t.pipeline_status ?? "Fresh Lead") ?? 0) + 1);
    if (t.dropped_from_stage) stageRej.set(t.dropped_from_stage, (stageRej.get(t.dropped_from_stage) ?? 0) + 1);
    const curIdx = STAGES.indexOf(t.pipeline_status === "Dropped" ? (t.dropped_from_stage ?? "Fresh Lead") : (t.pipeline_status ?? "Fresh Lead"));
    for (let i = 0; i < curIdx; i++) stageAcc.set(STAGES[i], (stageAcc.get(STAGES[i]) ?? 0) + 1);
  }
  // QA-047 (checker): same name under two phones may be one person entered twice — the
  // unique-phone index cannot catch it, so it is surfaced for a human (Manish) to confirm.
  // Never auto-merged.
  const dupeNames = (() => {
    const byName = new Map<string, Set<string>>();
    for (const t of items) {
      const k = String(t.name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
      if (!k) continue;
      if (!byName.has(k)) byName.set(k, new Set());
      byName.get(k)!.add(String(t.phone ?? ""));
    }
    return [...byName.entries()].filter(([, phones]) => phones.size > 1)
      .map(([name, phones]) => ({ name, phones: [...phones] }));
  })();
  const stageShown = stageFilter
    ? items.filter((t) => (t.pipeline_status === stageFilter) || (t.pipeline_status === "Dropped" && t.dropped_from_stage === stageFilter))
    : items;
  const shown = tag ? stageShown.filter((t) => availabilityTag(t) === tag) : stageShown;
  const openReq = requests.filter((r) => ["Open", "In Progress"].includes(r.status));
  const openPos = positions.filter((p) => p.status === "Open");
  const shownPos = posFilter === "Open" ? openPos : posFilter === "Closed" ? positions.filter((p) => p.status === "Closed") : positions;
  const shownReq = reqFilter === "open" ? openReq : reqFilter ? requests.filter((r) => r.status === reqFilter) : requests;

  function openEdit(t: any) {
    setEdit(t);
    setForm({
      ...t,
      home_location: t.home_location?._id ?? (t.home_location_other ? "__other__" : ""),
      home_location_other: t.home_location_other ?? "",
      skills: t.skills ?? [], capable_locations: (t.capable_locations ?? []).map((l: any) => l?._id ?? l),
    });
    setDrawer(true);
  }

  // QA-141 rider (-72): in-flight guard — a double click was two POSTs (the 2nd died on the
  // unique index only when the phone string matched exactly).
  const [savingT, setSavingT] = useState(false);
  async function save() {
    if (savingT) return;
    setSavingT(true);
    try {
      const json = {
        ...form,
        skills: typeof form.skills === "string" ? form.skills.split(",").map((s: string) => s.trim()).filter(Boolean) : form.skills,
        // "Others" (2026-08-13): home is free text when it is not one of our centres.
        home_location: form.home_location && form.home_location !== "__other__" ? form.home_location : null,
        home_location_other: form.home_location === "__other__" ? (form.home_location_other || null) : null,
        compensation_type: form.compensation_type || undefined,
      };
      if (edit) await api(`/api/trainers/${edit._id}`, { method: "PATCH", json });
      else await api("/api/trainers", { method: "POST", json });
      setDrawer(false); setEdit(null); setForm({ max_concurrent_batches: 4, status: "Available" }); load();
    } catch (e: any) { setError(e.message); }
    setSavingT(false);
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
        {/* QA-065: no buttons that exist only to bounce — a view-only user or a role the
            server refuses (Enrollment/Trainer) gets no Add/Import/Quick-add affordance. */}
        {/* QA-120: flex-wrap — this row overflowed every trainers tab by 50px on a phone. */}
        {canWrite && (
        <div className="flex flex-wrap gap-2">
          {/* CEO 13/08: "naam-email-phone dala, link bana, WhatsApp chala gaya — trainer khud bhare" */}
          <Btn kind="ghost" onClick={() => setImp({})}>Import (Excel)</Btn>
          <Btn kind="ghost" onClick={() => setInvite({ form: {} })}>Quick add + send link</Btn>
          <Btn onClick={() => { setEdit(null); setForm({ max_concurrent_batches: 4, status: "Available", pipeline_status: "Fresh Lead" }); setDrawer(true); }}>Add Trainer</Btn>
        </div>
        )}
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      {/* CEO 13/08: "Open Positions — kahan-kahan trainer hire karne hain" — Divya's tab. */}
      <Tabs tabs={["Trainers", `Requests (${openReq.length})`, `Open Positions (${openPos.length})`]}
        active={tab.startsWith("Requests") ? `Requests (${openReq.length})` : tab.startsWith("Open Positions") ? `Open Positions (${openPos.length})` : tab}
        onChange={(t) => setTab(t.startsWith("Requests") ? "Requests" : t.startsWith("Open Positions") ? "Open Positions" : t)} />
      {tab === "Open Positions" && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <FilterPills active={posFilter} onChange={(v) => setPosFilter(v === posFilter ? "" : v)}
              options={[
                { value: "Open", label: "Open", count: openPos.length },
                { value: "Closed", label: "Filled", count: positions.filter((p) => p.status === "Closed").length },
                { value: "", label: "All", count: positions.length },
              ]} />
            {/* R-G approved toggle — the CEO's default stays approved-only. */}
            <FilterPills active={posApproved} onChange={(v) => setPosApproved((v || "approved") as any)}
              options={[
                { value: "approved", label: "Approved centres", count: positions.filter((p) => p.approved).length },
                { value: "all", label: "Show not approved too", count: posApproved === "all" ? positions.length : undefined as any },
              ]} />
          </div>
          <p className="text-xs text-gray-500">
            A position fills by itself the moment the required number of trainers is certified for that
            centre × job role. Click a stage count to see exactly who is there.
          </p>
          <DataTable rows={shownPos} storageKey="open-positions"
            cardTitle={(r: any) => <>{r.location?.name} <span className="text-xs text-gray-400">· {r.program?.name}</span></>}
            loading={loading}
            defaultSort={{ key: "balance", dir: "desc" }}
            columns={[
              { key: "location", label: "Location", sortable: true, sortValue: (r: any) => r.location?.name, filterable: true, filterText: (r: any) => r.location?.name, minWidth: 220,
                render: (r: any) => <NameCell name={r.location?.name} sub={r.location?.code} /> },
              { key: "program", label: "Job role", sortable: true, sortValue: (r: any) => r.program?.name, filterable: true, filterText: (r: any) => `${r.program?.name ?? ""} ${r.program?.scheme ?? ""}`,
                render: (r: any) => <span>{r.program?.name} {r.program?.scheme && <Chip value={r.program.scheme} />}</span> },
              { key: "required", label: "Required", sortable: true, sortValue: (r: any) => r.required ?? -1, render: (r: any) => r.required ?? <span className="text-gray-400">not set</span> },
              { key: "certified", label: "Certified (ours)", sortable: true, sortValue: (r: any) => r.certified },
              {
                // QA-001 (checker): over-nomination was invisible — more people in the pipeline
                // than the position needs is money and TOT seats spent on a filled role.
                key: "nominated", label: "In pipeline", mobile: false, sortable: true, sortValue: (r: any) => r.nominated,
                render: (r: any) => r.required != null && r.nominated > r.required
                  ? <span className="font-semibold text-amber-700" title={`${r.nominated} in the pipeline for a position that needs ${r.required} — over-nominated`}>{r.nominated} ⚠ over</span>
                  : r.nominated,
              },
              { key: "balance", label: "Balance to hire", sortable: true, sortValue: (r: any) => r.balance ?? -1,
                render: (r: any) => r.balance == null ? <span className="text-gray-400">—</span>
                  : <span className={`font-semibold ${r.balance > 0 ? "text-amber-600" : "text-green-700"}`}>{r.balance}</span> },
              {
                // R-G (CEO [07:56]): the pipeline mapped against each position — "then we
                // can see which position needs our focus more than others". Click = names.
                key: "stages", label: "Pipeline", mobile: false, minWidth: 300,
                render: (r: any) => (
                  <div className="flex flex-wrap gap-1">
                    {([["fresh", "Fresh"], ["shortlisted", "Short"], ["docs", "Docs"], ["sent", "NSDC"], ["approved", "Appr"], ["certified", "Cert"]] as const).map(([k, lbl]) => {
                      const n = r.stages?.[k] ?? 0;
                      const FULL: Record<string, string> = { fresh: "Fresh Lead", shortlisted: "Shortlisted", docs: "Documents Completed", sent: "Sent to NSDC (incl. rejected-and-fixing)", approved: "NSDC Approved (incl. TOT prep)", certified: "Certified" };
                      return (
                        <button key={k} disabled={!n}
                          title={`${FULL[k]}: ${n}`}
                          onClick={(e) => { e.stopPropagation(); if (n) setPosDetail({ pos: r, bucket: k, label: FULL[k] }); }}
                          className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${n ? (k === "certified" ? "bg-green-100 text-green-700 hover:bg-green-200" : "bg-blue-50 text-blue-700 hover:bg-blue-100") : "bg-gray-50 text-gray-300"}`}>
                          {lbl} {n}
                        </button>
                      );
                    })}
                  </div>
                ),
              },
              ...(posApproved === "all" ? [{
                key: "approved", label: "Approved", sortable: true, sortValue: (r: any) => (r.approved ? 1 : 0),
                render: (r: any) => r.approved ? <span className="text-green-700">✓</span>
                  : <span className="text-amber-700" title={r.approved_reason ?? ""}>✗ {r.approved_reason}</span>,
              }] : []),
              // CEO [08:43] could not parse "Closed" — the word on the board is "Filled".
              { key: "status", label: "Status", sortable: true, sortValue: (r: any) => r.status,
                render: (r: any) => <Chip value={r.status === "Closed" ? "Filled" : r.status} /> },
            ]}
            empty="No open positions — every approved centre × job role has its trainers." />
          <Drawer open={!!posDetail} onClose={() => setPosDetail(null)}
            title={posDetail ? `${posDetail.pos.location?.name} · ${posDetail.pos.program?.name} — ${posDetail.label}` : ""}>
            {posDetail && (
              <ul className="space-y-2">
                {(posDetail.pos.stage_trainers?.[posDetail.bucket] ?? []).map((t: any) => (
                  <li key={t._id}>
                    <Link className="text-sm font-medium text-blue-700 hover:underline" href={`/trainers/${t._id}`}>{t.name}</Link>
                    <span className="ml-2 text-xs text-gray-500">{t.stage}</span>
                  </li>
                ))}
                {(posDetail.pos.stage_trainers?.[posDetail.bucket] ?? []).length === 0 && (
                  <li className="text-sm text-gray-400">Nobody here right now.</li>
                )}
              </ul>
            )}
          </Drawer>
        </>
      )}
      {tab === "Trainers" ? (
        <>
          {/* CEO 13/08: "har stage pe Accepted/Rejected dikhe" — the whole journey as counts;
              red = trainers who were DROPPED at that stage. Click a stage to filter. */}
          <div className="dt-scroll flex gap-1.5 overflow-x-auto pb-1">
            {STAGES.map((st) => {
              const cur = stageCur.get(st) ?? 0, rej = stageRej.get(st) ?? 0, acc = stageAcc.get(st) ?? 0;
              if (!cur && !rej && !acc) return (
                <button key={st} onClick={() => setStageFilter(stageFilter === st ? "" : st)}
                  title="0 here now · 0 accepted through · 0 rejected here"
                  className={`shrink-0 rounded-lg border px-2 py-1 text-[11px] ${stageFilter === st ? "border-blue-400 bg-blue-50" : "border-gray-100 text-gray-300"}`}>
                  {pipelineLabel(st)} 0 <span className="text-[10px]">✓0 ✗0</span>
                </button>
              );
              return (
                <button key={st} onClick={() => setStageFilter(stageFilter === st ? "" : st)}
                  title={`${cur} here now · ${acc} accepted (moved past this stage) · ${rej} rejected at this stage`}
                  className={`shrink-0 rounded-lg border px-2 py-1 text-left text-[11px] font-medium ${stageFilter === st ? "border-blue-400 bg-blue-50 text-blue-800" : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"}`}>
                  {pipelineLabel(st)} <span className="font-semibold text-gray-900">{cur}</span>
                  {/* QA-046: the CEO's pair at EVERY stage — zeros included, greyed. */}
                  <span className={`ml-1 rounded-full px-1.5 text-[10px] font-semibold ${acc > 0 ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"}`}>✓{acc}</span>
                  <span className={`ml-1 rounded-full px-1.5 text-[10px] font-semibold ${rej > 0 ? "bg-red-100 text-red-700" : "bg-gray-100 text-gray-400"}`}>✗{rej}</span>
                </button>
              );
            })}
          </div>
          {dupeNames.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              ⚠ <b>{dupeNames.length} name{dupeNames.length > 1 ? "s appear" : " appears"} under more than one phone number</b> — possibly the same person entered twice (the phone-unique rule cannot catch this). Confirm with the team before merging:{" "}
              {dupeNames.slice(0, 5).map((d) => `${d.name} (${d.phones.join(" / ")})`).join(" · ")}{dupeNames.length > 5 ? " …" : ""}
            </div>
          )}
          <FilterPills active={tag} onChange={(v) => setTag(v === tag ? "" : v)}
            options={[{ value: "", label: "All", count: items.length },
              ...TAG_ORDER.map((t) => ({
                value: t, label: t, count: tagCounts.get(t) ?? 0,
                // These are mutually exclusive TODAY-states, not a funnel — "Available 0
                // while Assigned 6" simply means every certified trainer is on a batch.
                title: {
                  "Certified": "Certified and not on any live batch — can take a class tomorrow",
                  "Under preparation": "Still in the hiring/TOT pipeline — not certified yet (may already be pencilled into a batch)",
                  "Assigned": "Certified and named on a live batch (Planning/Ready/Active/Closing)",
                  "Unavailable": "Certified but marked unavailable",
                  "Rejected/Dropped": "Left the pipeline (NSDC rejected or dropped)",
                }[t],
              }))]} />
          {/* 2026-08-13 (Manish couldn't find the hiring journey): a row now opens the trainer's
              detail page — the ONLY host of the journey rail + TOT panel; editing moved to the
              explicit button so the journey stops being unreachable. */}
          <DataTable rows={shown} onRowClick={(r: any) => router.push(`/trainers/${r._id}`)}
            cardTitle={(r: any) => r.name}
            loading={loading}
            defaultSort={{ key: "name", dir: "asc" }}
            columns={[
              { key: "name", label: "Name", mobile: false, sortable: true, sortValue: (r: any) => r.name, render: (r: any) => <NameCell name={r.name} sub={r.phone} /> },
              {
                // QA-029: flag rows whose skills name NO recognised job role — the exact rows
                // that blank the Preparation board when the real cohort loads.
                key: "skills", label: "Skills", render: (r: any) => (
                  <span>
                    {(r.skills ?? []).join(", ")}
                    {roleMismatch(r.skills) && (
                      <span className="ml-1.5 rounded-full border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700"
                        title="No recognised job role — invisible to the Preparation board and the batch form's role counts">no job role</span>
                    )}
                  </span>
                ),
              },
              { key: "home_location", label: "Home location", sortable: true, sortValue: (r: any) => r.home_location?.name ?? r.home_location_other ?? null, render: (r: any) => r.home_location?.name ?? r.home_location_other ?? "—", mobile: false },
              {
                // 2026-08-12: three states now, not two — a rejected profile and a dropped applicant
                // are not "in progress", and showing them amber hides the ones needing action.
                key: "pipeline_status", label: "Pipeline", sortable: true, sortValue: (r: any) => r.pipeline_status ?? "Fresh Lead",
                // The funnel filter must speak the SAME display names the cells show —
                // raw enum values here were exactly the "old labels in the filters"
                // Umesh caught on 14/08 after the CEO rename.
                filterText: (r: any) => {
                  const s = r.pipeline_status ?? "Fresh Lead";
                  return s === "Dropped" && r.dropped_from_stage ? `Dropped (at ${pipelineLabel(r.dropped_from_stage)})` : pipelineLabel(s);
                },
                render: (r: any) => {
                  const s = r.pipeline_status ?? "Fresh Lead";
                  const tone = s === "Certified" ? "border-green-200 bg-green-50 text-green-700"
                    : s === "NSDC Rejected" || s === "Dropped" ? "border-red-200 bg-red-50 text-red-700"
                      : "border-amber-200 bg-amber-50 text-amber-700";
                  {/* GD-39 + CEO 13/08: stages speak the operator's words (Fresh Lead, TOT
                      Payment Done…), and a Dropped profile NAMES the stage it died at. */}
                  return <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${tone}`}>
                    {s === "Dropped" && r.dropped_from_stage ? `Dropped (at ${pipelineLabel(r.dropped_from_stage)})` : pipelineLabel(s)}
                  </span>;
                },
              },
              {
                // QA-135: a Certified trainer without a TR ID is the state the bypass leaves
                // behind — flag it right in the list until the fact is recorded. Never blocks.
                key: "tr_id", label: "TR ID", mobile: false,
                render: (r: any) => r.tr_id
                  || (r.pipeline_status === "Certified"
                    ? <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700">TR ID pending</span>
                    : "—"),
              },
              {
                // QA-045 (third reopen — checker): the COLUMN still leaked the stale stored
                // status for certified trainers (4 of 6 wrong) while the pills were already
                // derived. One truth everywhere now: the tag computed from pipeline + real
                // batch links. The raw field is never rendered again.
                key: "status", label: "Status", sortable: true, filterable: true,
                sortValue: (r: any) => availabilityTag(r), filterText: (r: any) => availabilityTag(r),
                render: (r: any) => <Chip value={availabilityTag(r)} />,
              },
              { key: "available_from", label: "Available from", sortable: true, sortValue: (r: any) => r.available_from ? new Date(r.available_from).getTime() : null, render: (r: any) => fmtDate(r.available_from), mobile: false },
              { key: "max_concurrent_batches", label: "Max batches", mobile: false },
              // 2026-08-13 (Manish): where this row came from, one click to that sheet tab.
              { key: "source", label: "Source", mobile: false, filterable: true, filterText: (r: any) => r.source ?? "Entered in ERP", render: (r: any) => <SourceCell source={r.source} /> },
              {
                key: "_edit", label: "", render: (r: any) => (
                  <span onClick={(e) => e.stopPropagation()} className="flex items-center gap-1">
                    <Btn small kind="ghost" onClick={() => openEdit(r)}>Edit</Btn>
                    {/* QA-130: deletion is for junk rows (probes, duplicate imports) — Admin
                        only; the API refuses anyone referenced by a batch (drop those instead). */}
                    {su.role === "Admin" && (
                      <Btn small kind="ghost" onClick={async () => {
                        if (!window.confirm(`Delete ${r.name} (${r.phone}) permanently? Their documents go too. A trainer with real history should be Dropped, not deleted.`)) return;
                        try { await api(`/api/trainers/${r._id}`, { method: "DELETE" }); load(); }
                        catch (e: any) { setError(e.message); }
                      }}>Delete</Btn>
                    )}
                  </span>
                ),
              },
            ]} empty="No trainers yet." />
        </>
      ) : tab === "Requests" ? (
        <>
          {/* Default = the open ones, so the Home KPI's count and this list agree. */}
          <FilterPills active={reqFilter} onChange={(v) => setReqFilter(v)}
            options={[
              { value: "open", label: "Open + In Progress", count: openReq.length },
              { value: "Fulfilled", label: "Fulfilled", count: requests.filter((r) => r.status === "Fulfilled").length },
              { value: "Cancelled", label: "Cancelled", count: requests.filter((r) => r.status === "Cancelled").length },
              { value: "", label: "All", count: requests.length },
            ]} />
          <DataTable rows={shownReq} onRowClick={openReqEdit} loading={loading}
            cardTitle={(r: any) => `${r.location?.name} · ${r.program?.name}`}
            defaultSort={{ key: "required_by_date", dir: "asc" }}
            columns={[
              { key: "location", label: "Location", sortable: true, sortValue: (r: any) => r.location?.name, render: (r: any) => r.location?.name },
              { key: "program", label: "Program", sortable: true, sortValue: (r: any) => r.program?.name, render: (r: any) => r.program?.name },
              { key: "required_by_date", label: "Required by", sortable: true, sortValue: (r: any) => r.required_by_date ? new Date(r.required_by_date).getTime() : null, render: (r: any) => fmtDate(r.required_by_date) },
              { key: "status", label: "Status", sortable: true, render: (r: any) => <Chip value={r.status} /> },
              { key: "hiring_target_date", label: "Hiring by", render: (r: any) => fmtDate(r.hiring_target_date), mobile: false },
              { key: "tot_done_on", label: "TOT", render: (r: any) => r.tot_done_on ? `Done ${fmtDate(r.tot_done_on)}` : r.tot_scheduled_on ? `Sched ${fmtDate(r.tot_scheduled_on)}` : "—" },
              { key: "fulfilled_by_trainer", label: "Fulfilled by", render: (r: any) => r.fulfilled_by_trainer?.name ?? "—" },
            ]} empty="No trainer requests." />
        </>
      ) : null}

      {/* F-TRAINER-IMPORT: Manish's stage-wise sheet (qa/templates #3) → upload → map →
          preview → confirm. Unknown stages / centre / job-role names are reported and left
          blank, never guessed. */}
      <Drawer open={!!imp} onClose={() => setImp(null)} title="Import trainers (Excel)" wide>
        {imp && (
          <div className="space-y-3">
            {/* QA-028: every importer offers its sample sheet. */}
            <a href={`${BASE_PATH}/templates/trainers-sample.csv`} download className="inline-block text-sm font-medium text-blue-700 hover:underline">⬇ Download sample sheet format</a>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={async (e) => {
              const file = e.target.files?.[0]; e.target.value = "";
              if (!file) return;
              const fd = new FormData(); fd.append("file", file);
              try {
                const res = await fetch(`${BASE_PATH}/api/trainers/import`, { method: "POST", body: fd });
                const d = await res.json();
                if (!res.ok) throw new Error(d.error ?? "upload failed");
                // QA-110: pre-fill the remembered mapping when this column-set was imported before.
                let remembered: any = null;
                try {
                  const saved = JSON.parse(localStorage.getItem("erp-import-map-trainers") ?? "null");
                  if (saved?.sig === [...(d.columns ?? [])].sort().join("|")) remembered = saved.mapping;
                } catch {}
                setImp({ file, columns: d.columns, total: d.total, mapping: remembered ?? {}, remembered: !!remembered });
              } catch (err: any) { setError(err.message); }
            }} />
            {imp.columns && (
              <>
                <p className="text-sm text-gray-600">{imp.total} rows found. Map columns → fields (name and phone required). "Current Stage" accepts the display names (Fresh Lead, TOT Payment Done…).</p>
                <div className="grid grid-cols-2 gap-2">
                  {imp.columns.map((c: string) => (
                    <Field key={c} label={c}>
                      <select className={inputCls} value={imp.mapping?.[c] ?? ""} onChange={(e) => setImp({ ...imp, mapping: { ...imp.mapping, [c]: e.target.value } })}>
                        <option value="">Ignore</option>
                        {["name", "phone", "email", "qualification", "skills", "industry_experience_years", "teaching_experience_years", "home_location_other", "pipeline_status", "tr_id", "nominated_for_location", "nominated_for_program", "source", "day_rate", "pipeline_note"].map((f) => <option key={f}>{f}</option>)}
                      </select>
                    </Field>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Btn kind="ghost" onClick={() => trainerImport(true)}>Preview</Btn>
                  {imp.preview && <Btn onClick={() => trainerImport(false)}>Import {imp.preview.importable ?? imp.preview.valid} trainers</Btn>}
                </div>
                {imp.remembered && <p className="text-xs text-blue-700">Mapping pre-filled from your last import of this sheet shape — check it still fits.</p>}
                {imp.preview && (
                  <div className="space-y-2 text-sm text-gray-600">
                    <p>{imp.preview.valid} valid, {imp.preview.skipped} skipped (missing name/phone).</p>
                    {/* QA-110: an operator who forgets to map a column must be able to notice. */}
                    {(imp.preview.ignored_columns?.length ?? 0) > 0 && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        {imp.preview.ignored_columns.length} column{imp.preview.ignored_columns.length > 1 ? "s" : ""} will be IGNORED — their values are not imported: {imp.preview.ignored_columns.join(" · ")}
                      </div>
                    )}
                    {/* 15/08 (Umesh): unknown columns accepted by default, stored per trainer. */}
                    {(imp.preview.unknown_columns?.length ?? 0) > 0 && (
                      <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                        <div className="font-medium">New columns the ERP doesn&apos;t know: {imp.preview.unknown_columns.join(" · ")}</div>
                        <label className="mt-1 flex items-center gap-2">
                          <input type="checkbox" checked={imp.accept_unknown !== false}
                            onChange={(e) => setImp({ ...imp, accept_unknown: e.target.checked })} />
                          Accept as new columns — their values are stored and shown on each trainer
                        </label>
                        <div className="mt-0.5 text-blue-700">Or map them to an existing field above; unticked = ignored.</div>
                      </div>
                    )}
                    {["stage_unmatched", "centre_unmatched", "role_unmatched"].map((k) => (imp.preview[k]?.length ?? 0) > 0 && (
                      <p key={k} className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        {k === "stage_unmatched" ? "Stages" : k === "centre_unmatched" ? "Centres" : "Job roles"} not recognised (left blank): {imp.preview[k].join(" · ")}
                      </p>
                    ))}
                    {(imp.preview.warnings?.length ?? 0) > 0 && (
                      <ul className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        {imp.preview.warnings.map((w: string, i: number) => <li key={i}>• {w}</li>)}
                      </ul>
                    )}
                    {(imp.preview.duplicate_count ?? 0) > 0 && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                        <div className="font-medium">{imp.preview.duplicate_count} duplicate{imp.preview.duplicate_count > 1 ? "s" : ""} — skipped on import (a trainer's phone is unique)</div>
                        <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">{imp.preview.duplicates.map((d: string, i: number) => <li key={i}>• {d}</li>)}</ul>
                      </div>
                    )}
                  </div>
                )}
                {imp.done && <p className="text-sm font-medium text-green-700">✓ {imp.done.imported} trainers imported.</p>}
              </>
            )}
          </div>
        )}
      </Drawer>
      <Drawer open={!!invite} onClose={() => setInvite(null)} title="Quick add trainer — send them the form">
        {invite && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">
              Enter a name and phone number — an application link is generated for you to send over
              WhatsApp/SMS. The trainer fills in their own qualification, experience and skills;
              the profile enters the pipeline at "Fresh Lead". The link is single-use.
            </p>
            <Field label="Full name" required><input className={inputCls} value={invite.form.name ?? ""} onChange={(e) => setInvite({ ...invite, form: { ...invite.form, name: e.target.value } })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Phone (10 digit)" required>
                <input className={inputCls} inputMode="numeric" value={invite.form.phone ?? ""} onChange={(e) => setInvite({ ...invite, form: { ...invite.form, phone: e.target.value } })} />
                {invite.form.phone && phoneError(invite.form.phone) && <p className="mt-1 text-xs text-red-600">{phoneError(invite.form.phone)}</p>}
              </Field>
              <Field label="Email">
                <input className={inputCls} type="email" value={invite.form.email ?? ""} onChange={(e) => setInvite({ ...invite, form: { ...invite.form, email: e.target.value } })} />
                {invite.form.email && emailError(invite.form.email, { optional: true }) && <p className="mt-1 text-xs text-red-600">{emailError(invite.form.email, { optional: true })}</p>}
              </Field>
            </div>
            {invite.link ? (
              <ShareLinkPanel label="Application link" link={invite.link}
                hint="Single-use — the link stops working the moment the trainer submits the form. To send it again, generate a new link."
                onDismiss={() => { setInvite(null); load(); }} />
            ) : (
              <Btn disabled={savingT || !invite.form.name || !(invite.form.phone ?? "").trim() || !!phoneError(invite.form.phone) || !!emailError(invite.form.email, { optional: true })} onClick={async () => {
                if (savingT) return;
                setSavingT(true);
                try {
                  const d = await api("/api/trainers/quick-invite", { method: "POST", json: invite.form });
                  setInvite({ ...invite, link: `${window.location.origin}${BASE_PATH}${d.item.link}` });
                } catch (e: any) { setError(e.message); }
                setSavingT(false);
              }}>{savingT ? "Creating…" : "Create link"}</Btn>
            )}
          </div>
        )}
      </Drawer>

      <Drawer open={drawer} onClose={() => setDrawer(false)} title={edit ? `Edit ${edit.name}` : "Add Trainer"}>
        <div className="space-y-3">
          <Field label="Name" required><input className={inputCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            {/* QA-141: same checks the API refuses with — shown while typing, not on save. */}
            <Field label="Phone" required>
              <input className={inputCls} value={form.phone ?? ""} onChange={(e) => set("phone", e.target.value)} />
              {form.phone && phoneError(form.phone) && <p className="mt-1 text-xs text-red-600">{phoneError(form.phone)}</p>}
            </Field>
            <Field label="Email">
              <input className={inputCls} value={form.email ?? ""} onChange={(e) => set("email", e.target.value)} />
              {form.email && emailError(form.email, { optional: true }) && <p className="mt-1 text-xs text-red-600">{emailError(form.email, { optional: true })}</p>}
            </Field>
          </div>
          {/* QA-133: skills no longer gate any dropdown — free text is honest labelling now.
              QA-029 (-69): but a JOB ROLE among them is what the Preparation board and the
              batch dropdown count by — suggest from the master, warn on zero matches. */}
          <Field label="Skills (comma-separated — include the job role)" required>
            <input className={inputCls} list="job-role-suggestions" value={Array.isArray(form.skills) ? form.skills.join(", ") : form.skills ?? ""} onChange={(e) => set("skills", e.target.value)} />
            <datalist id="job-role-suggestions">
              {knownRoles.map((k) => <option key={k} value={k} />)}
            </datalist>
            {roleMismatch(typeof form.skills === "string" ? form.skills.split(",").map((s: string) => s.trim()).filter(Boolean) : form.skills) && (
              <p className="mt-1 text-xs font-medium text-amber-700">
                ⚠ None of these match a recognised job role — the Preparation board and the batch
                form count trainers by job role, so this trainer will not appear there.
              </p>
            )}
          </Field>
          <Field label="Home location">
            <select className={inputCls} value={form.home_location ?? ""} onChange={(e) => set("home_location", e.target.value)}>
              <option value="">—</option>
              {locations.map((l) => <option key={l._id} value={l._id} title={l.name}>{l.name}</option>)}
              {/* 2026-08-13 (Manish): a trainer's home town is usually not one of our centres */}
              <option value="__other__">Other…</option>
            </select>
            {form.home_location === "__other__" && (
              <input className={inputCls + " mt-1.5"} placeholder="Type the trainer's home town/city"
                value={form.home_location_other ?? ""} onChange={(e) => set("home_location_other", e.target.value)} />
            )}
          </Field>
          {/* 2026-08-13 parity: qualification/experience/source were sheet-only (display-only in
              the app) — TVP eligibility hangs on them, so they are typeable now. */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Qualification"><input className={inputCls} value={form.qualification ?? ""} onChange={(e) => set("qualification", e.target.value)} /></Field>
            <Field label="Where the CV came from"><input className={inputCls} placeholder="LinkedIn / Naukri / reference…" value={form.source ?? ""} onChange={(e) => set("source", e.target.value)} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Industry experience (yrs)"><input type="number" className={inputCls} value={form.industry_experience_years ?? ""} onChange={(e) => set("industry_experience_years", e.target.value === "" ? undefined : +e.target.value)} /></Field>
            <Field label="Teaching experience (yrs)"><input type="number" className={inputCls} value={form.teaching_experience_years ?? ""} onChange={(e) => set("teaching_experience_years", e.target.value === "" ? undefined : +e.target.value)} /></Field>
          </div>
          {/* 2026-08-12: the real journey (Manish) — CV → docs → nomination → NSDC → ₹3250 → TOT →
              TR ID. The stage is shown here for reference but is MOVED BY the transition endpoint,
              which enforces the order and the preconditions; setting it freely from a dropdown
              would let someone skip the document and nomination gates entirely. */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Hiring stage">
              <input className={inputCls + " bg-gray-50"} value={form.pipeline_status ?? "Fresh Lead"} readOnly
                title="Move a trainer along the pipeline from their detail page" />
            </Field>
            <Field label="TR ID (NSDC, after TOT)"><input className={inputCls} value={form.tr_id ?? ""} onChange={(e) => set("tr_id", e.target.value)} /></Field>
          </div>
          <Field label="Can train at (2026-08-11: one, two or ten locations)">
            <select multiple className={inputCls + " h-28"} value={form.capable_locations ?? []}
              onChange={(e) => set("capable_locations", Array.from(e.target.selectedOptions).map((o) => o.value))}>
              {locations.map((l) => <option key={l._id} value={l._id} title={l.name}>{l.name}</option>)}
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
              {/* F-B1 (Manish): the model always knew all four — the dropdown offered two. */}
              <select className={inputCls} value={form.compensation_type ?? ""} onChange={(e) => set("compensation_type", e.target.value)}>
                <option value="">—</option><option>Batch-wise</option><option>Monthly</option><option>Fixed</option><option>Incentive-based</option>
              </select>
            </Field>
            <Field label={`Fixed amount (₹${form.compensation_type === "Monthly" ? "/month" : form.compensation_type === "Batch-wise" ? "/batch" : form.compensation_type === "Fixed" ? " flat" : ""})`}>
              <input type="number" className={inputCls} value={form.compensation_fixed ?? ""} onChange={(e) => set("compensation_fixed", +e.target.value)} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Day rate (₹)"><input type="number" className={inputCls} value={form.day_rate ?? ""} onChange={(e) => set("day_rate", +e.target.value)} /></Field>
            <Field label="Max concurrent batches"><input type="number" className={inputCls} value={form.max_concurrent_batches ?? 4} onChange={(e) => set("max_concurrent_batches", +e.target.value)} /></Field>
          </div>
          <Field label="Performance incentive note"><input className={inputCls} placeholder="e.g. ₹500/batch completion bonus" value={form.incentive_note ?? ""} onChange={(e) => set("incentive_note", e.target.value)} /></Field>
          <Btn onClick={save} disabled={savingT || !form.name || !form.phone || !!phoneError(form.phone) || !!emailError(form.email, { optional: true })}>{savingT ? "Saving…" : edit ? "Save changes" : "Add Trainer"}</Btn>
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
