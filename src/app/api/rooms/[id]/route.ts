import { itemRoutes } from "@/lib/crud";
import { Room } from "@/models";

export const { GET, PATCH } = itemRoutes({
  model: Room, entity: "Room",
  fields: ["name", "type", "capacity", "active"],
  writeRoles: ["Admin", "Operations", "Location"], // fallback only
  // 2026-08-12 audit (auth S3-6): rooms carried no `permission`, so revoking locations.manage
  // from a role still left it able to create and edit rooms — a silent hole in the
  // "toggle it off and it is off" model the 2026-08-11 permission matrix promises.
  permission: "locations.manage",
});
