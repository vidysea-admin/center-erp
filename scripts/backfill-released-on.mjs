// One-off, idempotent migration for re-enrolment (Umesh 2026-11-02): "ek batch complete hai ya ek batch se
// bachcha drop hai to dusra join kar paaye." BatchMember gained `released_on` - the batch finished, so the
// seat no longer holds the person (lib/candidate-journey.ts HOLDS_PERSON) - and the Rule 20 unique index
// moved from `{left_on: null}` to `{left_on: null, released_on: null}`.
//
// Ships WITH the code, in this order, because each step is safe on its own:
//   1. every row without the field gets `released_on: null` (the partial index then sees it explicitly);
//   2. rows still on the roster (left_on null) of a Completed / Closed / Cancelled batch get
//      released_on = batch.actual_end ?? batch.updatedAt - every pass-out held today is freed;
//   3. the new `candidate_holds_person` index is created BEFORE the old one goes where the server allows
//      two indexes on {candidate: 1} (MongoDB 7.3+); older servers drop the old one first (see below);
//      the app also builds it on start, and creating it twice with one spec is a no-op;
//   4. the old `candidate_1` partial index is dropped. Until it is, new code + old index still refuses
//      every completed student, which is why this cannot wait for a later deploy.
// Safe to re-run, and RE-RUN it after the deploy settles: a batch completed or cancelled by an old-code
// instance (before the deploy, or mid rolling deploy) is not stamped by it, and this heals those rows.
//   Dry run (reads only):  MONGODB_DB=<db> node --env-file=.env.local scripts/backfill-released-on.mjs --dry-run
//   Apply:                 MONGODB_DB=<db> node --env-file=.env.local scripts/backfill-released-on.mjs
import mongoose from "mongoose";
import { requireSafeDb } from "./db-guard.mjs";

const DRY = process.argv.includes("--dry-run");
const dbName = DRY ? (process.env.MONGODB_DB ?? "").trim() : requireSafeDb("backfill-released-on");
if (!dbName) { console.error("backfill-released-on: MONGODB_DB is not set."); process.exit(1); }

await mongoose.connect(process.env.MONGODB_URL, { dbName, serverSelectionTimeoutMS: 10000 });
const db = mongoose.connection.db;
const members = db.collection("batchmembers");

const missing = await members.countDocuments({ released_on: { $exists: false } });
const finished = await db.collection("batches")
  .find({ status: { $in: ["Completed", "Closed", "Cancelled"] } })
  .project({ _id: 1, actual_end: 1, updatedAt: 1 })
  .toArray();
const toRelease = await members.countDocuments({ batch: { $in: finished.map((b) => b._id) }, left_on: null, released_on: null });
const indexes = await members.indexes();
const oldIndex = indexes.find((i) => i.name === "candidate_1");
const newIndex = indexes.find((i) => i.name === "candidate_holds_person");
const { version } = await db.admin().serverInfo();
console.log(`backfill-released-on (${dbName}, mongod ${version}${DRY ? ", DRY RUN" : ""}): ${missing} rows lack the field, `
  + `${finished.length} finished batches, ${toRelease} roster rows to release, `
  + `old index ${oldIndex ? "present" : "absent"}, new index ${newIndex ? "present" : "absent"}`);

if (!DRY) {
  const set = await members.updateMany({ released_on: { $exists: false } }, { $set: { released_on: null } });
  let released = 0;
  for (const b of finished) {
    const r = await members.updateMany(
      { batch: b._id, left_on: null, released_on: null },
      { $set: { released_on: b.actual_end ?? b.updatedAt ?? new Date() } },
    );
    released += r.modifiedCount;
  }
  const createNew = () => members.createIndex({ candidate: 1 }, { name: "candidate_holds_person", unique: true, partialFilterExpression: { left_on: null, released_on: null } });
  try {
    await createNew();
    if (oldIndex) await members.dropIndex("candidate_1");
  } catch (e) {
    // MongoDB before 7.3 refuses a second index on the same key pattern {candidate: 1}, whatever its partial
    // filter (85 IndexOptionsConflict / 86 IndexKeySpecsConflict). Then the old one goes FIRST: Rule 20 is
    // guarded by addMemberChecked's own check for the seconds between the two calls.
    if (!oldIndex || ![85, 86].includes(e?.code)) throw e;
    console.log(`backfill-released-on: server refused a second {candidate:1} index (code ${e.code}) - dropping candidate_1 first`);
    await members.dropIndex("candidate_1");
    await createNew();
  }
  console.log(`backfill-released-on: ${set.modifiedCount} rows given released_on: null, ${released} released, `
    + `new index ensured, old index ${oldIndex ? "dropped" : "was already gone"}`);
}
await mongoose.disconnect();
