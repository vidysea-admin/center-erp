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
  // QA-082: same strip as the create route — a Trainer never writes the govt figures.
  if (user.role === "Trainer") {
    delete body.govt_present; delete body.govt_source; delete body.govt_screenshot;
  }
  const before = log.toObject();
  const patch: Record<string, unknown> = {};
  for (const f of ["planned_topic", "actual_topic", "present_member_ids", "biometric_member_ids", "trainer_present", "govt_present", "govt_source", "govt_screenshot", "photos", "videos", "note"]) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  // 2026-08-12 audit F-007 (S1): this used to re-validate the STORED present list against the
  // CURRENT roster on every edit that touched either field. Once anyone was dropped, the stored
  // list no longer matched the roster, so entering the government attendance figure for that day
  // failed — while editing the note or the photos still worked, which made it look random.
  // Only an incoming present list needs roster validation; govt_present is bounded by the
  // roster_count frozen at save (Rules 28 and 30).
  if (patch.present_member_ids !== undefined || patch.biometric_member_ids !== undefined) {
    const present = (patch.present_member_ids as string[] | undefined) ?? (log.present_member_ids ?? []).map(String);
    const biometric = (patch.biometric_member_ids as string[] | undefined) ?? (log.biometric_member_ids ?? []).map(String);
    const check = await validateDailyLog(String(log.batch), log.log_date, {
      present_member_ids: present,
      govt_present: (patch.govt_present as number | null) ?? log.govt_present,
      trainer_present: (patch.trainer_present as boolean | undefined) ?? log.trainer_present,
      biometric_member_ids: biometric, // Rule 51 holds on the final day-level pair
    });
    patch.internal_present = check.internal_present; // Rule 29
    // QA-1047 (-243, checker on qa-235): the two lines above and below were correct on their own and
    // wrong together. `validateDailyLog` counts presence against the roster AS IT IS NOW, while
    // Rule 28 keeps `roster_count` frozen at what it was the day this log was saved. Those two agreed
    // until qa-235 let an operator TYPE a join date: back-date a late joiner onto a day whose log is
    // already frozen and today's roster for that day is larger than the number stored on the row, so
    // `internal_present` climbs straight past `roster_count` — a government-portal-facing row that can
    // read 12 present out of 6, and nothing refused it.
    //
    // The bound is `log.roster_count`, exactly as the `govt_present` branch below already does. Not
    // the live roster: the frozen number IS the record of who could have been there that day, and
    // recomputing it would be Rule 28's own defect (REQ-202: frozen, never recalculated).
    if (check.internal_present > log.roster_count) {
      throw new HttpError(400,
        `${check.internal_present} present is more than the ${log.roster_count} on the roster that day. ` +
        `Someone has been added to this batch with a joining date on or before ${new Date(log.log_date).toISOString().slice(0, 10)}, ` +
        `so they were not on the roster when this day was recorded. Correct their joining date, or drop them from this day.`);
    }
    // ...and the same day's government figure, which escaped entirely: the check below runs only in
    // the `else if`, so sending a present list AND a govt figure in one PATCH skipped Rule 30 outright.
    const gWith = (patch.govt_present as number | null | undefined) ?? log.govt_present;
    if (gWith !== undefined && gWith !== null && Number(gWith) > log.roster_count) {
      throw new HttpError(400, `Rule 30: government attendance (${Number(gWith)}) cannot exceed the ${log.roster_count} on the roster that day.`);
    }
    // Rule 28: roster_count stays frozen — deliberately NOT recomputed
    // A day-level edit is a CORRECTION, not a marking round: the day arrays are replaced as
    // given, and the correction is appended to the session history so the trail stays honest.
    patch.sessions = [...(log.sessions ?? []), { at: new Date(), present_member_ids: present, biometric_member_ids: biometric, marked_by: user.id, correction: true }];
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
