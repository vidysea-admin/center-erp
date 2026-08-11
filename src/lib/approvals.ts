// Approval matrix (RPL M24). Ships as an engine with every action switched OFF: with no
// enabled rule, `requireApproval` returns null and the caller proceeds exactly as before —
// zero behaviour change until an Admin turns an action on.
import { ApprovalRequest, ApprovalRule, Notification } from "@/models";
import { HttpError } from "@/lib/authz";
import type { SessionUser } from "@/auth";
import { audit } from "@/lib/audit";

export type ApprovalAction =
  | "location.close" | "location.stop" | "batch.cancel"
  | "invoice.raise" | "invoice.paid" | "batch.complete";

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

  // An approver acting on their own initiation would defeat the control; Admins are the
  // escape hatch only when they are themselves the configured approver.
  if (user.role === rule.approver_role && user.role === "Admin") return null;

  const request = await ApprovalRequest.create({
    action,
    entity: ctx.entity, entity_id: ctx.entity_id,
    summary: ctx.summary, payload: ctx.payload,
    location: ctx.location,
    initiator: user.id,
    approver_role: rule.approver_role,
  });

  await Notification.create({
    type: "approval_pending",
    severity: "warning",
    message: `Approval needed: ${ctx.summary} (requested by ${user.name})`,
    entity: "ApprovalRequest", entity_id: request._id,
    link: "/admin?tab=Approvals",
    role_target: [rule.approver_role],
    location: ctx.location,
  });

  await audit({ entity: "ApprovalRequest", entityId: request._id, field: "created", newValue: ctx.summary, actor: user.id });
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
