import { itemRoutes } from "@/lib/crud";
import { Candidate } from "@/models";
import { candidateEligibility } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";

export const { GET, PATCH } = itemRoutes({
  model: Candidate, entity: "Candidate",
  fields: ["name", "phone", "alt_phone", "gender", "dob", "id_reference", "location", "program", "source", "education", "last_training_date", "interested_programs", "interested_locations", "sidh_status", "sidh_link_sent_at", "sidh_registered_on", "sidh_candidate_id", "sidh_failure_reason", "fee_amount", "fee_paid_on", "fee_reference"],
  writeRoles: ["Admin", "Operations", "Location", "Enrollment"],
  permission: "candidates.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  populate: [
    { path: "location", select: "name code" },
    { path: "program", select: "name code" },
  ],
  async mapItems(items) {
    const defaults = await getDefaults();
    return items.map((c) => ({ ...c, eligibility: candidateEligibility(c, defaults) }));
  },
});
