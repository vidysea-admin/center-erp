// One-off, idempotent migration for the Aug-2026 policy changes (RPL process-flow alignment):
//   1. Defaults: max_concurrent_batches 1 → 5 (RPL M5 allows a trainer up to 5 batches)
//   2. Defaults: add roster_threshold_pct (was hardcoded 0.8 in code)
//   3. Trainers still carrying the old cap of 1 → 5
// Safe to re-run. Run: node --env-file=.env.local scripts/migrate-policy-2026-08.mjs
import mongoose from "mongoose";

await mongoose.connect(process.env.MONGODB_URL, {
  dbName: process.env.MONGODB_DB || "center_erp",
  serverSelectionTimeoutMS: 10000,
});
const db = mongoose.connection.db;

const d = await db.collection("defaults").updateOne(
  { _singleton: "defaults" },
  { $set: { max_concurrent_batches: 5 }, $setOnInsert: { _singleton: "defaults" } },
  { upsert: true },
);
await db.collection("defaults").updateOne(
  { _singleton: "defaults", roster_threshold_pct: { $exists: false } },
  { $set: { roster_threshold_pct: 80 } },
);

// Only trainers left at the old default are moved; anyone deliberately set to another
// number keeps it.
const t = await db.collection("trainers").updateMany(
  { $or: [{ max_concurrent_batches: 1 }, { max_concurrent_batches: { $exists: false } }] },
  { $set: { max_concurrent_batches: 5 } },
);

console.log(`defaults updated: ${d.modifiedCount + d.upsertedCount}, trainers updated: ${t.modifiedCount}`);
console.log(await db.collection("defaults").findOne({ _singleton: "defaults" }, { projection: { _id: 0, max_concurrent_batches: 1, roster_threshold_pct: 1, enrollment_threshold_pct: 1 } }));
await mongoose.disconnect();
