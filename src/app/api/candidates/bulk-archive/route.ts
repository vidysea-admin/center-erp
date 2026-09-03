import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, isScoped, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Candidate } from "@/models";
import { archiveCandidate } from "@/lib/candidate-archive";

// candidates-bulk-archive-restore-ux. Body: { candidate_ids: [], reason?, confirm_batch_history? }
// Same per-candidate try/catch shape as /api/candidates/assign — one candidate's refusal (batch
// history needing confirmation, out of scope, already archived) never aborts the rest.
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "candidates.delete");
  const body = await req.json();
  const { candidate_ids, reason, confirm_batch_history } = body;
  if (!Array.isArray(candidate_ids) || !candidate_ids.length) {
    throw new HttpError(400, "candidate_ids is required");
  }
  const results: { candidate: string; ok: boolean; error?: string }[] = [];
  for (const cid of candidate_ids) {
    try {
      const c = await Candidate.findById(cid);
      if (!c) throw new HttpError(404, "Candidate not found");
      if (isScoped(user)) {
        const locId = (c as any).location;
        if (!locId || !user.location_scope.map(String).includes(String(locId))) {
          throw new HttpError(403, "Out of scope");
        }
      }
      await archiveCandidate(c, user, { reason, confirmBatchHistory: !!confirm_batch_history });
      results.push({ candidate: cid, ok: true });
    } catch (e) {
      results.push({ candidate: cid, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ results, archived: results.filter((r) => r.ok).length });
});
