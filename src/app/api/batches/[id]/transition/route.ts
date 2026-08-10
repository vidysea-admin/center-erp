import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit } from "@/lib/authz";
import { assertBatchInScope, transitionBatch } from "@/lib/rules";
import { audit } from "@/lib/audit";

// POST { target: "Ready"|"Active"|"Closing"|"Completed"|"Cancelled"|"Planning", reason? }
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const { target, reason } = await req.json();
  const batch = await transitionBatch(id, target, { isAdmin: user.role === "Admin", reason });
  await audit({ entity: "Batch", entityId: batch._id, field: "status", newValue: target, oldValue: undefined, actor: user.id });
  return NextResponse.json({ item: batch });
});
