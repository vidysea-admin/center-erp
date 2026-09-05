// Approval matrix (RPL M24). Ships as an engine with every action switched OFF: with no
// enabled rule, `requireApproval` returns null and the caller proceeds exactly as before —
// zero behaviour change until an Admin turns an action on.
import { ApprovalRequest, ApprovalRule, Notification } from "@/models";
import { HttpError } from "@/lib/authz";
import type { SessionUser } from "@/auth";
import { audit } from "@/lib/audit";
import { mailUsers, mailUsersByRole } from "@/lib/mailer";
import { redactMoneyInText } from "@/lib/permissions";

export type ApprovalAction =
  | "location.close" | "location.stop" | "batch.cancel"
  | "invoice.raise" | "invoice.paid" | "batch.complete"
  | "cost.post" | "location.edit";

export type ApprovalOutcome = { request: any } | null;

// Returns null → proceed with the action.
// Returns { request } → the action was parked for approval; the caller must NOT apply it.
export async function requireApproval(
  action: ApprovalAction,
  user: SessionUser,
  ctx: { entity?: string; entity_id?: unknown; summary: string; payload?: unknown; location?: unknown },
): Promise<ApprovalOutcome> {
  const rule = await ApprovalRule.findOne({ action, enabled: true }).lean<any>();
  if (!rule) return null;

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
    location: ctx.location,
    initiator: user.id,
    approver_role: rule.approver_role,
    approver_users: approverUsers,
  });

  // Senior review of QA-1825 cycles 2-4: the queue was masked and then the SAME figure was
  // broadcast around it. This notification goes to `role_target: [approver_role]` — every user of
  // that role, not the finance grant-holders — and the mail below goes to the same list. So four
  // cycles of hiding `₹128500` from the approvals screen were undone by the bell beside it.
  //
  // Redacted UNCONDITIONALLY rather than per-reader, because a Notification row has no reader: it
  // is written once and read by whoever holds the role. Anyone entitled to the figure can open the
  // request itself, where the mask is per-reader and they will see it.
  const safeSummary = redactMoneyInText(ctx.summary, ctx.payload);
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

// Approve/reject. Returns the request so the caller can replay the payload on approval.
export async function decideApproval(requestId: string, user: SessionUser, decision: "Approved" | "Rejected", note?: string) {
  const request = await ApprovalRequest.findById(requestId);
  if (!request) throw new HttpError(404, "Approval request not found");
  if (request.status !== "Pending") throw new HttpError(409, `Already ${request.status}.`);
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
  request.status = decision;
  request.decided_by = user.id as any;
  request.decided_at = new Date();
  request.decision_note = note;
  await request.save();
  await Notification.updateMany(
    { entity: "ApprovalRequest", entity_id: request._id, status: { $in: ["New", "Acknowledged"] } },
    { $set: { status: "Resolved" } },
  );
  await audit({ entity: "ApprovalRequest", entityId: request._id, field: "status", newValue: decision, actor: user.id });
  return request;
}
