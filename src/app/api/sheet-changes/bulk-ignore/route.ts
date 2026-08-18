import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { bulkIgnore } from "@/lib/sync";

// POST { ids: [] } — Rule 9. Gated on the togglable sheet-approval right (2026-08-11).
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "sheet.approve");
  requireEdit(user); // Rule 39: can_edit=false is view-only everywhere, including granted rights
  const { ids, note } = await req.json();
  if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, "ids required");
  // Report what actually happened: some of the selection may carry Pending follow-ups and be
  // deliberately left Open (Rule 7). Reporting ids.length regardless told reviewers everything
  // was cleared when it was not.
  const result = await bulkIgnore(ids, user.id, typeof note === "string" && note.trim() ? note.trim().slice(0, 200) : undefined);
  return NextResponse.json(result);
});
