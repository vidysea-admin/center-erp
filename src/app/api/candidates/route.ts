import { collectionRoutes } from "@/lib/crud";
import { Candidate } from "@/models";
import { assertLocationInScope } from "@/lib/authz";

export const { GET, POST } = collectionRoutes({
  model: Candidate, entity: "Candidate",
  fields: ["name", "phone", "alt_phone", "gender", "dob", "id_reference", "location", "program", "source", "lifecycle_status"],
  searchFields: ["name", "phone"],
  writeRoles: ["Admin", "Operations", "Location", "Enrollment"],
  populate: [
    { path: "location", select: "name code" },
    { path: "program", select: "name code" },
  ],
  // Rule 38: creating a record at someone else's location was previously unchecked.
  beforeCreate(data, user) {
    if (data.location) assertLocationInScope(user, String(data.location));
  },
});
