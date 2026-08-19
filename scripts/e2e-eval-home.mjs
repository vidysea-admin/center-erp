// Eval: Dashboard/Home — CONTENT correctness, not just Rule-38 scoping (which e2e-roles owns).
// Before 2026-08-13 the Home surface had ~8 assertions, all "does it leak", none "is it right".
// Scenarios are tagged [best] happy path · [avg] partial data · [worst] wrong/edge input.
import { ok, req, adminLogin, login, finish, stamp, phone, today } from "./e2e-lib.mjs";

const admin = await adminLogin();
const s = stamp("EH");

// ---- fixtures: one centre with a full batch walked to Active ----
const prog = (await req(admin, "POST", "/api/programs", { code: s, name: "EvalHome Prog " + s, trainer_skill: "EHSkill" + s }, 201)).data.item;
// Created Pending so the KPI delta below can watch approval flip it (2026-08-13: the headline
// KPI counts APPROVED centres, not operationally-active ones).
const loc = (await req(admin, "POST", "/api/locations", { code: "L" + s, name: "TEST-EvalHome Loc " + s, approval_status: "Pending", city: "Jaipur" }, 201)).data.item;
const room = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "CR1", type: "Classroom" }, 201)).data.item;
const trainer = (await req(admin, "POST", "/api/trainers", { name: "TEST-EH Trainer " + s, phone: phone("9"), skills: ["EHSkill" + s] }, 201)).data.item;

const before = (await req(admin, "GET", "/api/home", undefined, 200)).data;

// [best] KPI deltas: each fixture moves exactly its own counter.
await req(admin, "PATCH", `/api/locations/${loc._id}`, { approval_status: "Approved", operational_status: "Active", status_reason: "eval fixture" }, 200);
const treq = (await req(admin, "POST", "/api/trainer-requests", { location: loc._id, program: prog._id, required_by_date: today() }, 201)).data.item;

const batch = (await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, room: room._id, planned_start: today(), target_size: 1 }, 201)).data.item;
const cand = (await req(admin, "POST", "/api/candidates", { name: "TEST-EH Cand " + s, phone: phone("8"), location: loc._id, program: prog._id }, 201)).data.item;
const mem = (await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: cand._id }, 201)).data.item;
await req(admin, "PATCH", `/api/members/${mem._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Ready" }, 200);
await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Active" }, 200);

const after = (await req(admin, "GET", "/api/home", undefined, 200)).data;
ok("[best] KPI approved_locations counts the newly Approved centre", after.kpis.approved_locations === before.kpis.approved_locations + 1, `${before.kpis.approved_locations} → ${after.kpis.approved_locations}`);
ok("[best] KPI active_batches counts the batch walked to Active", after.kpis.active_batches === before.kpis.active_batches + 1, `${before.kpis.active_batches} → ${after.kpis.active_batches}`);
ok("[best] KPI enrolled_students counts the completed 3-step enrollment", after.kpis.enrolled_students === before.kpis.enrolled_students + 1, `${before.kpis.enrolled_students} → ${after.kpis.enrolled_students}`);
ok("[best] KPI open_trainer_requests counts the fresh request", after.kpis.open_trainer_requests === before.kpis.open_trainer_requests + 1, `${before.kpis.open_trainer_requests} → ${after.kpis.open_trainer_requests}`);

// [avg] a batch that went Active TODAY owes no yesterday-log — it must NOT raise a false alarm.
ok("[avg] day-one Active batch is not flagged as missing its daily log",
  !(after.queues.missing_logs ?? []).some((m) => String(m.batch?._id) === String(batch._id)),
  JSON.stringify((after.queues.missing_logs ?? []).map((m) => m.batch?.code)));

// [best] Registration-Failed queue carries the WHY (GD-81: the reason is the queue's value).
await req(admin, "PATCH", `/api/candidates/${cand._id}`, { sidh_status: "Registration Failed", sidh_failure_reason: "OTP never arrived" }, 200);
const homeRF = (await req(admin, "GET", "/api/home", undefined, 200)).data;
const rfRow = (homeRF.queues.registration_failed ?? []).find((c) => String(c._id) === String(cand._id));
ok("[best] portal-refused candidate appears in the Registration Failed queue", !!rfRow, JSON.stringify(homeRF.queues.registration_failed?.length));
ok("[best] …with the refusal reason attached", rfRow?.sidh_failure_reason === "OTP never arrived", rfRow?.sidh_failure_reason);

// [avg] the queue empties the moment the candidate is registered.
await req(admin, "PATCH", `/api/candidates/${cand._id}`, { sidh_status: "Registered", sidh_failure_reason: "" }, 200);
const homeRF2 = (await req(admin, "GET", "/api/home", undefined, 200)).data;
ok("[avg] fixing the registration clears the queue row", !(homeRF2.queues.registration_failed ?? []).some((c) => String(c._id) === String(cand._id)));

// [worst] a scoped user whose centres do not exist gets an explanation, not a wall of zeros.
const ghostEmail = `eval.ghost.${s}@vidysea-test.local`;
const mkGhost = await req(admin, "POST", "/api/users", { name: "TEST-EH Ghost " + s, email: ghostEmail, password: "CiOnly@123", role: "Location", location_scope: ["000000000000000000000000"] });
if (mkGhost.status === 201) {
  const ghost = await login(ghostEmail, "CiOnly@123");
  ok("[worst] dangling-scope user can still sign in", !!ghost);
  if (ghost) {
    const gHome = (await req(ghost, "GET", "/api/home", undefined, 200)).data;
    ok("[worst] Home says WHY it is empty (scoped_no_centres)", gHome.scoped_no_centres === true, JSON.stringify(gHome.scoped_no_centres));
    // QA-096: a lean role's payload no longer carries the org-wide keys at all — the
    // honest zero applies to what they ARE sent, and the org figure is simply absent.
    ok("[worst] …and every KPI they receive is an honest zero (org keys absent)",
      gHome.kpis.active_batches === 0 && gHome.kpis.approved_locations === undefined, JSON.stringify(gHome.kpis));
    ok("[worst] …with no other centre's queue rows leaking", (gHome.queues.registration_failed ?? []).length === 0 && (gHome.queues.missing_logs ?? []).length === 0);
    // QA-114 (S1): the client renders queue sections on KEY PRESENCE now. This pins the
    // contract both ways: the org-wide queue keys are ABSENT for a lean role (so the
    // sections hide instead of crashing on undefined.length), and the always-on queues
    // arrive as real arrays.
    ok("QA-114: lean payload omits the org-wide queue keys entirely",
      gHome.queues.follow_ups === undefined && gHome.queues.sheet_changes === undefined && gHome.queues.invoices_pending === undefined,
      JSON.stringify(Object.keys(gHome.queues)));
    ok("QA-114: the always-on queues are real arrays, never missing",
      Array.isArray(gHome.queues.missing_logs) && Array.isArray(gHome.queues.attendance_gaps) && Array.isArray(gHome.queues.enrollment_failures),
      JSON.stringify(Object.keys(gHome.queues)));
  }
  await req(admin, "PATCH", `/api/users/${mkGhost.data.item._id}`, { active: false }, 200); // leave no live login behind
} else {
  ok("[worst] dangling-scope user creation (adjust fixture if scope ids are now validated)", false, JSON.stringify(mkGhost.data).slice(0, 120));
}

// [best] pending follow-ups KPI matches the follow-ups queue length by definition.
const homeFinal = (await req(admin, "GET", "/api/home", undefined, 200)).data;
ok("[best] pending_followups KPI equals the follow-ups queue it summarizes", homeFinal.kpis.pending_followups === (homeFinal.queues.follow_ups ?? []).length,
  `${homeFinal.kpis.pending_followups} vs ${(homeFinal.queues.follow_ups ?? []).length}`);

// [avg] thresholds surface from Defaults so the UI colors match what Admin configured.
ok("[avg] attendance thresholds ride along for the gap queue", typeof homeFinal.thresholds?.amber === "number" && typeof homeFinal.thresholds?.red === "number", JSON.stringify(homeFinal.thresholds));

// [worst] Home never 500s for any seeded role (content varies, the endpoint must not break).
for (const [email, label] of [["ops@vidysea.com", "Operations"], ["spoc.jpr03@vidysea.com", "SPOC"], ["enroll@vidysea.com", "Enrollment"]]) {
  const c = await login(email, "CiOnly@123");
  if (!c) { ok(`[worst] ${label} login available (seed-sample)`, false, email); continue; }
  const r = await req(c, "GET", "/api/home");
  ok(`[worst] Home answers 200 for ${label}`, r.status === 200, `got ${r.status}`);
  // QA-011 (S1): a scoped LOCATION user receives THEIR OWN trainer count (scope-aware
  // union) instead of an absent key the card renders as 0 — while the central unscoped
  // Enrollment login still gets no org-wide trainer figure at all.
  if (label === "SPOC") {
    ok("QA-011: SPOC home carries a scoped trainers_active_total (number, not absent)",
      typeof r.data.kpis?.trainers_active_total === "number" && Array.isArray(r.data.kpis?.trainers_by_role),
      JSON.stringify(r.data.kpis?.trainers_active_total));
  }
  if (label === "Enrollment") {
    ok("QA-011: unscoped Enrollment still gets no org-wide trainer figure",
      r.data.kpis?.trainers_active_total === undefined, JSON.stringify(r.data.kpis?.trainers_active_total));
  }
}

// ---- 2026-08-13 (Manish walkthrough): role-wise cards need role-wise KPI payload ----
const kFinal = homeFinal.kpis;
ok("[best] KPI approved_targets counts centre×job-role approvals, not centres", typeof kFinal.approved_targets === "number" && typeof kFinal.targets_total === "number",
  JSON.stringify({ a: kFinal.approved_targets, t: kFinal.targets_total }));
ok("[avg] …and it never exceeds the total number of job-role targets", kFinal.approved_targets <= kFinal.targets_total, `${kFinal.approved_targets}/${kFinal.targets_total}`);
ok("[best] KPI trainers_by_role is grouped by job role with counts", Array.isArray(kFinal.trainers_by_role) && kFinal.trainers_by_role.every((r) => typeof r.count === "number" && "program" in r),
  JSON.stringify(kFinal.trainers_by_role).slice(0, 160));
ok("[avg] …and trainers_active_total equals the sum of its groups",
  kFinal.trainers_active_total === (kFinal.trainers_by_role ?? []).reduce((s, r) => s + r.count, 0), String(kFinal.trainers_active_total));
ok("[best] KPI attendance carries present/roster/pct and today's split", kFinal.attendance && typeof kFinal.attendance.present === "number" && typeof kFinal.attendance.roster === "number" && "today_present" in kFinal.attendance,
  JSON.stringify(kFinal.attendance));
ok("[worst] …attendance pct is null (not NaN/0) when nothing has been logged",
  kFinal.attendance.roster > 0 ? typeof kFinal.attendance.pct === "number" : kFinal.attendance.pct === null, String(kFinal.attendance.pct));

// cleanup: close down the fixture batch so later suites' KPI deltas start clean
await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Cancelled", reason: "eval fixture teardown" });

// ---- -138 (G-07 / G-08 / G-11, 19 Aug recording): what the Home tiles count ----
// G-07: the tile read 'Total Attendance 12%' from 16 of 135 LOGGED student-days, at a centre whose
// batch page says 'Our logs: 0 days' and which had just imported 38 students across 17 portal
// working days. Umesh: those cohorts ran before this ERP existed, so their attendance only ever
// went to the government portal — 'attendance same hi hai'. The two are therefore NOT ADDED: they
// describe the same days, and summing them would double-count every day a centre recorded twice.
// Per batch, the portal answers where an import exists and our own logs answer where it does not.
{
  const k = (await req(admin, "GET", "/api/home", undefined, 200)).data.kpis;
  ok("-138 (G-07): the attendance figure names its two sources instead of silently meaning one",
    k.attendance && "portal_present" in k.attendance && "our_present" in k.attendance,
    JSON.stringify(Object.keys(k.attendance ?? {})));
  ok("-138 (G-07): the totals are the two parts added, so the tile cannot disagree with its own subtitle",
    (k.attendance.our_present + k.attendance.portal_present) === k.attendance.present
    && (k.attendance.our_roster + k.attendance.portal_roster) === k.attendance.roster,
    JSON.stringify(k.attendance));
  ok("-138 (G-07): a batch answered by the portal is NOT also counted from our logs — no double count",
    k.attendance.portal_batches === 0 || k.attendance.roster <= (k.attendance.our_roster + k.attendance.portal_roster),
    JSON.stringify({ batches: k.attendance.portal_batches, roster: k.attendance.roster }));

  // ---- -145 (QA-302): the scope must survive INTO the 'our logs' half, not just the portal half ----
  // Measured on live -138 across three roles: every portal figure was correctly narrowed for the
  // Gurugram SPOC (roster 1043 not 1447, 2 batches not 4) while our_present/our_roster came back
  // 35/180 -- byte-identical to the Admin's. Cause was one duplicated object key dropping the $in,
  // so the leak was invisible in review and invisible in any test that only checked the totals.
  // These compare a SCOPED role against the ADMIN on the same instant, which is the only shape
  // that can catch it: a leak makes the two halves equal, and scoping makes them differ or zero.
  {
    const spoc = await login("spoc.jpr03@vidysea.com", "CiOnly@123");
    if (!spoc) ok("-145 (QA-302): scoped SPOC login available", false, "no session");
    else {
      const sk = (await req(spoc, "GET", "/api/home", undefined, 200)).data.kpis;
      ok("-145 (QA-302): a scoped role's OUR-LOGS half is never larger than the whole org's",
        (sk.attendance?.our_roster ?? 0) <= (k.attendance?.our_roster ?? 0)
        && (sk.attendance?.our_present ?? 0) <= (k.attendance?.our_present ?? 0),
        JSON.stringify({ spoc: [sk.attendance?.our_present, sk.attendance?.our_roster], admin: [k.attendance?.our_present, k.attendance?.our_roster] }));
      // The decisive one. If the $in is dropped the two are IDENTICAL while every portal figure
      // beside them is narrowed -- that combination is the fingerprint of the bug, and it is what
      // was actually on screen. A scoped role either has fewer own-log days than the org, or the
      // org has none to begin with.
      ok("-145 (QA-302): ...and it does not silently equal the org-wide figure while the portal half is narrowed",
        (k.attendance?.our_roster ?? 0) === 0
        || (sk.attendance?.portal_roster ?? 0) === (k.attendance?.portal_roster ?? 0)
        || (sk.attendance?.our_roster ?? 0) !== (k.attendance?.our_roster ?? 0),
        JSON.stringify({ spoc_our: sk.attendance?.our_roster, admin_our: k.attendance?.our_roster, spoc_portal: sk.attendance?.portal_roster, admin_portal: k.attendance?.portal_roster }));
    }
  }

  // G-08: the two dead tiles are replaced by counts that must agree with the trainers list.
  ok("-138 (G-08): Home carries the two counts Umesh asked for",
    typeof k.trainers_nominated_total === "number" && typeof k.trainers_certified_free === "number",
    JSON.stringify({ nom: k.trainers_nominated_total, free: k.trainers_certified_free }));
  ok("-138 (G-08): ...and the breakdown adds up — certified = free + already on a live batch",
    (k.trainers_certified_free + k.trainers_certified_busy) === k.trainers_certified_total,
    JSON.stringify({ free: k.trainers_certified_free, busy: k.trainers_certified_busy, total: k.trainers_certified_total }));
  // the number a manager quotes must be the SAME number the trainers screen shows
  const trs = (await req(admin, "GET", "/api/trainers?limit=2000", undefined, 200)).data.items ?? [];
  const freeOnList = trs.filter((t) => t.pipeline_status === "Certified" && (t.live_batches?.length ?? 0) === 0 && t.active !== false).length;
  ok("-138 (G-08): the Home count and the trainers list agree on 'certified and free'",
    k.trainers_certified_free === freeOnList, JSON.stringify({ home: k.trainers_certified_free, list: freeOnList }));
}

finish();
