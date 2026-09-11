// Approval matrix (RPL M24). Ships as an engine with every action switched OFF: with no
// enabled rule, `requireApproval` returns null and the caller proceeds exactly as before —
// zero behaviour change until an Admin turns an action on.
import { ApprovalRequest, ApprovalRule, AuditLog, Batch, CostEntry, Notification } from "@/models";
import { HttpError } from "@/lib/authz";
import type { SessionUser } from "@/auth";
import { audit } from "@/lib/audit";
import { mailUsers, mailUsersByRole } from "@/lib/mailer";
import { redactMoneyInText, redactFiguresInText } from "@/lib/permissions";
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

// The deletion row must be recoverable before the CostEntry owner can disappear. Claim one
// deterministic owner-backed event first; concurrent or later authorized deleters reuse the
// original claimant's event rather than appending a second audit identity.
export async function ensureCostDeletionAuditEvent(input: {
  costId: unknown;
  actor: unknown;
  expectedUpdatedAt: unknown;
  oldValue: { amount: unknown; note: unknown };
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
      updatedAt: input.expectedUpdatedAt,
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

export async function costDeletionAuditIsDurable(input: {
  costId: unknown;
  eventId: string;
  actor: unknown;
  oldValue: { amount: unknown; note: unknown };
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
    && written.new_value === null
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
  batchCode?: string | null;
  location?: unknown;
}): Promise<{ notified: number; reason?: string }> {
  const fields = Object.keys(input.patch ?? {}).filter((f) => f !== "updatedAt");
  if (!fields.length) return { notified: 0, reason: "nothing changed" };

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
        userIds: named,
        subject: summary,
        title: "A recorded cost was corrected",
        lines: [summary, "Open the cost ledger to see the entry as it now stands."],
        link: "/costs", entity: "CostEntry", entity_id: input.costId,
      })
    : mailUsersByRole({
        roles: [rule.approver_role], location: input.location,
        subject: summary,
        title: "A recorded cost was corrected",
        lines: [summary, "Open the cost ledger to see the entry as it now stands."],
        link: "/costs", entity: "CostEntry", entity_id: input.costId,
      })
  ).catch(() => {});

  return { notified: named.length || 1 };
}

export async function requireApproval(
  action: ApprovalAction,
  user: SessionUser,
  ctx: {
    entity?: string; entity_id?: unknown; summary: string; payload?: unknown; location?: unknown; batch?: unknown;
    testPauseAfterCreateMs?: number;
  },
): Promise<ApprovalOutcome> {
  const rule = await ApprovalRule.findOne({ action, enabled: true }).lean<any>();
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
  const approverUsers = (rule.approver_users ?? []).map(String).filter(Boolean);
  const request = await ApprovalRequest.create({
    action,
    entity: ctx.entity, entity_id: ctx.entity_id,
    summary: ctx.summary, payload: ctx.payload,
    location: ctx.location, batch: batchId,
    initiator: user.id,
    approver_role: rule.approver_role,
    approver_users: approverUsers,
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
        userIds: approverUsers,
        subject: `Approval needed: ${safeSummary}`,
        title: "An action is waiting for your approval",
        lines: [`${safeSummary}`, `Requested by ${user.name}.`],
        link: "/admin?tab=Approvals", entity: "ApprovalRequest", entity_id: request._id,
      })
    : mailUsersByRole({
        roles: [rule.approver_role], location: ctx.location,
        subject: `Approval needed: ${safeSummary}`,
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

// Approve/reject. The Pending predicate is the claim: among concurrent approvers, exactly one
// changes the row and receives a request to replay. Reading Pending and then saving a document is
// not a claim — two readers can both do that — so do not replace the findOneAndUpdate with save().
export async function decideApproval(
  requestId: string,
  user: SessionUser,
  decision: "Approved" | "Rejected",
  note?: string,
  decisionData: { approvedAmount?: number; applying?: boolean; mapToCategory?: string } = {},
) {
  const request = await ApprovalRequest.findById(requestId);
  if (!request) throw new HttpError(404, "Approval request not found");
  const resuming = request.status === "Applying" && decision === "Approved" && decisionData.applying;
  if (request.status !== "Pending" && !resuming) throw new HttpError(409, `Already ${request.status}.`);
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
      status: { $in: ["Applying", "Approved"] },
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
