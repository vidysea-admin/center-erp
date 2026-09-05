import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, readJson } from "@/lib/authz";
import { requireFinance } from "@/lib/permissions";
import { assertBatchInScope, updateInvoiceChecked } from "@/lib/rules";
import { requireApproval } from "@/lib/approvals";
import { Batch } from "@/models";
import { audit } from "@/lib/audit";

// PATCH invoice (Rule 36). QA-1825: moved from `invoices.manage` to `finance.approve` — moving an
// invoice through Ready → Raised → Paid IS deciding money, and the CEO put money behind three
// named people. The `invoice.raise` / `invoice.paid` approval gate below is unchanged and still
// parks the act for a second person; this only narrows who may reach the door at all.
export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requireFinance(user, "approve");
  requireEdit(user); // Rule 39: can_edit=false is view-only everywhere, including granted rights
  const { id } = await ctx.params;
  // 2026-08-12 audit (auth S1-8): this was the only by-id batch route with no scope assertion,
  // so a scoped user could move another centre's invoice.
  await assertBatchInScope(user, id); // Rule 38
  const body = await readJson(req);
  const patch: Record<string, unknown> = {};
  for (const f of ["amount", "status", "invoice_no", "raised_on", "paid_on", "file"]) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  // RPL M24 — financial actions are the first ones an Admin would gate.
  if (patch.status === "Raised" || patch.status === "Paid") {
    const b = await Batch.findById(id).select("code location").lean<any>();
    const gate = await requireApproval(patch.status === "Raised" ? "invoice.raise" : "invoice.paid", user, {
      entity: "Invoice", entity_id: id, location: b?.location,
      summary: `Mark invoice ${String(patch.status).toLowerCase()} for batch ${b?.code}${patch.invoice_no ? ` (${patch.invoice_no})` : ""}`,
      payload: patch,
    });
    if (gate) return NextResponse.json({ pending_approval: true, request: gate.request, message: "Sent for approval." }, { status: 202 });
  }

  const inv = await updateInvoiceChecked(id, patch);
  await audit({ entity: "Invoice", entityId: inv._id, field: "invoice", newValue: patch, actor: user.id });
  return NextResponse.json({ item: inv });
});
