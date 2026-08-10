import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { DailyLog } from "@/models";
import { assertBatchInScope, dayStart, validateDailyLog } from "@/lib/rules";
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
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const body = await req.json();
  if (!body.log_date) throw new HttpError(400, "log_date is required");
  const D = dayStart(body.log_date);
  const { roster_count, internal_present } = await validateDailyLog(id, D, {
    present_member_ids: body.present_member_ids ?? [],
    govt_present: body.govt_present ?? null,
  });
  const doc = await DailyLog.create({
    batch: id, log_date: D,
    planned_topic: body.planned_topic, actual_topic: body.actual_topic,
    present_member_ids: body.present_member_ids ?? [],
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
