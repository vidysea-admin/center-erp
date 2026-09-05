import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, HttpError } from "@/lib/authz";
import { AuditLog } from "@/models";
import { hasPermission, maskMoneyInAuditRow, FINANCE_VIEW } from "@/lib/permissions";

// QA-137 (Umesh, 15/08: "poora per-user activity view" — "Divya ne aaj kya kiya" ka jawab).
// Admin-only ON PURPOSE, v1: a person's trail spans every centre, so handing it to a scoped
// role would be a back door around Rule 38 — the exact list-hides/item-allows pattern
// QA-095/QA-125 closed seven times. The checker flagged the same risk; widen only with a
// deliberate design, not by default. Read-only; ?entity= narrows; page/limit paginate.
export const GET = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  if (user.role !== "Admin") throw new HttpError(403, "Only an Admin may read a person's full activity trail.");
  const { id } = await ctx.params;
  const sp = req.nextUrl.searchParams;
  const filter: Record<string, unknown> = { actor: id };
  const entity = sp.get("entity");
  if (entity) filter.entity = entity;
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10) || 1);
  const asked = Number(sp.get("limit") ?? "");
  const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(500, Math.ceil(asked)) : 100;
  const [items, total] = await Promise.all([
    AuditLog.find(filter).sort({ created_at: -1 }).skip((page - 1) * limit).limit(limit)
      .populate("actor", "name email").lean(),
    AuditLog.countDocuments(filter),
  ]);
  // QA-1840 (checker, cycle 2): the FOURTH money door — and the one whose entire audience IS the
  // population the CEO's rule names. This route is Admin-only by construction, so "only an Admin
  // may read this" is not a protection here, it is the exposure: an Admin without `finance.view`
  // read `{"amount":128500,"invoice_no":"INV-2026-0456"}` straight off it, and Admin → Users
  // renders those rows verbatim in the per-person activity drawer.
  //
  // Its sibling `audit/[entity]/[id]` was masked in cycle 2 and this one was not, because the pin
  // derived its population from "route files naming Invoice or CostEntry" — and this file names
  // `AuditLog`. The sibling only qualified by ACCIDENT: it happens to import `Invoice` for an
  // unrelated scope map. The pin now walks the `AuditLog` readers too, so the accident is no
  // longer what decides.
  const canSeeMoney = await hasPermission(user, FINANCE_VIEW);
  return NextResponse.json({ items: items.map((r: any) => maskMoneyInAuditRow(r, canSeeMoney)), total, page, limit });
});
