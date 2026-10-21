import { ADMIN_OPS } from "@/lib/roles";
import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireRole, isScoped, HttpError, readJson } from "@/lib/authz";
import { FollowUpAction, SheetChange } from "@/models";
import { settleChangeIfDone, followUpVisibleTo } from "@/lib/sync";
import { audit } from "@/lib/audit";

// POST { status: "Done" | "Skipped" } — resolve a follow-up; settles parent change (Rule 7)
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireRole(user, ...ADMIN_OPS); // Rule 40 — resolving follow-ups is Admin/Ops only
  const { id } = await ctx.params;
  const { status } = await readJson(req);
  if (!["Done", "Skipped"].includes(status)) throw new HttpError(400, "status must be Done or Skipped");
  const fup = await FollowUpAction.findById(id);
  if (!fup) throw new HttpError(404, "Follow-up not found");
  if (isScoped(user)) {
    // Center Manager: only follow-ups at their own centres; refuse BEFORE any write.
    const sc = await SheetChange.findById(fup.source_change).select("location").lean<any>();
    if (!followUpVisibleTo(user, { source_change: sc })) throw new HttpError(403, "Location out of scope");
  }
  if (fup.status !== "Pending") throw new HttpError(409, "Already resolved");
  fup.status = status;
  fup.completed_by = user.id as any;
  fup.completed_at = new Date();
  await fup.save();
  await audit({ entity: "FollowUpAction", entityId: fup._id, field: "status", newValue: status, actor: user.id });
  await settleChangeIfDone(fup.source_change); // Rule 7
  return NextResponse.json({ item: fup });
});
