// Match the client workbook's TC IDs to the centres already in the ERP — proposal first.
//
//     node scripts/propose-tc-ids.mjs            → writes tc-id-proposal.json, changes nothing
//     node scripts/propose-tc-ids.mjs --apply    → applies ONLY the rows left marked "apply": true
//
// -169 (QA-520) added a SECOND proposal in the same file: `target_rows`, which puts each sheet
// row's TC ID onto the (centre × job role) row it belongs to (LocationTarget.tc_id). Why that
// matters: a centre has SEVERAL government registrations and Location.external_id holds exactly
// one, so on live 20 of the sheet's 35 TC IDs reached no centre at all — four of the five rows the
// 7,315/6,315 correction is about among them. Once a target row carries its own number, the sync
// can find it, and the correction stops being a thing somebody has to redo by hand every time.
//
// Why this exists: the government attendance import identifies a centre by the TC ID stamped
// into the portal's Org Name ("AVPL Gurugram -TC352854"), matched against Location.external_id.
// The client workbook carries that TC ID in a column, but Sheet Watch runs in watch mode with no
// field mappings — it reports changes, it never writes them. So no location has a TC ID and the
// import auto-detects nothing.
//
// It is two-step on purpose. The CEO's rule is that nothing from a sheet enters the database
// without a human validating it, and name matching across 36 centres is exactly the kind of
// thing that looks right and is not: "Govt. ITI, Badgad, Chitrkoot" has to find the right row
// among near-identical ITI names. So pass one only proposes, marking anything it is not sure
// about; a person reads the file, fixes or deletes rows, and pass two applies what survives.
import { readFileSync, writeFileSync, existsSync } from "fs";
import * as XLSX from "xlsx";
import mongoose from "mongoose";
import { requireSafeDb } from "./db-guard.mjs";

const APPLY = process.argv.includes("--apply");
const OUT = "tc-id-proposal.json";
const SHARE = process.argv.find((a) => a.startsWith("http")) ||
  "https://onedrive.live.com/:x:/g/personal/c1d310c499f08fba/IQBHQGQ1_HmBRZjCmC1XQMK8AQCFnOpu1H8GXm3MNvZnypE";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const APP_ID = "5cbed6ac-a083-4e14-b191-b4ba07653de2";

const MONGODB_URL = process.env.MONGODB_URL || "mongodb://127.0.0.1:27017";
const MONGODB_DB = requireSafeDb("propose-tc-ids");

// Names differ between the sheet and the ERP in punctuation, "Govt."/"Government", and spacing.
const norm = (s) => String(s ?? "").toLowerCase()
  .replace(/govt\.?/g, "government").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();

async function fetchWorkbook() {
  const tok = await (await fetch("https://api-badgerp.svc.ms/v1.0/token", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ appId: APP_ID }),
  })).json();
  const b64 = Buffer.from(SHARE.split("?")[0], "utf8").toString("base64")
    .replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  const item = await (await fetch(
    `https://my.microsoftpersonalcontent.com/_api/v2.0/shares/u!${b64}/driveitem?%24select=name,%40content.downloadUrl`,
    { headers: { Authorization: `Badger ${tok.token}`, Prefer: "autoredeem", "User-Agent": UA } },
  )).json();
  const buf = Buffer.from(await (await fetch(item["@content.downloadUrl"])).arrayBuffer());
  return XLSX.read(buf, { type: "buffer" });
}

await mongoose.connect(MONGODB_URL, { dbName: MONGODB_DB });
const db = mongoose.connection.db;
const locations = await db.collection("locations")
  .find({}, { projection: { name: 1, code: 1, city: 1, state: 1, external_id: 1 } }).toArray();
console.log(`${locations.length} locations in ${MONGODB_DB}\n`);

// ---------------------------------------------------------------- apply pass
if (APPLY) {
  if (!existsSync(OUT)) { console.error(`${OUT} not found — run without --apply first.`); process.exit(1); }
  const proposal = JSON.parse(readFileSync(OUT, "utf8"));
  const todo = proposal.rows.filter((r) => r.apply === true && r.location_id && r.tc_id);
  console.log(`${todo.length} of ${proposal.rows.length} rows marked apply:true\n`);
  let done = 0, skipped = 0;
  for (const r of todo) {
    const loc = locations.find((l) => String(l._id) === r.location_id);
    if (!loc) { console.log(`SKIP  ${r.tc_id} — location ${r.location_id} no longer exists`); skipped++; continue; }
    // Never silently overwrite a TC ID someone already set by hand.
    if (loc.external_id && loc.external_id !== r.tc_id) {
      console.log(`SKIP  ${loc.name} already has external_id "${loc.external_id}" (proposal says ${r.tc_id}) — resolve by hand`);
      skipped++; continue;
    }
    if (loc.external_id === r.tc_id) { skipped++; continue; }
    await db.collection("locations").updateOne({ _id: loc._id }, { $set: { external_id: r.tc_id, updatedAt: new Date() } });
    await db.collection("auditlogs").insertOne({
      entity: "Location", entity_id: loc._id, field: "external_id",
      old_value: loc.external_id ?? null, new_value: r.tc_id,
      actor_type: "EXTERNAL_SYNC", note: "TC ID backfilled from the client workbook via propose-tc-ids.mjs",
      createdAt: new Date(), updatedAt: new Date(),
    });
    console.log(`SET   ${loc.name} → ${r.tc_id}`);
    done++;
  }
  // -169 (QA-520): the per-row half. Same rules as above — never overwrite a value someone else
  // set, and only touch rows a human marked.
  const todoRows = (proposal.target_rows ?? []).filter((r) => r.apply === true && r.location_id && r.program_id && r.tc_id);
  let rDone = 0, rSkipped = 0;
  for (const r of todoRows) {
    const existing = await db.collection("locationtargets").findOne({
      location: new mongoose.Types.ObjectId(r.location_id), program: new mongoose.Types.ObjectId(r.program_id),
    });
    if (!existing) {
      console.log(`SKIP  ${r.tc_id} — ${r.location_name} has no target row for ${r.program_code} yet`);
      rSkipped++; continue;
    }
    if (existing.tc_id && existing.tc_id !== r.tc_id) {
      console.log(`SKIP  ${r.location_name} / ${r.program_code} already carries "${existing.tc_id}" (proposal says ${r.tc_id}) — resolve by hand`);
      rSkipped++; continue;
    }
    if (existing.tc_id === r.tc_id) { rSkipped++; continue; }
    await db.collection("locationtargets").updateOne({ _id: existing._id }, { $set: { tc_id: r.tc_id, updatedAt: new Date() } });
    await db.collection("auditlogs").insertOne({
      entity: "LocationTarget", entity_id: existing._id, field: "tc_id",
      old_value: existing.tc_id ?? null, new_value: r.tc_id,
      actor_type: "EXTERNAL_SYNC", note: "per-row TC ID backfilled from the client workbook via propose-tc-ids.mjs (QA-520)",
      createdAt: new Date(), updatedAt: new Date(),
    });
    console.log(`SET   ${r.location_name} / ${r.program_code} → ${r.tc_id}`);
    rDone++;
  }
  console.log(`\n${done} location key(s) applied, ${skipped} skipped.`);
  console.log(`${rDone} target row TC ID(s) applied, ${rSkipped} skipped.`);
  await mongoose.disconnect();
  process.exit(0);
}

// ---------------------------------------------------------------- proposal pass
const wb = await fetchWorkbook();
const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: "", raw: false });
// The workbook carries a totals row above the real header, so the header is found by content.
const h = grid.findIndex((r) => r.some((c) => /institution name/i.test(c)) && r.some((c) => /tc\s*id/i.test(c)));
if (h < 0) { console.error("Could not find the header row (expected 'Institution Name' and 'TC ID')."); process.exit(1); }
const col = (re) => grid[h].findIndex((c) => re.test(String(c)));
const cTc = col(/tc\s*id/i), cName = col(/institution name/i), cDist = col(/district/i), cState = col(/^state$/i);

// A TC ID repeats across job-role rows, so collapse to one entry per centre.
const centres = new Map();
for (const r of grid.slice(h + 1)) {
  const tc = String(r[cTc] ?? "").trim();
  if (!tc) continue;
  if (!centres.has(tc)) centres.set(tc, { tc_id: tc, name: String(r[cName] ?? "").trim(), district: String(r[cDist] ?? "").trim(), state: String(r[cState] ?? "").trim() });
}
console.log(`${centres.size} distinct TC IDs in the workbook\n`);

const rows = [];
for (const c of centres.values()) {
  const already = locations.find((l) => l.external_id && l.external_id.toUpperCase() === c.tc_id.toUpperCase());
  if (already) {
    rows.push({ ...c, status: "ALREADY SET", location_id: String(already._id), location_name: already.name, apply: false });
    continue;
  }
  const exact = locations.filter((l) => norm(l.name) === norm(c.name));
  const loose = exact.length ? exact
    : locations.filter((l) => norm(l.name) && (norm(l.name).includes(norm(c.name)) || norm(c.name).includes(norm(l.name))));
  const scoped = loose.length > 1 && c.district
    ? loose.filter((l) => norm(l.city) === norm(c.district)) || loose
    : loose;
  const hits = scoped.length ? scoped : loose;

  if (hits.length === 1) {
    rows.push({
      ...c, status: exact.length === 1 ? "MATCH (exact name)" : "MATCH (partial name — CHECK)",
      location_id: String(hits[0]._id), location_name: hits[0].name, location_city: hits[0].city ?? "",
      // Only an exact name match is pre-approved. Anything fuzzier needs a human to flip it.
      apply: exact.length === 1,
    });
  } else if (hits.length > 1) {
    rows.push({
      ...c, status: `AMBIGUOUS — ${hits.length} candidates, pick one and set location_id`,
      location_id: "", candidates: hits.map((l) => ({ id: String(l._id), name: l.name, city: l.city ?? "" })), apply: false,
    });
  } else {
    rows.push({ ...c, status: "NO MATCH — this centre is not in the ERP yet", location_id: "", apply: false });
  }
}

// -169 (QA-520): the per-row proposal. The centre still comes from the name match above (with a
// human confirming it), and the JOB ROLE comes from the sheet row's own columns — so this never
// guesses at the thing the government actually numbered.
const cRole = col(/job\s*role/i), cScheme = col(/scheme/i);
const programs = await db.collection("programs").find({}, { projection: { name: 1, code: 1, scheme: 1 } }).toArray();
const centreOf = new Map(rows.filter((r) => r.location_id).map((r) => [r.tc_id, r]));
const target_rows = [];
if (cRole < 0) {
  console.log("NOTE  no 'Job Role' column found in the workbook — the per-row proposal is empty.");
  console.log("      (Nothing is guessed: without the job role there is no row to attach a TC ID to.)");
} else {
  const seen = new Set();
  for (const r of grid.slice(h + 1)) {
    const tc = String(r[cTc] ?? "").trim();
    const role = String(r[cRole] ?? "").trim();
    if (!tc || !role) continue;
    const key = tc + "|" + norm(role);
    if (seen.has(key)) continue;
    seen.add(key);
    const centre = centreOf.get(tc);
    const scheme = cScheme >= 0 ? String(r[cScheme] ?? "").trim() : "";
    const byName = programs.filter((p) => norm(p.name) === norm(role));
    const hitsP = byName.length > 1 && scheme ? byName.filter((p) => norm(p.scheme) === norm(scheme)) : byName;
    const prog = hitsP.length === 1 ? hitsP[0] : null;
    target_rows.push({
      tc_id: tc, job_role: role, scheme,
      location_id: centre?.location_id ?? "", location_name: centre?.location_name ?? "",
      program_id: prog ? String(prog._id) : "", program_code: prog?.code ?? "",
      status: !centre?.location_id ? "NO CENTRE — resolve the centre above first"
        : !prog ? (byName.length > 1 ? `AMBIGUOUS — ${byName.length} programmes named "${role}"` : `NO PROGRAMME — nothing in the ERP is named "${role}"`)
        : "MATCH",
      // Pre-approved only when BOTH ends are unambiguous and the centre itself was an exact match.
      apply: !!(centre?.location_id && prog && centre.apply === true),
    });
  }
}
const rowTally = target_rows.reduce((a, r) => { const k = r.status.split(" —")[0]; a[k] = (a[k] ?? 0) + 1; return a; }, {});

const tally = rows.reduce((a, r) => { const k = r.status.split(" —")[0]; a[k] = (a[k] ?? 0) + 1; return a; }, {});
writeFileSync(OUT, JSON.stringify({
  generated_at: new Date().toISOString(), database: MONGODB_DB, source: SHARE.split("?")[0],
  how_to_use: "Review every row in BOTH lists. Set apply:true on the ones that are right; fix location_id on AMBIGUOUS rows first. \"rows\" sets each centre's key (Location.external_id); \"target_rows\" sets each (centre x job role) row's own TC ID (LocationTarget.tc_id) — that second one is what lets the sheet correct a row whose number is not its centre's key. Then: node scripts/propose-tc-ids.mjs --apply",
  summary: tally, rows, target_row_summary: rowTally, target_rows,
}, null, 2));

console.log(Object.entries(tally).map(([k, v]) => `  ${v}  ${k}`).join("\n"));
console.log(`\nWrote ${OUT}. Nothing has been changed.`);
console.log(`${rows.filter((r) => r.apply).length} centre key(s) are pre-approved (exact name match); the rest need a human.`);
console.log(`\n${target_rows.length} per-row TC ID proposal(s):`);
console.log(Object.entries(rowTally).map(([k, v]) => `  ${v}  ${k}`).join("\n") || "  (none)");
console.log(`${target_rows.filter((r) => r.apply).length} pre-approved; the rest need a human.`);
await mongoose.disconnect();
