import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { Feedback } from "@/models";
import { assertBatchInScope } from "@/lib/rules";

// Feedback received for a batch (2026-08-11) — list + average, for Admin/Ops/SPOC.
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id);
  const items = await Feedback.find({ batch: id })
    .sort({ submitted_at: -1 })
    .populate({ path: "batch_member", populate: { path: "candidate", select: "name" } })
    .lean<any[]>();
  const avg = items.length ? Math.round((items.reduce((s, f) => s + f.rating, 0) / items.length) * 10) / 10 : null;
  return NextResponse.json({ items, average: avg, count: items.length });
});
