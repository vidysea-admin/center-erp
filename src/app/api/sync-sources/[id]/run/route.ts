import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole } from "@/lib/authz";
import { runSync } from "@/lib/sync";

// POST — "Sync Now" (Rules 1–2)
export const POST = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin", "Operations");
  const { id } = await ctx.params;
  const result = await runSync(id);
  return NextResponse.json(result);
});
