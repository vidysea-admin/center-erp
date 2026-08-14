// Eval: Locations (targets, TC identity) + Admin (defaults, users) + the 2026-08-13 cost-entry
// edit surface. Admin → Defaults had TWO assertions in the whole baseline before this file.
import { ok, req, adminLogin, login, finish, stamp, phone, today } from "./e2e-lib.mjs";

const admin = await adminLogin();
const s = stamp("EL");

const prog = (await req(admin, "POST", "/api/programs", { code: s, name: "EvalLoc Prog " + s, trainer_skill: "ELSkill" + s }, 201)).data.item;
const loc = (await req(admin, "POST", "/api/locations", { code: "L" + s, name: "TEST-EvalLoc " + s, approval_status: "Approved", city: "Meerut" }, 201)).data.item;

// ---- targets: the new locations.manage gate (was requireEdit-only — audit 2026-08-13) ----
// enroll@ is unscoped with can_edit — exactly the shape that could rewrite approved targets before.
const enroll = await login("enroll@vidysea.com", "CiOnly@123");
if (enroll) {
  const r = await req(enroll, "PUT", `/api/locations/${loc._id}/targets`, { program: prog._id, approved_target: 999 });
  ok("[worst] approved targets refuse a can_edit user without locations.manage", r.status === 403, `got ${r.status}`);
}
// [best] the right holder sets a target; capacity math answers on read.
await req(admin, "PUT", `/api/locations/${loc._id}/targets`, { program: prog._id, approved_target: 120, trainers_required: 4 }, 200);
const targets = (await req(admin, "GET", `/api/locations/${loc._id}/targets`, undefined, 200)).data.items ?? [];
ok("[best] target upsert round-trip with trainers_required", targets[0]?.approved_target === 120 && targets[0]?.trainers_required === 4, JSON.stringify(targets[0]?.approved_target));
ok("[best] capacity math rides along (achieved/remaining)", targets[0]?.achieved && targets[0].achieved.remaining_by_enrolled === 120, JSON.stringify(targets[0]?.achieved));
// [avg] upsert means update, not duplicate.
await req(admin, "PUT", `/api/locations/${loc._id}/targets`, { program: prog._id, approved_target: 140 }, 200);
const targets2 = (await req(admin, "GET", `/api/locations/${loc._id}/targets`, undefined, 200)).data.items ?? [];
ok("[avg] re-PUT updates the same row (no duplicate target)", targets2.length === 1 && targets2[0].approved_target === 140, `${targets2.length} rows`);
// [worst] a target for a nonexistent program is refused.
await req(admin, "PUT", `/api/locations/${loc._id}/targets`, { program: "000000000000000000000000", approved_target: 10 }, 400);

// ---- 2026-08-13 (Manish: "31 approved hain, 10 nahi"): approval is per centre×job-role ----
await req(admin, "PUT", `/api/locations/${loc._id}/targets`, { program: prog._id, tc_id: "TCROW" + s, tc_status: "Approved" }, 200);
const tRow = ((await req(admin, "GET", `/api/locations/${loc._id}/targets`, undefined, 200)).data.items ?? [])[0];
ok("[best] per-job-role TC id + status round-trip on the target", tRow?.tc_id === "TCROW" + s && tRow?.tc_status === "Approved", JSON.stringify({ id: tRow?.tc_id, st: tRow?.tc_status }));
// [best] readiness must READ the per-row TC, not only the centre-level one: blank the centre's
// own TC and the row must stay unblocked on TC grounds because its own row is approved.
await req(admin, "PATCH", `/api/locations/${loc._id}`, { tc_status: "Pending" }, 200);
const rdy = ((await req(admin, "GET", `/api/mapping/readiness?location=${loc._id}`, undefined, 200)).data.items ?? [])
  .find((r) => String(r.program?._id) === String(prog._id));
ok("[best] readiness prefers the target's own TC status over the centre's", !(rdy?.blockers ?? []).some((b) => /TC status/.test(b)),
  JSON.stringify(rdy?.blockers).slice(0, 160));
ok("[avg] …and surfaces that row's own TC id", rdy?.location?.tc_id === "TCROW" + s, String(rdy?.location?.tc_id));
// [avg] the locations LIST carries scheme + job-role approval counts for the new columns.
const locRow = ((await req(admin, "GET", "/api/locations?limit=2000", undefined, 200)).data.items ?? []).find((l) => String(l._id) === String(loc._id));
ok("[avg] locations list exposes job_roles + schemes + approved_job_roles", Array.isArray(locRow?.job_roles) && Array.isArray(locRow?.schemes) && typeof locRow?.approved_job_roles === "number",
  JSON.stringify({ jr: locRow?.job_roles?.length, s: locRow?.schemes, a: locRow?.approved_job_roles }));

// ---- 2026-08-13 (OneDrive sheet-format cycle): sheet claims stored beside OUR live counts ----
// [best] the sheet's three claimed trainer counts round-trip through the targets PUT.
await req(admin, "PUT", `/api/locations/${loc._id}/targets`, { program: prog._id, nominations_received_reported: 3, nominated_nsdc_reported: 2, trainers_certified_reported: 1 }, 200);
const tClaim = ((await req(admin, "GET", `/api/locations/${loc._id}/targets`, undefined, 200)).data.items ?? [])[0];
ok("[best] sheet-claimed trainer counts round-trip on the target", tClaim?.nominations_received_reported === 3 && tClaim?.nominated_nsdc_reported === 2 && tClaim?.trainers_certified_reported === 1,
  JSON.stringify({ n: tClaim?.nominations_received_reported, d: tClaim?.nominated_nsdc_reported, c: tClaim?.trainers_certified_reported }));

// [best] the list join carries the sheet-format rollups the one-row-per-centre table renders.
const fetchRow = async () => ((await req(admin, "GET", "/api/locations?limit=2000", undefined, 200)).data.items ?? []).find((l) => String(l._id) === String(loc._id));
const locRow2 = await fetchRow();
ok("[best] list rollups: total target + trainer required + claimed certified", locRow2?.total_target === 140 && locRow2?.trainers_required_total === 4 && locRow2?.trainers_certified_reported_total === 1,
  JSON.stringify({ t: locRow2?.total_target, req: locRow2?.trainers_required_total, cert: locRow2?.trainers_certified_reported_total }));
ok("[avg] list carries the distinct per-row TC ids", (locRow2?.tc_ids ?? []).includes("TCROW" + s), JSON.stringify(locRow2?.tc_ids));
ok("[avg] before any trainer exists the LIVE count is an honest zero", locRow2?.trainers_certified_total === 0, String(locRow2?.trainers_certified_total));

// [best] OUR count is DERIVED — certifying a nominated trainer moves the list the moment the
// pipeline does (Umesh: "jaise-jaise trainer approve honge, count update ho jana chahiye").
// Created at TOT In Progress (a legal creation state) so ONE legal transition reaches
// Certified — TRAINER_FLOW forbids jumping there from Applied, by design.
const trEl = (await req(admin, "POST", "/api/trainers", { name: "TEST-EL Trainer " + s, phone: phone("97"), skills: ["ELSkill" + s], nominated_for_location: loc._id, nominated_for_program: prog._id, pipeline_status: "TOT In Progress" }, 201)).data.item;
const locRowMid = await fetchRow();
ok("[avg] a nominated-but-uncertified trainer counts as nominated, not certified", locRowMid?.trainers_certified_total === 0 && locRowMid?.trainers_nominated_total === 1,
  JSON.stringify({ cert: locRowMid?.trainers_certified_total, nom: locRowMid?.trainers_nominated_total }));
await req(admin, "POST", `/api/trainers/${trEl._id}/transition`, { target: "Certified", payload: { tr_id: "TREL" + s } }, 200);
const locRow3 = await fetchRow();
ok("[best] certifying the nominated trainer bumps the live count by exactly 1", locRow3?.trainers_certified_total === 1 && locRow3?.job_roles?.[0]?.trainers_certified === 1,
  JSON.stringify({ total: locRow3?.trainers_certified_total, row: locRow3?.job_roles?.[0]?.trainers_certified }));
ok("[avg] …while the sheet's claim stays its own separate column, never merged", locRow3?.trainers_certified_reported_total === 1, String(locRow3?.trainers_certified_reported_total));

// ---- Open Positions (CEO 13/08: "kahan-kahan trainer hire karne hain; required poore
// hote hi position apne aap Closed") — derived, never stored ----
{
  const pos = (await req(admin, "GET", "/api/open-positions", undefined, 200)).data.items ?? [];
  const mine = pos.find((p) => String(p.location?._id) === String(loc._id) && String(p.program?._id) === String(prog._id));
  ok("[best] approved centre×job-role appears as a position", !!mine, `${pos.length} rows`);
  ok("[best] position math: required 4 · certified 1 · balance 3 · Open",
    mine?.required === 4 && mine?.certified === 1 && mine?.balance === 3 && mine?.status === "Open",
    JSON.stringify({ r: mine?.required, c: mine?.certified, b: mine?.balance, s: mine?.status }));
  // Drop the requirement to 1 — certified (1) now meets it — the position must self-close.
  await req(admin, "PUT", `/api/locations/${loc._id}/targets`, { program: prog._id, trainers_required: 1 }, 200);
  const pos2 = (await req(admin, "GET", "/api/open-positions", undefined, 200)).data.items ?? [];
  const mine2 = pos2.find((p) => String(p.location?._id) === String(loc._id));
  ok("[best] position auto-CLOSES the moment certified meets required", mine2?.status === "Closed" && mine2?.balance === 0,
    JSON.stringify({ s: mine2?.status, b: mine2?.balance }));
  await req(admin, "PUT", `/api/locations/${loc._id}/targets`, { program: prog._id, trainers_required: 4 }, 200); // restore
  // Only per-row-APPROVED targets qualify: flip the row's TC verdict off and it vanishes.
  await req(admin, "PUT", `/api/locations/${loc._id}/targets`, { program: prog._id, tc_status: "Pending" }, 200);
  const pos3 = (await req(admin, "GET", "/api/open-positions", undefined, 200)).data.items ?? [];
  ok("[worst] a non-approved row is NOT an open position", !pos3.some((p) => String(p.location?._id) === String(loc._id)), `${pos3.length} rows`);
  await req(admin, "PUT", `/api/locations/${loc._id}/targets`, { program: prog._id, tc_status: "Approved" }, 200); // restore
}

// ---- TC identity fields (the govt portal credentials the sheet carries) ----
await req(admin, "PATCH", `/api/locations/${loc._id}`, { district: "Meerut", tc_id: "TC" + s, tc_status: "Approved", tc_password: "secret-" + s, operating_partner: "Vidysea", cluster_head_name: "TEST-EL Head", cluster_head_phone: phone("70") }, 200);
const asAdmin = (await req(admin, "GET", `/api/locations/${loc._id}`, undefined, 200)).data.item;
ok("[best] TC fields round-trip for the right holder", asAdmin.tc_id === "TC" + s && asAdmin.tc_status === "Approved" && asAdmin.tc_password === "secret-" + s, JSON.stringify({ id: asAdmin.tc_id, st: asAdmin.tc_status }));
if (enroll) {
  const asEnroll = (await req(enroll, "GET", `/api/locations/${loc._id}`, undefined, 200)).data.item;
  ok("[worst] tc_password is stripped for readers without locations.manage", asEnroll.tc_password === undefined, JSON.stringify(asEnroll.tc_password));
  ok("[avg] …but the non-secret TC fields stay readable", asEnroll.tc_id === "TC" + s, asEnroll.tc_id);
}

// ---- Defaults: write-validation + the retention knob ----
const before = (await req(admin, "GET", "/api/defaults", undefined, 200)).data.item;
// [worst] writes are gated by the togglable right.
if (enroll) await req(enroll, "PUT", "/api/defaults", { min_age: 21 }, 403);
// [best] a real write persists and only touches the named field.
await req(admin, "PUT", "/api/defaults", { snapshot_retention_per_tab: 42 }, 200);
const mid = (await req(admin, "GET", "/api/defaults", undefined, 200)).data.item;
ok("[best] defaults write persists the named field", mid.snapshot_retention_per_tab === 42, String(mid.snapshot_retention_per_tab));
ok("[best] …without disturbing its neighbours", mid.min_age === before.min_age && mid.batch_size === before.batch_size, JSON.stringify({ min_age: mid.min_age }));
// [worst] an unknown field is ignored, never stored.
await req(admin, "PUT", "/api/defaults", { not_a_real_default: 1 }, 200);
const junk = (await req(admin, "GET", "/api/defaults", undefined, 200)).data.item;
ok("[worst] unknown defaults key is dropped", junk.not_a_real_default === undefined);
// restore
await req(admin, "PUT", "/api/defaults", { snapshot_retention_per_tab: before.snapshot_retention_per_tab ?? 100 }, 200);

// ---- users lifecycle ----
const uEmail = `eval.user.${s}@vidysea-test.local`;
const mk = await req(admin, "POST", "/api/users", { name: "TEST-EL User " + s, email: uEmail, password: "CiOnly@123", role: "Location", location_scope: [loc._id] }, 201);
const uid = mk.data.item?._id;
// [best] the fresh scoped user can sign in and sees only their centre.
const fresh = await login(uEmail, "CiOnly@123");
ok("[best] admin-created user can sign in", !!fresh);
if (fresh) {
  const locs = (await req(fresh, "GET", "/api/locations?limit=2000", undefined, 200)).data;
  ok("[best] scoped user sees exactly their one centre", locs.items.length === 1 && String(locs.items[0]._id) === String(loc._id), `${locs.items.length} centres`);
}
// [worst] password hash never leaves the API.
const listed = (await req(admin, "GET", "/api/users", undefined, 200)).data.items ?? [];
ok("[worst] user list never carries password_hash", listed.every((u) => u.password_hash === undefined));
// [avg] deactivation flips the flag (JWT staleness is e2e-roles territory).
await req(admin, "PATCH", `/api/users/${uid}`, { active: false }, 200);
const offRow = ((await req(admin, "GET", "/api/users", undefined, 200)).data.items ?? []).find((u) => String(u._id) === String(uid));
ok("[avg] deactivated user shows active=false", offRow?.active === false, JSON.stringify(offRow?.active));

// ---- 15/08 (Umesh): user DROP — soft, terminal, email freed for a fresh account ----
{
  // lowercase on purpose: the schema lowercases emails, and the drop asserts compare strings.
  const dEmail = `eval.drop.${s.toLowerCase()}@vidysea-test.local`;
  const d1 = (await req(admin, "POST", "/api/users", { name: "TEST-EL Drop " + s, email: dEmail, password: "CiOnly@123", role: "Location", location_scope: [loc._id] }, 201)).data.item;
  ok("T3: drop fixture signs in before the drop", !!(await login(dEmail, "CiOnly@123")));
  // Non-admin cannot drop (the Admin-only privilege guard fires).
  const enrollDeny = await req(enroll, "PATCH", `/api/users/${d1._id}`, { drop: true });
  ok("T3: a non-admin cannot drop anyone", enrollDeny.status === 403, `got ${enrollDeny.status}`);
  // Admin drops: row stays, flags set, email renamed, original kept for display.
  const dropped = (await req(admin, "PATCH", `/api/users/${d1._id}`, { drop: true }, 200)).data.item;
  ok("T3: drop keeps the row with dropped=true + active=false", dropped?.dropped === true && dropped?.active === false, JSON.stringify({ d: dropped?.dropped, a: dropped?.active }));
  ok("T3: the original email is kept for display and the live one is renamed",
    dropped?.dropped_email === dEmail && String(dropped?.email ?? "").startsWith("dropped.") && String(dropped?.email ?? "").endsWith(dEmail),
    JSON.stringify({ e: dropped?.email, de: dropped?.dropped_email }));
  // The login dies with the drop.
  ok("T3: the dropped user cannot sign in anymore", !(await login(dEmail, "CiOnly@123")));
  // The freed email can carry a brand-new account (drop → recreate flow).
  const re = await req(admin, "POST", "/api/users", { name: "TEST-EL Rehire " + s, email: dEmail, password: "CiOnly@123", role: "Location", location_scope: [loc._id] });
  ok("T3: the same email works for a fresh account after the drop", re.status === 201, `got ${re.status}`);
  // Dropped is terminal: no edits, no second drop, and never yourself.
  ok("T3: a dropped account refuses edits (create a new one instead)", (await req(admin, "PATCH", `/api/users/${d1._id}`, { name: "zombie" })).status === 400);
  ok("T3: a second drop is refused", (await req(admin, "PATCH", `/api/users/${d1._id}`, { drop: true })).status === 400);
  const me = ((await req(admin, "GET", "/api/users", undefined, 200)).data.items ?? []).find((u) => u.email === "admin@vidysea.com");
  if (me) ok("T3: you cannot drop yourself", (await req(admin, "PATCH", `/api/users/${me._id}`, { drop: true })).status === 400);
}

// ---- cost entries: the 2026-08-13 edit/delete surface (sheet-imported costs can be wrong) ----
// ---- QA-117/118/119 (15/08): masters + institution identity ----
{
  // Schemes master lazy-seeds from the SCHEME enum — every Program.scheme value has a row.
  const schemes = (await req(admin, "GET", "/api/master-lists/schemes", undefined, 200)).data.items ?? [];
  ok("QA-119: schemes master carries the enum's five schemes", schemes.length >= 5 && schemes.some((x) => x.name === "RPL-AVPL"), JSON.stringify(schemes.map((x) => x.name)));
  // Hours + amount are editable facts (Manish's data) — pick the unused DDU scheme so no
  // other fixture's threshold shifts.
  const ddu = schemes.find((x) => x.name === "DDU-GKY2.0");
  const upd = await req(admin, "PATCH", `/api/master-lists/schemes/${ddu._id}`, { total_hours: 300, min_required_hours: 180, amount_received: 8000 });
  ok("QA-119: scheme hours + amount round-trip", upd.status === 200 && upd.data.item.total_hours === 300 && upd.data.item.min_required_hours === 180 && upd.data.item.amount_received === 8000, JSON.stringify(upd.data.item));
  // QA-093: a batch under that scheme derives its threshold from the master (180/300 = 60%).
  const sProg = (await req(admin, "POST", "/api/programs", { code: "SM" + s, name: "SchemeMaster Prog " + s, trainer_skill: "SM" + s, scheme: "DDU-GKY2.0", duration_days: 10, buffer_days: 2 }, 201)).data.item;
  const sBatch = (await req(admin, "POST", "/api/batches", { location: loc._id, program: sProg._id, planned_start: today() }, 201)).data.item;
  const att = (await req(admin, "GET", `/api/batches/${sBatch._id}/attendance`, undefined, 200)).data;
  ok("QA-093: threshold derives from the scheme master (60%, source 'scheme')", att.min_attendance_pct === 60 && att.min_attendance_source === "scheme", JSON.stringify({ pct: att.min_attendance_pct, src: att.min_attendance_source }));
  // A scheme WITHOUT hours still falls back to the Defaults percentage, honestly labelled.
  const dflt = (await req(admin, "GET", "/api/defaults", undefined, 200)).data.item;
  const rProg = (await req(admin, "POST", "/api/programs", { code: "SN" + s, name: "NoHours Prog " + s, trainer_skill: "SN" + s, scheme: "RPL-HSL", duration_days: 10, buffer_days: 2 }, 201)).data.item;
  const rBatch = (await req(admin, "POST", "/api/batches", { location: loc._id, program: rProg._id, planned_start: today() }, 201)).data.item;
  const att2 = (await req(admin, "GET", `/api/batches/${rBatch._id}/attendance`, undefined, 200)).data;
  ok("QA-093: hour-less scheme falls back to Defaults, labelled 'defaults'", att2.min_attendance_pct === (dflt.min_attendance_pct ?? 50) && att2.min_attendance_source === "defaults", JSON.stringify({ pct: att2.min_attendance_pct, src: att2.min_attendance_source }));
  // Job-roles master: unique, editable, feeds the programme form's suggestions.
  const jr = await req(admin, "POST", "/api/master-lists/job-roles", { name: "QA Job Role " + s });
  ok("QA-118: job role lands in the master", jr.status === 201, `got ${jr.status}`);
  ok("QA-118: duplicate job role (case-insensitive) → 409", (await req(admin, "POST", "/api/master-lists/job-roles", { name: ("qa job role " + s).toUpperCase() })).status === 409);
  // QA-117: institution_id — unique, editable, searchable.
  const instId = "INST-" + s;
  const patched = await req(admin, "PATCH", `/api/locations/${loc._id}`, { institution_id: instId });
  ok("QA-117: institution_id round-trips on the centre", patched.status === 200 && patched.data.item.institution_id === instId, JSON.stringify(patched.data.item?.institution_id));
  const loc2i = (await req(admin, "POST", "/api/locations", { code: "I" + s, name: "TEST-EL Inst2 " + s, approval_status: "Approved" }, 201)).data.item;
  ok("QA-117: a second centre cannot take the same institution_id", (await req(admin, "PATCH", `/api/locations/${loc2i._id}`, { institution_id: instId })).status >= 400);
  ok("QA-117: centres are searchable by institution_id", ((await req(admin, "GET", `/api/locations?q=${instId}&limit=5`, undefined, 200)).data.items ?? []).some((l) => String(l._id) === String(loc._id)));
}

const cost = (await req(admin, "POST", "/api/costs", { location: loc._id, category: (await pickCategory()), amount: 5000, note: "TEST-EL mobilisation " + s }, 201)).data.item;
async function pickCategory() {
  const cats = (await req(admin, "GET", "/api/master-lists/cost-categories", undefined, 200)).data.items ?? [];
  if (cats.length) return cats[0]._id;
  return (await req(admin, "POST", "/api/master-lists/cost-categories", { name: "TEST-EL Cat " + s }, 201)).data.item._id;
}
// [best] amount correction round-trip, audited.
await req(admin, "PATCH", `/api/costs/${cost._id}`, { amount: 4200, note: "corrected from sheet" }, 200);
const costs1 = (await req(admin, "GET", `/api/costs?location=${loc._id}`, undefined, 200)).data.items ?? [];
ok("[best] cost amount correction lands", costs1.find((c) => String(c._id) === String(cost._id))?.amount === 4200, JSON.stringify(costs1[0]?.amount));
// [worst] Rule 37 on the merged entry: a negative amount is refused.
await req(admin, "PATCH", `/api/costs/${cost._id}`, { amount: -50 }, 400);
await req(admin, "POST", "/api/costs", { location: loc._id, category: cost.category, amount: 0 }, 400);
// [worst] the edit surface answers to costs.manage.
if (enroll) {
  await req(enroll, "PATCH", `/api/costs/${cost._id}`, { amount: 1 }, 403);
  await req(enroll, "DELETE", `/api/costs/${cost._id}`, undefined, 403);
}
// [best] delete removes the entry from every total.
await req(admin, "DELETE", `/api/costs/${cost._id}`, undefined, 200);
const costs2 = (await req(admin, "GET", `/api/costs?location=${loc._id}`, undefined, 200)).data.items ?? [];
ok("[best] deleted cost entry is gone", !costs2.some((c) => String(c._id) === String(cost._id)), `${costs2.length} rows left`);
// [worst] deleting it twice is a clean 404, not a crash.
await req(admin, "DELETE", `/api/costs/${cost._id}`, undefined, 404);


// ---- 2026-08-13 list-UX cycle: KPI deep-link + manual-entry parity ----
// [best] the Approved-Locations KPI's landing filter is honoured server-side.
const approvedList = (await req(admin, "GET", "/api/locations?approval_status=Approved&limit=2000", undefined, 200)).data.items ?? [];
ok("[best] ?approval_status=Approved returns only approved centres", approvedList.length > 0 && approvedList.every((l) => l.approval_status === "Approved"), JSON.stringify([...new Set(approvedList.map((l) => l.approval_status))]));

// [best] client-reported target figures are keyable by hand (were API-only).
await req(admin, "PUT", `/api/locations/${loc._id}/targets`, { program: prog._id, enrolled_reported: 37, pending_reported: 5 }, 200);
const trep = ((await req(admin, "GET", `/api/locations/${loc._id}/targets`, undefined, 200)).data.items ?? [])[0];
ok("[best] enrolled/pending reported figures round-trip", trep?.enrolled_reported === 37 && trep?.pending_reported === 5, JSON.stringify({ e: trep?.enrolled_reported, p: trep?.pending_reported }));

// [best] rooms are editable and can be taken out of service (route existed, UI now calls it).
const rm = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "EL Room " + s, type: "Classroom", capacity: 25 }, 201)).data.item;
await req(admin, "PATCH", `/api/rooms/${rm._id}`, { name: "EL Room renamed " + s, type: "Lab", active: false }, 200);
const rmAfter = ((await req(admin, "GET", `/api/locations/${loc._id}/rooms`, undefined, 200)).data.items ?? []).find((r) => String(r._id) === String(rm._id));
ok("[best] room rename + type + out-of-service round-trip", rmAfter?.name === "EL Room renamed " + s && rmAfter?.type === "Lab" && rmAfter?.active === false, JSON.stringify(rmAfter));

// [best] the two planner knobs that had no Admin field persist like the rest.
await req(admin, "PUT", "/api/defaults", { lead_tot_start_days: 11, lead_trainer_ready_for_tot_days: 16 }, 200);
const dknobs = (await req(admin, "GET", "/api/defaults", undefined, 200)).data.item;
ok("[best] lead_tot_start_days + lead_trainer_ready_for_tot_days persist", dknobs.lead_tot_start_days === 11 && dknobs.lead_trainer_ready_for_tot_days === 16, JSON.stringify({ a: dknobs.lead_tot_start_days, b: dknobs.lead_trainer_ready_for_tot_days }));
await req(admin, "PUT", "/api/defaults", { lead_tot_start_days: 10, lead_trainer_ready_for_tot_days: 15 }, 200); // restore

// [best] the Preparation board's data contract: full list, each row carries the gap story.
const prepAll = (await req(admin, "GET", "/api/mapping/readiness", undefined, 200)).data;
ok("[best] readiness list returns every target row with counts", Array.isArray(prepAll.items) && typeof prepAll.ready_count === "number" && typeof prepAll.blocked_count === "number", JSON.stringify({ n: prepAll.items?.length, r: prepAll.ready_count, b: prepAll.blocked_count }));
const prepRow = (prepAll.items ?? []).find((r) => String(r.location?._id) === String(loc._id));
ok("[best] each row names its blockers + next action + trainer/candidate counts",
  !!prepRow && Array.isArray(prepRow.blockers) && typeof prepRow.next_action === "string" && prepRow.trainers && prepRow.candidates,
  JSON.stringify({ blockers: prepRow?.blockers?.length, na: prepRow?.next_action }).slice(0, 120));

finish();
