import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { assertBatchInScope, transitionBatch } from "@/lib/rules";
import { requireApproval } from "@/lib/approvals";
import { Batch } from "@/models";
import { audit } from "@/lib/audit";

// POST { target: "Ready"|"Active"|"Closing"|"Completed"|"Cancelled"|"Planning", reason? }
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "batches.manage"); // togglable (2026-08-11)
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const { target, reason } = await req.json();

  // RPL M24: gated only when an Admin has enabled the action; otherwise a no-op.
  if (target === "Cancelled" || target === "Completed") {
    const b = await Batch.findById(id).select("code location").lean<any>();
    const gate = await requireApproval(
      target === "Cancelled" ? "batch.cancel" : "batch.complete",
      user,
      {
        entity: "Batch", entity_id: id, location: b?.location,
        summary: `${target === "Cancelled" ? "Cancel" : "Complete"} batch ${b?.code}${reason ? ` — ${reason}` : ""}`,
        payload: { reason },
      },
    );
    if (gate) {
      return NextResponse.json({ pending_approval: true, request: gate.request, message: "Sent for approval." }, { status: 202 });
    }
  }

  const batch = await transitionBatch(id, target, { isAdmin: user.role === "Admin", reason });
  await audit({ entity: "Batch", entityId: batch._id, field: "status", newValue: target, oldValue: undefined, actor: user.id });
  return NextResponse.json({ item: batch });
});
