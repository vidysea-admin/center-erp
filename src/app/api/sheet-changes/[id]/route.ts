import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, assertLocationInScope, HttpError } from "@/lib/authz";
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
  // QA-2984 (S3, Umesh 2026-10-25, dual check): Rule 38 on a single record - the reveal door must not hand a scoped
  // user another centre's row. Fails closed on a change with no centre, like candidates/[id]/documents/route.ts:17.
  assertLocationInScope(user, String(item.location?._id ?? item.location ?? ""));
  return NextResponse.json({ item: maskSheetChange(item, user.role === "Admin") });
});
