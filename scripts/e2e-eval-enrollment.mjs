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

// [best] the 4 enrollment steps tick individually; all four = Completed.
await req(admin, "PATCH", `/api/members/${m0._id}`, { reg_done: true }, 200);
let w = (await req(admin, "GET", `/api/batches/${batch._id}/members`, undefined, 200)).data.items[0];
ok("[best] one step done ≠ Completed", w.enrollment_status !== "Completed", w.enrollment_status);
await req(admin, "PATCH", `/api/members/${m0._id}`, { kyc_done: true, enroll_done: true, accept_done: true }, 200);
w = (await req(admin, "GET", `/api/batches/${batch._id}/members`, undefined, 200)).data.items[0];
ok("[best] all four steps → enrollment Completed", w.enrollment_status === "Completed", w.enrollment_status);

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
  ok("QA-148: the readiness blocker names the FAILURE ('room not assigned'), never the check ('room assigned')",
    !!notReady && /room not assigned/.test(notReady.label) && !/Not ready: room assigned/.test(notReady.label), notReady?.label);
  await req(admin, "POST", `/api/batches/${noRoomBatch._id}/transition`, { target: "Cancelled", reason: "QA-147 pin cleanup" }, 200);
}
// ---- Rule 55 (QA-1824, Umesh live): step-order gate — a later step refused while an earlier
// one is still open, unless the caller confirms a backfill. Own batch (target_size 50, well
// clear of Rule 48) so this doesn't disturb the 80%-boundary math right below, which depends on
// the exact active-Completed count on `batch`. ----
{
  const r55room = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "R55-CR", type: "Classroom" }, 201)).data.item;
  const r55trainer = (await req(admin, "POST", "/api/trainers", { name: "TEST-R55 Trainer " + s, phone: phone("93"), skills: ["EESkill" + s] }, 201)).data.item;
  const r55batch = (await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, trainer: r55trainer._id, room: r55room._id, planned_start: today(), target_size: 50 }, 201)).data.item;
  const r55c1 = (await req(admin, "POST", "/api/candidates", { name: "TEST-EE R55C1 " + s, phone: phone("91"), location: loc._id, program: prog._id }, 201)).data.item;
  const r55c2 = (await req(admin, "POST", "/api/candidates", { name: "TEST-EE R55C2 " + s, phone: phone("92"), location: loc._id, program: prog._id }, 201)).data.item;
  const mm1 = (await req(admin, "POST", `/api/batches/${r55batch._id}/members`, { candidate: r55c1._id }, 201)).data.item;
  const mm2 = (await req(admin, "POST", `/api/batches/${r55batch._id}/members`, { candidate: r55c2._id }, 201)).data.item;

  // [worst] Batch Accept directly, nothing else done yet.
  const gap = await req(admin, "PATCH", `/api/members/${mm1._id}`, { accept_done: true });
  ok("QA-1824 [worst] Rule 55: Batch Accept refused while Registration/e-KYC/Enrollment are all open", gap.status === 409, `got ${gap.status}: ${JSON.stringify(gap.data).slice(0, 160)}`);
  ok("QA-1824 [worst] the refusal names all three missing steps, no rule code on screen",
    ["Registration", "e-KYC", "Enrollment"].every((w) => (gap.data?.error ?? "").includes(w)) && !/Rule\s*55/i.test(gap.data?.error ?? ""),
    gap.data?.error);
  const afterGap = (await req(admin, "GET", `/api/batches/${r55batch._id}/members`, undefined, 200)).data.items ?? [];
  const mm1row = afterGap.find((m) => String(m._id) === String(mm1._id));
  ok("QA-1824 [worst] accept_done was NOT persisted by the refused request", mm1row?.accept_done !== true, JSON.stringify(mm1row?.accept_done));

  // [best] the same request, confirmed — every missing step backfills alongside the one asked for.
  const backfilled = await req(admin, "PATCH", `/api/members/${mm1._id}`, { accept_done: true, confirm_backfill: true }, 200);
  const it = backfilled.data.item;
  ok("QA-1824 [best] confirm_backfill sets every earlier step true alongside the requested one",
    it.reg_done === true && it.kyc_done === true && it.enroll_done === true && it.accept_done === true,
    JSON.stringify({ reg: it.reg_done, kyc: it.kyc_done, enroll: it.enroll_done, accept: it.accept_done }));
  ok("QA-1824 [best] each backfilled step carries its own _at timestamp", !!it.reg_done_at && !!it.kyc_done_at && !!it.enroll_done_at && !!it.accept_done_at,
    JSON.stringify({ reg: it.reg_done_at, kyc: it.kyc_done_at, enroll: it.enroll_done_at, accept: it.accept_done_at }));
  ok("QA-1824 [best] enrollment_status derives Completed from the backfill", it.enrollment_status === "Completed", it.enrollment_status);

  // [best] turning a step OFF is never gated — regression control, same member, same request shape.
  const turnOff = await req(admin, "PATCH", `/api/members/${mm1._id}`, { reg_done: false }, 200);
  ok("QA-1824 [best] turning a step OFF succeeds with no confirmation required (Rule 55 only gates ON-transitions)", turnOff.data.item.reg_done === false, JSON.stringify(turnOff.data.item.reg_done));

  // [worst] a MIDDLE step (Enrollment) directly, with only Registration done — e-KYC still open.
  await req(admin, "PATCH", `/api/members/${mm2._id}`, { reg_done: true }, 200);
  const midGap = await req(admin, "PATCH", `/api/members/${mm2._id}`, { enroll_done: true });
  ok("QA-1824 [worst] Rule 55 also gates a MIDDLE step, not only Batch Accept", midGap.status === 409, `got ${midGap.status}`);
  // plain() (src/lib/user-copy.ts) sentence-cases the first character of a message that reaches
  // the screen — "e-KYC" leading the sentence reads "E-KYC", same as it would for any other
  // rule-coded refusal in this codebase. Case-insensitive match, so this pin tracks the rule's
  // actual behaviour rather than a coincidence of capitalization.
  const midMsg = (midGap.data?.error ?? "").toLowerCase();
  ok("QA-1824 [worst] the middle-step message names only e-KYC as missing (Registration already done)",
    midMsg.includes("e-kyc") && !midMsg.includes("registration"), midGap.data?.error);

  // [best] a single PATCH that sets the gap-closing step in the SAME request needs no confirm.
  const samePatch = await req(admin, "PATCH", `/api/members/${mm2._id}`, { kyc_done: true, enroll_done: true }, 200);
  ok("QA-1824 [best] setting the gap-closing step in the same request needs no confirm_backfill",
    samePatch.data.item.kyc_done === true && samePatch.data.item.enroll_done === true, JSON.stringify(samePatch.data.item));

  // [avg] the bulk 'accept_done' path hits the same per-member gate — a THIRD, still-fresh member
  // (mm2 is deliberately not reused: the "same request" pin just above already closed all of its
  // earlier steps, so it would carry no gap left to hit).
  const r55c3 = (await req(admin, "POST", "/api/candidates", { name: "TEST-EE R55C3 " + s, phone: phone("94"), location: loc._id, program: prog._id }, 201)).data.item;
  const mm3 = (await req(admin, "POST", `/api/batches/${r55batch._id}/members`, { candidate: r55c3._id }, 201)).data.item;
  const bulkGap = await req(admin, "POST", `/api/batches/${r55batch._id}/members/bulk-enroll`, { step: "accept_done", member_ids: [mm3._id] }, 200);
  ok("QA-1824 [worst] bulk-enroll surfaces the same per-member gate as a failure, not a silent skip",
    bulkGap.data.failed?.length === 1 && bulkGap.data.updated === 0, JSON.stringify(bulkGap.data));
  const bulkBackfilled = await req(admin, "POST", `/api/batches/${r55batch._id}/members/bulk-enroll`, { step: "accept_done", member_ids: [mm3._id], confirm_backfill: true }, 200);
  ok("QA-1824 [best] bulk-enroll with confirm_backfill succeeds through the same gate",
    bulkBackfilled.data.updated === 1, JSON.stringify(bulkBackfilled.data));

  await req(admin, "POST", `/api/batches/${r55batch._id}/transition`, { target: "Cancelled", reason: "QA-1824 pin cleanup" });
}
// ---- the 80% boundary (Rule 16) ---- (cands[1..2] already Completed via bulk above)
// 3 of 5 = 60% — below the gate.
await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Ready" }, 409);
const m3 = (await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: cands[3]._id }, 201)).data.item;
await req(admin, "PATCH", `/api/members/${m3._id}`, { reg_done: true, kyc_done: true, enroll_done: true, accept_done: true }, 200);
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

// ---- -250 (Umesh, 25/08, on Ashish Rana / AVP-GURU-RPLAVP-DST-03): a member who LEFT is read-only ----
// "log rakho candidate wale mai but baaki jagah se tho data naa dikhee." Until this unit the closure
// card offered live Pass/Fail/Absent buttons for a departed student and the SERVER took them: the
// batch status was checked, the member was checked, Rule 44 was checked, the A-09 eligibility gate
// was checked, and `left_on` was never asked about anywhere. The tab meanwhile carried a tooltip
// promising "a member who has left cannot be marked".
//
// The NEGATIVE CONTROL runs FIRST and on purpose. Without it this whole block passes just as well on
// a door that refuses everybody, which is the shape QA-1165 is on the ledger for - "the pin that
// could not fail on this defect, before or after the fix".
{
  const okMark = await req(admin, "PUT", `/api/batches/${batch._id}/results`, { rows: [{ member: m0._id, result: "Absent" }] });
  ok("[best] control: an ACTIVE member can still be marked", okMark.status === 200, `got ${okMark.status}: ${JSON.stringify(okMark.data).slice(0, 160)}`);

  const marked = await req(admin, "PUT", `/api/batches/${batch._id}/results`, { rows: [{ member: m3._id, result: "Absent" }] });
  const msg = JSON.stringify(marked.data ?? {});
  ok("[worst] a member who has left cannot be marked", marked.status >= 400, `got ${marked.status}: ${msg.slice(0, 200)}`);
  // The STATUS alone is worthless here: a 500 satisfies it, and so does an unrelated refusal. What
  // the operator needs is WHO and WHEN, and that is what is asserted.
  ok("[worst] the refusal names the candidate", msg.includes(cands[3].name), msg.slice(0, 240));
  ok("[worst] the refusal names the date they left", msg.includes(new Date(today()).toLocaleDateString("en-IN")), msg.slice(0, 240));

  // The guard sits AHEAD of Rule 44, so a Fail with no reason on a departed member is answered by
  // the departure, not by the missing reason. If this ever starts returning Rule 44's wording the
  // guard has drifted below the checks it is supposed to precede.
  const failNoReason = await req(admin, "PUT", `/api/batches/${batch._id}/results`, { rows: [{ member: m3._id, result: "Fail" }] });
  ok("[worst] the departure is the answer, ahead of the failure-reason rule",
    JSON.stringify(failNoReason.data ?? {}).includes("left this batch on"), JSON.stringify(failNoReason.data ?? {}).slice(0, 200));

  // Rule 42 survives: the record Umesh asked to KEEP is still there, still carrying its leave date.
  const resAfter = (await req(admin, "GET", `/api/batches/${batch._id}/results`, undefined, 200)).data.items ?? [];
  const dropRow = resAfter.find((i) => String(i.member) === String(m3._id));
  ok("[best] the departed member is still IN the results payload, with left_on", !!dropRow && !!dropRow.left_on, JSON.stringify(dropRow ?? null).slice(0, 200));
  ok("[best] and the payload carries the drop reason for the card to print", dropRow?.drop_reason === "Family relocation", String(dropRow?.drop_reason));

  // The SECOND door on the same route. `sidh_candidate_id` / `apaar_id` are written by their own
  // loop, independently of the marking call - so on a multi-row save where one member has left,
  // `updated > 0` means the throw never fires and the identity write would have gone through for
  // somebody the screen no longer offers. One valid active row rides along on purpose: this must
  // SKIP the departed row, not refuse the whole save.
  const beforeApaar = (await req(admin, "GET", `/api/candidates/${cands[3]._id}`, undefined, 200)).data.item.apaar_id ?? null;
  const mixed = await req(admin, "PUT", `/api/batches/${batch._id}/results`, { rows: [
    { member: m0._id, result: "Absent" },
    { member: m3._id, apaar_id: "123456789012" },
  ] });
  ok("[avg] a mixed save still succeeds for the active rows", mixed.status === 200, `got ${mixed.status}: ${JSON.stringify(mixed.data).slice(0, 160)}`);
  const afterApaar = (await req(admin, "GET", `/api/candidates/${cands[3]._id}`, undefined, 200)).data.item.apaar_id ?? null;
  ok("[worst] the departed member's identity fields were NOT rewritten", afterApaar === beforeApaar, `before=${beforeApaar} after=${afterApaar}`);
}

// teardown so later suites see clean KPIs
await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Cancelled", reason: "eval fixture teardown" });

finish();
