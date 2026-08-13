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

// ---- fetch the workbook ----
// 2026-08-13 (Umesh, superseding the same morning's Google switch): "iss [OneDrive] sheet
// ke exact column and data chahiye iss Location Master mein, aur koi nahi — this one is
// the only source of truth." Default = the client's OneDrive workbook (badger flow);
// verified before flipping back that Sonbhadra's approval now exists there too (55 rows,
// 30 approved per-row, single tab "Sheet1"). The Google export stays behind --google for
// comparison only — never as the write source for Location Master.
let wb, sourceName;
if (process.argv.includes("--google")) {
  const GURL = process.env.AVPL_SHEET_URL
    || "https://docs.google.com/spreadsheets/d/1f9veYSwuLktmggOJdUlspl_yydotdqnf/export?format=xlsx";
  const buf = Buffer.from(await (await fetch(GURL, { redirect: "follow" })).arrayBuffer());
  if (buf.slice(0, 2).toString() !== "PK") { console.error("Google sheet not readable (got HTML) — check sharing, or drop --google for the OneDrive truth sheet."); process.exit(2); }
  wb = XLSX.read(buf, { type: "buffer" });
  sourceName = "AVPL Google workbook (comparison only — NOT the source of truth)";
} else {
  const b64 = "u!" + Buffer.from(SHARE).toString("base64").replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  const tok = await (await fetch("https://api-badgerp.svc.ms/v1.0/token", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId: "5cbed6ac-a083-4e14-b191-b4ba07653de2" }),
  })).json();
  const meta = await (await fetch(
    `https://my.microsoftpersonalcontent.com/_api/v2.0/shares/${b64}/driveitem?$select=name,@content.downloadUrl`,
    { headers: { Authorization: "Badger " + tok.token, Prefer: "autoredeem", "User-Agent": "Mozilla/5.0" } },
  )).json();
  wb = XLSX.read(Buffer.from(await (await fetch(meta["@content.downloadUrl"])).arrayBuffer()), { type: "buffer" });
  sourceName = meta.name;
}
const sheet = wb.Sheets["Location_Master"] ?? wb.Sheets[wb.SheetNames[0]];
const grid = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
const meta = { name: sourceName };

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
  // The sheet's three CLAIMED trainer counts (Karunn: "chaaron cheezein le lo, soft data
  // ki tarah") — stored as *_reported beside our derived counts, never merged.
  nomRecv: col("Trainer Nomination received"),
  nomNsdc: col("Trainer Nominated to NSDC / SSC"),
  trCert: col("Trainer Certified"),
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
  } else if (S(r[IDX.tcStatus]) === "Approved") {
    // 2026-08-13 (Manish: "31 approved hain"): approval is PER ROW (centre×scheme×job-role) —
    // first-row-wins used to discard rows 2..n, undercounting approved centres too. A centre
    // with ANY approved job role is an approved centre.
    locations.get(institution).approval_status = "Approved";
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
      // "industry experience aur teaching experience required hai — mendetary hai TVP mein
      // jaane ke lie" (2026-08-12). The team drafts these for every technical job role today,
      // so every seeded role carries them on top of the universal five.
      mandatory_trainer_docs: ["Industry Experience", "Teaching Experience"],
      createdAt: new Date(), updatedAt: new Date(),
    });
  }
  targets.push({
    institution, key,
    approved_target: N(r[IDX.target]) ?? 0,
    trainers_required: N(r[IDX.trReq]),
    enrolled_reported: N(r[IDX.enrolled]),
    pending_reported: N(r[IDX.pending]),
    // Per-row government identity: each centre×scheme×job-role has its OWN TC ID + status
    // (Charthwal: TC353328 AVPL vs TC352938 HSL) — this is what "31 approved" counts.
    tc_id: S(r[IDX.tcId]) || undefined,
    tc_status: S(r[IDX.tcStatus]) || undefined,
    // Sheet-claimed trainer counts (blank cell = no claim, so undefined — never null).
    nominations_received_reported: N(r[IDX.nomRecv]) ?? undefined,
    nominated_nsdc_reported: N(r[IDX.nomNsdc]) ?? undefined,
    trainers_certified_reported: N(r[IDX.trCert]) ?? undefined,
  });
}
const approvedTargets = targets.filter((t) => t.tc_status === "Approved").length;

// ---- reconcile against the sheet's own totals before writing anything ----
const sumTarget = targets.reduce((s, t) => s + (t.approved_target || 0), 0);
const sumTrainers = targets.reduce((s, t) => s + (t.trainers_required || 0), 0);
console.log(`workbook   ${meta.name}`);
console.log(`mode       ${APPLY ? "APPLY" : "dry run"}\n`);
console.log(`locations  ${locations.size}`);
console.log(`programmes ${programs.size}   ${[...programs.values()].map((p) => p.code).join(", ")}`);
console.log(`targets    ${targets.length}   (${approvedTargets} approved per-row — Manish's approved count, from THIS sheet)`);
console.log(`sum target ${sumTarget}`);
console.log(`sum trainers required ${sumTrainers}`);
// The sheet's claimed trainer counts, reported so the dry run can be checked against the
// sheet's own header totals before anything is written.
const sumClaim = (k) => targets.reduce((s, t) => s + (t[k] ?? 0), 0);
console.log(`sheet claims  nominations received ${sumClaim("nominations_received_reported")} · nominated to NSDC ${sumClaim("nominated_nsdc_reported")} · certified ${sumClaim("trainers_certified_reported")}`);

// The states actually present — Manish says "abhi do hi hain, Haryana aur Uttar Pradesh", but
// the sheet is the master. If it still carries others, say so; do not silently seed a surprise.
const states = [...new Set([...locations.values()].map((l) => l.state).filter(Boolean))].sort();
console.log(`states     ${states.join(", ")}${states.length > 2 ? "   ⚠️ Manish said only Haryana + UP — confirm the extra rows" : ""}`);

// The client's stated fixed target vs what the rows add up to. Their own header disagrees with
// their own rows; the variance is reported, never "fixed" — that reconciliation is Manish's call.
const CLIENT_FIXED_TARGET = 12398; // "ye 12398 ye fix target hai" (2026-08-12)
if (sumTarget !== CLIENT_FIXED_TARGET) {
  console.log(`⚠️  client says the fixed target is ${CLIENT_FIXED_TARGET}; the sheet's usable rows sum to ${sumTarget} (difference ${CLIENT_FIXED_TARGET - sumTarget}, incl. any skipped rows below). Reported as-is for Manish to reconcile.`);
}
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
  // undefined stripped: absent = "no opinion", never null-out (same lesson as seed-avpl-master).
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  await db.collection("locationtargets").updateOne(
    { location, program },
    { $set: clean({
      location, program,
      approved_target: t.approved_target, trainers_required: t.trainers_required,
      enrolled_reported: t.enrolled_reported, pending_reported: t.pending_reported,
      tc_id: t.tc_id, tc_status: t.tc_status,
      nominations_received_reported: t.nominations_received_reported,
      nominated_nsdc_reported: t.nominated_nsdc_reported,
      trainers_certified_reported: t.trainers_certified_reported,
      reported_at: new Date(), updatedAt: new Date(),
    }), $setOnInsert: { createdAt: new Date() } },
    { upsert: true },
  );
  written++;
}
console.log(`\nWrote ${locations.size} locations, ${programs.size} programmes, ${written} targets.`);
await client.close();
