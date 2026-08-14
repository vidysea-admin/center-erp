// End-to-end walkthrough + rule assertions against a running server (default http://localhost:3000).
// Run: node scripts/e2e.mjs
const BASE = process.env.BASE_URL || "http://localhost:3000/erp";
let cookie = "";
let pass = 0, fail = 0;

function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name} ${extra}`); }
}

async function req(method, path, body, expectStatus) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (expectStatus !== undefined) {
    ok(`${method} ${path} → ${expectStatus}`, res.status === expectStatus, `(got ${res.status}: ${JSON.stringify(data).slice(0, 120)})`);
  }
  return { status: res.status, data };
}

// ---- login ----
const csrfRes = await fetch(BASE + "/api/auth/csrf");
const { csrfToken } = await csrfRes.json();
const csrfCookie = csrfRes.headers.get("set-cookie").split(";")[0];
const loginRes = await fetch(BASE + "/api/auth/callback/credentials", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: csrfCookie },
  body: new URLSearchParams({ csrfToken, email: "admin@vidysea.com", password: process.env.ADMIN_PASSWORD || "admin123" }),
  redirect: "manual",
});
const setCookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get("set-cookie")];
const session = setCookies.flat().filter(Boolean).map((c) => c.split(";")[0]).find((c) => c.includes("session-token"));
ok("login issues session cookie", !!session);
cookie = [csrfCookie, session].join("; ");

const stamp = Date.now().toString().slice(-6);

// ---- masters ----
const prog = (await req("POST", "/api/programs", { code: "PROG" + stamp, name: "Test Program " + stamp, trainer_skill: "TestSkill" + stamp, duration_days: 15, buffer_days: 5, default_batch_size: 30, completion_deadline_days: 90 }, 201)).data.item;
const loc = (await req("POST", "/api/locations", { code: "LOC" + stamp, name: "Test Location " + stamp, external_id: "EXT" + stamp, approval_status: "Approved", spoc_name: "Test SPOC" }, 201)).data.item;
const room = (await req("POST", `/api/locations/${loc._id}/rooms`, { name: "Classroom 1", type: "Classroom", capacity: 30 }, 201)).data.item;
const trainer = (await req("POST", "/api/trainers", { name: "Trainer " + stamp, phone: "99999" + stamp.slice(0, 5), skills: ["TestSkill" + stamp] }, 201)).data.item;

// capacity math (§5)
await req("PUT", `/api/locations/${loc._id}/targets`, { program: prog._id, approved_target: 210 }, 200);
const targets = (await req("GET", `/api/locations/${loc._id}/targets`)).data.items;
ok("capacity: 210 → 7 batches, 2 trainers", targets[0]?.capacity?.batches_required === 7 && targets[0]?.capacity?.trainers_required === 2, JSON.stringify(targets[0]?.capacity));

// ---- candidates ----
const cands = [];
for (let i = 0; i < 3; i++) {
  cands.push((await req("POST", "/api/candidates", { name: `Cand ${i} ${stamp}`, phone: `88888${stamp.slice(0, 4)}${i}`, location: loc._id, program: prog._id }, 201)).data.item);
}

// ---- batch ----
// LOCAL calendar date, exactly what the UI sends (toInputDate). The UTC version broke the
// whole wall in the IST 00:00-05:30 window: dayKey(actual_start) uses LOCAL day for Date
// objects, so a UTC "today" string read as YESTERDAY and Rule 32 rejected every log.
const _n = new Date();
const today = `${_n.getFullYear()}-${String(_n.getMonth() + 1).padStart(2, "0")}-${String(_n.getDate()).padStart(2, "0")}`;
const batch = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, room: room._id, planned_start: today, target_size: 3 }, 201)).data.item;
ok("batch code auto-assigned (B###)", /^B\d+$/.test(batch.code), batch.code);
const end = new Date(batch.planned_end), start = new Date(batch.planned_start);
ok("Rule 15: planned_end = start + 20 days", Math.round((end - start) / 86400000) === 20);

// Rule 16: not ready with empty roster
await req("POST", `/api/batches/${batch._id}/transition`, { target: "Ready" }, 409);

// assign members
for (const c of cands) await req("POST", `/api/batches/${batch._id}/members`, { candidate: c._id }, 201);
// Rule 20: re-assign active candidate → block
await req("POST", `/api/batches/${batch._id}/members`, { candidate: cands[0]._id }, 409);

// now Ready should pass (location approved, room, trainer, roster 3/3 ≥ 80%)
await req("POST", `/api/batches/${batch._id}/transition`, { target: "Ready" }, 200);

// Ready→Active blocked: enrollment threshold not met
await req("POST", `/api/batches/${batch._id}/transition`, { target: "Active" }, 409);

// enrollment worklist
const members = (await req("GET", `/api/batches/${batch._id}/members`)).data.items;
// Rule 23: Failed requires issue
await req("PATCH", `/api/members/${members[0]._id}`, { failed: true }, 400);
// complete all three steps for everyone (Rule 24 derivation)
for (const m of members) {
  const r = await req("PATCH", `/api/members/${m._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
  ok("Rule 24: derived Completed", r.data.item.enrollment_status === "Completed");
}
// candidate lifecycle → Enrolled (Rule 21)
const c0 = (await req("GET", `/api/candidates/${cands[0]._id}`)).data.item;
ok("Rule 21: candidate lifecycle Enrolled", c0.lifecycle_status === "Enrolled", c0.lifecycle_status);

// start batch
await req("POST", `/api/batches/${batch._id}/transition`, { target: "Active" }, 200);

// ---- trainer / room conflicts ----
// Rule 10 (2026-08-11 meeting: "up to four batches का provision" — cap is 4 now, was 5).
// The 2nd–4th overlapping batch is allowed; the 5th is blocked.
const extraBatches = [];
for (let i = 0; i < 3; i++) {
  const r = await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, planned_start: today, target_size: 3 }, 201);
  extraBatches.push(r.data.item?._id);
}
ok("Rule 10: trainer may hold 4 concurrent batches", extraBatches.every(Boolean));
await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, planned_start: today, target_size: 3 }, 409);
// 2026-08-11 slot clash: same trainer, same dates, overlapping time slots → 409 outright…
await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, planned_start: today, target_size: 3, slot_start: "09:00", slot_end: "13:00" }, 409); // cap already hit
// (cancel one so the cap has room, then prove the slot logic itself)
await req("POST", `/api/batches/${extraBatches[2]}/transition`, { target: "Cancelled", reason: "slot test" }, 200);
const s1 = await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, planned_start: today, target_size: 3, slot_start: "09:00", slot_end: "13:00" }, 201);
extraBatches[2] = s1.data.item?._id;
// same time window → blocked even though cap (4) is not exceeded after this fails
await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, planned_start: today, target_size: 3, slot_start: "12:00", slot_end: "16:00" }, 409);
ok("Slot clash: overlapping trainer time slots hard-blocked", true);
// Rule 13: same room, overlapping, same session → 409
await req("POST", "/api/batches", { location: loc._id, program: prog._id, room: room._id, planned_start: today, target_size: 3 }, 409);
// different session (Morning vs Full Day) still conflicts per rule
await req("POST", "/api/batches", { location: loc._id, program: prog._id, room: room._id, planned_start: today, target_size: 3, session: "Morning" }, 409);

// Release the concurrency-test batches so later assertions see a clean trainer workload.
for (const id of extraBatches) {
  await req("POST", `/api/batches/${id}/transition`, { target: "Cancelled", reason: "concurrency test cleanup" }, 200);
}

// ---- daily log ----
const mIds = members.map((m) => m._id);
// Rule 29: present > roster
await req("POST", `/api/batches/${batch._id}/logs`, { log_date: today, present_member_ids: [...mIds, mIds[0]] }, 400);
// Rule 30: govt_present > roster
await req("POST", `/api/batches/${batch._id}/logs`, { log_date: today, present_member_ids: mIds.slice(0, 2), govt_present: 5 }, 400);
// valid
const log = (await req("POST", `/api/batches/${batch._id}/logs`, { log_date: today, present_member_ids: mIds.slice(0, 2), govt_present: 2, actual_topic: "Day 1" }, 201)).data.item;
ok("Rule 28: roster_count frozen at 3", log.roster_count === 3);
// 2026-08-12 audit F-008 (S1): log_date used to be midnight in the SERVER PROCESS's timezone, so
// the same calendar day written by a laptop in IST and by the container in UTC were different
// instants. The missing-log lookups compared them for exact equality, so the alarm reported
// "no daily log for 8 operating days" directly above a table listing five of them. The stored
// value must now be the calendar date itself, pinned to UTC midnight, whatever TZ this runs in.
ok("F-008: log_date stored as a timezone-independent calendar date",
  new Date(log.log_date).toISOString() === `${today}T00:00:00.000Z`,
  `${new Date(log.log_date).toISOString()} for ${today}`);
{
  const h = (await req("GET", `/api/batches/${batch._id}`)).data.health;
  const missing = (h?.reasons ?? []).filter((r) => r.code === "missing_logs");
  ok("F-008: a batch logged today is not reported as missing its log", missing.length === 0, JSON.stringify(missing.map((m) => m.label)));
}
// Rule 27 now also catches a same-calendar-day duplicate written under the old encoding.
await req("POST", `/api/batches/${batch._id}/logs`, { log_date: `${today}T09:30:00.000Z`, present_member_ids: [] }, 409);
// Rule 27 (unique): duplicate date → 409
await req("POST", `/api/batches/${batch._id}/logs`, { log_date: today, present_member_ids: [] }, 409);
// Rule 32: date before actual_start
await req("POST", `/api/batches/${batch._id}/logs`, { log_date: "2020-01-01", present_member_ids: [] }, 400);

// 2026-08-12 audit F-007 (S1): dropping a candidate on day D used to lock day D's log. Rule 26
// excludes them from that day's roster, the saved log still listed them present, and every later
// PATCH touching present_member_ids or govt_present was refused — so the government attendance
// figure for that day could never be entered. Editing note/photos still worked, which made the
// failure look random. Reproduced on production before the fix.
{
  const fresh = (await req("POST", "/api/candidates", { name: `Drop Log ${stamp}`, phone: `77770${stamp}`, location: loc._id, program: prog._id }, 201)).data.item;
  const fm = (await req("POST", `/api/batches/${batch._id}/members`, { candidate: fresh._id }, 201)).data.item;
  const rosterBefore = (await req("GET", `/api/batches/${batch._id}/logs`)).data.items[0]?.roster_count;
  // put them on today's log, then drop them today
  const withThem = [...mIds.slice(0, 2), fm._id];
  await req("PATCH", `/api/logs/${log._id}`, { present_member_ids: withThem }, 200);
  await req("POST", `/api/members/${fm._id}/drop`, { left_on: today, drop_reason: "Got a job" }, 200);
  // the log must have been tidied, not left inconsistent
  const tidied = (await req("GET", `/api/batches/${batch._id}/logs`)).data.items.find((l) => l._id === log._id);
  ok("F-007: dropping a member strips them from that day's present list", !tidied.present_member_ids.map(String).includes(String(fm._id)));
  ok("F-007: internal_present follows the tidy-up", tidied.internal_present === tidied.present_member_ids.length, `${tidied.internal_present} vs ${tidied.present_member_ids.length}`);
  ok("F-007: Rule 28 roster_count still frozen after a drop", tidied.roster_count === rosterBefore, `${tidied.roster_count} vs ${rosterBefore}`);
  // …and the number that matters can still be entered
  await req("PATCH", `/api/logs/${log._id}`, { govt_present: 1 }, 200);
  await req("PATCH", `/api/logs/${log._id}`, { note: "still editable" }, 200);
  // Rule 30 bounds still enforced against the frozen roster
  await req("PATCH", `/api/logs/${log._id}`, { govt_present: 999 }, 400);
  await req("PATCH", `/api/logs/${log._id}`, { govt_present: -1 }, 400);
}

// ---- Rule 51 + marking rounds (Karunn 2026-08-13) ----
{
  // Rule 51: "biometric done & NOT present" cannot happen — reject at day level…
  await req("PATCH", `/api/logs/${log._id}`, { present_member_ids: [mIds[0]], biometric_member_ids: [mIds[1]] }, 400);
  // …and the legal pair round-trips (biometric ⊆ present).
  const ed = (await req("PATCH", `/api/logs/${log._id}`, { present_member_ids: [mIds[0], mIds[1]], biometric_member_ids: [mIds[0]] }, 200)).data.item;
  ok("Rule 51: biometric subset saves and persists", ed.biometric_member_ids.map(String).includes(String(mIds[0])) && ed.biometric_member_ids.length === 1, JSON.stringify(ed.biometric_member_ids));
  ok("day-level edit is recorded as a correction round", (ed.sessions ?? []).some((s) => s.correction), `${ed.sessions?.length} sessions`);

  // Rule 51 on a ROUND: biometric for a student present NOWHERE that day is refused
  // (mIds[2] is not yet in the day union and not in this round's present list).
  await req("POST", `/api/logs/${log._id}/sessions`, { present_member_ids: [], biometric_member_ids: [mIds[2]] }, 400);
  // An empty round is meaningless.
  await req("POST", `/api/logs/${log._id}/sessions`, { present_member_ids: [] }, 400);
  // A later marking ROUND unions into the day: mIds[2] joins via round 2, nobody is lost.
  const before = ed.internal_present;
  const r2 = (await req("POST", `/api/logs/${log._id}/sessions`, { present_member_ids: [mIds[2]], biometric_member_ids: [mIds[2]] }, 201)).data.item;
  ok("marking round unions into the day (present grows by 1)", r2.internal_present === before + 1, `${before} → ${r2.internal_present}`);
  ok("…and the round is timestamped in the history", (r2.sessions ?? []).length >= 2 && !!r2.sessions[r2.sessions.length - 1].at, `${r2.sessions?.length} sessions`);
  ok("…and biometric union follows", r2.biometric_member_ids.map(String).includes(String(mIds[2])), JSON.stringify(r2.biometric_member_ids));
  // Biometric marked in a LATER round for a student present since an earlier round is fine —
  // "bio done & present" across rounds is still bio done & present.
  await req("POST", `/api/logs/${log._id}/sessions`, { present_member_ids: [mIds[1]], biometric_member_ids: [mIds[1]] }, 201);
}

// ---- closure ----
// 2026-08-12 audit F-010 (S0): Rules 43/46 lived only inside the per-candidate branch, and that
// branch is skipped exactly when nobody has been assessed. A batch with zero results could be
// marked assessment Completed → Closing → certification Completed → invoice Raised → Paid, with
// ten candidates ending up lifecycle "Completed" and no evidence anywhere. Completing now
// demands either the batch-level numbers or per-candidate rows.
await req("PUT", `/api/batches/${batch._id}/closure`, { assessment_status: "Completed", assessment_date: today }, 409);
await req("PUT", `/api/batches/${batch._id}/closure`, { assessment_status: "Completed", assessment_date: today, appeared: 3 }, 409);
await req("PUT", `/api/batches/${batch._id}/closure`, { certification_status: "Completed", certification_date: today }, 409);
// sync S1-7: `passed` was unchecked when `appeared` was absent, and certificates_issued never checked.
await req("PUT", `/api/batches/${batch._id}/closure`, { passed: 99 }, 400);
await req("PUT", `/api/batches/${batch._id}/closure`, { appeared: 3, passed: 2, certificates_issued: 3 }, 400);
await req("PUT", `/api/batches/${batch._id}/closure`, { appeared: -1, passed: 0 }, 400);
// Rule 34: appeared > roster on date
await req("PUT", `/api/batches/${batch._id}/closure`, { assessment_status: "Completed", assessment_date: today, appeared: 5, passed: 2 }, 400);
// Rule 19: cancel with logs, non-force → still admin so allowed with reason; test missing reason
await req("POST", `/api/batches/${batch._id}/transition`, { target: "Cancelled" }, 409);
// Active→Closing blocked until assessment complete
await req("POST", `/api/batches/${batch._id}/transition`, { target: "Closing" }, 409);
await req("PUT", `/api/batches/${batch._id}/closure`, { assessment_status: "Completed", assessment_date: today, appeared: 3, passed: 2 }, 200);
await req("POST", `/api/batches/${batch._id}/transition`, { target: "Closing" }, 200);
// Rule 35: ready_for_invoice before certification → 409
await req("PUT", `/api/batches/${batch._id}/closure`, { ready_for_invoice: true }, 409);
await req("PUT", `/api/batches/${batch._id}/closure`, { certification_status: "Completed", certification_date: today, certificates_issued: 2 }, 200);
await req("PUT", `/api/batches/${batch._id}/closure`, { ready_for_invoice: true }, 200);
const inv1 = (await req("GET", `/api/batches/${batch._id}/closure`)).data.invoice;
ok("Rule 35: invoice auto Not Ready→Ready", inv1?.status === "Ready", inv1?.status);
// Rule 36: Raised without invoice_no → 400
await req("PATCH", `/api/batches/${batch._id}/invoice`, { status: "Raised" }, 400);
await req("PATCH", `/api/batches/${batch._id}/invoice`, { status: "Raised", invoice_no: "INV-" + stamp, raised_on: today, amount: 100000 }, 200);
// 2026-08-12 audit (sync S1-6): the money fields stayed editable after Raised, and a field-only
// PATCH skipped the approval gate because it carried no status change.
await req("PATCH", `/api/batches/${batch._id}/invoice`, { amount: 1 }, 409);
await req("PATCH", `/api/batches/${batch._id}/invoice`, { invoice_no: "INV-REWRITTEN" }, 409);
await req("PATCH", `/api/batches/${batch._id}/invoice`, { raised_on: "2020-01-01" }, 409);
// re-sending the same value is not a change, so it must not be refused
await req("PATCH", `/api/batches/${batch._id}/invoice`, { invoice_no: "INV-" + stamp }, 200);
// 2026-08-12 audit (sync S1-5): un-ticking and re-ticking "ready for invoice" used to drag a
// Raised (or Paid) invoice back to Ready, past the monotonic order and the approval gate.
await req("PUT", `/api/batches/${batch._id}/closure`, { ready_for_invoice: false }, 200);
await req("PUT", `/api/batches/${batch._id}/closure`, { ready_for_invoice: true }, 200);
const invAfterRetick = (await req("GET", `/api/batches/${batch._id}/closure`)).data.invoice;
ok("sync S1-5: re-ticking ready does not reset a Raised invoice", invAfterRetick?.status === "Raised", invAfterRetick?.status);
// complete batch
await req("POST", `/api/batches/${batch._id}/transition`, { target: "Completed" }, 200);
const c0b = (await req("GET", `/api/candidates/${cands[0]._id}`)).data.item;
ok("Rule 21: candidate Completed on batch completion", c0b.lifecycle_status === "Completed", c0b.lifecycle_status);

// ---- Rule 52 (CEO 13/08): Completed ≠ Closed — invoice still Raised, dues unset → refused ----
await req("POST", `/api/batches/${batch._id}/transition`, { target: "Closed" }, 409);

// trainer released (Rule 12)
const t2 = (await req("GET", `/api/trainers/${trainer._id}`)).data.item;
ok("Rule 12: trainer derived back to Available", t2.status === "Available", t2.status);

// ---- costs ----
await req("POST", "/api/costs", { category: "000000000000000000000000", amount: 100 }, 400); // Rule 37: no anchor
const cats = (await req("GET", "/api/master-lists/cost-categories")).data.items;
await req("POST", "/api/costs", { category: cats[0]._id, amount: 5000, trainer: trainer._id }, 201); // trainer-only allowed

// F-B17: list names are unique case-insensitively — "Trainer fee" beside "Trainer Fee"
// broke the trainer-fee auto-suggest in production.
await req("POST", "/api/master-lists/cost-categories", { name: "Trainer Fee" }, 409); // exact dupe
const dupeRes = await req("POST", "/api/master-lists/cost-categories", { name: "  trainer FEE  " }, 409); // case + whitespace dupe
ok("F-B17: the refusal names the existing entry", /"Trainer Fee" already exists/.test(dupeRes.data?.error ?? ""), dupeRes.data?.error);
const freshCat = await req("POST", "/api/master-lists/cost-categories", { name: "E2E Cat " + stamp }, 201);
ok("F-B17: a genuinely new name still creates (trimmed)", freshCat.data.item?.name === "E2E Cat " + stamp, freshCat.data.item?.name);

// ---- drop rules ----
const batch2 = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: today, target_size: 3 }, 201)).data.item;
const cand4 = (await req("POST", "/api/candidates", { name: "Cand4 " + stamp, phone: "77777" + stamp.slice(0, 5), location: loc._id, program: prog._id }, 201)).data.item;
const mem4 = (await req("POST", `/api/batches/${batch2._id}/members`, { candidate: cand4._id }, 201)).data.item;
await req("POST", `/api/members/${mem4._id}/drop`, { left_on: today }, 400); // Rule 25: reason required
await req("POST", `/api/members/${mem4._id}/drop`, { left_on: "2030-01-01", drop_reason: "Other" }, 400); // future date
await req("POST", `/api/members/${mem4._id}/drop`, { left_on: today, drop_reason: "Other" }, 200);
const cand4b = (await req("GET", `/api/candidates/${cand4._id}`)).data.item;
ok("Rule 21: dropped candidate lifecycle", cand4b.lifecycle_status === "Dropped", cand4b.lifecycle_status);
// re-assignable after drop (Rule 20/22 spirit)
await req("POST", `/api/batches/${batch2._id}/members`, { candidate: cand4._id }, 409); // same batch: unique(batch,candidate)
const batch3 = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: today, target_size: 3, session: "Morning" }, 201)).data.item;
await req("POST", `/api/batches/${batch3._id}/members`, { candidate: cand4._id }, 201); // different batch OK

// ---- Rule 1: location-status gating (2026-08) ----
const gateLoc = (await req("POST", "/api/locations", { code: "GATE" + stamp, name: "Gate Location " + stamp, approval_status: "Approved" }, 201)).data.item;
await req("POST", "/api/batches", { location: gateLoc._id, program: prog._id, planned_start: today, target_size: 3 }, 201); // Not Started is allowed (advance planning)
await req("PATCH", `/api/locations/${gateLoc._id}`, { operational_status: "Stopped", status_reason: "test" }, 200);
await req("POST", "/api/batches", { location: gateLoc._id, program: prog._id, planned_start: today, target_size: 3 }, 409); // Rule 1

// F-B5 (Manish): a halted centre must stop HIRING too, not just training.
await req("POST", "/api/trainer-requests", { location: gateLoc._id, program: prog._id, required_by_date: today }, 409);
await req("POST", "/api/trainers", { name: "Halted Nominee " + stamp, phone: "58" + stamp.slice(-8), nominated_for_location: gateLoc._id, nominated_for_program: prog._id }, 409);
const reNom = (await req("POST", "/api/trainers", { name: "Re-nominee " + stamp, phone: "59" + stamp.slice(-8) }, 201)).data.item;
await req("PATCH", `/api/trainers/${reNom._id}`, { nominated_for_location: gateLoc._id }, 409); // re-pointing is hiring too
await req("PATCH", `/api/locations/${gateLoc._id}`, { operational_status: "Active", status_reason: "resumed" }, 200);
await req("POST", "/api/trainer-requests", { location: gateLoc._id, program: prog._id, required_by_date: today }, 201); // resumes with the centre
await req("PATCH", `/api/locations/${gateLoc._id}`, { operational_status: "Stopped", status_reason: "test again" }, 200); // restore for Rule 1 asserts below

// ---- F-A3: TOT must finish ≥ lead_tot_done_days (3) before batch start — HARD gate now ----
const totTr = (await req("POST", "/api/trainers", { name: "TOT Lead " + stamp, phone: "56" + stamp.slice(-8), skills: ["totlead" + stamp], pipeline_status: "TOT In Progress" }, 201)).data.item;
const totCert = await req("POST", `/api/trainers/${totTr._id}/transition`, { target: "Certified", payload: { tr_id: "TRL" + stamp } }, 200);
ok("F-A3 fixture: certification stamps tot_done_on", !!totCert.data.item.tot_done_on, JSON.stringify(totCert.data.item.tot_done_on));
const totBatch = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: totTr._id, room: room._id, planned_start: today, target_size: 1 }, 201)).data.item;
const totCand = (await req("POST", "/api/candidates", { name: "TOT Cand " + stamp, phone: "55" + stamp.slice(-8), location: loc._id, program: prog._id }, 201)).data.item;
const totMem = (await req("POST", `/api/batches/${totBatch._id}/members`, { candidate: totCand._id }, 201)).data.item;
await req("PATCH", `/api/members/${totMem._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
const totBlocked = await req("POST", `/api/batches/${totBatch._id}/transition`, { target: "Ready" }, 409);
ok("F-A3: TOT finished today + start today → Ready refused naming tot_lead_ok", /tot_lead_ok/.test(totBlocked.data?.error ?? ""), totBlocked.data?.error);
const in5 = new Date(Date.now() + 5 * 864e5 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
await req("PATCH", `/api/batches/${totBatch._id}`, { planned_start: in5 }, 200);
await req("POST", `/api/batches/${totBatch._id}/transition`, { target: "Ready" }, 200); // 5-day lead clears it
await req("POST", `/api/batches/${totBatch._id}/transition`, { target: "Planning" }, 200);
// Cancel the fixture so its future dates don't hold the shared room against later batches (Rule 13).
await req("POST", `/api/batches/${totBatch._id}/transition`, { target: "Cancelled", reason: "F-A3 fixture done" }, 200);

// ---- Rule 48: enrolled count capped at batch capacity ----
const capBatch = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: today, target_size: 1 }, 201)).data.item;
const capCands = [];
for (let i = 0; i < 2; i++) {
  capCands.push((await req("POST", "/api/candidates", { name: `Cap ${i} ${stamp}`, phone: `77${stamp}${i}`, location: loc._id, program: prog._id }, 201)).data.item);
}
const capMembers = [];
for (const c of capCands) capMembers.push((await req("POST", `/api/batches/${capBatch._id}/members`, { candidate: c._id }, 201)).data.item);
await req("PATCH", `/api/members/${capMembers[0]._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
await req("PATCH", `/api/members/${capMembers[1]._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 409); // Rule 48

// ---- Rule 7: duplicate candidate detection is advisory, never a block ----
const dupPhone = "9" + stamp + "111";
await req("POST", "/api/candidates", { name: "Dup A " + stamp, phone: dupPhone, location: loc._id, program: prog._id }, 201);
const dupCheck = (await req("POST", "/api/candidates/check-duplicate", { name: "Dup B", phone: "+91 " + dupPhone })).data;
ok("Rule 7: duplicate found across phone formats", (dupCheck.duplicates ?? []).length >= 1, JSON.stringify(dupCheck).slice(0, 120));
await req("POST", "/api/candidates", { name: "Dup B " + stamp, phone: dupPhone, location: loc._id, program: prog._id }, 201); // warned, not blocked

// ---- Rule 36: invoice status moves one step forward only ----
const invBatchId = batch._id; // its invoice is "Raised" by this point
await req("PATCH", `/api/batches/${invBatchId}/invoice`, { status: "Paid", paid_on: today }, 200); // forward: legal
await req("PATCH", `/api/batches/${invBatchId}/invoice`, { status: "Ready" }, 409); // backwards: blocked

// ---- Rule 52 continued: invoice now PAID — dues attestation is the last gate to Closed ----
await req("POST", `/api/batches/${batch._id}/transition`, { target: "Closed" }, 409); // paid, but dues unset
const duesRes = await req("PUT", `/api/batches/${batch._id}/closure`, { dues_settled: true, dues_note: "trainer + centre settled " + stamp }, 200);
ok("Rule 52: dues attestation records who/when", !!duesRes.data.item.dues_marked_at, JSON.stringify(duesRes.data.item.dues_marked_at));
const closedRes = await req("POST", `/api/batches/${batch._id}/transition`, { target: "Closed" }, 200);
ok("Rule 52: cert + invoice PAID + no-dues → batch closes", closedRes.data.item.status === "Closed", closedRes.data.item.status);
await req("POST", `/api/batches/${batch._id}/transition`, { target: "Completed" }, 409); // Closed is terminal

// ---- Capacity math honours both constraints ----
const capTargets = (await req("GET", `/api/locations/${loc._id}/targets`)).data.items;
ok("capacity exposes both constraint terms", capTargets[0]?.capacity?.by_deadline === 2 && capTargets[0]?.capacity?.by_concurrency === 2, JSON.stringify(capTargets[0]?.capacity));
ok("targets expose achieved counts", capTargets[0]?.achieved?.enrolled >= 0 && capTargets[0]?.achieved?.remaining_by_certified >= 0, JSON.stringify(capTargets[0]?.achieved));

// ---- F-A9: readiness shortfall → TrainerRequests in one click ----
const p2 = (await req("POST", "/api/programs", { code: "SF" + stamp, name: "Shortfall Prog " + stamp, trainer_skill: "SF" + stamp }, 201)).data.item;
await req("PUT", `/api/locations/${loc._id}/targets`, { program: p2._id, approved_target: 30, trainers_required: 1 }, 200);
const sf1 = await req("POST", "/api/trainer-requests/from-shortfall", { location: loc._id }, 201);
ok("F-A9: the empty trainer slot became a TrainerRequest", sf1.data.created?.some((c) => c.program === p2.name), JSON.stringify(sf1.data.created));
const sf2 = await req("POST", "/api/trainer-requests/from-shortfall", { location: loc._id }, 200);
ok("F-A9: rerun doubles nothing — Open requests are skipped by name",
  sf2.data.summary?.created === 0 && sf2.data.skipped?.some((s) => /already exists/.test(s.reason)), JSON.stringify(sf2.data));
await req("PUT", `/api/locations/${gateLoc._id}/targets`, { program: p2._id, approved_target: 30, trainers_required: 1 }, 200);
const sf3 = await req("POST", "/api/trainer-requests/from-shortfall", { location: gateLoc._id }, 200);
ok("F-A9: a halted centre's gap is skipped with the F-B5 reason",
  sf3.data.summary?.created === 0 && sf3.data.skipped?.some((s) => /Stopped/.test(s.reason)), JSON.stringify(sf3.data.skipped));

// ================= Per-candidate assessment & certification (Rules 41–47) =================
// Runs on its own batch so the legacy batch-level path above stays untouched.
const b4 = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, room: room._id, planned_start: today, target_size: 3 }, 201)).data.item;
const b4Cands = [];
for (let i = 0; i < 3; i++) {
  b4Cands.push((await req("POST", "/api/candidates", { name: `R${i} ${stamp}`, phone: `66${stamp}${i}`, location: loc._id, program: prog._id }, 201)).data.item);
}
const b4Members = [];
for (const c of b4Cands) b4Members.push((await req("POST", `/api/batches/${b4._id}/members`, { candidate: c._id }, 201)).data.item);
for (const m of b4Members) await req("PATCH", `/api/members/${m._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
await req("POST", `/api/batches/${b4._id}/transition`, { target: "Ready" }, 200);
await req("POST", `/api/batches/${b4._id}/transition`, { target: "Active" }, 200);

const r0 = (await req("GET", `/api/batches/${b4._id}/results`, undefined, 200)).data;
ok("Rule 41: new batch starts legacy with a row per member", r0.legacy === true && r0.items.length === 3, JSON.stringify({ legacy: r0.legacy, n: r0.items?.length }));

await req("PUT", `/api/batches/${b4._id}/results`, { rows: [{ member: b4Members[0]._id, result: "Pass", score: 78, assessed_on: today, assessor: "NCVET" }] }, 200);
const afterPass = (await req("GET", `/api/batches/${b4._id}/closure`)).data;
ok("Rule 42: aggregates written through to Closure", afterPass.closure?.appeared === 1 && afterPass.closure?.passed === 1 && afterPass.legacy === false, JSON.stringify({ a: afterPass.closure?.appeared, p: afterPass.closure?.passed, legacy: afterPass.legacy }));

await req("PUT", `/api/batches/${b4._id}/results`, { rows: [{ member: b4Members[1]._id, result: "Fail" }] }, 400); // Rule 44
await req("PUT", `/api/batches/${b4._id}/results`, { rows: [{ member: b4Members[1]._id, result: "Fail", failure_reason: "Below cut-off", score: 31 }] }, 200);
await req("PUT", `/api/batches/${b4._id}/closure`, { assessment_status: "Completed", assessment_date: today }, 409); // Rule 43

await req("PUT", `/api/batches/${b4._id}/closure`, { appeared: 99, passed: 99 }, 200);
const ignored = (await req("GET", `/api/batches/${b4._id}/closure`)).data;
ok("Rule 42: hand-typed aggregates ignored once rows exist", ignored.closure.appeared === 2 && ignored.closure.passed === 1, JSON.stringify({ a: ignored.closure.appeared, p: ignored.closure.passed }));

await req("PUT", `/api/batches/${b4._id}/results`, { rows: [{ member: b4Members[2]._id, result: "Absent" }] }, 200);
const sum3 = (await req("GET", `/api/batches/${b4._id}/results`)).data.summary;
// 2026-08-12 (Manish, client contract): an absentee is NOT deducted from "appeared" — the
// client counts everyone who reached assessment stage. Reversible via Defaults.absent_counts_as_appeared.
ok("Absent counts toward 'appeared' (Manish 2026-08-12)", sum3.appeared === 3 && sum3.absent === 1, JSON.stringify(sum3));
await req("PUT", `/api/batches/${b4._id}/closure`, { assessment_status: "Completed", assessment_date: today }, 200); // Rule 43 satisfied
await req("POST", `/api/batches/${b4._id}/transition`, { target: "Closing" }, 200);

// Certificates (Rules 45/46)
const resultRows = (await req("GET", `/api/batches/${b4._id}/results`)).data.items;
const passRow = resultRows.find((i) => i.result?.result === "Pass").result;
const failRow = resultRows.find((i) => i.result?.result === "Fail").result;
await req("PATCH", `/api/results/${failRow._id}`, { certificate_status: "Processing" }, 409); // Rule 45
await req("PATCH", `/api/results/${passRow._id}`, { certificate_status: "Generated", certificate_no: "X" + stamp, certificate_date: today }, 409); // Rule 46 ordering
await req("PATCH", `/api/results/${passRow._id}`, { certificate_status: "Processing" }, 200);
await req("PATCH", `/api/results/${passRow._id}`, { certificate_status: "Generated" }, 400); // Rule 46 needs no + date
await req("PATCH", `/api/results/${passRow._id}`, { certificate_status: "Generated", certificate_no: "CERT-" + stamp, certificate_date: today }, 200);
await req("PUT", `/api/batches/${b4._id}/closure`, { certification_status: "Completed", certification_date: today }, 409); // Rule 46: not Issued yet
await req("PATCH", `/api/results/${passRow._id}`, { certificate_status: "Rejected" }, 400); // needs reason
await req("PATCH", `/api/results/${passRow._id}`, { certificate_status: "Rejected", certificate_rejection_reason: "Name spelling" }, 200);
await req("PATCH", `/api/results/${passRow._id}`, { certificate_status: "Processing" }, 200); // resubmission path
await req("PATCH", `/api/results/${passRow._id}`, { certificate_status: "Generated", certificate_no: "CERT-" + stamp, certificate_date: today }, 200);
await req("PATCH", `/api/results/${passRow._id}`, { certificate_status: "Issued" }, 200);
await req("PATCH", `/api/results/${passRow._id}`, { result: "Fail", failure_reason: "x" }, 409); // Rule 45 reverse
const certd = (await req("GET", `/api/batches/${b4._id}/closure`)).data;
ok("Rule 42: certificates_issued derived", certd.closure.certificates_issued === 1, String(certd.closure.certificates_issued));

// ---- Certificates bulk upload by CAN id (2026-08-14, CEO: "folder mein ID ke saath —
// upload hote hi bachche ke saamne assign"). Filenames carry the CAN id; the roster's
// sidh_candidate_id is the join key; everything unplaceable is reported with a reason.
await req("PATCH", `/api/candidates/${b4Cands[0]._id}`, { sidh_candidate_id: `CAN77${stamp.slice(-4)}1` }, 200);
await req("PATCH", `/api/candidates/${b4Cands[1]._id}`, { sidh_candidate_id: `CAN77${stamp.slice(-4)}2` }, 200);
async function certUpload(batchId, files, expect) {
  const fd = new FormData();
  for (const [name, bytes] of files) fd.append("files", new File([bytes], name, { type: "application/pdf" }));
  const res = await fetch(`${BASE}/api/batches/${batchId}/certificates`, { method: "POST", headers: { cookie }, body: fd });
  const data = await res.json().catch(() => ({}));
  if (expect !== undefined) ok(`POST certificates bulk → ${expect}`, res.status === expect, `(got ${res.status}: ${JSON.stringify(data).slice(0, 140)})`);
  return data;
}
const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
const up1 = await certUpload(b4._id, [
  [`CAN_77${stamp.slice(-4)}1.pdf`, pdf],      // → Pass candidate
  ["junk-no-id.pdf", pdf],                      // no CAN id
  [`CAN_77${stamp.slice(-4)}2.pdf`, pdf],      // → Fail candidate (Rule 45)
  ["CAN_000000009.pdf", pdf],                   // no roster match
], 200);
ok("cert bulk: exactly the Pass candidate placed", up1.summary?.matched === 1 && up1.matched?.[0]?.candidate === b4Cands[0].name, JSON.stringify(up1.summary));
ok("cert bulk: the 3 unplaceable files each carry a reason",
  up1.summary?.unmatched === 3 && up1.unmatched?.every((u) => u.reason?.length > 5),
  JSON.stringify(up1.unmatched));
ok("cert bulk: Rule 45 names the Fail refusal",
  up1.unmatched?.some((u) => /Rule 45/.test(u.reason)), JSON.stringify(up1.unmatched));
const afterUp = (await req("GET", `/api/batches/${b4._id}/results`)).data.items;
const upPassRow = afterUp.find((i) => i.result?.result === "Pass").result;
ok("cert bulk: certificate_file landed on the result row", /\/api\/files\//.test(upPassRow.certificate_file ?? ""), upPassRow.certificate_file);
// same CAN id again while file exists + batch still Closing → upsert path allows overwrite
// pre-completion; the freeze is tested after Completed below.

await req("PUT", `/api/batches/${b4._id}/closure`, { certification_status: "Completed", certification_date: today }, 200);
await req("PUT", `/api/batches/${b4._id}/closure`, { ready_for_invoice: true }, 200);
ok("invoice linkage unchanged by per-candidate mode", (await req("GET", `/api/batches/${b4._id}/closure`)).data.invoice?.status === "Ready");
await req("POST", `/api/batches/${b4._id}/transition`, { target: "Completed" }, 200);

// Rule 47: lifecycle splits by result
const lcPass = (await req("GET", `/api/candidates/${b4Cands[0]._id}`)).data.item;
const lcFail = (await req("GET", `/api/candidates/${b4Cands[1]._id}`)).data.item;
const lcAbs = (await req("GET", `/api/candidates/${b4Cands[2]._id}`)).data.item;
ok("Rule 47: Pass → Completed, Fail/Absent → Not Certified",
  lcPass.lifecycle_status === "Completed" && lcFail.lifecycle_status === "Not Certified" && lcAbs.lifecycle_status === "Not Certified",
  `${lcPass.lifecycle_status}/${lcFail.lifecycle_status}/${lcAbs.lifecycle_status}`);

await req("PUT", `/api/batches/${b4._id}/results`, { rows: [{ member: b4Members[0]._id, result: "Pass" }] }, 400); // Rule 41: closed batch
const candHistory = (await req("GET", `/api/candidates/${b4Cands[0]._id}/results`, undefined, 200)).data;
ok("candidate result history available", candHistory.items?.length >= 1 && candHistory.items[0].batch?.code === b4.code, JSON.stringify(candHistory.items?.[0]?.batch));

// ---- Cert bulk upload vs DEC-6 on Completed batches ----
// Rewriting an existing certificate file after completion is refused by name.
const upFrozen = await certUpload(b4._id, [[`CAN_77${stamp.slice(-4)}1.pdf`, pdf]], 200);
ok("cert bulk: Completed + existing file → frozen (DEC-6)",
  upFrozen.summary?.matched === 0 && /DEC-6/.test(upFrozen.unmatched?.[0]?.reason ?? ""), JSON.stringify(upFrozen.unmatched));

// But FILLING an absent file on a Completed batch is the CEO's own flow (the Gurgaon
// case: batch long done, certificates arrive later as a folder) — allowed, once.
const b5 = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, room: room._id, planned_start: today, target_size: 2 }, 201)).data.item;
const c5a = (await req("POST", "/api/candidates", { name: `LateCert A ${stamp}`, phone: `67${stamp}7`, location: loc._id, program: prog._id, sidh_candidate_id: `CAN88${stamp.slice(-4)}` }, 201)).data.item;
const c5b = (await req("POST", "/api/candidates", { name: `LateCert B ${stamp}`, phone: `67${stamp}8`, location: loc._id, program: prog._id }, 201)).data.item;
const m5 = [];
for (const c of [c5a, c5b]) m5.push((await req("POST", `/api/batches/${b5._id}/members`, { candidate: c._id }, 201)).data.item);
for (const m of m5) await req("PATCH", `/api/members/${m._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
await req("POST", `/api/batches/${b5._id}/transition`, { target: "Ready" }, 200);
await req("POST", `/api/batches/${b5._id}/transition`, { target: "Active" }, 200);
await req("PUT", `/api/batches/${b5._id}/results`, { rows: [
  { member: m5[0]._id, result: "Pass", score: 81, assessed_on: today, assessor: "NCVET" },
  { member: m5[1]._id, result: "Fail", failure_reason: "Below cut-off", score: 22 },
] }, 200);
await req("PUT", `/api/batches/${b5._id}/closure`, { assessment_status: "Completed", assessment_date: today }, 200);
await req("POST", `/api/batches/${b5._id}/transition`, { target: "Closing" }, 200);
const r5 = (await req("GET", `/api/batches/${b5._id}/results`)).data.items.find((i) => i.result?.result === "Pass").result;
await req("PATCH", `/api/results/${r5._id}`, { certificate_status: "Processing" }, 200);
await req("PATCH", `/api/results/${r5._id}`, { certificate_status: "Generated", certificate_no: "LC-" + stamp, certificate_date: today }, 200);
await req("PATCH", `/api/results/${r5._id}`, { certificate_status: "Issued" }, 200);
await req("PUT", `/api/batches/${b5._id}/closure`, { certification_status: "Completed", certification_date: today }, 200);
await req("PUT", `/api/batches/${b5._id}/closure`, { ready_for_invoice: true }, 200);
await req("POST", `/api/batches/${b5._id}/transition`, { target: "Completed" }, 200);

const upLate = await certUpload(b5._id, [[`can-88${stamp.slice(-4)}.pdf`, pdf]], 200); // lowercase/dash — id match is case/separator-proof
ok("cert bulk: absent file FILLED on a Completed batch (DEC-6 exception)",
  upLate.summary?.matched === 1 && upLate.matched?.[0]?.candidate === c5a.name, JSON.stringify(upLate));
const r5after = (await req("GET", `/api/batches/${b5._id}/results`)).data.items.find((i) => i.result?.result === "Pass").result;
ok("cert bulk: late certificate visible on the result row", /\/api\/files\//.test(r5after.certificate_file ?? ""), r5after.certificate_file);
const upLate2 = await certUpload(b5._id, [[`CAN_88${stamp.slice(-4)}.pdf`, pdf]], 200);
ok("cert bulk: second late upload refused — the fill is once (DEC-6)",
  upLate2.summary?.matched === 0 && /DEC-6/.test(upLate2.unmatched?.[0]?.reason ?? ""), JSON.stringify(upLate2.unmatched));

// ---- Late-ARRIVAL results (2026-08-14, Manish's Gurugram batch-1 certificates): a batch
// completed legacy-style — batch-level closure figures, ZERO per-candidate rows — and
// Rule 41 forbids marking after completion. The NSDC certificate arriving now IS the pass
// evidence: the upload creates the Pass row carrying it, and the recorded batch-level
// closure figures stay exactly as typed (Rule 42 / S0 clobber guard).
const b6 = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, room: room._id, planned_start: today, target_size: 2 }, 201)).data.item;
const c6a = (await req("POST", "/api/candidates", { name: `LateRes A ${stamp}`, phone: `68${stamp}1`, location: loc._id, program: prog._id, sidh_candidate_id: `CAN99${stamp.slice(-4)}` }, 201)).data.item;
const c6b = (await req("POST", "/api/candidates", { name: `LateRes B ${stamp}`, phone: `68${stamp}2`, location: loc._id, program: prog._id }, 201)).data.item;
const m6 = [];
for (const c of [c6a, c6b]) m6.push((await req("POST", `/api/batches/${b6._id}/members`, { candidate: c._id }, 201)).data.item);
for (const m of m6) await req("PATCH", `/api/members/${m._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
await req("POST", `/api/batches/${b6._id}/transition`, { target: "Ready" }, 200);
await req("POST", `/api/batches/${b6._id}/transition`, { target: "Active" }, 200);
await req("PUT", `/api/batches/${b6._id}/closure`, { assessment_status: "Completed", assessment_date: today, appeared: 2, passed: 1 }, 200); // batch-level, no rows
await req("POST", `/api/batches/${b6._id}/transition`, { target: "Closing" }, 200);
await req("PUT", `/api/batches/${b6._id}/closure`, { certification_status: "Completed", certification_date: today, certificates_issued: 1 }, 200);
await req("PUT", `/api/batches/${b6._id}/closure`, { ready_for_invoice: true }, 200);
await req("POST", `/api/batches/${b6._id}/transition`, { target: "Completed" }, 200);
const preRows = (await req("GET", `/api/batches/${b6._id}/results`)).data.items.filter((i) => i.result);
ok("late-arrival fixture: Completed with zero per-candidate rows", preRows.length === 0, String(preRows.length));
const upNew = await certUpload(b6._id, [[`CAN_99${stamp.slice(-4)}.pdf`, pdf]], 200);
ok("late-arrival: certificate upload CREATES the Pass row on a Completed batch",
  upNew.summary?.matched === 1 && upNew.matched?.[0]?.created_result === true && upNew.matched?.[0]?.candidate === c6a.name, JSON.stringify(upNew));
const r6row = (await req("GET", `/api/batches/${b6._id}/results`)).data.items.find((i) => i.result)?.result;
ok("late-arrival: created row is Pass + Issued + carries the file",
  r6row?.result === "Pass" && r6row?.certificate_status === "Issued" && /\/api\/files\//.test(r6row?.certificate_file ?? ""), JSON.stringify(r6row));
const cl6 = (await req("GET", `/api/batches/${b6._id}/closure`)).data.closure;
ok("late-arrival: batch-level closure figures NOT clobbered by the late row (Rule 42/S0)",
  cl6?.appeared === 2 && cl6?.passed === 1 && cl6?.certificates_issued === 1, JSON.stringify({ appeared: cl6?.appeared, passed: cl6?.passed, ci: cl6?.certificates_issued }));
const upNew2 = await certUpload(b6._id, [[`CAN_99${stamp.slice(-4)}.pdf`, pdf]], 200);
ok("late-arrival: re-upload for the same candidate refused — frozen after the fill (DEC-6)",
  upNew2.summary?.matched === 0 && /DEC-6/.test(upNew2.unmatched?.[0]?.reason ?? ""), JSON.stringify(upNew2.unmatched));

// ---- Batch Health Score (score always travels with reasons) ----
const healthBatch = (await req("GET", `/api/batches/${capBatch._id}`)).data;
ok("health score present with reasons array", ["Green", "Amber", "Red"].includes(healthBatch.health?.score) && Array.isArray(healthBatch.health?.reasons), JSON.stringify(healthBatch.health));
const listHealth = (await req("GET", "/api/batches")).data.items;
ok("health on every batch list row", listHealth.every((b) => b.health?.score), "missing on some rows");
const amberOrRed = listHealth.find((b) => b.health.score !== "Green");
ok("non-green batches always name a reason", !amberOrRed || amberOrRed.health.reasons.length > 0, JSON.stringify(amberOrRed?.health));

// ---- Approval matrix (RPL M24) — engine on, all actions off by default ----
const apr0 = (await req("GET", "/api/approvals", undefined, 200)).data;
ok("approval actions ship disabled", apr0.config?.every((c) => c.enabled === false), JSON.stringify(apr0.config?.map((c) => c.enabled)));

// With the gate off, cancelling stays immediate (no behaviour change).
const gateBatch1 = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: today, target_size: 2 }, 201)).data.item;
await req("POST", `/api/batches/${gateBatch1._id}/transition`, { target: "Cancelled", reason: "no gate" }, 200);

// Turn the gate on: the same action is parked instead of applied.
await req("PUT", "/api/approvals", { action: "batch.cancel", enabled: true, approver_role: "Operations" }, 200);
const gateBatch2 = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: today, target_size: 2 }, 201)).data.item;
const parked = await req("POST", `/api/batches/${gateBatch2._id}/transition`, { target: "Cancelled", reason: "needs approval" }, 202);
ok("gated action is parked, not applied", parked.data.pending_approval === true, JSON.stringify(parked.data).slice(0, 100));
const stillOpen = (await req("GET", `/api/batches/${gateBatch2._id}`)).data.item;
ok("batch untouched while approval pending", stillOpen.status !== "Cancelled", stillOpen.status);

const pendingReq = (await req("GET", "/api/approvals?status=Pending")).data.items.find((r) => String(r.entity_id) === String(gateBatch2._id));
ok("request appears in the approval queue", !!pendingReq);
await req("POST", `/api/approvals/${pendingReq._id}`, { decision: "Approved" }, 403); // initiator cannot self-approve
await req("PUT", "/api/approvals", { action: "batch.cancel", enabled: false }, 200); // restore default OFF
const afterOff = (await req("GET", "/api/approvals")).data.config.find((c) => c.action === "batch.cancel");
ok("approval switch can be turned back off", afterOff.enabled === false);

// ---- Alerts (RPL M22) ----
const alerts = (await req("GET", "/api/notifications", undefined, 200)).data;
ok("alerts endpoint returns a list", Array.isArray(alerts.items), JSON.stringify(alerts).slice(0, 80));
const alertCount = (await req("GET", "/api/notifications?count=1")).data;
ok("alerts count endpoint", typeof alertCount.count === "number", JSON.stringify(alertCount));
if (alerts.items.length) {
  const a = alerts.items[0];
  await req("POST", `/api/notifications/${a._id}`, { status: "Acknowledged" }, 200);
  await req("POST", `/api/notifications/${a._id}`, { status: "Bogus" }, 400);
}
const syncCount = (await req("GET", "/api/sheet-changes?count=1")).data;
ok("sheet-changes count endpoint (badge no longer fetches all rows)", typeof syncCount.count === "number", JSON.stringify(syncCount));

// ---- audit trail exists ----
const audit = (await req("GET", `/api/audit/Batch/${batch._id}`)).data.items;
ok("AuditLog rows written for batch", audit.length >= 3, `count=${audit.length}`);

// ============================================================================
// 2026-08-11 meeting features
// ============================================================================

// ---- Workbook Watch (all tabs, all columns, cell-level diff) ----
const XLSX = (await import("xlsx")).default ?? await import("xlsx");
function wbDataUrl(tabs) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(tabs)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  const b64 = XLSX.write(wb, { type: "base64", bookType: "xlsx" });
  return `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${b64}`;
}
const wb1 = wbDataUrl({ Sheet1: [["Name", "Target", "Status"], ["Alpha " + stamp, "10", "Open"], ["Beta " + stamp, "20", "Open"]] });
const watchSrc = (await req("POST", "/api/sync-sources", {
  name: "Watch Source " + stamp, source_url: wb1, mode: "watch", interval_minutes: 30, key_columns: ["Name"],
}, 201)).data.item;
const run1 = (await req("POST", `/api/sync-sources/${watchSrc._id}/run`, {}, 200)).data;
ok("watch: baseline snapshot raises no changes", run1.status === "OK" && run1.changes === 0, JSON.stringify(run1));
// client edits the sheet: Alpha 10→15, Beta row deleted, Gamma added, a whole new tab appears
const wb2 = wbDataUrl({
  Sheet1: [["Name", "Target", "Status"], ["Alpha " + stamp, "15", "Open"], ["Gamma " + stamp, "30", "Open"]],
  Extra: [["Col1"], ["x"]],
});
await req("PATCH", `/api/sync-sources/${watchSrc._id}`, { source_url: wb2 }, 200);
const run2 = (await req("POST", `/api/sync-sources/${watchSrc._id}/run`, {}, 200)).data;
ok("watch: second run detects changes", run2.status === "OK" && run2.changes >= 3, JSON.stringify(run2));
const wc = (await req("GET", "/api/workbook-changes?status=New", undefined, 200)).data;
const modified = wc.items.find((c) => c.row_key === "Alpha " + stamp && c.column === "Target");
ok("watch: modified cell has old → new", modified?.old_value === "10" && modified?.new_value === "15", JSON.stringify(modified));
ok("watch: removed row detected", wc.items.some((c) => c.row_key === "Beta " + stamp && c.change_type === "Removed"));
ok("watch: added row detected", wc.items.some((c) => c.row_key === "Gamma " + stamp && c.change_type === "Added"));
// re-run without edits: no duplicate changes for the standing difference
const run3 = (await req("POST", `/api/sync-sources/${watchSrc._id}/run`, {}, 200)).data;
ok("watch: unchanged sheet re-run raises nothing", run3.changes === 0, JSON.stringify(run3));
await req("PATCH", `/api/workbook-changes/${modified._id}`, { status: "Seen" }, 200);
await req("PATCH", `/api/workbook-changes/${modified._id}`, { status: "Accepted" }, 200);
await req("PATCH", `/api/workbook-changes/${modified._id}`, { status: "New" }, 400); // review states only
const wcCount = (await req("GET", "/api/workbook-changes?count=1")).data;
ok("watch: count endpoint", typeof wcCount.count === "number", JSON.stringify(wcCount));

// ---- Location contacts + meeting notes ----
await req("PATCH", `/api/locations/${loc._id}`, {
  contacts: [
    { name: "SPOC Two " + stamp, phone: "9000000001", role_label: "SPOC" },
    { name: "Cluster Head " + stamp, phone: "9000000002", role_label: "Cluster Head" },
  ],
}, 200);
const locAfter = (await req("GET", `/api/locations/${loc._id}`)).data.item;
ok("location holds multiple contacts", locAfter.contacts?.length === 2, JSON.stringify(locAfter.contacts));
await req("POST", `/api/locations/${loc._id}/notes`, { met_with: "Principal", note: "Discussed batch plan " + stamp }, 201);
await req("POST", `/api/locations/${loc._id}/notes`, { met_with: "Nobody" }, 400); // note text required
const notes = (await req("GET", `/api/locations/${loc._id}/notes`, undefined, 200)).data.items;
ok("meeting note recorded with author", notes.length === 1 && !!notes[0].logged_by?.name, JSON.stringify(notes[0]).slice(0, 120));

// ---- Trainer pipeline warning ----
const pipeTrainer = (await req("POST", "/api/trainers", {
  name: "Pipeline Trainer " + stamp, phone: "97777" + stamp.slice(0, 5),
  skills: ["TestSkill" + stamp], pipeline_status: "Docs Pending", tr_id: "TR" + stamp,
}, 201)).data.item;
const warnBatch = await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: pipeTrainer._id, planned_start: "2027-03-01", target_size: 3 }, 201);
ok("booking a not-Ready trainer warns, not blocks", String(warnBatch.data.warning ?? "").includes("Docs Pending"), JSON.stringify(warnBatch.data.warning));
await req("POST", `/api/batches/${warnBatch.data.item._id}/transition`, { target: "Cancelled", reason: "pipeline test cleanup" }, 200);

// ---- Backward batch planner ----
const plan = (await req("GET", "/api/plan-batch?start=2026-09-20", undefined, 200)).data;
ok("planner: 7 milestones, sorted by date", plan.milestones?.length === 7 &&
  plan.milestones.every((m, i, a) => i === 0 || new Date(a[i - 1].due_date) <= new Date(m.due_date)), JSON.stringify(plan.milestones?.map((m) => m.key)));
const totMs = plan.milestones.find((m) => m.key === "tot_done");
const totGap = Math.round((new Date("2026-09-20") - new Date(totMs?.due_date)) / 86400e3);
ok("planner: TOT due 3 days before start", totGap === 3, `gap=${totGap}d due=${totMs?.due_date}`);
const planBatch = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: "2027-04-01", target_size: 3 }, 201)).data.item;
ok("batch stores its backward plan", planBatch.milestones?.length === 7, `count=${planBatch.milestones?.length}`);
const ticked = (await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { key: "mobilization", done: true }, 200)).data.item;
ok("milestone tick-off records done_on", !!ticked.milestones.find((m) => m.key === "mobilization")?.done_on);
await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { regenerate: true }, 200);
const regen = (await req("GET", `/api/batches/${planBatch._id}`)).data.item;
ok("regenerate keeps ticked milestones done", !!regen.milestones.find((m) => m.key === "mobilization")?.done_on);
await req("POST", `/api/batches/${planBatch._id}/transition`, { target: "Cancelled", reason: "planner test cleanup" }, 200);

// ---- Candidate eligibility ----
const oldCand = (await req("POST", "/api/candidates", {
  name: "Old Cand " + stamp, phone: "77770" + stamp.slice(0, 5), location: loc._id, program: prog._id,
  dob: "1950-01-01", education: "10th Pass",
}, 201)).data.item;
const oldCandRead = (await req("GET", `/api/candidates/${oldCand._id}`)).data.item;
ok("eligibility: age above max flagged", oldCandRead.eligibility?.eligible === false &&
  oldCandRead.eligibility.reasons.some((r) => r.includes("above")), JSON.stringify(oldCandRead.eligibility));
const freshCand = (await req("POST", "/api/candidates", {
  name: "Fresh Cand " + stamp, phone: "77771" + stamp.slice(0, 5), location: loc._id, program: prog._id,
  dob: "2000-01-01", education: "10th Pass",
}, 201)).data.item;
const freshRead = (await req("GET", `/api/candidates/${freshCand._id}`)).data.item;
ok("eligibility: valid candidate passes", freshRead.eligibility?.eligible === true, JSON.stringify(freshRead.eligibility));
const cooldownCand = (await req("POST", "/api/candidates", {
  name: "Cooldown Cand " + stamp, phone: "77772" + stamp.slice(0, 5), location: loc._id, program: prog._id,
  dob: "2000-01-01", education: "10th Pass", last_training_date: new Date(Date.now() - 30 * 86400e3).toISOString(),
}, 201)).data.item;
const cooldownRead = (await req("GET", `/api/candidates/${cooldownCand._id}`)).data.item;
ok("eligibility: 6-month training cooldown flagged", cooldownRead.eligibility?.eligible === false, JSON.stringify(cooldownRead.eligibility));
// assignment warns, enrollment completion hard-blocks
const eligBatch = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: "2027-05-01", target_size: 5 }, 201)).data.item;
const assignRes = (await req("POST", "/api/candidates/assign", { batch: eligBatch._id, candidate_ids: [oldCand._id] }, 200)).data;
ok("assign ineligible candidate warns", assignRes.assigned === 1 && assignRes.warnings?.length === 1, JSON.stringify(assignRes.warnings));
const eligMembers = (await req("GET", `/api/batches/${eligBatch._id}/members`)).data.items;
const oldMember = eligMembers.find((m) => String(m.candidate?._id ?? m.candidate) === String(oldCand._id));
await req("PATCH", `/api/members/${oldMember._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 409); // hard gate
ok("enrollment completion blocked for ineligible candidate", true);
await req("POST", `/api/batches/${eligBatch._id}/transition`, { target: "Cancelled", reason: "eligibility test cleanup" }, 200);

// ---- SIDH status tracking ----
await req("PATCH", `/api/candidates/${freshCand._id}`, { sidh_status: "Link Sent", sidh_link_sent_at: new Date().toISOString() }, 200);
const sidhRead = (await req("GET", `/api/candidates/${freshCand._id}`)).data.item;
ok("SIDH status tracked on candidate", sidhRead.sidh_status === "Link Sent" && !!sidhRead.sidh_link_sent_at);

// ---- SIDH CRM export (D:\crm sheet contract) ----
const sidhExport = await fetch(BASE + `/api/candidates/export-sidh?location=${loc._id}`, { headers: { cookie } });
ok("export-sidh returns an xlsx", sidhExport.status === 200 &&
  (sidhExport.headers.get("content-type") ?? "").includes("spreadsheetml"), `status=${sidhExport.status}`);

// ---- Public self-registration (capability link, no session) ----
const regToken = (await req("POST", "/api/public-tokens", { purpose: "register", location: loc._id, program: prog._id }, 201)).data.item;
const pubGet = await fetch(BASE + `/api/public/register/${regToken.token}`); // deliberately no cookie
ok("public register form loads without login", pubGet.status === 200, `status=${pubGet.status}`);
const pubPost = await fetch(BASE + `/api/public/register/${regToken.token}`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "SelfReg Cand " + stamp, phone: "7666600" + stamp.slice(0, 3), dob: "2001-05-05", education: "12th Pass" }),
});
ok("public self-registration creates a candidate", pubPost.status === 201, `status=${pubPost.status}`);
const honeypot = await fetch(BASE + `/api/public/register/${regToken.token}`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Bot", phone: "7666600999", website: "spam.example" }),
});
ok("honeypot submission rejected", honeypot.status === 400, `status=${honeypot.status}`);
const badToken = await fetch(BASE + "/api/public/register/deadbeefdeadbeefdeadbeefdeadbeef");
ok("invalid register token → 404", badToken.status === 404, `status=${badToken.status}`);
const selfReg = (await req("GET", `/api/candidates?q=${encodeURIComponent("SelfReg Cand " + stamp)}`)).data.items;
ok("self-registered candidate lands in the pool", selfReg.length === 1 && selfReg[0].source === "Self Registration", JSON.stringify(selfReg[0]?.source));
await req("PATCH", `/api/public-tokens/${regToken._id}`, { active: false }, 200);
const revoked = await fetch(BASE + `/api/public/register/${regToken.token}`);
ok("revoked register token → 404", revoked.status === 404, `status=${revoked.status}`);

// ---- Candidate feedback (per-member links, one response each) ----
// `batch` from earlier in the suite is Active with members.
const fbLinks = (await req("POST", "/api/public-tokens", { purpose: "feedback", batch: batch._id }, 201)).data.items;
ok("feedback links generated per roster member", fbLinks.length >= 3, `count=${fbLinks.length}`);
const fbToken = fbLinks[0].token;
const fbGet = await fetch(BASE + `/api/public/feedback/${fbToken}`);
ok("public feedback form loads without login", fbGet.status === 200, `status=${fbGet.status}`);
const fbPost = await fetch(BASE + `/api/public/feedback/${fbToken}`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ rating: 5, liked: "Great trainer", suggestions: "More practice time" }),
});
ok("feedback submitted", fbPost.status === 201, `status=${fbPost.status}`);
const fbDup = await fetch(BASE + `/api/public/feedback/${fbToken}`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ rating: 1 }),
});
ok("second submission on same link → 409", fbDup.status === 409, `status=${fbDup.status}`);
const fbBadRating = await fetch(BASE + `/api/public/feedback/${fbLinks[1].token}`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ rating: 9 }),
});
ok("rating outside 1–5 → 400", fbBadRating.status === 400, `status=${fbBadRating.status}`);
const fbList = (await req("GET", `/api/batches/${batch._id}/feedback`, undefined, 200)).data;
ok("batch feedback tab lists responses with average", fbList.count === 1 && fbList.average === 5, JSON.stringify({ count: fbList.count, avg: fbList.average }));

// ============================================================================
// 2026-08-11 evening (CEO): signup→approval, permission toggles, validate→add
// ============================================================================

async function loginAs(email, password) {
  const csrfRes2 = await fetch(BASE + "/api/auth/csrf");
  const { csrfToken: tok } = await csrfRes2.json();
  const cc = csrfRes2.headers.get("set-cookie").split(";")[0];
  const r = await fetch(BASE + "/api/auth/callback/credentials", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: cc },
    body: new URLSearchParams({ csrfToken: tok, email, password }), redirect: "manual",
  });
  const sess = (r.headers.getSetCookie?.() ?? [r.headers.get("set-cookie")]).flat().filter(Boolean).map((c) => c.split(";")[0]).find((c) => c.includes("session-token"));
  return sess ? [cc, sess].join("; ") : null;
}

// ---- staff self-signup is CLOSED (CEO 13/08) — accounts are admin-created ----
const signupEmail = `trainer${stamp}@test.local`;
const su = await fetch(BASE + "/api/public/signup", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Signup Trainer " + stamp, email: signupEmail, password: "Test@12345", role: "Trainer", location: loc._id }),
});
ok("public staff signup answers 410 GONE (closed, with guidance)", su.status === 410, `status=${su.status}`);
const suBody = await su.json().catch(() => ({}));
ok("…and points at the right doors (candidate portal + trainer apply)", /trainer-apply/.test(JSON.stringify(suBody)), JSON.stringify(suBody).slice(0, 120));
ok("GET signup meta is gone too", (await fetch(BASE + "/api/public/signup")).status === 410);
// The login below is ADMIN-CREATED now (the only way staff accounts come to exist).
const mkTrainerUser = await req("POST", "/api/users", { name: "Signup Trainer " + stamp, email: signupEmail, password: "Test@12345", role: "Trainer", can_edit: true, location_scope: [loc._id] }, 201);
const pendingUser = mkTrainerUser.data.item;
const trainerCookie = await loginAs(signupEmail, "Test@12345");
ok("approved account can log in", !!trainerCookie);
// Trainer role: scoped + no batch-manage right
const trBatches = await fetch(BASE + "/api/batches", { headers: { cookie: trainerCookie } });
ok("trainer sees only scoped batches", trBatches.status === 200);
const trCreate = await fetch(BASE + "/api/batches", {
  method: "POST", headers: { "Content-Type": "application/json", cookie: trainerCookie },
  body: JSON.stringify({ location: loc._id, program: prog._id, planned_start: "2028-01-01" }),
});
ok("trainer cannot create batches (no batches.manage)", trCreate.status === 403, `status=${trCreate.status}`);

// ---- special grant: give the trainer sheet.approve → Sheet Watch opens up ----
const trWatch1 = await fetch(BASE + "/api/workbook-changes", { headers: { cookie: trainerCookie } });
ok("trainer blocked from Sheet Watch by default", trWatch1.status === 403, `status=${trWatch1.status}`);
await req("PATCH", `/api/users/${pendingUser._id}`, { extra_permissions: ["sheet.approve"] }, 200);
const trWatch2 = await fetch(BASE + "/api/workbook-changes", { headers: { cookie: trainerCookie } });
ok("special grant opens Sheet Watch for the same user (no re-login)", trWatch2.status === 200, `status=${trWatch2.status}`);
await req("PATCH", `/api/users/${pendingUser._id}`, { extra_permissions: [] }, 200);

// ---- privilege-escalation guards (security review) ----
// Give the trainer users.manage — they still must NOT be able to raise privileges.
await req("PATCH", `/api/users/${pendingUser._id}`, { extra_permissions: ["users.manage"] }, 200);
const esc1 = await fetch(BASE + `/api/users/${pendingUser._id}`, {
  method: "PATCH", headers: { "Content-Type": "application/json", cookie: trainerCookie },
  body: JSON.stringify({ role: "Admin" }),
});
ok("users.manage holder cannot self-escalate to Admin", esc1.status === 403, `status=${esc1.status}`);
const esc2 = await fetch(BASE + `/api/users/${pendingUser._id}`, {
  method: "PATCH", headers: { "Content-Type": "application/json", cookie: trainerCookie },
  body: JSON.stringify({ extra_permissions: ["defaults.manage"] }),
});
ok("…nor grant themselves extra rights", esc2.status === 403, `status=${esc2.status}`);
const esc3 = await fetch(BASE + `/api/users`, {
  method: "POST", headers: { "Content-Type": "application/json", cookie: trainerCookie },
  body: JSON.stringify({ name: "Evil", email: `evil${stamp}@test.local`, password: "Test@12345", role: "Admin" }),
});
ok("…nor create an Admin account", esc3.status === 403, `status=${esc3.status}`);
const esc4 = await fetch(BASE + `/api/permissions`, {
  method: "PUT", headers: { "Content-Type": "application/json", cookie: trainerCookie },
  body: JSON.stringify({ role: "Trainer", permissions: ["users.manage", "defaults.manage", "batches.manage"] }),
});
ok("…nor inflate their own role's rights in the matrix", esc4.status === 403, `status=${esc4.status}`);
const esc5 = await fetch(BASE + `/api/users/${pendingUser._id}`, {
  method: "PATCH", headers: { "Content-Type": "application/json", cookie: trainerCookie },
  body: JSON.stringify({ name: "Renamed OK" }),
});
ok("non-privilege edits still work for users.manage holder", esc5.status === 200, `status=${esc5.status}`);
await req("PATCH", `/api/users/${pendingUser._id}`, { extra_permissions: [] }, 200);

// ---- validate → add: a new sheet row becomes a Location only after human review ----
const vwUrl1 = wbDataUrl({ Master: [
  ["Institution Name", "Job role", "State", "District", "SPOC Name", "TC ID"],
  ["Existing Inst " + stamp, "Drone Tech", "UP", "Agra", "S One", "TC1" + stamp.slice(0, 4)],
] });
const vwSrc = (await req("POST", "/api/sync-sources", { name: "Watch Source V" + stamp, source_url: vwUrl1, mode: "watch", key_columns: ["Institution Name", "Job role"] }, 201)).data.item;
await req("POST", `/api/sync-sources/${vwSrc._id}/run`, {}, 200); // baseline
const vwUrl2 = wbDataUrl({ Master: [
  ["Institution Name", "Job role", "State", "District", "SPOC Name", "TC ID"],
  ["Existing Inst " + stamp, "Drone Tech", "UP", "Agra", "S One", "TC1" + stamp.slice(0, 4)],
  ["Test Location New ITI " + stamp, "Solar Tech", "HR", "Sirsa", "S Two", "TC2" + stamp.slice(0, 4)],
] });
await req("PATCH", `/api/sync-sources/${vwSrc._id}`, { source_url: vwUrl2 }, 200);
await req("POST", `/api/sync-sources/${vwSrc._id}/run`, {}, 200);
const vwChanges = (await req("GET", "/api/workbook-changes?status=New")).data.items ?? [];
const addedRow = vwChanges.find((c) => c.change_type === "Added" && c.row_key.startsWith("Test Location New ITI " + stamp));
ok("new sheet row lands as a PENDING change, not in the DB", !!addedRow);
const locBefore = (await req("GET", `/api/locations?q=${encodeURIComponent("Test Location New ITI " + stamp)}`)).data.items;
ok("no location auto-created", locBefore.length === 0, `found ${locBefore.length}`);
const prefill = (await req("GET", `/api/workbook-changes/${addedRow._id}/create-location`, undefined, 200)).data;
ok("prefill maps sheet columns (name/state/city/SPOC/TC ID)",
  prefill.suggested?.name === "Test Location New ITI " + stamp && prefill.suggested?.state === "HR" &&
  prefill.suggested?.city === "Sirsa" && prefill.suggested?.external_id?.startsWith("TC2"), JSON.stringify(prefill.suggested));
// the human edits a value before adding — the edit must win
const created = await req("POST", `/api/workbook-changes/${addedRow._id}/create-location`, { ...prefill.suggested, city: "Sirsa (edited)" }, 201);
ok("human-validated location created with edited value", created.data.item?.city === "Sirsa (edited)");
const afterApply = (await req("GET", "/api/workbook-changes?status=New")).data.items ?? [];
ok("row's pending changes auto-accepted after validation", !afterApply.some((c) => c.row_key === addedRow.row_key));

// ---- the trainer-preparation chain the CEO said was missing (2026-08-12) ----
// "ट्रेन होने से पहले ट्रेनर के TOT का कितना टाइम लगता है? वो नहीं कैप्चर किया हुआ है इसमें"
{
  const planned = (await req("GET", "/api/plan-batch?start=2027-03-01")).data;
  const keys = (planned.milestones ?? []).map((m) => m.key);
  ok("planner captures when the trainer is ready FOR tot", keys.includes("trainer_ready_for_tot"), JSON.stringify(keys));
  ok("planner captures when TOT starts", keys.includes("tot_start"), JSON.stringify(keys));
  ok("planner still has found → tot done → ready → mobilization → enrollment",
    ["trainer_found", "tot_done", "trainer_ready", "mobilization", "enrollment_done"].every((k) => keys.includes(k)), JSON.stringify(keys));
  const by = Object.fromEntries((planned.milestones ?? []).map((m) => [m.key, new Date(m.due_date).getTime()]));
  ok("the chain runs in the right order: ready-for-TOT → TOT starts → TOT done",
    by.trainer_ready_for_tot < by.tot_start && by.tot_start < by.tot_done,
    JSON.stringify({ r: by.trainer_ready_for_tot, s: by.tot_start, d: by.tot_done }));
  ok("the trainer is found before anyone tries to ready them for TOT",
    by.trainer_found < by.trainer_ready_for_tot, JSON.stringify({ found: by.trainer_found, ready: by.trainer_ready_for_tot }));
  ok("TOT completes at least 3 days before the batch starts (CEO's hard rule)",
    (new Date("2027-03-01").getTime() - by.tot_done) / 86400000 >= 3);
}

// All four compensation types the CEO named must be selectable.
{
  const tr = (await req("POST", "/api/trainers", { name: `Comp ${stamp}`, phone: "95555" + stamp.slice(2), skills: ["Skill" + stamp], compensation_type: "Incentive-based" }, 201)).data.item;
  ok("Incentive-based compensation accepted", tr.compensation_type === "Incentive-based");
  const tr2 = (await req("PATCH", `/api/trainers/${tr._id}`, { compensation_type: "Fixed", compensation_fixed: 25000 }, 200)).data.item;
  ok("Fixed compensation accepted with an amount", tr2.compensation_type === "Fixed" && tr2.compensation_fixed === 25000);
}

// ---- LEGACY pending accounts still surface for the approver (2026-08-14: self-signup is
// closed, but pre-existing pending rows — e.g. prod's real one — must stay visible) ----
const legacyEmail = `legacy.pending${stamp}@test.local`;
await req("POST", "/api/users", { name: "Legacy Pending " + stamp, email: legacyEmail, phone: "9876500011", password: "Test@12345", role: "Location", approval_status: "Pending", active: false, requested_role: "Location" });
const homeAfterSignup = (await req("GET", "/api/home")).data;
const queued = (homeAfterSignup.queues?.pending_users ?? []).find((u) => u.email === legacyEmail);
ok("a pending account appears on the Admin's Home queue", !!queued, JSON.stringify(homeAfterSignup.queues?.pending_users?.length));
ok("…with the contact details an approver needs", !!queued && queued.phone === "9876500011", JSON.stringify(queued));

// ---- public build marker (deploy verification, no auth) ----
const verRes = await fetch(BASE + "/api/public/version");
const verBody = await verRes.json().catch(() => ({}));
ok("version endpoint is public and names the release", verRes.status === 200 && !!verBody.release, `status=${verRes.status} ${JSON.stringify(verBody).slice(0, 80)}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
