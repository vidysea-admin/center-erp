import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, isScoped, assertLocationInScope, HttpError, readJson } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { bulkIgnore } from "@/lib/sync";
import { SheetChange } from "@/models";

// POST { ids: [] } — Rule 9. Gated on the togglable sheet-approval right (2026-08-11).
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "sheet.approve");
  requireEdit(user); // Rule 39: can_edit=false is view-only everywhere, including granted rights
  const { ids, note } = await readJson(req);
  if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, "ids required");
  // QA-2984 (S3, Umesh 2026-10-25, dual check): Rule 38. The WHOLE selection is checked before anything is closed, so a
  // list that carries one other-centre id (or a no-centre one, which fails closed - candidates/[id]/documents/route.ts:17)
  // is refused outright (403) with nothing written, rather than half-closed. Unscoped roles skip this entirely.
  if (isScoped(user)) {
    const rows = await SheetChange.find({ _id: { $in: ids } }).select("location").lean<any[]>();
    for (const r of rows) assertLocationInScope(user, String(r.location ?? ""));
  }
  // Report what actually happened: some of the selection may carry Pending follow-ups and be
  // deliberately left Open (Rule 7). Reporting ids.length regardless told reviewers everything
  // was cleared when it was not.
  const result = await bulkIgnore(ids, user.id, typeof note === "string" && note.trim() ? note.trim().slice(0, 200) : undefined);
  return NextResponse.json(result);
});
