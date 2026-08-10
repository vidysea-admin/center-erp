import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError, assertLocationInScope } from "@/lib/authz";
import { Batch, Candidate } from "@/models";
import { addMemberChecked } from "@/lib/rules";
import { audit } from "@/lib/audit";

// Bulk assign candidates to a batch. Body: { batch, candidate_ids: [], joined_on? }
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  const body = await req.json();
  const { batch: batchId, candidate_ids, joined_on } = body;
  if (!batchId || !Array.isArray(candidate_ids) || !candidate_ids.length) {
    throw new HttpError(400, "batch and candidate_ids are required");
  }
  const batch = await Batch.findById(batchId).lean<any>();
  if (!batch) throw new HttpError(404, "Batch not found");
  assertLocationInScope(user, String(batch.location)); // Rule 38
  if (["Completed", "Cancelled"].includes(batch.status)) throw new HttpError(409, "Batch is closed.");
  if (user.role === "Location") {
    const cands = await Candidate.find({ _id: { $in: candidate_ids } }).select("location").lean<any[]>();
    for (const c of cands) assertLocationInScope(user, String(c.location)); // Rule 38 on candidates too
  }

  const results: { candidate: string; ok: boolean; error?: string }[] = [];
  for (const cid of candidate_ids) {
    try {
      const m = await addMemberChecked(batchId, cid, joined_on ? new Date(joined_on) : new Date());
      await audit({ entity: "BatchMember", entityId: m._id, newValue: "assigned", actor: user.id });
      results.push({ candidate: cid, ok: true });
    } catch (e) {
      results.push({ candidate: cid, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ results, assigned: results.filter((r) => r.ok).length });
});
