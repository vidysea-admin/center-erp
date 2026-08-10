import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole } from "@/lib/authz";
import { FollowUpAction } from "@/models";

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin", "Operations"); // Rule 40 — sync workflow is Admin/Ops only
  const status = req.nextUrl.searchParams.get("status") || "Pending";
  const items = await FollowUpAction.find(status === "all" ? {} : { status })
    .sort({ createdAt: 1 })
    .populate({ path: "source_change", populate: { path: "location", select: "name code" } })
    .populate("owner", "name")
    .lean();
  return NextResponse.json({ items });
});
