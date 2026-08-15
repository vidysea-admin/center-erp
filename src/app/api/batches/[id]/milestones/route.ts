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

  // QA-152 part 2 (-82): the plan is an artifact the planner EDITS — due dates, labels,
  // notes, an owner per row, rows added by hand, rows removed. Same right (batches.manage),
  // every change audited by key.
  if (body.edit && typeof body.edit === "object") {
    const e = body.edit;
    const m = (batch.milestones ?? []).find((x: any) => x.key === String(e.key ?? ""));
    if (!m) throw new HttpError(404, "Milestone not found");
    const changed: string[] = [];
    if (e.due_date !== undefined) { const d = new Date(e.due_date); if (isNaN(d.getTime())) throw new HttpError(400, "due_date is not a valid date."); (m as any).due_date = d; changed.push("due_date"); }
    if (e.label !== undefined) { const l = String(e.label).trim(); if (!l) throw new HttpError(400, "label cannot be empty."); (m as any).label = l.slice(0, 120); changed.push("label"); }
    if (e.notes !== undefined) { (m as any).notes = String(e.notes).slice(0, 500) || undefined; changed.push("notes"); }
    if (e.owner_label !== undefined) { (m as any).owner_label = String(e.owner_label).slice(0, 80) || undefined; changed.push("owner_label"); }
    if (!changed.length) throw new HttpError(400, "Nothing to change.");
    batch.markModified("milestones");
    await batch.save();
    await audit({ entity: "Batch", entityId: batch._id, field: `milestone:${(m as any).key}`, newValue: `edited ${changed.join(", ")}`, actor: user.id });
    return NextResponse.json({ item: batch });
  }
  if (body.add && typeof body.add === "object") {
    const a = body.add;
    const label = String(a.label ?? "").trim();
    if (!label) throw new HttpError(400, "label is required.");
    const d = new Date(a.due_date);
    if (!a.due_date || isNaN(d.getTime())) throw new HttpError(400, "due_date is required.");
    const key = "custom_" + Date.now().toString(36);
    (batch.milestones as any).push({ key, label: label.slice(0, 120), due_date: d, notes: a.notes ? String(a.notes).slice(0, 500) : undefined, owner_label: a.owner_label ? String(a.owner_label).slice(0, 80) : undefined, custom: true });
    (batch.milestones as any).sort((x: any, y: any) => new Date(x.due_date).getTime() - new Date(y.due_date).getTime());
    batch.markModified("milestones");
    await batch.save();
    await audit({ entity: "Batch", entityId: batch._id, field: `milestone:${key}`, newValue: `added "${label}"`, actor: user.id });
    return NextResponse.json({ item: batch }, { status: 201 });
  }
  if (body.remove) {
    const key = String(body.remove);
    const idx = (batch.milestones ?? []).findIndex((x: any) => x.key === key);
    if (idx < 0) throw new HttpError(404, "Milestone not found");
    const removed = (batch.milestones as any)[idx];
    (batch.milestones as any).splice(idx, 1);
    batch.markModified("milestones");
    await batch.save();
    await audit({ entity: "Batch", entityId: batch._id, field: `milestone:${key}`, newValue: `removed "${removed?.label ?? key}"`, actor: user.id });
    return NextResponse.json({ item: batch });
  }

  const key = String(body.key ?? "");
  const m = (batch.milestones ?? []).find((x: any) => x.key === key);
  if (!m) throw new HttpError(404, "Milestone not found");
  if (body.done) {
    (m as any).done_on = new Date();
    (m as any).done_by = user.id;
    (m as any).done_via = "user";
  } else {
    (m as any).done_on = undefined;
    (m as any).done_by = undefined;
    (m as any).done_via = undefined;
  }
  batch.markModified("milestones");
  await batch.save();
  await audit({ entity: "Batch", entityId: batch._id, field: `milestone:${key}`, newValue: body.done ? "done" : "reopened", actor: user.id });
  return NextResponse.json({ item: batch });
});
