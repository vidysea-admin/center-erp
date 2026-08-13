import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError, assertLocationInScope } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, Candidate } from "@/models";
import { addMemberChecked, candidateEligibility } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";
import { audit } from "@/lib/audit";

// Bulk assign candidates to a batch. Body: { batch, candidate_ids: [], joined_on? }
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "candidates.assign"); // togglable (2026-08-11)
  const body = await req.json();
  const { batch: batchId, candidate_ids, joined_on } = body;
  if (!batchId || !Array.isArray(candidate_ids) || !candidate_ids.length) {
    throw new HttpError(400, "batch and candidate_ids are required");
  }
  const batch = await Batch.findById(batchId).lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  assertLocationInScope(user, String(batch.location)); // Rule 38
  if (["Completed", "Cancelled"].includes(batch.status)) throw new HttpError(409, "Batch is closed.");

  // 2026-08-11: assignment of an ineligible candidate warns (eligibility flips month to
  // month); enrollment completion is where the hard gate sits.
  const defaults = await getDefaults();
  const candDocs = await Candidate.find({ _id: { $in: candidate_ids } })
    .select("name dob education last_training_date location program").lean<any[]>();
  const byId = new Map(candDocs.map((c) => [String(c._id), c]));

  const results: { candidate: string; ok: boolean; error?: string; warning?: string }[] = [];
  for (const cid of candidate_ids) {
    try {
      // 2026-08-13 (Manish walkthrough — Prem Kumar/Lalit on the wrong roster): a candidate
      // must belong to the batch's OWN centre and job role. This used to be checked only for
      // the Location role (Rule 38 scope), so Admin/Operations could file any centre's
      // candidate into any batch. Now an equality check for everyone, per candidate so one
      // wrong row does not abort the other 29.
      const c0 = byId.get(String(cid));
      if (!c0) throw new HttpError(404, "Candidate not found");
      if (String(c0.location) !== String(batch.location)) {
        throw new HttpError(409, `${c0.name ?? "Candidate"} belongs to another centre — move them to this location first.`);
      }
      if (c0.program && batch.program && String(c0.program) !== String(batch.program)) {
        throw new HttpError(409, `${c0.name ?? "Candidate"} is registered under a different job role/scheme than this batch.`);
      }
      const m = await addMemberChecked(batchId, cid, joined_on ? new Date(joined_on) : new Date());
      // Import convention: program-less candidates (bulk/portal imports) inherit the batch's
      // programme on enrolment.
      if (!c0.program && batch.program) {
        await Candidate.updateOne({ _id: cid }, { $set: { program: batch.program } });
      }
      await audit({ entity: "BatchMember", entityId: m._id, newValue: "assigned", actor: user.id });
      const c = byId.get(String(cid));
      const elig = c ? candidateEligibility(c, defaults) : null;
      results.push({
        candidate: cid, ok: true,
        ...(elig && !elig.eligible ? { warning: `${c!.name}: ${elig.reasons.join("; ")}` } : {}),
      });
    } catch (e) {
      results.push({ candidate: cid, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({
    results,
    assigned: results.filter((r) => r.ok).length,
    warnings: results.filter((r) => r.warning).map((r) => r.warning),
  });
});
