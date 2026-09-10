import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError, readJson } from "@/lib/authz";
import { requirePerm, requireFinance, hasPermission, maskApprovalMoney, FINANCE_VIEW } from "@/lib/permissions";
import { decideApproval, finalizeApprovalDecision, rollbackApprovalDecision } from "@/lib/approvals";
import { assertActiveCostCategory, assertCostEntryValid, createCostEntryIdempotently, transitionBatch, updateInvoiceChecked } from "@/lib/rules";
import { ApprovalRequest, CostEntry, Location, LocationTarget, Room, CostCategory, COST_PAYMENT_MODE } from "@/models";
import { audit } from "@/lib/audit";
import { Types } from "mongoose";

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
  // QA-1828c: a new head carries `budget` and `pre_approved_amount`, and approving one also posts
  // the cost entry that prompted it. Both halves write money, so it belongs here by this file's own
  // stated criterion rather than as an exception to it.
  const MONEY_ACTIONS = new Set(["cost.post", "invoice.raise", "invoice.paid", "costcategory.create"]);
  const { id } = await ctx.params;
  // QA-1828c: `map_to_category` is the CEO's first option - *"एप्रोप्रियेट हेड सब हेड में डाल पाएं
  // या फिर एक नया हेड और सब हेड क्रिएट करें"*. Approving WITHOUT it creates the head the poster
  // proposed; approving WITH it files the cost under an existing head instead and creates nothing.
  // Both are an approval, because in both cases the cost is real and belongs somewhere - only the
  // taxonomy differs, and that is the approver's expertise, not the poster's.
  const { decision, note, map_to_category, approved_amount } = await readJson(req);
  if (!["Approved", "Rejected"].includes(decision)) throw new HttpError(400, "decision must be Approved or Rejected");

  // The gate has to run BEFORE decideApproval, which writes the decision. Gating after it would
  // refuse the caller AFTER their Rejected had already been persisted — the request would be closed
  // by someone the product just said may not close it. So the action is read first, cheaply.
  // A Rejected is gated too: refusing a payment is a money decision as much as allowing one.
  // QA-1981: this used to select ONLY "action", and the QA-1975 pre-validation added directly
  // below then read `pending.payload` from it - a field that was never loaded. It was therefore
  // `undefined` on every request, `?? {}` turned that into an empty object, and
  // `assertCostEntryValid` refused it for having no location, batch or trainer. Every single
  // costcategory.create approval answered 400, by both paths, mapped or not.
  //
  // So the fix for "the queue can half-write" shipped as "the queue cannot write at all", which is
  // strictly worse than the defect it closed - and I did not run the suite that would have said so.
  // e2e-cost-entry caught it immediately: 25 passed / 5 failed, and the three consequence pins
  // ("the head now exists", "the entry is in the ledger") failed downstream of the two 400s rather
  // than independently. The pins were right; nobody ran them.
  const pending = await ApprovalRequest.findById(id).select("action payload").lean<any>();
  if (!pending) throw new HttpError(404, "Approval request not found");
  if (MONEY_ACTIONS.has(pending.action)) await requireFinance(user, "approve");

  // A finance approver may sanction less than was requested, never more. The original request
  // remains in payload.amount; approved_amount is a separate decision fact. A partial approval
  // without a note would leave the raiser unable to understand the cut, so it is refused here.
  const canPartiallyApprove = pending.action === "cost.post" || pending.action === "costcategory.create";
  let sanctionedAmount: number | undefined;
  if (approved_amount !== undefined && approved_amount !== null && approved_amount !== "") {
    if (decision !== "Approved" || !canPartiallyApprove) {
      throw new HttpError(400, "approved_amount is only valid while approving a cost entry.");
    }
    const requested = Number((pending.payload ?? {}).amount);
    sanctionedAmount = Number(approved_amount);
    if (!(sanctionedAmount > 0) || !Number.isFinite(requested) || sanctionedAmount > requested) {
      throw new HttpError(400, "Approved amount must be positive and cannot exceed the requested amount.");
    }
    if (sanctionedAmount < requested && !String(note ?? "").trim()) {
      throw new HttpError(400, "Add a note explaining a partial approval.");
    }
  }

  // QA-1975 (checker, cycle 1) — THE QUEUE COULD HALF-WRITE, AND THE HALF IT WROTE WAS PERMANENT.
  //
  // `decideApproval` saves the request as Approved and only THEN does the replay run. So on a
  // costcategory.create whose payload cannot make a valid CostEntry, the checker measured
  // `headCreated=true entryCreated=false approvalStatus=Approved` — a cost head invented, no ledger
  // row, and a request that can never be decided again because it is no longer Pending.
  //
  // This unit's own manifest says "a queue that half-writes is worse than no queue". That was a
  // specification, and it failed in the one direction I never probed: I checked that NOTHING is
  // written before approval, and never that EVERYTHING is written after it.
  //
  // Validating here rather than making the two writes atomic is the honest fix at this size: the
  // route has no transaction, and a rollback that itself fails would just move the problem. What it
  // does guarantee is that the payload which reaches the replay can produce an entry, so the second
  // write cannot fail on data the first write already committed to.
  if (decision === "Approved" && pending.action === "costcategory.create") {
    const pp = (pending.payload ?? {}) as any;
    assertCostEntryValid({ ...pp, amount: sanctionedAmount ?? pp.amount, category: pp.category ?? "pending" }); // Rule 37, before anything is written
    if (pp.payment_mode && !COST_PAYMENT_MODE.includes(pp.payment_mode)) {
      throw new HttpError(400, `This request carries a payment mode this system does not use ("${pp.payment_mode}"). Reject it and ask for it again.`);
    }
    if (map_to_category) {
      // Checked here as well as in the replay, because reaching the replay means the decision is
      // already saved. QA-1980: a deactivated head is not a place to file new money either.
      const target = await CostCategory.findById(String(map_to_category)).select("_id active").lean<any>();
      if (!target) throw new HttpError(400, "That cost head no longer exists — pick another, or approve the new one as proposed.");
      if (target.active === false) throw new HttpError(400, "That cost head has been deactivated, so new costs should not be filed under it. Pick an active one, or approve the new head as proposed.");
    }
  }

  const request = await decideApproval(id, user, decision, note, { approvedAmount: sanctionedAmount });
  // The REJECT path hands back the same document and was the same leak; masked identically rather
  // than only fixing the branch the review happened to quote.
  if (decision !== "Approved") {
    await finalizeApprovalDecision(request, user, decision, { approvedAmount: sanctionedAmount });
    const seeMoney = await hasPermission(user, FINANCE_VIEW);
    return NextResponse.json({ item: maskApprovalMoney(request.toObject ? request.toObject() : request, seeMoney), applied: false });
  }
  if (decision === "Approved" && pending.action === "cost.post") {
    await assertActiveCostCategory((pending.payload as any)?.category);
  }

  const p = (request.payload ?? {}) as any;
  let effectApplied = false;
  // Only populated when THIS request owns an inactive staged head. A replay failure may reopen the
  // request only after its own deterministic cost has been cancelled and this exact unpublished
  // head has been conditionally removed.
  let stagedCategory: { id: Types.ObjectId; name: string; costId: Types.ObjectId } | null = null;
  try {
    switch (request.action) {
    case "location.close":
    case "location.stop":
      await Location.findByIdAndUpdate(request.entity_id, {
        operational_status: request.action === "location.close" ? "Closed" : "Stopped",
        status_reason: p.reason, status_changed_on: new Date(),
      });
      effectApplied = true;
      break;
    case "batch.cancel":
      await transitionBatch(String(request.entity_id), "Cancelled", { isAdmin: true, reason: p.reason });
      effectApplied = true;
      break;
    case "batch.complete":
      await transitionBatch(String(request.entity_id), "Completed", { isAdmin: true });
      effectApplied = true;
      break;
    case "invoice.raise":
    case "invoice.paid":
      await updateInvoiceChecked(String(request.entity_id), p);
      effectApplied = true;
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
      effectApplied = true;
      break;
    }
    case "costcategory.create": {
      // The WHOLE cost entry parked, not just the taxonomy request (Umesh, D8): nothing reaches the
      // ledger until somebody has decided where it belongs. So this replay does both writes, in the
      // order that makes the second possible.
      let categoryId = map_to_category ? String(map_to_category) : "";
      if (categoryId) {
        await assertActiveCostCategory(categoryId);
      } else {
        const name = String(p.new_subhead ?? "").trim();
        if (!name) throw new HttpError(400, "This request names no new head, and no existing head was chosen to file it under.");
        const requestId = new Types.ObjectId(String(request._id));
        const parent = p.new_head_parent ? new Types.ObjectId(String(p.new_head_parent)) : undefined;
        const expectedHead = {
          _id: requestId, name, active: false,
          staged_by_approval: requestId,
          ...(parent ? { parent } : {}),
        };
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const sameName = { name: { $regex: `^${escaped}$`, $options: "i" } };
        let existing: any = await CostCategory.collection.findOne(sameName);
        if (!existing) {
          try {
            const now = new Date();
            await CostCategory.collection.insertOne({ ...expectedHead, createdAt: now, updatedAt: now });
            existing = expectedHead;
          } catch (createError) {
            // Either our insert was acknowledged ambiguously or a same-name writer won. Only our
            // exact inactive row is resumable; an independently published head may be reused.
            existing = await CostCategory.collection.findOne(sameName);
            if (!existing) throw createError;
          }
        }
        if (String(existing._id) === String(requestId)
            && existing.active === false
            && String(existing.staged_by_approval) === String(requestId)
            && String(existing.parent ?? "") === String(parent ?? "")) {
          categoryId = String(requestId);
          stagedCategory = { id: requestId, name, costId: requestId };
        } else if (existing.active !== false && !existing.staged_by_approval) {
          categoryId = String(existing._id);
        } else {
          throw new HttpError(409, `"${name}" is inactive or currently staged by another approval. This request remains claimed for reconciliation.`);
        }
        if (stagedCategory && /^center_erp_ci(?:_|$)/.test(process.env.MONGODB_DB ?? "")) {
          if (Number(p._test_pause_after_head_ms) > 0) {
            await new Promise((resolve) => setTimeout(resolve, Number(p._test_pause_after_head_ms)));
          }
          if (p._test_fail_after_head === true) {
            throw new Error("test-only failure after staged cost head creation");
          }
        }
      }
      const approvedAmount = Number(request.approved_amount ?? p.amount);
      await assertCostEntryValid({ ...p, amount: approvedAmount, category: categoryId });
      const costId = new Types.ObjectId(String(request._id));
      const entryDraft = {
        _id: costId,
        entry_date: new Date(p.entry_date ?? request.createdAt),
        location: p.location ? new Types.ObjectId(String(p.location)) : undefined,
        batch: p.batch ? new Types.ObjectId(String(p.batch)) : undefined,
        trainer: p.trainer ? new Types.ObjectId(String(p.trainer)) : undefined,
        category: new Types.ObjectId(categoryId), amount: approvedAmount, requested_amount: Number(p.amount),
        approval_request: new Types.ObjectId(String(request._id)), payment_status: "Payment Pending", note: p.note,
        vendor_payee: p.vendor_payee || undefined,
        voucher_no: p.voucher_no || undefined,
        payment_mode: p.payment_mode || undefined,
        pre_approved_applied: false,
        reservation_state: stagedCategory ? "Pending" : "Applied",
        ...(stagedCategory ? { reservation_kind: "ApprovalHead" } : {}),
        entered_by: new Types.ObjectId(String(request.initiator)),
      };
      const entry = await createCostEntryIdempotently(entryDraft, {
        simulateAmbiguousAfterCreate: p._test_ambiguous_after_create === true
          && /^center_erp_ci(?:_|$)/.test(process.env.MONGODB_DB ?? ""),
      });
      if (stagedCategory) {
        if (p._test_fail_after_cost_before_publish === true
            && /^center_erp_ci(?:_|$)/.test(process.env.MONGODB_DB ?? "")) {
          throw new Error("test-only failure after staged cost creation before head publish");
        }
        const published = await CostCategory.collection.updateOne(
          { _id: stagedCategory.id, active: false, staged_by_approval: request._id },
          { $set: { active: true, updatedAt: new Date() }, $unset: { staged_by_approval: "" } },
        );
        if (published.modifiedCount !== 1) {
          const current = await CostCategory.collection.findOne({ _id: stagedCategory.id }, { projection: { active: 1, staged_by_approval: 1 } });
          if (current?.active !== true || current?.staged_by_approval) {
            throw new Error("The staged cost head could not be published by its owning approval.");
          }
        }
        const applied = await CostEntry.collection.updateOne(
          {
            _id: costId,
            approval_request: request._id,
            reservation_kind: "ApprovalHead",
            reservation_state: "Pending",
          },
          { $set: { reservation_state: "Applied", updatedAt: new Date() } },
        );
        if (applied.modifiedCount !== 1) {
          const current = await CostEntry.collection.findOne({ _id: costId }, { projection: { reservation_state: 1 } });
          if (current?.reservation_state !== "Applied") {
            throw new Error("The staged head was published but its associated cost could not be made visible.");
          }
        }
      }
      effectApplied = true;
      if (stagedCategory) {
        await audit({ entity: "CostCategory", entityId: stagedCategory.id, field: "created", newValue: `"${stagedCategory.name}" created by approving ${request.initiator}'s cost entry`, actor: user.id });
      }
      await audit({ entity: "CostEntry", entityId: entry._id, newValue: map_to_category ? "created (filed under an existing head by the approver)" : "created (new head approved)", actor: user.id });
      break;
    }
    case "cost.post": {
      // R-E: the ledger row is written only here — approval IS the write. It belongs to the
      // person who posted it (entered_by = initiator), with the approval trail alongside.
      const approvedAmount = Number(request.approved_amount ?? p.amount);
      await assertCostEntryValid({ ...p, amount: approvedAmount });
      await assertActiveCostCategory(p.category);
      const cost = await createCostEntryIdempotently({
        _id: new Types.ObjectId(String(request._id)),
        entry_date: new Date(p.entry_date ?? request.createdAt),
        location: p.location ? new Types.ObjectId(String(p.location)) : undefined,
        batch: p.batch ? new Types.ObjectId(String(p.batch)) : undefined,
        trainer: p.trainer ? new Types.ObjectId(String(p.trainer)) : undefined,
        category: new Types.ObjectId(String(p.category)), amount: approvedAmount, requested_amount: Number(p.amount),
        approval_request: new Types.ObjectId(String(request._id)), payment_status: "Payment Pending", note: p.note,
        entered_by: new Types.ObjectId(String(request.initiator)),
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
        reservation_state: "Applied",
      }, {
        simulateAmbiguousAfterCreate: p._test_ambiguous_after_create === true
          && /^center_erp_ci(?:_|$)/.test(process.env.MONGODB_DB ?? ""),
      });
      effectApplied = true;
      await audit({ entity: "CostEntry", entityId: cost._id, newValue: `created via approval ${request._id}`, actor: user.id });
      break;
    }
    default:
      throw new HttpError(400, "Approved request has no replay handler: " + request.action);
    }
  } catch (error) {
    if (effectApplied) {
      // The business write landed; do not reopen the request and risk replaying it. Best-effort
      // finalization keeps the queue and notification consistent even when a following audit fails.
      await finalizeApprovalDecision(request, user, decision, { approvedAmount: sanctionedAmount }).catch(() => {});
    } else {
      if (stagedCategory) {
        // Compensate the deterministic associated cost first. Only our own Pending row may become
        // Cancelled; Applied or foreign data means the effect may be visible, so fail closed. Once
        // cancellation is proven, remove that exact hidden row so reopening the request can reuse
        // its deterministic id instead of being permanently poisoned by its own tombstone.
        const cost = await CostEntry.collection.findOne({ _id: stagedCategory.costId });
        if (cost) {
          const cancelled = await CostEntry.collection.updateOne(
            {
              _id: stagedCategory.costId,
              approval_request: request._id,
              category: stagedCategory.id,
              reservation_kind: "ApprovalHead",
              reservation_state: "Pending",
            },
            { $set: { reservation_state: "Cancelled", reservation_cancel_reason: "approval replay failed", updatedAt: new Date() } },
          );
          const after = await CostEntry.collection.findOne({ _id: stagedCategory.costId }, { projection: { reservation_state: 1 } });
          if (cancelled.modifiedCount !== 1 && after?.reservation_state !== "Cancelled") {
            throw new HttpError(500, `Approval apply failed after staging "${stagedCategory.name}", but its associated cost could not be safely cancelled. The request remains claimed for manual reconciliation.`);
          }
          const removedCost = await CostEntry.collection.deleteOne({
            _id: stagedCategory.costId,
            approval_request: request._id,
            category: stagedCategory.id,
            reservation_kind: "ApprovalHead",
            reservation_state: "Cancelled",
          });
          const costStillThere = await CostEntry.collection.findOne(
            { _id: stagedCategory.costId },
            { projection: { reservation_state: 1 } },
          );
          if (removedCost.deletedCount !== 1 || costStillThere) {
            throw new HttpError(500, `Approval apply failed after staging "${stagedCategory.name}", but removal of its cancelled associated cost could not be proven. The request remains claimed for manual reconciliation.`);
          }
        }
        const removed = await CostCategory.collection.deleteOne({
          _id: stagedCategory.id,
          name: stagedCategory.name,
          active: false,
          staged_by_approval: request._id,
        });
        const stillThere = await CostCategory.collection.findOne({ _id: stagedCategory.id }, { projection: { active: 1, staged_by_approval: 1 } });
        if (removed.deletedCount !== 1 || stillThere) {
          throw new HttpError(500, `Approval apply failed after staging "${stagedCategory.name}" and safe compensation could not be proven. The request remains claimed for manual reconciliation; it was not reopened for replay.`);
        }
      }
      try {
        await rollbackApprovalDecision(request);
      } catch (rollbackError) {
        const detail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new HttpError(500, `Approval apply failed and its claim could not be released safely: ${detail}`);
      }
    }
    throw error;
  }
  await finalizeApprovalDecision(request, user, decision, { approvedAmount: sanctionedAmount });
  // Senior review of cycles 2-4: this handed back the RAW request — full `payload` (amount,
  // invoice_no) and the original summary — to whoever decided it. The door here is
  // `approvals.decide`, not `finance.view`, and `decideApproval` admits anyone whose role matches
  // the rule's `approver_role` (default "Admin"). So the sibling GET was masked in cycle 4 and the
  // decide response, one file away, handed the same figure over the instant the button was pressed.
  const canSeeMoney = await hasPermission(user, FINANCE_VIEW);
  return NextResponse.json({ item: maskApprovalMoney(request.toObject ? request.toObject() : request, canSeeMoney), applied: true });
});
