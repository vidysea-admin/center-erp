// Business rules engine — implements the numbered rules from
// center-erp-data-model-rules.md §4. Rule numbers are cited inline.
import { Types } from "mongoose";
import {
  Batch, BatchMember, Candidate, CandidateResult, Closure, CostCategory, CostEntry, DailyLog, Invoice, Location,
  LocationTarget, Notification, Program, Room, Trainer, TrainerDocument,
} from "@/models";
import { auditDiff } from "@/lib/audit";
import { getDefaults } from "@/lib/defaults";
import { HttpError, isScoped } from "@/lib/authz";
import type { SessionUser } from "@/auth";

export const ACTIVE_BATCH_STATUSES = ["Planning", "Ready", "Active", "Closing"];

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

// 2026-08-12 audit F-008 (S1): dayStart() is midnight in the SERVER PROCESS's timezone, and
// DailyLog.log_date was stored with it — so "7 Aug" written by a laptop in IST is a different
// instant from "7 Aug" written by the container in UTC. Lookups compared those instants for
// exact equality, so the missing-log alarm never matched the seeded rows and reported "no daily
// log for 8 operating days" directly above a table listing five. It also means the
// {batch, log_date} unique index behind Rule 27 is keyed on a timezone-dependent value.
//
// dayKey is the calendar date itself, pinned to UTC midnight so it does not move with the
// server's timezone. dayRange spans exactly that calendar day for querying.
export function dayKey(d: Date | string): Date {
  if (typeof d === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }
  const dt = new Date(d);
  return new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()));
}

export function dayRange(d: Date | string): { $gte: Date; $lt: Date } {
  const s = dayKey(d);
  return { $gte: s, $lt: new Date(s.getTime() + 86_400_000) };
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

const toMin = (hhmm: string) => {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(String(hhmm ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * Scheme timing guidelines. 2026-08-12 (Manish): the training day runs 09:00–18:00 — a 07:00
 * start was asked for and refused; no minimum break is prescribed, so none is enforced.
 * 2026-08-13 (Manish, walkthrough): a session is EXACTLY 4 hours or EXACTLY 8 hours — "ya toh
 * 4 ghante ka rakho ya 8 ghante ka… aise aap beech ka tod-mod nahi kar sakte" (a 5-hour slot
 * was asked about and refused). This supersedes the earlier ≤4h ceiling: max_session_hours is
 * no longer consulted here. The day window stays in Defaults (a circular can move it without a
 * deploy); the 4/8 pair is the scheme's own constant, so it is code, not a knob.
 * Blocking (not warning) is deliberate: these are the guidelines an audit checks.
 */
export function slotGuidelineErrors(
  slot: { slot_start?: string | null; slot_end?: string | null } | undefined,
  defaults: { day_start_time?: string; day_end_time?: string; max_session_hours?: number },
): string[] {
  if (!slot?.slot_start || !slot?.slot_end) return []; // slots stay optional — legacy batches have none
  const errs: string[] = [];
  const s = toMin(slot.slot_start), e = toMin(slot.slot_end);
  if (s == null || e == null) return ["Time slot must be in HH:mm form, e.g. 09:00."];
  if (e <= s) return ["Slot end must be after slot start."];

  const dayStart = toMin(defaults.day_start_time ?? "09:00") ?? 540;
  const dayEnd = toMin(defaults.day_end_time ?? "18:00") ?? 1080;
  if (s < dayStart || e > dayEnd) {
    errs.push(`Scheme guideline: training runs ${defaults.day_start_time ?? "09:00"}–${defaults.day_end_time ?? "18:00"}. This slot (${slot.slot_start}–${slot.slot_end}) falls outside it.`);
  }
  const durMin = e - s;
  if (durMin !== 240 && durMin !== 480) {
    errs.push(`Scheme guideline: a session is exactly 4 hours or exactly 8 hours. This slot is ${(durMin / 60).toFixed(1)} hours.`);
  }
  return errs;
}

export async function assertSlotWithinGuidelines(
  slot: { slot_start?: string | null; slot_end?: string | null } | undefined,
) {
  const errs = slotGuidelineErrors(slot, await getDefaults());
  if (errs.length) throw new HttpError(400, errs.join(" "));
}

// Rule 10: hard block if trainer would exceed max_concurrent_batches on overlapping ranges.
// 2026-08-11 addition: when both batches carry a time slot, a same-time overlap is blocked
// outright — a trainer cannot teach two rooms at 9:00 no matter how low the count is.
// 2026-08-12 addition: and no more than max_batches_per_day slotted batches on one day, since
// two 4-hour sessions is the pattern the scheme sanctions.
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
  // Two 4-hour batches a day is the sanctioned pattern (Manish, 2026-08-12). Only slotted
  // batches are counted — an unslotted batch is "whole day" and is already governed by the
  // concurrency cap, so counting it here would double-penalise legacy data.
  if (slot?.slot_start && slot?.slot_end) {
    const maxPerDay = (await getDefaults()).max_batches_per_day ?? 2;
    const sameDaySlotted = overlapping.filter((b) => b.slot_start && b.slot_end);
    if (sameDaySlotted.length + 1 > maxPerDay) {
      throw new HttpError(409,
        `Scheme guideline: at most ${maxPerDay} sessions a day. Trainer ${trainer.name} already runs ${sameDaySlotted.length} slotted batch(es) over these dates (${sameDaySlotted.map((b) => `${b.code} ${b.slot_start}–${b.slot_end}`).join(", ")}).`);
    }
  }
  // 2026-08-12 audit F-001: Admin → Defaults shows a "Max concurrent batches" field, but Rule 10
  // read only the per-trainer number, so changing that Default did nothing to enforcement — it
  // fed only the capacity sentence on the location screen. Production had the Default at 5 while
  // the cap actually applied was 4. The per-trainer value still wins when it is set (some
  // trainers genuinely carry more or fewer); the Default is the policy behind everyone else.
  const cap = trainer.max_concurrent_batches ?? (await getDefaults()).max_concurrent_batches ?? 1;
  if (overlapping.length + 1 > cap) {
    const c = overlapping[0];
    throw new HttpError(409,
      `Rule 10: Trainer ${trainer.name} already assigned to batch ${c.code} at ${c.location?.name ?? "?"} (${new Date(batchRange(c)[0]).toDateString()} – ${new Date(batchRange(c)[1]).toDateString()}); max concurrent = ${cap}.`);
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
  if (t.pipeline_status && t.pipeline_status !== "Certified") {
    warnings.push(`Trainer ${t.name} is still "${t.pipeline_status}" — not yet Certified, so they have no TR ID for the portal.`);
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
    const cand = await Candidate.findById(m.candidate).select("name dob education last_training_date fee_paid_on").lean<any>();
    if (cand) {
      const defaults = await getDefaults();
      const elig = candidateEligibility(cand, defaults);
      if (!elig.eligible) {
        throw new HttpError(409, `Candidate ${cand.name} is not eligible: ${elig.reasons.join("; ")}`);
      }
      // R-J (QA-049, CEO: "enrolled = fees paid"): gates only when the Defaults toggle is
      // ON — government-funded schemes charge the candidate nothing, so OFF is the default.
      if (defaults.fee_required_for_enrollment && !cand.fee_paid_on) {
        throw new HttpError(409, `Rule 54: ${cand.name} has no fee payment on record, and this environment requires the fee before enrollment completes. Record the payment on the candidate first.`);
      }
    }
  }
  await m.save();

  if (m.enrollment_status === "Completed") {
    await Candidate.findByIdAndUpdate(m.candidate, { lifecycle_status: "Enrolled" }); // Rule 21
  // CEO 14/08: capture WHEN the candidate enrolled — first completion only, never overwritten.
  await Candidate.updateOne({ _id: m.candidate, enrolled_at: null }, { enrolled_at: new Date() });
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
  // 2026-08-12 audit F-007 (S1): Rule 26 excludes a member from the roster on their own leave
  // date, so a log for that day kept listing someone who was no longer on it. Every later edit
  // to that log — including entering the government attendance figure, the number the whole
  // system exists to report — was then refused with "present member not in roster on that
  // date", naming neither the member nor the day. Tidy the roster history as we go instead.
  const staleLogs = await DailyLog.find({ batch: m.batch, log_date: { $gte: lo }, present_member_ids: m._id });
  for (const log of staleLogs) {
    log.present_member_ids = log.present_member_ids.filter((id: any) => String(id) !== String(m._id));
    // Rule 51 invariant: biometric ⊆ present — the tidy-up must strip both, or every later
    // edit of that day would be refused for a member who is no longer even on the roster.
    log.biometric_member_ids = (log.biometric_member_ids ?? []).filter((id: any) => String(id) !== String(m._id));
    log.internal_present = log.present_member_ids.length; // Rule 29; roster_count stays frozen (Rule 28)
    await log.save();
  }
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

  // F-A3 (Manish, 2026-08-14 — hard gate, was advisory): "TOT done at least three days
  // before batch start." Enforced only when the TOT completion date is on record —
  // trainers who predate the pipeline carry no tot_done_on and are not retro-blocked.
  const totLeadDays = defaults.lead_tot_done_days ?? 3;
  const totLeadOk = !trainer?.tot_done_on
    || dayStart(trainer.tot_done_on) <= dayStart(addDays(batch.planned_start, -totLeadDays));

  const checks = {
    location_approved: location?.approval_status === "Approved"
      && !HALTED_LOCATION_STATUSES.includes(location?.operational_status), // Rule 1
    room_assigned: roomOk,
    trainer_ready: trainerAvailable,
    tot_lead_ok: totLeadOk, // F-A3
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
        // Rule 47: only a Pass finishes as Completed; Fail/Absent are Failed (CEO 14/08 word).
        const passed = results.filter((r) => r.result === "Pass").map((r) => String(r.candidate));
        const notCertified = results.filter((r) => ["Fail", "Absent"].includes(r.result)).map((r) => String(r.candidate));
        await Candidate.updateMany(
          { _id: { $in: passed.filter((id) => rosterCandidateIds.includes(id)) } },
          { lifecycle_status: "Completed" },
        );
        await Candidate.updateMany(
          { _id: { $in: notCertified.filter((id) => rosterCandidateIds.includes(id)) } },
          { lifecycle_status: "Failed" },
        );
      } else {
        // Legacy batches keep the original blanket behaviour (Rule 21).
        await Candidate.updateMany({ _id: { $in: roster.map((m) => m.candidate) } }, { lifecycle_status: "Completed" });
      }
      break;
    }
    case "Completed->Closed": {
      // CEO 13/08 (Rule 52): "Complete hone ke baad certify → invoice → payment → ALL DUES
      // SETTLE — main khali payment lene mein interested nahi hoon; sabka settle karke NO
      // DUES, tab batch CLOSED." Completed is the training outcome; Closed is the money
      // outcome, and it cannot be claimed before the money story is actually over.
      const closure = await Closure.findOne({ batch: batchId }).lean<any>();
      if (closure?.certification_status !== "Completed") fail("Rule 52: certification must be Completed before closing.");
      const invoice = await Invoice.findOne({ batch: batchId }).lean<any>();
      if (invoice?.status !== "Paid") fail(`Rule 52: the invoice must be PAID before a batch closes (currently ${invoice?.status ?? "not raised"}).`);
      if (!closure?.dues_settled) fail("Rule 52: mark ALL dues settled (trainer, centre, vendor — no dues pending) before closing the batch.");
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

// ---------- Daily log (Rules 27–33, 51) ----------
export async function validateDailyLog(batchId: string, log_date: Date, payload: {
  present_member_ids: string[]; govt_present?: number | null; trainer_present?: boolean;
  biometric_member_ids?: string[];
}) {
  const batch = await Batch.findById(batchId).lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  if (batch.status !== "Active" && batch.status !== "Closing") {
    throw new HttpError(409, "Daily logs only for Active/Closing batches.");
  }
  await assertLocationOperational(batch.location, "Entering a daily log"); // Rule 1
  // 2026-08-13 (Manish): the govt portal accepts a day's student attendance only when the
  // trainer's own (biometric) attendance exists for that day — "trainer ka attendance must
  // hai daily basis pe, tabhi bacche us date mein attendance bana sakte hain". Mirrored:
  // students can be marked present only on a day the trainer is asserted present.
  if (payload.present_member_ids.length > 0 && payload.trainer_present === false) {
    throw new HttpError(400, "Students cannot be marked present on a day the trainer was absent — the government portal only accepts student attendance after the trainer's own attendance. Tick 'Trainer present' or clear the student ticks.");
  }
  // F-008: compare calendar dates on one consistent footing. Mixing dayStart (server-local) with
  // the dayKey the log is stored under would shift the day by the server's UTC offset.
  const D = dayKey(log_date);
  if (batch.actual_start && D < dayKey(batch.actual_start)) throw new HttpError(400, "Rule 32: log date before batch actual start.");
  if (batch.actual_end && D > dayKey(batch.actual_end)) throw new HttpError(400, "Rule 32: log date after batch actual end.");
  if (D > dayKey(new Date())) throw new HttpError(400, "Cannot log a future date.");

  const roster = await rosterOnDate(batchId, D); // Rule 26
  const rosterIds = new Set(roster.map((m) => String(m._id)));
  for (const id of payload.present_member_ids) {
    if (!rosterIds.has(String(id))) {
      // Name who and when — the operator cannot act on "a present member" (audit F-007).
      const m = await BatchMember.findById(id).populate("candidate", "name").lean<any>();
      const who = m?.candidate?.name ?? "That candidate";
      const when = D.toLocaleDateString("en-IN");
      throw new HttpError(400, m?.left_on
        ? `Rule 29: ${who} left this batch on ${new Date(m.left_on).toLocaleDateString("en-IN")}, so they were not on the roster on ${when}. Untick them to save.`
        : `Rule 29: ${who} was not on this batch's roster on ${when}.`);
    }
  }
  // Rule 51 (Karunn 2026-08-13): "biometric done & present" and "not done & present" are both
  // fine; "biometric done & NOT present" cannot happen — biometric attendance IS presence.
  if (payload.biometric_member_ids?.length) {
    const presentSet = new Set(payload.present_member_ids.map(String));
    for (const id of payload.biometric_member_ids) {
      if (!presentSet.has(String(id))) {
        const m = await BatchMember.findById(id).populate("candidate", "name").lean<any>();
        throw new HttpError(400, `Rule 51: ${m?.candidate?.name ?? "That student"} is marked "biometric done" but not present — biometric done & not present cannot happen. Tick them present first, or clear the biometric tick.`);
      }
    }
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
    const log = await DailyLog.findOne({ batch: batch._id, log_date: dayRange(d) }).select("_id").lean();
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

  if (batch.status === "Cancelled") return { score: "Green", reasons };
  // QA-003 (checker): a batch that "Completed" with nobody on it was Health Green — the
  // dashboard's word for "all fine" on a row that is provably wrong. Completed stays Green
  // only when it actually had students.
  if (batch.status === "Completed") {
    const rosterN = await BatchMember.countDocuments({ batch: batchId, left_on: null });
    if (rosterN === 0) {
      return { score: "Amber", reasons: [{ code: "empty_completed", label: "Completed with no students on the roster — upload the roster or remove the shell", severity: "amber" }] };
    }
    return { score: "Green", reasons };
  }
  // An Active/Closing batch with an empty roster is running for nobody — name it (the
  // missing-logs streak already fires, but "why" matters more than "what").
  if (["Active", "Closing"].includes(batch.status)) {
    const rosterN = await BatchMember.countDocuments({ batch: batchId, left_on: null });
    if (rosterN === 0) reasons.push({ code: "empty_roster", label: "No students on the roster", severity: "red" });
  }

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

// QA-048 (CEO): "Completed ke baad ke statuses kya hain?" — the money chain existed only as
// hidden flags (Closure.certification_status, Invoice.status, dues_settled) that Rule 52
// enforces but nothing displayed. Derived, never stored: the next unmet step IS the stage.
export function settlementStage(batchStatus: string, closure: any, invoice: any): string | null {
  if (batchStatus === "Closed") return "Closed — all dues settled";
  if (batchStatus !== "Completed") return null;
  if (closure?.certification_status !== "Completed") return "Awaiting certification";
  if (!invoice || invoice.status === "Not Ready") return "Certified — invoice not ready";
  if (invoice.status === "Ready") return "Certified — invoice to raise";
  if (invoice.status === "Raised") return "Invoice raised — payment pending";
  if (invoice.status === "Paid" && !closure?.dues_settled) return "Payment received — dues to settle";
  if (invoice.status === "Paid" && closure?.dues_settled) return "Ready to close";
  return null;
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
    const log = await DailyLog.findOne({ batch: b._id, log_date: dayRange(d) }).lean();
    if (!log) out.push({ batch: b, missing_date: d, owner: b.location?.spoc_name ?? "SPOC" });
  }
  return out;
}

// ---------- Per-candidate assessment & certification (Rules 41–47, RPL M17/M18) ----------

export type ResultSummary = {
  total: number; final: number; pending: number;
  appeared: number; passed: number; failed: number; absent: number; certificates_issued: number;
  billable_passed: number; dropped_passed: number;
};

export type SummaryOpts = {
  // Manish, 2026-08-12: for this client's contract an absentee is NOT deducted from "appeared".
  // It is a contract term rather than a scheme rule, so it stays a Defaults toggle.
  absentCountsAsAppeared?: boolean;
  // BatchMember ids that carry a left_on — a candidate who dropped out is not billable even if
  // they passed (Manish, 2026-08-12), while their result itself is still preserved (Rule 42).
  droppedMemberIds?: Set<string>;
};

// Pure — used on GET so reads never write.
export function summarizeResults(rows: any[], opts: SummaryOpts = {}): ResultSummary {
  const { absentCountsAsAppeared = true, droppedMemberIds } = opts;
  const by = (r: string) => rows.filter((x) => x.result === r).length;
  const passed = by("Pass"), failed = by("Fail"), absent = by("Absent"), pending = by("Pending");
  const droppedPassed = droppedMemberIds
    ? rows.filter((x) => x.result === "Pass" && droppedMemberIds.has(String(x.batch_member))).length
    : 0;
  return {
    total: rows.length,
    final: rows.length - pending,
    pending,
    appeared: absentCountsAsAppeared ? passed + failed + absent : passed + failed,
    passed, failed, absent,
    certificates_issued: rows.filter((x) => x.certificate_status === "Issued").length,
    dropped_passed: droppedPassed,
    billable_passed: passed - droppedPassed,
  };
}

// The DB-aware wrapper: reads the contract toggles and the drop list, so callers get the
// invoice-grade numbers without each one re-deriving them.
export async function summarizeBatchResults(batchId: string, rows?: any[]): Promise<ResultSummary> {
  const [defaults, resultRows, droppedMembers] = await Promise.all([
    getDefaults(),
    rows ? Promise.resolve(rows) : CandidateResult.find({ batch: batchId }).lean<any[]>(),
    BatchMember.find({ batch: batchId, left_on: { $ne: null } }).select("_id").lean<any[]>(),
  ]);
  return summarizeResults(resultRows, {
    absentCountsAsAppeared: defaults.absent_counts_as_appeared !== false,
    droppedMemberIds: defaults.dropped_pass_is_billable ? undefined : new Set(droppedMembers.map((m) => String(m._id))),
  });
}

// Rule 41: a batch with no rows is "legacy" and keeps its stored batch-level figures.
export async function batchUsesPerCandidateResults(batchId: string): Promise<boolean> {
  return (await CandidateResult.countDocuments({ batch: batchId })) > 0;
}

// Rule 42: aggregates are derived from the rows and written through to Closure, so every
// existing reader (invoice flow, dashboards) keeps working unchanged.
export async function recomputeClosureAggregates(batchId: string, actorId?: string) {
  const rows = await CandidateResult.find({ batch: batchId }).lean<any[]>();
  const summary = await summarizeBatchResults(batchId, rows);
  if (!rows.length) return { ...summary, legacy: true };

  const closure = (await Closure.findOne({ batch: batchId })) ?? new Closure({ batch: batchId });
  const before = { appeared: closure.appeared, passed: closure.passed, certificates_issued: closure.certificates_issued, billable_passed: closure.billable_passed };
  closure.appeared = summary.appeared;
  closure.passed = summary.passed;
  // DEC-4 (Umesh, 2026-08-13): dropped-but-passed candidates never count for invoicing. The raw
  // pass count stays (Rule 42 readers unchanged); the billable split is what invoicing reads.
  closure.dropped_passed = summary.dropped_passed;
  closure.billable_passed = summary.billable_passed;
  closure.certificates_issued = summary.certificates_issued;
  if (!closure.assessment_date) {
    const dates = rows.map((r) => r.assessed_on).filter(Boolean).map((d) => new Date(d).getTime());
    if (dates.length) closure.assessment_date = new Date(Math.max(...dates));
  }
  await closure.save();
  // Any previously hand-typed figure survives in the audit trail, attributed to derivation.
  await auditDiff("Closure", closure._id, before,
    { appeared: summary.appeared, passed: summary.passed, certificates_issued: summary.certificates_issued, billable_passed: summary.billable_passed },
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
  // 2026-08-12 audit (S0): a candidate who has left the batch kept blocking certification
  // forever, because this walked every result row regardless of membership.
  const dropped = await BatchMember.find({ batch: batchId, left_on: { $ne: null } }).select("_id").lean<any[]>();
  const droppedIds = new Set(dropped.map((m) => String(m._id)));
  const passes = rows.filter((r) => r.result === "Pass" && !droppedIds.has(String(r.batch_member)));
  // "Not Issued" is a settled outcome, not an outstanding one.
  const blocking = passes.filter((r) => !["Issued", "Not Issued"].includes(r.certificate_status));
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
  Processing: ["Generated", "Rejected", "Not Issued"],
  Generated: ["Issued", "Rejected", "Not Issued"],
  Issued: [],
  // 2026-08-12 audit (S0): "Rejected" used to lead only back to "Processing", which demands a
  // certificate_no — so a certificate the awarding body refused could never be abandoned and the
  // batch could never leave Closing. "Not Issued" is the honest terminal state.
  Rejected: ["Processing", "Not Issued"], // resubmit, or give up on it
  "Not Issued": ["Processing"], // reopen if the awarding body relents
};

// Rules 41, 42, 44, 45 — mark or update one candidate's assessment result.
export async function upsertCandidateResult(batchId: string, memberId: string, patch: Record<string, any>, userId: string) {
  const batch = await Batch.findById(batchId).select("status").lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  if (["Completed", "Cancelled"].includes(batch.status)) {
    throw new HttpError(409, "Rule 41: this batch is closed — results can no longer be recorded.");
  }
  // 2026-08-12 audit (S0): marking the FIRST candidate on a batch that already completed
  // assessment in batch-level mode silently rewrote Closure.appeared/passed from the real
  // figures (e.g. 30/25) down to 1/1, and left every unmarked candidate stranded at Enrolled
  // on a closed batch. Switching modes after the fact is now refused outright.
  const closureNow = await Closure.findOne({ batch: batchId }).select("assessment_status").lean<any>();
  if (closureNow?.assessment_status === "Completed" && !(await batchUsesPerCandidateResults(batchId))) {
    throw new HttpError(409,
      "Rule 42: assessment was already completed with batch-level figures. Reopen the assessment before marking candidates individually, so the totals are rebuilt from the roster rather than overwritten.");
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
  // DEC-6 (Umesh, 2026-08-13): a Completed batch stays locked — no admin override, even for a
  // mistyped certificate number. This path used to skip the batch-status check the assessment
  // path already had, so `{certificate_no}` could be rewritten after completion.
  const certBatch = await Batch.findById(row.batch).select("status").lean<any>();
  if (["Completed", "Cancelled"].includes(certBatch?.status)) {
    throw new HttpError(409, "The batch is closed — certificate details are frozen (2026-08-13 decision: a Completed batch stays locked).");
  }
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
    // Abandoning a certificate is a reportable decision, so it carries a reason too.
    if (target === "Not Issued" && !(patch.certificate_rejection_reason ?? row.certificate_rejection_reason)) {
      throw new HttpError(400, "Rule 46: say why this certificate will never be issued.");
    }
    // A stale number must not survive onto an abandoned or reopened certificate — it would
    // otherwise block its own reuse via the partial unique index (sync S2-10).
    if (["Not Issued", "Processing"].includes(target)) {
      row.set("certificate_no", undefined);
      row.set("certificate_date", undefined);
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
  // "Not Issued" is settled, not outstanding — a candidate whose certificate was abandoned may
  // be reassessed. Previously only "Pending" passed here, and the error told you to reject a
  // certificate that was already rejected (2026-08-12 audit, S0).
  if (!["Pending", "Not Issued"].includes(row.certificate_status)) {
    throw new HttpError(409, `Rule 44: this candidate's certificate is ${row.certificate_status} — reject it or mark it Not Issued before reassessing.`);
  }
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
  // DEC-6 (Umesh, 2026-08-13): once the batch is Completed the closure record is frozen.
  // The MONEY-FLOW flags stay writable — invoicing and the Rule 52 dues attestation happen
  // naturally AFTER completion (that is their whole purpose); the training facts stay locked.
  const POST_COMPLETION_WRITABLE = new Set(["ready_for_invoice", "dues_settled", "dues_note", "dues_marked_by", "dues_marked_at"]);
  if (["Completed", "Cancelled"].includes(batch.status)) {
    const blocked = Object.keys(patch).filter((k) => patch[k] !== undefined && !POST_COMPLETION_WRITABLE.has(k));
    if (blocked.length) {
      throw new HttpError(409, `The batch is closed — ${blocked.join(", ")} can no longer change (2026-08-13 decision: a Completed batch stays locked; only invoice-readiness and the dues attestation may still be marked).`);
    }
  }
  // Rule 52: once CLOSED, even the money flags are history.
  if (batch.status === "Closed") {
    throw new HttpError(409, "The batch is Closed — the settlement record is final.");
  }
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

  if (!perCandidate) {
    // Batch-level mode. Audit F-010 (S0): Rules 43/46 used to live ONLY inside the
    // perCandidate branch above, and perCandidate is false exactly when nobody has been
    // assessed — so a batch with zero results could be marked assessment Completed, then
    // certification Completed, then carried all the way to a Paid invoice with no evidence
    // behind it. "No results exist" was being read as "nothing is pending" instead of
    // "nothing was assessed". Completing now requires the numbers, in either mode.
    if (patch.assessment_status === "Completed") {
      const appeared = (patch.appeared as number) ?? closure.appeared;
      const passed = (patch.passed as number) ?? closure.passed;
      if (appeared == null || passed == null) {
        throw new HttpError(409, "Rule 43: record how many candidates appeared and passed, or mark each candidate individually, before completing assessment.");
      }
    }
    if (patch.certification_status === "Completed") {
      const issued = (patch.certificates_issued as number) ?? closure.certificates_issued;
      if (issued == null) {
        throw new HttpError(409, "Rule 46: record how many certificates were issued, or mark each candidate's certificate, before completing certification.");
      }
    }

    if (patch.assessment_status === "Completed" || patch.certification_status === "Completed"
      || patch.appeared != null || patch.passed != null || patch.certificates_issued != null) {
      const assessDate = (patch.assessment_date as Date) ?? closure.assessment_date ?? new Date();
      const roster = await rosterOnDate(batchId, new Date(assessDate));
      const appeared = (patch.appeared as number) ?? closure.appeared;
      const passed = (patch.passed as number) ?? closure.passed;
      const issued = (patch.certificates_issued as number) ?? closure.certificates_issued;
      if (appeared != null && appeared > roster.length) throw new HttpError(400, `Rule 34: appeared (${appeared}) exceeds roster on assessment date (${roster.length}).`);
      // sync S1-7: `passed` was unchecked whenever `appeared` was null, and
      // `certificates_issued` was never checked at all. Both feed the invoice.
      if (passed != null && passed > (appeared ?? roster.length)) {
        throw new HttpError(400, `Rule 34: passed (${passed}) cannot exceed ${appeared != null ? `appeared (${appeared})` : `the roster (${roster.length})`}.`);
      }
      if (issued != null && issued > (passed ?? roster.length)) {
        throw new HttpError(400, `Rule 46: certificates issued (${issued}) cannot exceed ${passed != null ? `passed (${passed})` : `the roster (${roster.length})`}.`);
      }
      if ([appeared, passed, issued].some((n) => n != null && (!Number.isInteger(n) || (n as number) < 0))) {
        throw new HttpError(400, "Rule 34: appeared, passed and certificates issued must be whole numbers of zero or more.");
      }
    }
  }

  const settingReady = patch.ready_for_invoice === true && !closure.ready_for_invoice;
  const certStatus = (patch.certification_status as string) ?? closure.certification_status;
  if (settingReady && certStatus !== "Completed") {
    throw new HttpError(409, "Rule 35: ready_for_invoice requires certification Completed.");
  }

  // 2026-08-13 (Manish): "as an admin main assessment date daal paun, aur student ko notify
  // kar paun". The date lands on the closure; setting or moving it raises an in-app alert for
  // every role that faces candidates. (Direct-to-candidate outreach remains the manual
  // WhatsApp/SMS links — no gateway is provisioned; the student attendance link shows the date.)
  const newAssessDate = patch.assessment_date ? new Date(patch.assessment_date as any) : undefined;
  const assessDateChanged = newAssessDate !== undefined
    && (!closure.assessment_date || dayKey(newAssessDate).getTime() !== dayKey(new Date(closure.assessment_date)).getTime());

  Object.assign(closure, patch);
  if (settingReady) {
    closure.marked_ready_by = new Types.ObjectId(userId);
    closure.marked_ready_at = new Date();
    // 2026-08-12 audit (sync S1-5): this unconditionally forced the invoice back to "Ready",
    // so un-ticking and re-ticking "ready for invoice" walked a Raised or even Paid invoice
    // backwards past both the monotonic order in Rule 36 and the approval gate. Only ever
    // create the invoice or lift it off "Not Ready" — never drag a live one back.
    const existing = await Invoice.findOne({ batch: batchId }).select("status").lean<any>();
    if (!existing) {
      await Invoice.create({ batch: batchId, status: "Ready" }); // Rule 35
    } else if (existing.status === "Not Ready") {
      await Invoice.updateOne({ batch: batchId }, { $set: { status: "Ready" } });
    }
  }
  await closure.save();
  if (assessDateChanged) {
    const b = await Batch.findById(batchId).select("code location").lean<any>();
    const when = new Date(closure.assessment_date!).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    // One live alert per batch (same dedup contract as the scheduler's notifications).
    await Notification.findOneAndUpdate(
      { type: "assessment_scheduled", entity_id: closure.batch, status: "New" },
      {
        $set: {
          severity: "info",
          message: `Assessment for ${b?.code ?? "batch"} scheduled on ${when} — inform the candidates.`,
          entity: "Batch", link: `/batches/${batchId}`,
          role_target: ["Admin", "Operations", "Location", "Trainer"],
          location: b?.location,
        },
        $setOnInsert: { type: "assessment_scheduled", entity_id: closure.batch, status: "New" },
      },
      { upsert: true },
    );
  }
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
  // 2026-08-12 audit (sync S1-6): the money fields stayed freely editable after Raised, and a
  // field-only PATCH carried no status change so it skipped the approval gate entirely — an
  // invoice number or amount could be rewritten after the fact with nothing recording it.
  // They are now frozen once the invoice has left "Ready"; correcting one means moving the
  // invoice back deliberately, which is itself gated and audited.
  const MONEY_FIELDS = ["amount", "invoice_no", "raised_on", "paid_on"];
  if (INVOICE_ORDER.indexOf(inv.status) >= INVOICE_ORDER.indexOf("Raised")) {
    const changed = MONEY_FIELDS.filter((f) => {
      if (patch[f] === undefined) return false;
      const before = (inv as any)[f];
      const a = before instanceof Date ? before.toISOString().slice(0, 10) : before ?? null;
      const b = patch[f] instanceof Date ? (patch[f] as Date).toISOString().slice(0, 10) : String(patch[f] ?? "").slice(0, 10) || null;
      return String(a ?? "") !== String(b ?? "");
    });
    // Setting paid_on as part of the Ready→Raised→Paid move itself is legitimate.
    const allowed = target === "Paid" ? ["paid_on"] : [];
    const blocked = changed.filter((f) => !allowed.includes(f));
    if (blocked.length) {
      throw new HttpError(409, `Rule 36: ${blocked.join(", ")} cannot be changed once the invoice is ${inv.status}.`);
    }
  }
  Object.assign(inv, patch);
  await inv.save();
  return inv;
}

// Rule 37
export function assertCostEntryValid(e: { location?: unknown; batch?: unknown; trainer?: unknown; amount?: unknown }) {
  if (!e.location && !e.batch && !e.trainer) {
    throw new HttpError(400, "Rule 37: cost entry needs at least a location, batch, or trainer.");
  }
  // 2026-08-13 (eval sweep): a negative or zero amount was accepted and silently shrank the
  // totals. Money entered here feeds the invoice conversation — refuse what cannot be spent.
  if (!(Number(e.amount) > 0)) {
    throw new HttpError(400, "Rule 37: amount must be a positive number.");
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
    lead_tot_start_days: number; lead_trainer_ready_for_tot_days: number;
  },
): Milestone[] {
  const start = dayStart(planned_start);
  const plan: Milestone[] = [
    { key: "trainer_found", label: "Trainer identified", due_date: addDays(start, -defaults.lead_trainer_found_days) },
    // The CEO's own gap: how long TOT itself takes was never captured, only its deadline.
    { key: "trainer_ready_for_tot", label: "Trainer available & ready for TOT", due_date: addDays(start, -(defaults.lead_trainer_ready_for_tot_days ?? 12)) },
    { key: "tot_start", label: "TOT starts", due_date: addDays(start, -(defaults.lead_tot_start_days ?? 10)) },
    { key: "tot_done", label: "Trainer TOT completed", due_date: addDays(start, -defaults.lead_tot_done_days) },
    { key: "mobilization", label: "Candidate mobilization complete", due_date: addDays(start, -defaults.lead_mobilization_days) },
    { key: "trainer_ready", label: "Trainer finalized & ready", due_date: addDays(start, -defaults.lead_trainer_ready_days) },
    { key: "enrollment_done", label: "Registration & enrollment done", due_date: addDays(start, -defaults.lead_enrollment_days) },
  ];
  return plan.sort((a, b) => a.due_date.getTime() - b.due_date.getTime());
}

// ---------- Batch code (CEO 14/08 [32:47]: CENTRE-COURSE-NN) ----------
// "It should be center code, dash, abbreviation for the course … dash, the batch number" —
// GGM-DST-01 style, numbered per centre × course. Shipped BEFORE Manish bulk-plans every
// RPL batch, so 8-10k batches are not minted in the old global format. The course
// abbreviation is the programme code's last segment (RPLAVP-DST → DST); one counter per
// prefix in the same `counters` collection. The legacy global "batch" counter stays parked
// at its last value — old codes on old paper never collide with new ones.
export async function nextBatchCode(location?: { code?: string } | null, program?: { code?: string } | null): Promise<string> {
  const db = Batch.db;
  const locCode = String(location?.code ?? "").trim().toUpperCase();
  const progAbbr = String(program?.code ?? "").trim().toUpperCase().split("-").pop() ?? "";
  if (locCode && progAbbr) {
    const prefix = `${locCode}-${progAbbr}`;
    const res = await db.collection("counters").findOneAndUpdate(
      { _id: `batch|${prefix}` as any }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" },
    );
    const seq = (res as any)?.seq ?? (res as any)?.value?.seq ?? 1;
    return `${prefix}-${String(seq).padStart(2, "0")}`;
  }
  // Legacy fallback — only for a caller with no centre/programme context.
  const res = await db.collection("counters").findOneAndUpdate(
    { _id: "batch" as any },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  const seq = (res as any)?.seq ?? (res as any)?.value?.seq ?? 1;
  return "B" + String(seq).padStart(3, "0");
}

// ---------- Trainer preparation pipeline (2026-08-12, Manish's RPL walkthrough) ----------
// The journey is a round-trip through a body we do not control (NSDC/SSC via the ABPL team), so
// the machine has to model waiting and rejection as first-class, not as an afterthought:
//   Fresh Lead -> Shortlisted (docs collected here) -> Documents Completed (Rule T2 gate)
//   -> Sent to NSDC -> NSDC Approved -> TOT Payment Done -> TOT Scheduled -> TOT In Progress -> Certified
// with "NSDC Rejected" branching off the submission and looping BACK to Shortlisted, because
// "profile mein kya truti hai vo batate hain... hum isko correct karke wapas bhej rahe hain" is
// the normal case, not the exception. Anything can reach "Dropped" with a reason.
// 2026-08-14: stage names ARE the CEO's recorded-review vocabulary — stored, not labelled.

// Documents that must be on file before a nomination can be prepared. Kept here rather than in
// The floor that applies to every job role. A programme can name its own wider set in
// Program.mandatory_trainer_docs — "industry experience aur teaching experience required hai,
// mendetary hai TVP mein jaane ke lie", and which ones differ BY JOB ROLE (2026-08-12, Manish).
export const MANDATORY_TRAINER_DOCS = ["Aadhaar", "PAN", "Photo", "CV", "Educational Qualification"] as const;

const TRAINER_FLOW: Record<string, string[]> = {
  // 2026-08-14 CEO vocabulary. The old Docs Pending state merged into Shortlisted (documents
  // are collected while Shortlisted); Rule T2's "papers actually in" check still gates the
  // entry into Documents Completed, which is the only exit that mattered.
  "Fresh Lead": ["Shortlisted", "Dropped"],
  "Shortlisted": ["Documents Completed", "Dropped"],
  "Documents Completed": ["Sent to NSDC", "Shortlisted", "Dropped"],
  "Sent to NSDC": ["NSDC Approved", "NSDC Rejected", "Dropped"],
  // The correct-and-resubmit loop. Also allowed straight back to Sent for a clerical fix.
  "NSDC Rejected": ["Shortlisted", "Sent to NSDC", "Dropped"],
  "NSDC Approved": ["TOT Payment Done", "Dropped"],
  "TOT Payment Done": ["TOT Scheduled", "Dropped"],
  "TOT Scheduled": ["TOT In Progress", "Dropped"],
  // A trainer can fail TOT - back to scheduled for a retake, or out.
  "TOT In Progress": ["Certified", "TOT Scheduled", "Dropped"],
  "Certified": ["Dropped"],
  "Dropped": ["Fresh Lead"], // re-open a candidate who comes back later
};

export async function trainerDocSummary(trainerId: string) {
  const [docs, trainer] = await Promise.all([
    TrainerDocument.find({ trainer: trainerId }).select("doc_type verified").lean<any[]>(),
    Trainer.findById(trainerId).select("nominated_for_program").lean<any>(),
  ]);
  // The job role decides the extra paperwork: the five identity documents are the floor for
  // everyone, and a role that demands experience certificates names them on the programme —
  // the union gates. No nomination target yet (early pipeline) → the floor alone applies; the
  // role's extras bite once the vacancy is chosen, which is always before Documents Completed
  // (Rule T3 requires the target by then), so nothing incomplete ever reaches NSDC.
  const required: string[] = [...MANDATORY_TRAINER_DOCS];
  if (trainer?.nominated_for_program) {
    const prog = await Program.findById(trainer.nominated_for_program).select("mandatory_trainer_docs").lean<any>();
    for (const d of prog?.mandatory_trainer_docs ?? []) if (!required.includes(d)) required.push(d);
  }
  const have = new Set(docs.map((d) => d.doc_type));
  const missing = required.filter((t) => !have.has(t));
  return { total: docs.length, required, missing, complete: missing.length === 0, verified: docs.filter((d) => d.verified).length };
}

// Mirrors transitionBatch: an explicit edge table, each edge naming its own precondition, and a
// 409 that says what is actually missing rather than "invalid transition".
export async function transitionTrainer(
  trainerId: string,
  target: string,
  opts: { reason?: string; remarks?: string; date?: Date; payload?: Record<string, unknown>; actor?: string } = {},
) {
  const t = await Trainer.findById(trainerId);
  if (!t) throw new HttpError(404, "Trainer not found");
  const from = t.pipeline_status ?? "Fresh Lead";
  if (from === target) throw new HttpError(409, `${t.name} is already at "${target}".`);

  const allowed = TRAINER_FLOW[from];
  if (!allowed) throw new HttpError(409, `Unknown pipeline state "${from}".`);
  if (!allowed.includes(target)) {
    throw new HttpError(409,
      `A trainer at "${from}" can only move to ${allowed.map((a) => `"${a}"`).join(" or ")} - not "${target}".`);
  }

  const when = opts.date ? new Date(opts.date) : new Date();

  switch (target) {
    case "Documents Completed": {
      // The whole point of the document stage. Nominating someone whose papers are incomplete is
      // what gets the profile bounced back by NSDC, which is the delay this pipeline exists to stop.
      const d = await trainerDocSummary(trainerId);
      if (!d.complete) {
        throw new HttpError(409, `Rule T2: ${t.name} is still missing ${d.missing.join(", ")}. Collect every mandatory document before preparing the nomination.`);
      }
      if (!t.nominated_for_location || !t.nominated_for_program) {
        throw new HttpError(409, "Rule T3: say which centre and job role this nomination is for - a nomination is always against a specific vacancy.");
      }
      t.nomination_sent_on = when;
      break;
    }
    case "Sent to NSDC":
      t.nsdc_submitted_on = when;
      break;
    case "NSDC Approved":
      t.nsdc_result_on = when;
      t.nsdc_remarks = undefined;
      break;
    case "NSDC Rejected":
      // Without the remarks nobody downstream knows what to correct before resubmitting.
      if (!opts.remarks) throw new HttpError(400, "Rule T4: record what NSDC said was wrong, so it can be corrected and resent.");
      t.nsdc_result_on = when;
      t.nsdc_remarks = opts.remarks;
      break;
    case "TOT Payment Done": {
      t.paid_on = when;
      if (opts.payload?.payment_reference) t.payment_reference = String(opts.payload.payment_reference);
      // "har stage pe cost capture karni hai" — the ₹3250 eligibility fee is a real per-trainer
      // spend, and recording it only on the trainer kept it out of the cost model entirely. One
      // CostEntry per trainer, booked by whoever moved the stage; guarded against doubles so a
      // re-entry into this stage (Dropped → re-opened → paid) doesn't book the fee twice.
      if (opts.actor) {
        const cat = await CostCategory.findOneAndUpdate(
          { name: "Trainer eligibility fee" },
          { $setOnInsert: { name: "Trainer eligibility fee", active: true } },
          { upsert: true, new: true },
        );
        const already = await CostEntry.findOne({ trainer: t._id, category: cat._id }).lean();
        if (!already) {
          await CostEntry.create({
            entry_date: when,
            trainer: t._id,
            location: t.nominated_for_location || undefined,
            category: cat._id,
            amount: t.eligibility_payment_amount ?? 3250,
            note: `NSDC eligibility payment for ${t.name}${t.payment_reference ? ` (ref ${t.payment_reference})` : ""}`,
            entered_by: opts.actor,
          });
        }
      }
      break;
    }
    case "TOT Scheduled":
      t.tot_scheduled_on = when;
      break;
    case "Certified": {
      // "TOT certified result aa jata hai... phir SIDH portal mein batch formation karte waqt vo
      // trainer ki profile mangta hai" - the TR ID is the whole reason this pipeline exists.
      const trId = (opts.payload?.tr_id as string) ?? t.tr_id;
      if (!trId) throw new HttpError(400, "Rule T5: a certified trainer needs their NSDC TR ID - it is what the portal asks for when a batch is formed.");
      t.tr_id = trId;
      t.tot_done_on = when;
      if (opts.payload?.tot_certificate_no) t.tot_certificate_no = String(opts.payload.tot_certificate_no);
      if (!t.available_from) t.available_from = when;
      break;
    }
    case "Dropped": {
      if (!opts.reason) throw new HttpError(400, "Rule T6: dropping a trainer needs a reason.");
      // CEO 13/08: "har stage pe Accepted/Rejected dikhna chahiye" — record WHERE the
      // journey ended, so the profile can say "Dropped at Shortlisted" instead of a bare tag.
      t.dropped_from_stage = from;
      // Rule T7: dropping someone who is still running a batch stranded it silently — the batch
      // kept pointing at a trainer who had left, the readiness screen still counted them, and
      // nobody found out until the day the class did not start. Name the batches and make the
      // reassignment happen first; this is the same trap the certificate rejection used to set.
      const booked = await Batch.find({ trainer: trainerId, status: { $in: ACTIVE_BATCH_STATUSES } })
        .select("code status").lean<any[]>();
      if (booked.length) {
        throw new HttpError(409,
          `Rule T7: ${t.name} is still assigned to ${booked.map((b) => `${b.code} (${b.status})`).join(", ")}. ` +
          `Reassign ${booked.length === 1 ? "that batch" : "those batches"} to another trainer before dropping them.`);
      }
      t.dropped_reason = opts.reason;
      t.active = false;
      break;
    }
    case "Fresh Lead":
      // Re-opening someone previously dropped.
      t.dropped_reason = undefined;
      t.active = true;
      break;
  }

  t.pipeline_status = target as any;
  if (opts.reason && target !== "Dropped") t.pipeline_note = opts.reason;
  await t.save();
  return t;
}

// ---------- Attendance-in-hours (R-D, CEO 14/08 [33:35, 42:15]) ----------
// "Without number of hours we don't know if the student has qualified for the next stage."
// One computation, shared by the public per-student portal and the batch Attendance tab —
// two copies of a threshold formula is how two screens end up disagreeing about the same
// student (the QA-045 lesson, money edition).
export function requiredAssessmentHours(program: any, minPct: number): number {
  // Real QP hours when recorded; duration_days × 8 (the full-day session) until then.
  const programHours = program?.hours || (program?.duration_days ?? 15) * 8;
  return Math.ceil((programHours * minPct) / 100);
}
export function slotHoursPerDay(batch: any): number {
  const toMin = (s?: string | null) => {
    const mm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? ""));
    return mm ? Number(mm[1]) * 60 + Number(mm[2]) : null;
  };
  const slotMin = (toMin(batch?.slot_end) ?? 0) - (toMin(batch?.slot_start) ?? 0);
  return slotMin > 0 ? slotMin / 60 : 8;
}

// Rule T7 - the counters the client tracks per centre x job role, DERIVED rather than stored.
// The two sheets already disagree with each other (nominated 23 vs 20, certified 18 vs 16),
// which is what happens when the same number is kept in two places; computing it here makes the
// ERP the source of truth and leaves each sheet as a cross-check.
// Exported since 2026-08-13: the locations LIST derives the same live per-centre×job-role
// counts (Umesh: "jaise-jaise trainer approve honge, count update ho jana chahiye").
export const NOMINATED_STATES = ["Documents Completed", "Sent to NSDC", "NSDC Approved", "NSDC Rejected",
  "TOT Payment Done", "TOT Scheduled", "TOT In Progress", "Certified"];

export async function trainerCountsFor(locationId: unknown, programId: unknown) {
  const base = { nominated_for_location: locationId, nominated_for_program: programId, active: true };
  const [nominated, certified, inPipeline] = await Promise.all([
    Trainer.countDocuments({ ...base, pipeline_status: { $in: NOMINATED_STATES } }),
    Trainer.countDocuments({ ...base, pipeline_status: "Certified" }),
    Trainer.countDocuments({ ...base, pipeline_status: { $nin: ["Certified", "Dropped"] } }),
  ]);
  return { nominated, certified, in_pipeline: inPipeline };
}

// Rule T8 - can this centre x job role actually start a batch? The three-way mapping Manish
// described: "ye teen cheezein hain - location, trainer, aur candidate. Ye teeno map ho gaye to
// batch form ho jata hai." Returns the ONE thing that is blocking, so the screen can say what to
// do next rather than showing a wall of red.
// The one definition of "what is stopping this centre x job role", shared by the single-row
// lookup below and the bulk listing. Two copies of this would drift, and a readiness screen that
// disagrees with itself is worse than none.
function readinessBlockers(
  loc: { tc_id?: string; tc_status?: string; approval_status?: string; operational_status?: string },
  counts: { certified: number; in_pipeline: number },
  registered: number,
  needed: number,
  infra?: { rooms: number; labs: number; requires_lab?: boolean },
): string[] {
  const blockers: string[] = [];
  // A centre with no approved TC cannot enrol anyone on the portal at all, whatever else is ready.
  if (!loc.tc_id) blockers.push("no TC ID on record");
  else if (loc.tc_status && loc.tc_status !== "Approved") blockers.push(`TC status is "${loc.tc_status}"`);
  if (loc.approval_status !== "Approved") blockers.push("centre not approved");
  if (["On Hold", "Stopped", "Closed"].includes(String(loc.operational_status))) blockers.push(`centre is ${loc.operational_status}`);
  if (counts.certified < 1) {
    blockers.push(counts.in_pipeline > 0
      ? `no certified trainer yet (${counts.in_pipeline} in the pipeline)`
      : "no trainer nominated for this job role");
  }
  // 2026-08-08: "teen trainer to rakh diye, classroom do hi hai, lab ek hi hai — can that be
  // managed or not?" The hard floor of that question: a centre with no usable room cannot run
  // any batch, and a lab job role with no lab cannot run either. Finer classroom-vs-parallel-
  // batch arithmetic stays in planning; readiness names only what makes a start impossible.
  if (infra) {
    if (infra.rooms < 1) blockers.push("no room at the centre");
    else if (infra.requires_lab && infra.labs < 1) blockers.push("no lab, and this job role needs one");
  }
  if (registered < needed) blockers.push(`${registered} of ${needed} candidates registered on SIDH`);
  return blockers;
}

// Bulk readiness for a whole estate. The first version looped mappingReadiness once per target and
// awaited each in turn — about five queries per row, run sequentially, which measured 10.3s for 81
// rows on a laptop. Home calls this on every load for every user, so that was a real outage in
// waiting. This does the same work in three aggregations regardless of how many targets exist.
export async function mappingReadinessBulk(targetFilter: Record<string, unknown>, limit = 2000) {
  const targets = await LocationTarget.find(targetFilter)
    .populate("location", "name code tc_id tc_status approval_status operational_status")
    .populate("program", "name code scheme default_batch_size requires_lab")
    .limit(limit).lean<any[]>();
  if (!targets.length) return [];

  const key = (l: unknown, p: unknown) => `${String(l)}|${String(p)}`;
  const locIds = [...new Set(targets.map((t) => t.location?._id).filter(Boolean))];
  const progIds = [...new Set(targets.map((t) => t.program?._id).filter(Boolean))];

  const [trainerRows, candRows, roomRows] = await Promise.all([
    Trainer.aggregate([
      { $match: { nominated_for_location: { $in: locIds }, nominated_for_program: { $in: progIds }, active: true } },
      { $group: {
        _id: { l: "$nominated_for_location", p: "$nominated_for_program" },
        nominated: { $sum: { $cond: [{ $in: ["$pipeline_status", NOMINATED_STATES] }, 1, 0] } },
        certified: { $sum: { $cond: [{ $eq: ["$pipeline_status", "Certified"] }, 1, 0] } },
        in_pipeline: { $sum: { $cond: [{ $in: ["$pipeline_status", ["Certified", "Dropped"]] }, 0, 1] } },
      } },
    ]),
    Candidate.aggregate([
      { $match: { location: { $in: locIds }, program: { $in: progIds }, lifecycle_status: "Unassigned" } },
      { $group: {
        _id: { l: "$location", p: "$program" },
        pool: { $sum: 1 },
        registered: { $sum: { $cond: [{ $eq: ["$sidh_status", "Registered"] }, 1, 0] } },
      } },
    ]),
    Room.aggregate([
      { $match: { location: { $in: locIds }, active: { $ne: false } } },
      { $group: {
        _id: "$location",
        rooms: { $sum: 1 },
        labs: { $sum: { $cond: [{ $eq: ["$type", "Lab"] }, 1, 0] } },
      } },
    ]),
  ]);

  const byTrainer = new Map(trainerRows.map((r) => [key(r._id.l, r._id.p), r]));
  const byCand = new Map(candRows.map((r) => [key(r._id.l, r._id.p), r]));
  const byRoom = new Map(roomRows.map((r) => [String(r._id), r]));

  return targets.filter((t) => t.location && t.program).map((t) => {
    const k = key(t.location._id, t.program._id);
    const tc = byTrainer.get(k) ?? { nominated: 0, certified: 0, in_pipeline: 0 };
    const cc = byCand.get(k) ?? { pool: 0, registered: 0 };
    const needed = t.program.default_batch_size ?? 30;
    const counts = { nominated: tc.nominated, certified: tc.certified, in_pipeline: tc.in_pipeline };
    const rc = byRoom.get(String(t.location._id)) ?? { rooms: 0, labs: 0 };
    // 2026-08-13 (Manish: "31 approved"): the government approves each centre×job-role ROW with
    // its own TC ID — a per-target TC wins over the centre-level one when the target carries it.
    const tcView = {
      ...t.location,
      tc_id: t.tc_id ?? t.location.tc_id,
      tc_status: t.tc_status ?? t.location.tc_status,
    };
    const blockers = readinessBlockers(tcView, counts, cc.registered, needed,
      { rooms: rc.rooms, labs: rc.labs, requires_lab: !!t.program.requires_lab });
    return {
      location: {
        _id: t.location._id, name: t.location.name, code: t.location.code,
        tc_id: tcView.tc_id ?? null, tc_status: tcView.tc_status ?? null,
        // F-A9: from-shortfall filters on these — the blockers strings alone are not a contract.
        approval_status: t.location.approval_status ?? null, operational_status: t.location.operational_status ?? null,
      },
      program: { _id: t.program._id, name: t.program.name, code: t.program.code, scheme: t.program.scheme ?? null },
      approved_target: t.approved_target ?? null,
      trainers: { required: t.trainers_required ?? null, ...counts },
      candidates: { pool: cc.pool, registered: cc.registered, needed },
      ready: blockers.length === 0,
      blockers,
      next_action: blockers[0] ?? "Ready to form a batch",
    };
  });
}

export async function mappingReadiness(locationId: string, programId: string) {
  const [loc, prog, target] = await Promise.all([
    Location.findById(locationId).select("name code tc_id tc_status approval_status operational_status").lean<any>(),
    Program.findById(programId).select("name code scheme default_batch_size requires_lab").lean<any>(),
    LocationTarget.findOne({ location: locationId, program: programId }).lean<any>(),
  ]);
  if (!loc || !prog) throw new HttpError(404, "Location or programme not found");

  const counts = await trainerCountsFor(locationId, programId);
  const registered = await Candidate.countDocuments({
    location: locationId, program: programId, sidh_status: "Registered", lifecycle_status: "Unassigned",
  });
  const pool = await Candidate.countDocuments({ location: locationId, program: programId, lifecycle_status: "Unassigned" });

  const rooms = await Room.find({ location: locationId, active: { $ne: false } }).select("type").lean<any[]>();
  const needed = prog.default_batch_size ?? 30;
  // Per-target TC (own id + approval per job role) wins over the centre-level fallback.
  const tcView = { ...loc, tc_id: target?.tc_id ?? loc.tc_id, tc_status: target?.tc_status ?? loc.tc_status };
  const blockers = readinessBlockers(tcView, counts, registered, needed, {
    rooms: rooms.length,
    labs: rooms.filter((r) => r.type === "Lab").length,
    requires_lab: !!prog.requires_lab,
  });

  return {
    location: { _id: loc._id, name: loc.name, code: loc.code, tc_id: tcView.tc_id ?? null, tc_status: tcView.tc_status ?? null },
    program: { _id: prog._id, name: prog.name, code: prog.code, scheme: prog.scheme ?? null },
    approved_target: target?.approved_target ?? null,
    trainers: { required: target?.trainers_required ?? null, ...counts },
    candidates: { pool, registered, needed },
    ready: blockers.length === 0,
    blockers,
    next_action: blockers[0] ?? "Ready to form a batch",
  };
}
