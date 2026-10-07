// mtg-c1 (R4) - QA-2871 / QA-2872 / QA-2873.
//
// Meeting 2026-10-06, Karunn sir: "all reporting from the system, no Excel". Umesh's decision on the
// notification noise: "Screen + 1 mail". So:
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
//   T6  recipients: ineligible addresses are recorded, not mailed
//   R1-R5 a failed/skipped send does not consume the day: retry (atomic, capped at 3, 10 minutes apart, same IST day)
//   G1  the "digest only" toggle: ON suppresses (on the record), OFF keeps the per-approval mail
//   G2  Publish now: refused without defaults.manage, allowed with it, cooldown, empty list
//   W   the scheduler wiring
//   S   the real screen, in Chromium
//
// Every identity is derived from the run stamp. The shared wall DB holds other suites' data, so the EXACT
// numbers are asserted through scoped personas on a day (2031-03-14) no other suite writes to.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
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
  ok("MC1: the suite ran to its end without an uncaught error", false, `ABORTED: ${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 300)} - every arm after this point did not run`);
  try { if (browser) await browser.close(); } catch { /* nothing left */ }
  finish();
};
process.on("uncaughtException", onFatal);
process.on("unhandledRejection", onFatal);

const s = stamp("MC1");
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
ok("[precondition] personas (Location A, Location A + finance.view, Location B, Location B + finance.view, Operations, Admin, Trainer) can log in",
  !!(uA.cookie && uAF.cookie && uB.cookie && uBF.cookie && uOps.cookie && uAdm.cookie && uTr.cookie),
  JSON.stringify({ a: uA.status, af: uAF.status, b: uB.status, bf: uBF.status, ops: uOps.status, adm: uAdm.status, tr: uTr.status }));

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

// =================================================================================================
// recipients, and T6 first (before anything is sent): who is eligible
// =================================================================================================
const unknownEmail = `zz.nobody.${s.toLowerCase()}@vidysea-test.local`;
const recipients = [uAF.email, uA.email, uAdm.email, uTr.email, unknownEmail];
// G2 (empty list), while the recipients are still empty: refused 409 and takes no cooldown
const emptyPub = await req(admin, "POST", "/api/reports/daily/publish", { date: PUBDAY });
ok("G2: Publish now with no recipients configured is a 409 that says so", emptyPub.status === 409 && /recipient/i.test(JSON.stringify(emptyPub.data)), `${emptyPub.status} ${JSON.stringify(emptyPub.data).slice(0, 120)}`);
const setDefaults = (body) => req(admin, "PUT", "/api/defaults", body);
const putR = await setDefaults({ digest_recipients: recipients.join(", ") });
const readBack = (await req(admin, "GET", "/api/defaults")).data?.item;
ok("[precondition] the recipient list is stored and read back, and the toggle defaults to OFF", putR.status === 200 && readBack?.digest_recipients === recipients.join(", ") && readBack?.digest_only_approval_mails === false,
  JSON.stringify({ put: putR.status, rb: readBack?.digest_recipients, toggle: readBack?.digest_only_approval_mails }));

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
ok("T6: the three eligible ERP accounts were mailed (outcome mailed) and the Trainer account and the unknown address were not",
  mailed(uAF.email)?.outcome === "mailed" && mailed(uA.email)?.outcome === "mailed" && mailed(uAdm.email)?.outcome === "mailed"
  && mailed(uTr.email)?.outcome === "ineligible" && mailed(unknownEmail)?.outcome === "ineligible", JSON.stringify(Object.values(resByTo).map((r) => [r.to, r.outcome])));
ok("T6: the ineligible ones are ON THE RECORD with a reason, not silent", rowsD.filter((r) => r.to === unknownEmail.toLowerCase() || r.to === uTr.email.toLowerCase()).every((r) => r.status === "skipped" && /not an active|trainer/i.test(String(r.reason ?? ""))),
  JSON.stringify(rowsD.filter((r) => /nobody|tr\./.test(r.to)).map((r) => [r.to, r.status, r.reason])));
const txtF = String(mailed(uAF.email)?.text ?? ""), txtN = String(mailed(uA.email)?.text ?? ""), txtAdm = String(mailed(uAdm.email)?.text ?? "");
ok("T5: the finance recipient's mail carries the exact costs (today Rs 1,250, month Rs 5,750, pending Rs 1,100, payment pending Rs 14,249)",
  /Costs/.test(txtF) && txtF.includes("Rs 1,250") && txtF.includes("Rs 5,750") && txtF.includes("Rs 1,100") && txtF.includes("Rs 14,249"), txtF.replace(/\s+/g, " ").slice(0, 400));
ok("T5: ...and its other sections carry the same exact numbers as the screen (Joined into batches: 4, Enrolled: 2, Mobilised 12 of 30)",
  txtF.includes("Joined into batches: 4") && txtF.includes("Enrolled: 2") && /Mobilised[^\n]*12 of 30/.test(txtF), txtF.replace(/\s+/g, " ").slice(0, 400));
ok("T5: the SAME digest for a recipient WITHOUT finance.view has no Costs section and no cost figure at all",
  txtN.length > 0 && !/Costs|Rs \d|spend|Payment pending/i.test(txtN) && txtN.includes("Joined into batches: 4"), txtN.replace(/\s+/g, " ").slice(0, 300));
ok("T5: an Admin recipient gets no Costs section either (no finance.view)", txtAdm.length > 0 && !/Costs|Rs \d/i.test(txtAdm), txtAdm.replace(/\s+/g, " ").slice(0, 200));
ok("T5: a scoped recipient's mail names only its own centre's batches", !txtN.includes(fx.pb1.code) && txtN.includes(fx.pa1.code), "");

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
// R5 - an ineligible address is recorded once and closed, not retried
await setDefaults({ digest_recipients: unknownEmail });
const r5a = await tick(istAt("2031-04-05", 21, 0, 0), "r5a-" + s, admin, { simulate: [] });
const r5b = await tick(istAt("2031-04-05", 21, 15, 0), "r5b-" + s, admin, { simulate: [] });
const clU = await jobLocks.findOne({ _id: `digest-sent:2031-04-05:${unknownEmail.toLowerCase()}` });
ok("R5: an address that is not an ERP account is recorded once and CLOSED (not retried: a retry cannot make it an account)", r5a.data?.fired === true && r5b.data?.fired === false && clU?.status === "closed" && (await digestRows("2031-04-05", [unknownEmail.toLowerCase()])).length === 1, JSON.stringify({ cl: clU?.status, rows: (await digestRows("2031-04-05", [unknownEmail.toLowerCase()])).length }));
await setDefaults({ digest_recipients: listAll });

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
// QA-2883: a non-blank string is not a recipient. Separator-only lists parse to zero addresses; an address with no
// ERP account, a Trainer account and an active account whose own mail switch is off are all skipped by the tick.
for (const [label, list] of [["a comma only", ","], ["a semicolon only", ";"], ["separators and spaces", " , ; "], ["an address with no ERP account", unknownEmail], ["a Trainer account only", uTr.email], ["an account with its own mail switch off", uOff.email]]) {
  await setDefaults({ digest_recipients: list });
  const r = await setDefaults({ digest_only_approval_mails: true });
  const rb = (await req(admin, "GET", "/api/defaults")).data?.item;
  ok(`G1/P1: 'digest only' ON with ${label} is refused (400, with a message) and the toggle stays OFF`, r.status === 400 && /recipient/i.test(JSON.stringify(r.data)) && rb?.digest_only_approval_mails === false, `${r.status} ${JSON.stringify(r.data).slice(0, 140)}`);
  const both = await setDefaults({ digest_recipients: list, digest_only_approval_mails: true });
  ok(`G1/P1: ...also when list and toggle arrive in ONE request (${label})`, both.status === 400 && (await req(admin, "GET", "/api/defaults")).data?.item?.digest_only_approval_mails === false, `${both.status}`);
}
const okOne = await setDefaults({ digest_recipients: `${unknownEmail}, ${uA.email}`, digest_only_approval_mails: true });
ok("G1/P1: ...but ON IS accepted when at least one listed address is an eligible ERP account (a mix with an unknown one)", okOne.status === 200 && (await req(admin, "GET", "/api/defaults")).data?.item?.digest_only_approval_mails === true, `${okOne.status}`);
const emptyToSep = await setDefaults({ digest_recipients: " , ; " });
ok("G1/P1: ...and while ON, replacing the list with separators only is refused too, the list unchanged", emptyToSep.status === 400 && (await req(admin, "GET", "/api/defaults")).data?.item?.digest_recipients === `${unknownEmail}, ${uA.email}`, `${emptyToSep.status}`);
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
  await page.locator('[data-testid="digest-costs"]').waitFor();
  const got = {
    joined: await txt(page, "digest-joined"), enrolled: await txt(page, "digest-enrolled"), mobilised: await txt(page, "digest-mobilised"),
    assigned: await txt(page, "digest-assigned"), idle: await txt(page, "digest-idle"), pipeline: await txt(page, "digest-pipeline"),
    today: await txt(page, "digest-cost-today"), month: await txt(page, "digest-cost-month"), pending: await txt(page, "digest-cost-pending"),
  };
  ok("S1: the tiles read joined 4, enrolled 2, mobilised 12, assigned 2, free 4, pipeline 6", got.joined === "4" && got.enrolled === "2" && got.mobilised === "12" && got.assigned === "2" && got.idle === "4" && got.pipeline === "6", JSON.stringify(got));
  ok("S1: the money tiles read 1,250 today, 5,750 this month, 1,100 pending", /1,250/.test(got.today) && /5,750/.test(got.month) && /1,100/.test(got.pending), JSON.stringify(got));
  ok("S1: Publish now is NOT offered to a user without defaults.manage", (await page.locator('[data-testid="digest-publish"]').count()) === 0, "");
  ok("S1: the date shown is the chosen IST day", /2031-03-14/.test(await page.locator('[data-testid="digest-date"]').inputValue()), "");
  await shot(page, "S1-digest-finance-viewer.png");
  await ctx.close();
});
await arm("S2 digest screen (Location A, no finance)", async () => {
  const { ctx, page } = await newPage(uA.email, PW);
  await page.goto(`${BASE}/reports/daily?date=${D}`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="digest-joined"]').waitFor();
  ok("S2: the costs section is not in the page at all, and no cost figure is", (await page.locator('[data-testid="digest-costs"]').count()) === 0 && !/1,250|5,750|14,249/.test(await page.locator("body").innerText()), "");
  ok("S2: no centre-B batch is on Location A's screen", (await page.locator(`text=${fx.pb1.code}`).count()) === 0, "");
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
  ok("S3: the Admin's screen has no costs section (no finance.view)", (await page.locator('[data-testid="digest-costs"]').count()) === 0, "");
  await shot(page, "S3-digest-admin-publish.png");
  await ctx.close();
  await setDefaults({ digest_recipients: "" });
  await jobLocks.deleteMany({ _id: "daily-digest-manual" });
});
await arm("S4 digest screen (Trainer is kept out)", async () => {
  const { ctx, page } = await newPage(uTr.email, PW);
  await page.goto(`${BASE}/reports/daily?date=${D}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  ok("S4: a Trainer login does not get the digest tiles", (await page.locator('[data-testid="digest-joined"]').count()) === 0, "");
  await ctx.close();
});

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
