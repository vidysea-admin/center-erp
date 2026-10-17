import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError, assertLocationInScope, readJson } from "@/lib/authz";
import { requirePerm, hasEditLevel } from "@/lib/permissions";

// The fields the roster itself renders - the chip, both attendance pickers, the enrolment card.
// Named once so the QA-1459 branch below cannot drift from what -212 established.
export const ROSTER_CANDIDATE_FIELDS = "name phone lifecycle_status sidh_candidate_id apaar_id";

// QA-1459's decision - WHICH FIELDS of a roster member's candidate this user may receive - stated
// once, for every door that hands the Enrollment tab a member row. The per-card PATCH
// (api/members/[id]) used to hard-code the narrow list even for editors, and the page merges that
// response over its cached row, so after one step toggle the card's Edit opened a drawer holding
// only name and mobile - and Save wrote "Current" and empty interest lists over the student's own
// answers (qa-selfreg-fields-drop). `null` means the whole document.
export async function rosterCandidateFields(user: Parameters<typeof hasEditLevel>[0]): Promise<string | null> {
  return (await hasEditLevel(user, "candidates.manage")) ? null : ROSTER_CANDIDATE_FIELDS;
}
import { Batch, BatchMember, Candidate, DailyLog, GovtAttendanceRow } from "@/models";
import { assertBatchInScope, assertBatchJoinable, assignCandidateToBatch, assessmentHoursBar, awaitingMatchFor, memberAttendedHours, slotHoursPerDay } from "@/lib/rules";
import { nameKey, unresolvedPortalRowsByName } from "@/lib/govt-attendance";
import { getDefaults } from "@/lib/defaults";

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  // -212 (Umesh 23/08, "har kisi ki portal id bhi dikha"): sidh_candidate_id rides the roster now.
  // Without it the chip on every candidate card and both attendance pickers would read "no portal
  // ID" for the entire roster - a screen-wide falsehood that no source-scanning pin could see,
  // because the component would be correct and the data behind it empty.
  // QA-1436: populate went from a fixed field list to the full document so the Enrollment tab's
  // Edit-candidate button can hand CandidateEditDrawer an already-loaded record with zero extra
  // fetch. Deliberately NOT routed through GET /api/candidates/[id] for this — that door stays
  // closed to a Trainer on purpose (QA-060/095, CEO: "I shouldn't see all the candidates... just
  // my batch-wise details" — a Trainer's lens IS this roster, not the general pool). A member row
  // here is already scoped by assertBatchInScope above, so reading the candidate behind a batch
  // this user is authorized to see does not reopen that door.
  //
  // QA-1459 — and that argument was HALF right, which is why it shipped. assertBatchInScope answers
  // WHICH candidates (this batch's, and only for someone allowed this batch); the projection was
  // answering WHICH FIELDS, and widening it to the whole document conflated the two. What went on
  // the wire for every roster row was aadhaar_no, dob, father_name, mother_name, religion, address,
  // email and custom_fields - to anyone who can see the batch, including a default Trainer who
  // holds no candidates right at all and is correctly shown no Edit button. A control the user
  // cannot see is not a gate; the door was open regardless of what the screen rendered.
  // The full record exists for ONE reason - to hand CandidateEditDrawer something to edit - and
  // that drawer only ever mounts for a user who may edit candidates. So ask that exact question,
  // with the exact function the drawer's own gate uses, and give everyone else the five fields the
  // roster actually renders. A Trainer's screen is byte-identical to what it was before -222.
  const candFields = await rosterCandidateFields(user);
  const q = BatchMember.find({ batch: id }).sort({ joined_on: 1 });
  const items = await (candFields === null
    ? q.populate("candidate")
    : q.populate("candidate", candFields)
  ).lean();

  // GD-102: "kitne bacche ki kitni-kitni attendance chal rahi hai" — each member's running
  // attendance, counted from the daily logs rather than stored anywhere it could go stale.
  const logs = await DailyLog.find({ batch: id }).select("present_member_ids").lean<any[]>();
  const daysHeld = logs.length;
  const presentDays = new Map<string, number>();
  for (const l of logs) {
    for (const mid of l.present_member_ids ?? []) {
      const k = String(mid);
      presentDays.set(k, (presentDays.get(k) ?? 0) + 1);
    }
  }
  // 2026-08-13: the government portal's cumulative figure per candidate (latest import wins) —
  // the roster shows both meters side by side, internal log days and portal days.
  // QA-070 (-70): hours ride along now — this API never even FETCHED total_hours_minutes,
  // which is why the roster showed days while the CEO asked for hours.
  const candIds = items.map((m: any) => m.candidate?._id).filter(Boolean);
  const govtLatest = candIds.length ? await GovtAttendanceRow.aggregate([
    { $match: { candidate: { $in: candIds }, match_status: "Matched" } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: "$candidate", days_present: { $first: "$total_days_present" }, working_days: { $first: "$total_working_days" }, hours_minutes: { $first: "$total_hours_minutes" }, as_of: { $first: "$createdAt" } } },
  ]) : [];
  const govtBy = new Map(govtLatest.map((g: any) => [String(g._id), g]));

  // One bar, one verdict — the same shared formulas as the Attendance tab and the portal.
  const batchDoc = await Batch.findById(id).populate("program", "hours duration_days scheme").select("program slot_start slot_end location").lean<any>();
  const defaults = await getDefaults();
  const { requiredHours } = await assessmentHoursBar(batchDoc?.program?.scheme, batchDoc?.program, defaults.min_attendance_pct ?? 50);
  const hoursPerDay = slotHoursPerDay(batchDoc);
  // -153 (QA-293): this roster showed both Sachin Kumars as "~0/60 hrs" - an estimate off OUR
  // daily logs, which hold no present days for them - while their real portal hours sat in this
  // database. The estimate was honest about its own basis and still said "~0" about students who
  // had cleared the bar. The chip needs to know an unattached row exists so it can say so instead.
  const awaitingByName = await unresolvedPortalRowsByName({ batchId: id, locationId: batchDoc?.location });

  const withAttendance = items.map((m: any) => {
    const g = govtBy.get(String(m.candidate?._id));
    const h = memberAttendedHours({ internalDays: presentDays.get(String(m._id)) ?? 0, hoursPerDay, govtMinutes: g?.hours_minutes, requiredHours });
    // -153 cycle 3 (QA-419): the same helper as the other two surfaces, not a re-typed condition.
    // Cycle 2 wrote this test out by hand here and inside eligibilityVerdict and again in the
    // public route, and the three drifted the moment a member was not enrolled.
    const awaiting = awaitingMatchFor({ basis: h.basis, hit: awaitingByName.get(nameKey(m.candidate?.name)) });
    return {
      ...m,
      attendance: {
        present: presentDays.get(String(m._id)) ?? 0,
        days_held: daysHeld,
        pct: daysHeld ? Math.round((100 * (presentDays.get(String(m._id)) ?? 0)) / daysHeld) : null,
      },
      govt_attendance: g ?? null,
      hours: { ...h, required_hours: requiredHours, awaiting_match: awaiting },
    };
  });
  return NextResponse.json({ items: withAttendance, required_hours: requiredHours });
});

// POST { candidate, joined_on? } — add one member (Rules 20–21)
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "candidates.assign"); // togglable (2026-08-11)
  const { id } = await ctx.params;
  // qa-import-into-batch (-325): load + 404 + Rule 38 + closed + Rule 1 is rules.ts assertBatchJoinable now,
  // shared with the bulk-assign door and the importer (ARCHITECTURE.md section 3.1).
  const batch = await assertBatchJoinable(user, id);
  const body = await readJson(req);
  if (!body.candidate) throw new HttpError(400, "candidate is required");
  const cand = await Candidate.findById(body.candidate).select("name phone sidh_candidate_id location program archived_at batch_interest").lean<any>();
  if (!cand) throw new HttpError(404, "Candidate not found");
  assertLocationInScope(user, String(cand.location)); // Rule 38 on the candidate too
  // qa-import-into-batch (-325): the centre test, the job-role test, addMemberChecked, programme and
  // centre adoption and their audit rows are assignCandidateToBatch (rules.ts) - one body for this door,
  // the bulk-assign door and the importer. The 2026-08-13 centre/role rulings, the -124 walk-in
  // exemption and QA-892's `undefined` join-date default all live there now, with their comments.
  const joined = await assignCandidateToBatch({
    batch, candidate: cand, joinedOn: body.joined_on ? new Date(body.joined_on) : undefined, actorId: user.id,
  });
  const m = joined.member;
  return NextResponse.json({ item: m, warning: (m as any).warning }, { status: 201 });
});
