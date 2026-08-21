// Business rules engine — implements the numbered rules from
// center-erp-data-model-rules.md §4. Rule numbers are cited inline.
import { Types } from "mongoose";
import {
  Batch, BatchMember, Candidate, CandidateResult, Closure, CostCategory, CostEntry, DailyLog, GovtAttendanceRow, Invoice, Location,
  LocationTarget, Notification, Program, Room, Scheme, TRAINER_PIPELINE, Trainer, TrainerDocument,
} from "@/models";
import { audit, auditDiff } from "@/lib/audit";
import { currentStageOf } from "@/lib/candidate-journey";
import { getDefaults } from "@/lib/defaults";
import { normalizeCan } from "@/lib/govt-attendance";
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

// QA-149 (Manish, 15/08): "Add Trainer se trainer banaya, certified kiya, batch assign kiya —
// login karun to batch dikhta hi nahi." Trainer.user was declared in 2026-08-11 but NOTHING
// ever set it — Add Trainer makes no login, Add User links to no trainer — so is_mine was
// false for every trainer alive and the batch list opened on an empty "My batches". This
// resolver is the ONE place a login becomes a trainer: the explicit link first, then the
// same email (self-healed onto the record so the next read is direct). Never by name.
export async function trainerForLogin(user: { id: string; email?: string | null; role?: string }): Promise<{ _id: unknown } | null> {
  if (user.role !== "Trainer") return null;
  const byLink = await Trainer.findOne({ user: user.id }).select("_id").lean<any>();
  if (byLink) return byLink;
  const email = String(user.email ?? "").trim().toLowerCase();
  if (!email) return null;
  const byEmail = await Trainer.findOne({ email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"), $or: [{ user: null }, { user: { $exists: false } }] }).select("_id").lean<any>();
  if (byEmail) {
    await Trainer.updateOne({ _id: byEmail._id }, { $set: { user: user.id } });
    return byEmail;
  }
  return null;
}

// Rule 38 on by-ID access: scoped users may only touch batches at their locations.
// QA-149: a Trainer login always reaches the batches ASSIGNED to it, even when the login's
// location_scope missed that centre — assignment is the stronger claim.
export async function assertBatchInScope(user: SessionUser, batchId: string) {
  if (!isScoped(user)) return;
  const b = await Batch.findById(batchId).select("location trainer").lean<any>();
  if (!b) throw new HttpError(404, "Batch not found");
  if (user.location_scope.map(String).includes(String(b.location))) return;
  if (user.role === "Trainer" && b.trainer) {
    const me = await trainerForLogin(user);
    if (me && String(me._id) === String(b.trainer)) return;
  }
  throw new HttpError(403, "Batch out of scope");
}

// Same, resolved via a BatchMember id.
export async function assertMemberInScope(user: SessionUser, memberId: string) {
  if (!isScoped(user)) return;
  const m = await BatchMember.findById(memberId).select("batch").lean<any>();
  if (!m) throw new HttpError(404, "Batch member not found");
  await assertBatchInScope(user, String(m.batch));
}

// QA-125 (checker, 15/08): Rule 38 on by-ID TRAINER access. The trainers LIST hides
// out-of-scope people (nomination/capability/home union — trainers/route.ts scopeFilter),
// but every item-level route only asked "may you manage trainers", never "may you manage
// THIS trainer" — a Gurugram SPOC documented, un-documented and edited a trainer they
// could not even see. Seventh occurrence of the list-hides/item-allows pattern and the
// first on writes, so the check is a shared helper, not another spot fix.
// A trainer tied to NO centre is out of scope for every scoped user (fail closed) — the
// same person the list already refuses to show them.
export function trainerScopeTies(t: { nominated_for_location?: unknown; home_location?: unknown; capable_locations?: unknown[] }): string[] {
  return [t.nominated_for_location, t.home_location, ...((t.capable_locations as unknown[]) ?? [])]
    .filter(Boolean)
    .map((v) => String((v as { _id?: unknown })?._id ?? v));
}
export function assertTrainerDocInScope(user: SessionUser, t: { nominated_for_location?: unknown; home_location?: unknown; capable_locations?: unknown[] } | null) {
  if (!isScoped(user)) return;
  if (!t) throw new HttpError(404, "Trainer not found");
  const allowed = user.location_scope.map(String);
  if (!trainerScopeTies(t).some((id) => allowed.includes(id))) {
    throw new HttpError(403, "Trainer out of scope — this person is not tied to your centre.");
  }
}
export async function assertTrainerInScope(user: SessionUser, trainerId: string) {
  if (!isScoped(user)) return;
  const t = await Trainer.findById(trainerId).select("nominated_for_location home_location capable_locations").lean<any>();
  assertTrainerDocInScope(user, t);
}
// QA-125 follow-up (checker design note, 15/08): capable_locations is a TEACHING tie — a
// trainer capable at ten centres would hand all ten SPOCs delete rights over their
// Aadhaar/PAN. Document DELETION follows ownership instead: the nominating centre or the
// home centre. Only a trainer with neither (the quick-invite window, capable-only) falls
// back to the full union — otherwise a mis-upload in that window needs an Admin, which is
// the QA-112 pain this delete exists to end. Reads and uploads keep the wide union.
export async function assertTrainerDocDeleteInScope(user: SessionUser, trainerId: string) {
  if (!isScoped(user)) return;
  const t = await Trainer.findById(trainerId).select("nominated_for_location home_location capable_locations").lean<any>();
  if (!t) throw new HttpError(404, "Trainer not found");
  const owners = [t.nominated_for_location, t.home_location]
    .filter(Boolean)
    .map((v) => String((v as { _id?: unknown })?._id ?? v));
  if (!owners.length) return assertTrainerDocInScope(user, t);
  const allowed = user.location_scope.map(String);
  if (!owners.some((id) => allowed.includes(id))) {
    throw new HttpError(403, "Only the nominating or home centre may delete this trainer's documents.");
  }
}

// QA-093/119 (15/08): the assessment threshold stops being "a guess wearing a number"
// the moment the scheme master carries real hours — min/total from the SCHEME row wins,
// the Defaults percentage stays the honest fallback until Manish's data lands.
export async function minAttendancePctForScheme(scheme: string | undefined, fallbackPct: number): Promise<{ pct: number; source: "scheme" | "defaults" }> {
  if (scheme) {
    const s = await Scheme.findOne({ name: scheme, active: true }).select("total_hours min_required_hours").lean<any>();
    if (s && Number.isFinite(s.total_hours) && Number.isFinite(s.min_required_hours)
      && s.total_hours > 0 && s.min_required_hours > 0 && s.min_required_hours <= s.total_hours) {
      return { pct: Math.round((s.min_required_hours / s.total_hours) * 100), source: "scheme" };
    }
  }
  return { pct: fallbackPct, source: "defaults" };
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
// QA-097/QA-098 (checker, 14/08): the candidate importer parsed dates with new Date(),
// which cannot read the DD-MM-YYYY its own template asks for (Invalid → silently dropped)
// and reads "05-06-2001" as May 5th; and an .xlsx sheet hands dates over as Excel SERIAL
// numbers. ONE parser for every importer: day-first always wins on ambiguity (the
// template's stated format), serials are days since 1899-12-30, and anything unreadable
// returns null so the caller can REPORT it by row — never guess, never drop silently.
export function parseSheetDate(raw: unknown): Date | null {
  if (raw == null || raw === "") return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : dayKey(raw);
  const build = (y: number, mo: number, d: number): Date | null => {
    if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? dt : null;
  };
  if (typeof raw === "number" || /^\d{4,6}(\.\d+)?$/.test(String(raw).trim())) {
    const n = Number(raw);
    // Excel serial: days since 1899-12-30. 20k..60k ≈ years 1954..2064.
    if (Number.isFinite(n) && n > 20000 && n < 60000) {
      return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86_400_000);
    }
  }
  const s = String(raw).trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T\s].*)?$/.exec(s); // ISO year-first
  if (m) return build(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s); // DD-MM-YYYY (template format)
  if (m) {
    const yy = +m[3];
    return build(m[3].length <= 2 ? (yy <= 29 ? 2000 + yy : 1900 + yy) : yy, +m[2], +m[1]);
  }
  return null;
}

// QA-081 (checker, 14/08): Rule 53 fixed "today" in one place and left three other
// definitions behind it. ONE definition now: the IST calendar date, in dayKey (UTC-
// midnight) encoding — at 1am IST the server's UTC date is still yesterday, the same
// class as the QA-056 DOB lockout.
export function istToday(): Date {
  return dayKey(new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10));
}

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

// QA-138: the slot guideline rule moved to slot-rules.ts (client-safe) so the batch form can
// run the SAME check while the operator types. One rule, two callers — no drifting copy.
import { slotGuidelineErrors, slotHoursPerDay } from "@/lib/slot-rules";
export { slotGuidelineErrors };

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
    const dflt = await getDefaults();
    const maxPerDay = dflt.max_batches_per_day ?? 2;
    const sameDaySlotted = overlapping.filter((b) => b.slot_start && b.slot_end);
    if (sameDaySlotted.length + 1 > maxPerDay) {
      throw new HttpError(409,
        `Scheme guideline: at most ${maxPerDay} sessions a day. Trainer ${trainer.name} already runs ${sameDaySlotted.length} slotted batch(es) over these dates (${sameDaySlotted.map((b) => `${b.code} ${b.slot_start}–${b.slot_end}`).join(", ")}).`);
    }
    // QA-144: the CEO's 8-hour rule. The session cap above bounds HOW MANY sessions; this
    // bounds their TOTAL hours, because two 4-hour sessions pass the count while 4+8 must
    // not. Slot-less batches carry no computable hours and stay outside, exactly as they
    // do for the time-clash check.
    const maxDailyHours = dflt.max_daily_hours ?? 8;
    const hours = [slot, ...sameDaySlotted].reduce((sum, b) => sum + (slotHoursPerDay(b) ?? 0), 0);
    if (hours > maxDailyHours) {
      throw new HttpError(409,
        `Trainer ${trainer.name} would teach ${hours}h on overlapping days (${sameDaySlotted.map((b) => `${b.code} ${b.slot_start}–${b.slot_end}`).join(", ")} + this batch ${slot.slot_start}–${slot.slot_end}); max daily hours = ${maxDailyHours}.`);
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
      `Trainer ${trainer.name} already assigned to batch ${c.code} at ${c.location?.name ?? "?"} (${new Date(batchRange(c)[0]).toDateString()} – ${new Date(batchRange(c)[1]).toDateString()}); max concurrent = ${cap}.`);
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
  // QA-081: the future check compares CALENDAR dates on the IST footing (dayKey space);
  // storage below stays in the historical dayStart encoding untouched.
  if (dayKey(left_on).getTime() > istToday().getTime()) throw new HttpError(400, "Rule 25: left_on cannot be a future date.");
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
  // Rule 21 + QA-021 (-68): the drop is a recorded FACT on the candidate too — reason, date
  // and the journey stage it happened at (derived server-side, same function the page uses).
  {
    const cand = await Candidate.findById(m.candidate).select("lifecycle_status enrolled_at sidh_status").lean<any>();
    const batchDoc = await Batch.findById(m.batch).select("status").lean<any>();
    const stage = cand ? currentStageOf({
      lifecycle_status: cand.lifecycle_status, enrolled_at: cand.enrolled_at, sidh_status: cand.sidh_status,
      latest_result: null, active_batch_status: batchDoc?.status ?? null,
    }) : undefined;
    await Candidate.findByIdAndUpdate(m.candidate, {
      lifecycle_status: "Dropped",
      dropped_reason: drop_reason, dropped_at: lo, ...(stage ? { dropped_from_stage: stage } : {}),
    });
  }
  // Rule 42: an existing result is NOT deleted when someone drops — they still appeared.
  // Recompute so the aggregates reflect the new roster.
  await recomputeClosureAggregates(String(m.batch));
  return m;
}

// ---------- Batch lifecycle (Rules 14–19) ----------
// QA-148 (checker) / Manish point 4: what each FAILED readiness check means in words. Keys mirror batchReadiness().checks.
export const READINESS_FAILURE_TEXT: Record<string, string> = {
  location_approved: "centre not approved / not operational",
  room_assigned: "room not assigned",
  trainer_ready: "trainer not ready",
  tot_lead_ok: "TOT not done 3 days before start", // plan_flags only since -81 (QA-150/152)
  roster_80pct: "roster below threshold",
};

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

  // F-A3 (Manish, 2026-08-14) asked for "TOT done at least three days before batch start" as
  // a HARD gate on Mark Ready. QA-150/QA-152 (Umesh, 15/08, on his own Gurugram batch): the
  // gate is a PLANNING verdict — it counts back from a FUTURE start — and on a batch entered
  // after it began (planned_start 30-07, trainer bypass-certified 15-08, milestones ticked
  // 15-08) it fails a deadline that can never be met, while the checklist hid it and read
  // "5/5". His word: such warnings live ONLY inside the batch's plan, never on every batch
  // as a gate. So: still computed, returned as plan_flags for the plan section, NOT a check.
  const totLeadDays = defaults.lead_tot_done_days ?? 3;
  const totDue = dayStart(addDays(batch.planned_start, -totLeadDays));
  const totLeadOk = !trainer?.tot_done_on || dayStart(trainer.tot_done_on) <= totDue;

  // Rule 16: the FOUR operational checks that gate Planning → Ready. Exactly these are
  // rendered on the Overview checklist (QA-150: the UI must show what gates, nothing else).
  const checks = {
    location_approved: location?.approval_status === "Approved"
      && !HALTED_LOCATION_STATUSES.includes(location?.operational_status), // Rule 1
    room_assigned: roomOk,
    trainer_ready: trainerAvailable,
    roster_80pct: roster.length >= Math.ceil((defaults.roster_threshold_pct / 100) * batch.target_size),
  };
  return {
    checks,
    ready: Object.values(checks).every(Boolean),
    // QA-152: plan-only verdicts — meaningful when the batch HAS a plan (plan_enabled).
    plan_flags: {
      tot_lead_ok: totLeadOk,
      tot_done_on: trainer?.tot_done_on ?? null,
      tot_due: trainer?.tot_done_on ? totDue : null,
      tot_lead_days: totLeadDays,
    },
    roster_count: roster.length,
    enrolled_count: enrolled,
    enrollment_threshold: enrollmentThreshold,
    enrollment_ok: roster.length > 0 && enrolled >= enrollmentThreshold, // plan1.md resolution #1
    location_halted: HALTED_LOCATION_STATUSES.includes(location?.operational_status),
    batch,
  };
}

// -88 (Umesh 15/08 23:20, on DST-02 with 36 portal rows imported and "Mark Ready" still on
// screen): "jis batch me attendance upload ho gayi hai usme Start batch jaise buttons aa rahe
// hain — ye to apne aap hona chahiye." Attendance IS proof the batch runs; asking a person to
// click Mark Ready / Start afterwards is backwards. When attendance evidence exists (a matched
// portal import or a daily log) for a batch still in Planning/Ready, the batch becomes Active
// on its own: actual_start = the planned start (or today if the plan is in the future — the
// evidence wins), the roster counted from that day (same restamp as a dated Start), the
// readiness gates skipped ON RECORD (audit row says "auto-activated from attendance"). It
// never moves past Active by itself — Closing/Completed still need assessment/certification.
export async function activateFromEvidence(batchId: string, opts: { actor?: string | null; source: string }): Promise<{ activated: boolean; reason?: string }> {
  const batch = await Batch.findById(batchId);
  if (!batch) return { activated: false, reason: "batch not found" };
  if (!["Planning", "Ready"].includes(batch.status)) return { activated: false, reason: `already ${batch.status}` };
  const [logs, portal] = await Promise.all([
    DailyLog.countDocuments({ batch: batchId }),
    GovtAttendanceRow.countDocuments({ batch: batchId, match_status: "Matched" }),
  ]);
  if (!logs && !portal) return { activated: false, reason: "no attendance evidence" };
  const today = istToday();
  const planned = dayKey(batch.planned_start);
  // QA-160 refinement (checker): when our own day-wise logs exist, the earliest logged day is
  // the truest start we have; the planned start otherwise; never a future day.
  const firstLog = logs ? await DailyLog.findOne({ batch: batchId }).sort({ log_date: 1 }).select("log_date").lean<any>() : null;
  const candidates = [planned, ...(firstLog?.log_date ? [dayKey(firstLog.log_date)] : [])].filter((d) => d.getTime() <= today.getTime());
  const start = candidates.length ? new Date(Math.min(...candidates.map((d) => d.getTime()))) : today;
  const from = batch.status;
  batch.actual_start = start;
  batch.status = "Active" as any;
  await batch.save();
  const restamped = await BatchMember.updateMany({ batch: batchId, joined_on: { $gt: start } }, { $set: { joined_on: start } });
  await audit({
    entity: "Batch", entityId: batch._id, field: "status", oldValue: from, newValue: "Active",
    actor: opts.actor ?? null, actorType: opts.actor ? "USER" : "SYSTEM",
  });
  await audit({
    entity: "Batch", entityId: batch._id, field: "auto_activated",
    newValue: `auto-activated from attendance evidence (${opts.source}: ${portal ? `${portal} portal rows` : ""}${portal && logs ? ", " : ""}${logs ? `${logs} daily logs` : ""}); actual_start ${start.toISOString().slice(0, 10)}${restamped.modifiedCount ? `; roster counted from that day (${restamped.modifiedCount} members)` : ""}; readiness gates skipped — the evidence is the proof`,
    actor: opts.actor ?? null, actorType: opts.actor ? "USER" : "SYSTEM",
  });
  if (batch.trainer) await deriveTrainerStatus(String(batch.trainer)); // Rule 12
  return { activated: true };
}

export async function transitionBatch(batchId: string, target: string, opts: { isAdmin?: boolean; reason?: string; actual_start?: string | Date | null; actor?: string } = {}) {
  const batch = await Batch.findById(batchId);
  if (!batch) throw new HttpError(404, "Batch not found");
  const from = batch.status;
  // -112 (QA-219): completion can now DERIVE from the rows (deriveCompletion), so a hand press of
  // "Mark Completed" may arrive after the batch already got there. Same status = already done,
  // not a refusal.
  if (from === target && ["Closing", "Completed"].includes(target)) return batch;

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
      // QA-101 (-69): the SERVER's day said "before planned_start" at 1am IST — IST calendar
      // dates decide, in dayKey space (QA-081 pattern).
      if (istToday() < dayKey(batch.planned_start)) fail("Rule 17: cannot start before planned_start.");
      await assertLocationOperational(batch.location, "Starting a batch"); // Rule 1
      const r = await batchReadiness(batchId);
      if (!r.enrollment_ok) fail(`Enrollment threshold not met: ${r.enrolled_count}/${r.enrollment_threshold} required (${(await getDefaults()).enrollment_threshold_pct}% of roster).`);
      // -81 (Umesh, 15/08 — Gurugram DST-02 began 30-07, entered on 15-08): Start may carry
      // the REAL start date. Before this, actual_start was always "now" and unwritable
      // afterwards, so an after-the-fact batch got a wrong date forever and Rule 32 refused
      // every real day. Rules: not in the future; default today (unchanged behaviour).
      if (opts.actual_start) {
        const requested = dayKey(opts.actual_start);
        if (isNaN(requested.getTime())) throw new HttpError(400, "actual_start is not a valid date.");
        if (requested > istToday()) throw new HttpError(400, "A batch cannot start in the future — actual start must be today or earlier.");
        batch.actual_start = requested;
        // The roster is counted from the day the batch really began: members added while
        // catching up carry joined_on = the day of entry, which Rule 29 (rosterOnDate) would
        // read as "not on the roster" for every real day. Restamp only those later than the
        // start; audited once with the count.
        const restamped = await BatchMember.updateMany({ batch: batchId, joined_on: { $gt: requested } }, { $set: { joined_on: requested } });
        if (restamped.modifiedCount) {
          await audit({ entity: "Batch", entityId: batch._id, field: "roster_backdated", newValue: `roster counted from ${requested.toISOString().slice(0, 10)} (${restamped.modifiedCount} members)`, actor: opts.actor });
        }
      } else {
        batch.actual_start = new Date();
      }
      break;
    }
    case "Active->Closing": {
      const closure = await Closure.findOne({ batch: batchId }).lean<any>();
      if (closure?.assessment_status !== "Completed") fail("Rule 18: assessment must be Completed before Closing.");
      break;
    }
    // -113 (Umesh, 18/08): the Admin gets a working "Mark Completed" button, so the Admin also gets
    // the way BACK. DEC-6 froze a Completed batch with no override at all, which was right while
    // completion was a deliberate end-of-life act — but a button that settles outstanding rows and
    // completes in one press needs an undo, or one mis-click is permanent. Admin only, reason
    // required, fully audited; the money side (invoice, dues) is untouched by the reopen, and a
    // CLOSED batch stays final because that is a settlement, not a training record.
    case "Completed->Closing": {
      if (!opts.isAdmin) fail("Only an Admin can reopen a completed batch.");
      if (!opts.reason) fail("Reopening a completed batch needs a reason — it is audited.");
      // Completing stamped an end date on the batch; reopening takes it off again, or Rule 32 goes on
      // refusing attendance for every day after an end that no longer applies.
      batch.set("actual_end", undefined);
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
  if (D > istToday()) throw new HttpError(400, "Cannot log a future date."); // QA-081: IST, not the server's UTC day

  const roster = await rosterOnDate(batchId, D); // Rule 26
  const rosterIds = new Set(roster.map((m) => String(m._id)));
  for (const id of payload.present_member_ids) {
    if (!rosterIds.has(String(id))) {
      // Name who and when — the operator cannot act on "a present member" (audit F-007).
      const m = await BatchMember.findById(id).populate("candidate", "name").lean<any>();
      const who = m?.candidate?.name ?? "That candidate";
      const when = D.toLocaleDateString("en-IN");
      throw new HttpError(400, m?.left_on
        ? `${who} left this batch on ${new Date(m.left_on).toLocaleDateString("en-IN")}, so they were not on the roster on ${when}. Untick them to save.`
        : `${who} was not on this batch's roster on ${when}.`);
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


// -82 (Umesh, 15/08: "Attendance tab se bhi us batch ki attendance fill ho, that too bulk").
// The ONE path that turns a request into a DailyLog — the single-day POST and the bulk
// grid both call this, so every rule holds per day whichever door was used:
// Rule 53 (no future day; a Trainer only today/yesterday), Rule 27 (one log per day),
// then validateDailyLog (status, Rule 32 window, Rule 29 roster-on-date, Rule 51, Rule 30).
export async function createDailyLogChecked(
  user: { id: string; role?: string },
  batchId: string,
  body: any,
) {
  // QA-082: the portal figures never come from a trainer's request.
  if (user.role === "Trainer") { delete body.govt_present; delete body.govt_source; delete body.govt_screenshot; }
  if (!body.log_date) throw new HttpError(400, "log_date is required");
  const D = dayKey(body.log_date); // F-008: the calendar date itself
  const todayD = istToday(); // QA-081: the one shared definition of "today"
  if (D.getTime() > todayD.getTime()) throw new HttpError(400, "Rule 53: attendance cannot be taken for a future date.");
  if (user.role === "Trainer" && (todayD.getTime() - D.getTime()) > 86_400_000) {
    throw new HttpError(403, "Rule 53: trainers may log only today or yesterday. Ask Operations/Admin to enter an older day.");
  }
  const clash = await DailyLog.findOne({ batch: batchId, log_date: dayRange(D) }).select("_id").lean();
  if (clash) throw new HttpError(409, "Rule 27: a log already exists for this batch on that date.");
  const { roster_count, internal_present } = await validateDailyLog(batchId, D, {
    present_member_ids: body.present_member_ids ?? [],
    govt_present: body.govt_present ?? null,
    trainer_present: body.trainer_present,
    biometric_member_ids: body.biometric_member_ids ?? [], // Rule 51
  });
  const doc = await DailyLog.create({
    batch: batchId, log_date: D,
    planned_topic: body.planned_topic, actual_topic: body.actual_topic,
    present_member_ids: body.present_member_ids ?? [],
    biometric_member_ids: body.biometric_member_ids ?? [],
    // Karunn 2026-08-13: every marking is a timestamped ROUND; the day starts with round 1.
    sessions: [{ at: new Date(), present_member_ids: body.present_member_ids ?? [], biometric_member_ids: body.biometric_member_ids ?? [], marked_by: user.id }],
    trainer_present: body.trainer_present,
    internal_present, roster_count, // Rule 28: frozen
    govt_present: body.govt_present ?? null,
    govt_source: body.govt_source ?? "Manual",
    govt_screenshot: body.govt_screenshot,
    photos: body.photos ?? [], videos: body.videos ?? [],
    note: body.note,
    entered_by: user.id, entered_at: new Date(),
  });
  await audit({ entity: "DailyLog", entityId: doc._id, newValue: "created", actor: user.id });
  return doc;
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
  let d = addDays(istToday(), -1); // QA-101 (-69): "yesterday" is the IST calendar's, not the server's
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
    const overdue = istToday() > dayKey(batch.planned_start); // QA-101 (-69): IST day decides "overdue"
    if (failing.length) {
      reasons.push({
        code: "not_ready",
        // QA-148 (Manish, 15/08 recording): the check KEYS are positive ("room_assigned"),
        // so joining them after "Not ready:" read backwards — "Not ready: room assigned".
        // He selected the line with the mouse and said "ye samajh nahi aaya". Say the
        // failure, not the check.
        label: `Not ready: ${failing.map((k) => READINESS_FAILURE_TEXT[k] ?? k.replace(/_/g, " ")).join(", ")}`,
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
  const today = istToday(); // QA-101 (-69): the missing-log queue keys on the IST day
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
  // -113: settle BEFORE summarising. Measured on live DST-01 minutes after -112 shipped: eight rows
  // read Issued while the closure still said "certificates_issued 0", because the summary was taken
  // from the rows as they were before the settle ran. One write stale is still wrong on screen.
  await settleCertificatesFromFiles(batchId, actorId);
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
  await deriveCompletion(batchId, actorId);
  return { ...summary, legacy: false };
}

// THE RULE IS UNIFORM, NOT JUST FORWARD-LOOKING (-112): "a certificate file on a Pass row IS the
// certificate" has to hold for rows that already carry one, or DST-01's eight files — attached under
// -108, before this rule existed — would sit Pending forever and Manish would stay blocked by
// history. Live batches only, so a frozen one is never rewritten, and every settle is audited by name.
// PENDING ONLY — never Processing/Generated/Rejected/Not Issued. Those are states a human chose: a
// certificate the awarding body REJECTED must not be re-issued by a background rule just because the
// old file is still on the row. Pending + a file = nobody ever decided, and the file is the decision.
export async function settleCertificatesFromFiles(batchId: string, actorId?: string) {
  try {
    const batch = await Batch.findById(batchId).select("status").lean<any>();
    if (!batch || !["Active", "Closing"].includes(batch.status)) return 0;
    const stale = await CandidateResult.find({
      batch: batchId, result: "Pass",
      certificate_file: { $nin: [null, ""] },
      certificate_status: "Pending",
    }).populate("candidate", "name");
    for (const row of stale) {
      row.certificate_status = "Issued";
      if (!row.certificate_date) row.certificate_date = new Date();
      await row.save();
      await audit({ entity: "CandidateResult", entityId: row._id, field: "certificate_status", oldValue: "Pending", newValue: `Issued — the attached certificate file is the evidence (${row.candidate?.name ?? "candidate"})`, actor: actorId ?? null, actorType: "SYSTEM" });
    }
    return stale.length;
  } catch (e) {
    console.error(`[settleCertificatesFromFiles] batch ${batchId}: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }
}

// -112 (QA-219, Manish 17/08 M4-03/M4-07: "jaise hi batch completed mode me aata hai to completed kar
// dijiye… mark complete karne se kuch ho nahi raha"): the two closure halves and the batch status
// used to be three separate hand ticks, each refusing until the one before it was ticked — the
// order was right and the door was invisible. Now they DERIVE from the per-candidate rows, through
// the very same gates (Rules 43/46/18), after every save:
//   every roster member has a final result       → assessment_status  = Completed
//   every Pass is Issued or Not Issued           → certification_status = Completed
//   both Completed                                → the batch walks Active→Closing→Completed itself
// A batch with no per-candidate rows (legacy, batch-level figures) is untouched — its ticks stay
// hand-driven. Nothing here can throw into the caller: a derived step that fails is logged and
// left for the hand path, never a 500 on a certificate upload.
export async function deriveCompletion(batchId: string, actorId?: string) {
  try {
    const batch = await Batch.findById(batchId).select("status").lean<any>();
    if (!batch || !["Active", "Closing"].includes(batch.status)) return;
    const closure = await Closure.findOne({ batch: batchId });
    if (!closure) return;
    let changed = false;
    const a = await assessmentCompleteness(batchId);
    if (closure.assessment_status !== "Completed") {
      if (!a.legacy && a.total > 0 && a.complete) {
        closure.assessment_status = "Completed";
        closure.assessment_derived = true;
        if (!closure.assessment_date) closure.assessment_date = new Date();
        changed = true;
        await audit({ entity: "Closure", entityId: closure._id, field: "assessment_status", oldValue: "Pending", newValue: "Completed — derived: every roster member has a final result", actor: actorId ?? null, actorType: "SYSTEM" });
      }
    } else if (closure.assessment_derived && !a.legacy && !a.complete) {
      // Derivation is a statement about the rows, so it follows the rows BOTH ways: un-mark a
      // student and the derived sign-off goes back to Pending rather than standing as a claim
      // nobody made. A HUMAN sign-off is never touched here.
      closure.assessment_status = "Pending";
      closure.assessment_derived = false;
      changed = true;
      await audit({ entity: "Closure", entityId: closure._id, field: "assessment_status", oldValue: "Completed", newValue: "Pending — the derived sign-off no longer holds: a roster member has no final result", actor: actorId ?? null, actorType: "SYSTEM" });
    }
    const c = await certificationCompleteness(batchId);
    // -156 (QA-445): the same question the hand door asks. Proved by the wall rather than by
    // reading: the -112 fixture builds a per-candidate batch of candidates with no portal ID, marks
    // every row Pass, and its derived certification went Completed at -155 while a direct PUT on
    // the identical shape was refused 409. Two doors, one question, two answers.
    // It gates the FORWARD derivation only. The walk-back below is deliberately untouched: a
    // certificate already issued is not un-issued because somebody later cleared an ID, and
    // derivation that reversed on that would be a claim about the certificate it cannot make.
    const noCan = await enrolledWithoutCan(batchId);
    if (closure.assessment_status === "Completed" && closure.certification_status !== "Completed") {
      if (!c.legacy && c.pass_count > 0 && c.complete && noCan.length === 0) {
        closure.certification_status = "Completed";
        closure.certification_derived = true;
        if (!closure.certification_date) closure.certification_date = new Date();
        changed = true;
        await audit({ entity: "Closure", entityId: closure._id, field: "certification_status", oldValue: "Pending", newValue: `Completed — derived: all ${c.pass_count} passes settled (${c.issued} issued)`, actor: actorId ?? null, actorType: "SYSTEM" });
      }
    } else if (closure.certification_derived && !c.legacy && (!c.complete || closure.assessment_status !== "Completed")) {
      closure.certification_status = "Pending";
      closure.certification_derived = false;
      changed = true;
      await audit({ entity: "Closure", entityId: closure._id, field: "certification_status", oldValue: "Completed", newValue: "Pending — the derived sign-off no longer holds: a passed candidate has no settled certificate", actor: actorId ?? null, actorType: "SYSTEM" });
    }
    if (changed) await closure.save();
    // WHERE DERIVATION STOPS, AND WHY — both learned from the wall, not from review.
    // It derives FACTS ABOUT THE ROWS (assessment/certification sign-off) and never moves the batch
    // itself, because the batch's own status ladder is ONE-WAY: there is no Closing→Active and
    // Completed is the DEC-6 freeze (results, certificates and figures locked, no admin override —
    // Umesh, 13/08). A derived sign-off has to be reversible (un-mark a student and it walks back);
    // a derived TRANSITION could not be. So the two buttons stay human — and they now succeed on the
    // first click instead of bouncing off Rule 18, which was Manish's actual complaint ("mark
    // complete karne se kuch ho nahi raha"). Making the transition automatic needs a reopen door
    // first: that is a change to a recorded decision, so it is Umesh's call, not the maker's.
  } catch (e) {
    console.error(`[deriveCompletion] batch ${batchId}: ${e instanceof Error ? e.message : String(e)}`);
  }
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

// -156 (QA-445): ONE definition of "who is enrolled on this batch with no portal Candidate ID",
// because -155 wrote the test inline on the hand-typed door and the automatic door never asked the
// question. That is the F-010 lesson landing one branch over: the gate was narrowed to per-candidate
// batches for a correct reason (a legacy paper batch cannot be asked for IDs that never existed),
// and per-candidate batches are precisely the mode where certification DERIVES rather than being
// typed - so the narrowing aimed the gate at the door nobody uses.
export async function enrolledWithoutCan(batchId: string) {
  // -158 (QA-471): the PHONE rides along, because a name does not identify a student on the one
  // roster this whole story is about - two Sachin Kumars, one batch. The phone is what the Portal
  // ID health screen shows beside each of them and what a centre actually uses to tell them apart.
  const members = await BatchMember.find({ batch: batchId, left_on: null, enrollment_status: "Completed" })
    .populate("candidate", "name phone sidh_candidate_id").lean<any[]>();
  return members
    .filter((m) => m.candidate && !normalizeCan(m.candidate.sidh_candidate_id))
    .map((m) => ({ member: String(m._id), name: String(m.candidate?.name ?? ""), phone: m.candidate?.phone ?? null }));
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
      "Assessment was already completed with batch-level figures. Reopen the assessment before marking candidates individually, so the totals are rebuilt from the roster rather than overwritten.");
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

  for (const f of ["result", "score", "max_score", "assessed_on", "assessor", "failure_reason", "failure_note", "reassessment_required", "reassessment_date", "evidence_file",
    "mock_appeared", "mock_qualified", "mock_score", "mock_note", "roll_no"]) {
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
  // -112 (QA-219, Manish 17/08 M4-01/M4-03: "certificate generate ho gaya hai… mark complete karne se
  // kuch ho nahi raha"): the certificate FILE is the certificate. Attaching one to a Pass row used
  // to leave certificate_status at Pending — a hand-driven ladder nobody knew to walk — so DST-01
  // sat at Active with 8 certificates on it and Mark Completed refused. The -108 late-arrival path
  // already created its rows as Issued; this makes the ordinary attach behave the same. The date
  // defaults to today; the number stays optional here (typed later if the portal gives one) — the
  // Rule 46 number/date checks guard the HAND transitions, not the evidence path.
  if (typeof patch.certificate_file === "string" && patch.certificate_file && !patch.certificate_status
      && row.certificate_status === "Pending") {
    row.certificate_status = "Issued";
    if (!row.certificate_date) row.certificate_date = new Date();
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
    // -112 (QA-219): a hand tick that merely re-states what derivation already wrote
    // (assessment/certification Completed) is a no-op, not a rewrite of a frozen batch.
    const current = await Closure.findOne({ batch: batchId }).select("assessment_status certification_status").lean<any>();
    const blocked = Object.keys(patch).filter((k) => patch[k] !== undefined && !POST_COMPLETION_WRITABLE.has(k)
      && !(["assessment_status", "certification_status"].includes(k) && patch[k] === current?.[k]));
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
    // -155 (Umesh, 20/08): "ye bas unke paas mandatory hoga na jo already enrolled hai" - the
    // portal Candidate ID becomes mandatory exactly where it is indispensable: the government
    // issues no certificate without the CAN. Enrolment stays open (a candidate legitimately
    // exists here before the portal registers them).
    //
    // PER-CANDIDATE MODE ONLY, and the first draft learned why the hard way: it sat above both
    // modes and broke the product's own seed script, which records a LEGACY batch-level closure
    // (hand-typed appeared/passed from paper records). A pre-portal paper batch cannot be asked
    // for portal IDs that never existed - demanding them would make legacy entry impossible, not
    // safer. This is a deliberate narrowing of the F-010 rule-in-one-branch lesson: the gate's
    // subject is the GOVERNMENT WORKFLOW, and only per-candidate batches are in it.
    // Placed AHEAD of Rule 46 so the operator hears the actionable message first.
    // TRANSITION only: -112 established that re-stating a value derivation already wrote is a
    // no-op on a frozen batch, and the wall caught this gate breaking that - a re-statement of
    // certification Completed must not suddenly demand IDs the record was closed without.
    if (patch.certification_status === "Completed" && closure.certification_status !== "Completed") {
      // -156 (QA-445): this door and deriveCompletion() now read ONE definition of the test. It
      // was inline here, and the automatic door - the one per-candidate batches actually use -
      // never asked the question at all.
      const noCan = await enrolledWithoutCan(batchId);
      if (noCan.length) {
        throw new HttpError(409,
          `${noCan.length} enrolled student(s) have no portal Candidate ID, and the government issues no certificate without one: ${noCan.map((m) => m.name).filter(Boolean).slice(0, 5).join(", ")}${noCan.length > 5 ? "…" : ""}. Fix it from Candidates → Portal ID health (a misfiled or unattached ID may already be in the system), or set the ID on each candidate's card.`);
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

  // -112: a human writing the status takes ownership of it — derivation stops managing it.
  if (patch.assessment_status !== undefined) (closure as any).assessment_derived = false;
  if (patch.certification_status !== undefined) (closure as any).certification_derived = false;
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
// One row of the earliest-possible-start reasoning. `date` null + `blocking` true means the
// constraint cannot be satisfied at all (QA-506) - which is stronger than a late date, not weaker.
export type Basis = { key: string; label: string; date: Date | null; blocking?: boolean; note: string };

// QA-152 part 2 (-82, Umesh 15/08): the batch plan as an ARTIFACT — its own view, a
// shareable link (like the self-registration form: the token is the credential), Excel
// download; the planner edits, the link holder reads (and ticks status only if the link was
// minted with allow_updates). One shape for the signed-in page, the public page and the
// export, built here so all three say the same thing.
export async function planArtifact(batchId: string) {
  const batch = await Batch.findById(batchId)
    .populate("program", "name code")
    .populate("location", "name code")
    .populate("trainer", "name tr_id tot_done_on")
    .lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  const today = istToday();
  const rows = (batch.milestones ?? [])
    .slice()
    .sort((a: any, b: any) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime())
    .map((m: any) => ({
      key: m.key, label: m.label, due_date: m.due_date, done_on: m.done_on ?? null,
      done_via: m.done_via ?? null, notes: m.notes ?? "", owner_label: m.owner_label ?? "",
      custom: !!m.custom,
      overdue: !m.done_on && !!m.due_date && dayKey(m.due_date).getTime() < today.getTime(),
    }));
  const defaults = await getDefaults();
  const totLeadDays = defaults.lead_tot_done_days ?? 3;
  const totDue = dayStart(addDays(batch.planned_start, -totLeadDays));
  const tr = batch.trainer;
  const plan_flags = {
    tot_lead_ok: !tr?.tot_done_on || dayStart(tr.tot_done_on) <= totDue,
    tot_done_on: tr?.tot_done_on ?? null,
    tot_due: tr?.tot_done_on ? totDue : null,
    tot_lead_days: totLeadDays,
  };
  return {
    batch: {
      _id: batch._id, code: batch.code, status: batch.status, plan_enabled: !!batch.plan_enabled,
      planned_start: batch.planned_start, planned_end: batch.planned_end ?? null,
      program: batch.program ? { name: batch.program.name, code: batch.program.code } : null,
      location: batch.location ? { name: batch.location.name, code: batch.location.code } : null,
      trainer: tr ? { name: tr.name, tr_id: tr.tr_id ?? null } : null,
      target_size: batch.target_size,
    },
    milestones: rows,
    plan_flags,
    counts: { total: rows.length, done: rows.filter((r: any) => r.done_on).length, overdue: rows.filter((r: any) => r.overdue).length },
  };
}

// Rows for the Excel export — plain values, one line per milestone.
export function planExportRows(art: Awaited<ReturnType<typeof planArtifact>>) {
  const d = (x: any) => (x ? new Date(x).toISOString().slice(0, 10) : "");
  return art.milestones.map((m: any, i: number) => ({
    "#": i + 1,
    Milestone: m.label,
    "Due date": d(m.due_date),
    Status: m.done_on ? "Done" : m.overdue ? "OVERDUE" : "Pending",
    "Done on": d(m.done_on),
    Owner: m.owner_label ?? "",
    Notes: m.notes ?? "",
  }));
}

// QA-460 (-164): the plan is no longer the same seven rows for every batch. Karunn sir writes
// "Not needed" in the TOT columns of rows 7, 14 and 15 of his own sheet, because those trainers
// are already certified — 3 of his 16 rows. This function had a HARD-CODED seven-element array
// with zero conditionals, so it handed those batches TOT deadlines nobody has to meet, and it
// did that on the first screen he would open.
//
// `trainer` is optional and the no-trainer call is unchanged on purpose: the standalone
// calculator (/api/plan-batch?start=) is used BEFORE a batch or a trainer exists — "मैं जब चाहूं
// एक batch planning निकाल के किसी को भी share कर सकूं" — and there the full plan is the honest
// answer, because no trainer is known to be certified yet.
export function planBatchBackward(
  planned_start: Date,
  defaults: {
    lead_enrollment_days: number; lead_mobilization_days: number; lead_trainer_ready_days: number;
    lead_tot_done_days: number; lead_trainer_found_days: number;
    lead_tot_start_days: number; lead_trainer_ready_for_tot_days: number;
    lead_trainer_mapped_sidh_days?: number;
  },
  opts?: { trainer?: { pipeline_status?: string | null; tot_done_on?: Date | string | null } | null },
): Milestone[] {
  const start = dayStart(planned_start);
  // Either signal alone is enough: `Certified` is the pipeline's own terminal state, and
  // tot_done_on is stamped when it is reached — but a trainer imported or bypassed into service
  // can carry the date without the stage, and Rule 11 already trusts the date.
  const tr = opts?.trainer;
  const totNeeded = !(tr && (tr.pipeline_status === "Certified" || !!tr.tot_done_on));
  // -164 cycle 2, contract §7 fold: trainer_ready_for_tot goes with them. It asks whether the
  // trainer is available and ready for a TOT they finished in January - the same dead deadline
  // QA-460 is written from. Karunn sir answers columns 7 through 13 as ONE block ("Not needed"),
  // and 7 is the first of them. Cycle 1 shipped six milestones, one of which asked that question;
  // the checker folded the widening after the maker raised it rather than deciding it alone.
  const plan: Milestone[] = [
    { key: "trainer_found", label: "Trainer identified", due_date: addDays(start, -defaults.lead_trainer_found_days) },
    ...(totNeeded ? [
      // The CEO's own gap: how long TOT itself takes was never captured, only its deadline.
      { key: "trainer_ready_for_tot", label: "Trainer available & ready for TOT", due_date: addDays(start, -(defaults.lead_trainer_ready_for_tot_days ?? 12)) },
      { key: "tot_start", label: "TOT starts", due_date: addDays(start, -(defaults.lead_tot_start_days ?? 10)) },
      { key: "tot_done", label: "Trainer TOT completed", due_date: addDays(start, -defaults.lead_tot_done_days) },
    ] : []),
    // Karunn sir's column 14, "Date for Trainer Mapping on SIDH Portal?". Per batch, because the
    // trainer is mapped to EACH batch separately on the portal. It sits after TOT and before
    // mobilization: nobody can be mapped before they are certified, and candidates should not be
    // mobilised for a batch with no mapped trainer. Its lead time is a Default, not a constant.
    //
    // QA-503 (-164 cycle 1 shipped this WRONG): the default was 5, and a bigger lead means an
    // EARLIER date, so on the shipped defaults it sorted five days before start while tot_done
    // sits three days before - the plan told you to map the trainer on the portal two days
    // BEFORE their TOT completed. Exactly the impossibility the paragraph above exists to
    // prevent, printed by the code that paragraph is attached to. Default is 2 now, which is
    // after tot_done (3) and level with mobilization (2), and the sort below breaks that tie by
    // the declared stage order rather than leaving it to chance.
    { key: "trainer_mapped_sidh", label: "Trainer mapped on SIDH portal", due_date: addDays(start, -(defaults.lead_trainer_mapped_sidh_days ?? 2)) },
    { key: "mobilization", label: "Candidate mobilization complete", due_date: addDays(start, -defaults.lead_mobilization_days) },
    { key: "trainer_ready", label: "Trainer finalized & ready", due_date: addDays(start, -defaults.lead_trainer_ready_days) },
    { key: "enrollment_done", label: "Registration & enrollment done", due_date: addDays(start, -defaults.lead_enrollment_days) },
  ];
  // QA-503: date first, DECLARED STAGE ORDER as the tiebreak. Two milestones can legitimately
  // fall on the same day (trainer_mapped_sidh and mobilization both do on the shipped defaults),
  // and a bare date sort leaves which one reads first to the sort's internals. The array above is
  // the sequence of the work; it is the right tiebreak. A lead time an admin configures into
  // nonsense still shows up as an out-of-order DATE, exactly as it always has for the other
  // seven - that is visible, and it is not this change's job to hide it.
  return plan
    .map((m, i) => ({ m, i }))
    .sort((a, b) => a.m.due_date.getTime() - b.m.due_date.getTime() || a.i - b.i)
    .map((x) => x.m);
}

// QA-504 (-164 cycle 2). THE SKIP WAS SILENTLY DELETING RECORDED WORK, and the deletion was new
// in -164 because the skip is what makes a milestone disappear from a regenerated plan at all.
// Both callers rebuilt `batch.milestones` with .map() over the NEW plan, carrying only done_on
// and done_by across - so any row the new plan omits was dropped outright, and any row it keeps
// lost its notes and its owner. Measured by the checker on the NORMAL path: a ticked tot_done
// carrying "TOT finished, certificate in hand" vanished the moment the trainer certified and
// planned_start was edited.
//
// A recalculation may move a DATE. It may never erase what a person recorded. A row that carries
// a tick, a note, an owner, or that a planner added by hand, survives regeneration on its own
// due date even when the new plan has no place for it.
export function mergePlan(existing: any[], next: Milestone[]): any[] {
  const carriesWork = (m: any) => !!m?.done_on || !!m?.custom
    || String(m?.notes ?? "").trim() !== "" || String(m?.owner_label ?? "").trim() !== "";
  const byKey = new Map((existing ?? []).map((m: any) => [m.key, m]));
  const kept = new Set(next.map((m) => m.key));
  const merged: any[] = next.map((m) => {
    const old: any = byKey.get(m.key);
    return {
      ...m,
      done_on: old?.done_on, done_by: old?.done_by, done_via: old?.done_via,
      notes: old?.notes, owner_label: old?.owner_label, custom: old?.custom,
    };
  });
  for (const old of existing ?? []) {
    if (kept.has(old.key) || !carriesWork(old)) continue;
    merged.push(old);
  }
  return merged.sort((a, b) => new Date(a.due_date).getTime() - new Date(b.due_date).getTime());
}

// QA-509 (-168): the ONE sentence for the earliest-possible-start, so the three screens that state
// it cannot state it differently. Built from the same `basis` the computation returns, which is why
// it cannot drift from the number it explains.
export function earliestStartNote(res: { blocked: boolean; basis: Basis[] }): string {
  const parts = res.basis.filter((b) => b.note).map((b) => b.note);
  return parts.join(" · ");
}

// QA-461 / REQ-185 (-164): the planner could only answer "if I pick this date, what must finish
// by when". It could not answer "which date is even possible here", so it would happily count
// backwards past today and hand out deadlines that expired before they were printed.
//
// max(trainer availability, first free room, today + mobilisation lead) — the contract's formula.
// It returns the BASIS as well as the date, because a date with no reason is not usable: the
// operator has to be able to see which of the three constraints is the binding one and go fix it.
export async function earliestPossibleStart(
  locationId: unknown,
  opts?: { trainerId?: unknown },
): Promise<{ date: Date; blocked: boolean; basis: Basis[] }> {
  const defaults = await getDefaults();
  const today = istToday();
  const basis: Basis[] = [];

  // 1. Mobilisation floor — candidates cannot be found retrospectively.
  const mobFloor = addDays(today, defaults.mobilisation_lead_days ?? 7);
  basis.push({
    key: "mobilisation", label: "Mobilisation lead", date: mobFloor,
    note: `${defaults.mobilisation_lead_days ?? 7} days from today to mobilise candidates`,
  });

  // 2. Trainer — available_from, and if they are already at their concurrency cap, the day the
  // earliest of those batches frees a slot. Both are real blocks Rule 10 would enforce anyway.
  if (opts?.trainerId) {
    const t = await Trainer.findById(opts.trainerId as any).select("name available_from max_concurrent_batches").lean<any>();
    if (t) {
      let when: Date | null = t.available_from ? dayStart(t.available_from) : null;
      let note = t.available_from ? `${t.name} is free from ${dayStart(t.available_from).toDateString()}` : `${t.name} has no availability date on file`;
      const cap = t.max_concurrent_batches ?? defaults.max_concurrent_batches ?? 1;
      const booked = await Batch.find({ trainer: opts.trainerId as any, status: { $in: ACTIVE_BATCH_STATUSES } }).lean<any[]>();
      if (booked.length >= cap) {
        // The cap frees up when the earliest-ending of the booked batches ends.
        const firstFree = addDays(booked.map((b) => batchRange(b)[1]).sort((a, b) => a.getTime() - b.getTime())[0], 1);
        if (!when || firstFree > when) { when = firstFree; }
        note = `${t.name} is at the ${cap}-batch cap until ${firstFree.toDateString()}`;
      }
      basis.push({ key: "trainer", label: "Trainer availability", date: when, note });
    }
  }

  // 3. Room — the Room model has existed since the first schema and NO planning path has ever
  // read it. A centre with no room at all is a real state (centres are created before they are
  // equipped), and it is reported rather than silently treated as "free today".
  const rooms = await Room.find({ location: locationId as any, active: true }).select("name").lean<any[]>();
  if (rooms.length === 0) {
    // QA-506 (-164 cycle 2): this used to push a null date and nothing else, and the reducer below
    // then FILTERED IT OUT - so a centre with no room at all was handed a date it cannot possibly
    // meet, and starts_too_soon said false. A constraint we cannot satisfy is not an absent
    // constraint; it is the binding one. `blocking` says so, and the caller must not present the
    // date as achievable while it is set.
    basis.push({ key: "room", label: "Room", date: null, blocking: true, note: "No active room at this centre — a room has to exist before a batch can be scheduled here" });
  } else {
    const roomIds = rooms.map((r) => r._id);
    const booked = await Batch.find({ room: { $in: roomIds }, status: { $in: ACTIVE_BATCH_STATUSES } }).lean<any[]>();
    // A room is free on day D if it hosts nothing overlapping [D, D+duration]. Rather than
    // scanning days, take each room's last booked end: the earliest of those is the first day
    // some room in this centre is certainly free.
    let firstFree: Date | null = null;
    for (const r of rooms) {
      const mine = booked.filter((b) => String(b.room) === String(r._id));
      const free = mine.length === 0 ? today : addDays(mine.map((b) => batchRange(b)[1]).sort((a, b) => b.getTime() - a.getTime())[0], 1);
      if (!firstFree || free < firstFree) firstFree = free;
    }
    basis.push({
      key: "room", label: "Room availability", date: firstFree,
      note: firstFree && firstFree <= today ? `${rooms.length} room(s) here, free now` : `first free room from ${firstFree?.toDateString()}`,
    });
  }

  const dates = basis.map((b) => b.date).filter(Boolean) as Date[];
  const date = dates.reduce((a, b) => (b > a ? b : a), dayStart(today));
  // `date` is still the best answer the satisfiable constraints allow, because an operator wants
  // to see it - but `blocked` travels with it so nothing can quote the date without the caveat.
  return { date, blocked: basis.some((b) => b.blocking), basis };
}

// ---------- Batch code (CEO 14/08 [32:47], QA-076: CENTRE-COURSE-SKILL-NN) ----------
// "Center code, dash, abbreviation for the course, dash, skill that we are training, dash,
// the batch number" — FOUR parts (the checker caught the third one dropped; Umesh: ship the
// four-part form before the bulk wave). The programme code is already COURSE-SKILL fused
// (RPLAVP-DST), so the prefix is the centre code + the FULL programme code:
// AVP-GURU-RPLAVP-DST-01. One counter per prefix in the same `counters` collection; the
// legacy global "batch" counter stays parked — old codes on old paper never collide.
export async function nextBatchCode(location?: { code?: string } | null, program?: { code?: string } | null): Promise<string> {
  const db = Batch.db;
  const locCode = String(location?.code ?? "").trim().toUpperCase();
  const progAbbr = String(program?.code ?? "").trim().toUpperCase();
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

// QA-111 (15/08): exported so the trainer GET can hand the UI the LEGAL next steps —
// the Move drawer used to offer all 11 stages and let the server refuse the pick.
export const TRAINER_FLOW: Record<string, string[]> = {
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
  opts: { reason?: string; remarks?: string; date?: Date; payload?: Record<string, unknown>; actor?: string; bypass?: boolean; actorName?: string } = {},
) {
  const t = await Trainer.findById(trainerId);
  if (!t) throw new HttpError(404, "Trainer not found");
  const from = t.pipeline_status ?? "Fresh Lead";
  if (from === target) throw new HttpError(409, `${t.name} is already at "${target}".`);

  // Rule T8 (Umesh 15/08): a pipeline.bypass holder may set ANY status directly — the
  // use-case is a trainer who already works with us (batch live or done) whose paperwork
  // arrives later. Every gate below (edges, T2 docs, T3 vacancy, T5 TR ID) is skipped;
  // the note and the audit row say so in as many words.
  if (opts.bypass) {
    if (!TRAINER_PIPELINE.includes(target as any)) throw new HttpError(400, `Unknown status "${target}".`);
    // -128 (QA-272): this read "Rule T6 holds even on bypass: …". The code sits mid-sentence rather
    // than leading, so plain() cannot lift it out without leaving a hole — the message says the same
    // thing in the user's words instead. The rule number lives in this comment, where it is useful.
    if (target === "Dropped" && !opts.reason) throw new HttpError(400, "Dropping a trainer needs a reason - that holds even when the status is set directly.");
    if (target === "Certified") {
      const trId = (opts.payload?.tr_id as string) ?? t.tr_id;
      if (trId) t.tr_id = trId; // recorded when given; NOT demanded — that is the point
      t.tot_done_on = opts.date ? new Date(opts.date) : new Date();
      if (!t.available_from) t.available_from = t.tot_done_on;
    }
    if (target === "Dropped") { t.dropped_from_stage = from; t.dropped_reason = opts.reason; t.active = false; }
    if (from === "Dropped") { t.dropped_reason = undefined; t.active = true; }
    t.pipeline_status = target as any;
    t.pipeline_note = `BYPASS by ${opts.actorName ?? "admin"}: ${from} → ${target}${opts.reason ? ` (${opts.reason})` : ""}`;
    await t.save();
    return t;
  }

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
// QA-085 (checker, 14/08): the old fallback credited a slot-less batch 8 hours a day —
// the longer of the two legal session lengths — which could turn the green
// "qualified for assessments" mark ON for hours never attended. Unknown slot now returns
// null: the caller shows "no slot on the batch" instead of assuming, and the green verdict
// comes from PORTAL hours alone.
export { slotHoursPerDay };

// QA-093 (-70): when the scheme master carries VALID absolute hours, the bar IS
// min_required_hours. The old path collapsed them to a rounded percentage and re-multiplied
// by program.hours — whenever program.hours ≠ scheme.total_hours the required number silently
// stopped equalling what the Admin typed into the master. The pct path stays as the honest
// fallback for schemes without data (Defaults guess, labelled "defaults").
export async function assessmentHoursBar(
  scheme: string | undefined,
  program: any,
  fallbackPct: number,
): Promise<{ requiredHours: number; minPct: number; source: "scheme" | "defaults" }> {
  if (scheme) {
    const s = await Scheme.findOne({ name: scheme, active: true }).select("total_hours min_required_hours").lean<any>();
    if (s && Number.isFinite(s.total_hours) && Number.isFinite(s.min_required_hours)
      && s.total_hours > 0 && s.min_required_hours > 0 && s.min_required_hours <= s.total_hours) {
      return { requiredHours: s.min_required_hours, minPct: Math.round((s.min_required_hours / s.total_hours) * 100), source: "scheme" };
    }
  }
  return { requiredHours: requiredAssessmentHours(program, fallbackPct), minPct: fallbackPct, source: "defaults" };
}

// (slotHoursPerDay moved to slot-rules.ts in -70 — client-safe for the Daily Execution
// summary; re-exported below so the two server routes keep their import path.)

// QA-070 (-70): the per-member hours verdict, extracted — the batch Attendance tab and the
// public portal carried byte-identical inline copies, and the roster + closure surfaces are
// about to become the third and fourth callers. QA-085/086 rules preserved verbatim: our
// hours are days × slot (null when the batch has no slot — never an assumed 8), and the
// GREEN verdict comes from the portal's hour meter ALONE.
export function memberAttendedHours(opts: {
  internalDays: number;
  hoursPerDay: number | null;
  govtMinutes?: number | null;
  requiredHours: number;
}): { our_hours: number | null; govt_hours: number | null; attended_hours: number | null; basis: "portal" | "estimate" | null; qualified: boolean } {
  const govt_hours = opts.govtMinutes != null ? Math.round(opts.govtMinutes / 60) : null;
  const our_hours = opts.hoursPerDay != null ? Math.round(opts.internalDays * opts.hoursPerDay) : null;
  return {
    our_hours,
    govt_hours,
    attended_hours: govt_hours ?? our_hours,
    basis: govt_hours != null ? "portal" : our_hours != null ? "estimate" : null,
    qualified: govt_hours != null && govt_hours >= opts.requiredHours,
  };
}

// ---------- The eligibility VERDICT, and when it is honest to give one (-109) ----------
// Umesh, 17/08: "jo humne student ke step-by-step journey banayi thi — documents update ho gaye,
// registration ho gaya, NSDC portal pe registration ho gaya, batch assigned ho gaya… jab batch
// assigned ho jayega tab wo ENROLLED student me convert hoga, aur enrolled student ke liye ye
// not-eligible wala hoga na. Pehli register karke hi na aa jaye upar."
//
// He is right, and production was worse than the complaint. Measured on 17/08: BHA-SPIT-02 read
// "not eligible" for all 31 students THREE DAYS into a fifteen-day programme; BHA-SPIT-01 read it
// for all 45 purely because that file's decimal hours never parsed (-106); CHI-DST-03 read it for
// all 45 with no import at all; on DST-01, 20 of the 29 had no hours on record whatsoever. So a
// MISSING-DATA state and an UNFINISHED COURSE were both being rendered as a negative verdict about
// a real student — on the very screen where certificates get decided.
//
// Two gates, therefore, and this is the only place either is decided:
//   1. the JOURNEY gate (Umesh's answer) — an eligibility verdict belongs to an ENROLLED student.
//      Before that the honest thing to show is where they are in the journey.
//   2. the TIME gate — "not eligible" is a verdict, so it waits until the course is actually over.
//      While it runs, a student below the bar is IN PROGRESS, not rejected.
// -153 cycle 2 (QA-413): the bucket list in the attendance route was six hand-typed strings against
// a union that has now grown twice (trainer in -127, awaiting_match in -153). The only thing keeping
// the -109 invariant true - that the buckets partition the roster - was somebody remembering to edit
// both places. A guard made of memory is the thing this project keeps paying for. The union and the
// list are ONE value now, so a new state joins the buckets by existing.
export const ELIGIBILITY_STATES = [
  "qualified", "in_progress", "no_hours", "awaiting_match", "not_eligible", "not_enrolled", "trainer",
] as const;
export type EligibilityState = (typeof ELIGIBILITY_STATES)[number];

export type EligibilityVerdict = {
  // -127 (QA-180): "trainer" is a state, not a verdict. A portal export carries the centre's own
  // trainers alongside its students, and eligibility is a question that was never asked of them —
  // so they get their own state rather than being squeezed into a student one. eligibilityVerdict()
  // itself never RETURNS it (it is only ever called about a student); the govt-attendance grid,
  // which is the one screen that sees non-student rows, constructs it.
  // -153 (QA-393): "awaiting_match" splits the one honest half off no_hours. no_hours says the
  // export never arrived; awaiting_match says it DID and the row is not attached to this student
  // yet. Both are "we cannot judge you", and telling them apart is the whole point - one is a
  // missing file somebody must go and fetch, the other is two clicks on a screen we already ship.
  state: EligibilityState;
  label: string;
  detail: string;
  qualified: boolean; // kept for every existing caller — true ONLY for a real pass of the bar
};
// -153 cycle 3 (QA-419): the ONE gate. Three surfaces consulted unresolvedPortalRowsByName with
// three different conditions - eligibilityVerdict behind the -109 journey gate, members/route.ts
// and the public route behind none - so a not-enrolled student got three different answers about
// one unattached row. The question "is a portal row waiting to be attached to this name" has
// nothing to do with enrolment: it is a fact about data. Enrolment gates the ELIGIBILITY VERDICT,
// which is a different question and keeps its own gate below.
export function awaitingMatchFor(opts: {
  basis: "portal" | "estimate" | null;
  hit?: { count: number; hours_minutes: number | null } | null;
}): { count: number; hours_minutes: number | null } | null {
  // A member the portal has already answered for is never pulled back into limbo by a namesake.
  if (opts.basis === "portal") return null;
  return opts.hit && opts.hit.count > 0 ? opts.hit : null;
}

export function eligibilityVerdict(opts: {
  enrollmentStatus?: string | null;   // BatchMember.enrollment_status — "Completed" = enrolled (Rule 21)
  sidhStatus?: string | null;         // where the candidate is in portal registration
  attendedHours: number | null;       // from memberAttendedHours — portal hours, or null
  requiredHours: number;
  basis: "portal" | "estimate" | null;
  courseFinished: boolean;            // batch past teaching, or the portal's own working days complete
  // -153 (QA-393): unattached portal rows answering to this student's name, from
  // unresolvedPortalRowsByName(). Present = the export carries hours under this name but the row
  // has not been resolved onto a student. NEVER a route to `qualified` - QA-085 stands: only a
  // row the ERP has actually attached to this person may move their hours.
  awaitingMatch?: { count: number; hours_minutes: number | null } | null;
  // -156 (QA-439): how many LIVE members of this batch answer to this student's name. "under this
  // name" is defensible; "not attached to THIS STUDENT yet" asserts the row IS theirs - which is
  // precisely what nobody knows while two people share the name.
  sameNameMembers?: number;
}): EligibilityVerdict {
  const { enrollmentStatus, sidhStatus, attendedHours, requiredHours, basis, courseFinished, awaitingMatch, sameNameMembers } = opts;

  // 1. The journey gate. A candidate who has not finished enrolling has not started earning hours,
  //    so "eligible / not eligible" is not a question that has been asked of them yet.
  if (enrollmentStatus !== "Completed") {
    const where = sidhStatus === "Registration Failed" ? "portal registration failed"
      : sidhStatus !== "Registered" ? "portal registration pending"
        : enrollmentStatus === "In Progress" ? "enrolment in progress"
          : "not enrolled yet";
    return {
      state: "not_enrolled", qualified: false,
      label: "Not enrolled yet",
      detail: `${where} — attendance hours are counted once the student is enrolled, so there is no eligibility verdict to give yet`,
    };
  }

  // 2. Qualified is the one verdict that never needs to wait: the bar has been cleared.
  //    QA-085 holds — only the PORTAL's hour meter can produce it, never an estimate.
  if (basis === "portal" && attendedHours != null && attendedHours >= requiredHours) {
    return { state: "qualified", qualified: true, label: "Qualified", detail: `${attendedHours} of ${requiredHours} hrs on the government portal` };
  }

  // 3. No hours at all is missing DATA, and saying "not eligible" about it is a lie about a student.
  //
  // -153 (QA-393): but "missing" has two causes and they need different people to do different
  // things. Before -153 both read as "the export has not been imported", which was a false
  // sentence about the two Sachin Kumars on AVP-GURU-RPLAVP-DST-02 - imported three times, hours
  // stored, ambiguous only because they share a name. It was simultaneously the RIGHT sentence for
  // the other eight members of that batch, and that is exactly what made it dangerous: an operator
  // who checks one of the eight, finds it accurate, and then trusts the line for all ten.
  if (attendedHours == null || basis !== "portal") {
    if (awaitingMatch && awaitingMatch.count > 0) {
      // Whole hours, via the SAME rounding memberAttendedHours uses (Math.round(min / 60)). A
      // second convention here would have this line reading 63.2 hrs beside a grid reading 63.
      // -153 cycle 2 (QA-410): say only what the row actually holds. A row whose hours column the
      // importer could not read is still a row waiting to be matched - but claiming it "DOES carry
      // hours" about a null trades one confident falsehood for another, which is the exact shape
      // this state exists to end. The wording it replaced was careful to allow for an unreadable
      // column; this must be too.
      const mins = awaitingMatch.hours_minutes;
      // -156 (QA-439): when more than one student here answers to this name, a single unattached
      // row cannot be said to be ANY of theirs - resolving it is what decides whose it is. The
      // figure is still worth stating, because it is what the export holds under the name; what
      // must not be said is "yours".
      if ((sameNameMembers ?? 1) > 1) {
        return {
          state: "awaiting_match", qualified: false,
          label: "Portal hours waiting on a match",
          detail: `${sameNameMembers} students in this batch share this name, and the export carries ${awaitingMatch.count === 1 ? "one row" : `${awaitingMatch.count} rows`} under it${mins != null && awaitingMatch.count === 1 ? ` (${Math.round(mins / 60)} hrs)` : ""} - which of them it belongs to is exactly what has not been decided yet. Open the import on the Government Attendance screen and pick the right person; nobody's hours can move until then`,
        };
      }
      return {
        state: "awaiting_match", qualified: false,
        label: "Portal hours waiting on a match",
        detail: awaitingMatch.count > 1
          ? `the export carries ${awaitingMatch.count} rows under this name and none is attached to a student yet - open the import on the Government Attendance screen and pick the right person for each, and whatever they hold lands by itself`
          : mins != null
            ? `the export DOES carry ${Math.round(mins / 60)} hrs under this name - the row is just not attached to this student yet; resolve it on the Government Attendance screen and the hours land by themselves`
            : `the export carries a row under this name but its hours column could not be read - attach the row on the Government Attendance screen, and re-import if the hours are still blank after that`,
      };
    }
    return {
      state: "no_hours", qualified: false,
      label: "No portal hours yet",
      detail: "the government portal export for this student has not been imported (or its hours column could not be read) — nothing is known about their attendance yet",
    };
  }

  // 4. Below the bar. While the course runs that is progress, not a verdict.
  if (!courseFinished) {
    return {
      state: "in_progress", qualified: false,
      label: `${attendedHours} of ${requiredHours} hrs so far`,
      detail: `still ${Math.max(0, requiredHours - attendedHours)} hrs short, and the course is still running — this is progress, not a verdict`,
    };
  }
  return {
    state: "not_eligible", qualified: false,
    label: "Not eligible",
    detail: `${attendedHours} of ${requiredHours} hrs and the course is over — short by ${Math.max(0, requiredHours - attendedHours)} hrs (no certificate without a Pass, and no assessment without the hours)`,
  };
}

// Has this cohort finished teaching? Either the batch has left Active, or the portal's own
// working-day count has reached the programme's length — whichever says "over" first.
export function courseIsFinished(batch: any, portalWorkingDays: number | null | undefined): boolean {
  if (["Closing", "Completed", "Closed", "Cancelled"].includes(String(batch?.status))) return true;
  const days = Number(batch?.program?.duration_days ?? 0);
  return !!days && Number(portalWorkingDays ?? 0) >= days;
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
// ---------- Karunn sir's Back-dated Planning table (QA-399) ----------
// The second of the two things he said the whole job needs. His sheet is 18 columns x 16 rows, one
// row per (Location x Job Role x Batch), and it is a TRACKER: where does every batch across every
// centre actually stand. `planBatchBackward` is a CALCULATOR: given one date, what is due when.
// They are transposes of each other and the contract asks for both, not one instead of the other.
//
// ⛔ THE THING THIS MUST NOT BECOME: a BatchPlan collection. His sheet is flat, so the 18 columns
// read like 18 properties of a batch. They are not - they sit at THREE grains: 1 belongs to the
// location, TEN to the trainer, and 7 to the batch. A trainer does TOT ONCE, not once per batch,
// and `max_concurrent_batches` defaults to 4 - so copying nsdc_submitted_on / nsdc_result_on /
// paid_on / tot_done_on onto each row would give one trainer FOUR copies of one TOT, and they would
// drift. Every trainer column here is read from the TRAINER document, so two batches of one trainer
// show the same date because it IS the same date.
export async function planTrackerRows(scope: Record<string, unknown> = {}) {
  // find() + populate, never an aggregation over the scope filter - authz builds its $in from
  // .map(String) and mongoose does not cast inside a pipeline (QA-302/347/350/395).
  const batches = await Batch.find({ ...scope, status: { $in: ACTIVE_BATCH_STATUSES } })
    .populate("location", "name code")
    .populate("program", "name code scheme")
    .populate("trainer",
      "name tr_id pipeline_status sidh_profile_verified_on eligibility_checked_on "
      + "nomination_sent_on nsdc_submitted_on nsdc_result_on nsdc_remarks paid_on payment_reference "
      + "tot_scheduled_on tot_done_on tot_result_expected_on tot_certificate_no")
    .sort({ planned_start: 1 })
    .lean<any[]>();
  if (!batches.length) return [];

  // Column 15 is "Is mobilization done for this batch?" and he writes "Yes - 38" in it: a state AND
  // a count. The count is DERIVED from the roster, never stored - `trainers_required` already
  // carries the comment explaining why ("the two sheets already disagree with each other... which
  // is exactly what happens when a count is kept in more than one place").
  const ids = batches.map((b) => b._id);
  const memberRows = await BatchMember.aggregate([
    { $match: { batch: { $in: ids }, left_on: null } },
    { $group: { _id: "$batch", n: { $sum: 1 } } },
  ]);
  const memberBy = new Map(memberRows.map((r: any) => [String(r._id), r.n]));

  const ms = (b: any, key: string) => (b.milestones ?? []).find((m: any) => m.key === key) ?? null;
  // "Not needed" is his own word for the TOT columns of a batch whose trainer is already certified -
  // rows 7, 14 and 15 of his sheet. The planner already drops those milestones (QA-460); the tracker
  // has to SAY so rather than leave the cell blank, because blank reads as "nobody has done it yet".
  const totNeeded = (t: any) => !(t && (t.pipeline_status === "Certified" || t.tot_done_on));

  return batches.map((b, i) => {
    const t = b.trainer ?? null;
    const need = totNeeded(t);
    const mob = ms(b, "mobilization");
    return {
      sl: i + 1,                                                    // 1
      location: b.location ? { _id: String(b.location._id), name: b.location.name } : null, // 2
      job_role: b.program?.name ?? null,                            // 3
      scheme: b.program?.scheme ?? null,
      batch: { _id: String(b._id), code: b.code, status: b.status },
      trainer: t ? { _id: String(t._id), name: t.name, tr_id: t.tr_id ?? null } : null, // 4
      sidh_profile_verified_on: t?.sidh_profile_verified_on ?? null, // 5
      eligibility_checked_on: t?.eligibility_checked_on ?? null,     // 6
      ready_for_tot: need ? (ms(b, "trainer_ready_for_tot")?.done_on ?? ms(b, "trainer_ready_for_tot")?.due_date ?? null) : "Not needed", // 7
      nsdc_submitted_on: need ? (t?.nsdc_submitted_on ?? null) : "Not needed",   // 8
      nsdc_result_on: need ? (t?.nsdc_result_on ?? null) : "Not needed",         // 9
      nsdc_remarks: t?.nsdc_remarks ?? null,
      paid_on: need ? (t?.paid_on ?? null) : "Not needed",                       // 10
      tot_start: need ? (t?.tot_scheduled_on ?? ms(b, "tot_start")?.due_date ?? null) : "Not needed", // 11
      tot_done_on: t?.tot_done_on ?? null,                                       // 12
      tot_result_expected_on: need ? (t?.tot_result_expected_on ?? null) : "Not needed", // 13
      trainer_mapped_sidh: ms(b, "trainer_mapped_sidh")?.done_on ?? ms(b, "trainer_mapped_sidh")?.due_date ?? null, // 14
      mobilization: {                                                            // 15
        status: mob?.done_on ? "Yes" : mob ? "In progress" : "Not started",
        count: memberBy.get(String(b._id)) ?? 0,
      },
      enrollment_done: ms(b, "enrollment_done")?.done_on ?? ms(b, "enrollment_done")?.due_date ?? null, // 16
      planned_start: b.planned_start ?? null,                                    // 17
      planned_end: b.planned_end ?? null,                                        // 18
    };
  });
}

// ---------- The high-level report (QA-398) ----------
// Karunn sir, 18:51: "aapki ek ye HIGH LEVEL aur doosra batch planning - bas in do mein saara kaam
// nikal jaata hai, teesri cheez ki zaroorat hi nahi." This is the first of those two.
//
// Rows are institutions, columns are job roles, and FIVE figures sit under each job role. Two of
// them come from the client's own sheet and three from our records, and the screen says which is
// which - a number whose origin is not stated is a number nobody can argue with.
//
// THE ONE MISTAKE THIS FUNCTION EXISTS TO NOT MAKE: cells are SUMMED, never assigned. A
// (centre x job role) cell can receive more than one PROGRAMME, because a programme is
// scheme-x-job-role fused while his columns are job roles alone. Writing `cell[centre][role] = v`
// is keep-last, and keep-last was measured to leave Approved looking EXACTLY RIGHT while Target
// went quietly short - so a reviewer who checks Approved, sees it reconcile, and concludes the
// report is sound is precisely the person it fools. Summing costs one character and removes the
// whole class.
// QA-527 (-175): `approved` alone cannot answer the question people actually ask of this report.
// Umesh, reading the shipped report: "ye approved location ka hai ya not approved ka, vo pata nahi
// chal raha." He is right, and the data says why. Measured on production 2026-08-21, all 55 rows:
//
//     Approved         31 rows    7,315
//     (blank)          24 rows    4,775
//     "Unapproved"      0 rows        0
//
// So the 4,775 the screen renders as "0 approved" is not a refusal by anybody. NOBODY HAS FILLED
// THOSE ROWS IN. Collapsing the two into one zero is what Karunn sir is complaining about at 13:08
// when he says leaving them blank means "koi reporting kabhi fix ho hi nahi sakti", and what he is
// asking for at 17:09: "ab usme ye bhi aa sakta hai ki approve kitne hain, NOT APPROVED kitne hain."
//
// Three buckets, and they sum back to `target` by construction - so the row can always be read as
// "of this much target, this much is approved, this much is refused, and this much nobody has said."
export type ReportCell = {
  target: number; approved: number; not_approved: number; unknown: number;
  mobilised: number; in_training: number; certified: number;
};
export type ReportRow = {
  location: { _id: string; name: string; code?: string };
  cells: Record<string, ReportCell>;   // job role -> figures
  total: ReportCell;
  // criterion 3: every row must read Target >= Mobilised >= In Training >= Certified, or SAY why
  // not. A report that silently renders an impossible row teaches people to distrust all of it.
  breaks: string[];
  // QA-562 (-177): the centre's verdict is computed HERE and sent, so the screen renders a word it
  // was given rather than deriving its own. rules.ts pulls in mongoose, so a client component
  // cannot import centreVerdict() - and a second copy in the page is exactly how the screen and
  // the Excel export would drift apart on what "Approved" means.
  verdict: ReturnType<typeof centreVerdict>;
};

const emptyCell = (): ReportCell => ({
  target: 0, approved: 0, not_approved: 0, unknown: 0, mobilised: 0, in_training: 0, certified: 0,
});
const addInto = (a: ReportCell, b: ReportCell) => {
  a.target += b.target; a.approved += b.approved; a.not_approved += b.not_approved;
  a.unknown += b.unknown; a.mobilised += b.mobilised;
  a.in_training += b.in_training; a.certified += b.certified;
};

// QA-527: the sheet's verdict on one (centre x job role) row, in three states rather than two.
// A single trimmed, case-insensitive comparison so "approved", "Approved " and "APPROVED" are the
// same answer - the value arrives from a spreadsheet a human types into, and the old strict `===`
// would have read a trailing space as "not approved". Anything that is neither of the two known
// words is `unknown`, INCLUDING a value nobody recognises: inventing a fourth bucket for it would
// hide it, and calling it "not approved" would put words in the client's mouth.
export function tcVerdict(tc_status: unknown): "approved" | "not_approved" | "unknown" {
  const s = String(tc_status ?? "").trim().toLowerCase();
  if (s === "approved") return "approved";
  if (s === "unapproved" || s === "not approved" || s === "rejected") return "not_approved";
  return "unknown";
}

// QA-552 (-176): `unknown` is a DEFAULT, so it receives a blank AND any word nobody taught this
// function. The screen labelled the whole bucket "TC Status is BLANK" - which is the same
// two-meanings-one-number defect QA-527 was raised to end, one level down and written by me while
// fixing it. It is not hypothetical: Karunn sir says "transferable" out loud at 12:31 about the
// very rows in dispute, and a sheet edit that writes it would be counted as "nobody has filled
// this in" under a label asserting exactly that.
//
// Rather than invent a fourth column for something that is currently empty, the unrecognised
// VALUES are collected and reported, so the day one appears it is visible instead of absorbed.
// QA-542/QA-562 (-177): one centre's verdict, in ONE place. The screen needs it for its column,
// its filter and its sort; the Excel export needs the same word or the file and the screen answer
// the same question differently - which is the whole disease ARCHITECTURE section 3 is about, and
// the export is exactly where a disagreement would be found last.
export function centreVerdict(c?: { target?: number; approved?: number; not_approved?: number; unknown?: number }):
  "" | "Approved" | "Not approved" | "No verdict yet" | "Mixed" {
  const t = c?.target ?? 0;
  if (!t) return "";
  if ((c?.approved ?? 0) === t) return "Approved";
  if ((c?.not_approved ?? 0) === t) return "Not approved";
  if ((c?.unknown ?? 0) === t) return "No verdict yet";
  return "Mixed";
}

export function unrecognisedTcStatus(tc_status: unknown): string | null {
  const raw = String(tc_status ?? "").trim();
  if (!raw) return null;                       // blank is a known, expected state
  return tcVerdict(raw) === "unknown" ? raw : null;
}

export async function reportRollup(scope: Record<string, unknown> = {}) {
  // find() + populate, not an aggregation over the scope filter: authz.ts builds `$in` from
  // `.map(String)`, mongoose casts strings to ObjectId inside find() but NOT inside a pipeline,
  // and four live defects came from exactly that (QA-302, QA-347, QA-350, QA-395). The
  // aggregations below only ever receive ObjectIds taken off documents we already loaded.
  const targets = await LocationTarget.find(scope)
    .populate("location", "name code")
    .populate("program", "name code scheme")
    .lean<any[]>();
  if (!targets.length) return { rows: [] as ReportRow[], roles: [] as string[], total: emptyCell(), sources: SOURCES };

  const locIds = [...new Set(targets.map((t) => t.location?._id).filter(Boolean))];
  const progIds = [...new Set(targets.map((t) => t.program?._id).filter(Boolean))];
  const key = (l: unknown, p: unknown) => `${String(l)}|${String(p)}`;

  // QA-556 (-177) - MOBILISED MEANS ENROLLED INTO A BATCH. Umesh, 2026-08-21, correcting the
  // column's stated source on the live screen: "mobilized vo hoga jo koi bhi ENROLLED hoga uss
  // batch mai. enrollment is needed."
  //
  // It used to count EVERY candidate record for the centre x job role at whatever stage, which
  // made the number "people we have typed in" rather than "people who are actually on a batch".
  // The report's own caveat had been apologising for that since -170 - "Mobilised currently tracks
  // In Training closely, because candidates are entered when they enrol" - and his instruction is
  // the resolution: stop describing the pool, count the enrolment.
  //
  // MEASURED on production before changing it, so the size of the move is known and not a
  // surprise: 252 candidate records, 251 of them on a batch roster, 209 with lifecycle Enrolled.
  // So Mobilised goes 252 -> 251 today. The point is not the one row - it is that the two columns
  // now mean two different things on purpose: Mobilised is "ever enrolled onto a batch here",
  // In training is "studying right now", and the gap between them (Failed 30, Completed 9,
  // Dropped 1) is a real funnel rather than an artefact of when a record was typed.
  //
  // `enrolled` is a lookup rather than a status test because BatchMember.status is null on every
  // one of the 251 live rows - the roster row EXISTING is the enrolment.
  const candRows = await Candidate.aggregate([
    { $match: { location: { $in: locIds }, program: { $in: progIds } } },
    { $lookup: { from: "batchmembers", localField: "_id", foreignField: "candidate", as: "bm" } },
    { $group: {
      _id: { l: "$location", p: "$program" },
      mobilised: { $sum: { $cond: [{ $gt: [{ $size: "$bm" }, 0] }, 1, 0] } },
      in_training: { $sum: { $cond: [{ $eq: ["$lifecycle_status", "Enrolled"] }, 1, 0] } },
    } },
  ]);
  const candBy = new Map(candRows.map((r: any) => [key(r._id.l, r._id.p), r]));

  // Certified = an assessment result of Pass. The screen names it that way rather than
  // "certified", because a certificate being ISSUED is a further step and conflating the two
  // would overstate the last column of every row.
  const passRows = await CandidateResult.aggregate([
    { $match: { result: "Pass" } },
    { $lookup: { from: "candidates", localField: "candidate", foreignField: "_id", as: "c" } },
    { $unwind: "$c" },
    { $match: { "c.location": { $in: locIds }, "c.program": { $in: progIds } } },
    { $group: { _id: { l: "$c.location", p: "$c.program" }, certified: { $sum: 1 } } },
  ]);
  const passBy = new Map(passRows.map((r: any) => [key(r._id.l, r._id.p), r]));

  const byLoc = new Map<string, ReportRow>();
  const roles = new Set<string>();
  const grand = emptyCell();
  // QA-552: every TC Status value this function did not recognise, and how many rows carry it.
  const unrecognised = new Map<string, number>();

  for (const t of targets) {
    if (!t.location?._id || !t.program?._id) continue;
    const role = String(t.program.name ?? "").trim() || String(t.program.code ?? "");
    roles.add(role);
    const lid = String(t.location._id);
    if (!byLoc.has(lid)) {
      byLoc.set(lid, {
        location: { _id: lid, name: t.location.name, code: t.location.code },
        cells: {}, total: emptyCell(), breaks: [], verdict: "",
      });
    }
    const row = byLoc.get(lid)!;
    if (!row.cells[role]) row.cells[role] = emptyCell();

    const c = candBy.get(key(t.location._id, t.program._id));
    const p = passBy.get(key(t.location._id, t.program._id));
    // QA-527: the sheet's own verdict, per (centre x job role) row, split three ways instead of
    // two. The target lands in exactly ONE of the three, so approved + not_approved + unknown is
    // always target and a reader can check the row adds up without being told to.
    const tgt = t.approved_target ?? 0;
    const verdict = tcVerdict(t.tc_status);
    const odd = unrecognisedTcStatus(t.tc_status);
    if (odd) unrecognised.set(odd, (unrecognised.get(odd) ?? 0) + 1);
    const one: ReportCell = {
      target: tgt,
      approved: verdict === "approved" ? tgt : 0,
      not_approved: verdict === "not_approved" ? tgt : 0,
      unknown: verdict === "unknown" ? tgt : 0,
      mobilised: c?.mobilised ?? 0,
      in_training: c?.in_training ?? 0,
      certified: p?.certified ?? 0,
    };
    // SUM. Never assign. See the note above this function.
    addInto(row.cells[role], one);
    addInto(row.total, one);
    addInto(grand, one);
  }

  const rows = [...byLoc.values()].sort((a, b) => a.location.name.localeCompare(b.location.name));
  for (const r of rows) {
    r.verdict = centreVerdict(r.total);
    for (const [role, cell] of Object.entries(r.cells)) {
      if (cell.mobilised > cell.target) r.breaks.push(`${role}: mobilised ${cell.mobilised} is more than the target ${cell.target}`);
      if (cell.in_training > cell.mobilised) r.breaks.push(`${role}: in training ${cell.in_training} is more than mobilised ${cell.mobilised}`);
      if (cell.certified > cell.in_training) r.breaks.push(`${role}: passed ${cell.certified} is more than in training ${cell.in_training}`);
    }
  }
  return {
    rows, roles: [...roles].sort(), total: grand,
    // Empty on todays data, and that is the point: the day the sheet grows a word like
    // "Transferable", it appears HERE instead of being absorbed into a bucket labelled blank.
    unrecognised_status: [...unrecognised.entries()].map(([value, rows]) => ({ value, rows })).sort((a, b) => b.rows - a.rows),
    // QA-568: the caveat carries the actual proportion rather than the word "close" (REQ-366b).
    // Computed here so it can never drift from the figures printed beside it.
    sources: {
      ...SOURCES,
      caveat: grand.mobilised
        ? `Mobilised counts everyone put on a batch (${grand.mobilised.toLocaleString("en-IN")}); In training counts the ones still studying (${grand.in_training.toLocaleString("en-IN")}) - ${Math.round((grand.in_training / grand.mobilised) * 100)}%. The rest have finished, failed or dropped out.`
        : SOURCES.caveat,
    },
  };
}

// REQ-367: every column says where it came from, on the screen. Two are the client's numbers and
// three are ours, and an argument about the report always starts with which is which.
export const SOURCES = {
  target: "Client sheet - the approved target on this centre x job role row",
  approved: "Client sheet - the same target, counted only where its TC Status reads Approved",
  // QA-527. These two exist because a single Approved figure cannot distinguish a refusal from a
  // blank, and on this data the blank is a THIRD of the target. Saying so on the screen matters
  // more than usual here: the two look identical in every export anyone has made so far.
  not_approved: "Client sheet - target on rows whose TC Status says Unapproved / Not approved / Rejected",
  unknown: "Client sheet - target on rows whose TC Status is BLANK, plus any value this report does not recognise (those are listed separately on the screen, never hidden here). Nobody has refused these; nobody has approved them either. On 2026-08-21 it was 24 of 55 rows and 4,775 of the target, all of them genuinely blank.",
  mobilised: "Our records - candidates ENROLLED onto a batch at this centre x job role. A candidate typed into the pool but not yet put on a batch is not counted.",
  in_training: "Our records - candidates whose enrolment is complete",
  certified: "Our records - candidates with a Pass assessment result (a certificate being issued is a further step)",
  // criterion 9 / REQ-366b. This has to be ON the screen, not in a footnote: today the two
  // columns are nearly the same number, and anyone reading a funnel would assume that is a finding.
  // QA-568 (-180): this line used to say Mobilised and In training were "close", and REQ-366b
  // forbids exactly that word - it asks for the FIGURE. "Close" is the reader's judgement to make
  // and the report's job to enable; a number does that and an adjective does not. reportRollup
  // computes the real percentage and overrides this at return time.
  caveat: "Mobilised counts everyone put on a batch; In training counts the ones still studying.",
} as const;

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
