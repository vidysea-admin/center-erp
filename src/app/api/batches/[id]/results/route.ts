import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { BatchMember, CandidateResult } from "@/models";
import { assertBatchInScope, bulkMarkResults, summarizeBatchResults } from "@/lib/rules";

// GET — every roster member left-joined to its result row, so the marking grid renders
// before anything has been marked. Pure read: no writes, no aggregate recompute (Rule 41).
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38

  const members = await BatchMember.find({ batch: id }).populate("candidate", "name phone lifecycle_status").sort({ joined_on: 1 }).lean<any[]>();
  const rows = await CandidateResult.find({ batch: id }).lean<any[]>();
  const byCandidate = new Map(rows.map((r) => [String(r.candidate), r]));

  const items = members.map((m) => ({
    member: String(m._id),
    candidate: m.candidate,
    joined_on: m.joined_on,
    left_on: m.left_on,
    enrollment_status: m.enrollment_status,
    result: byCandidate.get(String(m.candidate?._id ?? m.candidate)) ?? null,
  }));
  return NextResponse.json({ items, summary: await summarizeBatchResults(id, rows), legacy: rows.length === 0 });
});

// PUT — bulk mark. Body: { rows: [{ member, result, score, ... }] }
export const PUT = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "closure.manage"); // togglable (2026-08-11)
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const body = await req.json();
  if (!Array.isArray(body.rows) || !body.rows.length) throw new HttpError(400, "rows[] is required");

  const allowed = ["member", "result", "score", "max_score", "assessed_on", "assessor", "failure_reason", "failure_note", "reassessment_required", "reassessment_date", "evidence_file"];
  const rows = body.rows.map((r: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(r).filter(([k]) => allowed.includes(k))));

  const res = await bulkMarkResults(id, rows, user.id);
  if (res.updated === 0 && res.errors.length) throw new HttpError(400, res.errors[0].error);
  const after = await CandidateResult.find({ batch: id }).lean<any[]>();
  return NextResponse.json({ ...res, summary: await summarizeBatchResults(id, after) });
});
