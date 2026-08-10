import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, HttpError } from "@/lib/authz";
import { FollowUpAction } from "@/models";
import { settleChangeIfDone } from "@/lib/sync";
import { audit } from "@/lib/audit";

// POST { status: "Done" | "Skipped" } — resolve a follow-up; settles parent change (Rule 7)
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, "Admin", "Operations"); // Rule 40 — resolving follow-ups is Admin/Ops only
  const { id } = await ctx.params;
  const { status } = await req.json();
  if (!["Done", "Skipped"].includes(status)) throw new HttpError(400, "status must be Done or Skipped");
  const fup = await FollowUpAction.findById(id);
  if (!fup) throw new HttpError(404, "Follow-up not found");
  if (fup.status !== "Pending") throw new HttpError(409, "Already resolved");
  fup.status = status;
  fup.completed_by = user.id as any;
  fup.completed_at = new Date();
  await fup.save();
  await audit({ entity: "FollowUpAction", entityId: fup._id, field: "status", newValue: status, actor: user.id });
  await settleChangeIfDone(fup.source_change); // Rule 7
  return NextResponse.json({ item: fup });
});
