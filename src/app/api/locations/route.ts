import { collectionRoutes } from "@/lib/crud";
import { Location } from "@/models";

export const { GET, POST } = collectionRoutes({
  model: Location, entity: "Location", scopeField: "_id",
  fields: ["code", "external_id", "name", "city", "state", "address", "approval_status", "operational_status", "status_reason", "status_changed_on", "spoc_name", "spoc_phone", "spoc_user", "principal_name", "principal_phone", "principal_user"],
  searchFields: ["code", "name", "city", "external_id"],
  writeRoles: ["Admin", "Operations"],
});
