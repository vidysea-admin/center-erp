import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch } from "@/models";
import { assertBatchInScope, planBatchBackward } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";
import { audit } from "@/lib/audit";

// Backward-plan checklist (2026-08-11): tick a milestone off / untick it, or regenerate the
// plan from current Defaults while the batch is still in Planning.
// QA-152 (-81, Umesh 15/08): { create: true } is the ONE way a batch gets a plan — "planning
// is a deliberate act, not a side-effect of saving a batch". It sets plan_enabled and
// generates the milestones (keeping any done_on/done_by a pre--81 batch already carried).
export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "batches.manage"); // togglable (2026-08-11)
  const { id } = await ctx.params;
  await assertBatchInScope(user, id);
  const batch = await Batch.findById(id);
  if (!batch) throw new HttpError(404, "Batch not found");
  if (["Completed", "Cancelled"].includes(batch.status)) throw new HttpError(409, "Batch is closed.");
  const body = await req.json();

  if (body.create || body.regenerate) {
    if (body.regenerate && !batch.plan_enabled) throw new HttpError(409, "This batch has no plan yet — create one first.");
    if (batch.status !== "Planning") throw new HttpError(409, body.create ? "A backward plan is made while the batch is in Planning." : "Plan can only be regenerated while the batch is in Planning.");
    const creating = !batch.plan_enabled;
    batch.plan_enabled = true;
    const doneByKey = new Map((batch.milestones ?? []).map((m: any) => [m.key, m]));
    batch.milestones = planBatchBackward(batch.planned_start, await getDefaults()).map((m) => ({
      ...m,
      done_on: (doneByKey.get(m.key) as any)?.done_on,
      done_by: (doneByKey.get(m.key) as any)?.done_by,
    })) as any;
    await batch.save();
    await audit({ entity: "Batch", entityId: batch._id, field: "milestones", newValue: creating ? "plan created" : "plan regenerated", actor: user.id });
    return NextResponse.json({ item: batch });
  }
  if (!batch.plan_enabled) throw new HttpError(409, "This batch has no plan yet — create one first.");

  const key = String(body.key ?? "");
  const m = (batch.milestones ?? []).find((x: any) => x.key === key);
  if (!m) throw new HttpError(404, "Milestone not found");
  if (body.done) {
    (m as any).done_on = new Date();
    (m as any).done_by = user.id;
  } else {
    (m as any).done_on = undefined;
    (m as any).done_by = undefined;
  }
  batch.markModified("milestones");
  await batch.save();
  await audit({ entity: "Batch", entityId: batch._id, field: `milestone:${key}`, newValue: body.done ? "done" : "reopened", actor: user.id });
  return NextResponse.json({ item: batch });
});
