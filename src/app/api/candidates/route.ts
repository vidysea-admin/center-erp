import { collectionRoutes } from "@/lib/crud";
import { Candidate } from "@/models";
import { assertLocationInScope } from "@/lib/authz";
import { candidateEligibility } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";

export const { GET, POST } = collectionRoutes({
  model: Candidate, entity: "Candidate",
  fields: ["name", "phone", "alt_phone", "gender", "dob", "id_reference", "location", "program", "source", "lifecycle_status", "education", "last_training_date", "interested_programs", "interested_locations", "sidh_status", "sidh_link_sent_at", "sidh_registered_on", "sidh_candidate_id"],
  searchFields: ["name", "phone"],
  writeRoles: ["Admin", "Operations", "Location", "Enrollment"],
  permission: "candidates.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  populate: [
    { path: "location", select: "name code" },
    { path: "program", select: "name code" },
  ],
  // Rule 38: creating a record at someone else's location was previously unchecked.
  beforeCreate(data, user) {
    if (data.location) assertLocationInScope(user, String(data.location));
  },
  // 2026-08-11: eligibility (age / education / training cooldown) computed on read,
  // never stored — it flips on its own as the cooldown lapses.
  async mapItems(items) {
    const defaults = await getDefaults();
    return items.map((c) => ({ ...c, eligibility: candidateEligibility(c, defaults) }));
  },
});
