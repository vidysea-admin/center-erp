import { collectionRoutes } from "@/lib/crud";
import { Trainer } from "@/models";

export const { GET, POST } = collectionRoutes({
  model: Trainer, entity: "Trainer", scopeField: null,
  fields: ["name", "phone", "email", "skills", "home_location", "status", "available_from", "day_rate", "incentive_note", "max_concurrent_batches", "active"],
  searchFields: ["name", "phone", "email"],
  writeRoles: ["Admin", "Operations"],
  populate: [{ path: "home_location", select: "name code" }],
});
