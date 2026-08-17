import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { requirePerm, requireView } from "@/lib/permissions";
import { SyncSource, WorkbookChange } from "@/models";
import { sourceAllowed } from "@/lib/workbook";

// Columns whose values are credentials in the client sheet — only Admin sees them in clear.
const SENSITIVE_COLUMNS = new Set(["TC Password", "Password"]);

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requireView(user, "sheet.approve"); // QA-025 P3: reading = view level
  const status = req.nextUrl.searchParams.get("status") || "New";
  const tab = req.nextUrl.searchParams.get("tab") || "";
  // -100 (checker QA-169): every watched workbook was merged into one list with no way to tell
  // which sheet a row came from — which is exactly why two Google workbooks polled for three days
  // without anyone noticing. The source now travels with the row and can be filtered on.
  const source = req.nextUrl.searchParams.get("source") || "";
  const filter: Record<string, unknown> = {};
  if (status !== "all") filter.status = status;
  if (tab) filter.tab = tab;
  if (source) filter.sync_source = source;
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
  const tabs = await WorkbookChange.distinct("tab", source ? { sync_source: source } : {});
  // The sheets that actually have rows here, so the filter lists reality rather than the
  // registration table — a workbook whose rows are gone should not linger in the dropdown.
  const sourceIds = await WorkbookChange.distinct("sync_source");
  const sources = await SyncSource.find({ _id: { $in: sourceIds } }).select("name source_url mode").lean<any[]>();
  return NextResponse.json({
    items: masked,
    tabs,
    sources: sources.map((x) => ({ _id: String(x._id), name: x.name, mode: x.mode, is_client_workbook: sourceAllowed(String(x.source_url)).ok })),
  });
});
