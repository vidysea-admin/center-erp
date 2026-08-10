import { itemRoutes } from "@/lib/crud";
import { SyncSource } from "@/models";

export const { GET, PATCH } = itemRoutes({
  model: SyncSource, entity: "SyncSource", scopeField: null,
  fields: ["name", "source_url", "sync_time", "frequency", "field_mappings"],
  writeRoles: ["Admin"], readRoles: ["Admin", "Operations"],
});
