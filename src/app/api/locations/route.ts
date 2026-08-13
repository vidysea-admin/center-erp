import { collectionRoutes } from "@/lib/crud";
import { Location, LocationTarget } from "@/models";
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
  // 2026-08-13 (Manish: "Ongoing scheme bhi saath mein dikhana MUST hai — warna pata hi nahi
  // chalega"): each centre carries its job roles WITH their scheme, plus the per-row TC verdict
  // that decides the "31 approved". One extra query per page, same shape as candidates' batch join.
  async mapItems(items, user) {
    const masked = maskLocationSecrets(items, await hasPermission(user, "locations.manage"));
    const targets = await LocationTarget.find({ location: { $in: items.map((l: any) => l._id) } })
      .select("location program tc_status tc_id approved_target")
      .populate("program", "name code scheme")
      .lean<any[]>();
    const byLoc = new Map<string, any[]>();
    for (const t of targets) {
      const k = String(t.location);
      byLoc.set(k, [...(byLoc.get(k) ?? []), {
        program: t.program?.name ?? null, code: t.program?.code ?? null, scheme: t.program?.scheme ?? null,
        tc_id: t.tc_id ?? null, tc_status: t.tc_status ?? null, approved_target: t.approved_target ?? null,
      }]);
    }
    return masked.map((l: any) => {
      const rows = byLoc.get(String(l._id)) ?? [];
      return {
        ...l,
        job_roles: rows,
        schemes: [...new Set(rows.map((r) => r.scheme).filter(Boolean))],
        approved_job_roles: rows.filter((r) => r.tc_status === "Approved").length,
      };
    });
  },
});
