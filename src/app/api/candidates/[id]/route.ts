import { itemRoutes } from "@/lib/crud";
import { Candidate } from "@/models";

export const { GET, PATCH } = itemRoutes({
  model: Candidate, entity: "Candidate",
  fields: ["name", "phone", "alt_phone", "gender", "location", "program", "source"],
  writeRoles: ["Admin", "Operations", "Location", "Enrollment"],
  populate: [
    { path: "location", select: "name code" },
    { path: "program", select: "name code" },
  ],
});
