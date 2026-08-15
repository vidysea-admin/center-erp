import { itemRoutes } from "@/lib/crud";
import { Candidate } from "@/models";
import { candidateEligibility } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";
import { HttpError } from "@/lib/authz";
import { emailError, canonicalPhone, phoneError } from "@/lib/validate";

export const { GET, PATCH } = itemRoutes({
  model: Candidate, entity: "Candidate",
  fields: ["name", "phone", "alt_phone", "email", "gender", "dob", "id_reference", "location", "program", "source", "education", "last_training_date", "interested_programs", "interested_locations", "sidh_status", "sidh_link_sent_at", "sidh_registered_on", "sidh_candidate_id", "sidh_failure_reason", "fee_amount", "fee_paid_on", "fee_reference"],
  readRoles: ["Admin", "Operations", "Location", "Enrollment"], // QA-060/095: not the Trainer's lens
  writeRoles: ["Admin", "Operations", "Location", "Enrollment"],
  permission: "candidates.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  // QA-141 (Umesh): edits are as strict as creates — fixed-up numbers land as the bare 10.
  beforeUpdate(_id, body) {
    if (body.phone !== undefined) {
      const pErr = phoneError(body.phone);
      if (pErr) throw new HttpError(400, pErr);
      body.phone = canonicalPhone(body.phone)!;
    }
    if (body.alt_phone !== undefined && body.alt_phone !== "") {
      const aErr = phoneError(body.alt_phone, { optional: true });
      if (aErr) throw new HttpError(400, "Alt phone: " + aErr);
      body.alt_phone = canonicalPhone(body.alt_phone)!;
    }
    if (body.email !== undefined && body.email !== "") {
      const eErr = emailError(body.email, { optional: true });
      if (eErr) throw new HttpError(400, eErr);
    }
  },
  populate: [
    { path: "location", select: "name code" },
    { path: "program", select: "name code" },
  ],
  async mapItems(items) {
    const defaults = await getDefaults();
    return items.map((c) => ({ ...c, eligibility: candidateEligibility(c, defaults) }));
  },
});
