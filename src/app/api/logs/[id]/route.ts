import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { DailyLog } from "@/models";
import { assertBatchInScope, canEditDailyLog, validateDailyLog } from "@/lib/rules";
import { auditDiff } from "@/lib/audit";

// PATCH edit an existing log — Rule 27 (48h window for enterer; anytime Ops/Admin; audited)
export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  const { id } = await ctx.params;
  const log = await DailyLog.findById(id);
  if (!log) throw new HttpError(404, "Log not found");
  await assertBatchInScope(user, String(log.batch)); // Rule 38
  if (!(await canEditDailyLog(log, user.id, user.role))) {
    throw new HttpError(403, "Rule 27: edit window expired — only Operations/Admin may edit now.");
  }
  const body = await req.json();
  const before = log.toObject();
  const patch: Record<string, unknown> = {};
  for (const f of ["planned_topic", "actual_topic", "present_member_ids", "govt_present", "govt_source", "govt_screenshot", "photos", "videos", "note"]) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  if (patch.present_member_ids || patch.govt_present !== undefined) {
    const check = await validateDailyLog(String(log.batch), log.log_date, {
      present_member_ids: (patch.present_member_ids as string[]) ?? log.present_member_ids.map(String),
      govt_present: (patch.govt_present as number | null) ?? log.govt_present,
    });
    patch.internal_present = check.internal_present; // Rule 29
    // Rule 28: roster_count stays frozen — deliberately NOT recomputed
  }
  Object.assign(log, patch);
  await log.save();
  await auditDiff("DailyLog", log._id, before, patch, user.id); // Rule 27: every edit audited
  return NextResponse.json({ item: log });
});
