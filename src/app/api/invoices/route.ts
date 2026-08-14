import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Invoice } from "@/models";

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "invoices.manage"); // read follows the same togglable right as write
  // QA-140 (checker, 15/08) — same R-E principle the costs ledger got (CEO [25:06]):
  // Operations raises the work that becomes an invoice, but the invoice book — amounts,
  // status, per-centre — lives with the Admin. This route sat on requirePerm alone and only
  // read empty because no invoice had been raised yet.
  if (user.role === "Operations") {
    throw new HttpError(403, "Operations raises work for invoicing; the invoice book is Admin-only.");
  }
  const status = req.nextUrl.searchParams.get("status");
  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  const items = await Invoice.find(filter)
    .sort({ updatedAt: -1 })
    .populate({ path: "batch", select: "code location program", populate: [{ path: "location", select: "name code" }, { path: "program", select: "name code" }] })
    .lean();
  return NextResponse.json({ items });
});
