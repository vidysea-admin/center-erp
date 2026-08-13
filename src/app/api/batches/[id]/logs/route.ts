import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { DailyLog } from "@/models";
import { assertBatchInScope, dayKey, dayRange, validateDailyLog } from "@/lib/rules";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const items = await DailyLog.find({ batch: id }).sort({ log_date: -1 }).populate("entered_by", "name").lean();
  return NextResponse.json({ items });
});

// POST create a daily log (Rules 26–32). Body: { log_date, planned_topic?, actual_topic?,
// present_member_ids: [], govt_present?, govt_source?, govt_screenshot?, photos?, videos?, note? }
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "batches.daily_log"); // togglable (2026-08-11) — the Trainer role's core right
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const body = await req.json();
  if (!body.log_date) throw new HttpError(400, "log_date is required");
  // F-008: store the calendar date itself (UTC midnight), not midnight in whatever timezone this
  // process happens to run in — otherwise the same day written by two processes is two instants.
  const D = dayKey(body.log_date);
  // Rule 27 is backed by a unique index on {batch, log_date}, which only catches an exact repeat.
  // Check the whole calendar day as well, so a row written under the old timezone-dependent
  // encoding cannot be duplicated by a new one for the same day.
  const clash = await DailyLog.findOne({ batch: id, log_date: dayRange(D) }).select("_id").lean();
  if (clash) throw new HttpError(409, "Rule 27: a log already exists for this batch on that date.");
  const { roster_count, internal_present } = await validateDailyLog(id, D, {
    present_member_ids: body.present_member_ids ?? [],
    govt_present: body.govt_present ?? null,
    trainer_present: body.trainer_present,
    biometric_member_ids: body.biometric_member_ids ?? [], // Rule 51
  });
  const doc = await DailyLog.create({
    batch: id, log_date: D,
    planned_topic: body.planned_topic, actual_topic: body.actual_topic,
    present_member_ids: body.present_member_ids ?? [],
    biometric_member_ids: body.biometric_member_ids ?? [],
    // Karunn 2026-08-13: every marking is a timestamped ROUND; the day starts with round 1.
    // Further rounds append via POST /api/logs/[id]/sessions and union into the day arrays.
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
  return NextResponse.json({ item: doc }, { status: 201 });
});
