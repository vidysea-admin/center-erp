import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, isScoped, HttpError, readJson, translateError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Candidate } from "@/models";
import { unarchiveCandidate } from "@/lib/candidate-archive";

// candidates-bulk-archive-restore-ux. Body: { candidate_ids: [] }
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "candidates.delete");
  const body = await readJson(req);
  const { candidate_ids } = body;
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
      await unarchiveCandidate(c, user);
      results.push({ candidate: cid, ok: true });
    } catch (e) {
      // QA-2799: sibling of QA-2796's fix — see bulk-archive/route.ts for the same note.
      results.push({ candidate: cid, ok: false, error: translateError(e).message });
    }
  }
  return NextResponse.json({ results, restored: results.filter((r) => r.ok).length });
});
