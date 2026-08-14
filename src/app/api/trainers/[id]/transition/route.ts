import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { transitionTrainer } from "@/lib/rules";
import { audit } from "@/lib/audit";

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
