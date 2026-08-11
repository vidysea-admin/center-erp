import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { bulkIgnore } from "@/lib/sync";

// POST { ids: [] } — Rule 9. Gated on the togglable sheet-approval right (2026-08-11).
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "sheet.approve");
  const { ids } = await req.json();
  if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, "ids required");
  await bulkIgnore(ids, user.id);
  return NextResponse.json({ ignored: ids.length });
});
