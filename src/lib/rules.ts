// Business rules engine — implements the numbered rules from
// center-erp-data-model-rules.md §4. Rule numbers are cited inline.
import { Types } from "mongoose";
import {
  Batch, BatchMember, Candidate, CandidateResult, Closure, DailyLog, Invoice, Location, Program, Room, Trainer,
} from "@/models";
import { auditDiff } from "@/lib/audit";
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

// 2026-08-11: "HH:mm" time-slot pair on a batch. Two slots clash when both are fully
// defined and the times overlap. Batches without slots do NOT clash by time (backward
// compatible — the concurrency cap alone governs them, as before).
function slotsClash(aStart?: string | null, aEnd?: string | null, bStart?: string | null, bEnd?: string | null): boolean {
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  return aStart < bEnd && bStart < aEnd;
}

// Rule 10: hard block if trainer would exceed max_concurrent_batches on overlapping ranges.
// 2026-08-11 addition: when both batches carry a time slot, a same-time overlap is blocked
// outright — a trainer cannot teach two rooms at 9:00 no matter how low the count is.
export async function assertTrainerAvailableForBatch(
  trainerId: string, batchId: string | null, planned_start: Date, planned_end: Date,
  slot?: { slot_start?: string | null; slot_end?: string | null },
) {
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
  const clash = overlapping.find((b) => slotsClash(slot?.slot_start, slot?.slot_end, b.slot_start, b.slot_end));
  if (clash) {
    throw new HttpError(409,
      `Time slot clash: Trainer ${trainer.name} already teaches batch ${clash.code} at ${clash.location?.name ?? "?"} during ${clash.slot_start}–${clash.slot_end}.`);
  }
  if (overlapping.length + 1 > (trainer.max_concurrent_batches ?? 1)) {
    const c = overlapping[0];
    throw new HttpError(409,
      `Rule 10: Trainer ${trainer.name} already assigned to batch ${c.code} at ${c.location?.name ?? "?"} (${new Date(batchRange(c)[0]).toDateString()} – ${new Date(batchRange(c)[1]).toDateString()}); max concurrent = ${trainer.max_concurrent_batches}.`);
  }
}

// 2026-08-11: a trainer still in the hiring pipeline can be booked ahead, but the operator
// must see it. Warn, never block — the availability/TOT date rules (Rule 11) hard-gate the
// actual start. Same for location capability ("trainer कहाँ-कहाँ training ले सकता है"):
// an empty list means "anywhere"; a non-empty list that excludes the batch's location warns.
export async function trainerBookingWarnings(trainerId: string, locationId?: unknown): Promise<string[]> {
  const t = await Trainer.findById(trainerId).select("name pipeline_status capable_locations").lean<any>();
  if (!t) return [];
  const warnings: string[] = [];
  if (t.pipeline_status && t.pipeline_status !== "Ready to Train") {
    warnings.push(`Trainer ${t.name} is still "${t.pipeline_status}" — not yet Ready to Train.`);
  }
  if (locationId && t.capable_locations?.length &&
      !t.capable_locations.map(String).includes(String(locationId))) {
    const loc = await Location.findById(locationId).select("name").lean<any>();
    warnings.push(`Trainer ${t.name} is not listed as able to train at ${loc?.name ?? "this location"} — check travel/availability.`);
  }
  return warnings;
}

// Back-compat wrapper (kept for existing callers/tests).
export async function trainerPipelineWarning(trainerId: string): Promise<string | null> {
  const w = await trainerBookingWarnings(trainerId);
  return w[0] ?? null;
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
    // 2026-08-11: eligibility hard-gates enrollment completion (assignment only warns).
    // Only definitive failures block — unknown DOB/education never do.
    const cand = await Candidate.findById(m.candidate).select("name dob education last_training_date").lean<any>();
    if (cand) {
      const elig = candidateEligibility(cand, await getDefaults());
      if (!elig.eligible) {
        throw new HttpError(409, `Candidate ${cand.name} is not eligible: ${elig.reasons.join("; ")}`);
      }
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
  // Rule 42: an existing result is NOT deleted when someone drops — they still appeared.
  // Recompute so the aggregates reflect the new roster.
  await recomputeClosureAggregates(String(m.batch));
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
      const roster = await activeRoster(batchId);
      const rosterCandidateIds = roster.map((m) => String(m.candidate));
      const results = await CandidateResult.find({ batch: batchId }).select("candidate result").lean<any[]>();
      if (results.length) {
        // Rule 47: only a Pass finishes as Completed; Fail/Absent are Not Certified.
        const passed = results.filter((r) => r.result === "Pass").map((r) => String(r.candidate));
        const notCertified = results.filter((r) => ["Fail", "Absent"].includes(r.result)).map((r) => String(r.candidate));
        await Candidate.updateMany(
          { _id: { $in: passed.filter((id) => rosterCandidateIds.includes(id)) } },
          { lifecycle_status: "Completed" },
        );
        await Candidate.updateMany(
          { _id: { $in: notCertified.filter((id) => rosterCandidateIds.includes(id)) } },
          { lifecycle_status: "Not Certified" },
        );
      } else {
        // Legacy batches keep the original blanket behaviour (Rule 21).
        await Candidate.updateMany({ _id: { $in: roster.map((m) => m.candidate) } }, { lifecycle_status: "Completed" });
      }
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

// ---------- Per-candidate assessment & certification (Rules 41–47, RPL M17/M18) ----------

export type ResultSummary = {
  total: number; final: number; pending: number;
  appeared: number; passed: number; failed: number; absent: number; certificates_issued: number;
};

// Pure — used on GET so reads never write.
export function summarizeResults(rows: any[]): ResultSummary {
  const by = (r: string) => rows.filter((x) => x.result === r).length;
  const passed = by("Pass"), failed = by("Fail"), absent = by("Absent"), pending = by("Pending");
  return {
    total: rows.length,
    final: rows.length - pending,
    pending,
    appeared: passed + failed, // Rule 42: Absent did not appear
    passed, failed, absent,
    certificates_issued: rows.filter((x) => x.certificate_status === "Issued").length,
  };
}

// Rule 41: a batch with no rows is "legacy" and keeps its stored batch-level figures.
export async function batchUsesPerCandidateResults(batchId: string): Promise<boolean> {
  return (await CandidateResult.countDocuments({ batch: batchId })) > 0;
}

// Rule 42: aggregates are derived from the rows and written through to Closure, so every
// existing reader (invoice flow, dashboards) keeps working unchanged.
export async function recomputeClosureAggregates(batchId: string, actorId?: string) {
  const rows = await CandidateResult.find({ batch: batchId }).lean<any[]>();
  const summary = summarizeResults(rows);
  if (!rows.length) return { ...summary, legacy: true };

  const closure = (await Closure.findOne({ batch: batchId })) ?? new Closure({ batch: batchId });
  const before = { appeared: closure.appeared, passed: closure.passed, certificates_issued: closure.certificates_issued };
  closure.appeared = summary.appeared;
  closure.passed = summary.passed;
  closure.certificates_issued = summary.certificates_issued;
  if (!closure.assessment_date) {
    const dates = rows.map((r) => r.assessed_on).filter(Boolean).map((d) => new Date(d).getTime());
    if (dates.length) closure.assessment_date = new Date(Math.max(...dates));
  }
  await closure.save();
  // Any previously hand-typed figure survives in the audit trail, attributed to derivation.
  await auditDiff("Closure", closure._id, before,
    { appeared: summary.appeared, passed: summary.passed, certificates_issued: summary.certificates_issued },
    actorId ?? null, "SYSTEM");
  return { ...summary, legacy: false };
}

// Rule 43: no indefinite Pending — every roster member needs a final result.
export async function assessmentCompleteness(batchId: string) {
  const rows = await CandidateResult.find({ batch: batchId }).populate("candidate", "name").lean<any[]>();
  if (!rows.length) return { legacy: true, total: 0, final: 0, pending: [] as any[], complete: true };
  const closure = await Closure.findOne({ batch: batchId }).select("assessment_date").lean<any>();
  const roster = closure?.assessment_date
    ? await rosterOnDate(batchId, new Date(closure.assessment_date))
    : await activeRoster(batchId);
  // Walk the ROSTER, not the rows: a member with no row yet is pending too — otherwise a
  // batch where only two of thirty were marked would count as complete.
  const byMember = new Map(rows.map((r) => [String(r.batch_member), r]));
  const pending: { member: string; name?: string }[] = [];
  for (const m of roster) {
    const row = byMember.get(String(m._id));
    if (!row || row.result === "Pending") {
      pending.push({ member: String(m._id), name: row?.candidate?.name });
    }
  }
  return {
    legacy: false,
    total: roster.length,
    final: roster.length - pending.length,
    pending,
    complete: roster.length > 0 && pending.length === 0,
  };
}

// Rules 45/46: certification completes when every Pass candidate holds an Issued certificate.
export async function certificationCompleteness(batchId: string) {
  const rows = await CandidateResult.find({ batch: batchId }).populate("candidate", "name").lean<any[]>();
  if (!rows.length) return { legacy: true, pass_count: 0, issued: 0, blocking: [] as any[], complete: true };
  const passes = rows.filter((r) => r.result === "Pass");
  const blocking = passes.filter((r) => r.certificate_status !== "Issued");
  return {
    legacy: false,
    pass_count: passes.length,
    issued: passes.length - blocking.length,
    blocking: blocking.map((b) => ({ name: b.candidate?.name, status: b.certificate_status })),
    complete: blocking.length === 0,
  };
}

const CERT_FLOW: Record<string, string[]> = {
  Pending: ["Processing"],
  Processing: ["Generated", "Rejected"],
  Generated: ["Issued", "Rejected"],
  Issued: [],
  Rejected: ["Processing"], // resubmission path
};

// Rules 41, 42, 44, 45 — mark or update one candidate's assessment result.
export async function upsertCandidateResult(batchId: string, memberId: string, patch: Record<string, any>, userId: string) {
  const batch = await Batch.findById(batchId).select("status").lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  if (["Completed", "Cancelled"].includes(batch.status)) {
    throw new HttpError(409, "Rule 41: this batch is closed — results can no longer be recorded.");
  }
  const member = await BatchMember.findById(memberId).select("batch candidate").lean<any>();
  if (!member) throw new HttpError(404, "Batch member not found");
  if (String(member.batch) !== String(batchId)) throw new HttpError(400, "Member belongs to a different batch.");

  const row = (await CandidateResult.findOne({ batch: batchId, candidate: member.candidate }))
    ?? new CandidateResult({ batch: batchId, candidate: member.candidate, batch_member: memberId });

  const nextResult = patch.result ?? row.result;
  if (nextResult === "Fail" && !(patch.failure_reason ?? row.failure_reason)) {
    throw new HttpError(400, "Rule 44: a Fail result requires a failure reason.");
  }
  const wantsReassessment = patch.reassessment_required ?? row.reassessment_required;
  if (wantsReassessment && !(patch.reassessment_date ?? row.reassessment_date)) {
    throw new HttpError(400, "Rule 44: reassessment required means a reassessment date is required.");
  }
  // Rule 45: a certificate already in flight pins the result at Pass.
  if (row.result === "Pass" && nextResult !== "Pass" && row.certificate_status !== "Pending") {
    throw new HttpError(409, `Rule 45: this candidate already has a certificate (${row.certificate_status}). Reject the certificate before changing the result.`);
  }

  for (const f of ["result", "score", "max_score", "assessed_on", "assessor", "failure_reason", "failure_note", "reassessment_required", "reassessment_date", "evidence_file"]) {
    if (patch[f] !== undefined) (row as any)[f] = patch[f];
  }
  if (nextResult !== "Fail") { row.failure_reason = undefined; row.failure_note = undefined; }
  row.marked_by = userId as any;
  row.marked_at = new Date();
  await row.save();
  await recomputeClosureAggregates(batchId, userId);
  return row;
}

// Rules 45, 46 — certificate lifecycle for one candidate.
export async function upsertCandidateCertificate(resultId: string, patch: Record<string, any>, userId: string) {
  const row = await CandidateResult.findById(resultId);
  if (!row) throw new HttpError(404, "Result not found");
  if (row.result !== "Pass") {
    throw new HttpError(409, "Rule 45: no certificate without a Pass result.");
  }
  const target = patch.certificate_status as string | undefined;
  if (target && target !== row.certificate_status) {
    if (!CERT_FLOW[row.certificate_status]?.includes(target)) {
      throw new HttpError(409, `Rule 46: certificate status cannot go from ${row.certificate_status} to ${target}.`);
    }
    if (target === "Generated" && !(patch.certificate_no ?? row.certificate_no) ) {
      throw new HttpError(400, "Rule 46: a generated certificate needs a certificate number.");
    }
    if (target === "Generated" && !(patch.certificate_date ?? row.certificate_date)) {
      throw new HttpError(400, "Rule 46: a generated certificate needs a certificate date.");
    }
    if (target === "Rejected" && !(patch.certificate_rejection_reason ?? row.certificate_rejection_reason)) {
      throw new HttpError(400, "Rule 46: a rejected certificate needs a reason.");
    }
  }
  for (const f of ["certificate_status", "certificate_no", "certificate_date", "certificate_file", "certificate_rejection_reason"]) {
    if (patch[f] !== undefined) (row as any)[f] = patch[f];
  }
  // Never store "" — the partial unique index would then collide across every blank row.
  if (!row.certificate_no) row.set("certificate_no", undefined);
  await row.save();
  await recomputeClosureAggregates(String(row.batch), userId);
  return row;
}

// Rule 44: archive the current attempt and reopen the result.
export async function startReassessment(resultId: string, reassessment_date: Date, userId: string) {
  const row = await CandidateResult.findById(resultId);
  if (!row) throw new HttpError(404, "Result not found");
  if (row.result === "Pending") throw new HttpError(409, "Rule 44: this result is already open.");
  if (row.certificate_status !== "Pending") throw new HttpError(409, "Rule 44: a certificate exists — reject it before reassessing.");
  const batch = await Batch.findById(row.batch).select("status").lean<any>();
  if (["Completed", "Cancelled"].includes(batch?.status)) throw new HttpError(409, "Rule 44: the batch is closed.");

  row.attempts.push({
    attempt: row.attempt, result: row.result, score: row.score, assessed_on: row.assessed_on,
    assessor: row.assessor, failure_reason: row.failure_reason, evidence_file: row.evidence_file,
    recorded_by: userId as any, recorded_at: new Date(),
  } as any);
  row.attempt = (row.attempt ?? 1) + 1;
  row.result = "Pending";
  row.score = undefined; row.assessed_on = undefined; row.failure_reason = undefined; row.failure_note = undefined;
  row.reassessment_required = false;
  row.reassessment_date = reassessment_date;
  await row.save();
  await recomputeClosureAggregates(String(row.batch), userId);
  return row;
}

// Bulk marking — one bad row must not abort a 30-candidate save.
export async function bulkMarkResults(batchId: string, rows: any[], userId: string) {
  const errors: { member: string; error: string }[] = [];
  let updated = 0;
  for (const r of rows) {
    try {
      const { member, ...patch } = r;
      delete patch.source; // §7: provenance is never client-declared
      await upsertCandidateResult(batchId, member, patch, userId);
      updated++;
    } catch (e) {
      errors.push({ member: r.member, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { updated, errors };
}

// Rule 38 for by-ID result access.
export async function assertResultInScope(user: SessionUser, resultId: string) {
  if (!isScoped(user)) return;
  const row = await CandidateResult.findById(resultId).select("batch").lean<any>();
  if (!row) throw new HttpError(404, "Result not found");
  await assertBatchInScope(user, String(row.batch));
}

// ---------- Closure / Invoice (Rules 34–36) ----------
export async function upsertClosureChecked(batchId: string, patch: Record<string, unknown>, userId: string) {
  const batch = await Batch.findById(batchId).lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  let closure = await Closure.findOne({ batch: batchId });
  if (!closure) closure = new Closure({ batch: batchId });

  const perCandidate = await batchUsesPerCandidateResults(batchId);
  if (perCandidate) {
    // Rule 42: once rows exist the aggregates are derived. Silently drop hand-typed values
    // rather than erroring — the existing Save button still sends them, and the UI shows
    // these fields read-only.
    for (const f of ["appeared", "passed", "certificates_issued"]) delete patch[f];
    // Rule 43
    if (patch.assessment_status === "Completed") {
      const c = await assessmentCompleteness(batchId);
      if (!c.complete) {
        throw new HttpError(409, `Rule 43: ${c.total - c.final} candidate(s) still have no final result — ${c.pending.map((p) => p.name).filter(Boolean).slice(0, 5).join(", ")}`);
      }
    }
    // Rules 45/46
    if (patch.certification_status === "Completed") {
      const c = await certificationCompleteness(batchId);
      if (!c.complete) {
        throw new HttpError(409, `Rule 46: certificates not yet Issued for ${c.blocking.map((b) => `${b.name} (${b.status})`).slice(0, 5).join(", ")}`);
      }
    }
  }

  if (!perCandidate && (patch.assessment_status === "Completed" || patch.appeared != null || patch.passed != null)) {
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
  if (perCandidate) await recomputeClosureAggregates(batchId, userId); // Rule 42: derived wins
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

// ---------- Candidate eligibility (2026-08-11 meeting) ----------
// "Age 18 से 40 के बीच… 10th pass नहीं है तो ineligible… पिछले 6 महीने में training ले रखी
// है तो ineligible।" All thresholds live in Defaults. Advisory on assignment (eligibility
// flips month to month as the cooldown lapses), hard information for the operator either way.
export function candidateEligibility(
  c: { dob?: Date | string | null; education?: string | null; last_training_date?: Date | string | null },
  defaults: { min_age: number; max_age: number; training_cooldown_months: number },
  asOf: Date = new Date(),
): { eligible: boolean; reasons: string[]; unknown: string[] } {
  const reasons: string[] = [];
  const unknown: string[] = [];

  if (c.dob) {
    const dob = new Date(c.dob);
    let age = asOf.getFullYear() - dob.getFullYear();
    const m = asOf.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && asOf.getDate() < dob.getDate())) age--;
    if (age < defaults.min_age) reasons.push(`Age ${age} is below ${defaults.min_age}`);
    if (age > defaults.max_age) reasons.push(`Age ${age} is above ${defaults.max_age}`);
  } else unknown.push("Date of birth not recorded");

  if (c.education) {
    if (c.education === "Below 10th") reasons.push("Not 10th pass");
  } else unknown.push("Education not recorded");

  if (c.last_training_date) {
    const eligibleFrom = new Date(c.last_training_date);
    eligibleFrom.setMonth(eligibleFrom.getMonth() + defaults.training_cooldown_months);
    if (eligibleFrom > asOf) {
      reasons.push(`Trained within the last ${defaults.training_cooldown_months} months — eligible from ${eligibleFrom.toLocaleDateString("en-IN")}`);
    }
  } // absence of a last-training date is the normal case, not an unknown

  return { eligible: reasons.length === 0, reasons, unknown };
}

// ---------- Backward batch planner (2026-08-11 meeting) ----------
// "Batch date अगर 20 अगस्त है, तो registration+enrollment 19 तक, mobilization उसके दो दिन
// पहले, trainer एक दिन पहले trained, TOT done at least three days before" — each lead time
// configurable in Defaults, the whole plan shareable as a checklist.
export type Milestone = { key: string; label: string; due_date: Date };

export function planBatchBackward(
  planned_start: Date,
  defaults: {
    lead_enrollment_days: number; lead_mobilization_days: number; lead_trainer_ready_days: number;
    lead_tot_done_days: number; lead_trainer_found_days: number;
  },
): Milestone[] {
  const start = dayStart(planned_start);
  const plan: Milestone[] = [
    { key: "trainer_found", label: "Trainer identified", due_date: addDays(start, -defaults.lead_trainer_found_days) },
    { key: "tot_done", label: "Trainer TOT completed", due_date: addDays(start, -defaults.lead_tot_done_days) },
    { key: "mobilization", label: "Candidate mobilization complete", due_date: addDays(start, -defaults.lead_mobilization_days) },
    { key: "trainer_ready", label: "Trainer finalized & ready", due_date: addDays(start, -defaults.lead_trainer_ready_days) },
    { key: "enrollment_done", label: "Registration & enrollment done", due_date: addDays(start, -defaults.lead_enrollment_days) },
  ];
  return plan.sort((a, b) => a.due_date.getTime() - b.due_date.getTime());
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
