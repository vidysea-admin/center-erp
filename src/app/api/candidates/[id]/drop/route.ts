import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, isScoped, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { BatchMember, Candidate, CandidateResult } from "@/models";
import { dropMemberChecked } from "@/lib/rules";
import { currentStageOf } from "@/lib/candidate-journey";
import { audit } from "@/lib/audit";

// QA-021 (-68) — the CEO's loudest repeated ask: Dropout as a real candidate stage, reachable
// from ANYWHERE in the journey, not only from inside a batch roster. Before this route the
// only writer of lifecycle_status:"Dropped" was the member-drop (Rule 25), so a Fresh lead —
// someone who never entered a batch — had no code path to Dropped at all.
//
// POST { reason, date? }        → drop, with the reason and the CURRENT journey stage stamped
//                                 (stage derived server-side by the same function the page
//                                 renders with — never trusted from the client).
//                                 If an active roster membership exists, Rule 25 runs first so
//                                 the batch side stays consistent (results survive, Rule 42).
// POST { undo: true }           → reinstate a mistaken drop back to Unassigned (only when no
//                                 active membership exists; re-assignment un-drops naturally).
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "candidates.manage"); // QA-025: edit level — a :view holder reads, never drops
  const { id } = await ctx.params;
  const cand = await Candidate.findById(id);
  if (!cand) throw new HttpError(404, "Candidate not found");
  // Rule 38 on the by-id write, fail closed like every item route.
  if (isScoped(user)) {
    const locId = cand.location ? String(cand.location) : null;
    if (!locId || !user.location_scope.map(String).includes(locId)) throw new HttpError(403, "Out of scope");
  }
  const body = await req.json();

  if (body.undo === true) {
    if (cand.lifecycle_status !== "Dropped") throw new HttpError(400, `${cand.name} is not dropped.`);
    const active = await BatchMember.findOne({ candidate: cand._id, left_on: null }).lean();
    if (active) throw new HttpError(409, "They are on a batch roster — the drop was already undone by assignment.");
    cand.lifecycle_status = "Unassigned";
    cand.dropped_reason = undefined;
    cand.dropped_at = undefined;
    cand.dropped_from_stage = undefined;
    await cand.save();
    await audit({ entity: "Candidate", entityId: cand._id, field: "lifecycle_status", oldValue: "Dropped", newValue: "Unassigned (reinstated)", actor: user.id });
    return NextResponse.json({ item: cand });
  }

  const reason = String(body.reason ?? "").trim();
  if (!reason) throw new HttpError(400, "Dropping a candidate needs a reason — it is what the funnel report is made of.");
  if (cand.lifecycle_status === "Dropped") throw new HttpError(409, `${cand.name} is already dropped.`);
  const when = body.date ? new Date(body.date) : new Date();

  const activeMember = await BatchMember.findOne({ candidate: cand._id, left_on: null }).select("_id").lean<any>();
  if (activeMember) {
    // QA-1364: this branch is a ROSTER drop by another name — it calls the exact same
    // dropMemberChecked() that POST /api/members/[id]/drop calls, and until this line it did so
    // behind candidates.manage alone. So a login that QA-1290 locked out of the member-level drop
    // (403 on /api/members/[id]/drop) could still drop the same person from the same roster one
    // route over, through the candidate's own page, and dropMemberChecked never knew the
    // difference. `candidates.manage` stays the gate for a NON-roster candidate below (dropping a
    // Fresh Lead who was never assigned is not a roster action); the moment there IS an active
    // membership, this asks the same question the roster door asks.
    await requirePerm(user, "candidates.assign");
    // Rule 25 does the whole batch-side dance (roster, stale logs, aggregates) AND stamps the
    // candidate — one writer, no drift.
    await dropMemberChecked(String(activeMember._id), when, reason);
  } else {
    const latest = await CandidateResult.findOne({ candidate: cand._id, result: { $ne: "Pending" } })
      .sort({ assessed_on: -1, updatedAt: -1 }).select("result").lean<any>();
    const stage = currentStageOf({
      lifecycle_status: cand.lifecycle_status, enrolled_at: cand.enrolled_at, sidh_status: cand.sidh_status,
      latest_result: latest?.result ?? null, active_batch_status: null,
    });
    cand.lifecycle_status = "Dropped";
    cand.dropped_reason = reason;
    cand.dropped_at = when;
    cand.dropped_from_stage = stage;
    await cand.save();
  }
  await audit({ entity: "Candidate", entityId: cand._id, field: "lifecycle_status", oldValue: undefined, newValue: `Dropped (at ${cand.dropped_from_stage ?? "?"}) — ${reason}`, actor: user.id });
  const fresh = await Candidate.findById(id).lean();
  return NextResponse.json({ item: fresh });
});
