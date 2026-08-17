// Remove every business record that has no source behind it.
//
// Umesh, 2026-08-12: "जो भी sheet से data दे रहा हूँ उन सबको रख… अगर कोई data है जिसका कोई proof
// नहीं है, तो उसको मत रख, उसको wipe out कर दे."
//
// Production is currently carrying an entirely invented dataset — 8 Rajasthan centres (Jaipur 03,
// Kota 02…), 5 academic programmes (Mathematics/Physics/Chemistry/Biology/Reasoning Foundation),
// 24 trainers, 513 candidates and 130 batches — none of which traces to any sheet. The existing
// scripts/cleanup-testdata.mjs only matches e2e-generated names (Test*/Sync*/G######) and leaves
// every one of those demo rows untouched, which is why this script exists.
//
// WHAT IT KEEPS, deliberately:
//   users            — the real logins, incl. manish.k@vidysea.com and the pending umeshsugara@
//   rolepermissions  — the permission matrix an Admin has configured
//   approvalrules    — the approval matrix
//   defaults         — tuned policy numbers
//   costcategories / dropreasons / failurereasons — master lists
//   syncsources      — the real "Vidysea-RPL (client workbook)" watcher
//   counters         — the batch-code sequence (resetting it would reissue used codes)
//
//   node --env-file=.env.local scripts/purge-unsourced.mjs                    # dry run
//   node --env-file=.env.local scripts/purge-unsourced.mjs --apply
//
// TAKE A DATABASE BACKUP FIRST. This is irreversible and there is no undo.
import { MongoClient } from "mongodb";

const APPLY = process.argv.includes("--apply");

const url = process.env.MONGODB_URL;
const dbName = process.env.MONGODB_DB;
if (!url || !dbName) {
  console.error("MONGODB_URL and MONGODB_DB must both be set. Refusing to guess which database to purge.");
  process.exit(1);
}

// Everything that describes the business. Order matters only for readability — Mongo has no FKs.
const PURGE = [
  "locations", "programs", "locationtargets", "rooms",
  "trainers", "trainerdocuments", "trainerrequests",
  "candidates", "batches", "batchmembers", "dailylogs",
  "closures", "candidateresults", "invoices", "costentries",
  "followupactions", "sheetchanges", "workbooksnapshots", "workbookchanges", "tabmappings",
  "meetingnotes", "publictokens", "feedbacks", "notifications",
  "govtattendanceimports", "govtattendancerows",
  "approvalrequests", "auditlogs",
];

const KEEP = [
  "users", "rolepermissions", "approvalrules", "defaults",
  "costcategories", "dropreasons", "failurereasons", "counters", "job_locks",
];

// syncsources is a special case: the client's real OneDrive workbook must survive, but the test
// suites have created dozens of throwaway sources ("Test sheet …", "Watch Source …") which are
// exactly the unsourced rows this script removes. Keep only what points at a real client sheet.
//
// -100 (checker QA-166, 17/08): this keep-list used to whitelist `docs.google.com` too — so the
// cleanup script written to remove strays PRESERVED the two Google workbooks Umesh had ordered
// removed on 13/08. The single-truth policy is the client's OneDrive workbook and nothing else
// (src/lib/workbook.ts `sourceAllowed()`), and this predicate now says the same thing.
const REAL_SOURCE = { source_url: /onedrive\.live\.com|1drv\.ms/i };

const client = new MongoClient(url);
await client.connect();
const db = client.db(dbName);

console.log(`database   ${dbName}`);
console.log(`mode       ${APPLY ? "APPLY — records will be deleted" : "dry run — nothing will be deleted"}\n`);

// Show what survives, so the operator can see the keep-list is real before committing.
console.log("KEEPING:");
for (const name of KEEP) {
  const n = await db.collection(name).countDocuments().catch(() => 0);
  if (n) console.log(`   ${String(n).padStart(6)}  ${name}`);
}

console.log("\nPURGING:");
let total = 0;
const present = new Set((await db.listCollections().toArray()).map((c) => c.name));
for (const name of PURGE) {
  if (!present.has(name)) continue;
  const n = await db.collection(name).countDocuments();
  if (!n) continue;
  total += n;
  console.log(`   ${String(n).padStart(6)}  ${name}`);
  if (APPLY) await db.collection(name).deleteMany({});
}

// Sync sources: keep the ones pointing at a real client sheet, drop the test leftovers.
if (present.has("syncsources")) {
  const keepN = await db.collection("syncsources").countDocuments(REAL_SOURCE);
  const dropN = await db.collection("syncsources").countDocuments({ $nor: [REAL_SOURCE] });
  if (dropN) {
    total += dropN;
    console.log(`   ${String(dropN).padStart(6)}  syncsources (test leftovers; keeping ${keepN} real client sheet${keepN === 1 ? "" : "s"})`);
    if (APPLY) await db.collection("syncsources").deleteMany({ $nor: [REAL_SOURCE] });
  }
}

// Anything neither purged nor kept is new since this script was written — surface it rather than
// silently ignoring it, so a future collection cannot quietly survive a purge it should not.
const unknown = [...present].filter((c) => !PURGE.includes(c) && !KEEP.includes(c) && c !== "syncsources" && !c.startsWith("system."));
if (unknown.length) {
  console.log("\n⚠️  NOT IN EITHER LIST — left untouched, decide explicitly:");
  for (const c of unknown) console.log(`   ${String(await db.collection(c).countDocuments()).padStart(6)}  ${c}`);
}

console.log(`\n${APPLY ? "Deleted" : "Would delete"} ${total} record(s).`);
if (!APPLY) console.log("Re-run with --apply once you have a verified backup.");

// The users we keep are the whole point of keeping anything — name them so the operator can
// confirm nobody's login is about to disappear.
const users = await db.collection("users").find({}, { projection: { email: 1, role: 1 } }).toArray();
console.log(`\nLogins preserved (${users.length}):`);
for (const u of users) console.log(`   ${u.email}  ·  ${u.role}`);

await client.close();
