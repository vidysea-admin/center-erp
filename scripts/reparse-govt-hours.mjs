// QA-278: re-parse the hours the portal already gave us, for rows imported BEFORE -106 taught the
// parser to read decimals.
//
// THE FILE IS NOT NEEDED. That is the whole point of this script, and it is worth stating plainly
// because the row concluded otherwise: `GovtAttendanceRow` stores `total_hours_raw` — the string
// exactly as the portal wrote it — beside `total_hours_minutes`. So the 28 rows on
// BHA-ITI-RPLHSL-SPIT-01 that read "No portal hours yet" are not missing their data. They are
// carrying "26.6", "73.99", "109.94" in a column nobody re-read after the parser learned that shape.
// Nobody has to go and find 'Attendance Report 06-08-2026 (3837392) (1).xls' again.
//
// This does NOT rewrite what the portal said. `total_hours_raw` is the point-in-time record and is
// never touched; only the DERIVED minutes column is filled, and only where it is null while a raw
// value exists. Anything the current parser still cannot read is left null and reported by name —
// a value we cannot understand must stay unknown rather than become a confident zero (QA-085).
//
//   node --env-file=.env.local scripts/reparse-govt-hours.mjs           # dry run, changes nothing
//   node --env-file=.env.local scripts/reparse-govt-hours.mjs --apply   # writes
//
// Idempotent: a second run finds nothing, because every row it fixed now has minutes.
import { MongoClient } from "mongodb";

// THE PARSER IS A COPY, AND THAT IS A DELIBERATE, GUARDED CHOICE — not an oversight.
// The real one is hhmmssToMinutes in src/lib/govt-attendance.ts, but that module imports @/models,
// so importing it from a plain node script drags mongoose and the whole alias graph in; every other
// migration here (migrate-cits-doctype, migrate-logdate-tz) uses raw mongo for exactly that reason.
// So this is the same shape as -129's doc-type lists: a copy that cannot be avoided, made safe by a
// PIN rather than by hope. scripts/check-user-copy.mjs now runs both over the same table of values
// and fails the wall if they ever disagree. If you change one, the wall will make you change both.
function hhmmssToMinutes(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(s);
  if (m) return Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / 60 : 0);
  const dec = /^(\d{1,5})(?:[.,](\d{1,4}))?$/.exec(s);
  if (dec) {
    const hours = Number(`${dec[1]}.${dec[2] ?? 0}`);
    if (!Number.isFinite(hours)) return null;
    if (hours > 10_000) return null;
    return hours * 60;
  }
  return null;
}

// --selftest: prove this copy still agrees with the app, without importing the app. The values are
// the two shapes the portal actually sends plus the junk that must stay null (QA-085 — a figure we
// cannot understand must remain unknown rather than become a confident zero). The APP's side of the
// same table is pinned at runtime by e2e-govt.mjs's decimal-hours and junk-hours blocks, so the two
// are anchored to one set of expectations from both ends. The wall runs this; nothing is eval'd.
if (process.argv.includes("--selftest")) {
  const CASES = [["13:19:33", 799.55], ["26.6", 1596], ["73.99", 4439.4], ["109.94", 6596.4],
    ["1:5", 65], ["N/A", null], ["", null], ["99999999", null], ["12/08/2026", null],
    // "50000" is five digits, so it PASSES the regex and is stopped only by the >10,000-hour sanity
    // guard. Without it this table never exercised that guard at all — found by breaking the guard
    // and watching the pin stay green, which is the only way to know a pin is real.
    ["50000", null]];
  let bad = 0;
  for (const [inp, want] of CASES) {
    const got = hhmmssToMinutes(inp);
    const ok = want === null ? got === null : got !== null && Math.abs(got - want) < 0.01;
    if (!ok) { bad++; console.log(`MISMATCH ${JSON.stringify(inp)} -> ${got}, expected ${want}`); }
  }
  console.log(bad ? `selftest: ${bad} mismatch(es)` : `selftest: ${CASES.length}/${CASES.length} ok`);
  process.exit(bad ? 1 : 0);
}

const APPLY = process.argv.includes("--apply");
const url = process.env.MONGODB_URL || process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB;
if (!url || !dbName) {
  console.error("MONGODB_URL and MONGODB_DB must be set (use --env-file=.env.local).");
  process.exit(2);
}

const client = new MongoClient(url);
await client.connect();
const db = client.db(dbName);
console.log(`db: ${dbName} · ${APPLY ? "APPLY" : "DRY RUN"}\n`);

const rowsCol = db.collection("govtattendancerows");
const stuck = await rowsCol.find({
  total_hours_minutes: null,
  total_hours_raw: { $nin: [null, ""] },
}).project({ name: 1, total_hours_raw: 1, batch: 1, import: 1, candidate: 1 }).toArray();

console.log(`rows with a raw hours value but NO parsed minutes: ${stuck.length}`);
if (!stuck.length) {
  console.log("\nNothing to do — every row that carries a raw value has minutes.");
  await client.close();
  process.exit(0);
}

// Group by batch so the report reads like the screen it fixes.
const batches = await db.collection("batches").find({ _id: { $in: [...new Set(stuck.map((r) => r.batch).filter(Boolean))] } })
  .project({ code: 1 }).toArray();
const codeOf = new Map(batches.map((b) => [String(b._id), b.code]));

const fixable = [], unreadable = [];
for (const r of stuck) {
  const mins = hhmmssToMinutes(r.total_hours_raw);
  (mins == null ? unreadable : fixable).push({ ...r, mins });
}

const byBatch = {};
for (const r of fixable) (byBatch[codeOf.get(String(r.batch)) ?? "(no batch)"] ??= []).push(r);
for (const [code, list] of Object.entries(byBatch)) {
  console.log(`\n  ${code}: ${list.length} row(s) would gain hours`);
  for (const r of list.slice(0, 5)) console.log(`     ${r.name} — raw "${r.total_hours_raw}" -> ${Math.round(r.mins)} min (${(r.mins / 60).toFixed(1)} hrs)`);
  if (list.length > 5) console.log(`     … and ${list.length - 5} more`);
}
if (unreadable.length) {
  console.log(`\n  ${unreadable.length} row(s) the parser STILL cannot read — left null on purpose, a value we do not understand must stay unknown:`);
  for (const r of unreadable.slice(0, 10)) console.log(`     ${r.name} — raw ${JSON.stringify(r.total_hours_raw)}`);
}

if (!APPLY) {
  console.log(`\nDRY RUN — would fill ${fixable.length} row(s). Nothing written.`);
  await client.close();
  process.exit(0);
}

let n = 0;
for (const r of fixable) {
  await rowsCol.updateOne({ _id: r._id }, { $set: { total_hours_minutes: r.mins } });
  n++;
}
console.log(`\nfilled: ${n} row(s)`);
const left = await rowsCol.countDocuments({ total_hours_minutes: null, total_hours_raw: { $nin: [null, ""] } });
console.log(`verify: rows still raw-but-unparsed = ${left} (expected ${unreadable.length}, the genuinely unreadable ones)`);
console.log(left === unreadable.length ? "\nOK" : "\nCHECK THIS");
await client.close();
process.exit(left === unreadable.length ? 0 : 1);
