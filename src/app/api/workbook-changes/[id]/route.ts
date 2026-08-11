import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { WorkbookChange, WORKBOOK_CHANGE_STATUS } from "@/models";
import { audit } from "@/lib/audit";

// PATCH { status: "Seen" | "Accepted" } — review state only. Accepting a workbook change
// never writes to ERP entities; the mapped sync and manual edits stay the only write paths.
// 2026-08-11 (CEO): reviewing is the Admin-assignable "sheet.approve" right.
export const PATCH = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "sheet.approve");
  requireEdit(user);
  const { id } = await ctx.params;
  const body = await req.json();
  const status = String(body.status ?? "");
  if (!WORKBOOK_CHANGE_STATUS.includes(status as any) || status === "New") {
    throw new HttpError(400, "status must be Seen or Accepted");
  }
  const change = await WorkbookChange.findById(id);
  if (!change) throw new HttpError(404, "Change not found");
  const old = change.status;
  change.status = status as any;
  change.actor = user.id as any;
  change.actioned_at = new Date();
  await change.save();
  await audit({ entity: "WorkbookChange", entityId: change._id, field: "status", oldValue: old, newValue: status, actor: user.id });
  return NextResponse.json({ ok: true });
});
