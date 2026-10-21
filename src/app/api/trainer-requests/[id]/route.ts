import { ADMIN_OPS } from "@/lib/roles";
import { itemRoutes } from "@/lib/crud";
import { isScoped } from "@/lib/authz";
import { assertTrainerInScope } from "@/lib/rules";
import { TrainerRequest } from "@/models";

export const { GET, PATCH } = itemRoutes({
  model: TrainerRequest, entity: "TrainerRequest",
  fields: ["required_by_date", "status", "hiring_target_date", "tot_scheduled_on", "tot_done_on", "expected_available_from", "fulfilled_by_trainer", "note"],
  // QA-125 sweep (15/08): the LIST restricts readers, the item route did not — same
  // door as the list now (location scope was already enforced via the default scopeField).
  readRoles: [...ADMIN_OPS, "Location"],
  writeRoles: [...ADMIN_OPS],
  permission: "trainers.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  // Rule 38, the destination half (release -333 final review, R4): a scoped login (Center Manager) is confined to
  // its own request by the default location scope, but could point fulfilled_by_trainer at a trainer of another centre.
  async beforeUpdate(_id, body, existing, user) {
    const now = body.fulfilled_by_trainer;
    if (isScoped(user) && now && String(now) !== String((existing as any).fulfilled_by_trainer ?? "")) await assertTrainerInScope(user, String(now));
  },
  populate: [
    { path: "location", select: "name code" },
    { path: "program", select: "name code" },
    { path: "fulfilled_by_trainer", select: "name" },
  ],
});
