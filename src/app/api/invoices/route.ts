import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Invoice } from "@/models";

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "invoices.manage"); // read follows the same togglable right as write
  const status = req.nextUrl.searchParams.get("status");
  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  const items = await Invoice.find(filter)
    .sort({ updatedAt: -1 })
    .populate({ path: "batch", select: "code location program", populate: [{ path: "location", select: "name code" }, { path: "program", select: "name code" }] })
    .lean();
  return NextResponse.json({ items });
});
