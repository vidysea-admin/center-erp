import { NextRequest, NextResponse } from "next/server";
import { Types } from "mongoose";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, isScoped, HttpError } from "@/lib/authz";
import { hasFinanceApprove, requirePerm } from "@/lib/permissions";
import { CostEntry } from "@/models";
import { isCostCreator } from "@/lib/rules";
import { financeAuditEvent, settleFinanceAuditEvents } from "@/lib/approvals";

// mtg-b3 R10 (QA-2898, Umesh 2026-10-07): a creator's soft delete is recoverable. This undoes it - the
// row comes back exactly as it was (nothing about it was changed when it was archived) and is in every
// total again. Allowed to the person who entered it (costs.manage) and to finance (finance.approve),
// within their location scope. The restore writes an audit row, like the delete did.
export const POST = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  const finance = await hasFinanceApprove(user);
  if (!finance) await requirePerm(user, "costs.manage");
  requireEdit(user);
  if (!Types.ObjectId.isValid(id)) throw new HttpError(404, "Cost entry not found");
  // `archivedOnly` is the one query option that turns the hidden-row filter around: it finds ONLY
  // soft-deleted rows (models/index.ts), so a live row is "not found" here rather than "restored twice".
  const doc: any = await CostEntry.findOne({ _id: id }).setOptions({ archivedOnly: true }).lean();
  if (!doc) throw new HttpError(404, "This cost was not found among the deleted entries.");
  if (isScoped(user) && (!doc.location || !user.location_scope.map(String).includes(String(doc.location)))) {
    throw new HttpError(403, "Out of scope");
  }
  if (!finance && !isCostCreator(user, doc)) {
    throw new HttpError(403, "You can restore only the cost entries you entered yourself.");
  }
  if (!finance && doc.payment_status !== "Payment Pending") {
    throw new HttpError(409, doc.payment_status === "Paid"
      ? "This cost is already marked paid, so it is locked. Ask finance if it needs to change."
      : "The payment status of this cost is not recorded. Ask finance to verify it before restoring it.");
  }
  const now = new Date();
  const event = financeAuditEvent(`cost:${doc._id}:restored-at:${now.getTime()}`, {
    entity: "CostEntry", entity_id: doc._id, field: "restored",
    old_value: { archived_at: doc.archived_at ?? null, reason: doc.archive_reason ?? null },
    new_value: "restored",
    actor: new Types.ObjectId(String(user.id)),
  });
  const written = await CostEntry.collection.updateOne(
    { _id: doc._id, deletion_state: { $exists: false }, archived_at: { $ne: null },
      updatedAt: doc.updatedAt, cost_edit_request: null,
      ...(!finance ? { payment_status: "Payment Pending" } : {}),
    },
    {
      $set: { updatedAt: now },
      $unset: { archived_at: "", archived_by: "", archive_reason: "" },
      $push: { _audit_events: event },
    } as any,
  );
  if (written.modifiedCount !== 1) {
    throw new HttpError(409, "This cost was restored or removed while you were doing this. Refresh and check.");
  }
  await settleFinanceAuditEvents({ costIds: [doc._id] }).catch(() => {});
  const item = await CostEntry.findById(doc._id);
  return NextResponse.json({ item });
});
