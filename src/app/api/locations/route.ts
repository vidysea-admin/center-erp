import { collectionRoutes } from "@/lib/crud";
import { Location, LocationTarget } from "@/models";
import { tcVerdict, trainerTiesFor } from "@/lib/rules";

// 2026-08-12: tc_password is a LIVE government portal credential — "us location ke TC ID aur
// password se login karunga". QA-088 (checker, 14/08): the gate used to be
// locations.manage, and the saved matrix grants that to Operations AND every SPOC — so the
// password sat in plain text for exactly the logins it should be hidden from. The gate is
// the ROLE now, same as the Sheet Watch column: Admin sees it, nobody else does.
const SECRET_FIELDS = ["tc_password"];
export function maskLocationSecrets(items: any[], isAdmin: boolean) {
  if (isAdmin) return items;
  return items.map((l) => {
    const safe = { ...l };
    for (const f of SECRET_FIELDS) delete safe[f];
    return safe;
  });
}

export const { GET, POST } = collectionRoutes({
  model: Location, entity: "Location", scopeField: "_id",
  // -129 (QA-271): "active" joins the whitelist so a centre can be retired through the same
  // audited door as everything else. A field the model has and the route does not is the -116
  // lesson — it looks saved and is gone on the next read.
  fields: ["code", "external_id", "institution_id", "name", "city", "state", "address", "approval_status", "operational_status", "status_reason", "status_changed_on", "spoc_name", "spoc_phone", "spoc_user", "principal_name", "principal_phone", "principal_user", "contacts", "district", "tc_id", "tc_password", "tc_status", "operating_partner", "cluster_head_name", "cluster_head_phone", "active"],
  searchFields: ["code", "name", "city", "external_id", "institution_id", "tc_id", "district"],
  // QA-095: the CEO shut the Trainer's locations door — the API answers 403 now, not with
  // the centre's commercials. Batch/home surfaces carry the centre NAME on their own.
  readRoles: ["Admin", "Operations", "Location", "Enrollment"],
  writeRoles: ["Admin", "Operations"],
  permission: "locations.manage", // 2026-08-11 togglable right (writeRoles = fallback only)
  // 2026-08-13 (Manish: "Ongoing scheme bhi saath mein dikhana MUST hai — warna pata hi nahi
  // chalega"): each centre carries its job roles WITH their scheme, plus the per-row TC verdict
  // that decides the "31 approved". One extra query per page, same shape as candidates' batch join.
  // 2026-08-13 (Umesh, OneDrive-sheet-format cycle): the join now carries the sheet's full
  // per-row payload (targets, reported enrolment, claimed trainer counts) PLUS our live
  // trainer fulfilment — "jaise-jaise trainer approve honge, count update ho jana chahiye" —
  // derived per centre×job-role from Trainer rows (same $group as mappingReadinessBulk),
  // so the list updates the moment a trainer's pipeline moves. Never stored.
  async mapItems(items, user) {
    const masked = maskLocationSecrets(items, user.role === "Admin"); // QA-088
    const locIds = items.map((l: any) => l._id);
    const [targets, trainerRows] = await Promise.all([
      LocationTarget.find({ location: { $in: locIds } })
        .select("location program tc_status tc_id approved_target trainers_required enrolled_reported pending_reported nominations_received_reported nominated_nsdc_reported trainers_certified_reported")
        .populate("program", "name code scheme")
        .lean<any[]>(),
      // QA-1262 (client call 2026-08-25, "Zero zero dikh raha hai. Aur nomination ja chuka tha
      // iska."): this was its own aggregate on `nominated_for_location` alone — one of THREE copies
      // of the same derivation, all reading the same single tie. A trainer put on a batch at this
      // centre never sets that field, so the grid read 0 for a centre that had trainers working in
      // it. It now goes through the one shared derivation, which counts the batch tie too.
      trainerTiesFor(locIds),
    ]);
    const tcounts = trainerRows;
    const byLoc = new Map<string, any[]>();
    for (const t of targets) {
      const k = String(t.location);
      const ours = tcounts.get(`${k}|${String(t.program?._id)}`);
      byLoc.set(k, [...(byLoc.get(k) ?? []), {
        program: t.program?.name ?? null, code: t.program?.code ?? null, scheme: t.program?.scheme ?? null,
        // QA-528: two additive fields, both so a CALLER never has to re-decide something the
        // server already knows. `program_id` because every screen that wants to act on a job role
        // needs its id and was otherwise matching on the name; `tc_verdict` because "is this row
        // approved" now has exactly one definition (rules.ts tcVerdict), and a client re-testing
        // `=== "Approved"` would be the second copy that ARCHITECTURE section 3 exists to prevent.
        program_id: t.program?._id ?? null,
        tc_verdict: tcVerdict(t.tc_status),
        tc_id: t.tc_id ?? null, tc_status: t.tc_status ?? null, approved_target: t.approved_target ?? null,
        trainers_required: t.trainers_required ?? null,
        enrolled_reported: t.enrolled_reported ?? null, pending_reported: t.pending_reported ?? null,
        nominations_received_reported: t.nominations_received_reported ?? null,
        nominated_nsdc_reported: t.nominated_nsdc_reported ?? null,
        trainers_certified_reported: t.trainers_certified_reported ?? null,
        trainers_nominated: ours?.nominated ?? 0,
        trainers_certified: ours?.certified ?? 0,
      }]);
    }
    const sum = (rows: any[], k: string) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
    return masked.map((l: any) => {
      const rows = byLoc.get(String(l._id)) ?? [];
      return {
        ...l,
        job_roles: rows,
        schemes: [...new Set(rows.map((r) => r.scheme).filter(Boolean))],
        approved_job_roles: rows.filter((r) => r.tc_status === "Approved").length,
        // Sheet-format rollups for the one-row-per-centre list (the sheet's merged cells).
        total_target: sum(rows, "approved_target"),
        enrolled_reported_total: sum(rows, "enrolled_reported"),
        pending_reported_total: sum(rows, "pending_reported"),
        trainers_required_total: sum(rows, "trainers_required"),
        nominations_received_reported_total: sum(rows, "nominations_received_reported"),
        nominated_nsdc_reported_total: sum(rows, "nominated_nsdc_reported"),
        trainers_certified_reported_total: sum(rows, "trainers_certified_reported"),
        // OUR live figures (derived, move with the trainer pipeline).
        trainers_nominated_total: sum(rows, "trainers_nominated"),
        trainers_certified_total: sum(rows, "trainers_certified"),
        tc_ids: [...new Set(rows.map((r) => r.tc_id).filter(Boolean))],
      };
    });
  },
});
