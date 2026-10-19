// Approval matrix (RPL M24). Ships as an engine with every action switched OFF: with no
// enabled rule, `requireApproval` returns null and the caller proceeds exactly as before —
// zero behaviour change until an Admin turns an action on.
import { ApprovalRequest, ApprovalRule, AuditLog, Batch, CostCategory, CostEntry, Notification, User } from "@/models";
import { HttpError } from "@/lib/authz";
import type { SessionUser } from "@/auth";
import { audit, changedFields } from "@/lib/audit";
import { mailUsers, mailUsersByRole, type MailRecipient, type PerRecipientMail } from "@/lib/mailer";
import { redactMoneyInText, redactFiguresInText, financeApprovers, hasPermission, FINANCE_VIEW } from "@/lib/permissions";
import { createHash } from "crypto";
import { Types } from "mongoose";
import { confirmBatchAcceptingFinanceWork } from "@/lib/rules";

export type ApprovalAction =
  | "location.close" | "location.stop" | "batch.cancel"
  | "invoice.raise" | "invoice.paid" | "batch.complete"
  | "cost.post" | "location.edit"
  // QA-1828c. This union is a SECOND copy of APPROVAL_ACTIONS in models/index.ts and nothing keeps
  // them in step but a person remembering; tsc enforces this one and Mongoose the other, so an
  // action missing here fails at compile and missing there fails at runtime.
  | "costcategory.create";

export type ApprovalOutcome = { request: any } | null;
type ClaimedApproval = {
  _id: unknown;
  action?: string;
  status?: string;
  decided_by?: unknown;
  decided_at?: Date;
};

export type FinanceAuditEvent = {
  event_id: string;
  entity: string;
  entity_id: Types.ObjectId;
  field?: string;
  old_value?: unknown;
  new_value?: unknown;
  actor: Types.ObjectId;
  actor_type: "USER";
};

export function financeAuditEvent(
  key: string,
  input: Omit<FinanceAuditEvent, "event_id" | "actor_type">,
): FinanceAuditEvent {
  return {
    ...input,
    event_id: createHash("sha256").update(`finance-audit-v1:${key}`).digest("hex").slice(0, 24),
    actor_type: "USER",
  };
}

function sameAuditValue(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Existing production costs pre-date reservation_state and are visible liabilities by model
// contract. Their deletion audit must be recoverable exactly like a newer Applied row, while
// Pending/Cancelled fencing rows remain ineligible.
const COST_AUDIT_OWNER_ELIGIBLE = {
  $or: [
    { reservation_state: "Applied" },
    { reservation_state: { $exists: false } },
  ],
};

async function deliverOwnerEvents(
  collection: any,
  ownerId: Types.ObjectId,
  eligible: Record<string, unknown>,
  failure?: "before" | "after",
) {
  const owner = await collection.findOne({ _id: ownerId, ...eligible });
  if (!owner) return;
  const delivered = new Set((owner._audit_delivered_event_ids ?? []).map(String));
  for (const event of owner._audit_events ?? []) {
    if (!event?.event_id) {
      // A malformed owner is still undelivered. Returning success here would let it consume the
      // drain budget forever while the query keeps selecting it on every later read.
      throw new Error(`Audit owner ${ownerId} contains an event without an event_id.`);
    }
    if (delivered.has(String(event.event_id))) continue;
    const eventId = new Types.ObjectId(String(event.event_id));
    const durable = {
      _id: eventId,
      entity: event.entity,
      entity_id: new Types.ObjectId(String(event.entity_id)),
      // The MongoDB driver serializes undefined fields as null in this existing Mixed-shaped audit
      // schema. Normalize before both insert and comparison so a successful delivery can be marked
      // acknowledged instead of being retried forever after its own exact insert.
      field: event.field ?? null,
      old_value: event.old_value ?? null,
      new_value: event.new_value ?? null,
      actor: new Types.ObjectId(String(event.actor)),
      actor_type: "USER",
    };
    if (failure === "before") throw new Error("test-only audit delivery failure before insert");
    try {
      await AuditLog.collection.updateOne(
        { _id: eventId },
        { $setOnInsert: { ...durable, created_at: new Date() } },
        { upsert: true },
      );
    } catch (error: any) {
      // Two readers may drain the same owner concurrently. A duplicate-key from two racing
      // upserts is ambiguous until the deterministic occupant is read and compared below.
      if (error?.code !== 11000) throw error;
    }
    const written: any = await AuditLog.collection.findOne({ _id: eventId });
    const canonicalKeys = ["_id", "actor", "actor_type", "created_at", "entity", "entity_id", "field", "new_value", "old_value"];
    const writtenKeys = written ? Object.keys(written).sort() : [];
    if (!written
        || written.actor_type !== "USER"
        || !(written.created_at instanceof Date)
        || written.createdAt !== undefined
        || written.updatedAt !== undefined
        || !sameAuditValue(writtenKeys, canonicalKeys)
        || !["entity", "entity_id", "field", "old_value", "new_value", "actor", "actor_type"]
          .every((field) => sameAuditValue(written[field], (durable as any)[field]))) {
      throw new Error(`Audit event ${event.event_id} exists with different immutable details.`);
    }
    if (failure === "after") throw new Error("test-only audit delivery failure after insert");
    await collection.updateOne(
      { _id: ownerId, ...eligible },
      { $addToSet: { _audit_delivered_event_ids: String(event.event_id) } },
    );
  }
}

// QA-2495 (S2) - THE TOMBSTONE IS THE ONLY COPY, AND IT KEPT TWO OF THE TWELVE FIELDS THE FORM
// COLLECTS.
//
// A cost delete is a hard delete with a real cascade and no undo anywhere in the product, so
// whatever is not in this object is gone with the document. Until now it was `{ amount, note }`:
// the trail answered "how much and what for" and could NOT answer "against which centre, which
// batch, which trainer, on what date, paid how" - which is exactly the list a person re-entering
// the row by hand has to reconstruct. Not hypothetical: three CostEntry "deleted" rows written in
// production on 11 Sept 19:42 carry that two-field shape and those ten fields are unrecoverable.
// -305 puts the Delete control on /costs, the finance register AND the batch Costs tab at once
// (QA-2483), so the blast radius triples in one release - hence widened BEFORE it ships.
//
// ONE literal, built ONCE, handed to the writer and to its verifier. That is not tidiness, it is
// the QA-2497 lesson made structural: the two functions are a contract, and the way that contract
// broke last time was somebody widening one end of it alone. A shared type means a widening that
// reaches only one end now fails to compile.
//
// AND undefined IS NORMALIZED TO null, which is load-bearing twice over:
//  - `sameAuditValue` is JSON.stringify, so KEY ORDER is part of the comparison. A fixed literal
//    pins it; two hand-written object literals at two call sites would not.
//  - JSON.stringify DROPS an undefined key, while the driver writes it as null - the same asymmetry
//    `deliverOwnerEvents` already normalizes sixty lines above, for the same reason. Left alone, a
//    cost with no `note` (the common shape for a sheet-imported row) would be STORED as
//    `{...,"note":null}` and COMPARED against `{...}`, never match, and take the reuse-path 409.
//    That trap was already latent on the two-field snapshot; at twelve mostly-optional fields it
//    would have been the normal case rather than the edge one.
export type CostDeletionSnapshot = {
  entry_date: unknown; location: unknown; batch: unknown; trainer: unknown; category: unknown;
  amount: unknown; vendor_payee: unknown; voucher_no: unknown; payment_mode: unknown;
  paid_on: unknown; payment_ref: unknown; note: unknown;
};

export function costDeletionSnapshot(doc: any): CostDeletionSnapshot {
  const keep = (value: unknown) => (value === undefined ? null : value);
  // Field order follows the live Costs form top to bottom, so a reader of the audit row and a
  // person retyping the entry are looking at the same sequence. `note` is the form's Description
  // (models/index.ts CostEntrySchema says so explicitly) and stays last where the form puts it.
  return {
    entry_date: keep(doc?.entry_date),
    location: keep(doc?.location),
    batch: keep(doc?.batch),
    trainer: keep(doc?.trainer),
    category: keep(doc?.category),
    amount: keep(doc?.amount),
    vendor_payee: keep(doc?.vendor_payee),
    voucher_no: keep(doc?.voucher_no),
    payment_mode: keep(doc?.payment_mode),
    paid_on: keep(doc?.paid_on),
    payment_ref: keep(doc?.payment_ref),
    note: keep(doc?.note),
  };
}

// The deletion row must be recoverable before the CostEntry owner can disappear. Claim one
// deterministic owner-backed event first; concurrent or later authorized deleters reuse the
// original claimant's event rather than appending a second audit identity.
export async function ensureCostDeletionAuditEvent(input: {
  costId: unknown;
  actor: unknown;
  expectedUpdatedAt: unknown;
  oldValue: CostDeletionSnapshot;
  // QA-2484: WHY, alongside who/what/when. Manish asked for it directly on the 2026-09-11 call
  // ("delete krte waqt reason ka ek daal dena chahiye"), and it rides in the SAME atomic update
  // that stages the tombstone rather than being written beside it afterwards - a reason recorded
  // after the row is gone is a reason that can be missing exactly when the delete half-failed,
  // which is the case it exists for.
  reason: string;
}) {
  const costId = new Types.ObjectId(String(input.costId));
  const event = financeAuditEvent(`cost:${costId}:deleted`, {
    entity: "CostEntry",
    entity_id: costId,
    field: "deleted",
    old_value: input.oldValue,
    new_value: { deleted: true, reason: input.reason },
    actor: new Types.ObjectId(String(input.actor)),
  });
  const claim = await CostEntry.collection.updateOne(
    {
      _id: costId,
      ...COST_AUDIT_OWNER_ELIGIBLE,
      deletion_state: { $exists: false },
      cost_edit_request: null,
      updatedAt: input.expectedUpdatedAt,
      // QA-2495 widened the SNAPSHOT and deliberately did NOT widen this predicate to all twelve.
      // `updatedAt` is the concurrency token and already covers every field; these two are
      // defence-in-depth, and the whole snapshot is still compared field-for-field on the reuse
      // path below (`sameAuditValue(stored.old_value, event.old_value)`), so a mid-flight change to
      // any of the twelve is still caught. Adding ten more equality terms here would buy nothing and
      // would put ten new ways to produce a permanent, un-retryable 409 into the one handler
      // QA-2497 has already been through - a widening whose only untested outcome is a false refusal
      // is the shape of the bug, not the fix.
      amount: input.oldValue.amount,
      note: input.oldValue.note,
      "_audit_events.event_id": { $ne: event.event_id },
    },
    // `_audit_events` is deliberately Mixed and hidden from the public model; the native driver
    // accepts this shape, while Mongoose's generic collection type cannot express the field.
    {
      $set: { deletion_state: "Pending", deletion_audit_event_id: event.event_id },
      $push: { _audit_events: event },
    } as any,
  );
  // The event and tombstone were the same atomic update. A recovery read may already acknowledge
  // and collect the owner before this request runs another query, so the winning claimant must not
  // turn successful completion into a false foreign-claim 500 merely because the owner is gone.
  if (claim.modifiedCount === 1) {
    return { eventId: event.event_id, actor: String(event.actor), claimed: true };
  }
  const owner: any = await CostEntry.collection.findOne(
    { _id: costId, ...COST_AUDIT_OWNER_ELIGIBLE, deletion_state: "Pending" },
    { projection: { _audit_events: 1, deletion_audit_event_id: 1 } },
  );
  const committedEventId = String(owner?.deletion_audit_event_id ?? "");
  const stored = (owner?._audit_events ?? []).find((candidate: any) =>
    String(candidate?.event_id ?? "") === committedEventId);
  if (!owner) {
    const completed: any = await AuditLog.collection.findOne({ _id: new Types.ObjectId(event.event_id) });
    if (completed
        && completed.entity === "CostEntry"
        && sameAuditValue(completed.entity_id, costId)
        && completed.field === "deleted"
        && sameAuditValue(completed.old_value, event.old_value)
        && completed.actor_type === "USER"
        && completed.actor) {
      return { eventId: event.event_id, actor: String(completed.actor), claimed: false };
    }
  }
  if (!stored
      || !committedEventId
      || stored.entity !== "CostEntry"
      || !sameAuditValue(stored.entity_id, costId)
      || stored.field !== "deleted"
      || !sameAuditValue(stored.old_value, event.old_value)
      || stored.actor_type !== "USER"
      || !stored.actor
      || (claim.modifiedCount === 1 && committedEventId !== event.event_id)) {
    throw new HttpError(409, `Cost ${costId} changed while its deletion was being prepared. Refresh and retry.`);
  }
  return { eventId: committedEventId, actor: String(stored.actor), claimed: claim.modifiedCount === 1 };
}

// QA-2497 (S2) - THIS FUNCTION IS THE RESCUE PATH, AND -305 BROKE IT BY WIDENING THE WRITER.
//
// A DELETE that loses the race to a recovery read (which acknowledges and collects the tombstone
// first) finds its owner already gone. `costs/[id]/route.ts:190,197` then asks THIS function
// whether the deletion nevertheless landed durably, and returns 200 when it did - that is the whole
// reason the caller does not report a failure for an operation that fully succeeded. The comment
// above ensureCostDeletionAuditEvent's claim says it out loud: "the winning claimant must not turn
// successful completion into a false foreign-claim 500 merely because the owner is gone."
//
// QA-2484 made the writer stage `new_value: { deleted: true, reason }`. This checker still demanded
// `new_value === null`, so it rejected EVERY row the writer produced and the rescue never fired. The
// claimant got a 409 for a delete that had removed the row and written exactly one audit event.
// Measured, not inferred: this arm passed on walls _w303/_w305/_w306/_w307/_w308 and failed on
// _w310/_w311, the two carrying -305, with {"delete":409,"audits":1,"remains":false} identical on a
// deterministic re-run.
//
// The shape being verified is the CONTRACT between two functions twelve lines apart in the same
// file, and widening one without the other is how a guarantee gets deleted while every count stays
// green - this one only surfaced because a race test asserted the guarantee rather than the status.
// So `reason` is a REQUIRED parameter, not an optional one: a caller that forgets it fails to
// compile rather than silently falling back to the 409 this row exists to prevent.
//
// QA-2495 WIDENED old_value FROM TWO FIELDS TO TWELVE, AND WIDENED IT HERE IN THE SAME EDIT - which
// is the entire point of the paragraph above. `sameAuditValue(written.old_value, input.oldValue)`
// below compares the snapshot the writer stored against the snapshot this caller re-derives; had
// only `ensureCostDeletionAuditEvent` been widened, EVERY row the writer produced would have failed
// that line and the rescue would have stopped firing again, four hours after it was repaired the
// first time. Both ends now take the same `CostDeletionSnapshot`, produced by the same
// `costDeletionSnapshot` builder, so the next widening cannot reach one end alone without tsc
// saying so.
export async function costDeletionAuditIsDurable(input: {
  costId: unknown;
  eventId: string;
  actor: unknown;
  oldValue: CostDeletionSnapshot;
  reason: string;
}) {
  const owner = await CostEntry.collection.findOne({ _id: new Types.ObjectId(String(input.costId)) }, { projection: { _id: 1 } });
  if (owner) return false;
  const written: any = await AuditLog.collection.findOne({ _id: new Types.ObjectId(input.eventId) });
  const keys = written ? Object.keys(written).sort() : [];
  return !!written
    && written.entity === "CostEntry"
    && sameAuditValue(written.entity_id, new Types.ObjectId(String(input.costId)))
    && written.field === "deleted"
    && sameAuditValue(written.old_value, input.oldValue)
    && sameAuditValue(written.new_value, { deleted: true, reason: input.reason })
    && sameAuditValue(written.actor, new Types.ObjectId(String(input.actor)))
    && written.actor_type === "USER"
    && written.created_at instanceof Date
    && sameAuditValue(keys, ["_id", "actor", "actor_type", "created_at", "entity", "entity_id", "field", "new_value", "old_value"]);
}

export async function settleFinanceAuditEvents(input: {
  costIds?: unknown[];
  approvalIds?: unknown[];
  failure?: "before" | "after";
}) {
  let failure = input.failure;
  for (const id of input.costIds ?? []) {
    await deliverOwnerEvents(CostEntry.collection, new Types.ObjectId(String(id)), COST_AUDIT_OWNER_ELIGIBLE, failure);
    failure = undefined;
  }
  for (const id of input.approvalIds ?? []) {
    await deliverOwnerEvents(ApprovalRequest.collection, new Types.ObjectId(String(id)), { status: { $in: ["Approved", "Rejected"] } }, failure);
    failure = undefined;
  }
}

async function ownerFinanceAuditOutboxIsSettled(collection: any, id: unknown) {
  const owner: any = await collection.findOne(
    { _id: new Types.ObjectId(String(id)) },
    { projection: { _audit_events: 1, _audit_delivered_event_ids: 1 } },
  );
  if (!owner) return false;
  const delivered = new Set((owner._audit_delivered_event_ids ?? []).map(String));
  return (owner._audit_events ?? []).every((event: any) =>
    !!event?.event_id && delivered.has(String(event.event_id)));
}

export async function costFinanceAuditOutboxIsSettled(id: unknown) {
  return ownerFinanceAuditOutboxIsSettled(CostEntry.collection, id);
}

// Physical removal is garbage collection, not the business decision. The decision committed when
// the hidden tombstone and immutable event were claimed atomically; this CAS only removes an owner
// whose complete outbox, including that deletion event, is already acknowledged.
export async function garbageCollectSettledCostDeletion(id: unknown) {
  const ownerId = new Types.ObjectId(String(id));
  const owner: any = await CostEntry.collection.findOne(
    { _id: ownerId, deletion_state: "Pending" },
    { projection: { deletion_audit_event_id: 1, _audit_delivered_event_ids: 1 } },
  );
  const eventId = String(owner?.deletion_audit_event_id ?? "");
  if (!eventId || !(owner?._audit_delivered_event_ids ?? []).map(String).includes(eventId)) return false;
  const removed = await CostEntry.collection.deleteOne({
    _id: ownerId,
    deletion_state: "Pending",
    deletion_audit_event_id: eventId,
    _audit_delivered_event_ids: eventId,
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
  return removed.deletedCount === 1;
}

const drainGlobal = globalThis as typeof globalThis & {
  __financeAuditDrainCursor?: { cost?: string; approval?: string };
};
const financeAuditDrainCursor = drainGlobal.__financeAuditDrainCursor ??= {};

// Recovery does not depend on another write. Every normal finance ledger/approval list read calls
// this bounded drain; deterministic AuditLog ids make retries after either acknowledgement window
// exactly-once from the user's perspective.
export async function flushPendingFinanceAuditEvents(limit = 100) {
  const hasUndeliveredEvent = {
    $expr: {
      $gt: [
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
  };
  async function drainOwners(collection: any, eligible: Record<string, unknown>, kind: "cost" | "approval") {
    const remembered = financeAuditDrainCursor[kind];
    let after = remembered && Types.ObjectId.isValid(remembered) ? new Types.ObjectId(remembered) : undefined;
    let deliveredOwners = 0;
    let attemptedOwners = 0;
    const maxAttempts = Math.max(limit * 2, 100);
    // Success and attempt budgets are separate. A poison owner consumes an attempt but not a
    // delivery slot; the remembered cursor makes the next bounded read continue after it instead
    // of rescanning the same first pages forever. Costs and approvals rotate independently.
    while (deliveredOwners < limit && attemptedOwners < maxAttempts) {
      const take = Math.min(limit, maxAttempts - attemptedOwners);
      const page = await collection.find({
        $and: [
          eligible,
          { "_audit_events.0": { $exists: true } },
          kind === "cost" ? { $or: [hasUndeliveredEvent, { deletion_state: "Pending" }] } : hasUndeliveredEvent,
          ...(after ? [{ _id: { $gt: after } }] : []),
        ],
      }, { projection: { _id: 1 } }).sort({ _id: 1 }).limit(take).toArray();
      if (!page.length) {
        delete financeAuditDrainCursor[kind];
        break;
      }
      for (const owner of page) {
        attemptedOwners++;
        after = owner._id;
        financeAuditDrainCursor[kind] = String(owner._id);
        try {
          if (kind === "cost") await settleFinanceAuditEvents({ costIds: [owner._id] });
          else await settleFinanceAuditEvents({ approvalIds: [owner._id] });
          if (!(await ownerFinanceAuditOutboxIsSettled(collection, owner._id))) {
            throw new Error(`Audit owner ${owner._id} remains unsettled after delivery.`);
          }
          if (kind === "cost") await garbageCollectSettledCostDeletion(owner._id);
          deliveredOwners++;
          if (deliveredOwners >= limit) break;
        } catch {
          // This owner stays durable for reconciliation; continue to later ids in the same read.
        }
      }
      if (page.length < take) {
        delete financeAuditDrainCursor[kind];
        break;
      }
    }
  }

  await drainOwners(CostEntry.collection, COST_AUDIT_OWNER_ELIGIBLE, "cost");
  await drainOwners(ApprovalRequest.collection, { status: { $in: ["Approved", "Rejected"] } }, "approval");
}

// Returns null → proceed with the action.
// Returns { request } → the action was parked for approval; the caller must NOT apply it.
// QA-2485 (checker, 2026-09-11) is the finding this ANSWERS ONLY IN PART, and the gap is stated here
// rather than left for a reader to discover: *"An APPROVED cost can be rewritten to any amount by one
// PATCH - no re-approval, no bell, no mail. The two-person money control ends at the moment of
// approval."* This function supplies the bell and the mail. It does NOT supply the re-approval, so a
// single finance.approve holder can still rewrite an approved amount alone - now loudly instead of
// silently, which is a mitigation and not a fix.
//
// Closing it properly means re-parking a correction that changes amount, category or batch, and that
// is a FLOW change only Umesh can authorise: it puts a finance holder's own repair into the queue
// they themselves clear. Raised to him rather than decided here.
//
// Manish, 2026-09-11 - "aur phir edit pe bhi un logon ko wo message jaayega". A correction
// to an already-recorded cost is not a new approval and must NOT re-park: the people who would be
// asked are the people who already decided it, and parking every correction puts a finance holder's
// own repair into their own queue. He said MESSAGE, and a message is what this sends.
//
// WHO: the cost.post rule's audience - the named approvers if the rule names any, otherwise the
// approver role - because that is already this system's answer to "who watches money". The rule is
// read WITHOUT `enabled`, because who should hear about a correction does not depend on whether the
// gate is currently switched on. With no rule row at all there is no defined money audience and
// nothing is sent; that is requireApproval's own escape hatch ("no rule, nothing changes"), applied
// here on purpose rather than by omission.
//
// WHAT: the fields that changed, never their values. The recipient opens the entry to see figures,
// where the permission check actually lives - so a mail sitting in an inbox, on a lock screen or in
// a forward carries no amount at all. `redactMoneyInText` still runs over it with the patch as the
// payload, so if a value ever does reach this string it is taken out by the same rule -303 built.
//
// The actor is removed from the audience: telling somebody what they just did is noise, and noise
// is how a real alert stops being read.
export async function notifyCostCorrection(input: {
  costId: unknown;
  actor: SessionUser;
  patch: Record<string, unknown>;
  // QA-2506/QA-2508: the document AS IT WAS, so "changed" means changed rather than "was in the payload".
  // Required, not optional - a caller that cannot be bothered to pass it would silently fall back to
  // the old, wrong answer, and the wrong answer is the one that reads as working.
  before: Record<string, unknown>;
  batchCode?: string | null;
  location?: unknown;
}): Promise<{ notified: number; reason?: string }> {
  // QA-2506/QA-2508: was `Object.keys(input.patch)` - what was SENT. The cost form posts its whole payload,
  // so a correction touching only the date told the money approvers the AMOUNT had moved. Now the
  // same `changedFields` the audit trail itself uses (lib/audit.ts), so the notification and the
  // audit row can never again describe the same request differently.
  const fields = changedFields(input.before, input.patch ?? {}).filter((f) => f !== "updatedAt");
  if (!fields.length) return { notified: 0, reason: "nothing actually changed" };

  const rule = await ApprovalRule.findOne({ action: "cost.post" }).lean<any>();
  if (!rule) return { notified: 0, reason: "no cost.post rule is configured, so there is no defined money audience" };

  const named = (rule.approver_users ?? []).map(String).filter(Boolean)
    .filter((id: string) => String(id) !== String(input.actor.id));

  const where = input.batchCode ? ` on batch ${input.batchCode}` : "";
  const summary = redactMoneyInText(
    `Cost entry${where} corrected by ${input.actor.name} - changed: ${fields.join(", ")}`,
    input.patch,
  );

  await Notification.create({
    type: "cost_corrected",
    severity: "info",
    message: summary,
    entity: "CostEntry", entity_id: input.costId,
    link: "/costs",
    role_target: [rule.approver_role],
    ...(named.length ? { user_target: named } : {}),
    location: input.location,
  });

  // Fire-and-forget like every other mail door here: a notification must never fail the write it
  // describes. The per-account mail switch (QA-2461) governs it, so a silenced account still gets
  // the bell and no mail.
  (named.length
    ? mailUsers({
        perEvent: true, // mtg-c1 (R4): folded into the digest when "digest only" is ON
        userIds: named,
        subject: summary,
        title: "A recorded cost was corrected",
        lines: [summary, "Open the cost ledger to see the entry as it now stands."],
        link: "/costs", entity: "CostEntry", entity_id: input.costId,
      })
    : mailUsersByRole({
        perEvent: true,
        roles: [rule.approver_role], location: input.location,
        subject: summary,
        title: "A recorded cost was corrected",
        lines: [summary, "Open the cost ledger to see the entry as it now stands."],
        link: "/costs", entity: "CostEntry", entity_id: input.costId,
      })
  ).catch(() => {});

  return { notified: named.length || 1 };
}

// subject-amount (Umesh, 2026-10-19, REQ-235a): "Amount in mail subjects: show it only to the 4 people with
// finance access". ONE statement of "may this recipient be shown the figures in a mail" - the same
// finance.view check the in-app list and the daily digest use, never a role test (an Admin does not carry
// it, NO_ADMIN_BYPASS). A lookup that fails, or a recipient with no id, is treated as WITHOUT it.
export async function canSeeMailFigures(u: MailRecipient): Promise<boolean> {
  if (!u?._id) return false;
  return hasPermission(
    { id: String(u._id), role: String(u.role ?? ""), email: String(u.email ?? ""), name: String(u.name ?? "") } as SessionUser,
    FINANCE_VIEW,
  ).catch(() => false);
}

// The "approval needed" mail for ONE recipient. `canSeeFigures` defaults to false: a caller that forgets the
// flag sends the masked text (declared money values first, then every figure - QA-2447), never the raw one.
// The bell notification does NOT use this: a Notification row has no reader, so it stays masked for everyone.
export function approvalNeededMail(
  summary: string, payload: unknown, requesterName: string, canSeeFigures = false,
): { subject: string; lines: string[] } {
  const shown = canSeeFigures ? String(summary ?? "") : redactFiguresInText(redactMoneyInText(String(summary ?? ""), payload));
  return { subject: `Approval needed: ${shown}`, lines: [shown, `Requested by ${requesterName}.`] };
}

// The per-recipient callback `requireApproval` hands the mailer, as a function of its own so the wiring
// (finance.view question + raw builder) is testable without a server. A recipient who may not see figures
// gets `undefined`, which the mailer reads as "stay on the masked base text".
export function approvalNeededRecipientMail(summary: string, payload: unknown, requesterName: string): PerRecipientMail {
  return async (u) => (await canSeeMailFigures(u)) ? approvalNeededMail(summary, payload, requesterName, true) : undefined;
}

export async function requireApproval(
  action: ApprovalAction,
  user: SessionUser,
  ctx: {
    entity?: string; entity_id?: unknown; summary: string; payload?: unknown; location?: unknown; batch?: unknown;
    testPauseAfterCreateMs?: number;
    // QA-1977 (Umesh, 2026-10-06): some requests must ALWAYS reach a human, rule or no rule. A new
    // cost head named by a non-Admin is created at once but flagged not approved, and its sign-off
    // cannot depend on somebody having remembered to switch a rule on - that dependency is exactly
    // what produced the 409 Manish hit. With this set and no enabled rule, the request goes to this
    // role with no named approvers. An enabled rule still wins, so a configured approver list is
    // honoured. Every other caller leaves it unset and keeps "no rule = nothing changes".
    fallbackApproverRole?: string;
    // QA-1977 5B (Umesh, 2026-10-06): a NEW COST HEAD is signed off by any holder of the finance
    // approve right except its raiser - the grant is the rule, not the role and not a named list.
    // With this set the request snapshots no named approvers, and its bell + mail go to every such
    // holder other than the raiser (whatever their role), so a non-Admin approver actually hears
    // about it. Only requireHeadApproval below sets it (cost form + master list); every other request keeps its
    // configured role/named-list audience exactly. With no holder at all the old role audience is
    // used, so the request is never addressed to nobody.
    decidedByGrant?: boolean;
    // mtg-a3 R7: the scoped ("<user id>:<key>") idempotency key of the cost POST that parks here.
    // Stored on the request under a unique sparse index, so a duplicate POST can never open a
    // second request - the loser gets E11000 from the create below, before any bell or mail.
    idempotencyKey?: string;
    requestId?: Types.ObjectId;
  },
): Promise<ApprovalOutcome> {
  if (ctx.requestId) {
    const prior = await ApprovalRequest.findById(ctx.requestId);
    if (prior) {
      if (prior.action !== action || String(prior.initiator) !== String(user.id)) {
        throw new HttpError(409, "This approval identifier belongs to a different request.");
      }
      return { request: prior };
    }
  }
  const configured = await ApprovalRule.findOne({ action, enabled: true }).lean<any>();
  const rule = configured ?? (ctx.fallbackApproverRole ? { approver_role: ctx.fallbackApproverRole, approver_users: [] } : null);
  if (!rule) return null;

  const batchId = ctx.batch ? new Types.ObjectId(String(ctx.batch)) : undefined;
  if (batchId) {
    const live = await Batch.collection.findOne(
      { _id: batchId, deletion_state: { $exists: false } },
      { projection: { _id: 1 } },
    );
    if (!live) {
      throw new HttpError(409, "This batch is being deleted or no longer exists, so this request cannot be queued.");
    }
  }

  // QA-1826 (S1, filed 2026-09-05 on the CEO's own words): this line used to read
  //   `if (user.role === rule.approver_role && user.role === "Admin") return null;`
  // and it defeated the entire control for the one role that most needed it. An Admin who was the
  // configured approver never PARKED their own entry — it went straight to the ledger, unchecked,
  // so the self-approval refusal below (`decideApproval`, "an initiator can never approve their own
  // request") was unreachable for them: nothing had been parked to refuse.
  //
  // The CEO put it plainly: *"अगर कोई चीज़ मैंने डाली है तो वो अप्रूव मैं नहीं कर सकता, वो शुभी और
  // मनीष जी होंगे।"* — the person who raises it is never the person who clears it, and being the
  // approver is exactly what makes that matter, not what excuses it.
  //
  // Everyone parks now. The escape hatch that made this safe to ship in the first place — "with no
  // enabled rule nothing changes" — is untouched above: a disabled action still returns null.

  // QA-1827: the named list, snapshotted. An empty list means the role decides, exactly as before.
  const approverUsers = ctx.decidedByGrant ? [] : (rule.approver_users ?? []).map(String).filter(Boolean);
  // QA-1977 5B: the grant holders, minus the raiser (they can never decide it, so alerting them would
  // only invite a refusal). Computed before the request exists only to keep it beside its sibling.
  const grantHolders = ctx.decidedByGrant
    ? (await financeApprovers()).filter((h) => h.id !== String(user.id))
    : [];
  const request = await ApprovalRequest.create({
    ...(ctx.requestId ? { _id: ctx.requestId } : {}),
    action,
    entity: ctx.entity, entity_id: ctx.entity_id,
    summary: ctx.summary, payload: ctx.payload,
    location: ctx.location, batch: batchId,
    initiator: user.id,
    approver_role: rule.approver_role,
    approver_users: approverUsers,
    ...(ctx.idempotencyKey ? { idempotency_key: ctx.idempotencyKey } : {}),
  });

  // Test-only ordered race: the request is durable, but its post-create cleanup fence has not
  // run.  This proves that every queue path, not only Formula reservations, removes a request a
  // force-delete races after its child cascade.
  const testPause = /^center_erp_ci(?:_|$)/.test(process.env.MONGODB_DB ?? "")
    ? Math.max(0, Math.min(5_000, Number(ctx.testPauseAfterCreateMs ?? 0)))
    : 0;
  if (testPause) await new Promise((resolve) => setTimeout(resolve, testPause));

  // There is no cross-collection transaction on every supported deployment. Re-read the durable
  // batch fence after the request write with the final conditional Batch write; if force-delete
  // won the gap, delete only this newborn request before any notification/audit side effect and
  // fail closed.
  if (batchId) {
    try {
      await confirmBatchAcceptingFinanceWork(batchId);
    } catch (error) {
      await ApprovalRequest.deleteOne({ _id: request._id, batch: batchId });
      throw error;
    }
  }

  // Senior review of QA-1825 cycles 2-4: the queue was masked and then the SAME figure was
  // broadcast around it. This notification goes to `role_target: [approver_role]` — every user of
  // that role, not the finance grant-holders — and the mail below goes to the same list. So four
  // cycles of hiding `₹128500` from the approvals screen were undone by the bell beside it.
  //
  // Redacted UNCONDITIONALLY rather than per-reader, because a Notification row has no reader: it
  // is written once and read by whoever holds the role. Anyone entitled to the figure can open the
  // request itself, where the mask is per-reader and they will see it.
  // QA-2447 (checker, cycle 16): the THIRD house of one leak, and the comment directly above this
  // line already told the story - four cycles of hiding a figure from the approvals screen were
  // undone by the bell beside it. The bell was then fixed with the PAYLOAD-DRIVEN redactor, which
  // can only hunt figures the payload NAMES. A number a person TYPES into a note is not a payload
  // value, so the bell and the mail carried it back out - to exactly the ungranted reader the queue
  // (QA-2442) and the audit trail (QA-2427) had just been taught to blind.
  //
  // Same rule as both of those, in the one place left: on a money entity, take every figure.
  // `redactMoneyInText` first so a DECLARED value is matched precisely (an invoice number with no
  // rupee sign has nothing else to key on), then `redactFiguresInText` for the ones nobody declared.
  //
  // UNCONDITIONAL, AND THE COST OF THAT IS MEASURED RATHER THAN WAVED AT. It applies to every
  // approval action, not only the money ones, for the same reason the line above is unconditional
  // per-reader: `MONEY_ENTITIES` already contains `ApprovalRequest`, and `maskApprovalMoney` applies
  // exactly this rule to every approval row on the queue regardless of action - so gating it on an
  // ACTION LIST here would invent a third rule for one surface, and QA-1865 already recorded what a
  // list of names costs (it needed a live-caught addition within hours of being written).
  //
  // What that takes from a NON-money alert, measured on the real summaries this codebase writes:
  // `Complete batch AVP-GURU-RPLAVP-DST-07` loses nothing (two-digit groups survive); a batch code
  // carrying a YEAR loses the year; `capacity 30` survives and `capacity 120` does not;
  // `location.update` and `target.set` name changed FIELDS and carry no figures at all. The invoice
  // number in `invoice.raise` is taken deliberately - `invoice_no` is money-class by this module's
  // own INVOICE_MONEY_FIELDS rule. So the collateral is a room capacity of 100+ and a 3-digit run
  // inside a batch code, on the bell only, for a reader who can open the request and see both.
  const safeSummary = redactFiguresInText(redactMoneyInText(ctx.summary, ctx.payload));
  // subject-amount: the MAIL (not the bell) is decided per recipient. The base subject/lines passed to the
  // mailer below stay the masked text; a recipient holding finance.view is handed the raw summary instead.
  // The MailLog row for that send stores the masked base subject (mailer `logSubject` default), never the raw.
  const perRecipient = approvalNeededRecipientMail(ctx.summary, ctx.payload, user.name);
  if (grantHolders.length) {
    // QA-1977 5B: addressed person by person. `role_target` carries every role among them because
    // the inbox query matches on role first and user second; `user_target` is what narrows it to
    // the holders. The link is /finance, because /admin (the Approvals tab) is Admin-only and most
    // holders may not be Admins.
    await Notification.create({
      type: "approval_pending",
      severity: "warning",
      message: `Approval needed: ${safeSummary} (requested by ${user.name})`,
      entity: "ApprovalRequest", entity_id: request._id,
      link: "/finance",
      role_target: [...new Set(grantHolders.map((h) => h.role))],
      user_target: grantHolders.map((h) => h.id),
      location: ctx.location,
    });
    mailUsers({
      perEvent: true, // mtg-c1 (R4): folded into the digest when "digest only" is ON
      userIds: grantHolders.map((h) => h.id),
      excludeUserIds: [user.id], excludeEmails: [user.email], // approval-decision-mail C4: never the requester
      subject: `Approval needed: ${safeSummary}`,
      perRecipient,
      title: "A new cost head is waiting for your approval",
      lines: [`${safeSummary}`, `Requested by ${user.name}.`],
      link: "/finance", entity: "ApprovalRequest", entity_id: request._id,
    }).catch(() => {});
    await audit({ entity: "ApprovalRequest", entityId: request._id, field: "created", newValue: { summary: ctx.summary, payload: ctx.payload }, actor: user.id });
    return { request };
  }
  await Notification.create({
    type: "approval_pending",
    severity: "warning",
    message: `Approval needed: ${safeSummary} (requested by ${user.name})`,
    entity: "ApprovalRequest", entity_id: request._id,
    link: "/admin?tab=Approvals",
    // QA-1827: addressed to the named people when there are any. `role_target` is left set either
    // way so an existing rule with no named list behaves exactly as it did, and so the inbox query
    // has something to match on for those.
    role_target: [rule.approver_role],
    ...(approverUsers.length ? { user_target: approverUsers } : {}),
    location: ctx.location,
  });
  // QA-115: the approver hears about it in their inbox too — an approval that waits for
  // someone to open the bell is an approval that waits.
  (approverUsers.length
    ? mailUsers({
        perEvent: action === "cost.post", // mtg-c1: only cost approvals are folded - the digest's pending block is the cost one
        userIds: approverUsers,
        excludeUserIds: [user.id], excludeEmails: [user.email], // approval-decision-mail C4: never the requester
        subject: `Approval needed: ${safeSummary}`,
        perRecipient,
        title: "An action is waiting for your approval",
        lines: [`${safeSummary}`, `Requested by ${user.name}.`],
        link: "/admin?tab=Approvals", entity: "ApprovalRequest", entity_id: request._id,
      })
    : mailUsersByRole({
        perEvent: action === "cost.post",
        roles: [rule.approver_role], location: ctx.location,
        excludeUserIds: [user.id], excludeEmails: [user.email], // approval-decision-mail C4: never the requester
        subject: `Approval needed: ${safeSummary}`,
        perRecipient,
        title: "An action is waiting for your approval",
        // Mail leaves the building. A figure in a subject line survives in an inbox, on a phone
        // lock-screen and in a forward, long after any permission check could reach it.
        lines: [`${safeSummary}`, `Requested by ${user.name}.`],
        link: "/admin?tab=Approvals", entity: "ApprovalRequest", entity_id: request._id,
      })
  ).catch(() => {});

  // QA-1850: the payload rides along so the READ-side mask can redact the sentence properly — a
  // bare string here can only have its ₹ figures taken, not a bare invoice number. Stored raw on
  // purpose; `maskMoneyInAuditRow` decides per reader.
  await audit({ entity: "ApprovalRequest", entityId: request._id, field: "created", newValue: { summary: ctx.summary, payload: ctx.payload }, actor: user.id });
  return { request };
}

// QA-1977 owner decision 2026-10-06 ~22:00 (Umesh: "Admin heads also wait"): EVERY new cost head -
// whoever creates it, from the cost form or the Admin master list - is created not approved and gets
// one head-approval request, decided by any finance approve holder except its creator (5B). One
// function so both creation doors raise the identical request: same payload shape (which is what
// approvals/[id] and decideApproval recognise as "head-approval"), same audience, same summary.
// The caller has already created the head with approval_status "Pending", links the returned request
// to it (`approval_request`), and decides what to undo if this throws.
export async function requireHeadApproval(
  user: SessionUser,
  head: { id: Types.ObjectId; name: string; parent?: unknown },
  origin: "cost form" | "master list",
  capProposal?: { expected: Record<string, unknown>; proposed: Record<string, unknown>; expected_revision: number; requestId?: Types.ObjectId },
) {
  const outcome = await requireApproval("costcategory.create", user, {
    entity: "CostCategory", entity_id: head.id,
    summary: capProposal
      ? `Pre-approved policy change for "${head.name}" requested by ${user.name} — existing policy stays effective until another finance approver agrees`
      : `New cost head "${head.name}" added by ${user.name} — not approved yet`,
    payload: { kind: capProposal ? "cap-approval" : "head-approval", category: String(head.id), name: head.name, origin, ...(head.parent ? { parent: String(head.parent) } : {}), ...(capProposal ? { expected: capProposal.expected, proposed: capProposal.proposed, expected_revision: capProposal.expected_revision } : {}) },
    ...(capProposal?.requestId ? { requestId: capProposal.requestId } : {}),
    fallbackApproverRole: "Admin",
    decidedByGrant: true,
  });
  if (!outcome) throw new HttpError(500, "The new head's approval request could not be created.");
  return outcome;
}

// QA-2852 (Umesh, 2026-10-07): a cost parked under a head that is not approved says so on the approvals
// screens. The head's state is read NOW, here, not stored in the request: `summary` is written at park
// time and a mark written there would outlive the head's approval. `masked` is what the caller is about
// to return (money already masked) and `raw` the same rows before masking, in the same order - the head
// id is read from the raw payload, because a raiser without finance.view gets that payload masked.
// Adds `cost_head: { name, approval_status }` to a cost.post row whose head resolves; nothing else changes.
// A head with no approval_status gets `null`, which the screens read as approved (legacy heads).
export async function attachCostHeads<T extends Record<string, any>>(masked: T[], raw: any[]): Promise<T[]> {
  const ids = [...new Set(raw
    .filter((r) => r?.action === "cost.post")
    .map((r) => String(r?.payload?.category ?? ""))
    .filter((id) => Types.ObjectId.isValid(id)))];
  if (ids.length === 0) return masked;
  const cats = await CostCategory.collection
    .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } }, { projection: { name: 1, approval_status: 1 } })
    .toArray();
  const byId = new Map(cats.map((c: any) => [String(c._id), c]));
  return masked.map((m, i) => {
    const c: any = raw[i]?.action === "cost.post" ? byId.get(String(raw[i]?.payload?.category ?? "")) : null;
    return c ? { ...m, cost_head: { name: c.name, approval_status: c.approval_status ?? null } } : m;
  });
}

// pending-head-cap-bind (Umesh, 2026-10-19 ~16:00 IST, "go with best way"): the approver of a Pending
// cost head sees the head's pre-approved limit, the creator may still edit it meanwhile, and Approve
// carries the limit that was seen. The effective limit is the ONE definition below: the amount, but
// only while the head's pre-approval is switched on (a stored amount on a head with pre_approved off
// is not a limit anyone is bound by). `null` means "no limit".
export function headCapOf(cat: { pre_approved?: unknown; pre_approved_amount?: unknown } | null | undefined): number | null {
  return cat?.pre_approved === true && typeof cat.pre_approved_amount === "number" && Number.isFinite(cat.pre_approved_amount)
    ? cat.pre_approved_amount : null;
}
const fmtHeadCap = (n: number | null) => (n === null ? "none" : `₹${n.toLocaleString("en-IN")}`);

// Adds `head_cap: { amount, unit? }` to each head sign-off row. Read NOW from the head, never stored in
// the request (the creator may edit it while the head is Pending, so a stored copy would go stale), and
// only for a reader who may see money (`canSeeMoney` = finance.view; REQ-235a). `raw` is the same rows
// before masking, in the same order.
export async function attachHeadCaps<T extends Record<string, any>>(masked: T[], raw: any[], canSeeMoney: boolean): Promise<T[]> {
  if (!canSeeMoney) return masked;
  const isHead = (r: any) => r?.action === "costcategory.create" && r?.payload?.kind === "head-approval"
    && Types.ObjectId.isValid(String(r?.payload?.category ?? ""));
  const ids = [...new Set(raw.filter(isHead).map((r) => String(r.payload.category)))];
  if (ids.length === 0) return masked;
  const cats = await CostCategory.collection
    .find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } }, { projection: { pre_approved: 1, pre_approved_amount: 1, pre_approved_unit: 1 } })
    .toArray();
  const byId = new Map(cats.map((c: any) => [String(c._id), c]));
  return masked.map((m, i) => {
    if (!isHead(raw[i])) return m;
    const c: any = byId.get(String(raw[i].payload.category));
    if (!c) return m;
    const amount = headCapOf(c);
    const unit = amount !== null && c.pre_approved_unit && c.pre_approved_unit !== "Fixed amount" ? String(c.pre_approved_unit) : undefined;
    return { ...m, head_cap: { amount, ...(unit ? { unit } : {}) } };
  });
}

// The compare behind Approve on a Pending head. `seen` is the body's `seen_cap`: a number, or null for
// "the head showed no limit". Anything else - absent, a string, NaN - is refused too (fail closed), so
// a client that never learned the limit cannot approve past it. Called BEFORE decideApproval, so a
// refusal writes nothing at all. Returns silently when the head cannot be found: the replay's own
// "no longer exists" refusal owns that case.
export async function assertSeenHeadCap(categoryId: unknown, seen: unknown): Promise<void> {
  if (!Types.ObjectId.isValid(String(categoryId ?? ""))) return;
  const cat = await CostCategory.collection.findOne({ _id: new Types.ObjectId(String(categoryId)) },
    { projection: { pre_approved: 1, pre_approved_amount: 1 } });
  if (!cat) return;
  const current = headCapOf(cat as any);
  const seenOk = seen === null || (typeof seen === "number" && Number.isFinite(seen));
  if (!seenOk) throw new HttpError(409, "Reload this approval to see the head's current limit, then approve again.");
  if ((seen as number | null) !== current) {
    throw new HttpError(409, `Limit changed from ${fmtHeadCap(seen as number | null)} to ${fmtHeadCap(current)}, please review again.`);
  }
}

// Approve/reject. The Pending predicate is the claim: among concurrent approvers, exactly one
// changes the row and receives a request to replay. Reading Pending and then saving a document is
// not a claim — two readers can both do that — so do not replace the findOneAndUpdate with save().
export async function decideApproval(
  requestId: string,
  user: SessionUser,
  decision: "Approved" | "Rejected",
  note?: string,
  decisionData: { approvedAmount?: number; applying?: boolean; mapToCategory?: string; byGrant?: boolean } = {},
) {
  const request = await ApprovalRequest.findById(requestId);
  if (!request) throw new HttpError(404, "Approval request not found");
  const resuming = request.status === "Applying" && decision === "Approved" && decisionData.applying;
  if (request.status !== "Pending" && !resuming) throw new HttpError(409, `Already ${request.status}.`);
  // QA-1977 5B: a head-approval request is decided by the finance approve GRANT, which the caller
  // (POST /api/approvals/[id]) has already asserted with requireFinance(user, "approve"). The role
  // and named-list checks below therefore do not apply to it - "ANY user holding finance.approve,
  // regardless of role". Re-checked here from the stored request, not trusted from the flag alone,
  // so a caller passing byGrant for any other request still gets the full role rule.
  // An old whole-entry request stored the poster's raw body as its payload, so it could in principle
  // carry a typed `kind`; the server-built head-approval payload never has an amount, and that is
  // required too (senior review), so such a row keeps the full role rule.
  const byGrant = decisionData.byGrant === true
    && request.action === "costcategory.create"
    && ["head-approval", "cap-approval"].includes((request.payload as any)?.kind)
    && (request.payload as any)?.amount === undefined;
  if (!byGrant) {
    if (user.role !== request.approver_role && user.role !== "Admin") {
      throw new HttpError(403, `Only ${request.approver_role} may decide this request.`);
    }
    // QA-1827: a named list NARROWS the role, never widens it — the role check above still had to
    // pass. The list is the one snapshotted when the request was parked, so a rule edited afterwards
    // cannot retroactively change who was entitled to decide something already in the queue.
    const named = (request.approver_users ?? []).map(String).filter(Boolean);
    if (named.length && !named.includes(String(user.id))) {
      throw new HttpError(403, "This request is assigned to named approvers; you are not one of them.");
    }
  }
  // RPL M24: an initiator can never approve their own request.
  if (String(request.initiator) === String(user.id)) {
    throw new HttpError(403, "You cannot approve your own request.");
  }
  if (resuming) {
    if (note !== undefined && String(request.decision_note ?? "") !== String(note ?? "")) {
      throw new HttpError(409, "This approval is already applying a different decision note. Resume it without changing the decision.");
    }
    if (decisionData.approvedAmount !== undefined
        && Number(request.approved_amount ?? request.payload?.amount) !== decisionData.approvedAmount) {
      throw new HttpError(409, "This approval is already applying a different sanctioned amount. Resume it without changing the decision.");
    }
    if (decisionData.mapToCategory !== undefined
        && String(request.decision_map_to_category ?? "") !== String(decisionData.mapToCategory ?? "")) {
      throw new HttpError(409, "This approval is already applying a different cost head. Resume its original decision.");
    }
    return request;
  }
  const decidedAt = new Date();
  const nextStatus = decision === "Approved" && decisionData.applying ? "Applying" : decision;
  const decisionEvent = request.action === "cost.post" || request.action === "costcategory.create"
    ? financeAuditEvent(`approval:${request._id}:status:${decision}`, {
        entity: "ApprovalRequest", entity_id: new Types.ObjectId(String(request._id)), field: "status",
        new_value: decisionData.approvedAmount === undefined ? decision : { decision, approved_amount: decisionData.approvedAmount },
        actor: new Types.ObjectId(String(user.id)),
      })
    : null;
  const claimed = await ApprovalRequest.findOneAndUpdate(
    { _id: request._id, status: "Pending" },
    {
      $set: {
        status: nextStatus,
        decided_by: user.id,
        decided_at: decidedAt,
        decision_note: note,
        ...(decisionData.approvedAmount !== undefined ? { approved_amount: decisionData.approvedAmount } : {}),
        ...(decisionData.mapToCategory ? { decision_map_to_category: decisionData.mapToCategory } : {}),
        ...(decisionEvent ? { _audit_events: [decisionEvent] } : {}),
      },
    },
    { new: true, runValidators: true },
  );
  if (!claimed) {
    throw new HttpError(409, "This request was already claimed by another approver. Refresh the queue.");
  }
  return claimed;
}

// approval-decision-mail (Umesh, 2026-10-19: "approve ya reject ka bhi mail jana chahiye, tabhi to
// daalne wale ko pata chalega"). What the requester is told, built apart from the send so the words
// can be asserted on directly: the MailLog stores a subject and never a body.
//
// The summary is the SAME line the approval-needed mail carried and goes through the SAME redaction
// (declared money values, then every figure) - a mail leaves the building, and the recipient opens
// the entry in the ERP to see figures where the permission check lives. The reason typed by the
// decider is free text, so it gets the figure pass too. The sanctioned amount is never included.
export function buildDecisionMail(
  request: { action?: unknown; summary?: unknown; payload?: unknown; decision_note?: unknown },
  decider: { name: string },
  decision: "Approved" | "Rejected",
  // approval-decision-mail-r2 (C6): false = the requester lacks finance.view, so the typed note stays out
  // (the in-app list does the same: api/approvals ?mine=1 deletes decision_note for them).
  // subject-amount (C2): the same flag now also decides whether the SUMMARY carries the raw figures - a
  // requester with finance.view sees the amount in the subject and first line, everyone else the masked
  // text. The default is false (FAIL CLOSED, it was true): a bare call can no longer leak; the one send
  // path (decisionMailFor) always passes the real answer.
  canSeeNote = false,
): { subject: string; title: string; lines: string[]; link: string; log_subject: string } {
  const verb = decision === "Approved" ? "approved" : "rejected";
  const rawSummary = String(request.summary ?? "");
  const maskedSummary = redactFiguresInText(redactMoneyInText(rawSummary, request.payload));
  const summary = canSeeNote ? rawSummary : maskedSummary;
  const note = String(request.decision_note ?? "").trim();
  const lines = [summary, `${decision === "Approved" ? "Approved" : "Rejected"} by ${decider.name}.`];
  if (note && canSeeNote) lines.push(`${decision === "Approved" ? "Comment" : "Reason"}: ${redactFiguresInText(note)}`);
  else if (note) lines.push("Open the app or ask the approver for the reason.");
  const link = request.action === "cost.post" ? "/costs" : request.action === "costcategory.create" ? "/finance" : "/";
  // `log_subject` is ALWAYS the masked subject: the mail log is readable by any Admin, who does not hold
  // finance.view, so what is stored must not depend on who the recipient is.
  return { subject: `Your request was ${verb}: ${summary}`, title: `Your request was ${verb}`, lines, link, log_subject: `Your request was ${verb}: ${maskedSummary}` };
}

// The mail for one request, for ITS requester: whether the note travels is decided by the same
// finance.view check the in-app list uses (hasPermission(user, FINANCE_VIEW) - no second copy of the
// rule). A requester that cannot be found is treated as without it.
export async function decisionMailFor(
  request: any, decider: { name: string }, decision: "Approved" | "Rejected",
) {
  const row: any = request?.initiator
    ? await User.findById(request.initiator).select("role email name").lean().catch(() => null)
    : null;
  const canSeeNote = row ? await canSeeMailFigures(row) : false;
  return buildDecisionMail(request, decider, decision, canSeeNote);
}

// Only the requester (the request's initiator) is mailed - never the other approvers, never an
// address typed anywhere. It goes through mailUsers, so the global email_enabled switch, the
// per-account switch and the MailLog row apply unchanged (MailLog entity "ApprovalDecision"). It is
// NOT marked perEvent: digest-only mode folds the per-approval "needed" mails into the 21:00 digest,
// and that digest never lists decisions, so folding this one would mean the requester is never told.
// Fire-and-forget at the call site: a mail problem must never fail or undo a decision that has
// already been made.
async function notifyRequesterOfDecision(
  request: any, decider: SessionUser, decision: "Approved" | "Rejected",
) {
  if (!request?.initiator) return;
  const m = await decisionMailFor(request, decider, decision);
  await mailUsers({
    userIds: [request.initiator],
    subject: m.subject, logSubject: m.log_subject, title: m.title, lines: m.lines, link: m.link,
    entity: "ApprovalDecision", entity_id: request._id,
  });
}

// Side effects that say a decision is final run only after an Approved replay has succeeded (or
// immediately for Rejected, which has no replay). This keeps a failed apply out of the audit trail
// as a completed decision and leaves its notification actionable after rollback.
export async function finalizeApprovalDecision(
  request: ClaimedApproval,
  user: SessionUser,
  decision: "Approved" | "Rejected",
  decisionData: { approvedAmount?: number } = {},
) {
  let finalized: any = request;
  if (decision === "Approved" && request.status === "Applying") {
    finalized = await ApprovalRequest.findOneAndUpdate(
      { _id: request._id, status: "Applying", decided_by: request.decided_by, decided_at: request.decided_at },
      { $set: { status: "Approved" } },
      { new: true, runValidators: true },
    );
    if (!finalized) {
      const current: any = await ApprovalRequest.findById(request._id);
      if (current?.status === "Approved"
          && String(current.decided_by) === String(request.decided_by)
          && String(current.decided_at) === String(request.decided_at)) {
        finalized = current;
      } else {
        throw new Error(`Could not finalize applying approval ${request._id}; its claim changed.`);
      }
    }
  }
  await Notification.updateMany(
    { entity: "ApprovalRequest", entity_id: request._id, status: { $in: ["New", "Acknowledged"] } },
    { $set: { status: "Resolved" } },
  ).catch(() => {});
  // approval-decision-mail (Umesh, 2026-10-19): the person who raised it hears the outcome.
  notifyRequesterOfDecision(finalized ?? request, user, decision).catch(() => {});
  if (request.action === "cost.post" || request.action === "costcategory.create") {
    await settleFinanceAuditEvents({ approvalIds: [request._id] }).catch(() => {});
    return finalized;
  }
  await audit({
    entity: "ApprovalRequest", entityId: request._id, field: "status",
    newValue: decisionData.approvedAmount === undefined ? decision : { decision, approved_amount: decisionData.approvedAmount },
    actor: user.id,
  });
  return finalized;
}

// If replay fails before its effect is known to have landed, give the request back to the queue.
// The ownership + exact decided_at predicates are a compare-and-swap token: this rollback cannot
// reopen a row that another process has subsequently touched.
export async function rollbackApprovalDecision(request: ClaimedApproval) {
  const rolledBack = await ApprovalRequest.findOneAndUpdate(
    {
      _id: request._id,
      // A cap's durable policy receipt is forward-only. Its cancellation fence is owned by the
      // caller, and even a late recovery of that claim must never reopen a finalized decision.
      status: request.action === "costcategory.create" && (request as any).payload?.kind === "cap-approval"
        ? "Applying" : { $in: ["Applying", "Approved"] },
      decided_by: request.decided_by,
      decided_at: request.decided_at,
    },
    {
      $set: { status: "Pending" },
      $unset: {
        decided_by: 1,
        decided_at: 1,
        decision_note: 1,
        approved_amount: 1,
        decision_map_to_category: 1,
        _audit_events: 1,
        _audit_delivered_event_ids: 1,
      },
    },
    { new: true, runValidators: true },
  );
  if (!rolledBack) {
    throw new Error(`Could not return failed approval ${request._id} to Pending; its claim changed.`);
  }
  return rolledBack;
}

// mtg-b3 R10 (QA-2898, Umesh 2026-10-07): the replay of a creator's EDIT to an already-approved cost.
// The edit was parked as a `cost.post` request whose payload carries `kind: "cost-edit"` (see
// PATCH /api/costs/[id]); deciding it Approved lands HERE instead of creating a row. The ledger row is
// untouched until this runs, so an edit that nobody approves changes nothing - the same promise a new
// post makes ("approval IS the write").
//
// Safe to replay: a request that already owns the entry (approval_request === this request) returns
// at once, and the audit event is pushed under a deterministic id exactly once. It refuses, loudly and
// before writing, when the entry is no longer the one the creator saw - amount, head, batch or centre
// moved, it was deleted, or it was paid - so an approver is never made to approve a change to a row
// that has since become something else. A refusal here reopens the request (the route rolls the claim
// back), and the approver can reject it.
const COST_EDIT_FIELDS = ["entry_date", "location", "batch", "trainer", "category", "amount", "note", "vendor_payee", "voucher_no", "payment_mode"] as const;
export async function applyApprovedCostEdit(request: any, approvedAmount: number, approverId: unknown) {
  const p = (request.payload ?? {}) as any;
  const costId = new Types.ObjectId(String(p.cost_entry ?? request.entity_id));
  const raw: any = await CostEntry.collection.findOne({ _id: costId });
  if (!raw || raw.deletion_state) throw new HttpError(409, "The cost this edit was for no longer exists. Reject this request.");
  if (String(raw.approval_request ?? "") === String(request._id)) return costId; // already applied (a resumed claim)
  for (const field of ["note", "vendor_payee", "voucher_no", "payment_mode"]) {
    if (p[field] !== undefined && typeof p[field] !== "string") {
      throw new HttpError(400, `The proposed ${field.replaceAll("_", " ")} must be text. Reject this request and ask for the edit again.`);
    }
  }
  if (String(raw.cost_edit_request ?? "") !== String(request._id)) {
    throw new HttpError(409, "This request no longer owns the cost change. Reject it and ask for the edit again.");
  }
  if (raw.archived_at) throw new HttpError(409, "The cost this edit was for has since been deleted. Reject this request.");
  if (raw.payment_status !== "Payment Pending") throw new HttpError(409, "This cost has been marked paid since the edit was requested, so it can no longer be changed here. Reject this request.");
  // The row must still be the one the creator edited: its updatedAt is carried in the payload as
  // `base_updated_at` (a timestamp, not the old amount - the queue masks money keys but not a nested
  // copy of one, so no figure rides along that the masker cannot see).
  if (!p.base_updated_at || new Date(raw.updatedAt).toISOString() !== new Date(p.base_updated_at).toISOString()) {
    throw new HttpError(409, "This cost was changed after the edit was requested, so approving it would overwrite that change. Reject this request and ask for the edit again.");
  }
  const { assertActiveCostCategory } = await import("@/lib/rules");
  await assertActiveCostCategory(p.category, { requireApproved: true });
  const formulaCommitment = raw.pre_approved_applied && raw.pre_approved_unit === "Per billable passed";
  const materialChange = Number(raw.amount) !== approvedAmount
    || ["batch", "category", "location"].some((field) => String(raw[field] ?? "") !== String(p[field] ?? ""));
  const toValue = (f: string): unknown => {
    const v = f === "amount" ? approvedAmount : p[f];
    if (v === undefined || v === null || v === "") return undefined;
    if (f === "entry_date") return new Date(v);
    if (["location", "batch", "trainer", "category"].includes(f)) return new Types.ObjectId(String(v));
    return v;
  };
  const set: Record<string, unknown> = {
    requested_amount: Number(p.amount),
    approval_request: new Types.ObjectId(String(request._id)),
    pre_approved_applied: formulaCommitment && !materialChange ? true : false,
    updatedAt: new Date(),
  };
  const unset: Record<string, 1> = {
    pre_approved_basis: 1, pre_approved_unit: 1, cost_edit_request: 1, cost_edit_proposal: 1,
  };
  if (formulaCommitment && materialChange) {
    // A human has now sanctioned the replacement. Release the old automated commitment in the
    // same row CAS that applies that decision, never when a proposal is merely submitted.
    unset.reservation_kind = 1; unset.reservation_state = 1; unset.reservation_expires_at = 1;
  } else if (formulaCommitment) {
    delete unset.pre_approved_basis; delete unset.pre_approved_unit;
  }
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const f of COST_EDIT_FIELDS) {
    const v = toValue(f);
    if (v === undefined) unset[f] = 1; else set[f] = v;
    if (JSON.stringify(raw[f] ?? null) !== JSON.stringify(v ?? null)) changes[f] = { from: raw[f] ?? null, to: v ?? null };
  }
  if (p._pre_approved_basis) set.pre_approved_basis = p._pre_approved_basis;
  if (p._pre_approved_basis) delete unset.pre_approved_basis;
  const event = financeAuditEvent(`cost:${costId}:edited-via:${request._id}`, {
    entity: "CostEntry", entity_id: costId, field: "edited",
    old_value: { amount: raw.amount, category: raw.category ?? null, batch: raw.batch ?? null, location: raw.location ?? null },
    new_value: { via_approval: String(request._id), approved_amount: approvedAmount, changes },
    actor: new Types.ObjectId(String(approverId)),
  });
  const updated = await CostEntry.collection.updateOne(
    {
      _id: costId, payment_status: "Payment Pending", archived_at: null, deletion_state: { $exists: false },
      updatedAt: raw.updatedAt, cost_edit_request: new Types.ObjectId(String(request._id)),
      "_audit_events.event_id": { $ne: event.event_id },
    },
    { $set: set, $unset: unset, $push: { _audit_events: event } } as any,
  );
  if (updated.modifiedCount !== 1) {
    const now: any = await CostEntry.collection.findOne({ _id: costId }, { projection: { approval_request: 1 } });
    if (String(now?.approval_request ?? "") === String(request._id)) return costId;
    throw new HttpError(409, "This cost changed while the edit was being applied. Nothing was changed; refresh and decide it again.");
  }
  return costId;
}
