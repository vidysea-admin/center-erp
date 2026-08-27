import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { decideApproval } from "@/lib/approvals";
import { assertCostEntryValid, transitionBatch, updateInvoiceChecked } from "@/lib/rules";
import { CostEntry, Location, LocationTarget, Room } from "@/models";
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
      });
      await audit({ entity: "CostEntry", entityId: cost._id, newValue: `created via approval ${request._id}`, actor: user.id });
      break;
    }
    default:
      throw new HttpError(400, "Approved request has no replay handler: " + request.action);
  }
  return NextResponse.json({ item: request, applied: true });
});
