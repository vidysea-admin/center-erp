// mtg-c1 (R4) - QA-2871 / QA-2872 / QA-2873.
//
// Meeting 2026-10-06, Karunn sir: "all reporting from the system, no Excel". Umesh's decision on the
// notification noise: the scheduled closing digest, with manual Publish now also allowed. So:
//   R4   dailyDigest(dayIST, viewer): candidates, trainers, costs (finance.view only), one function,
//        read by the screen /reports/daily, the Publish-now button and the 21:00 IST mail.
//   R4b  a 4th scheduler tick: ONE mail per recipient per IST day, lock + durable day key.
//   R4c  a Defaults toggle "digest only" (default OFF) that folds the per-approval mails into the digest.
//
// THE CLOCK SEAM (and why it is this one): the tick is exercised through a TEST-ONLY door,
// POST /api/test/digest-tick {now, instance}, which answers 404 unless MONGODB_DB is a center_erp_ci*
// database and demands an Admin - the same guard style as /api/test/reset-sms-cap. The tick takes `now`
// and `instance` as ARGUMENTS, so no environment override lives in a production code path. In CI
// sendMail always logs "skipped" (test environment), so a MailLog row IS the captured attempt; the door
// also returns each recipient's rendered text so the per-recipient finance gate is asserted on the words
// that would have been mailed.
//
// ARM NAMES carry the criterion so a mutant reddens the arm it targets and a verdict can quote the line:
//   D1  exact candidates numbers (joined by batch, enrolled, batches created/started, mobilised)
//   D2  exact trainers numbers (assigned / free / unavailable / pipeline buckets), computed from Batch
//   D3  exact costs numbers, and ONLY for a viewer holding finance.view
//   D4  centre scope: a Location user sees its own centre and nothing else, in every section
//   D5  the IST day boundary: 23:59 and 00:01 IST land on opposite days, in every encoding
//   T1  the tick fires at 21:00 IST and not at 20:59
//   T2  two concurrent ticks give exactly one mail per recipient
//   T3  a lock held by another instance means nothing is sent and the day is not consumed
//   T4  a restart after a send does not send again; the next IST day does send
//   T5  the finance section is rendered per recipient
//   T6  recipients: ineligible accounts are recorded, not mailed; a typed address that is no account is mailed
//   R1-R5 a failed/skipped send does not consume the day: retry (atomic, capped at 3, 10 minutes apart, same IST day)
//   U   the CUSTOM recipient list (cycle 2, Umesh 2026-10-07): picked ERP users (`u:<id>`) and/or typed addresses
//       U1 the picker endpoint . U2 tagged entries, a re-emailed user, the typed address's full report with money
//       U3 the same person twice = one mail . U4 the account wins over a typed address . U5 write validation
//       U6 the deliverable guard . U7 only Admin edits, and GET redacts the list . U8 concurrent PUTs (A1)
//       U13 (QA-2923) only an ADMIN types an outside address; a defaults.manage grantee may pick existing users only
//       U9 "digest-only ON, nobody can receive it" is said out loud (A2) . U10 a crashed claim is re-taken (A3)
//       U11 Publish now names a reason per category (A5) . U12 fullView is reachable from one place only
//   G1  the "digest only" toggle: ON suppresses (on the record), OFF keeps the per-approval mail
//   G2  Publish now: refused without defaults.manage, allowed with it, cooldown, empty list
//   W   the scheduler wiring
//   S   the real screen, in Chromium
//   K   Karunn sir's review 2026-11-02: the digest as TABLES (trainers, candidates, costs), stage entries per period
//       (on the day / this week Mon-Sun IST / cumulative), trained-but-not-available counted by reason, weekly targets
//       with +/- (Admin, Targets: validated before any write), and the activity tracker (sign-ins + work per day)
//   K8  Umesh 2026-11-03: any range - "Monday, Monday+Tuesday, Monday..Thursday": the cumulative column runs from a chosen
//       day (?from=), equals the sum of the daily figures over those days, its target sums only the weeks it touches,
//       and a bad range is refused before anything is read or mailed
//   S4  the screen as a dashboard: section dropdown, sort, row filter, minimum, hide zero rows, CSV = what is shown
//
// Every identity is derived from the run stamp. The shared wall DB holds other suites' data, so the EXACT
// numbers are asserted through scoped personas on a day (2031-03-14) no other suite writes to.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ok as okLib, req, login, adminLogin, finish as finishLib, stamp, today, BASE } from "./e2e-lib.mjs";

const results = [];
const ok = (n, c, x = "") => { results.push({ name: n, pass: !!c, detail: String(x ?? "").replace(/\s+/g, " ").slice(0, 300) }); okLib(n, c, x); };
const pageErrors = [];
const finish = () => {
  const dir = process.env.MC1_BROWSER_REPORT;
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
      const failed = results.filter((r) => !r.pass).length;
      writeFileSync(path.join(dir, "report.json"), JSON.stringify({
        unit: "mtg-c1-daily-digest", date: new Date().toISOString(), base: BASE, kind: "maker smoke, not validation",
        tz: process.env.TZ ?? null, total: results.length, passed: results.length - failed, failed,
        uncaughtPageErrors: pageErrors.length, pageErrors: pageErrors.slice(0, 10), results,
      }, null, 2));
    } catch { /* a convenience; the exit code still decides */ }
  }
  finishLib();
};
let browser = null;
const onFatal = async (e) => {
  const cause = [e?.cause?.code, e?.cause?.message].filter((v) => v != null).map((v) => String(v).replace(/\s+/g, " ").slice(0, 160)).join(": ");
  ok("MC1: the suite ran to its end without an uncaught error", false, `ABORTED: ${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 300)}${cause ? `; cause: ${cause}` : ""} - every arm after this point did not run`);
  try { if (browser) await browser.close(); } catch { /* nothing left */ }
  finish();
};
process.on("uncaughtException", onFatal);
process.on("unhandledRejection", onFatal);

const s = stamp("MC1");
// Capture source before HTTP so the synchronous walk cannot outlive an idle keep-alive socket.
const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const walkSrc = (dir) => readdirSync(dir).flatMap((n) => { const f = path.join(dir, n); return statSync(f).isDirectory() ? walkSrc(f) : /\.(ts|tsx)$/.test(n) ? [f] : []; });
const fullViewUsers = walkSrc(srcRoot).filter((f) => /fullView/.test(readFileSync(f, "utf8"))).map((f) => path.relative(srcRoot, f).split(path.sep).join("/")).sort();
const ddSrc = readFileSync(path.join(srcRoot, "lib", "daily-digest.ts"), "utf8");
const ddCode = ddSrc.split("\n").filter((l) => /fullView/.test(l) && !/^\s*\/\//.test(l));
const admin = await adminLogin();
const MURL = process.env.MONGODB_URL || process.env.MONGODB_URI;
if (!MURL) { ok("[precondition] MONGODB_URL is set", false, "refusing to guess a connection string"); finish(); }
const { MongoClient, ObjectId } = await import("mongodb");
const mc = new MongoClient(MURL, { serverSelectionTimeoutMS: 8000 });
await mc.connect();
const db = mc.db(process.env.MONGODB_DB);
if (!/^center_erp_ci/.test(db.databaseName)) { ok("[precondition] the database is a CI database", false, db.databaseName); finish(); }
const oid = (x) => new ObjectId(String(x));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the test day, and instants built a DIFFERENT way from the product (ISO strings with +05:30) -------
const D = "2031-03-14", PREV = "2031-03-13", NEXT = "2031-03-15", D2 = "2031-03-16", D3 = "2031-03-17", PUBDAY = "2031-03-19";
const istAt = (day, hh, mm, ss = 0) => new Date(`${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}+05:30`);
const bizDay = (day) => new Date(`${day}T00:00:00Z`);          // a business date: UTC midnight of the IST date (dayKey)
const mailSubject = (day) => `Daily digest ${day}`;
// The mail's plain-text twin draws each table as fixed-width columns (label, then cells, 2+ spaces apart; a
// sub-row starts "- "). Returns the cells of the row with exactly that label, or null.
const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mailRow = (text, label) => {
  const line = String(text).split("\n").find((l) => new RegExp(`^\\s*(- )?${reEsc(label)}\\s{2,}`).test(l));
  return line ? line.trim().replace(/^- /, "").split(/\s{2,}/).slice(1) : null;
};

// ---- clean slate for the shared documents this suite touches ---------------------------------------------
const jobLocks = db.collection("job_locks");
const mailLogs = db.collection("maillogs");
const wipeLocks = async () => {
  await jobLocks.deleteMany({ _id: { $in: ["daily-digest", "daily-digest-manual"] } });
  await jobLocks.deleteMany({ _id: { $regex: /^digest-sent:/ } });
};
await wipeLocks();
// a previous aborted run must not leave a recipient list or the toggle behind
await req(admin, "PUT", "/api/defaults", { digest_recipients: "", digest_only_approval_mails: false });

// ---- fixture: two centres and their programmes --------------------------------------------------------
const mkLoc = async (tag) => (await req(admin, "POST", "/api/locations", { code: tag + s, name: `TEST-MC1 ${tag} ${s}`, approval_status: "Approved", operational_status: "Active", city: "Jaipur" }, 201)).data.item;
const locA = await mkLoc("A");
const locB = await mkLoc("B");
const mkProg = async (tag) => (await req(admin, "POST", "/api/programs", { code: `${tag}${s}`, name: `MC1 ${tag} ${s}`, trainer_skill: "MC1Skill" + s }, 201)).data.item;
const prog = await mkProg("PG");

// ---- batches: [tag, centre, status, target, createdAt, actual_start] ---------------------------------
const BATCHES = [
  ["pa1",    locA, "Planning", 20, istAt(D, 0, 1),   null],            // created D 00:01 IST  -> IN
  ["pa2",    locA, "Ready",    10, istAt(D, 23, 59), istAt(D, 2, 0)],  // created D 23:59 IST -> IN; started by `new Date()` at 02:00 IST D (an INSTANT, 20:30Z on D-1) -> IN D, not D-1
  ["act",    locA, "Active",   50, istAt(PREV, 23, 59), bizDay(D)],    // created D-1 23:59 -> OUT; started D -> IN
  ["closed", locA, "Closed",   12, istAt(NEXT, 0, 1), bizDay(PREV)],   // created D+1 00:01 -> OUT; started D-1 -> OUT
  ["pb1",    locB, "Planning", 30, istAt(D, 10, 0),  null],            // centre B
];
const fx = {};
for (const [tag, loc, status, target, createdAt, actualStart] of BATCHES) {
  const r = await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: today(), target_size: target });
  if (r.status !== 201) { ok(`[precondition] batch ${tag} created`, false, JSON.stringify(r.data).slice(0, 160)); continue; }
  const b = r.data.item;
  const $set = { status, target_size: target, createdAt, ...(actualStart ? { actual_start: actualStart } : {}) };
  await db.collection("batches").updateOne({ _id: oid(b._id) }, { $set });
  fx[tag] = { id: String(b._id), code: b.code, loc, target };
}
ok("[precondition] all five batch fixtures exist", Object.keys(fx).length === BATCHES.length, Object.keys(fx).join(","));

// ---- batch members. joined_on is a BUSINESS date (dayKey), like the product writes it ----------------
const NOW = new Date();
const mem = (batchTag, joinedDay, left = false) => ({
  batch: oid(fx[batchTag].id), candidate: new ObjectId(), joined_on: bizDay(joinedDay),
  left_on: left ? bizDay(joinedDay) : null, enrollment_status: "Not Started", createdAt: NOW, updatedAt: NOW,
});
const MEMBERS = [
  ...Array.from({ length: 5 }, () => mem("pa1", "2031-03-04")),   // base roster, joined long before
  mem("pa1", D), mem("pa1", D),                                   // j1, j2: joined D (IN)
  mem("pa1", PREV), mem("pa1", NEXT),                             // j4, j5: the days either side (OUT)
  mem("pa1", D, true),                                            // j6: joined D and left D: still a join that day
  ...Array.from({ length: 2 }, () => mem("pa2", "2031-03-04")),
  mem("pa2", D),                                                  // j3
  ...Array.from({ length: 4 }, () => mem("act", "2031-03-04")),
  ...Array.from({ length: 2 }, () => mem("pb1", "2031-03-04")),
  mem("pb1", D), mem("pb1", D),
];
await db.collection("batchmembers").insertMany(MEMBERS);

// ---- candidates: enrolled_at is an INSTANT (new Date() in the product) -----------------------------
const cand = (loc, name, enrolledAt) => ({ name: `ZZ MC1 ${name} ${s}`, phone: "9" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0"), location: oid(loc._id), lifecycle_status: "Assigned", enrolled_at: enrolledAt, createdAt: NOW, updatedAt: NOW });
await db.collection("candidates").insertMany([
  cand(locA, "c1", istAt(D, 9, 0)), cand(locA, "c2", istAt(D, 23, 59, 30)),   // IN
  cand(locA, "c3", istAt(PREV, 23, 59)), cand(locA, "c4", istAt(NEXT, 0, 1)), // OUT: one minute either side
  cand(locA, "c5", null),                                                     // never enrolled
  cand(locB, "cb1", istAt(D, 12, 0)),
]);

// ---- trainers ---------------------------------------------------------------------------------------
const TR = (name, extra) => ({ name: `ZZ MC1 ${name} ${s}`, phone: "9" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0"), skills: ["MC1Skill" + s], status: "Available", active: true, pipeline_status: "Fresh Lead", createdAt: NOW, updatedAt: NOW, ...extra });
const nomA = { nominated_for_location: oid(locA._id) };
const trainers = {
  t1: TR("t1 live-Active",    { ...nomA, pipeline_status: "Certified" }),
  t2: TR("t2 live-Planning",  { ...nomA, pipeline_status: "Certified", createdAt: istAt(D, 12, 0) }),     // also the added-today one
  t3: TR("t3 free",           { ...nomA, pipeline_status: "Certified", createdAt: istAt(D, 12, 0) }),
  t4: TR("t4 unavailable",    { ...nomA, pipeline_status: "Certified", status: "Unavailable" }),
  t5: TR("t5 stored Assigned but no batch", { ...nomA, pipeline_status: "Certified", status: "Assigned" }),   // QA-031: the stored status lies
  t6: TR("t6 only a Closed batch", { ...nomA, pipeline_status: "Certified" }),
  t7: TR("t7 fresh",          { ...nomA, pipeline_status: "Fresh Lead" }),
  t8: TR("t8 shortlisted",    { ...nomA, pipeline_status: "Shortlisted" }),
  t9: TR("t9 docs",           { ...nomA, pipeline_status: "Documents Completed" }),
  t10: TR("t10 sent",         { ...nomA, pipeline_status: "Sent to NSDC" }),
  t11: TR("t11 rejected",     { ...nomA, pipeline_status: "NSDC Rejected" }),
  t12: TR("t12 TOT sched",    { ...nomA, pipeline_status: "TOT Scheduled" }),
  t13: TR("t13 dropped",      { ...nomA, pipeline_status: "Dropped" }),
  t14: TR("t14 capable only", { capable_locations: [oid(locA._id)], pipeline_status: "Certified" }),          // scope via capable_locations
  t15: TR("t15 home only",    { home_location: oid(locA._id), pipeline_status: "Fresh Lead" }),               // scope via home_location
  tb1: TR("tb1 B free",       { nominated_for_location: oid(locB._id), pipeline_status: "Certified", createdAt: istAt(D, 15, 0) }),
  tb2: TR("tb2 B fresh",      { nominated_for_location: oid(locB._id), pipeline_status: "Fresh Lead" }),
};
const trIds = {};
for (const [k, doc] of Object.entries(trainers)) trIds[k] = (await db.collection("trainers").insertOne(doc)).insertedId;
// the live-batch links: the truth the digest must read (QA-031), never the stored `status`
await db.collection("batches").updateOne({ _id: oid(fx.act.id) }, { $set: { trainer: trIds.t1 } });
await db.collection("batches").updateOne({ _id: oid(fx.pa1.id) }, { $set: { trainer: trIds.t2 } });
await db.collection("batches").updateOne({ _id: oid(fx.closed.id) }, { $set: { trainer: trIds.t6 } });

// ---- money -----------------------------------------------------------------------------------------
const cost = (loc, day, amount, payment_status) => ({
  entry_date: bizDay(day), location: oid(loc._id), amount, note: "mc1 fixture " + s, payment_status,
  reservation_state: "Applied", createdAt: NOW, updatedAt: NOW,
});
await db.collection("costentries").insertMany([
  cost(locA, D, 1000, "Paid"), cost(locA, D, 250, "Payment Pending"),      // today: 1,250 in 2 entries
  cost(locA, "2031-03-10", 4000, "Payment Pending"),                       // month to date, not today
  cost(locA, "2031-03-01", 500, "Paid"),                                   // first day of the month: IN
  cost(locA, "2031-02-28", 9999, "Payment Pending"),                       // last month: not MTD, but still payment-pending as of D
  cost(locA, NEXT, 7777, "Payment Pending"),                               // the day AFTER: in nothing as of D
  cost(locB, D, 300, "Paid"),
]);
const approval = (loc, status, amount, createdAt) => ({
  action: "cost.post", entity: "CostEntry", summary: `mc1 pending ${amount} ${s}`, payload: { amount },
  location: oid(loc._id), initiator: new ObjectId(), approver_role: "Admin", status, createdAt, updatedAt: createdAt,
});
await db.collection("approvalrequests").insertMany([
  approval(locA, "Pending", 800, istAt(D, 11, 0)),         // raised today, still pending
  approval(locA, "Pending", 300, istAt(PREV, 11, 0)),      // raised earlier, still pending as of D
  approval(locA, "Approved", 555, istAt(D, 11, 0)),        // decided: not pending
  approval(locA, "Pending", 4242, istAt(NEXT, 11, 0)),     // raised the day AFTER: not pending as of D
  approval(locB, "Pending", 99, istAt(D, 11, 0)),
]);

// ---- personas ------------------------------------------------------------------------------------------
const PW = "Mc1Persona9!x";
const mkUser = async (role, scope, tag, extra = {}) => {
  const email = `zzcheck.mc1${tag}.${s.toLowerCase()}@vidysea-test.local`;
  const r = await req(admin, "POST", "/api/users", { name: `ZZ MC1 ${tag}`, email, password: PW, role, location_scope: scope, can_edit: true, ...extra });
  return { email, id: r.data?.item?._id ?? r.data?._id, cookie: r.status === 201 ? await login(email, PW) : null, status: r.status };
};
const uA = await mkUser("Location", [locA._id], "a");
const uAF = await mkUser("Location", [locA._id], "af", { extra_permissions: ["finance.view"] });
const uB = await mkUser("Location", [locB._id], "b");
const uBF = await mkUser("Location", [locB._id], "bf", { extra_permissions: ["finance.view"] });
const uOps = await mkUser("Operations", [], "ops");
const uAdm = await mkUser("Admin", [], "adm");
const uTr = await mkUser("Trainer", [locA._id], "tr");
const uOff = await mkUser("Operations", [], "off");        // an active ERP account whose OWN mail switch is off (QA-2461)
await db.collection("users").updateOne({ _id: oid(uOff.id) }, { $set: { mail_enabled: false } });
const uAdv = await mkUser("Location", [locA._id], "adv", { can_edit: false, extra_permissions: ["defaults.manage"] }); // holds defaults.manage but may only VIEW (can_edit false): must not edit the list (requireEdit exempts Admin AND Operations, so only a Location-type grantee can be refused by it)
// QA-2923: non-Admin holders of defaults.manage who ARE allowed to edit (can_edit true): the only personas that get past requirePerm/requireEdit to the list write
const uGL = await mkUser("Location", [locA._id], "gl", { extra_permissions: ["defaults.manage"] });
const uGO = await mkUser("Operations", [], "go", { extra_permissions: ["defaults.manage"] });
const uD = await mkUser("Operations", [], "d");                           // an eligible recipient that the arms deactivate and reactivate
const uDead = await mkUser("Operations", [], "dead");                     // a deactivated account (cannot receive; cannot log in)
await db.collection("users").updateOne({ _id: oid(uDead.id) }, { $set: { active: false } });
const uGone = await mkUser("Operations", [], "gone");                     // picked, then REMOVED (U4)
const uRej = await mkUser("Operations", [], "rej");                       // an account whose approval was REJECTED: it cannot sign in, so it cannot receive the digest
await db.collection("users").updateOne({ _id: oid(uRej.id) }, { $set: { approval_status: "Rejected" } });
const uDrop = await mkUser("Operations", [], "drop");                     // a DROPPED account: the product renames its login email and keeps the original in dropped_email
await db.collection("users").updateOne({ _id: oid(uDrop.id) }, { $set: { dropped: true, dropped_email: uDrop.email.toLowerCase(), email: `dropped.1700000000.${uDrop.email.toLowerCase()}` } });
ok("[precondition] personas (Location A, Location A + finance.view, Location B, Location B + finance.view, Operations, Admin, Trainer) can log in",
  !!(uA.cookie && uAF.cookie && uB.cookie && uBF.cookie && uOps.cookie && uAdm.cookie && uTr.cookie),
  JSON.stringify({ a: uA.status, af: uAF.status, b: uB.status, bf: uBF.status, ops: uOps.status, adm: uAdm.status, tr: uTr.status }));
ok("[precondition] the cycle-2 personas exist (the defaults.manage view-only grantee can log in; deactivated, removable and re-emailable accounts have ids)", !!(uAdv.cookie && uAdv.id && uD.id && uDead.id && uGone.id), JSON.stringify({ adv: uAdv.status, d: uD.status, dead: uDead.status, gone: uGone.status }));

const digest = (cookie, day) => req(cookie, "GET", `/api/reports/daily${day ? `?date=${day}` : ""}`);
// By default a tick's first attempt is simulated as "sent" (every test env suppresses mail, so a real send is always
// "skipped" and would now be retried): the arms T1-T6 below are about composition and once-a-day, not retry.
// The retry arms (R1-R5) pass their own `simulate`, or [] for the real, suppressed outcome.
const tick = (nowDate, instance, cookie = admin, extra = {}) => req(cookie, "POST", "/api/test/digest-tick", { now: nowDate.toISOString(), instance, simulate: ["sent"], ...extra });
const digestRows = (day, tos) => mailLogs.find({ entity: "DailyDigest", subject: mailSubject(day), to: { $in: tos } }).toArray();
const rowsByTo = (rows) => Object.fromEntries(rows.map((r) => [r.to, (rows.filter((x) => x.to === r.to).length)]));

// =================================================================================================
// D1 - exact candidates numbers (Location A: scoped, so the shared wall DB cannot move them)
// =================================================================================================
const rA = await digest(uA.cookie, D);
const dA = rA.data;
ok("D1: GET /api/reports/daily answers 200 for a Location user", rA.status === 200, `${rA.status} ${JSON.stringify(rA.data).slice(0, 120)}`);
ok("D1: the response names the day it describes", dA?.day === D, String(dA?.day));
const byBatchA = Object.fromEntries((dA?.candidates?.joined?.by_batch ?? []).map((r) => [r.code, r.count]));
ok("D1: joined into batches on the day = 4 (j1, j2, j3 and the one who joined and left that day; the days either side are out)",
  dA?.candidates?.joined?.total === 4, JSON.stringify(dA?.candidates?.joined));
ok("D1: ...grouped by batch: first Planning batch 3, Ready batch 1, nothing else",
  eq(byBatchA, { [fx.pa1.code]: 3, [fx.pa2.code]: 1 }), JSON.stringify(byBatchA));
ok("D1: enrolled on the day = 2 (09:00 and 23:59:30 IST; 23:59 the day before and 00:01 the day after are out; a never-enrolled candidate is out)",
  dA?.candidates?.enrolled?.total === 2, JSON.stringify(dA?.candidates?.enrolled));
ok("D1: training starts count people, not batches: 3 Ready-batch members plus 4 Active-batch members = 7",
  dA?.candidates?.training_started?.total === 7, JSON.stringify(dA?.candidates?.training_started));
ok("D1: current enrolled reuses the Candidates bucket (all five Assigned rows), not daily enrolments; none is Training Ongoing",
  dA?.candidates?.current?.enrolled === 5 && dA?.candidates?.current?.training_ongoing === 0, JSON.stringify(dA?.candidates?.current));
ok("D1: current learner totals name a valid measurement time even on the historical chosen day",
  Number.isFinite(Date.parse(dA?.candidates?.current?.measured_at)) && dA?.candidates?.current?.measured_at?.slice(0, 10) !== D,
  JSON.stringify(dA?.candidates?.current));
ok("D1: batches created on the day = 2 (00:01 IST and 23:59 IST; the batch created the previous 23:59 and the next 00:01 are out)",
  eq((dA?.candidates?.batches_created ?? []).map((b) => b.code).sort(), [fx.pa1.code, fx.pa2.code].sort()), JSON.stringify(dA?.candidates?.batches_created));
ok("D1: batches started on the day = 2 (the Active batch with a typed start date, and the Ready batch stamped at 02:00 IST: an instant whose UTC date is the day before)",
  eq((dA?.candidates?.batches_started ?? []).map((b) => b.code).sort(), [fx.act.code, fx.pa2.code].sort()), JSON.stringify(dA?.candidates?.batches_started));
ok("D1: mobilised = 2 planning batches, target 30, mobilised 12 (9 + 3: a member who left is not counted), gap 18; the Active batch is not in it",
  eq(dA?.candidates?.mobilised, { batches: 2, target: 30, mobilised: 12, gap: 18 }), JSON.stringify(dA?.candidates?.mobilised));

// =================================================================================================
// D2 - exact trainers numbers, from Batch links and never from the stored status
// =================================================================================================
const trA = dA?.trainers ?? {};
ok("D2: assigned = 2 (a live Active and a live Planning batch point at them)", trA.assigned === 2, JSON.stringify(trA));
ok("D2: free to assign = 4: free, capable-only, a stored-Assigned trainer with no batch (QA-031), and one with only a Closed batch",
  trA.idle === 4, JSON.stringify(trA));
ok("D2: unavailable = 1 and rejected/dropped = 2 are counted apart from the free ones", trA.unavailable === 1 && trA.rejected_dropped === 2, JSON.stringify(trA));
const bucketsA = Object.fromEntries((trA.pipeline?.buckets ?? []).map((b) => [b.key, b.count]));
ok("D2: the pipeline is 6 trainers in STAGE_BUCKETS: fresh 2 (one reached through home_location), shortlisted 1, docs 1, sent 1, approved 1, certified 0",
  trA.pipeline?.total === 6 && eq(bucketsA, { fresh: 2, shortlisted: 1, docs: 1, sent: 1, approved: 1, certified: 0 }), JSON.stringify(trA.pipeline));
ok("D2: trainers added on the day = 2 (created 12:00 IST that day)", trA.added === 2, String(trA.added));

// =================================================================================================
// D3 - costs: exact numbers, only for finance.view
// =================================================================================================
const rAF = await digest(uAF.cookie, D);
const cAF = rAF.data?.costs;
ok("D3: a viewer holding finance.view gets the costs section", rAF.status === 200 && !!cAF && rAF.data?.finance === true, JSON.stringify(rAF.data?.costs)?.slice(0, 160));
ok("D3: approved spend today = 1,250 in 2 entries", cAF?.today?.amount === 1250 && cAF?.today?.entries === 2, JSON.stringify(cAF?.today));
ok("D3: month to date = 5,750 in 4 entries (1 March in, 28 February out, the 15th out)", cAF?.month?.amount === 5750 && cAF?.month?.entries === 4, JSON.stringify(cAF?.month));
ok("D3: pending approval = 1,100 in 2 requests as of that day (an approved one and one raised the next day are out), 800 of it raised today",
  cAF?.pending?.amount === 1100 && cAF?.pending?.count === 2 && cAF?.pending?.raised_today?.amount === 800 && cAF?.pending?.raised_today?.count === 1, JSON.stringify(cAF?.pending));
ok("D3: payment pending = 14,249 in 3 entries as of that day (today's 250, the 10th's 4,000 and last month's 9,999; the next day's is out)",
  cAF?.payment_pending?.amount === 14249 && cAF?.payment_pending?.count === 3, JSON.stringify(cAF?.payment_pending));
const rA2 = dA;
ok("D3: a Location user WITHOUT finance.view gets costs: null and finance: false", rA2?.costs === null && rA2?.finance === false, JSON.stringify(rA2?.costs));
// ids are hex and can contain any four digits by chance, so they are dropped before the digit search
const noIds = (o) => JSON.stringify(o, (k, v) => (/(^|_)id$/.test(k) || k === "generated_at" ? undefined : v));
ok("D3: ...and no cost figure is anywhere in its response", !/1250|5750|14249|1100/.test(noIds(rA2)), "");
const rAdmG = await digest(uAdm.cookie, D);
ok("D3: an Admin does not get costs for free (finance.view is outside the Admin bypass)", rAdmG.status === 200 && rAdmG.data?.costs === null && rAdmG.data?.finance === false, JSON.stringify(rAdmG.data?.costs));
const rOpsG = await digest(uOps.cookie, D);
ok("D3: Operations without the grant gets costs: null too", rOpsG.status === 200 && rOpsG.data?.costs === null, JSON.stringify(rOpsG.data?.costs));

// =================================================================================================
// D4 - centre scope, in every section
// =================================================================================================
const rB = await digest(uB.cookie, D);
const dB = rB.data;
ok("D4: Location B sees only centre B: joined 2, enrolled 1, created 1, mobilised 1 batch / target 30 / mobilised 4 / gap 26",
  dB?.candidates?.joined?.total === 2 && dB?.candidates?.enrolled?.total === 1 && (dB?.candidates?.batches_created ?? []).length === 1
  && eq(dB?.candidates?.mobilised, { batches: 1, target: 30, mobilised: 4, gap: 26 }), JSON.stringify(dB?.candidates));
ok("D4: Location B's current learner total is its own one row; its Planning batch supplies no training starts or missing-start exception",
  dB?.candidates?.current?.enrolled === 1 && dB?.candidates?.current?.training_ongoing === 0
  && dB?.candidates?.training_started?.total === 0 && dB?.candidates?.training_started?.exceptions?.missing_actual_start === 0,
  JSON.stringify(dB?.candidates));
ok("D4: Location B's trainers are centre B's: free 1, pipeline 1, added 1; none of centre A's 14", dB?.trainers?.idle === 1 && dB?.trainers?.pipeline?.total === 1 && dB?.trainers?.added === 1 && dB?.trainers?.assigned === 0, JSON.stringify(dB?.trainers));
const bJson = JSON.stringify(dB);
ok("D4: no centre-A batch code or centre name is anywhere in Location B's response", !bJson.includes(fx.pa1.code) && !bJson.includes(fx.act.code) && !bJson.includes(locA.name), "");
const aJson = JSON.stringify(dA);
ok("D4: no centre-B batch code is anywhere in Location A's response", !aJson.includes(fx.pb1.code) && !aJson.includes(locB.name), "");
const rBF = await digest(uBF.cookie, D);
const cBF = rBF.data?.costs;
ok("D4: Location B with finance.view sees centre B's money only: today 300 in 1 entry, month 300, pending 99, payment pending 0",
  cBF?.today?.amount === 300 && cBF?.today?.entries === 1 && cBF?.month?.amount === 300 && cBF?.pending?.amount === 99 && cBF?.pending?.count === 1 && cBF?.payment_pending?.count === 0, JSON.stringify(cBF));
const rOps = rOpsG.data;
ok("D4: an unscoped viewer (Operations) sees at least both centres' joins (4 + 2) on that day", (rOps?.candidates?.joined?.total ?? 0) >= 6, JSON.stringify(rOps?.candidates?.joined));
const rTrDoor = await digest(uTr.cookie, D);
ok("D4: a Trainer login is refused at the door (403)", rTrDoor.status === 403, `${rTrDoor.status}`);

// =================================================================================================
// D5 - the IST day boundary, in every encoding
// =================================================================================================
const rPrev = (await digest(uA.cookie, PREV)).data;
const rNext = (await digest(uA.cookie, NEXT)).data;
ok("D5: the day BEFORE sees exactly the 23:59 enrolment (1) and the one join dated that day (1), and the created/started it owns",
  rPrev?.candidates?.enrolled?.total === 1 && rPrev?.candidates?.joined?.total === 1
  && eq((rPrev?.candidates?.batches_created ?? []).map((b) => b.code), [fx.act.code]) && eq((rPrev?.candidates?.batches_started ?? []).map((b) => b.code), [fx.closed.code]), JSON.stringify(rPrev?.candidates));
ok("D5: the day AFTER sees exactly the 00:01 enrolment (1), its join (1) and the batch created at 00:01 IST",
  rNext?.candidates?.enrolled?.total === 1 && rNext?.candidates?.joined?.total === 1 && eq((rNext?.candidates?.batches_created ?? []).map((b) => b.code), [fx.closed.code]), JSON.stringify(rNext?.candidates));
const bad = await digest(uA.cookie, "2031-13-45");
ok("D5: a malformed date is a 400, not a silent today", bad.status === 400, `${bad.status}`);
// the process clock cannot be moved, so the door reports which IST day an INSTANT falls on
const dayOf = async (d) => (await tick(d, "probe-" + s)).data?.today_ist;
ok("D5: 23:59 IST on the 14th is the 14th and 00:01 IST on the 15th is the 15th (the UTC dates of those instants are 14 and 14)",
  (await dayOf(istAt(D, 23, 59))) === D && (await dayOf(istAt(NEXT, 0, 1))) === NEXT, `${await dayOf(istAt(D, 23, 59))} / ${await dayOf(istAt(NEXT, 0, 1))}`);
ok("D5: 00:01 IST is NOT the previous day: the one minute after midnight belongs to the new day", (await dayOf(istAt(D2, 0, 1))) === D2, String(await dayOf(istAt(D2, 0, 1))));

// Learner movement uses actual start instants and roster business dates. These rows are removed
// before the older exact-count scheduler/UI arms, keeping every oracle independent of this addition.
const learnerBatches = {};
for (const [tag, loc, status, actualStart] of [
  ["edge", locA, "Active", istAt(D, 23, 59)], ["duplicate", locA, "Active", istAt(D, 10, 0)],
  ["next", locA, "Active", istAt(NEXT, 0, 1)], ["missing", locA, "Active", null],
  ["planned", locA, "Planning", null], ["scoped", locB, "Active", istAt(D, 10, 0)],
]) {
  const made = await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: today(), target_size: 20 });
  ok(`[precondition] learner batch ${tag} created`, made.status === 201, String(made.status));
  learnerBatches[tag] = made.data?.item?._id;
  if (learnerBatches[tag]) await db.collection("batches").updateOne({ _id: oid(learnerBatches[tag]) }, { $set: { status, planned_start: bizDay(D), actual_start: actualStart } });
}
const learnerCandidateIds = Array.from({ length: 8 }, () => new ObjectId());
const learnerCandidates = [
  { lifecycle_status: "Enrolled", enrolled_at: istAt(PREV, 9, 0) },
  { lifecycle_status: "Enrolled", enrolled_at: istAt(PREV, 9, 0) },
  { lifecycle_status: "Dropped", enrolled_at: istAt(PREV, 9, 0) },
  { lifecycle_status: "Unassigned", enrolled_at: istAt(PREV, 9, 0) },
  { lifecycle_status: "Completed", enrolled_at: istAt(PREV, 9, 0) },
  { lifecycle_status: "Enrolled", enrolled_at: istAt(PREV, 9, 0), archived_at: NOW },
  { lifecycle_status: "Dropped", enrolled_at: null },
  { lifecycle_status: "Enrolled", enrolled_at: istAt(PREV, 9, 0) },
].map((extra, i) => ({ ...cand(locA, `learner-${i}`, extra.enrolled_at), ...extra, _id: learnerCandidateIds[i] }));
await db.collection("candidates").insertMany(learnerCandidates);
const duplicateLearner = new ObjectId();
const lm = (tag, joinedDay, leftDay = null, candidate = new ObjectId()) => ({
  batch: oid(learnerBatches[tag]), candidate, joined_on: joinedDay ? bizDay(joinedDay) : null,
  left_on: leftDay ? bizDay(leftDay) : null, enrollment_status: "Completed", createdAt: NOW, updatedAt: NOW,
});
await db.collection("batchmembers").insertMany([
  lm("edge", PREV, null, learnerCandidateIds[1]), // roster before actual start; also current Training Ongoing
  lm("edge", NEXT),                            // late join starts NEXT, despite the earlier actual start
  lm("edge", PREV, PREV),                      // left before start: never started
  lm("edge", PREV, NEXT),                      // left later: historical start remains
  lm("edge", PREV, D),                         // departure on start day is not departure before it
  lm("edge", PREV, NEXT, duplicateLearner), lm("duplicate", PREV, NEXT, duplicateLearner),
  lm("next", PREV), lm("missing", PREV), lm("edge", null), lm("planned", PREV), lm("scoped", PREV),
]);
const resultId = new ObjectId();
await db.collection("candidateresults").insertOne({ _id: resultId, candidate: learnerCandidateIds[7], batch: oid(learnerBatches.edge), result: "Pass", assessed_on: bizDay(D), createdAt: NOW, updatedAt: NOW });
const learnersD = (await digest(uA.cookie, D)).data;
const learnersNext = (await digest(uA.cookie, NEXT)).data;
ok("D6: actual starts count 11 distinct learners: baseline 7 plus before-start roster, later departure, same-day departure and one duplicated candidate",
  learnersD?.candidates?.training_started?.total === 11, JSON.stringify(learnersD?.candidates?.training_started));
ok("D6: late join and 00:01 IST actual start count on NEXT only (2); planned dates never produce a learner start",
  learnersNext?.candidates?.training_started?.total === 2, JSON.stringify(learnersNext?.candidates?.training_started));
ok("D6: missing actual start and missing roster join are separate measured-now data exceptions, not invented training dates",
  learnersD?.candidates?.training_started?.exceptions?.missing_actual_start === 1
  && learnersD?.candidates?.training_started?.exceptions?.missing_join_date === 1,
  JSON.stringify(learnersD?.candidates?.training_started));
const currentRows = (await req(uA.cookie, "GET", "/api/candidates?limit=2000")).data?.items ?? [];
const linkedLearner = currentRows.find((r) => String(r._id) === String(learnerCandidateIds[1]));
const unlinkedLearner = currentRows.find((r) => String(r._id) === String(learnerCandidateIds[0]));
ok("NAV: enrolled candidate returns its actual batch id, while a candidate without an active roster stays unlinked",
  String(linkedLearner?.active_batch?._id) === String(learnerBatches.edge) && !!unlinkedLearner && unlinkedLearner.active_batch === null,
  JSON.stringify({ linked: linkedLearner?.active_batch, unlinked: unlinkedLearner?.active_batch }));
// Independent case oracle for these fixtures: Assigned counts enrolled, completed and enrolled-dropout
// count enrolled, Fresh/archived do not. In training (Umesh 2026-11-03) = a held seat in an Active, actually-started batch:
// of the two Enrolled rows without a recorded result only learner-1 holds one (edge); learner-0 has no seat, so 1.
ok("D7: current totals agree with the exact Candidates rows, including dropout, Fresh, archived and recorded-result precedence",
  currentRows.length === 13 && learnersD?.candidates?.current?.enrolled === 10 && learnersD?.candidates?.current?.training_ongoing === 1,
  JSON.stringify({ rows: currentRows.length, current: learnersD?.candidates?.current }));
ok("D7: choosing another report day leaves current learner totals current, while daily enrolments retain their selected-day meaning",
  learnersNext?.candidates?.current?.enrolled === 10 && learnersNext?.candidates?.current?.training_ongoing === 1
  && learnersD?.candidates?.enrolled?.total === 2 && learnersNext?.candidates?.enrolled?.total === 1,
  JSON.stringify({ day: learnersD?.candidates, next: learnersNext?.candidates }));
const learnersB = (await digest(uB.cookie, D)).data;
ok("D7: learner starts and current totals respect centre scope (B sees its one added start and one existing candidate)",
  learnersB?.candidates?.training_started?.total === 1 && learnersB?.candidates?.current?.enrolled === 1,
  JSON.stringify(learnersB?.candidates));
await db.collection("batchmembers").deleteMany({ batch: { $in: Object.values(learnerBatches).map(oid) } });
await db.collection("batches").deleteMany({ _id: { $in: Object.values(learnerBatches).map(oid) } });
await db.collection("candidates").deleteMany({ _id: { $in: learnerCandidateIds } });
await db.collection("candidateresults").deleteOne({ _id: resultId });

// =================================================================================================
// K - Karunn sir's review 2026-11-02: tables, stage entries per period, trained-not-available, targets, activity
// =================================================================================================
const tblOf = (d, key) => (d?.tables ?? []).find((t) => t.key === key);
const cellsAt = (d, key, label) => tblOf(d, key)?.rows.find((r) => r.label === label)?.cells ?? null;
const bucketLabel = (k) => (dA?.trainers?.pipeline?.buckets ?? []).find((b) => b.key === k)?.label;
const dash3 = ["—", "—", "—"];
ok("K1: a centre login without money gets two tables, Trainers and Candidates (no target table: targets are organisation-wide; no Costs)",
  eq((dA?.tables ?? []).map((t) => t.key), ["trainers", "candidates"]) && dA?.targets === null, JSON.stringify((dA?.tables ?? []).map((t) => t.key)));
ok("K1: the finance viewer also gets Costs, worded from the same figures (today Rs 1,250 in 2, payment pending Rs 14,249 in 3)",
  eq((rAF.data?.tables ?? []).map((t) => t.key), ["trainers", "candidates", "costs"]) && eq(cellsAt(rAF.data, "costs", "Approved on the day"), ["Rs 1,250", "2"])
  && eq(cellsAt(rAF.data, "costs", "Payment pending"), ["Rs 14,249", "3"]) && eq(cellsAt(rAF.data, "costs", "of which raised on the day"), ["Rs 800", "1"]), JSON.stringify(tblOf(rAF.data, "costs")?.rows));
ok("K1: the week runs Monday to Sunday: 2031-03-14 (a Friday) sits in 2031-03-10 to 2031-03-16, and the column says so",
  eq(dA?.week, { from: "2031-03-10", to: "2031-03-16" }) && tblOf(dA, "candidates")?.head?.[3] === "This week (2031-03-10 to 2031-03-14)", JSON.stringify([dA?.week, tblOf(dA, "candidates")?.head]));
// Candidates, centre A, day D. Columns: Now, on the day, this week, cumulative (a centre login: all time).
const candExpect = {
  "Joined into batches": ["—", "4", "5", "16"],            // week adds the day before (j4); all time adds the 11 base rows; the day after is out
  "Enrolled": ["5", "2", "3", "3"],                       // week adds 23:59 IST the day before; 00:01 the day after is out
  "In training (started Active batch)": ["0", ...dash3],
  "Certified (certificate issued)": ["—", "0", "0", "0"],
  "Batches created": ["—", "2", "3", "3"],                // week adds the batch created 23:59 IST the day before
  "Batches started": ["—", "2", "3", "3"],                // week adds the Closed batch started the day before
  "Mobilised (planning batches)": ["12 of 30 (gap 18)", ...dash3],
};
const candBad = Object.entries(candExpect).filter(([l, c]) => !eq(cellsAt(dA, "candidates", l), c)).map(([l, c]) => `${l}: got ${JSON.stringify(cellsAt(dA, "candidates", l))} want ${JSON.stringify(c)}`);
ok("K2: the Candidates table, cell for cell: on the day / this week / cumulative each count the same thing over their own range", candBad.length === 0, candBad.join(" | "));
const ts = cellsAt(dA, "candidates", "Training started");
ok("K2: training started: on the day 7, and a wider range never counts fewer", ts?.[1] === "7" && Number(ts?.[2]) >= 7 && Number(ts?.[3]) >= Number(ts?.[2]), JSON.stringify(ts));
ok("K2: the on-the-day column IS the day's figures (one definition each): joined, enrolled, started, batches created and started",
  cellsAt(dA, "candidates", "Joined into batches")?.[1] === String(dA?.candidates?.joined?.total) && cellsAt(dA, "candidates", "Enrolled")?.[1] === String(dA?.candidates?.enrolled?.total)
  && ts?.[1] === String(dA?.candidates?.training_started?.total) && cellsAt(dA, "candidates", "Batches created")?.[1] === String(dA?.candidates?.batches_created?.length)
  && cellsAt(dA, "candidates", "Batches started")?.[1] === String(dA?.candidates?.batches_started?.length), "");
// Trainers, centre A: the fixtures were inserted, not moved, so no trainer ENTERED a stage through the door here.
const trExpect = {
  [bucketLabel("fresh")]: ["2", "2", "2", "15"],           // Now = fresh leads; the period columns = trainers ADDED (t2, t3 on the day; all 15 by then)
  [bucketLabel("certified")]: ["7", "0", "0", "0"],        // Now = assigned 2 + free 4 + marked unavailable 1
  "Assigned to a live batch": ["2", ...dash3],
  "Free to assign": ["4", ...dash3],
  "Marked unavailable": ["1", ...dash3],
  "Trained, not available (incl. dropped after Certified)": ["1", ...dash3],
  "Reason not set": ["1", ...dash3],                       // t4 was marked Unavailable before the reason existed
  "Backed out": ["0", ...dash3],
  "Rejected / dropped": ["2", "0", "0", "0"],
  "Total trainers": ["15", ...dash3],
};
const trBad = Object.entries(trExpect).filter(([l, c]) => !eq(cellsAt(dA, "trainers", l), c)).map(([l, c]) => `${l}: got ${JSON.stringify(cellsAt(dA, "trainers", l))} want ${JSON.stringify(c)}`);
ok("K2: the Trainers table, cell for cell (Certified now = assigned + free + unavailable; an old Unavailable shows 'Reason not set')", trBad.length === 0, trBad.join(" | "));
ok("K2: the stage rows plus rejected/dropped add up to Total trainers",
  [...(dA?.trainers?.pipeline?.buckets ?? []).map((b) => Number(cellsAt(dA, "trainers", b.label)?.[0])), Number(cellsAt(dA, "trainers", "Rejected / dropped")?.[0])].reduce((a, b) => a + b, 0) === 15, "");

// K3 - the Monday boundary: Sunday 2031-03-16 closes the week, Monday 2031-03-17 opens the next one
const dSun = (await digest(uA.cookie, "2031-03-16")).data, dMon = (await digest(uA.cookie, "2031-03-17")).data;
ok("K3: on Sunday 2031-03-16 the week is still 03-10..03-16 and holds all four enrolments (the Saturday 00:01 one too)",
  eq(dSun?.week, { from: "2031-03-10", to: "2031-03-16" }) && eq(cellsAt(dSun, "candidates", "Enrolled")?.slice(1), ["0", "4", "4"]), JSON.stringify([dSun?.week, cellsAt(dSun, "candidates", "Enrolled")]));
ok("K3: on Monday 2031-03-17 a new week starts (03-17..03-23): the week column drops to 0, the cumulative keeps 4",
  eq(dMon?.week, { from: "2031-03-17", to: "2031-03-23" }) && eq(cellsAt(dMon, "candidates", "Enrolled")?.slice(1), ["0", "0", "4"])
  && eq(cellsAt(dMon, "candidates", "Joined into batches")?.slice(1, 3), ["0", "0"]), JSON.stringify([dMon?.week, cellsAt(dMon, "candidates", "Enrolled")]));

// K5 - stage entries through the REAL door, and the reason for a trained trainer who is not available.
// Its own centre C, so the counts are exact; the moves happen now, so the digest asked is today's.
const locC = await mkLoc("C");
const uC = await mkUser("Location", [locC._id], "c");
const nomC = { nominated_for_location: oid(locC._id) };
const kIds = {};
for (const k of ["k1", "k2", "k3", "k4"]) kIds[k] = String((await db.collection("trainers").insertOne(TR(`${k} stage`, { ...nomC, createdAt: new Date() }))).insertedId);
const move = (k, target, extra = {}) => req(admin, "POST", `/api/trainers/${kIds[k]}/transition`, { target, bypass: true, reason: "mc1 " + k, ...extra });
const mv = [await move("k1", "Certified"), await move("k2", "Certified"), await move("k3", "Shortlisted"), await move("k4", "NSDC Rejected")];
ok("[precondition] K5: four trainers moved through the transition door (two to Certified, one to Shortlisted, one NSDC Rejected)", mv.every((r) => r.status === 200), mv.map((r) => r.status).join(","));
const dropNo = await move("k2", "Dropped");
const dropBad = await move("k2", "Dropped", { payload: { unavailable_reason: "Went home" } });
ok("K5: dropping a trained (Certified) trainer without a reason is refused 400 and names the three reasons, even on a bypass",
  dropNo.status === 400 && /Backed out/.test(dropNo.data?.error ?? "") && dropBad.status === 400 && (await db.collection("trainers").findOne({ _id: oid(kIds.k2) }))?.pipeline_status === "Certified", `${dropNo.status} ${dropBad.status} ${dropNo.data?.error}`);
const dropOk = await move("k2", "Dropped", { payload: { unavailable_reason: "Absconding" } });
const k2 = await db.collection("trainers").findOne({ _id: oid(kIds.k2) });
ok("K5: with a reason the drop goes through and the trainer carries it (Absconding, dropped from Certified)",
  dropOk.status === 200 && k2?.pipeline_status === "Dropped" && k2?.unavailable_reason === "Absconding" && k2?.dropped_from_stage === "Certified", JSON.stringify({ st: dropOk.status, r: k2?.unavailable_reason, from: k2?.dropped_from_stage }));
const unNo = await req(uC.cookie, "PATCH", `/api/trainers/${kIds.k1}`, { status: "Unavailable" });
const unBad = await req(uC.cookie, "PATCH", `/api/trainers/${kIds.k1}`, { status: "Unavailable", unavailable_reason: "Busy" });
ok("K5: marking a trainer Unavailable without one of the three reasons is refused 400 (the centre's own edit door)", unNo.status === 400 && unBad.status === 400 && (await db.collection("trainers").findOne({ _id: oid(kIds.k1) }))?.status !== "Unavailable", `${unNo.status} ${unBad.status} ${JSON.stringify(unNo.data).slice(0, 120)}`);
const unOk = await req(uC.cookie, "PATCH", `/api/trainers/${kIds.k1}`, { status: "Unavailable", unavailable_reason: "Backed out" });
const backAv = await req(uC.cookie, "PATCH", `/api/trainers/${kIds.k1}`, { status: "Available" });
const k1Back = await db.collection("trainers").findOne({ _id: oid(kIds.k1) });
ok("K5: with a reason it is saved; set Available again and the reason is cleared (a stale reason would be counted)", unOk.status === 200 && backAv.status === 200 && k1Back?.status === "Available" && !k1Back?.unavailable_reason, JSON.stringify({ a: unOk.status, b: backAv.status, r: k1Back?.unavailable_reason }));
await req(uC.cookie, "PATCH", `/api/trainers/${kIds.k1}`, { status: "Unavailable", unavailable_reason: "Backed out" });
const dC = (await digest(uC.cookie, today())).data;
const cExpect = {
  [bucketLabel("fresh")]: ["0", "4", "4", "4"],            // added today: all four
  [bucketLabel("shortlisted")]: ["1", "1", "1", "1"],      // k3 entered Shortlisted today
  [bucketLabel("certified")]: ["1", "2", "2", "2"],        // k1 holds it (marked unavailable); k1 and k2 both ENTERED it today
  "Trained, not available (incl. dropped after Certified)": ["2", ...dash3],
  "Backed out": ["1", ...dash3], "Absconding": ["1", ...dash3], "Temporarily unavailable": ["0", ...dash3], "Reason not set": ["0", ...dash3],
  "Rejected / dropped": ["2", "2", "2", "2"],              // k2 entered Dropped and k4 NSDC Rejected today: both counted where Now counts them
  [bucketLabel("sent")]: ["0", "0", "0", "0"],             // an NSDC rejection is not an entry into Sent to NSDC
  "Total trainers": ["4", ...dash3],
};
const cBad = Object.entries(cExpect).filter(([l, c]) => !eq(cellsAt(dC, "trainers", l), c)).map(([l, c]) => `${l}: got ${JSON.stringify(cellsAt(dC, "trainers", l))} want ${JSON.stringify(c)}`);
ok("K5: stage ENTRIES are counted from the transition record per period, and trained-not-available is split by reason", cBad.length === 0, cBad.join(" | "));
ok("K5: ...and the same in the data: not_available 2 = 1 marked unavailable + 1 dropped after Certified",
  dC?.trainers?.not_available?.total === 2 && dC?.trainers?.not_available?.dropped_after_trained === 1 && dC?.trainers?.not_available?.by_reason?.["Backed out"] === 1 && dC?.trainers?.not_available?.by_reason?.["Absconding"] === 1,
  JSON.stringify(dC?.trainers?.not_available));
ok("K5: centre A's digest for today does not see centre C's moves", !(dA?.tables ?? []).length || cellsAt((await digest(uA.cookie, today())).data, "trainers", bucketLabel("certified"))?.[1] === "0", "");

// K4 - weekly targets: who may write, validation before any write, the +/- cells
const TW = db.collection("weeklytargets");
await TW.deleteMany({ week_start: { $in: [bizDay("2031-03-03"), bizDay("2031-03-10")] } });   // a crashed earlier run
const putT = (cookie, rows) => req(cookie, "PUT", "/api/targets/weekly", { rows });
ok("K4: a centre login without defaults.manage may not write targets (403)", (await putT(uA.cookie, [{ week_start: "2031-03-10", trainers_trained: 1 }])).status === 403, "");
ok("K4: a defaults.manage holder who may only VIEW may not write targets (403)", (await putT(uAdv.cookie, [{ week_start: "2031-03-10", trainers_trained: 1 }])).status === 403, "");
const badCases = [
  ["a date that is not a Monday (the message names the Monday)", [{ week_start: "2031-03-12", trainers_trained: 1 }], /not a Monday[\s\S]*2031-03-10/],
  ["the same week twice", [{ week_start: "2031-03-10", trainers_trained: 1 }, { week_start: "2031-03-10", trainers_trained: 2 }], /twice/],
  ["a negative figure", [{ week_start: "2031-03-10", trainers_trained: "-3" }], /whole number/],
  ["a fraction", [{ week_start: "2031-03-10", candidates_certified: 2.5 }], /whole number/],
  ["a word", [{ week_start: "2031-03-10", candidates_in_training: "ten" }], /whole number/],
  ["a figure above 1,00,000", [{ week_start: "2031-03-10", trainers_trained: 100001 }], /whole number/],
  ["a date that does not exist", [{ week_start: "2031-02-30", trainers_trained: 1 }], /real date/],
  ["a good row followed by a bad one (nothing half-written)", [{ week_start: "2031-03-03", trainers_trained: 4 }, { week_start: "2031-03-11", trainers_trained: 1 }], /Row 2/],
];
for (const [what, rows, rx] of badCases) {
  const r = await putT(admin, rows);
  ok(`K4: refused 400 with a reason: ${what}`, r.status === 400 && rx.test(String(r.data?.error ?? "")), `${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
}
ok("K4: ...and none of those refusals wrote anything", (await TW.countDocuments({ week_start: { $in: [bizDay("2031-03-03"), bizDay("2031-03-10")] } })) === 0, "");
ok("K4: a body that is not a list of weeks is refused 400", (await req(admin, "PUT", "/api/targets/weekly", { rows: "2031-03-10" })).status === 400, "");
const auditsBefore = await db.collection("auditlogs").countDocuments({ entity: "WeeklyTarget", field: { $regex: /^2031-03-(03|10) / } });
const goodRows = [
  { week_start: "2031-03-03", trainers_trained: "4", candidates_in_training: "", candidates_certified: 2 },
  { week_start: "2031-03-10", trainers_trained: 10, candidates_in_training: "1,200", candidates_certified: "5" },
];
const saveT = await putT(admin, goodRows);
const gotT = Object.fromEntries(((await req(admin, "GET", "/api/targets/weekly")).data?.items ?? []).map((r) => [r.week_start, r]));
ok("K4: a valid paste is saved (commas read as thousands, blank kept blank) and read back exactly",
  saveT.status === 200 && saveT.data?.saved === 2 && eq(gotT["2031-03-03"], { week_start: "2031-03-03", trainers_trained: 4, candidates_in_training: null, candidates_certified: 2 })
  && eq(gotT["2031-03-10"], { week_start: "2031-03-10", trainers_trained: 10, candidates_in_training: 1200, candidates_certified: 5 }), JSON.stringify([saveT.data, gotT["2031-03-03"], gotT["2031-03-10"]]));
const auditsAfter = await db.collection("auditlogs").countDocuments({ entity: "WeeklyTarget", field: { $regex: /^2031-03-(03|10) / } });
await putT(admin, goodRows);
const auditsAgain = await db.collection("auditlogs").countDocuments({ entity: "WeeklyTarget", field: { $regex: /^2031-03-(03|10) / } });
ok("K4: every figure set is on the audit record (5), and saving the same figures again records nothing new", auditsAfter - auditsBefore === 5 && auditsAgain === auditsAfter, `${auditsAfter - auditsBefore} then +${auditsAgain - auditsAfter}`);
// the +/- arithmetic, recomputed here from the row's own actual and target
const fmt = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 }));
const varOf = (a, t) => (a === null || t === null ? "—" : `${a - t >= 0 ? "+" : "−"}${fmt(Math.abs(a - t))}`);
const toneOf = (a, t) => (a === null || t === null ? "" : a >= t ? "pos" : "neg");
const allT = await TW.find({ week_start: { $lte: bizDay("2031-03-10") } }).sort({ week_start: 1 }).toArray();
const sumF = (f) => (allT.some((r) => r[f] !== null && r[f] !== undefined) ? allT.reduce((s2, r) => s2 + (Number(r[f]) || 0), 0) : null);
const dAdmT = (await digest(uAdm.cookie, D)).data;
const tr0 = dAdmT?.targets?.rows ?? [];
const byKey = Object.fromEntries(tr0.map((r) => [r.key, r]));
ok("K4: an unscoped viewer gets the target rows: week 2031-03-10 targets 10 / 1,200 / 5; cumulative = every target week up to it",
  dAdmT?.targets?.week_from === "2031-03-10" && dAdmT?.targets?.cumulative_from === allT[0]?.week_start?.toISOString().slice(0, 10)
  && byKey.trainers_trained?.week_target === 10 && byKey.candidates_in_training?.week_target === 1200 && byKey.candidates_certified?.week_target === 5
  && byKey.trainers_trained?.cum_target === sumF("trainers_trained") && byKey.candidates_certified?.cum_target === sumF("candidates_certified")
  && byKey.candidates_in_training?.cum_target === null, JSON.stringify(dAdmT?.targets).slice(0, 300));
const tt = tblOf(dAdmT, "targets");
const tBad = (tt?.rows ?? []).flatMap((row, i) => {
  const r = tr0[i];
  const want = [fmt(r.week_target), fmt(r.week_actual), varOf(r.week_actual, r.week_target), fmt(r.cum_target), fmt(r.cum_actual), varOf(r.cum_actual, r.cum_target)];
  const tones = ["", "", toneOf(r.week_actual, r.week_target), "", "", toneOf(r.cum_actual, r.cum_target)];
  return eq(row.cells, want) && eq(row.tones, tones) ? [] : [`${row.label}: ${JSON.stringify(row.cells)} ${JSON.stringify(row.tones)} want ${JSON.stringify(want)} ${JSON.stringify(tones)}`];
});
ok("K4: the target table's +/- cells are actual minus target, signed and coloured (green at or above target, red below)", tt?.rows?.length === 3 && tBad.length === 0, tBad.join(" | ").slice(0, 300));
ok("K4: in this fixture week nobody reached Certified, so trainers trained reads 0 against 10: −10, red", byKey.trainers_trained?.week_actual === 0 && tt?.rows?.[0]?.cells?.[2] === "−10" && tt?.rows?.[0]?.tones?.[2] === "neg", JSON.stringify(tt?.rows?.[0]));
ok("K4: a centre login asking the same day gets no target figures at all", (await digest(uA.cookie, D)).data?.targets === null, "");

// K8 - a chosen range. Flow rows only: their range cell must be the sum of the "on the day" cell over each day in it.
const digestR = (cookie, day, from) => req(cookie, "GET", `/api/reports/daily?date=${day}&from=${from}`);
const FLOW = ["Joined into batches", "Enrolled", "Training started", "Certified (certificate issued)", "Batches created", "Batches started"];
const daysK8 = ["2031-03-10", "2031-03-11", "2031-03-12", "2031-03-13", "2031-03-14", "2031-03-15", "2031-03-16", "2031-03-17"];
const onDay = {};
for (const d of daysK8) { const dd = (await digest(uA.cookie, d)).data; onDay[d] = Object.fromEntries(FLOW.map((l) => [l, Number(cellsAt(dd, "candidates", l)?.[1])])); }
const k8Bad = [];
for (const [from, to] of [["2031-03-10", "2031-03-17"], ["2031-03-12", "2031-03-16"], ["2031-03-14", "2031-03-14"], ["2031-03-15", "2031-03-17"]]) {
  const r = await digestR(uA.cookie, to, from);
  if (r.status !== 200 || r.data?.range_from !== from) { k8Bad.push(`${from}..${to}: ${r.status} ${r.data?.range_from}`); continue; }
  const head = tblOf(r.data, "candidates")?.head?.[4];
  if (head !== `Range (${from} to ${to})`) k8Bad.push(`${from}..${to} head ${head}`);
  for (const l of FLOW) {
    const want = daysK8.filter((d) => d >= from && d <= to).reduce((a, d) => a + onDay[d][l], 0);
    const got = Number(cellsAt(r.data, "candidates", l)?.[3]);
    if (got !== want) k8Bad.push(`${from}..${to} ${l}: ${got} want ${want}`);
  }
}
ok("K8: a range's column is exactly the sum of the daily figures over its days (Mon..Mon, Wed..Sun, one day, across a week end)", k8Bad.length === 0, k8Bad.join(" | "));
const k8Def = (await digest(uA.cookie, "2031-03-17")).data;
ok("K8: with no range chosen nothing changes: range_from is null and the column is the cumulative one", k8Def?.range_from === null && /^Cumulative/.test(tblOf(k8Def, "candidates")?.head?.[4] ?? ""), String(tblOf(k8Def, "candidates")?.head?.[4]));
const k8T1 = (await digestR(uAdm.cookie, D, "2031-03-10")).data?.targets, k8T2 = (await digestR(uAdm.cookie, D, "2031-03-05")).data?.targets;
const tk = (t, k) => t?.rows?.find((r) => r.key === k);
ok("K8: the range target sums only the target weeks the range touches (from 03-10: week 03-10 alone; from 03-05: weeks 03-03 + 03-10)",
  k8T1?.cumulative_from === "2031-03-10" && tk(k8T1, "trainers_trained")?.cum_target === 10 && tk(k8T1, "candidates_certified")?.cum_target === 5
  && k8T2?.cumulative_from === "2031-03-05" && tk(k8T2, "trainers_trained")?.cum_target === 14 && tk(k8T2, "candidates_certified")?.cum_target === 7,
  JSON.stringify([tk(k8T1, "trainers_trained"), tk(k8T2, "trainers_trained")]));
// review -342: a range starting MID-WEEK must not cut the week column (the stage-move read is bounded by the earlier start)
// A stage move on the week's MONDAY, before the range start, so a cut week column would show it missing.
const k8Tr = await db.collection("trainers").findOne({ _id: oid(kIds.k1) });
const k8Move = await db.collection("auditlogs").insertOne({ entity: "Trainer", entity_id: k8Tr._id, field: "pipeline_status", old_value: "NSDC Approved", new_value: "Certified", actor: oid(uAdm.id), created_at: istAt("2031-03-10", 12, 0) });
for (const viewerK8 of [uAdm, uA]) {
  const plain = (await digest(viewerK8.cookie, D)).data, mid = (await digestR(viewerK8.cookie, D, "2031-03-12")).data;
  const wk = (d) => ({ tr: (tblOf(d, "trainers")?.rows ?? []).map((r) => r.cells[2]), ca: (tblOf(d, "candidates")?.rows ?? []).map((r) => r.cells[2]), tt: tk(d?.targets, "trainers_trained")?.week_actual ?? null });
  ok(`K8: a range from mid-week (Wednesday 03-12) leaves every "this week" cell as it is without a range (${viewerK8 === uAdm ? "Admin" : "centre A"})`,
    eq(wk(plain), wk(mid)) && (tblOf(plain, "trainers")?.rows ?? []).length > 0, JSON.stringify([wk(plain), wk(mid)]).slice(0, 280));
}
ok("K8: ...and that Monday move really is in the week column (the arm can see a cut)", Number(cellsAt((await digest(uAdm.cookie, D)).data, "trainers", bucketLabel("certified"))?.[2]) >= 1, "");
await db.collection("auditlogs").deleteOne({ _id: k8Move.insertedId });
const k8Refused = [];
for (const [d, f] of [[D, "2031-03-15"], [D, "2030-03-01"], [D, "2031-02-30"], [D, "14-03-2031"]]) {
  const r = await digestR(uA.cookie, d, f);
  if (r.status !== 400) k8Refused.push(`${f}: ${r.status}`);
}
ok("K8: a range that starts after the day, spans over 366 days, or is not a real date is refused 400", k8Refused.length === 0, k8Refused.join(" | "));
const k8MailsBefore = await mailLogs.countDocuments({ subject: { $regex: /^Daily digest 2031-03-14/ } });
const k8Pub = await req(admin, "POST", "/api/reports/daily/publish", { date: D, from: "2031-03-20" });
ok("K8: Publish now with a bad range is refused 400 and mails nobody", k8Pub.status === 400 && (await mailLogs.countDocuments({ subject: { $regex: /^Daily digest 2031-03-14/ } })) === k8MailsBefore, `${k8Pub.status} ${JSON.stringify(k8Pub.data).slice(0, 120)}`);
const rm = await putT(admin, [{ week_start: "2031-03-03", trainers_trained: "", candidates_in_training: null }]);
ok("K4: sending a week with every figure blank removes that week, and only that week",
  rm.status === 200 && rm.data?.removed === 1 && (await TW.countDocuments({ week_start: bizDay("2031-03-03") })) === 0 && (await TW.countDocuments({ week_start: bizDay("2031-03-10") })) === 1, JSON.stringify(rm.data));

// K7 - the activity tracker: sign-ins and work per person per IST day (Admin only)
const istRange = (day) => ({ $gte: new Date(`${day}T00:00:00+05:30`), $lte: new Date(`${day}T23:59:59.999+05:30`) });
const uCAgain = await login(uC.email, PW);
const loginRows = await db.collection("auditlogs").countDocuments({ entity: "User", entity_id: oid(uC.id), field: "login", created_at: istRange(today()) });
ok("K7: each successful sign-in is recorded (the persona signed in twice today)", !!uCAgain && loginRows === 2, String(loginRows));
const workRows = await db.collection("auditlogs").countDocuments({ actor: oid(uC.id), field: { $ne: "login" }, created_at: istRange(today()) });
const act = await req(admin, "GET", `/api/users?activity=${today()}`);
const aC = act.data?.activity?.by_user?.[String(uC.id)];
ok("K7: the Admin's activity view for today counts that person's 2 sign-ins and exactly their recorded changes, grouped by what was touched",
  act.status === 200 && act.data?.activity?.day === today() && aC?.logins === 2 && aC?.actions === workRows && workRows > 0 && (aC?.touched?.Trainer ?? 0) > 0, JSON.stringify({ aC, workRows }));
ok("K7: a day with nothing on it shows nobody for that person", (await req(admin, "GET", "/api/users?activity=2031-01-01")).data?.activity?.by_user?.[String(uC.id)] === undefined, "");
ok("K7: anyone but an Admin is refused the activity view (403)", (await req(uOps.cookie, "GET", `/api/users?activity=${today()}`)).status === 403 && (await req(uA.cookie, "GET", `/api/users?activity=${today()}`)).status === 403, "");
const logDay = await req(admin, "GET", `/api/audit/by-user/${uC.id}?day=${today()}&limit=200`);
ok("K7: the per-person log for that day is exactly the sign-ins plus the changes", logDay.status === 200 && logDay.data?.total === 2 + workRows, `${logDay.status} ${logDay.data?.total} vs ${2 + workRows}`);
ok("K7: ...and for a day without activity it is empty", (await req(admin, "GET", `/api/audit/by-user/${uC.id}?day=2031-01-01`)).data?.total === 0, "");
const uCRow = ((await req(admin, "GET", "/api/users")).data?.items ?? []).find((u) => String(u._id) === String(uC.id));
ok("K7: the account list carries the last sign-in time", uCRow?.last_login_at && Date.now() - Date.parse(uCRow.last_login_at) < 15 * 60_000, String(uCRow?.last_login_at));
// the sign-in tracker is Admin-only: a non-Admin who may read the account list gets the list, never the times
const uUM = await mkUser("Operations", [], "um", { extra_permissions: ["users.manage"] });
const umList = await req(uUM.cookie, "GET", "/api/users");
const umLeak = (umList.data?.items ?? []).find((u) => "last_login_at" in u);
ok("K7: a non-Admin with the account list (users.manage) gets no last sign-in time on any row, the signed-in persona's included",
  umList.status === 200 && (umList.data?.items ?? []).some((u) => String(u._id) === String(uC.id)) && !umLeak, `${umList.status} ${JSON.stringify(umLeak ?? null).slice(0, 120)}`);

const zeroD = "2031-07-01";
const zero = (await digest(uA.cookie, zeroD)).data;
ok("D8: a zero-activity day is an explicit report with zero new enrolments, joins and training starts, plus separately current totals",
  zero?.candidates?.enrolled?.total === 0 && zero?.candidates?.joined?.total === 0 && zero?.candidates?.training_started?.total === 0
  && zero?.candidates?.current?.enrolled === 5, JSON.stringify(zero?.candidates));

// =================================================================================================
// recipients, and T6 first (before anything is sent): who is eligible
// =================================================================================================
const unknownEmail = `zz.nobody.${s.toLowerCase()}@vidysea-test.local`;
const recipients = [uAF.email, uA.email, uAdm.email, uTr.email, unknownEmail];
// G2 (empty list), while the recipients are still empty: refused 409 and takes no cooldown
const emptyPub = await req(admin, "POST", "/api/reports/daily/publish", { date: PUBDAY });
ok("G2: Publish now with no recipients configured is a 409 that says so", emptyPub.status === 409 && /recipient/i.test(JSON.stringify(emptyPub.data)), `${emptyPub.status} ${JSON.stringify(emptyPub.data).slice(0, 120)}`);
const setDefaults = (body) => req(admin, "PUT", "/api/defaults", body);
// A list the route would refuse (a removed user, a legacy value) is written straight to the document, the way an old row sits there.
const setListDirect = (list) => db.collection("defaults").updateOne({ _singleton: "defaults" }, { $set: { digest_recipients: list } });
const putR = await setDefaults({ digest_recipients: recipients.join(", ") });
const readBack = (await req(admin, "GET", "/api/defaults")).data?.item;
ok("[precondition] the recipient list is stored and read back, and the toggle defaults to OFF", putR.status === 200 && readBack?.digest_recipients === recipients.join(", ") && readBack?.digest_only_approval_mails === false,
  JSON.stringify({ put: putR.status, rb: readBack?.digest_recipients, toggle: readBack?.digest_only_approval_mails }));
const zeroTick = await tick(istAt(zeroD, 21, 0), "zero-" + s);
const zeroText = String(zeroTick.data?.results?.find((r) => r.to === uA.email.toLowerCase())?.text ?? "");
ok("D8: a zero-activity scheduled report still attempts the recipient list and explicitly mails zero daily figures plus current totals",
  zeroTick.data?.fired === true && (await digestRows(zeroD, recipients)).length === 5
  && mailRow(zeroText, "Joined into batches")?.[1] === "0" && eq(mailRow(zeroText, "Enrolled")?.slice(0, 2), ["5", "0"])
  && mailRow(zeroText, "Training started")?.[1] === "0" && mailRow(zeroText, "In training (started Active batch)")?.[0] === "0",
  JSON.stringify({ fired: zeroTick.data?.fired, text: zeroText.slice(0, 400) }));

// =================================================================================================
// T1 - the tick fires at 21:00 IST and not at 20:59
// =================================================================================================
const before = await tick(istAt(D, 20, 59, 59), "inst-early-" + s);
ok("T1: at 20:59:59 IST the tick does nothing", before.status === 200 && before.data?.fired === false && (before.data?.results ?? []).length === 0, JSON.stringify(before.data).slice(0, 160));
ok("T1: ...and it left no mail row and no day claim", (await digestRows(D, recipients)).length === 0 && (await jobLocks.countDocuments({ _id: { $regex: `^digest-sent:${D}:` } })) === 0, "");
const at21 = await tick(istAt(D, 21, 0, 0), "inst-a-" + s);
ok("T1: at 21:00:00 IST the tick fires for that IST day", at21.status === 200 && at21.data?.fired === true && at21.data?.day === D, JSON.stringify(at21.data).slice(0, 200));
const resByTo = Object.fromEntries((at21.data?.results ?? []).map((r) => [r.to, r]));
const rowsD = await digestRows(D, recipients);
ok("T1: exactly one mail row per recipient was written (5 recipients, 5 rows), each addressed once", rowsD.length === 5 && Object.values(rowsByTo(rowsD)).every((n) => n === 1), JSON.stringify(rowsByTo(rowsD)));

// =================================================================================================
// T6 / T5 - recipients and the per-recipient finance section
// =================================================================================================
const mailed = (e) => resByTo[e.toLowerCase()];
ok("T6: the three eligible ERP accounts and the typed address (no ERP account: it gets the full report, cycle 2) were mailed; the Trainer account was not",
  mailed(uAF.email)?.outcome === "mailed" && mailed(uA.email)?.outcome === "mailed" && mailed(uAdm.email)?.outcome === "mailed"
  && mailed(unknownEmail)?.outcome === "mailed" && mailed(unknownEmail)?.kind === "address" && mailed(uTr.email)?.outcome === "ineligible", JSON.stringify(Object.values(resByTo).map((r) => [r.to, r.outcome, r.kind])));
ok("T6: the ineligible one is ON THE RECORD with a reason, not silent", rowsD.filter((r) => r.to === uTr.email.toLowerCase()).length === 1 && rowsD.filter((r) => r.to === uTr.email.toLowerCase()).every((r) => r.status === "skipped" && /trainer/i.test(String(r.reason ?? ""))),
  JSON.stringify(rowsD.filter((r) => /tr\./.test(r.to)).map((r) => [r.to, r.status, r.reason])));
const txtF = String(mailed(uAF.email)?.text ?? ""), txtN = String(mailed(uA.email)?.text ?? ""), txtAdm = String(mailed(uAdm.email)?.text ?? "");
ok("T5: the finance recipient's mail carries the exact costs (today Rs 1,250, month Rs 5,750, pending Rs 1,100, payment pending Rs 14,249)",
  /^COSTS$/m.test(txtF) && eq(mailRow(txtF, "Approved on the day"), ["Rs 1,250", "2"]) && eq(mailRow(txtF, "Month to date"), ["Rs 5,750", "4"])
  && eq(mailRow(txtF, "Pending approval"), ["Rs 1,100", "2"]) && eq(mailRow(txtF, "Payment pending"), ["Rs 14,249", "3"]), txtF.replace(/\s+/g, " ").slice(0, 400));
ok("T5: ...and its other sections carry the same exact numbers as the screen (joined 4, enrolled 2, mobilised 12 of 30)",
  mailRow(txtF, "Joined into batches")?.[1] === "4" && mailRow(txtF, "Enrolled")?.[1] === "2" && mailRow(txtF, "Mobilised (planning batches)")?.[0] === "12 of 30 (gap 18)", txtF.replace(/\s+/g, " ").slice(0, 400));
ok("T5: mail uses the same daily learner start and the current totals as the screen, and says the Now column is current, not historical",
  mailRow(txtF, "Training started")?.[1] === "7" && mailRow(txtF, "Enrolled")?.[0] === "5" && mailRow(txtF, "In training (started Active batch)")?.[0] === "0"
  && /current totals, also when an earlier day is chosen/.test(txtF), txtF.replace(/\s+/g, " ").slice(0, 400));
// K: the mail draws the SAME cells as the API (one function): every row of every table, cell for cell
const apiAF = (await digest(uAF.cookie, D)).data;
const mailMismatch = (apiAF?.tables ?? []).flatMap((t) => t.rows.filter((r) => !eq(mailRow(txtF, r.label), r.cells)).map((r) => `${t.key}/${r.label}: mail ${JSON.stringify(mailRow(txtF, r.label))} api ${JSON.stringify(r.cells)}`));
ok("K6: mail = API: every row of every table in the finance viewer's mail carries exactly the API's cells", (apiAF?.tables ?? []).length === 3 && mailMismatch.length === 0, mailMismatch.join(" | ").slice(0, 300));
ok("T5: the SAME digest for a recipient WITHOUT finance.view has no Costs section and no cost figure at all",
  txtN.length > 0 && !/Costs|Rs \d|spend|Payment pending/i.test(txtN) && mailRow(txtN, "Joined into batches")?.[1] === "4", txtN.replace(/\s+/g, " ").slice(0, 300));
ok("K4: the Admin's mail carries the target table (week of 2031-03-10: trainers trained target 10); a centre login's mail does not",
  /^AGAINST TARGET$/m.test(txtAdm) && mailRow(txtAdm, "Trainers trained (reached Certified)")?.[0] === "10" && !/AGAINST TARGET/.test(txtN), txtAdm.replace(/\s+/g, " ").slice(0, 300));
ok("T5: an Admin recipient gets no Costs section either (no finance.view)", txtAdm.length > 0 && !/Costs|Rs \d/i.test(txtAdm), txtAdm.replace(/\s+/g, " ").slice(0, 200));
const txtTyped = String(mailed(unknownEmail)?.text ?? "");
ok("T5: the typed address (no ERP account) gets the FULL report: both centres' batches and the cost section with both centres' money (today Rs 1,550 = 1,250 + 300, month Rs 6,050)",
  /^COSTS$/m.test(txtTyped) && txtTyped.includes("Rs 1,550") && txtTyped.includes("Rs 6,050") && txtTyped.includes(fx.pa1.code) && txtTyped.includes(fx.pb1.code), txtTyped.replace(/\s+/g, " ").slice(0, 400));
ok("T5: a scoped recipient's mail names only its own centre's batches", !txtN.includes(fx.pb1.code) && txtN.includes(fx.pa1.code), "");
{
  const gone = await req(admin, "PUT", "/api/targets/weekly", { rows: [{ week_start: "2031-03-10" }] });
  ok("K4: a week sent with all three figures blank is removed (cleanup of this suite's target week)", gone.status === 200 && gone.data?.removed === 1 && (await db.collection("weeklytargets").countDocuments({ week_start: bizDay("2031-03-10") })) === 0, JSON.stringify(gone.data));
}

// =================================================================================================
// T2 - two concurrent ticks, one mail
// =================================================================================================
const [c1, c2] = await Promise.all([tick(istAt(D2, 21, 0, 5), "inst-c1-" + s), tick(istAt(D2, 21, 0, 5), "inst-c2-" + s)]);
const rowsD2 = await digestRows(D2, recipients);
ok("T2: two ticks racing on two containers wrote exactly 5 rows, one per recipient (not 10)", rowsD2.length === 5 && Object.values(rowsByTo(rowsD2)).every((n) => n === 1), JSON.stringify(rowsByTo(rowsD2)));
ok("T2: exactly one of the two ticks did the sending", [c1, c2].filter((r) => r.data?.fired === true).length === 1, JSON.stringify([c1.data?.fired, c1.data?.reason, c2.data?.fired, c2.data?.reason]));

// =================================================================================================
// T3 - a lock held by another instance: nothing is sent and the day is not consumed
// =================================================================================================
await jobLocks.deleteMany({ _id: "daily-digest" });
await jobLocks.insertOne({ _id: "daily-digest", holder: "some-other-container", expires_at: new Date(Date.now() + 5 * 60_000) });
const held = await tick(istAt(D3, 21, 0, 0), "inst-h-" + s);
ok("T3: while another container holds the lock the tick sends nothing", held.status === 200 && held.data?.fired === false && /lock/i.test(String(held.data?.reason ?? "")), JSON.stringify(held.data).slice(0, 200));
ok("T3: ...writes no mail row and claims no day (so the holder's work is not pre-empted)", (await digestRows(D3, recipients)).length === 0 && (await jobLocks.countDocuments({ _id: { $regex: `^digest-sent:${D3}:` } })) === 0, "");
await jobLocks.deleteMany({ _id: "daily-digest" });
const freed = await tick(istAt(D3, 21, 0, 10), "inst-f-" + s);
ok("T3: once the lock is free the same tick sends (so it was the lock that stopped it)", freed.data?.fired === true && (await digestRows(D3, recipients)).length === 5, JSON.stringify(freed.data).slice(0, 160));

// =================================================================================================
// T4 - a restart after a send does not send again; the next day does
// =================================================================================================
await jobLocks.deleteMany({ _id: "daily-digest" });                      // a restart: the in-memory instance and the TTL lock are gone
const restart = await tick(istAt(D, 21, 30, 0), "inst-restarted-" + s);
ok("T4: a restarted container ticking at 21:30 on a day already sent sends nothing", restart.status === 200 && restart.data?.fired === false && /already/i.test(String(restart.data?.reason ?? "")), JSON.stringify(restart.data).slice(0, 200));
ok("T4: ...the day still has exactly its 5 rows", (await digestRows(D, recipients)).length === 5, String((await digestRows(D, recipients)).length));
const late = await tick(istAt(D, 23, 59, 0), "inst-late-" + s);
ok("T4: even at 23:59 IST the same day is not sent a second time", late.data?.fired === false && (await digestRows(D, recipients)).length === 5, JSON.stringify(late.data).slice(0, 120));
await jobLocks.deleteMany({ _id: "daily-digest" });
const nextDay = await tick(istAt(NEXT, 21, 0, 0), "inst-next-" + s);
ok("T4: the NEXT IST day is a new day: it sends again (the key is the day, not a once-ever flag)", nextDay.data?.fired === true && nextDay.data?.day === NEXT && (await digestRows(NEXT, recipients)).length === 5, JSON.stringify(nextDay.data).slice(0, 160));
ok("T4: a day that never reached 21:00 (00:01 IST) claims nothing", (await tick(istAt("2031-03-20", 0, 1), "inst-z-" + s)).data?.fired === false && (await jobLocks.countDocuments({ _id: { $regex: "^digest-sent:2031-03-20:" } })) === 0, "");

// =================================================================================================
// R - a failed or skipped send does not consume the day (cycle 1, QA-2884). The claim records the outcome:
//     sent = final; failed/skipped = retry (>= 10 minutes later, same IST day, at most 3 attempts in all).
//     One eligible recipient, so the counts are exact; the list is restored before G1.
// =================================================================================================
const listAll = recipients.join(", ");
await setDefaults({ digest_recipients: uA.email });
const toA = uA.email.toLowerCase();
const claimOf = (day) => jobLocks.findOne({ _id: `digest-sent:${day}:${toA}` });
const rowsOf = async (day) => (await digestRows(day, [toA])).length;
const rr = (r) => (r.data?.results ?? []).length;
const RD1 = "2031-04-01", RD2 = "2031-04-02", RD4 = "2031-04-04";

// R1 - failure, then retry, then sent
const r1a = await tick(istAt(RD1, 21, 0, 0), "r1a-" + s, admin, { simulate: ["failed", "sent"] });
let cl = await claimOf(RD1);
ok("R1: a first send that FAILS leaves the claim retryable (status retry, 1 attempt, next attempt 10 minutes on) and does not consume the day",
  r1a.data?.fired === true && cl?.status === "retry" && cl?.attempts === 1 && cl?.last_status === "failed" && new Date(cl?.next_at).getTime() === istAt(RD1, 21, 10, 0).getTime(), JSON.stringify({ r: r1a.data?.results?.[0]?.status, cl: cl && { s: cl.status, a: cl.attempts, n: cl.next_at } }));
const r1b = await tick(istAt(RD1, 21, 9, 59), "r1b-" + s, admin, { simulate: ["failed", "sent"] });
ok("R1: a tick 9:59 after the failure does NOT retry (attempts are at least 10 minutes apart)", r1b.data?.fired === false && (await rowsOf(RD1)) === 1 && (await claimOf(RD1))?.attempts === 1, JSON.stringify({ fired: r1b.data?.fired, rows: await rowsOf(RD1) }));
const r1c = await tick(istAt(RD1, 21, 10, 0), "r1c-" + s, admin, { simulate: ["failed", "sent"] });
cl = await claimOf(RD1);
ok("R1: at +10:00 the retry runs: attempt 2, one more mail row, and this time it is SENT (claim final)",
  r1c.data?.fired === true && r1c.data?.results?.[0]?.attempt === 2 && cl?.status === "sent" && cl?.attempts === 2 && (await rowsOf(RD1)) === 2, JSON.stringify({ att: r1c.data?.results?.[0]?.attempt, cl: cl && { s: cl.status, a: cl.attempts }, rows: await rowsOf(RD1) }));
for (const [hh, mm] of [[21, 30], [23, 59]]) {
  const t = await tick(istAt(RD1, hh, mm, 0), `r1d${hh}${mm}-` + s, admin, { simulate: ["failed", "failed", "failed"] });
  ok(`R1: once SENT the claim is never retried (a tick at ${hh}:${mm} sends nothing)`, t.data?.fired === false && (await rowsOf(RD1)) === 2 && (await claimOf(RD1))?.status === "sent", JSON.stringify({ fired: t.data?.fired, rows: await rowsOf(RD1) }));
}

// R2 - skipped three times (the real, suppressed outcome in a test env), then it stops
const r2 = [];
for (const [hh, mm] of [[21, 0], [21, 10], [21, 20]]) r2.push(await tick(istAt(RD2, hh, mm, 0), `r2-${hh}${mm}-` + s, admin, { simulate: [] }));
cl = await claimOf(RD2);
ok("R2: a mail that is skipped is tried 3 times in all (21:00, 21:10, 21:20): 3 rows, attempts 1,2,3, then the claim is exhausted",
  r2.every((x) => x.data?.fired === true) && r2.map((x) => x.data?.results?.[0]?.attempt).join() === "1,2,3" && (await rowsOf(RD2)) === 3 && cl?.status === "exhausted" && cl?.attempts === 3,
  JSON.stringify({ att: r2.map((x) => x.data?.results?.[0]?.attempt), rows: await rowsOf(RD2), cl: cl && { s: cl.status, a: cl.attempts, last: cl.last_status } }));
for (const [hh, mm] of [[21, 30], [22, 0], [23, 59]]) {
  const t = await tick(istAt(RD2, hh, mm, 0), `r2z${hh}${mm}-` + s, admin, { simulate: [] });
  ok(`R2: after the 3rd attempt nothing more is sent (a tick at ${hh}:${mm})`, t.data?.fired === false && (await rowsOf(RD2)) === 3 && (await claimOf(RD2))?.attempts === 3, JSON.stringify({ fired: t.data?.fired, rows: await rowsOf(RD2) }));
}
const r2next = await tick(istAt("2031-04-03", 0, 30, 0), "r2n-" + s, admin, { simulate: [] });
ok("R2: the next IST day's 00:30 does not retry yesterday's claim (a retry never crosses midnight)", r2next.data?.fired === false && (await rowsOf(RD2)) === 3, JSON.stringify(r2next.data).slice(0, 120));

// R3 - several processes racing a RETRY, with the efficiency lock OFF: the claim alone must give one send.
// Five independent days so one lucky interleaving cannot pass it; four racers each.
const raceRounds = ["2031-04-10", "2031-04-11", "2031-04-12", "2031-04-13", "2031-04-14"];
const raceReport = [];
for (const d of raceRounds) {
  await tick(istAt(d, 21, 0, 0), "r3seed-" + s, admin, { simulate: ["failed"] });
  const racers = await Promise.all([0, 1, 2, 3].map((i) => tick(istAt(d, 21, 10, 0), `r3-${i}-` + s, admin, { simulate: ["failed", "sent"], skip_lock: true })));
  raceReport.push({ d, winners: racers.filter((x) => rr(x) > 0).length, rows: await rowsOf(d), claim: (await claimOf(d))?.status, att: (await claimOf(d))?.attempts });
}
ok("R3: 4 processes racing the SAME retry, lock off, 5 rounds: every round exactly one wins (2 rows in all: the failure and the one retry), claim sent, 2 attempts",
  raceReport.every((x) => x.winners === 1 && x.rows === 2 && x.claim === "sent" && x.att === 2), JSON.stringify(raceReport));
// the FIRST claim, raced without the lock, is exactly-once too (so the lock is demonstrably only an efficiency guard)
const firstRace = [];
for (const d of ["2031-04-20", "2031-04-21", "2031-04-22"]) {
  const racers = await Promise.all([0, 1, 2, 3].map((i) => tick(istAt(d, 21, 0, 5), `r3f-${i}-` + s, admin, { simulate: ["sent"], skip_lock: true })));
  firstRace.push({ d, winners: racers.filter((x) => rr(x) > 0).length, rows: await rowsOf(d) });
}
ok("R3: 4 processes racing the FIRST claim with the lock off, 3 rounds: exactly one mail each time", firstRace.every((x) => x.winners === 1 && x.rows === 1), JSON.stringify(firstRace));

// R4 - a SENT claim is never re-sent, whoever ticks and however the outcome is simulated
await tick(istAt(RD4, 21, 0, 0), "r4a-" + s, admin, { simulate: ["sent"] });
const r4 = [];
for (const [hh, mm] of [[21, 10], [21, 25], [23, 59]]) r4.push(await tick(istAt(RD4, hh, mm, 0), `r4-${hh}${mm}-` + s, admin, { simulate: ["failed", "failed", "failed"], skip_lock: true }));
ok("R4: a claim that was SENT is never re-sent: later ticks (lock off, outcomes forced to failed) fire nothing and the day keeps its 1 row", r4.every((x) => x.data?.fired === false) && (await rowsOf(RD4)) === 1 && (await claimOf(RD4))?.status === "sent" && (await claimOf(RD4))?.attempts === 1, JSON.stringify({ rows: await rowsOf(RD4), cl: (await claimOf(RD4))?.status }));
// R5 - an ineligible recipient (a Trainer account's email) is recorded once and closed, not retried
await setDefaults({ digest_recipients: uTr.email });
const r5a = await tick(istAt("2031-04-05", 21, 0, 0), "r5a-" + s, admin, { simulate: [] });
const r5b = await tick(istAt("2031-04-05", 21, 15, 0), "r5b-" + s, admin, { simulate: [] });
const clU = await jobLocks.findOne({ _id: `digest-sent:2031-04-05:${uTr.email.toLowerCase()}` });
ok("R5: a recipient who may never receive it (a Trainer account) is recorded once and CLOSED (not retried: a retry cannot make a Trainer eligible)", r5a.data?.fired === true && r5b.data?.fired === false && clU?.status === "closed" && (await digestRows("2031-04-05", [uTr.email.toLowerCase()])).length === 1, JSON.stringify({ cl: clU?.status, rows: (await digestRows("2031-04-05", [uTr.email.toLowerCase()])).length }));
await setDefaults({ digest_recipients: listAll });

// =================================================================================================
// U - the custom recipient list (cycle 2, Umesh 2026-10-07: "select it or add custom mail"). Entries are `u:<ERP user id>`
//     (a picked account) or a typed address. An ERP account always keeps ITS OWN view; a typed address that is no
//     account gets the FULL report incl. money; only Admin (defaults.manage) edits the list.
// =================================================================================================
const getDef = async (cookie = admin) => (await req(cookie, "GET", "/api/defaults")).data?.item;
const dbDef = () => db.collection("defaults").findOne({ _singleton: "defaults" });
const rowFor = (arr, to) => (arr ?? []).find((r) => r.to === to);

// ---- U1 the picker endpoint
const pk = await req(admin, "GET", "/api/reports/daily/recipients");
const pkUsers = pk.data?.users ?? [];
const pkEmails = new Set(pkUsers.map((u) => u.email));
ok("U1: the picker lists ERP accounts by name and email: active non-Trainer fixtures are in it (Location A, Location A + finance, Operations, Admin)",
  pk.status === 200 && [uA, uAF, uOps, uAdm].every((u) => pkEmails.has(u.email.toLowerCase())), `${pk.status} ${pkUsers.length} users`);
ok("U1: ...and a Trainer, a deactivated, a rejected and a dropped account are not in it", ![uTr, uDead, uRej, uDrop].some((u) => pkEmails.has(u.email.toLowerCase())), "");
ok("U1: ...each entry carries only id, name, email, role and the mail switch (no password hash or other account data)",
  pkUsers.length > 0 && pkUsers.every((u) => eq(Object.keys(u).sort(), ["email", "id", "mail_enabled", "name", "role"])), JSON.stringify(Object.keys(pkUsers[0] ?? {})));
const pkLoc = await req(uA.cookie, "GET", "/api/reports/daily/recipients");
const pkOps = await req(uOps.cookie, "GET", "/api/reports/daily/recipients");
ok("U1: a Location user and an Operations user are refused the picker (403): it needs defaults.manage", pkLoc.status === 403 && pkOps.status === 403, `${pkLoc.status} ${pkOps.status}`);

// ---- U2 tagged entries + the money split between an ERP account and a typed address
const UD2 = "2031-03-14";                      // the day with the exact fixtures, so the figures are known
const parseListSet = (raw) => String(raw ?? "").split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean).sort().join("|");
const typedFull = `zz.typed.${s.toLowerCase()}@vidysea-test.local`;
const newEmail = `zzcheck.mc1afnew.${s.toLowerCase()}@vidysea-test.local`;
const putTag = await setDefaults({ digest_recipients: `u:${uAF.id}, ${typedFull.toUpperCase()}` });
const rb2 = await getDef();
ok("U2: a list of a picked user and a typed address is stored in canonical form (lowercase, tagged, comma separated)", putTag.status === 200 && rb2?.digest_recipients === `u:${uAF.id}, ${typedFull}`, `${putTag.status} ${rb2?.digest_recipients}`);
await db.collection("users").updateOne({ _id: oid(uAF.id) }, { $set: { email: newEmail } });          // the account is RE-EMAILED after it was picked
const t2 = await tick(istAt(UD2, 22, 0, 0), "u2-" + s, admin, { simulate: ["sent"] });
const r2m = Object.fromEntries((t2.data?.results ?? []).map((r) => [r.to, r]));
ok("U2: a picked user whose email changed after it was picked STILL gets the digest, at the NEW address (the entry is the account, not the text)",
  r2m[newEmail]?.outcome === "mailed" && !r2m[uAF.email.toLowerCase()] && String(r2m[newEmail]?.text ?? "").includes("Rs 1,250"), JSON.stringify(Object.keys(r2m)));
const tx2 = String(r2m[newEmail]?.text ?? "");
ok("U2: ...and that ERP user's mail keeps ITS OWN view: centre A's money only (Rs 1,250 today, Rs 5,750 month, Rs 1,100 pending), not centre B's (no Rs 1,550) and no centre-B batch",
  tx2.includes("Rs 1,250") && tx2.includes("Rs 5,750") && tx2.includes("Rs 1,100") && !tx2.includes("Rs 1,550") && !tx2.includes(fx.pb1.code) && tx2.includes(fx.pa1.code), tx2.replace(/\s+/g, " ").slice(0, 300));
await db.collection("users").updateOne({ _id: oid(uAF.id) }, { $set: { email: uAF.email.toLowerCase() } });
const typedTxt = String(r2m[typedFull]?.text ?? "");
ok("U2: a typed address that is no ERP account is mailed (outcome mailed, kind address, full view)", r2m[typedFull]?.outcome === "mailed" && r2m[typedFull]?.kind === "address" && r2m[typedFull]?.full === true, JSON.stringify(r2m[typedFull] && { o: r2m[typedFull].outcome, k: r2m[typedFull].kind, f: r2m[typedFull].full }));
ok("U2: ...and its report is the FULL one: both centres' batches and the cost section with both centres' money (today Rs 1,550, month Rs 6,050)",
  /^COSTS$/m.test(typedTxt) && typedTxt.includes("Rs 1,550") && typedTxt.includes("Rs 6,050") && typedTxt.includes(fx.pa1.code) && typedTxt.includes(fx.pb1.code), typedTxt.replace(/\s+/g, " ").slice(0, 300));
ok("U2: ...the typed address's claim key is its normalised lowercase email", !!(await jobLocks.findOne({ _id: `digest-sent:${UD2}:${typedFull}` })), "");

// ---- U3 the same person listed twice (ERP user + typed address with the same email): ONE mail, in the account's own view
const UD3 = "2031-05-03", UD4 = "2031-05-04";
await setDefaults({ digest_recipients: `u:${uA.id}, ${uA.email.toUpperCase()}` });
const t3 = await tick(istAt(UD3, 21, 0, 0), "u3-" + s, admin, { simulate: ["sent"] });
const tx3 = String(t3.data?.results?.[0]?.text ?? "");
ok("U3: an ERP user AND a typed address with the same email: exactly one mail row, one claim, one result", (await digestRows(UD3, [uA.email.toLowerCase()])).length === 1 && t3.data?.results?.length === 1 && (await jobLocks.countDocuments({ _id: { $regex: `^digest-sent:${UD3}:` } })) === 1,
  JSON.stringify({ rows: (await digestRows(UD3, [uA.email.toLowerCase()])).length, results: t3.data?.results?.length }));
ok("U3: ...and it is the ACCOUNT's view (Location A, no finance): no Costs section, no centre-B batch, kind user and not full (typing the address did not upgrade it to the full report)", tx3.length > 0 && !/Costs|Rs \d/.test(tx3) && !tx3.includes(fx.pb1.code) && t3.data?.results?.[0]?.kind === "user" && t3.data?.results?.[0]?.full !== true, JSON.stringify({ k: t3.data?.results?.[0]?.kind, f: t3.data?.results?.[0]?.full }) + " " + tx3.replace(/\s+/g, " ").slice(0, 200));
const raceSame = await Promise.all([0, 1, 2, 3].map((i) => tick(istAt(UD4, 21, 0, 5), `u3r-${i}-` + s, admin, { simulate: ["sent"], skip_lock: true })));
ok("U3: 4 processes racing that same list with the lock OFF: still exactly one mail row for the person", (await digestRows(UD4, [uA.email.toLowerCase()])).length === 1 && raceSame.filter((x) => (x.data?.results ?? []).length > 0).length === 1,
  JSON.stringify({ rows: (await digestRows(UD4, [uA.email.toLowerCase()])).length, winners: raceSame.filter((x) => (x.data?.results ?? []).length > 0).length }));

// ---- U4 the account wins over a typed address (no upgrade, no revival)
const UD5 = "2031-05-05";
await setDefaults({ digest_recipients: `${uTr.email}, ${uDead.email}, u:${uGone.id}, ${uA.email}, ${uRej.email}, ${uDrop.email}` });   // picked while the user still existed...
await db.collection("users").deleteOne({ _id: oid(uGone.id) });                                          // ...then removed
const t5 = await tick(istAt(UD5, 21, 0, 0), "u4-" + s, admin, { simulate: ["sent"] });
const r5m = Object.fromEntries((t5.data?.results ?? []).map((r) => [r.to, r]));
ok("U4: a typed address that is a TRAINER account's email is refused (ineligible, nothing rendered): typing it does not give a Trainer the money report", r5m[uTr.email.toLowerCase()]?.outcome === "ineligible" && !r5m[uTr.email.toLowerCase()]?.text && /trainer/i.test(String(r5m[uTr.email.toLowerCase()]?.reason ?? "")), JSON.stringify(r5m[uTr.email.toLowerCase()]));
ok("U4: ...so is a typed address that is a DEACTIVATED account's email (reason names it), and a picked user that was removed (reason names it)",
  r5m[uDead.email.toLowerCase()]?.outcome === "ineligible" && /deactivated/i.test(String(r5m[uDead.email.toLowerCase()]?.reason ?? "")) && Object.values(r5m).some((r) => r.outcome === "ineligible" && /no longer exists/i.test(String(r.reason ?? ""))), JSON.stringify(Object.values(r5m).map((r) => [r.to, r.outcome, r.reason])));
ok("U4: ...so is a typed address of a REJECTED account (it cannot sign in) and one of a DROPPED account (whose login email was renamed: typing the original must not read as 'no account' and earn the full report with money)",
  [uRej, uDrop].every((u) => r5m[u.email.toLowerCase()]?.outcome === "ineligible" && !r5m[u.email.toLowerCase()]?.text), JSON.stringify([uRej, uDrop].map((u) => r5m[u.email.toLowerCase()] && [r5m[u.email.toLowerCase()].outcome, r5m[u.email.toLowerCase()].full])));
ok("U4: ...and a typed address that IS a Location A account gets that account's view (no Costs)", r5m[uA.email.toLowerCase()]?.outcome === "mailed" && !/Costs|Rs \d/.test(String(r5m[uA.email.toLowerCase()]?.text ?? "")), "");
ok("U4: each refusal is on the record (a skipped MailLog row with the reason), not silent", (await digestRows(UD5, [uTr.email.toLowerCase(), uDead.email.toLowerCase()])).every((r) => r.status === "skipped" && r.reason), "");
// a legacy, malformed token in the stored string is refused, never mailed as a "full view"
await db.collection("defaults").updateOne({ _singleton: "defaults" }, { $set: { digest_recipients: "not-an-email" } });
const t5b = await tick(istAt("2031-05-06", 21, 0, 0), "u4b-" + s, admin, { simulate: ["sent"] });
ok("U4: a malformed token already in the stored string is refused (ineligible), not treated as a typed address with the full view", t5b.data?.results?.[0]?.outcome === "ineligible" && !t5b.data?.results?.[0]?.text, JSON.stringify(t5b.data?.results?.[0]));
await db.collection("defaults").updateOne({ _singleton: "defaults" }, { $set: { digest_recipients: "" } });

// ---- U5 write validation: every one is a 400 and leaves the stored list as it was
await setDefaults({ digest_recipients: uA.email });
const base5 = (await getDef())?.digest_recipients;
const badLists = [
  ["an entry that is not an address", "nope"], ["an address with no dot in the domain", "a@b"], ["a list with a space inside an address", "a b@c.com"],
  ["a duplicate (same address, different case)", `${uA.email}, ${uA.email.toUpperCase()}`], ["a duplicate user tag", `u:${uA.id}, u:${uA.id}`],
  ["51 recipients", Array.from({ length: 51 }, (_, i) => `zzmany${i}.${s.toLowerCase()}@vidysea-test.local`).join(", ")],
  ["a CRLF header-injection attempt (Bcc line)", `${uA.email}\r\nBcc: attacker@evil.test`], ["an LF between two valid addresses", `${uA.email}\n${uB.email}`], ["a bare CR", `${uA.email}\r${uB.email}`],
  ["a NUL byte", `${uA.email}\u0000`], ["a tab", `${uA.email}\t${uB.email}`], ["angle brackets and a display name", `"Boss" <${uB.email}>`],
  ["a second address smuggled after a semicolon-colon", `${uA.email};bcc:x@y.com`], ["a malformed user tag", "u:123"], ["a well-formed tag for a user that does not exist", `u:${"0".repeat(23)}1`],
  ["a comma only", ","], ["a semicolon only", ";"], ["separators and spaces only", " , ; "], ["a percent-encoded CRLF in the local part", "a%0d%0a@c.com"],
];
const badOut = [];
for (const [label, list] of badLists) {
  const r = await setDefaults({ digest_recipients: list });
  const after = (await getDef())?.digest_recipients;
  if (!(r.status === 400 && after === base5)) badOut.push(`${label}: ${r.status} ${JSON.stringify(r.data).slice(0, 80)} stored=${after}`);
}
ok(`U5: ${badLists.length} malformed lists are each refused with a 400 and leave the stored list untouched`, badOut.length === 0, badOut.join(" | "));
const nonStr = await req(admin, "PUT", "/api/defaults", { digest_recipients: ["a@b.com"] });
ok("U5: a non-string list is a 400 too", nonStr.status === 400 && (await getDef())?.digest_recipients === base5, `${nonStr.status}`);
const fifty = Array.from({ length: 50 }, (_, i) => `zzfifty${i}.${s.toLowerCase()}@vidysea-test.local`).join(", ");
const ok50 = await setDefaults({ digest_recipients: fifty });
ok("U5: exactly 50 recipients is accepted (the limit is 50, not 49)", ok50.status === 200 && (await getDef())?.digest_recipients === fifty, `${ok50.status}`);
const canon = await setDefaults({ digest_recipients: `${uA.email.toUpperCase()};   ${typedFull}` });
ok("U5: a list written with semicolons, extra spaces and capitals is stored canonical", canon.status === 200 && (await getDef())?.digest_recipients === `${uA.email.toLowerCase()}, ${typedFull}`, `${canon.status} ${(await getDef())?.digest_recipients}`);
const unchanged = await db.collection("defaults").updateOne({ _singleton: "defaults" }, { $set: { digest_recipients: "legacy.one@vidysea-test.local;\nlegacy.two@vidysea-test.local" } });
const curDef = await getDef();
const legacySave = await req(admin, "PUT", "/api/defaults", { batch_size: curDef.batch_size, duration_days: curDef.duration_days, digest_recipients: "legacy.one@vidysea-test.local;\nlegacy.two@vidysea-test.local" });
ok("U5: a whole-form save that sends a LEGACY list back UNCHANGED (newline separated) is not refused: an old value must not block an unrelated save", legacySave.status === 200 && unchanged.matchedCount === 1, `${legacySave.status} ${JSON.stringify(legacySave.data).slice(0, 100)}`);
const legacyParsed = await tick(istAt("2031-05-07", 21, 0, 0), "u5l-" + s, admin, { simulate: ["sent"] });
ok("U5: ...and that legacy plain-email string still reads: both addresses are recipients (typed entries, nothing dropped)", (legacyParsed.data?.results ?? []).map((r) => r.to).sort().join() === "legacy.one@vidysea-test.local,legacy.two@vidysea-test.local", JSON.stringify((legacyParsed.data?.results ?? []).map((r) => r.to)));
await setDefaults({ digest_recipients: "" });
const blankOk = await setDefaults({ digest_recipients: "   " });
ok("U5: a blank list clears it (200)", blankOk.status === 200 && ((await getDef())?.digest_recipients ?? "") === "", `${blankOk.status}`);

// ---- U6 the deliverable guard (QA-2883, rewritten): ON needs at least one DELIVERABLE recipient
const offAgain = () => setDefaults({ digest_only_approval_mails: false });
await offAgain();
const typedOnly = await setDefaults({ digest_recipients: typedFull, digest_only_approval_mails: true });
ok("U6: a list of ONLY a typed address is now valid: digest-only ON is accepted (the cycle-1 'non-ERP-only refused' rule is superseded)", typedOnly.status === 200 && (await getDef())?.digest_only_approval_mails === true, `${typedOnly.status} ${JSON.stringify(typedOnly.data).slice(0, 100)}`);
const swapTyped = await setDefaults({ digest_recipients: `other.${typedFull}` });
ok("U6: ...and while ON the list may be swapped for another typed address", swapTyped.status === 200, `${swapTyped.status}`);
const toNobody = await setDefaults({ digest_recipients: uTr.email });
ok("U6: ...but not for a list nobody on can receive (a typed address that is a Trainer's email): 400, list unchanged", toNobody.status === 400 && (await getDef())?.digest_recipients === `other.${typedFull}`, `${toNobody.status}`);
await offAgain();
for (const [label, list] of [["a typed address that is a Trainer account's email", uTr.email], ["a picked ERP user whose own mail switch is off", `u:${uOff.id}`], ["a picked ERP user that is deactivated", `u:${uDead.id}`], ["a typed address that is a deactivated account's email", uDead.email]]) {
  await setDefaults({ digest_recipients: list });
  const r = await setDefaults({ digest_only_approval_mails: true });
  const one = await setDefaults({ digest_recipients: list, digest_only_approval_mails: true });
  ok(`U6: digest-only ON with ${label} is refused (400), also in one request, and the toggle stays OFF`, r.status === 400 && one.status === 400 && (await getDef())?.digest_only_approval_mails === false, `${r.status} ${one.status}`);
}
await setDefaults({ digest_recipients: "" });

// ---- U7 only Admin (defaults.manage, can_edit) changes the list; the list is not served to everyone
await setDefaults({ digest_recipients: typedFull });
const attempt = { digest_recipients: `x.${typedFull}`, digest_only_approval_mails: false };
const deniedLoc = await req(uA.cookie, "PUT", "/api/defaults", attempt);
const deniedOps = await req(uOps.cookie, "PUT", "/api/defaults", attempt);
const deniedViewOnly = await req(uAdv.cookie, "PUT", "/api/defaults", attempt);
ok("U7: Location, Operations and a defaults.manage grantee with can_edit off are all refused (403) when they try to change the recipient list, and the list is unchanged",
  deniedLoc.status === 403 && deniedOps.status === 403 && deniedViewOnly.status === 403 && (await getDef())?.digest_recipients === typedFull, `${deniedLoc.status} ${deniedOps.status} ${deniedViewOnly.status}`);
const toggleDenied = await req(uA.cookie, "PUT", "/api/defaults", { digest_only_approval_mails: true });
ok("U7: ...and they cannot switch digest-only on either", toggleDenied.status === 403 && (await getDef())?.digest_only_approval_mails === false, `${toggleDenied.status}`);
const seenLoc = await getDef(uA.cookie), seenOps = await getDef(uOps.cookie), seenAdm = await getDef(admin);
ok("U7: GET /api/defaults does not serve the list to a caller without defaults.manage (Location, Operations: empty) while the Admin sees it", seenLoc?.digest_recipients === "" && seenOps?.digest_recipients === "" && seenAdm?.digest_recipients === typedFull, JSON.stringify([seenLoc?.digest_recipients, seenOps?.digest_recipients, seenAdm?.digest_recipients]));
ok("U7: ...and every OTHER default is still there for them (batch_size, duration_days, email_enabled: nothing a screen reads is gone)", [seenLoc, seenOps].every((d) => typeof d?.batch_size === "number" && typeof d?.duration_days === "number" && typeof d?.email_enabled === "boolean"), JSON.stringify([typeof seenLoc?.batch_size, typeof seenOps?.duration_days]));

// ---- U13 (QA-2923, S2, Umesh 2026-10-17): ONLY an Admin may type an outside address. A defaults.manage grantee who is
// not an Admin may pick existing ERP users (who keep their own centre scope and finance permissions) and may keep or
// remove what is already stored; a NEW typed address would receive the money-bearing full report.
ok("[precondition] U13 personas: both non-Admin grantees can log in and hold defaults.manage with can_edit (the picker endpoint, gated by defaults.manage, answers them), so only the new rule can refuse them",
  !!(uGL.cookie && uGO.cookie) && Array.isArray((await req(uGL.cookie, "GET", "/api/reports/daily/recipients")).data?.users) && (await req(uGO.cookie, "GET", "/api/reports/daily/recipients")).status === 200, `${uGL.status} ${uGO.status}`);
await setDefaults({ digest_recipients: "", digest_only_approval_mails: false });
const extA = `zz.ext.a.${s.toLowerCase()}@vidysea-test.local`, extB = `zz.ext.b.${s.toLowerCase()}@vidysea-test.local`;
const admExt = await setDefaults({ digest_recipients: extA });
ok("U13: an Admin adds an outside (typed) address: 200, and it is stored", admExt.status === 200 && (await getDef())?.digest_recipients === extA, `${admExt.status} ${(await getDef())?.digest_recipients}`);
await setDefaults({ digest_recipients: "" });
for (const [who, g] of [["a Location grantee", uGL], ["an Operations grantee", uGO]]) {
  const before = (await getDef())?.digest_recipients;
  const r = await req(g.cookie, "PUT", "/api/defaults", { digest_recipients: extA });
  const rt = await req(g.cookie, "PUT", "/api/defaults", { digest_recipients: `u:${uD.id}, ${extA.toUpperCase()}` });
  const rs = await req(g.cookie, "PUT", "/api/defaults", { digest_recipients: "u:zzzzzzzzzzzzzzzzzzzzzzzz" });
  const rtog = await req(g.cookie, "PUT", "/api/defaults", { digest_recipients: extA, digest_only_approval_mails: true });
  const row = await db.collection("defaults").findOne({ _singleton: "defaults" });
  ok(`U13: ${who} (defaults.manage, can_edit) adding an outside address is refused 403 (plain, mixed with a picked user in capitals, a malformed tag, and together with the digest-only toggle) and NOTHING is written`,
    r.status === 403 && rt.status === 403 && rs.status === 403 && rtog.status === 403 && (row?.digest_recipients ?? "") === (before ?? "") && (row?.digest_only_approval_mails ?? false) === false,
    `${r.status} ${rt.status} ${rs.status} ${rtog.status} list=${JSON.stringify(row?.digest_recipients)} on=${row?.digest_only_approval_mails}`);
  ok(`U13: ...and the 403 names the reason (Admin only, outside address)`, /admin/i.test(JSON.stringify(r.data)) && /address/i.test(JSON.stringify(r.data)), JSON.stringify(r.data).slice(0, 160));
  const pick = await req(g.cookie, "PUT", "/api/defaults", { digest_recipients: `u:${uD.id}` });
  ok(`U13: ${who} picking an existing ERP user is allowed (200) and stored`, pick.status === 200 && (await getDef())?.digest_recipients === `u:${uD.id}`, `${pick.status} ${(await getDef())?.digest_recipients}`);
  await setDefaults({ digest_recipients: "" });
}
// what an earlier Admin put there stays: a grantee may carry it through a whole-form save, or remove it, but not re-add it or add another
await setDefaults({ digest_recipients: `${extA}, u:${uD.id}` });
const keep = await req(uGL.cookie, "PUT", "/api/defaults", { digest_recipients: `u:${uD.id}, ${extA.toUpperCase()}` });
ok("U13: a stored outside address is KEPT through a grantee's save of the same list (reordered, other case): 200, still stored", keep.status === 200 && parseListSet((await getDef())?.digest_recipients) === parseListSet(`${extA}, u:${uD.id}`), `${keep.status} ${(await getDef())?.digest_recipients}`);
const addAnother = await req(uGL.cookie, "PUT", "/api/defaults", { digest_recipients: `${extA}, u:${uD.id}, ${extB}` });
ok("U13: ...but adding a SECOND outside address next to the kept one is refused 403 and the stored list is unchanged", addAnother.status === 403 && parseListSet((await getDef())?.digest_recipients) === parseListSet(`${extA}, u:${uD.id}`), `${addAnother.status}`);
const dropIt = await req(uGO.cookie, "PUT", "/api/defaults", { digest_recipients: `u:${uD.id}` });
ok("U13: ...and a grantee may REMOVE the stored outside address (200)", dropIt.status === 200 && (await getDef())?.digest_recipients === `u:${uD.id}`, `${dropIt.status} ${(await getDef())?.digest_recipients}`);
const wasRemoved = await req(uGL.cookie, "PUT", "/api/defaults", { digest_recipients: `u:${uD.id}, ${extA}` });
ok("U13: ...after which putting it back is a NEW outside address and is refused 403", wasRemoved.status === 403 && (await getDef())?.digest_recipients === `u:${uD.id}`, `${wasRemoved.status}`);
const admBack = await setDefaults({ digest_recipients: `u:${uD.id}, ${extA}` });
ok("U13: ...while the Admin can put it back (200)", admBack.status === 200, `${admBack.status}`);
await setDefaults({ digest_recipients: "" });
ok("U13: `digest_recipients` is written by exactly one route, api/defaults/route.ts, so there is no second door around the rule (source shape; the model, the defaults reader, the Admin screen and the digest reader do not write it)",
  eq(walkSrc(srcRoot).filter((f) => /digest_recipients/.test(readFileSync(f, "utf8")) && !/(models[\\/]index|lib[\\/]defaults|admin[\\/]page|daily-digest)\.tsx?$/.test(f)).map((f) => path.relative(srcRoot, f).split(path.sep).join("/")), ["app/api/defaults/route.ts"]), "");
const routeSrc = readFileSync(path.join(srcRoot, "app", "api", "defaults", "route.ts"), "utf8");
ok("U13: the Admin-only check is on the SERVER, in the Defaults write: it tests the writer's role and calls newTypedAddresses on the incoming list (source shape)",
  /user\.role !== "Admin"/.test(routeSrc) && /newTypedAddresses\(/.test(routeSrc), "");

// ---- U8 (A1) two concurrent writes, one switching ON and one emptying the list, never leave ON with nobody
const racedBad = [];
for (let i = 0; i < 12; i++) {
  await db.collection("defaults").updateOne({ _singleton: "defaults" }, { $set: { digest_recipients: uA.email.toLowerCase(), digest_only_approval_mails: false } });
  const [p1, p2] = await Promise.all([req(admin, "PUT", "/api/defaults", { digest_only_approval_mails: true }), req(admin, "PUT", "/api/defaults", { digest_recipients: "" })]);
  const d = await dbDef();
  if (d.digest_only_approval_mails === true && !String(d.digest_recipients ?? "").trim()) racedBad.push(`round ${i}: ON + empty list (${p1.status}/${p2.status})`);
  if (![200, 400, 409].includes(p1.status) || ![200, 400, 409].includes(p2.status)) racedBad.push(`round ${i}: ${p1.status}/${p2.status}`);
}
ok("U8: 12 rounds of two concurrent PUTs (digest-only ON vs emptying the list): the document is never left ON with an empty list (the write is conditional on what was judged)", racedBad.length === 0, racedBad.join(" | "));
await db.collection("defaults").updateOne({ _singleton: "defaults" }, { $set: { digest_recipients: "", digest_only_approval_mails: false } });

// ---- U9 (A2) digest-only stays ON after the last deliverable recipient goes: say so, on the screens and on the record
await setDefaults({ digest_recipients: `u:${uD.id}`, digest_only_approval_mails: true });
const UD9 = "2031-05-09";
const healthy = (await digest(admin, D)).data?.meta;
ok("U9: with a deliverable recipient and digest-only ON there is no 'nobody' warning (meta.digest_only_nobody false, deliverable 1)", healthy?.digest_only === true && healthy?.deliverable === 1 && healthy?.digest_only_nobody === false, JSON.stringify(healthy));
await db.collection("users").updateOne({ _id: oid(uD.id) }, { $set: { active: false } });
const nobody = (await digest(admin, D)).data?.meta;
const pkHealth = (await req(admin, "GET", "/api/reports/daily/recipients")).data?.health;
ok("U9: once the last recipient is deactivated the screen data says digest-only is ON and nobody can receive it (daily meta and the Defaults picker both)", nobody?.digest_only_nobody === true && nobody?.deliverable === 0 && pkHealth?.digest_only_nobody === true, JSON.stringify({ nobody, pkHealth }));
const w1 = await tick(istAt(UD9, 21, 0, 0), "u9a-" + s, admin, { simulate: ["sent"] });
const w2 = await tick(istAt(UD9, 21, 30, 0), "u9b-" + s, admin, { simulate: ["sent"] });
const warnRows = await mailLogs.find({ entity: "DailyDigestWarning", subject: { $regex: `Daily digest ${UD9}` } }).toArray();
ok("U9: the 21:00 tick says so on the record: a result warning and exactly ONE system MailLog row for the day (a second tick the same evening adds none)",
  /Digest-only is ON/.test(String(w1.data?.warning ?? "")) && /Digest-only is ON/.test(String(w2.data?.warning ?? "")) && warnRows.length === 1 && warnRows[0].status === "skipped" && /going nowhere/.test(String(warnRows[0].reason ?? "")), JSON.stringify({ w1: w1.data?.warning, rows: warnRows.length }));
await db.collection("users").updateOne({ _id: oid(uD.id) }, { $set: { active: true } });
const recovered = (await digest(admin, D)).data?.meta;
ok("U9: reactivating the recipient clears the warning", recovered?.digest_only_nobody === false && recovered?.deliverable === 1, JSON.stringify(recovered));
await setDefaults({ digest_only_approval_mails: false });
await setDefaults({ digest_recipients: "" });

// ---- U10 (A3) a claim left "sending" by a crash is re-taken after 15 minutes, inside the 3-attempt cap
await setDefaults({ digest_recipients: uA.email });
const stale = async (day, attempts, at) => { await jobLocks.deleteMany({ _id: { $regex: `^digest-sent:${day}:` } }); await jobLocks.insertOne({ _id: `digest-sent:${day}:${toA}`, day, to: toA, instance: "crashed-" + s, at, status: "sending", attempts }); };
const SD1 = "2031-05-10", SD2 = "2031-05-11", SD3 = "2031-05-12";
await stale(SD1, 1, istAt(SD1, 21, 0, 0));
const sBefore = await tick(istAt(SD1, 21, 14, 59), "u10a-" + s, admin, { simulate: ["failed", "sent"] });
ok("U10: a claim stuck in 'sending' is NOT re-taken at 14:59 (the first process may just be slow)", sBefore.data?.fired === false && (await rowsOf(SD1)) === 0 && (await claimOf(SD1))?.attempts === 1, JSON.stringify({ f: sBefore.data?.fired, rows: await rowsOf(SD1) }));
const sAt = await tick(istAt(SD1, 21, 15, 0), "u10b-" + s, admin, { simulate: ["failed", "sent"] });
cl = await claimOf(SD1);
ok("U10: ...at 15:00 it IS re-taken: attempt 2 (the crashed one counted), the mail goes, the claim is final", sAt.data?.fired === true && sAt.data?.results?.[0]?.attempt === 2 && cl?.status === "sent" && cl?.attempts === 2 && (await rowsOf(SD1)) === 1, JSON.stringify({ att: sAt.data?.results?.[0]?.attempt, cl: cl && { s: cl.status, a: cl.attempts } }));
await stale(SD2, 3, istAt(SD2, 21, 0, 0));
const capped = await tick(istAt(SD2, 22, 30, 0), "u10c-" + s, admin, { simulate: ["sent"] });
ok("U10: a stale claim that already used all 3 attempts is never re-taken (the cap holds)", capped.data?.fired === false && (await rowsOf(SD2)) === 0, JSON.stringify(capped.data).slice(0, 120));
await stale(SD3, 1, istAt(SD3, 21, 0, 0));
const staleRace = await Promise.all([0, 1, 2, 3].map((i) => tick(istAt(SD3, 21, 16, 0), `u10r-${i}-` + s, admin, { simulate: ["failed", "sent"], skip_lock: true })));
ok("U10: 4 processes racing the stale re-take with the lock off: exactly one wins and one mail row is written", staleRace.filter((x) => (x.data?.results ?? []).length > 0).length === 1 && (await rowsOf(SD3)) === 1 && (await claimOf(SD3))?.attempts === 2, JSON.stringify({ w: staleRace.filter((x) => (x.data?.results ?? []).length > 0).length, rows: await rowsOf(SD3) }));

// ---- U11 (A5) Publish now names a reason per category
await setListDirect(`${uTr.email}, u:${uGone.id}, ${uOff.email}, ${typedFull}, ${uA.email}`);   // the removed user cannot be written through the route (it refuses it), so a stale list is written directly
await jobLocks.deleteMany({ _id: "daily-digest-manual" });
const pubR = await req(admin, "POST", "/api/reports/daily/publish", { date: "2031-03-21" });
const why = (pubR.data?.not_sent_reasons ?? []).join(" | ");
ok("U11: Publish now names a reason for EACH category that was not sent: a Trainer, a removed user, an account with its mail switch off, and the mail door's own skip (test environment)",
  pubR.status === 200 && /Trainer accounts are not sent/.test(why) && /no longer exists/.test(why) && /mail off for this account/.test(why) && /test environment/.test(why), `${pubR.status} ${why}`);
ok("U11: ...it counts the typed address as a typed address, and its counts add up (5 attempted, 0 sent, 5 skipped, 2 not allowed to receive it)", pubR.data?.typed_addresses === 1 && pubR.data?.attempted === 5 && pubR.data?.sent === 0 && pubR.data?.skipped === 5 && pubR.data?.ineligible === 2, JSON.stringify({ t: pubR.data?.typed_addresses, a: pubR.data?.attempted, s: pubR.data?.skipped, i: pubR.data?.ineligible }));
await jobLocks.deleteMany({ _id: "daily-digest-manual" });
await setDefaults({ digest_recipients: listAll });

// ---- U12 fullView is reachable ONLY from lib/daily-digest.ts, and only for a typed address that matches no account
ok("U12: `fullView` appears only in lib/rules.ts (the option) and lib/daily-digest.ts (its one caller)", eq(fullViewUsers, ["lib/daily-digest.ts", "lib/rules.ts"]), fullViewUsers.join(","));
ok("U10b: a claim is settled only by its CURRENT holder: the settle write is conditional on {instance, attempt, status sending}, so a slow first sender whose claim was re-taken cannot overwrite the re-taker (source shape; the race itself is not drivable through the door)",
  /async function settleClaim\([^)]*instance: string/.test(ddSrc) && /\{ _id: `digest-sent:\$\{day\}:\$\{to\}` as any, instance, attempts: attempt, status: "sending" \}/.test(ddSrc), "");
ok("U12: ...and daily-digest.ts passes it on exactly one code line, only when the recipient is a typed address with no account (r.full)", ddCode.length === 1 && /r\.full \? \{ fullView: true \} : (undefined|\{\})/.test(ddCode[0]), JSON.stringify(ddCode));

// =================================================================================================
// G1 - the "digest only" toggle on the per-approval mails
// =================================================================================================
const normalHeadId = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? []).find((c) => !c.pre_approved && c.active !== false)?._id;
ok("G1 [precondition] an ordinary (not pre-approved) cost head exists to post against", !!normalHeadId, "none - every arm below would post against nothing");
const ruleOn = await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: true, approver_role: "Admin" });
ok("G1 [precondition] the cost.post approval rule is ON so a cost is parked and the approval mail fires", ruleOn.status === 200, `${ruleOn.status}`);
// Same technique as e2e-cost-entry QA-2461: the mail is FIRE-AND-FORGET, so poll until the rows stop arriving.
const settledMail = async (requestId) => {
  let last = -1, stable = 0;
  for (let i = 0; i < 80; i++) {
    const n = await mailLogs.countDocuments({ entity_id: oid(requestId) });
    if (n > 0 && n === last) { if (++stable >= 6) break; } else stable = 0;
    last = n; await sleep(250);
  }
  return mailLogs.find({ entity_id: oid(requestId) }).toArray();
};
const parkCost = async (note) => {
  const r = await req(uOps.cookie, "POST", "/api/costs", { entry_date: "2026-09-07", location: locA._id, amount: 640, note, category: normalHeadId });
  return { status: r.status, id: r.data?.item?._id };
};
// OFF first (the default): the per-approval mail is kept
const offPark = await parkCost(`mc1 toggle OFF ${s}`);
ok("G1 [precondition] a cost parked for approval (202) with the toggle OFF", offPark.status === 202 && !!offPark.id, `${offPark.status}`);
const offRows = offPark.id ? await settledMail(offPark.id) : [];
ok("G1: toggle OFF keeps the per-approval mail: rows exist and none is held back by the digest-only mode",
  offRows.length > 0 && !offRows.some((m) => /digest-only/i.test(String(m.reason ?? ""))), JSON.stringify({ n: offRows.length, reasons: [...new Set(offRows.map((m) => m.reason))] }));
// ON is refused while nobody is listed to receive the digest (the approval mails would simply vanish)
const listBefore = (await req(admin, "GET", "/api/defaults")).data?.item?.digest_recipients;
await setDefaults({ digest_recipients: "" });
const onNoList = await setDefaults({ digest_only_approval_mails: true });
ok("G1: switching 'digest only' ON with no digest recipient is refused (400) and the toggle stays OFF",
  onNoList.status === 400 && (await req(admin, "GET", "/api/defaults")).data?.item?.digest_only_approval_mails === false, `${onNoList.status}`);
// QA-2883 (rewritten in cycle 2): a non-blank string is not a recipient. Separator-only lists parse to zero entries (the route now
// refuses to STORE one, so they are written straight to the document, the way an old row sits there); a Trainer account's email
// and an active account whose own mail switch is off are listed but can never receive it. A typed address with NO account is
// deliverable now (it gets the full report), so it is no longer in this loop: U6 pins that it is accepted.
for (const [label, list, direct] of [["a comma only", ",", true], ["a semicolon only", ";", true], ["separators and spaces", " , ; ", true], ["a Trainer account's email", uTr.email, false], ["an account with its own mail switch off", uOff.email, false]]) {
  if (direct) await setListDirect(list); else await setDefaults({ digest_recipients: list });
  const r = await setDefaults({ digest_only_approval_mails: true });
  const rb = (await req(admin, "GET", "/api/defaults")).data?.item;
  ok(`G1/P1: 'digest only' ON with ${label} is refused (400, with a message) and the toggle stays OFF`, r.status === 400 && /recipient/i.test(JSON.stringify(r.data)) && rb?.digest_only_approval_mails === false, `${r.status} ${JSON.stringify(r.data).slice(0, 140)}`);
  const both = await setDefaults({ digest_recipients: list, digest_only_approval_mails: true });
  ok(`G1/P1: ...also when list and toggle arrive in ONE request (${label})`, both.status === 400 && (await req(admin, "GET", "/api/defaults")).data?.item?.digest_only_approval_mails === false, `${both.status}`);
}
const okOne = await setDefaults({ digest_recipients: `${unknownEmail}, ${uA.email}`, digest_only_approval_mails: true });
ok("G1/P1: ...and ON IS accepted when at least one listed recipient can receive it (a mix of a typed address and an ERP account)", okOne.status === 200 && (await req(admin, "GET", "/api/defaults")).data?.item?.digest_only_approval_mails === true, `${okOne.status}`);
const emptyToSep = await setDefaults({ digest_recipients: " , ; " });
ok("G1/P1: ...and while ON, replacing the list with separators only is refused too (at the list itself), the list unchanged", emptyToSep.status === 400 && (await req(admin, "GET", "/api/defaults")).data?.item?.digest_recipients === `${unknownEmail}, ${uA.email}`, `${emptyToSep.status}`);
await setDefaults({ digest_only_approval_mails: false });
await setDefaults({ digest_recipients: listBefore });
// ON
const onSet = await setDefaults({ digest_only_approval_mails: true });
ok("G1 [precondition] the toggle is stored ON", onSet.status === 200 && (await req(admin, "GET", "/api/defaults")).data?.item?.digest_only_approval_mails === true, `${onSet.status}`);
const onPark = await parkCost(`mc1 toggle ON ${s}`);
const onRows = onPark.id ? await settledMail(onPark.id) : [];
ok("G1: toggle ON suppresses the per-approval mail: every row is skipped, with the digest-only reason ON THE RECORD, and none is sent",
  onRows.length > 0 && onRows.every((m) => m.status !== "sent" && /digest-only/i.test(String(m.reason ?? ""))), JSON.stringify({ n: onRows.length, reasons: [...new Set(onRows.map((m) => m.reason))] }));
ok("G1: ...while the approver still gets the bell (the toggle governs mail, not whether they are told)",
  !!onPark.id && (await db.collection("notifications").countDocuments({ entity: "ApprovalRequest", entity_id: oid(onPark.id) })) > 0, "");
const emptyWhileOn = await setDefaults({ digest_recipients: "" });
ok("G1: ...and emptying the recipient list while it is ON is refused (400) too", emptyWhileOn.status === 400 && (await req(admin, "GET", "/api/defaults")).data?.item?.digest_recipients === listBefore, `${emptyWhileOn.status}`);
await setDefaults({ digest_only_approval_mails: false });
const back = await parkCost(`mc1 toggle back OFF ${s}`);
const backRows = back.id ? await settledMail(back.id) : [];
ok("G1: switched back OFF the per-approval mail is kept again", backRows.length > 0 && !backRows.some((m) => /digest-only/i.test(String(m.reason ?? ""))), JSON.stringify([...new Set(backRows.map((m) => m.reason))]));
// this suite parked three requests on a shared wall: put the shared rule back the way the sibling suites expect it
await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: false, approver_role: "Admin" });
// ...and remove the three parked requests: a request raised now is "still pending" as of any later day, so
// they would otherwise add 1,920 to the pending figure the Chromium arm below reads
await db.collection("approvalrequests").deleteMany({ _id: { $in: [offPark.id, onPark.id, back.id].filter(Boolean).map(oid) } });

// =================================================================================================
// G2 - Publish now
// =================================================================================================
await jobLocks.deleteMany({ _id: "daily-digest-manual" });
const pubBefore = (await digestRows(PUBDAY, recipients)).length;
const refused = await req(uA.cookie, "POST", "/api/reports/daily/publish", { date: PUBDAY });
ok("G2: Publish now is refused (403) for a Location user, who lacks defaults.manage", refused.status === 403, `${refused.status} ${JSON.stringify(refused.data).slice(0, 120)}`);
const refusedOps = await req(uOps.cookie, "POST", "/api/reports/daily/publish", { date: PUBDAY });
ok("G2: ...and for Operations", refusedOps.status === 403, `${refusedOps.status}`);
ok("G2: ...and a refused attempt sent nothing and took no cooldown", (await digestRows(PUBDAY, recipients)).length === pubBefore && (await jobLocks.countDocuments({ _id: "daily-digest-manual" })) === 0, "");
const pub = await req(admin, "POST", "/api/reports/daily/publish", { date: PUBDAY });
ok("G2: Publish now by an Admin (defaults.manage) mails the recipient list at once: 200, 5 attempted", pub.status === 200 && pub.data?.attempted === 5 && pub.data?.day === PUBDAY, `${pub.status} ${JSON.stringify(pub.data).slice(0, 160)}`);
ok("G2: Publish now reports sent/skipped/failed from the outcomes: test env suppresses mail, so 0 sent, all 5 skipped, 0 failed, with the reason (never 'handed to the mail service')",
  pub.data?.sent === 0 && pub.data?.skipped === 5 && pub.data?.failed === 0 && pub.data?.sent + pub.data?.skipped + pub.data?.failed === pub.data?.attempted && Array.isArray(pub.data?.not_sent_reasons) && pub.data.not_sent_reasons.length > 0 && !("mailed" in (pub.data ?? {})), JSON.stringify({ s: pub.data?.sent, k: pub.data?.skipped, f: pub.data?.failed, why: pub.data?.not_sent_reasons }));
ok("G2: ...one row per recipient for that day", (await digestRows(PUBDAY, recipients)).length === pubBefore + 5, String((await digestRows(PUBDAY, recipients)).length));
const pub2 = await req(admin, "POST", "/api/reports/daily/publish", { date: PUBDAY });
ok("G2: a second press inside the cooldown is a 429, not a second mailing", pub2.status === 429 && (await digestRows(PUBDAY, recipients)).length === pubBefore + 5, `${pub2.status}`);
const scheduledAfterManual = await tick(istAt(PUBDAY, 21, 0), "after-manual-" + s);
ok("G2: manual Publish now does not consume the scheduled day: the same day's 21:00 tick also mails all five recipients",
  scheduledAfterManual.data?.fired === true && (await digestRows(PUBDAY, recipients)).length === pubBefore + 10,
  JSON.stringify({ fired: scheduledAfterManual.data?.fired, rows: (await digestRows(PUBDAY, recipients)).length }));
await jobLocks.deleteMany({ _id: "daily-digest-manual" });
const pubDefaults = await req(admin, "GET", "/api/reports/daily?date=" + D);
ok("G2: the screen's data carries the mail state so it can warn when email is off (meta.email_enabled, recipients, hour 21)",
  typeof pubDefaults.data?.meta?.email_enabled === "boolean" && pubDefaults.data?.meta?.recipients === 5 && pubDefaults.data?.meta?.hour === 21, JSON.stringify(pubDefaults.data?.meta));
const tickDoorUser = await tick(istAt(D, 21, 0), "inst-user-" + s, uA.cookie);
ok("G2: the test-only clock door is refused (403) to a non-Admin", tickDoorUser.status === 403, `${tickDoorUser.status}`);

// =================================================================================================
// W - the scheduler wiring (SCHEDULER_DISABLED=1 in every test env, so the tick body is exercised through the door above)
// =================================================================================================
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const instr = readFileSync(path.join(root, "src", "instrumentation.ts"), "utf8");
const lib = readFileSync(path.join(root, "src", "lib", "daily-digest.ts"), "utf8");
ok("W: instrumentation registers a 4th interval that calls digestTick", /setInterval\(\s*digestJob|setInterval\([^)]*digestTick/.test(instr) && /digestTick\(/.test(instr), "");
ok("W: the tick takes the daily-digest lock through the shared takeJobLock", /takeJobLock\(\s*"daily-digest"/.test(lib), "");
ok("W: the existing ticks' lock now delegates to the same shared takeJobLock (one implementation, not two)", /takeJobLock\(job, ttlMs, INSTANCE\)/.test(instr), "");

// ---- cleanup of shared documents ------------------------------------------------------------------------
await setDefaults({ digest_recipients: "", digest_only_approval_mails: false });
await wipeLocks();

// =================================================================================================
// S - the real screen, in Chromium
// =================================================================================================
try { browser = await chromium.launch({ headless: true }); }
catch (e) { ok("[precondition] chromium launches from the `playwright` devDependency", false, String(e.message).slice(0, 200)); finish(); }
const newPage = async (email, password) => {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });   // one context per persona
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e.message).slice(0, 160)));
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const emailBox = page.locator('input[type="email"], input[name="email"], input[id="email"]').first();
  if (await emailBox.count()) {
    await emailBox.fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first().click();
    await page.waitForURL((u) => !/login/i.test(String(u)), { timeout: 30000 }).catch(() => {});
  }
  page.setDefaultTimeout(20000);
  return { ctx, page };
};
const arm = async (name, fn) => { try { await fn(); } catch (e) { ok(`${name} [arm ran to its end]`, false, String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 260)); } };
const txt = async (page, tid) => (await page.locator(`[data-testid="${tid}"]`).first().innerText()).replace(/\s+/g, " ").trim();
const shotDir = process.env.MC1_BROWSER_REPORT;
const shot = async (page, name) => { if (shotDir) { try { mkdirSync(shotDir, { recursive: true }); await page.screenshot({ path: path.join(shotDir, name), fullPage: true }); } catch { /* evidence is a convenience */ } } };

await arm("S1 digest screen (Location A with finance.view)", async () => {
  const { ctx, page } = await newPage(uAF.email, PW);
  await page.goto(`${BASE}/reports/daily?date=${D}`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="digest-table-costs"]').waitFor();
  // screen = API, cell for cell, in every table (the screen only lays out what dailyDigest worded)
  const api = (await digest(uAF.cookie, D)).data;
  const screenBad = [];
  for (const t of api?.tables ?? []) for (const [ri, r] of t.rows.entries()) for (const [ci, c] of r.cells.entries()) {
    const got = await txt(page, `digest-cell-${t.key}-${ri}-${ci}`).catch(() => "<missing>");
    if (got !== c) screenBad.push(`${t.key}/${r.label}/${ci}: screen ${got} api ${c}`);
  }
  ok("S1: the screen draws every cell of every table exactly as the API words it (Trainers, Candidates, Costs)", (api?.tables ?? []).length === 3 && screenBad.length === 0, screenBad.join(" | ").slice(0, 300));
  const cell = async (key, label, ci) => txt(page, `digest-cell-${key}-${(api?.tables ?? []).find((t) => t.key === key)?.rows.findIndex((r) => r.label === label)}-${ci}`);
  const got = {
    joined: await cell("candidates", "Joined into batches", 1), enrolled: await cell("candidates", "Enrolled", 1), mobilised: await cell("candidates", "Mobilised (planning batches)", 0),
    assigned: await cell("trainers", "Assigned to a live batch", 0), idle: await cell("trainers", "Free to assign", 0),
    today: await cell("costs", "Approved on the day", 0), month: await cell("costs", "Month to date", 0), pending: await cell("costs", "Pending approval", 0),
  };
  ok("S1: the cells read joined 4, enrolled 2, mobilised 12 of 30, assigned 2, free 4", got.joined === "4" && got.enrolled === "2" && got.mobilised === "12 of 30 (gap 18)" && got.assigned === "2" && got.idle === "4", JSON.stringify(got));
  ok("S1: learner cells show 7 training starts on the day, 5 enrolled and 0 Training Ongoing now, with a current measurement time",
    await cell("candidates", "Training started", 1) === "7" && await cell("candidates", "Enrolled", 0) === "5"
    && await cell("candidates", "In training (started Active batch)", 0) === "0" && /measured.*IST/.test(await txt(page, "digest-current-measured")), "");
  ok("S1: the money cells read Rs 1,250 today, Rs 5,750 this month, Rs 1,100 pending", got.today === "Rs 1,250" && got.month === "Rs 5,750" && got.pending === "Rs 1,100", JSON.stringify(got));
  ok("S1: the week is named on the screen (Monday to Sunday)", /Week 2031-03-10 to 2031-03-16/.test(await txt(page, "digest-note")), await txt(page, "digest-note"));
  ok("S1: a finance viewer's note does say how pending approvals and payment-pending are counted", /payment-pending are exact for today/.test(await txt(page, "digest-note")), "");
  ok("S1: Publish now is NOT offered to a user without defaults.manage", (await page.locator('[data-testid="digest-publish"]').count()) === 0, "");
  ok("S1: the date shown is the chosen IST day", /2031-03-14/.test(await page.locator('[data-testid="digest-date"]').inputValue()), "");

  // S4 - the dashboard controls, on the same screen. Everything is presentation over the API's cells.
  const rowIds = async (key) => page.locator(`[data-testid^="digest-row-${key}-"]`).evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
  await page.locator('[data-testid="digest-section"]').selectOption("costs");
  await page.waitForURL(/section=costs/);
  ok("S4: the section dropdown shows only that table (Costs), and the link carries it",
    (await page.locator('[data-testid="digest-table-costs"]').count()) === 1 && (await page.locator('[data-testid="digest-table-trainers"]').count()) === 0 && (await page.locator('[data-testid="digest-table-candidates"]').count()) === 0, page.url());
  ok("S4: ...and the candidate details under the tables go with it (joined by batch, the 'measured' line)",
    (await page.locator('[data-testid="digest-by-batch"]').count()) === 0 && (await page.locator('[data-testid="digest-current-measured"]').count()) === 0, "");
  await page.locator('[data-testid="digest-section"]').selectOption("all");
  await page.locator('[data-testid="digest-table-trainers"]').waitFor();
  ok("S4: All sections brings them back", (await page.locator('[data-testid="digest-by-batch"]').count()) === 1 && (await page.locator('[data-testid="digest-current-measured"]').count()) === 1, "");
  const tTr = (api?.tables ?? []).find((t) => t.key === "trainers");
  const nowOf = (r) => { const m = String(r.cells[0]).replace(/,/g, "").match(/\d+/); return m ? Number(m[0]) : -1; };
  const parents = tTr.rows.map((r, i) => ({ r, i })).filter((x) => !x.r.sub);
  const wantDesc = [...parents].sort((a, b) => nowOf(b.r) - nowOf(a.r) || a.i - b.i).map((x) => x.i);
  await page.locator('[data-testid="digest-sort-trainers-1"]').click();
  const sortedParents = (await rowIds("trainers")).map((id) => Number(id.split("-").pop())).filter((i) => !tTr.rows[i].sub);
  ok("S4: clicking the Now header sorts the Trainers rows high to low, and each breakdown row stays under its parent",
    eq(sortedParents, wantDesc) && (await rowIds("trainers")).length === tTr.rows.length, JSON.stringify([sortedParents, wantDesc]));
  await page.locator('[data-testid="digest-sort-trainers-1"]').click();
  await page.locator('[data-testid="digest-sort-trainers-1"]').click();
  ok("S4: a third click puts the report's own order back", eq((await rowIds("trainers")).map((id) => Number(id.split("-").pop())), tTr.rows.map((_, i) => i)), "");
  await page.locator('[data-testid="digest-filter-candidates"]').fill("batches ");
  const filtered = await rowIds("candidates");
  ok("S4: the row filter keeps only matching rows (Batches created, Batches started)", filtered.length === 2, JSON.stringify(filtered));
  await page.locator('[data-testid="digest-filter-candidates"]').fill("");
  const tCa = (api?.tables ?? []).find((t) => t.key === "candidates");
  const numAt = (c) => { const m = String(c ?? "").replace(/,/g, "").replace(/\u2212/g, "-").match(/[-+]?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
  await page.locator('[data-testid="digest-min-candidates-3"]').fill("1");
  const wantMin = tCa.rows.filter((r) => (numAt(r.cells[2]) ?? -1) >= 1).length;
  ok("S4: a minimum on the week column keeps the rows at or above it", (await rowIds("candidates")).length === wantMin, `${(await rowIds("candidates")).length} vs ${wantMin}`);
  await page.locator('[data-testid="digest-min-candidates-3"]').fill("");
  await page.locator('[data-testid="digest-hide-zero"]').check();
  const wantNz = tCa.rows.filter((r) => r.cells.some((c) => { const n = numAt(c); return n !== null && n !== 0; })).length;
  ok("S4: Hide zero rows drops the rows whose every figure is 0 or blank", (await rowIds("candidates")).length === wantNz, `${(await rowIds("candidates")).length} vs ${wantNz}`);
  await page.locator('[data-testid="digest-hide-zero"]').uncheck();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator('[data-testid="digest-csv-costs"]').click()]);
  const csv = readFileSync(await dl.path(), "utf8").replace(/^\ufeff/, "");
  const tCo = (api?.tables ?? []).find((t) => t.key === "costs");
  const csvWant = [tCo.head, ...tCo.rows.map((r) => [(r.sub ? "  " : "") + r.label, ...r.cells])].map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\r\n");
  ok("S4: Download CSV gives the table exactly as shown (header + every row), named for the table and day", csv === csvWant && dl.suggestedFilename() === `digest-costs-${D}.csv`, `${dl.suggestedFilename()} ${csv.slice(0, 120)}`);
  await page.goto(`${BASE}/reports/daily?date=${D}&from=2031-03-10`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="digest-table-candidates"]').waitFor();
  const apiR = (await digestR(uAF.cookie, D, "2031-03-10")).data;
  const enrIdx = tCa.rows.findIndex((r) => r.label === "Enrolled");
  await page.waitForFunction(() => /Range 2031-03-10/.test(document.querySelector('[data-testid="digest-note"]')?.textContent ?? ""));
  ok("S4: a range in the link is on the screen: the picker holds it and the range column matches the API",
    (await page.locator('[data-testid="digest-from"]').inputValue()) === "2031-03-10" && (await txt(page, `digest-cell-candidates-${enrIdx}-3`)) === cellsAt(apiR, "candidates", "Enrolled")?.[3], "");
  // seen live on -342: two changes before the router re-renders - the second must not undo the first
  await page.locator('[data-testid="digest-section"]').selectOption("costs");
  await page.locator('[data-testid="digest-from"]').fill("2031-03-11");
  await page.waitForURL(/from=2031-03-11/);
  await page.waitForTimeout(800);
  ok("S4: picking a section and then a range straight away keeps both (section=costs and from=2031-03-11 in the link, only Costs shown)",
    /section=costs/.test(page.url()) && /from=2031-03-11/.test(page.url()) && (await page.locator('[data-testid^="digest-table-"]').count()) === 1, page.url());
  // ...and THREE in a row: the third must build on the second even when the URL has only caught up with the first
  await page.locator('[data-testid="digest-section"]').selectOption("trainers");
  await page.locator('[data-testid="digest-from"]').fill("2031-03-12");
  await page.locator('[data-testid="digest-date"]').fill("2031-03-13");
  await page.waitForURL(/date=2031-03-13/);
  await page.waitForTimeout(800);
  ok("S4: three quick changes (section, range, day) all stay in the link",
    /section=trainers/.test(page.url()) && /from=2031-03-12/.test(page.url()) && /date=2031-03-13/.test(page.url()), page.url());
  await shot(page, "S1-digest-finance-viewer.png");
  await ctx.close();
});
await arm("S2 digest screen (Location A, no finance)", async () => {
  const { ctx, page } = await newPage(uA.email, PW);
  await page.goto(`${BASE}/reports/daily?date=${D}`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="digest-table-candidates"]').waitFor();
  ok("S2: the costs section is not in the page at all, and no cost figure is", (await page.locator('[data-testid="digest-table-costs"]').count()) === 0 && !/1,250|5,750|14,249/.test(await page.locator("body").innerText()), "");
  ok("S2: no centre-B batch is on Location A's screen", (await page.locator(`text=${fx.pb1.code}`).count()) === 0, "");
  ok("S2: the note above the tables does not talk about pending approvals or payment-pending (this viewer has no Costs table)", !/payment-pending|Pending approvals/i.test(await txt(page, "digest-note")), await txt(page, "digest-note"));
  await shot(page, "S2-digest-no-finance.png");
  await ctx.close();
});
await arm("S3 digest screen (Admin: Publish now)", async () => {
  await setDefaults({ digest_recipients: recipients.join(", ") });
  await jobLocks.deleteMany({ _id: "daily-digest-manual" });
  const { ctx, page } = await newPage(uAdm.email, PW);   // the fixture Admin: holds no finance.view (the seeded admin may carry the grant)
  await page.goto(`${BASE}/reports/daily?date=${PUBDAY}`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="digest-publish"]').waitFor();
  const before = (await digestRows(PUBDAY, recipients)).length;
  // the button is disabled until the figures for the chosen day have loaded; wait for the ENABLED inner button
  // (clicking the wrapper span would land on a disabled button and do nothing)
  await page.locator('[data-testid="digest-publish"] button:not([disabled])').click();
  await page.locator('[data-testid="digest-publish-result"]').waitFor();
  const res = await txt(page, "digest-publish-result");
  ok("S3: pressing Publish now shows the outcome in words (5 recipients attempted)", /5/.test(res) && /recipient/i.test(res), res);
  ok("S3: ...and says truthfully that nothing was sent (test env suppresses mail): '0 sent', '5 skipped', the reason, and never 'handed to the mail service'", /(^|[^0-9])0 sent/.test(res) && /5 skipped/.test(res) && /Reason/.test(res) && !/handed to the mail service/i.test(res), res);
  ok("S3: ...and it really mailed through the one door: 5 new rows for that day", (await digestRows(PUBDAY, recipients)).length === before + 5, String((await digestRows(PUBDAY, recipients)).length - before));
  ok("S3: the Admin's screen has no costs section (no finance.view)", (await page.locator('[data-testid="digest-table-costs"]').count()) === 0, "");
  await shot(page, "S3-digest-admin-publish.png");
  await ctx.close();
  await setDefaults({ digest_recipients: "" });
  await jobLocks.deleteMany({ _id: "daily-digest-manual" });
});
await arm("S4 digest screen (Trainer is kept out)", async () => {
  const { ctx, page } = await newPage(uTr.email, PW);
  await page.goto(`${BASE}/reports/daily?date=${D}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  ok("S4: a Trainer login does not get the digest tables", (await page.locator('[data-testid^="digest-table-"]').count()) === 0, "");
  await ctx.close();
});

await arm("S5 Defaults: the recipient picker (Admin)", async () => {
  await setDefaults({ digest_only_approval_mails: false });
  await setListDirect("");
  const typedUi = `zz.ui.${s.toLowerCase()}@vidysea-test.local`;
  const { ctx, page } = await newPage(uAdm.email, PW);
  await page.goto(`${BASE}/admin?tab=Defaults`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="digest-recipients"]').waitFor();
  ok("S5: an empty list says so (no chip) and offers the picker and the typed box", (await page.locator('[data-testid="digest-chip"]').count()) === 0 && (await page.locator('[data-testid="digest-picker-search"]').count()) === 1 && (await page.locator('[data-testid="digest-typed-input"]').count()) === 1, "");
  await page.locator('[data-testid="digest-picker-search"]').fill(uA.email);
  await page.locator(`[data-testid="digest-picker-option"][data-email="${uA.email.toLowerCase()}"]`).waitFor();
  ok("S5: searching an email narrows the picker to that one ERP user (and a Trainer is not offered)", (await page.locator('[data-testid="digest-picker-option"]').count()) === 1, String(await page.locator('[data-testid="digest-picker-option"]').count()));
  await page.locator(`[data-testid="digest-picker-option"][data-email="${uA.email.toLowerCase()}"] [data-testid="digest-picker-add"]`).click();
  ok("S5: Add puts the user on the list as a user chip (no cost warning: an ERP user keeps their own view)", (await page.locator('[data-testid="digest-chip"][data-kind="user"]').count()) === 1 && (await page.locator('[data-testid="digest-typed-warning"]').count()) === 0, "");
  await page.locator('[data-testid="digest-typed-input"]').fill("not-an-email");
  await page.locator('[data-testid="digest-typed-add"]').click();
  ok("S5: a typed address that is not an address is refused on the spot, with a message, and no chip is added", (await page.locator('[data-testid="digest-typed-error"]').count()) === 1 && (await page.locator('[data-testid="digest-chip"]').count()) === 1, "");
  await page.locator('[data-testid="digest-typed-input"]').fill(typedUi.toUpperCase());
  await page.locator('[data-testid="digest-typed-add"]').click();
  const typedChip = page.locator(`[data-testid="digest-chip"][data-kind="address"][data-token="${typedUi}"]`);
  await typedChip.waitFor();
  ok("S5: a valid typed address becomes a chip (lowercased) that carries the warning 'This address will receive cost figures'", /This address will receive cost figures/.test(await typedChip.innerText()), (await typedChip.innerText()).replace(/\s+/g, " "));
  await page.locator('[data-testid="digest-typed-input"]').fill(typedUi);
  await page.locator('[data-testid="digest-typed-add"]').click();
  ok("S5: the same address again is refused (no duplicate chip)", (await page.locator('[data-testid="digest-chip"]').count()) === 2 && (await page.locator('[data-testid="digest-typed-error"]').count()) === 1, "");
  await shot(page, "S5-defaults-recipient-picker.png");
  await page.locator('button:has-text("Save")').first().click();
  let stored = "";
  for (let i = 0; i < 40; i++) { stored = String((await dbDef())?.digest_recipients ?? ""); if (stored) break; await sleep(250); }
  ok("S5: Save stores the list in canonical form: the picked user's tag and the typed address, comma separated", stored === `u:${uA.id}, ${typedUi}`, stored);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="digest-chip"][data-kind="user"]').filter({ hasText: "ZZ MC1 a" }).first().waitFor();
  ok("S5: after a reload both chips are there again (the user chip reads the person's name and email, not a bare id)", (await page.locator('[data-testid="digest-chip"]').count()) === 2 && /ZZ MC1 a/.test(await page.locator('[data-testid="digest-chip"][data-kind="user"]').innerText()) && (await page.locator('[data-testid="digest-chip"][data-kind="user"]').innerText()).includes(uA.email.toLowerCase()), (await page.locator('[data-testid="digest-chips"]').innerText()).replace(/\s+/g, " "));
  await page.locator(`[data-testid="digest-chip"][data-token="${typedUi}"] [data-testid="digest-chip-remove"]`).click();
  ok("S5: Remove takes the typed address off the list", (await page.locator('[data-testid="digest-chip"]').count()) === 1 && (await page.locator('[data-testid="digest-typed-warning"]').count()) === 0, "");
  await ctx.close();
  await setListDirect("");
});
await arm("S7 Defaults: the outside-address box is an Admin's (QA-2923)", async () => {
  await setListDirect("");
  const { ctx: ctxA, page: pa } = await newPage(uAdm.email, PW);
  await pa.goto(`${BASE}/admin?tab=Defaults`, { waitUntil: "domcontentloaded" });
  await pa.locator('[data-testid="digest-recipients"]').waitFor();
  ok("S7: an Admin sees the outside-address box and its Add button, and the picker", (await pa.locator('[data-testid="digest-typed-input"]').count()) === 1 && (await pa.locator('[data-testid="digest-typed-add"]').count()) === 1 && (await pa.locator('[data-testid="digest-picker-search"]').count()) === 1, "");
  await ctxA.close();
  for (const [who, g] of [["a Location grantee", uGL], ["an Operations grantee", uGO]]) {
    const { ctx, page } = await newPage(g.email, PW);
    await page.goto(`${BASE}/admin?tab=Defaults`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    ok(`S7: ${who} gets no outside-address box on Defaults (the /admin screen is itself Admin-only, so the box is not reachable at all)`, (await page.locator('[data-testid="digest-typed-input"]').count()) === 0 && (await page.locator('[data-testid="digest-typed-add"]').count()) === 0, page.url());
    await ctx.close();
  }
  const adminSrc = readFileSync(path.join(srcRoot, "app", "(app)", "admin", "page.tsx"), "utf8");
  ok("S7: the component renders the typed box only when the signed-in role is Admin, and says why otherwise (source shape; a non-Admin cannot render this screen in a browser, so the component guard is pinned in source)",
    /canType=\{[^}]*role[^}]*Admin/.test(adminSrc) && /canType &&[\s\S]{0,200}digest-typed-input/.test(adminSrc) && /data-testid="digest-typed-admin-only"/.test(adminSrc), "");
});
await arm("S6 the 'nobody can receive it' warning (Admin: Defaults and the digest screen)", async () => {
  await db.collection("users").updateOne({ _id: oid(uD.id) }, { $set: { active: false } });
  await db.collection("defaults").updateOne({ _singleton: "defaults" }, { $set: { digest_recipients: `u:${uD.id}`, digest_only_approval_mails: true } });
  const { ctx, page } = await newPage(uAdm.email, PW);
  await page.goto(`${BASE}/admin?tab=Defaults`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="digest-only-nobody-warning"]').waitFor();
  ok("S6: Defaults shows the red warning while digest-only is ON and the only recipient is deactivated", /going nowhere/.test(await txt(page, "digest-only-nobody-warning")), await txt(page, "digest-only-nobody-warning"));
  await page.goto(`${BASE}/reports/daily?date=${D}`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="digest-only-nobody-warning"]').waitFor();
  ok("S6: the digest screen shows the same warning to the Admin who can fix it", /going nowhere/.test(await txt(page, "digest-only-nobody-warning")), "");
  await shot(page, "S6-digest-only-nobody-warning.png");
  await ctx.close();
  const { ctx: ctx2, page: page2 } = await newPage(uOps.email, PW);
  await page2.goto(`${BASE}/reports/daily?date=${D}`, { waitUntil: "domcontentloaded" });
  await page2.locator('[data-testid="digest-table-candidates"]').waitFor();
  ok("S6: a viewer who cannot publish or edit the list does not get the warning", (await page2.locator('[data-testid="digest-only-nobody-warning"]').count()) === 0, "");
  await ctx2.close();
  await db.collection("users").updateOne({ _id: oid(uD.id) }, { $set: { active: true } });
  await setDefaults({ digest_only_approval_mails: false });
  await setListDirect("");
});

// ---- M1 a big joining day: the mail's "by batch" line names at most 10 batches and counts the rest. Last in the
// suite, on its own day, with Closed batches, so no earlier arm's figures move.
const CAPD = "2031-09-02";
const capTags = [];
for (let i = 0; i < 12; i++) {
  const r = await req(admin, "POST", "/api/batches", { location: locA._id, program: prog._id, planned_start: today(), target_size: 5 });
  if (r.status !== 201) { ok(`[precondition] M1 batch ${i} created`, false, JSON.stringify(r.data).slice(0, 160)); continue; }
  await db.collection("batches").updateOne({ _id: oid(r.data.item._id) }, { $set: { status: "Closed", createdAt: istAt("2031-03-01", 10, 0) } });
  fx[`cap${i}`] = { id: String(r.data.item._id), code: r.data.item.code, loc: locA, target: 5 };
  capTags.push(`cap${i}`);
}
await db.collection("batchmembers").insertMany(capTags.map((t) => mem(t, CAPD)));
await setListDirect(`u:${uAdm.id}`);
const capTick = await tick(istAt(CAPD, 21, 0), "cap-" + s);
const capLine = String(capTick.data?.results?.find((r) => r.to === uAdm.email.toLowerCase())?.text ?? "").split(/\r?\n/).find((l) => l.startsWith("Joined on the day, by batch:")) ?? "";
const named = capTags.filter((t) => capLine.includes(fx[t].code)).length;
ok("M1: 12 batches joined on one day: the mail line names 10 of them and says '2 more batches (see the Reports screen)'",
  capTags.length === 12 && named === 10 && /, and 2 more batches \(see the Reports screen\)$/.test(capLine), `${named} named: ${capLine.slice(0, 200)}`);
await setListDirect("");

await browser.close();
// remove the raw rows this suite inserted (marked with this run's stamp): they carry 2031 dates and real
// centres, and a later suite reading costs or trainers on the shared wall should not meet them
await db.collection("costentries").deleteMany({ note: `mc1 fixture ${s}` });
await db.collection("approvalrequests").deleteMany({ summary: new RegExp(`^mc1 pending .* ${s}$`) });
await db.collection("batchmembers").deleteMany({ batch: { $in: Object.values(fx).map((f) => oid(f.id)) } });
await db.collection("candidates").deleteMany({ name: new RegExp(`^ZZ MC1 .*${s}$`) });
await db.collection("trainers").deleteMany({ name: new RegExp(`^ZZ MC1 .*${s}$`) });
await mc.close();
finish();
