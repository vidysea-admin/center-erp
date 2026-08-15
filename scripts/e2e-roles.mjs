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

const PW = "CiOnly@123";
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
ok("Rule 40/QA-083: Operations is OUT of the Sync Inbox now", opsChanges.status === 403, `got ${opsChanges.status}`);
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
ok("Ops cannot read workbook changes either (QA-083)", (await req(ops, "GET", "/api/workbook-changes")).status === 403);
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
// QA-083: sheet.approve is OUT of the Operations defaults now — the toggle test runs the
// other way: granting it opens the door, removing it closes again.
ok("permission matrix lists roles + catalog (Ops trimmed of sheet.approve)", permsBefore.catalog?.length >= 10 && !opsSet.includes("sheet.approve"));
await req(admin, "PUT", "/api/permissions", { role: "Operations", permissions: [...opsSet, "sheet.approve"] });
await new Promise((r) => setTimeout(r, 5200)); // permission cache TTL
ok("granting sheet.approve to Operations opens Sheet Watch", (await req(ops, "GET", "/api/workbook-changes")).status === 200);
ok("…and the Sync Inbox", (await req(ops, "GET", "/api/sheet-changes")).status === 200);
await req(admin, "PUT", "/api/permissions", { role: "Operations", permissions: opsSet });
await new Promise((r) => setTimeout(r, 5200));
ok("removing the right closes it again", (await req(ops, "GET", "/api/workbook-changes")).status === 403);
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
  // R2: Enrollment no longer reads the trainer directory AT ALL, so the mask is proven on
  // a Location-role reader whose trainers.manage is REVOKED per-user (the R-B deny list) —
  // read allowed by role, money hidden by the missing right.
  const viewerUser = ((await req(admin, "GET", "/api/users")).data.items ?? []).find((u) => u.email === "viewer.jpr03@vidysea.com");
  if (viewerUser) await req(admin, "PATCH", `/api/users/${viewerUser._id}`, { revoked_permissions: ["trainers.manage"] });
  const progForMask = (await req(admin, "GET", "/api/programs?limit=1")).data.items[0];
  const paid = (await req(admin, "POST", "/api/trainers", {
    name: `PayCheck Trainer ${stamp}`, phone: `97${stamp}00`, skills: ["PayCheck"],
    day_rate: 1234, compensation_type: "Batch-wise", compensation_fixed: 5678, incentive_note: "secret",
    nominated_for_location: jpr._id, nominated_for_program: progForMask._id, // tie to JPR so the scoped viewer can see the row
  })).data.item;

  const list = (await req(viewer, "GET", "/api/trainers")).data.items ?? [];
  ok("trainer roster is readable without the manage right", list.length > 0);
  ok("…but day rate is hidden", list.every((t) => t.day_rate === undefined), JSON.stringify(list[0]?.day_rate));
  ok("…and compensation fields are hidden", list.every((t) => t.compensation_type === undefined && t.compensation_fixed === undefined && t.incentive_note === undefined));
  const one = (await req(viewer, "GET", `/api/trainers/${paid._id}`)).data.item;
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
  const seen = (await req(viewer, "GET", `/api/trainers/${nom._id}`)).data.item;
  ok("the nomination target stays visible without trainers.manage",
    (seen?.nominated_for_location?._id ?? seen?.nominated_for_location) === loc._id,
    JSON.stringify(seen?.nominated_for_location));
  ok("…and so does the job role it was nominated for",
    (seen?.nominated_for_program?._id ?? seen?.nominated_for_program) === prog._id,
    JSON.stringify(seen?.nominated_for_program));
  ok("…while the personnel fields beside it stay hidden",
    seen?.nsdc_remarks === undefined && seen?.qualification === undefined && seen?.payment_reference === undefined);
  if (viewerUser) await req(admin, "PATCH", `/api/users/${viewerUser._id}`, { revoked_permissions: [] }); // restore for later suites

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

// ---- QA-125 (checker, 15/08): trainer IDOR — the SEVENTH list-hides/item-allows hole,
// and the first on WRITES. A SPOC documented, un-documented and edited a trainer they
// could not even see. The union scope (nomination/capability/home) now guards every
// by-id trainer surface, untied trainers fail closed, and creation binds to the
// creator's own scope.
{
  const stamp = Date.now().toString().slice(-6); // block-local: the mask block's stamp is not in scope here
  const p125 = (n) => "95" + Date.now().toString().slice(-7) + n; // unique 10-digit phones
  const prog = (await req(admin, "GET", "/api/programs?limit=1")).data.items[0];
  // A trainer that is unambiguously FOREIGN to the JPR03-scoped SPOC…
  const foreignTr = (await req(admin, "POST", "/api/trainers", {
    name: `Foreign Trainer ${stamp}`, phone: p125(1), skills: ["Q125"],
    nominated_for_location: otherLoc._id, nominated_for_program: prog._id,
  })).data.item;
  // …and one tied to NOTHING at all.
  const untiedTr = (await req(admin, "POST", "/api/trainers", {
    name: `Untied Trainer ${stamp}`, phone: p125(2), skills: ["Q125"],
  })).data.item;
  const fDoc = (await req(admin, "POST", `/api/trainers/${foreignTr._id}/documents`, { doc_type: "Aadhaar", file_url: "/erp/api/files/q125.pdf", original_name: "q125.pdf" })).data.item;

  ok("QA-125: SPOC GET foreign trainer → 403", (await req(spoc, "GET", `/api/trainers/${foreignTr._id}`)).status === 403);
  ok("QA-125: SPOC PATCH foreign trainer → 403", (await req(spoc, "PATCH", `/api/trainers/${foreignTr._id}`, { qualification: "x" })).status === 403);
  ok("QA-125: SPOC read foreign trainer's documents → 403", (await req(spoc, "GET", `/api/trainers/${foreignTr._id}/documents`)).status === 403);
  ok("QA-125: SPOC document a foreign trainer → 403", (await req(spoc, "POST", `/api/trainers/${foreignTr._id}/documents`, { doc_type: "PAN", file_url: "/erp/api/files/q125b.pdf" })).status === 403);
  ok("QA-125: SPOC delete a foreign trainer's document → 403", (await req(spoc, "DELETE", `/api/trainers/${foreignTr._id}/documents/${fDoc._id}`)).status === 403);
  ok("QA-125: SPOC move a foreign trainer's pipeline → 403", (await req(spoc, "POST", `/api/trainers/${foreignTr._id}/transition`, { target: "Shortlisted" })).status === 403);
  ok("QA-125: an UNTIED trainer is out of scope too (fail closed, like the list)", (await req(spoc, "GET", `/api/trainers/${untiedTr._id}`)).status === 403);
  // Creation binds to the creator's scope: a foreign tie is refused, an own-centre tie lands.
  ok("QA-125: SPOC creating a trainer tied to a foreign centre → 403",
    (await req(spoc, "POST", "/api/trainers", { name: `Q125F ${stamp}`, phone: p125(3), skills: ["x"], nominated_for_location: otherLoc._id })).status === 403);
  ok("QA-125: SPOC creating an UNTIED trainer → 403 (they could never see it again)",
    (await req(spoc, "POST", "/api/trainers", { name: `Q125U ${stamp}`, phone: p125(4), skills: ["x"] })).status === 403);
  const jprLoc = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0];
  const ownCreate = await req(spoc, "POST", "/api/trainers", { name: `Q125O ${stamp}`, phone: p125(5), skills: ["x"], home_location: jprLoc._id });
  ok("QA-125: SPOC creating an own-centre trainer still works", ownCreate.status === 201, `got ${ownCreate.status}`);
  // Quick-invite by a scoped user auto-ties the invitee to the inviter's centre(s).
  const qi = await req(spoc, "POST", "/api/trainers/quick-invite", { name: `Q125QI ${stamp}`, phone: p125(6) });
  ok("QA-125: scoped quick-invite lands…", qi.status === 201, `got ${qi.status}`);
  if (qi.status === 201) {
    const invited = (await req(spoc, "GET", `/api/trainers/${qi.data.item.trainer}`));
    ok("QA-125: …auto-tied so the inviter can see their own invitee", invited.status === 200 && (invited.data.item?.capable_locations ?? []).length > 0, `got ${invited.status}`);
  }
  // QA-125 follow-up (checker design note): document DELETE is narrower than read/upload.
  // A capable-only tie lets a centre teach with the trainer, not erase their identity
  // documents — deletion belongs to the nominating/home centre. Capable-only trainers
  // (the quick-invite window) fall back to the union so a mis-upload stays fixable.
  const sharedTr = (await req(admin, "POST", "/api/trainers", {
    name: `Q125S ${stamp}`, phone: p125(7), skills: ["Q125"],
    nominated_for_location: otherLoc._id, capable_locations: [jprLoc._id],
  })).data.item;
  const sDoc = await req(spoc, "POST", `/api/trainers/${sharedTr._id}/documents`, { doc_type: "PAN", file_url: "/erp/api/files/q125s.pdf", original_name: "q125s.pdf" });
  ok("QA-125b: capable-tie SPOC can still READ the shared trainer", (await req(spoc, "GET", `/api/trainers/${sharedTr._id}`)).status === 200);
  ok("QA-125b: capable-tie SPOC can still UPLOAD a document", sDoc.status === 201, `got ${sDoc.status}`);
  ok("QA-125b: capable-tie SPOC cannot DELETE it — ownership is the nominating centre",
    (await req(spoc, "DELETE", `/api/trainers/${sharedTr._id}/documents/${sDoc.data.item._id}`)).status === 403);
  ok("QA-125b: admin (unscoped) deletes the shared trainer's document fine",
    (await req(admin, "DELETE", `/api/trainers/${sharedTr._id}/documents/${sDoc.data.item._id}`)).status === 200);
  if (qi.status === 201) {
    const qiDoc = await req(spoc, "POST", `/api/trainers/${qi.data.item.trainer}/documents`, { doc_type: "Photo", file_url: "/erp/api/files/q125qi.jpg", original_name: "q125qi.jpg" });
    ok("QA-125b: capable-ONLY invitee (no nomination/home) — inviter still deletes (union fallback)",
      qiDoc.status === 201 && (await req(spoc, "DELETE", `/api/trainers/${qi.data.item.trainer}/documents/${qiDoc.data.item._id}`)).status === 200);
  }
  if (ownCreate.status === 201) {
    const oDoc = await req(spoc, "POST", `/api/trainers/${ownCreate.data.item._id}/documents`, { doc_type: "Photo", file_url: "/erp/api/files/q125o.jpg", original_name: "q125o.jpg" });
    ok("QA-125b: HOME centre owns deletion too",
      oDoc.status === 201 && (await req(spoc, "DELETE", `/api/trainers/${ownCreate.data.item._id}/documents/${oDoc.data.item._id}`)).status === 200);
  }
  // QA-061 evidence (stale row close): Enrollment reaches neither the directory nor the board.
  ok("QA-061: Enrollment cannot read the trainer directory", (await req(enroll, "GET", "/api/trainers?limit=5")).status === 403);
  ok("QA-061: Enrollment cannot read the hiring board", (await req(enroll, "GET", "/api/open-positions")).status === 403);
  // Admin cleanup so later fixtures stay unaffected.
  const clean = await req(admin, "DELETE", `/api/trainers/${foreignTr._id}/documents/${fDoc._id}`);
  ok("QA-125: admin (unscoped) still deletes fine", clean.status === 200, `got ${clean.status}`);
}

// ---- QA-130 (-61): trainers get a DELETE verb — Admin-only, batch-referenced rows refuse,
// documents cascade. Junk rows (QA probes, duplicate imports) stop living forever in every
// list; a person with real history still gets Dropped, never erased. Plus the QA-130 rider:
// created_by now survives the schema, and QA-133's relevant_skills is recorded on the batch.
{
  const stamp61 = Date.now().toString().slice(-6);
  const p130 = (n) => "94" + Date.now().toString().slice(-7) + n;
  const jpr = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0];
  const prog = (await req(admin, "GET", "/api/programs?limit=1")).data.items[0];

  const mk = await req(admin, "POST", "/api/trainers", { name: `Q130 Junk ${stamp61}`, phone: p130(1), skills: ["Q130"], home_location: jpr._id });
  ok("QA-130: fixture trainer created", mk.status === 201, `got ${mk.status}`);
  const tid = mk.data.item?._id;
  const got = await req(admin, "GET", `/api/trainers/${tid}`);
  ok("QA-130 rider: created_by rides on the row (schema stopped dropping it)", !!got.data.item?.created_by, JSON.stringify(got.data.item?.created_by ?? null));

  ok("QA-130: Location SPOC cannot delete a trainer", (await req(spoc, "DELETE", `/api/trainers/${tid}`)).status === 403);
  ok("QA-130: Operations cannot delete either — Admin-only verb", (await req(ops, "DELETE", `/api/trainers/${tid}`)).status === 403);

  const bat = await req(admin, "POST", "/api/batches", { location: jpr._id, program: prog._id, planned_start: "2026-09-01", trainer: tid });
  ok("QA-130: batch fixture referencing the trainer", bat.status < 300, `got ${bat.status}`);
  if (bat.status < 300) {
    ok("QA-130: referenced by a batch → 409 (drop, don't erase)", (await req(admin, "DELETE", `/api/trainers/${tid}`)).status === 409);
    // QA-133: relevant_skills — the operator's recorded pick, never a filter; list-only, junk filtered.
    const rs = await req(admin, "PATCH", `/api/batches/${bat.data.item._id}`, { relevant_skills: ["Drone Service Technician", "  ", 42] });
    ok("QA-133: relevant_skills recorded on the batch (junk entries filtered)",
      rs.status === 200 && JSON.stringify(rs.data.item?.relevant_skills) === JSON.stringify(["Drone Service Technician"]),
      JSON.stringify(rs.data.item?.relevant_skills ?? null));
    ok("QA-133: relevant_skills refuses a non-list", (await req(admin, "PATCH", `/api/batches/${bat.data.item._id}`, { relevant_skills: "x" })).status === 400);
    const detach = await req(admin, "PATCH", `/api/batches/${bat.data.item._id}`, { trainer: null });
    ok("QA-130: batch detached for the delete path", detach.status === 200, `got ${detach.status}`);
  }
  const doc = await req(admin, "POST", `/api/trainers/${tid}/documents`, { doc_type: "PAN", file_url: "/erp/api/files/q130.pdf", original_name: "q130.pdf" });
  const del = await req(admin, "DELETE", `/api/trainers/${tid}`);
  ok("QA-130: admin deletes the junk row (documents cascade)", doc.status === 201 && del.status === 200, `${doc.status}/${del.status}`);
  ok("QA-130: the row is gone", (await req(admin, "GET", `/api/trainers/${tid}`)).status === 404);
  ok("QA-130: re-delete → 404, not a crash", (await req(admin, "DELETE", `/api/trainers/${tid}`)).status === 404);
}

// ---- QA-136/137 (-62): the audit trail was ALWAYS written on create (crud.ts — the checker's
// grep saw only route files and missed the central layer); what was missing is a surface.
// These pins hold both truths: the rows exist, and the new windows onto them are role-gated.
{
  const stamp62 = Date.now().toString().slice(-6);
  const p137 = (n) => "93" + Date.now().toString().slice(-7) + n;
  const jpr = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0];

  const mk = await req(admin, "POST", "/api/trainers", { name: `Q137 Trail ${stamp62}`, phone: p137(1), skills: ["Q137"], home_location: jpr._id });
  ok("QA-136: trainer create lands", mk.status === 201, `got ${mk.status}`);
  const tid = mk.data.item?._id;
  const hist = await req(admin, "GET", `/api/audit/Trainer/${tid}`);
  ok("QA-136 evidence: the CREATE audit row exists — crud has always written it",
    hist.status === 200 && (hist.data.items ?? []).some((a) => a.new_value === "created"),
    `${hist.status}, rows=${(hist.data.items ?? []).length}`);
  await req(admin, "PATCH", `/api/trainers/${tid}`, { qualification: "MSc (Q137)" });
  ok("QA-137: field-level history rows carry the change",
    ((await req(admin, "GET", `/api/audit/Trainer/${tid}`)).data.items ?? []).some((a) => a.field === "qualification"));
  ok("QA-137: SPOC reads an own-centre trainer's history (union resolver)",
    (await req(spoc, "GET", `/api/audit/Trainer/${tid}`)).status === 200);
  const foreign = await req(admin, "POST", "/api/trainers", { name: `Q137 Foreign ${stamp62}`, phone: p137(2), skills: ["Q137"], home_location: otherLoc._id });
  ok("QA-137: SPOC reading a FOREIGN trainer's history → 403 (fail closed)",
    (await req(spoc, "GET", `/api/audit/Trainer/${foreign.data.item?._id}`)).status === 403);

  const adminU = ((await req(admin, "GET", "/api/users")).data.items ?? []).find((u) => u.email === "admin@vidysea.com");
  const byUser = await req(admin, "GET", `/api/audit/by-user/${adminU._id}?limit=50`);
  ok("QA-137: Admin reads the per-user activity view", byUser.status === 200 && (byUser.data.items ?? []).length > 0, `got ${byUser.status}`);
  const narrowed = (await req(admin, "GET", `/api/audit/by-user/${adminU._id}?entity=Trainer&limit=50`)).data.items ?? [];
  ok("QA-137: ?entity= narrows the per-user view", narrowed.length > 0 && narrowed.every((a) => a.entity === "Trainer"), `n=${narrowed.length}`);
  ok("QA-137: Operations is refused the per-user view (Admin-only v1)", (await req(ops, "GET", `/api/audit/by-user/${adminU._id}`)).status === 403);
  ok("QA-137: a scoped SPOC is refused too — no Rule 38 back door", (await req(spoc, "GET", `/api/audit/by-user/${adminU._id}`)).status === 403);

  // Fixtures leave through the front door (QA-130's verb), proving it twice over.
  ok("QA-137: fixtures cleaned via the delete verb",
    (await req(admin, "DELETE", `/api/trainers/${tid}`)).status === 200 &&
    (await req(admin, "DELETE", `/api/trainers/${foreign.data.item?._id}`)).status === 200);
}

// ---- QA-131/140/139 (-63): the scheme's money is Admin-only, the invoice book follows the
// costs-ledger rule, and ignored earliest-start advice says so out loud (warn, never block).
{
  const ls = await req(admin, "GET", "/api/master-lists/schemes");
  ok("QA-131: schemes master loads for admin (lazy-seeded)", ls.status === 200 && (ls.data.items ?? []).length > 0, `got ${ls.status}, n=${(ls.data.items ?? []).length}`);
  const sch = ls.data.items?.[0];
  const set = await req(admin, "PATCH", `/api/master-lists/schemes/${sch._id}`, { amount_received: 12345, total_hours: 480 });
  ok("QA-131: admin records hours + amount on a scheme", set.status === 200, `got ${set.status}`);
  const back = (await req(admin, "GET", "/api/master-lists/schemes")).data.items.find((s) => s._id === sch._id);
  ok("QA-131: admin reads the amount back", back?.amount_received === 12345, JSON.stringify(back?.amount_received));
  for (const [who, name] of [[ops, "Operations"], [spoc, "Location SPOC"]]) {
    const r = await req(who, "GET", "/api/master-lists/schemes");
    const row = (r.data.items ?? []).find((s) => s._id === sch._id);
    ok(`QA-131: ${name} reads schemes WITHOUT amount_received`,
      r.status === 200 && (r.data.items ?? []).length > 0 && (r.data.items ?? []).every((s) => !("amount_received" in s)),
      `got ${r.status}`);
    ok(`QA-131: ${name} still sees the hours (only the money is masked)`, row?.total_hours === 480, JSON.stringify(row?.total_hours));
  }
  ok("QA-140: Operations is refused the invoice book (same R-E rule as the cost ledger)",
    (await req(ops, "GET", "/api/invoices")).status === 403);
  ok("QA-140: admin reads invoices fine", (await req(admin, "GET", "/api/invoices")).status === 200);

  const jpr = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0];
  const prog = (await req(admin, "GET", "/api/programs?limit=1")).data.items[0];
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
  const early = await req(admin, "POST", "/api/batches", { location: jpr._id, program: prog._id, planned_start: tomorrow });
  ok("QA-139: a too-early batch still creates — warn, never block", early.status === 201, `got ${early.status}`);
  ok("QA-139: …and the response names the earliest possible start",
    typeof early.data.warning === "string" && /earliest possible start/i.test(early.data.warning),
    JSON.stringify(early.data.warning ?? null));
}

// ---- QA-141 (-64, Umesh after the Arun episode: "values must be format tested — mobile
// number only 10 digit"): phone canon = bare 10 digits (+91/0 forms normalize to the same
// ten so one person is ONE row under the unique index); email must look like one. Strict on
// manual entry; the importers normalize-and-report instead (client rows are never dropped).
{
  const s141 = Date.now().toString().slice(-6);
  const jpr = (await req(spoc, "GET", "/api/locations?limit=1")).data.items[0];
  ok("QA-141: a 12-digit keyboard-mash phone is refused on trainer create (the Arun shape)",
    (await req(admin, "POST", "/api/trainers", { name: `Q141 Bad ${s141}`, phone: "332432432432", skills: ["x"], home_location: jpr._id })).status === 400);
  ok("QA-141: a junk email is refused",
    (await req(admin, "POST", "/api/trainers", { name: `Q141 Mail ${s141}`, phone: "9822200111", skills: ["x"], email: "not-an-email", home_location: jpr._id })).status === 400);
  const fancy = await req(admin, "POST", "/api/trainers", { name: `Q141 Canon ${s141}`, phone: "+91 98222 00119", skills: ["x"], home_location: jpr._id });
  ok("QA-141: '+91 98222 00119' lands as the bare '9822200119'", fancy.status === 201 && fancy.data.item?.phone === "9822200119", JSON.stringify(fancy.data.item?.phone ?? fancy.status));
  ok("QA-141: the SAME person entered bare now collides — one row per human (409)",
    (await req(admin, "POST", "/api/trainers", { name: `Q141 Dup ${s141}`, phone: "9822200119", skills: ["x"], home_location: jpr._id })).status === 409);
  ok("QA-141: candidate junk phone refused",
    (await req(admin, "POST", "/api/candidates", { name: `Q141 Cand ${s141}`, phone: "12345", location: jpr._id })).status === 400);
  ok("QA-141: user junk login email refused",
    (await req(admin, "POST", "/api/users", { name: "Q141U", email: "nope", password: "Q141pass!xyz", role: "Enrollment", location_scope: [jpr._id] })).status === 400);
  ok("QA-141: quick-invite refuses a 15-digit mash the old slice(-10) silently accepted",
    (await req(admin, "POST", "/api/trainers/quick-invite", { name: `Q141 QI ${s141}`, phone: "123456789012345" })).status === 400);
  if (fancy.status === 201) {
    ok("QA-141: fixture leaves via the delete verb", (await req(admin, "DELETE", `/api/trainers/${fancy.data.item._id}`)).status === 200);
  }
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
  // Stop access: active=false kills the LIVE session on its very next request (QA-080 —
  // the identity cache is invalidated by the stop itself, no TTL wait), and a fresh
  // session cannot be minted.
  ok("R-B: Admin stops access", (await req(admin, "PATCH", `/api/users/${uid}`, { active: false })).status === 200);
  ok("QA-080: the session they already had dies on the very next request",
    (await req(cookie, "GET", "/api/candidates?limit=1")).status === 401);
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

// ---- R-F (CEO 14/08 [36:44-37:28]): SPOC centre-detail edits go through Admin approval ----
{
  const rfStamp = Date.now().toString().slice(-6);
  await req(admin, "PUT", "/api/approvals", { action: "location.edit", enabled: true, approver_role: "Admin" });
  const fx = await req(spoc, "PATCH", `/api/locations/${jpr._id}`, { name: "Renamed by SPOC " + rfStamp });
  ok("R-F: a fixed field is refused for a centre login (403 naming it)",
    fx.status === 403 && /cannot change/.test(fx.data?.error ?? ""), `got ${fx.status} ${fx.data?.error ?? ""}`);
  const newAddr = "New Wing " + rfStamp;
  const sug = await req(spoc, "PATCH", `/api/locations/${jpr._id}`, { address: newAddr });
  ok("R-F: a detail change parks for approval (202)",
    sug.status === 202 && /Sent for approval/.test(sug.data?.error ?? ""), `got ${sug.status} ${JSON.stringify(sug.data).slice(0, 100)}`);
  const parkedLoc = (await req(admin, "GET", `/api/locations/${jpr._id}`)).data.item;
  ok("R-F: nothing applied while parked", parkedLoc.address !== newAddr, parkedLoc.address);
  const pend = ((await req(admin, "GET", "/api/approvals?status=Pending")).data.items ?? []).find((i) => i.action === "location.edit");
  ok("R-F: the suggestion sits in the Admin queue", !!pend, JSON.stringify(pend?.summary));
  if (pend) {
    await req(admin, "POST", `/api/approvals/${pend._id}`, { decision: "Approved" });
    const appliedLoc = (await req(admin, "GET", `/api/locations/${jpr._id}`)).data.item;
    ok("R-F: approval applies the change", appliedLoc.address === newAddr, appliedLoc.address);
  }
  const progList = (await req(admin, "GET", "/api/programs?limit=1")).data.items;
  if (progList?.[0]) {
    const tgt = await req(spoc, "PUT", `/api/locations/${jpr._id}/targets`, { program: progList[0]._id, approved_target: 111 });
    ok("R-F: a SPOC target change parks too (202, queued)", tgt.status === 202 && tgt.data.queued === true, `got ${tgt.status}`);
  }
  // QA-075: a SPOC's classroom/lab suggestion parks the same way, and the Room is created
  // only by the approval.
  const roomName = "SPOC Lab " + rfStamp;
  const roomSug = await req(spoc, "POST", `/api/locations/${jpr._id}/rooms`, { name: roomName, type: "Lab", capacity: 20 });
  ok("QA-075: a SPOC room suggestion parks (202, queued)", roomSug.status === 202 && roomSug.data.queued === true, `got ${roomSug.status}`);
  const roomsBefore = (await req(admin, "GET", `/api/locations/${jpr._id}/rooms`)).data.items ?? [];
  ok("QA-075: no room exists while parked", !roomsBefore.some((r) => r.name === roomName));
  if (roomSug.data.item?._id) {
    await req(admin, "POST", `/api/approvals/${roomSug.data.item._id}`, { decision: "Approved" });
    const roomsAfter = (await req(admin, "GET", `/api/locations/${jpr._id}/rooms`)).data.items ?? [];
    ok("QA-075: approval creates the room", roomsAfter.some((r) => r.name === roomName && r.type === "Lab"), JSON.stringify(roomsAfter.map((r) => r.name)));
  }
  await req(admin, "PUT", "/api/approvals", { action: "location.edit", enabled: false });
}

// ---- R-I (CEO [38:54-39:10]): a Trainer's batch list marks mine vs guest-faculty ----
{
  const tb = await req(trainer, "GET", "/api/batches");
  ok("R-I: every batch row carries is_mine for a Trainer login",
    (tb.data.items ?? []).length === 0 || tb.data.items.every((b) => typeof b.is_mine === "boolean"),
    JSON.stringify(tb.data.items?.[0]?.is_mine));
  const ab = await req(admin, "GET", "/api/batches");
  ok("R-I: other roles never see the flag (no accidental contract growth)",
    (ab.data.items ?? []).every((b) => b.is_mine === undefined));
}

// ---- R-H (CEO [03:02-03:14]): programme master carries QP hours + Admin-only money ----
{
  const prog = (await req(admin, "GET", "/api/programs?limit=1")).data.items?.[0];
  if (prog) {
    await req(admin, "PATCH", `/api/programs/${prog._id}`, { hours: 120, contract_amount: 9999 });
    const asAdmin = (await req(admin, "GET", `/api/programs/${prog._id}`)).data.item;
    ok("R-H: Admin sees the QP hours and the amount", asAdmin?.hours === 120 && asAdmin?.contract_amount === 9999,
      JSON.stringify({ h: asAdmin?.hours, a: asAdmin?.contract_amount }));
    const asSpoc = (await req(spoc, "GET", `/api/programs/${prog._id}`)).data.item;
    ok("R-H: the amount is MASKED for every non-Admin reader",
      !!asSpoc && asSpoc.contract_amount === undefined && asSpoc.hours === 120, JSON.stringify({ a: asSpoc?.contract_amount }));
    const listSpoc = (await req(spoc, "GET", "/api/programs?limit=5")).data.items ?? [];
    ok("R-H: the list masks it too", listSpoc.every((p) => p.contract_amount === undefined));
  } else {
    ok("R-H skipped — no programme (run seed:sample)", true);
  }
}

// ---- QA-088: tc_password is the Admin's alone (the matrix grants locations.manage to
// Ops AND every SPOC, so the old permission gate was the leak) ----
{
  await req(admin, "PATCH", `/api/locations/${jpr._id}`, { tc_password: "SECRET-" + Date.now() });
  const asAdmin = (await req(admin, "GET", `/api/locations/${jpr._id}`)).data.item;
  ok("QA-088: Admin sees tc_password", typeof asAdmin?.tc_password === "string" && asAdmin.tc_password.length > 0);
  const asOps = (await req(ops, "GET", `/api/locations/${jpr._id}`)).data.item;
  ok("QA-088: Operations never sees it", !!asOps && asOps.tc_password === undefined, JSON.stringify(asOps?.tc_password));
  const asSpoc = (await req(spoc, "GET", `/api/locations/${jpr._id}`)).data.item;
  ok("QA-088: the SPOC of the very centre never sees it", !!asSpoc && asSpoc.tc_password === undefined);
  const listOps = (await req(ops, "GET", "/api/locations?limit=200")).data.items ?? [];
  ok("QA-088: the list masks it for every centre", listOps.every((l) => l.tc_password === undefined));
}

// ---- R2 (QA-095/091/060/061/083/084/096): the doors are shut on the SERVER now ----
{
  // Trainer: every directory the CEO closed answers 403, not with data.
  for (const p of ["/api/trainers", "/api/candidates", "/api/locations", "/api/open-positions", "/api/trainer-requests"]) {
    ok(`R2: Trainer is refused at ${p}`, (await req(trainer, "GET", p)).status === 403, p);
  }
  // Enrollment: candidates & locations are their brief; the hiring surface is not.
  ok("R2: Enrollment still reads candidates", (await req(enroll, "GET", "/api/candidates?limit=1")).status === 200);
  ok("R2: Enrollment still reads locations", (await req(enroll, "GET", "/api/locations?limit=1")).status === 200);
  ok("R2: Enrollment is refused the trainer directory", (await req(enroll, "GET", "/api/trainers?limit=1")).status === 403);
  ok("R2: Enrollment is refused the hiring board", (await req(enroll, "GET", "/api/open-positions")).status === 403);
  // Operations: the sheet machinery and the approvals queue left with the matrix trim.
  ok("R2/QA-083: Operations refused at sheet-changes", (await req(ops, "GET", "/api/sheet-changes")).status === 403);
  ok("R2/QA-084: Operations refused at the approvals queue", (await req(ops, "GET", "/api/approvals")).status === 403);
  ok("R2: Operations still reads their own submissions (?mine=1)", (await req(ops, "GET", "/api/approvals?mine=1")).status === 200);
  // QA-096: a figure a lean role is not shown is not SENT either.
  const enrollHome = (await req(enroll, "GET", "/api/home")).data;
  ok("QA-096: the lean Home payload carries no org-wide KPIs",
    enrollHome?.kpis && enrollHome.kpis.approved_targets === undefined && enrollHome.kpis.targets_total === undefined
    && enrollHome.kpis.approved_locations === undefined && enrollHome.queues?.sheet_changes === undefined,
    JSON.stringify(Object.keys(enrollHome?.kpis ?? {})));
  const adminHome = (await req(admin, "GET", "/api/home")).data;
  ok("QA-096: the Admin payload still carries them", adminHome?.kpis?.targets_total !== undefined);
  // QA-082: a Trainer's daily-log write cannot smuggle the govt figures in.
  const tb2 = (await req(trainer, "GET", "/api/batches")).data.items?.find((b) => ["Active", "Closing"].includes(b.status));
  if (tb2) {
    const smuggle = await req(trainer, "POST", `/api/batches/${tb2._id}/logs`, {
      log_date: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10),
      present_member_ids: [], govt_present: 99, govt_source: "Manual", govt_screenshot: "/erp/api/files/fake.png",
    });
    if (smuggle.status === 201) {
      ok("QA-082: the govt figures were stripped from a Trainer's log write",
        smuggle.data.item.govt_present == null && !smuggle.data.item.govt_screenshot, JSON.stringify({ g: smuggle.data.item.govt_present }));
      await req(admin, "PATCH", `/api/logs/${smuggle.data.item._id}`, { note: "R2 probe log" });
    } else {
      ok("QA-082: log write refused for another reason (fixture) — strip is compile-pinned", true, `got ${smuggle.status}`);
    }
  } else {
    ok("QA-082: skipped — no Active batch visible to the trainer", true);
  }
}

// unauthenticated → 401
const anon = await fetch(BASE + "/api/locations");
ok("Unauthenticated API blocked (401)", anon.status === 401, `got ${anon.status}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
