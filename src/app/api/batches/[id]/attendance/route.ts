import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError } from "@/lib/authz";
import { Batch, BatchMember, DailyLog, GovtAttendanceRow } from "@/models";
import { ELIGIBILITY_STATES, assertBatchInScope, assessmentHoursBar, awaitingMatchFor, courseIsFinished, eligibilityVerdict, memberAttendedHours, slotHoursPerDay } from "@/lib/rules";
import { nameKey, unresolvedPortalRowsByName } from "@/lib/govt-attendance";
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
    // -161 (QA-430): the phone rides along, because REQ-389's fallback needs it - the attendance
    // payload carried the portal ID and nothing else, which is why the sub-line fell back to blank.
    BatchMember.find({ batch: id }).populate("candidate", "name phone sidh_candidate_id sidh_status").lean<any[]>(),
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

  // -153 (QA-393): the query above filters `match_status: "Matched"`, which is right for computing
  // hours and is why this screen could not tell "no export arrived" from "the export is sitting
  // right here, unattached". The unattached rows are read separately and never mixed into the
  // hours - they only explain the absence.
  const awaitingByName = await unresolvedPortalRowsByName({ batchId: id, locationId: batch.location });
  // -156 (QA-439): one row cannot belong to two people, so the sentence must not say it does.
  const sameNameCount = new Map<string, number>();
  for (const m of members) {
    if (m.left_on) continue;
    const nk = nameKey(m.candidate?.name);
    if (nk) sameNameCount.set(nk, (sameNameCount.get(nk) ?? 0) + 1);
  }

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
    // -153 cycle 3 (QA-419): computed ONCE, exposed on the row, and read by every surface. It used
    // to live only inside the verdict, where the -109 journey gate hid it from not-enrolled members
    // while the other two screens showed it - one row, three answers.
    const awaiting = awaitingMatchFor({ basis: h.basis, hit: awaitingByName.get(nameKey(m.candidate?.name)) });
    return {
      member_id: mid,
      candidate_id: m.candidate?._id ?? null,
      name: m.candidate?.name ?? "(removed)",
      sidh_candidate_id: m.candidate?.sidh_candidate_id ?? null,
      phone: m.candidate?.phone ?? null,
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
        // -153 (QA-393/QA-419): the same value the row carries. The verdict keeps the -109 journey
        // gate ahead of it - a not-enrolled student gets "Not enrolled yet" as their VERDICT, which
        // is a different question from where their hours are.
        awaitingMatch: awaiting,
        sameNameMembers: sameNameCount.get(nameKey(m.candidate?.name)) ?? 1,
      }),
      // -153 cycle 3 (QA-419): the hours story, on the row, so all three surfaces read one field.
      awaiting_match: awaiting,
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
    // -153 cycle 2 (QA-413): this was a hand-typed list, and awaiting_match had to be remembered
    // into it or the -109 invariant (the buckets partition the roster) would have broken silently
    // the first time a row went unresolved. It reads the one exported state list now, so the union
    // and the buckets cannot drift apart. ("trainer" is constructed by the govt-attendance grid,
    // never returned here, so its bucket is a constant 0 on this route - present and honest.)
    // -156 (QA-432): the count the Closure line needs, and it is NOT verdict_counts.awaiting_match.
    // That bucket is journey-gated (a not-enrolled member is not_enrolled, never awaiting_match),
    // while every chip on this page reads the ungated ROW field - so the line under-reported and
    // three surfaces disagreed with it. Counting the rows is the fix; widening the bucket would
    // break the -109 partition, which is the one thing that must not move.
    awaiting_match_rows: rows.filter((r) => !r.left_on && r.awaiting_match).length,
    verdict_counts: ELIGIBILITY_STATES.reduce((acc: Record<string, number>, k) => {
      acc[k] = rows.filter((r) => !r.left_on && r.verdict.state === k).length;
      return acc;
    }, {}),
  });
});
