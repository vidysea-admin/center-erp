import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, HttpError } from "@/lib/authz";
import { PublicToken } from "@/models";
import { memberTrainingSummary } from "@/lib/rules";

// Public per-student attendance view (2026-08-13, Manish: "bacche baar-baar request karte hain
// sir hamein attendance dekhiye… 60 plus hona mandatory hai" — eligibility is min_attendance_pct
// of the programme's hours). Capability URL per batch member, same trust model as feedback
// links: the 32-hex token IS the credential, GET only, and the payload carries THIS member's
// days and totals only — never another student's, and no phone/PII beyond the first name the
// student already knows is theirs.
// 2026-08-13 (Umesh: "candidate ke liye bhi ek hoga jahan wo apni relevant information dekh
// payenge — ye requirement hai"): this IS that portal. The same link now carries the whole
// "My Training" picture — centre, trainer, dates, SIDH registration, exam date, result and
// certificate — still only this one candidate's own facts.

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
  await dbConnect();
  const { token } = await ctx.params;
  const t = await PublicToken.findOne({ token, purpose: "attendance", active: true }).select("batch_member").lean<any>();
  if (!t || !t.batch_member) throw new HttpError(404, "This link is not valid or has been switched off.");
  // -342: the whole computation is memberTrainingSummary (rules.ts) - the portal's "My courses" and the admin
  // candidate History read the same one. The payload below is what this page has always returned.
  const m = (await memberTrainingSummary([t.batch_member])).get(String(t.batch_member));
  if (!m || !m.batch) throw new HttpError(404, "This link is not valid or has been switched off.");

  // 2026-08-25 (Umesh, on Ashish Rana / AVP-GURU-RPLAVP-DST-03): "aur jagah se remove ho jaaye uske
  // traces." A link minted BEFORE somebody left goes on serving them a live eligibility verdict -
  // "60 plus hona mandatory hai" - for a course they are no longer on. Minting already filters
  // { batch, left_on: null }; nothing re-asked at READ time, and dropMemberChecked does not touch
  // PublicToken, so every link handed out before the drop stayed live.
  //
  // The token is NOT killed, and that is the decision rather than the shortcut. Switching the token
  // off makes the lookup above miss, which 404s, which the page renders as "this link is not valid
  // or has expired" - and a dead link explains nothing to whoever is holding it. The person holding
  // THIS link is the one human in the system who cannot ask anybody what happened. So the page still
  // answers: their own name and batch, the date they left, and nothing that implies they are still
  // training. memberTrainingSummary leaves `live` null for a departed seat, so no verdict is built.
  if (m.left_on) {
    return NextResponse.json({
      candidate: m.candidate?.name ?? null,
      batch: m.batch.code ?? null,
      program: m.program,
      centre: m.centre,
      left_on: m.left_on,
    });
  }

  const live = m.live;
  const res = m.result_row;
  // Result & certificate - the "aage kya hua" answer once the exam happens.
  return NextResponse.json({
    candidate: m.candidate?.name,
    batch: m.batch.code,
    program: m.program ?? undefined,
    batch_status: m.batch.status,
    centre: m.centre,
    trainer: m.trainer,
    start_date: m.start_date,
    end_date: m.end_date,
    sidh_status: m.candidate?.sidh_status ?? null,
    result: res ? {
      result: res.result ?? null,
      certificate_status: res.certificate_status ?? null,
      certificate_no: res.certificate_no ?? null,
      certificate_date: res.certificate_date ?? null,
      reassessment_required: !!res.reassessment_required,
      reassessment_date: res.reassessment_date ?? null,
    } : null,
    days: m.days,
    internal_days_present: m.internal_days_present,
    days_held: m.days_held,
    govt: live.govt,
    program_hours: live.program_hours,
    min_attendance_pct: live.min_attendance_pct,
    required_hours: live.required_hours,
    attended_hours: live.attended_hours,
    hours_basis: live.hours_basis, // "portal" (authoritative) | "estimate" (days x slot) | null (no slot, no import)
    // -153 cycle 2 (QA-409): a shortfall computed off OUR daily logs, told to a student whose real
    // portal hours are sitting in an unattached row, is a number that can be wrong in the direction
    // that matters most to them. While a row is waiting to be matched we owe them the situation,
    // not an arithmetic answer - so no shortfall is quoted and the page says what is happening.
    awaiting_match: live.awaiting_match,
    remaining_hours: live.remaining_hours,
    eligible: live.eligible,
    assessment_date: live.assessment_date,
  });
});
