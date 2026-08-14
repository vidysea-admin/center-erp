import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, BatchMember, CandidateResult, Closure, CostEntry, DailyLog, GovtAttendanceRow, Invoice, Program } from "@/models";
import { assertBatchInScope, assertRoomFreeForBatch, assertSlotWithinGuidelines, assertTrainerAvailableForBatch, batchHealth, computePlannedEnd, deriveTrainerStatus, batchReadiness, planBatchBackward, trainerBookingWarnings } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";
import { audit, auditDiff } from "@/lib/audit";

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const readiness = await batchReadiness(id); // includes populated batch
  const health = await batchHealth(id);
  return NextResponse.json({ item: readiness.batch, readiness, health });
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
    "govt_batch_id", "drive_folder_url"]) {
    if (body[f] !== undefined) patch[f] = body[f];
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
  await assertSlotWithinGuidelines(slot); // 2026-08-12: 09:00–18:00, ≤4h per session
  if (trainer) await assertTrainerAvailableForBatch(String(trainer), id, newStart, newEnd ?? newStart, slot); // Rule 10 + slot clash
  if (room) await assertRoomFreeForBatch(String(room), id, newStart, newEnd ?? newStart, session); // Rule 13

  // Backward plan follows the start date while the batch is still being planned; once
  // Ready/Active the dates are history and stay put.
  if (patch.planned_start && batch.status === "Planning") {
    const doneByKey = new Map((batch.milestones ?? []).map((m: any) => [m.key, m]));
    patch.milestones = planBatchBackward(newStart, await getDefaults()).map((m) => ({
      ...m,
      done_on: (doneByKey.get(m.key) as any)?.done_on,
      done_by: (doneByKey.get(m.key) as any)?.done_by,
    }));
  }

  const oldTrainer = batch.trainer ? String(batch.trainer) : null;
  Object.assign(batch, patch);
  await batch.save();
  await auditDiff("Batch", batch._id, before, patch, user.id);
  if (oldTrainer && oldTrainer !== String(batch.trainer ?? "")) await deriveTrainerStatus(oldTrainer);
  if (batch.trainer) await deriveTrainerStatus(String(batch.trainer)); // Rule 12
  const warnings = patch.trainer && batch.trainer ? await trainerBookingWarnings(String(batch.trainer), batch.location) : [];
  return NextResponse.json({ item: batch, ...(warnings.length ? { warning: warnings.join(" ") } : {}) });
});
