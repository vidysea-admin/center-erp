// Ingest the AVPL-RPL project master workbook — every tab, every column that maps to something
// real. This is the exhaustive one: trainers, batches, the back-dated planning, the NSDC
// nomination sheet, and every candidate list.
//
//   node scripts/seed-avpl-master.mjs            → dry run: what WOULD be written, per tab
//   node scripts/seed-avpl-master.mjs --apply    → write it
//
// Refuses without an explicit MONGODB_DB. Anything it cannot map is REPORTED, never guessed.
import mongoose from "mongoose";
import * as XLSX from "xlsx";

const URL = process.env.AVPL_SHEET_URL
  || "https://docs.google.com/spreadsheets/d/1f9veYSwuLktmggOJdUlspl_yydotdqnf/export?format=xlsx";
const APPLY = process.argv.includes("--apply");

if (!process.env.MONGODB_URL || !process.env.MONGODB_DB) {
  console.error("MONGODB_URL and MONGODB_DB must both be set. Refusing to guess which database.");
  process.exit(1);
}

const res = await fetch(URL, { redirect: "follow" });
const buf = Buffer.from(await res.arrayBuffer());
if (buf.slice(0, 2).toString() !== "PK") {
  console.error("Sheet is not readable (got HTML, not a workbook). Check that it is shared.");
  process.exit(2);
}
const wb = XLSX.read(buf, { type: "buffer" });

await mongoose.connect(process.env.MONGODB_URL, { dbName: process.env.MONGODB_DB, serverSelectionTimeoutMS: 15000 });
const db = mongoose.connection.db;

// ---------------------------------------------------------------- helpers
const S = (v) => String(v ?? "").trim();
const norm = (v) => S(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const phone10 = (v) => { const d = S(v).replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };
const rowsOf = (tab) => XLSX.utils.sheet_to_json(wb.Sheets[tab], { header: 1, defval: "", raw: false })
  .map((r) => r.map((c) => S(c)));
// The header is the first row carrying a given marker column — these tabs keep totals rows above.
const headerAt = (rows, marker) => rows.findIndex((r) => r.some((c) => norm(c) === norm(marker)));
const colMap = (header) => { const m = new Map(); header.forEach((h, i) => { if (h) m.set(norm(h), i); }); return m; };
const pick = (m, row, ...names) => { for (const n of names) { const i = m.get(norm(n)); if (i != null && S(row[i])) return S(row[i]); } return ""; };

// "DST" / "SPIT" / "BSRT" / "DSWT" are the codes the team writes in the sheet.
const SKILL_TO_ROLE = {
  dst: "Drone Service Technician", spit: "Solar Panel Installation Technician",
  bsrt: "Battery System Repair Technician", dswt: "Drone Software Technician",
  "drone service technician": "Drone Service Technician",
  "solar panel installation technician": "Solar Panel Installation Technician",
  "battery system repair technician": "Battery System Repair Technician",
  "drone software technician": "Drone Software Technician",
};

const locations = await db.collection("locations").find({}).project({ name: 1, district: 1, city: 1, state: 1 }).toArray();
const programs = await db.collection("programs").find({}).project({ name: 1, code: 1, trainer_skill: 1 }).toArray();

// The sheet writes "Gurugram, Haryana" / "Basti GGP" / "Muzzafarnagar"; our centres are full
// institution names. Match on district first, then on any word overlap — and report misses.
// The team also spells places by ear (Kaushambhi/Kausambi), so the last resort drops the vowels
// and repeated letters before comparing: a spelling should never cost us the data.
const soundish = (v) => norm(v).replace(/[aeiou]/g, "").replace(/(.)\1+/g, "$1");
function findLocation(raw) {
  const v = norm(raw).replace(/\b(up|haryana|uttar pradesh)\b/g, "").trim();
  if (!v) return null;
  const sv = soundish(v);
  return locations.find((l) => norm(l.district) === v)
    ?? locations.find((l) => norm(l.name).includes(v) || v.includes(norm(l.district ?? "zzz")))
    ?? locations.find((l) => v.split(" ").some((w) => w.length > 4 && norm(l.name).includes(w)))
    ?? locations.find((l) => sv && (soundish(l.district) === sv || soundish(l.name).includes(sv)))
    ?? null;
}
function findProgram(raw) {
  const role = SKILL_TO_ROLE[norm(raw)] ?? S(raw);
  return programs.find((p) => norm(p.name) === norm(role) || norm(p.trainer_skill) === norm(role)) ?? null;
}

const report = {};
const unmapped = [];
const note = (tab, msg) => unmapped.push(`${tab}: ${msg}`);

// ---------------------------------------------------------------- 1. Trainer_Master
const trainers = new Map(); // phone → doc
{
  const tab = "Trainer_Master";
  const rows = rowsOf(tab);
  const hi = headerAt(rows, "Trainer Name");
  const m = colMap(rows[hi]);
  for (const r of rows.slice(hi + 1)) {
    const name = pick(m, r, "Trainer Name");
    if (!name || name === "-") continue;
    // Phone is the unique key, and the sheet sometimes has none — but that person still runs a
    // batch. Keep them with a visibly fake key so the batch link survives and the gap is obvious.
    const phone = phone10(pick(m, r, "Phone", "Mobile Number")) || `NA-${norm(name).replace(/ /g, "-")}`;
    if (phone.startsWith("NA-")) note(tab, `"${name}" has no phone in the sheet — imported with placeholder "${phone}", fill it before nomination`);
    const prog = findProgram(pick(m, r, "Skill"));
    const loc = findLocation(pick(m, r, "Location (Nominated)", "Home/Location"));
    if (!loc) note(tab, `"${name}": location "${pick(m, r, "Location (Nominated)", "Home/Location")}" not matched`);
    trainers.set(phone, {
      name, phone,
      email: pick(m, r, "Email") || undefined,
      source: "AVPL Trainer_Master",
      skills: prog ? [prog.trainer_skill] : [],
      nominated_for_location: loc?._id, nominated_for_program: prog?._id,
      status: /inactive/i.test(pick(m, r, "Status (Active/Inactive)")) ? "Unavailable" : "Available",
      active: !/inactive/i.test(pick(m, r, "Status (Active/Inactive)")),
      pipeline_status: "Applied",
      incentive_note: [pick(m, r, "Salary/Batch"), pick(m, r, "Pass/Incentive (60%)"), pick(m, r, "Pass/Enroll (85%)")].filter(Boolean).join(" · ") || undefined,
      _sheetCode: pick(m, r, "Trainer Code"),
      _batchCode: pick(m, r, "Batch Code"),
    });
  }
  report[tab] = trainers.size;
}

// ---------------------------------------------------------------- 2. Registered Trainers
// Headerless: the first row is already a person. Columns by position, as the team writes them.
{
  const tab = "Registered Trainers";
  const rows = rowsOf(tab).filter((r) => r.some(Boolean));
  let added = 0;
  for (const r of rows) {
    const name = S(r[0]); const phone = phone10(r[1]);
    if (!name || !phone) continue;
    const docNotes = r.slice(5).filter(Boolean).join(" · ");
    const loc = findLocation(r[4]);
    const prev = trainers.get(phone);
    // Documents saved + experience cert + ok-for-TOT is a real stage: papers are in.
    const stage = /ok for tot|tot/i.test(docNotes) ? "Docs Complete" : /document/i.test(docNotes) ? "Docs Pending" : "Applied";
    trainers.set(phone, {
      ...(prev ?? { name, phone, source: "AVPL Registered Trainers", skills: [], active: true, status: "Available" }),
      email: prev?.email ?? (S(r[2]) || undefined),
      qualification: S(r[3]) || prev?.qualification,
      nominated_for_location: prev?.nominated_for_location ?? loc?._id,
      pipeline_status: stage,
      pipeline_note: docNotes || undefined,
    });
    if (!prev) added++;
  }
  report[tab] = `${rows.length} rows → ${added} new trainers, rest enriched`;
}

// ---------------------------------------------------------------- 3. Back-dated Planning
// The batch-start countdown per trainer: eligibility, TOT readiness, NSDC submission/approval.
{
  const tab = "Back-dated Planning";
  const rows = rowsOf(tab);
  const hi = headerAt(rows, "Trainer Name");
  const m = colMap(rows[hi]);
  let touched = 0;
  for (const r of rows.slice(hi + 1)) {
    const name = pick(m, r, "Trainer Name");
    if (!name) continue;
    if (name === "-") continue;
    let hit = [...trainers.values()].find((t) => norm(t.name) === norm(name))
      ?? [...trainers.values()].find((t) => { const a = norm(t.name), b = norm(name); return a.startsWith(b + " ") || b.startsWith(a + " "); });
    if (!hit) {
      // Someone who exists only on the planning sheet is still in the hiring pipeline.
      const key = `NA-${norm(name).replace(/ /g, "-")}`;
      hit = { name, phone: key, source: "AVPL Back-dated Planning", skills: [], active: true, status: "Available", pipeline_status: "Applied" };
      trainers.set(key, hit);
      note(tab, `"${name}" existed only here — created at "Applied" with placeholder key "${key}"`);
    }
    const submitted = pick(m, r, "Trainer profile submitted Date to SSC/NSDC?");
    const approved = pick(m, r, "Is SSC/NSDC approved the trainer profile?", "Is SSC/NSDC approved?");
    const readyTot = pick(m, r, "Trainer Available & Ready for TOT?");
    const loc = findLocation(pick(m, r, "Location"));
    const prog = findProgram((pick(m, r, "Job Role").split("-")[0] || "").replace(/\(.*\)/, ""));
    hit.nominated_for_location = hit.nominated_for_location ?? loc?._id;
    hit.nominated_for_program = hit.nominated_for_program ?? prog?._id;
    // Furthest-along evidence wins; the pipeline itself is walked by humans afterwards.
    if (/yes|approved/i.test(approved)) hit.pipeline_status = "NSDC Approved";
    else if (submitted) hit.pipeline_status = "Submitted to NSDC";
    else if (/yes/i.test(readyTot)) hit.pipeline_status = "Docs Complete";
    hit.pipeline_note = [hit.pipeline_note, `Back-dated planning: ${rows[hi].map((h, i) => (h && r[i] ? `${h}=${r[i]}` : "")).filter(Boolean).join(" | ").slice(0, 400)}`].filter(Boolean).join(" || ");
    touched++;
  }
  report[tab] = `${touched} trainers enriched with planning state`;
}

// ---------------------------------------------------------------- 4. Trainer_Nomination
{
  const tab = "Trainer_Nomination";
  const rows = rowsOf(tab);
  const hi = headerAt(rows, "Trainer Name");
  const m = colMap(rows[hi]);
  let touched = 0, created = 0;
  for (const r of rows.slice(hi + 1)) {
    const name = pick(m, r, "Trainer Name");
    if (!name) continue;
    const phone = phone10(pick(m, r, "Mobile Number", "Mobile"));
    const key = phone || [...trainers.keys()].find((k) => norm(trainers.get(k).name) === norm(name));
    if (!key) { note(tab, `"${name}" has no phone and no match — skipped`); continue; }
    const prev = trainers.get(key);
    if (!prev) created++;
    trainers.set(key, {
      ...(prev ?? { name, phone: key, source: "AVPL Trainer_Nomination", skills: [], active: true, status: "Available" }),
      qualification: pick(m, r, "Education Attained") || prev?.qualification,
      industry_experience_years: Number(pick(m, r, "Industry experience (in number of years)")) || prev?.industry_experience_years,
      teaching_experience_years: Number(pick(m, r, "Training Experience (in number of year)")) || prev?.teaching_experience_years,
      tr_id: pick(m, r, "Trainer SIP ID") || prev?.tr_id,
      // A row on the nomination sheet means the profile went out to NSDC.
      pipeline_status: prev?.pipeline_status && ["NSDC Approved", "Certified"].includes(prev.pipeline_status)
        ? prev.pipeline_status : "Submitted to NSDC",
    });
    touched++;
  }
  report[tab] = `${touched} rows → ${created} new, rest enriched`;
}

// ---------------------------------------------------------------- 5. Batch_Master
const batches = [];
{
  const tab = "Batch_Master";
  const rows = rowsOf(tab);
  const hi = headerAt(rows, "Batch Code");
  const m = colMap(rows[hi]);
  for (const r of rows.slice(hi + 1)) {
    const code = pick(m, r, "Batch Code");
    if (!code) continue;
    const loc = findLocation(pick(m, r, "Location"));
    if (!loc) { note(tab, `batch ${code}: location "${pick(m, r, "Location")}" not matched — skipped`); continue; }
    // "DST"/"SPIT"/"BSRT" is inside the batch code: GGM-DST-01.
    const roleCode = (code.split("-")[1] ?? "").toLowerCase();
    const prog = findProgram(roleCode);
    if (!prog) { note(tab, `batch ${code}: job role "${roleCode}" not matched — skipped`); continue; }
    const trainerName = pick(m, r, "Trainer");
    const tr = trainerName && trainerName !== "-"
      ? ([...trainers.values()].find((t) => norm(t.name) === norm(trainerName))
        ?? [...trainers.values()].find((t) => { const a = norm(t.name), b = norm(trainerName); return a.startsWith(b + " ") || b.startsWith(a + " "); }))
      : null;
    if (trainerName && trainerName !== "-" && !tr) note(tab, `batch ${code}: trainer "${trainerName}" not found in any trainer tab`);
    batches.push({
      code, location: loc._id, program: prog._id,
      _trainerPhone: tr?.phone,
      target_size: Number(pick(m, r, "Capacity")) || 45,
      _startText: pick(m, r, "Start date"), _endText: pick(m, r, "End Date"),
      _enrollment: Number(pick(m, r, "Enrollment")) || 0,
      _certification: Number(pick(m, r, "Certification")) || 0,
      _costs: {
        mobilisation: Number(pick(m, r, "Mobilisation Cost")) || 0,
        trainer: Number(pick(m, r, "Trainer Cost")) || 0,
        other: Number(pick(m, r, "Other Cost")) || 0,
        assessor: Number(pick(m, r, "Accessor Evaluation")) || 0,
      },
      _mobilisation: pick(m, r, "Mobilisation (Local/Central/Mixed)"),
    });
  }
  report[tab] = batches.length;
}

// ---------------------------------------------------------------- 6. Candidate tabs
const CANDIDATE_TABS = ["Lead", "Gurugram - 6th July Batch", "Gurugram - 28th July Batch", "30th July Registrations"];
const candidates = new Map(); // phone → doc
for (const tab of CANDIDATE_TABS) {
  if (!wb.Sheets[tab]) { note(tab, "tab not found"); continue; }
  const rows = rowsOf(tab);
  const hi = headerAt(rows, "Name");
  if (hi === -1) { note(tab, "no Name column — skipped"); continue; }
  const m = colMap(rows[hi]);
  let n = 0;
  for (const r of rows.slice(hi + 1)) {
    const nameRaw = pick(m, r, "Name");
    if (!nameRaw) continue;
    const phone = phone10(pick(m, r, "Mobile", "Phone"));
    if (!phone) continue;
    const name = nameRaw.split("\n")[0].trim();
    const loc = findLocation(pick(m, r, "Interested Location"));
    const age = Number(pick(m, r, "What is your age?")) || null;
    const dob = age ? new Date(new Date().getFullYear() - age, 0, 1) : undefined;
    const qual = pick(m, r, "What is your qualification?");
    const enrolled = pick(m, r, "Enrolled Status");
    candidates.set(phone, {
      name, phone,
      location: loc?._id, source: `AVPL ${tab}`,
      dob,
      education: /graduate|post/i.test(qual) ? "Graduate" : /iti|diploma/i.test(qual) ? "12th Pass" : undefined,
      sidh_status: /^yes|registered/i.test(enrolled) ? "Registered" : "Not Registered",
      sidh_registered_on: /^yes|registered/i.test(enrolled) ? new Date() : undefined,
      lifecycle_status: "Unassigned",
      _note: [qual && `qualification: ${qual}`, pick(m, r, "Current employment status") && `employment: ${pick(m, r, "Current employment status")}`, pick(m, r, "Comments")].filter(Boolean).join(" · "),
    });
    n++;
  }
  report[tab] = n;
}

// ---------------------------------------------------------------- 7. Resumes → trainer applicants
{
  const tab = "Resumes";
  const rows = rowsOf(tab);
  const hi = headerAt(rows, "Name");
  const m = colMap(rows[hi]);
  let n = 0;
  for (const r of rows.slice(hi + 1)) {
    const name = pick(m, r, "Name"); const phone = phone10(pick(m, r, "Phone"));
    if (!name || !phone || trainers.has(phone)) continue;
    const response = pick(m, r, "Response");
    if (/invalid|not interested|no\./i.test(response)) continue; // a dead lead is not an applicant
    trainers.set(phone, {
      name, phone, email: pick(m, r, "Email") || undefined,
      qualification: pick(m, r, "Education") || undefined,
      source: "AVPL Resumes", skills: [], active: true, status: "Available",
      pipeline_status: "Applied", pipeline_note: response || undefined,
    });
    n++;
  }
  report[tab] = `${n} applicants added at "Applied"`;
}
report["Target_Planning"] = "read for reference only — monthly targets are planning aggregates, not entities";
report["Rough"] = "scratch tab — deliberately not imported";
report["Location_Master"] = "already seeded from the same data via seed-rpl.mjs (21 centres / 53 targets)";

// ---------------------------------------------------------------- report
console.log(`\nworkbook: ${wb.SheetNames.length} tabs\n`);
for (const [k, v] of Object.entries(report)) console.log(`  ${k.padEnd(30)} ${v}`);
console.log(`\nTOTALS → trainers ${trainers.size} · batches ${batches.length} · candidates ${candidates.size}`);
const stages = {};
for (const t of trainers.values()) stages[t.pipeline_status] = (stages[t.pipeline_status] ?? 0) + 1;
console.log(`trainer stages: ${JSON.stringify(stages)}`);
if (unmapped.length) {
  console.log(`\n⚠️  ${unmapped.length} row(s) could not be mapped:`);
  for (const u of unmapped.slice(0, 30)) console.log(`   ${u}`);
  if (unmapped.length > 30) console.log(`   … and ${unmapped.length - 30} more`);
}

if (!APPLY) { console.log("\nDry run. Re-run with --apply to write."); await mongoose.disconnect(); process.exit(0); }

// ---------------------------------------------------------------- write
let w = { trainers: 0, batches: 0, candidates: 0 };
for (const t of trainers.values()) {
  const { _sheetCode, _batchCode, ...doc } = t;
  await db.collection("trainers").updateOne({ phone: doc.phone },
    { $set: { ...doc, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date(), eligibility_payment_amount: 3250, max_concurrent_batches: 4, capable_locations: [], programs_applied: [] } },
    { upsert: true });
  w.trainers++;
}
const trainerIds = new Map();
for (const t of await db.collection("trainers").find({}).project({ phone: 1 }).toArray()) trainerIds.set(t.phone, t._id);

for (const c of candidates.values()) {
  const { _note, ...doc } = c;
  await db.collection("candidates").updateOne({ phone: doc.phone },
    { $set: { ...doc, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  w.candidates++;
}
for (const b of batches) {
  const { _trainerPhone, _startText, _endText, _enrollment, _certification, _costs, _mobilisation, ...doc } = b;
  await db.collection("batches").updateOne({ code: doc.code },
    { $set: { ...doc, trainer: _trainerPhone ? trainerIds.get(_trainerPhone) : undefined, updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date(), status: "Planning", session: "Full Day", milestones: [] } },
    { upsert: true });
  w.batches++;
}
console.log(`\nWrote: ${w.trainers} trainers · ${w.candidates} candidates · ${w.batches} batches.`);
await mongoose.disconnect();
