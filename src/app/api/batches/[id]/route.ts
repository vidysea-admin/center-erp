import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, BatchMember, CandidateResult, Closure, CostEntry, DailyLog, GovtAttendanceRow, Invoice, Program, Trainer } from "@/models";
import { assertBatchInScope, mergePlan, earliestPossibleStart, earliestStartNote, assertRoomFreeForBatch, assertSlotWithinGuidelines, assertTrainerAvailableForBatch, batchHealth, computePlannedEnd, deriveTrainerStatus, batchReadiness, planBatchBackward, settlementStage, trainerBookingWarnings } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";
import { audit, auditDiff } from "@/lib/audit";

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
export const DELETE = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  if (user.role !== "Admin") throw new HttpError(403, "Only an Admin may delete a batch.");
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
  if (total > 0) {
    throw new HttpError(409,
      `${batch.code} carries recorded work (${Object.entries(carried).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k.replace("_", " ")}`).join(", ")}). ` +
      `A batch with history is cancelled, never deleted — use the Cancel transition instead.`);
  }

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
  if (["Completed", "Cancelled"].includes(batch.status)) throw new HttpError(409, "Batch is closed.");
  const body = await req.json();
  const before = batch.toObject();

  const patch: Record<string, unknown> = {};
  // govt_batch_id and drive_folder_url were added to the schema but never to this list, so both
  // were unreachable through the API — written nowhere, readable nowhere. The SIDH batch id is
  // the key that links our row to the portal's, and the Drive folder is the evidence backup
  // Manish keeps in parallel with the NSDC upload; a field the API cannot write does not exist.
  for (const f of ["trainer", "room", "session", "target_size", "planned_start", "planned_end", "slot_start", "slot_end",
    "govt_batch_id", "drive_folder_url", "relevant_skills"]) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
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
  await assertSlotWithinGuidelines(slot); // slot-rules.ts: 09:00–18:00 window, exactly 4h or 8h
  if (trainer) await assertTrainerAvailableForBatch(String(trainer), id, newStart, newEnd ?? newStart, slot); // Rule 10 + slot clash
  if (room) await assertRoomFreeForBatch(String(room), id, newStart, newEnd ?? newStart, session); // Rule 13

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
