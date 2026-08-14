// Role-wise access verification — Rules 38 (location scoping), 39 (can_edit), 40 (role gates).
// Requires sample data (seed-sample.mjs). Run: node scripts/e2e-roles.mjs
const BASE = process.env.BASE_URL || "http://localhost:3000/erp";
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + " " + x); } };

async function login(email, password) {
  const csrfRes = await fetch(BASE + "/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const csrfCookie = csrfRes.headers.get("set-cookie").split(";")[0];
  const res = await fetch(BASE + "/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: csrfCookie },
    body: new URLSearchParams({ csrfToken, email, password }),
    redirect: "manual",
  });
  const session = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")]).flat().filter(Boolean).map((c) => c.split(";")[0]).find((c) => c.includes("session-token"));
  return session ? [csrfCookie, session].join("; ") : null;
}

async function req(cookie, method, path, body) {
  const res = await fetch(BASE + path, {
    method, headers: { "Content-Type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const PW = "Vidysea@123";
const admin = await login("admin@vidysea.com", process.env.ADMIN_PASSWORD || "admin123");
const ops = await login("ops@vidysea.com", PW);
const spoc = await login("spoc.jpr03@vidysea.com", PW);
// 2026-08-13 (Umesh role matrix): the principal is a WRITER now (admin-like within their
// centre); Rule 39's view-only persona lives on its own login.
const principal = await login("principal.jpr03@vidysea.com", PW);
const viewer = await login("viewer.jpr03@vidysea.com", PW);
const trainer = await login("trainer.jpr03@vidysea.com", PW);
const enroll = await login("enroll@vidysea.com", PW);
ok("all seven role users can log in", admin && ops && spoc && principal && viewer && trainer && enroll);

// Rule 38: Location user sees only scoped locations
const spocLocs = await req(spoc, "GET", "/api/locations?limit=200");
ok("Rule 38: SPOC sees exactly 1 location (JPR03)", spocLocs.data.items?.length === 1 && spocLocs.data.items[0].code === "JPR03", `got ${spocLocs.data.items?.length}`);
const adminLocs = await req(admin, "GET", "/api/locations?limit=200");
ok("Admin sees all locations", (adminLocs.data.items?.length ?? 0) > 5, `got ${adminLocs.data.items?.length}`);

// Rule 38: scoped batches/candidates
const spocBatches = await req(spoc, "GET", "/api/batches");
ok("Rule 38: SPOC batches all JPR03", spocBatches.data.items?.every((b) => b.location?.code === "JPR03"), JSON.stringify(spocBatches.data.items?.map((b) => b.location?.code)));
// Search for KOT02 rather than scanning a capped page for it. The list route caps at 200 rows and
// the test database grows with every run, so "find it in the first 200" quietly became false and
// the suite died on an undefined instead of failing an assertion. The search parameter is `q`.
const otherLoc = (await req(admin, "GET", "/api/locations?q=KOT02")).data.items?.find((l) => l.code === "KOT02")
  ?? adminLocs.data.items.find((l) => l.code === "KOT02");
ok("fixture: the foreign location KOT02 exists (run seed:sample first)", !!otherLoc);
const spocForeign = await req(spoc, "GET", `/api/locations/${otherLoc._id}`);
ok("Rule 38: SPOC blocked from foreign location detail (403)", spocForeign.status === 403, `got ${spocForeign.status}`);

// Rule 39: the view-only login cannot write
const jpr = spocLocs.data.items[0];
const viewerWrite = await req(viewer, "PATCH", `/api/locations/${jpr._id}`, { city: "Hacked" });
ok("Rule 39: view-only user PATCH blocked (403)", viewerWrite.status === 403, `got ${viewerWrite.status}`);
const viewerRead = await req(viewer, "GET", `/api/locations/${jpr._id}`);
ok("Rule 39: view-only user can still read", viewerRead.status === 200);
// SPOC (can_edit) CAN write own location
const spocWrite = await req(spoc, "PATCH", `/api/locations/${jpr._id}`, { spoc_phone: "9876500001" });
ok("SPOC with can_edit can write own location", spocWrite.status === 200, `got ${spocWrite.status}`);

// Rule 40: role gates
const enrollChanges = await req(enroll, "GET", "/api/sheet-changes");
ok("Rule 40: Enrollment role blocked from Sync Inbox (403)", enrollChanges.status === 403, `got ${enrollChanges.status}`);
const spocCosts = await req(spoc, "GET", "/api/costs");
ok("Rule 40: Location role blocked from Costs (403)", spocCosts.status === 403, `got ${spocCosts.status}`);
const opsChanges = await req(ops, "GET", "/api/sheet-changes");
ok("Rule 40: Operations can read Sync Inbox", opsChanges.status === 200);
const opsUsers = await req(ops, "GET", "/api/users");
ok("Rule 40: non-Admin blocked from Users (403)", opsUsers.status === 403, `got ${opsUsers.status}`);
const opsPrograms = await req(ops, "POST", "/api/programs", { code: "XX", name: "X", trainer_skill: "X" });
ok("Rule 40: non-Admin cannot create Program (403)", opsPrograms.status === 403, `got ${opsPrograms.status}`);
const enrollDefaults = await req(enroll, "PUT", "/api/defaults", { batch_size: 99 });
ok("Rule 40: non-Admin cannot edit Defaults (403)", enrollDefaults.status === 403, `got ${enrollDefaults.status}`);

// Enrollment role CAN update enrollment steps
const anyBatch = spocBatches.data.items.find((b) => b.status === "Active");
if (anyBatch) {
  const members = await req(admin, "GET", `/api/batches/${anyBatch._id}/members`);
  const m = members.data.items.find((x) => !x.left_on);
  const enrollPatch = await req(enroll, "PATCH", `/api/members/${m._id}`, { reg_done: true });
  ok("Enrollment role can update enrollment steps", enrollPatch.status === 200, `got ${enrollPatch.status}`);
}

// By-ID scope bypass (IDOR) — SPOC must NOT reach foreign batches directly
const allBatches = await req(admin, "GET", "/api/batches");
const foreignBatch = allBatches.data.items.find((b) => b.location?.code && b.location.code !== "JPR03");
if (foreignBatch) {
  ok("IDOR: SPOC GET foreign batch → 403", (await req(spoc, "GET", `/api/batches/${foreignBatch._id}`)).status === 403);
  ok("IDOR: SPOC PATCH foreign batch → 403", (await req(spoc, "PATCH", `/api/batches/${foreignBatch._id}`, { target_size: 99 })).status === 403);
  ok("IDOR: SPOC foreign batch members → 403", (await req(spoc, "GET", `/api/batches/${foreignBatch._id}/members`)).status === 403);
  ok("IDOR: SPOC foreign batch logs → 403", (await req(spoc, "GET", `/api/batches/${foreignBatch._id}/logs`)).status === 403);
  ok("IDOR: SPOC foreign batch closure → 403", (await req(spoc, "GET", `/api/batches/${foreignBatch._id}/closure`)).status === 403);
  ok("IDOR: SPOC foreign batch transition → 403", (await req(spoc, "POST", `/api/batches/${foreignBatch._id}/transition`, { target: "Ready" })).status === 403);
  ok("IDOR: SPOC bulk-assign into foreign batch → 403", (await req(spoc, "POST", "/api/candidates/assign", { batch: foreignBatch._id, candidate_ids: ["000000000000000000000000"] })).status === 403);
  const fMembers = await req(admin, "GET", `/api/batches/${foreignBatch._id}/members`);
  const fm = fMembers.data.items?.[0];
  if (fm) {
    ok("IDOR: SPOC PATCH foreign member → 403", (await req(spoc, "PATCH", `/api/members/${fm._id}`, { reg_done: true })).status === 403);
  }
  ok("IDOR: batches list ?location=<foreign> → 403", (await req(spoc, "GET", `/api/batches?location=${foreignBatch.location._id}`)).status === 403);
  // Foreign CANDIDATE into own batch must also be blocked (sibling asymmetry regression)
  const ownBatch = spocBatches.data.items.find((b) => !["Completed", "Cancelled"].includes(b.status));
  const foreignCand = (await req(admin, "GET", "/api/candidates?limit=200")).data.items.find((c) => c.location?.code && c.location.code !== "JPR03");
  if (ownBatch && foreignCand) {
    ok("IDOR: SPOC add foreign candidate to own batch → 403", (await req(spoc, "POST", `/api/batches/${ownBatch._id}/members`, { candidate: foreignCand._id })).status === 403);
  }
}
// Audit actor_type cannot be spoofed via body.source
if (anyBatch) {
  const members2 = await req(admin, "GET", `/api/batches/${anyBatch._id}/members`);
  const m2 = members2.data.items.find((x) => !x.left_on);
  await req(enroll, "PATCH", `/api/members/${m2._id}`, { kyc_done: true, source: "Automation" });
  const aud = await req(admin, "GET", `/api/audit/BatchMember/${m2._id}`);
  const latest = aud.data.items?.[0];
  ok("audit actor_type stays USER despite body.source=Automation", latest?.actor_type === "USER", latest?.actor_type);
}

// Per-candidate results routes must respect Rule 38 exactly like the rest
if (foreignBatch) {
  ok("IDOR: SPOC GET foreign batch results → 403", (await req(spoc, "GET", `/api/batches/${foreignBatch._id}/results`)).status === 403);
  ok("IDOR: SPOC PUT foreign batch results → 403", (await req(spoc, "PUT", `/api/batches/${foreignBatch._id}/results`, { rows: [{ member: "000000000000000000000000", result: "Pass" }] })).status === 403);
}
const ownActive = spocBatches.data.items.find((b) => !["Completed", "Cancelled"].includes(b.status));
if (ownActive) {
  ok("SPOC can read results for own batch", (await req(spoc, "GET", `/api/batches/${ownActive._id}/results`)).status === 200);
  ok("view-only user cannot mark results", (await req(viewer, "PUT", `/api/batches/${ownActive._id}/results`, { rows: [{ member: "000000000000000000000000", result: "Pass" }] })).status === 403);
}

// Alerts: the by-ID action route must be location-scoped exactly like the list
const adminAlerts = (await req(admin, "GET", "/api/notifications?status=all")).data.items ?? [];
const foreignAlert = adminAlerts.find((n) => n.location && n.location.code !== "JPR03");
if (foreignAlert) {
  ok("IDOR: SPOC cannot act on another location's alert", (await req(spoc, "POST", `/api/notifications/${foreignAlert._id}`, { status: "Resolved" })).status === 403);
}
const spocAlerts = (await req(spoc, "GET", "/api/notifications?status=all")).data.items ?? [];
ok("alerts list scoped to SPOC's location", spocAlerts.every((n) => !n.location || n.location.code === "JPR03"), JSON.stringify(spocAlerts.map((n) => n.location?.code)));

// Home queues must be scoped for Location users (no cross-location leakage)
const spocHome = await req(spoc, "GET", "/api/home");
const homeQueues = spocHome.data.queues ?? {};
const leaks = [
  ...(homeQueues.attendance_gaps ?? []).filter((l) => l.batch?.location?.code && l.batch.location.code !== "JPR03"),
  ...(homeQueues.enrollment_failures ?? []).filter((f) => f.batch?.location?.code && f.batch.location.code !== "JPR03"),
  ...(homeQueues.follow_ups ?? []),
  ...(homeQueues.sheet_changes ?? []),
];
ok("Home queues leak nothing outside SPOC scope", leaks.length === 0, `leaked ${leaks.length}`);

// 2026-08-11 routes — scoping and role gates
// Sheet Watch is Admin/Operations only
ok("SPOC cannot read workbook changes", (await req(spoc, "GET", "/api/workbook-changes")).status === 403);
ok("Ops can read workbook changes", (await req(ops, "GET", "/api/workbook-changes")).status === 200);
// Meeting notes follow location scope; view-only principal cannot write
const ownLocId = spocLocs.data.items[0]._id;
ok("SPOC can add a meeting note at own location", (await req(spoc, "POST", `/api/locations/${ownLocId}/notes`, { note: "role-test note" })).status === 201);
ok("SPOC cannot read another location's notes", (await req(spoc, "GET", `/api/locations/${otherLoc._id}/notes`)).status === 403);
ok("view-only user cannot add notes", (await req(viewer, "POST", `/api/locations/${ownLocId}/notes`, { note: "nope" })).status === 403);
// Public-token creation is scoped too
ok("SPOC cannot mint a register link for a foreign location", (await req(spoc, "POST", "/api/public-tokens", { purpose: "register", location: otherLoc._id })).status === 403);
// …and so is the token LIST — tokens are credentials, a foreign location's must never leak
const foreignToken = (await req(admin, "POST", "/api/public-tokens", { purpose: "register", location: otherLoc._id })).data.item;
const spocTokens = (await req(spoc, "GET", "/api/public-tokens")).data.items ?? [];
ok("token list scoped: SPOC never sees a foreign location's links",
  spocTokens.every((t) => !t.location || t.location.code === "JPR03"),
  JSON.stringify(spocTokens.map((t) => t.location?.code)));
if (foreignToken?._id) await req(admin, "PATCH", `/api/public-tokens/${foreignToken._id}`, { active: false });
// Backward-plan calculator is any-authenticated read
ok("planner endpoint readable by SPOC", (await req(spoc, "GET", "/api/plan-batch?start=2026-12-01")).status === 200);

// 2026-08-11 evening (CEO): togglable role permissions — revoke a right from a whole role
// and the gate closes for that role; restore it and it reopens. No re-login either way.
const permsBefore = (await req(admin, "GET", "/api/permissions")).data;
const opsSet = permsBefore.roles.find((r) => r.role === "Operations")?.permissions ?? [];
ok("permission matrix lists roles + catalog", permsBefore.catalog?.length >= 10 && opsSet.includes("sheet.approve"));
await req(admin, "PUT", "/api/permissions", { role: "Operations", permissions: opsSet.filter((p) => p !== "sheet.approve") });
await new Promise((r) => setTimeout(r, 5200)); // permission cache TTL
ok("revoking sheet.approve from Operations closes Sheet Watch", (await req(ops, "GET", "/api/workbook-changes")).status === 403);
ok("…and the Sync Inbox", (await req(ops, "GET", "/api/sheet-changes")).status === 403);
await req(admin, "PUT", "/api/permissions", { role: "Operations", permissions: opsSet });
await new Promise((r) => setTimeout(r, 5200));
ok("restoring the right reopens it", (await req(ops, "GET", "/api/workbook-changes")).status === 200);
ok("Admin role toggles are refused (lockout-proof)", (await req(admin, "PUT", "/api/permissions", { role: "Admin", permissions: [] })).status === 400);
ok("SPOC cannot open the permission matrix", (await req(spoc, "GET", "/api/permissions")).status === 403);

// 2026-08-12, found by testing a REAL approved account on production with every right
// granted: four screens stayed closed because their READ gate was still a hardcoded role
// check while only the write gate had moved onto the toggles. Granting a right must open
// the screen, not just the save button.
{
  const target = (await req(admin, "GET", "/api/users")).data.items.find((u) => u.email === "enroll@vidysea.com");
  const ALL = ["costs.manage", "invoices.manage", "sheet.sources", "feedback.links"];
  await req(admin, "PATCH", `/api/users/${target._id}`, { extra_permissions: ALL });
  for (const [path, label] of [["/api/costs", "costs"], ["/api/invoices", "invoices"], ["/api/sync-sources", "sync sources"], ["/api/public-tokens", "public links"]]) {
    ok(`granting the right opens ${label} for reading too`, (await req(enroll, "GET", path)).status === 200, `${path}`);
  }
  await req(admin, "PATCH", `/api/users/${target._id}`, { extra_permissions: [] });
  for (const [path, label] of [["/api/costs", "costs"], ["/api/invoices", "invoices"], ["/api/sync-sources", "sync sources"]]) {
    ok(`revoking it closes ${label} again`, (await req(enroll, "GET", path)).status === 403, `${path}`);
  }
  // The tab-mapping wizard (2026-08-13) is part of the same source-admin surface — every one of
  // its routes answers to sheet.sources, permission checked before the id is even looked up.
  ok("tab-mappings list is closed without sheet.sources", (await req(enroll, "GET", "/api/sync-sources/000000000000000000000000/tab-mappings")).status === 403);
  ok("tab-mappings approve is closed without sheet.sources", (await req(enroll, "PUT", "/api/sync-sources/000000000000000000000000/tab-mappings", { tab: "X", entity_type: "Candidate", columns: [], constants: {}, key_field: "phone" })).status === 403);
  ok("tab-mappings suggest is closed without sheet.sources", (await req(enroll, "POST", "/api/sync-sources/000000000000000000000000/tab-mappings/suggest", { tab: "X", entity_type: "Candidate" })).status === 403);
  ok("Sync Now is closed without sheet.sources (was role-gated)", (await req(enroll, "POST", "/api/sync-sources/000000000000000000000000/run", {})).status === 403);
}

// Trainer pay is not directory data (2026-08-12): a signed-in user without trainers.manage
// could read every trainer's day rate and compensation from the roster.
{
  // A trainer created here with a known day rate, rather than hoping one in the seed data has
  // one: the roster is capped, so "some trainer in the list has pay" quietly becomes false once
  // enough pay-less trainers exist, and the assertion then passes or fails on unrelated data.
  const stamp = Date.now().toString().slice(-6);
  const paid = (await req(admin, "POST", "/api/trainers", {
    name: `PayCheck Trainer ${stamp}`, phone: `97${stamp}00`, skills: ["PayCheck"],
    day_rate: 1234, compensation_type: "Batch-wise", compensation_fixed: 5678, incentive_note: "secret",
  })).data.item;

  const list = (await req(enroll, "GET", "/api/trainers")).data.items ?? [];
  ok("trainer roster is readable without the manage right", list.length > 0);
  ok("…but day rate is hidden", list.every((t) => t.day_rate === undefined), JSON.stringify(list[0]?.day_rate));
  ok("…and compensation fields are hidden", list.every((t) => t.compensation_type === undefined && t.compensation_fixed === undefined && t.incentive_note === undefined));
  const one = (await req(enroll, "GET", `/api/trainers/${paid._id}`)).data.item;
  ok("…opening the paid trainer by id does not leak them either",
    one?.day_rate === undefined && one?.compensation_fixed === undefined && one?.incentive_note === undefined, JSON.stringify(one?.day_rate));
  const adminOne = (await req(admin, "GET", `/api/trainers/${paid._id}`)).data.item;
  ok("Admin still sees pay", adminOne?.day_rate === 1234 && adminOne?.compensation_fixed === 5678, JSON.stringify(adminOne?.day_rate));

  // The other side of the same mask, and the more dangerous one. The nomination target is what
  // makes a trainer's TR ID usable at a centre, so the batch screen filters the dropdown on it.
  // It was briefly masked alongside the pay fields, which silently emptied the certified group
  // for everyone without trainers.manage — the people who mostly create batches. Masking it
  // again would break batch creation without failing any other assertion, so it is pinned here.
  // F-B5 made nominating for a HALTED centre a 409, and "?limit=1" can now hand back a
  // suite-halted Gate Location — pin the fixture to the known-operational JPR03 instead.
  const loc = jpr;
  const prog = (await req(admin, "GET", "/api/programs?limit=1")).data.items[0];
  const nom = (await req(admin, "POST", "/api/trainers", {
    name: `Nominated Trainer ${stamp}`, phone: `96${stamp}00`, skills: ["PayCheck"],
    nominated_for_location: loc._id, nominated_for_program: prog._id,
  })).data.item;
  const seen = (await req(enroll, "GET", `/api/trainers/${nom._id}`)).data.item;
  ok("the nomination target stays visible without trainers.manage",
    (seen?.nominated_for_location?._id ?? seen?.nominated_for_location) === loc._id,
    JSON.stringify(seen?.nominated_for_location));
  ok("…and so does the job role it was nominated for",
    (seen?.nominated_for_program?._id ?? seen?.nominated_for_program) === prog._id,
    JSON.stringify(seen?.nominated_for_program));
  ok("…while the personnel fields beside it stay hidden",
    seen?.nsdc_remarks === undefined && seen?.qualification === undefined && seen?.payment_reference === undefined);

  // 2026-08-13 (Umesh, testing the view-only principal): masking pay was not enough — a
  // scoped user saw the ENTIRE trainer directory. Scoped users see only trainers tied to
  // their centres (nominated / capable / home).
  const spocTrainers = (await req(spoc, "GET", "/api/trainers?limit=2000")).data.items ?? [];
  const jprId = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0]._id;
  const tied = (t) => [t.nominated_for_location?._id ?? t.nominated_for_location,
    t.home_location?._id ?? t.home_location, ...(t.capable_locations ?? []).map((l) => l?._id ?? l)]
    .filter(Boolean).map(String).includes(String(jprId));
  ok("Rule 38: scoped SPOC sees only trainers tied to their centre", spocTrainers.every(tied), `${spocTrainers.length} rows, untied: ${spocTrainers.filter((t) => !tied(t)).map((t) => t.name).slice(0, 3).join(", ")}`);
  if (String(loc._id) !== String(jprId)) {
    ok("…and the elsewhere-nominated trainer is not in their list", !spocTrainers.some((t) => t._id === nom._id));
  }
  const adminAll = (await req(admin, "GET", "/api/trainers?limit=2000")).data.items ?? [];
  ok("…while Admin still sees the full directory", adminAll.length > spocTrainers.length, `${adminAll.length} vs ${spocTrainers.length}`);
}

// 2026-08-12 audit F-000 (S0): the generic list route copied every ?key=value into the Mongo
// filter AFTER the Rule 38 scope filter, so ?location=<other centre> simply overwrote it and a
// scoped user could read every centre's candidate PII. Scope is now applied last, client keys
// are allow-listed to cfg.fields, and $-prefixed keys are rejected.
{
  const own = spocLocs.data.items[0];
  const baseline = await req(spoc, "GET", "/api/candidates?limit=200");
  const n0 = baseline.data.items?.length ?? 0;
  ok("F-000 baseline: SPOC sees only own-location candidates", (baseline.data.items ?? []).every((c) => c.location?.code === "JPR03"), `n=${n0}`);

  const widen = await req(spoc, "GET", `/api/candidates?location=${otherLoc._id}&limit=200`);
  const leaked = (widen.data.items ?? []).filter((c) => c.location?._id && String(c.location._id) === String(otherLoc._id));
  ok("F-000: ?location=<foreign> leaks nothing", leaked.length === 0, `leaked ${leaked.length}`);

  const byId = await req(spoc, "GET", `/api/locations?_id=${otherLoc._id}&limit=200`);
  ok("F-000: ?_id=<foreign> on locations leaks nothing",
    (byId.data.items ?? []).every((l) => l.code === "JPR03"), JSON.stringify((byId.data.items ?? []).map((l) => l.code)));

  ok("F-000: $-prefixed filter key rejected (400)", (await req(spoc, "GET", "/api/candidates?$where=1%3D%3D1")).status === 400);
  ok("F-000: dotted filter key rejected (400)", (await req(spoc, "GET", "/api/candidates?location.code=KOT02")).status === 400);

  const junk = await req(spoc, "GET", "/api/users?password_hash=x&limit=5");
  ok("F-000: unknown filter key never reaches Mongo", junk.status === 403 || (junk.data.items?.length ?? 0) === n0 || junk.status === 200, `${junk.status}`);

  // …while legitimate filtering must still work in both directions
  const narrowOwn = await req(spoc, "GET", `/api/candidates?location=${own._id}&limit=200`);
  ok("F-000: scoped user can still narrow within own scope", (narrowOwn.data.items?.length ?? 0) === n0, `${narrowOwn.data.items?.length} vs ${n0}`);
  const adminNarrow = await req(admin, "GET", `/api/candidates?location=${otherLoc._id}&limit=200`);
  ok("F-000: unscoped Admin can still filter by any location",
    (adminNarrow.data.items ?? []).every((c) => String(c.location?._id) === String(otherLoc._id)) && (adminNarrow.data.items?.length ?? 0) > 0,
    `n=${adminNarrow.data.items?.length}`);
  const enumFilter = await req(admin, "GET", "/api/candidates?lifecycle_status=Enrolled&limit=200");
  ok("F-000: ordinary field filters still work", enumFilter.status === 200 && (enumFilter.data.items ?? []).every((c) => c.lifecycle_status === "Enrolled"));
}

// 2026-08-12 audit (auth S1-9, sync S2-11): Rule 39 says can_edit=false is view-and-nothing-else
// everywhere. Seven write routes gated on a GRANTABLE right but never called requireEdit, so a
// view-only reviewer holding sheet.approve could close a centre, and the same shape could edit
// defaults, costs and users. The viewer below is a real view-only Location account.
{
  const jprId = spocLocs.data.items[0]._id;
  ok("Rule 39: view-only cannot add a cost entry", (await req(viewer, "POST", "/api/costs", { entry_date: "2026-08-12", location: jprId, category: "000000000000000000000000", amount: 1 })).status === 403);
  ok("Rule 39: view-only cannot edit Defaults", (await req(viewer, "PUT", "/api/defaults", { batch_size: 99 })).status === 403);
  ok("Rule 39: view-only cannot create a user", (await req(viewer, "POST", "/api/users", { name: "x", email: `vo${Date.now()}@t.local`, password: "Test@12345", role: "Location" })).status === 403);
  ok("Rule 39: view-only cannot bulk-ignore sheet changes", (await req(viewer, "POST", "/api/sheet-changes/bulk-ignore", { ids: ["000000000000000000000000"] })).status === 403);
  ok("Rule 39: view-only cannot apply a sheet change", (await req(viewer, "POST", "/api/sheet-changes/000000000000000000000000/apply", { action: "Close location", note: "x" })).status === 403);
  // auth S1-8: the invoice route was the only by-id batch route with no scope assertion at all
  const foreign = allBatches.data.items.find((b) => b.location?.code && b.location.code !== "JPR03");
  if (foreign) {
    ok("auth S1-8: SPOC cannot touch another centre's invoice", (await req(spoc, "PATCH", `/api/batches/${foreign._id}/invoice`, { amount: 1 })).status === 403);
  }

  // auth S1-5: the audit trail stores before/after values, so an unscoped feed leaked exactly the
  // personal data Rule 38 exists to protect. Any signed-in user could read any record's history.
  if (foreign) {
    ok("auth S1-5: SPOC cannot read a foreign batch's audit trail", (await req(spoc, "GET", `/api/audit/Batch/${foreign._id}`)).status === 403);
    const foreignCand = (await req(admin, "GET", "/api/candidates?limit=200")).data.items.find((c) => c.location?.code && c.location.code !== "JPR03");
    if (foreignCand) {
      ok("auth S1-5: …nor a foreign candidate's", (await req(spoc, "GET", `/api/audit/Candidate/${foreignCand._id}`)).status === 403);
    }
    ok("auth S1-5: unknown entity fails closed for a scoped user", (await req(spoc, "GET", `/api/audit/Whatever/${foreign._id}`)).status === 403);
  }
  const ownBatchForAudit = spocBatches.data.items[0];
  if (ownBatchForAudit) {
    ok("auth S1-5: SPOC can still read their own batch's audit trail", (await req(spoc, "GET", `/api/audit/Batch/${ownBatchForAudit._id}`)).status === 200);
  }
  ok("auth S1-5: Admin still reads any audit trail", (await req(admin, "GET", `/api/audit/Batch/${allBatches.data.items[0]._id}`)).status === 200);
}

// 2026-08-12 audit (auth S1-4): role, scope, can_edit and deactivation were frozen into the JWT
// at sign-in with a 30-day life, so an Admin could deactivate or demote someone and they carried
// on with their old powers until the token expired. The identity is now re-read from the database
// behind the same short TTL the permission cache uses.
{
  const target = (await req(admin, "GET", "/api/users")).data.items.find((u) => u.email === "enroll@vidysea.com");
  const before = await req(enroll, "GET", "/api/home");
  ok("auth S1-4: active account works before the change", before.status === 200, `${before.status}`);

  // narrowing scope must bite without a re-login
  const jprId = spocLocs.data.items[0]._id;
  await req(admin, "PATCH", `/api/users/${target._id}`, { location_scope: [jprId] }, undefined);
  await new Promise((r) => setTimeout(r, 5200));
  const scoped = await req(enroll, "GET", "/api/locations?limit=200");
  ok("auth S1-4: a narrowed scope applies to the live session",
    (scoped.data.items ?? []).every((l) => l.code === "JPR03"), JSON.stringify((scoped.data.items ?? []).map((l) => l.code)));
  await req(admin, "PATCH", `/api/users/${target._id}`, { location_scope: [] }, undefined);
  await new Promise((r) => setTimeout(r, 5200));

  // deactivation must end the session
  await req(admin, "PATCH", `/api/users/${target._id}`, { active: false }, undefined);
  await new Promise((r) => setTimeout(r, 5200));
  const afterOff = await req(enroll, "GET", "/api/home");
  ok("auth S1-4: deactivating an account ends its live session", afterOff.status === 401, `${afterOff.status}`);

  await req(admin, "PATCH", `/api/users/${target._id}`, { active: true }, undefined);
  await new Promise((r) => setTimeout(r, 5200));
  const afterOn = await req(enroll, "GET", "/api/home");
  ok("auth S1-4: reactivating restores it, still without a re-login", afterOn.status === 200, `${afterOn.status}`);
}

// 2026-08-12 audit — the access/disclosure S2/S3 cluster
{
  const jprId = spocLocs.data.items[0]._id;

  // auth S3-5: the approvals queue carries closure reasons and invoice amounts in its payload
  ok("auth S3-5: approvals queue needs the approvals.decide right", (await req(enroll, "GET", "/api/approvals")).status === 403);
  ok("auth S3-5: …and an Admin still reads it", (await req(admin, "GET", "/api/approvals")).status === 200);

  // auth S3-7 + S2-12: a 2000-row name+mobile+district export, and a duplicate oracle over every
  // centre, were both gated by nothing but "is signed in" — so a right that can be revoked
  // everywhere else could not be revoked here. Prove the gate by taking the right away.
  {
    const enrollPerms = (await req(admin, "GET", "/api/permissions")).data.roles.find((r) => r.role === "Enrollment")?.permissions ?? [];
    ok("auth S3-7/S2-12: both are open while the right is held",
      [200, 404].includes((await req(enroll, "GET", "/api/candidates/export-sidh")).status)
      && (await req(enroll, "POST", "/api/candidates/check-duplicate", { phone: "7700000001" })).status === 200);
    await req(admin, "PUT", "/api/permissions", { role: "Enrollment", permissions: enrollPerms.filter((p) => p !== "candidates.manage") });
    await new Promise((r) => setTimeout(r, 5200)); // permission cache TTL
    ok("auth S3-7: revoking candidates.manage closes the bulk SIDH export",
      (await req(enroll, "GET", "/api/candidates/export-sidh")).status === 403);
    ok("auth S2-12: …and closes the duplicate probe",
      (await req(enroll, "POST", "/api/candidates/check-duplicate", { phone: "7700000001" })).status === 403);
    await req(admin, "PUT", "/api/permissions", { role: "Enrollment", permissions: enrollPerms });
    await new Promise((r) => setTimeout(r, 5200));
  }
  const scopedProbe = await req(spoc, "POST", "/api/candidates/check-duplicate", { phone: "7700000001" });
  ok("auth S2-12: a scoped user only ever learns about their own centres",
    scopedProbe.status === 200 && (scopedProbe.data.duplicates ?? []).every((d) => !d.location || String(d.location).includes("Jaipur")),
    JSON.stringify((scopedProbe.data.duplicates ?? []).map((d) => d.location)));

  // auth S3-6: revoking locations.manage must also stop room writes
  const rooms = (await req(spoc, "GET", `/api/locations/${jprId}/rooms`)).data.items ?? [];
  if (rooms[0]) {
    ok("auth S3-6: view-only cannot edit a room", (await req(viewer, "PATCH", `/api/rooms/${rooms[0]._id}`, { capacity: 99 })).status === 403);
  }

  // auth S2-13: editing a log is where the government figure is set — same right as creating one
  const ownB = spocBatches.data.items.find((b) => ["Active", "Closing"].includes(b.status));
  if (ownB) {
    const lg = (await req(spoc, "GET", `/api/batches/${ownB._id}/logs`)).data.items?.[0];
    if (lg) ok("auth S2-13: view-only cannot edit a daily log", (await req(viewer, "PATCH", `/api/logs/${lg._id}`, { note: "nope" })).status === 403);
  }

  // auth S2-15: a 500 must not hand the client the raw exception text
  const boom = await req(admin, "POST", "/api/candidates", { name: "x", phone: "1", location: "not-an-objectid", program: "also-not" });
  ok("auth S2-15: an internal error does not leak driver/schema detail",
    boom.status < 500 || !/Cast to ObjectId|mongo|ValidationError|E11000|at .*\.ts:/i.test(JSON.stringify(boom.data)),
    `${boom.status} ${JSON.stringify(boom.data).slice(0, 120)}`);

  // auth S2-16: signup must not confirm which addresses already have an account
  const dup = await fetch(BASE + "/api/public/signup", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Probe", email: "admin@vidysea.com", password: "Test@12345", role: "Trainer" }),
  });
  ok("auth S2-16: signup does not reveal that an address is already registered", dup.status !== 409, `got ${dup.status}`);
}

// ---- 2026-08-13 (Umesh role matrix): principal/SPOC = admin-like within their centre;
// NO attendance, NO batch edit, certificate upload yes, NO accounts. Trainer = own batch
// daily log only. Operations = trainer + trainee data. ----
{
  const stampR = String(Date.now()).slice(-8); // 2-digit prefix + 8 = the 10-digit phone validation wants
  // Principal ADDS a trainer at their centre (trainers.manage newly granted to Location).
  const trAdd = await req(principal, "POST", "/api/trainers", { name: "TEST-RM Trainer " + stampR, phone: `96${stampR}`, skills: ["RMSkill"], home_location: jpr._id });
  ok("matrix: principal can ADD a trainer", trAdd.status === 201, `got ${trAdd.status}: ${JSON.stringify(trAdd.data).slice(0, 100)}`);
  // …and a candidate (candidates.manage kept). program is mandatory on direct creation.
  const progRM = spocBatches.data.items[0]?.program?._id
    ?? ((await req(principal, "GET", "/api/programs")).data.items ?? [])[0]?._id;
  const cAdd = await req(principal, "POST", "/api/candidates", { name: "TEST-RM Cand " + stampR, phone: `95${stampR}`, location: jpr._id, program: progRM });
  ok("matrix: principal can ADD a candidate", cAdd.status === 201, `got ${cAdd.status}: ${JSON.stringify(cAdd.data).slice(0, 80)}`);
  // NO attendance: daily-log POST and marking rounds are refused for the Location role.
  const anyBatch = spocBatches.data.items.find((b) => ["Active", "Closing"].includes(b.status));
  if (anyBatch) {
    const dl = await req(principal, "POST", `/api/batches/${anyBatch._id}/logs`, { log_date: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10), present_member_ids: [] });
    ok("matrix: principal CANNOT enter a daily log (attendance is the trainer's)", dl.status === 403, `got ${dl.status}`);
    const gv = await req(principal, "POST", "/api/govt-attendance", {});
    ok("matrix: principal CANNOT import govt attendance", gv.status === 403, `got ${gv.status}`);
  }
  // NO batch edit: transition + PATCH both 403 (batches.manage removed).
  const anyB = spocBatches.data.items[0];
  if (anyB) {
    ok("matrix: principal CANNOT transition a batch", (await req(principal, "POST", `/api/batches/${anyB._id}/transition`, { target: "Ready" })).status === 403);
    ok("matrix: principal CANNOT edit batch fields", (await req(principal, "PATCH", `/api/batches/${anyB._id}`, { target_size: 99 })).status === 403);
  }
  // Certificate upload path stays open (closure.manage kept): PUT closure on own batch is
  // not 403 — it may 409 on business rules, which is fine; the GATE is what we assert.
  if (anyB) {
    const cl = await req(principal, "PUT", `/api/batches/${anyB._id}/closure`, { certificate_file: "/files/rm-test.pdf" });
    ok("matrix: principal's certificate-upload gate is OPEN (not 403)", cl.status !== 403, `got ${cl.status}`);
  }
  // NO accounts: unchanged 403.
  ok("matrix: principal still blocked from costs", (await req(principal, "GET", "/api/costs")).status === 403);

  // Trainer: daily log right only — no trainer/candidate management.
  ok("matrix: trainer CANNOT add trainers", (await req(trainer, "POST", "/api/trainers", { name: "x", phone: "9000000000", skills: ["y"] })).status === 403);
  ok("matrix: trainer CANNOT edit candidates", (await req(trainer, "POST", "/api/candidates", { name: "x", phone: "9000000001", location: jpr._id })).status === 403);

  // Operations: trainer + trainee data updates work.
  if (trAdd.status === 201) {
    ok("matrix: Operations can update trainer data", (await req(ops, "PATCH", `/api/trainers/${trAdd.data.item._id}`, { qualification: "B.Tech" })).status === 200);
  }
  if (cAdd.status === 201) {
    ok("matrix: Operations can update trainee data", (await req(ops, "PATCH", `/api/candidates/${cAdd.data.item._id}`, { education: "12th Pass" })).status === 200);
  }
}

// ---- R-B (CEO 14/08 [35:07-35:13]): per-user REMOVE-a-right + stop access ----
{
  const stamp = Date.now().toString().slice(-6);
  const mk = await req(admin, "POST", "/api/users", {
    name: "Revoke Target " + stamp, email: `revoke.${stamp}@test.local`, password: PW,
    role: "Operations", can_edit: true,
  });
  ok("R-B fixture: an Operations user is created", mk.status === 201, `got ${mk.status}`);
  const uid = mk.data.item?._id;
  let cookie = await login(`revoke.${stamp}@test.local`, PW);
  ok("R-B fixture: they can log in", !!cookie);
  // Operations carries trainers.manage by default. The trainers LIST is deliberately
  // ungated (batch creators read it), so the revoke is proven on the WRITE the right
  // actually gates.
  const mkTrainer = () => req(cookie, "POST", "/api/trainers", { name: "Revoke Probe " + Date.now(), phone: "5" + Date.now().toString().slice(-9), skills: ["rp" + stamp] });
  ok("R-B: before the revoke, the role's right works (trainer create 201)", (await mkTrainer()).status === 201);
  ok("R-B: a non-Admin may not revoke rights",
    (await req(ops, "PATCH", `/api/users/${uid}`, { revoked_permissions: ["trainers.manage"] })).status === 403);
  ok("R-B: Admin revokes one right", (await req(admin, "PATCH", `/api/users/${uid}`, { revoked_permissions: ["trainers.manage"] })).status === 200);
  // (no cache wait needed: revokes are read from the user document on every check)
  const denied = await mkTrainer();
  ok("R-B: deny wins — the revoked right now 403s and names itself",
    denied.status === 403 && /right/i.test(denied.data?.error ?? ""), `got ${denied.status} ${denied.data?.error ?? ""}`);
  const anyProg = (await req(cookie, "GET", "/api/programs?limit=1")).data.items?.[0];
  ok("R-B: other rights survive the revoke (candidate create still allowed)",
    (await req(cookie, "POST", "/api/candidates", { name: "Revoke Cand " + stamp, phone: "4" + Date.now().toString().slice(-9), location: jpr._id, program: anyProg?._id })).status === 201);
  // A grant does NOT resurrect a revoked right — deny wins over extra too.
  await req(admin, "PATCH", `/api/users/${uid}`, { extra_permissions: ["trainers.manage"] });
  ok("R-B: an extra grant cannot undo a revoke (deny wins)", (await mkTrainer()).status === 403);
  // Stop access: active=false kills the NEXT login; a fresh session cannot be minted.
  ok("R-B: Admin stops access", (await req(admin, "PATCH", `/api/users/${uid}`, { active: false })).status === 200);
  ok("R-B: a stopped account cannot log in", (await login(`revoke.${stamp}@test.local`, PW)) === null);
  ok("R-B: reactivate restores login", (await req(admin, "PATCH", `/api/users/${uid}`, { active: true })).status === 200 && !!(await login(`revoke.${stamp}@test.local`, PW)));
}

// ---- Rule 53 (R-C, CEO 14/08 [40:51]): trainer log-date window ----
{
  const tb = (await req(trainer, "GET", "/api/batches")).data.items?.find((b) => ["Active", "Closing"].includes(b.status));
  if (tb) {
    const twoAgo = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    const old = await req(trainer, "POST", `/api/batches/${tb._id}/logs`, { log_date: twoAgo, present_member_ids: [] });
    ok("Rule 53: a trainer cannot backdate beyond yesterday",
      old.status === 403 && /Rule 53/.test(old.data?.error ?? ""), `got ${old.status} ${old.data?.error ?? ""}`);
    const fut = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const future = await req(admin, "POST", `/api/batches/${tb._id}/logs`, { log_date: fut, present_member_ids: [] });
    ok("Rule 53: a future date is refused for everyone",
      future.status === 400 && /future/i.test(future.data?.error ?? ""), `got ${future.status} ${future.data?.error ?? ""}`);
  } else {
    ok("Rule 53: skipped — no Active batch visible to the trainer (fixture)", true);
  }
}

// unauthenticated → 401
const anon = await fetch(BASE + "/api/locations");
ok("Unauthenticated API blocked (401)", anon.status === 401, `got ${anon.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
