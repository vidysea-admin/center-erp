// Removes e2e-test clutter (Test/Sync entities) so demo data stays clean, and rotates the
// admin password if ADMIN_NEW_PASSWORD is set.
// Run: node --env-file=.env.local scripts/cleanup-testdata.mjs
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

await mongoose.connect(process.env.MONGODB_URL, { dbName: process.env.MONGODB_DB || "center_erp", serverSelectionTimeoutMS: 10000 });
const db = mongoose.connection.db;
const ids = (docs) => docs.map((d) => d._id);

const testLocs = await db.collection("locations").find({ name: { $regex: "^(Test Location|Sync Loc)" } }).toArray();
const testProgs = await db.collection("programs").find({ name: { $regex: "^(Test Program|Sync Prog)" } }).toArray();
const testTrainers = await db.collection("trainers").find({ name: { $regex: "^(Trainer \\d|SyncTrainer)" } }).toArray();
const testCands = await db.collection("candidates").find({ $or: [{ name: { $regex: "^(Cand |Cand4|SyncCand)" } }, { location: { $in: ids(testLocs) } }] }).toArray();
const testBatches = await db.collection("batches").find({ $or: [{ location: { $in: ids(testLocs) } }, { program: { $in: ids(testProgs) } }] }).toArray();

const r = {};
r.batchmembers = (await db.collection("batchmembers").deleteMany({ $or: [{ batch: { $in: ids(testBatches) } }, { candidate: { $in: ids(testCands) } }] })).deletedCount;
r.dailylogs = (await db.collection("dailylogs").deleteMany({ batch: { $in: ids(testBatches) } })).deletedCount;
r.closures = (await db.collection("closures").deleteMany({ batch: { $in: ids(testBatches) } })).deletedCount;
r.invoices = (await db.collection("invoices").deleteMany({ batch: { $in: ids(testBatches) } })).deletedCount;
r.costentries = (await db.collection("costentries").deleteMany({ $or: [{ batch: { $in: ids(testBatches) } }, { trainer: { $in: ids(testTrainers) } }, { location: { $in: ids(testLocs) } }] })).deletedCount;
r.trainerrequests = (await db.collection("trainerrequests").deleteMany({ location: { $in: ids(testLocs) } })).deletedCount;
r.batches = (await db.collection("batches").deleteMany({ _id: { $in: ids(testBatches) } })).deletedCount;
r.candidates = (await db.collection("candidates").deleteMany({ _id: { $in: ids(testCands) } })).deletedCount;
r.trainers = (await db.collection("trainers").deleteMany({ _id: { $in: ids(testTrainers) } })).deletedCount;
r.rooms = (await db.collection("rooms").deleteMany({ location: { $in: ids(testLocs) } })).deletedCount;
const testSyncSources = await db.collection("syncsources").find({ name: { $regex: "^Test sheet" } }).toArray();
const testChanges = await db.collection("sheetchanges").find({ sync_source: { $in: ids(testSyncSources) } }).toArray();
r.followups = (await db.collection("followupactions").deleteMany({ source_change: { $in: ids(testChanges) } })).deletedCount;
r.sheetchanges = (await db.collection("sheetchanges").deleteMany({ _id: { $in: ids(testChanges) } })).deletedCount;
r.syncsources = (await db.collection("syncsources").deleteMany({ _id: { $in: ids(testSyncSources) } })).deletedCount;
r.locations = (await db.collection("locations").deleteMany({ _id: { $in: ids(testLocs) } })).deletedCount;
r.programs = (await db.collection("programs").deleteMany({ _id: { $in: ids(testProgs) } })).deletedCount;

console.log("Deleted:", JSON.stringify(r));

if (process.env.ADMIN_NEW_PASSWORD) {
  await db.collection("users").updateOne(
    { email: "admin@vidysea.com" },
    { $set: { password_hash: await bcrypt.hash(process.env.ADMIN_NEW_PASSWORD, 10), updatedAt: new Date() } },
  );
  console.log("Admin password rotated.");
}

for (const col of ["locations", "programs", "trainers", "candidates", "batches"]) {
  console.log(col.padEnd(12), await db.collection(col).countDocuments());
}
await mongoose.disconnect();
