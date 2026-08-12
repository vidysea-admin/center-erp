import { collectionRoutes } from "@/lib/crud";
import { Trainer } from "@/models";
import { hasPermission } from "@/lib/permissions";

// 2026-08-12, found by testing a real Trainer login: the directory is not location-scoped,
// so every signed-in user could read all 19 trainers INCLUDING day_rate, compensation and
// incentive notes. Pay is not directory data. Anyone without the trainers.manage right now
// gets the roster without the money fields.
const PAY_FIELDS = ["day_rate", "compensation_type", "compensation_fixed", "nominated_for_location", "nominated_for_program", "source", "qualification", "industry_experience_years", "teaching_experience_years", "nsdc_remarks", "eligibility_payment_amount", "payment_reference", "tot_certificate_no", "pipeline_note", "incentive_note"];

export const { GET, POST } = collectionRoutes({
  model: Trainer, entity: "Trainer", scopeField: null,
  async mapItems(items, user) {
    if (await hasPermission(user, "trainers.manage")) return items;
    return items.map((t) => {
      const safe = { ...t };
      for (const f of PAY_FIELDS) delete safe[f];
      return safe;
    });
  },
  fields: ["name", "phone", "email", "skills", "home_location", "status", "available_from", "day_rate", "incentive_note", "max_concurrent_batches", "active", "pipeline_status", "tr_id", "capable_locations", "programs_applied", "compensation_type", "compensation_fixed", "govt_candidate_id",
    // 2026-08-12 hiring pipeline (Manish's RPL walkthrough)
    "nominated_for_location", "nominated_for_program", "source", "qualification",
    "industry_experience_years", "teaching_experience_years", "nsdc_remarks",
    "eligibility_payment_amount", "payment_reference", "tot_certificate_no", "pipeline_note"],
  searchFields: ["name", "phone", "email", "tr_id"],
  writeRoles: ["Admin", "Operations"],
  permission: "trainers.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  populate: [
    { path: "home_location", select: "name code" },
    { path: "nominated_for_location", select: "name code" },
    { path: "nominated_for_program", select: "name code scheme" },
  ],
});
