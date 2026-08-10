import { itemRoutes } from "@/lib/crud";
import { TrainerRequest } from "@/models";

export const { GET, PATCH } = itemRoutes({
  model: TrainerRequest, entity: "TrainerRequest",
  fields: ["required_by_date", "status", "hiring_target_date", "tot_scheduled_on", "tot_done_on", "expected_available_from", "fulfilled_by_trainer", "note"],
  writeRoles: ["Admin", "Operations"],
  populate: [
    { path: "location", select: "name code" },
    { path: "program", select: "name code" },
    { path: "fulfilled_by_trainer", select: "name" },
  ],
});
