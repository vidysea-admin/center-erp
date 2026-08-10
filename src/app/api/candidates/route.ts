import { collectionRoutes } from "@/lib/crud";
import { Candidate } from "@/models";

export const { GET, POST } = collectionRoutes({
  model: Candidate, entity: "Candidate",
  fields: ["name", "phone", "alt_phone", "gender", "location", "program", "source", "lifecycle_status"],
  searchFields: ["name", "phone"],
  writeRoles: ["Admin", "Operations", "Location", "Enrollment"],
  populate: [
    { path: "location", select: "name code" },
    { path: "program", select: "name code" },
  ],
});
