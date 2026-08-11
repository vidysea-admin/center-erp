// Business rules engine — implements the numbered rules from
// center-erp-data-model-rules.md §4. Rule numbers are cited inline.
import { Types } from "mongoose";
import {
  Batch, BatchMember, Candidate, Closure, DailyLog, Invoice, Location, Program, Room, Trainer,
} from "@/models";
import { getDefaults } from "@/lib/defaults";
import { HttpError, isScoped } from "@/lib/authz";
import type { SessionUser } from "@/auth";

const ACTIVE_BATCH_STATUSES = ["Planning", "Ready", "Active", "Closing"];

// Rule 1 (RPL M1/M10): no operational activity at a location that has been stopped.
// "Not Started" is deliberately allowed — centres are planned before they open, which is
// the whole point of advance batch planning.
const HALTED_LOCATION_STATUSES = ["On Hold", "Stopped", "Closed"];

export async function assertLocationOperational(locationId: unknown, action = "This action") {
  const loc = await Location.findById(locationId).select("name operational_status").lean<any>();
  if (!loc) throw new HttpError(400, "Location not found");
  if (HALTED_LOCATION_STATUSES.includes(loc.operational_status)) {
    throw new HttpError(409, `Rule 1: ${action} is blocked — ${loc.name} is ${loc.operational_status}.`);
  }
}

// Rule 38 on by-ID access: scoped users may only touch batches at their locations.
export async function assertBatchInScope(user: SessionUser, batchId: string) {
  if (!isScoped(user)) return;
  const b = await Batch.findById(batchId).select("location").lean<any>();
  if (!b) throw new HttpError(404, "Batch not found");
  if (!user.location_scope.map(String).includes(String(b.location))) {
    throw new HttpError(403, "Batch out of scope");
  }
}

// Same, resolved via a BatchMember id.
export async function assertMemberInScope(user: SessionUser, memberId: string) {
  if (!isScoped(user)) return;
  const m = await BatchMember.findById(memberId).select("batch").lean<any>();
  if (!m) throw new HttpError(404, "Batch member not found");
  await assertBatchInScope(user, String(m.batch));
}

export function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

export function dayStart(d: Date | string): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

// ---------- Computed values (§5) ----------
export function computePlannedEnd(planned_start: Date, program: { duration_days: number; buffer_days: number }): Date {
  // Rule 15
  return addDays(planned_start, program.duration_days + program.buffer_days);
}

export function capacitySummary(
  approved_target: number,
  program: { default_batch_size: number; duration_days: number; buffer_days: number; completion_deadline_days: number },
  maxConcurrentBatches = 5,
) {
  const batches_required = Math.ceil(approved_target / program.default_batch_size);
  const batch_duration = program.duration_days + program.buffer_days;
  const trainer_days = batches_required * batch_duration;
  // Two constraints, both from the spec: the deadline (meeting whiteboard math) and the
  // per-trainer batch cap (RPL M6). Whichever needs more trainers wins.
  const by_deadline = Math.ceil(trainer_days / program.completion_deadline_days);
  const by_concurrency = Math.ceil(batches_required / Math.max(1, maxConcurrentBatches));
  const trainers_required = Math.max(by_deadline, by_concurrency);
  return {
    batches_required, batch_duration, trainer_days, by_deadline, by_concurrency, trainers_required,
    sentence: `Target ${approved_target} → ${batches_required} batches × ${batch_duration} days = ${trainer_days} trainer-days → ${trainers_required} trainer${trainers_required === 1 ? "" : "s"} required within ${program.completion_deadline_days} days.`,
  };
}

// ---------- Trainer rules ----------
function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

function batchRange(b: { planned_start: Date; planned_end?: Date | null; actual_start?: Date | null; status: string }): [Date, Date] {
  // Rule 10: planned_start..planned_end, or actual_start..planned_end once Active
  const start = b.status === "Active" || b.status === "Closing" ? (b.actual_start ?? b.planned_start) : b.planned_start;
  const end = b.planned_end ?? addDays(start, 30);
  return [new Date(start), new Date(end)];
}

// Rule 10: hard block if trainer would exceed max_concurrent_batches on overlapping ranges.
export async function assertTrainerAvailableForBatch(trainerId: string, batchId: string | null, planned_start: Date, planned_end: Date) {
  const trainer = await Trainer.findById(trainerId).lean<any>();
  if (!trainer) throw new HttpError(400, "Trainer not found");
  const others = await Batch.find({
    trainer: trainerId,
    status: { $in: ACTIVE_BATCH_STATUSES },
    ...(batchId ? { _id: { $ne: batchId } } : {}),
  }).populate("location", "name code").lean<any[]>();
  const overlapping = others.filter((b) => {
    const [s, e] = batchRange(b);
    return rangesOverlap(new Date(planned_start), new Date(planned_end), s, e);
  });
  if (overlapping.length + 1 > (trainer.max_concurrent_batches ?? 1)) {
    const c = overlapping[0];
    throw new HttpError(409,
      `Rule 10: Trainer ${trainer.name} already assigned to batch ${c.code} at ${c.location?.name ?? "?"} (${new Date(batchRange(c)[0]).toDateString()} – ${new Date(batchRange(c)[1]).toDateString()}); max concurrent = ${trainer.max_concurrent_batches}.`);
  }
}

// Rule 12: Trainer.status is derived.
export async function deriveTrainerStatus(trainerId: string) {
  const trainer = await Trainer.findById(trainerId);
  if (!trainer) return;
  if (trainer.status === "Unavailable") return; // manual override wins
  const activeCount = await Batch.countDocuments({ trainer: trainerId, status: { $in: ACTIVE_BATCH_STATUSES } });
  const next = activeCount > 0 ? "Assigned" : "Available";
  if (trainer.status !== next) {
    trainer.status = next;
    await trainer.save();
  }
}

// ---------- Room rules ----------
function sessionsConflict(a: string, b: string): boolean {
  // Rule 13: Full Day conflicts with both Morning and Afternoon
  return a === "Full Day" || b === "Full Day" || a === b;
}

export async function assertRoomFreeForBatch(roomId: string, batchId: string | null, planned_start: Date, planned_end: Date, session: string) {
  const others = await Batch.find({
    room: roomId,
    status: { $in: ACTIVE_BATCH_STATUSES },
    ...(batchId ? { _id: { $ne: batchId } } : {}),
  }).lean<any[]>();
  for (const b of others) {
    const [s, e] = batchRange(b);
    if (rangesOverlap(new Date(planned_start), new Date(planned_end), s, e) && sessionsConflict(session, b.session)) {
      throw new HttpError(409, `Rule 13: Room already hosts batch ${b.code} (${b.session}) from ${s.toDateString()} to ${e.toDateString()}.`);
    }
  }
}

// ---------- Roster (Rules 20–26) ----------
// Rule 26: roster on date D
export async function rosterOnDate(batchId: string, d: Date): Promise<any[]> {
  const D = dayStart(d);
  return BatchMember.find({
    batch: batchId,
    joined_on: { $lte: D },
    $or: [{ left_on: null }, { left_on: { $gt: D } }],
  }).lean<any[]>();
}

export async function activeRoster(batchId: string): Promise<any[]> {
  return BatchMember.find({ batch: batchId, left_on: null }).lean<any[]>();
}

// Rule 20 + 21: add a candidate to a batch.
// Returns { member, warning } — over-target assignment is a WARNING, not a block: centres
// deliberately assign a dropout buffer. The hard cap lands on enrolment (Rule 48).
export async function addMemberChecked(batchId: string, candidateId: string, joined_on: Date) {
  const existing = await BatchMember.findOne({ candidate: candidateId, left_on: null }).populate("batch", "code").lean<any>();
  if (existing) {
    throw new HttpError(409, `Rule 20: Candidate already active in batch ${existing.batch?.code ?? existing.batch}.`);
  }
  const batch = await Batch.findById(batchId).select("target_size code").lean<any>();
  const rosterCount = await BatchMember.countDocuments({ batch: batchId, left_on: null });
  const member = await BatchMember.create({ batch: batchId, candidate: candidateId, joined_on: dayStart(joined_on) });
  await Candidate.findByIdAndUpdate(candidateId, { lifecycle_status: "Assigned" }); // Rule 21
  const warning = batch && rosterCount + 1 > batch.target_size
    ? `Roster is now ${rosterCount + 1} of target ${batch.target_size} — enrolment will be capped at ${batch.target_size}.`
    : undefined;
  return Object.assign(member, { warning });
}

// Rules 22–24: enrollment step update
export async function updateEnrollment(memberId: string, patch: {
  reg_done?: boolean; kyc_done?: boolean; accept_done?: boolean;
  failed?: boolean; issue?: string | null; issue_note?: string | null;
  source?: "Manual" | "Automation";
}) {
  const m = await BatchMember.findById(memberId);
  if (!m) throw new HttpError(404, "Batch member not found");
  if (m.left_on) throw new HttpError(409, "Member has left this batch");

  const now = new Date();
  for (const step of ["reg_done", "kyc_done", "accept_done"] as const) {
    if (patch[step] !== undefined && patch[step] !== m[step]) {
      m[step] = patch[step]!;
      (m as any)[step + "_at"] = patch[step] ? now : null;
    }
  }
  if (patch.source) m.source = patch.source;

  if (patch.failed === true) {
    if (!patch.issue && !m.issue) throw new HttpError(400, "Rule 23: Failed requires an issue reason.");
    m.enrollment_status = "Failed";
    if (patch.issue) m.issue = patch.issue as any;
    if (patch.issue_note !== undefined) m.issue_note = patch.issue_note ?? undefined;
    // Rule 22: candidate lifecycle_status unchanged
  } else {
    if (patch.failed === false) { m.issue = null; m.issue_note = undefined; }
    // Rule 24: derive from booleans (unless still explicitly Failed and not cleared)
    if (m.enrollment_status !== "Failed" || patch.failed === false) {
      const done = [m.reg_done, m.kyc_done, m.accept_done].filter(Boolean).length;
      m.enrollment_status = done === 0 ? "Not Started" : done === 3 ? "Completed" : "In Progress";
    }
    if (patch.issue !== undefined) m.issue = patch.issue as any;
    if (patch.issue_note !== undefined) m.issue_note = patch.issue_note ?? undefined;
  }

  // Rule 48 (RPL M12): enrolled candidates can never exceed batch capacity.
  if (m.enrollment_status === "Completed" && m.isModified("enrollment_status")) {
    const batch = await Batch.findById(m.batch).select("target_size").lean<any>();
    const enrolled = await BatchMember.countDocuments({
      batch: m.batch, left_on: null, enrollment_status: "Completed", _id: { $ne: m._id },
    });
    if (batch && enrolled + 1 > batch.target_size) {
      throw new HttpError(409, `Rule 48: batch capacity is ${batch.target_size} and ${enrolled} are already enrolled. Raise the target size or drop a member first.`);
    }
  }
  await m.save();

  if (m.enrollment_status === "Completed") {
    await Candidate.findByIdAndUpdate(m.candidate, { lifecycle_status: "Enrolled" }); // Rule 21
  }
  return m;
}

// Rule 25: drop a member
export async function dropMemberChecked(memberId: string, left_on: Date, drop_reason: string) {
  if (!left_on || !drop_reason) throw new HttpError(400, "Rule 25: left_on and drop_reason are required.");
  const m = await BatchMember.findById(memberId);
  if (!m) throw new HttpError(404, "Batch member not found");
  const lo = dayStart(left_on);
  if (lo < dayStart(m.joined_on)) throw new HttpError(400, "Rule 25: left_on cannot precede joined_on.");
  if (lo > dayStart(new Date())) throw new HttpError(400, "Rule 25: left_on cannot be a future date.");
  m.left_on = lo;
  m.drop_reason = drop_reason;
  await m.save();
  await Candidate.findByIdAndUpdate(m.candidate, { lifecycle_status: "Dropped" }); // Rule 21
  return m;
}

// ---------- Batch lifecycle (Rules 14–19) ----------
export async function batchReadiness(batchId: string) {
  const batch = await Batch.findById(batchId).populate("program").populate("room").populate("trainer").populate("location", "name code approval_status operational_status").lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  const location = batch.location?.approval_status !== undefined ? batch.location : await Location.findById(batch.location).lean<any>();
  const roster = await activeRoster(batchId);
  const defaults = await getDefaults();

  const trainer = batch.trainer ? await Trainer.findById(batch.trainer._id ?? batch.trainer).lean<any>() : null;
  const trainerAvailable = !!trainer && (!trainer.available_from || dayStart(trainer.available_from) <= dayStart(batch.planned_start)); // Rule 11
  const roomOk = !!batch.room && (!batch.program?.requires_lab || batch.room?.type === "Lab"); // Rule 14

  const enrolled = roster.filter((m) => m.enrollment_status === "Completed").length;
  const enrollmentThreshold = Math.ceil((defaults.enrollment_threshold_pct / 100) * roster.length);

  const checks = {
    location_approved: location?.approval_status === "Approved"
      && !HALTED_LOCATION_STATUSES.includes(location?.operational_status), // Rule 1
    room_assigned: roomOk,
    trainer_ready: trainerAvailable,
    roster_80pct: roster.length >= Math.ceil((defaults.roster_threshold_pct / 100) * batch.target_size),
  }; // Rule 16
  return {
    checks,
    ready: Object.values(checks).every(Boolean),
    roster_count: roster.length,
    enrolled_count: enrolled,
    enrollment_threshold: enrollmentThreshold,
    enrollment_ok: roster.length > 0 && enrolled >= enrollmentThreshold, // plan1.md resolution #1
    location_halted: HALTED_LOCATION_STATUSES.includes(location?.operational_status),
    batch,
  };
}

export async function transitionBatch(batchId: string, target: string, opts: { isAdmin?: boolean; reason?: string } = {}) {
  const batch = await Batch.findById(batchId);
  if (!batch) throw new HttpError(404, "Batch not found");
  const from = batch.status;

  const fail = (msg: string) => { throw new HttpError(409, msg); };

  switch (`${from}->${target}`) {
    case "Planning->Ready": {
      const r = await batchReadiness(batchId);
      if (!r.ready) fail("Rule 16: readiness checks failing: " + Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k).join(", "));
      break;
    }
    case "Ready->Planning":
      break; // allow going back to fix things
    case "Ready->Active": {
      if (dayStart(new Date()) < dayStart(batch.planned_start)) fail("Rule 17: cannot start before planned_start.");
      await assertLocationOperational(batch.location, "Starting a batch"); // Rule 1
      const r = await batchReadiness(batchId);
      if (!r.enrollment_ok) fail(`Enrollment threshold not met: ${r.enrolled_count}/${r.enrollment_threshold} required (${(await getDefaults()).enrollment_threshold_pct}% of roster).`);
      batch.actual_start = new Date();
      break;
    }
    case "Active->Closing": {
      const closure = await Closure.findOne({ batch: batchId }).lean<any>();
      if (closure?.assessment_status !== "Completed") fail("Rule 18: assessment must be Completed before Closing.");
      break;
    }
    case "Closing->Completed": {
      const closure = await Closure.findOne({ batch: batchId }).lean<any>();
      if (closure?.certification_status !== "Completed") fail("Rule 18: certification must be Completed before batch completes.");
      batch.actual_end = new Date();
      // Rule 21: still-active members become Completed
      const roster = await activeRoster(batchId);
      await Candidate.updateMany(
        { _id: { $in: roster.map((m) => m.candidate) } },
        { lifecycle_status: "Completed" },
      );
      break;
    }
    case "Planning->Cancelled":
    case "Ready->Cancelled":
    case "Active->Cancelled": {
      const logCount = await DailyLog.countDocuments({ batch: batchId });
      if (logCount > 0 && !opts.isAdmin) fail("Rule 19: batch has daily logs; only Admin may force-close with a reason.");
      if (logCount > 0 && !opts.reason) fail("Rule 19: force-close requires a reason.");
      if (!opts.reason) fail("Cancellation requires a reason.");
      batch.cancel_reason = opts.reason;
      break;
    }
    default:
      fail(`Transition ${from} → ${target} is not allowed.`);
  }

  batch.status = target as any;
  await batch.save();
  if (batch.trainer) await deriveTrainerStatus(String(batch.trainer)); // Rule 12
  return batch;
}

// ---------- Daily log (Rules 27–33) ----------
export async function validateDailyLog(batchId: string, log_date: Date, payload: {
  present_member_ids: string[]; govt_present?: number | null;
}) {
  const batch = await Batch.findById(batchId).lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  if (batch.status !== "Active" && batch.status !== "Closing") {
    throw new HttpError(409, "Daily logs only for Active/Closing batches.");
  }
  await assertLocationOperational(batch.location, "Entering a daily log"); // Rule 1
  const D = dayStart(log_date);
  if (batch.actual_start && D < dayStart(batch.actual_start)) throw new HttpError(400, "Rule 32: log date before batch actual start.");
  if (batch.actual_end && D > dayStart(batch.actual_end)) throw new HttpError(400, "Rule 32: log date after batch actual end.");
  if (D > dayStart(new Date())) throw new HttpError(400, "Cannot log a future date.");

  const roster = await rosterOnDate(batchId, D); // Rule 26
  const rosterIds = new Set(roster.map((m) => String(m._id)));
  for (const id of payload.present_member_ids) {
    if (!rosterIds.has(String(id))) throw new HttpError(400, "Rule 29: present member not in roster on that date.");
  }
  const internal_present = payload.present_member_ids.length; // Rule 29
  if (internal_present > roster.length) throw new HttpError(400, "Rule 29: present exceeds roster.");
  if (payload.govt_present != null && payload.govt_present > roster.length) {
    throw new HttpError(400, "Rule 30: govt_present cannot exceed roster count.");
  }
  return { roster_count: roster.length, internal_present }; // Rule 28: frozen at save
}

export async function canEditDailyLog(log: { entered_by: unknown; entered_at: Date }, userId: string, role: string): Promise<boolean> {
  if (role === "Admin" || role === "Operations") return true; // Rule 27
  const defaults = await getDefaults();
  const ageHours = (Date.now() - new Date(log.entered_at).getTime()) / 36e5;
  return String(log.entered_by) === String(userId) && ageHours <= defaults.daily_log_edit_window_hours;
}

// ---------- Batch Health Score (RPL cross-cutting) ----------
// A composite Green/Amber/Red — but the score is NEVER shown alone: `reasons` always travels
// with it, because a bare "Amber" hides which thing is actually wrong.
export type BatchHealth = {
  score: "Green" | "Amber" | "Red";
  reasons: { code: string; label: string; severity: "amber" | "red" }[];
};

// Shared gap arithmetic — previously inlined in the Home route, now the single implementation.
export function attendanceGap(log: { roster_count?: number; internal_present?: number; govt_present?: number | null }): number | null {
  if (log.govt_present == null || !log.roster_count) return null;
  const internalPct = (100 * (log.internal_present ?? 0)) / log.roster_count;
  const govtPct = (100 * log.govt_present) / log.roster_count;
  return Math.round(internalPct - govtPct);
}

// How many consecutive operating days (ending yesterday) have no daily log.
export async function missingLogStreak(batch: any, operating: number[]): Promise<{ days: number; lastMissing: Date | null }> {
  let d = addDays(dayStart(new Date()), -1);
  let days = 0, lastMissing: Date | null = null, guard = 0;
  while (guard++ < 21) {
    if (!operating.includes(d.getDay())) { d = addDays(d, -1); continue; }
    if (batch.actual_start && d < dayStart(batch.actual_start)) break;
    const log = await DailyLog.findOne({ batch: batch._id, log_date: d }).select("_id").lean();
    if (log) break;
    days++;
    if (!lastMissing) lastMissing = d;
    d = addDays(d, -1);
  }
  return { days, lastMissing };
}

export async function batchHealth(batchId: string): Promise<BatchHealth> {
  const defaults = await getDefaults();
  const batch = await Batch.findById(batchId).populate("program", "operating_days").lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  const reasons: BatchHealth["reasons"] = [];

  if (["Completed", "Cancelled"].includes(batch.status)) return { score: "Green", reasons };

  // 1. Missing daily logs (Rule 33) — a streak matters more than a single miss.
  if (batch.status === "Active") {
    const operating: number[] = batch.program?.operating_days?.length ? batch.program.operating_days : [1, 2, 3, 4, 5, 6];
    const { days } = await missingLogStreak(batch, operating);
    if (days >= 3) reasons.push({ code: "missing_logs", label: `No daily log for ${days} operating days`, severity: "red" });
    else if (days >= 1) reasons.push({ code: "missing_logs", label: `Daily log missing for ${days} day${days > 1 ? "s" : ""}`, severity: "amber" });
  }

  // 2. Government attendance gap (Rule 31) — worst of the last 10 verified logs.
  const logs = await DailyLog.find({ batch: batchId, govt_present: { $ne: null } })
    .sort({ log_date: -1 }).limit(10).select("roster_count internal_present govt_present").lean<any[]>();
  const worstGap = logs.reduce((w, l) => Math.max(w, attendanceGap(l) ?? 0), 0);
  if (worstGap >= defaults.attendance_gap_red) reasons.push({ code: "govt_gap", label: `Government attendance gap ${worstGap} pts`, severity: "red" });
  else if (worstGap >= defaults.attendance_gap_amber) reasons.push({ code: "govt_gap", label: `Government attendance gap ${worstGap} pts`, severity: "amber" });

  // 3. Open enrollment failures.
  const failures = await BatchMember.countDocuments({ batch: batchId, enrollment_status: "Failed", left_on: null });
  if (failures > 0) reasons.push({ code: "enrollment_failures", label: `${failures} enrollment failure${failures > 1 ? "s" : ""} unresolved`, severity: failures >= 3 ? "red" : "amber" });

  // 4. Planning gaps — only meaningful before the batch starts.
  if (["Planning", "Ready"].includes(batch.status)) {
    const r = await batchReadiness(batchId);
    const failing = Object.entries(r.checks).filter(([, ok]) => !ok).map(([k]) => k);
    const overdue = dayStart(new Date()) > dayStart(batch.planned_start);
    if (failing.length) {
      reasons.push({
        code: "not_ready",
        label: `Not ready: ${failing.join(", ").replace(/_/g, " ")}`,
        severity: overdue ? "red" : "amber",
      });
    }
    if (r.location_halted) reasons.push({ code: "location_halted", label: "Location is not operational", severity: "red" });
  }

  const score = reasons.some((r) => r.severity === "red") ? "Red" : reasons.length ? "Amber" : "Green";
  return { score, reasons };
}

// Rule 33: Active batches missing previous operating day's log
export async function missingLogQueue(locationScopeFilter: Record<string, unknown>) {
  const batches = await Batch.find({ status: "Active", ...locationScopeFilter })
    .populate("location", "name code spoc_name")
    .populate("program", "name operating_days")
    .lean<any[]>();
  const out: any[] = [];
  const today = dayStart(new Date());
  for (const b of batches) {
    const operating: number[] = b.program?.operating_days?.length ? b.program.operating_days : [1, 2, 3, 4, 5, 6];
    // walk back to the previous operating day
    let d = addDays(today, -1);
    let guard = 0;
    while (!operating.includes(d.getDay()) && guard++ < 7) d = addDays(d, -1);
    if (b.actual_start && d < dayStart(b.actual_start)) continue;
    const log = await DailyLog.findOne({ batch: b._id, log_date: d }).lean();
    if (!log) out.push({ batch: b, missing_date: d, owner: b.location?.spoc_name ?? "SPOC" });
  }
  return out;
}

// ---------- Closure / Invoice (Rules 34–36) ----------
export async function upsertClosureChecked(batchId: string, patch: Record<string, unknown>, userId: string) {
  const batch = await Batch.findById(batchId).lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  let closure = await Closure.findOne({ batch: batchId });
  if (!closure) closure = new Closure({ batch: batchId });

  if (patch.assessment_status === "Completed" || patch.appeared != null || patch.passed != null) {
    const assessDate = (patch.assessment_date as Date) ?? closure.assessment_date ?? new Date();
    const roster = await rosterOnDate(batchId, new Date(assessDate));
    const appeared = (patch.appeared as number) ?? closure.appeared;
    const passed = (patch.passed as number) ?? closure.passed;
    if (appeared != null && appeared > roster.length) throw new HttpError(400, `Rule 34: appeared (${appeared}) exceeds roster on assessment date (${roster.length}).`);
    if (passed != null && appeared != null && passed > appeared) throw new HttpError(400, "Rule 34: passed cannot exceed appeared.");
  }

  const settingReady = patch.ready_for_invoice === true && !closure.ready_for_invoice;
  const certStatus = (patch.certification_status as string) ?? closure.certification_status;
  if (settingReady && certStatus !== "Completed") {
    throw new HttpError(409, "Rule 35: ready_for_invoice requires certification Completed.");
  }

  Object.assign(closure, patch);
  if (settingReady) {
    closure.marked_ready_by = new Types.ObjectId(userId);
    closure.marked_ready_at = new Date();
    await Invoice.findOneAndUpdate(
      { batch: batchId },
      { $set: { status: "Ready" }, $setOnInsert: { batch: batchId } },
      { upsert: true },
    ); // Rule 35
  }
  await closure.save();
  return closure;
}

const INVOICE_ORDER = ["Not Ready", "Ready", "Raised", "Paid"];

export async function updateInvoiceChecked(batchId: string, patch: Record<string, unknown>) {
  const inv = await Invoice.findOne({ batch: batchId });
  if (!inv) throw new HttpError(404, "Invoice not found (mark batch ready for invoice first).");
  const target = patch.status as string | undefined;
  // Rule 36: the invoice status only ever moves one step forward. Previously enforced only
  // by disabled buttons in the UI, so an API caller could jump Ready → Paid.
  if (target && target !== inv.status) {
    const from = INVOICE_ORDER.indexOf(inv.status);
    const to = INVOICE_ORDER.indexOf(target);
    if (to !== from + 1) {
      throw new HttpError(409, `Rule 36: invoice status moves ${INVOICE_ORDER.join(" → ")}; cannot go from ${inv.status} to ${target}.`);
    }
  }
  if (target === "Raised" && !((patch.invoice_no ?? inv.invoice_no) && (patch.raised_on ?? inv.raised_on))) {
    throw new HttpError(400, "Rule 36: Raised requires invoice_no and raised_on.");
  }
  if (target === "Paid" && !(patch.paid_on ?? inv.paid_on)) {
    throw new HttpError(400, "Rule 36: Paid requires paid_on.");
  }
  Object.assign(inv, patch);
  await inv.save();
  return inv;
}

// Rule 37
export function assertCostEntryValid(e: { location?: unknown; batch?: unknown; trainer?: unknown }) {
  if (!e.location && !e.batch && !e.trainer) {
    throw new HttpError(400, "Rule 37: cost entry needs at least a location, batch, or trainer.");
  }
}

// ---------- Batch code (auto: B + serial) ----------
export async function nextBatchCode(): Promise<string> {
  const db = Batch.db;
  const res = await db.collection("counters").findOneAndUpdate(
    { _id: "batch" as any },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  const seq = (res as any)?.seq ?? (res as any)?.value?.seq ?? 1;
  return "B" + String(seq).padStart(3, "0");
}
