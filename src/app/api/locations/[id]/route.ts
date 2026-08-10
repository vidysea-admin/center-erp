import { itemRoutes } from "@/lib/crud";
import { Location } from "@/models";
import { HttpError } from "@/lib/authz";

export const { GET, PATCH } = itemRoutes({
  model: Location, entity: "Location", scopeField: "_id",
  fields: ["code", "external_id", "name", "city", "state", "address", "approval_status", "operational_status", "status_reason", "status_changed_on", "spoc_name", "spoc_phone", "spoc_user", "principal_name", "principal_phone", "principal_user"],
  writeRoles: ["Admin", "Operations", "Location"],
  async beforeUpdate(_id, data, existing) {
    // Operational status change requires a reason (screen action: "change operational_status with reason")
    if (data.operational_status && data.operational_status !== existing.operational_status) {
      if (!data.status_reason) throw new HttpError(400, "Operational status change requires a reason.");
      data.status_changed_on = new Date();
    }
  },
});
