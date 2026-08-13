// Eval: data-shape resilience. The AVPL master was ingested with the RAW driver (bypassing
// Mongoose validation), so production carries shapes the API itself can never create — 572
// candidates without `program`, placeholder NA-<name> phone keys, batches with optional fields
// absent. The API has to survive and EDIT those rows, not just the ones it created itself.
//
// This is the one suite that touches Mongo directly (to plant those shapes); everything it
// asserts still goes through the HTTP API. It refuses to run against the production DB.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ok, req, adminLogin, finish, stamp, phone } from "./e2e-lib.mjs";

// ---- resolve the Mongo target exactly like the app: env first, then .env.local ----
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function envLocal(key) {
  const p = path.join(root, ".env.local");
  if (!existsSync(p)) return undefined;
  const m = readFileSync(p, "utf-8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m?.[1]?.trim();
}
const MONGODB_URL = process.env.MONGODB_URL || envLocal("MONGODB_URL") || "mongodb://localhost:27017";
const MONGODB_DB = process.env.MONGODB_DB || envLocal("MONGODB_DB");
if (!MONGODB_DB || MONGODB_DB === "center_erp") {
  // No implicit target, and NEVER production — this suite writes raw documents.
  console.log(`SKIPPED: e2e-eval-data needs an explicit non-production MONGODB_DB (got "${MONGODB_DB ?? ""}")`);
  console.log("\n0 passed, 0 failed");
  process.exit(0);
}

const { MongoClient } = await import("mongodb");
const client = await MongoClient.connect(MONGODB_URL);
const db = client.db(MONGODB_DB);

const admin = await adminLogin();
const s = stamp("ED");

// a real centre/program pair to hang batches on
const prog = (await req(admin, "POST", "/api/programs", { code: s, name: "EvalData Prog " + s, trainer_skill: "EDSkill" + s }, 201)).data.item;
const loc = (await req(admin, "POST", "/api/locations", { code: "L" + s, name: "TEST-EvalData Loc " + s, approval_status: "Approved", city: "Varanasi" }, 201)).data.item;

// ---- shape 1: candidate with NO program/location (all 572 imported rows look like this) ----
const bare = await db.collection("candidates").insertOne({ name: "TEST-ED Bare " + s, phone: phone("77"), lifecycle_status: "Unassigned", createdAt: new Date(), updatedAt: new Date() });
// [best] the list and detail APIs serve the row instead of choking on the missing refs.
const bareRead = await req(admin, "GET", `/api/candidates/${bare.insertedId}`);
ok("[best] API reads a raw-imported candidate with no program/location", bareRead.status === 200 && bareRead.data.item.program == null, `got ${bareRead.status}`);
// [best] THE Part-B proof: a phone correction must not be held hostage to fields the user is
// not touching. Full-document validation used to 400 this ("program is required").
const newPhone = phone("78");
const fix = await req(admin, "PATCH", `/api/candidates/${bare.insertedId}`, { phone: newPhone });
ok("[best] phone fix on a program-less row succeeds (validateModifiedOnly)", fix.status === 200, `got ${fix.status}: ${JSON.stringify(fix.data).slice(0, 120)}`);
const fixed = (await req(admin, "GET", `/api/candidates/${bare.insertedId}`, undefined, 200)).data.item;
ok("[best] …and the fix landed", fixed.phone === newPhone, fixed.phone);
// [avg] the same row can then be completed field by field.
await req(admin, "PATCH", `/api/candidates/${bare.insertedId}`, { location: loc._id, program: prog._id, education: "10th Pass" }, 200);
const completed = (await req(admin, "GET", `/api/candidates/${bare.insertedId}`, undefined, 200)).data.item;
ok("[avg] missing refs can be filled in afterwards", String(completed.program?._id) === String(prog._id) && completed.education === "10th Pass");

// ---- shape 2: the NA-<name> placeholder phone (sheet rows that had no number) ----
const naKey = "NA-test-ed-" + s.toLowerCase();
await db.collection("candidates").insertOne({ name: "TEST-ED NoPhone " + s, phone: naKey, lifecycle_status: "Unassigned", createdAt: new Date(), updatedAt: new Date() });
// [avg] placeholder rows are findable — they are data to fix, not rows to hide.
const naHits = (await req(admin, "GET", `/api/candidates?q=${encodeURIComponent(naKey)}&limit=10`, undefined, 200)).data.items ?? [];
ok("[avg] NA- placeholder row is searchable by its key", naHits.length === 1, `${naHits.length} hits`);
// [best] giving it a real phone through the edit surface works.
await req(admin, "PATCH", `/api/candidates/${naHits[0]._id}`, { phone: phone("79") }, 200);

// ---- shape 3: minimal raw batch (imported Batch_Master rows lack most optional fields) ----
const rawBatch = await db.collection("batches").insertOne({
  code: "ED-" + s, location: loc._id ? new (await import("mongodb")).ObjectId(String(loc._id)) : undefined,
  program: new (await import("mongodb")).ObjectId(String(prog._id)),
  status: "Planning", target_size: 20, planned_start: new Date(), createdAt: new Date(), updatedAt: new Date(),
});
// [best] readiness/health computation answers on a bare row (no milestones, no room, no slot).
const bRead = await req(admin, "GET", `/api/batches/${rawBatch.insertedId}`);
ok("[best] batch detail computes readiness on a raw-imported bare batch", bRead.status === 200 && bRead.data.readiness, `got ${bRead.status}`);
ok("[avg] …and its readiness is honestly incomplete, not accidentally green", (bRead.data.readiness?.missing ?? bRead.data.readiness?.blockers ?? []).length > 0 || bRead.data.readiness?.ready === false, JSON.stringify(bRead.data.readiness).slice(0, 120));
// [best] the list renders it alongside API-born batches.
const inList = ((await req(admin, "GET", "/api/batches?limit=2000", undefined, 200)).data.items ?? []).some((b) => b.code === "ED-" + s);
ok("[best] raw batch appears in the batches list", inList);

// ---- shape 4: one phone, two candidates (families share numbers — the data allows it) ----
const famPhone = phone("76");
await req(admin, "POST", "/api/candidates", { name: "TEST-ED Fam1 " + s, phone: famPhone, location: loc._id, program: prog._id }, 201);
await req(admin, "POST", "/api/candidates", { name: "TEST-ED Fam2 " + s, phone: famPhone, location: loc._id, program: prog._id }, 201);
const fam = (await req(admin, "GET", `/api/candidates?q=${famPhone}&limit=10`, undefined, 200)).data.items ?? [];
ok("[avg] two family members on one number both exist and both list", fam.length === 2, `${fam.length} rows`);

// ---- full-scale contract: the list caps guard runaway queries, not the data ----
const all = (await req(admin, "GET", "/api/candidates?limit=5000", undefined, 200)).data;
ok("[best] limit=5000 is honoured (no hidden 200-cap regression)", all.items.length === Math.min(all.total, 5000), `items=${all.items.length} total=${all.total}`);
const over = await req(admin, "GET", "/api/candidates?limit=999999");
ok("[worst] a runaway limit is clamped, not honoured", over.status === 200 && over.data.items.length <= 5000, `items=${over.data?.items?.length}`);

// ---- cleanup: this suite deletes exactly what it planted ----
await db.collection("candidates").deleteMany({ name: { $regex: `^TEST-ED .*${s}$` } });
await db.collection("batches").deleteMany({ code: "ED-" + s });
await client.close();

finish();
