import { itemRoutes } from "@/lib/crud";
import { Location } from "@/models";
import { HttpError } from "@/lib/authz";
import { requireApproval } from "@/lib/approvals";
import { maskLocationSecrets } from "../route";

export const { GET, PATCH } = itemRoutes({
  model: Location, entity: "Location", scopeField: "_id",
  // Same masking as the list route — tc_password is a live portal credential, and opening one
  // centre by id must not reveal what the list deliberately hides. QA-088: Admin-only.
  async mapItems(items, user) {
    return maskLocationSecrets(items, user.role === "Admin");
  },
  fields: ["code", "external_id", "name", "city", "state", "address", "approval_status", "operational_status", "status_reason", "status_changed_on", "spoc_name", "spoc_phone", "spoc_user", "principal_name", "principal_phone", "principal_user", "contacts", "district", "tc_id", "tc_password", "tc_status", "operating_partner", "cluster_head_name", "cluster_head_phone"],
  readRoles: ["Admin", "Operations", "Location", "Enrollment"], // QA-095: not the Trainer's door
  writeRoles: ["Admin", "Operations", "Location"],
  permission: "locations.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  async beforeUpdate(id, data, existing, user) {
    // R-F (CEO 14/08 [36:44-37:28]): a SPOC/principal may help with centre details — "other
    // than whatever eight, ten fields you want to fix" — and their change applies only once
    // the Admin approves it. The fixed ten are the centre's identity and the master-sheet
    // truth; everything else parks as a location.edit request (direct while the rule is off).
    if (user.role === "Location") {
      // QA-089: district and operating_partner ride the AVPL rebase too — everything the
      // master sheet writes is fixed the same way, or the next rebase silently undoes an
      // approved SPOC edit.
      const FIXED = ["code", "external_id", "name", "city", "state", "district", "operating_partner", "tc_id", "tc_password", "tc_status", "approval_status", "operational_status"];
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
