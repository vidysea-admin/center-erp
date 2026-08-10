import { collectionRoutes } from "@/lib/crud";
import { Program } from "@/models";

const cfg = {
  model: Program, entity: "Program", scopeField: null,
  fields: ["code", "name", "duration_days", "buffer_days", "default_batch_size", "requires_lab", "trainer_skill", "completion_deadline_days", "operating_days", "active"],
  searchFields: ["code", "name"],
  writeRoles: ["Admin"] as ("Admin")[],
};

export const { GET, POST } = collectionRoutes(cfg);
