import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, isScoped, HttpError, readJson } from "@/lib/authz";
import { requireFinance } from "@/lib/permissions";
import { CostEntry, COST_PAYMENT_MODE } from "@/models";
import { assertActiveCostCategory, assertCostEntryValid } from "@/lib/rules";
import { auditDiff } from "@/lib/audit";
import { costDeletionAuditIsDurable, costFinanceAuditOutboxIsSettled, ensureCostDeletionAuditEvent, garbageCollectSettledCostDeletion, settleFinanceAuditEvents } from "@/lib/approvals";
import { Types } from "mongoose";

// Cost entries were write-once (no update/delete route existed) — but sheet-imported costs
// (Batch_Master's four cost columns) can carry a wrong amount or category, so an entry must be
// correctable or removable. Rule 38 applies to by-ID writes.
//
// QA-1825: these two verbs moved from `costs.manage` (the POST-a-cost right) to
// `finance.approve`. Rewriting an amount that is already in the ledger, or deleting the row so
// "the amount disappears from every total", is deciding money — it is the same act the CEO put
// behind the two-point check, not the act of submitting an entry for someone else to check.

async function loadInScope(user: Awaited<ReturnType<typeof requireUser>>, id: string) {
  const doc = await CostEntry.findById(id);
  if (!doc) throw new HttpError(404, "Cost entry not found");
  if (isScoped(user)) {
    // Fail closed: an entry with no location is not writable by a scoped user.
    if (!doc.location || !user.location_scope.map(String).includes(String(doc.location))) {
      throw new HttpError(403, "Out of scope");
    }
  }
  return doc;
}

async function loadDeletionTombstoneInScope(user: Awaited<ReturnType<typeof requireUser>>, id: string) {
  if (!Types.ObjectId.isValid(id)) return null;
  const doc: any = await CostEntry.collection.findOne({ _id: new Types.ObjectId(id), deletion_state: "Pending" });
  if (!doc) return null;
  if (isScoped(user) && (!doc.location || !user.location_scope.map(String).includes(String(doc.location)))) {
    throw new HttpError(403, "Out of scope");
  }
  return doc;
}

export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requireFinance(user, "approve");
  requireEdit(user);
  const { id } = await ctx.params;
  if (await loadDeletionTombstoneInScope(user, id)) {
    throw new HttpError(409, "This cost has already been deleted and its audit history is being finalized.");
  }
  const doc = await loadInScope(user, id);
  const body = await readJson(req);
  const isTestDb = /^center_erp_ci(?:_|$)/.test(process.env.MONGODB_DB ?? "");
  const patchBarrier = isTestDb ? String(req.nextUrl.searchParams.get("_test_wait_after_patch_load") ?? "").slice(0, 100) : "";
  if (patchBarrier) {
    await CostEntry.collection.updateOne(
      { _id: doc._id, deletion_state: { $exists: false } },
      { $set: { _test_patch_loaded_barrier: patchBarrier } } as any,
    );
    for (let i = 0; i < 100; i++) {
      const held: any = await CostEntry.collection.findOne(
        { _id: doc._id }, { projection: { _test_patch_loaded_barrier: 1 } },
      );
      if (held?._test_patch_loaded_barrier !== patchBarrier) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (body.mark_paid === true) {
    if (doc.payment_status === "Paid") throw new HttpError(409, "This cost is already recorded as paid.");
    const paymentRef = String(body.payment_ref ?? "").trim();
    const payee = String(body.vendor_payee ?? doc.vendor_payee ?? "").trim();
    const mode = String(body.payment_mode ?? doc.payment_mode ?? "").trim();
    const paidOn = body.paid_on ? new Date(body.paid_on) : new Date();
    if (!payee) throw new HttpError(400, "Paid to is required before payment can be recorded.");
    if (!paymentRef) throw new HttpError(400, "Payment reference is required before payment can be recorded.");
    if (!COST_PAYMENT_MODE.includes(mode as any)) throw new HttpError(400, "Choose how this payment was made.");
    if (Number.isNaN(paidOn.getTime())) throw new HttpError(400, "Payment date is invalid.");
    const before = doc.toObject();
    const paymentPatch = {
      vendor_payee: payee, payment_mode: mode, payment_status: "Paid",
      paid_on: paidOn, payment_ref: paymentRef,
    };
    const updated = await CostEntry.findOneAndUpdate(
      { _id: doc._id, deletion_state: { $exists: false } },
      { $set: paymentPatch },
      { new: true, runValidators: true },
    );
    if (!updated) throw new HttpError(409, "This cost was deleted while the payment update was being prepared. Nothing changed.");
    await auditDiff("CostEntry", updated._id, before, paymentPatch, user.id);
    return NextResponse.json({ item: updated });
  }
  const patch: Record<string, unknown> = {};
  // QA-1828b: the new entry-side fields are editable by the same finance.approve holder who can
  // already edit the amount. NOT the pre-approved snapshot - that is a record of what was decided at
  // post time, and a field somebody can edit afterwards is not a record of anything.
  for (const f of ["entry_date", "location", "batch", "trainer", "category", "amount", "note", "vendor_payee", "voucher_no", "payment_mode"]) {
    if (body[f] !== undefined) patch[f] = body[f] === "" ? undefined : body[f];
  }
  // A formula pre-approval reserves cumulative capacity against this exact batch, category and
  // amount when the row is created. Moving or resizing the row later without atomically moving that
  // reservation would make the ledger and the cap disagree, so fail closed on those three fields.
  // Descriptive and payment fields remain editable through their normal paths.
  if (doc.pre_approved_applied && doc.pre_approved_unit === "Per billable passed") {
    const changesReservation =
      (body.amount !== undefined && Number(body.amount) !== Number(doc.amount))
      || (body.batch !== undefined && String(body.batch || "") !== String(doc.batch || ""))
      || (body.category !== undefined && String(body.category || "") !== String(doc.category || ""));
    if (changesReservation) {
      throw new HttpError(409, "A pre-approved cost cannot change its amount, batch, or category after its commitment has been applied.");
    }
  }
  const before = doc.toObject();
  assertCostEntryValid({ ...before, ...patch }); // Rule 37 on the merged entry
  if (patch.category !== undefined) await assertActiveCostCategory(patch.category);
  const setPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const unsetPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value === undefined).map(([field]) => [field, 1]));
  const update = {
    ...(Object.keys(setPatch).length ? { $set: setPatch } : {}),
    ...(Object.keys(unsetPatch).length ? { $unset: unsetPatch } : {}),
  };
  const updated = await CostEntry.findOneAndUpdate(
    { _id: doc._id, deletion_state: { $exists: false } },
    update,
    { new: true, runValidators: true },
  );
  if (!updated) throw new HttpError(409, "This cost was deleted while the correction was being prepared. Nothing changed.");
  await auditDiff("CostEntry", updated._id, before, patch, user.id);
  return NextResponse.json({ item: updated });
});

export const DELETE = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requireFinance(user, "approve");
  requireEdit(user);
  const { id } = await ctx.params;
  // QA-2484: a stated reason is required before ANY of this runs. Deliberately the first thing
  // after the rights check and ahead of every load, barrier and claim below, so a request that
  // cannot explain itself never reaches the staging update at all - QA-2457's lesson applied on
  // purpose rather than by accident: the refusal that must come first is written first.
  // Same shape as the batch force-delete (batches/[id] :89), which is the product's existing
  // answer to this question; costs were the outlier.
  let reason = "";
  try { const body = await readJson(req); reason = String(body?.reason ?? "").trim().slice(0, 500); } catch { /* no body */ }
  if (!reason) {
    throw new HttpError(400, "Say why this cost is being removed. The amount disappears from every total, and the reason is the only part of that a reader cannot work out afterwards.");
  }
  const tombstone = await loadDeletionTombstoneInScope(user, id);
  const doc = tombstone ?? await loadInScope(user, id);
  const isTestDb = /^center_erp_ci(?:_|$)/.test(process.env.MONGODB_DB ?? "");
  const deleteBarrier = isTestDb ? String(req.nextUrl.searchParams.get("_test_wait_after_delete_load") ?? "").slice(0, 100) : "";
  if (deleteBarrier) {
    await CostEntry.collection.updateOne(
      { _id: doc._id, deletion_state: { $exists: false } },
      { $set: { _test_delete_loaded_barrier: deleteBarrier } } as any,
    );
    for (let i = 0; i < 100; i++) {
      const held: any = await CostEntry.collection.findOne(
        { _id: doc._id }, { projection: { _test_delete_loaded_barrier: 1 } },
      );
      if (held?._test_delete_loaded_barrier !== deleteBarrier) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  // Deleting an applied row would free the visible ledger amount without returning the atomic
  // reservation, allowing the same commitment to be spent again. Preserve the original record.
  if (doc.pre_approved_applied && doc.pre_approved_unit === "Per billable passed") {
    throw new HttpError(409, "A pre-approved cost cannot be deleted after its commitment has been applied.");
  }
  // Both creation and deletion are durable owner-backed events. Stage the deletion event before
  // the irreversible remove, then fail closed until every event is confirmed in AuditLog. A crash
  // or outage can therefore resume from this CostEntry instead of losing the deletion history.
  const claim = await ensureCostDeletionAuditEvent({
    costId: doc._id,
    actor: user.id,
    expectedUpdatedAt: doc.updatedAt,
    oldValue: { amount: doc.amount, note: doc.note },
    reason,
  });
  if (!claim.claimed && claim.actor !== String(user.id)) {
    throw new HttpError(409, "Another authorized user already committed this deletion. Its audit history is being finalized.");
  }
  const pauseAfterClaim = isTestDb ? Math.min(Number(req.nextUrl.searchParams.get("_test_pause_after_delete_claim_ms")) || 0, 1000) : 0;
  if (pauseAfterClaim > 0) await new Promise((resolve) => setTimeout(resolve, pauseAfterClaim));
  const injectedFailure = isTestDb && req.nextUrl.searchParams.get("_test_fail_audit") === "before"
    ? "before" as const
    : isTestDb && req.nextUrl.searchParams.get("_test_fail_audit") === "after" ? "after" as const : undefined;
  await settleFinanceAuditEvents({ costIds: [doc._id], failure: injectedFailure }).catch(() => {});
  if (!(await costFinanceAuditOutboxIsSettled(doc._id))) {
    if (await costDeletionAuditIsDurable({
      costId: doc._id, eventId: claim.eventId, actor: claim.actor,
      oldValue: { amount: doc.amount, note: doc.note }, reason,
    })) return NextResponse.json({ ok: true });
    throw new HttpError(409, "This cost's audit history is still being recorded. Nothing was deleted; retry after the audit trail recovers.");
  }
  if (!(await garbageCollectSettledCostDeletion(doc._id))) {
    if (await costDeletionAuditIsDurable({
      costId: doc._id, eventId: claim.eventId, actor: claim.actor,
      oldValue: { amount: doc.amount, note: doc.note }, reason,
    })) return NextResponse.json({ ok: true });
    throw new HttpError(409, "This cost changed while its audit history was being checked. Nothing was deleted; refresh and retry.");
  }
  return NextResponse.json({ ok: true });
});
