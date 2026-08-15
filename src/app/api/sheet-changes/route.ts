import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { hasPermission, requirePerm, requireView } from "@/lib/permissions";
import { FollowUpAction, SheetChange } from "@/models";

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requireView(user, "sheet.approve"); // QA-025 P3: seeing the queue = view; apply/ignore keep edit
  const status = req.nextUrl.searchParams.get("status") || "Open";
  // The sidebar badge only needs the number — fetching every row to read .length was wasteful.
  if (req.nextUrl.searchParams.get("count") === "1") {
    return NextResponse.json({ count: await SheetChange.countDocuments(status === "all" ? {} : { status }) });
  }
  const items = await SheetChange.find(status === "all" ? {} : { status })
    .sort({ detected_at: -1 })
    .populate("location", "name code")
    .populate("actor", "name")
    .lean<any[]>();
  // 2026-08-13: tc_password became mappable, so a change row can now carry a live portal
  // credential. Sheet Watch already masks the same column; the reviewer inbox must not be the
  // door that stays open. Only a holder of locations.manage sees the values.
  const canSeeSecrets = await hasPermission(user, "locations.manage");
  const withFups = await Promise.all(items.map(async (c) => ({
    ...c,
    ...(canSeeSecrets || c.field_name !== "tc_password"
      ? {}
      : { old_value: c.old_value ? "••••••" : "", new_value: c.new_value ? "••••••" : "" }),
    pending_followups: await FollowUpAction.countDocuments({ source_change: c._id, status: "Pending" }),
  })));
  return NextResponse.json({ items: withFups });
});
