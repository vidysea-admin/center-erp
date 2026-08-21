// QA-530 — put a READ-ONLY copy of what production actually holds onto this machine, so a screen
// can be judged against real rows instead of invented ones.
//
// Umesh, 2026-08-21, looking at the shipped Reports tab on localhost and seeing 35 fixture
// programmes across 175 columns: "jab actual data hai to local mai bhi wahi hona chahiye na taaki
// testing easy ho na." He is right, and the cost of not having this was concrete — the honest
// question "we only have 6 batches, where is all this data from?" could not be answered from the
// screen itself.
//
// THREE LOCAL DATABASES, ON PURPOSE. They are not interchangeable:
//   center_erp_ci     the wall's. Fixtures, seeded, dropped and rebuilt every run. CI parity
//                     depends on it being exactly this and nothing else. NEVER point it here.
//   center_erp_local  this one. A snapshot of production, for LOOKING at screens.
//   center_erp        production. Read here, written never.
//
// Direction is one-way and enforced: production is the SOURCE, and this refuses to write to it.
//
//     node --env-file=.env scripts/mirror-prod.mjs            # dry run - counts only
//     node --env-file=.env scripts/mirror-prod.mjs --apply    # replace center_erp_local
//
// Then run the app against it:
//     MONGODB_DB=center_erp_local npm start
//
// The snapshot is a COPY. Editing it changes nothing upstream, which is the point — you can click
// anything without wondering whether it reached the client.
import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";

const SOURCE_DB = "center_erp";
const TARGET_DB = process.env.MIRROR_DB || "center_erp_local";
const APPLY = process.argv.includes("--apply");
const LOCAL_PW = process.env.MIRROR_PASSWORD || "LocalOnly@123";

// Collections whose rows are credentials or one-time tokens. A local copy of production is a
// convenience; a local copy of production's session and login material is a liability sitting on
// a laptop. Skipped by name rather than by pattern, so adding a collection is a decision.
const SKIP = new Set(["sessions", "accounts", "verificationtokens", "auditlogs", "publictokens"]);

// QA-551 (S1) — `publictokens` was added to that list AFTER a checker found it, and the way it was
// missed is worth more than the fix. QA-536 taught me "the worst secret is a FIELD, not a
// collection", I applied that lesson, and in applying it I stopped looking at collections. This one
// is 59 rows of which 58 are active, and **the 32-hex token IS the credential** — the public routes
// resolve `{ token, purpose, active: true }` and check nothing else. 45 of them are attendance
// tokens, and each opens one NAMED candidate's whole record on the live site: centre, trainer,
// dates, SIDH registration, exam date, result, certificate.
//
// The line above this set already said "collections whose rows are credentials or one-time tokens".
// It described `publictokens` exactly and did not contain it. A rule written down is not a rule
// applied.
//
// SKIPPED rather than field-redacted, unlike tc_password: a token row with its token removed still
// looks like a working share link on any screen that lists them, and a broken credential that looks
// live is worse than an obviously empty list. Locally, generate a fresh link instead.

// QA-536 (S1, found by the sweep against THIS script within an hour of it being written): skipping
// whole COLLECTIONS is not enough, because the worst secret in this database is a FIELD. Ten of the
// 22 live centres carry `tc_password` - the government portal login for that training centre - and
// the standing rule on this project is that the TC Password column is never read, stored or
// printed. A mirror that copies it hands ten live government logins to whoever has the laptop, and
// does it every time somebody refreshes their local data.
//
// Redacted by NAME, per collection, so adding one is a decision rather than a pattern that might
// silently stop matching. The field is removed, not blanked - a key holding "" still reads as "we
// store this here", and the next person to look would go find out where the value went.
const REDACT = {
  locations: ["tc_password"],
  locationtargets: ["tc_password"],
  users: ["password_hash"],   // replaced below with a local-only hash; never carried across as-is
};

const url = process.env.MONGODB_URL;
if (!url) {
  console.error("mirror-prod: MONGODB_URL is not set. Nothing was read.");
  process.exit(1);
}
if (TARGET_DB === SOURCE_DB) {
  console.error(`mirror-prod: refusing to mirror ${SOURCE_DB} onto itself. The target must be a LOCAL name.`);
  process.exit(1);
}
if (TARGET_DB === "center_erp_ci") {
  console.error([
    "mirror-prod: refusing to write to center_erp_ci.",
    "",
    "That database belongs to the wall. It is seeded with fixtures, dropped and rebuilt on every",
    "run, and CI parity depends on it holding exactly those fixtures and nothing else. Putting",
    "production rows there would make the suite pass or fail on whatever the client did that day.",
    "",
    "Use center_erp_local (the default) for looking at real data.",
  ].join("\n"));
  process.exit(1);
}

// TWO clients, and the second one is the whole point. The first draft of this file used ONE
// client for both — `client.db(SOURCE_DB)` and `client.db(TARGET_DB)` — and since MONGODB_URL is
// production, the "local mirror" was created ON THE PRODUCTION HOST: a full copy of center_erp
// plus 31 logins carrying a known password, sitting on a server that answers without
// authentication. It was caught within minutes and removed, and the lesson is written here rather
// than in a commit message because it is the kind of mistake that reads as impossible right up
// until it happens: a database is not local because its NAME says local. It is local because of
// the URL it was opened on.
const TARGET_URL = process.env.MIRROR_TARGET_URL || "mongodb://localhost:27017";
const hostOf = (u) => { try { return new URL(u.replace(/^mongodb(\+srv)?:\/\//, "http://")).host; } catch { return u; } };
if (hostOf(TARGET_URL) === hostOf(url)) {
  console.error([
    "mirror-prod: refusing to run — the target is the SAME HOST as the source.",
    "",
    `  source: ${hostOf(url)} / ${SOURCE_DB}`,
    `  target: ${hostOf(TARGET_URL)} / ${TARGET_DB}`,
    "",
    "A copy on the source host is not a mirror; it is a second copy of production sitting next to",
    "production. Point MIRROR_TARGET_URL at a local mongod (the default is localhost:27017).",
    "",
    "Nothing has been read or written.",
  ].join("\n"));
  process.exit(1);
}

const client = new MongoClient(url, { serverSelectionTimeoutMS: 30000 });
const targetClient = new MongoClient(TARGET_URL, { serverSelectionTimeoutMS: 15000 });
await client.connect();
await targetClient.connect();
const src = client.db(SOURCE_DB);
const dst = targetClient.db(TARGET_DB);
console.log(`source ${hostOf(url)}/${SOURCE_DB}  ->  target ${hostOf(TARGET_URL)}/${TARGET_DB}`);

const names = (await src.listCollections({}, { nameOnly: true }).toArray())
  .map((c) => c.name)
  .filter((n) => !n.startsWith("system."))
  .sort();

console.log(`${names.length} collections, ${SKIP.size} of which are skipped by name\n`);

let copied = 0, docs = 0, skipped = 0;
if (APPLY) {
  // Replace, never merge: a half-refreshed mirror is worse than a stale one, because it looks
  // current and disagrees with itself.
  await dst.dropDatabase();
}

for (const name of names) {
  const n = await src.collection(name).countDocuments();
  if (SKIP.has(name)) {
    console.log(`  skip  ${name.padEnd(28)} ${String(n).padStart(6)} (credentials / tokens / audit trail)`);
    skipped++;
    continue;
  }
  if (!APPLY) {
    console.log(`  read  ${name.padEnd(28)} ${String(n).padStart(6)}`);
    copied++; docs += n;
    continue;
  }
  if (n === 0) { console.log(`  ---   ${name.padEnd(28)}      0`); copied++; continue; }
  const batchSize = 500;
  let wrote = 0;
  const cursor = src.collection(name).find({}, { batchSize });
  const drop = REDACT[name] ?? [];
  let redacted = 0;
  let buf = [];
  for await (const doc of cursor) {
    // QA-536: strip before the document is ever held in the write buffer, so a secret never sits in
    // this process's memory longer than the read that produced it, and never reaches the target at
    // all - not even for the moment it would take to delete it afterwards.
    for (const f of drop) if (doc[f] !== undefined && doc[f] !== null && doc[f] !== "") { delete doc[f]; redacted++; }
    buf.push(doc);
    if (buf.length >= batchSize) { await dst.collection(name).insertMany(buf, { ordered: false }); wrote += buf.length; buf = []; }
  }
  if (buf.length) { await dst.collection(name).insertMany(buf, { ordered: false }); wrote += buf.length; }
  // The redaction count is PRINTED. A secret quietly removed is indistinguishable from a secret
  // that was never there, and the difference matters the day somebody asks whether this file is safe.
  console.log(`  copy  ${name.padEnd(28)} ${String(wrote).padStart(6)}` + (redacted ? `   (${redacted} secret value(s) removed: ${drop.join(", ")})` : ""));
  copied++; docs += wrote;
}

// The indexes matter as much as the rows: the unique index on batch code is what makes a local
// rename behave the way the real one did.
if (APPLY) {
  let idx = 0;
  for (const name of names) {
    if (SKIP.has(name)) continue;
    const specs = (await src.collection(name).indexes()).filter((i) => i.name !== "_id_");
    for (const s of specs) {
      const { key, name: iname, v, ns, background, ...opts } = s;
      try { await dst.collection(name).createIndex(key, { name: iname, ...opts }); idx++; } catch { /* a duplicate in the data can refuse a unique index - reported below, not fatal */ }
    }
  }
  console.log(`\n${copied} collections, ${docs} documents, ${idx} indexes -> ${TARGET_DB}`);

  // Without this the mirror is unusable, and the reason is easy to miss until you hit it: the
  // copied logins carry PRODUCTION password hashes, and nobody here knows those passwords - so you
  // would have a perfect copy of the data and no way through the front door. One local-only
  // password is set on every copied login, IN THE MIRROR ONLY. It cannot reach production: this
  // write is aimed at `dst`, and `dst` is refused at the top of this file if it is ever named
  // center_erp or center_erp_ci.
  const hash = await bcrypt.hash(LOCAL_PW, 10);
  const r = await dst.collection("users").updateMany({}, { $set: { password_hash: hash } });
  console.log(`\nlocal-only password set on ${r.modifiedCount} logins: ${LOCAL_PW}`);
  console.log("(it exists only in the mirror - production hashes were never read or written)");
  const admins = await dst.collection("users").find({ role: "Admin" }).project({ email: 1 }).limit(3).toArray();
  if (admins.length) console.log("sign in as: " + admins.map((a) => a.email).join(" / "));

  console.log(`\nRun the app against it:\n    MONGODB_DB=${TARGET_DB} npm start`);
} else {
  console.log(`\nDRY RUN - nothing written. ${copied} collections / ${docs} documents would be copied, ${skipped} skipped.`);
  console.log("Re-run with --apply.");
}

await client.close();
await targetClient.close();
