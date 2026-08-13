// Prod cleanup remnants — everything the app's own DELETE /api/sync-sources/[id] cannot
// reach. Umesh 2026-08-13: "sync bhi bas issi [OneDrive] sheet pe — baaki kisi sheet ki
// tracking hata de; database dumpyard nahi banana."
//
// The heavy lifting (source delete + its workbookchanges + workbooksnapshots cascade) is
// done through the app API so its guards run (Open-inbox refusal, audit log). This script
// only sweeps what has no API:
//   1. ORPHANED workbookchanges / workbooksnapshots / tabmappings — rows whose sync_source
//      no longer exists (belt-and-braces after the API cascade; also closes the tabmappings
//      gap found in purge-unsourced.mjs's lists).
//   2. locationtargets pairs NOT in the OneDrive truth sheet — expected 0 (prod is 1:1
//      with the sheet today); reported assert-style either way.
//   3. Test-harness users (@vidysea-test.local) that leaked into prod from eval suites.
//
// It deletes NOTHING else. No collection is dropped — the 2026-08-13 inventory found all
// 36 model-backed collections live; `counters` in particular must never be touched (batch-
// code sequence). Empty feature collections stay by Umesh's decision.
//
//   MONGODB_URL=... MONGODB_DB=center_erp node scripts/cleanup-sync-remnants.mjs          # dry run
//   MONGODB_URL=... MONGODB_DB=center_erp node scripts/cleanup-sync-remnants.mjs --apply
import { MongoClient } from "mongodb";
import * as XLSX from "xlsx";

const APPLY = process.argv.includes("--apply");
const url = process.env.MONGODB_URL, dbName = process.env.MONGODB_DB;
if (!url || !dbName) { console.error("MONGODB_URL and MONGODB_DB are required."); process.exit(1); }

// The OneDrive truth workbook (same share + badger flow as seed-rpl.mjs).
const SHARE = "https://onedrive.live.com/:x:/g/personal/c1d310c499f08fba/IQBHQGQ1_HmBRZjCmC1XQMK8AQCFnOpu1H8GXm3MNvZnypE";
const SCHEME_ALIASES = {
  "RPL-AVPL": "RPL-AVPL", "AVPL - RPL": "RPL-AVPL", "AVPL-RPL": "RPL-AVPL",
  "RPL-HSL": "RPL-HSL", "HSL": "RPL-HSL",
  "PMKVY-BECIL": "PMKVY-BECIL", "BECIL": "PMKVY-BECIL",
  "DDU-GKY2.0": "DDU-GKY2.0", "DDUGKY 2.0 SPH": "DDUGKY 2.0 SPH",
};
const S = (v) => String(v ?? "").trim();

const client = new MongoClient(url);
await client.connect();
const db = client.db(dbName);
console.log(`db    ${dbName} @ ${url.replace(/\/\/.*@/, "//")}`);
console.log(`mode  ${APPLY ? "APPLY" : "dry run"}\n`);

// ---- 1. orphans: rows pointing at a sync_source that no longer exists ----
const liveSources = (await db.collection("syncsources").find({}).project({ _id: 1 }).toArray()).map((s) => s._id);
console.log(`live sync sources: ${liveSources.length}`);
for (const col of ["workbookchanges", "workbooksnapshots", "tabmappings", "sheetchanges"]) {
  const filter = { sync_source: { $nin: liveSources } };
  const n = await db.collection(col).countDocuments(filter);
  // sheetchanges is the Sync Inbox AUDIT TRAIL — never deleted, only reported, matching
  // the DELETE route's own stance ("the audit trail is the point of them").
  if (col === "sheetchanges") { console.log(`${col}: ${n} orphan(s) — audit trail, REPORT ONLY`); continue; }
  console.log(`${col}: ${n} orphan(s)${n && APPLY ? " → deleting" : ""}`);
  if (n && APPLY) console.log(`  deleted ${(await db.collection(col).deleteMany(filter)).deletedCount}`);
}

// ---- 2. locationtargets pairs vs the OneDrive truth sheet (expected: 0 stale) ----
const b64 = "u!" + Buffer.from(SHARE).toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
const tok = await (await fetch("https://api-badgerp.svc.ms/v1.0/token", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ appId: "5cbed6ac-a083-4e14-b191-b4ba07653de2" }),
})).json();
const meta = await (await fetch(
  `https://my.microsoftpersonalcontent.com/_api/v2.0/shares/${b64}/driveitem?$select=name,@content.downloadUrl`,
  { headers: { Authorization: "Badger " + tok.token, Prefer: "autoredeem", "User-Agent": "Mozilla/5.0" } },
)).json();
const wb = XLSX.read(Buffer.from(await (await fetch(meta["@content.downloadUrl"])).arrayBuffer()), { type: "buffer" });
const sheetObj = wb.Sheets["Location_Master"] ?? wb.Sheets[wb.SheetNames[0]];
const grid = XLSX.utils.sheet_to_json(sheetObj, { header: 1, defval: "" });
// Same merged-cell semantics as seed-rpl (2026-08-14): the Institution cell is MERGED per
// centre; expand merges + carry blank institutions forward, or every continuation row's
// target would be false-flagged as "not in sheet" and deleted.
for (const m of sheetObj["!merges"] ?? []) {
  const v = sheetObj[XLSX.utils.encode_cell({ r: m.s.r, c: m.s.c })]?.v;
  if (v === undefined || v === "") continue;
  for (let r = m.s.r; r <= m.e.r; r++) for (let c = m.s.c; c <= m.e.c; c++) {
    if (grid[r] && (grid[r][c] === "" || grid[r][c] === undefined)) grid[r][c] = v;
  }
}
const norm = (s) => S(s).toLowerCase().replace(/[^a-z0-9]/g, "");
const sheetPairs = new Set();
let lastInst = "";
for (const r of grid.slice(2)) {
  const inst = S(r[5]) || lastInst;
  if (S(r[5])) lastInst = S(r[5]);
  const scheme = SCHEME_ALIASES[S(r[8])], role = S(r[9]);
  if (inst && scheme && role) sheetPairs.add(`${norm(inst)}|${scheme}|${norm(role)}`);
}
console.log(`\nOneDrive pairs (centre×scheme×job-role): ${sheetPairs.size}`);
const targets = await db.collection("locationtargets").aggregate([
  { $lookup: { from: "locations", localField: "location", foreignField: "_id", as: "l" } },
  { $lookup: { from: "programs", localField: "program", foreignField: "_id", as: "p" } },
  { $project: { loc: { $arrayElemAt: ["$l.name", 0] }, scheme: { $arrayElemAt: ["$p.scheme", 0] }, role: { $arrayElemAt: ["$p.name", 0] } } },
]).toArray();
const stale = targets.filter((t) => !sheetPairs.has(`${norm(t.loc)}|${t.scheme}|${norm(t.role)}`));
console.log(`prod locationtargets: ${targets.length} — stale (not in sheet): ${stale.length}`);
for (const t of stale) console.log(`  STALE ${t.loc} · ${t.scheme} · ${t.role}${APPLY ? " → deleting" : ""}`);
if (stale.length && APPLY) {
  const r = await db.collection("locationtargets").deleteMany({ _id: { $in: stale.map((t) => t._id) } });
  console.log(`  deleted ${r.deletedCount}`);
}

// ---- 3. eval-harness users that leaked into prod ----
const ghosts = await db.collection("users").find({ email: /@vidysea-test\.local$/i }).project({ email: 1, role: 1, active: 1 }).toArray();
console.log(`\ntest-harness users: ${ghosts.length}`);
for (const g of ghosts) console.log(`  ${g.email} (${g.role}, active=${g.active})${APPLY ? " → deleting" : ""}`);
if (ghosts.length && APPLY) {
  const r = await db.collection("users").deleteMany({ _id: { $in: ghosts.map((g) => g._id) } });
  console.log(`  deleted ${r.deletedCount}`);
}

if (!APPLY) console.log("\nDry run. Re-run with --apply to write.");
await client.close();
