"use client";
import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { api, fmtDate, istTodayInput, toInputDate } from "@/lib/client";
import { personLabel, personList, personSeparator } from "@/lib/person";
// -212 (QA-728): the shared portal-CAN helpers, from the PURE module. They used to live only in
// lib/govt-attendance, which imports the mongoose models, so this screen could not reach them and
// grew its own inline copy of the regex instead - the fifth spelling of one concept.
import { normalizeCan, storedCanIsUnreadable, apaarError, storedApaarIsUnreadable } from "@/lib/validate";
// QA-1198: the settled-certificate predicate, from the PURE module — this screen cannot reach
// rules.ts (mongoose), which is exactly why the definition lives in lib/candidate-journey.ts.
import { activeOnly, hasLeft, hasRecordedResult, isCertificateSettled, showsAfterLeaving } from "@/lib/candidate-journey";
import { trainerSelectGroups } from "@/lib/trainer-select";
import { slotGuidelineErrors, slotHoursPerDay } from "@/lib/slot-rules";
import { BackLink, Btn, Chip, CopyBtn, DataTable, Drawer, ErrorBanner, Field, FilterPills, HealthBanner, NameCell, Notice, Section, ShareLinkPanel, Tabs, inputCls, statusLabel } from "@/components/ui";
import { Activity } from "@/components/activity";
import { usePerms } from "@/components/shell";
import { compressImage, flushQueue, fmtBytes, getLastUploadInfo, getQueue, pickRecorderMime, uploadWithRetry, videoKnobs, type VideoKnobs } from "@/lib/upload";
import { BASE_PATH } from "@/lib/base-path";
import { bulkSmsCsv, smsLink, waLink } from "@/lib/messaging";

const TABS = ["Overview", "Candidates", "Enrollment", "Daily Execution", "Attendance", "Closure", "Feedback", "Costs", "Activity"];

// -159 cycle 2 (QA-481): the definition moved to @/lib/client, because writing it here made it the
// THIRD copy in src/ - in the release whose entire point was collapsing copies of this same rule.

export default function BatchDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const sp = useSearchParams();
  // 2026-08-13 (Umesh role matrix): the tabs a login cannot use are not shown to it —
  // Costs is finance-only (a Location user only ever got a 403 banner from it), and the
  // server remains the real gate either way.
  const { data: session } = useSession();
  const role = (session?.user as any)?.role;
  // 2026-08-24 (QA-904): the empty-shell delete follows `batches.delete` rather than the Admin role.
  const { can: canRightB, loaded: rightsLoadedB } = usePerms();
  const canDeleteBatch = rightsLoadedB && canRightB("batches.delete", "edit");
  // R-E (CEO 14/08): Operations is post-only on money — the batch cost ledger is Admin's.
  const tabs = TABS.filter((t) => t !== "Costs" || role === "Admin");
  const [tab, setTab] = useState(sp.get("tab") && TABS.includes(sp.get("tab")!) ? sp.get("tab")! : "Overview");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  // -86 (Umesh 15/08 22:55): the health and no-students banners get a ✕. A dismissal lasts
  // for THIS session, per batch (and per score for health — a Red that turns Amber shows
  // again). The 14/08 "not dismissible on purpose" is superseded by this ruling.
  const [dismissTick, setDismissTick] = useState(0);
  const dismissed = (key: string) => { try { return typeof window !== "undefined" && sessionStorage.getItem(key) === "1"; } catch { return false; } };
  const dismiss = (key: string) => { try { sessionStorage.setItem(key, "1"); } catch {} setDismissTick((t) => t + 1); };
  const undismiss = (key: string) => { try { sessionStorage.removeItem(key); } catch {} setDismissTick((t) => t + 1); };

  const load = () => api(`/api/batches/${id}`).then(setData).catch((e) => setError(e.message));
  // -88 (Umesh): a Planning/Ready batch that already has attendance evidence is running —
  // ask the server to let the status catch up (idempotent), then show the truth.
  const [reconciled, setReconciled] = useState(false);
  useEffect(() => {
    const b = data?.item;
    if (!b || reconciled || !["Planning", "Ready"].includes(b.status)) return;
    api(`/api/batches/${id}/attendance`).then((att) => {
      const evidence = (att?.days_held ?? 0) > 0 || (att?.members ?? []).some((m: any) => m.govt);
      if (!evidence) return;
      setReconciled(true);
      api(`/api/batches/${id}/reconcile-status`, { method: "POST", json: {} }).then((r) => { if (r?.activated) load(); }).catch(() => {});
    }).catch(() => {});
  }, [data?.item?._id, data?.item?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [id]);

  if (!data) return <div className="p-8 text-center text-gray-400">{error || "Loading…"}</div>;
  const b = data.item;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <BackLink fallback="/batches" label="Batches" />
        <h1 className="text-xl font-semibold">{b.code}</h1>
        <Chip value={b.status} />
        {data.settlement_stage && (
          <span className="rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[11px] font-medium text-violet-700" title="Where this batch stands on the money chain">
            {data.settlement_stage}
          </span>
        )}
        <span className="text-sm text-gray-500">
          {/* R-K: the programme name in the header opens its detail page. */}
          {b.program ? <Link className="text-blue-700 hover:underline" href={`/programs/${b.program._id}`}>{b.program.name}</Link> : "—"}
          {" "}· {fmtDate(b.planned_start)} → {fmtDate(b.planned_end)}
        </span>
      </div>
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      {/* 2026-08-14 (Umesh): a batch with nobody on it is not a batch — either its students
          get uploaded or the empty shell gets deleted. -86 (Umesh 15/08): dismissible with a
          ✕ for the session — it collapses to a one-line chip so Add/Import stay one click away. */}
      {(data.readiness?.roster_count ?? 0) === 0 && !["Cancelled"].includes(b.status) && dismissed(`erp_dismiss_roster_${id}`) && (
        <button data-tick={dismissTick} onClick={() => undismiss(`erp_dismiss_roster_${id}`)}
          className="w-fit rounded-full border border-red-200 bg-red-50 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100">
          No students yet · show
        </button>
      )}
      {(data.readiness?.roster_count ?? 0) === 0 && !["Cancelled"].includes(b.status) && !dismissed(`erp_dismiss_roster_${id}`) && (
        <div className="relative rounded-xl border-2 border-red-300 bg-red-50 p-4" data-tick={dismissTick}>
          <button aria-label="Dismiss" title="Hide for now" onClick={() => dismiss(`erp_dismiss_roster_${id}`)}
            className="absolute right-2 top-2 rounded px-1.5 text-lg leading-none text-red-400 hover:text-red-700">×</button>
          <div className="text-sm font-semibold text-red-800">This batch has no students yet — upload the roster</div>
          <p className="mt-1 text-sm text-red-700">
            {b.status === "Completed" || b.status === "Closing"
              ? "It is marked " + b.status + " with an empty roster, so its attendance, results and billing are all reading zero."
              : "Readiness, attendance and every count on the dashboard stay wrong until the students are on it."}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Btn small onClick={() => setTab("Candidates")}>Add students to this batch</Btn>
            {/* QA-896 (Umesh 24/08: "iss batch wale mai bulk sheet upload ... kaam nhi krr rha hai
                properly"). This was a bare `<Link href="/candidates">`. It carried NOTHING — not the
                batch, not the centre, not the programme — so the button on a banner that says "this
                batch has no students" dropped the operator on a generic page where they had to
                re-pick the centre and job role the batch already knew, and the batch stayed empty
                afterwards because the importer only fills the pool. Four steps, two of which the
                system could already answer. It now carries all three. */}
            <Link href={`/candidates?import=1&batch=${b._id}${b.location?._id ? `&location=${b.location._id}` : ""}${b.program?._id ? `&program=${b.program._id}` : ""}`}>
              <Btn small kind="ghost">Import candidates (Excel)</Btn>
            </Link>
            {/* 2026-08-24 (Umesh): "vo bhi respective acess wale persons". The gate was a hard-coded
                        role test, so the verb was invisible to the team who needed it. It follows the
                        togglable right now, and the SERVER refuses independently - this only decides
                        whether somebody is shown a button they would be allowed to press. */}
            {canDeleteBatch && (
              <Btn small kind="danger" onClick={async () => {
                if (!confirm(`Delete ${b.code}? This is only allowed while the batch carries no members, results, costs, logs or attendance.`)) return;
                try {
                  await api(`/api/batches/${id}`, { method: "DELETE" });
                  window.location.href = `${BASE_PATH}/batches`;
                } catch (e: any) { setError(e.message); }
              }}>Delete this empty batch</Btn>
            )}
          </div>
        </div>
      )}
      {!dismissed(`erp_dismiss_health_${id}_${data.health?.score}`) && (
        <HealthBanner health={data.health} onDismiss={() => dismiss(`erp_dismiss_health_${id}_${data.health?.score}`)} />
      )}
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      {tab === "Overview" && <Overview data={data} role={role} onChanged={load} error={error} setError={setError} onGo={setTab} />}
      {tab === "Candidates" && <Roster batchId={id} batch={b} error={error} setError={setError} onChanged={load} />}
      {tab === "Enrollment" && <Enrollment batchId={id} error={error} setError={setError} />}
      {tab === "Daily Execution" && <DailyExecution batchId={id} batch={b} role={role} error={error} setError={setError} />}
      {tab === "Attendance" && <AttendanceTab batchId={id} batch={data.item} role={role} error={error} setError={setError} onGo={setTab} />}
      {tab === "Closure" && <ClosureTab batchId={id} batch={b} role={role} error={error} setError={setError} onChanged={load} />}
      {tab === "Feedback" && <FeedbackTab batchId={id} error={error} setError={setError} />}
      {tab === "Costs" && role === "Admin" && <CostsTab batchId={id} batch={b} error={error} setError={setError} />}
      {tab === "Activity" && <Activity entity="Batch" id={id} />}
    </div>
  );
}

// ---------- Overview: readiness checklist (Rule 16) + transitions ----------
// -134 (QA-284): onGo is the page's own setTab — the quick actions move between tabs that already
// exist rather than duplicating any screen.
function Overview({ data, role, onChanged, error, setError, onGo }: any) {
  const b = data.item;
  // QA-798 (sweep, Umesh 2026-08-25: "go for 2"). Every control below that changes the batch —
  // Mark Ready, Start, Record start date, back to Planning, Assessment done, Close, Cancel, and
  // the room picker — decided its own enabled state from `b.status` alone, while BOTH servers
  // behind them ask a permission: `transition/route.ts:requirePerm(user,"batches.manage")` and
  // `[id]/route.ts:75` the same for the PATCH the room picker sends. So a principal without that
  // right saw every one of them ENABLED and got a 403 on press — the dead-control class, whose
  // sixth outing on this same screen was found by a checker on 2026-08-25.
  //
  // Deliberately the SAME shape as `mayMark` (:3027) and `mayMarkTab` (:2652), not a third
  // spelling: permissive while the rights are still loading, so nothing flickers disabled on a
  // slow fetch, and `.status` keeps its own meaning beside it rather than absorbing this one.
  // The two questions stay named apart — "is this batch AT that stage?" and "may THIS PERSON move
  // it?" — because collapsing them is exactly what QA-785 cost, one tab over.
  const { can: canBatchOv, loaded: batchPermsOv } = usePerms();
  // -88 (Umesh): once a batch runs, the Overview says so in numbers — running since when,
  // day N of M, our logged days, the portal's working days, who is qualified — instead of a
  // readiness checklist for a batch that already started.
  const [att, setAtt] = useState<any>(null);
  // QA-750 (-214, Umesh 23/08): "isme new information bhi aani chahiye jaise out of 23 kitne qualify
  // hue the and kitne certified ho gaye and all, like kitne pass kitne fail." The numbers already
  // exist - `summarizeResults` computes appeared/passed/failed/absent/certificates_issued and
  // GET /results returns them as `summary`. No new API, just the fetch this screen never made.
  const [resSummary, setResSummary] = useState<any>(null);
  useEffect(() => {
    if (!["Active", "Closing", "Completed", "Closed"].includes(b.status)) { setAtt(null); return; }
    api(`/api/batches/${b._id}/attendance`).then(setAtt).catch(() => setAtt(null));
    api(`/api/batches/${b._id}/results`).then((d) => setResSummary(d.summary ?? null)).catch(() => setResSummary(null));
  }, [b._id, b.status]);
  const running = ["Active", "Closing", "Completed", "Closed"].includes(b.status);
  const dayN = b.actual_start ? Math.max(1, Math.floor((Date.now() - new Date(b.actual_start).getTime()) / 864e5) + 1) : null;
  const dayM = b.program?.duration_days ?? (b.planned_start && b.planned_end ? Math.round((new Date(b.planned_end).getTime() - new Date(b.planned_start).getTime()) / 864e5) + 1 : null);
  const withPortal = (att?.members ?? []).filter((m: any) => m.govt);
  const portalDays = withPortal.length ? Math.max(0, ...withPortal.map((m: any) => Number(m.govt?.working_days ?? 0))) : 0;
  // Umesh role matrix: "no batch edit" for principal/SPOC — the server 403s regardless
  // (batches.manage removed from the Location role); the buttons simply are not offered.
  // QA-798: this WAS `role !== "Location" && role !== "Trainer" && role !== "Enrollment"` — a
  // blacklist of three role NAMES, standing in for a permission the server actually asks by name.
  // It is wrong in both directions, and the permission matrix is editable from inside the product,
  // so both are reachable without touching code:
  //   - grant `batches.manage` to Location, and the screen HIDES controls that principal may use;
  //   - revoke it from Operations, and the screen SHOWS controls that 403 on press.
  // The second is the dead-control class this screen has now produced six times.
  // Replaced IN PLACE rather than gated a second time beside — a second spelling of "who may move
  // this batch" is precisely what ARCHITECTURE.md section 3 is a list of.
  // `canAssignRoom` (:452) already derives from this, and the room picker's PATCH lands on
  // `api/batches/[id]/route.ts:75`, which asks the same `batches.manage`. One term, both doors.
  const canTransition = !batchPermsOv || canBatchOv("batches.manage", "edit");
  const r = data.readiness;
  const [reason, setReason] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  // -113 (Umesh 18/08: "admin ke paas mark completed ka button aaye, aur wo press kar paye"). The
  // ordinary buttons refuse until the ROWS allow it — Rule 43 wants every student marked, Rule 46
  // every pass settled — and on a batch that finished months ago nobody can satisfy that by hand.
  // The Admin door settles the outstanding rows the honest way (no result = Absent, no certificate =
  // Not Issued), under one typed reason, audited per row. This panel says exactly what it will do
  // BEFORE it is pressed; nothing here is silent.
  const [completePlan, setCompletePlan] = useState<any>(null);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [completeReason, setCompleteReason] = useState("");
  const [completing, setCompleting] = useState(false);
  const isAdmin = role === "Admin";
  useEffect(() => {
    // -205: the `isAdmin` guard was here because only the Admin panel read this payload. The caption
    // above reads it too now, and Operations and the centre look at that caption — with the guard in
    // place they would have read "Checking what is still outstanding…" for ever. The endpoint has its
    // own gate (`batches.manage`); a caller without it gets a refusal and the state stays null,
    // which is the same as before for them.
    if (!["Active", "Closing"].includes(b.status)) { setCompletePlan(null); return; }
    api(`/api/batches/${b._id}/complete`).then(setCompletePlan).catch(() => setCompletePlan(null));
  }, [b._id, b.status, isAdmin]);
  // QA-708 (-209): the ordinary completion, for the roles the server already allows. It goes through
  // /transition, which enforces Rule 18 and RPL M24s approval matrix - so a batch with anything still
  // open is refused THERE, by the rule, rather than by a sentence this screen invented. -207 had
  // disabled the only control Operations had and written "Completing a batch is an Admin action"
  // beside it, which the server contradicts: POST /transition {target:"Completed"} succeeds for them
  // today. Only the FORCE door is Admin-only.
  async function completeOrdinary() {
    if (!completeReason.trim()) { setError("Say why this batch is being completed - it is recorded on the batch."); return; }
    setCompleting(true); setError("");
    try {
      await transition("Completed", { reason: completeReason.trim() });
      setCompleteOpen(false); setCompleteReason("");
    } catch (e: any) { setError(e?.message ?? String(e)); onChanged(); }
    finally { setCompleting(false); }
  }

  async function completeAsAdmin() {
    if (!completeReason.trim()) { setError("Say why this batch is being completed — it is recorded against every row it settles."); return; }
    setCompleting(true);
    try {
      // -206: `force` is what makes this the SECOND press. The door refuses a bare press whenever
      // anything is open and writes nothing (QA-697) — the panel the user is looking at IS the first
      // press, and it listed every one of those things with a way to go and fix it. Pressing here is
      // the deliberate one.
      const res = await api(`/api/batches/${b._id}/complete`, { method: "POST", json: { reason: completeReason.trim(), force: true } });
      setCompleteOpen(false); setCompleteReason("");
      onChanged();
      if (res?.settled) setError("");
    } catch (e: any) {
      // QA-697: a refused press used to leave the screen showing the state from before it, because
      // nothing reloaded on the error path. That is the same shape as QA-686 on the trainer card,
      // fixed in -204 and repeated here. Reload whatever the refusal did or did not do, so what is
      // on screen is what is in the database.
      setError(e.message);
      onChanged();
    }
    finally { setCompleting(false); }
  }
  // QA-004 (checker): "Close Batch" was an enabled primary button on batches that provably
  // cannot close — the click just bounced off Rule 52. The button now knows the rule too.
  const [money, setMoney] = useState<any>(null);
  useEffect(() => {
    if (b.status !== "Completed") { setMoney(null); return; }
    api(`/api/batches/${b._id}/closure`).then((d) => setMoney({ closure: d.closure, invoice: d.invoice })).catch(() => setMoney(null));
  }, [b._id, b.status]);
  const closeBlockers: string[] = b.status !== "Completed" ? [] : [
    ...(money?.closure?.certification_status !== "Completed" ? ["certification not completed"] : []),
    ...(money?.invoice?.status !== "Paid" ? [`invoice ${money?.invoice?.status ?? "not raised"} — must be PAID`] : []),
    ...(!money?.closure?.dues_settled ? ["dues not attested as settled"] : []),
  ];

  async function transition(target: string, extra: Record<string, unknown> = {}) {
    try {
      await api(`/api/batches/${b._id}/transition`, { method: "POST", json: { target, reason, ...extra } });
      setConfirmCancel(false); setReason(""); onChanged();
    } catch (e: any) { setError(e.message); }
  }

  // -81 (Umesh, 15/08 — Gurugram DST-02 began 30-07, entered 15-08): a batch whose planned
  // start has passed is being entered after the fact; Start must carry the REAL date or
  // actual_start is stamped "today" forever (it is not editable afterwards).
  const plannedStartKey = b.planned_start ? String(b.planned_start).slice(0, 10) : "";
  const todayKey = istTodayInput(); // IST calendar day
  const beganAlready = !!plannedStartKey && plannedStartKey < todayKey && ["Planning", "Ready"].includes(b.status);
  const [startDate, setStartDate] = useState<string>(plannedStartKey);
  // -226 (Umesh, 24/08): recording a batch that already ran skips the readiness gates, so it opens a
  // confirmation rather than firing on the press - the -207 ruling ("vo double confirmation pop up
  // card khule properly"), and the same Drawer primitive, because a second overlay would be the
  // drift ARCHITECTURE.md section 3 catalogues.
  const [backdateOpen, setBackdateOpen] = useState(false);
  const [backdateReason, setBackdateReason] = useState("");
  const [backdating, setBackdating] = useState(false);
  async function recordBackdatedStart() {
    if (!startDate) return;
    setBackdating(true);
    try {
      // `extra` is spread last inside transition(), so this reason wins over the page-level one.
      await transition("Active", { actual_start: startDate, backdate_override: true, reason: backdateReason.trim() || undefined });
      setBackdateOpen(false); setBackdateReason("");
    } catch (e: any) { setError(e.message); onChanged(); }
    finally { setBackdating(false); }
  }

  // -235 (Umesh, 24/08, on MUZ-CHAR-RPLHSL-SPIT-01): "Money Sir ne galti se cancel mark kar diya hai."
  // Cancel was a one-way door in BOTH halves — rules.ts had no `Cancelled->` arm, and this screen
  // renders no status control at all on a cancelled batch, so a mis-click on a live batch carrying 33
  // students left nothing on screen to undo it with. The confirmation opens in the same Drawer primitive
  // as the two below it (the -207 ruling); the window.prompt on the Reopen control is the older pattern
  // and is deliberately left alone rather than half-migrated inside an unrelated unit.
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState("Planning");
  const [restoreReason, setRestoreReason] = useState("");
  const [restoring, setRestoring] = useState(false);
  // qa-234's ruling applied here: an option that cannot work is GREYED WITH ITS REASON, never removed —
  // a picker that silently omits a choice cannot tell you why it is missing. These strings only EXPLAIN
  // what the server will say; the server stays the decider. A client gate that tries to BE the decision
  // is the QA-733/QA-798 class, and this file is where that class lives.
  const restoreBlocked: Record<string, string | null> = {
    Planning: null,
    Ready: r.ready ? null : "readiness checks are not met",
    Active: b.actual_start ? null : "this batch never started",
  };
  async function restoreBatch() {
    const why = restoreReason.trim();
    if (!why || restoreBlocked[restoreTarget]) return;
    setRestoring(true);
    try {
      // Not routed through transition() on purpose: that helper SWALLOWS the failure (:256) and its
      // callers then close their drawer regardless, so a refusal would take itself off screen along with
      // the control that caused it. Here the refusal — Admin-only, readiness, "never started" — IS the
      // point of the confirmation, so it stays up and the drawer only closes on success.
      await api(`/api/batches/${b._id}/transition`, { method: "POST", json: { target: restoreTarget, reason: why } });
      setRestoreOpen(false); setRestoreReason(""); onChanged();
    } catch (e: any) { setError(e.message); }
    finally { setRestoring(false); }
  }

  // QA-150 (Umesh, 15/08): the checklist renders EXACTLY the checks that gate Mark Ready —
  // rules.batchReadiness().checks, in its order — and counts only those. It used to list
  // four of five and add a row that was not a check at all, so the header said "5/5" while
  // the banner said "Not ready" for a check that never appeared on screen. The failing
  // label is the same wording the health banner uses (READINESS_FAILURE_TEXT).
  const CHECK_LABEL: Record<string, string> = {
    location_approved: "Location approved",
    room_assigned: "Room assigned (Lab if required)",
    trainer_ready: "Trainer assigned & available",
    roster_80pct: `Roster ≥ 80% of target (${r.roster_count}/${b.target_size})`,
  };
  const CHECK_FAIL: Record<string, string> = {
    location_approved: "centre not approved / not operational",
    room_assigned: "room not assigned",
    trainer_ready: "trainer not ready",
    roster_80pct: "roster below threshold",
  };
  const CHECKS: [string, string, boolean][] = Object.entries(r.checks as Record<string, boolean>).map(([k, ok]) => [
    k,
    ok ? (CHECK_LABEL[k] ?? k.replace(/_/g, " ")) : `${CHECK_LABEL[k] ?? k.replace(/_/g, " ")} — ${CHECK_FAIL[k] ?? "not met"}`,
    ok,
  ]);

  // QA-147 (Manish): "room assign karne ka kahin koi option hi nahi aa raha." Rooms are
  // per-centre already (his own requirement) — CHI-ITI simply had none, so the New Batch
  // dropdown was empty and nothing on this page offered a way in. The failing check now
  // carries the path: pick one of the centre's rooms, or add one right here.
  const locId = String(b.location?._id ?? b.location ?? "");
  const [rooms, setRooms] = useState<any[] | null>(null);
  const [roomPick, setRoomPick] = useState("");
  const [newRoom, setNewRoom] = useState<{ name: string; type: string } | null>(null);
  const [roomBusy, setRoomBusy] = useState(false);
  // -205 (Umesh, 23/08): "overview mai jo Complete Batch button hai, that must be come beside
  // these above buttons in the same card, not anywhere else. am i really clear ?" He is clear.
  // -204 put these controls back on the screen by lifting them out of the collapsed readiness
  // ternary, which fixed the S1 - but it left them as their own row, and he wants them IN the
  // "Right now" card, beside Attendance / Daily log / Roster / Certificates. So the row is ONE
  // value declared here and rendered in both places the batch can be in: inside that card while
  // it is running, and inside the readiness Section before it starts. One copy, two homes - a
  // second literal would be the drift this repo's ARCHITECTURE.md section 3 is a list of.
  const statusActions = canTransition ? (
    <>
      {b.status === "Planning" && <Btn small onClick={() => transition("Ready")} disabled={!r.ready}>Mark Ready</Btn>}
      {b.status === "Ready" && !beganAlready && <Btn small onClick={() => transition("Active")}>Start Batch</Btn>}
      {/* -226 (Umesh, 24/08, stuck on MUZ-CHAR-RPLHSL-SPIT-01): this used to be `b.status === "Ready"
          && beganAlready`, while the banner that NAMES it renders on Planning too. So on a batch
          entered after it began - which is always in Planning, because Mark Ready is disabled by a
          roster check that a months-old batch can never satisfy - the screen said "When you Start it,
          set the real start date" and there was no such button anywhere on the page. `beganAlready`
          already covers Planning and Ready both; the banner and the control now agree. */}
      {beganAlready && (
        <span className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1">
          <label className="text-xs text-amber-800">Batch already began on</label>
          <input type="date" className="rounded-lg border border-gray-300 px-2 py-1 text-xs" value={startDate} max={todayKey} onChange={(e) => setStartDate(e.target.value)} />
          <Btn small onClick={() => setBackdateOpen(true)} disabled={!startDate || backdating}>Record start from that date</Btn>
        </span>
      )}
      {b.status === "Ready" && <Btn small kind="ghost" onClick={() => transition("Planning")}>Back to Planning</Btn>}
      {/* -102: the client's words for these two steps. Targets stay the stored enum. */}
      {b.status === "Active" && <Btn small onClick={() => transition("Closing")}>Assessment done → Result Awaited</Btn>}
      {/* -207 (Umesh, 23/08, with the screen open): "2 duplicate buttons fro similar functionlity
          ?? essaa kyu hai , worst user experiece. only ye blue wala Complete batch button rakho and
          put it in the same row of attendance and all. along with same ui and ye button mai vo
          double confirmation pop up card khule properly."

          Two doors to one room: "Mark Completed (Admin)" toggled a panel far down the page, and
          "Complete Batch" fired a transition straight off. ONE control now, and it opens the
          confirmation - which is what makes the two-step real rather than a label. It renders for
          Active and Closing both, so an Admin never has to walk a finished batch through an extra
          status first. The caption that used to hang under the old button moved into the
          confirmation, where the decision is actually made. */}
      {/* QA-723 (-211, checker on qa-209): -207 offered this for Active and Closing, and -209 made it
          pressable by a non-Admin. There is no Active -> Completed arm in transitionBatch at all -
          the only one is Closing -> Completed - so for a non-Admin on an Active batch every press
          could only 409, and on a clean Active batch nothing even rendered to say why. I fixed a
          dead button in -209 and shipped another one in the same release.
          The Admin's force door walks Active -> Closing -> Completed itself, so it is honest on both.
          A non-Admin gets it only where their door exists. */}
      {(isAdmin ? ["Active", "Closing"] : ["Closing"]).includes(b.status) && (
        <Btn small onClick={() => setCompleteOpen(true)}>Complete Batch</Btn>
      )}
      {/* -113: completing is one press now, so it needs an undo. Admin only, reason required,
          audited — and never offered on a CLOSED batch, which is a settlement, not a record. */}
      {isAdmin && b.status === "Completed" && (
        <Btn small kind="ghost" onClick={() => {
          const why = window.prompt("Reopen this completed batch? Results and certificates become editable again. Reason:");
          if (why && why.trim()) transition("Closing", { reason: why.trim() });
        }}>Reopen (Admin)</Btn>
      )}
      {/* Rule 52: Completed = training over; Closed = money over (cert + invoice PAID + no dues). */}
      {b.status === "Completed" && (
        <span title={closeBlockers.length ? `Still needed before the batch can close: ${closeBlockers.join("; ")}` : "All dues settled — the batch can close"} className="inline-flex flex-col gap-0.5">
          <Btn small onClick={() => transition("Closed")} disabled={money !== null && closeBlockers.length > 0}>Close Batch (no dues)</Btn>
          {money !== null && closeBlockers.length > 0 && (
            <span className="text-[10px] font-medium text-amber-700">needs: {closeBlockers.join(" · ")}</span>
          )}
        </span>
      )}
      {["Planning", "Ready", "Active"].includes(b.status) && <Btn small kind="danger" onClick={() => setConfirmCancel(true)}>Cancel Batch</Btn>}
      {/* -235: the way back out of Cancelled. Offered only to an Admin, because only an Admin can do it
          (rules.ts) — a control that could do nothing but 409 for the person looking at it is exactly the
          dead button QA-723 charged. Everyone else who can move status gets the sentence instead, because
          a cancelled batch used to show a completely blank row and there was no way to learn why. */}
      {b.status === "Cancelled" && (isAdmin
        ? <Btn small onClick={() => setRestoreOpen(true)}>Restore batch</Btn>
        : <span className="text-xs text-gray-500">This batch is cancelled. Only an Admin can restore it.</span>)}
    </>
  ) : (
    <span className="text-xs text-gray-400">Batch status is moved by Operations/Admin.</span>
  );

  const canAssignRoom = canTransition && !r.checks.room_assigned && ["Planning", "Ready"].includes(b.status);
  useEffect(() => {
    if (!canAssignRoom || !locId) return;
    api(`/api/locations/${locId}/rooms`).then((d) => setRooms(d.items ?? [])).catch(() => setRooms([]));
  }, [canAssignRoom, locId]);
  async function assignRoom(roomId: string) {
    if (roomBusy || !roomId) return;
    setRoomBusy(true);
    try { await api(`/api/batches/${b._id}`, { method: "PATCH", json: { room: roomId } }); setRoomPick(""); onChanged(); }
    catch (e: any) { setError(e.message); }
    finally { setRoomBusy(false); }
  }
  async function createAndAssignRoom() {
    if (roomBusy || !newRoom?.name) return;
    setRoomBusy(true);
    try {
      const res = await api(`/api/locations/${locId}/rooms`, { method: "POST", json: { name: newRoom.name, type: newRoom.type || "Classroom" } });
      if (res.queued) { setError("Room suggestion sent for approval — an Admin will add it."); setNewRoom(null); return; }
      await api(`/api/batches/${b._id}`, { method: "PATCH", json: { room: res.item._id } });
      setNewRoom(null); onChanged();
    } catch (e: any) { setError(e.message); }
    finally { setRoomBusy(false); }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {running && (
        <div className="lg:col-span-2 flex flex-wrap items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-4 py-2 text-xs text-green-900">
          {/* -104: this banner printed the raw enum, so the Overview said "Result Awaited" in the
              header chip and "Closing" two lines below it. Same label map as the chip. */}
          <span className="font-semibold">{b.status === "Active" ? "Running" : statusLabel(b.status)}</span>
          {b.actual_start && <span>since {fmtDate(b.actual_start)}</span>}
          {dayN && dayM && b.status === "Active" && <span>· day {Math.min(dayN, dayM)} of {dayM}</span>}
          {att && <span>· our logs {att.days_held} day{att.days_held === 1 ? "" : "s"}</span>}
          {att && (withPortal.length ? <span>· portal {portalDays} working day{portalDays === 1 ? "" : "s"} ({withPortal.length}/{att.members?.length} students)</span> : <span className="text-green-700/70">· portal not imported yet</span>)}
          {att && <span>· {att.qualified_count} qualified for assessment</span>}
        </div>
      )}
      {/* QA-150: the header counts the checks that gate Mark Ready and nothing else; the
          enrollment line below the divider gates START (Rule 17 side) and is labelled so.
          -112 (QA-219 / Manish 17/08 M4-07 "batches me ye readiness ka koi abhi sense nahi hai"):
          readiness is a PREPARATION check. Once the batch is running or finished it has nothing
          left to say, so it collapses into a <details> the way the batches list already renders a
          dash there — still reachable for anyone auditing why it started, never occupying the
          screen of a batch that is past it. */}
      {running ? (
        <>
        {/* -134 (QA-284, Umesh 19/08): -112 was right to collapse the readiness checklist once a
            batch starts — it is a preparation record and has nothing left to say. But NOTHING took
            its place, so half the Overview of a running batch was empty white space, on the screen
            whose whole job is to answer "what is happening with this batch". The collapse was the
            fix; the hole was the cost of it, and nobody looked at the screen afterwards. What goes
            here is what this component already computes and was not showing. */}
        <Section title="Right now">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div><div className="text-xs text-gray-500">On the roster</div><div className="text-lg font-semibold">{data.readiness?.roster_count ?? 0}<span className="text-sm font-normal text-gray-500"> of {b.target_size ?? "—"}</span></div></div>
            <div><div className="text-xs text-gray-500">Days we logged</div><div className="text-lg font-semibold">{att ? att.days_held : "—"}</div></div>
            <div><div className="text-xs text-gray-500">Portal working days</div><div className="text-lg font-semibold">{att ? (portalDays || <span className="text-sm font-normal text-gray-500">not imported</span>) : "—"}</div></div>
            <div><div className="text-xs text-gray-500">Qualified for assessment</div><div className="text-lg font-semibold text-green-700">{att ? att.qualified_count : "—"}</div></div>
          </div>
          {/* QA-750. Two rows, not one, and they are NOT a subtotal of each other: "qualified for
              assessment" is an ATTENDANCE verdict (enough hours to sit the exam) and pass/fail is a
              RESULT. Printing them as one chain would repeat QA-704 - three numbers on one screen
              answering what reads like one question. So the second row says out loud what it counts. */}
          {resSummary && (
            <div className="mt-3 border-t border-gray-100 pt-3">
              <div className="mb-1.5 text-xs text-gray-500">Results recorded so far — this is the exam, not the attendance bar above</div>
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                {/* QA-782 (-216, checker on qa-214): this printed `summary.appeared`, which is not
                    "how many were marked" - it is a CONTRACT TOGGLE (`absent_counts_as_appeared`).
                    With that setting off, the card read "Marked 3" directly above "1 marked Absent."
                    The label now counts what it says: every student carrying a settled result. */}
                <div><div className="text-xs text-gray-500">Marked</div><div className="text-lg font-semibold">{(resSummary.passed ?? 0) + (resSummary.failed ?? 0) + (resSummary.absent ?? 0)}<span className="text-sm font-normal text-gray-500"> of {data.readiness?.roster_count ?? 0}</span></div></div>
                <div><div className="text-xs text-gray-500">Passed</div><div className="text-lg font-semibold text-green-700">{resSummary.passed ?? 0}</div></div>
                <div><div className="text-xs text-gray-500">Failed</div><div className="text-lg font-semibold text-red-600">{resSummary.failed ?? 0}</div></div>
                <div><div className="text-xs text-gray-500">Certificates issued</div><div className="text-lg font-semibold">{resSummary.certificates_issued ?? 0}<span className="text-sm font-normal text-gray-500"> of {resSummary.passed ?? 0}</span></div></div>
              </div>
              {(resSummary.absent ?? 0) > 0 && (
                <div className="mt-1.5 text-xs text-gray-500">{resSummary.absent} marked Absent.</div>
              )}
            </div>
          )}
          {/* Umesh's own list, 19/08: "mark attendance, daily attendance" plus the two he named
              when asked — roster and certificates. Every one already had a door; the point is that
              they were all a tab-click away from the screen a person opens precisely to do one. */}
          <div className="mt-4 flex flex-wrap gap-2 border-t border-gray-100 pt-3">
            <Btn small onClick={() => onGo("Attendance")}>Attendance</Btn>
            <Btn small kind="ghost" onClick={() => onGo("Daily Execution")}>Daily log</Btn>
            <Btn small kind="ghost" onClick={() => onGo("Candidates")}>Roster</Btn>
            <Btn small kind="ghost" onClick={() => onGo("Closure")}>Certificates</Btn>
            {/* -205: his ask, literally - the status controls beside these four, in this card. */}
            {statusActions}
          </div>
        </Section>
        <details className="rounded-xl border border-gray-200/80 bg-white px-4 py-2 text-sm">
          <summary className="cursor-pointer text-sm font-semibold text-gray-500">Readiness checklist ({CHECKS.filter(([, , v]) => v).length}/{CHECKS.length}) — preparation record, this batch has started</summary>
          <ul className="mt-2 space-y-1 text-xs text-gray-500">
            {CHECKS.map(([k, label, ok]) => <li key={k}>{ok ? "✓" : "○"} {label}</li>)}
          </ul>
        </details>
        </>
      ) : (
      <Section title={`Readiness checklist (${CHECKS.filter(([, , v]) => v).length}/${CHECKS.length})`}>
        {beganAlready && (
          <p className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Planned start {fmtDate(b.planned_start)} has passed — this batch is being entered after it began.
            Set the real start date below and record it. The checks that are not met are kept on the
            record; they do not stop you.
          </p>
        )}
        <ul className="space-y-2 text-sm">
          {CHECKS.map(([k, label, ok]) => (
            <li key={k} className="flex flex-wrap items-center gap-2">
              <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${ok ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"}`}>{ok ? "✓" : "○"}</span>
              {label}
              {k === "room_assigned" && canAssignRoom && (
                <span className="flex flex-wrap items-center gap-1.5 text-xs">
                  {rooms && rooms.length > 0 && (
                    <>
                      <select className="rounded-lg border border-gray-300 px-2 py-1 text-xs" value={roomPick} onChange={(e) => setRoomPick(e.target.value)}>
                        <option value="">Assign room…</option>
                        {rooms.map((rm: any) => <option key={rm._id} value={rm._id}>{rm.name} ({rm.type})</option>)}
                      </select>
                      <Btn small disabled={!roomPick || roomBusy} onClick={() => assignRoom(roomPick)}>Assign</Btn>
                    </>
                  )}
                  {rooms && rooms.length === 0 && !newRoom && <span className="text-amber-700">This centre has no rooms yet.</span>}
                  {!newRoom
                    ? <button className="text-blue-700 underline" onClick={() => setNewRoom({ name: "", type: b.program?.requires_lab ? "Lab" : "Classroom" })}>+ Add room at this centre</button>
                    : (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <input className="w-32 rounded-lg border border-gray-300 px-2 py-1 text-xs" placeholder="Room name" value={newRoom.name} onChange={(e) => setNewRoom({ ...newRoom, name: e.target.value })} />
                        <select className="rounded-lg border border-gray-300 px-2 py-1 text-xs" value={newRoom.type} onChange={(e) => setNewRoom({ ...newRoom, type: e.target.value })}>
                          <option>Classroom</option><option>Lab</option>
                        </select>
                        <Btn small disabled={!newRoom.name.trim() || roomBusy} onClick={createAndAssignRoom}>{roomBusy ? "…" : "Add & assign"}</Btn>
                        <button className="text-gray-500 underline" onClick={() => setNewRoom(null)}>cancel</button>
                      </span>
                    )}
                </span>
              )}
            </li>
          ))}
          <li className="flex items-center gap-2 border-t pt-2">
            <span className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${r.enrollment_ok ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-400"}`}>{r.enrollment_ok ? "✓" : "○"}</span>
            <span>For Start: enrolled ≥ threshold ({r.enrolled_count}/{r.enrollment_threshold})</span>
            <span className="text-[10px] text-gray-400">not part of the count above</span>
          </li>
        </ul>
        <div className="mt-4 flex flex-wrap gap-2">{statusActions}</div>
      </Section>
      )}
      {/* -207 (Umesh): "ye button mai vo double confirmation pop up card khule properly." It was an
          inline block that appeared far down the page - he pressed a button at the top and the thing
          it opened was below the fold, which is why it read as a second, unrelated dialog. It is a
          Drawer now: this repo has exactly one overlay primitive and inventing a second would be the
          drift ARCHITECTURE.md section 3 is a catalogue of. It opens for anyone who can see the
          button; the door itself is Admin-only and the panel says so, rather than the screen hiding
          a control and explaining nothing. */}
      {/* -226: told ONCE, and then not stopped - Umesh's own words were "just notify them once that
          this is a past date but dont stop them". Everything that is not met is named here, in the
          same wording the checklist above uses (CHECKS, so there is no second copy of it on the
          client), and the press goes through. The reason box is optional on purpose: every other
          override in this product demands one, but demanding one here would be the stopping he
          asked us not to do. */}
      {/* -235: Umesh chose "Admin target khud chune" over a fixed restore point, so all three pre-cancel
          states are offered and the Admin says which one the batch was really in. */}
      <Drawer open={restoreOpen && b.status === "Cancelled"} onClose={() => setRestoreOpen(false)} title={`Restore ${b.code}`} error={error}>
        <div className="space-y-3 text-sm">
          <p className="text-gray-600">
            This batch was cancelled{b.cancel_reason ? <> — reason on record: <b>{b.cancel_reason}</b></> : ", with no reason on record"}.
            Restoring puts its status back so work can continue; it changes no dates and undoes nothing else.
          </p>
          <Field label="Put it back to" required>
            <div className="space-y-1">
              {["Planning", "Ready", "Active"].map((t) => {
                const why = restoreBlocked[t];
                return (
                  <label key={t} className={`flex items-center gap-2 text-sm ${why ? "text-gray-400" : "text-gray-800"}`}>
                    <input type="radio" name="restore-target" value={t} disabled={!!why}
                      checked={restoreTarget === t} onChange={() => setRestoreTarget(t)} />
                    <span>{statusLabel(t)}</span>
                    {why && <span className="text-xs">— not available: {why}</span>}
                  </label>
                );
              })}
            </div>
          </Field>
          <p className="text-xs text-gray-500">
            Restoring to Ready runs the same readiness checks that Mark Ready runs. Restoring to Active is
            only for a batch that genuinely started — one that never did is restored to Planning or Ready
            and then started with its real date.
          </p>
          <Field label="Reason" required>
            <input className={inputCls} placeholder="e.g. cancelled by mistake" value={restoreReason} onChange={(e) => setRestoreReason(e.target.value)} />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Btn onClick={restoreBatch} disabled={restoring || !restoreReason.trim() || !!restoreBlocked[restoreTarget]}>{restoring ? "Restoring…" : "Restore batch"}</Btn>
            <Btn kind="ghost" onClick={() => setRestoreOpen(false)}>Cancel</Btn>
          </div>
        </div>
      </Drawer>
      <Drawer open={backdateOpen && beganAlready} onClose={() => setBackdateOpen(false)} title={`Record ${b.code} as already started`} error={error}>
        <div className="text-sm">
          <div className="font-semibold text-amber-900">This batch is being recorded after it began</div>
          <p className="mt-1 text-amber-800">
            It will be recorded as having started on <b>{startDate ? fmtDate(startDate) : "—"}</b>, so attendance can be
            entered from that day. The start date cannot be changed afterwards.
          </p>
          {CHECKS.some(([, , okv]) => !okv) || !r.enrollment_ok ? (
            <div className="mt-2 space-y-1 text-amber-800">
              <p className="font-medium">Not met — recorded as it stands, not fixed:</p>
              <ul className="list-disc space-y-0.5 pl-5 text-xs">
                {CHECKS.filter(([, , okv]) => !okv).map(([k, label]) => <li key={k}>{label}</li>)}
                {!r.enrollment_ok && <li>For Start: enrolled ≥ threshold ({r.enrolled_count}/{r.enrollment_threshold})</li>}
                {r.location_halted && <li>This centre is not operational today</li>}
              </ul>
              <p className="text-xs">A batch that already ran cannot pass checks that describe preparing for one that has not — so these are written to the batch history with your name instead of blocking you.</p>
            </div>
          ) : (
            <p className="mt-2 text-amber-800">Every readiness check is met — this simply records the real start date.</p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input className={inputCls + " max-w-md"} placeholder="Reason (optional — kept on the batch history)" value={backdateReason} onChange={(e) => setBackdateReason(e.target.value)} />
            <Btn onClick={recordBackdatedStart} disabled={backdating || !startDate}>{backdating ? "Recording…" : "Record it"}</Btn>
            <Btn kind="ghost" onClick={() => setBackdateOpen(false)}>Cancel</Btn>
          </div>
        </div>
      </Drawer>
      <Drawer open={completeOpen && ["Active", "Closing"].includes(b.status)} onClose={() => setCompleteOpen(false)} title={`Complete ${b.code}`} error={error}>
        <div className="text-sm">
          <div className="font-semibold text-amber-900">Complete this batch now</div>
          {/* -207: this branch used to be `can_complete_cleanly` alone, and that flag answers only
              "are the results and certificates settled". On the batch Umesh was looking at it was
              TRUE while 10 students had no portal Candidate ID, so this panel said "every student is
              marked and every certificate is settled" two lines under a caption correctly saying 10
              were outstanding. One card, contradicting itself. Same flag, same wrong question as
              QA-678 — asked in a third place. */}
          {completePlan?.can_complete_cleanly && !(completePlan?.no_portal_id?.length ?? 0) ? (
            <p className="mt-1 text-amber-800">Every student is marked, every certificate is settled and every portal Candidate ID is on record — this just completes the batch.</p>
          ) : (
            /* -206 (Umesh, 23/08): "2 time confirmation kindaa... ek popup aana chaiye like list of
               critical issues in the batch remaining... and their navigation button to respective
               tab so that they can fix those issues and vha prr neeche button of complete batch
               forcefully." Every open thing is named, each with the way to go and fix it, and the
               forceful press sits below them rather than beside a count. */
            <div className="mt-1 space-y-2 text-amber-800">
              <p className="font-medium">Still open on this batch — fix them, or complete it forcefully and they are recorded as they stand:</p>
              <ul className="space-y-1.5">
                {(completePlan?.unmarked?.length ?? 0) > 0 && (
                  <li className="flex flex-wrap items-center gap-2">
                    <span><b>{completePlan.unmarked.length} student{completePlan.unmarked.length === 1 ? "" : "s"} with no result</b> → recorded <b>Fail</b>
                      <span className="text-amber-700"> ({personList(completePlan.unmarked.slice(0, 4))}{completePlan.unmarked.length > 4 ? ` +${completePlan.unmarked.length - 4}` : ""})</span></span>
                    <Btn small kind="ghost" onClick={() => { setCompleteOpen(false); onGo("Candidates"); }}>Mark them →</Btn>
                  </li>
                )}
                {(completePlan?.unsettled?.length ?? 0) > 0 && (
                  <li className="flex flex-wrap items-center gap-2">
                    {/* -159 cycle 2 (QA-476): four lines below the one -159 fixed, on a payload that
                        already carried the phone. Counting by hand missed it twice. */}
                    <span><b>{completePlan.unsettled.length} passed candidate{completePlan.unsettled.length === 1 ? "" : "s"} with no certificate</b> → recorded <b>Not Issued</b>
                      <span className="text-amber-700"> ({personList(completePlan.unsettled.slice(0, 4))})</span></span>
                    <Btn small kind="ghost" onClick={() => { setCompleteOpen(false); onGo("Closure"); }}>Attach certificates →</Btn>
                  </li>
                )}
                {(completePlan?.no_portal_id?.length ?? 0) > 0 && (
                  <li className="flex flex-wrap items-center gap-2">
                    {/* The one blocker no amount of marking settles: it is the government's number.
                        Rule 18 holds certification shut on it, which is what used to make this door
                        reach its last step and 409 after writing everything above (QA-697). */}
                    <span><b>{completePlan.no_portal_id.length} enrolled student{completePlan.no_portal_id.length === 1 ? "" : "s"} with no portal Candidate ID</b> → certification signed by you, not derived
                      <span className="text-amber-700"> ({personList(completePlan.no_portal_id.slice(0, 4))}{completePlan.no_portal_id.length > 4 ? ` +${completePlan.no_portal_id.length - 4}` : ""})</span></span>
                    <Btn small kind="ghost" onClick={() => { setCompleteOpen(false); onGo("Closure"); }}>Enter the IDs →</Btn>
                  </li>
                )}
              </ul>
              <p className="text-xs">Every one of these is written to the batch history with your reason and the time in IST. If a student really passed, mark them first — this is the door for a batch that is over, not a shortcut through data entry.</p>
            </div>
          )}
          <p className="mt-2 text-xs text-amber-800">Completing freezes the results and figures. You can reopen it later (Admin, with a reason).</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input className={inputCls + " max-w-md"} placeholder="Reason (recorded on every row this settles)" value={completeReason} onChange={(e) => setCompleteReason(e.target.value)} />
            {/* -206: the second press, and it says what it is. On a batch with nothing open it is an
                ordinary completion; on one with rows still standing it is the forceful one, and the
                label must not hide that from the person pressing it. */}
            {/* QA-708 (-209, checker on qa-207): -207 disabled this for a non-Admin and wrote
                "Completing a batch is an Admin action" beside it. The server does not say that.
                POST /transition {target:"Completed"} succeeds for Operations today - it is only the
                FORCE door that is Admin-only - so -207 deleted the one Overview control they had and
                replaced it with a sentence the server contradicts. A screen that invents a
                permission rule is worse than one that offers nothing, because the person believes it.
                Non-Admins get the ordinary door, which enforces Rule 18 and the approval matrix; the
                override stays Admin-only and the label says which of the two this press is. */}
            <Btn onClick={isAdmin ? completeAsAdmin : completeOrdinary} disabled={completing || !completeReason.trim()}>
              {completing ? "Completing…" : !isAdmin
                ? "Complete batch"
                : completePlan?.can_complete_cleanly && !(completePlan?.no_portal_id?.length ?? 0)
                  ? "Complete batch"
                  : "Complete batch forcefully"}
            </Btn>
            <Btn kind="ghost" onClick={() => setCompleteOpen(false)}>Cancel</Btn>
            {/* QA-721 (-211, checker on qa-209): -207 said "Completing a batch is an Admin action",
                which the server contradicted; -209 replaced it with "completing over it is an Admin
                action", which the server ALSO contradicts - the checker pressed this as Operations on
                a Closing batch with a portal-ID gap and it completed, 200. Two releases, two invented
                permission rules. The screen does not know what the door will allow, so it stops
                claiming to: it says what this press WILL DO, and lets the rule answer for itself. */}
            {!isAdmin && (
              <span className="text-xs text-gray-500">
                This is the ordinary completion. Anything the rules still hold open will be refused, and
                the refusal will say what it is.
              </span>
            )}
          </div>
        </div>
      </Drawer>
      {/* QA-055 (checker): a SPOC saw the full editable Details card with a Save button the
          server refuses (403). Editors get the form; everyone else gets the same facts
          read-only — no button that only exists to bounce. */}
      <Section title="Details">
        {/* QA-007 (15/08): a finished batch with no portal id, no Drive folder or no time
            slot is an evidence gap the client can ask about — name what is missing instead
            of leaving blanks nobody notices. */}
        {/* QA-749 (-214, Umesh 23/08): "ab sach mai humko ye drive evidence chahiye bhi? drive to use
            hi nahi ho raha na ab, ab to google cloud mai store ho raha hai na data. to ye galat hai
            na??" He was right, and the measurement is blunter than the question: NOTHING in the
            backend reads `drive_folder_url` - it exists on the model and on one PATCH allow-list and
            nowhere else - while `lib/storage.ts:4` states in its own words that "the USER never sees
            Drive", which is precisely what this banner and the field below were doing. Live evidence
            storage is GCS. So the batch was being nagged for a folder nobody would ever open.
            His ruling, asked directly: "poori tarah hatao" - banner and form both. The SCHEMA is
            untouched, so every link already typed is still in the database. */}
        {["Closing", "Completed"].includes(b.status) && (!b.govt_batch_id || !b.slot_start) && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Still missing on this finished batch: {[
              !b.govt_batch_id && "the SIDH batch ID",
              !b.slot_start && "the time slot",
            ].filter(Boolean).join(" · ")} — fill them below so the record stands on its own.
          </div>
        )}
        {canTransition
          ? <EditDetails b={b} onChanged={onChanged} error={error} setError={setError} />
          : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              {[["Trainer", b.trainer?.name ?? "—"], ["Room", b.room?.name ?? "—"],
                ["Planned start", fmtDate(b.planned_start)], ["Planned end", fmtDate(b.planned_end)],
                ["Session", b.session ?? "—"], ["Target size", String(b.target_size ?? "—")],
                ["Time slot", b.slot_start ? `${b.slot_start}–${b.slot_end}` : "—"],
                ["Government batch ID", b.govt_batch_id ?? "—"]].map(([k, v]) => (
                <div key={k as string}><span className="text-xs text-gray-400">{k}: </span><span className="font-medium">{v}</span></div>
              ))}
            </div>
          )}
        {/* 15/08 (Umesh): accepted unknown import columns — facts, edited only by re-import. */}
        {b.custom_fields && Object.keys(b.custom_fields).length > 0 && (
          <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm">
            <div className="mb-1 text-xs font-medium text-gray-500">Extra columns (from import)</div>
            {Object.entries(b.custom_fields).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3"><span className="text-gray-500">{k}</span><span className="text-right">{String(v)}</span></div>
            ))}
          </div>
        )}
      </Section>
      {/* QA-152 (Umesh, 15/08): the backward plan is made ON DEMAND — "planning is a deliberate
          act, not a side-effect of saving a batch". No plan → one button. Batches created
          before -81 keep their auto-milestones hidden until this button is pressed. Plan-only
          verdicts (TOT lead time, F-A3) live HERE, never on the readiness checklist. */}
      {!b.plan_enabled && canTransition && b.status === "Planning" && (
        <Section title="Backward plan">
          <p className="text-sm text-gray-600">No plan for this batch. A backward plan counts the trainer/TOT/mobilisation milestones back from the planned start — for a batch you are planning ahead, not one that has already run.</p>
          <div className="mt-3">
            <Btn onClick={async () => {
              try { await api(`/api/batches/${b._id}/milestones`, { method: "PATCH", json: { create: true } }); onChanged(); }
              catch (e: any) { setError(e.message); }
            }}>Create backward plan</Btn>
          </div>
        </Section>
      )}
      {b.plan_enabled && (b.milestones?.length ?? 0) > 0 && (
        <Section title="Backward plan" titleHref={`/batches/${b._id}/plan`} actions={
          <span className="flex flex-wrap items-center gap-2">
            <Link className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700" href={`/batches/${b._id}/plan`}>Open plan · share · Excel ↗</Link>
            {b.status === "Planning" && (
              <Btn small kind="ghost" onClick={async () => {
                try { await api(`/api/batches/${b._id}/milestones`, { method: "PATCH", json: { regenerate: true } }); onChanged(); }
                catch (e: any) { setError(e.message); }
              }}>Regenerate</Btn>
            )}
          </span>
        }>
          {r.plan_flags && r.plan_flags.tot_lead_ok === false && ["Planning", "Ready"].includes(b.status) && (
            <p className="mb-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              TOT completed {fmtDate(r.plan_flags.tot_done_on)} — the plan needed it by {fmtDate(r.plan_flags.tot_due)} ({r.plan_flags.tot_lead_days} days before start).
              {b.trainer?._id && <> Wrong date on record? Correct it on the <Link className="underline" href={`/trainers/${b.trainer._id}`}>trainer&apos;s page</Link>.</>}
            </p>
          )}
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
      <Drawer error={error} open={confirmCancel} onClose={() => setConfirmCancel(false)} title={`Cancel batch ${b.code}?`}>
        <div className="space-y-3">
          <p className="text-sm text-gray-600">This is destructive. A batch with daily logs can only be force-closed by Admin, with a reason.</p>
          <Field label="Reason" required><input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Btn kind="danger" onClick={() => transition("Cancelled")} disabled={!reason}>Confirm Cancel</Btn>
        </div>
      </Drawer>
    </div>
  );
}

function EditDetails({ b, onChanged, error, setError }: any) {
  const [trainers, setTrainers] = useState<any[]>([]);
  const [rooms, setRooms] = useState<any[]>([]);
  const [allLocations, setAllLocations] = useState<any[]>([]);
  const [allPrograms, setAllPrograms] = useState<any[]>([]);
  // ONE shape for "what this form holds", used both to seed it and to RE-seed it from the server's
  // own answer after a save. `refOf` reads an id off a populated ref OR off a bare ObjectId,
  // because the two doors this form talks to return the same field in two shapes: GET
  // /api/batches/[id] populates location/program/trainer/room, PATCH returns the raw document.
  const refOf = (v: any) => (v == null ? "" : String(v?._id ?? v));
  const formFrom = (x: any) => ({
    trainer: refOf(x.trainer), room: refOf(x.room), session: x.session,
    planned_start: toInputDate(x.planned_start), planned_end: toInputDate(x.planned_end), target_size: x.target_size,
    slot_start: x.slot_start ?? "", slot_end: x.slot_end ?? "",
    relevant_skills: x.relevant_skills ?? [],
    // QA-749: `drive_folder_url` deliberately NOT carried on this form any more. PATCH is partial,
    // so leaving it out means every link already in the database stays exactly as it is - the field
    // is invisible, not deleted. Carrying it would have meant re-sending it on every Details save
    // for a box nobody can see.
    govt_batch_id: x.govt_batch_id ?? "",
    location: refOf(x.location), program: refOf(x.program),
  });
  const [form, setForm] = useState<any>(() => formFrom(b));
  const [defaults, setDefaults] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [warn, setWarn] = useState("");
  const planning = b.status === "Planning";
  useEffect(() => {
    api("/api/trainers?limit=2000").then((d) => setTrainers(d.items)).catch(() => {});
    api("/api/defaults").then((d) => setDefaults(d.item)).catch(() => {});
    const locId = b.location?._id ?? b.location;
    api(`/api/locations/${locId}/rooms`).then((d) => setRooms(d.items)).catch(() => {});
    if (planning) {
      api("/api/locations?limit=2000").then((d) => setAllLocations(d.items)).catch(() => {});
      api("/api/programs?limit=1000").then((d) => setAllPrograms(d.items)).catch(() => {});
    }
  }, [b]);

  async function save() {
    setError(""); setSaved(""); setWarn(""); setSaving(true);
    try {
      const json: any = { ...form, trainer: form.trainer || null, room: form.room || null };
      // location/program travel only when actually changed — otherwise every ordinary save on a
      // Planning batch with a roster would trip the empty-roster guard on the API.
      if (json.location === String(b.location?._id ?? b.location ?? "")) delete json.location;
      if (json.program === String(b.program?._id ?? b.program ?? "")) delete json.program;
      const res = await api(`/api/batches/${b._id}`, { method: "PATCH", json });
      // MEASURED on an isolated copy 2026-08-25, because this was reported as "details save nahi ho
      // rahi" and the save was never the thing that was broken: the PATCH persists every field on
      // this form and answers 200. What it ALSO does is hand back a `warning` on virtually every
      // save — the trainer's portal standing, and how early the start really is ("kam se kam 15
      // din lagenge, is kaaran se") — and this function used to discard the entire response and
      // render nothing at all. So a save that WORKED and a save that did nothing were byte-for-byte
      // identical from the operator's seat, and the only reasonable conclusion to draw was the
      // wrong one. The create drawer has surfaced this since it was written (batches/page.tsx:238);
      // this is the second copy, and it never got it.
      if (res?.item) setForm(formFrom(res.item));
      setSaved("Saved.");
      if (res?.warning) setWarn(res.warning);
      onChanged();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  const idOf = (v: any) => (v?._id ?? v) as string | undefined;
  const locId = idOf(b.location), progId = idOf(b.program);
  // QA-133/134: the ONE shared predicate both batch forms use (trainer-select.ts) — this
  // form used to carry its own diverging copy, which is exactly how the create drawer grew
  // an unrequested skill filter without anyone noticing.
  const { ready: certified, others } = trainerSelectGroups(trainers, {
    locationId: locId, programId: progId, currentTrainerId: form.trainer,
  });
  const skillOptions = Array.from(new Set([
    ...(b.program?.trainer_skill ? [b.program.trainer_skill] : []),
    ...trainers.flatMap((t: any) => t.skills ?? []),
    ...(form.relevant_skills ?? []),
  ])).sort();
  // QA-138 pulled this check out CLIENT-SAFE precisely so a form could show the same errors while
  // the operator types instead of springing them on save. The create drawer took it
  // (batches/page.tsx:233); this form — the other place the very same slot is edited — did not,
  // so an identical 5-hour slot is accepted here without a word and then refused by the API.
  const slotErrs = slotGuidelineErrors({ slot_start: form.slot_start, slot_end: form.slot_end }, defaults ?? {});

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
        {/* Same gates as batch creation (shared predicate) — reassigning a trainer here must
            not quietly sidestep what the create drawer enforces. */}
        <Field label="Trainer">
          <select className={inputCls} value={form.trainer} onChange={(e) => setForm({ ...form, trainer: e.target.value })}>
            <option value="">—</option>
            {certified.length > 0 && (
              <optgroup label="Certified — has a TR ID and is cleared for this centre">
                {certified.map((t: any) => <option key={t._id} value={t._id}>{t.name} · TR {t.tr_id}</option>)}
              </optgroup>
            )}
            {others.length > 0 && (
              <optgroup label="Not portal-ready — the reason is next to each name">
                {others.map(({ t, reason }) => <option key={t._id} value={t._id}>{t.name} — {reason}</option>)}
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
      {/* QA-133 (Umesh, 15/08): recorded operator pick, never a filter. */}
      <Field label="Skills relevant to this batch (optional — your pick, never a filter)">
        <select multiple className={inputCls + " h-24"} value={form.relevant_skills ?? []}
          onChange={(e) => setForm({ ...form, relevant_skills: Array.from(e.target.selectedOptions).map((o) => o.value) })}>
          {skillOptions.map((s: string) => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>
      {/* The portal's own identifiers. Batch formation happens on SIDH, so the ERP has to hold
          the key that links our row to theirs — and the Drive folder Manish keeps in parallel
          with the NSDC upload, which is the only copy if the portal upload is ever questioned. */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Government batch ID (SIDH)">
          <input className={inputCls} value={form.govt_batch_id} placeholder="as shown on the portal"
            onChange={(e) => setForm({ ...form, govt_batch_id: e.target.value })} />
        </Field>
      </div>
      <div className="text-xs text-gray-500">Actual: {fmtDate(b.actual_start)} → {fmtDate(b.actual_end)}</div>
      {/* QA-138: the same errors the API would refuse with, shown while typing. */}
      {slotErrs.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {slotErrs.map((e: string) => <div key={e}>⚠ {e}</div>)}
        </div>
      )}
      {/* The answer to "did that save?" belongs BESIDE the button that asked the question. `error`
          does render page-level at :86 — but that is ABOVE the tab strip, and this card ends about
          a thousand pixels below it with no scrollIntoView, so a refusal was invisible from the
          only seat that could act on it. This is a second home for it, not a replacement: the
          Drawers on this same page already render `error` twice for exactly this reason. */}
      <ErrorBanner msg={error} onDismiss={() => setError("")} />
      {saved && <Notice kind="success" onDismiss={() => setSaved("")}>{saved}</Notice>}
      {warn && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          ⚠ {warn} <button className="ml-2 font-bold" onClick={() => setWarn("")}>×</button>
        </div>
      )}
      <Btn onClick={save} disabled={saving}>{saving ? "Saving…" : "Save details"}</Btn>
    </div>
  );
}

// ---------- Candidates tab: roster ----------
function Roster({ batchId, batch, error, setError, onChanged }: any) {
  const [members, setMembers] = useState<any[]>([]);
  const [pool, setPool] = useState<any[]>([]);
  const [showPool, setShowPool] = useState(false);
  const [dropTarget, setDropTarget] = useState<any>(null);
  const [dropForm, setDropForm] = useState<any>({});
  const [dropReasons, setDropReasons] = useState<any[]>([]);
  const [attLinks, setAttLinks] = useState<any[] | null>(null);
  // A-03
  const [regLink, setRegLink] = useState<string | null>(null);
  const [regWarning, setRegWarning] = useState<string | null>(null);   // QA-1187
  const [regBusy, setRegBusy] = useState(false);
  const [attBusy, setAttBusy] = useState(false);

  // 2026-08-13 (Manish): "bacche baar-baar puchte hain sir mera kitna ho gaya attendance" —
  // one capability link per active member, student sees their own days/hours/eligibility.
  // A-03: the batch decides the centre AND the programme, so neither is asked for here - the mint
  // route reads both off the batch. A refusal (batch finished, or at another centre) surfaces on the
  // page rather than being swallowed, because a link that silently never appeared is the shape this
  // screen has produced too many times.
  async function mintBatchRegLink() {
    setRegBusy(true);
    try {
      const res = await api("/api/public-tokens", { method: "POST", json: { purpose: "register", location: batch?.location?._id ?? batch?.location, batch: batchId } });
      setRegLink(res.link ?? res.url ?? (res.item?.token ? `${window.location.origin}${BASE_PATH}/p/register/${res.item.token}` : null));
      // QA-1187: a link for a batch already at target used to be minted in complete silence, while
      // the form it opens went on telling the student they would be added. The link is still made -
      // a batch can empty by tomorrow, and a dead link explains nothing to whoever holds it
      // (REQ-393) - but the person about to paste it into a WhatsApp thread is told first.
      setRegWarning(res.warning ?? null);
    } catch (e: any) { setError(e.message); }
    setRegBusy(false);
  }

  async function generateAttendanceLinks() {
    setAttBusy(true);
    try {
      const res = await api("/api/public-tokens", { method: "POST", json: { purpose: "attendance", batch: batchId } });
      setAttLinks(res.items);
    } catch (e: any) { setError(e.message); }
    setAttBusy(false);
  }

  // -101 (Umesh 17/08, "CRUD ke saare operations chalne chahiye"): a certificate could be
  // uploaded and replaced but never REMOVED — a scan attached to the wrong candidate was
  // permanent. Removing the FILE only; the status, number and date are what the awarding body
  // said and are changed on the results screen, not here. Frozen batches refuse (DEC-6).
  const [certBusy, setCertBusy] = useState("");
  async function removeCertificate(res: any, candName: string) {
    const reason = window.prompt(`Remove the certificate FILE for ${candName}?

The certificate status (${res.certificate_status ?? "—"}), number and date stay as they are — only the attached file is deleted from storage. Say why:`);
    if (!reason?.trim()) return;
    setCertBusy(String(res._id));
    try {
      await api(`/api/results/${res._id}/certificate`, { method: "DELETE", json: { reason: reason.trim() } });
      await load();
      onChanged?.();
    } catch (e: any) { setError(e.message); }
    setCertBusy("");
  }

  const [loaded, setLoaded] = useState(false);
  // QA-043 (checker): a completed batch's roster showed enrollment but never the outcome —
  // result + certificate ride along from the per-candidate rows.
  const [resultsByCand, setResultsByCand] = useState<Map<string, any>>(new Map());
  const load = () => Promise.all([
    api(`/api/batches/${batchId}/members`).then((d) => setMembers(d.items)),
    api(`/api/batches/${batchId}/results`).then((d) => setResultsByCand(new Map((d.items ?? []).filter((i: any) => i.result).map((i: any) => [String(i.result.candidate?._id ?? i.result.candidate), i.result])))).catch(() => {}),
    // 2026-08-13 (Manish hit this live — Prem Kumar/Lalit from another job role in the pool):
    // the pool is this location AND this job role. Program-less candidates (bulk imports)
    // stay eligible — they inherit the batch's programme on enrol; the server enforces both.
    api(`/api/candidates?location=${batch.location?._id ?? batch.location}&limit=2000`).then((d) =>
      setPool(d.items.filter((c: any) => ["Unassigned", "Dropped"].includes(c.lifecycle_status)
        && (!c.program || String(c.program?._id ?? c.program) === String(batch.program?._id ?? batch.program))))),
    api("/api/master-lists/drop-reasons").then((d) => setDropReasons(d.items)),
  ]).catch((e: any) => setError(e.message)).finally(() => setLoaded(true));
  useEffect(() => { load(); }, [batchId]);

  // -235 (Umesh, 24/08): "batch start ho chuka hai na … humein maximum data collect karna hai." Adding a
  // late joiner to a batch that already ran was never BLOCKED — but the join date was never ASKED for
  // either, so they landed on the day someone typed them in, and Rule 26 then says they were on no day's
  // roster while the batch was actually running. The attendance the centre holds on paper could not be
  // entered for them at all, and nobody found out until they sat down to enter it weeks later (QA-892).
  // The automatic default in addMemberChecked can only GUESS — QA-958/965 measured it missing the batches
  // activated from evidence — so the operator now says the date outright and the server validates it.
  const batchBegan = batch?.actual_start ? toInputDate(batch.actual_start) : "";
  const [joinOn, setJoinOn] = useState<string>(batchBegan);
  useEffect(() => { setJoinOn(batchBegan); }, [batchBegan]);

  async function add(candidateId: string) {
    try { await api(`/api/batches/${batchId}/members`, { method: "POST", json: { candidate: candidateId, joined_on: joinOn || undefined } }); load(); onChanged(); }
    catch (e: any) { setError(e.message); }
  }
  async function drop() {
    try {
      await api(`/api/members/${dropTarget._id}/drop`, { method: "POST", json: dropForm });
      setDropTarget(null); setDropForm({}); load(); onChanged();
    } catch (e: any) { setError(e.message); }
  }

  const active = activeOnly(members);
  return (
    <div className="space-y-4">
      {/* A-03: the link, once made. Shown with the batch named in the label so it can never be
          confused with the centre-wide intake link on the Candidates page - copying the wrong one is
          exactly how every self-registered candidate ended up on the pool instead of a roster. */}
      {regLink && regWarning && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <b>Before you send this link:</b> {regWarning}
        </div>
      )}
      {regLink && (
        <ShareLinkPanel label={`Registration link for ${batch?.code ?? "this batch"}`} link={regLink}
          hint="Whoever fills this form is registered AND added to this batch. The centre-wide link on the Candidates page does not do that — it leaves them on the pool."
          onDismiss={() => setRegLink(null)} />
      )}
      <Section title={`Roster (${active.length} active / ${members.length} total)`} actions={
        <div className="flex items-center gap-2">
          {/* A-03 (24-Aug sheet, Shiv, spoken): "Batch four ke liye main candidate ko
              self-registration ki link bhej raha hoon... wo direct batch four mein hi assign ho jaana
              chahiye." It is minted HERE, beside the roster it fills, and not on the Candidates page
              where the centre-wide link lives - because the two are different things and the whole
              defect was that only one of them existed. The labels say which is which. */}
          <Btn small kind="ghost" disabled={regBusy} onClick={mintBatchRegLink}>{regBusy ? "Making…" : "Registration link"}</Btn>
          <Btn small kind="ghost" disabled={attBusy} onClick={generateAttendanceLinks}>Attendance links</Btn>
          <Btn small onClick={() => setShowPool(true)}>Add from pool</Btn>
        </div>
      }>
        {/* -133 (QA-282, Umesh 19/08): "platform me aisi bahut sari jagah hai" — and this is the
            one he named. The panel opened on a click and `setAttLinks(null)` did not exist anywhere
            in the file, so there was no close button because nothing could clear the state. He asked
            for the same thing on 15/08 and it was fixed for HealthBanner and ShareLinkPanel; four
            days later the panels beside them still had no way out. Sixth instance of one shape. */}
        {attLinks && (
          <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="font-medium text-blue-800">One attendance link per candidate — student sees their own days, hours and exam eligibility:</div>
              <button onClick={() => setAttLinks(null)} aria-label="Close" title="Close"
                className="-mt-1 shrink-0 text-xl leading-none text-blue-400 hover:text-blue-700">×</button>
            </div>
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
            // QA-754 (-213): the roster tab is the "candidate card" Umesh named first, and it showed
            // no portal ID at all. Its own column, so it survives the mobile card collapse and can be
            // read down the list rather than hunted for inside a name cell.
            { key: "portal_id", label: "Portal ID", render: (r: any) => <PortalIdChip candidate={r.candidate} /> },
            // QA-902: the APAAR ID on the roster too. Its own column for the same reason the Portal
            // ID has one - it survives the mobile card collapse and can be read DOWN the list, which
            // is how an operator finds the students still missing one. Read-only here; the box that
            // fills it lives on the Closure card.
            { key: "apaar_id", label: "APAAR ID", render: (r: any) => (
              r.candidate?.apaar_id
                ? <span className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${apaarIdState(r.candidate.apaar_id) === "ok" ? "bg-gray-100 text-gray-700" : "bg-amber-100 font-medium text-amber-900"}`}
                    title={apaarIdState(r.candidate.apaar_id) === "ok" ? "Government APAAR ID" : "Stored on this candidate, but it is not a readable 12-digit APAAR ID."}>
                    {r.candidate.apaar_id}{apaarIdState(r.candidate.apaar_id) === "ok" ? "" : " ⚠"}</span>
                : <span className="text-gray-400">—</span>
            ) },
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
            {
              // QA-070 (-70): HOURS on the roster — the CEO's ask ("without number of hours we
              // don't know if the student has qualified"). Same shared verdict as the
              // Attendance tab: green only on portal-verified hours.
              key: "hours", label: "Hours", render: (r: any) => {
                const h = r.hours;
                if (!h) return <span className="text-xs text-gray-400">—</span>;
                if (h.qualified) return <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-700" title={`Portal-verified: ${h.govt_hours} of ${h.required_hours} hrs`}>✓ {h.govt_hours}/{h.required_hours} hrs</span>;
                if (h.basis === "portal") return <span className="text-xs tabular-nums text-amber-700">{h.attended_hours}/{h.required_hours} hrs</span>;
                // -153 (QA-293): checked BEFORE the estimate, because the estimate is the thing
                // that was lying. Both Sachin Kumars rendered "~0/60 hrs" off our own daily logs
                // while their real portal hours sat unattached in the same database.
                // -156 (QA-434): built from the row, not asserted. The export may carry a row whose
                // HOURS column could not be read, and the name may be shared - neither can be
                // promised in a fixed sentence.
                if (h.awaiting_match) return <span className="text-xs text-amber-700" title={`The government export carries ${h.awaiting_match.count > 1 ? `${h.awaiting_match.count} rows` : "a row"} under this name${h.awaiting_match.hours_minutes != null ? ` (${Math.round(h.awaiting_match.hours_minutes / 60)} hrs)` : ", though its hours column could not be read"}. Nothing is attached to a student yet — resolve it on the Government Attendance screen.`}>portal hrs — match pending</span>;
                if (h.basis === "estimate") return <span className="text-xs tabular-nums text-gray-500" title="Days × slot estimate — the portal meter decides">~{h.attended_hours}/{h.required_hours} hrs</span>;
                return <span className="text-xs text-gray-400" title="No slot on the batch and no portal import yet">awaiting hrs</span>;
              },
            },
            {
              // QA-043: the outcome, on the roster itself.
              key: "result", label: "Result", mobile: false, filterable: true,
              filterText: (r: any) => resultsByCand.get(String(r.candidate?._id))?.result ?? "—",
              render: (r: any) => {
                const res = resultsByCand.get(String(r.candidate?._id));
                return res?.result ? <Chip value={res.result} /> : <span className="text-xs text-gray-400">—</span>;
              },
            },
            {
              key: "certificate", label: "Certificate", mobile: false,
              render: (r: any) => {
                const res = resultsByCand.get(String(r.candidate?._id));
                if (!res) return <span className="text-xs text-gray-400">—</span>;
                const frozen = ["Completed", "Cancelled"].includes(batch.status);
                return res.certificate_file
                  ? <span className="flex items-center gap-2">
                      <a className="text-xs font-medium text-blue-700 hover:underline" href={res.certificate_file} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{res.certificate_status ?? "View"} ↗</a>
                      {!frozen && (
                        <button type="button" disabled={certBusy === String(res._id)}
                          title="Delete the attached certificate file (status, number and date stay)"
                          className="text-[11px] text-red-600 hover:underline disabled:opacity-50"
                          onClick={(e) => { e.stopPropagation(); removeCertificate(res, r.candidate?.name ?? "this candidate"); }}>
                          {certBusy === String(res._id) ? "…" : "Delete file"}
                        </button>
                      )}
                    </span>
                  : <span className="text-xs text-gray-500">{res.certificate_status ?? "—"}</span>;
              },
            },
            // QA-039: provenance on the roster too.
            { key: "source", label: "Source", mobile: false, hidden: true, filterable: true, render: (r: any) => r.source ?? <span className="text-gray-400">—</span> },
            { key: "left_on", label: "Left", render: (r: any) => r.left_on ? `${fmtDate(r.left_on)} (${r.drop_reason})` : "—" },
            { key: "_act", label: "", render: (r: any) => !r.left_on ? <Btn small kind="ghost" onClick={() => setDropTarget(r)}>Drop</Btn> : null },
          ]} empty="No members yet — add from the candidate pool." />
      </Section>

      <Drawer error={error} open={showPool} onClose={() => setShowPool(false)} title="Candidate pool (this location)">
        <div className="space-y-2">
          {/* -235: one date for everyone added in this sitting — the normal case is a handful of late
              joiners who all belong to the same batch from the same day. */}
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
            <Field label="Joined on">
              <input type="date" className={inputCls} value={joinOn} max={istTodayInput()} onChange={(e) => setJoinOn(e.target.value)} />
            </Field>
            <p className="mt-1 text-xs text-gray-500">
              {batchBegan
                ? <>This batch began on <b>{fmtDate(batch.actual_start)}</b>. Leaving it there puts a late joiner on the roster from the day the batch really ran, so the attendance you already hold for those days can be entered for them.</>
                : <>This batch has no recorded start yet, so leaving this blank counts them from today. Set it only if they joined earlier.</>}
            </p>
          </div>
          {pool.map((c) => (
            <div key={c._id} className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
              <span>{c.name} <span className="text-gray-400">· {c.phone}</span></span>
              <Btn small onClick={() => add(c._id)}>Add</Btn>
            </div>
          ))}
          {pool.length === 0 && <p className="text-sm text-gray-400">No unassigned candidates at this location.</p>}
        </div>
      </Drawer>

      <Drawer error={error} open={!!dropTarget} onClose={() => setDropTarget(null)} title={`Drop ${dropTarget?.candidate?.name}?`}>
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
// QA-147 (Manish, 15/08 recording): three fixes live here. (1) StepToggle and Card were
// declared INSIDE the component, so every setMembers created new component types and React
// remounted the whole list — the "page upar bhaga" after each click. They are module-level
// now; a click updates one card in place and the scroll position stays. (2) Bulk actions —
// mark one step, or complete enrollment, for every pending member in ONE request. (3) The
// card names the person in every state (Completed included) with a name→email→phone chain.
function EnrolStepToggle({ m, field, label, onUpdate }: any) {
  return (
    <button onClick={() => onUpdate(m, { [field]: !m[field] })}
      className={`rounded-lg border px-3 py-2 text-sm font-medium ${m[field] ? "border-green-300 bg-green-50 text-green-700" : "border-gray-300 bg-white text-gray-500"}`}>
      {m[field] ? "✓ " : ""}{label}
    </button>
  );
}
// -212, Umesh 23/08: "jo candidate card hai, usme har kisi ki portal id bhi properly highlight
// karke dikha". -208 put the portal ID on the batch screen, but only as a list of the students who
// are MISSING one - so the ID a student DOES hold was still invisible everywhere except the edit
// drawer. This is the chip that answers it, in one place, used by every candidate row on this
// screen: the roster card and both attendance pickers.
//
// Three states, because there are three, and the middle one is the whole reason QA-725 exists:
//   has one, readable        -> show it, quietly. Nothing to do.
//   has one, NOT readable    -> amber. It is stored, and certification cannot see it. Until QA-719
//                               is decided this is a real state a person has to be told about,
//                               because the row otherwise looks identical to the next one.
//   has none                 -> amber. This is what blocks the batch.
//
// QA-754 (-213, checker on qa-212): -212 mounted this in three places and NOT ONE of them was a tab
// Umesh named. He said "candidate card" and "attendance wale tab"; the mounts landed on Enrollment
// and Daily Execution, because I grepped for rows rendering `m.candidate?.name` and never checked
// which tab each one belonged to. The checker found it by OPENING THE APP after 3,335 green
// assertions - the fifth broken screen behind a green wall in two days. The two tabs he actually
// named are `Candidates` (the roster table) and `Attendance`, and both take flat rows, so this
// accepts a bare value as well as a candidate object.
// QA-747: the three states, named once. PortalIdChip renders them; the closure card's input needs
// the same answer to colour its border, and two spellings of "is this id readable" on one screen is
// exactly what ARCHITECTURE section 3 exists to stop.
function portalIdState(v: unknown): "none" | "unreadable" | "ok" {
  const raw = String(v ?? "").trim();
  if (!raw) return "none";
  return storedCanIsUnreadable(raw) ? "unreadable" : "ok";
}

// QA-902 (2026-08-24): the same three states for the government APAAR ID, named once and in terms
// of the SAME rule the server refuses on (lib/validate.ts `apaarError`), so the border a person sees
// and the answer the door gives can never drift apart. "unreadable" is a state that really occurs:
// the bulk importer reports a malformed APAAR and stores it anyway (QA-141 — a client's sheet is
// never dropped over format), so a record can hold a value this system cannot read, and a blank box
// on such a record would be a lie about what is stored.
function apaarIdState(v: unknown): "none" | "unreadable" | "ok" {
  const raw = String(v ?? "").trim();
  if (!raw) return "none";
  return storedApaarIsUnreadable(raw) ? "unreadable" : "ok";
}

function PortalIdChip({ candidate, value, className = "" }: { candidate?: any; value?: unknown; className?: string }) {
  const raw = String(value ?? candidate?.sidh_candidate_id ?? "").trim();
  const unreadable = storedCanIsUnreadable(raw);
  if (raw && !unreadable) {
    return <span className={`rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] text-gray-700 ${className}`}
      title="Portal Candidate ID (SIDH)">{raw}</span>;
  }
  if (raw) {
    return <span className={`rounded bg-amber-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-amber-900 ${className}`}
      title="This is stored on the candidate, but certification cannot read it as a portal ID. It has to read as CAN followed by the number.">{raw} ⚠</span>;
  }
  return <span className={`rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900 ${className}`}
    title="No portal Candidate ID on record. Certification cannot complete until this is filled in from SIDH.">no portal ID</span>;
}

function EnrolCard({ m, onUpdate, selected, onSelect }: any) {
  const who = m.candidate?.name || m.candidate?.email || m.candidate?.phone || "(unnamed candidate)";
  return (
    <div className={`space-y-3 rounded-xl border bg-white p-4 ${selected ? "ring-2 ring-blue-200" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <label className="flex min-w-0 items-start gap-2">
          {m.enrollment_status !== "Completed" && <input type="checkbox" className="mt-1" checked={!!selected} onChange={() => onSelect(m._id)} />}
          <div className="min-w-0">
            <div className="truncate font-semibold" title={who}>{who}</div>
            <div className="text-sm text-gray-500">{m.candidate?.phone}{m.candidate?.email && m.candidate?.name ? ` · ${m.candidate.email}` : ""}</div>
            <div className="mt-1"><PortalIdChip candidate={m.candidate} /></div>
          </div>
        </label>
        <Chip value={m.enrollment_status} />
      </div>
      <div className="flex flex-wrap gap-2">
        <EnrolStepToggle m={m} field="reg_done" label="Registration" onUpdate={onUpdate} />
        <EnrolStepToggle m={m} field="kyc_done" label="e-KYC" onUpdate={onUpdate} />
        <EnrolStepToggle m={m} field="accept_done" label="Batch Accept" onUpdate={onUpdate} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" value={m.issue ?? ""}
          onChange={(e) => e.target.value ? onUpdate(m, { failed: true, issue: e.target.value }) : onUpdate(m, { failed: false, issue: null })}>
          <option value="">No issue</option>
          {["OTP not received", "Already registered", "KYC failed", "Portal error", "Duplicate", "Other"].map((i) => <option key={i}>{i}</option>)}
        </select>
        {m.enrollment_status === "Failed" && <Btn small kind="ghost" onClick={() => onUpdate(m, { failed: false, issue: null })}>Clear failure</Btn>}
        <span className="ml-auto text-xs text-gray-400">{m.source}</span>
      </div>
    </div>
  );
}

function Enrollment({ batchId, error, setError }: any) {
  const [members, setMembers] = useState<any[]>([]);
  const [idx, setIdx] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState("");

  const load = () => api(`/api/batches/${batchId}/members`).then((d) => setMembers(activeOnly(d.items))).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, [batchId]);

  async function update(m: any, patch: any) {
    try {
      const res = await api(`/api/members/${m._id}`, { method: "PATCH", json: patch });
      setMembers((ms) => ms.map((x) => (x._id === m._id ? { ...x, ...res.item } : x)));
    } catch (e: any) { setError(e.message); }
  }
  const toggleSel = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pending = members.filter((m) => m.enrollment_status !== "Completed");
  async function bulk(step: string) {
    if (bulkBusy) return;
    const targets = selected.size ? [...selected] : pending.map((m) => m._id);
    if (!targets.length) return;
    const what = step === "all" ? "complete enrollment (all three steps)" : `mark ${step === "reg_done" ? "Registration" : step === "kyc_done" ? "e-KYC" : "Batch Accept"}`;
    if (!confirm(`${what} for ${targets.length} candidate${targets.length > 1 ? "s" : ""}?`)) return;
    setBulkBusy(true); setBulkMsg("");
    try {
      const r = await api(`/api/batches/${batchId}/members/bulk-enroll`, { method: "POST", json: { step, member_ids: targets } });
      setBulkMsg(`${r.updated} updated${r.skipped ? `, ${r.skipped} already done` : ""}${r.failed?.length ? `, ${r.failed.length} failed` : ""}`);
      setSelected(new Set());
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setBulkBusy(false); }
  }

  if (!members.length) return <p className="p-6 text-center text-sm text-gray-400">No active members to enroll.</p>;
  const done = members.filter((m) => m.enrollment_status === "Completed").length;
  const scope = selected.size ? `${selected.size} selected` : `all ${pending.length} pending`;
  const cur = members[Math.min(idx, members.length - 1)];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-600">
        <span>{done}/{members.length} enrolled · Failed: {members.filter((m) => m.enrollment_status === "Failed").length}</span>
        {bulkMsg && <span className="text-green-700">✓ {bulkMsg}</span>}
      </div>
      {/* QA-147: bulk actions — the 135-click wall becomes three clicks (or one). */}
      {pending.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs">
          <span className="font-medium text-blue-900">Bulk ({scope}):</span>
          <Btn small kind="ghost" disabled={bulkBusy} onClick={() => bulk("reg_done")}>Mark Registration</Btn>
          <Btn small kind="ghost" disabled={bulkBusy} onClick={() => bulk("kyc_done")}>Mark e-KYC</Btn>
          <Btn small kind="ghost" disabled={bulkBusy} onClick={() => bulk("accept_done")}>Mark Batch Accept</Btn>
          <Btn small disabled={bulkBusy} onClick={() => bulk("all")}>{bulkBusy ? "Working…" : "Complete enrollment"}</Btn>
          <button className="ml-auto text-blue-700 underline" onClick={() => setSelected(selected.size === pending.length ? new Set() : new Set(pending.map((m) => m._id)))}>
            {selected.size === pending.length ? "Clear selection" : "Select all pending"}
          </button>
        </div>
      )}
      {/* Desktop: all cards. Mobile: one at a time with prev/next (spec §0 Rule B) */}
      <div className="hidden gap-3 md:grid md:grid-cols-2 xl:grid-cols-3">
        {members.map((m) => <EnrolCard key={m._id} m={m} onUpdate={update} selected={selected.has(m._id)} onSelect={toggleSel} />)}
      </div>
      <div className="md:hidden">
        <EnrolCard m={cur} onUpdate={update} selected={selected.has(cur._id)} onSelect={toggleSel} />
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
// ---------- Attendance tab (R-D, CEO 14/08 [34:02, 41:50, 42:15]) ----------
// "One more tab as attendance only … day-wise a person should be able to see the
// attendance … show them two types: the one they are taking and the government portal's —
// days AND hours — and once the hours threshold is crossed, mark that child GREEN:
// qualified for assessments." Visible to every login that can open the batch.

// -208: the portal-ID gap, as one component. It fetches its own picture, names every student the
// certification gate is blocked on, and takes the ID typed straight from SIDH - through the ordinary
// candidate door, the same one the Candidates drawer uses. Mounted on Certificates and on Attendance.
//
// It renders NOTHING when there is no gap. A panel that says "0 students are missing an ID" is noise
// on the screen of a centre that has nothing to fix.
function PortalIdGaps({ batchId, onChanged }: any) {
  const [plan, setPlan] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState("");
  // QA-770 (-215, checker on live -213): most of these students are not missing an ID at all - it is
  // sitting in the WRONG FIELD. 57 candidates system-wide carry a CAN-shaped value in `id_reference`
  // (which the model USED TO call "government ID reference, NOT the Aadhaar number itself" — until
  // 2026-08-24, when Umesh reversed that and `aadhaar_no` became its own field; `id_reference` is now
  // "some other government ID", neither Aadhaar nor the portal CAN id) with
  // `sidh_candidate_id` empty - and TEN of them are on AVP-GURU-RPLAVP-DST-02, the batch this whole
  // week has been about. Umesh has been told ten IDs are missing; ten of them are already here.
  //
  // The remedy was BUILT (portal-id-health's `misfiled` bucket, REQ-381) and nobody ran it, because
  // it lives on the Candidates screen and the person with the problem is standing on the BATCH
  // screen. Same shape as everything else this week: the capability exists where the pain is not.
  // So this surfaces it here. It is the existing door, unchanged - only ever fills an EMPTY
  // sidh_candidate_id, and re-checks the plan at apply time, so a value that appeared in between is
  // refused rather than overwritten.
  const [health, setHealth] = useState<any>(null);
  const [moving, setMoving] = useState(false);
  // QA-775 (-216, checker on qa-215): the apply needs `candidates.manage` at EDIT. Both GETs behind
  // this panel need only read, so a Location or Operations login whose edit right has been revoked
  // saw the banner and the button and got 403 on press - the fourth outing of the dead-button class
  // (QA-712, QA-723, QA-754). Same pattern as `canImport` a hundred lines up this file: while the
  // rights are still loading assume yes, so the control does not flicker away from someone who has it.
  const { can: canPerm, loaded: permsReady } = usePerms();
  const canMove = !permsReady || canPerm("candidates.manage", "edit");
  const load = () => Promise.all([
    api(`/api/batches/${batchId}/link-portal-ids`).then(setPlan).catch(() => setPlan(null)),
    // QA-776: narrowed by the SERVER now (`?batch=`), not by an intersection in the browser. The
    // client-side filter below stays as a second belt, but the thing that decides whose students
    // these are is a query this suite can actually test.
    api(`/api/candidates/portal-id-health?batch=${batchId}`).then(setHealth).catch(() => setHealth(null)),
  ]);
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [batchId]);

  // Only the misfiled rows that belong to THIS batch's blocked students - the health screen is
  // system-wide and a centre must not be offered someone else's roster to fix from here.
  const blockedIds = new Set((plan?.missing ?? []).map((m: any) => String(m.candidate)).filter(Boolean));
  const recoverable: any[] = ((health?.misfiled ?? []) as any[]).filter((m) => blockedIds.has(String(m.candidate)));

  async function moveMisfiled() {
    if (moving || !recoverable.length) return;
    setMoving(true); setErr("");
    try {
      const asked = recoverable.length;
      const res = await api("/api/candidates/portal-id-health", { method: "POST", json: { copy: recoverable.map((m) => String(m.candidate)) } });
      // QA-774 (-216, checker on qa-215, S2): this read `res?.results?.refused`. The endpoint returns
      // `{set_null, copied, rematched, refused}` UNWRAPPED (`route.ts:219`), so the branch below was
      // unreachable code: the checker pressed "Move 5" against a stale plan, the server correctly
      // moved 4 and refused 1, and THE SCREEN SAID NOTHING - the banner simply vanished. A partial
      // refusal reaching the operator as silence is the same defect as a sentence that is not true.
      const refused = (res?.refused ?? res?.results?.refused ?? []) as string[];
      const copied = Number(res?.copied ?? res?.results?.copied ?? 0);
      if (refused.length) {
        setErr(`${copied} of ${asked} moved. ${refused.length} left untouched — ${refused[0]}`);
      } else if (copied < asked) {
        setErr(`${copied} of ${asked} moved. The rest already had an ID by the time this ran.`);
      }
      await load(); onChanged?.();
    } catch (e: any) { setErr(e.message); }
    setMoving(false);
  }

  async function save(candidateId: string, rawId: string) {
    const v = String(rawId ?? "").trim();
    if (!v || !candidateId) return;
    setSaving(candidateId); setErr("");
    try {
      await api(`/api/candidates/${candidateId}`, { method: "PATCH", json: { sidh_candidate_id: v } });
      setDraft((d) => { const n = { ...d }; delete n[candidateId]; return n; });
      await load();
      onChanged?.();
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setSaving(null); }
  }

  const gaps = plan?.missing ?? [];
  if (!plan || gaps.length === 0) return null;

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <b>{plan.blocking ?? gaps.length} student{(plan.blocking ?? gaps.length) === 1 ? " has" : "s have"} no portal Candidate ID.</b>{" "}
      Certification cannot complete until every one of them does.
      <button type="button" onClick={() => setOpen((v) => !v)} className="ml-1 font-semibold underline">
        {open ? "hide the list" : `show which ${gaps.length}`}
      </button>
      {err && <div className="mt-1 text-red-700">{err}</div>}
      {/* QA-770: the good news first, because it changes what the person does next. */}
      {recoverable.length > 0 && canMove && (
        <div className="mt-2 rounded-lg border border-green-300 bg-green-50 px-2.5 py-2 text-green-900">
          <b>{recoverable.length} of them already have an ID — it is filed in the wrong place.</b>{" "}
          The value is sitting in that candidate&rsquo;s <span className="font-mono">ID reference</span> field,
          which is not the field certification reads. Nothing has to be typed.
          <div className="mt-1 font-mono text-[11px]">
            {/* REQ-389 / QA-476: through personLabel, never a bare name - this very batch has two
                Sachin Kumars, and a list of bare names would offer the operator two identical rows. */}
            {recoverable.slice(0, 4).map((m: any) => personLabel({ name: m.name, phone: m.phone, sidh_candidate_id: m.can })).join("  ·  ")}
            {recoverable.length > 4 ? `  ·  +${recoverable.length - 4} more` : ""}
          </div>
          <button type="button" onClick={moveMisfiled} disabled={moving}
            className="mt-1.5 rounded-lg bg-green-700 px-2.5 py-1 font-medium text-white hover:bg-green-800 disabled:bg-green-300">
            {moving ? "Moving…" : `Move ${recoverable.length} into the portal ID field`}
          </button>
          <div className="mt-1 text-[11px] text-green-800">
            Only fills an empty portal ID — an ID already on record is never overwritten, and every move is recorded.
          </div>
        </div>
      )}
      {open && (
        <div className="mt-2 space-y-1 rounded-lg border border-gray-200 bg-white p-2">
          <div className="text-[11px] text-gray-500">Type the portal Candidate ID from SIDH and press Save. The count above recounts itself.</div>
          {gaps.map((m: any) => (
            <div key={m.member} className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-1 text-xs first:border-t-0">
              <span className="min-w-[9rem] font-medium text-gray-800">{m.name}</span>
              <span className="text-gray-500">{m.phone ?? "no phone"}</span>
              <span className={m.result === "Pass" ? "text-green-700" : m.result === "Pending" ? "text-amber-700" : "text-gray-500"}>{m.result}</span>
              {/* QA-710 (-209, checker on qa-207): this branch was UNREACHABLE and I claimed it as
                  delivered in a manifest and a commit message. `enrolledWithoutCan` filters
                  `m.candidate &&`, so a roster row whose candidate record is gone never enters this
                  list at all — which is also why it cannot block the gate, and why the count it was
                  written to explain (QA-701) stopped being possible the moment the list started
                  coming from that function. It is kept, narrowed to a guard rather than a promise:
                  if the payload ever does carry such a row, this says so instead of rendering a box
                  that would save nowhere. The claim that it was a delivered feature is withdrawn. */}
              {/* QA-725 (-212, checker on qa-210): a student who HOLDS an id this system cannot read
                  used to render exactly like a student who holds nothing — blank box, no
                  explanation — so the operator retyped what was already there and the row did not
                  move. `normalizeCan` reads only the digits after CAN, so `CAN_ED0711202` and
                  `CAN_CHK208A` are both stored, both valid to the door that accepted them, and both
                  invisible to the gate. Widening the matcher is QA-719 and is Umesh's call; until
                  then this row says what is on record and that it cannot be read. */}
              {m.unreadable && (
                <span className="rounded bg-amber-50 px-1.5 py-0.5 text-amber-800" title="Stored on this candidate, but the certification gate cannot read it as a portal ID.">
                  on record: <span className="font-mono">{m.on_record}</span> — not readable as a portal ID
                </span>
              )}
              {!m.candidate ? (
                <span className="text-amber-700">no candidate record on this row — nothing to write an ID onto</span>
              ) : (<>
                <input className="w-40 rounded-lg border border-gray-300 px-2 py-1 text-xs" placeholder={m.unreadable ? "replace it…" : "CAN_…"}
                  value={draft[m.candidate] ?? ""}
                  onChange={(e) => setDraft({ ...draft, [m.candidate]: e.target.value })}
                  onKeyDown={(e) => { if (e.key === "Enter") save(m.candidate, draft[m.candidate] ?? ""); }} />
                <button type="button" onClick={() => save(m.candidate, draft[m.candidate] ?? "")}
                  disabled={saving === m.candidate || !(draft[m.candidate] ?? "").trim()}
                  className="rounded-lg bg-blue-600 px-2.5 py-1 font-medium text-white hover:bg-blue-700 disabled:bg-blue-300">
                  {saving === m.candidate ? "Saving…" : "Save"}
                </button>
              </>)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AttendanceTab({ batchId, batch, role, error, setError, onGo }: any) {
  const [data, setData] = useState<any>(null);
  const load = () => api(`/api/batches/${batchId}/attendance`).then(setData).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, [batchId]); // eslint-disable-line react-hooks/exhaustive-deps
  // -82 (Umesh, 15/08): "batch ke andar Attendance tab se bhi us batch ki attendance fill karne
  // ka option, that too bulk." A date-range × roster grid: every cell starts Present, the
  // operator unticks absentees, one save posts every day through the same per-day rules
  // (POST /logs/bulk → createDailyLogChecked). Admin/Ops/Trainer (batches.daily_log);
  // Trainer's Rule 53 window still applies per day and is reported per day.
  const canMark = role === "Admin" || role === "Operations" || role === "Trainer";
  const { can, loaded: permsLoaded } = usePerms(); // -107: the portal-sheet door follows the RIGHT
  const batchActive = ["Active", "Closing"].includes(batch?.status);
  const todayKey = istTodayInput();
  const [grid, setGrid] = useState<null | { from: string; to: string; trainer_present: boolean; absent: Record<string, Set<string>> }>(null);
  const [gridBusy, setGridBusy] = useState(false);
  const [gridResult, setGridResult] = useState<any[] | null>(null);
  const operating: number[] = batch?.program?.operating_days ?? [1, 2, 3, 4, 5, 6];
  const loggedDays = new Set<string>((data?.days ?? []).map((d: string) => String(d).slice(0, 10)));
  // -102, Manish 17/08 ([00:55] "mark attendance bulk wala… ye kaise kaam kar raha hai nahi
  // pata, no open days in this range" on 17→17): the range was empty because the trainer had
  // ALREADY logged 17/08 — correct behaviour, but the tool opened and then said nothing useful.
  // The walk now records WHY each day was left out, so the panel can name the reason instead of
  // reporting an empty result.
  const walkRange = (from: string, to: string) => {
    const open: string[] = [];
    const skipped: { day: string; reason: string }[] = [];
    if (!from || !to || from > to) return { open, skipped };
    const cur = new Date(from + "T00:00:00Z");
    const end = new Date(to + "T00:00:00Z");
    let guard = 0;
    while (cur <= end && open.length < 31 && guard++ < 400) {
      const k = cur.toISOString().slice(0, 10);
      const dow = cur.getUTCDay();
      if (k > todayKey) skipped.push({ day: k, reason: "in the future" });
      else if (!operating.includes(dow)) skipped.push({ day: k, reason: "not an operating day for this programme" });
      else if (loggedDays.has(k)) skipped.push({ day: k, reason: "already logged" });
      else open.push(k);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return { open, skipped };
  };
  const gridWalk = walkRange(grid?.from ?? "", grid?.to ?? "");
  const gridDays: string[] = gridWalk.open;
  // Every operating day this batch has actually run that still has no log — what the bulk tool
  // exists for. Empty means there is nothing to bulk-mark, and the button says so up front
  // rather than opening onto a dead range.
  const openBacklog: string[] = batch?.actual_start
    ? walkRange(String(batch.actual_start).slice(0, 10), todayKey).open
    : [];
  const activeMembers = activeOnly(data?.members ?? []);
  // Shipped by the attendance route since A-04/A-05 (roster_count / left_count) - this tab hides the
  // departed rows now, so it counts what it SHOWS and states the rest in words below the chips.
  const leftCount: number = data?.left_count ?? 0;
  const toggleAbsent = (day: string, memberId: string) => {
    if (!grid) return;
    const next = { ...grid, absent: { ...grid.absent } };
    const set = new Set(next.absent[day] ?? []);
    if (set.has(memberId)) set.delete(memberId); else set.add(memberId);
    next.absent[day] = set;
    setGrid(next);
  };
  const setDay = (day: string, allPresent: boolean) => {
    if (!grid) return;
    const next = { ...grid, absent: { ...grid.absent } };
    next.absent[day] = allPresent ? new Set() : new Set(activeMembers.map((m: any) => m.member_id));
    setGrid(next);
  };
  async function saveGrid() {
    if (!grid || !gridDays.length) return;
    setGridBusy(true); setGridResult(null);
    try {
      const days = gridDays.map((day) => ({
        log_date: day,
        trainer_present: grid.trainer_present,
        present_member_ids: activeMembers.map((m: any) => m.member_id).filter((id: string) => !(grid.absent[day]?.has(id))),
      }));
      const res = await api(`/api/batches/${batchId}/logs/bulk`, { method: "POST", json: { days } });
      setGridResult(res.results ?? []);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setGridBusy(false); }
  }
  // QA-151 (Umesh, 15/08 — Gurugram DST-02): "Attendance tab me upload ka option nahi hai,
  // blank hai." The batch-scoped bulk importer (?batch=, preview → confirm) was fully built
  // and its only button sat inside Daily Execution, which stays locked until the batch is
  // Active — so on every Planning/Ready batch the one control that does the job was
  // invisible while the tab NAMED Attendance showed a read-only table of zeros. Same link,
  // same condition, here, in every batch status.
  // -107: that condition was the ROLE while the API has always read the PERMISSION
  // (`requirePerm(user, "attendance.govt")`), so granting a trainer the right changed nothing on
  // screen — Anuj Kumar carries it on production and never saw a button. The right decides now.
  const canImport = !permsLoaded || can("attendance.govt", "edit");
  const importLink = canImport ? (
    <a className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700" href={`${BASE_PATH}/govt-attendance?batch=${batchId}`}>
      ⬆ Upload attendance sheet (bulk)
    </a>
  ) : null;
  if (!data) return <p className="p-6 text-center text-sm text-gray-400">Loading…</p>;
  if (!data.members?.length) return (
    <div className="space-y-3">
      {importLink && <div className="flex justify-end">{importLink}</div>}
      <p className="p-6 text-center text-sm text-gray-400">No students on the roster yet.</p>
    </div>
  );
  // A roster that is entirely departed is NOT an empty roster, and the two must not say the same
  // thing. The government-attendance route carries a whole separate flag for this state
  // (roster_is_empty vs roster_all_departed) because one boolean answering both questions gave the
  // wrong answer three releases running. Without this branch, hiding the departed rows would leave a
  // headed table with nothing under it - the shape QA-1145 shipped in.
  if (!activeMembers.length) return (
    <div className="space-y-3">
      {importLink && <div className="flex justify-end">{importLink}</div>}
      <p className="p-6 text-center text-sm text-gray-400">
        Everyone on this batch{String.fromCharCode(8217)}s roster has left. Their records are on the Candidates tab.
      </p>
      {onGo && <div className="flex justify-center"><Btn small kind="ghost" onClick={() => onGo("Candidates")}>Open Candidates</Btn></div>}
    </div>
  );
  const portalAsOf = activeMembers.map((m: any) => m.govt?.as_of).filter(Boolean).sort().pop();
  return (
    <div className="space-y-3">
      {/* -208 (Umesh, 23/08): "even attendance wale tab me bhi vo kar de". Same component as the
          Certificates tab, mounted where the centre works every day - one widget, two homes. It
          renders nothing when there is no gap. */}
      <PortalIdGaps batchId={batchId} onChanged={load} />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-gray-100 px-2 py-0.5">Programme: {data.program_hours} hrs</span>
        <span className="cursor-help rounded-full bg-gray-100 px-2 py-0.5" title={`${data.min_attendance_pct}% of programme hours. Hours come from the government portal once an import is matched; until then they are estimated from our daily logs × the batch slot. The portal meter is what the assessor settles against.`}>Needed for assessment: {data.required_hours} hrs</span>
        {/* QA-159 (-86, checker): "0 days logged" next to 13 portal working days read as a lie —
            two meters, named apart: OUR day-wise logs vs the PORTAL's cumulative import. */}
        <span className="rounded-full bg-gray-100 px-2 py-0.5" title="Day-wise logs marked in this system (Daily Execution / bulk grid)">Our logs: {data.days_held} day{data.days_held === 1 ? "" : "s"}</span>
        {(() => {
          const withPortal = activeMembers.filter((m: any) => m.govt);
          const wd = Math.max(0, ...withPortal.map((m: any) => Number(m.govt?.working_days ?? 0)));
          return withPortal.length
            ? <span className="rounded-full bg-blue-50 px-2 py-0.5 text-blue-700" title="Skill India portal export, cumulative per student">Portal: {wd || "?"} working day{wd === 1 ? "" : "s"} · {withPortal.length}/{activeMembers.length} students · as of {fmtDate(portalAsOf)}</span>
            : <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-500">Portal: not imported yet</span>;
        })()}
        <span className="rounded-full bg-green-100 px-2 py-0.5 font-medium text-green-700">{data.qualified_count} qualified for assessments</span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {/* -102: the button knows whether there is anything to mark, and opens ON the backlog
              (earliest unlogged operating day → today) rather than on a range that may be empty. */}
          {canMark && batchActive && !grid && (openBacklog.length > 0 ? (
            <button className="rounded-lg border border-blue-600 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-50"
              title={`${openBacklog.length} operating day${openBacklog.length === 1 ? "" : "s"} still unlogged, from ${fmtDate(openBacklog[0])}`}
              onClick={() => { setGridResult(null); setGrid({ from: openBacklog[0], to: todayKey, trainer_present: true, absent: {} }); }}>
              ✎ Mark attendance (bulk) — {openBacklog.length} day{openBacklog.length === 1 ? "" : "s"} open
            </button>
          ) : (
            <span className="text-gray-400" title="The bulk tool only creates missing days; changing a day that is already logged is an audited edit, which happens in Daily Execution.">
              ✓ Every operating day up to today is logged — corrections go through Daily Execution.
            </span>
          ))}
          {canMark && !batchActive && (
            <span className="text-gray-400" title="Daily logs are only taken on a running batch">Start the batch (Overview → Start Batch) to mark day-wise attendance.</span>
          )}
          {!canMark && <span className="text-gray-400">Day-wise marking is done by the trainer / Operations.</span>}
          {importLink}
        </span>
      </div>
      {/* 2026-08-25 (Umesh, on Ashish Rana / AVP-GURU-RPLAVP-DST-03): "log rakho candidate wale mai
          but baaki jagah se tho data naa dikhee." The departed rows are gone from the table below,
          so every number on this tab now counts 54 where it used to count 55 - and the Candidates
          tab still says "55 total". A screen that quietly drops a person and never says so is how
          three separate counting defects got filed in one week (the buckets summed to one less than
          the chip above them and there was no bucket to put that person in). The row leaves; the
          FACT stays, in words, with somewhere to go and read it. */}
      {leftCount > 0 && (
        <p className="text-[11px] text-gray-500">
          {leftCount} student{leftCount === 1 ? "" : "s"} left this batch and {leftCount === 1 ? "is" : "are"} not shown
          here — their record{leftCount === 1 ? " is" : "s are"} on the Candidates tab
          {onGo && <> · <button type="button" className="underline hover:text-gray-700" onClick={() => onGo("Candidates")}>open it</button></>}
        </p>
      )}
      {grid && (
        <div className="space-y-2 rounded-xl border border-blue-200 bg-blue-50/50 p-3">
          <div className="flex flex-wrap items-end gap-3 text-xs">
            <label className="flex flex-col gap-1">From
              <input type="date" className="rounded-lg border border-gray-300 px-2 py-1" value={grid.from} max={todayKey} min={batch?.actual_start ? String(batch.actual_start).slice(0, 10) : undefined} onChange={(e) => setGrid({ ...grid, from: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1">To
              <input type="date" className="rounded-lg border border-gray-300 px-2 py-1" value={grid.to} max={todayKey} onChange={(e) => setGrid({ ...grid, to: e.target.value })} />
            </label>
            <label className="flex items-center gap-1 pb-1"><input type="checkbox" checked={grid.trainer_present} onChange={(e) => setGrid({ ...grid, trainer_present: e.target.checked })} /> Trainer present</label>
            <span className="pb-1 text-gray-500">{gridDays.length} day{gridDays.length === 1 ? "" : "s"} to mark · everyone starts Present — untick the absentees{role === "Trainer" ? " · as a trainer you may mark only today/yesterday" : ""}</span>
            {/* -102: the reasons sit WITH the range inputs, so a range that yields nothing
                explains itself before the user goes looking for the grid. */}
            {gridWalk.skipped.length > 0 && (
              <span className="basis-full pb-0.5 text-[11px] text-gray-500">
                Left out of this range: {["already logged", "not an operating day for this programme", "in the future"]
                  .map((reason) => {
                    const days = gridWalk.skipped.filter((s) => s.reason === reason).map((s) => s.day);
                    if (!days.length) return null;
                    return `${days.length} ${reason} (${days.slice(0, 4).map((d) => d.slice(8, 10) + "/" + d.slice(5, 7)).join(", ")}${days.length > 4 ? `, +${days.length - 4}` : ""})`;
                  }).filter(Boolean).join(" · ")}
              </span>
            )}
            <span className="ml-auto flex gap-2 pb-0.5">
              <Btn small disabled={gridBusy || !gridDays.length} onClick={saveGrid}>{gridBusy ? "Saving…" : `Save ${gridDays.length} day${gridDays.length === 1 ? "" : "s"}`}</Btn>
              <Btn small kind="ghost" onClick={() => { setGrid(null); setGridResult(null); }}>Close</Btn>
            </span>
          </div>
          {gridDays.length === 0 && (
            <p className="text-xs text-amber-700">
              Nothing to create in this range — this tool only <b>adds</b> missing days.{" "}
              {gridWalk.skipped.some((s) => s.reason === "already logged")
                ? <>Every operating day here is already logged. To change one, open it in <b>Daily Execution</b> above — pick the date and its ticks come up as recorded (the edit is audited).</>
                : <>The dates picked hold no operating day for this programme.</>}
              {openBacklog.length > 0 && <> The earliest day still unlogged is <b>{fmtDate(openBacklog[0])}</b>.</>}
            </p>
          )}
          {gridDays.length > 0 && (
            <div className="overflow-x-auto">
              <table className="text-xs">
                <thead>
                  <tr>
                    <th className="sticky left-0 bg-blue-50/50 px-2 py-1 text-left">Candidate</th>
                    {gridDays.map((d) => (
                      <th key={d} className="px-1 py-1 text-center font-medium">
                        <div>{d.slice(8, 10)}/{d.slice(5, 7)}</div>
                        <div className="text-[10px] font-normal text-gray-500">
                          <button className="underline" onClick={() => setDay(d, true)}>all</button>{" · "}<button className="underline" onClick={() => setDay(d, false)}>none</button>
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {activeMembers.map((m: any) => (
                    <tr key={m.member_id} className="border-t">
                      <td className="sticky left-0 bg-white px-2 py-1 whitespace-nowrap">{m.name}</td>
                      {gridDays.map((d) => (
                        <td key={d} className="px-1 py-1 text-center">
                          <input type="checkbox" checked={!(grid.absent[d]?.has(m.member_id))} onChange={() => toggleAbsent(d, m.member_id)} title={`${m.name} — ${d}`} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {gridResult && (
            <ul className="space-y-0.5 text-xs">
              {gridResult.map((r: any) => (
                <li key={r.log_date} className={r.status === "created" ? "text-green-700" : r.status === "exists" ? "text-gray-500" : "text-red-700"}>
                  {r.log_date}: {r.status === "created" ? "saved" : r.status === "exists" ? "already logged — edit in Daily Execution" : r.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <DataTable rows={activeMembers}
        cardTitle={(r: any) => r.name}
        defaultSort={{ key: "name", dir: "asc" }}
        columns={[
          // -161 (QA-430, open since 2026-08-20 and the line REQ-389 was written FROM): a candidate
          // with no portal ID got nothing beneath their name, so two students of one name rendered
          // identically on the one screen that shows hours per person. The separator falls back the
          // way the requirement says: portal ID, otherwise phone.
          // QA-754: "even attendance wale tab me bhi wo kar de". `personSeparator` falls back to the
          // PHONE when there is no portal ID, so this column showed a phone for a student with no id
          // and showed an unreadable id exactly like a good one - the two states this whole thread is
          // about were the two it could not tell apart. The chip says which.
          {
            key: "name", label: "Name", sortable: true,
            render: (r: any) => (
              <div className="flex flex-wrap items-center gap-1.5">
                <NameCell name={r.name} sub={personSeparator(r) || undefined} />
                <PortalIdChip value={r.sidh_candidate_id} className="shrink-0" />
              </div>
            ),
          },
          { key: "internal_days", label: "Our days", sortable: true, render: (r: any) => `${r.internal_days} / ${data.days_held}` },
          {
            // QA-086: our own hours get their own column, on the same footing as the
            // portal's. No slot on the batch = no estimate (QA-085), said out loud.
            key: "our_hours", label: "Our hours", sortValue: (r: any) => r.our_hours ?? -1, sortable: true,
            render: (r: any) => r.our_hours != null
              ? <span title="Our days × the batch slot — an estimate, not the portal meter">{r.our_hours} hrs <span className="text-[10px] text-gray-400">est.</span></span>
              : <span className="text-gray-400" title="No time slot on the batch — hours cannot be estimated">—</span>,
          },
          { key: "govt_days", label: "Govt days", sortValue: (r: any) => r.govt?.days_present ?? -1, sortable: true, render: (r: any) => r.govt ? `${r.govt.days_present ?? "—"}${r.govt.working_days ? ` / ${r.govt.working_days}` : ""}` : <span className="text-gray-400" title="No matched portal import yet">—</span> },
          { key: "govt_hours", label: "Govt hours", sortValue: (r: any) => r.govt?.hours ?? -1, sortable: true, render: (r: any) => r.govt?.hours != null ? `${r.govt.hours} hrs` : <span className="text-gray-400">—</span> },
          {
            // -251 (voice note 26-Aug, matched to the govt AEBAS export's own "Hours Attendance %"
            // column): govt hours attended over the programme's total hours — a progress %, not the
            // assessment-eligibility threshold (data.required_hours, used by the Assessment column below).
            key: "govt_hours_pct", label: "Hours Attendance %", sortValue: (r: any) => r.govt?.hours != null && data.program_hours ? Math.round((100 * r.govt.hours) / data.program_hours) : -1, sortable: true,
            render: (r: any) => r.govt?.hours != null && data.program_hours
              ? <span className="text-xs tabular-nums">{Math.round((100 * r.govt.hours) / data.program_hours)}%</span>
              : <span className="text-gray-400" title="No matched portal import yet">—</span>,
          },
          {
            // -251: same sheet's "Days Attendance %" — govt days present over the programme's total
            // training days (data.program_days, the sync source's "duration_days").
            key: "govt_days_pct", label: "Days Attendance %", sortValue: (r: any) => r.govt?.days_present != null && data.program_days ? Math.round((100 * r.govt.days_present) / data.program_days) : -1, sortable: true,
            render: (r: any) => r.govt?.days_present != null && data.program_days
              ? <span className="text-xs tabular-nums">{Math.round((100 * r.govt.days_present) / data.program_days)}%</span>
              : <span className="text-gray-400" title="No matched portal import yet">—</span>,
          },
          {
            // QA-085: the green mark is PORTAL-VERIFIED only — an estimate can never
            // qualify a student, and the chip says which meter it is reading.
            key: "qualified", label: "Assessment", sortable: true, sortValue: (r: any) => (r.qualified ? 1 : 0),
            // -153 (QA-393): the awaiting_match arm sits AHEAD of the estimate arm and links to
            // the one screen that clears it. The complaint this closes was that the operator was
            // told to go and fetch a file that had already been imported three times.
            filterText: (r: any) => (r.qualified ? "Qualified" : r.basis === "portal" ? "Below threshold" : r.awaiting_match ? "Match pending" : "Awaiting portal hours"),
            // 2026-08-25: a "Dropout" arm used to sit here, rendering a MEMBERSHIP fact inside the
            // ELIGIBILITY column - the one place on this screen that says whether a student may sit
            // the assessment. It is gone with the rows it described: this table shows the active
            // roster only. It was already half-broken, which is the part worth recording - filterText
            // directly above has no Dropout branch, so the funnel filter and the chip gave a departed
            // row two different answers. Do not re-add it here; the departed member is named in the
            // line under the chips, and their record is on the Candidates tab.
            render: (r: any) => r.qualified
                ? <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-700" title={`Portal-verified: ${r.govt?.hours} of ${data.required_hours} hrs`}>✓ Qualified for assessments</span>
                : r.basis === "portal"
                  ? <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600" title="Portal hours below the threshold">{r.attended_hours} / {data.required_hours} hrs</span>
                  : r.awaiting_match
                    ? <Link href="/govt-attendance" className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 hover:underline" title={r.verdict?.state === "awaiting_match" ? r.verdict.detail : `The government export carries ${(r.awaiting_match?.count ?? 1) > 1 ? `${r.awaiting_match.count} rows` : "a row"} under this name, not attached to a student yet. Resolve it on the Government Attendance screen.`}>Portal hours waiting on a match →</Link>
                  : r.basis === "estimate"
                    ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700" title="Estimated from our days × slot — the verdict waits for portal hours">~{r.attended_hours} / {data.required_hours} hrs (est.)</span>
                    : <span className="rounded-full bg-gray-50 px-2 py-0.5 text-[11px] text-gray-400" title="No portal import and no slot on the batch">awaiting portal hours</span>,
          },
          {
            key: "_days", label: "Day-wise", mobile: false,
            render: (r: any) => (
              <div className="flex max-w-[260px] gap-0.5 overflow-x-auto" title="Our daily logs, oldest first">
                {r.present_by_day.map((p: boolean, i: number) => (
                  <span key={i} title={fmtDate(data.days[i])}
                    className={`inline-block h-3 w-3 shrink-0 rounded-sm ${p ? "bg-green-500" : "bg-gray-200"}`} />
                ))}
              </div>
            ),
          },
        ]} empty="No students on this batch’s active roster." />
    </div>
  );
}

function DailyExecution({ batchId, batch, role, error, setError }: any) {
  const canMark = role !== "Location";
  // -107: the bulk portal-sheet link is gated on the RIGHT, matching the API.
  const { can: canPerm, loaded: permsReady } = usePerms();
  const canImportSheet = !permsReady || canPerm("attendance.govt", "edit");
  const [logs, setLogs] = useState<any[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [form, setForm] = useState<any>({ log_date: toInputDate(new Date()), present: new Set<string>(), biometric: new Set<string>(), photos: [], videos: [] });
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(0);
  const [editLog, setEditLog] = useState<any>(null);
  const [roundLog, setRoundLog] = useState<any>(null); // "mark another round" target (Karunn: P-P-P multiple times a day)

  const [loaded, setLoaded] = useState(false);
  const [uploadNote, setUploadNote] = useState(""); // -87: "photo.jpg: 3.8 MB → 420 KB"
  const [recOpen, setRecOpen] = useState(false); // -91: in-app recorder
  const load = () => Promise.all([
    api(`/api/batches/${batchId}/logs`).then((d) => setLogs(d.items)),
    api(`/api/batches/${batchId}/members`).then((d) => setMembers(activeOnly(d.items))),
  ]).catch((e: any) => setError(e.message)).finally(() => setLoaded(true));
  useEffect(() => { load(); setQueued(getQueue(batchId).length); }, [batchId]); // eslint-disable-line react-hooks/exhaustive-deps

  // -102, Manish 17/08 ([02:13] "agar wo 17 ke date me hi 2:12 koi photo dalna chahta hai… un
  // logo ko phir se wo check-in yaha karega?" → [02:23] "pehle se hi pre-check aane chahiye"):
  // the panel always opened blank, so adding a second photo at 2pm meant re-ticking all 45
  // students — and the day they had already marked lived only behind Edit in History.
  // Now the panel READS the day it is pointed at: an already-logged date arrives with its
  // present/biometric ticks, topics and trainer flag in place, and Save updates that day
  // instead of trying to create a second one. Photos and videos stay empty on purpose — they
  // APPEND to the day's existing media, they are not re-picked.
  const dayLog = logs.find((l: any) => String(l.log_date).slice(0, 10) === form.log_date) ?? null;
  const [seeded, setSeeded] = useState<string>(""); // "<logId>@<date>" already seeded — don't clobber edits
  useEffect(() => {
    const stamp = dayLog ? `${dayLog._id}@${form.log_date}` : `none@${form.log_date}`;
    if (seeded === stamp) return;
    setSeeded(stamp);
    if (dayLog) {
      setForm((f: any) => ({
        ...f,
        planned_topic: dayLog.planned_topic ?? "", actual_topic: dayLog.actual_topic ?? "",
        note: dayLog.note ?? "", trainer_present: dayLog.trainer_present !== false,
        present: new Set((dayLog.present_member_ids ?? []).map(String)),
        biometric: new Set((dayLog.biometric_member_ids ?? []).map(String)),
        photos: [], videos: [],
      }));
    } else if (seeded) {
      // moved off an already-logged day onto a fresh one — start clean rather than carrying
      // the previous day's ticks over as if they were marked.
      setForm((f: any) => ({
        log_date: f.log_date, present: new Set<string>(), biometric: new Set<string>(), photos: [], videos: [],
      }));
    }
  }, [dayLog?._id, form.log_date, logs]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // -83: every evidence upload says where it belongs — Drive folder <Centre>/<Batch>/<kind>
  // and the StoredFile entity link — and the retry queue is bound to THIS batch.
  const evidenceHints = (kind: string) => ({
    folder_centre: batch?.location?.code ?? batch?.location?.name ?? "", folder_batch: batch?.code ?? "", folder_kind: kind,
    entity: "Batch", entity_id: batchId, batch_id: batchId,
  });
  async function uploadFile(file: File, kind: "photos" | "videos" | "govt_screenshot") {
    try {
      const url = await uploadWithRetry(file, kind, evidenceHints(kind), (p) => {
        if (p.phase === "uploading") setUploadNote(`${file.name}: ${p.pct}% (${fmtBytes(p.sent)} / ${fmtBytes(p.total)}) — uploading straight to storage, resumes if the signal drops`);
        else if (p.phase === "finalising") setUploadNote(`${file.name}: confirming with storage…`);
      }); // compressed + 3 retries + per-batch offline queue; large/video → direct-to-Drive with progress
      const info = getLastUploadInfo();
      // -97 (QA-164): the screen tells the per-file truth — shrunk (how) or NOT shrunk (why).
      if (info) {
        const c = info.compression ?? "";
        const why = /\(device: ([^)]+)\)/.exec(c)?.[1] ?? (c.startsWith("none:") ? c.slice(5).trim() : "");
        setUploadNote(c && !c.startsWith("none")
          ? `${file.name}: ${fmtBytes(file.size)} → ${fmtBytes(info.size)} (${c.replace(/^client:/, "")})`
          : `⚠ ${file.name}: uploaded as recorded (${fmtBytes(info.size)}) — not compressed on this device${why ? `: ${why}` : ""}`);
      }
      if (kind === "photos") setForm((f: any) => ({ ...f, photos: [...f.photos, url] }));
      else if (kind === "videos") setForm((f: any) => ({ ...f, videos: [...f.videos, url] }));
      else setForm((f: any) => ({ ...f, govt_screenshot: url }));
    } catch (e: any) { setError(e.message); setQueued(getQueue(batchId).length); }
  }

  // -97 (Umesh: delete must work too): a wrong photo/video can be dropped BEFORE Save — the
  // object is discarded from storage (uploader-only, unreferenced), not left as an orphan.
  async function discardUpload(url: string, kind: "photos" | "videos") {
    const name = url.split("/").pop() ?? "";
    try { await api(`/api/files/${name}`, { method: "DELETE" }); }
    catch (e: any) { if (!/removed|already|not found/i.test(String(e?.message))) { setError(e.message); return; } }
    setForm((f: any) => ({ ...f, [kind]: (f[kind] as string[]).filter((u) => u !== url) }));
  }

  async function retryQueued() {
    const done = await flushQueue(batchId); // this batch's items only
    for (const d of done) {
      if (d.kind === "photos") setForm((f: any) => ({ ...f, photos: [...f.photos, d.url] }));
      else if (d.kind === "videos") setForm((f: any) => ({ ...f, videos: [...f.videos, d.url] }));
      else if (d.kind === "govt_screenshot") setForm((f: any) => ({ ...f, govt_screenshot: d.url }));
    }
    setQueued(getQueue(batchId).length);
  }

  async function save() {
    setBusy(true);
    try {
      if (dayLog) {
        // -102: the day already exists — this is an UPDATE, through the same Rule 27 door
        // Edit has always used, so no new server contract appears. Media appends to what the
        // day already holds; the ticks and topics are the panel's current state.
        await api(`/api/logs/${dayLog._id}`, {
          method: "PATCH",
          json: {
            planned_topic: form.planned_topic, actual_topic: form.actual_topic,
            present_member_ids: [...form.present],
            biometric_member_ids: [...form.biometric],
            trainer_present: form.trainer_present !== false,
            note: form.note,
            photos: [...(dayLog.photos ?? []), ...form.photos],
            videos: [...(dayLog.videos ?? []), ...form.videos],
            ...(form.govt_screenshot ? { govt_screenshot: form.govt_screenshot } : {}),
            ...(form.govt_present === "" || form.govt_present == null ? {} : { govt_present: +form.govt_present }),
          },
        });
        setSeeded(""); // force a re-seed from the freshly saved day
      } else {
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
      }
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
  // QA-070 (-70): the SHARED slot formula — this summary carried its own hours/duration-or-8
  // copy, the exact assumed-8 QA-085 removed elsewhere. No slot → no hours estimate shown.
  const hoursPerDay = slotHoursPerDay(batch);
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
            <div className="text-[11px] text-gray-400">{expDays} operating days × {roster} on roster{hoursPerDay != null ? <> · ≈{Math.round(expSD * hoursPerDay)} hrs</> : null}</div>
          </div>
          <div className={`rounded-xl border p-3 ${oursSD < expSD * 0.6 ? "border-amber-300 bg-amber-50" : "border-gray-200/80 bg-white"}`}>
            <div className="text-[11px] font-medium uppercase tracking-wider text-gray-400">Our records (trainer-marked)</div>
            <div className="text-lg font-semibold text-gray-900">{oursSD} <span className="text-xs font-normal text-gray-400">({pct(oursSD)}%)</span></div>
            <div className="text-[11px] text-gray-400">{hoursPerDay != null ? `≈${Math.round(oursSD * hoursPerDay)} hrs marked` : "no slot on the batch — hours come from the portal meter"}</div>
          </div>
          <div className={`rounded-xl border p-3 ${govtSD > oursSD ? "border-amber-300 bg-amber-50" : "border-gray-200/80 bg-white"}`}>
            <div className="text-[11px] font-medium uppercase tracking-wider text-gray-400">Govt portal</div>
            <div className="text-lg font-semibold text-gray-900">{govtSD} <span className="text-xs font-normal text-gray-400">({pct(govtSD)}%)</span></div>
            <div className="text-[11px] text-gray-400">from verified/imported days only</div>
          </div>
        </div>
      )}
      {canMark && <Section title={dayLog ? `${fmtDate(dayLog.log_date)} — already logged, update it` : "Today's entry"}>
        <div className="space-y-4">
          {/* -102: the panel says which state it is in, so nobody wonders whether saving will
              create a second entry for the same day. */}
          {dayLog && (
            <p className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
              This day is already logged — {dayLog.internal_present} of {dayLog.roster_count} present, marked{" "}
              {(dayLog.sessions ?? []).length || 1}× so far. The ticks below are what is on record; change them, or just add
              photos/videos and Save. New media is <b>added</b> to the day&apos;s {(dayLog.photos ?? []).length} photo
              {(dayLog.photos ?? []).length === 1 ? "" : "s"} and {(dayLog.videos ?? []).length} video
              {(dayLog.videos ?? []).length === 1 ? "" : "s"} — nothing is replaced. Every change is audited.
            </p>
          )}
          <div className="grid grid-cols-2 gap-3">
            {/* Rule 53 (CEO 14/08): never a future date; a Trainer gets today or yesterday
                only. The server enforces the same — this just stops the doomed attempt. */}
            <Field label="Date" required><input type="date" className={inputCls} value={form.log_date}
              max={toInputDate(new Date())}
              min={role === "Trainer" ? toInputDate(new Date(Date.now() - 86_400_000)) : undefined}
              onChange={(e) => setForm({ ...form, log_date: e.target.value })} /></Field>
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
                    {/* -161 (QA-482): the tap-present grid. Three candidates of one name rendered
                        three identical buttons, and this is the control a trainer presses to say a
                        PERSON was here - the highest-consequence place on the screen to be unable to
                        tell two people apart. It was on no ledger row at all. */}
                    <span className="min-w-0 truncate">{form.present.has(m._id) ? "✓ " : ""}{personLabel(m.candidate) || m.candidate?.name}</span>
                    <PortalIdChip candidate={m.candidate} className="shrink-0" />
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
            {/* QA-072 (CEO [39:59] "they should be able to add multiple photos"): the
                pickers take several files in one go; each uploads through the same
                compressed/retry/offline-queue path and appends to the day's arrays. */}
            <Field label={`Photos (${form.photos.length})`}>
              <input type="file" accept="image/*" capture="environment" multiple className={inputCls} onChange={(e) => { for (const f of Array.from(e.target.files ?? [])) uploadFile(f, "photos"); }} />
              <PendingMedia urls={form.photos} kind="photos" onRemove={(u) => discardUpload(u, "photos")} />
            </Field>
            <Field label={`Videos (${form.videos.length})`}>
              <input type="file" accept="video/mp4,video/*" capture="environment" multiple className={inputCls} onChange={(e) => { for (const f of Array.from(e.target.files ?? [])) uploadFile(f, "videos"); }} />
              <PendingMedia urls={form.videos} kind="videos" onRemove={(u) => discardUpload(u, "videos")} />
              {/* -91: record IN the app at the compression targets — compressed at source, nothing to
                  transcode. Gallery clips picked above are re-encoded in the browser before upload.
                  -97 (QA-164): the copy no longer promises what the device may not manage — the
                  per-file note above says what actually happened; and re-encoding runs in real time. */}
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <button type="button" className="rounded-lg border border-blue-600 px-2 py-1 font-medium text-blue-700 hover:bg-blue-50" onClick={() => setRecOpen(true)}>● Record video</button>
                <span className="text-gray-400">gallery clips are re-encoded on your phone first (takes about as long as the clip); the note above says if a clip could not be shrunk. Uploads resume if the signal drops.</span>
              </div>
            </Field>
            {/* CEO 14/08 [41:31]: "Government attendance screenshot — I don't think they
                [trainers] will have it, so they won't be able to provide." Ops/Admin keep it. */}
            {role !== "Trainer" && (
              <Field label={`Govt attendance screenshot${form.govt_screenshot ? " ✓" : ""}`}>
                <input type="file" accept="image/*" className={inputCls} onChange={(e) => e.target.files?.[0] && uploadFile(e.target.files[0], "govt_screenshot")} />
              </Field>
            )}
          </div>
          <Field label="Note"><input className={inputCls} value={form.note ?? ""} onChange={(e) => setForm({ ...form, note: e.target.value })} /></Field>
          <div className="flex items-center gap-3">
            <Btn onClick={save} disabled={busy}>{busy ? "Saving…" : dayLog ? `Update ${fmtDate(dayLog.log_date)} log` : "Save Daily Log"}</Btn>
            {uploadNote && <span className="text-xs text-gray-500" title="What the server stored (compressed at the storage door)">{uploadNote}</span>}
            <VideoRecorder open={recOpen} onClose={() => setRecOpen(false)} onRecorded={(f) => { setRecOpen(false); uploadFile(f, "videos"); }} />
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
        // -107 (Umesh 17/08): the portal-sheet door follows the `attendance.govt` RIGHT, not the
        // role. Off for the Trainer role by default, so this stays Admin/Ops work unless a specific
        // trainer is granted it — which Umesh had already done for Anuj without any door appearing.
        canImportSheet ? (
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
                {/* -98 (QA-165): a wrong day can be undone — audited, its own evidence leaves with it. */}
                <Btn small kind="ghost" onClick={async () => {
                  const reason = window.prompt(`Delete the daily log for ${fmtDate(r.log_date)}? This removes the day's attendance and its photos/videos from storage (recorded in the audit). Reason:`);
                  if (reason === null) return;
                  try { await api(`/api/batches/${batchId}/logs/${r._id}`, { method: "DELETE", json: { reason } }); load(); }
                  catch (e: any) { setError(e.message); }
                }}>Delete</Btn>
              </span>
            ) : null },
          ]} empty="No logs yet." />
      </Section>
      <LogEditDrawer log={editLog} members={members} onClose={() => setEditLog(null)} onSaved={() => { setEditLog(null); load(); }} error={error} setError={setError} />
      <RoundDrawer log={roundLog} members={members} onClose={() => setRoundLog(null)} onSaved={() => { setRoundLog(null); load(); }} error={error} setError={setError} />
    </div>
  );
}

// Karunn 2026-08-13: "din mein do baar, teen baar, jitni baar bhi P-P-P" — a fresh marking
// round for an existing day. Unions into the day server-side; timestamps kept per round.
function RoundDrawer({ log, members, onClose, onSaved, error, setError }: any) {
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
    <Drawer open onClose={onClose} title={`Marking round — ${fmtDate(log.log_date)}`} wide error={error}>
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
                {/* -212 (Umesh 23/08): "even attendance wale tab me bhi wo kar de" — the ID rides
                    the attendance row too, so a centre marking attendance sees which students the
                    portal cannot identify without leaving the screen they are already on. */}
                <PortalIdChip candidate={m.candidate} className="shrink-0" />
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
function LogEditDrawer({ log, members, onClose, onSaved, error, setError }: any) {
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
    <Drawer open onClose={onClose} title={`Edit log — ${fmtDate(log.log_date)}`} wide error={error}>
      <div className="space-y-4">
        <p className="text-xs text-gray-500">Editable for 48h by whoever entered it, anytime by Operations/Admin; every change is audited. Roster count stays at {log.roster_count}.</p>
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
                  <PortalIdChip candidate={m.candidate} className="shrink-0" />
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
// -97: what is attached to the day BEFORE it is saved — thumbnails with a ✕ each.
function PendingMedia({ urls, kind, onRemove }: { urls: string[]; kind: "photos" | "videos"; onRemove: (u: string) => void }) {
  if (!urls?.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {urls.map((u, i) => (
        <div key={u} className="relative">
          {kind === "photos"
            ? <img src={u} alt={`photo ${i + 1}`} className="h-14 w-14 rounded border object-cover" />
            : <video src={u} className="h-14 w-20 rounded border bg-black object-cover" muted playsInline preload="metadata" />}
          <button type="button" aria-label="Remove" title="Remove this file (it is deleted from storage)" onClick={() => onRemove(u)}
            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-gray-300 bg-white text-xs text-gray-700 shadow hover:bg-red-50 hover:text-red-700">✕</button>
        </div>
      ))}
    </div>
  );
}
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
      {/* -83: evidence must be VIEWABLE — a video plays here (Range-served, seekable), a
          voice note plays here; the link stays for a full-screen open. */}
      {videos.map((v, i) => /\.(m4a|mp3|wav|amr|ogg)$/i.test(v) ? (
        <audio key={v} src={v} controls preload="none" className="h-8 max-w-[160px]" title={`Voice note ${i + 1}`} />
      ) : (
        <span key={v} className="inline-flex items-center gap-1">
          <video src={v} controls preload="none" playsInline className="h-16 max-w-[120px] rounded border border-gray-200 bg-black" title={`Video ${i + 1}`} />
          <a href={v} target="_blank" rel="noreferrer" className="text-[10px] text-blue-700 underline" title="Open full size">↗</a>
        </span>
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
          <input type="file" className="hidden" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp,.heic,.xlsx,.xls,.csv" onChange={onUpload} />
        </label>
      )}
    </div>
  );
}

function ClosureTab({ batchId, batch, role, error, setError, onChanged }: any) {
  const [closure, setClosure] = useState<any>(null);
  const [invoice, setInvoice] = useState<any>(null);
  const [form, setForm] = useState<any>({});
  const [invForm, setInvForm] = useState<any>({});
  const [legacy, setLegacy] = useState(true);
  const [summary, setSummary] = useState<any>(null);
  const [perCandidate, setPerCandidate] = useState(false);
  // QA-033: two sources of truth were OFFERED side by side — free batch-level numbers next
  // to "Start per-candidate marking". Per-candidate is the default path now; the legacy
  // numeric entry hides behind its own explicit button and disappears entirely once
  // per-candidate rows exist.
  const [showLegacyEntry, setShowLegacyEntry] = useState(false);

  // -116 (Umesh 18/08: "manish sir mark complete karenge but complete button show hona chahiye…
  // andar wala complete button kaam nahi kar raha na"). Two separate things were wrong, and this is
  // the second: the Admin door shipped in -113 sits on the OVERVIEW tab, while the button Manish
  // actually presses is the one inside THIS tab — and that one refused with an error banner far
  // above where he was looking, so from his seat it did nothing at all. These panels now know their
  // own rule (the QA-004 pattern: a button that cannot fire says so instead of bouncing), and the
  // Admin door is offered right here, where the press happens.
  const [blockers, setBlockers] = useState<any>(null);
  // -157 (QA-462): names of enrolled students with no portal Candidate ID. Certification cannot
  // complete - by either door - while this is non-empty.
  const [noCan, setNoCan] = useState<Array<{ name: string; phone: string | null }>>([]);
  const [adminBusy, setAdminBusy] = useState(false);
  const isAdmin = role === "Admin";
  // QA-785's real mechanism, and it is the opposite of what it looks like: loadBlockers hits
  // GET /complete, which requires `batches.manage`. Without it the call 403s, the failure is
  // swallowed, `blockers` becomes null, and `(blockers?.unmarked?.length ?? 0) > 0` is FALSE - so the
  // sign-off button rendered ENABLED and 403'd on press. LESS permission produced a MORE pressable
  // button. "Could not load" and "loaded, and empty" are now different states, and the first one
  // disables.
  const [blockersFailed, setBlockersFailed] = useState(false);
  const loadBlockers = () => api(`/api/batches/${batchId}/complete`)
    .then((b) => { setBlockers(b); setBlockersFailed(false); })
    .catch(() => { setBlockers(null); setBlockersFailed(true); });
  useEffect(() => { loadBlockers(); }, [batchId, batch?.status]);
  // QA-712 (-209, checker on qa-207): this button was DEAD from the moment -206 shipped. It renders
  // only when blockers exist, and -206 made a press without `force` refuse 409 whenever blockers
  // exist - the same condition that shows it. Every press returned "Nothing has been changed".
  // Nothing in the wall touched it, because no suite presses the Closure tab's own door.
  // Its prompt was wrong too: it promised the unmarked students would be recorded ABSENT, and -204
  // changed that to Fail on Umesh's ruling. Two lines above it the banner already said "Fail". A
  // screen that describes a write in two ways is worse than one that describes it in none.
  async function completeAsAdmin() {
    const noId = blockers?.no_portal_id?.length ?? 0;
    const why = window.prompt(
      `Complete this batch now?\n\n${(blockers?.unmarked?.length ?? 0)} student(s) with no result will be recorded FAIL.\n`
      + `${(blockers?.unsettled?.length ?? 0)} passed candidate(s) with no certificate will be recorded NOT ISSUED.\n`
      + (noId ? `${noId} student(s) have no portal Candidate ID — certification will be signed by you, not derived.\n` : "")
      + "\nEvery row is audited with your reason and the time in IST. Completing freezes the results and figures (an Admin can reopen it).\n\nReason:");
    if (!why || !why.trim()) return;
    setAdminBusy(true);
    try {
      await api(`/api/batches/${batchId}/complete`, { method: "POST", json: { reason: why.trim(), force: true } });
      load(); onChanged(); loadBlockers();
    } catch (e: any) { setError(e.message); }
    finally { setAdminBusy(false); }
  }
  const load = () => api(`/api/batches/${batchId}/closure`).then((d) => {
    setClosure(d.closure); setInvoice(d.invoice);
    setForm(d.closure ?? {}); setInvForm(d.invoice ?? {});
    setLegacy(d.legacy !== false);
    setSummary(d.results_summary ?? null);
    // -157 (QA-462): -156 shipped this field and no component read it, so the gate it explains
    // stopped certification deriving with nothing on screen to say why - the operator's first news
    // was a 409 after pressing a button that looked live. A guard that changes what a screen will
    // do explains itself on that screen.
    setNoCan(Array.isArray(d.certification_blocked_no_can) ? d.certification_blocked_no_can : []);
    if (d.legacy === false) setPerCandidate(true);
  }).catch((e: any) => setError(e.message));
  useEffect(() => { load(); }, [batchId]);

  // ---- -223: the four dates nobody ever sent ----
  // The card renders SIX date inputs. `Save` sent TWO. `mock_test_date`, `result_expected_date`,
  // `certificate_distribution_date` and `sidh_uploaded_on` are real Date fields on ClosureSchema and
  // all four are in the PUT allow-list (closure/route.ts:49) - nothing in the client ever put them
  // in a payload. And the loss is IMMEDIATE, not on reload: saveClosure calls load(), which does
  // setForm(d.closure ?? {}), so the operator types a date, presses Save, and watches it vanish.
  // These are Manish's M4-14 chain dates; -120 shipped the model, the API and the inputs and never
  // the payload. Same shape as QA-522 one layer out.
  //
  // The cause was FOUR hand-written patch literals (two Save, two Mark Completed). One builder now,
  // used by all four, so a sign-off can no longer drop a date the operator just typed. The server's
  // allow-list is the other copy of this list; a pin in check-user-copy asserts they agree.
  const CLOSURE_DATE_FIELDS = ["assessment_date", "mock_test_date", "result_expected_date",
    "certification_date", "certificate_distribution_date", "sidh_uploaded_on"] as const;
  const closureDatePatch = (f: any): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of CLOSURE_DATE_FIELDS) {
      if (f?.[k] === undefined) continue;
      // A blanked input is "" - send null so clearing a date is a clear, not a cast error.
      out[k] = f[k] === "" ? null : f[k];
    }
    return out;
  };

  async function saveClosure(patch: any) {
    try { await api(`/api/batches/${batchId}/closure`, { method: "PUT", json: patch }); load(); onChanged(); }
    catch (e: any) { setError(e.message); }
  }

  // -224 (Umesh 24/08, measured on live BHA-ITI-RPLHSL-SPIT-01): "Start per-candidate marking"
  // opened a grid in which EVERY control was guaranteed to fail. rules.ts:1302 refuses each mark
  // while the assessment already carries a batch-level sign-off and no per-candidate row exists -
  // and the remedy that refusal NAMES ("Reopen the assessment before marking candidates
  // individually") existed nowhere in this product: Mark Completed disables itself once Completed,
  // and Overview's "Reopen (Admin)" reopens a completed BATCH, so an Active batch was never offered
  // one. The 409 then landed in the page-top banner (page.tsx:83), thousands of pixels above a
  // viewport scrolled through 46 cards, so from the operator's seat Pass/Fail were simply dead - and
  // with nothing able to reach Pass, "Issue certificates" stayed disabled and every bulk-uploaded
  // certificate came back refused. One fault, three symptoms, exactly the -223 shape.
  //
  // The guard is CORRECT and is untouched (2026-08-12 audit S0: it stops a batch-level 30/25 being
  // silently rewritten to 1/1 by the first candidate marked). What was missing is the door it asks
  // for. `assessment_status` is already in the closure PUT allow-list and updateClosure guards only
  // SETTING Completed - reverting to Pending was always permitted by the server, never offered by
  // the client.
  const [reopening, setReopening] = useState(false);
  async function reopenAssessment(then?: () => void) {
    // -224 cycle 3 (QA-878): this sentence used to ASSERT the provenance - "recorded by hand rather
    // than from the roster" - on every batch it was offered for. On a derived sign-off that was
    // simply false, and it was false in the one place a person is being asked to consent. Read the
    // provenance instead of claiming it: `assessment_derived` is the field that knows, and a
    // reopen that has nothing to rebuild says so rather than inventing a reason.
    const a = closure?.appeared, p = closure?.passed;
    const figures = a != null || p != null ? ` — ${a ?? "?"} appeared, ${p ?? "?"} passed` : "";
    const byHand = closure?.assessment_derived !== true;
    if (!window.confirm(
      `Reopen this batch's assessment?\n\n`
      + (byHand
        ? `It was completed with batch-level figures${figures}, entered against the batch rather than derived from the roster.\n\n`
          + `Marking candidates individually REBUILDS those totals from the per-candidate rows, so those numbers will be replaced by whatever the rows actually say. The batch itself is not reopened and nothing else changes.\n\n`
        : `Its figures${figures} were derived from the per-candidate rows, not entered by hand, so reopening changes no number here. The batch itself is not reopened and nothing else changes.\n\n`)
      + `This is audited.`)) return;
    setReopening(true);
    try {
      // Same door and same payload shape as saveClosure - written out here only so the grid opens
      // AFTER the reopen lands, and stays shut if it does not.
      await api(`/api/batches/${batchId}/closure`, { method: "PUT", json: { assessment_status: "Pending" } });
      await load(); onChanged();
      then?.();
    } catch (e: any) { setError(e.message); }
    finally { setReopening(false); }
  }
  async function saveInvoice(patch: any) {
    try { await api(`/api/batches/${batchId}/invoice`, { method: "PATCH", json: patch }); load(); }
    catch (e: any) { setError(e.message); }
  }
  // -86 (checker, QA-157 bypass #1): the result/certificate files are the contractual
  // artifacts and used to skip the one upload path (no compression, no retry, no folder,
  // no entity). Same door as every other file now.
  async function uploadClosureFile(e: any, field: "result_file" | "certificate_file") {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const url = await uploadWithRetry(file, "closure", {
        folder_centre: batch?.location?.code ?? batch?.location?.name ?? "", folder_batch: batch?.code ?? "", folder_kind: field === "result_file" ? "results" : "certificates",
        entity: "Batch", entity_id: batchId,
      });
      saveClosure({ [field]: url });
    } catch (err: any) { setError(err.message); }
  }

  // QA-785 (-217): -216 put `mayMark` on the CHILD component and left this one, 250 lines above it,
  // on a status-only `closed`. A Trainer pressed an ENABLED "Mark Completed" here and was told they
  // lack the right - the FIFTH outing of this class, on the same tab as the fourth. The lesson is
  // not the line: I fixed exactly the line the verdict quoted and never looked one level out.
  const { can: canCloseTab, loaded: closeTabReady } = usePerms();
  const mayMarkTab = !closeTabReady || canCloseTab("closure.manage", "edit");
  // QA-825 / QA-828 (-223, client-reported LIVE OUTAGE): these are TWO DIFFERENT FACTS, and -216/
  // -217 collapsed them into one name. `closed` is right for `disabled=` - someone without the
  // right SHOULD find the inputs inert. It is NOT right for deciding what RENDERS, and it is NOT
  // right for choosing a sentence. It was doing both:
  //   * the marking grid's ONLY door rendered on `!closed`, so without the right it VANISHED - not
  //     refused, absent. `perCandidate` starts false, so there was no path to marking at all. And
  //     "the certificate upload option is gone" was the same defect one step downstream: nothing
  //     can be marked Pass, so no row ever offers a certificate.
  //   * four places printed "the batch is finished" while the header on that same screen showed the
  //     Active chip. That is worse than a dead control - it is a FALSE FACT about the batch, and it
  //     sent the operator hunting for "Reopen" instead of asking an Admin for the right.
  // Measured before fixing: the live permission matrix was never touched (it equals the defaults),
  // so nothing was revoked - the only thing that changed was this expression. FIVE live users do
  // this work without `closure.manage` (3 Trainer, 2 Enrollment), and no manifest of mine asked
  // that question before tightening the gate. That is the process failure, not the line.
  const statusClosedTab = ["Completed", "Cancelled"].includes(batch?.status);
  const closed = statusClosedTab || !mayMarkTab;

  // QA-044: legacy batch with per-candidate rows but NO closure record — the cards below
  // would read 0 while the rows hold real passes/certificates. One click derives.
  async function derive() {
    try { await api(`/api/batches/${batchId}/closure/recompute`, { method: "POST" }); load(); onChanged(); }
    catch (e: any) { setError(e.message); }
  }

  return (
    <div className="space-y-4">
      {!closure && (summary?.total ?? 0) > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span>{summary.passed} passed and {summary.certificates_issued} certificate(s) exist on per-candidate rows, but this batch has no closure record — the figures below read 0.</span>
          <Btn small onClick={derive}>Derive figures from rows</Btn>
        </div>
      )}
      {/* -102, Manish 17/08 ([08:53] "main isko close na karke isko main complete kar pau, kyunki
          closure wala Tarun ji bol rahe the ki wo sab hum baad me dekhenge"): this tab is called
          Closure and holds two unrelated jobs, so it reads as the deferred money work — and the two
          panels that actually carry a batch to Completed look optional. Say which is which. */}
      {/* -111: one line; the explanation rides on the "?" (Umesh: "bahut zyada text heavy"). */}
      <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/60 px-3 py-1.5 text-xs text-blue-900">
        <span><b>Assessment → Certification</b> completes the batch. <b>Invoice → dues</b> closes it — later, no hurry.</span>
        <span className="cursor-help rounded-full border border-blue-300 px-1.5 text-[10px] font-bold text-blue-700"
          title="Assessment done moves the batch to Result Awaited; certification done marks it Completed. Nothing about money is needed for that. Invoice and dues are the later step that ends in Closed — a Completed batch can sit there indefinitely.">?</span>
      </div>
      {/* -116: the door Umesh asked for, ON THIS TAB. It is only offered when the ordinary buttons
          CANNOT fire — when they can, the honest path is to press them. */}
      {/* -206 (QA-678): this hid the Admin door exactly when everything the flag knows about was
          done. `can_complete_cleanly` answers "are the results and certificates settled" and says
          nothing at all about the portal Candidate ID — so on the Gurugram batch, where those were
          settled and 45 students had no ID, the ordinary buttons were disabled AND this box was
          gone. A flag was being asked a question it does not answer. The condition is now "is
          anything at all still open", portal IDs included. Umesh: "dono jagah dikhein." */}
      {isAdmin && !closed && blockers
        && (blockers.can_complete_cleanly === false || (blockers.no_portal_id?.length ?? 0) > 0)
        && ["Active", "Closing"].includes(batch?.status) && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>
            <b>This batch cannot be completed the ordinary way yet.</b>{" "}
            {(blockers.unmarked?.length ?? 0) > 0 && <>{blockers.unmarked.length} student(s) have no result</>}
            {(blockers.unmarked?.length ?? 0) > 0 && (blockers.unsettled?.length ?? 0) > 0 && " · "}
            {(blockers.unsettled?.length ?? 0) > 0 && <>{blockers.unsettled.length} passed candidate(s) have no certificate</>}
            . As Admin you can finish it anyway — the missing rows are recorded Fail / Not Issued, audited with your reason.
          </span>
          <Btn small onClick={completeAsAdmin} disabled={adminBusy}>{adminBusy ? "Completing…" : "Mark Completed (Admin)"}</Btn>
        </div>
      )}
      {/* Per-candidate marking gets the full width — it is a data-entry grid, not a side panel. */}
      {perCandidate && (
        <CandidateResults batchId={batchId} batch={batch} error={error} setError={setError} onChanged={() => { load(); onChanged(); }} />
      )}
      <div className="grid gap-4 lg:grid-cols-2">
      <Section
        title={`Assessment — ${closure?.assessment_status ?? "Pending"}`}
        actions={legacy && !perCandidate && !statusClosedTab ? (
          <span className="flex gap-1.5">
            {/* Renders on the BATCH's state, never on this person's rights. Without the right the
                grid still opens - every control inside it already reads `closed`, so it opens
                READ-ONLY, which is exactly what someone who may not mark should get: the results,
                visible. Vanishing is not refusing, and vanishing left the people whose daily job
                this is with no door at all. */}
            {/* -224: when a batch-level sign-off already stands, opening the grid without reopening
                the assessment opens a room where every control 409s. Reopen first, with the figures
                that are about to be rebuilt stated out loud. Someone who may NOT mark is never
                offered the reopen - they get the read-only view, which is what they came for. */}
            <Btn small disabled={reopening}
              onClick={() => {
                if (mayMarkTab && closure?.assessment_status === "Completed") { reopenAssessment(() => setPerCandidate(true)); return; }
                setPerCandidate(true);
              }}>
              {reopening ? "Reopening…" : mayMarkTab ? "Start per-candidate marking" : "View per-candidate results"}
            </Btn>
            {mayMarkTab && !showLegacyEntry && <Btn small kind="ghost" onClick={() => setShowLegacyEntry(true)}>Batch-level figures (legacy)…</Btn>}
          </span>
        ) : undefined}
      >
        <div className="grid grid-cols-2 gap-3">
          {/* -232 (QA-833): all six of these were typeable by a login whose Save is disabled - the
              operator could fill a date, press a dead Save and lose it, with nothing saying why.
              Same dead-control class as QA-712/723/754/775/785/791 on this very tab, in its
              quietest form: not a button that refuses, an input that accepts and then discards.
              `closed` is the one that already gates Save, so the box and its Save now agree. */}
          <Field label="Assessment date"><input type="date" disabled={closed} className={inputCls} value={toInputDate(form.assessment_date)} onChange={(e) => setForm({ ...form, assessment_date: e.target.value })} /></Field>
          {/* -120 (M4-14, Manish 17/08 [09:17] — he typed the chain out on screen). These are the dates
              it asks for that the ERP never held, in his order. Every one is OPTIONAL and gates
              NOTHING: a batch that never ran a mock test leaves them blank and nothing changes. His
              mock-test STATUS wording is still owed, so no status is invented here — only the facts he
              named. What already existed is not rebuilt: the assessment date above, pass/fail counts,
              the fail reason (Rule 44), the certificate number (Rule 46), the file, and the invoice. */}
          <Field label="Mock test date"><input type="date" disabled={closed} className={inputCls} value={toInputDate(form.mock_test_date)} onChange={(e) => setForm({ ...form, mock_test_date: e.target.value })} /></Field>
          <Field label="Result expected (tentative)"><input type="date" disabled={closed} className={inputCls} value={toInputDate(form.result_expected_date)} onChange={(e) => setForm({ ...form, result_expected_date: e.target.value })} /></Field>
          <div />
          {legacy && !perCandidate && showLegacyEntry ? (
            <>
              <Field label="Appeared (legacy batch-level)"><input type="number" disabled={closed} className={inputCls} value={form.appeared ?? ""} onChange={(e) => setForm({ ...form, appeared: +e.target.value })} /></Field>
              <Field label="Passed (legacy batch-level)"><input type="number" disabled={closed} className={inputCls} value={form.passed ?? ""} onChange={(e) => setForm({ ...form, passed: +e.target.value })} /></Field>
            </>
          ) : !legacy || perCandidate ? (
            <>
              <Field label="Appeared"><div className={inputCls + " bg-gray-50 text-gray-700"}>{closure?.appeared ?? 0} <span className="text-xs text-gray-400">derived</span></div></Field>
              <Field label="Passed"><div className={inputCls + " bg-gray-50 text-gray-700"}>{closure?.passed ?? 0} <span className="text-xs text-gray-400">derived</span></div></Field>
            </>
          ) : (
            <p className="col-span-2 text-xs text-gray-500">Mark each candidate ("Start per-candidate marking") — Appeared/Passed derive from the marks. Batch-level entry exists only for legacy paper records.</p>
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
        {/* QA-829: `items-start`, because the flex default is `stretch` and the sibling span below
            carries two lines of helper text - so Save was being stretched to its neighbour's height
            and read as a broken control. It is LABELLED now too: it saves this card's dates and is
            not a sign-off, which the screen never said. */}
        <div className="mt-3 flex items-start gap-2">
          <span className="inline-flex flex-col gap-0.5">
            <Btn small kind="ghost" disabled={closed}
              onClick={() => saveClosure({ ...closureDatePatch(form), ...(legacy && !perCandidate && showLegacyEntry ? { appeared: form.appeared, passed: form.passed } : {}) })}>Save</Btn>
            <span className="text-[10px] font-medium text-gray-500">saves the dates — not a sign-off</span>
          </span>
          <span className="inline-flex flex-col gap-0.5">
            <Btn small
              onClick={() => saveClosure({ ...closureDatePatch(form), assessment_status: "Completed", assessment_date: form.assessment_date ?? new Date(), ...(legacy && !perCandidate && showLegacyEntry ? { appeared: form.appeared, passed: form.passed } : {}) })}
              disabled={closed || blockersFailed || closure?.assessment_status === "Completed" || (blockers?.unmarked?.length ?? 0) > 0}>Mark Completed</Btn>
            {closure?.assessment_status !== "Completed" && (blockers?.unmarked?.length ?? 0) > 0 && (
              <span className="text-[10px] font-medium text-amber-700"
                title={personList(blockers.unmarked)}>
                {blockers.unmarked.length} student(s) have no result yet — mark them and this turns on by itself
              </span>
            )}
            {/* -162 (QA-394): the finished state, which nothing covered. The condition that disables
                this button used to be the same condition that hid every explanation beside it, so an
                operator on a Completed batch met a dead control and silence. QA-245 fixed the
                blocked-while-Active case and is untouched; this is the other end of the same story. */}
            {closure?.assessment_status === "Completed" && (
              <span className="text-[10px] font-medium text-gray-500">
                already signed off{closure?.assessment_date ? ` on ${fmtDate(closure.assessment_date)}` : ""}
                {statusClosedTab ? " — the batch is finished, so this is frozen. An Admin can Reopen it from the Overview tab." : ""}
              </span>
            )}
            {/* -224: the door rules.ts:1302 tells the operator to use. It existed nowhere before -
                this line only ever MENTIONED reopening when the batch itself was finished, i.e.
                never on the Active batch where per-candidate marking is actually blocked.
                -224 cycle 3 (QA-878, checker on cycle 2): my own predicate asked only HALF the
                question the server asks. rules.ts:1302 refuses on TWO facts - the sign-off is
                Completed AND there are ZERO per-candidate rows - and this asked only the first. So
                on a batch whose sign-off was DERIVED from its rows (`legacy:false`,
                `assessment_derived:true`) the control rendered, its confirm claimed the figures were
                "recorded by hand rather than from the roster" - both clauses false - and pressing it
                did nothing at all: the PUT set Pending, and deriveCompletion immediately restored
                Completed from the rows. A dead button that lies to obtain consent, on the screen
                whose whole release is about dead buttons. `legacy` is the client's name for "no
                per-candidate rows exist", so it is the same question, asked in the client's words. */}
            {legacy && closure?.assessment_status === "Completed" && !statusClosedTab && mayMarkTab && (
              <button onClick={() => reopenAssessment()} disabled={reopening}
                title="Marking candidates individually is refused while a batch-level sign-off stands, because rebuilding the totals from the roster would overwrite the figures that were entered against this batch. Reopening derives them from the rows instead."
                className="w-fit rounded-lg border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50">
                {reopening ? "Reopening…" : "Reopen assessment"}
              </button>
            )}
            {/* Two reasons, two sentences. Calling an ACTIVE batch "finished" is the whole defect. */}
            {statusClosedTab && closure?.assessment_status !== "Completed" && (
              <span className="text-[10px] font-medium text-gray-500">the batch is finished — Reopen it from the Overview tab to change results</span>
            )}
            {!statusClosedTab && !mayMarkTab && (
              <span className="text-[10px] font-medium text-amber-700">read-only for your login — ask an Admin for the right to record results</span>
            )}
            {!statusClosedTab && mayMarkTab && blockersFailed && (
              <span className="text-[10px] font-medium text-amber-700">could not check what is still pending — reload before signing off</span>
            )}
          </span>
        </div>
        <ClosureFileSlot label="Result sheet" value={closure?.result_file} disabled={closed} onUpload={(e: any) => uploadClosureFile(e, "result_file")} />
      </Section>
      <Section title={`Certification — ${closure?.certification_status ?? "Pending"}`}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Certification date"><input type="date" disabled={closed} className={inputCls} value={toInputDate(form.certification_date)} onChange={(e) => setForm({ ...form, certification_date: e.target.value })} /></Field>
          {/* -120 (M4-14): the two dates after certification that his chain ends on.
              QA-1265 (client call 25/08, Umesh decided the same day): these two are gated on the
              RIGHT alone, never on completion. `closed` conflates two questions — "is this batch
              finished" and "may this person mark" — and for these two fields only the second one is
              a reason to refuse. Certificates are distributed AFTER the batch completes and the SIDH
              upload happens after that, so completion is precisely the wrong thing to lock them on:
              "Yeh Monday ko humne certificate distribute kar diye ... toh ab kaise dalu? Yeh add hi
              nahi ho raha hai." The split is the same one QA-785 already made further down this file
              (batchClosedByStatus vs mayMark); the server half is POST_COMPLETION_WRITABLE. */}
          {/* DO NOT change these two back to `disabled={closed}`. That was done once, in good faith,
              by a reader who saw `!mayMarkTab` and read it as a gate that had gone missing (389b9b9,
              "do closure date box apna gate kho baithe the"). The gate is not missing - it is the
              PERMISSION half on purpose, and only the COMPLETION half is dropped. `closed` is
              `statusClosedTab || !mayMarkTab`; these two fields must keep the second and lose the
              first, because a certificate is distributed AFTER the batch completes and the SIDH
              upload happens after that. There is a pin on this in check-user-copy.mjs now, because
              a comment alone did not survive one afternoon. */}
          <Field label="Certificate distribution date"><input type="date" disabled={!mayMarkTab} className={inputCls} value={toInputDate(form.certificate_distribution_date)} onChange={(e) => setForm({ ...form, certificate_distribution_date: e.target.value })} /></Field>
          <Field label="Uploaded to SIDH portal on"><input type="date" disabled={!mayMarkTab} className={inputCls} value={toInputDate(form.sidh_uploaded_on)} onChange={(e) => setForm({ ...form, sidh_uploaded_on: e.target.value })} /></Field>
          {legacy && !perCandidate
            ? <Field label="Certificates issued"><input type="number" disabled={closed} className={inputCls} value={form.certificates_issued ?? ""} onChange={(e) => setForm({ ...form, certificates_issued: +e.target.value })} /></Field>
            : <Field label="Certificates issued"><div className={inputCls + " bg-gray-50 text-gray-700"}>{closure?.certificates_issued ?? 0} <span className="text-xs text-gray-400">derived</span></div></Field>}
        </div>
        {!legacy && summary && summary.passed > summary.certificates_issued && (
          <p className="mt-2 text-xs text-amber-700">{summary.passed - summary.certificates_issued} passed candidate(s) still need an issued certificate.</p>
        )}
        {/* QA-1265: this section had NO frozen sentence at all while the Assessment section above
            has one, so a Completed batch showed three greyed boxes, a greyed Save, and not one word
            of explanation — the client's "yaha pe mujhe yeh default mujhe bola bhi nahi". It says
            both halves now: what stays open, and what does not and how to reopen it. */}
        {statusClosedTab && (
          <p className="mt-2 text-xs text-gray-600">
            The batch is finished. <b>Certificate distribution and the SIDH upload date can still be recorded</b> — they
            happen after a batch completes. The certification date itself is frozen; an Admin can Reopen the batch from
            the Overview tab to change it.
          </p>
        )}
        <div className="mt-3 flex items-start gap-2">
          <span className="inline-flex flex-col gap-0.5">
            {/* QA-1265: Save carries the two post-completion dates, so completion must not disable
                it — otherwise the boxes above accept a value that has no way to reach the server.
                The permission half still refuses. Unchanged frozen dates ride along at their stored
                values and the server treats them as the no-ops they are (sameStoredValue). */}
            <Btn small kind="ghost" disabled={!mayMarkTab}
              onClick={() => saveClosure({ ...closureDatePatch(form), ...(legacy ? { certificates_issued: form.certificates_issued } : {}) })}>Save</Btn>
            <span className="text-[10px] font-medium text-gray-500">saves the dates — not a sign-off</span>
          </span>
          <span className="inline-flex flex-col gap-0.5">
            <Btn small
              onClick={() => saveClosure({ ...closureDatePatch(form), certification_status: "Completed", certification_date: form.certification_date ?? new Date(), ...(legacy ? { certificates_issued: form.certificates_issued } : {}) })}
              disabled={closed || blockersFailed || closure?.certification_status === "Completed" || (blockers?.unsettled?.length ?? 0) > 0 || closure?.assessment_status !== "Completed" || noCan.length > 0}>Mark Completed</Btn>
            {closure?.certification_status !== "Completed" && (blockers?.unsettled?.length ?? 0) > 0 && (
              <span className="text-[10px] font-medium text-amber-700"
                title={personList(blockers.unsettled)}>
                {blockers.unsettled.length} passed candidate(s) have no certificate yet
              </span>
            )}
            {closure?.certification_status !== "Completed" && (blockers?.unsettled?.length ?? 0) === 0 && closure?.assessment_status !== "Completed" && (
              <span className="text-[10px] font-medium text-gray-500">assessment goes first</span>
            )}
            {/* -162 (QA-394): same gap, same fix — this section hid its reason on a finished batch too. */}
            {closure?.certification_status === "Completed" && (
              <span className="text-[10px] font-medium text-gray-500">
                already signed off{closure?.certification_date ? ` on ${fmtDate(closure.certification_date)}` : ""}
                {statusClosedTab ? " — the batch is finished, so this is frozen. An Admin can Reopen it from the Overview tab." : ""}
              </span>
            )}
            {statusClosedTab && closure?.certification_status !== "Completed" && (
              <span className="text-[10px] font-medium text-gray-500">the batch is finished — Reopen it from the Overview tab to change certification</span>
            )}
            {!statusClosedTab && !mayMarkTab && (
              <span className="text-[10px] font-medium text-amber-700">read-only for your login — ask an Admin for the right to record certification</span>
            )}
            {!statusClosedTab && mayMarkTab && blockersFailed && (
              <span className="text-[10px] font-medium text-amber-700">could not check what is still pending — reload before signing off</span>
            )}
            {/* -157 (QA-462): the same shape as the unsettled line four lines up, for the same
                reason. The government issues no certificate without the portal Candidate ID, so
                this batch cannot certify by ANY door until these students have one - and until
                -157 the screen said nothing at all while the derived tick silently stopped
                arriving, which is Manish's "mark complete karne se kuch nahi ho raha" one step
                earlier. The link goes where the IDs can actually be recovered. */}
            {closure?.certification_status !== "Completed" && noCan.length > 0 && (
              <span className="text-[10px] font-medium text-amber-700"
                /* -158 (QA-471): name AND phone, because two students of one name are exactly the
                   case this batch tab exists to stop being ambiguous, and "Sachin Kumar, Sachin
                   Kumar" names nobody. */
                title={personList(noCan)}>
                {noCan.length} enrolled student{noCan.length === 1 ? " has" : "s have"} no portal Candidate ID —{" "}
                <Link href="/candidates" className="underline">Portal ID health</Link> fixes most of them
              </span>
            )}
          </span>
        </div>
        <ClosureFileSlot label="Certificate bundle" value={closure?.certificate_file} disabled={closed} onUpload={(e: any) => uploadClosureFile(e, "certificate_file")} />
      </Section>
      {/* QA-038 (checker): a Location/SPOC login saw the whole Invoice section with buttons the
          server refuses — money surfaces render only for the roles that hold them. */}
      {["Admin", "Operations"].includes(role) && (
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
              <input type="checkbox" disabled={!mayMarkTab} checked={!!closure?.dues_settled}
                onChange={(e) => saveClosure({ dues_settled: e.target.checked })} />
              <span className="font-medium">All dues settled — trainer, centre, vendor: NO dues pending</span>
            </label>
            {closure?.dues_settled && closure?.dues_marked_at && (
              <p className="mt-1 text-xs text-gray-500">Attested {fmtDate(closure.dues_marked_at)}</p>
            )}
            <input className={inputCls + " mt-2"} disabled={!mayMarkTab} placeholder="Dues note (optional — what was settled, references)"
              value={closure?.dues_note ?? ""} onChange={(e) => saveClosure({ dues_note: e.target.value })} />
            <p className="mt-2 text-xs text-gray-500">
              Batch closes from the Overview tab once certification is Completed, the invoice is
              PAID, and this attestation is ticked.
            </p>
            {/* -236 (QA-985, checker on qa-232 c2): these two were the ONLY write controls on this
                tab with no gate at all - a Viewer could tick an attestation the server would refuse.
                They are now gated on the PERMISSION and deliberately NOT on `closed`: rules.ts keeps
                dues_settled/dues_note in POST_COMPLETION_WRITABLE on purpose (DEC-6 - the dues
                attestation HAPPENS after the batch finishes; that is its whole point). Gating them
                on status would have been the obvious fix and would have broken the money flow. What
                was actually wrong is that four other places on this screen say "frozen" while these
                two still write - so the screen says it, rather than leaving the operator to find out. */}
            {statusClosedTab && (
              <p className="mt-1 text-xs text-gray-500">
                The batch is finished, but this attestation stays open on purpose — dues are settled
                after a batch ends, not before.
              </p>
            )}
          </div>
        </div>
      </Section>
      )}
      </div>
    </div>
  );
}

// ---------- Per-candidate assessment & certification (RPL M17/M18) ----------
function CandidateResults({ batchId, batch, error, setError, onChanged }: any) {
  const [items, setItems] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [reasons, setReasons] = useState<any[]>([]);
  const [view, setView] = useState<"mark" | "review">("mark");
  const [bulk, setBulk] = useState<any>({ assessed_on: toInputDate(new Date()), assessor: "" });
  const [certDrawer, setCertDrawer] = useState(false);
  const [certForm, setCertForm] = useState<any>({});
  const [idx, setIdx] = useState(0);
  const [certUpload, setCertUpload] = useState<any>(null); // last confirm report
  const [certOk, setCertOk] = useState(true); // -111: the success half of the report is showing
  const [compressNote, setCompressNote] = useState<string | null>(null); // -123 (QA-157): say what compression did
  const [linkNote, setLinkNote] = useState<string | null>(null); // -111: link success, auto-hides
  const [uploading, setUploading] = useState(false);
  // -224 (Umesh 24/08: "pass fail, and certificate bulk upload ... not properly working"): every
  // failure in this panel reported ONLY through setError, and that banner renders at page.tsx:83 -
  // the top of the page, above the tabs. This grid starts ~2,400 lines of JSX below it and the
  // operator is scrolled through 46 cards, so a refusal painted thousands of pixels out of sight and
  // the button read as dead. The codebase diagnosed exactly this for the Complete button at the top
  // of ClosureTab ("refused with an error banner far above where he was looking, so from his seat it
  // did nothing at all") and fixed ONLY that button; the marking grid never got it.
  //
  // The page-level banner is KEPT - it is right for page-level failures. What is added is a second
  // surface that says it where the press happened: once in the panel, and for a per-candidate mark,
  // pinned to the card that failed so one refusal among 46 is attributable to a person.
  const [gridError, setGridError] = useState<string | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const report = (m: string) => { setGridError(m); setError(m); };
  const fail = (e: any) => { const m = e?.message ?? String(e); report(m); return m; };
  const clearCardError = (member: string) =>
    setCardErrors((c) => { if (!c[member]) return c; const n = { ...c }; delete n[member]; return n; });
  // QA-777 (-216, checker on qa-214): `closed` was the ONLY thing disabling these controls, and it
  // is about the BATCH, not the person. `page.tsx:35` gates only the Costs tab and `GET /results`
  // carries no permission check at all - so a Trainer or an Enrollment user could open Closure, see
  // an ENABLED Candidate ID box, type into it and be told on save that they lack the right. The
  // checker did exactly that in a browser. My -214 manifest defended this door with the sentence
  // "everyone who can see this card can fill the box"; that sentence was false and this is what it
  // cost - the FOURTH outing of the dead-control class (QA-712, QA-723, QA-754, QA-775).
  const { can: canClose, loaded: closePermsReady } = usePerms();
  const mayMark = !closePermsReady || canClose("closure.manage", "edit");
  // QA-785 (-217, checker on qa-216): two DIFFERENT questions, named apart. -216 collapsed them into
  // one `closed`, and the collapse is what made an upload control render for the very people who
  // cannot use it (the condition below reads `!closed || !file`).
  //   batchClosedByStatus - is this BATCH finished?
  //   mayMark             - may THIS PERSON mark?
  const batchClosedByStatus = ["Completed", "Cancelled"].includes(batch?.status);
  const closed = batchClosedByStatus || !mayMark;
  // -108: bulk upload is preview-first — the staged files and their proposed mapping, editable
  // before anything is written. Umesh: "agar koi wrong auto map hua ya nahi map ho paye toh preview
  // me map kar sakte hain, har certificate ke aligned."
  const [mapping, setMapping] = useState<any>(null);
  const [linkPlan, setLinkPlan] = useState<any>(null); // portal-id readiness for the pre-flight panel
  const [linking, setLinking] = useState(false);
  const [certBusy, setCertBusy] = useState<string | null>(null); // per-candidate upload in flight

  // 2026-08-14 (CEO 49:33): "sare certificate ek folder mein ID ke saath — upload hote
  // hi bachche ke saamne assign." Multi-file picker → the CAN id in each FILENAME joins
  // to the roster's sidh_candidate_id server-side; the report below names every file
  // that could not be placed and why. Available on Completed batches too — the endpoint
  // only ever FILLS an absent certificate_file there (DEC-6 stays intact).
  // -108 step 1: stage the files and get a proposed mapping. Nothing is attached yet.
  async function uploadCertificates(list: FileList | null) {
    if (!list?.length) return;
    // -224: Rule 45 is knowable BEFORE the bytes move, and this door never asked. The line directly
    // above this button already prints "0 can take a certificate now" - yet the operator could still
    // pick 46 files, watch every one compress, upload and land in the bucket, and only then read a
    // preview in which all 46 are refused as not-Pass. Refuse at the picker instead, and say which
    // of the two cases it is, because they need opposite actions.
    if (!certReady.length) {
      report(certDone.length
        ? `Every candidate marked Pass on this batch already has a certificate — a bulk upload has nothing to attach. To replace one, use that candidate's own card below. Nothing has been uploaded.`
        : `No candidate is marked Pass yet, and a certificate can only go to a candidate who passed. Mark the results first — nothing has been uploaded.`);
      return;
    }
    setUploading(true);
    setCertUpload(null);
    try {
      // -123 (QA-157): the single-candidate upload has always gone through uploadWithRetry, which
      // compresses on the device. THIS path — the bulk one, the one Manish actually uses — built its
      // own FormData and posted the files whole. A scanned certificate is exactly the large image
      // compression exists for, and the storage arithmetic on QA-104/QA-145 assumes ~2 MB a photo.
      // Compression stays BEST-EFFORT (an upload that must not fail): compressImage returns the
      // original on any decode failure. What changes is that it now runs at all here, and that the
      // result is reported rather than silent — the other half of QA-157's complaint.
      // THE FILE NAME IS LOAD-BEARING and is preserved exactly: the matcher reads CAN_12345 out of
      // it (-108). A compressed blob is re-wrapped in a File under the SAME name, so a renamed
      // extension can never break the matching the whole preview depends on.
      const fd = new FormData();
      let saved = 0, shrunk = 0;
      for (const f of Array.from(list)) {
        let out: File = f;
        if (f.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|tiff?|hei[cf])$/i.test(f.name)) {
          try {
            const blob = await compressImage(f);
            if (blob.size < f.size) { saved += f.size - blob.size; shrunk++; out = new File([blob], f.name, { type: blob.type || f.type }); }
          } catch { /* best effort — the original goes up, exactly as before */ }
        }
        fd.append("files", out);
      }
      if (shrunk > 0) setCompressNote(`${shrunk} image${shrunk === 1 ? "" : "s"} compressed before upload — ${fmtBytes(saved)} saved.`);
      else setCompressNote(null);
      const res = await fetch(`${BASE_PATH}/api/batches/${batchId}/certificates`, { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
      // Each staged file carries its own chosen member, seeded from the server's proposal so a
      // correct auto-match needs no clicks and a wrong one is one dropdown away.
      setMapping({ ...data, choice: Object.fromEntries((data.staged ?? []).map((s: any) => [s.url, s.member ?? ""])) });
    } catch (e: any) { fail(e); }
    finally { setUploading(false); }
  }

  // -108 step 2: attach exactly the pairs the operator confirmed — the correction wins, not the
  // filename. Anything left unmapped is discarded rather than abandoned in the bucket.
  async function confirmMapping() {
    if (!mapping) return;
    const pairs = (mapping.staged ?? [])
      .filter((s: any) => mapping.choice[s.url])
      .map((s: any) => ({ url: s.url, member: mapping.choice[s.url] }));
    const discard = (mapping.staged ?? []).filter((s: any) => !mapping.choice[s.url]).map((s: any) => s.url);
    if (!pairs.length) { report("Nothing to attach — point at least one certificate at a candidate, or press Cancel to discard them."); return; }
    setUploading(true);
    try {
      const data = await api(`/api/batches/${batchId}/certificates`, { method: "POST", json: { confirm: true, pairs, discard } });
      setCertUpload(data); setCertOk(true);
      setMapping(null);
      setGridError(null);
      await load(); onChanged(); loadLinkPlan();
    } catch (e: any) { fail(e); }
    finally { setUploading(false); }
  }

  // Cancel = the staged files leave the bucket. An abandoned preview is not a reason to keep bytes.
  async function cancelMapping() {
    const urls = (mapping?.staged ?? []).map((s: any) => s.url);
    setMapping(null);
    for (const u of urls) {
      const name = String(u).split("/").pop();
      await api(`/api/files/${name}`, { method: "DELETE" }).catch(() => null);
    }
  }

  // -108: the roster's portal-ID readiness — the one fact that explained Manish's eight red lines.
  const loadLinkPlan = () => api(`/api/batches/${batchId}/link-portal-ids`).then(setLinkPlan).catch(() => setLinkPlan(null));
  async function linkPortalIds() {
    setLinking(true);
    try {
      const res = await api(`/api/batches/${batchId}/link-portal-ids`, { method: "POST" });
      setCertUpload(null);
      await load(); await loadLinkPlan();
      if (res.linked) setLinkNote(`${res.linked} portal ID${res.linked === 1 ? "" : "s"} linked from the government imports — those certificates will now match by file name.`);
      if (!res.linked) report(res.conflicts?.length
        ? `Nothing linked — ${res.conflicts.length} candidate(s) have conflicting portal IDs, left untouched. Fix them on the candidate record.`
        : "Nothing to link — the portal attendance imported so far names no new IDs for this roster.");
    } catch (e: any) { fail(e); }
    finally { setLinking(false); }
  }


  const [loaded, setLoaded] = useState(false);
  // QA-070 (-70): the marking screen was hours-blind — the CEO's exact ask is knowing WHO
  // qualified while marking results. Same existing attendance API, joined by member_id.
  const [hoursBy, setHoursBy] = useState<Map<string, any>>(new Map());
  const [attMeta, setAttMeta] = useState<any>(null); // -109: the bar, whether the course is over, and the verdict breakdown
  const load = () => Promise.all([
    api(`/api/batches/${batchId}/results`).then((d) => { setItems(d.items); setSummary(d.summary); }),
    api("/api/master-lists/failure-reasons").then((d) => setReasons(d.items)).catch(() => setReasons([])),
    api(`/api/batches/${batchId}/attendance`).then((d) => {
      // A-04: this picker is an ALLOW-LIST, so a field the server starts sending is a field the
      // screen silently never sees. `roster_count` and `left_count` were added to the route and the
      // sentence below was written to print them - and rendered nothing, because they stopped here.
      // Found by looking at the screen, not by the pins: the API assertions passed the whole time.
      setAttMeta({ required_hours: d.required_hours, course_finished: d.course_finished, portal_working_days: d.portal_working_days, verdict_counts: d.verdict_counts ?? {}, awaiting_match_rows: d.awaiting_match_rows ?? 0, roster_count: d.roster_count ?? null, left_count: d.left_count ?? 0 });
      setHoursBy(new Map((d.members ?? []).map((m: any) => [String(m.member_id), { qualified: m.qualified, attended_hours: m.attended_hours, basis: m.basis, required_hours: d.required_hours, verdict: m.verdict }])));
    }).catch(() => {}),
  ]).catch((e: any) => setError(e.message)).finally(() => setLoaded(true));
  useEffect(() => { load(); loadLinkPlan(); }, [batchId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function mark(member: string, patch: any) {
    try {
      await api(`/api/batches/${batchId}/results`, { method: "PUT", json: { rows: [{ member, assessed_on: bulk.assessed_on, assessor: bulk.assessor || undefined, ...patch }] } });
      clearCardError(member); setGridError(null);
      await load(); onChanged();
    } catch (e: any) {
      const m = fail(e);
      setCardErrors((c) => ({ ...c, [member]: m }));
    }
  }
  async function bulkApply(rows: any[]) {
    if (!rows.length) return;
    try {
      const res = await api(`/api/batches/${batchId}/results`, { method: "PUT", json: { rows } });
      // -224: bulkMarkResults (rules.ts:1429) collects per-row failures and the route throws ONLY
      // when every single row failed (results/route.ts:121) - otherwise it returns 200 with
      // { updated, errors }. This function discarded `errors` entirely, so "Mark 45 pending as Pass"
      // could mark 20, refuse 25, and report a clean success. A partial write that says nothing is
      // worse than a refusal: the operator believes the roster is marked.
      const errs: any[] = Array.isArray(res?.errors) ? res.errors : [];
      // -224 cycle 3 (QA-877, checker on cycle 2): a SUCCESSFUL bulk mark cleared only `gridError`
      // and never `cardErrors`, so cards that had just been marked Pass went on displaying the old
      // refusal - "Reopen the assessment before marking candidates individually" - beside a green
      // Pass. A stale refusal standing next to the result that disproves it is the same lie this
      // unit exists to remove, and it contradicted this component's own comment ("clears on that
      // card's next successful mark"), which was true only for the single-candidate path. Every
      // member this call actually updated gets its card cleared, exactly as mark() does.
      const failed = new Set(errs.map((e) => String(e?.member)));
      setCardErrors((c) => {
        const n = { ...c };
        for (const r of rows) { const m = String(r.member); if (!failed.has(m)) delete n[m]; }
        for (const e of errs) if (e?.member) n[String(e.member)] = String(e.error ?? "refused, no reason given");
        return n;
      });
      if (errs.length) {
        const names = errs.map((e) => items.find((i) => String(i.member) === String(e.member))?.candidate?.name).filter(Boolean) as string[];
        report(`${res?.updated ?? 0} marked · ${errs.length} refused — ${errs[0]?.error ?? "no reason given"}`
          + (names.length ? ` (${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3} more` : ""})` : ""));
      } else {
        // …and the page-top banner the same report() wrote, or the two surfaces disagree (QA-877).
        setGridError(null); setError("");
      }
      await load(); onChanged();
    } catch (e: any) { fail(e); }
  }
  async function certPatch(resultId: string, patch: any) {
    try { setGridError(null); await api(`/api/results/${resultId}`, { method: "PATCH", json: patch }); await load(); onChanged(); }
    catch (e: any) { fail(e); }
  }

  // -108: one certificate, one candidate. Goes through the SAME upload door as every other file
  // (uploadWithRetry: compression, 3 retries, offline queue) and then the existing certificate
  // field patch — no new server contract, and no file-name matching to get wrong.
  async function uploadOneCertificate(i: any, file: File) {
    if (!i.result?._id) { report("Mark this candidate's result first — a certificate attaches to a result."); return; }
    setCertBusy(String(i.result._id));
    try {
      const url = await uploadWithRetry(file, "closure", {
        folder_centre: batch?.location?.code ?? batch?.location?.name ?? "", folder_batch: batch?.code ?? "", folder_kind: "certificates",
        entity: "Batch", entity_id: batchId,
      });
      await certPatch(String(i.result._id), { certificate_file: url });
    } catch (e: any) { fail(e); }
    finally { setCertBusy(null); }
  }

  const active = activeOnly(items);
  // A-05: named beside `active` rather than derived twice, because every count on this screen that
  // disagreed with another one disagreed about exactly this set.
  const left = items.filter(hasLeft);
  // 2026-08-25 (Umesh): "log rakho candidate wale mai but baaki jagah se tho data naa dikhee." The
  // rule he gave, asked to state it in one line, is "a left member appears only where they have a
  // record of their own; where they are just a name, they are gone." On THIS screen a record of
  // their own means a DECIDED result - so the two halves of `left` are not the same thing and must
  // not share a name. A-05 above learned that lesson once and needed two names; this needs four.
  const leftShown = left.filter((i) => hasRecordedResult(i.result));
  const leftHidden = left.filter((i) => !hasRecordedResult(i.result));
  const pending = active.filter((i) => !i.result || i.result.result === "Pending");
  // The ONE population every count, every pill and the card grid on this screen reads. Every
  // counting defect this tab has been filed for - three different answers to "how many unmarked" on
  // one screen, a pill counting rows the grid could not show - was two surfaces each deriving their
  // own. There is one now, and it is this.
  const visible = items.filter((i) => showsAfterLeaving(i, hasRecordedResult(i.result)));

  // QA-748 (-214, Umesh 23/08): "yeh joh saare candidate cards hai, inke upar bhi filter hona
  // chahiye... kisiko sirf pass wale candidate dekhne toh woh us card ke through hi filter laga de,
  // aur kisiko aise chahiye ki jinki candidate id missing hai toh woh missing wale aa jayen... abhi
  // to 40-45 hain, let's suppose kal ke din 200 plus ho jata hai to us case mein to ye bahut hi
  // zyada ho jayega na, complex to scroll and all." Plus, asked what to include: "sab kuch" and
  // "candidate id search, mock test, aur jaise bhi possible, search based filteration too".
  //
  // The Review table beside this view has had search and per-column filters since the -83 table-UX
  // cycle (DataTable builds them in); the CARD view had nothing. Client-side, because the payload
  // already carries every row - no new API.
  const [cardFilter, setCardFilter] = useState("all");
  const [cardSearch, setCardSearch] = useState("");
  // QA-1166 was a `selfCounted` flag here, suppressing FilterPills' appended count on the one pill
  // whose LABEL already carried numbers - because "All 6 active - 1 left" plus an appended 7 read as
  // three numbers on a screen whose entire complaint is numbers that do not reconcile.
  //
  // 2026-08-25: the flag is GONE, and this is the better fix rather than a second one. No label on
  // this strip states its own numbers any more, so there is nothing to suppress. One label, one
  // count, and the count is the number of cards the grid will actually render. A suppression flag
  // that no pill sets is dead scaffolding, and dead scaffolding is what the next reader mistakes for
  // a rule. The two-population fact Umesh asked for on 24 Aug ("show both, side by side") is not
  // lost - it moved into the hover text and the line under this strip, which say it in words.
  const CARD_FILTERS: { value: string; label: string; title: string; test: (i: any) => boolean }[] = [
    // A-05 (24-Aug issues sheet): this chip said "All 46" while the header said "45 not marked yet"
    // and the bulk button said "Mark 45 pending as Pass" - three numbers, one screen, one batch. The
    // cause is not the missing portal ID the report reasoned from: `active` below drops members who
    // have LEFT, and this chip counted everyone. Umesh, asked which number is the true one, chose
    // "show both, side by side" - so nobody silently disappears from a screen and no number hides
    // arithmetic. The chip still SELECTS everyone; it just stops implying they are all markable.
    { value: "all", label: "All", title: left.length
      ? `${items.length} on the roster. This screen shows ${visible.length}: the ${active.length} still in the batch${leftShown.length ? ` and ${leftShown.length} who left with a result already on record, kept read-only` : ""}.`
        + (leftHidden.length ? ` ${leftHidden.length} who left with no result recorded ${leftHidden.length === 1 ? "is" : "are"} not shown - their record is on the Candidates tab.` : "")
        + " A member who has left cannot be marked."
      : "Everyone on the roster", test: () => true },
    { value: "Pass", label: "Pass", title: "Marked Pass", test: (i) => i.result?.result === "Pass" },
    { value: "Fail", label: "Fail", title: "Marked Fail", test: (i) => i.result?.result === "Fail" },
    { value: "Absent", label: "Absent", title: "Marked Absent", test: (i) => i.result?.result === "Absent" },
    { value: "pending", label: "Not marked", title: "No result recorded yet", test: (i) => !i.result || i.result.result === "Pending" },
    // his own example, and the one this whole week has been about
    // QA-778 (-216, checker on qa-214): this pill counted EVERY row on the roster, including students
    // who have left, while the panel on the same screen counts only the ENROLLED ones the gate
    // actually blocks on (`enrolledWithoutCan`). Drop one member and the screen shows "No portal ID
    // 10" beside "9 enrolled students have no portal Candidate ID" - QA-704 again, one question with
    // two numbers, in a release whose own job was to stop that. The pill is not re-pointed at the
    // gate (a filter that hides a student you can still see on the card would be worse); it NAMES its
    // own population instead, so the two numbers read as the two different facts they are.
    // 2026-08-25: this title used to end "- including students who have left". That sentence was
    // true when it was written and this change makes it FALSE: a student who left with no result is
    // not on this screen at all any more. Editing it is not tidying. Four times in one day this
    // project has shipped a true sentence sitting beside the code that contradicted it, each time
    // written by the person who broke it, and nothing in the toolchain compares prose to behaviour -
    // so the pin that holds this string is in check-user-copy, not here.
    { value: "nocan", label: "No portal ID (shown rows)", title: "Every row shown on this screen with no portal Candidate ID, or one the certification gate cannot read. The panel below counts only the ENROLLED students certification is actually held up on, so these two numbers can differ and both be right.", test: (i) => portalIdState(i.candidate?.sidh_candidate_id) !== "ok" },
    { value: "nocert", label: "Passed, no certificate", title: "Passed but the certificate is not settled yet", test: (i) => i.result?.result === "Pass" && !isCertificateSettled(i.result?.certificate_status) },
    { value: "mock", label: "Mock: not qualified", title: "Sat the mock test and did not clear it", test: (i) => i.result?.mock_appeared === true && i.result?.mock_qualified !== true },
  ];
  const q = cardSearch.trim().toLowerCase();
  const matchesSearch = (i: any) => !q || [i.candidate?.name, i.candidate?.phone, i.candidate?.sidh_candidate_id, i.candidate?.apaar_id]
    .some((v) => String(v ?? "").toLowerCase().includes(q));
  const shown = visible.filter((i) => (CARD_FILTERS.find((f) => f.value === cardFilter)?.test ?? (() => true))(i) && matchesSearch(i));
  // QA-779: narrowing the list must put the pager back at the start, or the phone view opens on
  // whatever index the previous filter happened to be sitting at.
  useEffect(() => { setIdx(0); }, [cardFilter, cardSearch]);
  // DELIBERATELY `items`, not `active` or `visible`, and this was a decision rather than an
  // oversight. A candidate who passed and THEN left keeps their card here (that is what `visible`
  // is for) precisely so the certificate they earned can still be attached to it - certificate
  // fields route through upsertCandidateCertificate, which the new left_on refusal does not touch.
  // Narrowing this line would drop them out of certReady/certDone, the expected-filenames list and
  // the mapping drawer, and take the certificate door away with them.
  // KNOWN DISAGREEMENT, left standing rather than silently resolved: certificationCompleteness on
  // the server excludes dropped passes from the gate, so the "Issue certificates" offer here can
  // count somebody the gate says is not blocking. That predates this change and is Umesh's call.
  const passes = items.filter((i) => i.result?.result === "Pass");
  // -108: the pre-flight numbers, in the words the panel says them in.
  const certReady = passes.filter((i) => !i.result?.certificate_file);
  const certDone = passes.filter((i) => i.result?.certificate_file);
  // -114 (QA-238, checker on live -112): every one of DST-01's eight Issued certificates carries NO
  // certificate NUMBER — the file settles the status, the number comes from the awarding body later —
  // and the screen said "8 already have one" with nothing hinting that not one of them can be
  // invoiced against. The number is what downstream invoicing and audits reference, so the count of
  // missing ones belongs beside the count of present ones.
  const certNoNumber = certDone.filter((i) => !i.result?.certificate_no);
  const notPassed = active.filter((i) => i.result && ["Fail", "Absent"].includes(i.result.result));
  // The exact file names this batch's matcher would accept, for the candidates who can actually
  // take a certificate. Same normalisation as the server's canOf(), so the list cannot promise a
  // name the matcher would then reject.
  const expectedNames = certReady
    .map((i) => {
      // -212 (QA-728): was an inline near-copy of the matcher's regex. It is the shared one now, so
      // the name this screen SUGGESTS for a file cannot drift from the name the server MATCHES on.
      const can = normalizeCan(i.candidate?.sidh_candidate_id);
      return can ? { name: i.candidate?.name, file: `${can}.pdf` } : null;
    })
    .filter(Boolean) as { name: string; file: string }[];

  // A-09 (24-Aug issues sheet): a card carrying the red "Not eligible" pill kept a fully live Pass
  // button - no confirmation, nothing recorded. Umesh's answer to "who may override" was "anyone who
  // can mark", so the button stays exactly where it is for everybody; what changes is that pressing
  // it on a not-eligible candidate now ASKS, and the answer is stored against them.
  //
  // The prompt is a courtesy, not the gate. The server refuses a Pass on a not-eligible candidate
  // without a reason whatever the screen does - which is the only arrangement that survives anything
  // that can POST. Cancelling here sends nothing at all, so a hesitant operator changes nothing.
  const ResultButtons = ({ i }: any) => {
    // 2026-08-25: a member who has LEFT keeps the result already on record and takes no new one.
    // The server refuses it now (upsertCandidateResult), so leaving these enabled would render a
    // control whose only outcome is a 409 - the dead-control class this file has paid for five
    // times (QA-712, QA-723, QA-754, QA-775, QA-785), twice on this very tab.
    const readOnly = closed || hasLeft(i);
    return (
    <div className="flex flex-wrap gap-1.5">
      {["Pass", "Fail", "Absent"].map((r) => {
        const on = i.result?.result === r;
        const tone = r === "Pass" ? "border-green-300 bg-green-50 text-green-700"
          : r === "Fail" ? "border-red-300 bg-red-50 text-red-700" : "border-amber-300 bg-amber-50 text-amber-700";
        const notEligible = hoursBy.get(String(i.member))?.verdict?.state === "not_eligible";
        const overriding = r === "Pass" && notEligible && i.result?.result !== "Pass";
        return (
          <button key={r} disabled={readOnly}
            title={overriding ? `${i.candidate?.name ?? "This candidate"} did not meet the attendance requirement. Passing them is allowed, but you will be asked why, and it is recorded against them.` : undefined}
            onClick={() => {
              if (r === "Fail") return mark(i.member, { result: "Fail", failure_reason: i.result?.failure_reason || reasons[0]?.name || "Below cut-off" });
              if (!overriding) return mark(i.member, { result: r });
              const gap = "\n\n";
              const why = window.prompt(
                `${i.candidate?.name ?? "This candidate"} is marked NOT ELIGIBLE — they did not meet the ${attMeta?.required_hours ?? 60}-hour attendance bar.` + gap
                + "A Pass is what unlocks their certificate, so this is an override. It is allowed, and it will be recorded against them with your name." + gap
                + "Why are they being passed anyway?");
              if (!why?.trim()) return;
              return mark(i.member, { result: r, eligibility_override_reason: why.trim() });
            }}
            className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium disabled:opacity-50 ${on ? tone : overriding ? "border-red-300 bg-white text-red-700" : "border-gray-200 bg-white text-gray-500"}`}>
            {on ? "✓ " : ""}{r}{overriding ? " ⚠" : ""}
          </button>
        );
      })}
    </div>
    );
  };

  const Card = ({ i }: any) => {
    const h = hoursBy.get(String(i.member));
    // Umesh's rule on this screen: a departed member is here ONLY because a result is already on
    // record. Every ASSESSMENT control is therefore read-only for them. The CERTIFICATE controls
    // below are deliberately NOT - certificate fields route through upsertCandidateCertificate, the
    // left_on refusal does not touch that door, and being able to attach the certificate they earned
    // is the reason their card was kept at all.
    const leftOn = i.left_on;
    const readOnly = closed || !!leftOn;
    return (
    <div className="space-y-2 rounded-xl border bg-white p-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium">{i.candidate?.name}</div>
          <div className="text-xs text-gray-500">{i.candidate?.phone}{leftOn ? ` · left ${fmtDate(leftOn)}${i.drop_reason ? ` (${i.drop_reason})` : ""}` : ""}</div>
        </div>
        <span className="flex items-center gap-1.5">
          {/* QA-070: the qualification verdict RIGHT where results are marked. */}
          {/* -109 (Umesh 17/08): this chip used to say only "Qualified" or an hours figure, and the
              import grid beside it said "Not eligible" for anyone below the bar — including students
              three days into a fifteen-day course, students whose hours file never parsed, and
              students with no import at all. A missing-data state was reading as a verdict about a
              real person, on the screen where certificates get decided. The verdict now comes from
              the ONE shared function (eligibilityVerdict) with both gates: a student who has not
              finished enrolling gets no verdict at all, and "Not eligible" waits for the course to
              be over. */}
          {h?.verdict && (
            <span title={h.verdict.detail}
              className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                h.verdict.state === "qualified" ? "bg-green-100 font-semibold text-green-700"
                  : h.verdict.state === "in_progress" ? "border border-amber-200 bg-amber-50 text-amber-700"
                    : h.verdict.state === "not_eligible" ? "border border-red-200 bg-red-50 text-red-700"
                      : "border border-gray-200 bg-gray-50 text-gray-500"}`}>
              {h.verdict.state === "qualified" ? "✓ " : ""}{h.verdict.label}
            </span>
          )}
          <Chip value={i.result?.result ?? "Pending"} />
        </span>
      </div>
      {/* -120 (M4-14, Manish typed it out): "who all are APPEARING for the mock test" and "who all are
          QUALIFYING — yeh data aayega" are two different lists in his words, so they are two toggles,
          not one flag. The gap between them is the thing a centre acts on before the real assessment:
          someone who appeared and did not qualify needs work, someone who never appeared needs
          chasing, and those are different jobs. `mock_note` carries WHY — the same discipline Rule 44
          already enforces for a Fail, which is M4-17's ask applied to the mock test.
          Nothing here gates anything: a batch that ran no mock test simply leaves it alone. */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-gray-50 px-2 py-1.5 text-xs">
        <span className="font-medium text-gray-500">Mock test:</span>
        {[["mock_appeared", "Appeared"], ["mock_qualified", "Qualified"]].map(([f, label]) => {
          const on = i.result?.[f] === true;
          return (
            <button key={f} disabled={readOnly}
              onClick={() => mark(i.member, { [f]: !on, ...(f === "mock_appeared" && on ? { mock_qualified: false } : {}) })}
              className={`rounded-full border px-2 py-0.5 font-medium disabled:opacity-50 ${on ? (f === "mock_qualified" ? "border-green-300 bg-green-50 text-green-700" : "border-blue-200 bg-blue-50 text-blue-700") : "border-gray-200 bg-white text-gray-500"}`}>
              {on ? "✓ " : ""}{label}
            </button>
          );
        })}
        {i.result?.mock_appeared === true && i.result?.mock_qualified !== true && (
          <input placeholder="Why not qualified?" disabled={readOnly}
            className="w-44 rounded-lg border border-gray-300 px-2 py-0.5"
            defaultValue={i.result?.mock_note ?? ""}
            onBlur={(e) => e.target.value !== String(i.result?.mock_note ?? "") && mark(i.member, { mock_note: e.target.value })} />
        )}
        {/* QA-747 (-214, Umesh 23/08): "role number ka kya kaam hai bhai isme... role number nai
            chayye, candidate id chayye. Candidate id fill karne ke liye woh hona chahiye, taaki jin
            students ki candidate id missing hai unko wo kar payein."
            The Roll no box that used to sit here was filled 0 times out of 45 on the live batch, and
            it is in no contract - REQUIREMENTS-2026-08-20's "two roll numbers" is REQ-378 talking
            about `_id` and `sidh_candidate_id`, not this field. The FIELD stays on the model and on
            this door's allow-list so nothing already typed anywhere dies; only the box is gone.
            The write goes through THIS door (closure.manage), not the candidate door
            (candidates.manage) - his decision, so a Trainer can fill one in without meeting a 403. */}
        <span className="ml-auto flex items-center gap-1.5">
          {portalIdState(i.candidate?.sidh_candidate_id) === "unreadable" && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900"
              title="Stored on this candidate, but certification cannot read it as a portal ID.">not readable</span>
          )}
          <input placeholder="Candidate ID" disabled={readOnly}
            className={`w-40 rounded-lg border px-2 py-0.5 ${portalIdState(i.candidate?.sidh_candidate_id) === "ok" ? "border-gray-300" : "border-amber-300 bg-amber-50"}`}
            title="The portal Candidate ID from SIDH — the only key the certificate matcher joins on."
            defaultValue={i.candidate?.sidh_candidate_id ?? ""}
            onBlur={(e) => e.target.value !== String(i.candidate?.sidh_candidate_id ?? "")
              && mark(i.member, { sidh_candidate_id: e.target.value })} />
          {/* QA-902 (-232, Umesh 24/08): "hrr individual candidate k liye jaise abhi candidate id
              aati hai vaise hi govt APAAR ID hota hai... card mai iske liye bhi jagah bnaao same as
              candidate id."
              Right beside the Candidate ID and NOT on its own row — his words were "same as candidate
              id", and the strip is flex-wrap, so on a narrow screen it drops to the next line without
              costing vertical height on a 46-card roster.
              `disabled={closed}` is not decoration and is not copied by habit: `closed` is
              `batchClosedByStatus || !mayMark` (QA-777/QA-785), and an input that renders enabled for
              someone whose save will 403 is the dead-control class this codebase has now shipped four
              times (QA-712, QA-723, QA-754, QA-775). The write goes through THIS door — the same
              `mark()` on `closure.manage` — so a Trainer can fill one in, exactly as Umesh asked for
              the Candidate ID box ("Trainer bhi bhar sake") and repeated here ("admin, ops team, and
              those all who can push the batch data"). */}
          <input placeholder="APAAR ID" disabled={readOnly} inputMode="numeric"
            className={`w-40 rounded-lg border px-2 py-0.5 ${apaarIdState(i.candidate?.apaar_id) === "ok" ? "border-gray-300" : apaarIdState(i.candidate?.apaar_id) === "unreadable" ? "border-amber-300 bg-amber-50" : "border-gray-300"}`}
            title="The government APAAR ID — the student's 12-digit academic account number. Not the Aadhaar number: they are both 12 digits and are different numbers."
            defaultValue={i.candidate?.apaar_id ?? ""}
            onBlur={(e) => e.target.value !== String(i.candidate?.apaar_id ?? "")
              && mark(i.member, { apaar_id: e.target.value })} />
        </span>
      </div>
      {/* Where it cannot act, it must say why rather than render nothing. A door that silently
          vanishes teaches nobody anything; a door that refuses out loud does. */}
      {leftOn && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-[11px] leading-4 text-gray-600">
          Read-only — this student left the batch on {fmtDate(leftOn)}. Their result stays on record exactly as it is.
          The certificate can still be attached.
        </div>
      )}
      <ResultButtons i={i} />
      {/* -224: the refusal for THIS candidate, on THIS card. A message in the panel header is right
          for a bulk action; a per-candidate mark that fails needs to name the person it failed for,
          or on a 46-card roster the operator cannot tell who did not get marked. Clears on this
          card's next successful mark. */}
      {cardErrors[String(i.member)] && (
        <div className="flex items-start gap-1.5 rounded-lg border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] leading-4 text-red-800">
          <span aria-hidden className="font-bold">!</span>
          <span className="flex-1">{cardErrors[String(i.member)]}</span>
          <button aria-label="Dismiss" onClick={() => clearCardError(String(i.member))}
            className="rounded px-1 leading-none text-red-400 hover:text-red-700">×</button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input type="number" placeholder="Score" disabled={readOnly}
          className="w-24 rounded-lg border border-gray-300 px-2 py-1 text-sm"
          defaultValue={i.result?.score ?? ""}
          onBlur={(e) => e.target.value !== String(i.result?.score ?? "") && mark(i.member, { score: +e.target.value })} />
        {i.result?.result === "Fail" && (
          <select className="rounded-lg border border-gray-300 px-2 py-1 text-sm" disabled={readOnly}
            value={i.result?.failure_reason ?? ""}
            onChange={(e) => mark(i.member, { result: "Fail", failure_reason: e.target.value })}>
            {reasons.map((r) => <option key={r._id}>{r.name}</option>)}
            {!reasons.length && <option>Below cut-off</option>}
          </select>
        )}
        {i.result?.certificate_status && i.result.certificate_status !== "Pending" && <Chip value={i.result.certificate_status} />}
      </div>
      {/* -108, Umesh 17/08: "ya toh bachche ke wahan se kar le" — one file, straight to this
          candidate, no file name and no portal ID involved. The route that cannot fail on matching.
          Rule 45 still decides: without a Pass there is nothing to attach a certificate to, and the
          line says what to do instead of hiding the control silently. */}
      <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2 text-xs">
        {i.result?.result !== "Pass" ? (
          <span className="text-gray-400">
            {i.result?.result ? `${i.result.result} — no certificate` : "Mark the result Pass first — then the certificate can be attached"}
          </span>
        ) : (
          <>
            <span className="text-gray-500">Certificate</span>
            {i.result?.certificate_file ? (
              <>
                <a className="text-blue-700 underline" href={i.result.certificate_file} target="_blank" rel="noreferrer">open</a>
                {!closed && (
                  <button className="text-red-600 hover:underline"
                    onClick={async () => {
                      const reason = window.prompt(`Remove ${i.candidate?.name}'s certificate file? The certificate number and status stay. Reason:`);
                      if (reason === null) return;
                      try { await api(`/api/results/${i.result._id}/certificate`, { method: "DELETE", json: { reason } }); setGridError(null); await load(); onChanged(); }
                      catch (e: any) { fail(e); }
                    }}>remove</button>
                )}
              </>
            ) : <span className="text-gray-400">none</span>}
            {/* QA-785: this reads `!closed || !file`, so widening `closed` to mean "or this person
                may not mark" made the upload control render MORE often, not less - and both
                certificate paths push the file to STORAGE before the server's 403. The permission is
                asked on its own; the status condition keeps the meaning it always had. */}
            {mayMark && (!batchClosedByStatus || !i.result?.certificate_file) ? (
              <label className="cursor-pointer rounded-lg border border-blue-600 px-2 py-0.5 font-medium text-blue-700 hover:bg-blue-50">
                {certBusy === String(i.result?._id) ? "Uploading…" : i.result?.certificate_file ? "Replace" : "⬆ Upload"}
                <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden"
                  disabled={certBusy === String(i.result?._id)}
                  onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) uploadOneCertificate(i, f); }} />
              </label>
            ) : null}
          </>
        )}
      </div>
    </div>
    );
  };

  return (
    <Section
      // Both halves from the SAME set. `summary.final` is derived server-side over every result row
      // on the batch INCLUDING members who have left, while the denominator has always been the
      // active roster - so this read "18/54" with an 18 that silently counted departed people. The
      // numbers on this screen are the whole subject of this unit; this one cannot stay mixed.
      //
      // QA-1278 (-250 cycle 2, checker): matching the two halves to each other was necessary and not
      // sufficient. Rendered, this read "Candidate results - 0/2 marked" directly above a pill saying
      // "All 3" and a visible tick-Pass card - because the grid shows `visible` (people still on the
      // batch PLUS anyone who left with a result already recorded) while this header counts only the
      // people still on it. Both numbers are right and they answer different questions, which is
      // QA-778's shape exactly, and QA-778 settled the remedy: NAME the population, do not force the
      // numbers to agree. Re-pointing this at `visible` would be worse - it would tell an operator
      // that somebody who has left is work still to do, and the bulk buttons below (correctly) cannot
      // touch them. So the header says whose count it is, and the pill already says whose it is.
      title={`Candidate results — ${active.filter((i) => hasRecordedResult(i.result)).length} of the ${active.length} still on the batch marked${summary?.pending ? ` · ${summary.pending} pending` : ""}`}
      actions={<Btn small kind="ghost" onClick={() => setView(view === "mark" ? "review" : "mark")}>{view === "mark" ? "Review table" : "Mark results"}</Btn>}
    >
      {pending.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {/* -159 cycle 2 (QA-476): the one the checker caught in a BROWSER, printing "G317511 Echo,
              G317511 Echo, G317511 Echo" in visible amber copy - not a tooltip, no hover needed, on
              the same tab as the two this unit had just fixed. The results payload has carried the
              phone all along. */}
          Still pending: {personList(pending.slice(0, 6).map((p: any) => p.candidate))}
          {pending.length > 6 ? ` +${pending.length - 6} more` : ""} — assessment cannot be marked Completed until every candidate has a final result.
        </div>
      )}

      {/* -224: the panel's own failure surface. Every refusal from this grid used to be painted at
          the top of the PAGE, which on a 46-card roster is thousands of pixels above the press. */}
      {gridError && (
        <div className="mb-3">
          <Notice kind="error" onDismiss={() => setGridError(null)}>{gridError}</Notice>
        </div>
      )}

      {!closed && (
        <div className="mb-3 flex flex-wrap items-end gap-2 rounded-lg bg-gray-50 p-3">
          <Field label="Assessment date (applies to marks)">
            <input type="date" className={inputCls + " max-w-40"} value={bulk.assessed_on} onChange={(e) => setBulk({ ...bulk, assessed_on: e.target.value })} />
          </Field>
          <Field label="Assessor">
            <input className={inputCls + " max-w-44"} value={bulk.assessor} onChange={(e) => setBulk({ ...bulk, assessor: e.target.value })} placeholder="Assessor name (optional)" title="The assessment body appoints the assessor, so a centre often never learns the name. Nothing here needs it — leave it blank and closure still proceeds." />
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
          {/* -224: `disabled={!passes.length}` with nothing beside it is indistinguishable from a
              broken button - and on a batch where marking itself was refused, this was the FIRST
              thing the operator pressed. A control that cannot fire says why (the QA-004 pattern). */}
          <span className="inline-flex flex-col gap-0.5" title={certReady.length
            ? `${certReady.length} passed candidate${certReady.length === 1 ? " has" : "s have"} no certificate attached yet. This opens the panel that attaches them and records their numbers.`
            : passes.length
              ? `Every passed candidate already has a certificate file. This opens the panel that records their certificate numbers${certNoNumber.length ? ` — ${certNoNumber.length} still have none` : ""}.`
              : "Nobody is marked Pass yet, so there is nothing to certify."}>
            {/* A-08 (24-Aug issues sheet). This button read "Issue certificates (17)", filled and
                enabled, directly above a sentence reading "0 can take a certificate now". Both were
                true and neither was wrong on its own - they answer DIFFERENT questions. The button
                counted every Pass; the sentence counts the passes with no certificate file yet
                (`certReady`). On AVP-GURU-RPLAVP-DST-02 all 17 passes already had a file, so one
                said 17 and the other said 0 and nothing on screen reconciled them.
                The fix is not to make the numbers agree - they are different facts - but to make the
                BUTTON say what pressing it will actually do, which on that batch is settle the
                certificate NUMBERS the header is already complaining are missing. One predicate per
                sentence, and the label names its own subject. */}
            <Btn small onClick={() => { setCertForm({ certificate_date: toInputDate(new Date()), prefix: "RPL/2026/", numbers: {} }); setCertDrawer(true); }} disabled={!passes.length}>
              {certReady.length
                ? `Issue certificates (${certReady.length})`
                : certNoNumber.length
                  ? `Add certificate numbers (${certNoNumber.length})`
                  : `Certificates (${passes.length})`}
            </Btn>
            {!passes.length && (
              <span className="text-[10px] font-medium text-amber-700">no candidate is marked Pass yet — mark results first</span>
            )}
          </span>
        </div>
      )}

      {/* -108, Umesh 17/08: "trainer ko rules pata thodi hote hain na — proper highlight karna
          chahiye ki kya issue aaya, format kya hona chahiye, sab kuch pehle hi bata do."
          Everything a trainer needs BEFORE picking a file, from data this screen already has. */}
      {batch?.status !== "Cancelled" && (
        <div className="mb-3 space-y-2 rounded-lg border border-gray-200 bg-white p-3">
          {/* 1. Is this roster even ready for automatic matching? This one line is what would have
                explained Manish's eight red lines: the files were right, the roster had no IDs. */}
          {linkPlan && (linkPlan.without_portal_id > 0 || linkPlan.linkable?.length > 0) && (
            <div className={`rounded-lg border px-3 py-2 text-xs ${linkPlan.with_portal_id === 0 ? "border-amber-300 bg-amber-50 text-amber-900" : "border-blue-200 bg-blue-50 text-blue-900"}`}>
              {/* QA-1278 (-250 cycle 2, checker): this sat four lines above a pill reading "No portal
                  ID (shown rows) 3" and said "0 of 4", because `linkPlan.roster` is the WHOLE roster
                  and the pill counts what this screen shows. Third population on one screen; the pill
                  named itself and this did not. Same remedy as QA-709 two comments down and QA-778
                  before it - each set states itself. */}
              <b>{linkPlan.with_portal_id} of {linkPlan.roster} on this batch{String.fromCharCode(8217)}s roster carry a portal ID.</b>{" "}
              {linkPlan.with_portal_id === 0
                ? "Automatic matching by filename cannot work at all until at least one does — a correctly named file will still be reported as “matches no candidate”."
                : ""}
              {/* QA-709 (-209, checker on qa-207): -207 wrote "N of them are blocking certification"
                  straight after "X of Y candidates carry a portal ID" — and "them" pointed at the
                  wrong set while N came from the other one, so a roster with two students missing an
                  ID could read "2 of 4 candidates carry a portal ID. 0 of them are blocking…". The
                  route comment in the same commit promises these two sets are never mixed; this
                  sentence mixed them one screen away. Each set now states itself, or says nothing. */}
              {(linkPlan.blocking ?? 0) > 0 && (
                <span className="ml-1">
                  Separately, <b>{linkPlan.blocking} enrolled student{linkPlan.blocking === 1 ? "" : "s"}</b> {linkPlan.blocking === 1 ? "has" : "have"} no portal Candidate ID, and certification cannot complete until {linkPlan.blocking === 1 ? "they do" : "they all do"}.
                </span>
              )}
              {linkPlan.linkable?.length > 0 && (
                <span className="ml-1">
                  The portal attendance already imported names <b>{linkPlan.linkable.length}</b> of them.
                  <button onClick={linkPortalIds} disabled={linking}
                    className="ml-2 rounded-lg bg-blue-600 px-2.5 py-1 font-medium text-white hover:bg-blue-700 disabled:bg-blue-300">
                    {linking ? "Linking…" : `Link portal IDs (${linkPlan.linkable.length})`}
                  </button>
                </span>
              )}
              {/* QA-720 (-211, checker on qa-209): "these" had nothing left to point at. -209 removed
                  the sentence that used to sit between, so on a roster where nobody is blocking, this
                  line bound straight to "X of Y candidates carry a portal ID" — telling the reader that
                  the students who HAVE an id have to be typed in from the portal, above an empty list.
                  It names its own subject now, and does not render at all when nothing is blocking.
                  Third correction to one paragraph in three releases. */}
              {!linkPlan.linkable?.length && (linkPlan.blocking ?? 0) > 0 && (
                <span className="ml-1">The imports name none of those {linkPlan.blocking}, so their IDs have to be typed in from the portal.</span>
              )}
              {/* -208 (Umesh, 23/08): "even attendance wale tab me bhi vo kar de, yeh closer wale
                  me kar dhe". The list of students with no portal ID is ONE component now, mounted
                  where the work happens - here on Certificates, and on Attendance where the centre
                  is every day. A second copy of the same widget is the drift ARCHITECTURE.md
                  section 3 is a catalogue of, and this one carries a WRITE. */}
              <PortalIdGaps batchId={batchId} onChanged={() => { load(); loadLinkPlan(); }} />
              {linkPlan.conflicts?.length > 0 && (
                <div className="mt-1 text-amber-800">
                  {linkPlan.conflicts.length} left untouched because the portal gives conflicting IDs: {personList(linkPlan.conflicts.slice(0, 3))}
                  {linkPlan.conflicts.length > 3 ? ` +${linkPlan.conflicts.length - 3}` : ""}.
                </div>
              )}
            </div>
          )}

          {/* 2. Who can take a certificate today, and who cannot — in words, not rule numbers. */}
          <p className="text-xs text-gray-600">
            <b className="text-green-700">{certReady.length} can take a certificate now</b> (Pass, none attached yet)
            {/* -162 (QA-396, Manish sir 20/08): “9 already have one · 9 without a certificate
                number : iska kya matlab hai bhai”. He was right — it reads as EIGHTEEN people.
                certNoNumber is certDone.filter(...), a SUBSET of the same nine, printed beside them
                as though it were a second group. One group, stated once, subset said as a subset. */}
            {certDone.length > 0 && <> · <span className="text-gray-500">{certDone.length} already have one</span>
              {certNoNumber.length > 0 && (
                <span className="cursor-help text-amber-700" title="The certificate file settles the candidate's status; the NUMBER is what invoicing and audits quote. Add it on each candidate's card (or in Issue certificates) when the awarding body sends it.">
                  {certNoNumber.length === certDone.length
                    ? ", and none of them carries a certificate number yet"
                    : `, ${certNoNumber.length} of them with no certificate number yet`}
                </span>
              )}</>}
            {pending.length > 0 && <> · <span className="text-amber-700">{pending.length} not marked yet — mark the result first</span></>}
            {notPassed.length > 0 && <> · <span className="text-gray-500">{notPassed.length} Fail/Absent — no certificate</span></>}
          </p>
          {/* -109: and the hours picture, split honestly. Lumping "no data" in with "did not make
              the bar" is what made 45 students at Bhadohi read "not eligible" over a parse failure. */}
          {attMeta?.verdict_counts && (
            <p className="text-xs text-gray-600">
              Attendance hours (bar {attMeta.required_hours} hrs
              {attMeta.portal_working_days ? `, portal shows ${attMeta.portal_working_days} working days` : ""}
              {attMeta.course_finished ? ", course over" : ", course still running"}):{" "}
              <span className="text-green-700">{attMeta.verdict_counts.qualified ?? 0} qualified</span>
              {/* -153 cycle 3 (QA-422): QA-413 made the PAYLOAD derive its buckets from
                  ELIGIBILITY_STATES and this sentence went on hand-listing six of the seven, so the
                  next state added would be counted, keep the pinned sum invariant true, and
                  silently not appear in the line a human reads. Anything without a phrase of its
                  own is named here rather than dropped. */}
              {Object.entries(attMeta.verdict_counts as Record<string, number>)
                .filter(([k, n]) => n > 0 && !["qualified", "in_progress", "no_hours", "awaiting_match", "not_eligible", "not_enrolled"].includes(k))
                .map(([k, n]) => <span key={k}> · <span className="text-gray-500">{n} {k.replace(/_/g, " ")}</span></span>)}
              {(attMeta.verdict_counts.in_progress ?? 0) > 0 && <> · <span className="text-amber-700">{attMeta.verdict_counts.in_progress} still short (course running)</span></>}
              {(attMeta.verdict_counts.no_hours ?? 0) > 0 && <> · <span className="text-gray-500">{attMeta.verdict_counts.no_hours} with <b>no portal hours imported</b></span></>}
              {/* -153 (QA-393): counted and named separately, because it is the only one of these
                  buckets somebody can clear from their own desk in two clicks. */}
              {(attMeta.verdict_counts.not_eligible ?? 0) > 0 && <> · <span className="text-red-700">{attMeta.verdict_counts.not_eligible} not eligible</span></>}
              {(attMeta.verdict_counts.not_enrolled ?? 0) > 0 && <> · <span className="text-gray-500">{attMeta.verdict_counts.not_enrolled} not enrolled yet</span></>}
              {/* A-04 (24-Aug issues sheet). `awaiting_match` is a REAL bucket of the partition, and
                  it was the one bucket with no phrase anywhere: the catch-all two branches above
                  names "anything without a phrase of its own", but the filter beside it EXCLUDES
                  awaiting_match by name, and no dedicated branch printed it. So it was silently
                  dropped from the sentence a human reads.
                  Measured on live -244, CHI-ITI-RPLAVP-BSRT-01: the line printed
                  "0 qualified · 41 still short (course running) · 2 not enrolled yet" = 43 against a
                  chip reading "All 45". The missing 2 were exactly this bucket.
                  It is NOT the same number as `awaiting_match_rows` below - that one is ungated and
                  cuts ACROSS the buckets (QA-432); this one is part of the partition. Both are
                  printed now, and each says which it is. */}
              {(attMeta.verdict_counts.awaiting_match ?? 0) > 0 && <> · <span className="text-amber-700" title="These students have portal hours waiting on a name match, so no hours verdict can be given yet. They are part of the roster breakdown - one of the buckets that add up to the active roster.">{attMeta.verdict_counts.awaiting_match} waiting on a portal match</span></>}
              {/* A-04 / A-05: the buckets above partition the ACTIVE roster. A member who has left is
                  in none of them, while the tab chip beside this line counts the whole roster - so on
                  BHA-ITI-RPLHSL-SPIT-01 the sentence read 45 under a chip reading "All 46" and there
                  was no bucket to put the 46th in. Named here, so the line accounts for everybody. */}
              {(attMeta.left_count ?? 0) > 0 && <> · <span className="text-gray-500" title="These members left the batch, so they get no attendance verdict. They are still on the roster, which is why the roster count is higher than the buckets above.">{attMeta.left_count} left the batch</span></>}
              {/* -156 (QA-432): reads the ROW count, not the journey-gated bucket - a not-enrolled
                  student with an unattached row is still a row somebody must resolve, and this line
                  used to leave them out while three chips on the same page showed them.
                  IT IS NOT A SEVENTH BUCKET, and it is placed after the partition and says so
                  out loud: every name in it is ALSO counted in one of the groups above (usually
                  "not enrolled yet"), so a reader who summed a bucket-shaped list would get more
                  than the roster. The buckets partition; this cuts across them. */}
              {(attMeta.awaiting_match_rows ?? 0) > 0 && <> · <Link href="/govt-attendance" className="font-medium text-amber-700 hover:underline" title="The export carries a row under each of these names and none is attached to a student yet. These students are also counted above under their own status - this is a separate thing to clear, not another group.">{attMeta.awaiting_match_rows} of them have <b>portal rows here but unmatched</b> (counted above too) — resolve →</Link></>}
            </p>
          )}

          {/* 3. This batch's REAL expected filenames, copyable. Built with the same normalisation the
                matcher uses, so the list can never disagree with what the matcher accepts. */}
          {expectedNames.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-blue-700">Expected file names for this batch ({expectedNames.length}) — rename to these and every file will land on its own</summary>
              <div className="mt-1 flex items-start gap-2">
                <pre className="max-h-40 flex-1 overflow-auto rounded-lg bg-gray-50 p-2 font-mono text-[11px] leading-5">{expectedNames.map((e) => `${e.file}   ${e.name}`).join("\n")}</pre>
                <Btn small kind="ghost" onClick={() => navigator.clipboard?.writeText(expectedNames.map((e) => `${e.file}\t${e.name}`).join("\n"))}>Copy</Btn>
              </div>
            </details>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {/* QA-879 (checker on qa-224 cycle 2; reproduced in a browser on a real Trainer login,
                evidence-24-08/live229/trainer-login-closure-permission-reason.png): this control
                rendered ENABLED for anyone who could see the tab, and choosing a file fired
                POST /certificates -> 403. That is worse than a dead button - the certificate path
                pushes the bytes to STORAGE before the server refuses, so a login without the right
                could still spend an upload before being told no. Its per-candidate twin has asked
                `mayMark` since -217 (see the comment above that one); only the BULK control was left
                behind, which is why -229 shipped with every other control on this card correct and
                this one still live. It does not vanish silently either: QA-825 was a door that
                disappeared instead of refusing, so the reason takes its place, in the same words the
                Closure card already uses for Save and Mark Completed. */}
            {mayMark ? (
              <label className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium text-white ${uploading ? "bg-gray-400" : "bg-blue-600 hover:bg-blue-700"}`}>
                {uploading ? "Reading…" : "⬆ Upload certificates (bulk)"}
                <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden" disabled={uploading}
                  onChange={(e) => { uploadCertificates(e.target.files); e.target.value = ""; }} />
              </label>
            ) : (
              <span className="text-xs font-medium text-gray-500">read-only for your login — ask an Admin for the right to upload certificates</span>
            )}
            {compressNote && <span className="text-xs text-gray-500">{compressNote}</span>}
            {mayMark && <span className="cursor-help text-xs text-gray-500" title="Every file is shown with the candidate it is going to, and you can change any of them, before anything is saved. A file named CAN_12345.pdf is matched for you. Or upload from a candidate's own card below — no file name needed.">
              Preview first, then save · <span className="font-mono">CAN_12345.pdf</span> matches itself · <span className="underline decoration-dotted">?</span>
            </span>}
          </div>

          {linkNote && <Notice kind="success" onDismiss={() => setLinkNote(null)}>{linkNote}</Notice>}
          {/* -111 (Umesh 18/08, "certificate upload ke baad notification aata hai aur wahin reh jaata
              hai"): the report is two notices now. What WORKED is a success notice — × to dismiss, and
              it leaves by itself in ~15s. What was REFUSED stays until dismissed, because a refusal
              is something to act on, not to glance at. */}
          {certUpload && (certOk || (certUpload.refused ?? []).length > 0) && (
            <div className="space-y-2 border-t border-gray-100 pt-2 text-xs">
              {certOk && (
                <Notice kind={(certUpload.summary?.attached ?? 0) > 0 ? "success" : "info"} onDismiss={() => setCertOk(false)}>
                  <p className="font-medium">
                    {certUpload.summary?.attached ?? 0} attached
                    {certUpload.summary?.discarded ? ` · ${certUpload.summary.discarded} discarded` : ""}
                    {certUpload.linked != null ? ` · ${certUpload.linked} portal IDs linked` : ""}
                  </p>
                  {(certUpload.attached ?? []).map((m: any, i: number) => (
                    <p key={`a${i}`}>✓ {m.original} → {m.candidate}</p>
                  ))}
                </Notice>
              )}
              {(certUpload.refused ?? []).length > 0 && (
                <Notice kind="error" onDismiss={() => setCertUpload((c: any) => c && { ...c, refused: [] })}>
                  <p className="font-medium">{certUpload.refused.length} refused — fix and upload again</p>
                  {certUpload.refused.map((u: any, i: number) => (
                    <p key={`r${i}`}>✗ {u.reason}</p>
                  ))}
                </Notice>
              )}
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
          {/* QA-748: the filter strip. Counts come from the fetched set, so it doubles as the
              at-a-glance summary - "45 me se kitne kya" without opening anything. */}
          <div className="mb-3 space-y-2">
            <FilterPills active={cardFilter} onChange={setCardFilter}
              options={CARD_FILTERS.map((f) => ({ value: f.value, label: f.label, title: f.title, count: visible.filter(f.test).length }))} />
            {/* The two-population fact, in WORDS, under the strip whose numbers it explains.
                `attMeta.left_count` a few lines down answers a different question - "how many left
                the batch" - and that one belongs to the attendance partition. This one answers "of
                those, how many can you see here and how many can you not", which is the question a
                reader of THIS grid actually has. A-04's whole lesson was that a number cutting across
                a partition has to say so. */}
            {(leftHidden.length > 0 || leftShown.length > 0) && (
              <p className="text-[11px] leading-4 text-gray-500">
                {leftHidden.length > 0 && (
                  <>{leftHidden.length} student{leftHidden.length === 1 ? "" : "s"} who left this batch {leftHidden.length === 1 ? "is" : "are"} not shown
                    {" "}— no result was recorded, so their record lives on the Candidates tab.{" "}</>
                )}
                {leftShown.length > 0 && (
                  <>{leftShown.length} card{leftShown.length === 1 ? "" : "s"} below belong{leftShown.length === 1 ? "s" : ""} to {leftShown.length === 1 ? "a student" : "students"} who left — kept because a result is on record, and read-only.</>
                )}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <input className="w-64 rounded-lg border border-gray-300 px-2 py-1 text-sm"
                placeholder="Search name, phone, Candidate ID or APAAR ID…"
                value={cardSearch} onChange={(e) => setCardSearch(e.target.value)} />
              {(cardFilter !== "all" || q) && (
                <>
                  <span className="text-xs text-gray-500">showing {shown.length} of {visible.length}</span>
                  <button type="button" className="text-xs font-medium text-blue-700 hover:underline"
                    onClick={() => { setCardFilter("all"); setCardSearch(""); }}>clear</button>
                </>
              )}
            </div>
          </div>
          {/* An empty result says so. A screen that just goes blank reads as broken. */}
          {shown.length === 0 && (
            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-4 text-sm text-gray-600">
              No student on this batch matches {cardFilter === "all" ? "that search" : `"${CARD_FILTERS.find((f) => f.value === cardFilter)?.label}"`}
              {q ? ` and "${cardSearch.trim()}"` : ""}. <button type="button" className="font-medium text-blue-700 hover:underline" onClick={() => { setCardFilter("all"); setCardSearch(""); }}>Show everyone</button>
            </div>
          )}
          <div className="hidden gap-3 md:grid md:grid-cols-2 xl:grid-cols-3">
            {shown.map((i) => <Card key={i.member} i={i} />)}
          </div>
          <div className="md:hidden">
            {shown.length > 0 && <Card i={shown[Math.min(idx, shown.length - 1)]} />}
            {shown.length === 0 && null}
            {/* -235 (QA-968-note-QA-789, checker on qa-232 cycle 1): -216 rebuilt this pager onto
                `shown` and I then proposed CLOSING the row - wrongly. The counter was right about the
                list but the pager still RENDERED on an empty one, so a filter matching nothing showed
                the honest "no candidate matches" line and, directly beneath it, "1 / 0". Two answers
                to one question again, one of them impossible. A pager for nothing is nothing. */}
            {shown.length > 0 && <div className="mt-3 flex items-center justify-between">
              {/* QA-779 (-216, checker on qa-214): this was bound to `items` while the card beside it
                  renders `shown`, so a filter with one result read "1 / 12" and Next walked the
                  counter while the card never changed. The pager belongs to the list on screen. */}
              <Btn kind="ghost" onClick={() => setIdx((v) => Math.max(0, v - 1))} disabled={idx === 0}>← Prev</Btn>
              <span className="text-sm text-gray-500">{Math.min(idx + 1, Math.max(shown.length, 1))} / {shown.length}</span>
              <Btn kind="ghost" onClick={() => setIdx((v) => Math.min(shown.length - 1, v + 1))} disabled={idx >= shown.length - 1}>Next →</Btn>
            </div>}
          </div>
        </>
      )}

      {/* -108, Umesh 17/08: "bulk me karay toh mapping kar le ki ye certificate kis bachche ka hai…
          plus preview mapping — agar koi wrong auto map hua ya nahi map ho paye toh preview me map
          kar sakte hain, har certificate ke aligned." Every staged file, its proposed candidate,
          changeable — and nothing is written until Attach. */}
      <Drawer open={!!mapping} onClose={cancelMapping} title="Map each certificate to its candidate" wide error={error}>
        {mapping && (() => {
          const byMember = new Map((mapping.candidates ?? []).map((c: any) => [c.member, c]));
          const chosenCount = new Map<string, number>();
          for (const s of mapping.staged ?? []) {
            const m = mapping.choice[s.url];
            if (m) chosenCount.set(m, (chosenCount.get(m) ?? 0) + 1);
          }
          const rowState = (s: any) => {
            const m = mapping.choice[s.url];
            if (!m) return { tone: "border-gray-200", msg: s.reason ?? "not mapped — this file will be discarded", bad: true };
            if ((chosenCount.get(m) ?? 0) > 1) return { tone: "border-red-300 bg-red-50", msg: "two files point at this same candidate — only one certificate per candidate", bad: true };
            const c: any = byMember.get(m);
            if (!c) return { tone: "border-red-300 bg-red-50", msg: "that candidate is not on this roster", bad: true };
            if (c.result !== "Pass") {
              return {
                tone: "border-amber-300 bg-amber-50", bad: true,
                msg: c.result ? `${c.name}: result is ${c.result} — a certificate needs a Pass` : `${c.name}: result not marked yet — mark Pass and this will attach`,
                markPass: !c.result || c.result === "Pending" ? m : null,
              };
            }
            if (c.has_certificate) return { tone: "border-blue-200 bg-blue-50", msg: `${c.name} already has a certificate — this replaces it and the old file is removed`, bad: false };
            return { tone: "border-green-200 bg-green-50", msg: `${c.name} — ready to attach`, bad: false };
          };
          const rows = (mapping.staged ?? []).map((s: any) => ({ s, st: rowState(s) }));
          const okCount = rows.filter((r: any) => !r.st.bad && mapping.choice[r.s.url]).length;
          return (
            <div className="space-y-3">
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
                <b>{mapping.summary?.staged ?? 0} file{(mapping.summary?.staged ?? 0) === 1 ? "" : "s"} uploaded, {mapping.summary?.auto_matched ?? 0} matched automatically.</b>{" "}
                Nothing is saved yet. Change any candidate below, then press Attach.
                {mapping.roster_has_no_portal_ids && (
                  <div className="mt-1 text-amber-800">
                    No candidate on this roster has a portal ID, so none of these could be matched by file name — <b>your files are not the problem</b>. Pick each candidate here, or close this and use <b>Link portal IDs</b> first.
                  </div>
                )}
                {mapping.discarded_stale > 0 && <div className="mt-1 text-gray-500">{mapping.discarded_stale} file(s) left over from an earlier unfinished upload were discarded.</div>}
              </div>

              {(mapping.rejected ?? []).map((r: any, n: number) => (
                <p key={`rej${n}`} className="text-xs text-red-700">✗ {r.filename} — {r.reason}</p>
              ))}

              <div className="max-h-[26rem] space-y-2 overflow-y-auto">
                {rows.map(({ s, st }: any) => (
                  <div key={s.url} className={`rounded-lg border p-2 text-xs ${st.tone}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <a className="min-w-0 flex-1 truncate font-medium text-blue-700 underline" href={s.url} target="_blank" rel="noreferrer" title="Open the uploaded file to check it is the right one">
                        {s.original_name}
                      </a>
                      <span className="shrink-0 text-gray-400">{fmtBytes(s.size)}</span>
                      <select className="max-w-64 rounded-lg border border-gray-300 px-2 py-1"
                        value={mapping.choice[s.url] ?? ""}
                        onChange={(e) => setMapping({ ...mapping, choice: { ...mapping.choice, [s.url]: e.target.value } })}>
                        <option value="">— not mapped (discard) —</option>
                        {(mapping.candidates ?? []).map((c: any) => (
                          <option key={c.member} value={c.member}>
                            {c.name}{c.portal_id ? ` · ${c.portal_id}` : ""}{c.phone ? ` · ${c.phone}` : ""}
                            {c.result === "Pass" ? (c.has_certificate ? " · Pass, has one" : " · Pass") : c.result ? ` · ${c.result}` : " · not marked"}
                            {c.left_on ? ` · left ${fmtDate(c.left_on)}` : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <span className={st.bad ? "text-amber-800" : "text-green-800"}>{st.msg}</span>
                      {s.match_by && mapping.choice[s.url] === s.member && <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px] text-gray-500">matched by {s.match_by}</span>}
                      {mapping.choice[s.url] && mapping.choice[s.url] !== s.member && <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px] text-gray-500">you chose this</span>}
                      {st.markPass && (
                        <button className="rounded-lg border border-amber-500 px-2 py-0.5 font-medium text-amber-800 hover:bg-amber-100"
                          onClick={async () => {
                            await mark(st.markPass, { result: "Pass" });
                            const fresh = await api(`/api/batches/${batchId}/results`).then((d) => d.items).catch(() => null);
                            if (fresh) {
                              const row = fresh.find((x: any) => String(x.member) === String(st.markPass));
                              setMapping((mp: any) => mp && ({
                                ...mp,
                                candidates: (mp.candidates ?? []).map((c: any) => c.member === st.markPass
                                  ? { ...c, result: row?.result?.result ?? "Pass", has_certificate: !!row?.result?.certificate_file } : c),
                              }));
                            }
                          }}>Mark Pass</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-3 border-t border-gray-100 pt-2">
                <Btn onClick={confirmMapping} disabled={uploading || !okCount}>
                  {uploading ? "Attaching…" : `Attach ${okCount} certificate${okCount === 1 ? "" : "s"}`}
                </Btn>
                <Btn kind="ghost" onClick={cancelMapping} disabled={uploading}>Cancel &amp; discard</Btn>
                <span className="text-xs text-gray-500">
                  {rows.length - okCount > 0 ? `${rows.length - okCount} file(s) will not be attached${rows.some((r: any) => !mapping.choice[r.s.url]) ? " — unmapped ones are discarded" : ""}.` : "Every file is mapped and ready."}
                </span>
              </div>
            </div>
          );
        })()}
      </Drawer>

      <Drawer error={error} open={certDrawer} onClose={() => setCertDrawer(false)} title="Issue certificates" wide>
        <div className="space-y-3">
          <p className="text-sm text-gray-600">Only candidates who passed appear here — no certificate without a Pass.</p>
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
            // -224 cycle 2 (QA-862, checker on cycle 1). This loop is the NINTH failure path in this
            // panel and cycle 1 missed it - and it is the real action behind the very button Umesh
            // named. Three faults in five lines: the catch reported only to the page-top banner; each
            // iteration's setError OVERWROTE the previous, so N refusals arrived as one; and the
            // drawer closed itself unconditionally, so what was left of the message surfaced only
            // after the thing the operator was reading had vanished. The checker drove it rather than
            // reading it - three candidates Pass, ZERO issued, THREE failures, ONE message shown.
            // `Drawer` already takes an `error` slot and this one is passed it; closing the drawer on
            // failure is exactly what made that slot useless. So: keep every refusal, name every
            // candidate, and close ONLY on success.
            const failures: string[] = [];
            // -224 cycle 3 (QA-886, second checker): a candidate with no number was skipped in
            // SILENCE as long as one other candidate had one - measured 3 Pass, 1 number typed, 1
            // Issued, 2 left Pending, drawer closed, nothing said. Cycle 2 added the all-blank
            // message and stopped one step short of the partial case, which is the same defect
            // QA-857 named for bulkApply: a partial write that reports as a clean success.
            const skipped: string[] = [];
            let issued = 0, numbered = 0;
            for (const p of passes) {
              const no = certForm.numbers?.[p.result._id] ?? p.result.certificate_no;
              if (!no) { skipped.push(p.candidate?.name ?? "This candidate"); continue; }
              numbered++;
              try {
                if (p.result.certificate_status === "Pending") await api(`/api/results/${p.result._id}`, { method: "PATCH", json: { certificate_status: "Processing" } });
                if (["Pending", "Processing"].includes(p.result.certificate_status)) {
                  await api(`/api/results/${p.result._id}`, { method: "PATCH", json: { certificate_status: "Generated", certificate_no: no, certificate_date: certForm.certificate_date } });
                }
                await api(`/api/results/${p.result._id}`, { method: "PATCH", json: { certificate_status: "Issued" } });
                issued++;
              } catch (e: any) { failures.push(`${p.candidate?.name ?? "This candidate"}: ${e?.message ?? String(e)}`); }
            }
            await load(); onChanged();
            const names = (xs: string[]) => `${xs.slice(0, 3).join(" · ")}${xs.length > 3 ? ` · +${xs.length - 3} more` : ""}`;
            const skippedClause = skipped.length
              ? ` · ${skipped.length} left out, no certificate number typed yet (${names(skipped)})` : "";
            if (failures.length) {
              report(`${issued} issued · ${failures.length} refused — ${names(failures)}${skippedClause}`);
              return; // the drawer STAYS OPEN, carrying the message beside the rows it is about
            }
            if (!numbered) {
              report("No certificate number is filled in yet, so there was nothing to issue. Type the numbers the awarding body sent, or press Fill to number them in a series.");
              return;
            }
            if (skipped.length) {
              // Some went, some never had a number. That is a PARTIAL write, and a partial write
              // that closes its own drawer and says nothing is exactly QA-857's shape.
              report(`${issued} issued${skippedClause}`);
              return;
            }
            // -224 cycle 3 (QA-877, extended by the second checker): the success branch cleared
            // gridError and never the page-top banner, so a clean run left the PREVIOUS refusal
            // standing on screen, contradicting what had just happened. `setError(null)` appeared
            // zero times in this file before this line.
            setGridError(null); setError("");
            setCertDrawer(false);
          }}>Generate &amp; issue</Btn>
        </div>
      </Drawer>
    </Section>
  );
}

// ---------- Costs tab ----------
// ---------- Feedback tab (2026-08-11: "हर बच्चा… feedback दे पाए") ----------
function FeedbackTab({ batchId, error, setError }: any) {
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
        {/* -133 (QA-282): same shape as the attendance panel above — opened by "Get feedback
            links", and setLinks(null) existed nowhere. */}
        {links && (
          <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm">
            {/* 2026-08-12 (Manish): SMS alongside WhatsApp — rural candidates are not reliably on WhatsApp. */}
            <div className="mb-2 flex items-start justify-between gap-2">
              <div className="font-medium text-blue-800">One link per candidate — send on WhatsApp or SMS:</div>
              <button onClick={() => setLinks(null)} aria-label="Close" title="Close"
                className="-mt-1 shrink-0 text-xl leading-none text-blue-400 hover:text-blue-700">×</button>
            </div>
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

function CostsTab({ batchId, batch, error, setError }: any) {
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
        storageKey="batch-costs"
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

// -91 (Umesh: "pehle compress, phir upload"): record evidence IN the app at the Admin's video
// targets (720p / 1500 kbps by default) — the clip is compressed at source, nothing to
// transcode, and it goes straight into the same upload path (resumable when Drive is on).
function VideoRecorder({ open, onClose, onRecorded }: { open: boolean; onClose: () => void; onRecorded: (f: File) => void }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [secs, setSecs] = useState(0);
  const [bytes, setBytes] = useState(0);
  const [err, setErr] = useState("");
  const [knobs, setKnobs] = useState<VideoKnobs | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      try {
        const k = await videoKnobs(); if (!alive) return; setKnobs(k);
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: Math.round(k.video_max_height * 16 / 9) }, height: { ideal: k.video_max_height }, frameRate: { ideal: 25 } }, audio: true });
        if (!alive) { s.getTracks().forEach((t) => t.stop()); return; }
        setStream(s);
        if (videoRef.current) { videoRef.current.srcObject = s; videoRef.current.muted = true; await videoRef.current.play().catch(() => {}); }
      } catch (e: any) { setErr(e?.message ?? "Camera not available"); }
    })();
    return () => { alive = false; };
  }, [open]);
  useEffect(() => { if (!open) { stream?.getTracks().forEach((t) => t.stop()); setStream(null); setRec(null); setSecs(0); setBytes(0); setErr(""); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!rec) return; const id = setInterval(() => setSecs((x) => x + 1), 1000); return () => clearInterval(id); }, [rec]);
  const start = () => {
    if (!stream || !knobs) return;
    const mime = pickRecorderMime();
    if (!mime) { setErr("This browser cannot record video — pick a file instead."); return; }
    chunksRef.current = [];
    const r = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: knobs.video_bitrate_kbps * 1000, audioBitsPerSecond: knobs.video_audio_kbps * 1000 });
    r.ondataavailable = (e) => { if (e.data?.size) { chunksRef.current.push(e.data); setBytes((b) => b + e.data.size); } };
    r.onstop = () => {
      const ext = mime.startsWith("video/mp4") ? ".mp4" : ".webm";
      const f = new File(chunksRef.current, `evidence-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}${ext}`, { type: mime.split(";")[0] });
      onRecorded(f);
    };
    r.start(1000);
    setRec(r); setSecs(0); setBytes(0);
  };
  const stop = () => { rec?.stop(); setRec(null); };
  if (!open) return null;
  return (
    <Drawer error={err} open={open} onClose={() => { if (rec) stop(); onClose(); }} title="Record video evidence">
      <div className="space-y-3">
        <video ref={videoRef} playsInline muted className="w-full rounded-lg bg-black" />
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {knobs && <span className="text-gray-500">{knobs.video_max_height}p · {knobs.video_bitrate_kbps} kbps ≈ {Math.round(knobs.video_bitrate_kbps * 60 / 8 / 1024 * 10) / 10} MB/min</span>}
          {rec && <span className="font-medium text-red-600">● {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")} · {fmtBytes(bytes)}</span>}
        </div>
        <div className="flex gap-2">
          {!rec ? <Btn onClick={start} disabled={!stream}>Start recording</Btn> : <Btn kind="danger" onClick={stop}>Stop & upload</Btn>}
          <Btn kind="ghost" onClick={() => { if (rec) { rec.onstop = null; rec.stop(); setRec(null); } onClose(); }}>Cancel</Btn>
        </div>
        <p className="text-[11px] text-gray-400">Recorded at the Admin's compression targets, so nothing large ever leaves the phone; the upload resumes on its own if the signal drops.</p>
      </div>
    </Drawer>
  );
}
