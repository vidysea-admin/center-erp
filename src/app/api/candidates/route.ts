import { collectionRoutes } from "@/lib/crud";
import { BatchMember, Candidate, CandidateResult } from "@/models";
import { assertLocationInScope } from "@/lib/authz";
import { candidateEligibility } from "@/lib/rules";
import { getDefaults } from "@/lib/defaults";

export const { GET, POST } = collectionRoutes({
  model: Candidate, entity: "Candidate",
  fields: ["name", "phone", "alt_phone", "email", "gender", "dob", "id_reference", "location", "program", "source", "lifecycle_status", "education", "last_training_date", "interested_programs", "interested_locations", "sidh_status", "sidh_link_sent_at", "sidh_registered_on", "sidh_candidate_id", "sidh_failure_reason", "fee_amount", "fee_paid_on", "fee_reference"],
  // 2026-08-13 (Umesh: "search should allow all the columns"): the global shell search
  // rides this too — alt numbers, mobiliser/campaign and the portal CAN_ id all findable.
  searchFields: ["name", "phone", "alt_phone", "source", "sidh_candidate_id"],
  // QA-060/095 (CEO [38:43] "I shouldn't see all the candidates … just my batch-wise
  // details"): a Trainer never reads the centre's candidate pool — their lens is the
  // batch roster and the Attendance tab, which stay open to them.
  readRoles: ["Admin", "Operations", "Location", "Enrollment"],
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
  // 2026-08-13 (Umesh: "enrolled hai to No programme kyun?"): a candidate sitting in a batch
  // effectively HAS that batch's programme even when the imported row never carried one —
  // attach the active membership (at most one: partial-unique index on {candidate, left_on:null})
  // so the list can show the real programme instead of a false "No programme".
  async mapItems(items) {
    const defaults = await getDefaults();
    const members = await BatchMember.find({ candidate: { $in: items.map((c) => c._id) }, left_on: null })
      .select("candidate batch")
      .populate({ path: "batch", select: "code program status", populate: { path: "program", select: "name code scheme" } })
      .lean();
    const byCand = new Map(members.map((m: any) => [String(m.candidate), m.batch]));
    // QA-069 (S1): the Enrolled journey read "Result Awaited" for people whose result WAS
    // recorded — the journey trusted lifecycle_status, which historical imports never
    // caught up. The recorded assessment is the truth; it rides on every row as
    // latest_result and the journey derives from it first.
    const results = await CandidateResult.find({ candidate: { $in: items.map((c) => c._id) }, result: { $ne: "Pending" } })
      .select("candidate result assessed_on").sort({ assessed_on: -1, updatedAt: -1 }).lean<any[]>();
    const resByCand = new Map<string, string>();
    for (const r of results) if (!resByCand.has(String(r.candidate))) resByCand.set(String(r.candidate), r.result);
    return items.map((c) => {
      const b: any = byCand.get(String(c._id));
      return {
        ...c, eligibility: candidateEligibility(c, defaults),
        active_batch: b ? { code: b.code, status: b.status, program: b.program } : null,
        latest_result: resByCand.get(String(c._id)) ?? null,
      };
    });
  },
});
