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
const today = new Date().toISOString().slice(0, 10);
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
// Rule 10 (2026-08 policy: a trainer may hold up to max_concurrent_batches overlapping batches).
// The 2nd–5th overlapping batch is allowed; the 6th is blocked.
const extraBatches = [];
for (let i = 0; i < 4; i++) {
  const r = await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, planned_start: today, target_size: 3 }, 201);
  extraBatches.push(r.data.item?._id);
}
ok("Rule 10: trainer may hold 5 concurrent batches", extraBatches.every(Boolean));
await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, planned_start: today, target_size: 3 }, 409);
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
// Rule 27 (unique): duplicate date → 409
await req("POST", `/api/batches/${batch._id}/logs`, { log_date: today, present_member_ids: [] }, 409);
// Rule 32: date before actual_start
await req("POST", `/api/batches/${batch._id}/logs`, { log_date: "2020-01-01", present_member_ids: [] }, 400);

// ---- closure ----
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
// complete batch
await req("POST", `/api/batches/${batch._id}/transition`, { target: "Completed" }, 200);
const c0b = (await req("GET", `/api/candidates/${cands[0]._id}`)).data.item;
ok("Rule 21: candidate Completed on batch completion", c0b.lifecycle_status === "Completed", c0b.lifecycle_status);

// trainer released (Rule 12)
const t2 = (await req("GET", `/api/trainers/${trainer._id}`)).data.item;
ok("Rule 12: trainer derived back to Available", t2.status === "Available", t2.status);

// ---- costs ----
await req("POST", "/api/costs", { category: "000000000000000000000000", amount: 100 }, 400); // Rule 37: no anchor
const cats = (await req("GET", "/api/master-lists/cost-categories")).data.items;
await req("POST", "/api/costs", { category: cats[0]._id, amount: 5000, trainer: trainer._id }, 201); // trainer-only allowed

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

// ---- Capacity math honours both constraints ----
const capTargets = (await req("GET", `/api/locations/${loc._id}/targets`)).data.items;
ok("capacity exposes both constraint terms", capTargets[0]?.capacity?.by_deadline === 2 && capTargets[0]?.capacity?.by_concurrency === 2, JSON.stringify(capTargets[0]?.capacity));
ok("targets expose achieved counts", capTargets[0]?.achieved?.enrolled >= 0 && capTargets[0]?.achieved?.remaining_by_certified >= 0, JSON.stringify(capTargets[0]?.achieved));

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
ok("Rule 42: Absent does not count as appeared", sum3.appeared === 2 && sum3.absent === 1, JSON.stringify(sum3));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
