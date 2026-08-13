import { itemRoutes } from "@/lib/crud";
import { Trainer } from "@/models";
import { hasPermission } from "@/lib/permissions";
import { maskTrainerSecrets } from "../route";

// Same masking as the list route (2026-08-12) — opening one trainer by id was the obvious way
// around a list-only filter. The field list itself lives in the list route so there is only one.
export const { GET, PATCH } = itemRoutes({
  model: Trainer, entity: "Trainer", scopeField: null,
  async mapItems(items, user) {
    return maskTrainerSecrets(items, await hasPermission(user, "trainers.manage"));
  },
  // The hiring-journey fields have to be writable here too — the detail page PATCHes through
  // this route, and a field missing from this list is silently dropped. pipeline_status is
  // deliberately NOT here (2026-08-13 eval sweep): a plain PATCH could jump a trainer straight
  // to "Certified", skipping every TRAINER_FLOW guard — document gates, the NSDC round-trip,
  // Rule T7. Stages move only through /transition; creation may still set an initial stage.
  fields: ["name", "phone", "email", "skills", "home_location", "home_location_other", "status", "available_from", "day_rate", "incentive_note", "max_concurrent_batches", "active", "tr_id", "capable_locations", "programs_applied", "compensation_type", "compensation_fixed", "govt_candidate_id",
    "nominated_for_location", "nominated_for_program", "source", "qualification",
    "industry_experience_years", "teaching_experience_years", "nsdc_remarks",
    "eligibility_payment_amount", "payment_reference", "tot_certificate_no", "pipeline_note"],
  writeRoles: ["Admin", "Operations"],
  permission: "trainers.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  populate: [
    { path: "home_location", select: "name code" },
    { path: "nominated_for_location", select: "name code" },
    { path: "nominated_for_program", select: "name code scheme" },
  ],
});
