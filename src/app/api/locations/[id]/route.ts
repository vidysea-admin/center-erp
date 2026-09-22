import { NextRequest, NextResponse } from "next/server";
import { itemRoutes } from "@/lib/crud";
import { dbConnect } from "@/lib/db";
import { Location } from "@/models";
import { apiHandler, requireUser, requireEdit, HttpError, readJson } from "@/lib/authz";
import { requirePerm } from "@/lib/permissions";
import { requireApproval } from "@/lib/approvals";
import { locationUsage } from "@/lib/rules";
import { audit } from "@/lib/audit";
import { maskLocationSecrets } from "../route";

export const { GET, PATCH } = itemRoutes({
  model: Location, entity: "Location", scopeField: "_id",
  // Same masking as the list route — tc_password is a live portal credential, and opening one
  // centre by id must not reveal what the list deliberately hides. QA-088: Admin-only.
  async mapItems(items, user) {
    return maskLocationSecrets(items, user.role === "Admin");
  },
  fields: ["code", "external_id", "institution_id", "name", "city", "state", "address", "approval_status", "operational_status", "status_reason", "status_changed_on", "spoc_name", "spoc_phone", "spoc_user", "principal_name", "principal_phone", "principal_user", "contacts", "district", "tc_id", "tc_password", "tc_status", "mobile_otp", "aebas_link", "aebas_id", "aebas_password", "operating_partner", "cluster_head_name", "cluster_head_phone", "active"],
  readRoles: ["Admin", "Operations", "Location", "Enrollment"], // QA-095: not the Trainer's door
  writeRoles: ["Admin", "Operations", "Location"],
  permission: "locations.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  async beforeUpdate(id, data, existing, user) {
    // QA-621 cycle 4 / QA-1502 cycle 6: this route used to bump the slot generation counters here
    // itself. It no longer does, and not because the bump stopped mattering — because a checker
    // found two OTHER shipped routes that write `spoc_name` and never bumped (the Sync Inbox's
    // "Apply value" and the sheet-change revert door), which is the fifth time this S1 has been
    // caused by a write path that did not know it had a duty. The bump is structural now:
    // `LocationSchema.pre("save")` in models/index.ts fires for crud.ts's `existing.save()` below
    // exactly as it does for those two, and for whatever route is written next.
    // R-F (CEO 14/08 [36:44-37:28]): a SPOC/principal may help with centre details — "other
    // than whatever eight, ten fields you want to fix" — and their change applies only once
    // the Admin approves it. The fixed ten are the centre's identity and the master-sheet
    // truth; everything else parks as a location.edit request (direct while the rule is off).
    if (user.role === "Location") {
      // QA-089: district and operating_partner ride the AVPL rebase too — everything the
      // master sheet writes is fixed the same way, or the next rebase silently undoes an
      // approved SPOC edit.
      const FIXED = ["code", "external_id", "name", "city", "state", "district", "operating_partner", "tc_id", "tc_password", "tc_status", "mobile_otp", "aebas_link", "aebas_id", "aebas_password", "approval_status", "operational_status"];
      const touched = FIXED.filter((f) => data[f] !== undefined && String(data[f]) !== String((existing as any)[f] ?? ""));
      if (touched.length) {
        throw new HttpError(403, `Fixed by the Admin/master sheet — a centre login cannot change: ${touched.join(", ")}.`);
      }
      for (const f of FIXED) delete data[f]; // unchanged copies of fixed fields are just noise
      const changed = Object.keys(data);
      if (changed.length) {
        const gate = await requireApproval("location.edit", user, {
          entity: "Location", entity_id: id, location: id,
          summary: `${existing.name}: ${user.name} suggests changing ${changed.join(", ")}`,
          payload: { patch: data },
        });
        if (gate) throw new HttpError(202, `Sent for approval: ${gate.request.summary}`);
      }
    }
    // Operational status change requires a reason (screen action: "change operational_status with reason")
    if (data.operational_status && data.operational_status !== existing.operational_status) {
      if (!data.status_reason) throw new HttpError(400, "Operational status change requires a reason.");
      data.status_changed_on = new Date();

      // RPL M24: stopping or closing a centre is the archetypal two-person action, so it is
      // gateable. Nothing changes until an Admin enables it.
      if (["Closed", "Stopped"].includes(String(data.operational_status))) {
        const gate = await requireApproval(
          data.operational_status === "Closed" ? "location.close" : "location.stop",
          user,
          {
            entity: "Location", entity_id: id, location: id,
            summary: `${data.operational_status === "Closed" ? "Close" : "Stop"} ${existing.name} — ${data.status_reason}`,
            payload: { reason: data.status_reason },
          },
        );
        if (gate) throw new HttpError(202, `Sent for approval: ${gate.request.summary}`);
      }
    }
  },
});

// qa-location-delete-warn-impact (Umesh, 2026-09-22, qa/gates/location-delete-behaviour.md):
// itemRoutes() (src/lib/crud.ts) only ever exports {GET, PATCH}, so a Location had NO delete path at
// all — this is the standalone export, matching the programs/[id]/route.ts DELETE pattern (its own
// Option-B precedent). Behaviour = Option B: the delete is ALLOWED unconditionally (programme-style,
// "Admin ki marzi") and is NEVER refused for carried work — but it is never silent either. Gated on
// the OWN togglable right `locations.delete` (separate from locations.manage, ARCHITECTURE §3.2b),
// and the response + audit record the full impact (`carried` counts + the named batch list), the
// same structured snapshot the batch force-delete writes. The UI's before-the-click impact preview
// is served by the companion GET /api/locations/[id]/usage; this door records what actually went.
export const DELETE = apiHandler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
  await dbConnect();
  const user = await requireUser();
  requireEdit(user);
  await requirePerm(user, "locations.delete");
  const { id } = await ctx.params;
  const location = await Location.findById(id).select("code name").lean<any>();
  if (!location) throw new HttpError(404, "Location not found");
  // A reason is recorded on the decision, same as every other destructive verb in this codebase.
  // Kept OPTIONAL, not a 400: the delete is never refused, and an existing caller with no body still
  // succeeds — the UI Drawer is what makes a reason required for a human pressing the button.
  let reason = "";
  try { const body = await readJson(req); reason = String(body?.reason ?? "").trim().slice(0, 500); } catch { /* no body */ }
  // The impact is computed BEFORE the delete, so the counts describe what this call orphaned/wiped
  // rather than what happens to be there after. Read-only; it decides nothing here (Option B).
  const usage = await locationUsage(id);
  await Location.deleteOne({ _id: id });
  const summary = `${location.code} (${location.name}) deleted`
    + (usage.total > 0 ? ` — ${usage.total} referencing record(s) orphaned` : " — nothing referenced it")
    + (reason ? ` — reason: ${reason}` : "");
  // Structured snapshot, same shape as batches/[id]/route.ts's force-delete audit value: nothing
  // else on disk remembers what pointed at this centre once it is gone.
  await audit({
    entity: "Location", entityId: id, field: "delete",
    newValue: { summary, snapshot: { code: location.code, name: location.name, carried: usage.counts, batch_list: usage.batch_list } },
    actor: user.id,
  });
  return NextResponse.json({ deleted: location.code, carried: usage.counts, batch_list: usage.batch_list, total: usage.total });
});
