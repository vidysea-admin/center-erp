import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole } from "@/lib/authz";
import { FollowUpAction } from "@/models";
import { maskSheetChange } from "@/lib/sync";

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin", "Operations"); // Rule 40 — sync workflow is Admin/Ops only
  const status = req.nextUrl.searchParams.get("status") || "Pending";
  const raw = await FollowUpAction.find(status === "all" ? {} : { status })
    .sort({ createdAt: 1 })
    .populate({ path: "source_change", populate: { path: "location", select: "name code" } })
    .populate("owner", "name")
    .lean();
  // -251 (QA-1319, S1): the second door onto the same leak - `source_change` populated whole, so a
  // live `tc_password` rode out of this list too. Masked with the shared `maskSheetChange`, the same
  // way and for the same reason as the Home queue; see the comment there.
  const items = raw.map((f: any) =>
    f?.source_change ? { ...f, source_change: maskSheetChange(f.source_change, false) } : f);
  return NextResponse.json({ items });
});
