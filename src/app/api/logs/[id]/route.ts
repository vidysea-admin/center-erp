import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { DailyLog } from "@/models";
import { assertBatchInScope, canEditDailyLog, validateDailyLog } from "@/lib/rules";
import { auditDiff } from "@/lib/audit";

// PATCH edit an existing log — Rule 27 (48h window for enterer; anytime Ops/Admin; audited)
export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  // 2026-08-12 audit (auth S2-13): creating a daily log requires batches.daily_log, but
  // editing one required nothing — and an edit is where the government attendance figure
  // actually gets set. Revoking the right left the back door open.
  await requirePerm(user, "batches.daily_log");
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
  for (const f of ["planned_topic", "actual_topic", "present_member_ids", "trainer_present", "govt_present", "govt_source", "govt_screenshot", "photos", "videos", "note"]) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  // 2026-08-12 audit F-007 (S1): this used to re-validate the STORED present list against the
  // CURRENT roster on every edit that touched either field. Once anyone was dropped, the stored
  // list no longer matched the roster, so entering the government attendance figure for that day
  // failed — while editing the note or the photos still worked, which made it look random.
  // Only an incoming present list needs roster validation; govt_present is bounded by the
  // roster_count frozen at save (Rules 28 and 30).
  if (patch.present_member_ids !== undefined) {
    const check = await validateDailyLog(String(log.batch), log.log_date, {
      present_member_ids: patch.present_member_ids as string[],
      govt_present: (patch.govt_present as number | null) ?? log.govt_present,
      trainer_present: (patch.trainer_present as boolean | undefined) ?? log.trainer_present,
    });
    patch.internal_present = check.internal_present; // Rule 29
    // Rule 28: roster_count stays frozen — deliberately NOT recomputed
  } else if (patch.govt_present !== undefined && patch.govt_present !== null) {
    const g = Number(patch.govt_present);
    if (!Number.isInteger(g) || g < 0) throw new HttpError(400, "Rule 30: government attendance must be a whole number of zero or more.");
    if (g > log.roster_count) {
      throw new HttpError(400, `Rule 30: government attendance (${g}) cannot exceed the ${log.roster_count} on the roster that day.`);
    }
  }
  Object.assign(log, patch);
  await log.save();
  await auditDiff("DailyLog", log._id, before, patch, user.id); // Rule 27: every edit audited
  return NextResponse.json({ item: log });
});
