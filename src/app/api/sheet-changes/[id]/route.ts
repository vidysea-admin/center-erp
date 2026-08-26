import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError } from "@/lib/authz";
import { requireView } from "@/lib/permissions";
import { SheetChange } from "@/models";
import { maskSheetChange } from "@/lib/sync";

// QA-1026 (S1): the sibling of api/locations/[id]/route.ts's GET half — the ONLY door through
// which a masked list row's real value can be seen, one record at a time, Admin only. Read-only
// by design: no PATCH/DELETE here, applying or reverting a change stays on their own doors.
export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requireView(user, "sheet.approve"); // same gate as the list route
  const { id } = await ctx.params;
  const item = await SheetChange.findById(id).populate("location", "name code").populate("actor", "name").lean<any>();
  if (!item) throw new HttpError(404, "Change not found");
  return NextResponse.json({ item: maskSheetChange(item, user.role === "Admin") });
});
