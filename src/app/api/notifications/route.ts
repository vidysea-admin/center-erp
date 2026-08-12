import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, locationFilter, isScoped } from "@/lib/authz";
import { Notification } from "@/models";

// RPL M22 — the user's alert inbox. Rule 38: scoped users only see alerts for their own
// locations (alerts with no location are system-wide and shown to everyone entitled).
export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  const status = req.nextUrl.searchParams.get("status") ?? "open";
  const countOnly = req.nextUrl.searchParams.get("count") === "1";

  const filter: Record<string, unknown> = {
    role_target: user.role,
    ...(status === "all" ? {} : status === "open" ? { status: { $in: ["New", "Acknowledged"] } } : { status }),
  };
  // 2026-08-12: filter by alert type. The list is capped at 100 and sorted severity-first, so
  // without this a low-severity alert (a pending signup, say) becomes unreachable once enough
  // warnings pile up — the bell would show it and the inbox would not.
  const type = req.nextUrl.searchParams.get("type");
  if (type) filter.type = { $in: type.split(",").map((t) => t.trim()).filter(Boolean) };
  if (isScoped(user)) {
    filter.$or = [{ location: null }, { ...locationFilter(user) }];
  }

  if (countOnly) return NextResponse.json({ count: await Notification.countDocuments(filter) });
  const items = await Notification.find(filter).sort({ severity: -1, createdAt: -1 }).limit(100)
    .populate("location", "name code").populate("acknowledged_by", "name").lean();
  return NextResponse.json({ items });
});
