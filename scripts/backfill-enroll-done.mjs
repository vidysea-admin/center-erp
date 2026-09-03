// One-off, idempotent backfill for the 2026-09-03 4th enrollment step (Umesh, voice note):
// BatchMember gained `enroll_done` between `kyc_done` and `accept_done`. Any row that already
// reached accept_done = true under the old 3-step model must, logically, have already enrolled
// in the batch first — so enroll_done backfills to true (and enroll_done_at to accept_done_at,
// the closest real timestamp on record) wherever accept_done is true and enroll_done is not
// already true. Rows that never reached Batch Accept are untouched: their enrollment_status
// (derived from 4 booleans post-deploy) correctly drops from Completed/In-Progress-3-of-3 to
// In Progress-3-of-4 until someone marks the new step, which is the intended re-derivation.
// Safe to re-run. Run: MONGODB_DB=<db> node --env-file=.env.local scripts/backfill-enroll-done.mjs
import mongoose from "mongoose";
import { requireSafeDb } from "./db-guard.mjs";

await mongoose.connect(process.env.MONGODB_URL, {
  dbName: requireSafeDb("backfill-enroll-done"),
  serverSelectionTimeoutMS: 10000,
});
const db = mongoose.connection.db;

const members = await db.collection("batchmembers")
  .find({ accept_done: true, enroll_done: { $ne: true } })
  .project({ _id: 1, accept_done_at: 1 })
  .toArray();

let updated = 0;
for (const m of members) {
  await db.collection("batchmembers").updateOne(
    { _id: m._id },
    { $set: { enroll_done: true, enroll_done_at: m.accept_done_at ?? new Date() } },
  );
  updated++;
}
console.log(`backfill-enroll-done: ${members.length} candidate rows found, ${updated} updated`);
await mongoose.disconnect();
