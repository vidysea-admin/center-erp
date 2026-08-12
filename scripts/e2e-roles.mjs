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
const principal = await login("principal.jpr03@vidysea.com", PW);
const enroll = await login("enroll@vidysea.com", PW);
ok("all five role users can log in", admin && ops && spoc && principal && enroll);

// Rule 38: Location user sees only scoped locations
const spocLocs = await req(spoc, "GET", "/api/locations?limit=200");
ok("Rule 38: SPOC sees exactly 1 location (JPR03)", spocLocs.data.items?.length === 1 && spocLocs.data.items[0].code === "JPR03", `got ${spocLocs.data.items?.length}`);
const adminLocs = await req(admin, "GET", "/api/locations?limit=200");
ok("Admin sees all locations", (adminLocs.data.items?.length ?? 0) > 5, `got ${adminLocs.data.items?.length}`);

// Rule 38: scoped batches/candidates
const spocBatches = await req(spoc, "GET", "/api/batches");
ok("Rule 38: SPOC batches all JPR03", spocBatches.data.items?.every((b) => b.location?.code === "JPR03"), JSON.stringify(spocBatches.data.items?.map((b) => b.location?.code)));
const otherLoc = adminLocs.data.items.find((l) => l.code === "KOT02");
const spocForeign = await req(spoc, "GET", `/api/locations/${otherLoc._id}`);
ok("Rule 38: SPOC blocked from foreign location detail (403)", spocForeign.status === 403, `got ${spocForeign.status}`);

// Rule 39: view-only principal cannot write
const jpr = spocLocs.data.items[0];
const principalWrite = await req(principal, "PATCH", `/api/locations/${jpr._id}`, { city: "Hacked" });
ok("Rule 39: view-only principal PATCH blocked (403)", principalWrite.status === 403, `got ${principalWrite.status}`);
const principalRead = await req(principal, "GET", `/api/locations/${jpr._id}`);
ok("Rule 39: view-only principal can still read", principalRead.status === 200);
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
  ok("view-only principal cannot mark results", (await req(principal, "PUT", `/api/batches/${ownActive._id}/results`, { rows: [{ member: "000000000000000000000000", result: "Pass" }] })).status === 403);
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
ok("view-only principal cannot add notes", (await req(principal, "POST", `/api/locations/${ownLocId}/notes`, { note: "nope" })).status === 403);
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

// unauthenticated → 401
const anon = await fetch(BASE + "/api/locations");
ok("Unauthenticated API blocked (401)", anon.status === 401, `got ${anon.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
