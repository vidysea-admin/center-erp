import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { hasPermission, requirePerm, requireView } from "@/lib/permissions";
import { FollowUpAction, SheetChange } from "@/models";
import { classifyChange } from "@/lib/sync";

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
  const withFups = await Promise.all(items.map(async (c) => {
    const masked = {
      ...c,
      ...(canSeeSecrets || c.field_name !== "tc_password"
        ? {}
        : { old_value: c.old_value ? "••••••" : "", new_value: c.new_value ? "••••••" : "" }),
    };
    return {
      ...masked,
      // QA-946: what this row's reviewer may actually DO, decided by the same predicate the apply
      // door refuses through (lib/sync.ts). The drawer used to render one hardcoded list of seven
      // for every row while the door accepted at most one of the top two, so a reviewer's only way
      // to learn a row's kind was to pick wrong and read the 400.
      //
      // Classified from the MASKED row, not the raw one. No `why` quotes a value today, but the
      // verdicts do read new_value (blank means "applying this ERASES the field"), and computing
      // them from the raw row would put a live portal credential one careless edit away from
      // travelling past the mask written two lines above it.
      actions: classifyChange(masked),
      pending_followups: await FollowUpAction.countDocuments({ source_change: c._id, status: "Pending" }),
    };
  }));
  return NextResponse.json({ items: withFups });
});
