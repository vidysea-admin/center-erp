import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { runSync } from "@/lib/sync";
import { runWatch } from "@/lib/workbook";
import { SyncSource } from "@/models";

// POST — "Sync Now" (Rules 1–2 for mapped sources, Workbook Watch for watch sources).
// 2026-08-13: was the only source route still role-gated; now the same togglable sheet.sources
// right as create/edit/test/delete, so a granted user is not mysteriously blocked from this one.
export const POST = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "sheet.sources");
  const { id } = await ctx.params;
  const src = await SyncSource.findById(id).select("mode").lean<any>();
  const result = src?.mode === "watch" ? await runWatch(id) : await runSync(id);
  return NextResponse.json(result);
});
