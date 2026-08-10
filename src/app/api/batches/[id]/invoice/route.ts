import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole } from "@/lib/authz";
import { updateInvoiceChecked } from "@/lib/rules";
import { audit } from "@/lib/audit";

// PATCH invoice (Rule 36). Operations/Admin only (screen spec: Costs → Invoices tab).
export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin", "Operations");
  const { id } = await ctx.params;
  const body = await req.json();
  const patch: Record<string, unknown> = {};
  for (const f of ["amount", "status", "invoice_no", "raised_on", "paid_on", "file"]) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  const inv = await updateInvoiceChecked(id, patch);
  await audit({ entity: "Invoice", entityId: inv._id, field: "invoice", newValue: patch, actor: user.id });
  return NextResponse.json({ item: inv });
});
