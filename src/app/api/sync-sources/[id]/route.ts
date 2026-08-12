import { itemRoutes } from "@/lib/crud";
import { SyncSource } from "@/models";

export const { GET, PATCH } = itemRoutes({
  model: SyncSource, entity: "SyncSource", scopeField: null,
  fields: ["name", "source_url", "sync_time", "frequency", "field_mappings", "mode", "interval_minutes", "key_columns"],
  writeRoles: ["Admin"],
  permission: "sheet.sources", // 2026-08-11 togglable right (writeRoles = fallback only)
  readPermission: "sheet.sources", // read follows the same togglable right as write (Rule 40 baseline)
});
