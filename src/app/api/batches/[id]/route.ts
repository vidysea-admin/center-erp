import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { Batch, Program } from "@/models";
import { assertBatchInScope, assertRoomFreeForBatch, assertTrainerAvailableForBatch, batchHealth, computePlannedEnd, deriveTrainerStatus, batchReadiness } from "@/lib/rules";
import { auditDiff } from "@/lib/audit";

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const readiness = await batchReadiness(id); // includes populated batch
  const health = await batchHealth(id);
  return NextResponse.json({ item: readiness.batch, readiness, health });
});

export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const batch = await Batch.findById(id);
  if (!batch) throw new HttpError(404, "Batch not found");
  if (["Completed", "Cancelled"].includes(batch.status)) throw new HttpError(409, "Batch is closed.");
  const body = await req.json();
  const before = batch.toObject();

  const patch: Record<string, unknown> = {};
  for (const f of ["trainer", "room", "session", "target_size", "planned_start", "planned_end"]) {
    if (body[f] !== undefined) patch[f] = body[f];
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
  if (trainer) await assertTrainerAvailableForBatch(String(trainer), id, newStart, newEnd ?? newStart, ); // Rule 10
  if (room) await assertRoomFreeForBatch(String(room), id, newStart, newEnd ?? newStart, session); // Rule 13

  const oldTrainer = batch.trainer ? String(batch.trainer) : null;
  Object.assign(batch, patch);
  await batch.save();
  await auditDiff("Batch", batch._id, before, patch, user.id);
  if (oldTrainer && oldTrainer !== String(batch.trainer ?? "")) await deriveTrainerStatus(oldTrainer);
  if (batch.trainer) await deriveTrainerStatus(String(batch.trainer)); // Rule 12
  return NextResponse.json({ item: batch });
});
