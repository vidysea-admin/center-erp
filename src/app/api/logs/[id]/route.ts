import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { DailyLog } from "@/models";
import { assertBatchInScope, canEditDailyLog, planRosterGrowth, recordRosterGrowth, validateDailyLog } from "@/lib/rules";
import type { RosterGrowth } from "@/lib/rules";
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
  let growth: RosterGrowth | null = null; // REQ-202/REQ-421, set in the present-list branch below
  for (const f of ["planned_topic", "actual_topic", "present_member_ids", "biometric_member_ids", "trainer_present", "govt_present", "govt_source", "govt_screenshot", "photos", "videos", "attendance_sheet", "note"]) {
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
    // QA-1047 / QA-1055 (-243 → 2026-08-27) — SETTLED, and the answer was the denominator, not the guard.
    //
    // QA-1047's charge was real: `validateDailyLog` counts presence against the roster AS IT IS NOW,
    // while Rule 28 froze `roster_count` at save. Back-date a member behind a frozen day and
    // `internal_present` climbed past the number stored on the row — a government-facing row reading
    // more present than it said were enrolled.
    //
    // The fix for it made the FROZEN number the bound, and that was QA-1055 (S2): `e2e.mjs` marks a
    // member present on the SAME DAY they joined, which is an ordinary, truthful thing to do — the
    // log was saved when three were enrolled, a fourth walked in that day and attended. Both doors
    // returned 400 and there was NO way left to record that day's real attendance, with a refusal
    // that advised correcting a joining date that was already correct.
    //
    // The two rules only ever disagreed because both were read as bounds. Rule 26 (REQ-119) says the
    // roster on day D is everyone with `joined_on <= D`; REQ-202 (as amended 2026-08-27 on Umesh's
    // own answer, "Us din ka count badh jaye") says the frozen count may INCREASE for exactly that
    // reason and may NEVER decrease. So the bound is `check.roster_count` — the live Rule 26 roster
    // as of `log_date`, which the validator above already computed — and the stored count rises to
    // meet it. The row reads 4 of 4. Nothing new derives Rule 26 here; nobody leaving later can
    // shrink the day, which was Rule 28's actual purpose.
    //
    // REQ-421: if that day already carries a government figure, the growth silently rewrites the
    // denominator of a number already reported. It is flagged for a person instead — never
    // resubmitted, never restated. `recordRosterGrowth` below, after the save.
    growth = planRosterGrowth(log, check.roster_count);
    if (growth.grew) Object.assign(log, growth.patch); // applied to the doc, audited by name below
    //
    // What IS fixed below, because it needed no ruling: Rule 30's bound on `govt_present` lived in an
    // `else if`, so sending a present list AND a government figure in one PATCH skipped it entirely.
    // ...and the same day's government figure, which escaped entirely: the check below runs only in
    // the `else if`, so sending a present list AND a govt figure in one PATCH skipped Rule 30 outright.
    // QA-1064: I copied Rule 30's CEILING into this branch and left its FLOOR behind, then said in a
    // release note that the check "now applies either way" — and that sentence is on the production
    // endpoint. Measured by the cycle-3 checker: `govt_present: -4` alone is a 400, the same -4 sent
    // WITH a present list was a 200, and MongoDB held -4 against roster_count 2, rendering "-4/2
    // (-200%)". 1.5 stored the same way. Both halves live in the `else if` below and only one made the
    // journey. That is the fourth time today a guard was written down and then walked past, and the
    // third time it was me. Both branches now ask the same three questions, in the same order.
    // QA-1106: the merged read is deliberate — `validateDailyLog` above judges the merged value too, so
    // guarding only what was SENT would let this route accept a day the validator would reject. But the
    // consequence I had not thought through: a log already holding a bad figure — one this very bug
    // wrote before it was fixed — then refuses an edit to the PRESENT LIST, over a number the operator
    // did not type and cannot see in their own request. "Cannot exceed" about someone else's mistake is
    // the hour-costing kind of refusal. So the guard stays, and the message changes: when the offending
    // value is the STORED one, say that, and name the repair.
    const gSent = patch.govt_present as number | null | undefined;
    const gWith = gSent ?? log.govt_present;
    if (gWith !== undefined && gWith !== null) {
      const g = Number(gWith);
      const stored = gSent === undefined || gSent === null;
      const origin = stored
        ? `The government attendance already recorded for this day (${g}) `
        // QA-1106 ka jumla, bina ledger code ke. `Rule 30: ` yahan likhne ka koi faayda tha hi
        // nahi: `apiHandler` (authz.ts:105-108) har HttpError ko `plain()` se guzarta hai aur
        // ledger code wahin gir jaata hai — chokepoint ka poora maqsad yahi hai. To wo code kabhi
        // kisi user tak pahuncha hi nahi; usne sirf do kaam kiye — `-111` ka static wall check
        // toda (kyunki ye literal ek const me jaata hai, seedha throw me nahi, is liye pin use
        // "thrown" nahi pehchaan paata), aur FL19 ko ek aisi string par khada kar diya jo
        // architecture ke hisaab se response me aa hi nahi sakti thi.
        : `Government attendance (${g}) `;
      const repair = stored ? " Correct that figure in the same edit to save this day." : "";
      if (!Number.isInteger(g) || g < 0) {
        throw new HttpError(400, `${origin}must be a whole number of zero or more.${repair}`);
      }
      if (g > log.roster_count) {
        throw new HttpError(400, `${origin}cannot exceed the ${log.roster_count} on the roster that day.${repair}`);
      }
    }
    // REQ-202: roster_count moved above if the day's real Rule 26 roster is now larger — never down.
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
  // REQ-201 audit row for the denominator itself + REQ-421's review item, only once the write
  // actually landed. `roster_count` is deliberately NOT in `patch` above, so this is the single
  // place that records it — auditDiff cannot also write it and produce two rows for one change.
  if (growth) await recordRosterGrowth(log, growth, user.id);
  return NextResponse.json({ item: log });
});
