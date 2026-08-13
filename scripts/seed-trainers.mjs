// Individual-trainer ingestion from Manish's trainer master sheet (2026-08-13).
// The sheet: https://docs.google.com/spreadsheets/d/1f9veYSwuLktmggOJdUlspl_yydotdqnf
// — trainer names, companies, registered/accepted/certified status, back-date planning points.
//
// DESIGN: inventory first, map second, write last — never guess a column.
//   1. No args        → print every tab, its headers and row count, then exit. This output is
//                       what the TAB_MAPPINGS below get written FROM (real headers, not guesses).
//   2. Dry run        → once TAB_MAPPINGS is filled: parse + report what WOULD be written,
//                       including every unmapped row with the reason.
//   3. --apply        → write Trainer rows. Refuses without an explicit MONGODB_DB.
//
// GATE: the sheet must be shared "anyone with link → Viewer". Until then this script prints the
// Google sign-in wall and stops — that is the signal to ask Umesh, not to work around it.
import mongoose from "mongoose";
import * as XLSX from "xlsx";

const SHEET_URL = process.env.TRAINER_SHEET_URL
  || "https://docs.google.com/spreadsheets/d/1f9veYSwuLktmggOJdUlspl_yydotdqnf/export?format=xlsx";
const APPLY = process.argv.includes("--apply");

// Filled from the REAL inventory output of step 1. Empty = inventory-only mode.
// Shape per tab: { tab: "<tab name>", header_row_contains: "<a header cell>", columns: {
//   name: "<col>", phone: "<col>", location: "<col>", job_role: "<col>", company: "<col>",
//   status: "<col>", tr_id: "<col>", tot_date: "<col>" } }
const TAB_MAPPINGS = [];

// Status text in the sheet → pipeline stage. Extend from the real inventory; anything not
// listed is REPORTED, never guessed into a stage.
const STATUS_ALIASES = {
  "shortlisted": "Shortlisted",
  "documents pending": "Docs Pending",
  "documents received": "Docs Complete",
  "registered": "Docs Complete",          // registered on SIDH = profile built, papers in
  "nominated": "Submitted to NSDC",
  "nominated to nsdc": "Submitted to NSDC",
  "approved": "NSDC Approved",
  "accepted": "NSDC Approved",
  "rejected": "NSDC Rejected",
  "payment done": "Payment Done",
  "tot scheduled": "TOT Scheduled",
  "tot done": "Certified",
  "certified": "Certified",
  "dropped": "Dropped",
};

const res = await fetch(SHEET_URL, { redirect: "follow" });
const buf = Buffer.from(await res.arrayBuffer());
if (buf.slice(0, 5).toString().startsWith("<!DO") || buf.slice(0, 2).toString() !== "PK") {
  console.error("❌ The sheet is still locked (Google returned a sign-in page, not a workbook).");
  console.error("   Ask Umesh: Share → General access → 'Anyone with the link' → Viewer.");
  process.exit(2);
}

const wb = XLSX.read(buf, { type: "buffer" });
console.log(`workbook: ${wb.SheetNames.length} tab(s)\n`);
for (const name of wb.SheetNames) {
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" });
  const nonEmpty = rows.filter((r) => r.some((c) => String(c).trim()));
  console.log(`TAB "${name}" — ${nonEmpty.length} non-empty rows`);
  for (let i = 0; i < Math.min(3, nonEmpty.length); i++) {
    console.log(`   r${i}: ${JSON.stringify(nonEmpty[i].slice(0, 14)).slice(0, 220)}`);
  }
  console.log("");
}

if (!TAB_MAPPINGS.length) {
  console.log("Inventory only — TAB_MAPPINGS is empty. Fill it from the headers above, then dry-run.");
  process.exit(0);
}

// ---- mapping mode (runs once TAB_MAPPINGS is filled from the real inventory) ----
if (!process.env.MONGODB_URL || !process.env.MONGODB_DB) {
  console.error("MONGODB_URL and MONGODB_DB must both be set. Refusing to guess which database.");
  process.exit(1);
}
await mongoose.connect(process.env.MONGODB_URL, { dbName: process.env.MONGODB_DB, serverSelectionTimeoutMS: 10000 });
const db = mongoose.connection.db;

const locations = await db.collection("locations").find({}).project({ name: 1, district: 1, city: 1 }).toArray();
const programs = await db.collection("programs").find({}).project({ name: 1, code: 1, trainer_skill: 1 }).toArray();
const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const findLocation = (v) => locations.find((l) => norm(l.name).includes(norm(v)) || norm(v).includes(norm(l.district ?? "")) && norm(l.district ?? "")) ?? null;
const findProgram = (v) => programs.find((p) => norm(p.name) === norm(v) || norm(p.trainer_skill) === norm(v)) ?? null;

const out = [], skipped = [];
for (const m of TAB_MAPPINGS) {
  const sheet = wb.Sheets[m.tab];
  if (!sheet) { skipped.push({ tab: m.tab, why: "tab not found" }); continue; }
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }).map((r) => r.map((c) => String(c ?? "").trim()));
  const hi = rows.findIndex((r) => r.includes(m.header_row_contains));
  if (hi === -1) { skipped.push({ tab: m.tab, why: `header cell "${m.header_row_contains}" not found` }); continue; }
  const header = rows[hi];
  const col = (key) => { const c = m.columns[key]; return c ? header.indexOf(c) : -1; };
  for (const [i, r] of rows.slice(hi + 1).entries()) {
    const name = col("name") >= 0 ? r[col("name")] : "";
    if (!name) continue;
    const loc = col("location") >= 0 ? findLocation(r[col("location")]) : null;
    const prog = col("job_role") >= 0 ? findProgram(r[col("job_role")]) : null;
    const statusRaw = col("status") >= 0 ? r[col("status")] : "";
    const stage = STATUS_ALIASES[norm(statusRaw)] ?? null;
    if (statusRaw && !stage) { skipped.push({ tab: m.tab, row: hi + i + 2, why: `unknown status "${statusRaw}" (${name})` }); continue; }
    out.push({
      name,
      phone: col("phone") >= 0 ? r[col("phone")].replace(/\D/g, "").slice(-10) : "",
      source: col("company") >= 0 ? r[col("company")] : m.tab,
      skills: prog ? [prog.trainer_skill] : [],
      nominated_for_location: loc?._id, nominated_for_program: prog?._id,
      pipeline_status: stage ?? "Applied",
      tr_id: col("tr_id") >= 0 ? r[col("tr_id")] || undefined : undefined,
      active: stage !== "Dropped",
      _trace: { tab: m.tab, row: hi + i + 2, loc: loc?.name ?? `UNMATCHED "${col("location") >= 0 ? r[col("location")] : ""}"` },
    });
  }
}

console.log(`\nwould write ${out.length} trainer(s); ${skipped.length} skipped`);
for (const s of skipped.slice(0, 20)) console.log(`   SKIP ${s.tab} r${s.row ?? "-"}: ${s.why}`);
const byStage = {};
for (const t of out) byStage[t.pipeline_status] = (byStage[t.pipeline_status] ?? 0) + 1;
console.log("by stage:", JSON.stringify(byStage));

if (!APPLY) { console.log("\nDry run. Re-run with --apply to write."); await mongoose.disconnect(); process.exit(0); }

let written = 0;
for (const t of out) {
  const { _trace, ...doc } = t;
  if (!doc.phone) { skipped.push({ tab: _trace.tab, row: _trace.row, why: `no phone (${doc.name}) — phone is the unique key` }); continue; }
  await db.collection("trainers").updateOne(
    { phone: doc.phone },
    { $set: { ...doc, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date(), eligibility_payment_amount: 3250, max_concurrent_batches: 4, status: "Available" } },
    { upsert: true },
  );
  written++;
}
console.log(`\nWrote ${written} trainer(s).`);
await mongoose.disconnect();
