import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, requireRole, locationFilter, assertLocationInScope, HttpError } from "@/lib/authz";
import { Batch, BatchMember, Program } from "@/models";
import { assertLocationOperational, assertRoomFreeForBatch, assertTrainerAvailableForBatch, computePlannedEnd, deriveTrainerStatus, nextBatchCode } from "@/lib/rules";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  const sp = req.nextUrl.searchParams;
  const filter: Record<string, unknown> = { ...locationFilter(user) };
  for (const k of ["program", "status", "trainer"]) {
    const v = sp.get(k);
    if (v) filter[k] = v;
  }
  const loc = sp.get("location");
  if (loc) {
    assertLocationInScope(user, loc); // client filter may narrow scope, never widen it
    filter.location = loc;
  }
  const items = await Batch.find(filter)
    .sort({ createdAt: -1 })
    .populate("location", "name code")
    .populate("program", "name code duration_days")
    .populate("trainer", "name")
    .populate("room", "name type")
    .lean<any[]>();
  // enrolled/target chip for the list
  const counts = await BatchMember.aggregate([
    { $match: { batch: { $in: items.map((b) => b._id) }, left_on: null } },
    { $group: { _id: "$batch", roster: { $sum: 1 }, enrolled: { $sum: { $cond: [{ $eq: ["$enrollment_status", "Completed"] }, 1, 0] } } } },
  ]);
  const byBatch = new Map(counts.map((c) => [String(c._id), c]));
  const out = items.map((b) => ({ ...b, roster_count: byBatch.get(String(b._id))?.roster ?? 0, enrolled_count: byBatch.get(String(b._id))?.enrolled ?? 0 }));
  return NextResponse.json({ items: out, total: out.length });
});

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin", "Operations", "Location"); // batch planning is not an Enrollment action (§6)
  requireEdit(user);
  const body = await req.json();
  const { location, program: programId, trainer, room, session = "Full Day", planned_start } = body;
  if (!location || !programId || !planned_start) throw new HttpError(400, "location, program and planned_start are required");
  assertLocationInScope(user, location);
  await assertLocationOperational(location, "Creating a batch"); // Rule 1
  const program = await Program.findById(programId).lean<any>();
  if (!program) throw new HttpError(400, "Program not found");

  const start = new Date(planned_start);
  const end = computePlannedEnd(start, program); // Rule 15
  if (trainer) await assertTrainerAvailableForBatch(trainer, null, start, end); // Rule 10
  if (room) await assertRoomFreeForBatch(room, null, start, end, session); // Rule 13

  const doc = await Batch.create({
    code: await nextBatchCode(),
    location, program: programId, trainer: trainer || undefined, room: room || undefined,
    session,
    target_size: body.target_size ?? program.default_batch_size,
    planned_start: start, planned_end: end,
    created_by: user.id,
  });
  if (trainer) await deriveTrainerStatus(trainer); // Rule 12
  await audit({ entity: "Batch", entityId: doc._id, newValue: "created " + doc.code, actor: user.id });
  return NextResponse.json({ item: doc }, { status: 201 });
});
