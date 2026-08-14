import { itemRoutes } from "@/lib/crud";
import { TrainerRequest } from "@/models";

export const { GET, PATCH } = itemRoutes({
  model: TrainerRequest, entity: "TrainerRequest",
  fields: ["required_by_date", "status", "hiring_target_date", "tot_scheduled_on", "tot_done_on", "expected_available_from", "fulfilled_by_trainer", "note"],
  // QA-125 sweep (15/08): the LIST restricts readers, the item route did not — same
  // door as the list now (location scope was already enforced via the default scopeField).
  readRoles: ["Admin", "Operations", "Location"],
  writeRoles: ["Admin", "Operations"],
  permission: "trainers.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  populate: [
    { path: "location", select: "name code" },
    { path: "program", select: "name code" },
    { path: "fulfilled_by_trainer", select: "name" },
  ],
});
