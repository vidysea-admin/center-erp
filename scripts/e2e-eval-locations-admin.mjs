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

// ---- -163 (QA-496): a wrong (centre x job role) row could be created and never removed ----
// The client sheet has no PMKVY-BECIL Drone SERVICE row at all, yet two 280-target rows sat on that
// programme in the ERP - 560 of target in the wrong column while the GRAND TOTAL stayed right, which
// is why every total-level check passed over it. And it could not be corrected through the product:
// PUT upserts on { location, program }, so `program` is the KEY - sending the right job role creates
// a SECOND row and leaves the wrong one, taking the centre UP by 560 instead of moving it. No delete
// existed anywhere.
{
  // Its OWN centre. The first draft used the shared `loc` and its extra target rows changed that
  // centre's rollups two assertions later - the same lesson the QA-410 fixture taught: a pin that
  // disturbs the fixture it borrows is a pin that fails somebody else's check.
  const mvLoc = (await req(admin, "POST", "/api/locations", { code: "LM" + s, name: "TEST-EvalMove " + s, approval_status: "Approved", city: "Meerut" }, 201)).data.item;
  const progB = (await req(admin, "POST", "/api/programs", { code: s + "B", name: "EvalLoc ProgB " + s, trainer_skill: "ELSkillB" + s }, 201)).data.item;
  // Two rows on this centre, because the clash case needs a DESTINATION that is already taken -
  // and it has to be built here rather than borrowed, which is what the first draft got wrong.
  await req(admin, "PUT", `/api/locations/${mvLoc._id}/targets`, { program: prog._id, approved_target: 120 }, 200);
  await req(admin, "PUT", `/api/locations/${mvLoc._id}/targets`, { program: progB._id, approved_target: 280, tc_id: "TCMOVE" + s, tc_status: "Approved" }, 200);

  const noReason = await req(admin, "PATCH", `/api/locations/${mvLoc._id}/targets`, { from_program: progB._id, to_program: prog._id });
  ok("-163 (QA-496): moving a government-approved target between job roles demands a reason",
    noReason.status === 400, `got ${noReason.status}`);

  // the destination already has a row, so a move would silently merge two approvals - refuse, name both
  const clash = await req(admin, "PATCH", `/api/locations/${mvLoc._id}/targets`, { from_program: progB._id, to_program: prog._id, reason: "-163 pin: clash" });
  ok("-163 (QA-496): it refuses to merge two targets and says which row already holds one",
    clash.status === 409 && /already has a target row/i.test(String(clash.data.error ?? "")), `${clash.status} ${String(clash.data.error ?? "").slice(0, 90)}`);

  // a clean move: destination empty, and the row must ARRIVE whole - its tc identity travels with it
  const progC = (await req(admin, "POST", "/api/programs", { code: s + "C", name: "EvalLoc ProgC " + s, trainer_skill: "ELSkillC" + s }, 201)).data.item;
  const moved = await req(admin, "PATCH", `/api/locations/${mvLoc._id}/targets`, { from_program: progB._id, to_program: progC._id, reason: "-163 pin: the sheet calls this row a different job role" });
  const after = (await req(admin, "GET", `/api/locations/${mvLoc._id}/targets`, undefined, 200)).data.items ?? [];
  const onB = after.filter((t) => String(t.program?._id ?? t.program) === String(progB._id));
  const onC = after.filter((t) => String(t.program?._id ?? t.program) === String(progC._id));
  ok("-163 (QA-496): the row MOVES - it leaves the wrong job role rather than being copied to the right one",
    moved.status === 200 && onB.length === 0 && onC.length === 1,
    JSON.stringify({ status: moved.status, onB: onB.length, onC: onC.length }));
  ok("-163 (QA-496): ...and it arrives whole, carrying the government identity that belongs to that source row",
    onC[0]?.approved_target === 280 && onC[0]?.tc_id === "TCMOVE" + s && onC[0]?.tc_status === "Approved",
    JSON.stringify({ target: onC[0]?.approved_target, tc_id: onC[0]?.tc_id, tc_status: onC[0]?.tc_status }));

  // -163 cycle 2 (QA-502). THIS ASSERTION USED TO BE VACUOUS AND A CHECKER PROVED IT.
  // It read `totalAfter === totalBefore` with both figures taken inside this block, so on pre-fix
  // code - where the PATCH 405s and writes nothing - the two reads were trivially equal and it
  // PASSED on broken source. It passed precisely because nothing had happened. REQ-388: a pin that
  // passes before the fix is not a pin, it is a description.
  //
  // Rewritten to assert the OUTCOME AN OPERATOR NEEDS, reached through whichever route the product
  // actually offers. Pre-fix there is no move door, so the only thing available is a PUT of the
  // corrected job role - and PUT upserts on { location, program }, so it ADDS a second row and the
  // centre's approved target GROWS by 280 instead of moving. That is the defect itself, and this is
  // now red for exactly that reason. Its own centre, so nothing else's rollups move.
  const fixLoc = (await req(admin, "POST", "/api/locations", { code: "LF" + s, name: "TEST-EvalMoveOutcome " + s, approval_status: "Approved", city: "Meerut" }, 201)).data.item;
  await req(admin, "PUT", `/api/locations/${fixLoc._id}/targets`, { program: progB._id, approved_target: 280, tc_id: "TCFIX" + s, tc_status: "Approved" }, 200);
  const sumFix = async () => ((await req(admin, "GET", `/api/locations/${fixLoc._id}/targets`, undefined, 200)).data.items ?? []).reduce((acc, t) => acc + (t.approved_target ?? 0), 0);
  const fixBefore = await sumFix();
  const attempt = await req(admin, "PATCH", `/api/locations/${fixLoc._id}/targets`, { from_program: progB._id, to_program: progC._id, reason: "-163 pin: the sheet calls this row a different job role" });
  if (attempt.status === 404 || attempt.status === 405 || attempt.status === 501) {
    // No move door. This branch is what the product left an operator with, and taking it is the
    // whole point - the assertion below then measures the damage rather than measuring nothing.
    await req(admin, "PUT", `/api/locations/${fixLoc._id}/targets`, { program: progC._id, approved_target: 280 }, 200);
  }
  const fixAfter = await sumFix();
  // QA-516 (a checker, on the cycle-2 rewrite of this very pin): the total alone is red only
  // against method-ABSENCE. If someone shipped a PATCH that answered 200 and wrote nothing, the
  // fallback would not fire, the total would not move, and this would go GREEN on a broken move.
  // So the assertion also states WHERE the row ended up: the corrected job role must hold it and
  // the wrong one must not. That is red for a no-op 200 as well as for a missing method.
  const fixRows = ((await req(admin, "GET", `/api/locations/${fixLoc._id}/targets`, undefined, 200)).data.items ?? []);
  const onWrong = fixRows.filter((t) => String(t.program?._id ?? t.program) === String(progB._id));
  const onRight = fixRows.filter((t) => String(t.program?._id ?? t.program) === String(progC._id));
  ok("-163 (QA-496): correcting a mis-filed target MOVES it - the total does not grow AND the row is on the corrected job role",
    fixAfter === fixBefore && onRight.length === 1 && onWrong.length === 0,
    JSON.stringify({ before: fixBefore, after: fixAfter, onWrong: onWrong.length, onRight: onRight.length, via: attempt.status === 200 ? "PATCH move" : `PUT fallback (PATCH ${attempt.status})` }));
}

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

// ---- QA-1731: a row explicitly BLANKED (not merely never-touched) must still fall back to the
// centre's TC status - mappingReadinessBulk's tcView used `??`, which never reaches the centre for
// a row genuinely stored as "" (the exact "Update target" shape QA-497/QA-1075 already
// established), so a deliberately-cleared row silently read as unblocked even when the centre's
// own record said "Rejected". A fresh location/programme, so this cannot inherit `loc`'s own
// tc_status state from the pin just above.
{
  // tc_id must be set too - readinessBlockers' TC checks are `if (!loc.tc_id) ... else if (loc.tc_status ...)`,
  // so a centre with no TC ID at all never reaches the tc_status branch this pin means to exercise.
  const q1731Loc = (await req(admin, "POST", "/api/locations", { code: "Q1731" + s, name: "TEST-Q1731Fallback " + s, approval_status: "Approved", city: "Meerut", tc_id: "Q1731TC" + s, tc_status: "Rejected" }, 201)).data.item;
  const q1731Prog = (await req(admin, "POST", "/api/programs", { code: "Q1731P" + s, name: "Q1731Role " + s, scheme: "RPL-AVPL", trainer_skill: "Q1731Skill" + s }, 201)).data.item;
  await req(admin, "PUT", `/api/locations/${q1731Loc._id}/targets`, { program: q1731Prog._id, approved_target: 30, tc_status: "" }, 200);
  const q1731Rdy = ((await req(admin, "GET", `/api/mapping/readiness?location=${q1731Loc._id}`, undefined, 200)).data.items ?? [])
    .find((r) => String(r.program?._id) === String(q1731Prog._id));
  ok("QA-1731: a row explicitly blanked (tc_status \"\") falls back to the CENTRE's TC status - a Rejected centre still blocks, not silently unblocked by a cleared row",
    (q1731Rdy?.blockers ?? []).some((b) => /TC status is "Rejected"/.test(b)),
    JSON.stringify(q1731Rdy?.blockers).slice(0, 200));
}

// ---- QA-1732: the SAME gap as QA-1731, for tc_id, opposite failure direction - a row's tc_id
// blanked via "Update target" (a real "", not the row's never-set state) must still fall back to
// the centre's tc_id, or readinessBlockers' truthy-guarded "no TC ID on record" check fires a
// FALSE blocker on a centre that genuinely has one. tc_status left at "Approved" on both centre
// and row (implicitly, via PUT never sending one - the target starts with none - falling back to
// the centre's own "Approved") so this fixture isolates the tc_id behaviour alone.
{
  const q1732Loc = (await req(admin, "POST", "/api/locations", { code: "Q1732" + s, name: "TEST-Q1732Fallback " + s, approval_status: "Approved", city: "Meerut", tc_id: "Q1732TC" + s, tc_status: "Approved" }, 201)).data.item;
  const q1732Prog = (await req(admin, "POST", "/api/programs", { code: "Q1732P" + s, name: "Q1732Role " + s, scheme: "RPL-AVPL", trainer_skill: "Q1732Skill" + s }, 201)).data.item;
  await req(admin, "PUT", `/api/locations/${q1732Loc._id}/targets`, { program: q1732Prog._id, approved_target: 30, tc_id: "" }, 200);
  const q1732Rdy = ((await req(admin, "GET", `/api/mapping/readiness?location=${q1732Loc._id}`, undefined, 200)).data.items ?? [])
    .find((r) => String(r.program?._id) === String(q1732Prog._id));
  ok("QA-1732: a row explicitly blanked (tc_id \"\") falls back to the CENTRE's TC id - no FALSE 'no TC ID on record' blocker on a centre that genuinely has one",
    !(q1732Rdy?.blockers ?? []).some((b) => /no TC ID on record/.test(b)),
    JSON.stringify(q1732Rdy?.blockers).slice(0, 200));
}
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

// ---- -129 (QA-271): a centre can be RETIRED, which is not the same as deleted ----
// Divya found a selectable placeholder, "yet to be identify", in the live centre picker. Location
// was the only master with no `active` flag - Program, Room, Trainer, Scheme and JobRole all have
// one. Retiring is a decision about what may be STARTED: the row leaves the creation pickers and
// every batch, candidate and target already pointing at it keeps resolving. Deleting it would
// orphan them, which is exactly why -126 retired a programme rather than deleting it.
{
  const junk = (await req(admin, "POST", "/api/locations", {
    code: "JUNK" + Date.now().toString().slice(-6), name: "yet to be identify",
    state: "UP", district: "Unknown", approval_status: "Pending",
  }, 201)).data.item;
  ok("-129 (QA-271): a new centre is live by default", junk.active !== false, String(junk.active));

  const retired = await req(admin, "PATCH", `/api/locations/${junk._id}`, { active: false }, 200);
  ok("-129 (QA-271): a centre can be retired through the app's own audited door", retired.data.item?.active === false, String(retired.data.item?.active));

  // the -116 lesson: a field the ITEM route does not accept looks saved and is gone on the next read
  const back = (await req(admin, "GET", `/api/locations/${junk._id}`, undefined, 200)).data.item;
  ok("-129 (QA-271): ...and it READS BACK retired - both doors accept the field, not just one", back.active === false, String(back.active));

  const listed = ((await req(admin, "GET", "/api/locations?limit=2000", undefined, 200)).data.items ?? []).find((l) => String(l._id) === String(junk._id));
  ok("-129 (QA-271): a retired centre is still RETURNED by the API - history keeps working, only the creation pickers hide it",
    !!listed && listed.active === false, JSON.stringify(listed && { name: listed.name, active: listed.active }));

  await req(admin, "PATCH", `/api/locations/${junk._id}`, { active: true }, 200);
  ok("-129 (QA-271): and it is reversible, which is the whole reason this is a retire and not a delete",
    (await req(admin, "GET", `/api/locations/${junk._id}`, undefined, 200)).data.item.active === true);
}


// ---------------------------------------------------------------------------------------------
// QA-1262 — the client's own case, from the 2026-08-25 call. He put a trainer on a Basti batch,
// the nomination had already gone to NSDC, and the grid still read "TRAINERS (OURS, LIVE) 0 / 2":
//     "maine ek batch banaya, usme trainer dala hua hai... Zero zero dikh raha hai.
//      Aur nomination ja chuka tha iska."
// The count read ONE of the ways a trainer is tied to a centre. Putting a trainer on a batch never
// writes `nominated_for_location`, and trainer-select DELIBERATELY offers un-nominated trainers, so
// the ordinary path creates exactly the state the count could not see.
//
// This is a BEHAVIOURAL test on purpose. The same defect class survived FIVE static pins in
// check-user-copy.mjs this month (QA-1091 -> QA-1127 -> QA-1141 -> QA-1184 -> QA-1214), each
// tightening buying one new hole and one new false red. A number that moves when the product moves
// is the only guard that has held.
{
  const before = await fetchRow();
  const beforeNom = before?.trainers_nominated_total ?? 0;

  // A trainer with NO nomination to anywhere - the state the batch door actually creates.
  const bTr = (await req(admin, "POST", "/api/trainers", { name: "TEST-EL BatchTie " + s, phone: phone("96"), skills: ["ELSkill" + s], pipeline_status: "TOT In Progress" }, 201)).data.item;
  const afterTrainer = await fetchRow();
  ok("QA-1262: a trainer tied to NO centre does not count for this one (else the tie means nothing)",
    (afterTrainer?.trainers_nominated_total ?? 0) === beforeNom,
    JSON.stringify({ beforeNom, after: afterTrainer?.trainers_nominated_total }));

  // ...now put them on a batch AT THIS centre x job role. Batch.location and Batch.program are both
  // required, so this is an exact tie - and it is the tie the client actually made.
  const bRoom = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "EL Tie Room " + s, type: "Classroom", capacity: 25 }, 201)).data.item;
  await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, trainer: bTr._id, room: bRoom._id, planned_start: today(), target_size: 1 }, 201);
  const afterBatch = await fetchRow();
  ok("QA-1262: putting that trainer on a batch here MAKES THE COUNT MOVE - the client's exact case",
    (afterBatch?.trainers_nominated_total ?? 0) === beforeNom + 1,
    JSON.stringify({ beforeNom, expected: beforeNom + 1, got: afterBatch?.trainers_nominated_total }));

  // DEDUP - my own claim, so it gets its own assertion. The trainer certified earlier is ALREADY
  // counted through the nomination tie; putting them on a batch here too must not count them twice.
  // A union that double-counted would swap one wrong number for another, and this row is what the
  // client reconciles his sheet against.
  const dupBefore = await fetchRow();
  const dRoom = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "EL Dup Room " + s, type: "Classroom", capacity: 25 }, 201)).data.item;
  await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trEl._id, room: dRoom._id, planned_start: today(), target_size: 1 }, 201);
  const dupAfter = await fetchRow();
  ok("QA-1262: a trainer counted through BOTH ties still counts ONCE",
    (dupAfter?.trainers_nominated_total ?? 0) === (dupBefore?.trainers_nominated_total ?? 0)
      && (dupAfter?.trainers_certified_total ?? 0) === (dupBefore?.trainers_certified_total ?? 0),
    JSON.stringify({ nomBefore: dupBefore?.trainers_nominated_total, nomAfter: dupAfter?.trainers_nominated_total,
      certBefore: dupBefore?.trainers_certified_total, certAfter: dupAfter?.trainers_certified_total }));

  // ...and the number must not be vacuous: if the count were 0 throughout, every check above passes
  // for the wrong reason. This is the QA-1245 lesson, applied before it can bite here.
  ok("QA-1262 [precondition] the count under test is above zero, so the assertions above are not vacuous",
    (afterBatch?.trainers_nominated_total ?? 0) > 0, JSON.stringify({ got: afterBatch?.trainers_nominated_total }));
}


// ---------------------------------------------------------------------------------------------
// QA-1307 + QA-1306 — the two the cycle-1 checker measured against QA-1262, both LIVE on -249.
{
  // QA-1307: a FINISHED batch is history, not presence. My own reason for excluding Cancelled -
  // "a cancelled batch is not a trainer working at a centre" - applies word for word to a batch
  // that completed, and the column is headed "Trainers (ours, live)".
  const before = (await fetchRow())?.trainers_nominated_total ?? 0;
  const fTr = (await req(admin, "POST", "/api/trainers", { name: "TEST-EL Finished " + s, phone: phone("94"), skills: ["ELSkill" + s], pipeline_status: "TOT In Progress" }, 201)).data.item;
  const fRoom = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "EL Fin Room " + s, type: "Classroom", capacity: 25 }, 201)).data.item;
  const fBatch = (await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, trainer: fTr._id, room: fRoom._id, planned_start: today(), target_size: 1 }, 201)).data.item;
  const mid = (await fetchRow())?.trainers_nominated_total ?? 0;
  ok("QA-1307 [precondition] a PLANNING batch does count, so the next assertion is not vacuous",
    mid === before + 1, JSON.stringify({ before, mid }));
  // A batch's status is NOT a PATCH field - it moves through /transition. My first version did
  //     await req(..., "PATCH", `/api/batches/${id}`, { status: "Completed" }, 200).catch(() => {})
  // and that `.catch` SWALLOWED the refusal: the batch stayed in Planning, the count correctly did
  // not drop, and the assertion below failed pointing at the PRODUCT. The test hid its own broken
  // precondition and then blamed the code. Every step is asserted now, and the state is READ BACK -
  // if the batch never reaches Completed, that is what goes red, by name.
  // QA-1321 cycle 2 — a NAME COLLISION, and it crashed the whole suite rather than reddening one
  // assertion. `fresh` is declared 235 lines up as a LOGIN COOKIE (`const fresh = await login(...)`),
  // and this line read it as an array of candidates: `fresh[0]._id` is `undefined`, the members door
  // correctly answered 400 "Candidate is required", `fMem` was undefined, and the next line threw
  // `Cannot read properties of undefined (reading '_id')` — no counts from this suite at all.
  //
  // A CRASHED suite is not a red wall and it is certainly not a green one: it contributes no numbers,
  // so a TOTAL line above it can read clean while nineteen assertions were never asked. That is the
  // same shape as the `.catch(() => {})` this block already exists to have removed — a setup step
  // that fails without saying so — which is why the candidate is now created HERE and ASSERTED,
  // rather than borrowed from a variable that happened to be in scope.
  const fCand = (await req(admin, "POST", "/api/candidates", { name: "TEST-EL Fin Cand " + s, phone: phone("95"), location: loc._id, program: prog._id }, 201)).data.item;
  ok("QA-1307 [precondition] a real candidate exists for the roster (else every step below is about nothing)",
    !!fCand?._id, JSON.stringify({ got: fCand?._id ?? null }));
  const fMem = (await req(admin, "POST", `/api/batches/${fBatch._id}/members`, { candidate: fCand._id }, 201)).data.item;
  ok("QA-1307 [precondition] and that candidate is on the roster, so the 80% gate can pass",
    !!fMem?._id, JSON.stringify({ got: fMem?._id ?? null }));
  await req(admin, "PATCH", `/api/members/${fMem._id}`, { reg_done: true, kyc_done: true, enroll_done: true, accept_done: true }, 200);
  await req(admin, "POST", `/api/batches/${fBatch._id}/transition`, { target: "Ready" }, 200);
  await req(admin, "POST", `/api/batches/${fBatch._id}/transition`, { target: "Active", actual_start: today() }, 200);
  // The ladder does NOT go Active -> Closing here, and the read-back assertion below is what proved
  // it: Rule 18 refuses Closing until assessment is Completed ("Assessment must be Completed before
  // Closing."), and Rule 43 will not let assessment complete while any roster member has no final
  // result. Active -> Completed is not a legal edge at all. So the honest way to finish a batch that
  // still has outstanding rows is the door the product built for exactly that — the Admin
  // force-complete, which settles the unmarked rows as Fail with the reason recorded against every
  // one of them, and is refused without a reason.
  //
  // This fixture only needs a FINISHED batch; it does not care how it finished. Using the real door
  // is both shorter and truer than walking assessment + certification by hand — and if that door ever
  // stops completing the batch, the precondition below says so by name instead of the assertion after
  // it blaming the counting code.
  await req(admin, "POST", `/api/batches/${fBatch._id}/complete`, { force: true, reason: "EL fixture: finishing the batch so the trainer-tie count can be measured after completion" }, 200);
  const fState = (await req(admin, "GET", `/api/batches/${fBatch._id}`, undefined, 200)).data.item;
  ok("QA-1307 [precondition] the batch really reached Completed (else the assertion below is about nothing)",
    fState?.status === "Completed", JSON.stringify({ status: fState?.status }));
  const after = (await fetchRow())?.trainers_nominated_total ?? 0;
  ok("QA-1307: once that batch is FINISHED the trainer stops counting as this centre's",
    after === before, JSON.stringify({ before, mid, after }));
}
{
  // QA-1306 — the one that cost something live. A centre whose ONLY tie is a batch-tied trainer
  // nobody nominated must STILL be treated as unstaffed by from-shortfall, because "is hiring
  // underway for this seat" is a nomination question. And if it ever does decline, it must SAY SO:
  // the old bare `continue` returned {created:0, skipped:0} with no reason anywhere.
  const qProg = (await req(admin, "POST", "/api/programs", { code: "Q" + s, name: "ShortfallProg " + s, trainer_skill: "QSkill" + s }, 201)).data.item;
  const qLoc = (await req(admin, "POST", "/api/locations", { code: "QL" + s, name: "TEST-Shortfall " + s, approval_status: "Approved", operational_status: "Active", city: "Meerut" }, 201)).data.item;
  // The targets route exports GET, PUT and PATCH - there is no POST, so this asked for a 405 and
  // got one. Every other suite creates a target with PUT ... 200 (e2e.mjs, e2e-roles.mjs), and
  // PUT is an upsert keyed on {location, program} returning `{item}` at 200. The .catch() hid the
  // throw but not the failure, and with no target created the two QA-1306 assertions below and
  // QA-1307 all fell over behind it - four reds from one wrong verb.
  // The `.catch(() => {})` that used to be on this line is GONE, and that is the point. The wall
  // reported `POST /api/locations/.../targets -> 201 (got 405)`: this route exposes GET/PUT/PATCH and
  // refuses POST. No target row existed, so there was no readiness row, so from-shortfall had nothing
  // to look at and answered {created:0, skipped:[]} - which reads EXACTLY like the defect this test
  // was written to catch. A swallowed setup failure does not make a test pass; it makes it accuse the
  // product of the test's own mistake.
  await req(admin, "PUT", `/api/locations/${qLoc._id}/targets`, { program: qProg._id, trainers_required: 1, approved_target: 30, tc_status: "Approved" }, 200);
  const qRoom = (await req(admin, "POST", `/api/locations/${qLoc._id}/rooms`, { name: "Q Room " + s, type: "Classroom", capacity: 25 }, 201)).data.item;
  const qTr = (await req(admin, "POST", "/api/trainers", { name: "TEST-Q BatchOnly " + s, phone: phone("93"), skills: ["QSkill" + s], pipeline_status: "Fresh Lead" }, 201)).data.item;
  await req(admin, "POST", "/api/batches", { location: qLoc._id, program: qProg._id, trainer: qTr._id, room: qRoom._id, planned_start: today(), target_size: 1 }, 201);
  // 201, not 200 - and the reason this line was wrong is the SAME disease, a third time in this file.
  // The route has answered `created.length ? 201 : 200` since F-A9 (5536491); that split is older
  // than this test. While my fixture was broken (POST to a route that only takes PUT), nothing was
  // ever created, so `created.length` was always 0, the route always said 200, and this assertion
  // passed - FOR THE WRONG REASON. Fixing the setup is what exposes an expectation that was never
  // valid. Asserting 201 is also the stronger claim: it is the route's own way of saying it created
  // something, so the status and the body now have to agree.
  const shortfall = await req(admin, "POST", "/api/trainer-requests/from-shortfall", { location: qLoc._id }, 201);
  const res = shortfall.data;
  const createdN = res.summary?.created ?? 0;
  const skippedN = (res.skipped ?? []).length;
  ok("QA-1306: a centre whose only trainer is batch-tied and NOT nominated is still unstaffed - the request gets raised",
    createdN >= 1, JSON.stringify({ created: createdN, skipped: res.skipped }));
  ok("QA-1306: and nothing is ever declined in SILENCE - every non-creation carries a reason",
    createdN >= 1 || skippedN >= 1, JSON.stringify({ created: createdN, skippedCount: skippedN, skipped: res.skipped }));
}

finish();
