import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit } from "@/lib/authz";
import { assertMemberInScope, updateEnrollment } from "@/lib/rules";
import { audit } from "@/lib/audit";

// PATCH enrollment worklist update (Rules 22–24).
// Body: { reg_done?, kyc_done?, accept_done?, failed?, issue?, issue_note?, source? }
export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  const { id } = await ctx.params;
  await assertMemberInScope(user, id); // Rule 38
  const body = await req.json();
  // Session users are always USER in the audit trail; the future Selenium bot gets its own
  // service credential and its own actor_type — never client-declared.
  delete body.source;
  const m = await updateEnrollment(id, body);
  await audit({
    entity: "BatchMember", entityId: m._id, field: "enrollment",
    newValue: { status: m.enrollment_status, reg: m.reg_done, kyc: m.kyc_done, accept: m.accept_done, issue: m.issue },
    actor: user.id,
    actorType: "USER",
  });
  return NextResponse.json({ item: m });
});
