import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { assertResultInScope, startReassessment } from "@/lib/rules";
import { audit } from "@/lib/audit";

// Rule 44: archive the current attempt and reopen the result for a retake.
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "closure.manage"); // togglable (2026-08-11)
  const { id } = await ctx.params;
  await assertResultInScope(user, id); // Rule 38
  const { reassessment_date } = await req.json();
  if (!reassessment_date) throw new HttpError(400, "Rule 44: a reassessment date is required.");
  const row = await startReassessment(id, new Date(reassessment_date), user.id);
  await audit({ entity: "CandidateResult", entityId: id, field: "reassessment", newValue: { attempt: row.attempt, reassessment_date }, actor: user.id });
  return NextResponse.json({ item: row });
});
