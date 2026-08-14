import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, assertLocationInScope, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, BatchMember, Closure, LocationTarget, Program } from "@/models";
import { capacitySummary, trainerCountsFor } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";
import { requireApproval } from "@/lib/approvals";
import { audit } from "@/lib/audit";

// GET: targets for a location with capacity math (§5)
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  assertLocationInScope(user, id);
  const targets = await LocationTarget.find({ location: id }).populate("program").lean<any[]>();
  const defaults = await getDefaults();

  // RPL M1: Completed / Remaining are system-calculated, never typed. Both bases are shown
  // because they answer different questions — enrolled = progress, certified = billable.
  const items = await Promise.all(targets.map(async (t) => {
    const batches = await Batch.find({ location: id, program: t.program?._id ?? t.program }).select("_id status").lean<any[]>();
    const batchIds = batches.map((b) => b._id);
    const enrolled = batchIds.length
      ? await BatchMember.countDocuments({ batch: { $in: batchIds }, enrollment_status: "Completed" })
      : 0;
    const closures = batchIds.length
      ? await Closure.find({ batch: { $in: batchIds } }).select("certificates_issued").lean<any[]>()
      : [];
    const certified = closures.reduce((s, c) => s + (c.certificates_issued ?? 0), 0);

    // 2026-08-12: the two client sheets already disagree about how many trainers are nominated
    // and certified (23 vs 20, 18 vs 16). Rather than pick a winner, the ERP derives its own
    // figure by counting Trainer rows and reports it BESIDE what the sheet claims, with the
    // variance named. That is what Person 1 meant by "teeno sheet ka crossverify karega hamesha"
    // — the sheet becomes a cross-check, not a rival master. Never write theirs over ours.
    const tc = t.program ? await trainerCountsFor(id, t.program?._id ?? t.program) : null;
    const trainers = tc && {
      required: t.trainers_required ?? null,
      nominated: tc.nominated,
      certified: tc.certified,
      in_pipeline: tc.in_pipeline,
      shortfall: t.trainers_required != null ? Math.max(0, t.trainers_required - tc.certified) : null,
    };

    return {
      ...t,
      capacity: t.program ? capacitySummary(t.approved_target, t.program, defaults.max_concurrent_batches) : null,
      trainers,
      // What the client's own sheet says, kept separate and never merged into our figures.
      reported: {
        enrolled: t.enrolled_reported ?? null,
        pending: t.pending_reported ?? null,
        // A non-zero variance is the thing to look at: our count and theirs have drifted apart.
        enrolled_variance: t.enrolled_reported != null ? enrolled - t.enrolled_reported : null,
      },
      achieved: {
        batches_created: batches.length,
        enrolled,
        certified,
        remaining_by_enrolled: Math.max(0, (t.approved_target ?? 0) - enrolled),
        remaining_by_certified: Math.max(0, (t.approved_target ?? 0) - certified),
      },
    };
  }));
  return NextResponse.json({ items });
});

// PUT: upsert a target row { program, approved_target?, allocated_target?, start_date?, end_date? }
export const PUT = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  // Approved targets are contract numbers; can_edit alone was the only gate here (audit 2026-08-13).
  await requirePerm(user, "locations.manage");
  const { id } = await ctx.params;
  assertLocationInScope(user, id);
  const body = await req.json();
  if (!body.program) throw new HttpError(400, "program is required");
  const program = await Program.findById(body.program).lean<any>();
  if (!program) throw new HttpError(400, "Program not found");
  const set: Record<string, unknown> = {};
  // 2026-08-12: the client sheet also states how many trainers this centre x job role needs, and
  // what they believe is already enrolled — kept separate from our own computed figure.
  // tc_id/tc_status: per-row government identity (2026-08-13, "31 approved") — editable so a
  // fresh approval reaches the board without waiting for the next sheet sync.
  for (const f of ["approved_target", "allocated_target", "start_date", "end_date",
    "trainers_required", "enrolled_reported", "pending_reported", "tc_id", "tc_status",
    // 2026-08-13 (Karunn): the sheet's claimed trainer counts — soft data kept beside ours.
    "nominations_received_reported", "nominated_nsdc_reported", "trainers_certified_reported"]) {
    if (body[f] !== undefined) set[f] = body[f];
  }
  // R-F (CEO 14/08 [36:55]): "a location is now approved for a certain program — they
  // should be able to do that … let us send it for the approval to the admin." A centre
  // login's target change parks; the row is written by the approval replay.
  if (user.role === "Location") {
    const gate = await requireApproval("location.edit", user, {
      entity: "Location", entity_id: id, location: id,
      summary: `${user.name} suggests a target change (${program.name}): ${Object.keys(set).join(", ")}`,
      payload: { target: { program: body.program, set } },
    });
    if (gate) return NextResponse.json({ queued: true, item: gate.request }, { status: 202 });
  }
  const doc = await LocationTarget.findOneAndUpdate(
    { location: id, program: body.program },
    { $set: set },
    { upsert: true, new: true },
  );
  await audit({ entity: "LocationTarget", entityId: doc._id, field: "target", newValue: set, actor: user.id });
  return NextResponse.json({ item: doc });
});
