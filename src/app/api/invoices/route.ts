import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, isScoped, locationFilter } from "@/lib/authz";
import { requireFinance } from "@/lib/permissions";
import { Batch, Invoice } from "@/models";

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
  // QA-2984 (S3, Umesh 2026-10-25, dual check): Rule 38. An Invoice has no centre of its own, only a batch, so the
  // centre is the batch's - the SAME resolution home/route.ts uses for its invoice tiles (batch: { $in: Batch.find(
  // locationFilter(user)) }). A user scoped to centre X sees only the invoices of centre X batches. Admin and every
  // unscoped role skip this branch entirely, so their rows and counts are exactly what they were.
  if (isScoped(user)) filter.batch = { $in: await Batch.find(locationFilter(user)).distinct("_id") };
  const items = await Invoice.find(filter)
    .sort({ updatedAt: -1 })
    .populate({ path: "batch", select: "code location program", populate: [{ path: "location", select: "name code" }, { path: "program", select: "name code" }] })
    .lean();
  return NextResponse.json({ items });
});
