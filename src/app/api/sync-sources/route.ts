import { collectionRoutes } from "@/lib/crud";
import { SyncSource } from "@/models";

export const { GET, POST } = collectionRoutes({
  model: SyncSource, entity: "SyncSource", scopeField: null,
  fields: ["name", "source_url", "sync_time", "frequency", "field_mappings"],
  writeRoles: ["Admin"], readRoles: ["Admin", "Operations"], // Rule 40
});
