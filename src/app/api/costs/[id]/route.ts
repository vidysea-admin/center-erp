import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, isScoped, HttpError, readJson } from "@/lib/authz";
import { requireFinance } from "@/lib/permissions";
import { CostEntry, COST_PAYMENT_MODE } from "@/models";
import { assertActiveCostCategory, assertCostEntryValid } from "@/lib/rules";
import { auditDiff } from "@/lib/audit";
import { costFinanceAuditOutboxIsSettled, ensureCostDeletionAuditEvent, settleFinanceAuditEvents } from "@/lib/approvals";

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

export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requireFinance(user, "approve");
  requireEdit(user);
  const { id } = await ctx.params;
  const doc = await loadInScope(user, id);
  const body = await readJson(req);
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
    Object.assign(doc, paymentPatch);
    await doc.save({ validateModifiedOnly: true });
    await auditDiff("CostEntry", doc._id, before, paymentPatch, user.id);
    return NextResponse.json({ item: doc });
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
  Object.assign(doc, patch);
  await doc.save({ validateModifiedOnly: true });
  await auditDiff("CostEntry", doc._id, before, patch, user.id);
  return NextResponse.json({ item: doc });
});

export const DELETE = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requireFinance(user, "approve");
  requireEdit(user);
  const { id } = await ctx.params;
  const doc = await loadInScope(user, id);
  // Deleting an applied row would free the visible ledger amount without returning the atomic
  // reservation, allowing the same commitment to be spent again. Preserve the original record.
  if (doc.pre_approved_applied && doc.pre_approved_unit === "Per billable passed") {
    throw new HttpError(409, "A pre-approved cost cannot be deleted after its commitment has been applied.");
  }
  // Both creation and deletion are durable owner-backed events. Stage the deletion event before
  // the irreversible remove, then fail closed until every event is confirmed in AuditLog. A crash
  // or outage can therefore resume from this CostEntry instead of losing the deletion history.
  await ensureCostDeletionAuditEvent({
    costId: doc._id,
    actor: user.id,
    oldValue: { amount: doc.amount, note: doc.note },
  });
  const isTestDb = /^center_erp_ci(?:_|$)/.test(process.env.MONGODB_DB ?? "");
  const injectedFailure = isTestDb && req.nextUrl.searchParams.get("_test_fail_audit") === "before"
    ? "before" as const
    : isTestDb && req.nextUrl.searchParams.get("_test_fail_audit") === "after" ? "after" as const : undefined;
  await settleFinanceAuditEvents({ costIds: [doc._id], failure: injectedFailure }).catch(() => {});
  if (!(await costFinanceAuditOutboxIsSettled(doc._id))) {
    throw new HttpError(409, "This cost's audit history is still being recorded. Nothing was deleted; retry after the audit trail recovers.");
  }
  const removed = await CostEntry.collection.deleteOne({
    _id: doc._id,
    $expr: {
      $eq: [
        {
          $size: {
            $setDifference: [
              { $map: { input: { $ifNull: ["$_audit_events", []] }, as: "event", in: "$$event.event_id" } },
              { $ifNull: ["$_audit_delivered_event_ids", []] },
            ],
          },
        },
        0,
      ],
    },
  });
  if (removed.deletedCount !== 1) {
    throw new HttpError(409, "This cost changed while its audit history was being checked. Nothing was deleted; refresh and retry.");
  }
  return NextResponse.json({ ok: true });
});
