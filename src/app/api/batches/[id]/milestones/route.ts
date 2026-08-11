import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { Batch } from "@/models";
import { assertBatchInScope, planBatchBackward } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";
import { audit } from "@/lib/audit";

// Backward-plan checklist (2026-08-11): tick a milestone off / untick it, or regenerate the
// plan from current Defaults while the batch is still in Planning.
export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  const { id } = await ctx.params;
  await assertBatchInScope(user, id);
  const batch = await Batch.findById(id);
  if (!batch) throw new HttpError(404, "Batch not found");
  if (["Completed", "Cancelled"].includes(batch.status)) throw new HttpError(409, "Batch is closed.");
  const body = await req.json();

  if (body.regenerate) {
    if (batch.status !== "Planning") throw new HttpError(409, "Plan can only be regenerated while the batch is in Planning.");
    const doneByKey = new Map((batch.milestones ?? []).map((m: any) => [m.key, m]));
    batch.milestones = planBatchBackward(batch.planned_start, await getDefaults()).map((m) => ({
      ...m,
      done_on: (doneByKey.get(m.key) as any)?.done_on,
      done_by: (doneByKey.get(m.key) as any)?.done_by,
    })) as any;
    await batch.save();
    await audit({ entity: "Batch", entityId: batch._id, field: "milestones", newValue: "plan regenerated", actor: user.id });
    return NextResponse.json({ item: batch });
  }

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
