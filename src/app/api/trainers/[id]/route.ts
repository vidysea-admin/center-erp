import { itemRoutes } from "@/lib/crud";
import { Trainer } from "@/models";
import { hasPermission } from "@/lib/permissions";
import { assertLocationOperational, assertTrainerDocInScope, TRAINER_FLOW } from "@/lib/rules";
import { maskTrainerSecrets } from "../route";

// Same masking as the list route (2026-08-12) — opening one trainer by id was the obvious way
// around a list-only filter. The field list itself lives in the list route so there is only one.
export const { GET, PATCH } = itemRoutes({
  model: Trainer, entity: "Trainer", scopeField: null,
  // QA-125 (checker, 15/08): the list's nomination/capability/home union now guards the
  // ITEM too — a scoped user could read and PATCH any trainer by id before this.
  scopeAssert: (user, item) => assertTrainerDocInScope(user, item),
  async mapItems(items, user) {
    const masked = await maskTrainerSecrets(items, await hasPermission(user, "trainers.manage"));
    // QA-111 (15/08): the Move drawer offered all 11 stages and let the server refuse the
    // pick — a dead-end that even demanded a TR ID first. The edge table is the single
    // source of truth; hand the UI exactly the moves the machine will accept.
    return masked.map((t: any) => ({ ...t, allowed_next: TRAINER_FLOW[t.pipeline_status ?? "Fresh Lead"] ?? [] }));
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
  readRoles: ["Admin", "Operations", "Location"], // QA-095: same door as the list
  writeRoles: ["Admin", "Operations"],
  permission: "trainers.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  // F-B5: re-pointing a trainer's nomination at a halted centre is also hiring for it.
  async beforeUpdate(_id, body, existing) {
    if (body.nominated_for_location && String(body.nominated_for_location) !== String(existing.nominated_for_location ?? "")) {
      await assertLocationOperational(body.nominated_for_location, "Nominating a trainer for this centre");
    }
  },
  populate: [
    { path: "home_location", select: "name code" },
    { path: "nominated_for_location", select: "name code" },
    { path: "nominated_for_program", select: "name code scheme" },
  ],
});
