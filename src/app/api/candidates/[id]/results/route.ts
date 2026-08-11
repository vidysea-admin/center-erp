import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, assertLocationInScope, HttpError } from "@/lib/authz";
import { Candidate, CandidateResult } from "@/models";

// Every result this candidate has across all batches — the candidate drawer's history view.
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  const cand = await Candidate.findById(id).select("location").lean<any>();
  if (!cand) throw new HttpError(404, "Candidate not found");
  assertLocationInScope(user, String(cand.location)); // Rule 38

  const items = await CandidateResult.find({ candidate: id })
    .sort({ createdAt: -1 })
    .populate("batch", "code status")
    .lean();
  return NextResponse.json({ items });
});
