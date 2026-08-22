import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { CORRECTABLE_TRAINER_DATES, assertTrainerInScope, correctTrainerDates, transitionTrainer } from "@/lib/rules";
import { audit, auditDiff } from "@/lib/audit";

// POST { target, reason?, remarks?, date?, payload? } — move a trainer along the hiring pipeline
// (2026-08-12, Manish's RPL walkthrough). The guards live in transitionTrainer; this route is the
// gate and the audit trail. A nomination, an NSDC verdict and a TR ID are all reportable facts,
// so every move is written to the audit log with who did it.
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "trainers.manage");
  const { id } = await ctx.params;
  await assertTrainerInScope(user, id); // QA-125: moving a foreign trainer's pipeline is a foreign write
  const { target, reason, remarks, date, payload, bypass } = await req.json();

  // Rule T8 (Umesh 15/08): bypass = its own grantable right, confirmed in the UI, and the
  // audit row names it in as many words.
  if (bypass) await requirePerm(user, "pipeline.bypass");

  const before = target;
  // actor: TOT Payment Done books the ₹3250 eligibility fee as a CostEntry, entered by this user.
  const t = await transitionTrainer(id, target, { reason, remarks, date, payload, actor: user.id, bypass: !!bypass, actorName: user.name });

  await audit({
    entity: "Trainer",
    entityId: t._id,
    field: bypass ? "pipeline_bypass" : "pipeline_status",
    newValue: bypass ? `BYPASS → ${before}` : before,
    oldValue: undefined,
    actor: user.id,
  });

  return NextResponse.json({ item: t });
});

// PATCH { nomination_sent_on?, nsdc_submitted_on?, nsdc_result_on?, paid_on?, tot_scheduled_on?,
// tot_done_on? } — correct the dates PAST transitions stamped. Same door as POST on purpose:
// POST moves the trainer along the pipeline, PATCH fixes what a move wrote down. Putting these six
// on the plain PATCH /api/trainers/:id allow-list instead would have been the real bypass — that
// list is what stops a hand-made request setting pipeline_status, and qa-196's ratified invariant
// rests on these six being absent from it. Here the sentence "these fields are written only through
// the pipeline door" stays true, and now covers correcting them too.
//
// Umesh, 2026-08-22: "agar koi wrong value set ho gayi toh baad me edit nahi kar pa raha hai - edit
// ka button bhi de bhai." Same right as moving a stage (trainers.manage: Admin, Operations and the
// centre), same scope check, and every field lands in the Activity tab with the name of whoever
// typed it - which a stage move does not manage, since it audits only pipeline_status.
export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "trainers.manage");
  const { id } = await ctx.params;
  await assertTrainerInScope(user, id); // QA-125: correcting a foreign trainer is a foreign write
  const body = await req.json();

  // The ₹3250 entry in Costs carries its own date. Moving it is a cost write, so it happens only
  // for someone who already holds that right; for everyone else the mismatch is reported instead of
  // being made silently. requirePerm is reused rather than re-deriving the level, because a
  // second copy of "what counts as edit" is how two doors end up disagreeing.
  let canMoveCost = false;
  try { await requirePerm(user, "costs.manage"); canMoveCost = true; } catch { canMoveCost = false; }

  const { item, before, warnings } = await correctTrainerDates(id, body, { canMoveCost });

  // auditDiff, not audit(): one row per changed field, which is what the Activity tab already
  // renders as "field: old → new". The POST above writes oldValue: undefined, so a correction
  // actually leaves a better trail than the transition it is correcting.
  const after: Record<string, unknown> = {};
  for (const f of CORRECTABLE_TRAINER_DATES) if (f in before) after[f] = (item as any)[f] ?? null;
  await auditDiff("Trainer", item._id, before, after, user.id);

  return NextResponse.json({ item, ...(warnings.length ? { warnings } : {}) });
});
