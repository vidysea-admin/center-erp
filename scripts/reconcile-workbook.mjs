// Manish sir's developer note #8: "Totals in the ERP must match the existing costing workbook to
// the rupee." This loads his workbook's own 18 cost entries and 10 heads into an isolated database,
// runs the SAME `costRollup` the screen and the .xlsx read, and compares every figure against the
// numbers his own report tabs compute.
//
// Sheet: 1WxkHGC0ElAeK4Yw2OI0T3T8dqjE6C0vu, read 2026-09-06.
//
// NOT part of `npm test`, deliberately: it WIPES `costentries` and `costcategories` so the ledger
// contains his 18 rows and nothing else, which would destroy every other suite's fixtures. Run it
// on its own, against a throwaway database:
//
//   MONGODB_URL=... MONGODB_DB=... BASE_URL=http://localhost:PORT/erp //     ADMIN_PASSWORD=admin123 node scripts/reconcile-workbook.mjs
//
// Result on 2026-09-06 at `adf9195`: 32 passed, 0 failed.
//
// THE ONE PLACE WE DIFFER, AND IT IS DELIBERATE: his "Report - Job Role Wise" tab totals 72,585,
// not 76,385, because it has no Unassigned row and the two untagged entries (1,600 travel + 2,200
// miscellaneous) fall out of it entirely. His own developer note #5 asks for the opposite - "those
// rows land in the Unassigned bucket so the grand total always ties to the register" - so ours puts
// them there and ties. Every one of his three job-role figures matches ours exactly; the difference
// is only the rows his tab drops.
// The models are TypeScript, so this talks to mongo with the plain driver and then reads the
// numbers back through the RUNNING SERVER's `/api/reports/costs` — which is the real `costRollup`,
// behind the real finance door. Reconciling against the function in isolation would prove less.
import { MongoClient, ObjectId } from "mongodb";
// QA-510, and it caught THIS script on its first wall: a tool that deletes must ask the guard
// before it touches a database. This one wipes `costentries` and `costcategories` so the ledger
// holds the workbook's 18 rows and nothing else - pointed at `center_erp` by a forgotten
// `--env-file`, that is the production cost ledger, erased. `requireSafeDb` refuses the production
// name unless somebody says it out loud.
import { requireSafeDb } from "./db-guard.mjs";

const HEADS = [
  ["CH01", "Trainer Eligibility Fee"], ["CH02", "TOT Fee"], ["CH03", "Material & Consumables"],
  ["CH04", "Equipment & Tools"], ["CH05", "Trainee Kit"], ["CH06", "Travel & Conveyance"],
  ["CH07", "Venue & Infrastructure"], ["CH08", "Certification & Assessment Fee"],
  ["CH09", "Marketing & Mobilisation"], ["CH10", "Miscellaneous"],
];
const LOCS = [
  ["SIRSA", "AVPL Drone Repair Centre, JCDM College of Engineering, Sirsa"],
  ["SONIPAT", "AVPL Drone Repair Centre, Puran Murti Education Society, Sonipat"],
  ["CHAYAL", "Govt. ITI, Chayal, Kausambi"],
  ["MADIHAN", "Govt. ITI, Madihan, Mirzapur"],
];
const ROLES = [["BRT", "Battery Repair Technician"], ["DST", "Drone Service Technician"], ["SPI", "Solar Panel Installation"]];
const BATCHES = [
  ["CHK1286 Program 4", "SONIPAT", "DST", "2026-07-12", 30],
  ["BSR-Trg-02", "CHAYAL", "BRT", "2026-08-18", 25],
  ["SPT-Trg-01", "MADIHAN", "SPI", "2026-08-05", 28],
  ["DRC-Sirsa-01", "SIRSA", "DST", "2026-08-22", 30],
];
const TRAINERS = ["Prashant Kumar", "Priyanka Kumari", "Manoj Kumar Srivastava", "Suresh Chandra", "Rekha Devi"];
// date, locationCode|null, batchName|null, trainer|null, head, amount
const ENTRIES = [
  ["2026-07-15", "SIRSA", "DRC-Sirsa-01", "Prashant Kumar", "Trainer Eligibility Fee", 3250],
  ["2026-07-20", "SIRSA", "DRC-Sirsa-01", null, "Material & Consumables", 6200],
  ["2026-07-28", "SIRSA", "DRC-Sirsa-01", null, "Equipment & Tools", 9400],
  ["2026-08-02", "SIRSA", "DRC-Sirsa-01", "Priyanka Kumari", "Travel & Conveyance", 2100],
  ["2026-08-10", "SIRSA", "DRC-Sirsa-01", null, "Trainee Kit", 3600],
  ["2026-08-18", "CHAYAL", "BSR-Trg-02", "Manoj Kumar Srivastava", "Trainer Eligibility Fee", 3250],
  ["2026-08-19", "CHAYAL", "BSR-Trg-02", null, "Material & Consumables", 4575],
  ["2026-08-21", "CHAYAL", "BSR-Trg-02", null, "Venue & Infrastructure", 5200],
  ["2026-08-25", "CHAYAL", "BSR-Trg-02", "Manoj Kumar Srivastava", "Travel & Conveyance", 1800],
  ["2026-08-05", "MADIHAN", "SPT-Trg-01", "Suresh Chandra", "Trainer Eligibility Fee", 3250],
  ["2026-08-12", "MADIHAN", "SPT-Trg-01", null, "Equipment & Tools", 8900],
  ["2026-08-15", "MADIHAN", "SPT-Trg-01", null, "Trainee Kit", 3360],
  ["2026-08-28", "MADIHAN", "SPT-Trg-01", "Suresh Chandra", "Certification & Assessment Fee", 4200],
  ["2026-08-22", "SONIPAT", "CHK1286 Program 4", "Rekha Devi", "TOT Fee", 4500],
  ["2026-08-30", "SONIPAT", "CHK1286 Program 4", null, "Material & Consumables", 5100],
  ["2026-09-01", "SONIPAT", "CHK1286 Program 4", null, "Marketing & Mobilisation", 3900],
  ["2026-07-10", null, null, "Prashant Kumar", "Travel & Conveyance", 1600],
  ["2026-08-03", null, null, null, "Miscellaneous", 2200],
];

// ---- his own report tabs, transcribed verbatim
const EXPECT = {
  grand: 76385,
  entries: 18,
  byHead: { "Trainer Eligibility Fee": 9750, "TOT Fee": 4500, "Material & Consumables": 15875,
    "Equipment & Tools": 18300, "Trainee Kit": 6960, "Travel & Conveyance": 5500,
    "Venue & Infrastructure": 5200, "Certification & Assessment Fee": 4200,
    "Marketing & Mobilisation": 3900, "Miscellaneous": 2200 },
  byBatch: { "CHK1286 Program 4": 13500, "BSR-Trg-02": 14825, "SPT-Trg-01": 19710,
    "DRC-Sirsa-01": 24550, "Unassigned": 3800 },
  byLocation: { "AVPL Drone Repair Centre, JCDM College of Engineering, Sirsa": 24550,
    "AVPL Drone Repair Centre, Puran Murti Education Society, Sonipat": 13500,
    "Govt. ITI, Chayal, Kausambi": 14825, "Govt. ITI, Madihan, Mirzapur": 19710,
    "Unassigned": 3800 },
  byMonth: { "2026-07": 20450, "2026-08": 52035, "2026-09": 3900 },
  // His job-role tab totals 72,585 - NOT 76,385. It has no Unassigned row, so the two untagged
  // entries (1,600 travel + 2,200 misc) fall out of it entirely. Recorded as HIS figure; ours is
  // expected to differ by exactly that 3,800, and to tie.
  byJobRoleHis: { "Battery Repair Technician": 14825, "Drone Service Technician": 38050,
    "Solar Panel Installation": 19710 },
  byJobRoleHisTotal: 72585,
};

const uri = process.env.MONGODB_URL, dbName = requireSafeDb("reconcile-workbook"), BASE = process.env.BASE_URL;
const client = await new MongoClient(uri).connect();
const db = client.db(dbName);
console.log(`reconciling against ${dbName} via ${BASE}`);
const now = new Date();
const meta = { createdAt: now, updatedAt: now, __v: 0 };

// A dedicated ledger: only the workbook's 18 rows, so the comparison is against his numbers and
// nothing else.
await db.collection("costentries").deleteMany({});
await db.collection("costcategories").deleteMany({});
const admin = await db.collection("users").findOne({ email: "admin@vidysea.com" });
const ins = async (coll, doc) => (await db.collection(coll).insertOne({ ...doc, ...meta })).insertedId;

const heads = {};
for (const [code, name] of HEADS) heads[name] = await ins("costcategories", { code, name, head_type: "Direct", active: true });
const locs = {};
for (const [code, name] of LOCS) {
  const found = await db.collection("locations").findOne({ name });
  locs[code] = found ? found._id : await ins("locations", { code: `WB-${code}`, name, approval_status: "Approved", operational_status: "Operational" });
}
const progs = {};
for (const [code, name] of ROLES) {
  const found = await db.collection("programs").findOne({ name });
  progs[code] = found ? found._id : await ins("programs", { code: `WB-${code}`, name, duration_days: 45, buffer_days: 5, default_batch_size: 30, trainer_skill: name, completion_deadline_days: 90, requires_lab: false });
}
const trs = {};
for (const n of TRAINERS) {
  const found = await db.collection("trainers").findOne({ name: n });
  trs[n] = found ? found._id : await ins("trainers", { name: n, phone: `9${Math.floor(100000000 + Math.random() * 899999999)}` });
}
const batches = {};
for (const [name, loc, role, start, seats] of BATCHES) {
  await db.collection("batches").deleteMany({ code: name });
  batches[name] = await ins("batches", { code: name, location: locs[loc], program: progs[role],
    target_size: seats, planned_start: new Date(`${start}T00:00:00+05:30`), status: "Planning", plan_enabled: false, milestones: [] });
}
for (const [date, loc, batch, trainer, head, amount] of ENTRIES) {
  await ins("costentries", {
    entry_date: new Date(`${date}T09:00:00+05:30`),
    ...(loc ? { location: locs[loc] } : {}),
    ...(batch ? { batch: batches[batch] } : {}),
    ...(trainer ? { trainer: trs[trainer] } : {}),
    category: heads[head], amount, note: "workbook reconciliation", entered_by: admin._id,
  });
}
// A granted reader, because the finance door refuses an Admin without `finance.view` — which is
// itself part of what this run confirms.
await db.collection("users").updateOne({ email: "admin@vidysea.com" }, { $set: { extra_permissions: ["finance.view"] } });

const login = async () => {
  const csrfRes = await fetch(`${BASE}/api/auth/csrf`);
  const { csrfToken } = await csrfRes.json();
  const cookie1 = csrfRes.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: cookie1 },
    body: new URLSearchParams({ csrfToken, email: "admin@vidysea.com", password: process.env.ADMIN_PASSWORD || "admin123" }),
  });
  return [cookie1, ...res.headers.getSetCookie().map((c) => c.split(";")[0])].join("; ");
};
const cookie = await login();
const resp = await fetch(`${BASE}/api/reports/costs`, { headers: { cookie } });
if (resp.status !== 200) { console.log(`FATAL: the finance door answered ${resp.status}`); await client.close(); process.exit(1); }
const r = await resp.json();

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { c ? pass++ : fail++; console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };
const money = (n) => Number(n).toLocaleString("en-IN");

ok("grand total matches the workbook to the rupee", r.totals.actual === EXPECT.grand, `ERP ${money(r.totals.actual)} vs workbook ${money(EXPECT.grand)}`);
ok("entry count matches", r.totals.entries === EXPECT.entries, `${r.totals.entries} vs ${EXPECT.entries}`);

for (const [head, amt] of Object.entries(EXPECT.byHead)) {
  const row = r.by_head.find((h) => h.head === head);
  ok(`head "${head}"`, row && row.amount === amt, `ERP ${money(row?.amount ?? 0)} vs workbook ${money(amt)}`);
}
for (const [b, amt] of Object.entries(EXPECT.byBatch)) {
  const row = r.unit_economics.find((x) => x.batch === b);
  ok(`batch "${b}"`, row && row.amount === amt, `ERP ${money(row?.amount ?? 0)} vs workbook ${money(amt)}`);
}
for (const [l, amt] of Object.entries(EXPECT.byLocation)) {
  const row = r.by_location.find((x) => x.label === l);
  ok(`location "${l}"`, row && row.amount === amt, `ERP ${money(row?.amount ?? 0)} vs workbook ${money(amt)}`);
}
for (const [m, amt] of Object.entries(EXPECT.byMonth)) {
  const row = r.by_month.find((x) => x.key === m);
  ok(`month ${m}`, row && row.amount === amt, `ERP ${money(row?.amount ?? 0)} vs workbook ${money(amt)}`);
}
ok("no month outside the workbook's three carries money",
  r.by_month.filter((x) => x.amount > 0).length === 3, JSON.stringify(r.by_month.filter((x) => x.amount > 0).map((x) => [x.key, x.amount])));

// The job-role tab: his three rows must match ours exactly, and ours must ALSO carry the untagged
// 3,800 that his tab drops - which is the whole reason our grand total ties and his does not.
for (const [role, amt] of Object.entries(EXPECT.byJobRoleHis)) {
  const row = r.by_job_role.find((x) => x.label === role);
  ok(`job role "${role}"`, row && row.amount === amt, `ERP ${money(row?.amount ?? 0)} vs workbook ${money(amt)}`);
}
const roleUnassigned = r.by_job_role.find((x) => x.label === "Unassigned");
ok("the two untagged entries appear under Unassigned in OUR job-role view",
  roleUnassigned && roleUnassigned.amount === EXPECT.grand - EXPECT.byJobRoleHisTotal,
  `ERP Unassigned ${money(roleUnassigned?.amount ?? 0)} = 76,385 - 72,585 = ${money(EXPECT.grand - EXPECT.byJobRoleHisTotal)}`);
const oursRoleTotal = r.by_job_role.reduce((a, x) => a + x.amount, 0);
ok("...so OUR job-role view ties to the grand total, where the workbook's tab does not",
  oursRoleTotal === EXPECT.grand, `ERP ${money(oursRoleTotal)} vs his tab ${money(EXPECT.byJobRoleHisTotal)}`);

// The cross-tab, cell by cell, against his Batch-wise report.
const CROSS = {
  "CHK1286 Program 4": { "TOT Fee": 4500, "Material & Consumables": 5100, "Marketing & Mobilisation": 3900 },
  "BSR-Trg-02": { "Trainer Eligibility Fee": 3250, "Material & Consumables": 4575, "Travel & Conveyance": 1800, "Venue & Infrastructure": 5200 },
  "SPT-Trg-01": { "Trainer Eligibility Fee": 3250, "Equipment & Tools": 8900, "Trainee Kit": 3360, "Certification & Assessment Fee": 4200 },
  "DRC-Sirsa-01": { "Trainer Eligibility Fee": 3250, "Material & Consumables": 6200, "Equipment & Tools": 9400, "Trainee Kit": 3600, "Travel & Conveyance": 2100 },
  "Unassigned": { "Travel & Conveyance": 1600, "Miscellaneous": 2200 },
};
let cellsChecked = 0, cellsWrong = [];
for (const [batch, cells] of Object.entries(CROSS)) {
  const row = r.cross_tab.rows.find((x) => x.batch === batch);
  for (const [head, amt] of Object.entries(cells)) {
    const key = r.cross_tab.heads.find((h) => h.head === head)?.key;
    const got = row?.cells?.[key] ?? 0;
    cellsChecked++;
    if (got !== amt) cellsWrong.push(`${batch} x ${head}: ${got} vs ${amt}`);
  }
}
ok(`every populated cell of the batch x head cross-tab matches (${cellsChecked} cells)`,
  cellsWrong.length === 0, cellsWrong.slice(0, 4).join(" · "));

console.log(`\n${pass} passed, ${fail} failed`);
await db.collection("users").updateOne({ email: "admin@vidysea.com" }, { $set: { extra_permissions: [] } });
await client.close();
process.exit(fail ? 1 : 0);
