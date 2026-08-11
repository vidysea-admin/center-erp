import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { WorkbookChange } from "@/models";

// Columns whose values are credentials in the client sheet — only Admin sees them in clear.
const SENSITIVE_COLUMNS = new Set(["TC Password", "Password"]);

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "sheet.approve"); // 2026-08-11: Admin-assignable reviewer right
  const status = req.nextUrl.searchParams.get("status") || "New";
  const tab = req.nextUrl.searchParams.get("tab") || "";
  const filter: Record<string, unknown> = {};
  if (status !== "all") filter.status = status;
  if (tab) filter.tab = tab;
  if (req.nextUrl.searchParams.get("count") === "1") {
    return NextResponse.json({ count: await WorkbookChange.countDocuments({ status: "New" }) });
  }
  const items = await WorkbookChange.find(filter)
    .sort({ detected_at: -1 }).limit(500)
    .populate("sync_source", "name")
    .populate("actor", "name")
    .lean<any[]>();
  const masked = items.map((c) => {
    if (user.role !== "Admin" && c.column && SENSITIVE_COLUMNS.has(c.column)) {
      return { ...c, old_value: c.old_value ? "••••••" : "", new_value: c.new_value ? "••••••" : "" };
    }
    return c;
  });
  const tabs = await WorkbookChange.distinct("tab");
  return NextResponse.json({ items: masked, tabs });
});
