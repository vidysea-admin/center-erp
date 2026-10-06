// mtg-b1 (R3 + R1a) - QA-2864 / QA-2865.
//
// Meeting 2026-10-06, Karunn sir: "all reporting from the system, no Excel".
//   R3  the Planning tab on /batches: Target / Mobilised / Gap per planned batch, and above the table
//       the batches starting this week (IST), total target, total mobilised, total gap.
//   R1a /reports: a "Recently approved" strip - LocationTarget approvals decided in the last N days
//       (default 7), grouped by centre x job role with the count.
//
// ARM NAMES carry the criterion so a mutant reddens the arm it targets and a verdict can quote the line:
//   P1  exact per-batch Target / Mobilised / Gap (an over-filled batch has gap 0, not negative)
//   P2  exact summary numbers, and the status filter (Active is not in the summary, Ready is)
//   P3  the IST week: week.start is Monday 00:00 IST; Sun 23:30 IST is in, Mon 00:30 IST next week is out
//   P4  centre scope on the Planning tab, one persona per BrowserContext on the screen
//   P5  the Excel download carries the same words and numbers
//   A1  recently approved: exact grouping and counts
//   A2  the N-day window: 6.9 days is in and 7.1 days is out at the default, ?days= is honoured
//   A3  the status filter: Pending and Rejected rows decided yesterday are NOT counted
//   A4  centre scope on the strip
//   A5  the stamp: a real write through the door stamps, an unchanged re-write does not refresh it
//   A6  the native-driver door (api/admin/avpl-rebase -> upsertLocationTargetNative) moves the stamp by the SAME rule (QA-2866)
//   P3b the exact week boundaries: a batch starting exactly Monday 00:00 IST is IN, exactly next Monday 00:00 IST is OUT (QA-2867)
//   S   the real screens, in Chromium
//
// Every identity is derived from the run stamp. The shared wall DB holds other suites' batches, so the
// EXACT numbers are asserted through scoped personas (Location A, Location B, Enrollment [A,B]) whose
// scope contains only this run's centres; Admin and Operations get invariant checks only.
import { chromium } from "playwright";
import * as XLSX from "xlsx";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ok as okLib, req, login, adminLogin, finish as finishLib, stamp, phone, today, BASE, ADMIN_PASSWORD } from "./e2e-lib.mjs";

const results = [];
const ok = (n, c, x = "") => { results.push({ name: n, pass: !!c, detail: String(x ?? "").replace(/\s+/g, " ").slice(0, 300) }); okLib(n, c, x); };
const pageErrors = [];
const finish = () => {
  const dir = process.env.MB1_BROWSER_REPORT;
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
      const failed = results.filter((r) => !r.pass).length;
      writeFileSync(path.join(dir, "report.json"), JSON.stringify({
        unit: "mtg-b1-planning-mobilised-and-recent-approvals", date: new Date().toISOString(), base: BASE, kind: "maker smoke, not validation",
        tz: process.env.TZ ?? null, total: results.length, passed: results.length - failed, failed,
        uncaughtPageErrors: pageErrors.length, pageErrors: pageErrors.slice(0, 10), results,
      }, null, 2));
    } catch { /* a convenience; the exit code still decides */ }
  }
  finishLib();
};
let browser = null;
const onFatal = async (e) => {
  ok("MB1: the suite ran to its end without an uncaught error", false, `ABORTED: ${String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 300)} - every arm after this point did not run`);
  try { if (browser) await browser.close(); } catch { /* nothing left */ }
  finish();
};
process.on("uncaughtException", onFatal);
process.on("unhandledRejection", onFatal);

const s = stamp("MB1");
const admin = await adminLogin();
const MURL = process.env.MONGODB_URL || process.env.MONGODB_URI;
if (!MURL) { ok("[precondition] MONGODB_URL is set", false, "refusing to guess a connection string"); finish(); }
const { MongoClient, ObjectId } = await import("mongodb");
const mc = new MongoClient(MURL, { serverSelectionTimeoutMS: 8000 });
await mc.connect();
const db = mc.db(process.env.MONGODB_DB);
if (!/^center_erp_ci/.test(db.databaseName)) { ok("[precondition] the database is a CI database", false, db.databaseName); finish(); }
const oid = (x) => new ObjectId(String(x));

// ---- the IST week, derived a DIFFERENT way from the product (Intl, not offset arithmetic) -------------
const istParts = (d) => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false })
  .formatToParts(d).map((p) => [p.type, p.value]));
const WD = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const weekStartMs = (() => {
  const p = istParts(new Date());
  const istMidnight = new Date(`${p.year}-${p.month}-${p.day}T00:00:00+05:30`).getTime();
  return istMidnight - WD[p.weekday] * 86_400_000;
})();
const WEEK_START = new Date(weekStartMs);
const WEEK_END = new Date(weekStartMs + 7 * 86_400_000);
const at = (ms) => new Date(ms);
const MIN = 60_000;

// ---- fixture: three centres (A, B for planning and approvals; H for the stamp arms) -------------------
const mkLoc = async (tag) => (await req(admin, "POST", "/api/locations", { code: tag + s, name: `TEST-MB1 ${tag} ${s}`, approval_status: "Approved", operational_status: "Active", city: "Jaipur" }, 201)).data.item;
const locA = await mkLoc("A");
const locB = await mkLoc("B");
const locH = await mkLoc("H");
const locE = await mkLoc("E");   // P3b: the exact week-boundary batches live alone at this centre, so no other arm's number moves
const locR = await mkLoc("R");   // A6: the native-driver rows
const mkProg = async (tag, name) => (await req(admin, "POST", "/api/programs", { code: `${tag}${s}`, name: name ?? `MB1 ${tag} ${s}`, trainer_skill: "MB1Skill" + s }, 201)).data.item;
const prog = await mkProg("PL");

// ---- planning batches ---------------------------------------------------------------------------------
// [tag, centre, start instant, status, target, mobilised]; created through the door, then the start and
// the status are pinned in Mongo so the boundary instants are EXACT whatever the creation rules say.
const BATCHES = [
  ["mon",   locA, WEEK_START.getTime() + 30 * MIN,                  "Planning", 20, 8],  // Mon 00:30 IST this week  -> IN
  ["sun",   locA, WEEK_END.getTime() - 30 * MIN,                    "Planning", 10, 3],  // Sun 23:30 IST this week  -> IN
  ["prev",  locA, WEEK_START.getTime() - 30 * MIN,                  "Planning", 15, 5],  // last Sun 23:30 IST       -> OUT
  ["next",  locA, WEEK_END.getTime() + 30 * MIN,                    "Planning", 5, 1],   // next Mon 00:30 IST       -> OUT
  ["over",  locA, WEEK_START.getTime() + 3 * 86_400_000 + 5 * 3_600_000, "Planning", 4, 6],  // over-filled, IN
  ["ready", locA, WEEK_START.getTime() + 2 * 86_400_000 + 5 * 3_600_000, "Ready", 8, 2],     // Ready is listed, IN
  ["act",   locA, WEEK_START.getTime() + 86_400_000 + 5 * 3_600_000,     "Active", 50, 2],   // started: not in the tab or the summary
  ["bin",   locB, WEEK_START.getTime() + 2 * 86_400_000 + 5 * 3_600_000, "Planning", 30, 10], // centre B, IN
  ["bout",  locB, WEEK_END.getTime() + 2 * 86_400_000,              "Planning", 12, 0],  // centre B, next week, OUT
];
const fx = {};
for (const [tag, loc, startMs, status, target, mob] of BATCHES) {
  const r = await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: today(), target_size: target });
  if (r.status !== 201) { ok(`[precondition] batch ${tag} created`, false, JSON.stringify(r.data).slice(0, 160)); continue; }
  const b = r.data.item;
  await db.collection("batches").updateOne({ _id: oid(b._id) }, { $set: { planned_start: at(startMs), status, target_size: target } });
  if (mob) await db.collection("batchmembers").insertMany(Array.from({ length: mob }, () => ({
    batch: oid(b._id), candidate: new ObjectId(), joined_on: new Date(), left_on: null, enrollment_status: "Not Started", createdAt: new Date(), updatedAt: new Date() })));
  fx[tag] = { id: String(b._id), code: b.code, loc, target, mob, gap: Math.max(0, target - mob), status };
}
// a member who LEFT must not count as mobilised
if (fx.mon) await db.collection("batchmembers").insertOne({ batch: oid(fx.mon.id), candidate: new ObjectId(), joined_on: new Date(), left_on: new Date(), enrollment_status: "Not Started", createdAt: new Date(), updatedAt: new Date() });
ok("[precondition] all nine planning fixtures exist", Object.keys(fx).length === BATCHES.length, Object.keys(fx).join(","));

// ---- approvals ---------------------------------------------------------------------------------------
const DAY = 86_400_000;
const nowMs = Date.now();
const roleX = `MB1 Role X ${s}`;
const roleY = `MB1 Role Y ${s}`;
const PX1 = await mkProg("X1", roleX), PX2 = await mkProg("X2", roleX); // two programmes, ONE job role name
const PY = await mkProg("Y", roleY);
const PPEND = await mkProg("PE"), PREJ = await mkProg("RJ"), PUND = await mkProg("UD"), PBX = await mkProg("BX", roleX);
const putT = (loc, p, body) => req(admin, "PUT", `/api/locations/${loc._id}/targets`, { program: p._id, ...body });
const setStamp = (loc, p, ms) => db.collection("locationtargets").updateOne({ location: oid(loc._id), program: oid(p._id) }, ms == null ? { $unset: { tc_status_changed_at: 1 } } : { $set: { tc_status_changed_at: at(ms) } });
const rowsPut = [
  [locA, PX1, { approved_target: 100, tc_status: "Approved" },   nowMs - 2 * DAY],            // IN  (role X)
  [locA, PX2, { approved_target: 30,  tc_status: " approved " }, nowMs - 3 * DAY],            // IN  (role X, odd spelling: tcVerdict trims)
  [locA, PY,  { approved_target: 40,  tc_status: "Approved" },   nowMs - (7 * DAY + 2 * 3_600_000)], // OUT at 7 days (7.08d), IN at 8
  [locA, PPEND, { approved_target: 25, tc_status: "Pending" },   nowMs - 1 * DAY],            // not approved
  [locA, PREJ,  { approved_target: 15, tc_status: "Rejected" },  nowMs - 1 * DAY],            // not approved
  [locA, PUND,  { approved_target: 12, tc_status: "Approved" },  null],                       // approved, no date
  [locB, PBX, { approved_target: 60, tc_status: "Approved" },    nowMs - 1 * DAY],            // centre B
];
for (const [loc, p, body, ms] of rowsPut) {
  const r = await putT(loc, p, body);
  if (r.status !== 200) ok(`[precondition] target ${p.code} written`, false, JSON.stringify(r.data).slice(0, 160));
  await setStamp(loc, p, ms);
}
// the (6.9 day) inside edge is its own row so the 7.08-day row above is the outside edge
const PEDGE = await mkProg("ED", roleY);
await putT(locA, PEDGE, { approved_target: 7, tc_status: "Approved" });
await setStamp(locA, PEDGE, nowMs - (6 * DAY + 22 * 3_600_000));                              // 6.92 days: IN

// ---- personas ----------------------------------------------------------------------------------------
const PW = "Mb1Persona9!x";
const mkUser = async (role, scope, tag) => {
  const email = `zzcheck.mb1${tag}.${s.toLowerCase()}@vidysea-test.local`;
  const r = await req(admin, "POST", "/api/users", { name: `ZZ MB1 ${tag}`, email, password: PW, role, location_scope: scope, can_edit: true });
  return { email, cookie: r.status === 201 ? await login(email, PW) : null, status: r.status };
};
const uA = await mkUser("Location", [locA._id], "a");
const uB = await mkUser("Location", [locB._id], "b");
const uAB = await mkUser("Enrollment", [locA._id, locB._id], "ab");
const uE = await mkUser("Location", [locE._id], "e");
const uOps = await mkUser("Operations", [], "ops");
ok("[precondition] personas (Location A, Location B, Enrollment A+B, Operations) can log in", !!(uA.cookie && uB.cookie && uAB.cookie && uOps.cookie),
  JSON.stringify({ a: uA.status, b: uB.status, ab: uAB.status, ops: uOps.status }));

const track = async (cookie) => (await req(cookie, "GET", "/api/plan-tracker")).data;
const recent = async (cookie, qs = "") => (await req(cookie, "GET", "/api/reports/recently-approved" + qs)).data;
const codes = (rows) => (rows ?? []).map((r) => r.batch?.code);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// =================================================================================================
// P1 / P2 / P3 - the numbers
// =================================================================================================
const tA = await track(uA.cookie);
const rowOf = (t, tag) => (t.rows ?? []).find((r) => r.batch?.code === fx[tag]?.code);
for (const tag of ["mon", "sun", "prev", "next", "over", "ready"]) {
  const r = rowOf(tA, tag);
  ok(`P1: ${tag} batch row reads Target ${fx[tag]?.target} / Mobilised ${fx[tag]?.mob} / Gap ${fx[tag]?.gap}`,
    !!r && r.target === fx[tag].target && r.mobilised === fx[tag].mob && r.gap === fx[tag].gap,
    r ? JSON.stringify({ t: r.target, m: r.mobilised, g: r.gap }) : "row missing");
}
ok("P1: a member who has LEFT the batch is not counted as mobilised (mon is 8, not 9)", rowOf(tA, "mon")?.mobilised === 8, String(rowOf(tA, "mon")?.mobilised));
ok("P1: an over-filled batch (target 4, mobilised 6) has Gap 0 - never negative", rowOf(tA, "over")?.gap === 0 && rowOf(tA, "over")?.mobilised === 6, JSON.stringify(rowOf(tA, "over")));
ok("P1: Mobilised on the new field is the same number as mobilization.count on the row",
  ["mon", "sun", "over"].every((t) => rowOf(tA, t)?.mobilised === rowOf(tA, t)?.mobilization?.count), "");

const sA = tA.summary;
ok("P2: summary lists the Planning-tab statuses [Planning, Ready]", eq(sA?.statuses, ["Planning", "Ready"]), JSON.stringify(sA?.statuses));
ok("P2: total over the listed batches = 6 batches, target 62, mobilised 25, gap 39 (the Active batch is not in it)",
  sA?.total?.batches === 6 && sA.total.target === 62 && sA.total.mobilised === 25 && sA.total.gap === 39, JSON.stringify(sA?.total));
ok("P2: total gap is the SUM of the row gaps (39), not target minus mobilised (37): an over-filled batch does not cancel a shortfall",
  sA?.total?.gap === 39 && sA?.total?.gap !== sA?.total?.target - sA?.total?.mobilised, JSON.stringify(sA?.total));
ok("P2: the Active batch is still a row (the Excel carries it) but its 50 seats are in no summary figure",
  !!rowOf(tA, "act") && sA?.total?.target === 62, "");

ok("P3: week.start is Monday 00:00 IST of the current week", sA?.week?.start === WEEK_START.toISOString(), `${sA?.week?.start} vs ${WEEK_START.toISOString()}`);
ok("P3: week.end is the next Monday 00:00 IST", sA?.week?.end === WEEK_END.toISOString(), `${sA?.week?.end} vs ${WEEK_END.toISOString()}`);
ok("P3: starting this week = 4 batches (Mon 00:30 IST, Sun 23:30 IST, Thursday over-filled, Ready) - not last Sunday 23:30 IST, not next Monday 00:30 IST",
  sA?.this_week?.batches === 4 && sA.this_week.target === 42 && sA.this_week.mobilised === 19 && sA.this_week.gap === 25, JSON.stringify(sA?.this_week));

// =================================================================================================
// P3b - the EXACT week boundaries (QA-2867). Monday 00:30 and Sunday 23:30 never touch the edge itself, so
// a `ps <= end` mutant survived every arm above. Two batches at a centre of their own, planned_start set in
// Mongo to the exact instants: this Monday 00:00 IST (inclusive, IN) and next Monday 00:00 IST (exclusive, OUT).
// =================================================================================================
const edgeBatch = async (tag, startMs, target) => {
  const r = await req(admin, "POST", "/api/batches", { location: locE._id, program: prog._id, planned_start: today(), target_size: target });
  if (r.status !== 201) { ok(`[precondition] boundary batch ${tag} created`, false, JSON.stringify(r.data).slice(0, 160)); return null; }
  await db.collection("batches").updateOne({ _id: oid(r.data.item._id) }, { $set: { planned_start: at(startMs), status: "Planning", target_size: target } });
  return r.data.item;
};
const eStart = await edgeBatch("edge-start", WEEK_START.getTime(), 7);
const eEnd = await edgeBatch("edge-end", WEEK_END.getTime(), 9);
const tE = await track(uE.cookie);
ok("P3b: a batch starting EXACTLY at this Monday 00:00 IST is in this week (inclusive start): this_week = 1 batch, target 7",
  tE.summary?.this_week?.batches === 1 && tE.summary.this_week.target === 7, JSON.stringify(tE.summary?.this_week));
ok("P3b: a batch starting EXACTLY at next Monday 00:00 IST is NOT this week (exclusive end): it is in total (2 batches, target 16) but not in this_week",
  tE.summary?.total?.batches === 2 && tE.summary.total.target === 16 && tE.summary.this_week?.batches === 1 && tE.summary.this_week.target !== 16,
  JSON.stringify({ total: tE.summary?.total, wk: tE.summary?.this_week, ids: [eStart?._id, eEnd?._id] }));

// =================================================================================================
// P4 - scope on the Planning tab
// =================================================================================================
const tB = await track(uB.cookie);
const tAB = await track(uAB.cookie);
const aCodes = ["mon", "sun", "prev", "next", "over", "ready", "act"].map((t) => fx[t]?.code);
const bCodes = ["bin", "bout"].map((t) => fx[t]?.code);
ok("P4: Location A sees every centre-A batch and no centre-B batch", aCodes.every((c) => codes(tA.rows).includes(c)) && !bCodes.some((c) => codes(tA.rows).includes(c)), codes(tA.rows).join(","));
ok("P4: Location B sees only its own two batches", eq([...codes(tB.rows)].sort(), [...bCodes].sort()), codes(tB.rows).join(","));
ok("P4: Location B summary = 2 batches, target 42, mobilised 10, gap 32; this week 1 / 30 / 10 / 20",
  tB.summary?.total?.batches === 2 && tB.summary.total.target === 42 && tB.summary.total.mobilised === 10 && tB.summary.total.gap === 32
  && tB.summary.this_week.batches === 1 && tB.summary.this_week.target === 30 && tB.summary.this_week.mobilised === 10 && tB.summary.this_week.gap === 20, JSON.stringify(tB.summary));
ok("P4: Enrollment scoped to A+B = A and B added: 8 batches, target 104, mobilised 35, gap 71; this week 5 / 72 / 29 / 45",
  tAB.summary?.total?.batches === 8 && tAB.summary.total.target === 104 && tAB.summary.total.mobilised === 35 && tAB.summary.total.gap === 71
  && tAB.summary.this_week.batches === 5 && tAB.summary.this_week.target === 72 && tAB.summary.this_week.mobilised === 29 && tAB.summary.this_week.gap === 45, JSON.stringify(tAB.summary));
const tOps = await track(uOps.cookie), tAdm = await track(admin);
ok("P4: Operations and Admin (not centre-scoped) see both centres' fixtures and a summary at least as large as the fixtures",
  [tOps, tAdm].every((t) => [...aCodes, ...bCodes].every((c) => codes(t.rows).includes(c)) && t.summary?.total?.target >= 104 && t.summary?.total?.mobilised >= 35), "");

// =================================================================================================
// P5 - the Excel download
// =================================================================================================
const xl = async (cookie) => {
  const res = await fetch(BASE + "/api/plan-tracker/export", { headers: { cookie } });
  const wb = XLSX.read(Buffer.from(await res.arrayBuffer()), { type: "buffer" });
  return { status: res.status, wb, planning: XLSX.utils.sheet_to_json(wb.Sheets["planning"] ?? {}, { defval: "" }), summary: XLSX.utils.sheet_to_json(wb.Sheets["summary"] ?? {}, { defval: "" }) };
};
const xA = await xl(uA.cookie);
const hdr = Object.keys(xA.planning[0] ?? {});
ok("P5: the download carries Target, Mobilised and Gap columns, and the old 'Mobilised count' name is gone", ["Target", "Mobilised", "Gap"].every((h) => hdr.includes(h)) && !hdr.includes("Mobilised count"), hdr.join("|"));
const xrow = (tag) => xA.planning.find((r) => r["Batch"] === fx[tag]?.code);
ok("P5: the file's numbers for mon and over equal the screen's (20/8/12 and 4/6/0)",
  xrow("mon")?.Target === 20 && xrow("mon")?.Mobilised === 8 && xrow("mon")?.Gap === 12 && xrow("over")?.Target === 4 && xrow("over")?.Mobilised === 6 && xrow("over")?.Gap === 0,
  JSON.stringify([xrow("mon"), xrow("over")].map((r) => r && [r.Target, r.Mobilised, r.Gap])));
const sumCell = (m, col) => xA.summary.find((r) => r.Measure === m)?.[col];
ok("P5: the file's summary sheet equals the screen's summary (target 62 / mobilised 25 / gap 39; this week 42 / 19 / 25)",
  sumCell("Target", "All planned") === 62 && sumCell("Mobilised", "All planned") === 25 && sumCell("Gap", "All planned") === 39
  && sumCell("Target", "Starting this week (IST)") === 42 && sumCell("Mobilised", "Starting this week (IST)") === 19 && sumCell("Gap", "Starting this week (IST)") === 25,
  JSON.stringify(xA.summary));
ok("P5: Location A's file holds no centre-B batch", !bCodes.some((c) => xA.planning.some((r) => r["Batch"] === c)), "");

// =================================================================================================
// A1..A4 - recently approved
// =================================================================================================
const rA = await recent(uA.cookie);
const grp = (r, role) => (r?.rows ?? []).find((x) => x.job_role === role);
ok("A1: Location A, default window: exactly two job-role groups (role X and role Y)", (rA.rows ?? []).length === 2 && !!grp(rA, roleX) && !!grp(rA, roleY), JSON.stringify((rA.rows ?? []).map((r) => [r.job_role, r.count])));
ok("A1: two programmes of ONE job role at ONE centre make ONE group with count 2 and seats 130 (100 + 30, ' approved ' spelling counted)",
  grp(rA, roleX)?.count === 2 && grp(rA, roleX)?.seats === 130, JSON.stringify(grp(rA, roleX)));
ok("A1: role Y shows only the 6.92-day-old row: count 1, seats 7", grp(rA, roleY)?.count === 1 && grp(rA, roleY)?.seats === 7, JSON.stringify(grp(rA, roleY)));
ok("A1: total = 2 groups, 3 approvals, 137 seats", rA.total?.rows === 2 && rA.total?.count === 3 && rA.total?.seats === 137, JSON.stringify(rA.total));
ok("A1: the response names the window: days 7, and a `since` 7 days before measured_at",
  rA.days === 7 && Math.abs(new Date(rA.measured_at) - new Date(rA.since) - 7 * DAY) < 5000, JSON.stringify({ d: rA.days, since: rA.since, at: rA.measured_at }));

ok("A2: a row approved 6.92 days ago is inside the 7-day window and one approved 7.08 days ago is outside (role Y count is 1, not 2)", grp(rA, roleY)?.count === 1, JSON.stringify(grp(rA, roleY)));
const r8 = await recent(uA.cookie, "?days=8");
ok("A2: ?days=8 brings the 7.08-day row in (role Y count 2, seats 47; total 4 approvals)", grp(r8, roleY)?.count === 2 && grp(r8, roleY)?.seats === 47 && r8.total?.count === 4 && r8.days === 8, JSON.stringify([r8.days, grp(r8, roleY), r8.total]));
const r1 = await recent(uA.cookie, "?days=1");
ok("A2: ?days=1 leaves nothing (the newest approved row is 2 days old)", r1.days === 1 && (r1.rows ?? []).length === 0 && r1.total?.count === 0, JSON.stringify([r1.days, r1.total]));
for (const bad of ["abc", "0", "-3", ""]) {
  const rb = await recent(uA.cookie, bad === "" ? "" : `?days=${bad}`);
  ok(`A2: ?days=${bad || "(none)"} falls back to 7 and does not fail`, rb.days === 7 && rb.total?.count === 3, JSON.stringify([rb.days, rb.total]));
}
const rBig = await recent(uA.cookie, "?days=99999");
ok("A2: an absurd ?days is capped at 90", rBig.days === 90, String(rBig.days));

const r30 = await recent(uA.cookie, "?days=30");
ok("A3: Pending and Rejected rows decided yesterday are not counted, even in a 30-day window (4 approvals: X1, X2, the 6.92-day and the 7.08-day row)",
  r30.total?.count === 4 && !(r30.rows ?? []).some((r) => /MB1 (PE|RJ) /.test(r.job_role)), JSON.stringify([r30.total, (r30.rows ?? []).map((r) => r.job_role)]));
ok("A3: an Approved row with no date is not counted, and is disclosed (undated_approved = 1)", rA.undated_approved === 1, String(rA.undated_approved));

const rB = await recent(uB.cookie);
ok("A4: Location B sees only centre B: one group, role X, count 1, seats 60", (rB.rows ?? []).length === 1 && rB.rows[0].location.name === locB.name && rB.rows[0].job_role === roleX && rB.rows[0].count === 1 && rB.rows[0].seats === 60, JSON.stringify(rB.rows));
ok("A4: Location A's strip names no centre-B row, and B's names no centre-A row",
  !(rA.rows ?? []).some((r) => r.location._id === locB._id) && !(rB.rows ?? []).some((r) => r.location._id === locA._id), "");
ok("A4: Location B's undated count is 0 (A's undated row is not B's business)", rB.undated_approved === 0, String(rB.undated_approved));
const rAB = await recent(uAB.cookie);
ok("A4: Enrollment scoped to A+B sees both: 3 groups, 4 approvals, 197 seats", (rAB.rows ?? []).length === 3 && rAB.total?.count === 4 && rAB.total?.seats === 197, JSON.stringify(rAB.total));
const rOps = await recent(uOps.cookie), rAdm = await recent(admin);
ok("A4: Operations and Admin (not centre-scoped) see both centres' groups", [rOps, rAdm].every((r) => (r.rows ?? []).some((x) => x.location._id === locA._id) && (r.rows ?? []).some((x) => x.location._id === locB._id)), "");

// =================================================================================================
// A5 - the stamp, through the REAL door
// =================================================================================================
const PH = await mkProg("HK");
const h = async () => ((await recent(admin, "?days=7")).rows ?? []).filter((r) => r.location._id === locH._id);
ok("A5: nothing at the stamp centre before any write", (await h()).length === 0, "");
await putT(locH, PH, { approved_target: 50, tc_status: "Approved" });
ok("A5: a NEW row written as Approved through PUT /targets is stamped now and appears (count 1, seats 50)", (await h()).length === 1 && (await h())[0].count === 1 && (await h())[0].seats === 50, JSON.stringify(await h()));
await setStamp(locH, PH, nowMs - 30 * DAY);
ok("A5: (setup) with the stamp moved 30 days back it drops out of the 7-day window", (await h()).length === 0, "");
await putT(locH, PH, { approved_target: 55, tc_status: "approved " });
ok("A5: re-writing the SAME status (different spelling, other field changed) does NOT refresh the stamp - an old approval does not look new", (await h()).length === 0, JSON.stringify(await h()));
await putT(locH, PH, { tc_status: "Pending" });
ok("A5: moving it to Pending - not counted", (await h()).length === 0, "");
await putT(locH, PH, { tc_status: "Approved" });
ok("A5: Pending -> Approved is a new approval: stamped now, appears (count 1, seats 55)", (await h()).length === 1 && (await h())[0].seats === 55, JSON.stringify(await h()));
const doc = await db.collection("locationtargets").findOne({ location: oid(locH._id), program: oid(PH._id) });
ok("A5: tc_status_changed_at is a Date within the last minute", doc?.tc_status_changed_at instanceof Date && Date.now() - doc.tc_status_changed_at.getTime() < 60_000, String(doc?.tc_status_changed_at));

// =================================================================================================
// A6 - the native-driver door (QA-2866). api/admin/avpl-rebase cannot be driven offline (it fetches a
// hardcoded OneDrive workbook, and the outbound-fetch guard refuses loopback), so the REAL function it calls
// for every target, upsertLocationTargetNative in src/models/index.ts, is loaded with jiti against this same
// CI database, and a source pin below proves the route still goes through it and has no write of its own.
// Each effect is read back through the strip's own API, and the stored stamp.
// =================================================================================================
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const jm = createRequire(import.meta.url)(path.join(root, "node_modules/jiti"));
const M = (jm.createJiti ?? jm)(path.join(here, "e2e-planning-and-approved.mjs"), { interopDefault: true })(path.join(root, "src/models/index.ts"));
const mg = createRequire(import.meta.url)(path.join(root, "node_modules/mongoose"));
await mg.connect(MURL, { dbName: process.env.MONGODB_DB });
const nativeWrite = (loc, p, fields) => M.upsertLocationTargetNative(
  { location: new mg.Types.ObjectId(String(loc._id)), program: new mg.Types.ObjectId(String(p._id)) },
  { location: new mg.Types.ObjectId(String(loc._id)), program: new mg.Types.ObjectId(String(p._id)), reported_at: new Date(), updatedAt: new Date(), ...fields },
  { createdAt: new Date() });
const rDoc = (p) => db.collection("locationtargets").findOne({ location: oid(locR._id), program: oid(p._id) });
const rStrip = async () => ((await recent(admin, "?days=7")).rows ?? []).filter((r) => r.location._id === locR._id);
const fresh = (d) => d?.tc_status_changed_at instanceof Date && Date.now() - d.tc_status_changed_at.getTime() < 60_000;

const R1 = await mkProg("N1", `MB1 N1 ${s}`), R2 = await mkProg("N2", `MB1 N2 ${s}`), R3 = await mkProg("N3", `MB1 N3 ${s}`), R4 = await mkProg("N4", `MB1 N4 ${s}`);
ok("A6: (setup) the centre has nothing in the strip before the native writes", (await rStrip()).length === 0, "");
// R1: a row that ALREADY carries a stamp (Pending, 30 days old), flipped to Approved by the native door
await putT(locR, R1, { approved_target: 20, tc_status: "Pending" });
await db.collection("locationtargets").updateOne({ location: oid(locR._id), program: oid(R1._id) }, { $set: { tc_status_changed_at: at(nowMs - 30 * DAY) } });
const r1Before = (await rDoc(R1))?.tc_status_changed_at?.getTime();
await nativeWrite(locR, R1, { approved_target: 20, tc_status: "Approved" });
const r1Doc = await rDoc(R1);
ok("A6: a previously STAMPED row (Pending, 30 days old) flipped to Approved by the native door has its stamp MOVED to now (QA-2866)",
  fresh(r1Doc) && r1Doc.tc_status_changed_at.getTime() > r1Before && r1Doc.tc_status === "Approved", JSON.stringify({ before: r1Before, after: r1Doc?.tc_status_changed_at, st: r1Doc?.tc_status }));
ok("A6: ...and that row now lists as recently approved (a stale stamp would have dated it 30 days ago)", (await rStrip()).some((r) => r.job_role === `MB1 N1 ${s}` && r.count === 1 && r.seats === 20), JSON.stringify(await rStrip()));
// R2: already Approved and stamped 30 days ago, the native door re-writes the SAME status (other spelling, other field)
await putT(locR, R2, { approved_target: 30, tc_status: "Approved" });
await db.collection("locationtargets").updateOne({ location: oid(locR._id), program: oid(R2._id) }, { $set: { tc_status_changed_at: at(nowMs - 30 * DAY) } });
await nativeWrite(locR, R2, { approved_target: 35, tc_status: " approved " });
const r2Doc = await rDoc(R2);
ok("A6: an UNCHANGED status re-written by the native door (other spelling, other field changed) does NOT refresh the stamp - an old approval does not look new",
  r2Doc?.approved_target === 35 && Math.abs(r2Doc.tc_status_changed_at.getTime() - (nowMs - 30 * DAY)) < 1000 && !(await rStrip()).some((r) => r.job_role === `MB1 N2 ${s}`), JSON.stringify({ at: r2Doc?.tc_status_changed_at, t: r2Doc?.approved_target }));
// R3: a NEW row inserted by the native door as Approved is stamped (it is a change from blank)
await nativeWrite(locR, R3, { approved_target: 40, tc_status: "Approved" });
ok("A6: a NEW row the native door inserts as Approved is stamped now and appears (count 1, seats 40)",
  fresh(await rDoc(R3)) && (await rStrip()).some((r) => r.job_role === `MB1 N3 ${s}` && r.count === 1 && r.seats === 40), JSON.stringify(await rDoc(R3)));
// R4: a native write that does not carry tc_status leaves the stamp alone
await putT(locR, R4, { approved_target: 10, tc_status: "Approved" });
await db.collection("locationtargets").updateOne({ location: oid(locR._id), program: oid(R4._id) }, { $set: { tc_status_changed_at: at(nowMs - 30 * DAY) } });
await nativeWrite(locR, R4, { approved_target: 12 });
const r4Doc = await rDoc(R4);
ok("A6: a native write with no tc_status in it leaves the stamp alone", r4Doc?.approved_target === 12 && r4Doc.tc_status === "Approved" && Math.abs(r4Doc.tc_status_changed_at.getTime() - (nowMs - 30 * DAY)) < 1000, JSON.stringify({ at: r4Doc?.tc_status_changed_at }));
await mg.disconnect();
// the route must still go through that function and carry no write of its own
const routeSrc = readFileSync(path.join(root, "src/app/api/admin/avpl-rebase/route.ts"), "utf8");
ok("A6: api/admin/avpl-rebase writes LocationTargets only through upsertLocationTargetNative (no raw locationtargets collection call left in the route)",
  /upsertLocationTargetNative\(/.test(routeSrc) && !/collection\(\s*["']locationtargets["']\s*\)/.test(routeSrc), "");

// =================================================================================================
// S - the real screens
// =================================================================================================
try { browser = await chromium.launch({ headless: true }); }
catch (e) { ok("[precondition] chromium launches from the `playwright` devDependency", false, String(e.message).slice(0, 200)); finish(); }
const newPage = async (email, password) => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });   // one context per persona
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

await arm("S1 planning screen (Location A)", async () => {
  const { ctx, page } = await newPage(uA.email, PW);
  await page.goto(`${BASE}/batches?tab=Planning`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="plan-summary"]').waitFor();
  const got = { week: await txt(page, "plan-sum-week"), target: await txt(page, "plan-sum-target"), mobilised: await txt(page, "plan-sum-mobilised"), gap: await txt(page, "plan-sum-gap") };
  ok("S1: the tiles read 4 starting this week, total target 62, mobilised 25, gap 39", got.week === "4" && got.target === "62" && got.mobilised === "25" && got.gap === "39", JSON.stringify(got));
  const headers = (await page.locator("table thead th, [role=columnheader]").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  ok("S1: the table has Target, Mobilised and Gap column headings", ["target", "mobilised", "gap"].every((h) => headers.some((x) => x.toLowerCase().startsWith(h))), headers.join(" | "));
  const rowFor = (code) => page.locator(`tr:has-text("${code}")`).first();
  const cells = async (code) => ({ t: await rowFor(code).locator('[data-testid="plan-target"]').innerText(), m: await rowFor(code).locator('[data-testid="plan-mobilised"]').innerText(), g: await rowFor(code).locator('[data-testid="plan-gap"]').innerText() });
  const cm = await cells(fx.mon.code), co = await cells(fx.over.code);
  ok("S1: the mon batch row shows 20 / 8 / 12 and the over-filled batch 4 / 6 / 0", cm.t === "20" && cm.m === "8" && cm.g === "12" && co.t === "4" && co.m === "6" && co.g === "0", JSON.stringify([cm, co]));
  ok("S1: the Active batch is not listed on the tab (it moved to Batches)", (await page.locator(`tr:has-text("${fx.act.code}")`).count()) === 0, "");
  ok("S1: no centre-B batch is on Location A's screen", (await page.locator(`text=${fx.bin.code}`).count()) === 0, "");
  await ctx.close();
});
await arm("S2 planning screen (Location B, its own context)", async () => {
  const { ctx, page } = await newPage(uB.email, PW);
  await page.goto(`${BASE}/batches?tab=Planning`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="plan-summary"]').waitFor();
  const got = [await txt(page, "plan-sum-week"), await txt(page, "plan-sum-target"), await txt(page, "plan-sum-mobilised"), await txt(page, "plan-sum-gap")];
  ok("S2: Location B's tiles read 1 / 42 / 10 / 32 and none of centre A's batches is listed", eq(got, ["1", "42", "10", "32"]) && (await page.locator(`text=${fx.mon.code}`).count()) === 0, JSON.stringify(got));
  await ctx.close();
});
await arm("S3 reports screen (Location A)", async () => {
  const { ctx, page } = await newPage(uA.email, PW);
  await page.goto(`${BASE}/reports`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="recent-approved"]').waitFor();
  await page.locator('[data-testid="recent-row"]').first().waitFor();
  const rowsTxt = (await page.locator('[data-testid="recent-row"]').allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
  ok("S3: the strip shows 2 cards - role X with 2 approved and role Y with 1 approved - and nothing from centre B",
    rowsTxt.length === 2 && rowsTxt.some((t) => t.includes(roleX) && /\b2 approved/.test(t) && t.includes("130 seats")) && rowsTxt.some((t) => t.includes(roleY) && /\b1 approved/.test(t)) && !rowsTxt.some((t) => t.includes(locB.name)), rowsTxt.join(" || "));
  ok("S3: the strip's total line reads 3 approvals - 137 seats", /3 approvals\s*·\s*137 seats/.test(await txt(page, "recent-total")), await txt(page, "recent-total"));
  ok("S3: the undated row is disclosed in words", /no approval date/i.test(await page.locator('[data-testid="recent-approved"]').innerText()), "");
  await page.locator('[data-testid="recent-days"]').selectOption("14");
  await page.waitForFunction(() => /4 approvals/.test(document.querySelector('[data-testid="recent-total"]')?.textContent ?? ""), null, { timeout: 15000 });
  ok("S3: switching the window to 14 days brings the 7.08-day row in (4 approvals)", /4 approvals/.test(await txt(page, "recent-total")), await txt(page, "recent-total"));
  await ctx.close();
});

await browser.close();
await mc.close();
finish();
