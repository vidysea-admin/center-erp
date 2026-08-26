import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, BatchMember, CandidateResult, Closure, CostEntry, DailyLog, GovtAttendanceRow, Invoice, Program, Trainer } from "@/models";
import { assertBatchInScope, mergePlan, earliestPossibleStart, earliestStartNote, assertRoomFreeForBatch, assertSlotWithinGuidelines, assertTrainerAvailableForBatch, batchHealth, computePlannedEnd, deriveTrainerStatus, batchReadiness, govtBatchIdConflict, planBatchBackward, settlementStage, trainerBookingWarnings } from "@/lib/rules";
import { canonicalGovtBatchId } from "@/lib/validate";
import { getDefaults } from "@/lib/defaults";
import { audit, auditDiff } from "@/lib/audit";

// The fields this door may write. ONE list, because two consumers now read it: the assignment loop
// in PATCH, and the closed-batch test right above it. A second hand-written copy of these names is
// how "what can be patched" ends up meaning two different things inside one function.
const PATCHABLE = ["trainer", "room", "session", "target_size", "planned_start", "planned_end", "slot_start", "slot_end",
  "govt_batch_id", "drive_folder_url", "relevant_skills"];

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const readiness = await batchReadiness(id); // includes populated batch
  const health = await batchHealth(id);
  // QA-048: the post-Completed money stage rides the detail payload too.
  const st = ["Completed", "Closed"].includes(readiness.batch.status)
    ? settlementStage(readiness.batch.status,
        await Closure.findOne({ batch: id }).select("certification_status dues_settled").lean(),
        await Invoice.findOne({ batch: id }).select("status").lean())
    : null;
  return NextResponse.json({ item: readiness.batch, readiness, health, settlement_stage: st });
});

// 2026-08-14 (Umesh): "agar data ka koi source nahi hai toh remove that." The 13/08 seed
// generated batch rows per centre×job-role that never came from any sheet and never got a
// roster — they inflate every count, sit in Preparation as blockers, and put a Completed
// batch with zero students on the board. A batch that carries ANY real record is business
// history and is CANCELLED, never deleted; only an empty shell can be removed, and the
// endpoint proves emptiness itself rather than trusting the caller.
export const DELETE = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  // 2026-08-24 (Umesh): "delete krne ka option dena hai team ko … but vo bhi respective acess wale
  // persons." This verb was never missing - it was shut behind a hard-coded Admin test, so the team
  // saw no button and reported the feature as absent. It is a togglable right now, so an Admin can
  // grant or revoke it per role and per person from the Permissions matrix.
  //
  // EVERY SAFETY REFUSAL BELOW IS UNCHANGED. Widening WHO may press the verb is not a reason to
  // soften WHAT it refuses - if anything it is the reason not to, because more people can now reach it.
  //
  // QA-1437 (checker, cycle 1 FAIL): the permission check used to run here, UNCONDITIONALLY,
  // before the total>0 branch below ever got a chance to check batches.delete_with_data instead —
  // so an actor needed BOTH rights to ever force-delete a non-empty batch, contradicting this
  // unit's own "holding one does not imply the other" design and the catalog's own label. Fixed by
  // moving the check past the carried-work count and branching on which right applies.
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const batch = await Batch.findById(id).select("code status location program").lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");

  const [members, results, costs, logs, closures, govtRows, invoices] = await Promise.all([
    BatchMember.countDocuments({ batch: id }),
    CandidateResult.countDocuments({ batch: id }),
    CostEntry.countDocuments({ batch: id }),
    DailyLog.countDocuments({ batch: id }),
    Closure.countDocuments({ batch: id }),
    GovtAttendanceRow.countDocuments({ batch: id }),
    Invoice.countDocuments({ batch: id }),
  ]);
  const carried = { members, results, costs, logs, closures, govt_rows: govtRows, invoices };
  const total = Object.values(carried).reduce((a, n) => a + n, 0);
  const breakdown = Object.entries(carried).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k.replace("_", " ")}`).join(", ");
  if (total > 0) {
    // 2026-08-25 (Umesh, feedback-inbox): a batch created by mistake (e.g. for a test) and then
    // populated with data could only be Cancelled, never removed. batches.delete_with_data is a
    // SEPARATE, narrower-grantable right from batches.delete — holding it ALONE is sufficient for
    // this branch (QA-1437) — and a reason is required, same as every other force-past-history verb
    // in this file (see complete/route.ts's own reason requirement).
    let canForce = false;
    try { await requirePerm(user, "batches.delete_with_data"); canForce = true; } catch { canForce = false; }
    if (!canForce) {
      throw new HttpError(409,
        `${batch.code} carries recorded work (${breakdown}). ` +
        `A batch with history is cancelled, never deleted — use the Cancel transition instead.`);
    }
    let reason = "";
    try { const body = await req.json(); reason = String(body?.reason ?? "").trim().slice(0, 500); } catch { /* no body */ }
    if (!reason) throw new HttpError(400, "Say why this batch is being force-deleted with recorded work still on it — it is recorded against every row this removes.");
    await Promise.all([
      BatchMember.deleteMany({ batch: id }),
      CandidateResult.deleteMany({ batch: id }),
      CostEntry.deleteMany({ batch: id }),
      DailyLog.deleteMany({ batch: id }),
      Closure.deleteMany({ batch: id }),
      GovtAttendanceRow.deleteMany({ batch: id }),
      Invoice.deleteMany({ batch: id }),
    ]);
    await Batch.deleteOne({ _id: id });
    await audit({ entity: "Batch", entityId: id, field: "delete", newValue: `${batch.code} (${batch.status}) FORCE-deleted with recorded work (${breakdown}) — reason: ${reason}`, actor: user.id });
    return NextResponse.json({ deleted: batch.code, forced: true, carried });
  }

  await requirePerm(user, "batches.delete");
  await Batch.deleteOne({ _id: id });
  await audit({ entity: "Batch", entityId: id, field: "delete", newValue: `${batch.code} (${batch.status}) deleted — empty shell, no members/results/costs/logs/closure/attendance/invoice`, actor: user.id });
  return NextResponse.json({ deleted: batch.code });
});

export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "batches.manage"); // togglable (2026-08-11)
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const batch = await Batch.findById(id);
  if (!batch) throw new HttpError(404, "Batch not found");
  const body = await req.json();
  // A closed batch is frozen - with ONE exception, and the portal's own timing is what demands it:
  // SIDH issues the batch ID at or after completion, so the single status in which that id actually
  // arrives was the one status in which this door refused to record it. The batch page has been
  // NAGGING for it on Completed batches the whole time (batches/[id]/page.tsx: "Still missing on
  // this finished batch: the SIDH batch ID - fill them below") over a form whose Save then 409'd.
  //
  // Umesh, asked directly with both options on the table, chose ADMIN ONLY for this exception.
  //
  // The test is on what the REQUEST asks to change, never on what the caller says it is doing.
  // `location` and `program` are in the list even though they are handled separately further down -
  // without them a body carrying {govt_batch_id, location} reads as id-only and walks a centre
  // change straight through the freeze. `asked.length > 0` keeps an empty body at 409 rather than
  // letting it answer 200 having done nothing.
  const closed = ["Completed", "Cancelled"].includes(batch.status);
  const asked = [...PATCHABLE, "location", "program"].filter((f) => body[f] !== undefined);
  const idOnly = asked.length > 0 && asked.every((f) => f === "govt_batch_id");
  if (closed && !(idOnly && user.role === "Admin")) {
    throw new HttpError(409, idOnly
      ? "Batch is closed - only an Admin can still record its SIDH batch ID."
      : "Batch is closed.");
  }
  const before = batch.toObject();

  const patch: Record<string, unknown> = {};
  // govt_batch_id and drive_folder_url were added to the schema but never to this list, so both
  // were unreachable through the API — written nowhere, readable nowhere. The SIDH batch id is
  // the key that links our row to the portal's, and the Drive folder is the evidence backup
  // Manish keeps in parallel with the NSDC upload; a field the API cannot write does not exist.
  for (const f of PATCHABLE) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  // QA-1287: the SIDH batch id is normalised through the SAME helper the create door uses, so the
  // two cannot drift into two ideas of what a blank means. Blank must land as `null`, never `""` —
  // an empty string is a value: it reads back as "there is an id here" and a duplicate check would
  // then match every blank batch against every other.
  if (patch.govt_batch_id !== undefined) patch.govt_batch_id = canonicalGovtBatchId(patch.govt_batch_id);
  // QA-133: operator-picked list, recorded, never a filter — but never a free-form blob either.
  if (patch.relevant_skills !== undefined) {
    if (!Array.isArray(patch.relevant_skills)) throw new HttpError(400, "relevant_skills must be a list of skill names.");
    patch.relevant_skills = patch.relevant_skills.filter((s: unknown) => typeof s === "string" && (s as string).trim()).slice(0, 50);
  }

  // Sheet-imported batches can carry a wrong fuzzy match for centre or job role. Both are
  // correctable, but only while the batch is still Planning with an empty roster — after that,
  // rosters/conflict checks/readiness have all been computed against the old pair.
  if (body.location !== undefined || body.program !== undefined) {
    const rosterCount = await BatchMember.countDocuments({ batch: id });
    if (batch.status !== "Planning" || rosterCount > 0) {
      throw new HttpError(409, "Location/program can only be changed while the batch is in Planning with an empty roster.");
    }
    if (body.location !== undefined) patch.location = body.location;
    if (body.program !== undefined) patch.program = body.program;
  }

  const newStart = patch.planned_start ? new Date(patch.planned_start as string) : batch.planned_start;
  let newEnd = patch.planned_end ? new Date(patch.planned_end as string) : batch.planned_end;
  // Rule 15: recompute planned_end when planned_start changes (unless explicitly set)
  if (patch.planned_start && !patch.planned_end) {
    const program = await Program.findById(batch.program).lean<any>();
    newEnd = computePlannedEnd(newStart, program);
    patch.planned_end = newEnd;
  }
  const session = (patch.session as string) ?? batch.session;
  const trainer = patch.trainer !== undefined ? patch.trainer : batch.trainer;
  const room = patch.room !== undefined ? patch.room : batch.room;
  const slot = {
    slot_start: (patch.slot_start as string | undefined) ?? batch.slot_start,
    slot_end: (patch.slot_end as string | undefined) ?? batch.slot_end,
  };
  // Every refusal here is about a request that MOVES the schedule. Reaching this line with `closed`
  // true means the Admin id-only carve-out above, where nothing about the schedule is changing - and
  // running them anyway would fail that edit for reasons it has nothing to do with: a legacy batch
  // whose stored slot is not exactly 4h or 8h answers 400 (slot-rules.ts), and a trainer who has
  // since been given a LIVE batch at the same hour answers 409 (Rule 10). Neither is a statement
  // about the id being typed.
  if (!closed) {
    await assertSlotWithinGuidelines(slot); // slot-rules.ts: 09:00–18:00 window, exactly 4h or 8h
    if (trainer) await assertTrainerAvailableForBatch(String(trainer), id, newStart, newEnd ?? newStart, slot); // Rule 10 + slot clash
    if (room) await assertRoomFreeForBatch(String(room), id, newStart, newEnd ?? newStart, session); // Rule 13
  }

  // Backward plan follows the start date while the batch is still being planned; once
  // Ready/Active the dates are history and stay put.
  if (patch.planned_start && batch.status === "Planning" && batch.plan_enabled) { // QA-152: only a requested plan follows the date
    // QA-460 (-164): follow the trainer this PATCH is LEAVING the batch with, not the one it had
    // — assigning a certified trainer is precisely when the TOT rows should disappear.
    const nextTrainer = trainer ?? batch.trainer;
    const planTrainer = nextTrainer
      ? await Trainer.findById(nextTrainer).select("pipeline_status tot_done_on").lean<any>()
      : null;
    // QA-504: this is the exact path the checker measured the data loss on - certify the trainer,
    // edit the start date, and a ticked tot_done with its note was gone. mergePlan keeps it.
    patch.milestones = mergePlan(
      batch.milestones ?? [],
      planBatchBackward(newStart, await getDefaults(), { trainer: planTrainer }),
    );
  }

  const oldTrainer = batch.trainer ? String(batch.trainer) : null;
  Object.assign(batch, patch);
  await batch.save();
  await auditDiff("Batch", batch._id, before, patch, user.id);
  if (oldTrainer && oldTrainer !== String(batch.trainer ?? "")) await deriveTrainerStatus(oldTrainer);
  if (batch.trainer) await deriveTrainerStatus(String(batch.trainer)); // Rule 12
  const warnings = patch.trainer && batch.trainer ? await trainerBookingWarnings(String(batch.trainer), batch.location) : [];
  // QA-1289: same warning as create, and `id` excludes this batch so re-saving an unchanged field
  // never warns about itself.
  if (patch.govt_batch_id !== undefined) {
    const clash = await govtBatchIdConflict(patch.govt_batch_id as string | null, id);
    if (clash) warnings.push(`SIDH batch ID ${patch.govt_batch_id} is already recorded on batch ${clash}. Saved — check the portal if that was not intended.`);
  }
  // QA-139: reschedules are exactly where a too-early start sneaks in — same warning as create.
  // QA-509 (-168): the third of four copies. Same one definition as the create door now, so a
  // reschedule and a create cannot disagree about the same centre on the same day.
  if (patch.planned_start || patch.trainer !== undefined) {
    const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const eps = await earliestPossibleStart(batch.location, { trainerId: batch.trainer ?? undefined });
    if (eps.blocked || day(new Date(batch.planned_start)) < day(eps.date)) {
      warnings.push(`Planned start ${new Date(batch.planned_start).toLocaleDateString("en-IN")} is before the earliest possible start ${eps.date.toLocaleDateString("en-IN")} (${earliestStartNote(eps)}).`);
    }
  }
  return NextResponse.json({ item: batch, ...(warnings.length ? { warning: warnings.join(" ") } : {}) });
});
