import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { decideApproval } from "@/lib/approvals";
import { assertCostEntryValid, transitionBatch, updateInvoiceChecked } from "@/lib/rules";
import { CostEntry, Location } from "@/models";
import { audit } from "@/lib/audit";

// POST { decision: "Approved" | "Rejected", note? }
// On approval the parked action is replayed here, so approval and execution stay in one
// place rather than being re-implemented per module.
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "approvals.decide"); // togglable (2026-08-11)
  const { id } = await ctx.params;
  const { decision, note } = await req.json();
  if (!["Approved", "Rejected"].includes(decision)) throw new HttpError(400, "decision must be Approved or Rejected");

  const request = await decideApproval(id, user, decision, note);
  if (decision !== "Approved") return NextResponse.json({ item: request, applied: false });

  const p = (request.payload ?? {}) as any;
  switch (request.action) {
    case "location.close":
    case "location.stop":
      await Location.findByIdAndUpdate(request.entity_id, {
        operational_status: request.action === "location.close" ? "Closed" : "Stopped",
        status_reason: p.reason, status_changed_on: new Date(),
      });
      break;
    case "batch.cancel":
      await transitionBatch(String(request.entity_id), "Cancelled", { isAdmin: true, reason: p.reason });
      break;
    case "batch.complete":
      await transitionBatch(String(request.entity_id), "Completed", { isAdmin: true });
      break;
    case "invoice.raise":
    case "invoice.paid":
      await updateInvoiceChecked(String(request.entity_id), p);
      break;
    case "cost.post": {
      // R-E: the ledger row is written only here — approval IS the write. It belongs to the
      // person who posted it (entered_by = initiator), with the approval trail alongside.
      await assertCostEntryValid(p);
      const cost = await CostEntry.create({
        entry_date: p.entry_date ?? request.createdAt,
        location: p.location || undefined, batch: p.batch || undefined, trainer: p.trainer || undefined,
        category: p.category, amount: p.amount, note: p.note,
        entered_by: request.initiator,
      });
      await audit({ entity: "CostEntry", entityId: cost._id, newValue: `created via approval ${request._id}`, actor: user.id });
      break;
    }
    default:
      throw new HttpError(400, "Approved request has no replay handler: " + request.action);
  }
  return NextResponse.json({ item: request, applied: true });
});
