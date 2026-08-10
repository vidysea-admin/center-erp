import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError, assertLocationInScope } from "@/lib/authz";
import { BatchMember, Candidate } from "@/models";
import { addMemberChecked, assertBatchInScope } from "@/lib/rules";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const items = await BatchMember.find({ batch: id }).populate("candidate", "name phone lifecycle_status").sort({ joined_on: 1 }).lean();
  return NextResponse.json({ items });
});

// POST { candidate, joined_on? } — add one member (Rules 20–21)
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const body = await req.json();
  if (!body.candidate) throw new HttpError(400, "candidate is required");
  const cand = await Candidate.findById(body.candidate).select("location").lean<any>();
  if (!cand) throw new HttpError(404, "Candidate not found");
  assertLocationInScope(user, String(cand.location)); // Rule 38 on the candidate too
  const m = await addMemberChecked(id, body.candidate, body.joined_on ? new Date(body.joined_on) : new Date());
  await audit({ entity: "BatchMember", entityId: m._id, newValue: "assigned", actor: user.id });
  return NextResponse.json({ item: m }, { status: 201 });
});
