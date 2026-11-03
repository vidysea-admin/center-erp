import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, assertLocationInScope, isScoped, HttpError } from "@/lib/authz";
import { CANDIDATE_READ_ROLES } from "@/lib/roles";
import { Batch, BatchMember, Candidate } from "@/models";
import { memberTrainingSummary } from "@/lib/rules";

// The candidate's History, for the staff drawer: every batch they have sat in, newest first - one row per SEAT,
// so a seat that was dropped before any result still shows (-342, Umesh 2026-11-03: a student now has several
// batches over time, and admin/ops must see each one: course, centre, dates, attendance, result, certificate).
//
// It used to return the raw CandidateResult documents (evidence file, assessor, every attempt) for the batches
// that HAD a result. The rows are now driven by BatchMember and built from memberTrainingSummary (rules.ts) -
// the same computation the student's own portal reads - and every field below is named: nothing from a result
// document goes out except what the History shows.
//
// Who may read: the candidate record's own roles (CANDIDATE_READ_ROLES - Trainer is refused, as it is there)
// and Rule 38 on the candidate's centre.
//
// Which seats (Umesh 2026-11-03): Admin and Ops see every batch the person ever sat in. A centre-scoped
// user (Rule 38 - Location, scoped Enrollment) sees only the seats whose BATCH is at one of their own
// centres - a student who studied at Jaipur and moved to Bhopal shows Bhopal's manager the Bhopal batch,
// not the Jaipur one.
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, ...CANDIDATE_READ_ROLES);
  const { id } = await ctx.params;
  const cand = await Candidate.findById(id).select("location").lean<any>();
  if (!cand) throw new HttpError(404, "Candidate not found");
  assertLocationInScope(user, String(cand.location)); // Rule 38

  let seats = await BatchMember.find({ candidate: id }).sort({ joined_on: -1, createdAt: -1 }).select("_id batch").lean<any[]>();
  if (isScoped(user)) {
    const own = new Set((await Batch.find({ _id: { $in: seats.map((s) => s.batch) }, location: { $in: user.location_scope } }).distinct("_id")).map(String));
    seats = seats.filter((s) => own.has(String(s.batch)));
  }
  const summaries = await memberTrainingSummary(seats.map((s) => s._id));
  const items = seats.map((s) => summaries.get(String(s._id))).filter(Boolean).map((m: any) => ({
    member: m.member_id,
    batch: m.batch,
    program: m.program,
    centre: m.centre,
    start_date: m.start_date,
    end_date: m.end_date,
    status: m.state,
    joined_on: m.joined_on,
    left_on: m.left_on,
    released_on: m.released_on,
    attendance: { days_present: m.internal_days_present, days_held: m.days_held },
    result: m.result,
    score: m.result ? (m.result_row?.score ?? null) : null,
    certificate_status: m.result_row?.certificate_status ?? null,
    certificate_no: m.result_row?.certificate_no ?? null,
    certificate_date: m.result_row?.certificate_date ?? null,
  }));
  return NextResponse.json({ items });
});
