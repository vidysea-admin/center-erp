import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { runSync } from "@/lib/sync";
import { runWatch, sourceAllowed } from "@/lib/workbook";
import { SyncSource } from "@/models";

// POST — "Sync Now" (Rules 1–2 for mapped sources, Workbook Watch for watch sources).
// 2026-08-13: was the only source route still role-gated; now the same togglable sheet.sources
// right as create/edit/test/delete, so a granted user is not mysteriously blocked from this one.
export const POST = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "sheet.sources");
  const { id } = await ctx.params;
  const src = await SyncSource.findById(id).select("mode source_url name").lean<any>();
  if (!src) throw new HttpError(404, "Sync source not found");
  // -100: "Sync Now" is the manual twin of the scheduler loops — it gets the same gate, so a row
  // that predates the policy cannot be run by hand either.
  {
    const verdict = sourceAllowed(String(src.source_url));
    if (!verdict.ok) throw new HttpError(400, verdict.reason ?? "This sheet cannot be synced.");
  }
  const result = src.mode === "watch" ? await runWatch(id) : await runSync(id);
  return NextResponse.json(result);
});
