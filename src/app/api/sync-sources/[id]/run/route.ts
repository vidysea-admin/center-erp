import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole } from "@/lib/authz";
import { runSync } from "@/lib/sync";
import { runWatch } from "@/lib/workbook";
import { SyncSource } from "@/models";

// POST — "Sync Now" (Rules 1–2 for mapped sources, Workbook Watch for watch sources)
export const POST = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin", "Operations");
  const { id } = await ctx.params;
  const src = await SyncSource.findById(id).select("mode").lean<any>();
  const result = src?.mode === "watch" ? await runWatch(id) : await runSync(id);
  return NextResponse.json(result);
});
