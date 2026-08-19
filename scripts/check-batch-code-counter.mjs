// Umesh, 19/08 (screenshot): "Chitrakoot mein drone ka yeh 1st batch hai to DST-3 nahi yahan DST-1
// hoga. Gurugram mein Drone ke 2 batch bane hain." — the list shows CHI-ITI-RPLAVP-DST-03 on a centre
// whose first drone batch this is.
//
// READ-ONLY. This answers the question rather than assuming it, because the obvious fix would be the
// actual bug.
//
// What the code already does (rules.ts nextBatchCode): the prefix is centre code + FULL programme
// code, and the counter is a per-prefix document in `counters` — `_id: batch|CHI-ITI-RPLAVP-DST`,
// $inc with upsert. So Gurugram's two do NOT push Chitrakoot to 3; those are different counters.
// `-03` means THIS prefix's counter has been incremented twice already.
//
// AND THAT MAY BE CORRECT. A monotonic counter is deliberate: hand a number back after a delete and
// two different batches end up carrying the same code on paper — and the code is what a centre writes
// on a government form. So there are three possible answers and only one of them is a defect:
//
//   1. batches were created and later deleted/cancelled  -> working as designed, nothing to fix
//   2. the counter was seeded or migrated with a wrong start -> a one-row data correction
//   3. something increments it WITHOUT creating a batch (a failed create that consumed a number)
//      -> a real defect; the number should be reserved only on a successful write
//
//   node --env-file=.env.local scripts/check-batch-code-counter.mjs
//   node --env-file=.env.local scripts/check-batch-code-counter.mjs --prefix=CHI-ITI-RPLAVP-DST
//
// Nothing is renumbered by this script or by anything it recommends without Umesh saying so.
import { MongoClient } from "mongodb";

const arg = process.argv.find((a) => a.startsWith("--prefix="));
const only = arg ? arg.split("=")[1] : null;
const url = process.env.MONGODB_URL || process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB;
if (!url || !dbName) {
  console.error("MONGODB_URL and MONGODB_DB must be set (use --env-file=.env.local).");
  process.exit(2);
}

const client = new MongoClient(url);
await client.connect();
const db = client.db(dbName);
console.log(`db: ${dbName} · READ ONLY\n`);

const counters = await db.collection("counters")
  .find({ _id: { $regex: "^batch\\|" } }).toArray();
if (!counters.length) {
  console.log("No per-prefix batch counters exist yet — every code came from the legacy global counter.");
  await client.close();
  process.exit(0);
}

const batches = await db.collection("batches").find({}, { projection: { code: 1, status: 1, createdAt: 1 } }).toArray();
let suspicious = 0;
for (const c of counters.sort((a, b) => String(a._id).localeCompare(String(b._id)))) {
  const prefix = String(c._id).replace(/^batch\|/, "");
  if (only && prefix !== only) continue;
  const mine = batches.filter((b) => String(b.code ?? "").startsWith(prefix + "-"));
  const seqs = mine.map((b) => Number(String(b.code).split("-").pop())).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const missing = [];
  for (let n = 1; n <= (c.seq ?? 0); n++) if (!seqs.includes(n)) missing.push(n);

  const verdict = missing.length === 0
    ? "OK — every number the counter issued is on a batch"
    : `${missing.length} number(s) issued but no batch carries them: ${missing.join(", ")}`;
  console.log(`${prefix}`);
  console.log(`  counter: ${c.seq}   batches on record: ${mine.length}   codes: ${seqs.map((n) => String(n).padStart(2, "0")).join(", ") || "(none)"}`);
  console.log(`  ${verdict}`);
  for (const b of mine) console.log(`    ${b.code}  ${b.status}  created ${b.createdAt ? new Date(b.createdAt).toISOString().slice(0, 10) : "?"}`);
  if (missing.length) {
    suspicious++;
    console.log(`  -> check the audit trail for a DELETED batch on this prefix. If one was deleted, this is`);
    console.log(`     working as designed (outcome 1) and nothing should change. If none was, the counter`);
    console.log(`     either started wrong (outcome 2) or a failed create consumed a number (outcome 3).`);
  }
  console.log();
}
console.log(suspicious === 0
  ? "Every counter matches its batches. Nothing to do."
  : `${suspicious} prefix(es) have gaps — read the audit trail before deciding, and do NOT renumber an existing batch: its code is on a government form.`);
await client.close();
