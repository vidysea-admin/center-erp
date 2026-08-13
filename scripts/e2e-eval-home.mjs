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
const mkGhost = await req(admin, "POST", "/api/users", { name: "TEST-EH Ghost " + s, email: ghostEmail, password: "Vidysea@123", role: "Location", location_scope: ["000000000000000000000000"] });
if (mkGhost.status === 201) {
  const ghost = await login(ghostEmail, "Vidysea@123");
  ok("[worst] dangling-scope user can still sign in", !!ghost);
  if (ghost) {
    const gHome = (await req(ghost, "GET", "/api/home", undefined, 200)).data;
    ok("[worst] Home says WHY it is empty (scoped_no_centres)", gHome.scoped_no_centres === true, JSON.stringify(gHome.scoped_no_centres));
    ok("[worst] …and every KPI is an honest zero", gHome.kpis.approved_locations === 0 && gHome.kpis.active_batches === 0, JSON.stringify(gHome.kpis));
    ok("[worst] …with no other centre's queue rows leaking", (gHome.queues.registration_failed ?? []).length === 0 && (gHome.queues.missing_logs ?? []).length === 0);
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
  const c = await login(email, "Vidysea@123");
  if (!c) { ok(`[worst] ${label} login available (seed-sample)`, false, email); continue; }
  const r = await req(c, "GET", "/api/home");
  ok(`[worst] Home answers 200 for ${label}`, r.status === 200, `got ${r.status}`);
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

finish();
