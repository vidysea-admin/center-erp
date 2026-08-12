import { itemRoutes } from "@/lib/crud";
import { Location } from "@/models";
import { HttpError } from "@/lib/authz";
import { requireApproval } from "@/lib/approvals";

export const { GET, PATCH } = itemRoutes({
  model: Location, entity: "Location", scopeField: "_id",
  fields: ["code", "external_id", "name", "city", "state", "address", "approval_status", "operational_status", "status_reason", "status_changed_on", "spoc_name", "spoc_phone", "spoc_user", "principal_name", "principal_phone", "principal_user", "contacts", "district", "tc_id", "tc_password", "tc_status", "operating_partner", "cluster_head_name", "cluster_head_phone"],
  writeRoles: ["Admin", "Operations", "Location"],
  permission: "locations.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  async beforeUpdate(id, data, existing, user) {
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
