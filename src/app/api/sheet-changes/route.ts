import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole } from "@/lib/authz";
import { FollowUpAction, SheetChange } from "@/models";

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin", "Operations"); // Rule 40
  const status = req.nextUrl.searchParams.get("status") || "Open";
  const items = await SheetChange.find(status === "all" ? {} : { status })
    .sort({ detected_at: -1 })
    .populate("location", "name code")
    .populate("actor", "name")
    .lean<any[]>();
  const withFups = await Promise.all(items.map(async (c) => ({
    ...c,
    pending_followups: await FollowUpAction.countDocuments({ source_change: c._id, status: "Pending" }),
  })));
  return NextResponse.json({ items: withFups });
});
