import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, requireRole, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { assertMemberInScope, updateEnrollment } from "@/lib/rules";
import { BatchMember, Candidate, CandidateResult, DailyLog, GovtAttendanceRow } from "@/models";
import { audit } from "@/lib/audit";
import { ROSTER_CANDIDATE_FIELDS } from "@/app/api/batches/[id]/members/route";

// PATCH enrollment worklist update (Rules 22–24).
// Body: { reg_done?, kyc_done?, accept_done?, failed?, issue?, issue_note?, source? }
export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  // QA-1290 (client call 2026-08-25): this door held no permission key at all - any signed-in,
  // non-view-only user with the member in scope could complete enrolment. candidates.assign is
  // the SAME key the two sibling roster-add doors already gate on (members/route.ts,
  // candidates/assign/route.ts), so "who may put someone on a roster" and "who may carry them
  // through it" are one right, not two that could drift apart. Live matrix read 2026-08-25:
  // Trainer holds candidates.assign nowhere - this is a real gate, not a formality.
  await requirePerm(user, "candidates.assign"); // togglable (2026-08-11)
  const { id } = await ctx.params;
  await assertMemberInScope(user, id); // Rule 38
  const body = await req.json();
  // Session users are always USER in the audit trail; the future Selenium bot gets its own
  // service credential and its own actor_type — never client-declared.
  delete body.source;
  const m = await updateEnrollment(id, body);
  // The Enrollment tab's client merges this response straight over its cached roster row
  // (`{ ...x, ...res.item }`, batches/[id]/page.tsx) — updateEnrollment returns the raw saved
  // doc with `candidate` unpopulated, so without this the merge clobbered a candidate's own
  // name/phone with a bare ObjectId, rendering "(unnamed candidate)" until the next full reload.
  // Same restricted field list the roster's own GET already uses, so the two can never drift.
  await m.populate("candidate", ROSTER_CANDIDATE_FIELDS);
  await audit({
    entity: "BatchMember", entityId: m._id, field: "enrollment",
    newValue: { status: m.enrollment_status, reg: m.reg_done, kyc: m.kyc_done, accept: m.accept_done, issue: m.issue },
    actor: user.id,
    actorType: "USER",
  });
  return NextResponse.json({ item: m });
});

// DELETE { reason } — take a member OFF a roster entirely (-102).
//
// Rule 25 (drop) is the right answer for a student who left: the row stays, the history stays, the
// figures stay honest. It is the WRONG answer for a row that should never have existed — a wrongly
// enrolled candidate, or the maker's own clearly-named test rows on the empty Gurugram batch Manish
// is about to load real data into. Until now there was no removal path at all, and a `BatchMember`
// could not be erased once created.
//
// So this door is deliberately narrow: Admin only, a reason on record, and it REFUSES the moment the
// member has left any footprint — a result row, a day where they were marked present, or a matched
// portal attendance row. Anything that could silently rewrite attendance or an NSDC figure comes back
// 409 with the reason, and Rule 25's drop remains the honest route for it.
export const DELETE = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  // Admin only, full stop — deliberately NOT a togglable permission. `requirePerm` returns
  // immediately for an Admin, so pairing the two here would be a check that can never fail.
  requireRole(user, "Admin");
  const { id } = await ctx.params;
  await assertMemberInScope(user, id); // Rule 38
  const { reason } = await req.json().catch(() => ({}));
  if (!reason || !String(reason).trim()) {
    throw new HttpError(400, "A reason is required — removing a roster row is audited, not silent. (To record a student who left, drop them instead.)");
  }

  const m = await BatchMember.findById(id).populate("candidate", "name").populate("batch", "code").lean<any>();
  if (!m) throw new HttpError(404, "Roster row not found.");
  const who = m.candidate?.name ?? "(removed candidate)";
  const where = m.batch?.code ?? String(m.batch);

  // Footprint checks — each names what it found, so the 409 is actionable.
  const blockers: string[] = [];
  if (await CandidateResult.exists({ batch_member: m._id })) blockers.push("an assessment/certification result row");
  const loggedDays = await DailyLog.countDocuments({ batch: m.batch?._id ?? m.batch, present_member_ids: m._id });
  if (loggedDays) blockers.push(`attendance on ${loggedDays} day${loggedDays === 1 ? "" : "s"}`);
  if (m.candidate?._id && await GovtAttendanceRow.exists({ candidate: m.candidate._id, match_status: "Matched" })) {
    blockers.push("a matched government-portal attendance row");
  }
  if (blockers.length) {
    throw new HttpError(409, `${who} cannot be removed from ${where} — this roster row already carries ${blockers.join(", ")}. Removing it would rewrite figures that have been reported. Drop them instead, which keeps the history.`);
  }

  await BatchMember.deleteOne({ _id: m._id });
  await audit({
    entity: "BatchMember", entityId: m._id, field: "removed",
    oldValue: `${who} on ${where}`, newValue: `removed — ${String(reason).trim()}`,
    actor: user.id, actorType: "USER",
  });

  // Rule 21 stamps the candidate "Assigned" on enrolment and "Enrolled" once the worklist
  // completes. Deleting the row without undoing that would leave a candidate reading Assigned
  // with no batch anywhere — and the planner's available pool counts exactly
  // `lifecycle_status: "Unassigned"` (rules.ts plan-batch pool), so the person would be invisible
  // to it forever. A candidate on no roster IS unassigned; only say so once the LAST row is gone.
  let lifecycle: string | null = null;
  const cid = m.candidate?._id;
  if (cid && !(await BatchMember.exists({ candidate: cid }))) {
    const cand = await Candidate.findById(cid).select("lifecycle_status").lean<any>();
    if (cand && cand.lifecycle_status !== "Unassigned") {
      await Candidate.updateOne({ _id: cid }, { lifecycle_status: "Unassigned" });
      lifecycle = "Unassigned";
      await audit({
        entity: "Candidate", entityId: cid, field: "lifecycle_status",
        oldValue: cand.lifecycle_status, newValue: "Unassigned",
        actor: user.id, actorType: "USER",
      });
    }
  }

  return NextResponse.json({ ok: true, removed: { member: String(m._id), candidate: who, batch: where }, lifecycle_status: lifecycle });
});
