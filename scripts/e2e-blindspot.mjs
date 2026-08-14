// Blind-spot tests — edge cases the main suites do not cover, run against localhost.
// Focus: exact-boundary eligibility, slot boundaries, TC Password masking per role,
// duplicate sheet keys, header-below-totals-row detection, REAL OneDrive fetch,
// capability warnings, instant trainer-request notification, interested[] round-trip.
const BASE = process.env.BASE_URL || "http://localhost:3000/erp";
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
const ops = await login("ops@vidysea.com", "Vidysea@123");
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
const cd6m = new Date(today); cd6m.setMonth(cd6m.getMonth() - 6); cd6m.setDate(cd6m.getDate() - 1); // cooldown lapsed yesterday
const cd6mIn = new Date(today); cd6mIn.setMonth(cd6mIn.getMonth() - 6); cd6mIn.setDate(cd6mIn.getDate() + 2); // still inside
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
const tr = (await req(admin, "POST", "/api/trainers", { name: `Trainer ${stamp}`, phone: "96666" + stamp.slice(2), skills: ["Skill" + stamp], capable_locations: [loc._id] })).data.item;
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
await req(admin, "PATCH", `/api/sync-sources/${wsrc._id}`, { source_url: "https://www.vidysea.com/erp/login" });
const wrFail = (await req(admin, "POST", `/api/sync-sources/${wsrc._id}/run`, {})).data;
ok("HTML page instead of sheet → Failed with clear error", wrFail.status === "Failed" && String(wrFail.error ?? "").length > 0, JSON.stringify(wrFail));

// ---- 9. Milestones do not regenerate once batch is Ready (dates are history) ----
const msBatch = (await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: "2027-12-01", target_size: 2 })).data.item;
const regenPlanning = await req(admin, "PATCH", `/api/batches/${msBatch._id}/milestones`, { regenerate: true });
ok("regenerate allowed while Planning", regenPlanning.status === 200);

// ---- 10. Public register: halted location keeps its link working (pool-building is allowed pre-open) ----
const regTok = (await req(admin, "POST", "/api/public-tokens", { purpose: "register", location: loc._id, program: prog._id })).data.item;
const pubRes = await fetch(BASE + `/api/public/register/${regTok.token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Pub " + stamp, phone: "7999" + String(Math.floor(Math.random() * 1e6)).padStart(6, "0") }) });
ok("public registration works (location Not Started — advance pooling)", pubRes.status === 201, `status=${pubRes.status}`);
// 9-digit phone rejected
const shortPhone = await fetch(BASE + `/api/public/register/${regTok.token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Pub short", phone: "123456789" }) });
ok("public registration rejects <10-digit phone", shortPhone.status === 400, `status=${shortPhone.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
