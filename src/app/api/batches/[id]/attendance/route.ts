import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError } from "@/lib/authz";
import { Batch, BatchMember, DailyLog, GovtAttendanceRow } from "@/models";
import { assertBatchInScope, requiredAssessmentHours, slotHoursPerDay } from "@/lib/rules";
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

  const batch = await Batch.findById(id).populate("program", "name hours duration_days").lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");

  const [members, logs, defaults] = await Promise.all([
    BatchMember.find({ batch: id }).populate("candidate", "name sidh_candidate_id").lean<any[]>(),
    DailyLog.find({ batch: id }).select("log_date present_member_ids").sort({ log_date: 1 }).lean<any[]>(),
    getDefaults(),
  ]);

  const minPct = defaults.min_attendance_pct ?? 50;
  const requiredHours = requiredAssessmentHours(batch.program, minPct);
  const hoursPerDay = slotHoursPerDay(batch);

  // Latest Matched portal row per candidate — cumulative as of its import.
  const candIds = members.map((m) => m.candidate?._id).filter(Boolean);
  const govtRows = await GovtAttendanceRow.find({ candidate: { $in: candIds }, match_status: "Matched" })
    .sort({ createdAt: 1 }) // ascending: the LAST write into the map wins = newest
    .select("candidate total_days_present total_working_days total_hours_minutes total_hours_raw createdAt")
    .lean<any[]>();
  const govtByCand = new Map(govtRows.map((r) => [String(r.candidate), r]));

  const days = logs.map((l) => l.log_date);
  const rows = members.map((m) => {
    const mid = String(m._id);
    const presentByDay = logs.map((l) => (l.present_member_ids ?? []).some((x: unknown) => String(x) === mid));
    const internalDays = presentByDay.filter(Boolean).length;
    const g = m.candidate ? govtByCand.get(String(m.candidate._id)) : undefined;
    // QA-085/086: the GREEN verdict comes from the portal's hour meter ALONE — that is
    // what the assessor settles against. Our own hours (days × slot) are shown beside it
    // as their own column; with no slot on the batch they are null, never an assumed 8.
    const govtHours = g?.total_hours_minutes != null ? Math.round(g.total_hours_minutes / 60) : null;
    const ourHours = hoursPerDay != null ? Math.round(internalDays * hoursPerDay) : null;
    const basis = govtHours != null ? "portal" : ourHours != null ? "estimate" : null;
    return {
      member_id: mid,
      candidate_id: m.candidate?._id ?? null,
      name: m.candidate?.name ?? "(removed)",
      sidh_candidate_id: m.candidate?.sidh_candidate_id ?? null,
      left_on: m.left_on ?? null,
      present_by_day: presentByDay,
      internal_days: internalDays,
      our_hours: ourHours,
      govt: g ? {
        days_present: g.total_days_present ?? null,
        working_days: g.total_working_days ?? null,
        hours: govtHours,
        hours_raw: g.total_hours_raw ?? null,
        as_of: g.createdAt,
      } : null,
      attended_hours: govtHours ?? ourHours,
      basis,
      qualified: govtHours != null && govtHours >= requiredHours,
    };
  });

  return NextResponse.json({
    days,
    days_held: days.length,
    members: rows,
    program_hours: batch.program?.hours || (batch.program?.duration_days ?? 15) * 8,
    min_attendance_pct: minPct,
    required_hours: requiredHours,
    hours_per_day: hoursPerDay,
    qualified_count: rows.filter((r) => r.qualified && !r.left_on).length,
  });
});
