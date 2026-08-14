import { collectionRoutes } from "@/lib/crud";
import { Batch, Trainer } from "@/models";
import { hasPermission } from "@/lib/permissions";
import { ACTIVE_BATCH_STATUSES, assertLocationOperational } from "@/lib/rules";

// 2026-08-12, found by testing a real Trainer login: the directory is not location-scoped,
// so every signed-in user could read all 19 trainers INCLUDING day_rate, compensation and
// incentive notes. Pay is not directory data. Anyone without the trainers.manage right now
// gets the roster without the money fields.
// 2026-08-12: extended to the hiring journey too — NSDC remarks, qualification, experience
// and payment references are personnel data, not directory data.
// nominated_for_location/_program deliberately stay VISIBLE. They are not personnel data — they
// are the assignment fact "this trainer is cleared for this centre and this job role", which is
// what makes their TR ID usable on a batch. Masking them broke the trainer dropdown for anyone
// without trainers.manage, which is most of the people who actually create batches.
// One list, imported by the item route rather than copied into it — the two had already drifted
// apart once, and a mask that is right in one place and wrong in the other is worse than no mask.
const SENSITIVE_FIELDS = ["day_rate", "compensation_type", "compensation_fixed", "source", "qualification", "industry_experience_years", "teaching_experience_years", "nsdc_remarks", "eligibility_payment_amount", "payment_reference", "tot_certificate_no", "pipeline_note", "incentive_note"];

export function maskTrainerSecrets(items: any[], canManage: boolean) {
  if (canManage) return items;
  return items.map((t) => {
    const safe = { ...t };
    for (const f of SENSITIVE_FIELDS) delete safe[f];
    return safe;
  });
}

export const { GET, POST } = collectionRoutes({
  model: Trainer, entity: "Trainer", scopeField: null,
  // 2026-08-13 (Umesh, testing the view-only principal): masking pay was not enough — a
  // scoped user saw the ENTIRE trainer directory. A trainer belongs to a centre through
  // nomination, capability or home; scoped users see only trainers tied to their centres.
  scopeFilter: (user) => {
    const ids = (user.location_scope ?? []).map(String);
    return {
      $or: [
        { nominated_for_location: { $in: ids } },
        { capable_locations: { $in: ids } },
        { home_location: { $in: ids } },
      ],
    };
  },
  async mapItems(items, user) {
    // QA-031/045 (checker): "Assigned 6" was derived from pipeline_status Certified while
    // assigned_batches sat empty on all 71 — two different facts presented as one. The
    // truth is the batch links themselves: a trainer is assigned when a live batch points
    // at them. Attached per row so the UI stops guessing.
    const ids = items.map((t: any) => t._id);
    const live = ids.length
      ? await Batch.find({ trainer: { $in: ids }, status: { $in: ACTIVE_BATCH_STATUSES } })
        .select("code status trainer").lean<any[]>()
      : [];
    const byTrainer = new Map<string, any[]>();
    for (const b of live) {
      const k = String(b.trainer);
      if (!byTrainer.has(k)) byTrainer.set(k, []);
      byTrainer.get(k)!.push({ _id: b._id, code: b.code, status: b.status });
    }
    const withBatches = items.map((t: any) => ({ ...t, live_batches: byTrainer.get(String(t._id)) ?? [] }));
    return maskTrainerSecrets(withBatches, await hasPermission(user, "trainers.manage"));
  },
  fields: ["name", "phone", "email", "skills", "home_location", "home_location_other", "status", "available_from", "day_rate", "incentive_note", "max_concurrent_batches", "active", "pipeline_status", "tr_id", "capable_locations", "programs_applied", "compensation_type", "compensation_fixed", "govt_candidate_id",
    // 2026-08-12 hiring pipeline (Manish's RPL walkthrough)
    "nominated_for_location", "nominated_for_program", "source", "qualification",
    "industry_experience_years", "teaching_experience_years", "nsdc_remarks",
    "eligibility_payment_amount", "payment_reference", "tot_certificate_no", "pipeline_note"],
  searchFields: ["name", "phone", "email", "tr_id"],
  writeRoles: ["Admin", "Operations"],
  permission: "trainers.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  // F-B5 (Manish): a halted centre must stop hiring — no nominating trainers for it.
  async beforeCreate(body) {
    if (body.nominated_for_location) await assertLocationOperational(body.nominated_for_location, "Nominating a trainer for this centre");
  },
  populate: [
    { path: "home_location", select: "name code" },
    { path: "nominated_for_location", select: "name code" },
    { path: "nominated_for_program", select: "name code scheme" },
  ],
});
