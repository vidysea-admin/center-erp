import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, requireRole, locationFilter, assertLocationInScope, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, BatchMember, Candidate, Closure, Invoice, Location, Notification, Program, Trainer } from "@/models";
import { assertLocationOperational, assertRoomFreeForBatch, assertSlotWithinGuidelines, assertTrainerAvailableForBatch, batchHealth, computePlannedEnd, deriveTrainerStatus, nextBatchCode, planBatchBackward, settlementStage, trainerBookingWarnings } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";
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
    .populate("created_by", "name email")
    .lean<any[]>();
  // enrolled/target chip for the list
  const counts = await BatchMember.aggregate([
    { $match: { batch: { $in: items.map((b) => b._id) }, left_on: null } },
    { $group: { _id: "$batch", roster: { $sum: 1 }, enrolled: { $sum: { $cond: [{ $eq: ["$enrollment_status", "Completed"] }, 1, 0] } } } },
  ]);
  const byBatch = new Map(counts.map((c) => [String(c._id), c]));
  // QA-048: the post-Completed money chain, visible per row (derived from Closure+Invoice).
  const doneIds = items.filter((b) => ["Completed", "Closed"].includes(b.status)).map((b) => b._id);
  const closures = doneIds.length ? await Closure.find({ batch: { $in: doneIds } }).select("batch certification_status dues_settled").lean<any[]>() : [];
  const invoices = doneIds.length ? await Invoice.find({ batch: { $in: doneIds } }).select("batch status").lean<any[]>() : [];
  const clByB = new Map(closures.map((c) => [String(c.batch), c]));
  const invByB = new Map(invoices.map((i) => [String(i.batch), i]));
  // R-I (CEO [38:54-39:10]): a Trainer's default view is "batches assigned to ME", with the
  // rest of their centre reachable as guest faculty. is_mine marks which is which — the
  // linked Trainer profile is resolved from the login (Trainer.user), never guessed by name.
  let myTrainerId: string | null = null;
  if (user.role === "Trainer") {
    const me = await Trainer.findOne({ user: user.id }).select("_id").lean<any>();
    myTrainerId = me ? String(me._id) : null;
  }
  // Health is computed per row; the list is already capped by location scope + status filter.
  const out = await Promise.all(items.map(async (b) => ({
    ...b,
    roster_count: byBatch.get(String(b._id))?.roster ?? 0,
    enrolled_count: byBatch.get(String(b._id))?.enrolled ?? 0,
    settlement_stage: settlementStage(b.status, clByB.get(String(b._id)), invByB.get(String(b._id))),
    health: await batchHealth(String(b._id)),
    ...(user.role === "Trainer" ? { is_mine: myTrainerId != null && String(b.trainer?._id ?? b.trainer ?? "") === myTrainerId } : {}),
  })));
  return NextResponse.json({ items: out, total: out.length });
});

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "batches.manage"); // togglable (2026-08-11); default set matches the old Admin/Ops/Location gate
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
  const slot = { slot_start: body.slot_start || null, slot_end: body.slot_end || null };
  await assertSlotWithinGuidelines(slot); // 2026-08-12: 09:00–18:00, ≤4h per session
  if (trainer) await assertTrainerAvailableForBatch(trainer, null, start, end, slot); // Rule 10 + slot clash
  if (room) await assertRoomFreeForBatch(room, null, start, end, session); // Rule 13

  const defaults = await getDefaults();
  const doc = await Batch.create({
    code: await nextBatchCode(),
    location, program: programId, trainer: trainer || undefined, room: room || undefined,
    session,
    slot_start: slot.slot_start || undefined, slot_end: slot.slot_end || undefined,
    target_size: body.target_size ?? program.default_batch_size,
    planned_start: start, planned_end: end,
    // 2026-08-11: backward plan generated at creation — the checklist the boss hands out.
    milestones: planBatchBackward(start, defaults),
    created_by: user.id,
  });
  if (trainer) await deriveTrainerStatus(trainer); // Rule 12
  // 2026-08-11: booking a not-yet-Ready trainer, or one not capable at this location,
  // warns but does not block (Rule 11 gates the actual start).
  const warnings = trainer ? await trainerBookingWarnings(trainer, location) : [];
  await audit({ entity: "Batch", entityId: doc._id, newValue: "created " + doc.code, actor: user.id });

  // 2026-08-08 (both transcriptions): "Batch open hote hi inke paas aana chahiye — bhaiya tere
  // candidate pool mein 50." The centre's own people are told the batch exists and how many
  // unassigned candidates they have to fill it from, at the moment it opens — not when someone
  // happens to look. Rule 38 scoping on the inbox delivers it to exactly that centre.
  const [poolCount, locDoc] = await Promise.all([
    Candidate.countDocuments({ location, program: programId, lifecycle_status: "Unassigned" }),
    Location.findById(location).select("name").lean<any>(),
  ]);
  await Notification.create({
    type: "batch_created", severity: "info",
    message: `${doc.code} (${program.name}) opened at ${locDoc?.name ?? "your centre"} — ${poolCount} candidate${poolCount === 1 ? "" : "s"} in your pool to assign`,
    entity: "Batch", entity_id: doc._id, link: `/batches/${doc._id}?tab=Candidates`,
    location, role_target: ["Location", "Operations", "Enrollment"],
  });
  return NextResponse.json({ item: doc, ...(warnings.length ? { warning: warnings.join(" ") } : {}) }, { status: 201 });
});
