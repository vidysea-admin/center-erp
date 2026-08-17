import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError } from "@/lib/authz";
import { Batch, BatchMember, DailyLog, GovtAttendanceRow } from "@/models";
import { assertBatchInScope, assessmentHoursBar, courseIsFinished, eligibilityVerdict, memberAttendedHours, slotHoursPerDay } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";

// R-D (CEO 14/08): the batch's own "Attendance" tab — day-wise per student, BOTH meters
// side by side ("one is the attendance which they are taking, and second attendance from
// the government portal … number of days AND number of hours"), and the green verdict:
// once a student's hours cross the programme threshold they have "qualified for
// assessments". Readable by every role that can see the batch — the CEO wants the green
// mark "in all other logins also", so there is no extra permission gate here.
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38 — scope is the only gate

  const batch = await Batch.findById(id).populate("program", "name hours duration_days scheme").lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");

  const [members, logs, defaults] = await Promise.all([
    BatchMember.find({ batch: id }).populate("candidate", "name sidh_candidate_id sidh_status").lean<any[]>(),
    DailyLog.find({ batch: id }).select("log_date present_member_ids").sort({ log_date: 1 }).lean<any[]>(),
    getDefaults(),
  ]);

  // QA-093 (-70): scheme's ABSOLUTE min_required_hours is the bar when the master has it;
  // the Defaults pct is the honest fallback (assessmentHoursBar, one formula for every surface).
  const { requiredHours, minPct, source: minPctSource } = await assessmentHoursBar(batch.program?.scheme, batch.program, defaults.min_attendance_pct ?? 50);
  const hoursPerDay = slotHoursPerDay(batch);

  // Latest Matched portal row per candidate — cumulative as of its import.
  const candIds = members.map((m) => m.candidate?._id).filter(Boolean);
  const govtRows = await GovtAttendanceRow.find({ candidate: { $in: candIds }, match_status: "Matched" })
    .sort({ createdAt: 1 }) // ascending: the LAST write into the map wins = newest
    .select("candidate total_days_present total_working_days total_hours_minutes total_hours_raw createdAt")
    .lean<any[]>();
  const govtByCand = new Map(govtRows.map((r) => [String(r.candidate), r]));

  // -109: is this cohort still teaching? "Not eligible" is a verdict and waits for the course to be
  // over; while it runs, short hours are progress. The portal's own working-day count is the
  // cohort-level signal (it is what the file says about how far along the batch is).
  const portalWorkingDays = Math.max(0, ...govtRows.map((r) => Number(r.total_working_days ?? 0)));
  const finished = courseIsFinished(batch, portalWorkingDays);

  const days = logs.map((l) => l.log_date);
  const rows = members.map((m) => {
    const mid = String(m._id);
    const presentByDay = logs.map((l) => (l.present_member_ids ?? []).some((x: unknown) => String(x) === mid));
    const internalDays = presentByDay.filter(Boolean).length;
    const g = m.candidate ? govtByCand.get(String(m.candidate._id)) : undefined;
    // QA-070 (-70): the shared verdict (memberAttendedHours) — QA-085/086 semantics live
    // there now: green from PORTAL hours alone, no assumed 8 when the batch has no slot.
    const h = memberAttendedHours({ internalDays, hoursPerDay, govtMinutes: g?.total_hours_minutes, requiredHours });
    return {
      member_id: mid,
      candidate_id: m.candidate?._id ?? null,
      name: m.candidate?.name ?? "(removed)",
      sidh_candidate_id: m.candidate?.sidh_candidate_id ?? null,
      left_on: m.left_on ?? null,
      present_by_day: presentByDay,
      internal_days: internalDays,
      our_hours: h.our_hours,
      govt: g ? {
        days_present: g.total_days_present ?? null,
        working_days: g.total_working_days ?? null,
        hours: h.govt_hours,
        hours_raw: g.total_hours_raw ?? null,
        as_of: g.createdAt,
      } : null,
      attended_hours: h.attended_hours,
      basis: h.basis,
      qualified: h.qualified,
      // -109: the verdict, and whether it is honest to give one at all. `qualified` above stays
      // exactly as it was (portal hours ≥ bar) so every existing caller is untouched; `verdict`
      // carries the journey gate and the course-still-running gate Umesh asked for.
      verdict: eligibilityVerdict({
        enrollmentStatus: m.enrollment_status,
        sidhStatus: m.candidate?.sidh_status,
        attendedHours: h.attended_hours,
        requiredHours,
        basis: h.basis,
        courseFinished: finished,
      }),
      enrollment_status: m.enrollment_status ?? null,
    };
  });

  return NextResponse.json({
    days,
    days_held: days.length,
    members: rows,
    program_hours: batch.program?.hours || (batch.program?.duration_days ?? 15) * 8,
    min_attendance_pct: minPct,
    min_attendance_source: minPctSource, // "scheme" once the master carries hours, else "defaults"
    required_hours: requiredHours,
    hours_per_day: hoursPerDay,
    qualified_count: rows.filter((r) => r.qualified && !r.left_on).length,
    // -109: the honest breakdown, so a screen can say "23 qualified, 12 still short, 10 with no
    // hours on record, 0 genuinely not eligible" instead of lumping the last three together.
    course_finished: finished,
    portal_working_days: portalWorkingDays || null,
    verdict_counts: ["qualified", "in_progress", "no_hours", "not_eligible", "not_enrolled"].reduce((acc: Record<string, number>, k) => {
      acc[k] = rows.filter((r) => !r.left_on && r.verdict.state === k).length;
      return acc;
    }, {}),
  });
});
