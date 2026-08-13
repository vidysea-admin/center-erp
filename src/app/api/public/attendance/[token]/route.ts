import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, HttpError } from "@/lib/authz";
import { CandidateResult, Closure, DailyLog, GovtAttendanceRow, PublicToken } from "@/models";
import { getDefaults } from "@/lib/defaults";

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
  const t = await PublicToken.findOne({ token, purpose: "attendance", active: true })
    .populate({
      path: "batch_member",
      populate: [
        { path: "candidate", select: "name sidh_status" },
        {
          path: "batch", select: "code status slot_start slot_end actual_start planned_start planned_end trainer location",
          populate: [
            { path: "program", select: "name hours duration_days" },
            { path: "location", select: "name" },
            { path: "trainer", select: "name" },
          ],
        },
      ],
    }).lean<any>();
  if (!t || !t.batch_member) throw new HttpError(404, "This link is not valid or has been switched off.");
  const m = t.batch_member;
  const batch = m.batch;

  const logs = await DailyLog.find({ batch: batch._id }).select("log_date present_member_ids").sort({ log_date: 1 }).lean<any[]>();
  const days = logs.map((l) => ({
    date: l.log_date,
    present: (l.present_member_ids ?? []).some((x: unknown) => String(x) === String(m._id)),
  }));
  const internalDays = days.filter((d) => d.present).length;

  // Latest portal (government) figure for this candidate — cumulative as of its import date.
  const govtRow = await GovtAttendanceRow.findOne({ candidate: m.candidate?._id, match_status: "Matched" })
    .sort({ createdAt: -1 })
    .select("total_days_present total_working_days total_hours_minutes total_hours_raw createdAt")
    .lean<any>();

  const defaults = await getDefaults();
  const minPct = defaults.min_attendance_pct ?? 50;
  // Programme hours: real QP hours when recorded; duration_days × 8 (the full-day session) until then.
  const programHours = batch?.program?.hours || (batch?.program?.duration_days ?? 15) * 8;
  const requiredHours = Math.ceil((programHours * minPct) / 100);

  const toMin = (s?: string | null) => {
    const mm = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s ?? ""));
    return mm ? Number(mm[1]) * 60 + Number(mm[2]) : null;
  };
  const slotMin = (toMin(batch?.slot_end) ?? 0) - (toMin(batch?.slot_start) ?? 0);
  const hoursPerDay = slotMin > 0 ? slotMin / 60 : 8;

  // The portal's own hour meter is authoritative when present (that is what the assessor
  // settles against); the centre's day count approximates hours otherwise.
  const attendedHours = govtRow?.total_hours_minutes != null
    ? Math.round(govtRow.total_hours_minutes / 60)
    : Math.round(internalDays * hoursPerDay);

  const closure = await Closure.findOne({ batch: batch._id }).select("assessment_date").lean<any>();
  // Result & certificate — the "aage kya hua" answer once the exam happens.
  const result = await CandidateResult.findOne({ batch: batch._id, candidate: m.candidate?._id })
    .select("result certificate_status certificate_no certificate_date reassessment_required reassessment_date")
    .lean<any>();

  return NextResponse.json({
    candidate: m.candidate?.name,
    batch: batch?.code,
    program: batch?.program?.name,
    batch_status: batch?.status,
    centre: batch?.location?.name ?? null,
    trainer: batch?.trainer?.name ?? null,
    start_date: batch?.actual_start ?? batch?.planned_start ?? null,
    end_date: batch?.planned_end ?? null,
    sidh_status: m.candidate?.sidh_status ?? null,
    result: result ? {
      result: result.result ?? null,
      certificate_status: result.certificate_status ?? null,
      certificate_no: result.certificate_no ?? null,
      certificate_date: result.certificate_date ?? null,
      reassessment_required: !!result.reassessment_required,
      reassessment_date: result.reassessment_date ?? null,
    } : null,
    days,
    internal_days_present: internalDays,
    days_held: days.length,
    govt: govtRow ? {
      days_present: govtRow.total_days_present,
      working_days: govtRow.total_working_days,
      hours: govtRow.total_hours_minutes != null ? Math.round(govtRow.total_hours_minutes / 60) : null,
      hours_raw: govtRow.total_hours_raw,
      as_of: govtRow.createdAt,
    } : null,
    program_hours: programHours,
    min_attendance_pct: minPct,
    required_hours: requiredHours,
    attended_hours: attendedHours,
    remaining_hours: Math.max(0, requiredHours - attendedHours),
    eligible: attendedHours >= requiredHours,
    assessment_date: closure?.assessment_date ?? null,
  });
});
