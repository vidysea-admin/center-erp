// Build the Gurugram rosters from the AVPL master's own batch tabs, and stamp portal Candidate
// IDs (CAN_…) from the government attendance export — the missing link that left 17 batches
// with zero members and a zero dashboard (found 2026-08-13).
//
//   node scripts/seed-gurugram-roster.mjs                       → dry run (report only)
//   node scripts/seed-gurugram-roster.mjs --apply               → write
//   CSV=path\to\Attendance.csv overrides the attendance file.
//
// The tab IS the roster: everyone on "Gurugram - 6th July Batch" belongs to that batch. They are
// attending per the portal export, ergo enrolled (reg/kyc/accept done, enrollment Completed).
// Anything unmatchable is REPORTED BY NAME, never guessed — the seed-avpl-master discipline.
import { readFileSync } from "node:fs";
import mongoose from "mongoose";
import * as XLSX from "xlsx";
import { requireSafeDb } from "./db-guard.mjs";

const URL = process.env.AVPL_SHEET_URL
  || "https://docs.google.com/spreadsheets/d/1f9veYSwuLktmggOJdUlspl_yydotdqnf/export?format=xlsx";
const CSV_PATH = process.env.CSV || "d:\\erp\\qa\\fixtures\\Attendance_till-11-Aug.csv";
const APPLY = process.argv.includes("--apply");

if (!process.env.MONGODB_URL || !process.env.MONGODB_DB) {
  console.error("MONGODB_URL and MONGODB_DB must both be set. Refusing to guess which database.");
  process.exit(1);
}

const S = (v) => String(v ?? "").trim();
const norm = (v) => S(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const phone10 = (v) => { const d = S(v).replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };

// ---- sources ----
const res = await fetch(URL, { redirect: "follow" });
const buf = Buffer.from(await res.arrayBuffer());
if (buf.slice(0, 2).toString() !== "PK") { console.error("Workbook not readable (HTML, not xlsx)."); process.exit(2); }
const wb = XLSX.read(buf, { type: "buffer" });

const csvText = readFileSync(CSV_PATH, "utf-8");
// Minimal CSV parse tolerant of the quoted multi-line "Details" blob.
function parseCsv(text) {
  const rows = []; let row = [], cell = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch; }
    else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => S(c) !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  if (cell !== "" || row.length) row.push(cell);
  if (row.length && row.some((c) => S(c) !== "")) rows.push(row);
  return rows;
}
const csvRows = parseCsv(csvText);
const csvHeader = csvRows[0].map((h) => norm(h));
const ci = (name) => csvHeader.findIndex((h) => h === norm(name));
const IX = { name: ci("Name"), can: ci("Candidate ID"), org: ci("Org Name"), present: ci("Total Days Present"), working: ci("Total Working days") };
if (IX.name < 0 || IX.can < 0) { console.error("CSV header missing Name/Candidate ID columns:", csvRows[0]); process.exit(2); }
const portal = csvRows.slice(1)
  .filter((r) => S(r[IX.can]).toUpperCase().startsWith("CAN"))
  .map((r) => ({ name: S(r[IX.name]), can: S(r[IX.can]).toUpperCase(), org: S(r[IX.org]), present: S(r[IX.present]), working: S(r[IX.working]) }));

await mongoose.connect(process.env.MONGODB_URL, { dbName: requireSafeDb("seed-gurugram-roster"), serverSelectionTimeoutMS: 15000 });
const db = mongoose.connection.db;

const report = { members: 0, existing: 0, can_ids: 0, skipped: [], batches: [], created: [] };

// ---- resolve the two Gurugram batches by location + start date ----
const gurugram = await db.collection("locations").findOne({ name: /gurugram/i });
if (!gurugram) { console.error("No Gurugram location found."); process.exit(2); }
const batches = await db.collection("batches").find({ location: gurugram._id }).toArray();
function batchNear(day, month) {
  const hits = batches.filter((b) => {
    const d = b.planned_start ? new Date(b.planned_start) : null;
    return d && d.getUTCMonth() === month && Math.abs(d.getUTCDate() - day) <= 3;
  });
  return hits.length === 1 ? hits[0] : null;
}
// Roster sources differ deliberately (dry-run finding 2026-08-13):
// - The 6th-July tab holds exactly 45 phone-carrying rows = the batch's target_size 45 → the
//   tab IS that roster.
// - The 28th-July tab mixes a lead list + a pasted process document (189 phone matches — NOT a
//   roster). The government attendance export (38 trainees, Total Working Days 11 ≈ 30 Jul →
//   11 Aug) is the authoritative roster for GGM-DST-02: whoever the portal tracks, attends.
const TABS = [
  { tab: "Gurugram - 6th July Batch", batch: batchNear(6, 6), source: "tab" },
  { tab: "Gurugram - 28th July Batch", batch: batchNear(28, 6), source: "csv" },
];

// TC identity: the portal file resolves the centre by this — set it if the sheet never carried it.
const tcFromCsv = (portal[0]?.org.match(/TC\d+/) ?? [])[0];
if (tcFromCsv && !gurugram.tc_id) {
  report.batches.push(`location "${gurugram.name}": set tc_id ${tcFromCsv} (was empty — portal file resolves by it)`);
  if (APPLY) await db.collection("locations").updateOne({ _id: gurugram._id }, { $set: { tc_id: tcFromCsv } });
}

const allCands = await db.collection("candidates").find({}).project({ name: 1, phone: 1, sidh_candidate_id: 1, lifecycle_status: 1 }).toArray();
const byPhone = new Map(allCands.map((c) => [phone10(c.phone) || c.phone, c]));
const now = new Date();

async function enrol(batch, cand, start) {
  const existing = await db.collection("batchmembers").findOne({ candidate: cand._id, left_on: null });
  if (existing) { report.existing++; return false; }
  report.members++;
  if (APPLY) {
    await db.collection("batchmembers").insertOne({
      batch: batch._id, candidate: cand._id, joined_on: start, left_on: null,
      enrollment_status: "Completed",
      reg_done: true, reg_done_at: start, kyc_done: true, kyc_done_at: start, accept_done: true, accept_done_at: start,
      issue: null, source: "Manual", createdAt: now, updatedAt: now,
    });
    await db.collection("candidates").updateOne({ _id: cand._id }, { $set: { lifecycle_status: "Enrolled", sidh_status: "Registered", updatedAt: now } });
  }
  return true;
}

// Name lookup for the CSV: Gurugram-located candidates first, then anyone (fuzzy imports parked
// some people under other centres). "DUP" = two share the name → hand-fix, never guess.
const ggmCands = await db.collection("candidates").find({ location: gurugram._id }).project({ name: 1, sidh_candidate_id: 1 }).toArray();
function nameMap(cands) {
  const m = new Map();
  for (const c of cands) { const k = norm(c.name); m.set(k, m.has(k) ? "DUP" : c); }
  return m;
}
const byNameGgm = nameMap(ggmCands);
const byNameAll = nameMap(allCands);
const findByName = (nm) => byNameGgm.get(norm(nm)) ?? byNameAll.get(norm(nm)) ?? null;

for (const { tab, batch, source } of TABS) {
  if (!batch) { report.skipped.push(`tab "${tab}": no unique Gurugram batch near that date — codes: ${batches.map((b) => b.code).join(", ")}`); continue; }
  const start = batch.planned_start ? new Date(batch.planned_start) : now;
  let added = 0;

  if (source === "tab") {
    const sheet = wb.Sheets[tab];
    if (!sheet) { report.skipped.push(`tab "${tab}" not found in workbook`); continue; }
    const raw = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: false }).map((r) => r.map((c) => S(c)));
    const hIdx = raw.findIndex((r) => r.some((c) => norm(c) === "name"));
    if (hIdx < 0) { report.skipped.push(`tab "${tab}": no Name header`); continue; }
    const header = raw[hIdx].map((h) => norm(h));
    const nameI = header.findIndex((h) => h === "name");
    const phoneI = header.findIndex((h) => h === "mobile" || h === "phone" || h === "mobile number");
    for (let r = hIdx + 1; r < raw.length; r++) {
      const nm = S(raw[r][nameI]); const ph = phone10(raw[r][phoneI]);
      if (!nm || !ph) continue; // headings/process rows — a roster row carries a phone
      const cand = byPhone.get(ph);
      if (!cand) { report.skipped.push(`"${nm}" (${tab}): no candidate with phone ${ph}`); continue; }
      if (await enrol(batch, cand, start)) added++;
    }
  } else {
    // source === "csv": the portal's 38 tracked trainees ARE this batch's roster.
    for (const p of portal) {
      let cand = findByName(p.name);
      if (cand === "DUP") { report.skipped.push(`CSV "${p.name}" (${p.can}): two candidates share this name — assign the CAN id by hand, then re-run`); continue; }
      if (!cand) {
        // The portal is tracking a real attending trainee the ERP never captured. Create them —
        // placeholder phone (NA-<CAN>) per the established convention, everything reported.
        report.created.push(`${p.name} (${p.can}) — new candidate, placeholder phone`);
        if (APPLY) {
          const ins = await db.collection("candidates").insertOne({
            name: p.name, phone: "NA-" + p.can, location: gurugram._id, program: batch.program,
            lifecycle_status: "Unassigned", sidh_status: "Registered", sidh_candidate_id: p.can,
            source: "govt attendance export 11 Aug", createdAt: now, updatedAt: now,
          });
          cand = { _id: ins.insertedId, name: p.name };
        } else {
          report.members++; added++; continue; // dry-run: count the would-be member
        }
      }
      if (cand && S(cand.sidh_candidate_id) !== p.can) {
        report.can_ids++;
        if (APPLY) await db.collection("candidates").updateOne({ _id: cand._id }, { $set: { sidh_candidate_id: p.can, sidh_status: "Registered", updatedAt: now } });
      }
      if (cand && await enrol(batch, cand, start)) added++;
    }
  }

  report.batches.push(`${batch.code} ← ${source === "tab" ? `"${tab}"` : "attendance CSV"}: +${added} members, actual_start ${start.toISOString().slice(0, 10)}, status ${batch.status} → Active`);
  if (APPLY) await db.collection("batches").updateOne({ _id: batch._id }, { $set: { actual_start: start, status: "Active", updatedAt: now } });
}

console.log(`${APPLY ? "APPLIED" : "DRY RUN"} against ${process.env.MONGODB_DB}`);
console.log(`Portal rows: ${portal.length} (all ${tcFromCsv ?? "?"})`);
for (const b of report.batches) console.log("  batch: " + b);
console.log(`  members to create: ${report.members} (already members: ${report.existing})`);
console.log(`  CAN ids to stamp: ${report.can_ids}`);
if (report.created.length) {
  console.log(`  NEW candidates from the portal export (${report.created.length}):`);
  for (const c of report.created) console.log("    + " + c);
}
if (report.skipped.length) {
  console.log(`  SKIPPED — every one named (${report.skipped.length}):`);
  for (const s of report.skipped) console.log("    - " + s);
}
await mongoose.disconnect();
