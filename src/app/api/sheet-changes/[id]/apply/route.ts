import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/db";
import { apiHandler, requireUser, requireEdit, HttpError } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { applySheetChange, isSecretSheetField, maskSheetChange } from "@/lib/sync";
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
      // QA-1331(c): `action` comes straight from the request body with nothing checking it is
      // semantically valid for THIS row's field — so a client can reach this branch on a
      // tc_password-field row (a Close/Stop location action makes no sense for a password field,
      // but nothing here refuses it). The summary used to embed change.new_value raw, and
      // requireApproval writes it verbatim into the ApprovalRequest doc, a notification, an email
      // subject+body, and its own audit() call — four plaintext copies from one unmasked template
      // literal. Masked at the source with the same predicate maskSheetChange uses, so every
      // downstream copy is safe without a second fix.
      summary: `${action} — ${loc?.name ?? "unmatched location"} (from the Sync Inbox: ${change.field_name} → ${isSecretSheetField(change.field_name) ? (change.new_value ? "(set)" : "") : (change.new_value ?? "")})`,
      payload: { changeId: id, action, note },
      location: change.location,
    });
    if (parked) return NextResponse.json(parked, { status: 202 });
  }

  const result = await applySheetChange(id, action, note, user.id);
  // QA-1316/QA-1331(a): this used to hand back `result.change` raw — old_value, new_value AND
  // impact_snapshot.{apply,revert} — to anyone holding sheet.approve, a PERMISSION and not a role.
  // Masked with the same helper and the same hardcoded `false` the revert door already uses two
  // files over: this door is gated on sheet.approve alone, deliberately, because applying is an
  // operational act a non-Admin reviewer is meant to perform — what must not follow from that
  // right is READING the credential. An Admin who wants the plaintext still reads it from the LIST
  // door, which computes canSeeSecrets from the caller's role.
  return NextResponse.json({ ...result, change: maskSheetChange(result.change.toObject(), false) });
});
