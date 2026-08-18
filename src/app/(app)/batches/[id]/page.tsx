"use client";
import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { api, fmtDate, toInputDate } from "@/lib/client";
import { trainerSelectGroups } from "@/lib/trainer-select";
import { slotHoursPerDay } from "@/lib/slot-rules";
import { BackLink, Btn, Chip, CopyBtn, DataTable, Drawer, ErrorBanner, Field, HealthBanner, NameCell, Notice, Section, Tabs, inputCls, statusLabel } from "@/components/ui";
import { Activity } from "@/components/activity";
import { usePerms } from "@/components/shell";
import { flushQueue, fmtBytes, getLastUploadInfo, getQueue, pickRecorderMime, uploadWithRetry, videoKnobs, type VideoKnobs } from "@/lib/upload";
import { BASE_PATH } from "@/lib/base-path";
import { bulkSmsCsv, smsLink, waLink } from "@/lib/messaging";

const TABS = ["Overview", "Candidates", "Enrollment", "Daily Execution", "Attendance", "Closure", "Feedback", "Costs", "Activity"];

export default function BatchDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const sp = useSearchParams();
  // 2026-08-13 (Umesh role matrix): the tabs a login cannot use are not shown to it —
  // Costs is finance-only (a Location user only ever got a 403 banner from it), and the
  // server remains the real gate either way.
  const { data: session } = useSession();
  const role = (session?.user as any)?.role;
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
            <Link href="/candidates"><Btn small kind="ghost">Import candidates (Excel)</Btn></Link>
            {role === "Admin" && (
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
      {tab === "Overview" && <Overview data={data} role={role} onChanged={load} setError={setError} />}
      {tab === "Candidates" && <Roster batchId={id} batch={b} setError={setError} onChanged={load} />}
      {tab === "Enrollment" && <Enrollment batchId={id} setError={setError} />}
      {tab === "Daily Execution" && <DailyExecution batchId={id} batch={b} role={role} setError={setError} />}
      {tab === "Attendance" && <AttendanceTab batchId={id} batch={data.item} role={role} setError={setError} />}
      {tab === "Closure" && <ClosureTab batchId={id} batch={b} role={role} setError={setError} onChanged={load} />}
      {tab === "Feedback" && <FeedbackTab batchId={id} setError={setError} />}
      {tab === "Costs" && role === "Admin" && <CostsTab batchId={id} batch={b} setError={setError} />}
      {tab === "Activity" && <Activity entity="Batch" id={id} />}
    </div>
  );
}

// ---------- Overview: readiness checklist (Rule 16) + transitions ----------
function Overview({ data, role, onChanged, setError }: any) {
  const b = data.item;
  // -88 (Umesh): once a batch runs, the Overview says so in numbers — running since when,
  // day N of M, our logged days, the portal's working days, who is qualified — instead of a
  // readiness checklist for a batch that already started.
  const [att, setAtt] = useState<any>(null);
  useEffect(() => {
    if (!["Active", "Closing", "Completed", "Closed"].includes(b.status)) { setAtt(null); return; }
    api(`/api/batches/${b._id}/attendance`).then(setAtt).catch(() => setAtt(null));
  }, [b._id, b.status]);
  const running = ["Active", "Closing", "Completed", "Closed"].includes(b.status);
  const dayN = b.actual_start ? Math.max(1, Math.floor((Date.now() - new Date(b.actual_start).getTime()) / 864e5) + 1) : null;
  const dayM = b.program?.duration_days ?? (b.planned_start && b.planned_end ? Math.round((new Date(b.planned_end).getTime() - new Date(b.planned_start).getTime()) / 864e5) + 1 : null);
  const withPortal = (att?.members ?? []).filter((m: any) => m.govt);
  const portalDays = withPortal.length ? Math.max(0, ...withPortal.map((m: any) => Number(m.govt?.working_days ?? 0))) : 0;
  // Umesh role matrix: "no batch edit" for principal/SPOC — the server 403s regardless
  // (batches.manage removed from the Location role); the buttons simply are not offered.
  const canTransition = role !== "Location" && role !== "Trainer" && role !== "Enrollment";
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
    if (!isAdmin || !["Active", "Closing"].includes(b.status)) { setCompletePlan(null); return; }
    api(`/api/batches/${b._id}/complete`).then(setCompletePlan).catch(() => setCompletePlan(null));
  }, [b._id, b.status, isAdmin]);
  async function completeAsAdmin() {
    if (!completeReason.trim()) { setError("Say why this batch is being completed — it is recorded against every row it settles."); return; }
    setCompleting(true);
    try {
      const res = await api(`/api/batches/${b._id}/complete`, { method: "POST", json: { reason: completeReason.trim() } });
      setCompleteOpen(false); setCompleteReason("");
      onChanged();
      if (res?.settled) setError("");
    } catch (e: any) { setError(e.message); }
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
  const todayKey = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); // IST calendar day
  const beganAlready = !!plannedStartKey && plannedStartKey < todayKey && ["Planning", "Ready"].includes(b.status);
  const [startDate, setStartDate] = useState<string>(plannedStartKey);

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
        <details className="rounded-xl border border-gray-200/80 bg-white px-4 py-2 text-sm">
          <summary className="cursor-pointer text-sm font-semibold text-gray-500">Readiness checklist ({CHECKS.filter(([, , v]) => v).length}/{CHECKS.length}) — preparation record, this batch has started</summary>
          <ul className="mt-2 space-y-1 text-xs text-gray-500">
            {CHECKS.map(([k, label, ok]) => <li key={k}>{ok ? "✓" : "○"} {label}</li>)}
          </ul>
        </details>
      ) : (
      <Section title={`Readiness checklist (${CHECKS.filter(([, , v]) => v).length}/${CHECKS.length})`}>
        {beganAlready && (
          <p className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Planned start {fmtDate(b.planned_start)} has passed — this batch is being entered after it began.
            When you Start it, set the real start date so attendance can be recorded from that day.
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
        {canTransition ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {b.status === "Planning" && <Btn onClick={() => transition("Ready")} disabled={!r.ready}>Mark Ready</Btn>}
            {b.status === "Ready" && !beganAlready && <Btn onClick={() => transition("Active")}>Start Batch</Btn>}
            {b.status === "Ready" && beganAlready && (
              <span className="inline-flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1">
                <label className="text-xs text-amber-800">Batch already began on</label>
                <input type="date" className="rounded-lg border border-gray-300 px-2 py-1 text-xs" value={startDate} max={todayKey} onChange={(e) => setStartDate(e.target.value)} />
                <Btn onClick={() => transition("Active", { actual_start: startDate || undefined })} disabled={!startDate}>Start Batch from that date</Btn>
              </span>
            )}
            {b.status === "Ready" && <Btn kind="ghost" onClick={() => transition("Planning")}>Back to Planning</Btn>}
            {/* -102: the client's words for these two steps. Targets stay the stored enum. */}
            {b.status === "Active" && <Btn onClick={() => transition("Closing")}>Assessment done → Result Awaited</Btn>}
            {/* -113: the Admin's own door, on Active as well as Result Awaited. It is offered whether
                or not the rules are already satisfied — when they are, it simply completes; when they
                are not, the panel below says what it will settle first. */}
            {isAdmin && ["Active", "Closing"].includes(b.status) && (
              <Btn kind={b.status === "Closing" ? "ghost" : "primary"} onClick={() => setCompleteOpen((v) => !v)}>Mark Completed (Admin)</Btn>
            )}
            {/* -112 (QA-219 / Manish M4-01 "status aayega certification done"): when every result is
                final and every pass has its certificate, the two closure halves derive themselves and
                the batch walks to Result Awaited on its own. The one press left is the freeze, and it
                says so — it used to bounce off Rule 18 with nothing on screen explaining why. */}
            {b.status === "Closing" && (
              <span className="inline-flex flex-col gap-0.5">
                <Btn onClick={() => transition("Completed")}>{money?.closure?.certification_status === "Completed" ? "Certification done → Complete Batch" : "Complete Batch"}</Btn>
                <span className="text-[10px] font-medium text-gray-500">
                  {money?.closure?.certification_status === "Completed"
                    ? "Every certificate is settled. Completing freezes the results and figures."
                    : "Waiting on certificates — each passed candidate needs one attached (or marked Not Issued)."}
                </span>
              </span>
            )}
            {/* -113: completing is one press now, so it needs an undo. Admin only, reason required,
                audited — and never offered on a CLOSED batch, which is a settlement, not a record. */}
            {isAdmin && b.status === "Completed" && (
              <Btn kind="ghost" onClick={() => {
                const why = window.prompt("Reopen this completed batch? Results and certificates become editable again. Reason:");
                if (why && why.trim()) transition("Closing", { reason: why.trim() });
              }}>Reopen (Admin)</Btn>
            )}
            {/* Rule 52: Completed = training over; Closed = money over (cert + invoice PAID + no dues). */}
            {b.status === "Completed" && (
              <span title={closeBlockers.length ? `Still needed before the batch can close: ${closeBlockers.join("; ")}` : "All dues settled — the batch can close"} className="inline-flex flex-col gap-0.5">
                <Btn onClick={() => transition("Closed")} disabled={money !== null && closeBlockers.length > 0}>Close Batch (no dues)</Btn>
                {money !== null && closeBlockers.length > 0 && (
                  <span className="text-[10px] font-medium text-amber-700">needs: {closeBlockers.join(" · ")}</span>
                )}
              </span>
            )}
            {["Planning", "Ready", "Active"].includes(b.status) && <Btn kind="danger" onClick={() => setConfirmCancel(true)}>Cancel Batch</Btn>}
          </div>
        ) : (
          <p className="mt-4 text-xs text-gray-400">Batch status is moved by Operations/Admin.</p>
        )}
      </Section>
      )}
      {completeOpen && isAdmin && ["Active", "Closing"].includes(b.status) && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
          <div className="font-semibold text-amber-900">Complete this batch now</div>
          {completePlan?.can_complete_cleanly ? (
            <p className="mt-1 text-amber-800">Every student is marked and every certificate is settled — this just completes the batch.</p>
          ) : (
            <div className="mt-1 space-y-1 text-amber-800">
              <p>This batch still has rows nobody finished. Completing now records them the honest way:</p>
              <ul className="ml-4 list-disc">
                {(completePlan?.unmarked?.length ?? 0) > 0 && (
                  <li><b>{completePlan.unmarked.length} student(s) with no result → Absent</b>
                    <span className="text-amber-700"> ({completePlan.unmarked.slice(0, 4).map((u: any) => u.name).filter(Boolean).join(", ")}{completePlan.unmarked.length > 4 ? ` +${completePlan.unmarked.length - 4}` : ""})</span></li>
                )}
                {(completePlan?.unsettled?.length ?? 0) > 0 && (
                  <li><b>{completePlan.unsettled.length} passed candidate(s) with no certificate → Not Issued</b>
                    <span className="text-amber-700"> ({completePlan.unsettled.slice(0, 4).map((u: any) => u.name).filter(Boolean).join(", ")})</span></li>
                )}
              </ul>
              <p className="text-xs">Every one of those rows is audited with your reason. If a student really passed, mark them first — this is the door for a batch that is over, not a shortcut through data entry.</p>
            </div>
          )}
          <p className="mt-2 text-xs text-amber-800">Completing freezes the results and figures. You can reopen it later (Admin, with a reason).</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input className={inputCls + " max-w-md"} placeholder="Reason (recorded on every row this settles)" value={completeReason} onChange={(e) => setCompleteReason(e.target.value)} />
            <Btn onClick={completeAsAdmin} disabled={completing || !completeReason.trim()}>{completing ? "Completing…" : "Complete batch"}</Btn>
            <Btn kind="ghost" onClick={() => setCompleteOpen(false)}>Cancel</Btn>
          </div>
        </div>
      )}
      {/* QA-055 (checker): a SPOC saw the full editable Details card with a Save button the
          server refuses (403). Editors get the form; everyone else gets the same facts
          read-only — no button that only exists to bounce. */}
      <Section title="Details">
        {/* QA-007 (15/08): a finished batch with no portal id, no Drive folder or no time
            slot is an evidence gap the client can ask about — name what is missing instead
            of leaving blanks nobody notices. */}
        {["Closing", "Completed"].includes(b.status) && (!b.govt_batch_id || !b.drive_folder_url || !b.slot_start) && (
          <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Still missing on this finished batch: {[
              !b.govt_batch_id && "the SIDH batch ID",
              !b.drive_folder_url && "the Drive evidence folder",
              !b.slot_start && "the time slot",
            ].filter(Boolean).join(" · ")} — fill them below so the record stands on its own.
          </div>
        )}
        {canTransition
          ? <EditDetails b={b} onChanged={onChanged} setError={setError} />
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
      <Drawer open={confirmCancel} onClose={() => setConfirmCancel(false)} title={`Cancel batch ${b.code}?`}>
        <div className="space-y-3">
          <p className="text-sm text-gray-600">This is destructive. A batch with daily logs can only be force-closed by Admin, with a reason.</p>
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
    relevant_skills: b.relevant_skills ?? [],
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
            {
              // QA-070 (-70): HOURS on the roster — the CEO's ask ("without number of hours we
              // don't know if the student has qualified"). Same shared verdict as the
              // Attendance tab: green only on portal-verified hours.
              key: "hours", label: "Hours", render: (r: any) => {
                const h = r.hours;
                if (!h) return <span className="text-xs text-gray-400">—</span>;
                if (h.qualified) return <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-700" title={`Portal-verified: ${h.govt_hours} of ${h.required_hours} hrs`}>✓ {h.govt_hours}/{h.required_hours} hrs</span>;
                if (h.basis === "portal") return <span className="text-xs tabular-nums text-amber-700">{h.attended_hours}/{h.required_hours} hrs</span>;
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

function Enrollment({ batchId, setError }: any) {
  const [members, setMembers] = useState<any[]>([]);
  const [idx, setIdx] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkMsg, setBulkMsg] = useState("");

  const load = () => api(`/api/batches/${batchId}/members`).then((d) => setMembers(d.items.filter((m: any) => !m.left_on))).catch((e: any) => setError(e.message));
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
function AttendanceTab({ batchId, batch, role, setError }: any) {
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
  const todayKey = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
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
  const activeMembers = (data?.members ?? []).filter((m: any) => !m.left_on);
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
  const portalAsOf = data.members.map((m: any) => m.govt?.as_of).filter(Boolean).sort().pop();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full bg-gray-100 px-2 py-0.5">Programme: {data.program_hours} hrs</span>
        <span className="cursor-help rounded-full bg-gray-100 px-2 py-0.5" title={`${data.min_attendance_pct}% of programme hours. Hours come from the government portal once an import is matched; until then they are estimated from our daily logs × the batch slot. The portal meter is what the assessor settles against.`}>Needed for assessment: {data.required_hours} hrs</span>
        {/* QA-159 (-86, checker): "0 days logged" next to 13 portal working days read as a lie —
            two meters, named apart: OUR day-wise logs vs the PORTAL's cumulative import. */}
        <span className="rounded-full bg-gray-100 px-2 py-0.5" title="Day-wise logs marked in this system (Daily Execution / bulk grid)">Our logs: {data.days_held} day{data.days_held === 1 ? "" : "s"}</span>
        {(() => {
          const withPortal = (data.members ?? []).filter((m: any) => m.govt);
          const wd = Math.max(0, ...withPortal.map((m: any) => Number(m.govt?.working_days ?? 0)));
          return withPortal.length
            ? <span className="rounded-full bg-blue-50 px-2 py-0.5 text-blue-700" title="Skill India portal export, cumulative per student">Portal: {wd || "?"} working day{wd === 1 ? "" : "s"} · {withPortal.length}/{data.members.length} students · as of {fmtDate(portalAsOf)}</span>
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
      <DataTable rows={data.members}
        cardTitle={(r: any) => r.name}
        defaultSort={{ key: "name", dir: "asc" }}
        columns={[
          { key: "name", label: "Name", sortable: true, render: (r: any) => <NameCell name={r.name} sub={r.sidh_candidate_id ?? undefined} /> },
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
            // QA-085: the green mark is PORTAL-VERIFIED only — an estimate can never
            // qualify a student, and the chip says which meter it is reading.
            key: "qualified", label: "Assessment", sortable: true, sortValue: (r: any) => (r.qualified ? 1 : 0),
            filterText: (r: any) => (r.qualified ? "Qualified" : r.basis === "portal" ? "Below threshold" : "Awaiting portal hours"),
            render: (r: any) => r.left_on
              ? <Chip value="Dropout" />
              : r.qualified
                ? <span className="rounded-full bg-green-100 px-2 py-0.5 text-[11px] font-semibold text-green-700" title={`Portal-verified: ${r.govt?.hours} of ${data.required_hours} hrs`}>✓ Qualified for assessments</span>
                : r.basis === "portal"
                  ? <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600" title="Portal hours below the threshold">{r.attended_hours} / {data.required_hours} hrs</span>
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
        ]} empty="No students on the roster." />
    </div>
  );
}

function DailyExecution({ batchId, batch, role, setError }: any) {
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
    api(`/api/batches/${batchId}/members`).then((d) => setMembers(d.items.filter((m: any) => !m.left_on))),
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

function ClosureTab({ batchId, batch, role, setError, onChanged }: any) {
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
  const [adminBusy, setAdminBusy] = useState(false);
  const isAdmin = role === "Admin";
  const loadBlockers = () => api(`/api/batches/${batchId}/complete`).then(setBlockers).catch(() => setBlockers(null));
  useEffect(() => { loadBlockers(); }, [batchId, batch?.status]);
  async function completeAsAdmin() {
    const why = window.prompt(
      `Complete this batch now?\n\n${(blockers?.unmarked?.length ?? 0)} student(s) with no result will be recorded ABSENT.\n`
      + `${(blockers?.unsettled?.length ?? 0)} passed candidate(s) with no certificate will be recorded NOT ISSUED.\n\n`
      + "Every row is audited with your reason. Completing freezes the results and figures (an Admin can reopen it).\n\nReason:");
    if (!why || !why.trim()) return;
    setAdminBusy(true);
    try {
      await api(`/api/batches/${batchId}/complete`, { method: "POST", json: { reason: why.trim() } });
      load(); onChanged(); loadBlockers();
    } catch (e: any) { setError(e.message); }
    finally { setAdminBusy(false); }
  }
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

  const closed = ["Completed", "Cancelled"].includes(batch?.status);

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
      {isAdmin && !closed && blockers && blockers.can_complete_cleanly === false && ["Active", "Closing"].includes(batch?.status) && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>
            <b>This batch cannot be completed the ordinary way yet.</b>{" "}
            {(blockers.unmarked?.length ?? 0) > 0 && <>{blockers.unmarked.length} student(s) have no result</>}
            {(blockers.unmarked?.length ?? 0) > 0 && (blockers.unsettled?.length ?? 0) > 0 && " · "}
            {(blockers.unsettled?.length ?? 0) > 0 && <>{blockers.unsettled.length} passed candidate(s) have no certificate</>}
            . As Admin you can finish it anyway — the missing rows are recorded Absent / Not Issued, audited with your reason.
          </span>
          <Btn small onClick={completeAsAdmin} disabled={adminBusy}>{adminBusy ? "Completing…" : "Mark Completed (Admin)"}</Btn>
        </div>
      )}
      {/* Per-candidate marking gets the full width — it is a data-entry grid, not a side panel. */}
      {perCandidate && (
        <CandidateResults batchId={batchId} batch={batch} setError={setError} onChanged={() => { load(); onChanged(); }} />
      )}
      <div className="grid gap-4 lg:grid-cols-2">
      <Section
        title={`Assessment — ${closure?.assessment_status ?? "Pending"}`}
        actions={legacy && !perCandidate && !closed ? (
          <span className="flex gap-1.5">
            <Btn small onClick={() => setPerCandidate(true)}>Start per-candidate marking</Btn>
            {!showLegacyEntry && <Btn small kind="ghost" onClick={() => setShowLegacyEntry(true)}>Batch-level figures (legacy)…</Btn>}
          </span>
        ) : undefined}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Assessment date"><input type="date" className={inputCls} value={toInputDate(form.assessment_date)} onChange={(e) => setForm({ ...form, assessment_date: e.target.value })} /></Field>
          <div />
          {legacy && !perCandidate && showLegacyEntry ? (
            <>
              <Field label="Appeared (legacy batch-level)"><input type="number" className={inputCls} value={form.appeared ?? ""} onChange={(e) => setForm({ ...form, appeared: +e.target.value })} /></Field>
              <Field label="Passed (legacy batch-level)"><input type="number" className={inputCls} value={form.passed ?? ""} onChange={(e) => setForm({ ...form, passed: +e.target.value })} /></Field>
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
        <div className="mt-3 flex gap-2">
          <Btn small kind="ghost" onClick={() => saveClosure({ assessment_date: form.assessment_date, ...(legacy && !perCandidate && showLegacyEntry ? { appeared: form.appeared, passed: form.passed } : {}) })}>Save</Btn>
          <span className="inline-flex flex-col gap-0.5">
            <Btn small
              onClick={() => saveClosure({ assessment_status: "Completed", assessment_date: form.assessment_date ?? new Date(), ...(legacy && !perCandidate && showLegacyEntry ? { appeared: form.appeared, passed: form.passed } : {}) })}
              disabled={closure?.assessment_status === "Completed" || (blockers?.unmarked?.length ?? 0) > 0}>Mark Completed</Btn>
            {closure?.assessment_status !== "Completed" && (blockers?.unmarked?.length ?? 0) > 0 && (
              <span className="text-[10px] font-medium text-amber-700"
                title={(blockers.unmarked ?? []).map((u: any) => u.name).filter(Boolean).join(", ")}>
                {blockers.unmarked.length} student(s) have no result yet — mark them and this turns on by itself
              </span>
            )}
          </span>
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
          <p className="mt-2 text-xs text-amber-700">{summary.passed - summary.certificates_issued} passed candidate(s) still need an issued certificate.</p>
        )}
        <div className="mt-3 flex gap-2">
          <Btn small kind="ghost" onClick={() => saveClosure({ certification_date: form.certification_date, ...(legacy ? { certificates_issued: form.certificates_issued } : {}) })}>Save</Btn>
          <span className="inline-flex flex-col gap-0.5">
            <Btn small
              onClick={() => saveClosure({ certification_status: "Completed", certification_date: form.certification_date ?? new Date(), ...(legacy ? { certificates_issued: form.certificates_issued } : {}) })}
              disabled={closure?.certification_status === "Completed" || (blockers?.unsettled?.length ?? 0) > 0 || closure?.assessment_status !== "Completed"}>Mark Completed</Btn>
            {closure?.certification_status !== "Completed" && (blockers?.unsettled?.length ?? 0) > 0 && (
              <span className="text-[10px] font-medium text-amber-700"
                title={(blockers.unsettled ?? []).map((u: any) => u.name).filter(Boolean).join(", ")}>
                {blockers.unsettled.length} passed candidate(s) have no certificate yet
              </span>
            )}
            {closure?.certification_status !== "Completed" && (blockers?.unsettled?.length ?? 0) === 0 && closure?.assessment_status !== "Completed" && (
              <span className="text-[10px] font-medium text-gray-500">assessment goes first</span>
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
              PAID, and this attestation is ticked.
            </p>
          </div>
        </div>
      </Section>
      )}
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
  const [certUpload, setCertUpload] = useState<any>(null); // last confirm report
  const [certOk, setCertOk] = useState(true); // -111: the success half of the report is showing
  const [linkNote, setLinkNote] = useState<string | null>(null); // -111: link success, auto-hides
  const [uploading, setUploading] = useState(false);
  const closed = ["Completed", "Cancelled"].includes(batch?.status);
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
    setUploading(true);
    setCertUpload(null);
    try {
      const fd = new FormData();
      for (const f of Array.from(list)) fd.append("files", f);
      const res = await fetch(`${BASE_PATH}/api/batches/${batchId}/certificates`, { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Upload failed (${res.status})`);
      // Each staged file carries its own chosen member, seeded from the server's proposal so a
      // correct auto-match needs no clicks and a wrong one is one dropdown away.
      setMapping({ ...data, choice: Object.fromEntries((data.staged ?? []).map((s: any) => [s.url, s.member ?? ""])) });
    } catch (e: any) { setError(e.message); }
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
    if (!pairs.length) { setError("Nothing to attach — point at least one certificate at a candidate, or press Cancel to discard them."); return; }
    setUploading(true);
    try {
      const data = await api(`/api/batches/${batchId}/certificates`, { method: "POST", json: { confirm: true, pairs, discard } });
      setCertUpload(data); setCertOk(true);
      setMapping(null);
      await load(); onChanged(); loadLinkPlan();
    } catch (e: any) { setError(e.message); }
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
      if (!res.linked) setError(res.conflicts?.length
        ? `Nothing linked — ${res.conflicts.length} candidate(s) have conflicting portal IDs, left untouched. Fix them on the candidate record.`
        : "Nothing to link — the portal attendance imported so far names no new IDs for this roster.");
    } catch (e: any) { setError(e.message); }
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
      setAttMeta({ required_hours: d.required_hours, course_finished: d.course_finished, portal_working_days: d.portal_working_days, verdict_counts: d.verdict_counts ?? {} });
      setHoursBy(new Map((d.members ?? []).map((m: any) => [String(m.member_id), { qualified: m.qualified, attended_hours: m.attended_hours, basis: m.basis, required_hours: d.required_hours, verdict: m.verdict }])));
    }).catch(() => {}),
  ]).catch((e: any) => setError(e.message)).finally(() => setLoaded(true));
  useEffect(() => { load(); loadLinkPlan(); }, [batchId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // -108: one certificate, one candidate. Goes through the SAME upload door as every other file
  // (uploadWithRetry: compression, 3 retries, offline queue) and then the existing certificate
  // field patch — no new server contract, and no file-name matching to get wrong.
  async function uploadOneCertificate(i: any, file: File) {
    if (!i.result?._id) { setError("Mark this candidate's result first — a certificate attaches to a result."); return; }
    setCertBusy(String(i.result._id));
    try {
      const url = await uploadWithRetry(file, "closure", {
        folder_centre: batch?.location?.code ?? batch?.location?.name ?? "", folder_batch: batch?.code ?? "", folder_kind: "certificates",
        entity: "Batch", entity_id: batchId,
      });
      await certPatch(String(i.result._id), { certificate_file: url });
    } catch (e: any) { setError(e.message); }
    finally { setCertBusy(null); }
  }

  const active = items.filter((i) => !i.left_on);
  const pending = active.filter((i) => !i.result || i.result.result === "Pending");
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
      const m = /CAN[\s_-]*(\d+)/i.exec(String(i.candidate?.sidh_candidate_id ?? ""));
      return m ? { name: i.candidate?.name, file: `CAN${m[1]}.pdf` } : null;
    })
    .filter(Boolean) as { name: string; file: string }[];

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

  const Card = ({ i }: any) => {
    const h = hoursBy.get(String(i.member));
    return (
    <div className="space-y-2 rounded-xl border bg-white p-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium">{i.candidate?.name}</div>
          <div className="text-xs text-gray-500">{i.candidate?.phone}{i.left_on ? " · dropped" : ""}</div>
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
                      try { await api(`/api/results/${i.result._id}/certificate`, { method: "DELETE", json: { reason } }); await load(); onChanged(); }
                      catch (e: any) { setError(e.message); }
                    }}>remove</button>
                )}
              </>
            ) : <span className="text-gray-400">none</span>}
            {!closed || !i.result?.certificate_file ? (
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
      title={`Candidate results — ${summary?.final ?? 0}/${active.length} marked${summary?.pending ? ` · ${summary.pending} pending` : ""}`}
      actions={<Btn small kind="ghost" onClick={() => setView(view === "mark" ? "review" : "mark")}>{view === "mark" ? "Review table" : "Mark results"}</Btn>}
    >
      {pending.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Still pending: {pending.map((p) => p.candidate?.name).slice(0, 6).join(", ")}
          {pending.length > 6 ? ` +${pending.length - 6} more` : ""} — assessment cannot be marked Completed until every candidate has a final result.
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

      {/* -108, Umesh 17/08: "trainer ko rules pata thodi hote hain na — proper highlight karna
          chahiye ki kya issue aaya, format kya hona chahiye, sab kuch pehle hi bata do."
          Everything a trainer needs BEFORE picking a file, from data this screen already has. */}
      {batch?.status !== "Cancelled" && (
        <div className="mb-3 space-y-2 rounded-lg border border-gray-200 bg-white p-3">
          {/* 1. Is this roster even ready for automatic matching? This one line is what would have
                explained Manish's eight red lines: the files were right, the roster had no IDs. */}
          {linkPlan && (linkPlan.without_portal_id > 0 || linkPlan.linkable?.length > 0) && (
            <div className={`rounded-lg border px-3 py-2 text-xs ${linkPlan.with_portal_id === 0 ? "border-amber-300 bg-amber-50 text-amber-900" : "border-blue-200 bg-blue-50 text-blue-900"}`}>
              <b>{linkPlan.with_portal_id} of {linkPlan.roster} candidates carry a portal ID.</b>{" "}
              {linkPlan.with_portal_id === 0
                ? "Automatic matching by filename cannot work at all until at least one does — a correctly named file will still be reported as “matches no candidate”."
                : `${linkPlan.without_portal_id} without one can only be mapped by hand.`}
              {linkPlan.linkable?.length > 0 && (
                <span className="ml-1">
                  The portal attendance already imported names <b>{linkPlan.linkable.length}</b> of them.
                  <button onClick={linkPortalIds} disabled={linking}
                    className="ml-2 rounded-lg bg-blue-600 px-2.5 py-1 font-medium text-white hover:bg-blue-700 disabled:bg-blue-300">
                    {linking ? "Linking…" : `Link portal IDs (${linkPlan.linkable.length})`}
                  </button>
                </span>
              )}
              {!linkPlan.linkable?.length && linkPlan.without_portal_id > 0 && (
                <span className="ml-1">Nothing to link from the imports so far — map by hand below, or upload from each candidate&apos;s own card.</span>
              )}
              {linkPlan.conflicts?.length > 0 && (
                <div className="mt-1 text-amber-800">
                  {linkPlan.conflicts.length} left untouched because the portal gives conflicting IDs: {linkPlan.conflicts.slice(0, 3).map((c: any) => c.name).join(", ")}
                  {linkPlan.conflicts.length > 3 ? ` +${linkPlan.conflicts.length - 3}` : ""}.
                </div>
              )}
            </div>
          )}

          {/* 2. Who can take a certificate today, and who cannot — in words, not rule numbers. */}
          <p className="text-xs text-gray-600">
            <b className="text-green-700">{certReady.length} can take a certificate now</b> (Pass, none attached yet)
            {certDone.length > 0 && <> · <span className="text-gray-500">{certDone.length} already have one</span></>}
            {certNoNumber.length > 0 && <> · <span className="cursor-help text-amber-700" title="The certificate file settles the candidate's status; the NUMBER is what invoicing and audits quote. Add it on each candidate's card (or in Issue certificates) when the awarding body sends it.">{certNoNumber.length} without a certificate number</span></>}
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
              {(attMeta.verdict_counts.in_progress ?? 0) > 0 && <> · <span className="text-amber-700">{attMeta.verdict_counts.in_progress} still short (course running)</span></>}
              {(attMeta.verdict_counts.no_hours ?? 0) > 0 && <> · <span className="text-gray-500">{attMeta.verdict_counts.no_hours} with <b>no portal hours imported</b></span></>}
              {(attMeta.verdict_counts.not_eligible ?? 0) > 0 && <> · <span className="text-red-700">{attMeta.verdict_counts.not_eligible} not eligible</span></>}
              {(attMeta.verdict_counts.not_enrolled ?? 0) > 0 && <> · <span className="text-gray-500">{attMeta.verdict_counts.not_enrolled} not enrolled yet</span></>}
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
            <label className={`cursor-pointer rounded-lg px-3 py-1.5 text-xs font-medium text-white ${uploading ? "bg-gray-400" : "bg-blue-600 hover:bg-blue-700"}`}>
              {uploading ? "Reading…" : "⬆ Upload certificates (bulk)"}
              <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp" className="hidden" disabled={uploading}
                onChange={(e) => { uploadCertificates(e.target.files); e.target.value = ""; }} />
            </label>
            <span className="cursor-help text-xs text-gray-500" title="Every file is shown with the candidate it is going to, and you can change any of them, before anything is saved. A file named CAN_12345.pdf is matched for you. Or upload from a candidate's own card below — no file name needed.">
              Preview first, then save · <span className="font-mono">CAN_12345.pdf</span> matches itself · <span className="underline decoration-dotted">?</span>
            </span>
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

      {/* -108, Umesh 17/08: "bulk me karay toh mapping kar le ki ye certificate kis bachche ka hai…
          plus preview mapping — agar koi wrong auto map hua ya nahi map ho paye toh preview me map
          kar sakte hain, har certificate ke aligned." Every staged file, its proposed candidate,
          changeable — and nothing is written until Attach. */}
      <Drawer open={!!mapping} onClose={cancelMapping} title="Map each certificate to its candidate" wide>
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
                            {c.left_on ? " · dropped" : ""}
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

      <Drawer open={certDrawer} onClose={() => setCertDrawer(false)} title="Issue certificates" wide>
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
    <Drawer open={open} onClose={() => { if (rec) stop(); onClose(); }} title="Record video evidence">
      <div className="space-y-3">
        {err && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{err}</div>}
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
