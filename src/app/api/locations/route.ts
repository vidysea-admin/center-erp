import { collectionRoutes } from "@/lib/crud";
import { Location } from "@/models";
import { hasPermission } from "@/lib/permissions";

// 2026-08-12: tc_password is a LIVE government portal credential — "us location ke TC ID aur
// password se login karunga". The Sheet Watch column carrying it is already masked for non-Admins
// (src/app/api/workbook-changes/route.ts); storing the same secret on Location without the same
// masking would have re-opened the hole through a different door, since every signed-in user can
// read the centres they are scoped to. Only a holder of locations.manage sees it.
const SECRET_FIELDS = ["tc_password"];
export function maskLocationSecrets(items: any[], canManage: boolean) {
  if (canManage) return items;
  return items.map((l) => {
    const safe = { ...l };
    for (const f of SECRET_FIELDS) delete safe[f];
    return safe;
  });
}

export const { GET, POST } = collectionRoutes({
  model: Location, entity: "Location", scopeField: "_id",
  fields: ["code", "external_id", "name", "city", "state", "address", "approval_status", "operational_status", "status_reason", "status_changed_on", "spoc_name", "spoc_phone", "spoc_user", "principal_name", "principal_phone", "principal_user", "contacts", "district", "tc_id", "tc_password", "tc_status", "operating_partner", "cluster_head_name", "cluster_head_phone"],
  searchFields: ["code", "name", "city", "external_id", "tc_id", "district"],
  writeRoles: ["Admin", "Operations"],
  permission: "locations.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  async mapItems(items, user) {
    return maskLocationSecrets(items, await hasPermission(user, "locations.manage"));
  },
});
