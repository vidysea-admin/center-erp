import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { DailyLog } from "@/models";
import { assertBatchInScope, createDailyLogChecked } from "@/lib/rules";

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
// -82: the rules and the write live in rules.createDailyLogChecked — the bulk grid
// (POST /logs/bulk) goes through the same function, one day at a time.
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "batches.daily_log"); // togglable (2026-08-11) — the Trainer role's core right
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const body = await req.json();
  const doc = await createDailyLogChecked(user, id, body);
  return NextResponse.json({ item: doc }, { status: 201 });
});
