import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole } from "@/lib/authz";
import { applySheetChange } from "@/lib/sync";

// POST { action, note? } — Apply & Acknowledge (Rules 4–8). Admin/Operations only (Rule 40).
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin", "Operations");
  const { id } = await ctx.params;
  const { action, note } = await req.json();
  const result = await applySheetChange(id, action, note, user.id);
  return NextResponse.json(result);
});
