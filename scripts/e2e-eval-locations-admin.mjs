// Eval: Locations (targets, TC identity) + Admin (defaults, users) + the 2026-08-13 cost-entry
// edit surface. Admin → Defaults had TWO assertions in the whole baseline before this file.
import { ok, req, adminLogin, login, finish, stamp, phone, today } from "./e2e-lib.mjs";

const admin = await adminLogin();
const s = stamp("EL");

const prog = (await req(admin, "POST", "/api/programs", { code: s, name: "EvalLoc Prog " + s, trainer_skill: "ELSkill" + s }, 201)).data.item;
const loc = (await req(admin, "POST", "/api/locations", { code: "L" + s, name: "TEST-EvalLoc " + s, approval_status: "Approved", city: "Meerut" }, 201)).data.item;

// ---- targets: the new locations.manage gate (was requireEdit-only — audit 2026-08-13) ----
// enroll@ is unscoped with can_edit — exactly the shape that could rewrite approved targets before.
const enroll = await login("enroll@vidysea.com", "Vidysea@123");
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
const mk = await req(admin, "POST", "/api/users", { name: "TEST-EL User " + s, email: uEmail, password: "Vidysea@123", role: "Location", location_scope: [loc._id] }, 201);
const uid = mk.data.item?._id;
// [best] the fresh scoped user can sign in and sees only their centre.
const fresh = await login(uEmail, "Vidysea@123");
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

// ---- cost entries: the 2026-08-13 edit/delete surface (sheet-imported costs can be wrong) ----
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
