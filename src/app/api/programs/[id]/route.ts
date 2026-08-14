import { itemRoutes } from "@/lib/crud";
import { Program } from "@/models";
import { maskProgramMoney } from "../route";

export const { GET, PATCH } = itemRoutes({
  model: Program, entity: "Program", scopeField: null,
  fields: ["code", "name", "duration_days", "buffer_days", "default_batch_size", "requires_lab", "trainer_skill", "completion_deadline_days", "operating_days", "active", "scheme", "qp_code", "nsqf_level", "sector", "scheme_priority", "mandatory_trainer_docs", "hours", "contract_amount"],
  writeRoles: ["Admin"],
  // R-H: the admin-only money field is masked for every other reader, list and item alike.
  async mapItems(items, user) {
    return maskProgramMoney(items, (user as any)?.role === "Admin");
  },
});
