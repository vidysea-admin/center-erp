// -129 (QA-268): rename the trainer document type "CIPSA Certificate" -> "CITS Certificate".
//
// Why this is a MIGRATION and not a find-and-replace in the source. The label IS the stored value:
// there is no display layer for TRAINER_DOC_TYPE (contrast pipelineLabel, which lets the pipeline
// rename stages freely). Two collections hold the literal, and leaving either behind is worse than
// the wrong name:
//
//   1. TrainerDocument.doc_type — a row still reading "CIPSA Certificate" fails enum validation on
//      any re-save, and the upload door deletes-and-replaces by { trainer, doc_type }
//      (api/trainers/[id]/documents/route.ts). Re-uploading under the new name would STACK a second
//      row instead of superseding the old one, and the old file would never be reaped.
//
//   2. Program.mandatory_trainer_docs — this one is the real damage. rules.ts builds the required
//      set from MANDATORY_TRAINER_DOCS ∪ program.mandatory_trainer_docs, and Rule T2 refuses
//      "Documents Completed" until every required type is on file. A programme still demanding
//      "CIPSA Certificate" would demand a document the UI can no longer offer — so that programme's
//      trainers could NEVER reach Documents Completed. A permanent stall, from a rename.
//
//   node --env-file=.env.local scripts/migrate-cits-doctype.mjs           # dry run, changes nothing
//   node --env-file=.env.local scripts/migrate-cits-doctype.mjs --apply   # writes
//
// Reports counts before and after, and is idempotent — running it twice changes nothing the second
// time. Safe to run before OR after the code deploy: the two are independent.
import { MongoClient } from "mongodb";

const APPLY = process.argv.includes("--apply");
const OLD = "CIPSA Certificate";
const NEW = "CITS Certificate";

const url = process.env.MONGODB_URL || process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB;
if (!url || !dbName) {
  console.error("MONGODB_URL and MONGODB_DB must be set (use --env-file=.env.local).");
  process.exit(2);
}

const client = new MongoClient(url);
await client.connect();
const db = client.db(dbName);
console.log(`db: ${dbName} · ${APPLY ? "APPLY" : "DRY RUN"}\n`);

const docs = db.collection("trainerdocuments");
const progs = db.collection("programs");

const beforeDocs = await docs.countDocuments({ doc_type: OLD });
const beforeProgs = await progs.countDocuments({ mandatory_trainer_docs: OLD });
console.log(`TrainerDocument rows with doc_type "${OLD}":            ${beforeDocs}`);
console.log(`Program rows listing "${OLD}" as mandatory:             ${beforeProgs}`);

// Name the affected programmes out loud — a stalled programme is the expensive half of this row.
if (beforeProgs) {
  const names = await progs.find({ mandatory_trainer_docs: OLD }).project({ code: 1, name: 1 }).toArray();
  for (const p of names) console.log(`   would stall: ${p.code} — ${p.name}`);
}
// And say whose files these are, so the count is a list of people rather than a number.
if (beforeDocs) {
  const sample = await docs.find({ doc_type: OLD }).project({ trainer: 1, original_name: 1 }).limit(10).toArray();
  for (const d of sample) console.log(`   file: ${d.original_name ?? "(unnamed)"} on trainer ${d.trainer}`);
  if (beforeDocs > 10) console.log(`   … and ${beforeDocs - 10} more`);
}

if (!APPLY) {
  console.log(`\nDRY RUN — would rename ${beforeDocs} document row(s) and ${beforeProgs} programme entry(ies). Nothing written.`);
  await client.close();
  process.exit(0);
}

// A trainer who somehow holds BOTH names would collide on { trainer, doc_type }. Refuse rather than
// merge — the same stance migrate-logdate-tz takes, because picking a winner is a human's call.
const both = await docs.aggregate([
  { $match: { doc_type: { $in: [OLD, NEW] } } },
  { $group: { _id: { t: "$trainer", d: "$doc_type" }, n: { $sum: 1 } } },
  { $group: { _id: "$_id.t", kinds: { $addToSet: "$_id.d" } } },
  { $match: { "kinds.1": { $exists: true } } },
]).toArray();
if (both.length) {
  console.log(`\nREFUSING: ${both.length} trainer(s) already hold BOTH names — renaming would collide on { trainer, doc_type }.`);
  for (const b of both) console.log(`   trainer ${b._id}`);
  console.log("Settle those by hand (keep one file), then re-run.");
  await client.close();
  process.exit(1);
}

const r1 = await docs.updateMany({ doc_type: OLD }, { $set: { doc_type: NEW } });
const r2 = await progs.updateMany({ mandatory_trainer_docs: OLD }, { $set: { "mandatory_trainer_docs.$[e]": NEW } }, { arrayFilters: [{ e: OLD }] });
console.log(`\nrenamed: ${r1.modifiedCount} document row(s), ${r2.modifiedCount} programme(s)`);

const afterDocs = await docs.countDocuments({ doc_type: OLD });
const afterProgs = await progs.countDocuments({ mandatory_trainer_docs: OLD });
console.log(`verify: TrainerDocument still on the old name = ${afterDocs} (want 0)`);
console.log(`verify: Program still on the old name        = ${afterProgs} (want 0)`);
console.log(`verify: TrainerDocument now on "${NEW}"       = ${await docs.countDocuments({ doc_type: NEW })}`);
console.log(afterDocs === 0 && afterProgs === 0 ? "\nOK" : "\nCHECK THIS — something still carries the old name");
await client.close();
process.exit(afterDocs === 0 && afterProgs === 0 ? 0 : 1);
