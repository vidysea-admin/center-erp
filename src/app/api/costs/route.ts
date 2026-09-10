import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, locationFilter, assertLocationInScope, readJson, HttpError } from "@/lib/authz";
import { requirePerm, requireFinance } from "@/lib/permissions";
import { CostEntry, CostCategory } from "@/models";
import { assertActiveCostCategory, assertBatchInScope, assertCostEntryValid, assertTrainerInScope, createCostEntryIdempotently, evaluatePreApproval } from "@/lib/rules";
import { financeAuditEvent, flushPendingFinanceAuditEvents, requireApproval, settleFinanceAuditEvents } from "@/lib/approvals";
import { audit } from "@/lib/audit";
import { Types } from "mongoose";

export const GET = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  // R-E (CEO 14/08 [25:06]): whoever POSTS money entries "shouldn't be able to see what has been
  // posted" — the ledger is a narrower right than the form. Their own submissions stay visible via
  // /api/approvals?mine=1, never the book.
  //
  // QA-1825 (CEO, 2026-09-05): that shape is unchanged; what changed is that it is no longer a
  // hardcoded role name. The old line read `if (user.role === "Operations") throw 403`, written
  // because "an ordered none<view<edit lattice cannot express edit-without-view". Splitting the
  // right instead of stretching the lattice expresses it exactly — costs.manage is the form,
  // finance.view is the book — and the CEO has since widened the rule far past Operations:
  // "kisi ke bhi paas nahi hogi chaahe super admin ho." An Admin without the grant now 403s here
  // too, which the role hardcode could never have done.
  await requireFinance(user, "view");
  await flushPendingFinanceAuditEvents().catch(() => {});
  const sp = req.nextUrl.searchParams;
  const filter: Record<string, unknown> = { ...locationFilter(user) };
  for (const k of ["location", "batch", "trainer", "category"]) {
    const v = sp.get(k);
    if (v) filter[k] = v;
  }
  const items = await CostEntry.find(filter)
    .sort({ entry_date: -1 })
    .populate("location", "name code").populate("batch", "code").populate("trainer", "name").populate("category", "name").populate("entered_by", "name")
    .lean();
  return NextResponse.json({ items });
});

export const POST = apiHandler(async (req: NextRequest) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "costs.manage");
  requireEdit(user); // Rule 39: can_edit=false is view-only everywhere, including granted rights
  await flushPendingFinanceAuditEvents().catch(() => {});
  const body = await readJson(req);
  assertCostEntryValid(body); // Rule 37
  // R-E: when the cost.post approval rule is enabled, a non-approver's entry PARKS instead
  // of writing the ledger — the CostEntry is created only by the approval replay. Admin (as
  // the configured approver) passes straight through, exactly as before.
  // QA-1828b: the description is the CEO's, not an optional note. *"हेड हो, सब हेड हो,
  // डिस्क्रिप्शन हो"* — and the example is a sentence explaining a decision, which is exactly the
  // thing that is unrecoverable later if nobody wrote it down at the time.
  if (!String(body.note ?? "").trim()) {
    throw new HttpError(400, "Say what this cost was for — the description is what makes it answerable later.");
  }

  // Cost entry is intentionally wider than finance visibility: every operational role can submit
  // its own expense, but a granted form must never become a foreign-centre write door. Check every
  // dimension the caller supplied before creating a head, an approval request, or a ledger row.
  // The shared assertions preserve the project's existing scope semantics, including a Trainer's
  // explicit assignment being stronger than a stale location_scope for a batch.
  if (body.location) assertLocationInScope(user, String(body.location));
  if (body.batch) await assertBatchInScope(user, String(body.batch));
  if (body.trainer) await assertTrainerInScope(user, String(body.trainer));

  // Is it pre-approved, and can a machine tell? A cap can be checked; a free-text basis cannot, so
  // that entry parks WITH the basis quoted rather than being waved through on a flag. The CEO named
  // the failing case himself: *"अब अगर उसके 29 रह गए… तो वो एक बार अप्रूव होनी चाहिए।"*
  // QA-1828c (CEO): *"अगर कोई नया है हेड या सब हेड, तो इनके पास इवैल्यूएशन होगी… तो हमारा सिस्टम
  // पूरा बंद हो जाएगा अगर हम ये यूज़ नहीं करेंगे।"* The failure he named is not a wrong figure - it is
  // people abandoning the system because the head they need is not in the list. So a missing head is
  // a QUEUE, not a refusal, and the WHOLE entry parks: nothing reaches the ledger until somebody has
  // decided where it belongs (Umesh, D8). `category` is therefore optional when `new_subhead` is
  // given, and Rule 37 is checked on the replay against whichever head is finally chosen.
  const proposed = String(body.new_subhead ?? "").trim();
  // Umesh, 2026-09-07: *"head jo 2-3 ceo ne bnaaye vo rakhte hai otherwise baaki others se new head
  // bhi tho create krr skte hai naa, team kr legi"*.
  //
  // An Admin ALREADY creates cost heads — Rule 40, `master-lists/[list]/route.ts:64` — and the
  // three Admins are the very people the CEO named as the evaluators. Sending them round an
  // approval queue to reach a screen they can open in two clicks would be ceremony, not control:
  // the request would be theirs, the decision would be theirs, and the only thing added is a step.
  // So an Admin naming a head here just creates it; everybody else proposes and an Admin decides.
  // That is the same split the master list already draws, applied at the place the need is felt.
  if (proposed && user.role === "Admin") {
    // A staged head is hidden from ordinary Mongoose reads. Inspect the raw row here so an Admin
    // posting the same name cannot race the approval replay into a duplicate-key 500 or attach a
    // cost to an unpublished taxonomy row.
    const escaped = proposed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const existing = await CostCategory.collection.findOne(
      { name: { $regex: `^${escaped}$`, $options: "i" } },
      { projection: { _id: 1, active: 1, staged_by_approval: 1 } },
    );
    if (existing?.staged_by_approval || existing?.active === false) {
      throw new HttpError(409, `"${proposed}" is inactive or currently being approved. Wait for that review or choose another active head.`);
    }
    if (existing) body.category = String(existing._id);
    else {
      const made = await CostCategory.create({ name: proposed, active: true });
      body.category = String(made._id);
      await audit({ entity: "CostCategory", entityId: made._id, field: "created", newValue: `"${proposed}" created inline while posting a cost`, actor: user.id });
    }
  } else if (proposed) {
    const queued = await requireApproval("costcategory.create", user, {
      entity: "CostCategory",
      summary: `New cost head "${proposed}" for a ₹${body.amount} entry by ${user.name} — ${body.note}`,
      payload: { ...body, new_subhead: proposed },
      location: body.location || undefined,
      batch: body.batch || undefined,
    });
    // If nobody has enabled the rule there is no approver, and silently writing an unreviewed head
    // would be the opposite of what was asked. Say so instead of inventing one.
    if (!queued) throw new HttpError(409, "There is no approver set up for new cost heads yet, so this cannot be reviewed. Pick an existing head for now, or ask an Admin to turn that approval on.");
    return NextResponse.json({ queued: true, item: queued.request, awaiting: "a new cost head" }, { status: 202 });
  }

  await assertActiveCostCategory(body.category);

  // Allocate the id before any write. Formula submissions persist under this id as hidden Pending
  // rows before the cap decision; fixed/non-approved submissions use it for ambiguity-safe create.
  const costEntryId = new Types.ObjectId();
  const createdEvent = (id: Types.ObjectId, value = "created") => financeAuditEvent(`cost:${id}:created`, {
    entity: "CostEntry", entity_id: id, new_value: value,
    actor: new Types.ObjectId(String(user.id)),
  });
  const baseEntry = {
    _id: costEntryId,
    entry_date: body.entry_date ? new Date(body.entry_date) : new Date(),
    location: body.location ? new Types.ObjectId(String(body.location)) : undefined,
    batch: body.batch ? new Types.ObjectId(String(body.batch)) : undefined,
    trainer: body.trainer ? new Types.ObjectId(String(body.trainer)) : undefined,
    category: new Types.ObjectId(String(body.category)),
    amount: Number(body.amount), requested_amount: Number(body.amount),
    payment_status: "Payment Pending", note: body.note,
    vendor_payee: body.vendor_payee || undefined,
    voucher_no: body.voucher_no || undefined,
    payment_mode: body.payment_mode || undefined,
    _audit_events: [createdEvent(costEntryId)],
    entered_by: new Types.ObjectId(String(user.id)),
  };
  const isTestDb = /^center_erp_ci(?:_|$)/.test(process.env.MONGODB_DB ?? "");
  const auditFailure = isTestDb && body._test_fail_audit_before_insert === true
    ? "before" as const
    : isTestDb && body._test_fail_audit_after_insert === true ? "after" as const : undefined;
  const pre = await evaluatePreApproval(body.category, Number(body.amount), {
    batch: body.batch,
    reservation: {
      entry: baseEntry,
      ...(isTestDb && Number(body._test_formula_ttl_ms) > 0 ? { expiresInMs: Number(body._test_formula_ttl_ms) } : {}),
      ...(isTestDb && Number(body._test_formula_pause_after_reserve_ms) > 0 ? { pauseAfterPersistMs: Number(body._test_formula_pause_after_reserve_ms) } : {}),
      ...(isTestDb && Number(body._test_formula_wait_for_batch_deletion_fence_ms) > 0 ? { waitForBatchDeletionFenceMs: Number(body._test_formula_wait_for_batch_deletion_fence_ms) } : {}),
      simulateAmbiguousAfterCreate: isTestDb && body._test_ambiguous_after_create === true,
    },
  });

  const parked = pre.applied ? null : await requireApproval("cost.post", user, {
    entity: "CostEntry",
    summary: `Cost entry ₹${body.amount} (${user.name})${body.note ? ` — ${body.note}` : ""}${pre.basis ? ` · pre-approved basis: ${pre.basis}` : ""}`,
    payload: { ...body, _pre_approved_basis: pre.basis },
    location: body.location || undefined,
    batch: body.batch || undefined,
  });
  if (parked) return NextResponse.json({ queued: true, item: parked.request, pre_approval: pre.reason }, { status: 202 });
  if (pre.applied && pre.reservation?.state === "Applied") {
    const applied = await CostEntry.findById(pre.reservation.cost_entry_id);
    if (!applied) throw new HttpError(500, "The pre-approved reservation was applied but its ledger row could not be confirmed.");
    await settleFinanceAuditEvents({ costIds: [applied._id], failure: auditFailure }).catch(() => {});
    return NextResponse.json({ item: applied }, { status: 201 });
  }

  // When approval is disabled an above-formula submission keeps its Cancelled fencing row and
  // proceeds as an ordinary liability under a fresh id. Reusing the cancelled id would let a
  // delayed zombie and a direct write contend for one record.
  const ledgerEntryId = pre.reservation ? new Types.ObjectId() : costEntryId;
  const entry = {
    ...baseEntry,
    _id: ledgerEntryId,
    _audit_events: [createdEvent(ledgerEntryId)],
    // The decision as it was AT POST TIME, with the sentence it was made against. A later edit to the
    // head must never rewrite what was approved today.
    pre_approved_applied: pre.applied,
    pre_approved_basis: pre.applied ? pre.basis ?? undefined : undefined,
    pre_approved_unit: pre.applied ? "Fixed amount" : undefined,
    reservation_state: "Applied",
  };
  const doc = await createCostEntryIdempotently(entry, {
    simulateAmbiguousAfterCreate: isTestDb && body._test_ambiguous_after_create === true,
  });
  await settleFinanceAuditEvents({ costIds: [doc._id], failure: auditFailure }).catch(() => {});
  const confirmed = await CostEntry.findById(doc._id);
  if (!confirmed) throw new HttpError(500, "The cost was written but could not be read back.");
  return NextResponse.json({ item: confirmed }, { status: 201 });
});
