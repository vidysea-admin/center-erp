import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { assertBatchInScope, transitionBatch } from "@/lib/rules";
import { requireApproval } from "@/lib/approvals";
import { Batch } from "@/models";
import { audit } from "@/lib/audit";

// POST { target: "Ready"|"Active"|"Closing"|"Completed"|"Cancelled"|"Planning", reason?,
//        actual_start?, actual_end?, backdate_override? }
//        actual_start (YYYY-MM-DD, today or earlier) only for target Active:
//        -81 (Umesh 15/08) a batch entered after it began starts with its REAL date.
//        -226 (Umesh 24/08) backdate_override records a batch that ALREADY RAN: it takes
//        Planning straight to Active and turns the readiness checks and the enrollment
//        threshold into an audited note instead of a refusal. It applies only to target
//        Active, and rules.ts refuses it outright unless planned_start is strictly past -
//        an override with nothing to override is just a readiness bypass. actual_end rides
//        the same flag on target Completed, so a batch that finished in July does not
//        record "ended today".
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "batches.manage"); // togglable (2026-08-11)
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const { target, reason, actual_start, actual_end, backdate_override } = await req.json();
  // Kept on the ordinary batches.manage right on purpose (Umesh, 24/08, asked which door this
  // should sit behind and chose "jiske paas batches.manage hai"). In the default matrix that is
  // Admin and Operations - Location, Enrollment and Trainer do not carry it.
  if (backdate_override === true && target !== "Active" && target !== "Completed") {
    throw new HttpError(400, "Recording a batch after the fact applies to starting and completing it, nothing else.");
  }

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

  // -235: this row hardcoded `oldValue: undefined`, so the ONE audit entry that records a status move
  // rendered as `null → "Completed"` on the Activity tab and never said what it moved FROM. It became
  // load-bearing here: restoring a mistakenly-cancelled batch has to be able to answer "cancelled from
  // what?", and the Activity tab was the only place that could ever have known. Read before the write,
  // because transitionBatch saves the new status onto the same document.
  const before = await Batch.findById(id).select("status").lean<any>();
  const batch = await transitionBatch(id, target, {
    isAdmin: user.role === "Admin", reason,
    actual_start: target === "Active" ? actual_start : undefined,
    actual_end: target === "Completed" ? actual_end : undefined,
    backdate_override: backdate_override === true,
    actor: user.id,
  });
  await audit({ entity: "Batch", entityId: batch._id, field: "status", newValue: target, oldValue: before?.status, actor: user.id });
  return NextResponse.json({ item: batch });
});
