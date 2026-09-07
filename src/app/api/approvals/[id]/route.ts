import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError, readJson } from "@/lib/authz";
import { requirePerm, requireFinance, hasPermission, maskApprovalMoney, FINANCE_VIEW } from "@/lib/permissions";
import { decideApproval } from "@/lib/approvals";
import { assertCostEntryValid, transitionBatch, updateInvoiceChecked } from "@/lib/rules";
import { ApprovalRequest, CostEntry, Location, LocationTarget, Room } from "@/models";
import { audit } from "@/lib/audit";

// POST { decision: "Approved" | "Rejected", note? }
// On approval the parked action is replayed here, so approval and execution stay in one
// place rather than being re-implemented per module.
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "approvals.decide"); // togglable (2026-08-11)
  // QA-1844 (checker, qa-1825 cycle 3, confirmed live again in cycles 4-6): the CEO's sentence has
  // TWO halves — *"कॉस्ट की **अप्रूवल** … और **विजिबिलिटी** …"* — and Unit 1 spent six cycles on the
  // second one. An Admin with `finance.view: null` POSTed `{decision:"Approved"}` to a parked cost
  // and it went through: 200, persisted, `decided_by` their name, no 403 anywhere. They could not
  // SEE the figure by then, and approved it anyway.
  //
  // Which actions this covers is derived from the payload's own effect, not from a list of names:
  // an action whose replay writes or moves money is a money decision. The others (location.close,
  // location.stop, batch.cancel, batch.complete, location.edit) stay on `approvals.decide`, because
  // narrowing them would take the queue away from the Operations users whose job it is.
  const MONEY_ACTIONS = new Set(["cost.post", "invoice.raise", "invoice.paid"]);
  const { id } = await ctx.params;
  const { decision, note } = await readJson(req);
  if (!["Approved", "Rejected"].includes(decision)) throw new HttpError(400, "decision must be Approved or Rejected");

  // The gate has to run BEFORE decideApproval, which writes the decision. Gating after it would
  // refuse the caller AFTER their Rejected had already been persisted — the request would be closed
  // by someone the product just said may not close it. So the action is read first, cheaply.
  // A Rejected is gated too: refusing a payment is a money decision as much as allowing one.
  const pending = await ApprovalRequest.findById(id).select("action").lean<any>();
  if (!pending) throw new HttpError(404, "Approval request not found");
  if (MONEY_ACTIONS.has(pending.action)) await requireFinance(user, "approve");

  const request = await decideApproval(id, user, decision, note);
  // The REJECT path hands back the same document and was the same leak; masked identically rather
  // than only fixing the branch the review happened to quote.
  if (decision !== "Approved") {
    const seeMoney = await hasPermission(user, FINANCE_VIEW);
    return NextResponse.json({ item: maskApprovalMoney(request.toObject ? request.toObject() : request, seeMoney), applied: false });
  }

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
    case "location.edit": {
      // R-F: apply the SPOC's parked suggestion. The fixed ten are stripped again here —
      // the park-side check is the UX, this is the guarantee.
      const FIXED = ["code", "external_id", "name", "city", "state", "district", "operating_partner", "tc_id", "tc_password", "tc_status", "approval_status", "operational_status"]; // QA-089: sheet-truth complete
      if (p.patch) {
        const patch = { ...p.patch };
        for (const f of FIXED) delete patch[f];
        if (Object.keys(patch).length) {
          // QA-621 cycle 4 / QA-1502 cycle 6: a parked SPOC/Principal/Cluster-Head name change
          // lands HERE, via findByIdAndUpdate rather than crud.ts's beforeUpdate — its own,
          // separate write path, which used to mean its own copy of the generation bump. The
          // query middleware on LocationSchema (models/index.ts) now does it for every Mongoose
          // write, and it still compares against whatever the slot's occupant is RIGHT NOW rather
          // than what it was when the suggestion was typed, which may be stale by approval time.
          await Location.findByIdAndUpdate(request.entity_id, patch);
        }
      }
      if (p.target?.program) {
        await LocationTarget.findOneAndUpdate(
          { location: request.entity_id, program: p.target.program },
          { $set: p.target.set ?? {} },
          { upsert: true, new: true },
        );
      }
      // QA-075: a SPOC's classroom/lab suggestion — the Room is created only on approval.
      if (p.room?.name && p.room?.type) {
        await Room.create({ location: request.entity_id, name: p.room.name, type: p.room.type, capacity: p.room.capacity, active: true });
      }
      break;
    }
    case "cost.post": {
      // R-E: the ledger row is written only here — approval IS the write. It belongs to the
      // person who posted it (entered_by = initiator), with the approval trail alongside.
      await assertCostEntryValid(p);
      const cost = await CostEntry.create({
        entry_date: p.entry_date ?? request.createdAt,
        location: p.location || undefined, batch: p.batch || undefined, trainer: p.trainer || undefined,
        category: p.category, amount: p.amount, note: p.note,
        entered_by: request.initiator,
              // QA-1828b: the SECOND place a CostEntry is built. The inbound payload was never filtered
        // (`payload: body` in costs/route.ts), so a new form field reaches the queue for free and is
        // then dropped HERE unless it is named — which would make an entry's contents depend on
        // whether the cost.post rule happened to be enabled. Same fields, same order, deliberately.
        vendor_payee: p.vendor_payee || undefined,
        voucher_no: p.voucher_no || undefined,
        payment_mode: p.payment_mode || undefined,
        // An entry that went through the queue was NOT pre-approved - somebody decided it. The basis
        // is still recorded, because it is what they decided against.
        pre_approved_applied: false,
        pre_approved_basis: p._pre_approved_basis || undefined,
});
      await audit({ entity: "CostEntry", entityId: cost._id, newValue: `created via approval ${request._id}`, actor: user.id });
      break;
    }
    default:
      throw new HttpError(400, "Approved request has no replay handler: " + request.action);
  }
  // Senior review of cycles 2-4: this handed back the RAW request — full `payload` (amount,
  // invoice_no) and the original summary — to whoever decided it. The door here is
  // `approvals.decide`, not `finance.view`, and `decideApproval` admits anyone whose role matches
  // the rule's `approver_role` (default "Admin"). So the sibling GET was masked in cycle 4 and the
  // decide response, one file away, handed the same figure over the instant the button was pressed.
  const canSeeMoney = await hasPermission(user, FINANCE_VIEW);
  return NextResponse.json({ item: maskApprovalMoney(request.toObject ? request.toObject() : request, canSeeMoney), applied: true });
});
