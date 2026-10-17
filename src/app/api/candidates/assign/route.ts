import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError, readJson, translateError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Candidate } from "@/models";
import { assertBatchJoinable, assignCandidateToBatch } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";

// Bulk assign candidates to a batch. Body: { batch, candidate_ids: [], joined_on? }
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "candidates.assign"); // togglable (2026-08-11)
  const body = await readJson(req);
  const { batch: batchId, candidate_ids, joined_on } = body;
  if (!batchId || !Array.isArray(candidate_ids) || !candidate_ids.length) {
    throw new HttpError(400, "batch and candidate_ids are required");
  }
  // qa-import-into-batch (-325): the load + 404 + Rule 38 + closed + Rule 1 gate is ONE function now
  // (rules.ts assertBatchJoinable), shared with the members door and the importer. Behaviour delta, said
  // out loud: this door gains Rule 1 (a halted centre refuses joins), which members POST already enforced.
  const batch = await assertBatchJoinable(user, batchId);

  // 2026-08-11: assignment of an ineligible candidate warns (eligibility flips month to
  // month); enrollment completion is where the hard gate sits.
  const defaults = await getDefaults();
  // QA-1801: archived candidates are not assignable. This is the client's own driver for asking
  // for Archive at all - "galti se ye deleted wale chale ja rahe hain" - unwanted leads being swept
  // into bulk Assign-to-Batch by select-all. Excluding them from the ACTION is not the same as
  // hiding them from the LIST, so REQ-417-421 is untouched.
  const candDocs = await Candidate.find({ _id: { $in: candidate_ids }, archived_at: null })
    .select("name dob education last_training_date location program").lean<any[]>();
  const byId = new Map(candDocs.map((c) => [String(c._id), c]));

  // QA-892: `joined_on` is part of the answer, not a detail — on a backdated batch it is the day the
  // student is counted from, and every attendance day the operator can enter afterwards depends on it.
  const results: { candidate: string; ok: boolean; error?: string; warning?: string; joined_on?: Date | null }[] = [];
  for (const cid of candidate_ids) {
    try {
      const c0 = byId.get(String(cid));
      if (!c0) throw new HttpError(404, "Candidate not found");
      // qa-import-into-batch (-325): everything between "found the candidate" and "joined" - the centre
      // test (with the -130 walk-in exemption), the job-role test, addMemberChecked, programme and centre
      // adoption and their audit rows - is assignCandidateToBatch now (rules.ts). It was a verbatim copy
      // of the members door (QA-273 / ARCHITECTURE.md section 3.1) and the importer is its third caller.
      // QA-892: `undefined`, not `new Date()` - the default belongs to addMemberChecked.
      const joined = await assignCandidateToBatch({
        batch, candidate: c0, joinedOn: joined_on ? new Date(joined_on) : undefined, actorId: user.id, defaults,
      });
      const m = joined.member;
      // -131 (QA-277): `warning` carries BOTH the roster warning and the eligibility text, kept rather
      // than one winning - over-target and not-eligible are different facts about the same enrolment.
      const warnings = [joined.rosterWarning, joined.eligibilityWarning].filter(Boolean) as string[];
      results.push({
        candidate: cid, ok: true,
        // QA-892: the date this enrolment actually landed on. The operator is told which day the
        // student is counted from, because on a backdated batch it is NOT the day they pressed the
        // button, and every attendance day they can enter afterwards depends on it.
        joined_on: (m as any).joined_on ?? null,
        ...(warnings.length ? { warning: warnings.join(" · ") } : {}),
      });
    } catch (e) {
      // QA-2796: this used to be `e.message` verbatim. That reached the client on a 200 (the bulk
      // shape reports per-candidate, it never throws to apiHandler), so a duplicate-key collision —
      // real if two operators assign the same candidate to the same batch at once, since the
      // preconditions above only refuse what THIS request can already see — put the raw Mongo
      // E11000 driver text straight into the toast. translateError() is the SAME function the
      // single-add door's apiHandler wrapper uses; only its .message is used here because this
      // door's response is always 200 with a per-candidate ok/error shape, not a top-level status.
      results.push({ candidate: cid, ok: false, error: translateError(e).message });
    }
  }
  return NextResponse.json({
    results,
    assigned: results.filter((r) => r.ok).length,
    warnings: results.filter((r) => r.warning).map((r) => r.warning),
  });
});
