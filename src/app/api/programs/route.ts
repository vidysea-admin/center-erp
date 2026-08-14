import { collectionRoutes } from "@/lib/crud";
import { Program } from "@/models";

// R-H (CEO 14/08 [03:02-03:14]): the job-role/scheme master is Admin-editable "from the
// backend along with basic data such as number of hours of training", and the amount we
// receive is VISIBLE ONLY TO ADMIN — masked here for everyone else, the same pattern as
// tc_password on locations.
export function maskProgramMoney(items: any[], isAdmin: boolean) {
  if (isAdmin) return items;
  return items.map(({ contract_amount: _hidden, ...rest }) => rest);
}

const cfg = {
  model: Program, entity: "Program", scopeField: null,
  fields: ["code", "name", "duration_days", "buffer_days", "default_batch_size", "requires_lab", "trainer_skill", "completion_deadline_days", "operating_days", "active", "scheme", "qp_code", "nsqf_level", "sector", "scheme_priority", "mandatory_trainer_docs", "hours", "contract_amount"],
  searchFields: ["code", "name"],
  writeRoles: ["Admin"] as ("Admin")[],
  async mapItems(items: any[], user: any) {
    return maskProgramMoney(items, user?.role === "Admin");
  },
};

export const { GET, POST } = collectionRoutes(cfg);
