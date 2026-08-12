import { itemRoutes } from "@/lib/crud";
import { Program } from "@/models";

export const { GET, PATCH } = itemRoutes({
  model: Program, entity: "Program", scopeField: null,
  fields: ["code", "name", "duration_days", "buffer_days", "default_batch_size", "requires_lab", "trainer_skill", "completion_deadline_days", "operating_days", "active", "scheme", "qp_code", "nsqf_level", "sector", "scheme_priority"],
  writeRoles: ["Admin"],
});
