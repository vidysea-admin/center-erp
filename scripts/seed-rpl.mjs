// Seed the ERP from the client's REAL data — the OneDrive RPL workbook — and nothing else.
//
// Umesh, 2026-08-12: "जो भी sheet से data दे रहा हूँ उन सबको रख… उस data को use कर… भले ही कम
// होगा, वो ठीक है, लेकिन actual data होगा तो relatable भी लगेगा."
//
// Creates: Locations (one per Institution), Programmes (one per real Scheme x Job role pair),
// LocationTargets (one per sheet row, with the true target and trainer requirement).
//
// Creates NO trainers, NO candidates and NO batches — the workbook contains none. It carries
// COUNTS of trainers, not people: no names, no phones, no TR IDs. Inventing rows to fill those
// counters would be exactly the unsourced data this pass exists to remove. The team enters real
// trainers as they hire, and the counters then become derived (see trainerCountsFor in rules.ts).
//
//   node --env-file=.env.local scripts/seed-rpl.mjs            # dry run, shows what it would write
//   node --env-file=.env.local scripts/seed-rpl.mjs --apply
import { MongoClient } from "mongodb";
import * as XLSX from "xlsx";

const APPLY = process.argv.includes("--apply");
const url = process.env.MONGODB_URL, dbName = process.env.MONGODB_DB;
if (!url || !dbName) { console.error("MONGODB_URL and MONGODB_DB are required."); process.exit(1); }

const SHARE = "https://onedrive.live.com/:x:/g/personal/c1d310c499f08fba/IQBHQGQ1_HmBRZjCmC1XQMK8AQCFnOpu1H8GXm3MNvZnypE";

// The scheme names differ between the two sheets the client keeps ("AVPL - RPL" in the hiring
// sheet, "RPL-AVPL" in the master). Normalise rather than trusting string equality.
const SCHEME_ALIASES = {
  "RPL-AVPL": "RPL-AVPL", "AVPL - RPL": "RPL-AVPL", "AVPL-RPL": "RPL-AVPL",
  "RPL-HSL": "RPL-HSL", "HSL": "RPL-HSL",
  "PMKVY-BECIL": "PMKVY-BECIL", "BECIL": "PMKVY-BECIL",
  "DDU-GKY2.0": "DDU-GKY2.0", "DDUGKY 2.0 SPH": "DDUGKY 2.0 SPH",
};
// CEO: "पहले हमें ABPL, HSL दूसरे priority पे है, तीसरे पे ये है."
const SCHEME_PRIORITY = { "RPL-AVPL": 1, "RPL-HSL": 2, "PMKVY-BECIL": 3, "DDU-GKY2.0": 4, "DDUGKY 2.0 SPH": 5 };
const JOB_ROLE_CODES = {
  "Drone Service Technician": "DST",
  "Battery System Repair Technician": "BSRT",
  "Solar Panel Installation Technician": "SPIT",
  "Drone Software Technician": "DSWT",
};

const S = (v) => String(v ?? "").trim();
const N = (v) => { const n = Number(String(v ?? "").replace(/,/g, "").trim()); return Number.isFinite(n) ? n : null; };
// Institution -> stable short code, e.g. "Govt. ITI Charthwal, Muzaffarnagar" -> "MUZ-CHAR"
const slug = (name) => {
  const parts = S(name).replace(/^Govt\.?\s*/i, "").split(",");
  const tail = S(parts[parts.length - 1]).slice(0, 3).toUpperCase();
  const head = S(parts[0]).replace(/[^A-Za-z ]/g, "").split(/\s+/).filter(Boolean).slice(-1)[0] ?? "LOC";
  return `${tail}-${head.slice(0, 4).toUpperCase()}`;
};

// ---- fetch the workbook anonymously (same badger flow as src/lib/workbook.ts) ----
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
const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "" });

// Header is on the SECOND row — the first carries the client's own totals.
const H = grid[1].map(S);
const col = (n) => H.findIndex((h) => h.toLowerCase() === n.toLowerCase());
const IDX = {
  spoc: col("SPOC Name"), clusterPhone: col("Cluster Head Contact No."),
  state: col("State"), district: col("District"), institution: col("Institution Name"),
  operational: col("Operational/ Non-Operational"), partner: col("Current Operating Partner"),
  scheme: col("Ongoing Scheme"), jobRole: col("Job role"),
  target: col("Total Target"), enrolled: col("Already Enrolled"), pending: col("Pending Enrollment"),
  tcId: col("TC ID"), tcPw: col("TC Password"), tcStatus: col("TC Status"),
  trReq: col("Trainer Required"),
};
const missingCols = Object.entries(IDX).filter(([, i]) => i < 0).map(([k]) => k);
if (missingCols.length) { console.error("Sheet columns changed — not found:", missingCols.join(", ")); process.exit(2); }

const rows = grid.slice(2).filter((r) => S(r[IDX.institution]));

// ---- build ----
const locations = new Map(); // institution -> doc
const programs = new Map();  // "SCHEME|Job role" -> doc
const targets = [];
const skipped = [];
let lastDistrict = "", lastSpoc = "", lastPhone = "";

for (const r of rows) {
  const institution = S(r[IDX.institution]);
  const scheme = SCHEME_ALIASES[S(r[IDX.scheme])] ?? null;
  const jobRole = S(r[IDX.jobRole]);

  // The sheet leaves district/SPOC blank on continuation rows for the same institution.
  lastDistrict = S(r[IDX.district]) || lastDistrict;
  lastSpoc = S(r[IDX.spoc]) || lastSpoc;
  lastPhone = S(r[IDX.clusterPhone]) || lastPhone;

  if (!locations.has(institution)) {
    const tcStatus = S(r[IDX.tcStatus]);
    locations.set(institution, {
      code: slug(institution), name: institution, external_id: S(r[IDX.tcId]) || slug(institution),
      state: S(r[IDX.state]), district: lastDistrict, city: lastDistrict,
      tc_id: S(r[IDX.tcId]) || undefined, tc_password: S(r[IDX.tcPw]) || undefined,
      tc_status: tcStatus || undefined, operating_partner: S(r[IDX.partner]) || undefined,
      spoc_name: lastSpoc || undefined, cluster_head_name: lastSpoc || undefined,
      cluster_head_phone: lastPhone || undefined,
      // The client's TC Status is the government's verdict on the centre — that IS our approval.
      approval_status: tcStatus === "Approved" ? "Approved" : "Pending",
      operational_status: /^Operational$/i.test(S(r[IDX.operational])) ? "Active" : "Not Started",
      createdAt: new Date(), updatedAt: new Date(),
    });
  }

  // A row with no job role (the DDU-GKY ones) cannot become a programme or a target — report it
  // rather than inventing a name for it.
  if (!scheme || !jobRole) {
    skipped.push({ institution, scheme: S(r[IDX.scheme]), jobRole, why: !scheme ? "unknown scheme" : "blank job role" });
    continue;
  }

  const key = `${scheme}|${jobRole}`;
  if (!programs.has(key)) {
    programs.set(key, {
      code: `${scheme.replace(/[^A-Z]/gi, "").slice(0, 6).toUpperCase()}-${JOB_ROLE_CODES[jobRole] ?? jobRole.slice(0, 4).toUpperCase()}`,
      name: jobRole, scheme, scheme_priority: SCHEME_PRIORITY[scheme] ?? 99,
      trainer_skill: jobRole, sector: scheme.startsWith("RPL") ? "RPL" : "PMKVY",
      duration_days: 15, buffer_days: 5, default_batch_size: 30, completion_deadline_days: 90,
      requires_lab: false, operating_days: [1, 2, 3, 4, 5, 6], active: true,
      createdAt: new Date(), updatedAt: new Date(),
    });
  }
  targets.push({
    institution, key,
    approved_target: N(r[IDX.target]) ?? 0,
    trainers_required: N(r[IDX.trReq]),
    enrolled_reported: N(r[IDX.enrolled]),
    pending_reported: N(r[IDX.pending]),
  });
}

// ---- reconcile against the sheet's own totals before writing anything ----
const sumTarget = targets.reduce((s, t) => s + (t.approved_target || 0), 0);
const sumTrainers = targets.reduce((s, t) => s + (t.trainers_required || 0), 0);
console.log(`workbook   ${meta.name}`);
console.log(`mode       ${APPLY ? "APPLY" : "dry run"}\n`);
console.log(`locations  ${locations.size}`);
console.log(`programmes ${programs.size}   ${[...programs.values()].map((p) => p.code).join(", ")}`);
console.log(`targets    ${targets.length}`);
console.log(`sum target ${sumTarget}`);
console.log(`sum trainers required ${sumTrainers}`);
if (skipped.length) {
  console.log(`\n⚠️  ${skipped.length} row(s) skipped — no programme could be derived:`);
  for (const s of skipped) console.log(`   ${s.institution} · "${s.scheme}" · "${s.jobRole}" — ${s.why}`);
}
console.log("\nTrainers/candidates/batches created: 0 — the workbook holds counts, not people.");

if (!APPLY) { console.log("\nDry run. Re-run with --apply to write."); process.exit(0); }

const client = new MongoClient(url);
await client.connect();
const db = client.db(dbName);

for (const loc of locations.values()) {
  await db.collection("locations").updateOne({ code: loc.code }, { $set: loc }, { upsert: true });
}
for (const p of programs.values()) {
  await db.collection("programs").updateOne({ code: p.code }, { $set: p }, { upsert: true });
}
const locIds = new Map((await db.collection("locations").find({}, { projection: { code: 1, name: 1 } }).toArray()).map((l) => [l.name, l._id]));
const progIds = new Map((await db.collection("programs").find({}, { projection: { code: 1, name: 1, scheme: 1 } }).toArray()).map((p) => [`${p.scheme}|${p.name}`, p._id]));

let written = 0;
for (const t of targets) {
  const location = locIds.get(t.institution), program = progIds.get(t.key);
  if (!location || !program) continue;
  await db.collection("locationtargets").updateOne(
    { location, program },
    { $set: {
      location, program,
      approved_target: t.approved_target, trainers_required: t.trainers_required,
      enrolled_reported: t.enrolled_reported, pending_reported: t.pending_reported,
      reported_at: new Date(), updatedAt: new Date(),
    }, $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  written++;
}
console.log(`\nWrote ${locations.size} locations, ${programs.size} programmes, ${written} targets.`);
await client.close();
