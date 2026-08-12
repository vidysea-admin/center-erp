// Normalise DailyLog.log_date to a timezone-independent calendar date (UTC midnight).
//
// Why: dayStart() used setHours(0,0,0,0) — midnight in the SERVER PROCESS's timezone — and
// log_date was stored with it. A day written from a laptop in IST is a different instant from
// the same day written by the container in UTC, so the missing-log lookups (exact equality)
// never matched and the alarm reported "no daily log for N operating days" over a table listing
// them. The {batch, log_date} unique index behind Rule 27 is keyed on that same drifting value.
//
// This rewrites each row to UTC midnight of the calendar day it was MEANT to represent, read in
// the timezone it was written in (--from-tz, default Asia/Kolkata, which is what the seeding and
// back-dating scripts ran in).
//
//   node --env-file=.env.local scripts/migrate-logdate-tz.mjs              # dry run, changes nothing
//   node --env-file=.env.local scripts/migrate-logdate-tz.mjs --apply      # writes
//   node --env-file=.env.local scripts/migrate-logdate-tz.mjs --from-tz=UTC --apply
//
// TAKE A BACKUP FIRST. This is the only migration in the remediation set that rewrites existing
// attendance rows. It refuses to merge collisions — if two rows would land on the same calendar
// day for one batch it reports them and leaves both alone for a human to settle.
import { MongoClient } from "mongodb";

const APPLY = process.argv.includes("--apply");
const fromTzArg = process.argv.find((a) => a.startsWith("--from-tz="));
const FROM_TZ = fromTzArg ? fromTzArg.split("=")[1] : "Asia/Kolkata";

const url = process.env.MONGODB_URL;
const dbName = process.env.MONGODB_DB;
if (!url || !dbName) { console.error("MONGODB_URL and MONGODB_DB are required"); process.exit(1); }

// The calendar date this instant falls on, as seen in FROM_TZ.
const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: FROM_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
function calendarDateIn(instant) {
  return fmt.format(instant); // YYYY-MM-DD
}
function utcMidnight(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const client = new MongoClient(url);
await client.connect();
const db = client.db(dbName);
const logs = db.collection("dailylogs");

const all = await logs.find({}, { projection: { batch: 1, log_date: 1 } }).toArray();
console.log(`database        ${dbName}`);
console.log(`reading dates as${" "}${FROM_TZ}`);
console.log(`daily logs      ${all.length}`);
console.log(`mode            ${APPLY ? "APPLY (writes)" : "dry run (no writes)"}\n`);

const planned = [];
for (const row of all) {
  const target = utcMidnight(calendarDateIn(new Date(row.log_date)));
  if (target.getTime() !== new Date(row.log_date).getTime()) {
    planned.push({ _id: row._id, batch: String(row.batch), from: new Date(row.log_date), to: target });
  }
}

// Refuse to create a Rule 27 collision.
const seen = new Map(); // batch|ymd -> _id
for (const row of all) {
  const target = utcMidnight(calendarDateIn(new Date(row.log_date)));
  const key = `${row.batch}|${target.toISOString().slice(0, 10)}`;
  if (seen.has(key)) {
    console.error(`COLLISION  batch ${row.batch} would have two logs on ${target.toISOString().slice(0, 10)} (${seen.get(key)} and ${row._id}).`);
    console.error("Nothing was written. Settle these two rows by hand, then re-run.");
    await client.close();
    process.exit(2);
  }
  seen.set(key, String(row._id));
}

if (!planned.length) {
  console.log("Every log_date is already at UTC midnight — nothing to do.");
} else {
  console.log(`${planned.length} row(s) would change:`);
  for (const p of planned.slice(0, 20)) {
    console.log(`  ${p._id}  ${p.from.toISOString()}  ->  ${p.to.toISOString()}  (${p.to.toISOString().slice(0, 10)})`);
  }
  if (planned.length > 20) console.log(`  … and ${planned.length - 20} more`);

  if (APPLY) {
    let done = 0;
    for (const p of planned) {
      await logs.updateOne({ _id: p._id }, { $set: { log_date: p.to } });
      done++;
    }
    console.log(`\nRewrote ${done} row(s).`);
  } else {
    console.log("\nDry run — nothing written. Re-run with --apply once you have a backup.");
  }
}

await client.close();
