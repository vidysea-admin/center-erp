import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, isScoped, HttpError, readJson, assertLocationInScope } from "@/lib/authz";
import { FINANCE_VIEW, hasFinanceApprove, hasPermission, maskApprovalMoney, requirePerm } from "@/lib/permissions";
import { ApprovalRequest, Batch, CostEntry, COST_PAYMENT_MODE } from "@/models";
import { assertActiveCostCategory, assertBatchInScope, assertCostEntryValid, assertTrainerInScope, COST_MATERIAL_FIELDS, COST_OWN_FIELDS, evaluateCostEditPreApproval, isCostCreator, pendingCostEditRequest, stampCostApprovals } from "@/lib/rules";
import { auditDiff } from "@/lib/audit";
import { costDeletionAuditIsDurable, costDeletionSnapshot, costFinanceAuditOutboxIsSettled, ensureCostDeletionAuditEvent, financeAuditEvent, garbageCollectSettledCostDeletion, notifyCostCorrection, requireApproval, settleFinanceAuditEvents } from "@/lib/approvals";
import { Types } from "mongoose";
import { approvedCostSentence, costIsApproved, isBareOtherHeadName, OTHER_HEAD_NEEDS_NAME } from "@/lib/validate";
import { createHash } from "node:crypto";

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

// QA-2910 (S2): the optional association ids of a cost edit (centre, batch, trainer, head) must be
// well-formed BEFORE any write, claim or approval request. An unscoped creator who kept a valid batch
// and sent a malformed centre passed every scope helper (they return at once for unscoped users) and
// Rule 37 (any association will do), and the creator path then persisted its owner/proposal claim
// before ApprovalRequest's ObjectId cast failed - a half-write. Omitted, null and "" mean "no value"
// (clearing stays legal where Rule 37 allows); anything else must be a 24-hex string or an ObjectId.
const COST_ASSOCIATION_FIELDS = ["location", "batch", "trainer", "category"] as const;
function assertCostAssociationIds(body: Record<string, unknown>) {
  for (const f of COST_ASSOCIATION_FIELDS) {
    const v = body[f];
    if (v === undefined || v === null || v === "") continue;
    if (v instanceof Types.ObjectId) continue;
    if (typeof v === "string" && /^[0-9a-fA-F]{24}$/.test(v)) continue;
    throw new HttpError(400, `The ${f} is invalid.`);
  }
}

export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  // mtg-b3 R10: everyone WITHOUT the finance approve right takes the creator path below, which asks
  // for costs.manage and for the entry to be their own. Finance keeps exactly what it had.
  const { id } = await ctx.params;
  if (!(await hasFinanceApprove(user))) return patchOwnCost(user, req, id);
  requireEdit(user);
  if (await loadDeletionTombstoneInScope(user, id)) {
    throw new HttpError(409, "This cost has already been deleted and its audit history is being finalized.");
  }
  const doc = await loadInScope(user, id);
  const body = await readJson(req);
  const pendingOwner: any = await CostEntry.collection.findOne({ _id: doc._id }, { projection: { cost_edit_request: 1 } });
  if (pendingOwner?.cost_edit_request || await pendingCostEditRequest(doc._id)) {
    throw new HttpError(409, "A creator change is waiting for approval. Decide it before correcting or paying this cost.");
  }
  const isTestDb = /^center_erp_ci(?:_|$)/.test(process.env.MONGODB_DB ?? "");
  const patchBarrier = isTestDb ? String(req.nextUrl.searchParams.get("_test_wait_after_patch_load") ?? "").slice(0, 100) : "";
  if (patchBarrier) {
    await CostEntry.collection.updateOne(
      { _id: doc._id, deletion_state: { $exists: false }, archived_at: null, cost_edit_request: null,
        updatedAt: doc.updatedAt, payment_status: { $ne: "Paid" } },
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
      { _id: doc._id, deletion_state: { $exists: false }, archived_at: null, cost_edit_request: null,
        updatedAt: doc.updatedAt, payment_status: { $ne: "Paid" } },
      { $set: paymentPatch },
      { new: true, runValidators: true },
    );
    if (!updated) throw new HttpError(409, "This cost changed while the payment was being prepared. Refresh before recording payment; nothing changed.");
    await auditDiff("CostEntry", updated._id, before, paymentPatch, user.id);
    return NextResponse.json({ item: updated });
  }
  assertCostAssociationIds(body);
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
  const materialCorrection = COST_MATERIAL_FIELDS.some((field) => field in patch
    && costCanon(field, patch[field]) !== costCanon(field, before[field]));
  if (patch.category !== undefined || materialCorrection) {
    const target = await assertActiveCostCategory(patch.category ?? doc.category, { requireApproved: materialCorrection });
    // Umesh, 2026-10-06 ~22:00 ("Others needs a name"): no cost may be MOVED onto the bare Other/Misc
    // head. Only a change counts - the edit form sends the category back unchanged, and an old row
    // already under Others stays editable (no migration of old rows).
    if (patch.category !== undefined && String(patch.category) !== String(doc.category ?? "") && isBareOtherHeadName(target.name)) {
      throw new HttpError(400, OTHER_HEAD_NEEDS_NAME);
    }
  }
  const setPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const unsetPatch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value === undefined).map(([field]) => [field, 1]));
  const update = {
    ...(Object.keys(setPatch).length ? { $set: setPatch } : {}),
    ...(Object.keys(unsetPatch).length ? { $unset: unsetPatch } : {}),
  };
  const updated = await CostEntry.findOneAndUpdate(
    { _id: doc._id, deletion_state: { $exists: false }, archived_at: null, cost_edit_request: null,
      updatedAt: doc.updatedAt },
    update,
    { new: true, runValidators: true },
  );
  if (!updated) throw new HttpError(409, "This cost was deleted while the correction was being prepared. Nothing changed.");
  await auditDiff("CostEntry", updated._id, before, patch, user.id);
  // QA-2500 (checker, cycle 1 FAIL): notifyCostCorrection was written for -305 - ninety lines of
  // audience resolution, field-name-not-value summarising, redactMoneyInText and a fire-and-forget
  // mail - and NEVER CALLED. Zero callers anywhere in src/. The checker measured it the only way that
  // could: a 200 PATCH with a cost.post rule installed produced 0 Notification rows and 0 MailLogs.
  // The unit claimed "an edit notifies the approvers" (Manish on the 2026-09-11 call: "aur phir edit
  // pe bhi un logon ko vo message jayega"), the release note stated it as fact to every
  // unauthenticated reader, and the feature did not exist. A function that compiles, typechecks and
  // is never invoked is indistinguishable from one that was never written - except that it reads,
  // to anyone grepping for it, as though the work is done.
  //
  // AFTER the audit row and AFTER the response value is settled, and deliberately not awaited into
  // the response: a mail outage must not fail a correction that already landed.
  void notifyCostCorrection({
    costId: updated._id,
    actor: user,
    patch,
    before,
    // QA-2507 (checker, cycle 2): this passed String(updated.batch) - the raw ObjectId - into a
    // parameter literally named batchCode, so the alert and the mail SUBJECT read "Cost entry on
    // batch 6aa4b851...". An approver cannot recognise a batch by its ObjectId; the code is the
    // only form of it they have ever seen. The parameter name said what was wanted and the call
    // site handed it the nearest value instead.
    batchCode: (updated as any)?.batch
      ? ((await Batch.findById((updated as any).batch).select("code").lean<any>())?.code ?? null)
      : null,
    location: (updated as any)?.location ?? null,
  }).catch(() => { /* notification is a courtesy on top of a committed correction, never a gate */ });
  return NextResponse.json({ item: updated });
});

export const DELETE = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  if (!(await hasFinanceApprove(user))) return deleteOwnCost(user, req, id);
  requireEdit(user);
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
  const pendingOwner: any = await CostEntry.collection.findOne({ _id: doc._id }, { projection: { cost_edit_request: 1 } });
  if (pendingOwner?.cost_edit_request || await pendingCostEditRequest(doc._id)) {
    throw new HttpError(409, "A creator change is waiting for approval. Decide it before removing this cost.");
  }
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
  // QA-2495: the snapshot is built ONCE, here, and the SAME object is handed to the writer and to
  // both of its verifier calls below. It used to be three separate `{ amount: doc.amount, note:
  // doc.note }` literals - harmless while it was two fields, and a QA-2497 waiting to happen at
  // twelve: the verifier compares with JSON.stringify, so three literals are three chances for the
  // key order or one field to drift apart and turn a delete that fully succeeded into a 409. One
  // object, read from `doc` before anything is staged, cannot disagree with itself.
  const oldValue = costDeletionSnapshot(doc);
  // Both creation and deletion are durable owner-backed events. Stage the deletion event before
  // the irreversible remove, then fail closed until every event is confirmed in AuditLog. A crash
  // or outage can therefore resume from this CostEntry instead of losing the deletion history.
  const claim = await ensureCostDeletionAuditEvent({
    costId: doc._id,
    actor: user.id,
    expectedUpdatedAt: doc.updatedAt,
    oldValue,
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
      oldValue, reason,
    })) return NextResponse.json({ ok: true });
    throw new HttpError(409, "This cost's audit history is still being recorded. Nothing was deleted; retry after the audit trail recovers.");
  }
  if (!(await garbageCollectSettledCostDeletion(doc._id))) {
    if (await costDeletionAuditIsDurable({
      costId: doc._id, eventId: claim.eventId, actor: claim.actor,
      oldValue, reason,
    })) return NextResponse.json({ ok: true });
    throw new HttpError(409, "This cost changed while its audit history was being checked. Nothing was deleted; refresh and retry.");
  }
  return NextResponse.json({ ok: true });
});

// ---------- mtg-b3 R10 (QA-2898 / QA-2899, Umesh 2026-10-07): the creator's own edit and delete ----------
// "jo create krr rhaa vo chaahe tho khud ki entry edit ya delete krr paayee":
//   - Payment Pending: the creator may edit or delete their own entry.
//   - already APPROVED and the amount or the head (and the batch / centre, which are the same kind of
//     fact) changes: it goes back for approval through the existing cost.post queue - the edit is parked
//     there, the row is untouched until an approver says yes (approvals/[id] -> applyApprovedCostEdit).
//   - Paid: locked for the creator. Finance and Admin-with-the-grant keep the paths above, unchanged.
//   - every edit and delete writes an audit row (the same durable owner-backed outbox the create uses).
//   - the delete is SOFT (archived_at) and recoverable; finance's delete above stays a hard delete.
// "Creator" is CostEntry.entered_by and nothing else. The server enforces every rule here whatever the
// dialog showed: an approved entry is changed or deleted only with `confirm_approved: true` in the body.

type OwnUser = Awaited<ReturnType<typeof requireUser>>;

async function loadOwnCost(user: OwnUser, id: string) {
  await requirePerm(user, "costs.manage");
  requireEdit(user);
  if (await loadDeletionTombstoneInScope(user, id)) {
    throw new HttpError(409, "This cost has already been deleted and its audit history is being finalized.");
  }
  if (!Types.ObjectId.isValid(id)) throw new HttpError(404, "Cost entry not found");
  // An archived row is read only to recover its already-committed delete receipt. The handlers
  // refuse every new mutation on it; ordinary listing still uses the schema visibility fence.
  const doc = await CostEntry.findById(id)
    ?? await CostEntry.findOne({ _id: id }).setOptions({ archivedOnly: true });
  if (!doc) throw new HttpError(404, "Cost entry not found");
  if (isScoped(user) && (!doc.location || !user.location_scope.map(String).includes(String(doc.location)))) {
    throw new HttpError(403, "Out of scope");
  }
  if (!isCostCreator(user, doc)) throw new HttpError(403, "You can change only the cost entries you entered yourself.");
  const internal: any = await CostEntry.collection.findOne({ _id: doc._id }, {
    projection: { own_mutations: 1, cost_edit_request: 1, cost_edit_proposal: 1 },
  });
  const lean: any = doc.toObject();
  await stampCostApprovals([lean]);
  return { doc, internal, stamp: { kind: lean.approved_by_kind as string, by: lean.approved_by as string | null, on: lean.approved_on as Date | null } };
}

const costCanon = (f: string, v: unknown): string => {
  if (v === undefined || v === null || v === "") return "";
  if (f === "entry_date") return String(new Date(v as any).getTime());
  if (f === "amount") return String(Number(v));
  return String(v);
};

async function patchOwnCost(user: OwnUser, req: NextRequest, id: string) {
  const loaded = await loadOwnCost(user, id);
  const { doc, stamp } = loaded;
  let internal = loaded.internal;
  const body = await readJson(req);
  // Native writes must keep the schema's text contract before any queue/receipt effects.
  for (const field of ["note", "vendor_payee", "voucher_no", "payment_mode"]) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      throw new HttpError(400, `The ${field.replaceAll("_", " ")} must be text.`);
    }
  }
  if (body.mark_paid === true) {
    throw new HttpError(403, "Recording a payment is for finance. You can change or delete your own entry until it is paid.");
  }
  assertCostAssociationIds(body); // QA-2910: before any receipt, claim, request or audit effect
  const before: any = doc.toObject();
  const clientKey = String(req.headers.get("Idempotency-Key") ?? "").trim();
  if (clientKey.length > 160) throw new HttpError(400, "The edit retry key is too long.");
  const inputHash = createHash("sha256").update(JSON.stringify(Object.fromEntries(
    [...COST_OWN_FIELDS, "confirm_approved", "base_updated_at"].filter((f) => body[f] !== undefined)
      .sort().map((f) => [f, costCanon(f, body[f])]),
  ))).digest("hex");
  const base = body.base_updated_at ? new Date(body.base_updated_at) : new Date(before.updatedAt);
  if (!Number.isFinite(base.getTime())) throw new HttpError(400, "The cost revision is invalid.");
  const mutationKey = `cost-edit:${user.id}:${id}:${clientKey || `${base.getTime()}:${inputHash}`}`;
  const queuedResult = async (request: any, savedReceipt?: any): Promise<NextResponse> => {
    const raw = typeof request?.toObject === "function" ? request.toObject() : request;
    // QA-2909: every queued response, including a durable receipt, uses today's permission.
    // Keep the original raw receipt internally so a later grant can expose that same result.
    const canSeeMoney = await hasPermission(user, FINANCE_VIEW);
    const item: any = maskApprovalMoney(raw, canSeeMoney);
    if (!canSeeMoney) {
      delete item.decision_note;
      if (raw.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
          && raw.payload.amount !== undefined) {
        item.payload = { ...(item.payload ?? {}), amount: raw.payload.amount };
      }
    }
    const response = { ...(savedReceipt?.result ?? { queued: true }), item };
    if (savedReceipt) return NextResponse.json(response, { status: savedReceipt.http_status ?? 202 });
    const result = { queued: true, item: raw };
    const event = financeAuditEvent(`cost:${doc._id}:edit-request:${request._id}`, {
      entity: "CostEntry", entity_id: doc._id, field: "edit sent for approval",
      new_value: { request: String(request._id), by: "creator" }, actor: new Types.ObjectId(String(user.id)),
    });
    const written = await CostEntry.collection.updateOne({ _id: doc._id, "own_mutations.key": { $ne: mutationKey } }, {
      $push: { own_mutations: { key: mutationKey, input_hash: inputHash, http_status: 202, result }, _audit_events: event },
    } as any);
    await settleFinanceAuditEvents({ costIds: [doc._id] }).catch(() => {});
    if (written.modifiedCount !== 1) {
      const owner: any = await CostEntry.collection.findOne({ _id: doc._id }, { projection: { own_mutations: 1 } });
      const first = (owner?.own_mutations ?? []).find((r: any) => r.key === mutationKey);
      if (first?.input_hash === inputHash) return queuedResult(first.result.item, first);
      throw new HttpError(409, "The edit result could not be recorded. Refresh and retry.");
    }
    return NextResponse.json(response, { status: 202 });
  };
  const receipt = (internal?.own_mutations ?? []).find((r: any) => r.key === mutationKey);
  if (receipt) {
    if (receipt.input_hash !== inputHash) throw new HttpError(409, "This retry key was already used for a different edit.");
    if (receipt.result?.queued === true) return queuedResult(receipt.result.item, receipt);
    return NextResponse.json(receipt.result, { status: receipt.http_status ?? 200 });
  }
  // An accepted queue result stays the first result even after approval/rejection or payment.
  const priorQuery = {
    action: "cost.post", entity_id: doc._id, initiator: user.id,
    "payload.kind": "cost-edit", "payload._edit_mutation_key": mutationKey,
  };
  const prior: any = await ApprovalRequest.findOne(priorQuery).lean();
  if (prior) {
    if (prior.payload?._edit_input_hash !== inputHash) throw new HttpError(409, "This retry key was already used for a different edit.");
    return queuedResult(prior);
  }
  if (doc.archived_at) throw new HttpError(409, "This cost was deleted. Restore it before making another change.");
  if (doc.payment_status !== "Payment Pending") {
    throw new HttpError(409, doc.payment_status === "Paid"
      ? "This cost is already marked paid, so it is locked. Ask finance if it needs to change."
      : "The payment status of this cost is not recorded. Ask finance to verify it before changing it.");
  }
  let recovering = internal?.cost_edit_proposal?.mutation_key === mutationKey
    && internal.cost_edit_proposal.input_hash === inputHash;
  if ((internal?.cost_edit_request || await pendingCostEditRequest(doc._id)) && !recovering) {
    // The pending query is newer than loadOwnCost's snapshot. A matching peer may have
    // acquired our durable claim between those reads; recover that owner, never a new one.
    const owner: any = await CostEntry.collection.findOne({ _id: doc._id }, {
      projection: { own_mutations: 1, cost_edit_request: 1, cost_edit_proposal: 1 },
    });
    const first = (owner?.own_mutations ?? []).find((r: any) => r.key === mutationKey);
    if (first) {
      if (first.input_hash !== inputHash) throw new HttpError(409, "This retry key was already used for a different edit.");
      if (first.result?.queued === true) return queuedResult(first.result.item, first);
      return NextResponse.json(first.result, { status: first.http_status ?? 200 });
    }
    const proposal = owner?.cost_edit_proposal;
    if (owner?.cost_edit_request && proposal?.context
        && String(proposal.context.requestId) === String(owner.cost_edit_request)
        && proposal.mutation_key === mutationKey && proposal.input_hash === inputHash) {
      internal = owner;
      recovering = true;
    } else {
      // Approval/rejection may have settled ownership during the reread. Its first result
      // remains replayable only through the same actor/cost/kind/key-scoped request lookup.
      const completed: any = await ApprovalRequest.findOne(priorQuery).lean();
      if (completed) {
        if (completed.payload?._edit_input_hash !== inputHash) throw new HttpError(409, "This retry key was already used for a different edit.");
        return queuedResult(completed);
      }
      throw new HttpError(409, "A change to this cost is already waiting for approval. Wait for the decision before changing or deleting it again.");
    }
  }
  if (new Date(before.updatedAt).getTime() !== base.getTime()) {
    throw new HttpError(409, "This cost changed after you opened the form. Refresh before editing it.");
  }
  // Only the fields that actually CHANGE count: the edit form sends every field back.
  const patch: Record<string, unknown> = {};
  for (const f of COST_OWN_FIELDS) {
    if (body[f] === undefined) continue;
    const next = body[f] === "" ? undefined : body[f];
    if (costCanon(f, next) !== costCanon(f, before[f])) patch[f] = next;
  }
  if (!Object.keys(patch).length) return NextResponse.json({ item: doc, unchanged: true });

  const merged = { ...before, ...patch };
  assertCostEntryValid(merged); // Rule 37 on the merged entry
  if (!String(merged.note ?? "").trim()) {
    throw new HttpError(400, "Say what this cost was for - the description is what makes it answerable later.");
  }
  if (patch.payment_mode && !COST_PAYMENT_MODE.includes(String(patch.payment_mode) as never)) {
    throw new HttpError(400, "Choose how this payment was made.");
  }
  // Scope: an edit may not move an entry onto a centre, batch or trainer the creator cannot reach.
  if (patch.location) assertLocationInScope(user, String(patch.location));
  if (patch.trainer) await assertTrainerInScope(user, String(patch.trainer));
  // QA-2908: a scoped missing-batch refusal must not strand the source's exact crash claim.
  // Check the saved owner, not merely the retry's destination, and leave ambiguous claims intact.
  const proposal = internal?.cost_edit_proposal;
  const savedContext = proposal?.context;
  const savedPayload = savedContext?.payload;
  const savedRequestId = internal?.cost_edit_request;
  const savedDestination = savedContext?.batch;
  const coherent = proposal?.mutation_key === mutationKey && proposal?.input_hash === inputHash
    && Types.ObjectId.isValid(String(savedRequestId ?? ""))
    && String(savedContext?.requestId ?? "") === String(savedRequestId)
    && savedContext?.entity === "CostEntry" && String(savedContext?.entity_id ?? "") === String(doc._id)
    && savedPayload?.kind === "cost-edit" && String(savedPayload?.cost_entry ?? "") === String(doc._id)
    && savedPayload?._edit_mutation_key === mutationKey && savedPayload?._edit_input_hash === inputHash
    && (!savedDestination || Types.ObjectId.isValid(String(savedDestination)))
    && String(savedPayload?.batch ?? "") === String(savedDestination ?? "")
    && String(merged.batch ?? "") === String(savedDestination ?? "");
  if (recovering && coherent && savedDestination) {
      const live = await Batch.collection.findOne({ _id: new Types.ObjectId(String(savedDestination)) }, { projection: { _id: 1 } });
      if (!live && !(await ApprovalRequest.exists({ _id: savedRequestId }))) {
        await CostEntry.collection.updateOne({
          _id: doc._id, entered_by: new Types.ObjectId(String(user.id)), updatedAt: before.updatedAt,
          payment_status: "Payment Pending", archived_at: null, deletion_state: { $exists: false },
          cost_edit_request: savedRequestId, "cost_edit_proposal.mutation_key": mutationKey,
          "cost_edit_proposal.input_hash": inputHash, "cost_edit_proposal.context": savedContext,
        }, { $unset: { cost_edit_request: "", cost_edit_proposal: "" } });
        if (isScoped(user)) throw new HttpError(404, "Batch not found");
        throw new HttpError(409, "This batch is being deleted or no longer exists, so this request cannot be queued.");
      }
  }
  if (patch.batch) await assertBatchInScope(user, String(patch.batch));
  if (recovering && !coherent) {
    throw new HttpError(409, "This cost has an incomplete edit claim. Nothing changed; ask finance to reconcile it.");
  }
  const target = await assertActiveCostCategory(merged.category);
  if (patch.category !== undefined) {
    if (isBareOtherHeadName(target.name)) throw new HttpError(400, OTHER_HEAD_NEEDS_NAME);
  }
  const material = COST_MATERIAL_FIELDS.some((f) => f in patch);
  const approvedBefore = costIsApproved(stamp);
  if (approvedBefore && body.confirm_approved !== true) {
    throw new HttpError(409, approvedCostSentence(stamp, material ? "edit" : "edit-light"));
  }

  // Local-only race barrier: both requests have validated the same revision, but neither has
  // claimed/written it yet. Production query parameters cannot enable the barrier.
  const testPause = /^center_erp_ci(?:_|$)/.test(process.env.MONGODB_DB ?? "")
    ? Math.max(0, Math.min(1000, Number(req.nextUrl.searchParams.get("_test_pause_before_own_commit_ms")) || 0)) : 0;
  if (testPause) await new Promise((resolve) => setTimeout(resolve, testPause));

  let preApproval: Awaited<ReturnType<typeof evaluateCostEditPreApproval>> | null = null;
  if (material || target.approvalNeeded) {
    // The SAME rule a new post goes through (QA-1977: nothing auto-approves under a Pending or Rejected
    // head; the cap is checked). An edit is never an easier door than a post. A person who approved
    // this entry approved THAT amount under THAT head, so for them it always goes back to a person.
    preApproval = await evaluateCostEditPreApproval(merged.category, Number(merged.amount), merged.batch);
    const needsPerson = approvedBefore || target.approvalNeeded || !preApproval.applied;
    if (needsPerson) {
      const idStr = (v: unknown) => (v ? String(v) : undefined);
      const requestId = recovering ? new Types.ObjectId(String(internal.cost_edit_request)) : new Types.ObjectId();
      const context = {
        requestId,
        entity: "CostEntry", entity_id: doc._id,
        summary: `Change to a cost entry: ₹${merged.amount} (was ₹${before.amount}) (${user.name}) - ${merged.note}`,
        payload: {
          kind: "cost-edit", cost_entry: String(doc._id), base_updated_at: new Date(before.updatedAt).toISOString(),
          _edit_mutation_key: mutationKey, _edit_input_hash: inputHash,
          entry_date: merged.entry_date ? new Date(merged.entry_date).toISOString() : undefined,
          location: idStr(merged.location), batch: idStr(merged.batch), trainer: idStr(merged.trainer),
          category: idStr(merged.category), amount: Number(merged.amount), note: merged.note,
          vendor_payee: merged.vendor_payee || undefined, voucher_no: merged.voucher_no || undefined,
          payment_mode: merged.payment_mode || undefined,
          _pre_approved_basis: preApproval.applied ? preApproval.basis : undefined,
        },
        location: idStr(merged.location), batch: idStr(merged.batch),
        // An already-approved entry's change reaches a person even when nobody switched the rule on.
        ...(approvedBefore || target.approvalNeeded ? { fallbackApproverRole: "Admin" } : {}),
        idempotencyKey: `${mutationKey}:revision:${base.getTime()}`,
      };
      // Claim before crossing into another collection. A parallel edit, deletion, or payment
      // cannot win after this point; a crash leaves the exact proposal recoverable by its retry.
      if (!recovering) {
        const claimed = await CostEntry.collection.updateOne({
          _id: doc._id, entered_by: new Types.ObjectId(String(user.id)), updatedAt: before.updatedAt,
          payment_status: "Payment Pending", archived_at: null, deletion_state: { $exists: false },
          cost_edit_request: null, reservation_state: { $ne: "Pending" },
        }, { $set: {
          cost_edit_request: requestId,
          cost_edit_proposal: { mutation_key: mutationKey, input_hash: inputHash, context },
        } } as any);
        if (claimed.modifiedCount !== 1) {
          const winner: any = await CostEntry.collection.findOne({ _id: doc._id }, { projection: { cost_edit_request: 1, cost_edit_proposal: 1 } });
          const winnerProposal = winner?.cost_edit_proposal;
          const winnerContext = winnerProposal?.context;
          const winnerPayload = winnerContext?.payload;
          const winnerDestination = winnerContext?.batch;
          const winnerCoherent = winnerProposal?.mutation_key === mutationKey && winnerProposal?.input_hash === inputHash
            && Types.ObjectId.isValid(String(winner?.cost_edit_request ?? ""))
            && String(winnerContext?.requestId ?? "") === String(winner.cost_edit_request)
            && winnerContext?.entity === "CostEntry" && String(winnerContext?.entity_id ?? "") === String(doc._id)
            && winnerPayload?.kind === "cost-edit" && String(winnerPayload?.cost_entry ?? "") === String(doc._id)
            && winnerPayload?._edit_mutation_key === mutationKey && winnerPayload?._edit_input_hash === inputHash
            && (!winnerDestination || Types.ObjectId.isValid(String(winnerDestination)))
            && String(winnerPayload?.batch ?? "") === String(winnerDestination ?? "")
            && String(merged.batch ?? "") === String(winnerDestination ?? "");
          if (winnerCoherent) {
            let parked;
            try {
              parked = await requireApproval("cost.post", user, {
                ...winnerContext, requestId: new Types.ObjectId(String(winner.cost_edit_request)),
              });
            } catch (error: any) {
              if (error?.code !== 11000) {
                const destination = winnerDestination;
                if (destination) {
                  const live = await Batch.collection.findOne({ _id: new Types.ObjectId(String(destination)), deletion_state: { $exists: false } });
                  if (!live && !(await ApprovalRequest.exists({ _id: winner.cost_edit_request }))) {
                    await CostEntry.collection.updateOne({
                      _id: doc._id, entered_by: new Types.ObjectId(String(user.id)), updatedAt: before.updatedAt,
                      payment_status: "Payment Pending", archived_at: null, deletion_state: { $exists: false },
                      cost_edit_request: winner.cost_edit_request, "cost_edit_proposal.mutation_key": mutationKey,
                      "cost_edit_proposal.input_hash": inputHash, "cost_edit_proposal.context": winnerContext,
                    }, { $unset: { cost_edit_request: "", cost_edit_proposal: "" } });
                  }
                }
                throw error;
              }
              const existing = await ApprovalRequest.findById(winner.cost_edit_request);
              if (!existing) throw error;
              parked = { request: existing };
            }
            if (parked) return queuedResult(parked.request);
          }
          throw new HttpError(409, "This cost changed while the edit was being requested. Refresh and try again.");
        }
      }
      let parked;
      const claimedContext = recovering ? savedContext : context;
      try {
        parked = await requireApproval("cost.post", user, { ...claimedContext, requestId });
      } catch (error: any) {
        if (error?.code !== 11000) {
          const destination = claimedContext.batch;
          if (destination) {
            const live = await Batch.collection.findOne({ _id: new Types.ObjectId(String(destination)), deletion_state: { $exists: false } });
            if (!live && !(await ApprovalRequest.exists({ _id: requestId }))) {
              await CostEntry.collection.updateOne({
                _id: doc._id, entered_by: new Types.ObjectId(String(user.id)), updatedAt: before.updatedAt,
                payment_status: "Payment Pending", archived_at: null, deletion_state: { $exists: false },
                cost_edit_request: requestId, "cost_edit_proposal.mutation_key": mutationKey,
                "cost_edit_proposal.input_hash": inputHash, "cost_edit_proposal.context": claimedContext,
              }, { $unset: { cost_edit_request: "", cost_edit_proposal: "" } });
            }
          }
          throw error;
        }
        const existing = await ApprovalRequest.findById(requestId);
        if (!existing) throw error;
        parked = { request: existing };
      }
      if (parked) {
        return queuedResult(parked.request);
      }
      // A concurrently disabled optional rule can yield no queue. Release only our own claim
      // before the direct-write CAS; mandatory fallbacks above can never take this branch.
      await CostEntry.collection.updateOne({ _id: doc._id, cost_edit_request: requestId },
        { $unset: { cost_edit_request: "", cost_edit_proposal: "" } });
    }
  }

  // Applied straight away: a change that stays approved, or a material change the pre-approval rule
  // (or a switched-off cost.post rule, exactly as for a new post) lets through. A pre-approved head
  // re-stamps the entry's basis; anything else clears it.
  const now = new Date();
  const set: Record<string, unknown> = { updatedAt: now };
  const unset: Record<string, 1> = {};
  for (const [f, v] of Object.entries(patch)) {
    if (v === undefined) { unset[f] = 1; continue; }
    if (["location", "batch", "trainer", "category"].includes(f)) {
      if (!Types.ObjectId.isValid(String(v))) throw new HttpError(400, `The ${f} is invalid.`);
      set[f] = new Types.ObjectId(String(v));
    } else {
      set[f] = f === "entry_date" ? new Date(v as any) : f === "amount" ? Number(v) : v;
    }
  }
  if (patch.amount !== undefined) set.requested_amount = Number(patch.amount);
  if (material) {
    if (preApproval?.applied) {
      set.pre_approved_applied = true; set.pre_approved_unit = "Fixed amount";
      if (preApproval.basis) set.pre_approved_basis = preApproval.basis; else unset.pre_approved_basis = 1;
    } else {
      set.pre_approved_applied = false; unset.pre_approved_basis = 1; unset.pre_approved_unit = 1;
    }
  }
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of Object.keys(patch)) changes[f] = { from: before[f] ?? null, to: patch[f] ?? null };
  const event = financeAuditEvent(`cost:${doc._id}:edited-at:${now.getTime()}`, {
    entity: "CostEntry", entity_id: doc._id, field: "edited",
    old_value: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.from])),
    new_value: { by: "creator", changes: Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, v.to])) },
    actor: new Types.ObjectId(String(user.id)),
  });
  const written = await CostEntry.collection.updateOne(
    {
      _id: doc._id, payment_status: "Payment Pending", deletion_state: { $exists: false }, archived_at: null,
      updatedAt: before.updatedAt, reservation_state: { $ne: "Pending" }, cost_edit_request: null,
    },
    { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), $push: {
      _audit_events: event,
      own_mutations: { key: mutationKey, input_hash: inputHash, result: { item: Object.fromEntries(
        Object.entries({ ...before, ...set }).filter(([field]) => !unset[field]),
      ) } },
    } } as any,
  );
  if (written.modifiedCount !== 1) {
    const winner: any = await CostEntry.collection.findOne({ _id: doc._id }, { projection: { own_mutations: 1 } });
    const first = (winner?.own_mutations ?? []).find((r: any) => r.key === mutationKey);
    if (first?.input_hash === inputHash) {
      if (first.result?.queued === true) return queuedResult(first.result.item, first);
      return NextResponse.json(first.result);
    }
    throw new HttpError(409, "This cost changed while your edit was being saved (it may have been paid or deleted). Nothing was changed; refresh and try again.");
  }
  await settleFinanceAuditEvents({ costIds: [doc._id] }).catch(() => {});
  return NextResponse.json({ item: Object.fromEntries(Object.entries({ ...before, ...set }).filter(([field]) => !unset[field])) });
}

async function deleteOwnCost(user: OwnUser, req: NextRequest, id: string) {
  const { doc, internal, stamp } = await loadOwnCost(user, id);
  let body: any = {};
  try { body = await readJson(req); } catch { /* no body */ }
  const clientKey = String(req.headers.get("Idempotency-Key") ?? "").trim();
  if (clientKey.length > 160) throw new HttpError(400, "The delete retry key is too long.");
  const inputHash = createHash("sha256").update(JSON.stringify({
    confirm_approved: body?.confirm_approved === true, reason: String(body?.reason ?? "").trim().slice(0, 500),
    base_updated_at: body?.base_updated_at ?? null,
  })).digest("hex");
  const mutationKey = `cost-delete:${user.id}:${id}:${clientKey || `${new Date(doc.updatedAt).getTime()}:${inputHash}`}`;
  const receipt = (internal?.own_mutations ?? []).find((r: any) => r.key === mutationKey);
  if (receipt) {
    if (receipt.input_hash !== inputHash) throw new HttpError(409, "This retry key was already used for a different deletion.");
    return NextResponse.json(receipt.result);
  }
  if (doc.archived_at) throw new HttpError(409, "This cost was already deleted.");
  if (doc.payment_status !== "Payment Pending") throw new HttpError(409, doc.payment_status === "Paid"
    ? "This cost is already marked paid, so it is locked. Ask finance if it needs to change."
    : "The payment status of this cost is not recorded. Ask finance to verify it before deleting it.");
  if (internal?.cost_edit_request || await pendingCostEditRequest(doc._id)) {
    throw new HttpError(409, "A change to this cost is already waiting for approval. Decide it before deleting this cost.");
  }
  if (body.base_updated_at && new Date(body.base_updated_at).getTime() !== new Date(doc.updatedAt).getTime()) {
    throw new HttpError(409, "This cost changed after you opened it. Refresh before deleting it.");
  }
  if (costIsApproved(stamp) && body?.confirm_approved !== true) {
    throw new HttpError(409, approvedCostSentence(stamp, "delete"));
  }
  // Archiving hides the liability from reports but deliberately retains any Formula commitment:
  // the native cap query still counts this row, and restoring it cannot spend the cap twice.
  const reason = String(body?.reason ?? "").trim().slice(0, 500) || "Deleted by the person who entered it";
  const now = new Date();
  const event = financeAuditEvent(`cost:${doc._id}:archived-at:${now.getTime()}`, {
    entity: "CostEntry", entity_id: doc._id, field: "deleted (recoverable)",
    old_value: costDeletionSnapshot(doc),
    new_value: { by: "creator", reason, restorable: true },
    actor: new Types.ObjectId(String(user.id)),
  });
  const written = await CostEntry.collection.updateOne(
    {
      _id: doc._id, payment_status: "Payment Pending", deletion_state: { $exists: false }, archived_at: null,
      updatedAt: (doc as any).updatedAt, reservation_state: { $ne: "Pending" }, cost_edit_request: null,
    },
    {
      $set: { archived_at: now, archived_by: new Types.ObjectId(String(user.id)), archive_reason: reason, updatedAt: now },
      $push: { _audit_events: event, own_mutations: { key: mutationKey, input_hash: inputHash, result: { ok: true, restorable: true } } },
    } as any,
  );
  if (written.modifiedCount !== 1) {
    const winner: any = await CostEntry.collection.findOne({ _id: doc._id }, { projection: { own_mutations: 1 } });
    const first = (winner?.own_mutations ?? []).find((r: any) => r.key === mutationKey);
    if (first?.input_hash === inputHash) return NextResponse.json(first.result);
    throw new HttpError(409, "This cost changed while it was being deleted (it may have been paid or already deleted). Nothing was changed; refresh and try again.");
  }
  await settleFinanceAuditEvents({ costIds: [doc._id] }).catch(() => {});
  return NextResponse.json({ ok: true, restorable: true });
}
