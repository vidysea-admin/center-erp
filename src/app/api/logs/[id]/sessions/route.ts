import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { DailyLog } from "@/models";
import { assertBatchInScope, dayKey, istToday, planRosterGrowth, recordRosterGrowth, validateDailyLog } from "@/lib/rules";
import { audit } from "@/lib/audit";

// POST append a MARKING ROUND to a day's log (Karunn 2026-08-13: "din mein do baar, teen
// baar, jitni baar bhi P-P-P, timestamp ke saath"). A round unions INTO the day-level
// arrays — a student present in any round was present that day — so every existing
// consumer (counts, govt compare, gap queue) keeps reading the same fields. Rule 51
// (biometric ⊆ present) is checked on the round AND holds on the resulting union.
// Body: { present_member_ids: [], biometric_member_ids?: [] }
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "batches.daily_log"); // the Trainer role's core right
  const { id } = await ctx.params;
  const log = await DailyLog.findById(id);
  if (!log) throw new HttpError(404, "Log not found");
  await assertBatchInScope(user, String(log.batch)); // Rule 38 — a trainer marks only their own batch
  // A round is LIVE marking, not an edit: any scoped batches.daily_log holder (the trainer,
  // whoever opened the day) may add one ON THE DAY ITSELF. Anything later is a backdated
  // correction and goes through Edit, which Rule 27 restricts to Ops/Admin.
  // QA-081: "today" is the IST calendar date everywhere — at 1am IST the server's UTC day
  // is still yesterday, which would have refused a trainer's perfectly-on-time round.
  if (istToday().getTime() !== dayKey(log.log_date).getTime() && user.role !== "Admin" && user.role !== "Operations") {
    throw new HttpError(403, "Marking rounds are same-day only — for an earlier date use Edit (Operations/Admin).");
  }
  const body = await req.json();
  const roundPresent: string[] = (body.present_member_ids ?? []).map(String);
  const roundBiometric: string[] = (body.biometric_member_ids ?? []).map(String);
  if (!roundPresent.length && !roundBiometric.length) {
    throw new HttpError(400, "A marking round needs at least one student marked.");
  }

  // The union the day will hold after this round — validated as a whole (roster Rule 29,
  // trainer-present portal rule, biometric Rule 51), so a bad round cannot corrupt the day.
  const dayPresent = [...new Set([...(log.present_member_ids ?? []).map(String), ...roundPresent])];
  const dayBiometric = [...new Set([...(log.biometric_member_ids ?? []).map(String), ...roundBiometric])];
  const check = await validateDailyLog(String(log.batch), log.log_date, {
    present_member_ids: dayPresent,
    govt_present: log.govt_present,
    trainer_present: log.trainer_present,
    biometric_member_ids: dayBiometric,
  });

  // QA-1047 / QA-1055 (settled 2026-08-27): the guard that briefly lived here refused any round whose
  // union pushed `internal_present` past the FROZEN `roster_count`, and a marking round is same-day
  // only — which is EXACTLY the case it got wrong: a member who joined today, marked present today,
  // on a log frozen earlier today. REQ-202 (amended) now says that day's count may rise to admit them
  // (REQ-119/Rule 26 says they were genuinely on that day's roster) and may never fall. The bound is
  // therefore `check.roster_count` — the live Rule 26 roster as of `log_date` that `validateDailyLog`
  // above already computed. Same call as the day-edit door: one decision, one implementation
  // (ARCHITECTURE §3). REQ-421's review flag rides along for a day that already carries a government
  // figure. Full reasoning in logs/[id]/route.ts.
  const growth = planRosterGrowth(log, check.roster_count);
  if (growth.grew) Object.assign(log, growth.patch);
  log.sessions.push({ at: new Date(), present_member_ids: roundPresent, biometric_member_ids: roundBiometric, marked_by: user.id } as any);
  log.present_member_ids = dayPresent as any;
  log.biometric_member_ids = dayBiometric as any;
  log.internal_present = check.internal_present; // Rule 29 on the union
  await log.save();
  await audit({ entity: "DailyLog", entityId: log._id, field: "session", newValue: `round ${log.sessions.length}: ${roundPresent.length} present, ${roundBiometric.length} biometric`, actor: user.id });
  await recordRosterGrowth(log, growth, user.id); // REQ-201 audit row + REQ-421 review item
  return NextResponse.json({ item: log }, { status: 201 });
});
