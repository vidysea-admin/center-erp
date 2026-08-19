import { MongoClient, ObjectId } from "mongodb";
const c = new MongoClient("mongodb://127.0.0.1:27017");
await c.connect();
const db = c.db("center_erp_ci");

const spoc = await db.collection("users").findOne({ email: "spoc.jpr03@vidysea.com" });
const scopeIds = (spoc.location_scope || []).map(x => new ObjectId(String(x)));
console.log("SPOC scope locations:", scopeIds.map(String).join(","));
const scopedBatchIds = await db.collection("batches").distinct("_id", { location: { $in: scopeIds } });
console.log("scopedBatchIds:", scopedBatchIds.length);

async function portalFor(batchScope) {
  return db.collection("govtattendancerows").aggregate([
    { $match: { match_status: "Matched", ...(("batch" in batchScope) ? batchScope : { batch: { $ne: null } }) } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: { b: "$batch", c: "$candidate" }, days: { $first: "$total_days_present" }, working: { $first: "$total_working_days" } } },
    { $group: { _id: "$_id.b", present: { $sum: "$days" }, roster: { $sum: "$working" } } },
  ]).toArray();
}
async function ours(match) {
  const r = await db.collection("dailylogs").aggregate([
    { $match: match },
    { $group: { _id: null, present: { $sum: "$internal_present" }, roster: { $sum: "$roster_count" } } },
  ]).toArray();
  return r[0] ?? { present: 0, roster: 0 };
}

for (const [who, batchScope] of [["ADMIN (unscoped)", {}], ["SPOC (scoped)", { batch: { $in: scopedBatchIds } }]]) {
  const pb = await portalFor(batchScope);
  const portalBatches = new Set(pb.map(p => String(p._id)));
  console.log(`\n== ${who} ==  portalBatches=${portalBatches.size} [${[...portalBatches].join(",")}]`);
  const nin = [...portalBatches].map(x => new ObjectId(x));
  const OLD = { ...batchScope, batch: { $nin: nin } };
  const NEW = { batch: { ...(batchScope.batch ?? {}), $nin: nin } };
  console.log("  OLD filter:", JSON.stringify(OLD));
  console.log("  NEW filter:", JSON.stringify(NEW));
  console.log("  OLD result:", JSON.stringify(await ours(OLD)));
  console.log("  NEW result:", JSON.stringify(await ours(NEW)));
  console.log("  attAll(scoped):", JSON.stringify(await ours({ ...batchScope })));
}
await c.close();
