// Eval: candidate ↔ batch enrollment — the roster worklist, the 80% readiness boundary, drops,
// and the 2026-08-13 rule that a sheet-imported batch's wrong centre/job-role is correctable
// ONLY while the batch is still Planning with an empty roster.
import { ok, req, adminLogin, finish, stamp, phone, today } from "./e2e-lib.mjs";

const admin = await adminLogin();
const s = stamp("EE");

const prog = (await req(admin, "POST", "/api/programs", { code: s, name: "EvalEnr Prog " + s, trainer_skill: "EESkill" + s }, 201)).data.item;
const prog2 = (await req(admin, "POST", "/api/programs", { code: "Q" + s, name: "EvalEnr Prog2 " + s, trainer_skill: "EESkill2" + s }, 201)).data.item;
const loc = (await req(admin, "POST", "/api/locations", { code: "L" + s, name: "TEST-EvalEnr Loc " + s, approval_status: "Approved", city: "Agra" }, 201)).data.item;
const loc2 = (await req(admin, "POST", "/api/locations", { code: "M" + s, name: "TEST-EvalEnr Loc2 " + s, approval_status: "Approved", city: "Mathura" }, 201)).data.item;
const room = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "CR1", type: "Classroom" }, 201)).data.item;
const trainer = (await req(admin, "POST", "/api/trainers", { name: "TEST-EE Trainer " + s, phone: phone("9"), skills: ["EESkill" + s] }, 201)).data.item;

// target_size 5 → the 80% roster gate needs exactly 4.
const batch = (await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, room: room._id, planned_start: today(), target_size: 5 }, 201)).data.item;

// ---- Part B guard: location/program correction window ----
// [best] while Planning + empty roster, both are correctable (the wrong-import fix).
await req(admin, "PATCH", `/api/batches/${batch._id}`, { location: loc2._id }, 200);
await req(admin, "PATCH", `/api/batches/${batch._id}`, { location: loc._id }, 200); // put it back
const afterFix = (await req(admin, "GET", `/api/batches/${batch._id}`, undefined, 200)).data.item;
ok("[best] Planning+empty batch accepts a location correction", String(afterFix.location?._id ?? afterFix.location) === String(loc._id));

// candidates for the roster
const cands = [];
for (let i = 0; i < 5; i++) {
  cands.push((await req(admin, "POST", "/api/candidates", { name: `TEST-EE Cand${i} ` + s, phone: phone(String(80 + i)), location: loc._id, program: prog._id }, 201)).data.item);
}

// [best] assignment moves the candidate's lifecycle and shows up in the members worklist.
const m0 = (await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: cands[0]._id }, 201)).data.item;
const c0 = (await req(admin, "GET", `/api/candidates/${cands[0]._id}`, undefined, 200)).data.item;
ok("[best] assigned candidate's lifecycle is Assigned", c0.lifecycle_status === "Assigned", c0.lifecycle_status);
const work0 = (await req(admin, "GET", `/api/batches/${batch._id}/members`, undefined, 200)).data.items ?? [];
ok("[best] worklist shows the member with enrollment Pending", work0.length === 1 && work0[0].enrollment_status !== "Completed", JSON.stringify(work0[0]?.enrollment_status));

// [worst] a batch with a roster refuses the location/program correction (Part B guard).
await req(admin, "PATCH", `/api/batches/${batch._id}`, { program: prog2._id }, 409);
await req(admin, "PATCH", `/api/batches/${batch._id}`, { location: loc2._id }, 409);

// [best] the 3 enrollment steps tick individually; all three = Completed.
await req(admin, "PATCH", `/api/members/${m0._id}`, { reg_done: true }, 200);
let w = (await req(admin, "GET", `/api/batches/${batch._id}/members`, undefined, 200)).data.items[0];
ok("[best] one step done ≠ Completed", w.enrollment_status !== "Completed", w.enrollment_status);
await req(admin, "PATCH", `/api/members/${m0._id}`, { kyc_done: true, accept_done: true }, 200);
w = (await req(admin, "GET", `/api/batches/${batch._id}/members`, undefined, 200)).data.items[0];
ok("[best] all three steps → enrollment Completed", w.enrollment_status === "Completed", w.enrollment_status);

// [worst] the same candidate cannot be added to the batch twice.
const dupAdd = await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: cands[0]._id });
ok("[worst] double-assignment refused", dupAdd.status >= 400, `got ${dupAdd.status}`);

// ---- QA-147 (-76): bulk enrollment — Manish's 135-click wall. Two members, ONE request. ----
{
  const mA = (await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: cands[1]._id }, 201)).data.item;
  const mB = (await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: cands[2]._id }, 201)).data.item;
  const bad = await req(admin, "POST", `/api/batches/${batch._id}/members/bulk-enroll`, { step: "nonsense" });
  ok("QA-147: bulk-enroll refuses an unknown step (400)", bad.status === 400, String(bad.status));
  const one = await req(admin, "POST", `/api/batches/${batch._id}/members/bulk-enroll`, { step: "reg_done", member_ids: [mA._id, mB._id] }, 200);
  ok("QA-147: bulk 'reg_done' updates both selected members", one.data.updated === 2 && one.data.skipped === 0, JSON.stringify(one.data));
  const again = await req(admin, "POST", `/api/batches/${batch._id}/members/bulk-enroll`, { step: "reg_done", member_ids: [mA._id, mB._id] }, 200);
  ok("QA-147: re-running the same step is idempotent (skipped, not re-stamped)", again.data.updated === 0 && again.data.skipped === 2, JSON.stringify(again.data));
  const all = await req(admin, "POST", `/api/batches/${batch._id}/members/bulk-enroll`, { step: "all", member_ids: [mA._id, mB._id] }, 200);
  ok("QA-147: 'all' completes enrollment for the selection in one call", all.data.updated === 2, JSON.stringify(all.data));
  const wl = (await req(admin, "GET", `/api/batches/${batch._id}/members`, undefined, 200)).data.items ?? [];
  const both = wl.filter((m) => [String(mA._id), String(mB._id)].includes(String(m._id)));
  ok("QA-147: both members read back Completed via the same Rule 24 derivation", both.length === 2 && both.every((m) => m.enrollment_status === "Completed"), JSON.stringify(both.map((m) => m.enrollment_status)));
  // Blocker text (Manish: "Not ready: room assigned" read backwards). Health on a Planning
  // batch missing a room must SAY "room not assigned".
  const noRoomBatch = (await req(admin, "POST", "/api/batches", { location: loc2._id, program: prog2._id, planned_start: today(), target_size: 5 }, 201)).data.item;
  const health = (await req(admin, "GET", `/api/batches/${noRoomBatch._id}`, undefined, 200)).data;
  const notReady = (health.health?.reasons ?? []).find((r) => r.code === "not_ready");
  ok("QA-147: the readiness blocker names the FAILURE ('room not assigned'), never the check ('room assigned')",
    !!notReady && /room not assigned/.test(notReady.label) && !/Not ready: room assigned/.test(notReady.label), notReady?.label);
  await req(admin, "POST", `/api/batches/${noRoomBatch._id}/transition`, { target: "Cancelled", reason: "QA-147 pin cleanup" }, 200);
}
// ---- the 80% boundary (Rule 16) ---- (cands[1..2] already Completed via bulk above)
// 3 of 5 = 60% — below the gate.
await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Ready" }, 409);
const m3 = (await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: cands[3]._id }, 201)).data.item;
await req(admin, "PATCH", `/api/members/${m3._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
// 4 of 5 = exactly 80% — the boundary itself must pass.
const ready = await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Ready" });
ok("[avg] exactly 80% roster passes the Ready gate (boundary, not off-by-one)", ready.status === 200, `got ${ready.status}: ${JSON.stringify(ready.data).slice(0, 120)}`);

// [worst] Ready batch also refuses the location/program correction.
await req(admin, "PATCH", `/api/batches/${batch._id}`, { location: loc2._id }, 409);

// ---- drop with a reason ----
await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Active" }, 200);
const dropNo = await req(admin, "POST", `/api/members/${m3._id}/drop`, {});
ok("[worst] drop without a reason is refused (Rule 25)", dropNo.status === 400, `got ${dropNo.status}`);
const drop = await req(admin, "POST", `/api/members/${m3._id}/drop`, { left_on: today(), drop_reason: "Family relocation" });
ok("[best] drop with a reason succeeds", drop.status === 200, `got ${drop.status}: ${JSON.stringify(drop.data).slice(0, 100)}`);
const afterDrop = (await req(admin, "GET", `/api/batches/${batch._id}/members`, undefined, 200)).data.items ?? [];
ok("[best] the roster worklist no longer counts the dropped member as live", afterDrop.filter((m) => !m.left_on).length === 3, JSON.stringify(afterDrop.map((m) => !!m.left_on)));
const droppedCand = (await req(admin, "GET", `/api/candidates/${cands[3]._id}`, undefined, 200)).data.item;
ok("[best] dropped candidate returns to the pool as Dropped", droppedCand.lifecycle_status === "Dropped", droppedCand.lifecycle_status);

// teardown so later suites see clean KPIs
await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Cancelled", reason: "eval fixture teardown" });

finish();
