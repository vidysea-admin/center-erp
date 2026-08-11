// One-off, idempotent migration for the 2026-08-11 meeting decisions:
//   1. Defaults: max_concurrent_batches 5 → 4 ("up to four batches का provision")
//   2. Trainers still at the old default of 5 → 4 (deliberate other values keep)
// Everything else added that day is new fields with schema defaults — no data to move.
// Safe to re-run. Run: node --env-file=.env.local scripts/migrate-policy-2026-08-11.mjs
import mongoose from "mongoose";

await mongoose.connect(process.env.MONGODB_URL, {
  dbName: process.env.MONGODB_DB || "center_erp",
  serverSelectionTimeoutMS: 10000,
});
const db = mongoose.connection.db;

const d = await db.collection("defaults").updateOne(
  { _singleton: "defaults", $or: [{ max_concurrent_batches: 5 }, { max_concurrent_batches: { $exists: false } }] },
  { $set: { max_concurrent_batches: 4 } },
);
const t = await db.collection("trainers").updateMany(
  { $or: [{ max_concurrent_batches: 5 }, { max_concurrent_batches: { $exists: false } }] },
  { $set: { max_concurrent_batches: 4 } },
);
console.log(`defaults updated: ${d.modifiedCount}, trainers updated: ${t.modifiedCount}`);
await mongoose.disconnect();
