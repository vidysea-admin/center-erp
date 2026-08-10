import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
import { bulkIgnore } from "@/lib/sync";

// POST { ids: [] } — Rule 9
export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin", "Operations");
  const { ids } = await req.json();
  if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, "ids required");
  await bulkIgnore(ids, user.id);
  return NextResponse.json({ ignored: ids.length });
});
