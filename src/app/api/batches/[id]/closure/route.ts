import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit } from "@/lib/authz";
import { Closure, Invoice } from "@/models";
import { assertBatchInScope, upsertClosureChecked } from "@/lib/rules";
import { audit } from "@/lib/audit";

export const GET = apiHandler(async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const [closure, invoice] = await Promise.all([
    Closure.findOne({ batch: id }).lean(),
    Invoice.findOne({ batch: id }).lean(),
  ]);
  return NextResponse.json({ closure, invoice });
});

// PUT closure fields (Rules 34–35)
export const PUT = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  const { id } = await ctx.params;
  await assertBatchInScope(user, id); // Rule 38
  const body = await req.json();
  const patch: Record<string, unknown> = {};
  for (const f of ["assessment_status", "assessment_date", "appeared", "passed", "result_file", "certification_status", "certification_date", "certificates_issued", "certificate_file", "ready_for_invoice"]) {
    if (body[f] !== undefined) patch[f] = body[f];
  }
  const closure = await upsertClosureChecked(id, patch, user.id);
  await audit({ entity: "Closure", entityId: closure._id, field: "closure", newValue: patch, actor: user.id });
  return NextResponse.json({ item: closure });
});
