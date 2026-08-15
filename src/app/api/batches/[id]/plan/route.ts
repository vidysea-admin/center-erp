import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { PublicToken } from "@/models";
import { assertBatchInScope, planArtifact } from "@/lib/rules";

// QA-152 part 2 (-82): the signed-in plan view. Read for anyone who can see the batch
// (Rule 38 scope is the gate); editing goes through PATCH /api/batches/[id]/milestones.
// Also returns the currently active share link (if any) so the page can show/copy it.
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id);
  const art = await planArtifact(id);
  const link = await PublicToken.findOne({ purpose: "plan", batch: id, active: true }).select("token allow_updates createdAt").lean<any>();
  return NextResponse.json({ ...art, share: link ? { token: link.token, allow_updates: !!link.allow_updates, created_at: link.createdAt } : null });
});
