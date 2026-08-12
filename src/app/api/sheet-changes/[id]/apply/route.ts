import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { applySheetChange } from "@/lib/sync";
import { requireApproval } from "@/lib/approvals";
import { SheetChange, Location } from "@/models";

// POST { action, note? } — Apply & Acknowledge (Rules 4–8).
// 2026-08-11 (CEO): WHO may approve sheet changes is an Admin-assigned right, not a
// hardcoded role — gated on the togglable "sheet.approve" permission.
export const POST = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  await requirePerm(user, "sheet.approve");
  requireEdit(user); // Rule 39: can_edit=false is view-only everywhere, including granted rights
  const { id } = await ctx.params;
  const { action, note } = await req.json();

  // 2026-08-12 audit (sync S1-4): closing or stopping a centre from the Location screen goes
  // through the approval matrix, but the identical action taken from the Sync Inbox went
  // straight through. Same consequence — a centre stops operating, batches are stopped and
  // trainers released — so it answers to the same gate, whichever door it came in by.
  const APPROVAL_FOR: Record<string, "location.close" | "location.stop"> = {
    "Close location": "location.close",
    "Stop location": "location.stop",
  };
  const needs = APPROVAL_FOR[action as string];
  if (needs) {
    const change = await SheetChange.findById(id).select("location field_name new_value").lean<any>();
    if (!change) throw new HttpError(404, "Change not found");
    const loc = change.location ? await Location.findById(change.location).select("name code").lean<any>() : null;
    const parked = await requireApproval(needs, user, {
      entity: "SheetChange",
      entity_id: id,
      summary: `${action} — ${loc?.name ?? "unmatched location"} (from the Sync Inbox: ${change.field_name} → ${change.new_value ?? ""})`,
      payload: { changeId: id, action, note },
      location: change.location,
    });
    if (parked) return NextResponse.json(parked, { status: 202 });
  }

  const result = await applySheetChange(id, action, note, user.id);
  return NextResponse.json(result);
});
