// One-off repair (2026-08-13 incident): a seed-avpl-master re-run $set sheet defaults over
// APP-owned candidate fields — lifecycle_status hard-coded "Unassigned" and sidh_* from the
// sheet's stale "Enrolled Status" column — regressing 57 Enrolled → Unassigned and
// 16 Registered → Not Registered on production. The pre-apply mongodump is the truth for
// those fields; this restores them per _id where they differ. Batches and trainers are NOT
// touched (their changes were the point of that apply). The root cause is fixed in
// seed-avpl-master.mjs (those fields are $setOnInsert-only now); this script exists to heal
// the one bad run and as the incident record.
//
// Prereq: the backup restored locally as center_erp_pre —
//   docker exec -i erp-test-mongo mongorestore --archive --nsFrom "center_erp.*" \
//     --nsTo "center_erp_pre.*" --drop < d:/erp/backups/<pre-apply>.archive
//
//   node scripts/restore-candidate-fields.mjs           → dry run (prints every restore)
//   node scripts/restore-candidate-fields.mjs --apply   → write
import { MongoClient } from "mongodb";

const APPLY = process.argv.includes("--apply");
const FIELDS = ["lifecycle_status", "sidh_status", "sidh_registered_on", "sidh_link_sent_at", "sidh_failure_reason", "name", "location", "source", "dob", "education"];

const pre = await MongoClient.connect(process.env.BACKUP_URL || "mongodb://127.0.0.1:27017");
const prod = await MongoClient.connect(process.env.MONGODB_URL || "mongodb://13.202.206.101:27017");
const before = pre.db(process.env.BACKUP_DB || "center_erp_pre").collection("candidates");
const now = prod.db(process.env.MONGODB_DB || "center_erp").collection("candidates");

const backup = await before.find({}).toArray();
const nowById = new Map((await now.find({}).toArray()).map((c) => [String(c._id), c]));

let fixes = 0, rows = 0;
const fieldCounts = {};
for (const b of backup) {
  const cur = nowById.get(String(b._id));
  if (!cur) continue;
  const set = {};
  for (const f of FIELDS) {
    const bv = b[f], cv = cur[f];
    const norm = (v) => (v instanceof Date ? v.toISOString() : v == null ? null : JSON.stringify(v));
    if (norm(bv) !== norm(cv)) {
      set[f] = bv === undefined ? null : bv; // absent in backup = should be absent again
      fieldCounts[f] = (fieldCounts[f] ?? 0) + 1;
      fixes++;
    }
  }
  if (Object.keys(set).length) {
    rows++;
    if (rows <= 15) console.log(`  ${b.name} (${b.phone}): ${Object.entries(set).map(([k, v]) => `${k} → ${JSON.stringify(v)?.slice(0, 40)}`).join(", ")}`);
    if (APPLY) await now.updateOne({ _id: b._id }, { $set: { ...set, updatedAt: new Date() } });
  }
}
console.log(`\n${rows} candidate(s), ${fixes} field value(s) ${APPLY ? "RESTORED" : "would be restored"}`);
console.log("per field:", JSON.stringify(fieldCounts));
if (!APPLY) console.log("Dry run — re-run with --apply.");
await pre.close();
await prod.close();
