import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { applySheetChange } from "@/lib/sync";

// POST { action, note? } — Apply & Acknowledge (Rules 4–8).
// 2026-08-11 (CEO): WHO may approve sheet changes is an Admin-assigned right, not a
// hardcoded role — gated on the togglable "sheet.approve" permission.
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "sheet.approve");
  requireEdit(user); // Rule 39: can_edit=false is view-only everywhere, including granted rights
  const { id } = await ctx.params;
  const { action, note } = await req.json();
  const result = await applySheetChange(id, action, note, user.id);
  return NextResponse.json(result);
});
