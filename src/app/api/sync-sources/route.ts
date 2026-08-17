import { collectionRoutes } from "@/lib/crud";
import { SyncSource } from "@/models";
import { assertSyncSourceAllowed } from "@/lib/sync";

export const { GET, POST } = collectionRoutes({
  model: SyncSource, entity: "SyncSource", scopeField: null,
  fields: ["name", "source_url", "sync_time", "frequency", "field_mappings", "mode", "interval_minutes", "key_columns", "active"],
  writeRoles: ["Admin"],
  permission: "sheet.sources", // 2026-08-11 togglable right (writeRoles = fallback only)
  readPermission: "sheet.sources", // read follows the same togglable right as write (Rule 40 baseline)
  // -100 (Umesh, 17/08): the single-truth policy is a gate now, not a runbook paragraph —
  // only the client's OneDrive workbook may be registered, and never twice in the same mode.
  beforeCreate: async (body) => { await assertSyncSourceAllowed(body, null); },
});
