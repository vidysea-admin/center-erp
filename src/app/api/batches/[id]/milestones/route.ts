import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { Batch, Trainer } from "@/models";
import { PLAN_CREATE_STATUSES, assertBatchInScope, dayKey, istToday, mergePlan, planBatchBackward } from "@/lib/rules";
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
    // QA-607 (Umesh, 2026-08-27): plan CREATION also reaches a running batch. The feature shipped
    // usable only on Planning batches and every batch that exists is Active — plan sharing was
    // correct code nobody could open. Creation only; REGENERATION stays Planning-only, because
    // regenerating recomputes every due date from planned_start and a running batch's plan is a
    // record of what already happened, not a schedule to be recut. "Ready" is deliberately NOT in
    // this list: `alerts.ts:165` raises milestone_overdue for Planning/Ready only, so a plan minted
    // on a Ready batch whose dates have passed would raise a wall of alerts the moment it exists —
    // which is exactly the risk that got the QA-607 backfill option declined. Active is outside
    // that query, so a backward plan on a running batch raises nothing. See the manifest.
    if (body.regenerate && batch.status !== "Planning") throw new HttpError(409, "Plan can only be regenerated while the batch is in Planning.");
    if (body.create && !PLAN_CREATE_STATUSES.includes(batch.status)) throw new HttpError(409, "A backward plan is made while the batch is in Planning, or while it is running.");
    const creating = !batch.plan_enabled;
    batch.plan_enabled = true;
    // QA-460 (-164): the batch's own trainer decides whether TOT rows belong in this plan. Read
    // here rather than inside the planner so the planner stays a pure function.
    const planTrainer = batch.trainer
      ? await Trainer.findById(batch.trainer).select("pipeline_status tot_done_on").lean<any>()
      : null;
    // QA-504: mergePlan, not .map() - a regenerated plan may move dates, never erase a tick, a
    // note, an owner or a hand-added row. The skip makes omission normal, so this is load-bearing.
    batch.milestones = mergePlan(
      batch.milestones ?? [],
      planBatchBackward(batch.planned_start, await getDefaults(), { trainer: planTrainer }),
    ) as any;
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
    // -196 (Umesh, 2026-08-22): "jaise dates aate rahengi woh usi values mein fill hote rahengi".
    // A tick meant "done, now" — but the Planning grid is filled from a sheet days after the fact,
    // so the date the operator types IS the fact and stamping today's date would overwrite it with
    // a wrong one. An explicit done_on is honoured; a bare tick still means now.
    // `undefined` means "no date given, so now". An empty STRING is a cleared input the caller
    // sent by accident, and -197 let it fall through to now (QA-650) - it is refused instead.
    // QA-660 (-200): -198 refused the empty STRING and left `0` and `null` falling through to now,
    // because the guard tested one shape and the next line tested truthiness. One rule: `undefined`
    // (or absent) means "no date given, so today". Anything else present must be a real date.
    if (body.done_on !== undefined && (typeof body.done_on !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(body.done_on.trim()))) {
      // My first attempt at this listed the shapes to REFUSE - null, "", boolean - and `0` walked
      // straight through it into `new Date(0)`, which is a perfectly valid 1 Jan 1970 and stored as
      // a fact. Listing what is allowed is the only version of this that cannot be outgrown: a
      // date here is a non-empty STRING, and absence is the one way to mean "today".
      //
      // QA-683 (-203, checker on qa-198): an allow-list on EMPTINESS is still not an allow-list on
      // being a date. The string "0" is non-empty, and new Date("0") is 1 Jan 2000 - a real date,
      // comfortably in the past, waved through by the future check below and stored as a fact just
      // like 1970 was. The shape is the allow-list; nothing weaker survives contact.
      throw new HttpError(400, "done_on must be a date like 2026-08-22. Leave it out to record today.");
    }
    const on = body.done_on === undefined ? new Date() : new Date(body.done_on);
    if (isNaN(on.getTime())) throw new HttpError(400, "done_on is not a valid date.");
    // QA-644: -196 validated only that the string parsed. done_on means "this happened", and every
    // other happened-date in this codebase refuses the future - Rule 25 on left_on, Rule 53 on
    // attendance, the daily log, actual_start. It is load-bearing twice over: `overdue` is computed
    // as `!done_on && due_date < today`, so a milestone ticked into the future stops being overdue,
    // and the planning grid prints done_on ?? due_date, so it would read as a fact.
    //
    // QA-650 (-198): -197 cited those rules and then did not follow them - it compared raw
    // milliseconds with 24h of slack, so TOMORROW'S DATE was accepted as already done while the
    // message said "cannot be a future date". Every one of the rules it cites compares CALENDAR
    // dates on the IST footing (QA-081: dayKey vs istToday), and so does this now. An empty string
    // is also no longer treated as "no date given" further up - see the parse above.
    if (dayKey(on).getTime() > istToday().getTime()) {
      throw new HttpError(400, "done_on cannot be a future date — it records something that has already happened. To record a target instead, edit the milestone's due date.");
    }
    (m as any).done_on = on;
    (m as any).done_by = user.id;
    (m as any).done_via = "user";
  } else {
    (m as any).done_on = undefined;
    (m as any).done_by = undefined;
    (m as any).done_via = undefined;
  }
  batch.markModified("milestones");
  await batch.save();
  await audit({ entity: "Batch", entityId: batch._id, field: `milestone:${key}`, newValue: body.done ? `done ${new Date((m as any).done_on).toISOString().slice(0, 10)}` : "reopened", actor: user.id });
  return NextResponse.json({ item: batch });
});
