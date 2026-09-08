import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError, readJson } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { assertBatchInScope, transitionBatch } from "@/lib/rules";
import { requireApproval } from "@/lib/approvals";
import { Batch, Closure } from "@/models";
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
  const { target, reason, actual_start, actual_end, backdate_override, enrollment_override, exam_held } = await readJson(req);
  // Kept on the ordinary batches.manage right on purpose (Umesh, 24/08, asked which door this
  // should sit behind and chose "jiske paas batches.manage hai"). In the default matrix that is
  // Admin and Operations - Location, Enrollment and Trainer do not carry it.
  if (backdate_override === true && target !== "Active" && target !== "Completed") {
    throw new HttpError(400, "Recording a batch after the fact applies to starting and completing it, nothing else.");
  }
  // QA-1973: the enrolment hatch exists for STARTING a batch and nothing else. Refused up front
  // rather than ignored, so a caller that sends it at the wrong moment learns that it did nothing -
  // an override silently dropped is worse than one refused, because the sender believes it applied.
  if (enrollment_override === true && target !== "Active") {
    throw new HttpError(400, "Starting below the enrolment threshold applies to starting a batch, nothing else.");
  }
  // QA-2250: the same shape as enrollment_override above, and refused the same way for the same
  // reason - an override silently dropped is worse than one refused, because the sender believes it
  // applied. "The assessment was held" is a fact about moving a batch to Result Awaited and about
  // nothing else; it is not a way to stamp exam_held onto a batch at any other moment.
  if (exam_held === true && target !== "Closing") {
    throw new HttpError(400, "Recording that the assessment was held applies to moving a batch to Result Awaited, nothing else.");
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
  // QA-2250: recorded BEFORE the transition, because Rule 18 reads it off the Closure - written
  // after, the rule would refuse the very press that carries the fact. It is deliberately its own
  // audit row rather than a field on the status row: "who said the exam was held, and when" is the
  // entire reason Umesh chose an explicit press over an inferred assessment date, and that answer
  // has to survive independently of whether the transition it accompanied succeeded.
  // upsert, because a batch can reach Active with no Closure document at all.
  if (exam_held === true) {
    const c = await Closure.findOneAndUpdate(
      { batch: id },
      { $set: { exam_held: true, exam_held_by: user.id, exam_held_at: new Date() } },
      { upsert: true, new: true },
    );
    await audit({
      entity: "Closure", entityId: c._id, field: "exam_held", oldValue: "false", newValue: "true - the assessment was held; results are not required to reach Result Awaited (QA-2250)",
      actor: user.id, actorType: "USER",
    });
  }
  const batch = await transitionBatch(id, target, {
    isAdmin: user.role === "Admin", reason,
    actual_start: target === "Active" ? actual_start : undefined,
    actual_end: target === "Completed" ? actual_end : undefined,
    backdate_override: backdate_override === true,
    enrollment_override: enrollment_override === true,
    actor: user.id,
  });
  await audit({ entity: "Batch", entityId: batch._id, field: "status", newValue: target, oldValue: before?.status, actor: user.id });
  return NextResponse.json({ item: batch });
});
