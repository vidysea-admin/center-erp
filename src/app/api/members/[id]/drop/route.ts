import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { assertMemberInScope, dropMemberChecked } from "@/lib/rules";
import { audit } from "@/lib/audit";

// POST { left_on, drop_reason } — Rule 25
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  const { id } = await ctx.params;
  await assertMemberInScope(user, id); // Rule 38
  const { left_on, drop_reason } = await req.json();
  if (!left_on || !drop_reason) throw new HttpError(400, "Rule 25: left_on and drop_reason required");
  const m = await dropMemberChecked(id, new Date(left_on), drop_reason);
  await audit({ entity: "BatchMember", entityId: m._id, field: "dropped", newValue: { left_on, drop_reason }, actor: user.id });
  return NextResponse.json({ item: m });
});
