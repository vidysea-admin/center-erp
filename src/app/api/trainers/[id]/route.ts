import { itemRoutes } from "@/lib/crud";
import { Trainer } from "@/models";

export const { GET, PATCH } = itemRoutes({
  model: Trainer, entity: "Trainer", scopeField: null,
  fields: ["name", "phone", "email", "skills", "home_location", "status", "available_from", "day_rate", "incentive_note", "max_concurrent_batches", "active"],
  writeRoles: ["Admin", "Operations"],
  populate: [{ path: "home_location", select: "name code" }],
});
