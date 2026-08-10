import { itemRoutes } from "@/lib/crud";
import { Room } from "@/models";

export const { GET, PATCH } = itemRoutes({
  model: Room, entity: "Room",
  fields: ["name", "type", "capacity", "active"],
  writeRoles: ["Admin", "Operations", "Location"],
});
