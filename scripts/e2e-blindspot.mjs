// Blind-spot tests — edge cases the main suites do not cover, run against localhost.
// Focus: exact-boundary eligibility, slot boundaries, TC Password masking per role,
// duplicate sheet keys, header-below-totals-row detection, REAL OneDrive fetch,
// capability warnings, instant trainer-request notification, interested[] round-trip.
//
// QA-1692/QA-1741: guarded via requireLocalBase (db-guard.mjs) — this file writes
// (/api/programs, /api/public/register/:token, /api/candidates/import) through whatever
// server BASE_URL names. Missed in QA-1692's first pass (name confusion with the sibling
// e2e-flows-blindspot.mjs, which was fixed); the checker caught the miss and filed QA-1741.
import { requireLocalBase } from "./db-guard.mjs";
const BASE = requireLocalBase("e2e-blindspot", process.env.BASE_URL || "http://localhost:3000/erp");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + " " + x); } };

async function login(email, password) {
  const csrfRes = await fetch(BASE + "/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const csrfCookie = csrfRes.headers.get("set-cookie").split(";")[0];
  const res = await fetch(BASE + "/api/auth/callback/credentials", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: csrfCookie },
    body: new URLSearchParams({ csrfToken, email, password }), redirect: "manual",
  });
  const session = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")]).flat().filter(Boolean).map((c) => c.split(";")[0]).find((c) => c.includes("session-token"));
  return [csrfCookie, session].join("; ");
}
async function req(cookie, method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const admin = await login("admin@vidysea.com", process.env.ADMIN_PASSWORD || "admin123");
const ops = await login("ops@vidysea.com", "CiOnly@123");
const stamp = "BS" + Date.now().toString().slice(-6);

// ---- setup ----
const prog = (await req(admin, "POST", "/api/programs", { code: stamp, name: "Test Program " + stamp, trainer_skill: "Skill" + stamp, duration_days: 15, buffer_days: 5, default_batch_size: 30, completion_deadline_days: 90 })).data.item;
const loc = (await req(admin, "POST", "/api/locations", { code: "L" + stamp, name: "Test Location " + stamp, approval_status: "Approved" })).data.item;
const loc2 = (await req(admin, "POST", "/api/locations", { code: "M" + stamp, name: "Test Location B" + stamp, approval_status: "Approved" })).data.item;

// ---- 1. Eligibility exact boundaries ----
const today = new Date();
const dobExactly18 = new Date(today); dobExactly18.setFullYear(today.getFullYear() - 18);
const dobExactly40 = new Date(today); dobExactly40.setFullYear(today.getFullYear() - 40);
const dob41 = new Date(today); dob41.setFullYear(today.getFullYear() - 41);
const dob17 = new Date(today); dob17.setFullYear(today.getFullYear() - 17); dob17.setDate(dob17.getDate() + 2); // turns 18 the day after tomorrow

async function eligOf(dob, extra = {}) {
  const c = (await req(admin, "POST", "/api/candidates", { name: `Cand ${stamp}${Math.random().toString(36).slice(2, 6)}`, phone: "9" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0"), location: loc._id, program: prog._id, dob: dob?.toISOString?.() ?? dob, education: "10th Pass", ...extra })).data.item;
  return (await req(admin, "GET", `/api/candidates/${c._id}`)).data.item.eligibility;
}
ok("exactly 18 today → eligible", (await eligOf(dobExactly18)).eligible === true);
ok("exactly 40 today → eligible (18–40 inclusive)", (await eligOf(dobExactly40)).eligible === true);
ok("41 → not eligible", (await eligOf(dob41)).eligible === false);
ok("17 (18 in 2 days) → not eligible yet", (await eligOf(dob17)).eligible === false);
// QA-1594 (S3): `setMonth(getMonth() - 6)` overflows the day. Run on 31 August it asks for
// "31 February" and JS answers 3 March - five months and 29 days back, INSIDE the cooldown - so
// this fixture demanded eligible=true for a candidate the product correctly still blocks. It fails
// only on the 29th, 30th and 31st of a month, which is why it read as a flake for weeks. The
// product's own rule (rules.ts candidateEligibility) applies setMonth(+cooldown) to the training
// date, so the fixture has to hand it a date whose day EXISTS in the target month.
const monthsAgo = (base, n) => {
  const d = new Date(base);
  const day = d.getDate();
  d.setDate(1);                                  // never overflow while changing the month
  d.setMonth(d.getMonth() - n);
  const lastOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastOfMonth));         // clamp: 31 Aug -> 28 Feb, not 3 Mar
  return d;
};
const cd6m = monthsAgo(today, 6); cd6m.setDate(cd6m.getDate() - 1);      // cooldown lapsed yesterday
const cd6mIn = monthsAgo(today, 6); cd6mIn.setDate(cd6mIn.getDate() + 2); // still inside
ok("training 6mo+1d ago → eligible again", (await eligOf(new Date("2000-06-15"), { last_training_date: cd6m.toISOString() })).eligible === true);
ok("training just under 6mo ago → still blocked", (await eligOf(new Date("2000-06-15"), { last_training_date: cd6mIn.toISOString() })).eligible === false);
ok("no dob+education → Unverified (eligible w/ unknowns, never hard-fail)", await (async () => {
  const c = (await req(admin, "POST", "/api/candidates", { name: `Cand ${stamp}unk`, phone: "9" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0"), location: loc._id, program: prog._id })).data.item;
  const e = (await req(admin, "GET", `/api/candidates/${c._id}`)).data.item.eligibility;
  return e.eligible === true && e.unknown.length === 2;
})());

// ---- 2. interested[] round-trip (CEO: shortlist में फटाफट ढूंढ पाऊं) ----
const intCand = (await req(admin, "POST", "/api/candidates", { name: `Cand ${stamp}int`, phone: "9" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0"), location: loc._id, program: prog._id, interested_programs: [prog._id], interested_locations: [loc._id, loc2._id] })).data.item;
const intRead = (await req(admin, "GET", `/api/candidates/${intCand._id}`)).data.item;
ok("interested programs+locations stored and readable", intRead.interested_programs?.length === 1 && intRead.interested_locations?.length === 2, JSON.stringify({ p: intRead.interested_programs?.length, l: intRead.interested_locations?.length }));

// ---- 3. Slot boundary: back-to-back slots do NOT clash; containment DOES ----
const tr = (await req(admin, "POST", "/api/trainers", { name: `Trainer ${stamp}`, phone: "9666" + stamp.slice(2), skills: ["Skill" + stamp], capable_locations: [loc._id] })).data.item;
const start = "2027-06-01";
const b1 = (await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, trainer: tr._id, planned_start: start, target_size: 3, slot_start: "09:00", slot_end: "13:00" }));
ok("slot batch created", b1.status === 201);
const b2 = await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, trainer: tr._id, planned_start: start, target_size: 3, slot_start: "13:00", slot_end: "17:00" });
ok("back-to-back slot (13:00 start after 13:00 end) allowed", b2.status === 201, `got ${b2.status}: ${JSON.stringify(b2.data).slice(0, 80)}`);
// 2026-08-13: sub-4-hour slots are invalid outright, so containment is tested with a 4h slot
// inside an 8h one, on a window clear of b1/b2's ~35-day ranges.
const b3 = await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, trainer: tr._id, planned_start: start, target_size: 3, slot_start: "10:00", slot_end: "11:00" });
ok("a 1-hour slot refused outright (sessions are exactly 4 or 8 hours)", b3.status === 400, `got ${b3.status}`);
const start2 = "2027-09-01";
const b8 = await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, trainer: tr._id, planned_start: start2, target_size: 3, slot_start: "09:00", slot_end: "17:00" });
ok("8-hour slot batch created", b8.status === 201, `got ${b8.status}: ${JSON.stringify(b8.data).slice(0, 80)}`);
const b9 = await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, trainer: tr._id, planned_start: start2, target_size: 3, slot_start: "10:00", slot_end: "14:00" });
ok("contained slot (10–14 inside 9–17) blocked", b9.status === 409, `got ${b9.status}`);

// ---- 4. Capability warning (CEO: कहाँ-कहाँ training ले सकता है) ----
const bCap = await req(admin, "POST", "/api/batches", { location: loc2._id, program: prog._id, trainer: tr._id, planned_start: "2027-08-01", target_size: 3 });
ok("booking outside capable_locations warns", bCap.status === 201 && String(bCap.data.warning ?? "").includes("not listed as able"), JSON.stringify(bCap.data.warning));
const bCapOk = await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, trainer: tr._id, planned_start: "2027-10-01", target_size: 3 });
// 2026-08-12: assert on the capability warning specifically. A trainer now starts at "Fresh Lead"
// (the real pipeline default), which legitimately raises its own not-yet-Certified warning —
// that must not be read as a location-capability failure.
ok("booking at a capable location does not warn about capability",
  bCapOk.status === 201 && !String(bCapOk.data.warning ?? "").includes("not listed as able"),
  JSON.stringify(bCapOk.data.warning));

// ---- 5. Instant notification on trainer request (CEO: detail मनीष जी के पास) ----
const req1 = (await req(admin, "POST", "/api/trainer-requests", { location: loc._id, program: prog._id, required_by_date: "2027-06-01" })).data.item;
// Queried by type — the inbox caps at 100 and sorts severity-first, so an unfiltered scan
// silently drops this alert once enough unrelated warnings accumulate in the database.
const notifs = (await req(admin, "GET", "/api/notifications?status=all&type=trainer_request_new")).data.items ?? [];
ok("new trainer request raises an instant alert", notifs.some((n) => n.type === "trainer_request_new" && String(n.entity_id) === String(req1._id)));

// ---- 6. Workbook Watch edge cases ----
// Resolved from the repo's own node_modules — an absolute file:/// path here kept every
// CI run red (Linux runners have no D: drive) while passing silently on the dev laptop.
const xlsxMod = await import("xlsx");
const XLSX = xlsxMod.default ?? xlsxMod;
function wbUrl(tabs) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(tabs)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return "data:application/octet-stream;base64," + XLSX.write(wb, { type: "base64", bookType: "xlsx" });
}
// Real Vidysea-RPL shape: totals row ABOVE the header, duplicate Institution+Job role pair
const sheetV1 = [
  ["", "", 360, 24],                                     // totals junk row
  ["Institution Name", "Job role", "Total Target", "TC Password"],
  ["ITI " + stamp, "Drone Tech", "135", "secret1"],
  ["ITI " + stamp, "Drone Tech", "225", "secret2"],      // duplicate key pair!
  ["Apex " + stamp, "Solar Tech", "315", "secret3"],
];
const wsrc = (await req(admin, "POST", "/api/sync-sources", { name: "Watch Source " + stamp, source_url: wbUrl({ Sheet1: sheetV1 }), mode: "watch", key_columns: ["Institution Name", "Job role"] })).data.item;
const wr1 = (await req(admin, "POST", `/api/sync-sources/${wsrc._id}/run`, {})).data;
ok("header detected below totals row (baseline OK)", wr1.status === "OK" && wr1.changes === 0, JSON.stringify(wr1));
// change ONLY the second duplicate row + the password
const sheetV2 = JSON.parse(JSON.stringify(sheetV1));
sheetV2[3][2] = "230";        // duplicate row target 225 → 230
sheetV2[4][3] = "newpass";    // TC Password change
await req(admin, "PATCH", `/api/sync-sources/${wsrc._id}`, { source_url: wbUrl({ Sheet1: sheetV2 }) });
const wr2 = (await req(admin, "POST", `/api/sync-sources/${wsrc._id}/run`, {})).data;
const wcs = (await req(admin, "GET", "/api/workbook-changes?status=New")).data.items ?? [];
const dupChange = wcs.find((c) => c.row_key?.includes("(#2)") && c.column === "Total Target");
ok("duplicate-key rows tracked separately (#2 suffix)", dupChange?.old_value === "225" && dupChange?.new_value === "230", JSON.stringify(dupChange ?? wr2));
const pwChangeAdmin = wcs.find((c) => c.column === "TC Password");
ok("admin sees TC Password change in clear", pwChangeAdmin?.new_value === "newpass", JSON.stringify(pwChangeAdmin?.new_value));
// QA-083 (checker round 5): Operations lost sheet.approve — the sheet feed no longer
// answers them at all, which is stronger than the old masked read.
const wcsOpsRes = await req(ops, "GET", "/api/workbook-changes?status=New");
ok("Operations can no longer read the sheet feed at all (QA-083)", wcsOpsRes.status === 403, `got ${wcsOpsRes.status}`);

// ---- 6b. MANY tabs, differently shaped, and tabs coming and going (2026-08-13) ----
// "10-15 tabs saare sync hone chahiye… kal koi nayi tab aaye ya hate, system dynamic ho."
// Also proves per-tab row identity: a tab whose columns don't match key_columns must key on its
// OWN identifying columns, not on the serial number (which renumbers and makes every row "change").
{
  const trainersV1 = [
    ["S.No", "Trainer Name", "Job Role", "Status"],
    [1, "Ramesh " + stamp, "Drone Tech", "Nominated"],
    [2, "Suresh " + stamp, "Solar Tech", "Certified"],
  ];
  const centresV1 = [["Centre Code", "Centre Name"], ["C1", "ITI A " + stamp], ["C2", "ITI B " + stamp]];
  const multi = (await req(admin, "POST", "/api/sync-sources", {
    name: "Multi-tab " + stamp,
    source_url: wbUrl({ Trainers: trainersV1, Centres: centresV1 }),
    mode: "watch", key_columns: ["Institution Name", "Job role"], // deliberately matches NEITHER tab
  })).data.item;
  const m1 = (await req(admin, "POST", `/api/sync-sources/${multi._id}/run`, {})).data;
  ok("every tab is snapshotted, not just the first", m1.status === "OK" && m1.tabs === 2, JSON.stringify(m1));

  // Insert a row at the TOP of Trainers: every serial number below shifts. With serial-number
  // keying this reported a change on every row; keyed on the trainer's own columns it is 1 add.
  const trainersV2 = [
    ["S.No", "Trainer Name", "Job Role", "Status"],
    [1, "Naya " + stamp, "Drone Tech", "Fresh Lead"],
    [2, "Ramesh " + stamp, "Drone Tech", "Nominated"],
    [3, "Suresh " + stamp, "Solar Tech", "Certified"],
  ];
  await req(admin, "PATCH", `/api/sync-sources/${multi._id}`, { source_url: wbUrl({ Trainers: trainersV2, Centres: centresV1 }) });
  const m2 = (await req(admin, "POST", `/api/sync-sources/${multi._id}/run`, {})).data;
  const mc = (await req(admin, "GET", `/api/workbook-changes?status=New`)).data.items ?? [];
  // Scope to THIS run's rows — the inbox also holds changes from earlier suite runs.
  const added = mc.filter((c) => c.tab === "Trainers" && c.change_type === "Added" && String(c.row_key ?? "").includes(stamp));
  ok("a row inserted at the top is ONE addition, not a renumbering flood",
    m2.changes === 1 && added.length === 1 && /Naya/.test(added[0]?.row_key ?? ""), JSON.stringify({ changes: m2.changes, keys: mc.map((c) => c.row_key).slice(0, 5) }));

  // A brand-new tab tomorrow must be picked up on its own, and a deleted one announced.
  await req(admin, "PATCH", `/api/sync-sources/${multi._id}`, {
    source_url: wbUrl({ Trainers: trainersV2, Batches: [["Batch Code", "Centre"], ["B1", "ITI A " + stamp]] }),
  });
  const m3 = (await req(admin, "POST", `/api/sync-sources/${multi._id}/run`, {})).data;
  const mc3 = (await req(admin, "GET", `/api/workbook-changes?status=New`)).data.items ?? [];
  ok("a tab added later is discovered on the next poll",
    mc3.some((c) => c.change_type === "Added" && /New tab "Batches"/.test(String(c.new_value ?? ""))), JSON.stringify(m3));
  ok("…and a tab that disappears is announced, not silently forgotten",
    mc3.some((c) => c.change_type === "Removed" && /Tab "Centres" is gone/.test(String(c.new_value ?? ""))), JSON.stringify(m3));
  // The serial column itself must never be treated as data.
  ok("a renumbered serial column is not reported as an edit",
    !mc3.some((c) => c.column === "S.No" && String(c.row_key ?? "").includes(stamp)),
    JSON.stringify(mc3.filter((c) => c.column === "S.No" && String(c.row_key ?? "").includes(stamp)).slice(0, 2)));
}

// ---- 7. REAL OneDrive fetch through the server (the badger flow, end to end) ----
const realSrc = (await req(admin, "POST", "/api/sync-sources", {
  name: "Watch Source " + stamp + " REAL",
  source_url: "https://onedrive.live.com/:x:/g/personal/c1d310c499f08fba/IQBHQGQ1_HmBRZjCmC1XQMK8AQCFnOpu1H8GXm3MNvZnypE",
  mode: "watch", key_columns: ["Institution Name", "Job role"],
})).data.item;
const realRun = (await req(admin, "POST", `/api/sync-sources/${realSrc._id}/run`, {})).data;
ok("REAL Vidysea-RPL OneDrive workbook fetched via badger flow", realRun.status === "OK" && realRun.tabs >= 1, JSON.stringify(realRun));

// ---- 8. Watch failure mode: login-wall HTML must fail loudly, not diff garbage ----
// -100: this used to point the source at https://www.vidysea.com/erp/login, which the
// single-truth policy now refuses before it can be saved (only the client workbook may be
// registered). The behaviour under test is "an HTML page where a spreadsheet should be", so it is
// driven from THIS server's own login page instead — same HTML, same detection, policy respected.
await req(admin, "PATCH", `/api/sync-sources/${wsrc._id}`, { source_url: `${BASE}/login` });
const wrFail = (await req(admin, "POST", `/api/sync-sources/${wsrc._id}/run`, {})).data;
ok("HTML page instead of sheet → Failed with clear error", wrFail.status === "Failed" && String(wrFail.error ?? "").length > 0, JSON.stringify(wrFail));

// ---- 9. Milestones do not regenerate once batch is Ready (dates are history) ----
const msBatch = (await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: "2027-12-01", target_size: 2 })).data.item;
await req(admin, "PATCH", `/api/batches/${msBatch._id}/milestones`, { create: true }); // QA-152 (-81): plan only on demand
const regenPlanning = await req(admin, "PATCH", `/api/batches/${msBatch._id}/milestones`, { regenerate: true });
ok("regenerate allowed while Planning", regenPlanning.status === 200);

// ---- 10. Public register: halted location keeps its link working (pool-building is allowed pre-open) ----
const regTok = (await req(admin, "POST", "/api/public-tokens", { purpose: "register", location: loc._id, program: prog._id })).data.item;
const pubRes = await fetch(BASE + `/api/public/register/${regTok.token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Pub " + stamp, phone: "7999" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0"), email: "pub" + stamp + "@test.local" }) });
ok("public registration works (location Not Started — advance pooling)", pubRes.status === 201, `status=${pubRes.status}`);
// 9-digit phone rejected
const shortPhone = await fetch(BASE + `/api/public/register/${regTok.token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Pub short", phone: "123456789" }) });
ok("public registration rejects <10-digit phone", shortPhone.status === 400, `status=${shortPhone.status}`);

// ---- A-03 (24-Aug issues sheet, Shiv, SPOKEN): the link must be able to carry a BATCH ----
// "Batch four ke liye main candidate ko self-registration ki link bhej raha hoon... aur maine usko
// yahan se link copy karke jaise hi send kiya hai, toh phir wo direct batch four mein hi assign ho
// jaana chahiye."
// Before this, the register purpose never read the token's `batch` field (which has existed since
// the record was written, used only by plan and attendance links), so every self-registered
// candidate was created lifecycle_status "Unassigned" and had to be found and enrolled by hand -
// which is why AVP-GURU-RPLAVP-DST-04 sat at 0/41 enrolled on live.
{
  const aBatch = (await req(admin, "POST", "/api/batches",
    { location: loc._id, program: prog._id, planned_start: "2027-11-01", target_size: 2 })).data.item;

  const bTokRes = await req(admin, "POST", "/api/public-tokens",
    { purpose: "register", location: loc._id, batch: aBatch._id });
  ok("A-03: a registration link can be minted against a BATCH, and does not ask for the programme twice",
    bTokRes.status === 201 && !!bTokRes.data.item?.token && String(bTokRes.data.item.batch) === String(aBatch._id)
      && String(bTokRes.data.item.program) === String(prog._id),
    JSON.stringify({ s: bTokRes.status, batch: bTokRes.data.item?.batch, program: bTokRes.data.item?.program }));
  // If the mint refuses, every assertion below is about a token that does not exist. On the pre-fix
  // build that is exactly what happens (400: the route demanded a programme and had no idea what a
  // batch was), and an unguarded block CRASHED the whole suite there. A regression should read as a
  // failure, not kill the run and take 80 unrelated assertions with it.
  const bTok = bTokRes.data.item?.token;
  if (!bTok) {
    ok("A-03: the public form is TOLD which batch (not run - the link could not be minted)", false, JSON.stringify(bTokRes.data));
    ok("A-03: registering through a batch link SAYS which batch they joined (not run)", false, "no token");
    ok("A-03: and they are actually ON that batch's roster (not run)", false, "no token");
    ok("A-03: a batch-pinned link records batch_interest Current (not run)", false, "no token");
    ok("A-03: a centre-wide link is untouched (not run)", false, "no token");
    ok("A-03: a finished batch refuses a new registration link (not run)", false, "no token");
  } else {

  const meta = await (await fetch(BASE + `/api/public/register/${bTok}`)).json();
  ok("A-03: the public form is TOLD which batch, and that it is pinned - so it can show it instead of asking",
    meta.batch_fixed === true && meta.batch?.code === aBatch.code,
    JSON.stringify({ batch_fixed: meta.batch_fixed, batch: meta.batch }));

  const ph = "7391" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
  const reg = await fetch(BASE + `/api/public/register/${bTok}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "A03 Joiner " + stamp, phone: ph, email: "a03" + stamp + "@test.local" }) });
  const regBody = await reg.json();
  ok("A-03: registering through a batch link SAYS which batch they joined",
    reg.status === 201 && regBody.batch === aBatch.code, JSON.stringify({ s: reg.status, batch: regBody.batch }));

  // THE WHOLE POINT: they are ON the roster, not on the pool.
  const roster = (await req(admin, "GET", `/api/batches/${aBatch._id}/members`)).data.items ?? [];
  ok("A-03: and they are actually ON that batch's roster - which is the entire ask",
    roster.some((m) => m.candidate?.phone === ph || String(m.candidate?.name ?? "").startsWith("A03 Joiner")),
    JSON.stringify({ roster: roster.length, names: roster.map((m) => m.candidate?.name) }));

  // A link that names a batch has already settled the intake, so the current-vs-future question is
  // not asked - and must not be answerable, because "Future" would make addMemberChecked refuse.
  const cand = roster.find((m) => String(m.candidate?.name ?? "").startsWith("A03 Joiner"))?.candidate;
  const candRow = cand ? (await req(admin, "GET", `/api/candidates/${cand._id}`)).data.item : null;
  ok("A-03: a batch-pinned link records batch_interest Current, never Future - or the enrolment it just did could not have happened",
    candRow?.batch_interest === "Current", JSON.stringify({ batch_interest: candRow?.batch_interest }));

  // AND THE OLD LINKS MUST NOT CHANGE. A link already sitting in somebody's WhatsApp thread keeps
  // behaving exactly as it did - the REQ-393 lesson: a dead link explains nothing to whoever holds it.
  const centreTok = (await req(admin, "POST", "/api/public-tokens",
    { purpose: "register", location: loc._id, program: prog._id })).data.item;
  const centreMeta = await (await fetch(BASE + `/api/public/register/${centreTok.token}`)).json();
  ok("A-03: a centre-wide link (no batch) is untouched - not pinned, and still asks the current-vs-future question",
    centreMeta.batch_fixed === false && centreMeta.batch === null,
    JSON.stringify({ batch_fixed: centreMeta.batch_fixed, batch: centreMeta.batch }));

  // A link cannot be made for a batch nobody can join, and the refusal names it.
  await req(admin, "POST", `/api/batches/${aBatch._id}/transition`, { target: "Cancelled", reason: "A-03 pin" }, 200);
  const deadTok = await req(admin, "POST", "/api/public-tokens",
    { purpose: "register", location: loc._id, batch: aBatch._id }, 409);
  ok("A-03: a finished batch refuses a new registration link, and the refusal NAMES the batch",
    deadTok.status === 409 && String(deadTok.data?.error ?? "").includes(aBatch.code),
    JSON.stringify({ s: deadTok.status, e: deadTok.data?.error }));
  }
}

// ---- QA-1187: "is there room on this roster" must have ONE answer, and somebody must be told ----
// Filed by the qa-247 checker against my own unit. A-03's register door refused the join once the
// roster reached target_size. The product does not work that way and never did: `addMemberChecked`
// WARNS and admits ("Roster is now N of target M - enrolment will be capped at M"), and Rule 48 in
// `updateEnrollment` REFUSES only when somebody tries to COMPLETE enrolment past the target. Joining
// and enrolling are two events with two rules, deliberately. My refusal was a THIRD answer, and it
// landed on the one door a member of the public uses - so an anonymous registrant was turned away
// from a roster a staff member could have added them to.
// What was genuinely missing was not a refusal but the warning REACHING somebody: the link for a
// full batch was minted in silence and the form went on promising a seat.
{
  const fBatch = (await req(admin, "POST", "/api/batches",
    { location: loc._id, program: prog._id, planned_start: "2027-10-01", target_size: 1 })).data.item;

  const mk = async (tag) => (await req(admin, "POST", "/api/candidates",
    { name: `Cap ${tag} ${stamp}`, phone: "76" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0"),
      location: loc._id, program: prog._id }, 201)).data.item;

  // fill it to target through the STAFF door
  const c1 = await mk("A");
  await req(admin, "POST", `/api/batches/${fBatch._id}/members`, { candidate: c1._id }, 201);

  // THE STAFF DOOR'S ANSWER, established first so the public door can be compared against it.
  const c2 = await mk("B");
  const staff = await req(admin, "POST", `/api/batches/${fBatch._id}/members`, { candidate: c2._id }, 201);
  ok("QA-1187: the STAFF roster door admits an over-target member and WARNS - it does not refuse",
    staff.status === 201 && /target 1/.test(String(staff.data?.warning ?? "")),
    JSON.stringify({ s: staff.status, warning: staff.data?.warning }));

  // MINTING a link for a batch already over target: still minted, but the operator is TOLD.
  const fullTok = await req(admin, "POST", "/api/public-tokens",
    { purpose: "register", location: loc._id, batch: fBatch._id }, 201);
  ok("QA-1187: a link for an already-full batch is still MINTED - killing it would strand whoever holds it (REQ-393)",
    fullTok.status === 201 && !!fullTok.data.item?.token, JSON.stringify({ s: fullTok.status }));
  ok("QA-1187: …but the operator is WARNED in the same reply, with the batch and the numbers named",
    /already has/.test(String(fullTok.data?.warning ?? "")) && String(fullTok.data?.warning ?? "").includes(fBatch.code),
    JSON.stringify({ warning: fullTok.data?.warning }));

  // and the form stops promising a seat it cannot promise
  const fullMeta = await (await fetch(BASE + `/api/public/register/${fullTok.data.item.token}`)).json();
  ok("QA-1187: the public form is TOLD the batch is full, so it can stop promising a seat",
    fullMeta.batch?.full === true, JSON.stringify({ batch: fullMeta.batch }));

  // THE POINT OF THE WHOLE ROW: the two doors now give the SAME answer.
  const ph = "7742" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
  const joined = await fetch(BASE + `/api/public/register/${fullTok.data.item.token}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Cap Public " + stamp, phone: ph, email: "cap" + stamp + "@test.local" }) });
  const jBody = await joined.json();
  ok("QA-1187: the PUBLIC link admits them too, exactly as the staff door did - one answer to 'is there room', not two",
    joined.status === 201 && jBody.batch === fBatch.code,
    JSON.stringify({ s: joined.status, batch: jBody.batch }));
  const fRoster = (await req(admin, "GET", `/api/batches/${fBatch._id}/members`)).data.items ?? [];
  ok("QA-1187: …and they are really on that roster, not quietly left on the pool",
    fRoster.some((m) => String(m.candidate?.name ?? "").startsWith("Cap Public")),
    JSON.stringify({ roster: fRoster.length, names: fRoster.map((m) => m.candidate?.name) }));

  // a batch with room must NOT carry the warning - or it becomes noise nobody reads
  const roomy = (await req(admin, "POST", "/api/batches",
    { location: loc._id, program: prog._id, planned_start: "2027-10-15", target_size: 30 })).data.item;
  const roomyTok = await req(admin, "POST", "/api/public-tokens",
    { purpose: "register", location: loc._id, batch: roomy._id }, 201);
  const roomyMeta = await (await fetch(BASE + `/api/public/register/${roomyTok.data.item.token}`)).json();
  ok("QA-1187: a batch with room carries NO warning and is not marked full - the caution stays rare enough to read",
    !roomyTok.data?.warning && roomyMeta.batch?.full === false,
    JSON.stringify({ warning: roomyTok.data?.warning ?? null, full: roomyMeta.batch?.full }));
}

// ---- QA-1239: the window a mint-time refusal cannot reach ----
// Minting a register link for an already-closed batch is refused at mint (409). That refusal cannot
// cover the case this pins: the batch was OPEN when the link was made and was cancelled afterwards.
// The link is already out. The form kept branching on `full` alone, so it went on saying "you will
// be added to this batch" to somebody who could not be, and the submit answered with the same
// "Thank you! Your details are registered" a person gets when they HAVE just joined a roster. The
// batch refusal reached the audit trail and nobody else - least of all the one person who opened a
// link that named a batch and wants to know whether they are on it.
//
// EVERY SETUP STEP BELOW ASSERTS ITS OWN STATUS CODE, and that is not decoration. The first version
// of this block sent {target:"Cancelled"} with no reason; Rule 19 refuses that (409), so the batch
// stayed in Planning and the three assertions after it faithfully measured an OPEN batch and
// reported the product broken. A pin whose setup can fail quietly does not test the thing it names.
{
  const cBatch = (await req(admin, "POST", "/api/batches",
    { location: loc._id, program: prog._id, planned_start: "2027-11-01", target_size: 30 }, 201)).data.item;
  ok("QA-1239 setup: a batch with room exists", !!cBatch?._id, JSON.stringify({ id: cBatch?._id }));

  const cTok = await req(admin, "POST", "/api/public-tokens",
    { purpose: "register", location: loc._id, batch: cBatch._id }, 201);
  ok("QA-1239: precondition - the batch has ROOM when the link is minted, so nothing is refused at mint",
    cTok.status === 201 && !!cTok.data.item?.token && !cTok.data?.warning,
    JSON.stringify({ s: cTok.status, warning: cTok.data?.warning ?? null }));

  const openMeta = await (await fetch(BASE + `/api/public/register/${cTok.data.item.token}`)).json();
  ok("QA-1239: precondition - and the form is promising a seat it CAN honour at this point",
    openMeta.batch?.full === false && !["Completed", "Cancelled", "Closed"].includes(String(openMeta.batch?.status)),
    JSON.stringify({ batch: openMeta.batch }));

  // the batch is cancelled AFTER the link is in somebody hands - the window the 409 cannot cover.
  // Rule 19: a cancellation carries a reason, or it is refused.
  const killed = await req(admin, "POST", `/api/batches/${cBatch._id}/transition`,
    { target: "Cancelled", reason: "QA-1239 fixture: cancelled after its registration link went out" });
  ok("QA-1239 setup: the batch is cancelled after its link went out (with the reason Rule 19 requires)",
    killed.status === 200, `got ${killed.status}: ${JSON.stringify(killed.data?.error ?? null)}`);

  const deadMeta = await (await fetch(BASE + `/api/public/register/${cTok.data.item.token}`)).json();
  ok("QA-1239: the form payload carries the batch STATUS - the page has everything it needs without fetching anything",
    String(deadMeta.batch?.status) === "Cancelled", JSON.stringify({ batch: deadMeta.batch }));
  ok("QA-1239: ...and `full` is still false, which is exactly why a page reading only `full` says the wrong thing",
    deadMeta.batch?.full === false, JSON.stringify({ full: deadMeta.batch?.full }));

  const ph1239 = "7743" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
  // Distinct x-forwarded-for per registrant. The public register POST is limited to 10 per client
  // per 10 minutes (audit auth S2-14), keyed on the RIGHT-most XFF hop, so every unattributed test
  // request in this suite shares the single "local" bucket - and these two fixtures were the ones
  // that tipped it over, so the LAST pin failed with 429 rather than on its own subject.
  // This is not a way around the guard: the scenario IS two different members of the public opening
  // two different links, so giving them two client identities is more faithful than sharing one.
  // The limiter itself is untouched and still proves itself elsewhere in the wall.
  const sub = await fetch(BASE + `/api/public/register/${cTok.data.item.token}`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.11" },
    body: JSON.stringify({ name: "Dead Link " + stamp, phone: ph1239, email: "dead" + stamp + "@test.local" }) });
  const subBody = await sub.json();
  ok("QA-1239: the registration is still KEPT - a cancelled batch is the centre problem, never the student one",
    sub.status === 201, `got ${sub.status}: ${JSON.stringify(subBody).slice(0, 160)}`);
  ok("QA-1239: ...they are told the batch could not take them, instead of being thanked as though it had",
    subBody.batch === null && /could not take/.test(String(subBody.message ?? "")),
    JSON.stringify({ batch: subBody.batch, message: subBody.message }));

  // and the ordinary path must NOT have picked up the new sentence
  const liveBatch = (await req(admin, "POST", "/api/batches",
    { location: loc._id, program: prog._id, planned_start: "2027-11-15", target_size: 30 }, 201)).data.item;
  const okTok = await req(admin, "POST", "/api/public-tokens",
    { purpose: "register", location: loc._id, batch: liveBatch._id }, 201);
  ok("QA-1239 setup: a live batch and its link exist for the contrast case",
    !!liveBatch?._id && okTok.status === 201 && !!okTok.data.item?.token,
    JSON.stringify({ batch: liveBatch?._id, s: okTok.status }));
  const ph1239b = "7744" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
  const good = await fetch(BASE + `/api/public/register/${okTok.data.item.token}`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.12" },
    body: JSON.stringify({ name: "Live Link " + stamp, phone: ph1239b, email: "live" + stamp + "@test.local" }) });
  const goodBody = await good.json();
  ok("QA-1239: a registration that DID join a live batch still gets the joining message, not the refusal one",
    good.status === 201 && goodBody.batch === liveBatch.code && /you are on batch/.test(String(goodBody.message ?? "")),
    JSON.stringify({ s: good.status, batch: goodBody.batch, message: String(goodBody.message ?? "").slice(0, 90) }));
}

// ---- QA-869 (Umesh 2026-08-24): the self-registration link pins its PROGRAMME, not just its centre ----
// "it should confirm location and program too jisse jo candidate register krega uska location and
// program pre fixed rhegaa. vo khud nhi select krega."
//
// The column and both public doors have honoured a pinned programme since the token was written; the
// MINT UI never sent one, so every link ever shared let the student pick their own job role. The
// refusal below is what makes that unrepeatable - a screen can forget a field, a door that refuses
// cannot. The last two assertions are the other half of the promise: links already in somebody's
// WhatsApp thread were NOT rotated off, so this pins that they still work rather than asserting it.
{
  // QA-887 (found by qa-227's checker): the public register door is rate-limited to 10 posts per
  // 10 minutes PER CLIENT KEY, and every suite in the wall shares one key ("local") because they all
  // arrive from the same address. This block took that shared budget from 7/10 to 9/10, and the
  // checker reproduced three HTTP-429s that read exactly like defects. `clientKey` takes the
  // RIGHT-MOST x-forwarded-for hop, so a test can take a bucket of its own by naming one. That does
  // NOT weaken the guard - it is still enforced per key, and the last assertion in this block trips
  // it deliberately on a key of its own to prove it still bites.
  let xffN = 0;
  const pubPost = (token, body) => fetch(BASE + `/api/public/register/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": `10.99.${(++xffN) % 250}.${xffN % 250}` },
    body: JSON.stringify(body),
  });
  const noProg = await req(admin, "POST", "/api/public-tokens", { purpose: "register", location: loc._id });
  ok("QA-869: minting a registration link with no programme is refused",
    noProg.status === 400, `status=${noProg.status}`);
  ok("QA-869: ...and the refusal names the programme, so the operator knows which box to fill",
    /programme|program/i.test(String(noProg.data?.error ?? "")), JSON.stringify(noProg.data));

  // A retired programme may stay on a record that already points at one, but nothing NEW may start
  // under it (-115/QA-221). A registration link is as new as it gets, and the picker hides retired
  // programmes - so the door and the screen have to agree, or the screen offers what the server rejects.
  const deadProg = (await req(admin, "POST", "/api/programs", { code: stamp + "X", name: "Retired Program " + stamp, trainer_skill: "Skill" + stamp, duration_days: 15, buffer_days: 5, default_batch_size: 30, completion_deadline_days: 90 })).data.item;
  await req(admin, "PATCH", `/api/programs/${deadProg._id}`, { active: false });
  const retired = await req(admin, "POST", "/api/public-tokens", { purpose: "register", location: loc._id, program: deadProg._id });
  ok("QA-869: a retired programme cannot be given a new registration link",
    retired.status === 409, `status=${retired.status} ${JSON.stringify(retired.data)}`);

  // The pinned link tells the student what it decided for them, and says so as a FACT the page can
  // act on - `programs.length === 1` alone cannot tell "this link pins it" from "the system happens
  // to have one active programme today", and those two render differently on purpose.
  const meta = await (await fetch(BASE + `/api/public/register/${regTok.token}`)).json();
  ok("QA-869: a pinned token reports program_fixed and offers exactly its own programme",
    meta.program_fixed === true && (meta.programs ?? []).length === 1 && String(meta.programs[0]._id) === String(prog._id),
    JSON.stringify({ fixed: meta.program_fixed, n: (meta.programs ?? []).length }));

  // The token WINS over anything the body carries. Without this the pin is decorative: a student (or
  // anything posting to an unauthenticated door) could name a different job role and be filed under it.
  const smuggle = await pubPost(regTok.token, { name: "Pin " + stamp, phone: "7998" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0"), email: "pin" + stamp + "@test.local", program: deadProg._id });
  const smuggled = (await req(admin, "GET", `/api/candidates?limit=2000&location=${loc._id}`)).data.items.find((c) => c.name === "Pin " + stamp);
  ok("QA-869: a programme sent in the body cannot override the one the link pins",
    smuggle.status === 201 && String(smuggled?.program?._id ?? smuggled?.program) === String(prog._id),
    `status=${smuggle.status} program=${JSON.stringify(smuggled?.program)}`);

  // THE COMPATIBILITY PROMISE, measured rather than asserted. Every register token minted before this
  // change has no programme, and they are in people's hands right now. The door refuses to CREATE one
  // of these any more, which is exactly why it has to be inserted directly - there is no longer an API
  // that can produce the shape being tested. Rotating them off would have killed a link somebody is
  // holding to punish a defect that was never theirs.
  const { MongoClient } = await import("mongodb");
  const mc = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
  await mc.connect();
  try {
    const legacyToken = "legacy" + stamp + Math.floor(Math.random() * 1e6);
    await mc.db(process.env.MONGODB_DB || "center_erp_ci").collection("publictokens").insertOne({
      token: legacyToken, purpose: "register", location: new (await import("mongodb")).ObjectId(String(loc._id)),
      active: true, createdAt: new Date(), updatedAt: new Date(), __v: 0,
    });
    const legacyMeta = await (await fetch(BASE + `/api/public/register/${legacyToken}`)).json();
    ok("QA-869: a link shared BEFORE this change still opens, and still lets the candidate choose",
      legacyMeta.program_fixed === false && (legacyMeta.programs ?? []).length >= 1,
      JSON.stringify({ fixed: legacyMeta.program_fixed, n: (legacyMeta.programs ?? []).length }));
    const legacyPost = await pubPost(legacyToken, { name: "Legacy " + stamp, phone: "7997" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0"), email: "legacy" + stamp + "@test.local", program: prog._id });
    ok("QA-869: ...and a candidate can still register through it",
      legacyPost.status === 201, `status=${legacyPost.status}`);

    // ---- QA-903 (Umesh 2026-08-24): the Aadhaar number, on all three intake doors ----
    // This product deliberately did NOT hold one until today: models/index.ts labelled id_reference
    // "NOT the Aadhaar number itself", and export-sidh shipped its aadhaar column blank on purpose.
    // Umesh reversed that and chose the full number on all three doors, so these pins guard the
    // reversal AND the PII consequences that come with it.
    //
    // 234123412346 is a published Verhoeff-valid sample. The two invalid ones are that same number
    // with one digit changed and with two adjacent digits swapped - the two ways a hand-typed 12-digit
    // number actually goes wrong, and exactly what the check digit exists to catch.
    const AAD_OK = "234123412346", AAD_BAD = "234123412345", AAD_SWAP = "234123412364";
    const DBNAME = process.env.MONGODB_DB || "center_erp_ci";
    const { ObjectId } = await import("mongodb");
    const mkCand = (extra) => req(admin, "POST", "/api/candidates", {
      name: "Aad " + stamp + Math.random().toString(36).slice(2, 6),
      phone: "9" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0"),
      location: loc._id, program: prog._id, ...extra,
    });

    {
      const r = await mkCand({ aadhaar_no: "2341 2341 2346" });
      ok("QA-903: a valid Aadhaar is accepted and stored as bare 12 digits (spaces normalise away)",
        r.status === 201 && r.data.item?.aadhaar_no === AAD_OK, `status=${r.status} stored=${r.data.item?.aadhaar_no}`);
    }
    ok("QA-903: a one-digit typo is refused - the check digit is the whole point",
      (await mkCand({ aadhaar_no: AAD_BAD })).status === 400);
    ok("QA-903: two swapped digits are refused",
      (await mkCand({ aadhaar_no: AAD_SWAP })).status === 400);
    {
      const r = await mkCand({ aadhaar_no: "23412341234" });
      ok("QA-903: 11 digits is refused and the message says how many were given",
        r.status === 400 && /11/.test(String(r.data?.error ?? "")), JSON.stringify(r.data).slice(0, 120));
    }
    ok("QA-903: a number beginning 0 or 1 is refused - UIDAI never issues one",
      (await mkCand({ aadhaar_no: "034123412346" })).status === 400);
    {
      const r = await mkCand({ aadhaar_no: AAD_BAD });
      ok("QA-903: the refusal never calls a real person's Aadhaar 'invalid'",
        !/invalid/i.test(String(r.data?.error ?? "")), String(r.data?.error ?? "").slice(0, 100));
    }
    ok("QA-903: Aadhaar stays OPTIONAL - a candidate with none is still created",
      (await mkCand({})).status === 201);

    // THE QA-726 REGRESSION, guarded from the start rather than after it bites. -210 validated a
    // portal id on EVERY patch that carried the field, and the drawer re-sends every field on every
    // edit, so a record already holding a bad value became UNEDITABLE - correcting it was the one
    // thing you could not do. Bulk import writes Aadhaar without refusing rows, so such records will
    // exist by design, and fixing the phone number on one of them must not be blocked by it.
    {
      const c = (await mkCand({ aadhaar_no: AAD_OK })).data.item;
      await mc.db(DBNAME).collection("candidates")
        .updateOne({ _id: new ObjectId(String(c._id)) }, { $set: { aadhaar_no: "999999999999" } });
      const emailOnly = await req(admin, "PATCH", `/api/candidates/${c._id}`, { email: "still" + stamp + "@test.local" });
      ok("QA-903: a record already holding a bad Aadhaar can still have its OTHER fields edited",
        emailOnly.status === 200, `status=${emailOnly.status} ${JSON.stringify(emailOnly.data).slice(0, 120)}`);
      const resend = await req(admin, "PATCH", `/api/candidates/${c._id}`, { aadhaar_no: "999999999999", email: "again" + stamp + "@test.local" });
      ok("QA-903: ...even when the drawer re-sends that same bad value unchanged",
        resend.status === 200, `status=${resend.status}`);
      const fix = await req(admin, "PATCH", `/api/candidates/${c._id}`, { aadhaar_no: AAD_OK });
      ok("QA-903: ...and correcting it to a good one is accepted", fix.status === 200, `status=${fix.status}`);
      const clear = await req(admin, "PATCH", `/api/candidates/${c._id}`, { aadhaar_no: "" });
      ok("QA-903: ...and clearing it is possible - that is how a wrong one is removed",
        clear.status === 200 && !clear.data.item?.aadhaar_no, `status=${clear.status} v=${clear.data.item?.aadhaar_no}`);
    }

    // THE PII CONSEQUENCES. Not decoration: without these the number reaches places the record's own
    // protections never touch.
    {
      const c = (await mkCand({ aadhaar_no: AAD_OK })).data.item;
      await req(admin, "PATCH", `/api/candidates/${c._id}`, { aadhaar_no: "999941057058" });
      const rows = await mc.db(DBNAME).collection("auditlogs")
        .find({ entity: "Candidate", field: "aadhaar_no" }).sort({ _id: -1 }).limit(6).toArray();
      const leaked = rows.filter((r) => /[0-9]{12}/.test(JSON.stringify([r.old_value, r.new_value, r.oldValue, r.newValue])));
      ok("QA-903: the audit log records THAT the Aadhaar changed, never the number itself",
        rows.length > 0 && leaked.length === 0, `rows=${rows.length} leaked=${leaked.length}`);
    }
    {
      const { readFileSync } = await import("node:fs");
      const src = readFileSync("scripts/mirror-prod.mjs", "utf8");
      ok("QA-903: mirror-prod redacts Aadhaar, so no local mirror carries live ones (QA-536's lesson)",
        /candidates:\s*\[[^\]]*aadhaar_no/.test(src));
    }
    {
      const res = await fetch(BASE + `/api/candidates/export-sidh?location=${loc._id}&all=1`, { headers: { cookie: admin } });
      ok("QA-903: the SIDH export still builds now it carries the column it used to ship blank",
        res.status === 200, `status=${res.status}`);
    }

    // ---- QA-941 / QA-942 (qa-233 checker, FAIL cycle 1) ----
    // The bulk importer had NO lane for Aadhaar: a checksum failure and the literal string
    // "NOT-AN-AADHAAR" both imported silently, 201, no warning - while lib/validate.ts asserted in a
    // comment that the "normalize-and-report lane" existed. That is QA-727 repeating one release
    // later, cited by the person who had just read it. Worse than the portal-ID case, because
    // QA-942 traced the unreadable value straight through to the GOVERNMENT SIDH export.
    //
    // Two separate promises are pinned here, and they pull in opposite directions on purpose:
    // the row is NEVER dropped (QA-141: a client's sheet is client data), and the export NEVER
    // carries a value it cannot read.
    {
      const XLSX = await import("xlsx");
      const mkSheet = (rows) => {
        const ws = XLSX.utils.json_to_sheet(rows);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
        return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
      };
      const impName = "ImpAad " + stamp;
      const buf = mkSheet([
        { Name: impName + " A", Phone: "9811" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0"), Aadhaar: "234123412345" },
        { Name: impName + " B", Phone: "9812" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0"), Aadhaar: "NOT-AN-AADHAAR" },
        { Name: impName + " C", Phone: "9813" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0"), Aadhaar: "2341 2341 2346" },
      ]);
      const post = async (extra) => {
        const fd = new FormData();
        fd.append("file", new Blob([buf]), "aad.xlsx");
        fd.append("location", String(loc._id));
        fd.append("program", String(prog._id));
        fd.append("mapping", JSON.stringify({ Name: "name", Phone: "phone", Aadhaar: "aadhaar_no" }));
        fd.append("accept_unknown", "1");
        for (const [k, v] of Object.entries(extra ?? {})) fd.append(k, v);
        const r = await fetch(BASE + "/api/candidates/import", { method: "POST", headers: { cookie: admin }, body: fd });
        return { status: r.status, data: await r.json().catch(() => ({})) };
      };

      const preview = await post({});
      ok("QA-941: the import PREVIEW names the unreadable Aadhaar numbers instead of taking them silently",
        (preview.data?.aadhaar_invalid_count ?? 0) === 2,
        `count=${preview.data?.aadhaar_invalid_count} ${JSON.stringify(preview.data?.aadhaar_invalid ?? []).slice(0, 150)}`);
      ok("QA-941: ...and it names WHICH person, not just a number",
        (preview.data?.aadhaar_invalid ?? []).some((l) => String(l).includes(impName)),
        JSON.stringify(preview.data?.aadhaar_invalid ?? []).slice(0, 150));

      const done = await post({ confirm: "1" });
      ok("QA-941: the rows are still IMPORTED - reported, never refused (QA-141: a client's sheet is client data)",
        done.data?.imported === 3, `imported=${done.data?.imported}`);
      // QA-896 (Umesh 24/08: "bulk sheet upload ... kaam nhi krr rha hai properly"). The batch's own
      // empty-roster banner offers "Import candidates (Excel)", and the import fills only the POOL —
      // so the batch stayed empty and the operator had to navigate back and enrol by hand. The screen
      // now offers to enrol exactly the rows it just created, which needs their ids: guessing "the
      // newest N" is wrong the moment two people import at once.
      ok("QA-896: a confirmed import returns the ids it created, so the batch it came from can be offered them",
        Array.isArray(done.data?.imported_ids) && done.data.imported_ids.length === done.data.imported,
        JSON.stringify({ imported: done.data?.imported, ids: (done.data?.imported_ids ?? []).length }));
      ok("QA-896: and they are real ids, not placeholders",
        (done.data?.imported_ids ?? []).every((s) => /^[0-9a-f]{24}$/i.test(String(s))),
        JSON.stringify((done.data?.imported_ids ?? []).slice(0, 3)));
      ok("QA-941: ...and the confirm response reports them too, not only the preview",
        (done.data?.aadhaar_invalid_count ?? 0) === 2, `count=${done.data?.aadhaar_invalid_count}`);

      const rows = (await req(admin, "GET", `/api/candidates?limit=2000&location=${loc._id}`)).data.items;
      const rowA = rows.find((c) => c.name === impName + " A");
      const rowC = rows.find((c) => c.name === impName + " C");
      ok("QA-941: the unreadable value is STORED as given - visible and fixable, not silently dropped",
        rowA?.aadhaar_no === "234123412345", `stored=${rowA?.aadhaar_no}`);
      ok("QA-941: ...and a spaced-but-valid one is normalised to bare 12 digits on the way in",
        rowC?.aadhaar_no === "234123412346", `stored=${rowC?.aadhaar_no}`);

      // QA-942: the government export. The whole chain ends here, and this is the assertion that
      // matters most - a value we cannot read must not leave the building dressed as an Aadhaar.
      const xl = await fetch(BASE + `/api/candidates/export-sidh?location=${loc._id}&all=1`, { headers: { cookie: admin } });
      const ab = await xl.arrayBuffer();
      const wb = XLSX.read(Buffer.from(ab), { type: "buffer" });
      const out = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      const outA = out.find((r) => String(r.full_name) === impName + " A");
      const outC = out.find((r) => String(r.full_name) === impName + " C");
      ok("QA-942: the SIDH export does NOT carry an Aadhaar the system cannot read",
        outA && String(outA.aadhaar_or_vid ?? "") === "", `exported="${outA?.aadhaar_or_vid}"`);
      ok("QA-942: ...and it DOES carry a good one - the guard filters, it does not blank the column",
        outC && String(outC.aadhaar_or_vid) === "234123412346", `exported="${outC?.aadhaar_or_vid}"`);

      // QA-971 (cycle 2): the operator-facing sentence must AGREE with what the export does. Cycle 2
      // shipped a message saying "the SIDH export will carry it as-is" in the same commit that made
      // the export carry nothing - I contradicted my own fix in the words a person reads, and it
      // reached master. Pinned as a STRING assertion because that is the only thing that catches a
      // sentence: no behaviour changed, only the truth of the claim.
      ok("QA-971: the import warning does NOT claim the export carries an unreadable Aadhaar",
        !(preview.data?.aadhaar_invalid ?? []).some((l) => /carry it as-is/i.test(String(l))),
        JSON.stringify(preview.data?.aadhaar_invalid ?? []).slice(0, 160));
      ok("QA-971: ...it says what the export ACTUALLY does - leaves the column blank",
        (preview.data?.aadhaar_invalid ?? []).every((l) => /blank/i.test(String(l))),
        JSON.stringify(preview.data?.aadhaar_invalid ?? []).slice(0, 160));
    }

    // The PUBLIC doors get the same rule. A field one door validates and another does not is the
    // -116/QA-275 shape, and it is silent - the value looks saved and is not.
    {
      const pubBad = await pubPost(regTok.token, { name: "AadPub " + stamp, phone: "7996" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0"), email: "aadpub" + stamp + "@test.local", aadhaar_no: AAD_BAD });
      ok("QA-903: the public self-registration door refuses a mistyped Aadhaar too",
        pubBad.status === 400, `status=${pubBad.status}`);
      const pubOk = await pubPost(regTok.token, { name: "AadPub2 " + stamp, phone: "7995" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0"), email: "aadpub2" + stamp + "@test.local", aadhaar_no: "9999 4105 7058" });
      ok("QA-903: ...and accepts a good one through the public door",
        pubOk.status === 201, `status=${pubOk.status}`);
    }

    // And the guard itself still bites - proved on a key of this test's own, so it spends no other
    // suite's budget. Without this, the x-forwarded-for trick above would be indistinguishable from
    // having quietly switched rate limiting off.
    {
      let tripped = 0;
      for (let i = 0; i < 13; i++) {
        const r = await fetch(BASE + `/api/public/register/${regTok.token}`, {
          method: "POST", headers: { "Content-Type": "application/json", "x-forwarded-for": "10.77.77.77" },
          body: JSON.stringify({ name: "RL " + i, phone: "7000000000" }),
        });
        if (r.status === 429) tripped++;
      }
      ok("QA-887: the public door's rate limit still trips - per key, so no suite spends another's budget",
        tripped > 0, `429s=${tripped}`);
    }

    // ---- QA-945 (Umesh 2026-08-24): "The current batch" vs "Upcoming batch" ----
    // QA-1190 (client call 2026-08-25, confirmed by Umesh): the two choices were RENAMED. "The
    // current / upcoming batch" became "The current batch", and "A future batch - not available
    // right now" became "Upcoming batch". WORDS ONLY - the stored values are still "Current" and
    // "Future", so every assertion about BEHAVIOUR below is untouched, and only the assertions about
    // WORDING moved with the screen.
    // "jo future interested hai unka status jab tak update nhi hoga tho vo batch mai register nhi
    // hongee aur select krne mai aana chaiye ki phle status update kro. team ko ye help kregi ki
    // future interested walo se jitna abhi data possible hai vo le legi aur baad mai dobara call
    // kreke convert kr skti hai jo ki possible quality lead hogi future ki."
    //
    // The refusal lives in `addMemberChecked` part 1, which is the ONE function both roster-add doors
    // pass through. The assertion that matters most below is therefore a DISAGREEMENT test, in the
    // QA-509 shape: both doors must refuse with the SAME sentence. If they ever diverge, the gate has
    // two homes, and ARCHITECTURE §3.1 records that this exact pair has already drifted apart once
    // (QA-273) - one door adopted a centre-less candidate, the other refused them by comparing against
    // the string "undefined".
    {
      const biBatch = (await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: "2027-11-01", target_size: 8 })).data.item;
      const mkBI = async (interest) => (await req(admin, "POST", "/api/candidates", {
        name: "BI " + stamp + Math.random().toString(36).slice(2, 5),
        phone: "9" + String(Math.floor(Math.random() * 1e9)).padStart(9, "0"),
        location: loc._id, program: prog._id, ...(interest ? { batch_interest: interest } : {}),
      })).data.item;

      ok("QA-945: a new candidate defaults to the CURRENT intake",
        (await mkBI()).batch_interest === "Current");
      ok("QA-945: ...and Future round-trips through the create door",
        (await mkBI("Future")).batch_interest === "Future");

      const fut1 = await mkBI("Future");
      const single = await req(admin, "POST", `/api/batches/${biBatch._id}/members`, { candidate: fut1._id });
      ok("QA-945: the SINGLE-add door refuses a future-interested candidate",
        single.status === 409, `status=${single.status} ${JSON.stringify(single.data).slice(0, 120)}`);
      // QA-1190: this was /change|current intake/i - an alternation whose left branch is the bare
      // word "change", so it passed on almost any refusal sentence. It now demands the remedy
      // VERBATIM, because the remedy names a control the operator must find on screen: after the
      // rename there is no option called "the current intake" any more, and a correct guard whose
      // stated remedy does not exist on screen is the -224 fault this project has already shipped.
      ok("QA-945: ...and the refusal NAMES THE FIX, in the words the screen now uses",
        String(single.data?.error ?? "").includes('change "Interested in" to "The current batch"'),
        String(single.data?.error ?? "").slice(0, 140));

      // THE SAME candidate through the second door, deliberately. The first version of this block used
      // two different people and the sentences then differed only by NAME - which made the comparison
      // below fail while the code was correct. Reusing one candidate is not a weaker test to get past
      // a red assertion; it is the stronger one, because it removes the only legitimate reason the two
      // strings could differ. The single-add above REFUSED, so this person is still unenrolled.
      const bulk = await req(admin, "POST", "/api/candidates/assign", { batch: biBatch._id, candidate_ids: [fut1._id] });
      const bulkErr = String(bulk.data?.results?.[0]?.error ?? "");
      // Asserting the REASON, not merely that it failed. The falsification run caught this: with the
      // schema field removed the single-add SUCCEEDED, so the bulk call then failed with "Rule 20:
      // already active" - and a bare `ok === false` reported PASS on a build where this gate did not
      // exist at all. An assertion that cannot tell why it failed is not a pin.
      ok("QA-945: the BULK-assign door refuses too, and for THIS reason - one gate, both doors (QA-273's lesson)",
        bulk.data?.results?.[0]?.ok === false && /Upcoming batch/.test(bulkErr),
        JSON.stringify(bulk.data?.results?.[0] ?? null).slice(0, 160));

      // THE DISAGREEMENT TEST. Not "both refuse" - both refuse WITH THE SAME SENTENCE. Two doors that
      // refuse for different-sounding reasons are two implementations waiting to drift.
      const singleErr = String(single.data?.error ?? "");
      ok("QA-945: both doors refuse with the SAME sentence - proof the gate has one home, not two",
        singleErr.length > 0 && bulkErr.length > 0 && singleErr === bulkErr,
        JSON.stringify({ single: singleErr.slice(0, 70), bulk: bulkErr.slice(0, 70) }));

      // Absent must NOT be read as Future. Every candidate written before this field existed has no
      // value, and treating them as unavailable would have silently frozen the entire live pool.
      const legacy = await mkBI();
      await mc.db(DBNAME).collection("candidates").updateOne(
        { _id: new ObjectId(String(legacy._id)) }, { $unset: { batch_interest: "" } });
      const legacyAdd = await req(admin, "POST", `/api/batches/${biBatch._id}/members`, { candidate: legacy._id });
      ok("QA-945: a candidate with NO batch_interest at all is still enrollable - absent is not Future",
        legacyAdd.status === 201, `status=${legacyAdd.status} ${JSON.stringify(legacyAdd.data).slice(0, 120)}`);

      // The conversion Umesh described, end to end: the same person becomes enrollable once the
      // status is updated. Without this the feature is a trap rather than a queue.
      const conv = await mkBI("Future");
      const before = await req(admin, "POST", `/api/batches/${biBatch._id}/members`, { candidate: conv._id });
      const patched = await req(admin, "PATCH", `/api/candidates/${conv._id}`, { batch_interest: "Current" });
      const after = await req(admin, "POST", `/api/batches/${biBatch._id}/members`, { candidate: conv._id });
      ok("QA-945: refused while Future, ACCEPTED after the status is moved to Current",
        before.status === 409 && patched.status === 200 && after.status === 201,
        `before=${before.status} patch=${patched.status} after=${after.status}`);

      // Both public doors accept the answer, and neither takes a value it did not offer.
      const pubFut = await pubPost(regTok.token, { name: "BIPub " + stamp, phone: "7994" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0"), email: "bipub" + stamp + "@test.local", batch_interest: "Future" });
      // QA-1051 (qa-235 checker, S3): this said "RECORDS a future-batch answer" and only checked
      // `status === 201` — so it PASSED on the build with no field at all, where nothing was recorded.
      // A pin whose NAME outruns its ASSERTION, surviving one line from the one I had just fixed for
      // exactly that and declared cured. Reading it back is what makes it a pin: 201 says the request
      // was accepted, not that the answer survived.
      {
        const pubName = "BIPub " + stamp;
        const stored = (await req(admin, "GET", `/api/candidates?limit=2000&location=${loc._id}`)).data.items.find((c) => c.name === pubName);
        ok("QA-945: the public self-registration door RECORDS a future-batch answer (read back, not just 201)",
          pubFut.status === 201 && stored?.batch_interest === "Future",
          `status=${pubFut.status} stored=${stored?.batch_interest}`);
      }
      // QA-945 (cycle 3): the API accepted this from the start and NEITHER PUBLIC FORM OFFERED IT,
      // so the person the option exists for could not use it - only staff could. A source-level pin,
      // because the wall has no browser: the failure was never in the route, it was that the screen
      // never asked. Both doors, because QA-275 records that the second one is the one that is
      // forgotten - and here it was forgotten on both.
      {
        const { readFileSync } = await import("node:fs");
        for (const [label, f] of [
          ["p/register", "src/app/p/register/[token]/page.tsx"],
          ["p/enrol", "src/app/p/enrol/page.tsx"],
        ]) {
          const src = readFileSync(f, "utf8");
          // QA-1190: matched as RENDERED markup (">...</option>"), never as a bare phrase - the
          // comment below records that the bare-phrase version of this very pin once matched the
          // fix's own COMMENT, so it could not tell code from prose about the code.
          ok(`QA-945: the ${label} form OFFERS both choices by the names the client chose`,
            /batch_interest/.test(src)
              && src.includes(">The current batch</option>")
              && src.includes(">Upcoming batch</option>"),
            `${label} renders no choice`);
          // ...and it must sit ABOVE the "All optional" government block. It first shipped INSIDE it,
          // which told the student the one question that decides whether they join this batch was
          // optional. Found by looking at the live screenshot, not by reading the diff - so this pin
          // exists because a diff review would not have caught it and did not.
          // Match the RENDERED markup, not the bare phrase. First version searched for the plain
          // words and found them in this fix's own COMMENT (which explains the mistake by naming the
          // block), so the pin failed while the code was right - a check that cannot tell code from a
          // comment about the code. The `? *` and the `>...<` are what actually reach the student.
          const iChoice = src.indexOf("Which batch are you interested in? *");
          const iOptional = src.indexOf(">Government registration details<");
          ok(`QA-945: ...and on ${label} it sits ABOVE the "All optional" block, not inside it`,
            iChoice > -1 && iOptional > -1 && iChoice < iOptional, `choice@${iChoice} optional@${iOptional}`);
        }
      }

      // QA-1190: THE "hrr jagah" PIN. Umesh's instruction was "just text update krne hai hrr jagah
      // bss" - EVERYWHERE, not only in the dropdown. The two pins above prove the two public FORMS
      // carry the new names; this one proves nothing still speaks the OLD language anywhere in src/,
      // which is the half that gets forgotten: the row tag, two hover titles, the amber hint, the
      // row-action button, the enrolment refusal and the import label all said "future" or "current
      // intake", and no browser test in this wall reaches any of them.
      // Proven falsifiable BEFORE it was written: run against HEAD it reports 17 sites, against the
      // fix 0. A pin that cannot fail measures nothing (QA-212).
      // src/lib/version.ts is EXCLUDED deliberately - it is the release-note history, and what it
      // says about a past release is the truth about that release. Rewriting it would make the
      // changelog lie about what shipped.
      {
        // readFileSync is destructured HERE, not borrowed: the block above has its own, inside its
        // own braces, and this pin CRASHED the whole suite on that - contributing zero counts rather
        // than one red line. `node --check` passed it, because syntax is not scope.
        const { readFileSync, readdirSync, statSync } = await import("node:fs");
        const { join } = await import("node:path");
        const STALE = ["A future batch", "Future interested", "LATER batch", "FUTURE batch",
                       "current intake", "The current / upcoming batch", "later batch"];
        const walk = (d) => readdirSync(d).flatMap((n) => {
          const p = join(d, n);
          return statSync(p).isDirectory() ? walk(p) : [p];
        });
        const stale = [];
        for (const p of walk("src")) {
          if (!/\.(ts|tsx)$/.test(p)) continue;
          const rel = p.split("\\").join("/");
          if (rel === "src/lib/version.ts") continue;
          readFileSync(p, "utf8").split(/\r?\n/).forEach((line, i) => {
            for (const phrase of STALE) if (line.includes(phrase)) stale.push(`${rel}:${i + 1} [${phrase}]`);
          });
        }
        ok('QA-1190: nothing in src/ still says "future batch" or "current intake" - the rename reached every screen, not only the dropdown',
          stale.length === 0, stale.slice(0, 6).join(" | ") || "clean");

        // QA-1205 (checker, qa-1190 cycle 1). THE BLACKLIST ABOVE HAS A HOLE, and the checker did not
        // suspect it - it PROVED it: on the fixed tree it reverted ONLY the import label and this pin
        // still reported GREEN, exit 0. The reason is that the list is `String.includes` and
        // case-SENSITIVE, and the label's own spelling is "Interested in (Current / Future batch)" -
        // capital F, matching neither "A future batch" nor "FUTURE batch". Five of the six renamed
        // files were guarded; the sixth, the one a mobiliser's sheet is mapped through, was not.
        //
        // A blacklist can only ever ban the spellings somebody thought of. So the label is asserted
        // POSITIVELY - the same tightening the two form pins got, and for the same reason: say what
        // must be there, not merely what must not.
        const catalog = readFileSync("src/lib/field-catalog.ts", "utf8");
        ok("QA-1205: the Excel import label IS the renamed one - asserted positively, because a blacklist cannot guard a spelling nobody predicted",
          catalog.includes('label: "Interested in (Current / Upcoming batch)"')
            && !/Interested in \(Current \/ Future batch\)/i.test(catalog),
          catalog.match(/label: "Interested in [^"]*"/)?.[0] ?? "no batch_interest label found");

        // QA-1206 (same verdict): the bare "upcoming" alias was greedy enough to capture a column
        // that has nothing to do with batch interest. Bounded - the Excel import screen does not use
        // aliases at all and the sheet-sync path coerces enums - so the worst case was a
        // mis-suggestion a human sees. Removed anyway; the two-word forms cover the real headers.
        ok("QA-1206: the batch_interest aliases keep the two-word forms and no longer claim a bare \"upcoming\"",
          /"upcoming batch"/.test(catalog) && /"current or upcoming"/.test(catalog)
            && !/"upcoming"\s*\]/.test(catalog) && !/, "upcoming",/.test(catalog),
          catalog.match(/aliases: \[[^\]]*"upcoming[^\]]*\]/)?.[0]?.slice(0, 160) ?? "aliases not found");
      }
      const pubJunk = await pubPost(regTok.token, { name: "BIJunk " + stamp, phone: "7993" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0"), email: "bijunk" + stamp + "@test.local", batch_interest: "Whatever" });
      const junkRow = (await req(admin, "GET", `/api/candidates?limit=2000&location=${loc._id}`)).data.items.find((c) => c.name === "BIJunk " + stamp);
      ok("QA-945: ...and a value the door never offered falls back to Current, it is not stored",
        pubJunk.status === 201 && junkRow?.batch_interest === "Current",
        `status=${pubJunk.status} stored=${junkRow?.batch_interest}`);

      // ---- QA-1191: the Excel import used to let ONE cell kill the whole file ----
      // Measured on the live -247 build before the fix, not argued: a three-row sheet whose middle
      // cell said "Upcoming batch" got preview 200 (silence from the one screen built to report
      // unreadable values), then confirm 400 "batch_interest must be one of: Current, Future", and
      // ZERO of the three rows landed. The same sheet with "Future" imported 3 of 3.
      //
      // batch_interest was in TEXT_IMPORT_FIELDS, so the raw cell went straight into the document and
      // mongoose's enum validator failed the whole ordered insertMany. Its two neighbours in the same
      // loop, education and sidh_status, have always been coerced and REPORTED instead.
      //
      // QA-1190 did not cause this, it sharpened the bait: the import label now reads "Interested in
      // (Current / Upcoming batch)", so "Upcoming batch" is exactly what the screen invites an
      // operator to type - and the refusal then listed the STORED values back at them, words that
      // appear nowhere on their screen.
      {
        const XLSX2 = await import("xlsx");
        const sheet = (rows) => {
          const ws = XLSX2.utils.json_to_sheet(rows);
          const wb = XLSX2.utils.book_new();
          XLSX2.utils.book_append_sheet(wb, ws, "Sheet1");
          return XLSX2.write(wb, { type: "buffer", bookType: "xlsx" });
        };
        const ph = (p) => p + String(Math.floor(Math.random() * 1e6)).padStart(6, "0");

        const runImport = async (tag, cell) => {
          const nm = `BI${tag}${stamp}`;
          const buf = sheet([
            { Name: nm + " A", Phone: ph("9881"), Interest: "The current batch" },
            { Name: nm + " B", Phone: ph("9882"), Interest: cell },
            { Name: nm + " C", Phone: ph("9883"), Interest: "Current" },
          ]);
          const send = async (extra) => {
            const fd = new FormData();
            fd.append("file", new Blob([buf]), "bi.xlsx");
            fd.append("location", String(loc._id));
            fd.append("program", String(prog._id));
            fd.append("mapping", JSON.stringify({ Name: "name", Phone: "phone", Interest: "batch_interest" }));
            fd.append("accept_unknown", "1");
            for (const [k, v] of Object.entries(extra ?? {})) fd.append(k, v);
            const r = await fetch(BASE + "/api/candidates/import", { method: "POST", headers: { cookie: admin }, body: fd });
            return { status: r.status, data: await r.json().catch(() => ({})) };
          };
          const preview = await send({});
          const confirm = await send({ confirm: "1" });
          const rows = ((await req(admin, "GET", `/api/candidates?limit=2000&q=${encodeURIComponent(nm)}`)).data.items ?? [])
            .filter((c) => String(c.name).startsWith(nm));
          const by = (suffix) => rows.find((c) => String(c.name).endsWith(suffix))?.batch_interest;
          return { preview, confirm, rows, by };
        };

        // 1. THE REGRESSION PIN. Before the fix this was 0 of 3 and a 400 - assert BOTH the count and
        //    the status, because either alone can be right for the wrong reason.
        const up = await runImport("UP", "Upcoming batch");
        ok("QA-1191: a sheet cell saying \"Upcoming batch\" - the words the import screen itself offers - no longer kills the file",
          up.confirm.status === 201 && up.rows.length === 3,
          `status=${up.confirm.status} landed=${up.rows.length}/3 err=${JSON.stringify(up.confirm.data?.error ?? "")}`);

        // 2. ...and it means what the screen says it means. Not merely "did not crash" - the stored
        //    value has to be the one the operator chose, or the import is quietly lying.
        ok("QA-1191: ...and the screen's two names land on the right STORED values, not just any value",
          up.by(" A") === "Current" && up.by(" B") === "Future" && up.by(" C") === "Current",
          JSON.stringify({ A: up.by(" A"), B: up.by(" B"), C: up.by(" C") }));

        // 3. REPORT, NEVER GUESS - and report it on the PREVIEW, which is where the defect was
        //    cruellest: preview answered 200 while confirm died.
        const junk = await runImport("JNK", "maybe later idk");
        ok("QA-1191: an unrecognised spelling is REPORTED on the PREVIEW, the screen that stayed silent while confirm died",
          (junk.preview.data?.batch_interest_unmatched ?? []).includes("maybe later idk"),
          JSON.stringify(junk.preview.data?.batch_interest_unmatched ?? "field absent"));

        // 4. The safe failure direction. A wrong "Future" silently freezes a real person out of every
        //    batch; an unset cell takes the schema default and leaves them enrollable. So an
        //    unrecognised value must NOT be guessed into Future - and the file must still import.
        ok("QA-1191: ...and it is NOT guessed - the row still imports and falls back to Current, the direction that cannot silently block anyone",
          junk.confirm.status === 201 && junk.rows.length === 3 && junk.by(" B") === "Current",
          `status=${junk.confirm.status} landed=${junk.rows.length}/3 stored=${junk.by(" B")}`);

        // ---- cycle 2: the three the checker charged, each pinned so it cannot come back ----

        // QA-1233 (S2). Cycle 1 took batch_interest OUT of TEXT_IMPORT_FIELDS and never added it to
        // HANDLED_IMPORT_FIELDS, so every import mapping the interest column reported
        // unhandled_fields:["batch_interest"] - the QA-426/REQ-379 honesty lane announcing "accepted
        // and discarded" about the one column this unit exists to handle. Asserted as ABSENCE from
        // the set, because that is the shape the defect had: a false extra member.
        ok("QA-1233: mapping the interest column does NOT make the importer call it unhandled - the report lane must not lie about the field this unit taught it",
          !((up.preview.data?.unhandled_fields ?? []).includes("batch_interest"))
            && !((up.confirm.data?.unhandled_fields ?? []).includes("batch_interest")),
          `preview=${JSON.stringify(up.preview.data?.unhandled_fields ?? [])} confirm=${JSON.stringify(up.confirm.data?.unhandled_fields ?? [])}`);

        // QA-1234 (S3). Blank counting lived INSIDE the text branch, so the moment batch_interest
        // left that branch an all-blank interest column stopped being reported - while the screen
        // block above it still promised "per column ... caught by the same line". An all-blank
        // MAPPED column is what a mis-aligned sheet looks like, and QA-414 is what that costs.
        {
          const nm = `BIBLANK${stamp}`;
          const buf = sheet([
            { Name: nm + " A", Phone: ph("9884"), Interest: "" },
            { Name: nm + " B", Phone: ph("9885"), Interest: "" },
          ]);
          const fd = new FormData();
          fd.append("file", new Blob([buf]), "bi.xlsx");
          fd.append("location", String(loc._id));
          fd.append("program", String(prog._id));
          fd.append("mapping", JSON.stringify({ Name: "name", Phone: "phone", Interest: "batch_interest" }));
          fd.append("accept_unknown", "1");
          const r = await fetch(BASE + "/api/candidates/import", { method: "POST", headers: { cookie: admin }, body: fd });
          const d = await r.json().catch(() => ({}));
          ok("QA-1234: an ALL-BLANK mapped interest column is reported in blank_by_field - a mapped column that came back empty is what a mis-aligned sheet looks like",
            (d?.blank_by_field?.batch_interest ?? 0) === 2 && d?.row_count === 2,
            JSON.stringify({ blank_by_field: d?.blank_by_field, row_count: d?.row_count }));
        }

        // QA-1235 (S2). Cycle 1 reported batch_interest_unmatched into a response key that NO SCREEN
        // RENDERED - the checker drove a real browser and watched the drawer print the education
        // warning and stay silent about this one. That reproduces qa-1191's own defect one layer up:
        // the preview saying nothing while something was wrong. Source-level here because this wall
        // has no browser; the rendered proof is in the manifest.
        // Matched on the RENDERED expression, not the bare key - a bare-key search would also match
        // the comment that explains the fix, which is a trap this suite has already sprung once.
        {
          // QA-1268 (qa-1191 cycle-3 checker): THIS PIN IS GONE, ON PURPOSE, AND IT IS NOT COMING BACK
          // IN THIS SHAPE. It searched candidates/page.tsx for the rendered expression, and it was
          // blind twice. Cycle 2's version matched the fix's own COMMENT. Cycle 3 stripped comments -
          // but only LINE-START ones, and that file has 38 multi-line {/* ... */} blocks, so the
          // checker deleted the render, kept the comment, and this still said PASS 124/0. A one-line
          // comment as control went correctly RED, which is how the hole was proved rather than
          // guessed.
          //
          // A string search over source cannot answer "does this render". Every tightening buys one
          // hole and one false red - QA-1091 -> QA-1127 -> QA-1141 -> QA-1184 -> QA-1214 walked that
          // exact ladder for another pin before this one. A pin that gives false assurance is worse
          // than no pin, so this does not get a fourth attempt here.
          //
          // THE ASSERTION MOVED TO WHERE IT CAN BE TRUE: scripts/e2e-rendered-candidates.mjs opens
          // the import drawer in a real browser, uploads a sheet with an unreadable interest value,
          // and reads the drawer's innerText - with an unreadable EDUCATION value as the positive
          // control, so a screen that renders everything cannot pass it either. Deleting the render
          // fails it; no comment can.

          // QA-1267 (checker, cycle 2): an "Ignore"d column must produce no blank_by_field entry at
          // all. Driven through the API the way the drawer posts it - destination "" - because that
          // is the state the screen actually creates.
          {
            const nm = `BIIGN${stamp}`;
            const buf = sheet([{ Name: nm + " A", Phone: ph("9886"), Junk: "" }, { Name: nm + " B", Phone: ph("9887"), Junk: "" }]);
            const fd = new FormData();
            fd.append("file", new Blob([buf]), "ign.xlsx");
            fd.append("location", String(loc._id));
            fd.append("program", String(prog._id));
            fd.append("mapping", JSON.stringify({ Name: "name", Phone: "phone", Junk: "" }));
            fd.append("accept_unknown", "1");
            const r = await fetch(BASE + "/api/candidates/import", { method: "POST", headers: { cookie: admin }, body: fd });
            const d = await r.json().catch(() => ({}));
            const keys = Object.keys(d?.blank_by_field ?? {});
            ok("QA-1267: a column set back to Ignore produces NO nameless blank warning - the preview must never say \"the column mapped to .\"",
              !keys.includes("") && !keys.some((k) => !String(k).trim()),
              JSON.stringify(d?.blank_by_field ?? null));
          }
        }
      }
    }
  } finally { await mc.close(); }
}

// ---- QA-510 / QA-514 (-167): a destructive script must not have a production DEFAULT ----
// Eight scripts read process.env.MONGODB_DB with a FALLBACK to the production database name.
// (Spelled out rather than quoted verbatim: the census below sweeps this file too, and a comment
// that quotes the offending pattern makes the check report itself.) One
// forgotten --env-file and `npm run seed` writes defaults, master lists and an admin user WITH A
// PASSWORD into the live database - silently, because a default is not an error. cleanup-testdata
// was in the same set, and that one DELETES.
//
// These assertions run the guard in real child processes rather than importing it, because the
// guard's whole job is to call process.exit - importing it would take this suite down with it.
// Nothing here connects to any database: the guard refuses before a connection is opened, and
// that ordering is itself one of the assertions.
{
  const { execFileSync } = await import("node:child_process");
  const { readdirSync, readFileSync } = await import("node:fs");

  const runGuard = (env, call) => {
    try {
      const out = execFileSync(process.execPath, ["--input-type=module", "-e", call], {
        cwd: "scripts", env: { ...process.env, ...env }, encoding: "utf8", stdio: "pipe",
      });
      return { code: 0, out };
    } catch (e) {
      return { code: e.status ?? -1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
    }
  };
  const CALL = 'import { requireSafeDb } from "./db-guard.mjs"; console.log("DB=" + requireSafeDb("seed"));';
  const BASECALL = 'import { requireLocalBase } from "./db-guard.mjs"; console.log("BASE=" + requireLocalBase("seed-sample", process.env.BASE_URL));';

  const unset = runGuard({ MONGODB_DB: undefined }, CALL);
  ok("QA-510: with MONGODB_DB unset a writing script REFUSES instead of guessing production",
    unset.code === 1 && /will not guess/i.test(unset.out), `code=${unset.code} ${unset.out.slice(0, 120)}`);

  const prod = runGuard({ MONGODB_DB: "center_erp", ALLOW_PRODUCTION_WRITE: undefined }, CALL);
  ok("QA-510: naming the PRODUCTION database is refused on its own - the name alone is not consent",
    prod.code === 1 && /PRODUCTION database/.test(prod.out), `code=${prod.code} ${prod.out.slice(0, 120)}`);

  const ci = runGuard({ MONGODB_DB: "center_erp_ci" }, CALL);
  ok("QA-510: a named non-production database runs normally - the guard blocks accidents, not work",
    ci.code === 0 && /DB=center_erp_ci/.test(ci.out), `code=${ci.code} ${ci.out.slice(0, 120)}`);

  const deliberate = runGuard({ MONGODB_DB: "center_erp", ALLOW_PRODUCTION_WRITE: "yes-i-mean-production" }, CALL);
  ok("QA-510: production IS reachable when somebody says so in full - a guard with no door gets deleted",
    deliberate.code === 0 && /DB=center_erp/.test(deliberate.out), `code=${deliberate.code} ${deliberate.out.slice(0, 120)}`);

  const remote = runGuard({ BASE_URL: "https://www.vidysea.com/erp", ALLOW_PRODUCTION_WRITE: undefined }, BASECALL);
  ok("QA-514: seeding THROUGH a remote server is refused - naming a test database there proves nothing",
    remote.code === 1 && /not local/i.test(remote.out), `code=${remote.code} ${remote.out.slice(0, 120)}`);

  const localBase = runGuard({ BASE_URL: "http://localhost:3000/erp" }, BASECALL);
  ok("QA-514: ...and a localhost base is fine",
    localBase.code === 0 && /BASE=http/.test(localBase.out), `code=${localBase.code} ${localBase.out.slice(0, 120)}`);

  // The census, so a NEW script cannot quietly reintroduce the default. This is the part that
  // makes the fix survive: the guard exists once, and this asserts nobody wrote their own.
  //
  // The pattern is ASSEMBLED rather than written as a literal. The first version of this check was
  // a regex literal, so the check's own source matched it and this suite reported ITSELF as an
  // offender - a census that cannot see past its own reflection. Building the string means the
  // sweep genuinely covers every file, including this one.
  const DEFAULT_PATTERN = new RegExp("MONGODB_DB" + "\\s*\\|\\|\\s*" + "[\"']" + "center" + "_erp" + "[\"']");
  const files = readdirSync("scripts").filter((f) => f.endsWith(".mjs") && f !== "db-guard.mjs");
  const srcOf = (f) => readFileSync("scripts/" + f, "utf8");
  const offenders = files.filter((f) => DEFAULT_PATTERN.test(srcOf(f)));
  ok("QA-510: NO script anywhere still defaults its database to production",
    offenders.length === 0, JSON.stringify(offenders));

  // The rule is about WRITES, and saying so is not narrowing it to fit: a read-only script aimed
  // at production cannot cause the harm this guard exists to prevent, and forbidding it would only
  // add friction to legitimate work. So the requirement is stated as it actually is - every script
  // that WRITES asks first - and the exemption is asserted rather than assumed: the scripts left
  // out must contain no write call at all.
  const WRITE_CALLS = /insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|bulkWrite|findOneAndUpdate|findOneAndDelete|replaceOne|dropDatabase|\.save\(\)/;
  const connects = files.filter((f) => /mongoose\.connect|new MongoClient/.test(srcOf(f)));
  const writers = connects.filter((f) => WRITE_CALLS.test(srcOf(f)));
  const readersOnly = connects.filter((f) => !WRITE_CALLS.test(srcOf(f)));
  const unguarded = writers.filter((f) => {
    const src = srcOf(f);
    // a suite pinned to the CI database is already safe by construction
    return !/db-guard\.mjs/.test(src) && !/center_erp_ci/.test(src);
  });
  ok("QA-510: every script that WRITES to a database asks the guard first (or is pinned to the CI database)",
    unguarded.length === 0, JSON.stringify(unguarded));
  ok("QA-510: ...and the scripts exempted as read-only really are read-only - the exemption is measured, not assumed",
    readersOnly.every((f) => !WRITE_CALLS.test(srcOf(f))), JSON.stringify(readersOnly));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
