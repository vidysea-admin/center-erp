import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser } from "@/lib/authz";
import { requireFinance } from "@/lib/permissions";
import { Invoice } from "@/models";

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  // QA-140 (checker, 15/08) — the R-E principle the costs ledger got (CEO [25:06]): whoever
  // raises the work that becomes an invoice does not get the invoice book — amounts, status,
  // per-centre. QA-1825 replaces the `role === "Operations"` hardcode with the same one finance
  // door the ledger now uses, so the CEO's 2026-09-05 widening ("chaahe super admin ho") applies
  // here identically instead of having to be remembered twice.
  await requireFinance(user, "view");
  const status = req.nextUrl.searchParams.get("status");
  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  const items = await Invoice.find(filter)
    .sort({ updatedAt: -1 })
    .populate({ path: "batch", select: "code location program", populate: [{ path: "location", select: "name code" }, { path: "program", select: "name code" }] })
    .lean();
  return NextResponse.json({ items });
});
