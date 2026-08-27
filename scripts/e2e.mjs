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
  // -111: every error the wall ever sees is scanned for a ledger code — the pin covers every
  // refusal path the suite exercises, not five hand-picked ones. Asserted once at the end.
  if (res.status >= 400 && typeof data?.error === "string" && CODE_RX.test(data.error)) codeLeaks.push(`${method} ${path} → ${data.error.slice(0, 100)}`);
  return { status: res.status, data };
}
const CODE_RX = /\b(?:Rules?|DEC|QA)[-\s]?T?\d+\b/;
const codeLeaks = [];

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
const loc = (await req("POST", "/api/locations", { code: "LOC" + stamp, name: "Test Location " + stamp, external_id: "EXT" + stamp, approval_status: "Approved", spoc_name: "Test SPOC", principal_name: "Test Principal", contacts: [{ name: "Shared Line One", role_label: "SPOC" }, { name: "Shared Line Two", role_label: "Principal" }] }, 201)).data.item;
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
// R-J (CEO [32:47]): batch codes are CENTRE-COURSE-NN, numbered per centre × course.
ok("R-J: the first batch for a centre × course is …-01", batch.code === `LOC${stamp}-PROG${stamp}-01`, batch.code);
ok("batch code auto-assigned (CENTRE-COURSE-NN)", /-\d{2}$/.test(batch.code), batch.code);
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
// CEO 14/08 [15:21]: "I hope we are also capturing when a candidate is enrolled"
ok("R-A: enrolled_at is stamped when enrollment completes", !!c0.enrolled_at, String(c0.enrolled_at));

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

// ---- QA-144 (-73): the CEO's 8-hour rule — slot-hours per day are capped, not just the
// session COUNT. Inside the stock 09:00–18:00 window two 4h sessions (=8h) is the ceiling
// anyway, so the rule only bites when the knobs move — which is exactly how we prove it:
// widen the day + allow 3 sessions, then show the THIRD 4h session trips the HOURS cap.
{
  await req("PUT", "/api/defaults", { day_end_time: "21:00", max_batches_per_day: 3 }, 200);
  const qa144 = [];
  const mk = (ss, se, expect) => req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, planned_start: today, target_size: 3, slot_start: ss, slot_end: se }, expect);
  const a = await mk("09:00", "13:00", 201); qa144.push(a.data.item?._id);
  const b = await mk("13:00", "17:00", 201); qa144.push(b.data.item?._id);
  ok("QA-144: two 4h sessions (=8h, the exact cap) are allowed", !!qa144[0] && !!qa144[1]);
  const c = await mk("17:00", "21:00", 409);
  ok("QA-144: a third 4h session (12h total) trips the hours cap BY NAME",
    /max daily hours = 8/.test(c.data?.error ?? ""), c.data?.error);
  await req("PUT", "/api/defaults", { max_daily_hours: 12 }, 200);
  const c2 = await mk("17:00", "21:00", 201); qa144.push(c2.data.item?._id);
  ok("QA-144: raising the Defaults knob to 12 admits the same batch (knob is live)", !!c2.data.item?._id);
  await req("PUT", "/api/defaults", { day_end_time: "18:00", max_batches_per_day: 2, max_daily_hours: 8 }, 200);
  for (const id of qa144.filter(Boolean)) {
    await req("POST", `/api/batches/${id}/transition`, { target: "Cancelled", reason: "QA-144 test cleanup" }, 200);
  }
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

// ---- -99 (QA-159 second half, measured on production 17/08): the batches list said "0 days"
// in bold next to "(36)" for a batch whose attendance exists only in the portal — 36 was the
// number of STUDENTS matched, never days, so the row could not answer "kitne din". The portal's
// own working-day meter now rides on the row. ----
{
  const { MongoClient, ObjectId } = await import("mongodb");
  const mc = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
  await mc.connect();
  const dbp = mc.db(process.env.MONGODB_DB || "center_erp_ci");
  const before = ((await req("GET", "/api/batches?limit=100")).data?.items ?? []).find((b) => String(b._id) === String(batch._id));
  ok("-99 (QA-159): a batch with no portal import reports portal_days 0 and no as_of", (before?.portal_days ?? null) === 0 && !before?.portal_as_of, JSON.stringify({ d: before?.portal_days, a: before?.portal_as_of }));
  // two matched portal rows for this batch: 13 working days, 11 and 12 days present
  const imp = await dbp.collection("govtattendanceimports").insertOne({ location: null, source: "e2e-pin", createdAt: new Date(), updatedAt: new Date() });
  await dbp.collection("govtattendancerows").insertMany([13, 13].map((wd, i) => ({
    import: imp.insertedId, batch: new ObjectId(String(batch._id)), name: `Portal Pin ${i + 1}`,
    total_working_days: wd, total_days_present: 11 + i, match_status: "Matched",
    createdAt: new Date(), updatedAt: new Date(),
  })));
  const after = ((await req("GET", "/api/batches?limit=100")).data?.items ?? []).find((b) => String(b._id) === String(batch._id));
  ok("-99 (QA-159): the list row now carries the portal's WORKING DAYS (13), the student count (2) and the import date — the three things 'kis batch ki kitne din' needs", after?.portal_days === 13 && after?.portal_rows === 2 && !!after?.portal_as_of && after?.portal_days_present_max === 12, JSON.stringify({ d: after?.portal_days, r: after?.portal_rows, p: after?.portal_days_present_max, a: !!after?.portal_as_of }));
  ok("-99 (QA-159): our own day-wise logs stay a SEPARATE number (the portal import does not inflate them)", after?.attendance_days === before?.attendance_days, JSON.stringify({ b: before?.attendance_days, a: after?.attendance_days }));
  // an UNMATCHED portal row is not counted (it belongs to nobody on this roster yet)
  await dbp.collection("govtattendancerows").insertOne({ import: imp.insertedId, batch: new ObjectId(String(batch._id)), name: "Unmatched Pin", total_working_days: 99, total_days_present: 99, match_status: "Unmatched", createdAt: new Date(), updatedAt: new Date() });
  const after2 = ((await req("GET", "/api/batches?limit=100")).data?.items ?? []).find((b) => String(b._id) === String(batch._id));
  ok("-99 (QA-159): an UNMATCHED portal row is ignored — days stay 13, not 99", after2?.portal_days === 13 && after2?.portal_rows === 2, JSON.stringify({ d: after2?.portal_days, r: after2?.portal_rows }));
  await dbp.collection("govtattendancerows").deleteMany({ import: imp.insertedId });
  await dbp.collection("govtattendanceimports").deleteOne({ _id: imp.insertedId });
  await mc.close();
}

// ---- -98 (QA-165, checker): a daily log can be READ singly and DELETED (audited, evidence leaves with it) ----
{
  const one = await req("GET", `/api/batches/${batch._id}/logs/${log._id}`);
  ok("-98 (QA-165): a single daily log can be read", one.status === 200 && String(one.data?.item?._id) === String(log._id), String(one.status));
  ok("-98 (QA-165): a bad log id is 400, an unknown one 404", (await req("GET", `/api/batches/${batch._id}/logs/not-an-id`)).status === 400 && (await req("GET", `/api/batches/${batch._id}/logs/${"0".repeat(24)}`)).status === 404);
  // Rule 32 refuses a day before the start and Rule 27 allows one log per day, so the fixture's own
  // day (`log`, today) is the delete target — attach an evidence photo to it via Edit first, delete,
  // then re-create it so the rest of the file keeps its fixture.
  const fdE = new FormData();
  fdE.append("file", new File([Buffer.from("qa165-photo")], "day.png", { type: "image/png" }));
  const upE = await (await fetch(BASE + "/api/upload", { method: "POST", headers: { cookie }, body: fdE })).json();
  const { MongoClient, ObjectId } = await import("mongodb");
  const mc = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
  await mc.connect();
  const dbx = mc.db(process.env.MONGODB_DB || "center_erp_ci");
  await dbx.collection("dailylogs").updateOne({ _id: new ObjectId(String(log._id)) }, { $set: { photos: [upE.url] } });
  const del = await req("DELETE", `/api/batches/${batch._id}/logs/${log._id}`, { reason: "QA-165 pin — wrong day" });
  const gone = await req("GET", `/api/batches/${batch._id}/logs/${log._id}`);
  const photoRead = await fetch(BASE + String(upE.url).replace(/^\/erp/, ""), { headers: { cookie } });
  ok("-98 (QA-165): DELETE removes the day (200 → 404), and its evidence photo leaves storage with it (URL 410)", del.status === 200 && del.data?.evidence_removed === 1 && gone.status === 404 && photoRead.status === 410, JSON.stringify({ d: del.status, g: gone.status, p: photoRead.status, r: del.data }));
  const aud = await dbx.collection("auditlogs").findOne({ field: "daily_log_deleted", entity_id: new ObjectId(String(batch._id)) }, { sort: { created_at: -1 } });
  ok("-98 (QA-165): the deletion is audited with the snapshot (date, present, photos) and the reason", !!aud && /QA-165 pin/.test(String(aud.new_value ?? "")) && /"present":2/.test(String(aud.old_value ?? "")), JSON.stringify(aud && { n: aud.new_value }).slice(0, 200));
  await mc.close();
  // re-create the fixture day exactly as before so the rest of the file is unchanged
  const re = await req("POST", `/api/batches/${batch._id}/logs`, { log_date: today, present_member_ids: mIds.slice(0, 2), govt_present: 2, actual_topic: "Day 1" }, 201);
  ok("-98 (QA-165): the day can be entered again after a delete (Rule 27 slot freed)", re.status === 201, String(re.status));
  if (re.status === 201) log._id = re.data.item._id;
  // rights: view-only / out-of-scope cannot delete
  const enrDel = await fetch(BASE + `/api/batches/${batch._id}/logs/${log._id}`, { method: "DELETE", headers: { cookie: await loginAs("enroll@vidysea.com", "CiOnly@123") } });
  const anonDel = await fetch(BASE + `/api/batches/${batch._id}/logs/${log._id}`, { method: "DELETE" });
  ok("-98 (QA-165): Enrollment (no batches.daily_log) → 403, anonymous → 401 — the fixture day stays", enrDel.status === 403 && anonDel.status === 401 && (await req("GET", `/api/batches/${batch._id}/logs/${log._id}`)).status === 200, `${enrDel.status} ${anonDel.status}`);
}

// ---- -81 (Umesh 15/08, Gurugram DST-02 began 30-07, entered 15-08): Start with the REAL date ----
{
  const dayN = (n) => new Date(Date.now() + n * 864e5 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const bdStart = dayN(-5);
  const bdTrainer = (await req("POST", "/api/trainers", { name: "Backdate Trainer " + stamp, phone: "5300" + stamp, skills: ["bd" + stamp] }, 201)).data.item;
  const bdRoom = (await req("POST", `/api/locations/${loc._id}/rooms`, { name: "Backdate Room " + stamp, type: "Classroom", capacity: 5 }, 201)).data.item;
  const bdBatch = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: bdTrainer._id, room: bdRoom._id, planned_start: bdStart, target_size: 1 }, 201)).data.item;
  const bdCand = (await req("POST", "/api/candidates", { name: "Backdate Cand " + stamp, phone: "5400" + stamp, location: loc._id, program: prog._id }, 201)).data.item;
  const bdMem = (await req("POST", `/api/batches/${bdBatch._id}/members`, { candidate: bdCand._id }, 201)).data.item; // joined_on = today
  await req("PATCH", `/api/members/${bdMem._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
  await req("POST", `/api/batches/${bdBatch._id}/transition`, { target: "Ready" }, 200);
  const bdFuture = await req("POST", `/api/batches/${bdBatch._id}/transition`, { target: "Active", actual_start: dayN(1) }, 400);
  ok("-81: a batch cannot start in the future", /future/i.test(bdFuture.data?.error ?? ""), bdFuture.data?.error);
  const bdActive = (await req("POST", `/api/batches/${bdBatch._id}/transition`, { target: "Active", actual_start: bdStart }, 200)).data.item;
  ok("-81: Start carries the real (past) start date", String(bdActive.actual_start).slice(0, 10) === bdStart, JSON.stringify(bdActive.actual_start));
  const bdMemAfter = ((await req("GET", `/api/batches/${bdBatch._id}/members`)).data.items ?? []).find((m) => String(m._id) === String(bdMem._id));
  ok("-81: roster is counted from the real start (joined_on restamped for members added while catching up)", String(bdMemAfter?.joined_on).slice(0, 10) === bdStart, JSON.stringify(bdMemAfter?.joined_on));
  const bdLog = await req("POST", `/api/batches/${bdBatch._id}/logs`, { log_date: dayN(-3), present_member_ids: [bdMem._id], trainer_present: true }, 201);
  ok("-81: a real past day (after the real start) can now be logged with the member present", bdLog.status === 201, JSON.stringify(bdLog.data?.error ?? bdLog.data?.item?.log_date));
  await req("POST", `/api/batches/${bdBatch._id}/logs`, { log_date: dayN(-6), present_member_ids: [], trainer_present: true }, 400); // Rule 32 still holds before the real start
  const bdAudit = ((await req("GET", `/api/audit/Batch/${bdBatch._id}`)).data.items ?? []);
  ok("-81: the roster restamp is audited once with the count", bdAudit.some((a) => a.field === "roster_backdated" && /1 members/.test(String(a.new_value))), JSON.stringify(bdAudit.map((a) => a.field)));

  // ---- -82 (Umesh): bulk day-wise marking from the Attendance tab — same rules per day ----
  // day -3 is already logged above; -4 and -2 are open; -6 is before the real start; +1 is the future.
  const bulk = (await req("POST", `/api/batches/${bdBatch._id}/logs/bulk`, { days: [
    { log_date: dayN(-4), present_member_ids: [bdMem._id], trainer_present: true },
    { log_date: dayN(-3), present_member_ids: [bdMem._id], trainer_present: true },
    { log_date: dayN(-2), present_member_ids: [], trainer_present: true },
    { log_date: dayN(-6), present_member_ids: [bdMem._id], trainer_present: true },
    { log_date: dayN(1), present_member_ids: [bdMem._id], trainer_present: true },
  ] }, 201)).data;
  const byDay = Object.fromEntries((bulk.results ?? []).map((r) => [r.log_date, r]));
  ok("-82: bulk creates the open days (2) and answers per day", bulk.created === 2 && byDay[dayN(-4)]?.status === "created" && byDay[dayN(-2)]?.status === "created", JSON.stringify(bulk.results));
  ok("-82: an already-logged day is reported 'exists', not duplicated", byDay[dayN(-3)]?.status === "exists", JSON.stringify(byDay[dayN(-3)]));
  ok("-82: a day before the real start fails Rule 32 for that day only", byDay[dayN(-6)]?.status === "error" && /before batch actual start/.test(byDay[dayN(-6)]?.message ?? ""), JSON.stringify(byDay[dayN(-6)]));
  ok("-82: a future day fails Rule 53 for that day only", byDay[dayN(1)]?.status === "error" && /future date/.test(byDay[dayN(1)]?.message ?? ""), JSON.stringify(byDay[dayN(1)]));
  const bdAtt = (await req("GET", `/api/batches/${bdBatch._id}/attendance`)).data;
  ok("-82: the Attendance tab now counts 3 days held, member present on 2 of them", bdAtt.days_held === 3 && bdAtt.members.find((m) => m.member_id === String(bdMem._id))?.internal_days === 2, JSON.stringify({ held: bdAtt.days_held, m: bdAtt.members.map((m) => [m.name, m.internal_days]) }));
  const again = (await req("POST", `/api/batches/${bdBatch._id}/logs/bulk`, { days: [{ log_date: dayN(-4), present_member_ids: [], trainer_present: true }] }, 200)).data;
  ok("-82: repeating a bulk save is idempotent (exists, nothing created)", again.created === 0 && again.results?.[0]?.status === "exists", JSON.stringify(again));
  await req("POST", `/api/batches/${bdBatch._id}/logs/bulk`, { days: [] }, 400);
  await req("POST", `/api/batches/${bdBatch._id}/logs/bulk`, { days: [{ log_date: dayN(-1), present_member_ids: ["000000000000000000000000"], trainer_present: true }] }, 200); // Rule 29 → error for that day, 200 overall
  const bdBulkAudit = ((await req("GET", `/api/audit/Batch/${bdBatch._id}`)).data.items ?? []);
  ok("-82: the bulk save is audited on the batch with the count", bdBulkAudit.some((a) => a.field === "attendance_bulk" && /2 day/.test(String(a.new_value))), JSON.stringify(bdBulkAudit.filter((a) => a.field === "attendance_bulk").map((a) => a.new_value)));
  await req("POST", `/api/batches/${bdBatch._id}/transition`, { target: "Cancelled", reason: "backdate fixture done" }, 200);
}

// ---- QA-1055 (S2): a saved day's roster count GROWS to admit a walk-in — and never shrinks ----
// REQ-202 as amended 2026-08-27 (Umesh, verbatim: "Us din ka count badh jaye — Rule 28 ki asli
// mansha count ko GHATNE se rokna thi, badhne se nahi") + REQ-421 on the government half (his own
// answer: "Flag the day for review when this happens").
//
// QA-1047 made the FROZEN roster_count the bound on a day edit and that refused the everyday case
// outright: a student who enrols today is on today's Rule 26 roster (REQ-119) by the product's own
// default joining date, and BOTH doors — the day PATCH and the marking round — returned 400, so
// there was no way at all to record that day's real attendance. The bound is now the live Rule 26
// roster AS OF log_date; the stored count rises to meet it and never falls. This whole block runs
// on its OWN batch, trainer and room so nothing here can move the shared fixture's numbers.
{
  const q55T = (await req("POST", "/api/trainers", { name: "RosterGrow Trainer " + stamp, phone: "5500" + stamp, skills: ["rg55" + stamp] }, 201)).data.item;
  const q55R = (await req("POST", `/api/locations/${loc._id}/rooms`, { name: "RosterGrow Room " + stamp, type: "Classroom", capacity: 10 }, 201)).data.item;
  const q55B = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: q55T._id, room: q55R._id, planned_start: today, target_size: 3 }, 201)).data.item;
  const q55Mem = [];
  for (let i = 0; i < 3; i++) {
    const c = (await req("POST", "/api/candidates", { name: `RosterGrow Cand ${i} ${stamp}`, phone: `56${i}0${stamp}`.slice(0, 10), location: loc._id, program: prog._id }, 201)).data.item;
    const m = (await req("POST", `/api/batches/${q55B._id}/members`, { candidate: c._id }, 201)).data.item;
    await req("PATCH", `/api/members/${m._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
    q55Mem.push(String(m._id));
  }
  await req("POST", `/api/batches/${q55B._id}/transition`, { target: "Ready" }, 200);
  await req("POST", `/api/batches/${q55B._id}/transition`, { target: "Active", actual_start: today }, 200);
  // Today's log, saved with all three present AND a government figure already recorded against 3.
  // That govt figure is what makes this day REQ-421 material: 3 is what the portal was told.
  const q55Log = (await req("POST", `/api/batches/${q55B._id}/logs`, { log_date: today, present_member_ids: q55Mem, govt_present: 3, trainer_present: true, actual_topic: "roster-growth day" }, 201)).data.item;
  ok("QA-1055 fixture: today's log is saved with roster_count frozen at 3 and govt 3 already recorded",
    q55Log.roster_count === 3 && q55Log.govt_present === 3, JSON.stringify({ rc: q55Log.roster_count, g: q55Log.govt_present }));

  // (a) THE REPORTED CASE. A walk-in enrolled today, no joining date typed — addMemberChecked's own
  // default stores joined_on = today, so Rule 26 puts them on today's roster. The day must accept it.
  const wCand = (await req("POST", "/api/candidates", { name: `RosterGrow Walkin ${stamp}`, phone: `5700${stamp}`.slice(0, 10), location: loc._id, program: prog._id }, 201)).data.item;
  const wMem = String((await req("POST", `/api/batches/${q55B._id}/members`, { candidate: wCand._id }, 201)).data.item._id);
  const q55Patch = await req("PATCH", `/api/logs/${q55Log._id}`, { present_member_ids: [...q55Mem, wMem] });
  ok("QA-1055 (a): a walk-in enrolled TODAY can be marked present on today's already-saved log (200, not the old 400)",
    q55Patch.status === 200, `${q55Patch.status} ${String(q55Patch.data?.error ?? "").slice(0, 140)}`);
  ok("QA-1055 (a): REQ-202 — the day's roster_count GREW 3 → 4 to match the real Rule 26 roster, so the row reads 4 of 4 (100%), not 4 of 3 (133%)",
    q55Patch.data?.item?.roster_count === 4 && q55Patch.data?.item?.internal_present === 4,
    JSON.stringify({ rc: q55Patch.data?.item?.roster_count, ip: q55Patch.data?.item?.internal_present }));

  // (b) REQ-421. The day already carried a government figure, so the growth is FLAGGED, and the
  // reported number itself is left exactly as it was — no resubmission, no silent restatement.
  const q55Flagged = q55Patch.data?.item?.govt_review;
  ok("QA-1055 (b): REQ-421 — the day is flagged for manual review, naming both denominators and the figure that was reported",
    q55Flagged?.needed === true && q55Flagged?.roster_count_before === 3 && q55Flagged?.roster_count_after === 4 && q55Flagged?.govt_present_at_flag === 3,
    JSON.stringify(q55Flagged));
  ok("QA-1055 (b): …and the already-reported government figure is UNTOUCHED — flagged, never restated",
    q55Patch.data?.item?.govt_present === 3, String(q55Patch.data?.item?.govt_present));
  const q55Notes = (await req("GET", "/api/notifications?type=govt_roster_grew")).data.items ?? [];
  const q55Note = q55Notes.find((n) => String(n.entity_id) === String(q55Log._id));
  ok("QA-1055 (b): …and it reaches Ops/Admin through the existing review queue, saying nothing went to the portal",
    !!q55Note && /grew from 3 to 4/.test(String(q55Note.message)) && /resubmitted/i.test(String(q55Note.message)),
    JSON.stringify(q55Note && { t: q55Note.type, m: String(q55Note.message).slice(0, 160) }));
  // REQ-201: a count-changing edit is audited, and the denominator moves under its own name.
  const q55Aud = ((await req("GET", `/api/audit/DailyLog/${q55Log._id}`)).data.items ?? []);
  ok("QA-1055 (b): REQ-201 — the roster_count move is audited by name, 3 → 4",
    q55Aud.some((a) => a.field === "roster_count" && String(a.old_value) === "3" && String(a.new_value) === "4"),
    JSON.stringify(q55Aud.map((a) => `${a.field}:${a.old_value}→${a.new_value}`).slice(0, 8)));

  // (c) THE SECOND DOOR. A marking round is same-day only, which is exactly the case QA-1047 broke.
  const w2Cand = (await req("POST", "/api/candidates", { name: `RosterGrow Walkin Two ${stamp}`, phone: `5800${stamp}`.slice(0, 10), location: loc._id, program: prog._id }, 201)).data.item;
  const w2Mem = String((await req("POST", `/api/batches/${q55B._id}/members`, { candidate: w2Cand._id }, 201)).data.item._id);
  const q55Round = await req("POST", `/api/logs/${q55Log._id}/sessions`, { present_member_ids: [w2Mem] });
  ok("QA-1055 (c): the marking round accepts a second same-day walk-in (201) and grows the count 4 → 5 the same way",
    q55Round.status === 201 && q55Round.data?.item?.roster_count === 5 && q55Round.data?.item?.internal_present === 5,
    `${q55Round.status} ${JSON.stringify({ rc: q55Round.data?.item?.roster_count, ip: q55Round.data?.item?.internal_present })}`);

  // (d) THE HALF OF RULE 28 THAT MUST SURVIVE: the count NEVER decreases. Someone leaving later
  // cannot shrink a day that has already been counted and reported — that was Rule 28's real purpose.
  await req("POST", `/api/members/${w2Mem}/drop`, { left_on: today, drop_reason: "roster-growth pin: left again" }, 200);
  const q55Shrink = await req("PATCH", `/api/logs/${q55Log._id}`, { present_member_ids: [...q55Mem, wMem] });
  ok("QA-1055 (d): REQ-202 — a member leaving cannot pull the day's roster_count back down (still 5, never 4)",
    q55Shrink.status === 200 && q55Shrink.data?.item?.roster_count === 5, `${q55Shrink.status} rc=${q55Shrink.data?.item?.roster_count}`);
  ok("QA-1055 (d): …and REQ-203 still holds on every edit — internal_present never exceeds roster_count",
    q55Shrink.data?.item?.internal_present <= q55Shrink.data?.item?.roster_count,
    JSON.stringify({ ip: q55Shrink.data?.item?.internal_present, rc: q55Shrink.data?.item?.roster_count }));

  // (e) THE RESIDUAL REFUSAL QA-1047 ACTUALLY DESCRIBED is still a 400: someone demonstrably NOT on
  // that day's roster. Growing the denominator is not the same as admitting anybody.
  const q55Bad = await req("PATCH", `/api/logs/${q55Log._id}`, { present_member_ids: [...q55Mem, wMem, w2Mem] });
  ok("QA-1055 (e): a member who left ON that day is still refused (400) — and the refusal names them, not a joining date to 'correct'",
    q55Bad.status === 400 && /left this batch/i.test(String(q55Bad.data?.error ?? "")) && !/joining date/i.test(String(q55Bad.data?.error ?? "")),
    `${q55Bad.status} ${String(q55Bad.data?.error ?? "").slice(0, 140)}`);
  const q55Stranger = await req("PATCH", `/api/logs/${q55Log._id}`, { present_member_ids: [...q55Mem, String(mIds[0])] });
  ok("QA-1055 (e): …and a member of a DIFFERENT batch is still refused (400) — the roster is the bound, not the count",
    q55Stranger.status === 400, `${q55Stranger.status} ${String(q55Stranger.data?.error ?? "").slice(0, 120)}`);
  const q55Final = (await req("GET", `/api/batches/${q55B._id}/logs`)).data.items.find((l) => String(l._id) === String(q55Log._id));
  ok("QA-1055 (e): a refused edit changed nothing — the day still reads 4 of 5 with the flag and the reported 3 intact",
    q55Final?.roster_count === 5 && q55Final?.internal_present === 4 && q55Final?.govt_present === 3 && q55Final?.govt_review?.needed === true,
    JSON.stringify({ rc: q55Final?.roster_count, ip: q55Final?.internal_present, g: q55Final?.govt_present, f: q55Final?.govt_review?.needed }));
  await req("POST", `/api/batches/${q55B._id}/transition`, { target: "Cancelled", reason: "roster-growth fixture done" }, 200);
}

// 2026-08-12 audit F-007 (S1): dropping a candidate on day D used to lock day D's log. Rule 26
// excludes them from that day's roster, the saved log still listed them present, and every later
// PATCH touching present_member_ids or govt_present was refused — so the government attendance
// figure for that day could never be entered. Editing note/photos still worked, which made the
// failure look random. Reproduced on production before the fix.
{
  const fresh = (await req("POST", "/api/candidates", { name: `Drop Log ${stamp}`, phone: `7777${stamp}`, location: loc._id, program: prog._id }, 201)).data.item;
  const fm = (await req("POST", `/api/batches/${batch._id}/members`, { candidate: fresh._id }, 201)).data.item;
  const rosterBefore = (await req("GET", `/api/batches/${batch._id}/logs`)).data.items[0]?.roster_count;
  // put them on today's log, then drop them today
  const withThem = [...mIds.slice(0, 2), fm._id];
  const withThemRes = await req("PATCH", `/api/logs/${log._id}`, { present_member_ids: withThem }, 200);
  // QA-1055: `fm` joined TODAY, so Rule 26 puts them on today's roster and REQ-202 (as amended
  // 2026-08-27) raises this day's count to admit them. `rosterBefore` above is the count from
  // BEFORE that add, so it is no longer what the drop must be compared against — the question
  // this pin asks ("does a DROP move the count?") needs the count as it stood after the add.
  const rosterAfterAdd = withThemRes.data?.item?.roster_count;
  ok("QA-1055/REQ-202: adding a member who joined today raises this day's count to the real Rule 26 roster",
    rosterAfterAdd === rosterBefore + 1, `${rosterBefore} → ${rosterAfterAdd}`);
  await req("POST", `/api/members/${fm._id}/drop`, { left_on: today, drop_reason: "Got a job" }, 200);
  // the log must have been tidied, not left inconsistent
  const tidied = (await req("GET", `/api/batches/${batch._id}/logs`)).data.items.find((l) => l._id === log._id);
  ok("F-007: dropping a member strips them from that day's present list", !tidied.present_member_ids.map(String).includes(String(fm._id)));
  ok("F-007: internal_present follows the tidy-up", tidied.internal_present === tidied.present_member_ids.length, `${tidied.internal_present} vs ${tidied.present_member_ids.length}`);
  ok("F-007 + REQ-202: a drop still cannot move roster_count — it never decreases", tidied.roster_count === rosterAfterAdd && tidied.roster_count > rosterBefore, `${tidied.roster_count} vs ${rosterAfterAdd} (was ${rosterBefore})`);
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

// ---- -109: "not eligible" is a VERDICT, and it waits for both gates ----
// Umesh 17/08: "jo humne student ki step-by-step journey banayi thi… jab batch assigned ho jayega
// tab wo enrolled student me convert hoga, aur enrolled student ke liye ye not-eligible wala hoga
// na. Pehli register karke hi na aa jaye upar." Production was worse than the complaint: BHA-SPIT-02
// read "not eligible" for all 31 students THREE DAYS into a fifteen-day course; BHA-SPIT-01 for all
// 45 purely because that file's decimal hours never parsed; CHI-DST-03 for all 45 with no import at
// all. A missing-data state and an unfinished course were both rendering as a verdict about a real
// student, on the screen where certificates get decided.
{
  const eRoom = (await req("POST", `/api/locations/${loc._id}/rooms`, { name: `Elig Room ${stamp}`, type: "Classroom", capacity: 30 }, 201)).data.item;
  const eb = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, room: eRoom._id, planned_start: today, target_size: 1 }, 201)).data.item;
  const ec = (await req("POST", "/api/candidates", { name: `Elig One ${stamp}`, phone: `830${stamp}0`, location: loc._id, program: prog._id }, 201)).data.item;
  const em = (await req("POST", `/api/batches/${eb._id}/members`, { candidate: ec._id }, 201)).data.item;

  // GATE 1 — the journey. Enrolment is not complete yet, so there is NO verdict to give.
  const notEnrolled = (await req("GET", `/api/batches/${eb._id}/attendance`)).data.members.find((m) => String(m.member_id) === String(em._id));
  ok("-109: a candidate who has not finished enrolling gets NO eligibility verdict",
    notEnrolled.verdict?.state === "not_enrolled" && /not enrolled|registration/i.test(String(notEnrolled.verdict?.detail)),
    JSON.stringify(notEnrolled.verdict));
  ok("-109: …and it is NOT called 'not eligible' — that word is a verdict",
    !/not eligible/i.test(String(notEnrolled.verdict?.label)), String(notEnrolled.verdict?.label));

  await req("PATCH", `/api/members/${em._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
  await req("POST", `/api/batches/${eb._id}/transition`, { target: "Ready" }, 200);
  await req("POST", `/api/batches/${eb._id}/transition`, { target: "Active" }, 200);

  // GATE 2 — no portal hours on record is MISSING DATA, never a verdict.
  const noHours = (await req("GET", `/api/batches/${eb._id}/attendance`)).data.members.find((m) => String(m.member_id) === String(em._id));
  ok("-109: an enrolled student with no portal hours imported reads 'no portal hours yet', not 'not eligible'",
    noHours.verdict?.state === "no_hours" && !/not eligible/i.test(String(noHours.verdict?.label)),
    JSON.stringify(noHours.verdict));

  // The batch tab must also report the honest breakdown rather than one lumped bucket.
  const att = (await req("GET", `/api/batches/${eb._id}/attendance`)).data;
  ok("-109: the batch reports the breakdown by state, so 'no data' is never counted as a verdict",
    att.verdict_counts && typeof att.verdict_counts.no_hours === "number" && typeof att.verdict_counts.not_eligible === "number"
    && att.verdict_counts.no_hours === 1 && att.verdict_counts.not_eligible === 0,
    JSON.stringify(att.verdict_counts));
  ok("-109: …and it says whether the course is over, which is what gates the word 'not eligible'",
    att.course_finished === false, JSON.stringify({ finished: att.course_finished, portal_days: att.portal_working_days }));
  ok("-109: `qualified` keeps its old meaning for every existing caller (portal hours >= bar)",
    att.members.every((m) => m.qualified === (m.basis === "portal" && m.govt?.hours != null && m.govt.hours >= att.required_hours)));
  await req("POST", `/api/batches/${eb._id}/transition`, { target: "Cancelled", reason: "-109 fixture done" }, 200);
  // The roster row has to leave before the candidate record can (candidates/[id] refuses while any
  // batch history exists) — the -102 door is exactly for this, and the pair is pinned above.
  await req("DELETE", `/api/members/${em._id}`, { reason: "-109 fixture teardown" }, 200);
  await req("DELETE", `/api/candidates/${ec._id}`, undefined, 200);
}

// ---- -109: a student registered from INSIDE the ERP now gets their confirmation mail ----
// Umesh 17/08: "admin ne new student register kiya, new student ko mail nahi aaya." There were nine
// send sites and none of them was POST /api/candidates — every registration mail lived on the
// PUBLIC paths. The moment was never built; the transport was fine all along.
{
  const withMail = (await req("POST", "/api/candidates", { name: `Mail Me ${stamp}`, phone: `831${stamp}0`, email: `mailme.${stamp}@vidysea-test.local`, location: loc._id, program: prog._id }, 201)).data.item;
  const logs = (await req("GET", "/api/test-email")).data.log ?? [];
  const mine = logs.find((l) => String(l.entity) === "Candidate" && String(l.entity_id) === String(withMail._id));
  ok("-109: registering a student WITH an email produces a MailLog row for that candidate",
    !!mine && /registration is received/i.test(String(mine.subject)), JSON.stringify(mine && { to: mine.to, s: mine.subject, st: mine.status }));
  // The wall runs with mail suppressed, so the honest outcome here is "skipped" naming the reason —
  // what matters is that the ATTEMPT is on record per candidate, which is what "mail gaya ki nahi"
  // actually needs to be answerable.
  ok("-109: …and the row names its outcome honestly rather than claiming a send",
    ["sent", "skipped", "failed"].includes(String(mine?.status)), String(mine?.status));

  const noMail = (await req("POST", "/api/candidates", { name: `No Mail ${stamp}`, phone: `832${stamp}0`, location: loc._id, program: prog._id }, 201)).data.item;
  const logs2 = (await req("GET", "/api/test-email")).data.log ?? [];
  const skipped = logs2.find((l) => String(l.entity) === "Candidate" && String(l.entity_id) === String(noMail._id));
  // -110 changed what a phone-only student gets: not a mail-skip but an SMS ATTEMPT (Umesh: "email
  // hai toh mail pe, warna phone pe"). The row is still on record, still a skip, still naming the
  // honest reason — today that reason is "no approved DLT template" (or CI suppression), because
  // the registration SMS is switched off by construction until its template is approved.
  ok("-109/-110: a phone-only student is not an error — an attempt is RECORDED with its reason, on the SMS channel",
    !!skipped && skipped.channel === "sms" && skipped.status === "skipped" && /template|test environment|SMS_DISABLED/i.test(String(skipped.reason ?? "")),
    JSON.stringify(skipped && { ch: skipped.channel, st: skipped.status, r: String(skipped.reason).slice(0, 70) }));
  ok("-110: …and the row carries the E.164 number it would have gone to", !!skipped && /^\+91\d{10}$/.test(String(skipped.to ?? "")), String(skipped?.to));
  // -109's own finding (MailLog.to required -> an empty recipient's log row was silently lost) is
  // proved on the one path that CAN reach the mail door with no address: the OTP register step on
  // the SMS path, where the confirmation mail is sent to the candidate's optional email. That is
  // pinned in e2e-roles (-110 block: "registration lands on the SMS path"), where a phone-only
  // registration must leave a recorded email skip, not silence.
  await req("DELETE", `/api/candidates/${withMail._id}`, undefined, 200);
  await req("DELETE", `/api/candidates/${noMail._id}`, undefined, 200);
}

// ---- -108: certificates are PREVIEWED and MAPPED, never committed off a filename alone ----
// Umesh 17/08, on eight certificate files every one of which was refused: the files were correct.
// Not one of 39 roster candidates carried a portal ID, so the matcher's lookup was EMPTY and every
// file had to fail — while the screen blamed the file. The route now stages, proposes, and lets the
// operator correct the proposal before anything is written.
{
  // Rule 13: the fixture room is already hosting a full-day batch across these dates, so this
  // batch gets its own room. Phones are exactly 10 digits (3 + 6-digit stamp + index).
  const cRoom = (await req("POST", `/api/locations/${loc._id}/rooms`, { name: `Cert Room ${stamp}`, type: "Classroom", capacity: 30 }, 201)).data.item;
  const cb = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, room: cRoom._id, planned_start: today, target_size: 2 }, 201)).data.item;
  const cc2 = [];
  for (let i = 0; i < 2; i++) cc2.push((await req("POST", "/api/candidates", { name: `Cert Map ${i} ${stamp}`, phone: `840${stamp}${i}`, location: loc._id, program: prog._id }, 201)).data.item);
  const cm = [];
  for (const c of cc2) cm.push((await req("POST", `/api/batches/${cb._id}/members`, { candidate: c._id }, 201)).data.item);
  for (const m of cm) await req("PATCH", `/api/members/${m._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
  await req("POST", `/api/batches/${cb._id}/transition`, { target: "Ready" }, 200);
  await req("POST", `/api/batches/${cb._id}/transition`, { target: "Active" }, 200);
  const pdf2 = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

  // (a) The roster carries NO portal ids — the reason must blame the ROSTER, not the file.
  const noIds = await certPreview(cb._id, [["CAN_555000111.pdf", pdf2]], 200);
  ok("-108: preview with an id-less roster says the ROSTER has no portal IDs — it does not blame the file",
    noIds.roster_has_no_portal_ids === true
    && /your file is fine/i.test(String(noIds.staged?.[0]?.reason ?? ""))
    && !/matches no candidate/i.test(String(noIds.staged?.[0]?.reason ?? "")),
    JSON.stringify(noIds.staged?.[0]?.reason));
  ok("-108: a preview attaches NOTHING", (await req("GET", `/api/batches/${cb._id}/results`)).data.items.every((i) => !i.result?.certificate_file));
  ok("-108: …and it still stages the file and offers the whole roster to map onto",
    !!noIds.staged?.[0]?.url && (noIds.candidates ?? []).length === 2, JSON.stringify({ url: !!noIds.staged?.[0]?.url, cands: noIds.candidates?.length }));

  // (b) Give both candidates portal ids and a Pass, then prove the operator's correction WINS over
  //     the filename — the case Umesh asked for ("agar koi wrong auto map hua").
  await req("PATCH", `/api/candidates/${cc2[0]._id}`, { sidh_candidate_id: `CAN_881${stamp}` }, 200);
  await req("PATCH", `/api/candidates/${cc2[1]._id}`, { sidh_candidate_id: `CAN_882${stamp}` }, 200);
  await req("PUT", `/api/batches/${cb._id}/results`, { rows: cm.map((m) => ({ member: String(m._id), result: "Pass", score: 70, max_score: 100, assessed_on: today })) }, 200);
  const pre = await certPreview(cb._id, [[`CAN_881${stamp}.pdf`, pdf2]], 200);
  ok("-108: a correctly named file is proposed to the right candidate, with the reason it matched",
    pre.staged?.[0]?.member === String(cm[0]._id) && /portal id/i.test(String(pre.staged?.[0]?.match_by)),
    JSON.stringify({ m: pre.staged?.[0]?.member, by: pre.staged?.[0]?.match_by }));
  // …and the operator points it at the OTHER candidate instead.
  const fixed = await certConfirm(cb._id, [{ url: pre.staged[0].url, member: String(cm[1]._id) }]);
  const afterFix = (await req("GET", `/api/batches/${cb._id}/results`)).data.items;
  const on0 = afterFix.find((i) => String(i.member) === String(cm[0]._id))?.result?.certificate_file;
  const on1 = afterFix.find((i) => String(i.member) === String(cm[1]._id))?.result?.certificate_file;
  ok("-108: the operator's correction WINS — the file lands where they said, not where the filename said",
    fixed.summary?.attached === 1 && !on0 && !!on1, JSON.stringify({ attached: fixed.summary?.attached, on0: !!on0, on1: !!on1 }));

  // (b2) PER-CANDIDATE upload — Umesh's "ya toh bachche ke wahan se kar le". There is no new route
  //      for this and there should not be: PATCH /api/results/<id> { certificate_file } already
  //      carries the whole guard set (upsertCandidateCertificate — Rule 45, DEC-6, and the Rule 46
  //      status ladder is skipped when no status is sent). -108 wires each candidate card to it, so
  //      one file goes to one candidate with no file name and no portal ID involved. Pinned here
  //      because a reviewer reading results/[id]/certificate/route.ts finds only DELETE and could
  //      reasonably conclude the upload half is missing.
  {
    const row0 = (await req("GET", `/api/batches/${cb._id}/results`)).data.items.find((i) => String(i.member) === String(cm[0]._id)).result;
    const fdp = new FormData();
    fdp.append("file", new File([pdf2], "one-candidate.pdf", { type: "application/pdf" }));
    fdp.append("folder_centre", "_e2e"); fdp.append("folder_kind", "certificates");
    const up = await fetch(`${BASE}/api/upload`, { method: "POST", headers: { cookie }, body: fdp }).then((r) => r.json()).catch(() => ({}));
    ok("-108: a single certificate uploads through the ONE upload door (no bulk, no filename)", /\/api\/files\//.test(String(up?.url)), JSON.stringify(up).slice(0, 120));
    const attached1 = await req("PATCH", `/api/results/${row0._id}`, { certificate_file: up.url }, 200);
    const check1 = (await req("GET", `/api/batches/${cb._id}/results`)).data.items.find((i) => String(i.member) === String(cm[0]._id)).result;
    ok("-108: …and PATCH /api/results/<id> attaches it to that one candidate — the per-candidate door",
      attached1.status === 200 && check1.certificate_file === up.url, JSON.stringify({ st: attached1.status, f: check1.certificate_file }));
    // -112 (QA-219): attaching a file now SETTLES the certificate (Issued), and Rule 45 has always
    // pinned the result at Pass while a certificate is in flight — so the remove door runs first and
    // the refusal test uses the now-file-free row. Both original assertions survive, plus one new.
    ok("-112: with a certificate attached, the result can no longer be flipped out from under it",
      (await req("PUT", `/api/batches/${cb._id}/results`, { rows: [{ member: String(cm[0]._id), result: "Absent", assessed_on: today }] })).status === 400);
    // …and the -101 remove door still takes it off again, which is what the card offers beside it.
    ok("-108: the -101 removal door still works on a per-candidate upload",
      (await req("DELETE", `/api/results/${row0._id}/certificate`, { reason: "-108 pin: per-candidate upload cleanup" })).status === 200);
    ok("-108: the per-candidate door still obeys Rule 45 — a non-Pass candidate is refused (409)", await (async () => {
      await req("PUT", `/api/batches/${cb._id}/results`, { rows: [{ member: String(cm[0]._id), result: "Absent", assessed_on: today }] }, 200);
      const row1 = (await req("GET", `/api/batches/${cb._id}/results`)).data.items.find((i) => String(i.member) === String(cm[0]._id)).result;
      const refused = await req("PATCH", `/api/results/${row1._id}`, { certificate_file: up.url });
      await req("PUT", `/api/batches/${cb._id}/results`, { rows: [{ member: String(cm[0]._id), result: "Pass", score: 70, assessed_on: today }] }, 200);
      return refused.status === 409 && /no certificate without a Pass/i.test(String(refused.data?.error ?? ""));
    })());
  }

  // (c) Rule 45 still refuses on confirm, and says what to do.
  await req("DELETE", `/api/results/${afterFix.find((i) => String(i.member) === String(cm[1]._id)).result._id}/certificate`, { reason: "-108 pin: clearing for the Rule 45 check" }, 200);
  await req("PUT", `/api/batches/${cb._id}/results`, { rows: [{ member: String(cm[1]._id), result: "Absent", assessed_on: today }] }, 200);
  const pre2 = await certPreview(cb._id, [[`CAN_882${stamp}.pdf`, pdf2]], 200);
  ok("-108: the PREVIEW already names the Rule 45 blocker, before anything is written",
    pre2.staged?.[0]?.ok === false && /needs a Pass|mark Pass first/.test(String(pre2.staged?.[0]?.blocker)), JSON.stringify(pre2.staged?.[0]?.blocker));
  const refused = await certConfirm(cb._id, [{ url: pre2.staged[0].url, member: String(cm[1]._id) }]);
  ok("-108: and confirming it anyway is still refused (Rule 45 is enforced on the write, not just shown)",
    refused.summary?.attached === 0 && /needs a Pass|mark Pass first/.test(String(refused.refused?.[0]?.reason)), JSON.stringify(refused.refused?.[0]?.reason));

  // (d) An unmapped file is discarded, not abandoned in the bucket.
  const pre3 = await certPreview(cb._id, [["no-id-at-all.pdf", pdf2]], 200);
  const strayUrl = pre3.staged[0].url;
  ok("-108: a file with no id in its name is staged and asks to be mapped", !pre3.staged[0].member && /pick the candidate/i.test(String(pre3.staged[0].reason)));
  const withDiscard = await certConfirm(cb._id, [{ url: pre.staged[0].url, member: String(cm[0]._id) }], [strayUrl]);
  ok("-108: an unmapped file is discarded on confirm and reported", withDiscard.discarded === 1, JSON.stringify(withDiscard.summary));
  ok("-108: …and its URL is gone (410), so nothing lingers unreachable", (await req("GET", strayUrl.replace(/^\/erp/, ""))).status === 410);

  // (e) A file from somewhere else cannot be attached by confirm.
  const foreign = await certConfirm(cb._id, [{ url: "/erp/api/files/deadbeefdeadbeefdeadbeefdeadbeef.pdf", member: String(cm[0]._id) }]);
  ok("-108: confirm refuses a url this batch never staged — the door cannot point a record at any object",
    foreign.summary?.attached === 0 && /not one of this batch/i.test(String(foreign.refused?.[0]?.reason)), JSON.stringify(foreign.refused?.[0]?.reason));
  ok("-108: confirm without pairs is a 400, not a silent no-op", (await req("POST", `/api/batches/${cb._id}/certificates`, { confirm: true, pairs: [] })).status === 400);

  // (f) A re-preview discards the previous, still-unattached staging.
  const s1 = await certPreview(cb._id, [["stale-one.pdf", pdf2]], 200);
  const s2 = await certPreview(cb._id, [["stale-two.pdf", pdf2]], 200);
  ok("-108: a new preview discards the abandoned files from the last one", s2.discarded_stale >= 1, String(s2.discarded_stale));
  ok("-108: …and the abandoned file is genuinely gone (410)", (await req("GET", s1.staged[0].url.replace(/^\/erp/, ""))).status === 410);
  await certConfirm(cb._id, [], []).catch(() => null);
  // -112: this fixture ends with every roster row final and every pass carrying its certificate, so
  // BOTH closure halves are signed off without anyone ticking them — the -108 upload flow and the
  // QA-219 chain meeting on the same batch. The batch itself stays where the human left it.
  {
    const st = (await req("GET", `/api/batches/${cb._id}`)).data.item.status;
    const cl = (await req("GET", `/api/batches/${cb._id}/closure`)).data.closure;
    // Assessment derives (every row is final). Certification does NOT, and that is the honest
    // answer: this fixture's surviving pass ends with its certificate discarded, so Rule 46 still
    // has one unsettled pass — exactly the shape DST-01 is in with its 9th pass.
    ok("-112: the -108 upload flow ends with assessment signed off by derivation, batch untouched",
      st === "Active" && cl?.assessment_status === "Completed",
      JSON.stringify({ st, a: cl?.assessment_status, c: cl?.certification_status }));
    ok("-112: …and certification does NOT derive while one pass has no settled certificate",
      cl?.certification_status !== "Completed", String(cl?.certification_status));
  }
  await req("POST", `/api/batches/${cb._id}/transition`, { target: "Cancelled", reason: "-108 fixture done" }, 200);
}

// ---- -112 (QA-219 · Manish 17/08 M4-01/M4-03/M4-07): completion DERIVES from the rows ----
// What he saw on AVP-GURU-RPLAVP-DST-01: 9 Passes, 8 certificate FILES attached by the -108 upload,
// and the batch still reading Active / "Assessment done → Result Awaited", with Mark Completed
// refusing. Nothing was broken — certificate_status stayed Pending because attaching a file never
// walked Rule 46's ladder, and the two closure ticks plus the batch transition were three separate
// hand presses. Now: a file on a Pass row IS the certificate (→ Issued), every roster row final →
// assessment Completed, every Pass settled → certification Completed, both → the batch completes
// itself. Same gates (Rules 43/46/18); only the trigger changed.
{
  // Rule 13 books a room for the whole date range and Rule 10 does the same for a trainer, so each
  // fixture batch gets its own of both — three batches sharing one room is a room conflict, rightly.
  // -156 (QA-445): `noCan` builds the batch the gate is meant to stop - used exactly once, by d1,
  // to prove the derived door asks the same question as the hand door. Every other batch here goes
  // on to certify, and in the real world a batch that certifies carries portal Candidate IDs.
  const mkBatch = async (size, tag, { noCan = false } = {}) => {
    const room = (await req("POST", `/api/locations/${loc._id}/rooms`, { name: `D112-${tag}-${stamp}`, type: "Classroom" }, 201)).data.item;
    const tr = (await req("POST", "/api/trainers", { name: `TEST-D112${tag} ${stamp}`, phone: `85${tag}${stamp}9`.slice(0, 10), skills: [prog.trainer_skill] }, 201)).data.item;
    const b = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: tr._id, room: room._id, planned_start: today, target_size: size }, 201)).data.item;
    const mems = [];
    const cands = [];
    for (let i = 0; i < size; i++) {
      const c = (await req("POST", "/api/candidates", {
        name: `D112 ${tag}${i} ${stamp}`, phone: `84${tag}${i}${stamp}`.slice(0, 10), location: loc._id, program: prog._id,
        ...(noCan ? {} : { sidh_candidate_id: `CAN_${stamp}${tag}${i}` }),   // DIGITS after CAN: normalizeCan is /CAN[s_-]*(d+)/i, so a letter here reads as NO id at all
      }, 201)).data.item;
      const m = (await req("POST", `/api/batches/${b._id}/members`, { candidate: c._id }, 201)).data.item;
      await req("PATCH", `/api/members/${m._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
      mems.push(m); cands.push(c);
    }
    await req("POST", `/api/batches/${b._id}/transition`, { target: "Ready" }, 200);
    await req("POST", `/api/batches/${b._id}/transition`, { target: "Active" }, 200);
    return { b, mems, cands };
  };
  const upload = async (name) => {
    const fd = new FormData();
    fd.append("file", new File([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52, 10])], name, { type: "application/pdf" }));
    fd.append("folder_centre", "_e2e"); fd.append("folder_kind", "certificates");
    return (await fetch(`${BASE}/api/upload`, { method: "POST", headers: { cookie }, body: fd }).then((r) => r.json())).url;
  };
  const closureOf = async (id) => (await req("GET", `/api/batches/${id}/closure`)).data.closure;
  const statusOf = async (id) => (await req("GET", `/api/batches/${id}`)).data.item.status;
  const rowsOf = async (id) => (await req("GET", `/api/batches/${id}/results`)).data.items;

  // (a) the happy chain: two Passes, two certificate files → Completed with no hand tick at all.
  const { b: d1, mems: m1, cands: cd1 } = await mkBatch(2, 1, { noCan: true });
  await req("PUT", `/api/batches/${d1._id}/results`, { rows: m1.map((m) => ({ member: String(m._id), result: "Pass", score: 70, max_score: 100, assessed_on: today })) }, 200);
  const afterMarks = await closureOf(d1._id);
  ok("-112: every roster row final → assessment Completed derives itself (no hand tick)",
    afterMarks?.assessment_status === "Completed", JSON.stringify({ a: afterMarks?.assessment_status, c: afterMarks?.certification_status }));
  ok("-112: …but certification does NOT derive while the certificates are still Pending",
    afterMarks?.certification_status !== "Completed" && (await statusOf(d1._id)) !== "Completed", JSON.stringify({ c: afterMarks?.certification_status, s: await statusOf(d1._id) }));
  const r1 = await rowsOf(d1._id);
  for (const i of r1) await req("PATCH", `/api/results/${i.result._id}`, { certificate_file: await upload(`d112-${i.member}.pdf`) }, 200);
  const r1b = await rowsOf(d1._id);
  ok("-112: a certificate FILE on a Pass row IS the certificate — status Issued, dated, without walking the ladder by hand",
    r1b.every((i) => i.result?.certificate_status === "Issued" && !!i.result?.certificate_date && !!i.result?.certificate_file),
    JSON.stringify(r1b.map((i) => [i.result?.certificate_status, !!i.result?.certificate_date])));
  // -156 (QA-445): the -155 gate was written on the hand-typed door and narrowed to per-candidate
  // batches - and per-candidate is exactly the mode that DERIVES instead of typing, so the gate was
  // aimed at the door nobody uses. This fixture is the proof: its candidates carry no portal ID at
  // all, and at -155 certification derived itself here while the same shape was refused 409 through
  // the hand door. Two doors, one question, two answers.
  const c1gate = await closureOf(d1._id);
  ok("-156 (QA-445): certification does NOT derive while an enrolled student has no portal Candidate ID",
    c1gate?.certification_status !== "Completed", String(c1gate?.certification_status));
  const gateBody = (await req("GET", `/api/batches/${d1._id}/closure`)).data;
  ok("-156 (QA-445): ...and the closure screen is told WHO is missing one, rather than showing a tick that never arrives",
    Array.isArray(gateBody.certification_blocked_no_can) && gateBody.certification_blocked_no_can.length === 2,
    JSON.stringify(gateBody.certification_blocked_no_can));
  // -158 (QA-471): a NAME does not identify a student on the roster this whole story is about -
  // two Sachin Kumars, one batch - so the payload that feeds the tooltip has to carry something
  // that tells two entries apart. It sent bare names and the screen rendered one name twice.
  {
    const blocked = gateBody.certification_blocked_no_can ?? [];
    const phones = blocked.map((x) => x && x.phone).filter(Boolean);
    ok("-158 (QA-471): each blocked student carries what distinguishes them, not just a name",
      blocked.every((x) => x && typeof x.name === "string" && x.name) && phones.length === blocked.length
        && new Set(phones).size === phones.length,
      JSON.stringify(blocked));
  }
  // the centre does what the message asks: the portal IDs go on the students
  for (const [i, c] of cd1.entries()) await req("PATCH", `/api/candidates/${c._id}`, { sidh_candidate_id: `CAN_${stamp}77${i}` }, 200);
  // a touch on a settled row is what re-runs the derivation (every result upsert recomputes)
  await req("PATCH", `/api/results/${r1[0].result._id}`, { certificate_no: `CERT-D112-${stamp}` }, 200);
  const c1 = await closureOf(d1._id);
  ok("-112: every Pass settled → certification Completed derives itself", c1?.certification_status === "Completed", String(c1?.certification_status));
  ok("-112: the derived figures are real, not blank", (c1?.passed ?? 0) === 2 && (c1?.certificates_issued ?? 0) === 2, JSON.stringify({ p: c1?.passed, ci: c1?.certificates_issued }));
  // WHERE IT STOPS: derivation states FACTS about the rows and never moves the batch — the batch
  // ladder is one-way (no Closing→Active) and Completed is the DEC-6 freeze, so a derived transition
  // could not be walked back the way a derived sign-off can.
  ok("-112: derivation never moves the batch itself — it is still exactly where the human left it",
    (await statusOf(d1._id)) === "Active", await statusOf(d1._id));
  // THE COMPLAINT ITSELF: both presses used to bounce off Rule 18 because nobody had ticked the
  // closure halves. Now each works on the first click.
  ok("-112: Manish's complaint — 'Assessment done → Result Awaited' now works on the first click",
    (await req("POST", `/api/batches/${d1._id}/transition`, { target: "Closing" })).status === 200 && (await statusOf(d1._id)) === "Closing");
  ok("-112: …and so does Complete Batch, the press that used to do nothing",
    (await req("POST", `/api/batches/${d1._id}/transition`, { target: "Completed" })).status === 200 && (await statusOf(d1._id)) === "Completed");
  ok("-112: pressing it again is a no-op (200), not a refusal in the operator's face",
    (await req("POST", `/api/batches/${d1._id}/transition`, { target: "Completed" })).status === 200);
  ok("-112: re-stating a derived closure value on a frozen batch is a no-op too",
    (await req("PUT", `/api/batches/${d1._id}/closure`, { certification_status: "Completed" })).status === 200);
  // DEC-6 still holds: a Completed batch's training facts stay frozen.
  ok("-112: DEC-6 unbroken — a real change to a frozen batch is still refused (409)",
    (await req("PUT", `/api/batches/${d1._id}/closure`, { appeared: 1 })).status === 409);

  // (b) a Fail needs no certificate — the batch still completes on the Passes alone.
  const { b: d2, mems: m2 } = await mkBatch(2, 2);
  await req("PUT", `/api/batches/${d2._id}/results`, { rows: [
    { member: String(m2[0]._id), result: "Pass", score: 70, max_score: 100, assessed_on: today },
    { member: String(m2[1]._id), result: "Fail", failure_reason: "Below cut-off", assessed_on: today },
  ] }, 200);
  const r2 = (await rowsOf(d2._id)).find((i) => String(i.member) === String(m2[0]._id));
  await req("PATCH", `/api/results/${r2.result._id}`, { certificate_file: await upload(`d112b-${stamp}.pdf`) }, 200);
  ok("-112: a Fail blocks nothing — certification settles on the PASSES alone",
    (await closureOf(d2._id))?.certification_status === "Completed" && (await statusOf(d2._id)) === "Active", await statusOf(d2._id));
  // A DERIVED sign-off is the rows talking about themselves, so it follows them BOTH ways: take the
  // certificate off and certification un-derives; un-mark the student and assessment does too. This
  // is why the un-mark door stays open (a human attestation still closes it).
  {
    const r2b = (await rowsOf(d2._id)).find((i) => String(i.member) === String(m2[0]._id));
    await req("DELETE", `/api/results/${r2b.result._id}/certificate`, { reason: "-112 pin: the derived sign-off must walk back" }, 200);
    const back = await closureOf(d2._id);
    ok("-112: removing the certificate walks the DERIVED certification sign-off back to Pending",
      back?.certification_status === "Pending", JSON.stringify({ c: back?.certification_status, a: back?.assessment_status }));
    ok("-112: …and the row itself is honest again — Pending, no file, so the result can still be corrected",
      (await rowsOf(d2._id)).find((i) => String(i.member) === String(m2[0]._id))?.result?.certificate_status === "Pending");
    const unmark = await req("DELETE", `/api/results/${r2b.result._id}`, { reason: "-112 pin: un-marking is not blocked by a derived sign-off" });
    ok("-112: a DERIVED assessment sign-off does not block un-marking (nothing was reported)", unmark.status === 200, `${unmark.status} ${String(unmark.data?.error ?? "").slice(0, 90)}`);
    const back2 = await closureOf(d2._id);
    ok("-112: …and the derived assessment sign-off walks back too", back2?.assessment_status === "Pending", String(back2?.assessment_status));
  }

  // (c) the guard that matters: one unmarked candidate and nothing derives at all.
  const { b: d3, mems: m3 } = await mkBatch(2, 3);
  await req("PUT", `/api/batches/${d3._id}/results`, { rows: [{ member: String(m3[0]._id), result: "Pass", score: 70, max_score: 100, assessed_on: today }] }, 200);
  const r3 = (await rowsOf(d3._id)).find((i) => String(i.member) === String(m3[0]._id));
  await req("PATCH", `/api/results/${r3.result._id}`, { certificate_file: await upload(`d112c-${stamp}.pdf`) }, 200);
  const c3 = await closureOf(d3._id);
  ok("-112: one candidate still unmarked → NOTHING derives (Rule 43 is the gate, not a suggestion)",
    c3?.assessment_status !== "Completed" && c3?.certification_status !== "Completed" && (await statusOf(d3._id)) === "Active",
    JSON.stringify({ a: c3?.assessment_status, c: c3?.certification_status, s: await statusOf(d3._id) }));
  ok("-112: …and the hand press is still refused while that student is unmarked — the gate did not move",
    (await req("POST", `/api/batches/${d3._id}/transition`, { target: "Closing" })).status === 409);
  // Marking the last student is all it takes — the same tick then derives both halves.
  await req("PUT", `/api/batches/${d3._id}/results`, { rows: [{ member: String(m3[1]._id), result: "Absent", assessed_on: today }] }, 200);
  const c3b = await closureOf(d3._id);
  ok("-112: marking the LAST student derives assessment + certification in the same tick (the 26-unmarked case on DST-01)",
    c3b?.assessment_status === "Completed" && c3b?.certification_status === "Completed" && (await statusOf(d3._id)) === "Active",
    JSON.stringify({ a: c3b?.assessment_status, c: c3b?.certification_status, s: await statusOf(d3._id) }));

  // ---- -113 (Umesh 18/08): the ADMIN door — a button that is there, and that actually presses ----
  // Manish's batch is over in the real world and unfinished in the ERP: students nobody marked, a
  // pass with no certificate. Rules 43/46 hold it Active, correctly, and no amount of pressing the
  // ordinary buttons moves it. The Admin door settles those rows the honest way (no result = Absent,
  // no certificate = Not Issued), audited under one typed reason, and only then completes.
  const { b: d4, mems: m4 } = await mkBatch(3, 4);
  await req("PUT", `/api/batches/${d4._id}/results`, { rows: [{ member: String(m4[0]._id), result: "Pass", score: 70, max_score: 100, assessed_on: today }] }, 200);
  const r4 = (await rowsOf(d4._id)).find((i) => String(i.member) === String(m4[0]._id));
  await req("PATCH", `/api/results/${r4.result._id}`, { certificate_file: await upload(`d113-${stamp}.pdf`) }, 200);
  // one Pass with a certificate, TWO students never marked → exactly DST-01's shape
  const plan = (await req("GET", `/api/batches/${d4._id}/complete`, undefined, 200)).data;
  ok("-113: the door SAYS what it will settle before anything is pressed",
    plan.can_complete_cleanly === false && plan.unmarked?.length === 2 && plan.unsettled?.length === 0,
    JSON.stringify({ clean: plan.can_complete_cleanly, u: plan.unmarked?.length, s: plan.unsettled?.length }));
  ok("-113: the ordinary press is still refused while students are unmarked — the rule did not move",
    (await req("POST", `/api/batches/${d4._id}/transition`, { target: "Closing" })).status === 409);
  ok("-113: no reason, no completion (400) — it is recorded on every row it settles",
    (await req("POST", `/api/batches/${d4._id}/complete`, {})).status === 400);
  {
    const enrCookie = await loginAs("enroll@vidysea.com", "CiOnly@123");
    const notAdmin = await fetch(BASE + `/api/batches/${d4._id}/complete`, { method: "POST", headers: { "Content-Type": "application/json", cookie: enrCookie }, body: JSON.stringify({ reason: "not my call" }) });
    const anon = await fetch(BASE + `/api/batches/${d4._id}/complete`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "nope" }) });
    ok("-113: ADMIN only — Enrollment 403, anonymous 401", notAdmin.status === 403 && anon.status === 401, `${notAdmin.status} ${anon.status}`);
  }
  // -206: `force` is the SECOND press. The contract changed deliberately and this line records the
  // change rather than working around it: a bare press on a batch with anything outstanding is now
  // REFUSED and writes nothing (QA-697 — it used to write every unmarked student to Fail and then
  // 409). The refusal is pinned separately below; this is the confirmed press the screen sends after
  // showing the Admin every open row and a way to go and fix each one.
  const doneRes = (await req("POST", `/api/batches/${d4._id}/complete`, { reason: "-113 pin: batch finished on site months ago", force: true }, 200)).data;
  ok("-113: THE ASK — the Admin press completes the batch", (await statusOf(d4._id)) === "Completed", await statusOf(d4._id));
  ok("-113: …and reports exactly what it settled", doneRes.settled?.failed === 2 && doneRes.settled?.not_issued === 0, JSON.stringify(doneRes.settled));
  {
    const rows4 = await rowsOf(d4._id);
    // -204: this asserted ABSENT until Umesh chose otherwise on 22/08, looking at the Gurugram batch:
    // "jitne bachche remaining hain jinke certificate nahi hai, woh bachche fail ho gaye". He was
    // shown that a student who never sat the assessment is Absent rather than Fail, and offered an
    // attendance-driven split; he chose one word for all of them. Both halves are asserted, because
    // "some are Fail" would still pass if the rest were silently left Pending.
    const failed = rows4.filter((i) => i.result?.result === "Fail").length;
    const stillAbsent = rows4.filter((i) => i.result?.result === "Absent").length;
    const stillPending = rows4.filter((i) => !i.result || i.result?.result === "Pending").length;
    ok("-204: the unmarked students are recorded FAIL — Umesh's ruling, not Absent",
      failed === 2 && stillAbsent === 0 && stillPending === 0,
      JSON.stringify({ failed, stillAbsent, stillPending }));
    // Rule 44 refuses a Fail with no reason, and the first run of this change hit it eight times.
    // So the reason is part of the behaviour, not an implementation detail: every forced Fail has to
    // carry one, and it has to say the true thing - that nobody marked them - not a placeholder.
    const reasons = rows4.filter((i) => i.result?.result === "Fail").map((i) => String(i.result?.failure_reason ?? ""));
    ok("-204: …and each forced Fail carries a failure reason naming why it was written",
      reasons.length === 2 && reasons.every((r) => /No result was recorded before .* completed by an Admin/.test(r)),
      JSON.stringify(reasons));
    const cl4 = await closureOf(d4._id);
    ok("-113: the closure signs off from those rows, and the figures are the rows' own",
      cl4?.assessment_status === "Completed" && cl4?.certification_status === "Completed" && cl4?.passed === 1 && cl4?.certificates_issued === 1,
      JSON.stringify({ a: cl4?.assessment_status, c: cl4?.certification_status, p: cl4?.passed, ci: cl4?.certificates_issued }));
  }
  ok("-113: DEC-6 still holds after the Admin door — the completed batch is frozen",
    (await req("PUT", `/api/batches/${d4._id}/closure`, { appeared: 1 })).status === 409);
  // …and because one press can now finish a batch, one press can put it back.
  ok("-113: reopening needs a reason (409 without one)",
    (await req("POST", `/api/batches/${d4._id}/transition`, { target: "Closing" })).status === 409);
  {
    const enrCookie = await loginAs("ops@vidysea.com", "CiOnly@123");
    const notAdmin = await fetch(BASE + `/api/batches/${d4._id}/transition`, { method: "POST", headers: { "Content-Type": "application/json", cookie: enrCookie }, body: JSON.stringify({ target: "Closing", reason: "ops trying to reopen" }) });
    ok("-113: reopening is ADMIN only — Operations is refused", notAdmin.status === 409 || notAdmin.status === 403, String(notAdmin.status));
  }
  ok("-113: an Admin CAN reopen with a reason, and the batch is editable again",
    (await req("POST", `/api/batches/${d4._id}/transition`, { target: "Closing", reason: "-113 pin: a result was wrong" }, 200)).status === 200
    && (await statusOf(d4._id)) === "Closing");
  ok("-113: …and the end date came off with it, so attendance is not refused for days after a date that no longer applies",
    !(await req("GET", `/api/batches/${d4._id}`)).data.item.actual_end);
  ok("-113: after reopening, a result can be corrected again (DEC-6's freeze is lifted, not bypassed)",
    (await req("PUT", `/api/batches/${d4._id}/results`, { rows: [{ member: String(m4[1]._id), result: "Fail", failure_reason: "-113 pin: corrected after reopen", assessed_on: today }] }, 200)).status === 200);
  // A batch with nothing outstanding needs no settling at all — the door just completes it.
  ok("-113: a clean batch reports nothing to settle",
    (await req("GET", `/api/batches/${d1._id}/complete`, undefined, 200)).data.status === "Completed");

  // ---- QA-697 (-206, checker on qa-204): a REFUSED press must change nothing ----
  // The door wrote every unmarked student to Fail, derived the sign-offs, walked the batch
  // Active -> Closing, and only then met Rule 18 and threw 409. Permanent rows, a moved batch, and
  // an error naming none of it. Reproduced by the checker twice, at 10 and 12 rows. The refusal
  // path was never exercised by any suite, which is why it survived: every existing pin presses the
  // door on a batch that CAN complete.
  {
    // `noCan: true` builds the roster WITHOUT portal Candidate IDs — the exact shape of the live
    // batches this defect was standing in front of.
    const { b: rb } = await mkBatch(2, 9, { noCan: true });
    const before = (await req("GET", `/api/batches/${rb._id}`)).data.item.status;

    const refused = await req("POST", `/api/batches/${rb._id}/complete`, { reason: "QA-697 pin: this press must change nothing" });
    ok("QA-697: the door REFUSES when the portal IDs are missing, instead of half-doing it",
      refused.status === 409, `status=${refused.status}`);
    ok("QA-697: …and the refusal names the portal Candidate ID and says nothing changed",
      /portal Candidate ID/i.test(String(refused.data?.error ?? "")) && /nothing has been changed/i.test(String(refused.data?.error ?? "")),
      JSON.stringify(refused.data?.error ?? null).slice(0, 200));
    const after = (await req("GET", `/api/batches/${rb._id}`)).data.item.status;
    ok("QA-697: …the batch did NOT move", after === before, `${before} -> ${after}`);
    const rrows = (await req("GET", `/api/batches/${rb._id}/results`)).data.items ?? [];
    const anyFail = rrows.filter((i) => i.result?.result === "Fail").length;
    ok("QA-697: …and NOT ONE student was written to Fail by a press that then failed",
      anyFail === 0, JSON.stringify({ failed: anyFail, rows: rrows.length }));

    // ---- QA-732 (-206 checker, cycle 2 on qa-206): the FORCED press's own deliverables, pinned ----
    // QA-675 asked for the IST wall-clock and the list of what was open, by name, on the audit row -
    // the checker measured all of it by hand and found NOT ONE assertion existed for any of it,
    // on the release whose own commit message names "no suite exercises this path" as the reason
    // QA-697 itself survived. This is that pin.
    const forced = await req("POST", `/api/batches/${rb._id}/complete`,
      { reason: "QA-732 pin: forced, must be signed and logged in IST", force: true });
    ok("QA-732: a forced press on a noCan, unmarked batch actually completes",
      forced.status === 200, `status=${forced.status} error=${JSON.stringify(forced.data?.error ?? null).slice(0, 200)}`);
    const rClosure = await closureOf(rb._id);
    ok("QA-732: …certification is signed by the Admin, not derived",
      rClosure?.certification_status === "Completed" && rClosure?.certification_derived === false,
      JSON.stringify({ cert: rClosure?.certification_status, derived: rClosure?.certification_derived }));
    const rAudit = ((await req("GET", `/api/audit/Batch/${rb._id}`)).data.items ?? []);
    const completedRow = rAudit.find((a) => a.field === "completed_by_admin");
    const nvText = String(completedRow?.new_value ?? completedRow?.newValue ?? "");
    ok("QA-732: …the audit row carries an IST wall-clock, not the raw UTC instant",
      /Completed by Admin at \d{1,2} \w{3} \d{4}, \d{2}:\d{2} (am|pm) IST/.test(nvText),
      nvText.slice(0, 120));
    // The blocked candidates come from `mkBatch`'s own `noCan` roster, named `D112 9<i> <stamp>`.
    const rrosterCands = (await req("GET", `/api/batches/${rb._id}/members`)).data.items ?? [];
    const blockedNames = rrosterCands.map((m) => m.candidate?.name).filter(Boolean);
    ok("QA-732: …and it names EACH blocked student, not just a count",
      blockedNames.length >= 2 && blockedNames.every((n) => nvText.includes(n)),
      JSON.stringify({ names: blockedNames, text: nvText.slice(0, 260) }));

    // ---- QA-732 cycle 2 (-256): the two deliverables the cycle-1 pins still did not cover ----
    // The checker listed five unguarded behaviours and verified all five BY HAND (its P3/P4/P6).
    // Three got pins above. These are the other two, and they are the two that cannot be seen by
    // reading the audit row - one lives on the RESPONSE, the other only shows up later.

    // (1) `completed_at_ist` on the response body. A grep of the whole scripts/ tree found ZERO
    //     hits for this key at the cycle-1 commit AND at HEAD: the route computes an IST stamp,
    //     returns it, and nothing has ever asserted it is there or that it is IST. The audit-row
    //     pin above reads the STORED sentence; this reads what the caller is handed back, which is
    //     what a screen would render. Two different surfaces, and only one of them was watched.
    ok("QA-732 (-256): the forced press HANDS BACK its IST wall-clock, not only writes it to the audit row",
      typeof forced.data?.completed_at_ist === "string"
        && /^\d{2} \w{3} \d{4}, \d{2}:\d{2} (am|pm)$/.test(String(forced.data.completed_at_ist)),
      JSON.stringify({ completed_at_ist: forced.data?.completed_at_ist ?? null }));
    // ...and it is the SAME instant the audit row recorded. Two stamps of "now" taken in two places
    // is how a record ends up disagreeing with itself about when a thing happened.
    ok("QA-732 (-256): …and it is the same stamp the audit row carries, not a second reading of the clock",
      !!forced.data?.completed_at_ist && nvText.includes(String(forced.data.completed_at_ist)),
      JSON.stringify({ response: forced.data?.completed_at_ist ?? null, audit: nvText.slice(0, 140) }));

    // (2) THE STICKY SIGNATURE. Rule 18 normally derives certification from the rows; an Admin who
    //     forces past it SIGNS it instead (`certification_derived: false`). The danger is the next
    //     derivation quietly overwriting that signature and erasing the fact that a human overrode
    //     the rule - the batch would then read as if it had qualified on its own. The checker
    //     reproduced the correct behaviour by hand (P6) and found nothing guarding it.
    //
    //     Every step below is asserted, so this cannot pass by the reopen failing and nothing
    //     happening at all - which is exactly how a "nothing changed" pin passes for the wrong
    //     reason (QA-776, and twice more in this file's own history this week).
    const reopen = await req("POST", `/api/batches/${rb._id}/transition`,
      { target: "Closing", reason: "QA-732 pin: reopen to re-run derivation over a signed closure" });
    ok("QA-732 (-256): …the signed batch can be reopened at all, so the rest of this actually runs",
      reopen.status === 200, `status=${reopen.status} ${JSON.stringify(reopen.data?.error ?? null).slice(0, 160)}`);
    if (reopen.status === 200) {
      // Give every student the portal ID whose absence forced the press in the first place, so the
      // ordinary derivation now HAS every reason to sign certification by itself.
      const rmems = (await req("GET", `/api/batches/${rb._id}/members`)).data.items ?? [];
      let idsSet = 0;
      for (const [i, m] of rmems.entries()) {
        const cid = m.candidate?._id ?? m.candidate;
        if (!cid) continue;
        const put = await req("PATCH", `/api/candidates/${cid}`, { sidh_candidate_id: `CAN_${stamp}73${i}` });
        if (put.status === 200) idsSet++;
      }
      ok("QA-732 (-256): …and the blocker that forced the press is genuinely gone before we re-derive",
        idsSet >= 2 && idsSet === rmems.length, JSON.stringify({ idsSet, roster: rmems.length }));
      // Now give the derivation EVERY reason to sign certification by itself: every row a Pass, every
      // certificate walked up Rule 46 to Issued. If the signature were overwritable, this is the
      // shape that would overwrite it - a batch that now qualifies on its own merits, with the
      // Admin's override sitting underneath.
      //
      // The first version of this block reached for one `PATCH /api/results/<id> {certificate_no}`,
      // the touch the -112 fixture next door uses. It answered 409 - those rows are Fail with the
      // certificate Not Issued after a forced press, which is a different shape entirely - and the
      // sticky assertion below then passed WITHOUT ANY DERIVATION HAVING RUN. It was green because
      // nothing happened. The `touch` assertion is what caught it, which is the whole reason each
      // step here is asserted rather than assumed (QA-776's lesson, third outing this week).
      const rmems2 = (await req("GET", `/api/batches/${rb._id}/members`)).data.items ?? [];
      const rePut = await req("PUT", `/api/batches/${rb._id}/results`, {
        rows: rmems2.map((m) => ({ member: String(m._id), result: "Pass", score: 75, max_score: 100, assessed_on: today })),
      });
      ok("QA-732 (-256): …every student can be re-marked Pass, so the derivation has rows to act on",
        rePut.status === 200, `status=${rePut.status} ${JSON.stringify(rePut.data?.error ?? null).slice(0, 160)}`);
      const rrows2 = (await req("GET", `/api/batches/${rb._id}/results`)).data.items ?? [];
      let issued = 0;
      for (const i of rrows2) {
        const rid = i.result?._id;
        if (!rid) continue;
        await req("PATCH", `/api/results/${rid}`, { certificate_status: "Processing" });
        await req("PATCH", `/api/results/${rid}`, { certificate_status: "Generated", certificate_no: `CERT-732-${stamp}-${issued}`, certificate_date: today });
        const iss = await req("PATCH", `/api/results/${rid}`, { certificate_status: "Issued" });
        if (iss.status === 200) issued++;
      }
      ok("QA-732 (-256): …and the derivation really was re-run over a batch that now qualifies on its own",
        issued >= 2 && issued === rrows2.length,
        JSON.stringify({ issued, rows: rrows2.length }));
      const signed = await closureOf(rb._id);
      // Certification IS Completed either way - what must not change is WHO said so.
      ok("QA-732 (-256): the Admin's signature is STICKY - a later derivation cannot quietly overwrite it",
        signed?.certification_status === "Completed" && signed?.certification_derived === false,
        JSON.stringify({ cert: signed?.certification_status, derived: signed?.certification_derived, issued }));
    }
  }

  // A clean, fully-marked and fully-settled batch: a bare (unforced) press must say plainly that
  // nothing was outstanding, not merely succeed silently.
  {
    const { b: cb, mems: cm } = await mkBatch(2, 90);
    await req("PUT", `/api/batches/${cb._id}/results`, { rows: cm.map((m) => ({ member: String(m._id), result: "Pass", score: 80, max_score: 100, assessed_on: today })) }, 200);
    const cRows = await rowsOf(cb._id);
    for (const i of cRows) await req("PATCH", `/api/results/${i.result._id}`, { certificate_file: await upload(`d112-clean-${i.member}.pdf`) }, 200);
    const clean = await req("POST", `/api/batches/${cb._id}/complete`, { reason: "QA-732 pin: clean press, must say nothing was outstanding" });
    ok("QA-732: a clean press on a fully-marked, fully-settled, fully-CAN'd batch completes unforced",
      clean.status === 200, `status=${clean.status} error=${JSON.stringify(clean.data?.error ?? null).slice(0, 200)}`);
    const cAudit = ((await req("GET", `/api/audit/Batch/${cb._id}`)).data.items ?? []);
    const cRow = cAudit.find((a) => a.field === "completed_by_admin");
    const cText = String(cRow?.new_value ?? cRow?.newValue ?? "");
    ok("QA-732: …and the row reads plainly that nothing was outstanding, not an empty list",
      cText.includes("nothing was outstanding"), cText.slice(0, 200));
  }

  // ---- QA-735 / QA-736 (-212, checker on qa-211): QA-697 RESTORED, on a shape nothing covered ----
  //
  // The Admin's force door signed certification only `if (noCan.length)` — a condition that was
  // wrong about its own reason. `deriveCompletion` signs certification only when `pass_count > 0`,
  // so a batch where NOBODY passed never derives it either. On such a batch, with every portal ID
  // present, the override was skipped, the ladder reached Rule 18, and the press 409'd — AFTER it
  // had written every unmarked student a permanent `Fail` and moved the batch Active -> Closing.
  // Permanently un-completable, while the drawer reported it clean.
  //
  // It survived because every pin for this door — QA-697's included — used a roster WITH a
  // portal-ID gap, and the gap is what made the override fire. Take the gap away and the door
  // closes. That is the second dead-button shape in three releases, in the release whose subject
  // was a button that could only fail.
  {
    // NO `noCan` — every student holds a real portal ID. Nobody is marked, so nobody passes.
    const { b: zb } = await mkBatch(2, 10);
    const pressed = await req("POST", `/api/batches/${zb._id}/complete`,
      { reason: "QA-735 pin: nobody passed and no portal ID is missing", force: true });
    ok("QA-735: a forced press on a batch where NOBODY passed completes, instead of 409 at the last step",
      pressed.status === 200, `status=${pressed.status} error=${JSON.stringify(pressed.data?.error ?? null).slice(0, 200)}`);
    ok("QA-736: …and the batch actually reaches Completed rather than being stranded in Closing",
      (await statusOf(zb._id)) === "Completed", await statusOf(zb._id));
    const zc = await closureOf(zb._id);
    ok("QA-735: …certification is signed by the Admin, NOT derived — the tick is a person's decision",
      zc?.certification_status === "Completed" && zc?.certification_derived === false,
      JSON.stringify({ cert: zc?.certification_status, derived: zc?.certification_derived }));
    // The reason must name the TRUE cause. The old audit line asserted the portal ID even when the
    // portal ID was not the problem — this batch has every ID.
    // the audit model stores `new_value` (snake_case) — reading `newValue` here returned three
    // empty strings and made this pin pass-by-accident-shaped rather than false. Read both.
    const zAudit = (await req("GET", `/api/audit/Closure/${zc._id}`)).data.items ?? [];
    const nv = (a) => String(a.new_value ?? a.newValue ?? "");
    ok("QA-735: …and the audit row says why certification did not derive, not a borrowed reason",
      zAudit.some((a) => /no candidate passed/i.test(nv(a))),
      JSON.stringify(zAudit.slice(0, 3).map((a) => nv(a).slice(0, 90))));
    ok("QA-735: …and it does NOT blame the portal Candidate ID, which this batch has for everyone",
      zAudit.length > 0 && !zAudit.some((a) => /portal Candidate ID/i.test(nv(a))),
      JSON.stringify(zAudit.map((a) => nv(a).slice(0, 70))));
  }

  // ---- QA-751 / QA-752 / QA-753 (-213, checker on qa-212): the THIRD write-then-refuse shape ----
  //
  // -212 fixed the 0-pass batch and was charged with hunting a third. There was one, and the checker
  // found it: a roster where EVERY member has been dropped. `deriveCompletion` signs assessment only
  // when `total > 0`, so it never derives; -212 signed CERTIFICATION in the Admin's name, audit row
  // and all, its new assertion waved the press through because certification was the only arm it
  // looked at, and the ladder then refused on the way OUT of Active. Batch stranded with a sign-off
  // nobody could derive, drawer calling it clean, and a second press repeating it forever.
  //
  // Unforced, the same shape sailed past the blocker refusal entirely - an empty active roster has
  // no unmarked, no unsettled and no missing portal ID, so the list was EMPTY and the door treated
  // "nothing is blocking" as "ready", wrote, and moved the batch. Its own comment promises the first
  // press never writes.
  {
    const { b: db_, mems: dm } = await mkBatch(2, 12);
    // The drop door is POST /api/members/:id/drop with a REASON (Rule 25) - not a PATCH. My first
    // version of this pin PATCHed `left_on` onto the member route, which does not accept that field:
    // it returned 200, dropped nobody, and the pin then exercised the QA-736 shape all over again
    // while claiming to be the all-dropped one. It passed. That is the same fail-proof-pin fault the
    // -212 checker charged (QA-757), caught here only because the assertion on `assessment_derived`
    // was specific enough to notice the sign-off had been DERIVED rather than signed.
    for (const m of dm) await req("POST", `/api/members/${m._id}/drop`, { left_on: today, drop_reason: "Other" }, 200);
    ok("QA-751 precondition: the roster really is empty before the press",
      ((await req("GET", `/api/batches/${db_._id}/complete`)).data.roster_count ?? -1) === 0,
      JSON.stringify((await req("GET", `/api/batches/${db_._id}/complete`)).data.roster_count ?? null));

    // QA-752 note: an unforced press on THIS (all-dropped) shape already refused before -213 and
    // already left the batch alone, so asserting it here proves nothing - I checked against a
    // rebuilt -212 and both assertions were green on both sides. The shape that actually moved the
    // batch is pinned separately below; keeping a green-both-ways assertion here would be the
    // third fail-proof pin of the day.
    const beforeStatus = await statusOf(db_._id);
    const soft = await req("POST", `/api/batches/${db_._id}/complete`, { reason: "QA-752 pin: this press must change nothing" });
    ok("QA-752 [regression guard, green pre-fix]: an unforced press on an all-dropped roster refuses",
      soft.status === 409, `status=${soft.status}`);
    ok("QA-752 [regression guard, green pre-fix]: …and does not move the batch",
      (await statusOf(db_._id)) === beforeStatus, `${beforeStatus} -> ${await statusOf(db_._id)}`);

    // QA-751: forced must actually finish, signing BOTH arms rather than one.
    const hard = await req("POST", `/api/batches/${db_._id}/complete`,
      { reason: "QA-751 pin: everyone left, close it", force: true });
    ok("QA-751: a forced press on an all-dropped roster completes instead of stranding the batch",
      hard.status === 200, `status=${hard.status} error=${JSON.stringify(hard.data?.error ?? null).slice(0, 200)}`);
    ok("QA-751: …and the batch really reaches Completed, not Active with a sign-off on it",
      (await statusOf(db_._id)) === "Completed", await statusOf(db_._id));
    const dc = await closureOf(db_._id);
    ok("QA-751: …BOTH arms are signed, and both say a person signed them, not the rows",
      dc?.assessment_status === "Completed" && dc?.certification_status === "Completed"
      && dc?.assessment_derived === false && dc?.certification_derived === false,
      JSON.stringify({ a: dc?.assessment_status, ad: dc?.assessment_derived, c: dc?.certification_status, cd: dc?.certification_derived }));
    // guard: when the fix is incomplete `dc` is null, and reading `dc._id` CRASHES the suite -
    // which the wall then refuses to count at all rather than reporting three honest failures.
    const dAudit = dc?._id ? ((await req("GET", `/api/audit/Closure/${dc._id}`)).data.items ?? []) : [];
    ok("QA-751: …and the assessment audit row names the real reason - nobody was left on the roster",
      dAudit.some((a) => /no student remained on the roster/i.test(String(a.new_value ?? a.newValue ?? ""))),
      JSON.stringify(dAudit.slice(0, 4).map((a) => String(a.new_value ?? a.newValue ?? "").slice(0, 80))));
  }

  // ---- QA-752 proper (-213): the shape where an unforced press really DID move the batch ----
  //
  // Every student marked, NOBODY passed, no portal-ID gap. The blocker list is empty, so the
  // refusal at the top of the door never fires. Before -213 the press then settled nothing,
  // assessment derived on its own, the batch MOVED Active -> Closing, and Rule 18 refused only
  // there - because certification never derives when pass_count is 0. One rung up from where the
  // operator left it, by a press whose own comment promises the first press never writes.
  {
    const { b: mb, mems: mm } = await mkBatch(2, 13);
    await req("PUT", `/api/batches/${mb._id}/results`, {
      rows: mm.map((m) => ({ member: String(m._id), result: "Fail", failure_reason: "Below cut-off", assessed_on: today })),
    }, 200);
    const pre = (await req("GET", `/api/batches/${mb._id}/complete`)).data;
    ok("QA-752: the precondition - nothing is blocking, so the top refusal cannot fire",
      (pre.unmarked ?? []).length === 0 && (pre.unsettled ?? []).length === 0 && (pre.no_portal_id ?? []).length === 0,
      JSON.stringify({ unmarked: (pre.unmarked ?? []).length, unsettled: (pre.unsettled ?? []).length, noCan: (pre.no_portal_id ?? []).length }));
    const was = await statusOf(mb._id);
    const soft2 = await req("POST", `/api/batches/${mb._id}/complete`, { reason: "QA-752 pin: must not move the batch" });
    ok("QA-752: the press refuses…", soft2.status === 409, `status=${soft2.status}`);
    ok("QA-752: THE DEFECT — …and the batch is still where the operator left it",
      (await statusOf(mb._id)) === was, `${was} -> ${await statusOf(mb._id)}`);
    ok("QA-752: …and the refusal says the batch was not moved, instead of a bare rule name",
      /has NOT been moved/i.test(String(soft2.data?.error ?? "")),
      JSON.stringify(soft2.data?.error ?? null).slice(0, 200));
  }

  // ---- QA-737 (-212, checker on qa-211): the drawer's list and the server's door must agree ----
  // A portal-ID gap only blocks while certification is UNSIGNED. Once it is Completed — derived or
  // signed — the gap is a data-quality fact, not a door, and the ordinary transition passes. The
  // preview listed it as an open blocker regardless, so a batch that completes 200 was shown as
  // blocked and the operator was sent to fix something that was stopping nothing.
  {
    const { b: sb, mems: sm } = await mkBatch(2, 11, { noCan: true });
    await req("PUT", `/api/batches/${sb._id}/results`, { rows: sm.map((m) => ({ member: String(m._id), result: "Pass", score: 70, max_score: 100, assessed_on: today })) }, 200);
    const pre = (await req("GET", `/api/batches/${sb._id}/complete`)).data;
    ok("QA-737: while certification is unsigned, the missing portal IDs ARE reported as blocking",
      pre.no_portal_id_blocks === true && (pre.no_portal_id ?? []).length === 2,
      JSON.stringify({ blocks: pre.no_portal_id_blocks, n: (pre.no_portal_id ?? []).length }));
    await req("POST", `/api/batches/${sb._id}/complete`, { reason: "QA-737 pin: sign it past the gap", force: true }, 200);
    const post = (await req("GET", `/api/batches/${sb._id}/complete`)).data;
    ok("QA-737: …and once it IS signed, the same students are still named but no longer called blocking",
      post.no_portal_id_blocks === false && (post.no_portal_id ?? []).length === 2,
      JSON.stringify({ blocks: post.no_portal_id_blocks, n: (post.no_portal_id ?? []).length }));
  }

  // ---- -126 (S18-02 / S18-03 / S18-04): the PUBLIC self-registration door ----
  // Shivshakti, 18/08: "jab hum self register ki link bhejte hain toh wo saare column yahan bhi show
  // hone chahiye." SS-01 landed on the internal form and both internal routes and never touched this
  // page, so a candidate who self-registered still had to be chased for the data the fields exist to
  // stop chasing. The pins are on the two things that fail SILENTLY: a field the route does not accept
  // looks saved and is gone on the next read (-116's lesson), and a REMOVED field that is only hidden
  // on screen is not removed at all.
  {
    const tok = (await req("POST", "/api/public-tokens", { purpose: "register", location: loc._id, program: prog._id }, 201)).data.item;
    const portal = { salutation: "Mr.", father_name: "Indal Singh", mother_name: "Rani Devi", marital_status: "Single",
      religion: "Hindu", social_category: "OBC", state: "Uttar Pradesh", district: "Sant Ravidas Nagar", sub_district: "Aurai" };
    const reg = await fetch(`${BASE}/api/public/register/${tok.token}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Self Reg ${stamp}`, phone: `79${stamp}55`.slice(0, 10), email: `selfreg.${stamp}@example.invalid`, ...portal }),
    });
    ok("-126 (S18-02): a self-registration carrying the government-portal fields is accepted", reg.status === 201 || reg.status === 200, String(reg.status));
    const mine = ((await req("GET", `/api/candidates?limit=2000`)).data.items ?? []).find((c2) => c2.name === `Self Reg ${stamp}`);
    ok("-126 (S18-02): …and the candidate exists", !!mine, "not found after self-registration");
    const wrong = Object.entries(portal).filter(([k, v]) => String(mine?.[k] ?? "") !== v).map(([k]) => k);
    ok("-126 (S18-02): every portal field STORES and READS BACK through the public door", wrong.length === 0, `missing/wrong: ${wrong.join(", ")}`);

    // -126 (S18-04): the public door used to run its own phone rule (length >= 10) while the rest of
    // the product used canonicalPhone — so junk got in here that was refused everywhere else.
    const bad = await fetch(`${BASE}/api/public/register/${tok.token}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Bad Phone ${stamp}`, phone: "99999999999999", email: `bad.${stamp}@example.invalid` }),
    });
    const badBody = await bad.json().catch(() => ({}));
    ok("-126 (S18-04): the public door now refuses a bad phone with the SAME rule as the rest of the product",
      bad.status === 400 && /10-digit/i.test(String(badBody?.error ?? "")), `${bad.status} ${String(badBody?.error ?? "").slice(0, 70)}`);

    // -126 (S18-03): removed means removed, not hidden. Both internal doors must ignore them.
    const c3 = (await req("POST", "/api/candidates", { name: `No Extras ${stamp}`, phone: `79${stamp}66`.slice(0, 10), location: loc._id, program: prog._id, address_type: "Rural", differently_abled: "Other" }, 201)).data.item;
    const back3 = (await req("GET", `/api/candidates/${c3._id}`)).data.item;
    ok("-126 (S18-03): the two removed fields are REJECTED on create, not quietly stored",
      !back3.address_type && !back3.differently_abled, JSON.stringify({ a: back3.address_type, d: back3.differently_abled }));
    await req("PATCH", `/api/candidates/${c3._id}`, { address_type: "Urban" }, 200);
    ok("-126 (S18-03): …and on edit too — the whitelist is the door, not the form",
      !(await req("GET", `/api/candidates/${c3._id}`)).data.item.address_type);
  }

  // ---- -130 (QA-273): the bulk roster door refused every walk-in ----
  // -124 taught the single-add door that a candidate with no centre ADOPTS the batch's. The bulk
  // door was three files away and never got either half: no walk-in exemption, so `String(undefined)`
  // never matched the batch id and the row was refused with "belongs to another centre" — naming a
  // centre the person does not have; and no adoption, so even a successful bulk enrolment left the
  // record unscoped and invisible to the centre running the batch. One at a time worked, thirty at a
  // time did not. Pinned on BOTH halves, because fixing only the refusal would have shipped the
  // silent one.
  {
    // its own batch on purpose: this block ENROLS someone, and the closure/transition assertions
    // further down read the shared batch's roster. A pin that moves the state another pin reads is
    // a pin that will be blamed for the wrong thing.
    // no room and no trainer: this pin only needs a roster to enrol into, and booking the shared
    // room again for overlapping dates is refused (correctly) by the double-booking rule.
    const bulkBatchRes = await req("POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: today, target_size: 3 }, 201);
    const bulkBatch = bulkBatchRes.data.item;
    ok("-130 (QA-273): a second batch exists to test the bulk door against", !!bulkBatch?._id, JSON.stringify(bulkBatchRes.data).slice(0, 160));
    const bulkWalkIn = (await req("POST", "/api/candidates", { name: `Bulk Walk In ${stamp}`, phone: `82${stamp}77`.slice(0, 10), program: prog._id }, 201)).data.item;
    ok("-130 (QA-273): a walk-in starts with no centre (the -124 shape)", !bulkWalkIn.location, JSON.stringify({ loc: bulkWalkIn.location }));
    const bulk = await req("POST", "/api/candidates/assign", { batch: bulkBatch._id, candidate_ids: [bulkWalkIn._id] }, 200);
    const row = (bulk.data.results ?? [])[0];
    ok("-130 (QA-273): the BULK door accepts them too - it is the same question as adding one",
      row?.ok === true, JSON.stringify(row));
    ok("-130 (QA-273): ...and no longer blames a centre the candidate does not have",
      !/belongs to another centre/i.test(String(row?.error ?? "")), String(row?.error ?? ""));
    const bAfter = (await req("GET", `/api/candidates/${bulkWalkIn._id}`)).data.item;
    ok("-130 (QA-273): ...and the bulk path ADOPTS the centre, so the row is not left invisible to it",
      String(bAfter.location?._id ?? bAfter.location) === String(loc._id),
      JSON.stringify({ got: bAfter.location?._id ?? bAfter.location, want: String(loc._id) }));
    // -131 (QA-277): the FOURTH instance of this shape, on this very route. addMemberChecked
    // computes "Roster is now N of target M" and returns it on the member; the single-add door has
    // always surfaced it and the bulk door populated `warning` only from the eligibility check, so
    // the roster warning was computed on every row and thrown away. bulkBatch has target_size 3.
    {
      const overs = [];
      for (let i = 0; i < 3; i++) {
        overs.push((await req("POST", "/api/candidates", { name: `Over Target ${i} ${stamp}`, phone: `83${stamp}${i}0`.slice(0, 10), location: loc._id, program: prog._id }, 201)).data.item._id);
      }
      const res = await req("POST", "/api/candidates/assign", { batch: bulkBatch._id, candidate_ids: overs }, 200);
      const warned = (res.data.results ?? []).filter((r2) => /target/i.test(String(r2.warning ?? "")));
      ok("-131 (QA-277): pushing a roster past target through the BULK door warns, exactly as adding one does",
        warned.length > 0, JSON.stringify((res.data.results ?? []).map((r2) => r2.warning ?? null)));
      ok("-131 (QA-277): ...and the warning names the roster and the target, not just 'too many'",
        /Roster is now \d+ of target \d+/.test(String(warned[0]?.warning ?? "")), String(warned[0]?.warning ?? ""));
      ok("-131 (QA-277): ...and the top-level warnings array carries it too, so a caller cannot miss it",
        (res.data.warnings ?? []).some((w) => /target/i.test(String(w))), JSON.stringify(res.data.warnings));
    }

    ok("-130 (QA-273): ...audited, because it changes who can see the record",
      ((await req("GET", `/api/audit/Candidate/${bulkWalkIn._id}`)).data.items ?? []).some((a2) => String(a2.field) === "location"),
      "no audit row for the adoption");
  }

  // ---- -124 (M4-04): a walk-in has no centre until somebody enrols them ----
  // Manish: "ye location nahi hogi, user ka koi bhi location ho sakta hai." Forcing a centre at entry
  // either invents a fact or turns the person away. The centre is decided by the first real event
  // instead. Everything here is about who can SEE the row, because Rule 38 scoping keys on this field.
  {
    const walkIn = (await req("POST", "/api/candidates", { name: `Walk In ${stamp}`, phone: `81${stamp}44`.slice(0, 10), program: prog._id }, 201)).data.item;
    ok("-124 (M4-04): a candidate can be entered with NO centre", !walkIn.location, JSON.stringify({ loc: walkIn.location }));
    // …but only by someone who can see every centre. QA-125's reasoning: a scoped user would create a
    // person their own list can never show them.
    {
      const spocCookie = await loginAs("spoc.jpr03@vidysea.com", "CiOnly@123");
      const refused = await fetch(BASE + "/api/candidates", { method: "POST", headers: { "Content-Type": "application/json", cookie: spocCookie }, body: JSON.stringify({ name: `Scoped WalkIn ${stamp}`, phone: `81${stamp}45`.slice(0, 10), program: prog._id }) });
      ok("-124 (M4-04): a SCOPED user still has to name their own centre (400, not a hidden row)", refused.status === 400, String(refused.status));
    }
    // enrolment is the event that decides the centre — the same shape as the programme inheritance
    // that has always sat one line below it
    const addRes = await req("POST", `/api/batches/${batch._id}/members`, { candidate: walkIn._id }, 201);
    const after = (await req("GET", `/api/candidates/${walkIn._id}`)).data.item;
    ok("-124 (M4-04): enrolling a walk-in ADOPTS the batch's centre", String(after.location?._id ?? after.location) === String(loc._id), JSON.stringify({ got: after.location?._id ?? after.location, want: String(loc._id) }));
    ok("-124 (M4-04): …and the adoption is audited, because it changes who can see the record",
      ((await req("GET", `/api/audit/Candidate/${walkIn._id}`)).data.items ?? []).some((a2) => /walk-in|enrolment/i.test(String(a2.new_value ?? ""))),
      "no audit row naming the adoption");
    // and a candidate who DOES belong elsewhere is still refused — that rule is Manish's own
    const otherLoc = (await req("POST", "/api/locations", { code: "OC" + stamp, name: `Other Centre ${stamp}`, approval_status: "Approved", operational_status: "Active", city: "Kota" }, 201)).data.item;
    const other = (await req("POST", "/api/candidates", { name: `Other Centre Cand ${stamp}`, phone: `81${stamp}46`.slice(0, 10), location: otherLoc._id, program: prog._id }, 201)).data.item;
    const blocked = await req("POST", `/api/batches/${batch._id}/members`, { candidate: other._id });
    ok("-124 (M4-04): a candidate who belongs to ANOTHER centre is still refused (409) — only 'unplaced' is new",
      blocked.status === 409 && /another centre/i.test(String(blocked.data?.error ?? "")), `${blocked.status} ${String(blocked.data?.error ?? "").slice(0, 70)}`);
  }

  // ---- -120 (M4-14): the chain's DATA — dates on the closure, mock test + roll number per candidate ----
  // Manish typed this list on screen. Everything in it is a date or a list; only the mock-test STATUS
  // wording is still owed, so no status enum exists to pin. What IS pinned is the thing that goes
  // wrong silently: a field the route does not accept looks saved and is gone on the next read (the
  // -116 lesson, where the portal fields dropped on edit). And that none of it became a new GATE.
  {
    const dates = { mock_test_date: today, result_expected_date: today, certificate_distribution_date: today, sidh_uploaded_on: today };
    await req("PUT", `/api/batches/${d3._id}/closure`, dates, 200);
    const cl = (await req("GET", `/api/batches/${d3._id}/closure`)).data.closure;
    const missing = Object.keys(dates).filter((k) => !cl?.[k]);
    ok("-120 (M4-14): every date his chain names is stored on the closure and reads back", missing.length === 0, `missing: ${missing.join(", ")}`);
    // the whole point of "optional and independent": a batch that never ran a mock test is unaffected
    const clean = (await req("GET", `/api/batches/${d1._id}/closure`)).data.closure;
    ok("-120 (M4-14): …and a batch that never ran a mock test is untouched by them",
      !clean?.mock_test_date && !clean?.result_expected_date, JSON.stringify({ m: clean?.mock_test_date, r: clean?.result_expected_date }));

    const m3 = (await req("GET", `/api/batches/${d3._id}/members`)).data.items ?? [];
    const mem = m3[0];
    await req("PUT", `/api/batches/${d3._id}/results`, { rows: [{ member: String(mem._id), mock_appeared: true, mock_qualified: false, mock_note: "-120 pin: appeared, did not clear the practical", roll_no: `RN${stamp}` }] }, 200);
    const row = (await req("GET", `/api/batches/${d3._id}/results`)).data.items.find((i) => String(i.member) === String(mem._id))?.result;
    ok("-120 (M4-14): appeared and qualified are two separate facts, not one flag",
      row?.mock_appeared === true && row?.mock_qualified === false, JSON.stringify({ a: row?.mock_appeared, q: row?.mock_qualified }));
    ok("-120 (M4-14): …the reason someone did not qualify is kept (M4-17 applied to the mock test)",
      /did not clear/.test(String(row?.mock_note ?? "")), String(row?.mock_note));
    ok("-120 (M4-14): the roll number is stored per candidate, beside the certificate number",
      row?.roll_no === `RN${stamp}`, String(row?.roll_no));
    // and none of it gates the ordinary flow
    ok("-120 (M4-14): a mock-test record does not block or change the real assessment",
      (await req("PUT", `/api/batches/${d3._id}/results`, { rows: [{ member: String(mem._id), result: "Pass", score: 71, assessed_on: today }] }, 200)).status === 200);
    const row2 = (await req("GET", `/api/batches/${d3._id}/results`)).data.items.find((i) => String(i.member) === String(mem._id))?.result;
    ok("-120 (M4-14): …and marking the real result does not wipe the mock-test facts",
      row2?.result === "Pass" && row2?.mock_appeared === true && row2?.roll_no === `RN${stamp}`,
      JSON.stringify({ r: row2?.result, a: row2?.mock_appeared, rn: row2?.roll_no }));
  }

  // ---- -119 (M4-16): a trainer added from inside the ERP gets the welcome mail ----
  // The candidate twin shipped in -109 after Umesh found that NINE mail paths existed and none of
  // them was the one an admin actually uses. Manish asked for the same on Add Trainer. The pin is the
  // MailLog row, because that is the only thing that answers "did it go?" months later — and the
  // no-email case must be recorded honestly rather than silently skipped.
  {
    const before = (await req("GET", "/api/test-email")).data.log ?? [];
    const t119 = (await req("POST", "/api/trainers", { name: `M416 Mailed ${stamp}`, phone: `82${stamp}11`.slice(0, 10), email: `m416.${stamp}@example.invalid`, skills: [prog.trainer_skill], home_location: loc._id }, 201)).data.item;
    const t119b = (await req("POST", "/api/trainers", { name: `M416 NoMail ${stamp}`, phone: `82${stamp}22`.slice(0, 10), skills: [prog.trainer_skill], home_location: loc._id }, 201)).data.item;
    await new Promise((r) => setTimeout(r, 800)); // fire-and-forget: creating a trainer never waits on mail
    const after = (await req("GET", "/api/test-email")).data.log ?? [];
    const mine = after.filter((m) => !before.some((b2) => String(b2._id) === String(m._id)));
    const forT = mine.find((m) => String(m.entity_id) === String(t119._id));
    ok("-119 (M4-16): adding a trainer with an email logs the welcome mail against that trainer",
      !!forT && /added as a trainer/i.test(String(forT.subject ?? "")), JSON.stringify({ found: !!forT, subj: forT?.subject }));
    ok("-119 (M4-16): …and it is not claimed as sent when the environment cannot send (honest status)",
      !!forT && ["sent", "skipped", "failed"].includes(String(forT.status)), String(forT?.status));
    // -121 (QA-260, checker): the pin above passed for the WRONG reason. It accepted "no row at all"
    // as success, so it could never catch the actual defect — the trainer path returned early and
    // logged nothing while the release note claimed a skip was recorded. A row MUST exist now, and it
    // must say why. The checker also warned that /api/test-email caps the log at 20 rows, so a
    // count-based check can never move; this reads the rows.
    const forB = mine.find((m) => String(m.entity_id) === String(t119b._id));
    ok("-121 (QA-260): a trainer with NO email still gets a MailLog row — 'did it go?' is answerable for every trainer",
      !!forB, JSON.stringify({ logged: !!forB, rows: mine.length }));
    ok("-121 (QA-260): …and that row says skipped, naming the missing address rather than claiming a send",
      forB?.status === "skipped" && /recipient address/i.test(String(forB?.reason ?? forB?.error ?? "")),
      JSON.stringify({ status: forB?.status, reason: forB?.reason ?? forB?.error }));
  }

  // ---- -116 (QA-244, checker): a malformed id is a bad REQUEST, not a server fault ----
  // The locations grid flattens centre × job role and keys each row "<locationId>:<index>". -115 put
  // that composite key straight into a link, so the page 500'd with "Something went wrong on our
  // side." Nothing had gone wrong on our side. The link now uses the real id, and the route no longer
  // dresses an unparseable id as a server fault — checked on three entities, because the guard lives
  // in crud.ts and every detail route inherits it.
  {
    const composite = `${loc._id}:0`;
    ok("-116 (QA-244): a composite grid key is a 404 with a plain message, never a 500",
      (await req("GET", `/api/locations/${composite}`)).status === 404);
    const r244 = await req("GET", `/api/locations/${composite}`);
    ok("-116 (QA-244): …and it says WHY, naming the id rather than blaming the server",
      /not a valid id/i.test(String(r244.data?.error ?? "")) && !/our side/i.test(String(r244.data?.error ?? ""))
      && !String(r244.data?.error ?? "").includes(String(loc._id)), String(r244.data?.error ?? "").slice(0, 90));
    ok("-116 (QA-244): the same guard covers other entities (batches, candidates)",
      (await req("GET", `/api/batches/${batch._id}:0`)).status === 404 && (await req("GET", "/api/candidates/not-an-id")).status === 404);
    ok("-116 (QA-244): a VALID id still resolves — the guard did not become a wall",
      (await req("GET", `/api/locations/${loc._id}`)).status === 200);
  }

  // ---- -116: the government-portal fields (SS-01) survive a round trip ----
  // Shivshakti filled our form beside the Skill India application to show what we did not ask for.
  // Eleven optional fields; the pin is that they STORE and COME BACK, because a field that silently
  // drops on save is worse than one that was never offered.
  {
    // -126 (S18-03): address_type and differently_abled were REMOVED from this list on purpose —
    // Shivshakti asked for them out, and they were never in his spoken eight. Their absence is now
    // pinned separately, in the -126 block, because "removed" has to mean the door rejects them.
    const sidh = { salutation: "Mr.", father_name: "Indal Singh", mother_name: "Rani Devi", marital_status: "Single",
      religion: "Hindu", social_category: "OBC", state: "Uttar Pradesh", district: "Sant Ravidas Nagar",
      sub_district: "Aurai" };
    const c116 = (await req("POST", "/api/candidates", { name: `SIDH Fields ${stamp}`, phone: `83${stamp}11`.slice(0, 10), location: loc._id, program: prog._id, ...sidh }, 201)).data.item;
    const back = (await req("GET", `/api/candidates/${c116._id}`)).data.item;
    const missing = Object.entries(sidh).filter(([k, v]) => back[k] !== v).map(([k]) => k);
    ok("-116 (SS-01): every government-portal field the sheet names stores and reads back", missing.length === 0, `missing/wrong: ${missing.join(", ")}`);
    // …and they are editable afterwards, which is how a centre fills them in later.
    await req("PATCH", `/api/candidates/${c116._id}`, { district: "Bhadohi", religion: "Muslim" }, 200);
    const back2 = (await req("GET", `/api/candidates/${c116._id}`)).data.item;
    ok("-116 (SS-01): …and they can be corrected later", back2.district === "Bhadohi" && back2.religion === "Muslim", JSON.stringify({ d: back2.district, r: back2.religion }));
  }

  // ---- -224 (Umesh 24/08, LIVE on BHA-ITI-RPLHSL-SPIT-01): the trap between the two modes ----
  // Measured on production before this was written: batch Active, Closure.assessment_status
  // "Completed" from a hand-typed batch-level entry (appeared 23, passed 23), ZERO CandidateResult
  // rows, roster 46. In that state rules.ts refuses EVERY per-candidate mark - correctly, because
  // the roster would otherwise silently overwrite figures a human signed. But the remedy its message
  // names ("reopen the assessment") existed in no screen, and the refusal itself painted in the
  // page-top banner far above a viewport scrolled through 46 cards. So Pass/Fail read as dead, and
  // with nothing able to reach Pass, certificate upload was dead behind it. One fault, three
  // symptoms. This pins the SERVER contract the fix depends on, in the order it has to hold.
  {
    const { b: t1, mems: tm } = await mkBatch(2, 8);   // tag 8 — 1,2,3,4,9,10,11,12,13 are taken; a reused tag collides on the trainer phone
    // the legacy door: a batch-level sign-off, exactly as the live batch carries one
    await req("PUT", `/api/batches/${t1._id}/closure`, { assessment_status: "Completed", appeared: 2, passed: 2, assessment_date: today }, 200);
    ok("-223: precondition — a batch-level sign-off stands and NO per-candidate row exists",
      (await closureOf(t1._id))?.assessment_status === "Completed" && (await rowsOf(t1._id)).every((i) => !i.result),
      JSON.stringify({ a: (await closureOf(t1._id))?.assessment_status, rows: (await rowsOf(t1._id)).filter((i) => i.result).length }));

    // 1. the trap itself — every mark is refused, and this is the state the live batch was stuck in
    const trapped = await req("PUT", `/api/batches/${t1._id}/results`, { rows: [{ member: String(tm[0]._id), result: "Pass", assessed_on: today }] });
    ok("-223: marking a candidate is REFUSED while a batch-level sign-off stands (the live trap)",
      trapped.status >= 400 && /reopen the assessment/i.test(String(trapped.data?.error ?? "")),
      `${trapped.status} ${String(trapped.data?.error ?? "").slice(0, 110)}`);
    ok("-223: …and the refusal wrote NOTHING — no half-marked row left behind",
      (await rowsOf(t1._id)).every((i) => !i.result), JSON.stringify((await rowsOf(t1._id)).map((i) => i.result?.result)));

    // 2. the door the refusal asks for. THIS is what no screen offered; the server always allowed it.
    const reopened = await req("PUT", `/api/batches/${t1._id}/closure`, { assessment_status: "Pending" });
    ok("-223: reopening the assessment is accepted by the server (the door the message names)",
      reopened.status === 200 && (await closureOf(t1._id))?.assessment_status === "Pending",
      `${reopened.status} ${String((await closureOf(t1._id))?.assessment_status)}`);

    // 3. and only now does the thing Umesh pressed actually work
    const freed = await req("PUT", `/api/batches/${t1._id}/results`, { rows: [{ member: String(tm[0]._id), result: "Pass", score: 70, max_score: 100, assessed_on: today }] });
    ok("-223: after the reopen the SAME press is accepted — the trap is escapable",
      freed.status === 200 && (await rowsOf(t1._id)).find((i) => String(i.member) === String(tm[0]._id))?.result?.result === "Pass",
      `${freed.status} ${String((await rowsOf(t1._id)).find((i) => String(i.member) === String(tm[0]._id))?.result?.result)}`);

    // 4. the partial-bulk shape the client was throwing away. bulkMarkResults collects per-row
    //    failures and the route throws ONLY when every row failed - so a mixed batch returns 200
    //    with a NON-EMPTY errors[], and "Mark N pending as Pass" could mark some, refuse the rest,
    //    and report a clean success. The contract has to carry both halves for the UI to show them.
    const mixed = await req("PUT", `/api/batches/${t1._id}/results`, { rows: [
      { member: String(tm[1]._id), result: "Pass", score: 60, assessed_on: today },
      { member: "0".repeat(24), result: "Pass", assessed_on: today },
    ] });
    ok("-223: a PARTIAL bulk mark returns 200 carrying BOTH halves — updated AND errors[]",
      mixed.status === 200 && (mixed.data?.updated ?? 0) === 1 && Array.isArray(mixed.data?.errors) && mixed.data.errors.length === 1,
      JSON.stringify({ s: mixed.status, u: mixed.data?.updated, e: mixed.data?.errors?.length }));
    ok("-223: …and each refused row names WHICH member it was, so the card can be pointed at",
      !!mixed.data?.errors?.[0]?.member && !!mixed.data?.errors?.[0]?.error,
      JSON.stringify(mixed.data?.errors?.[0]));
  }
}

// ---- -102 (Manish 17/08): a roster row that should never have existed can be REMOVED ----
// Rule 25's drop is the honest record of a student who left. It is the wrong answer for a wrongly
// enrolled row, and until -102 a BatchMember could not be erased at all — which is why Manish's own
// empty Gurugram batch was carrying two of the maker's test candidates. The door is Admin-only,
// needs a reason, and refuses the moment the row has a footprint.
{
  const rmCand = (await req("POST", "/api/candidates", { name: `Remove Me ${stamp}`, phone: `86000${stamp.slice(0, 5)}`, location: loc._id, program: prog._id }, 201)).data.item;
  const rmMem = (await req("POST", `/api/batches/${batch._id}/members`, { candidate: rmCand._id }, 201)).data.item;
  ok("-102: removing a roster row without a reason is refused (400) — it is audited, not silent", (await req("DELETE", `/api/members/${rmMem._id}`)).status === 400);
  // Footprint guard: mark them present on the fixture day, and the door must refuse.
  const withRm = [...(await req("GET", `/api/batches/${batch._id}/logs`)).data.items.find((l) => l._id === log._id).present_member_ids.map(String), String(rmMem._id)];
  await req("PATCH", `/api/logs/${log._id}`, { present_member_ids: withRm }, 200);
  const blocked = await req("DELETE", `/api/members/${rmMem._id}`, { reason: "-102 pin: should be refused, they have attendance" });
  ok("-102: a roster row with attendance on record refuses removal (409) and says to drop instead",
    blocked.status === 409 && /attendance on 1 day/i.test(String(blocked.data?.error ?? "")) && /drop them instead/i.test(String(blocked.data?.error ?? "")),
    `${blocked.status} ${String(blocked.data?.error ?? "").slice(0, 120)}`);
  // Take the attendance back off, and it becomes removable.
  await req("PATCH", `/api/logs/${log._id}`, { present_member_ids: withRm.filter((x) => x !== String(rmMem._id)) }, 200);
  const enrCookie = await loginAs("enroll@vidysea.com", "CiOnly@123");
  const enrRm = await fetch(BASE + `/api/members/${rmMem._id}`, { method: "DELETE", headers: { "Content-Type": "application/json", cookie: enrCookie }, body: JSON.stringify({ reason: "not my call" }) });
  const anonRm = await fetch(BASE + `/api/members/${rmMem._id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "nope" }) });
  ok("-102: only an Admin may remove a roster row — Enrollment 403, anonymous 401", enrRm.status === 403 && anonRm.status === 401, `${enrRm.status} ${anonRm.status}`);
  const rosterBeforeRm = (await req("GET", `/api/batches/${batch._id}/members`)).data.items.length;
  const dayRosterBefore = (await req("GET", `/api/batches/${batch._id}/logs`)).data.items.find((l) => l._id === log._id).roster_count;
  const gone = await req("DELETE", `/api/members/${rmMem._id}`, { reason: "-102 pin: enrolled by mistake" });
  const rosterAfterRm = (await req("GET", `/api/batches/${batch._id}/members`)).data.items;
  ok("-102: a footprint-free roster row is removed (200) and is gone from the roster",
    gone.status === 200 && rosterAfterRm.length === rosterBeforeRm - 1 && !rosterAfterRm.some((m) => String(m._id) === String(rmMem._id)),
    `${gone.status} ${rosterBeforeRm}→${rosterAfterRm.length}`);
  const rmAud = ((await req("GET", `/api/audit/BatchMember/${rmMem._id}`)).data.items ?? []).find((a) => a.field === "removed");
  ok("-102: the removal is audited with who it was, which batch, and the reason",
    !!rmAud && /Remove Me/.test(String(rmAud.old_value ?? "")) && /enrolled by mistake/.test(String(rmAud.new_value ?? "")),
    JSON.stringify(rmAud && { o: rmAud.old_value, n: rmAud.new_value }).slice(0, 180));
  ok("-102: removing it again is an honest 404, not a fake success", (await req("DELETE", `/api/members/${rmMem._id}`, { reason: "again" })).status === 404);
  // Rule 21 stamped them "Assigned" on enrolment; with no roster row left they are Unassigned
  // again, or the planner's available pool (which counts exactly that) loses them for good.
  const rmCandAfter = (await req("GET", `/api/candidates/${rmCand._id}`)).data.item;
  ok("-102: with their last roster row gone the candidate is Unassigned again, and it is audited",
    rmCandAfter?.lifecycle_status === "Unassigned"
    && ((await req("GET", `/api/audit/Candidate/${rmCand._id}`)).data.items ?? []).some((a) => a.field === "lifecycle_status" && a.new_value === "Unassigned"),
    String(rmCandAfter?.lifecycle_status));
  // …and with no batch history left, the candidate record itself is deletable — the pair that
  // actually clears a test row off a real batch (candidates/[id] refuses while any member row exists).
  // The day's frozen roster_count (Rule 28) is deliberately NOT rewritten by a removal.
  const dayAfter = (await req("GET", `/api/batches/${batch._id}/logs`)).data.items.find((l) => l._id === log._id);
  ok("-102: the day's frozen roster_count is untouched by the removal (Rule 28)", dayAfter.roster_count === dayRosterBefore, `${dayRosterBefore}→${dayAfter.roster_count}`);
  await req("DELETE", `/api/candidates/${rmCand._id}`, undefined, 200);
}

// ---- -102: Home answers "where do I log today's attendance?" ----
// Manish 17/08 [07:09]: four clicks to reach Daily Execution. Rule 33's missing-log queue cannot
// serve this — it reports the PREVIOUS operating day, so a batch that needs logging TODAY is absent.
{
  const home = (await req("GET", "/api/home")).data;
  const mine = (home.queues?.today_logging ?? []).find((b) => String(b._id) === String(batch._id));
  ok("-102: Home carries today's logging list, with this batch on it and its roster size",
    !!mine && mine.code === batch.code && mine.roster_count >= 1, JSON.stringify(mine));
  ok("-102: …and it knows today's log is already in (the fixture logged today)", mine?.logged_today === true, String(mine?.logged_today));
  const trCookie = await loginAs("trainer.jpr03@vidysea.com", "CiOnly@123");
  const trHome = trCookie ? await fetch(BASE + "/api/home", { headers: { cookie: trCookie } }).then((r) => r.json()).catch(() => null) : null;
  if (trHome) {
    ok("-102: a Trainer gets the today-logging list too (it is their own batch — QA-096 holds)",
      Array.isArray(trHome.queues?.today_logging), JSON.stringify(Object.keys(trHome.queues ?? {})));
    ok("-102: …and still none of the org-wide queues QA-096 trimmed", trHome.queues?.invoices_pending === undefined && trHome.queues?.sheet_changes === undefined);
  }
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
// -102 (Manish 17/08 [13:04] "batch ka status ho gaya result awaited"): the UI now WORDS this
// stage as "Result Awaited", but the change is a label only — the stored enum, and therefore every
// rule, filter, deep link and audit row, still says "Closing". Pinned so a future "tidy-up" that
// renames the enum has to fail here rather than silently break saved links and history.
ok("-102: 'Result Awaited' is a label — the API still stores and returns the enum 'Closing'",
  (await req("GET", `/api/batches/${batch._id}`)).data.item?.status === "Closing",
  String((await req("GET", `/api/batches/${batch._id}`)).data.item?.status));
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

// ---- R-E (CEO 14/08 [25:20-25:44]): Operations is POST-ONLY on money ----
{
  await req("PUT", "/api/approvals", { action: "cost.post", enabled: true, approver_role: "Admin" }, 200);
  const opsCookie = await loginAs("ops@vidysea.com", "CiOnly@123");
  if (opsCookie) {
    const saved = cookie; cookie = opsCookie;
    ok("R-E: the cost ledger is closed to Operations", (await req("GET", "/api/costs")).status === 403);
    const post = await req("POST", "/api/costs", { category: cats[0]._id, amount: 777, trainer: trainer._id, note: "R-E queue test " + stamp });
    ok("R-E: an Operations entry PARKS for approval — 202, no ledger write", post.status === 202 && post.data.queued === true, `got ${post.status}`);
    const reqId = post.data.item?._id;
    const mineList = await req("GET", "/api/approvals?mine=1");
    ok("R-E: the initiator sees their own submission without approver rights",
      mineList.status === 200 && (mineList.data.items ?? []).some((i) => String(i._id) === String(reqId)));
    cookie = saved;
    const parkedLedger = (await req("GET", "/api/costs")).data.items.filter((c) => c.note === "R-E queue test " + stamp).length;
    ok("R-E: nothing reaches the ledger while parked", parkedLedger === 0, String(parkedLedger));
    const dec = await req("POST", `/api/approvals/${reqId}`, { decision: "Approved" }, 200);
    ok("R-E: approval IS the write (applied: true)", dec.data.applied === true, JSON.stringify(dec.data).slice(0, 120));
    const landed = (await req("GET", "/api/costs")).data.items.filter((c) => c.note === "R-E queue test " + stamp);
    ok("R-E: the approved entry lands exactly once, owned by the initiator",
      landed.length === 1 && !!landed[0].entered_by, JSON.stringify({ n: landed.length, by: landed[0]?.entered_by?.name }));
    const direct = await req("POST", "/api/costs", { category: cats[0]._id, amount: 5, trainer: trainer._id, note: "R-E direct " + stamp }, 201);
    ok("R-E: the Admin-approver's own post writes directly (201)", direct.status === 201);
    await req("PUT", "/api/approvals", { action: "cost.post", enabled: false }, 200);
  } else {
    ok("R-E skipped — ops login unavailable (run seed:sample)", true);
  }
}

// ---- drop rules ----
const batch2 = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: today, target_size: 3 }, 201)).data.item;
const cand4 = (await req("POST", "/api/candidates", { name: "Cand4 " + stamp, phone: "77777" + stamp.slice(0, 5), location: loc._id, program: prog._id }, 201)).data.item;
const mem4 = (await req("POST", `/api/batches/${batch2._id}/members`, { candidate: cand4._id }, 201)).data.item;
// Complete the enrollment first — the CEO's Dropout is "enrolled but did not complete the
// training", so the fixture must actually enroll before leaving (also stamps enrolled_at).
await req("PATCH", `/api/members/${mem4._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
// -250: mint the student's attendance link BEFORE the drop, so the pin below can read the SAME
// token afterwards. This is the whole point - minting already filters { batch, left_on: null }, so
// a link minted AFTER a drop was never the bug. The bug is the link the student already has.
const attTok = (await req("POST", "/api/public-tokens", { purpose: "attendance", batch: batch2._id }, 201))
  .data.items.find((t) => String(t.batch_member?._id ?? t.batch_member) === String(mem4._id));
ok("-250: an attendance link exists for the member before they leave", !!attTok?.token, JSON.stringify(attTok ?? null).slice(0, 120));
{
  const live = await req("GET", `/api/public/attendance/${attTok.token}`, undefined, 200);
  ok("-250 control: while they are ON the batch the link serves a live verdict",
    typeof live.data?.eligible === "boolean" && typeof live.data?.required_hours === "number",
    JSON.stringify(live.data ?? {}).slice(0, 200));
}
await req("POST", `/api/members/${mem4._id}/drop`, { left_on: today }, 400); // Rule 25: reason required
await req("POST", `/api/members/${mem4._id}/drop`, { left_on: "2030-01-01", drop_reason: "Other" }, 400); // future date
await req("POST", `/api/members/${mem4._id}/drop`, { left_on: today, drop_reason: "Other" }, 200);

// ---- -250 (Umesh, 25/08): the link a departed student is still holding ----
// "aur jagah se remove ho jaaye uske traces." dropMemberChecked does not touch PublicToken and the
// token lookup never asked about left_on, so every attendance link handed out before a drop went on
// serving that student a LIVE eligibility verdict for a course they had left.
//
// The token is deliberately NOT killed. Switching it off 404s, and the page renders a 404 as "this
// link is not valid or has expired" - and a dead link explains nothing to whoever is holding it,
// which is REQ-393's own lesson. So 200-not-404 is asserted EXPLICITLY: it is the half of this fix
// that a careless later change would quietly undo.
//
// The FIELDS are asserted, not the status. `status !== 200` would be satisfied by a 500.
{
  const after = await req("GET", `/api/public/attendance/${attTok.token}`, undefined, 200);
  const d = after.data ?? {};
  ok("-250: the departed student's link still answers, it is not dead", after.status === 200, `got ${after.status}`);
  ok("-250: and it tells them the date they left", !!d.left_on, JSON.stringify(d).slice(0, 200));
  ok("-250: their own name and batch are still there, so the page is visibly theirs",
    !!d.candidate && !!d.batch, JSON.stringify(d).slice(0, 200));
  const leaked = ["eligible", "required_hours", "attended_hours", "days_held", "govt", "days", "result"]
    .filter((k) => d[k] !== undefined);
  ok("-250: no attendance, hours, eligibility or exam data is served to them any more",
    leaked.length === 0, "still present: " + JSON.stringify(leaked));
}

const cand4b = (await req("GET", `/api/candidates/${cand4._id}`)).data.item;
ok("Rule 21: dropped candidate lifecycle", cand4b.lifecycle_status === "Dropped", cand4b.lifecycle_status);
// CEO 14/08 [28:12] "the word is drop out": a Dropped candidate who HAD enrolled keeps the
// enrolled_at stamp — the UI files them under the Enrolled journey as "Dropout", not Fresh.
ok("R-A: a training dropout keeps enrolled_at (Dropout, not a fresh inquiry)", !!cand4b.enrolled_at, String(cand4b.enrolled_at));
ok("R-J: per-position numbering keeps the centre × course prefix",
  new RegExp(`^LOC${stamp}-PROG${stamp}-\\d{2}$`).test(batch2.code), batch2.code);

// ---- R-J (QA-049, CEO: "enrolled = fees paid") — Rule 54, toggle-gated ----
{
  const cand5 = (await req("POST", "/api/candidates", { name: "Cand5 Fee " + stamp, phone: "76666" + stamp.slice(0, 5), location: loc._id, program: prog._id }, 201)).data.item;
  const mem5 = (await req("POST", `/api/batches/${batch2._id}/members`, { candidate: cand5._id }, 201)).data.item;
  // QA-032/021/069: the MIDDLE of the journey is written — assignment stamps Assigned
  // (the pre-wipe 75-Enrolled-never-Assigned rows were seed artifacts, not a code path).
  ok("QA-032: assignment stamps the middle of the journey (Assigned)",
    (await req("GET", `/api/candidates/${cand5._id}`)).data.item.lifecycle_status === "Assigned");
  await req("PUT", "/api/defaults", { fee_required_for_enrollment: true }, 200);
  const blocked = await req("PATCH", `/api/members/${mem5._id}`, { reg_done: true, kyc_done: true, accept_done: true });
  ok("Rule 54: toggle ON — enrollment refuses without a fee on record",
    blocked.status === 409 && /no fee payment on record/.test(blocked.data?.error ?? ""), `got ${blocked.status} ${blocked.data?.error ?? ""}`);
  await req("PATCH", `/api/candidates/${cand5._id}`, { fee_amount: 500, fee_paid_on: today, fee_reference: "UPI-" + stamp }, 200);
  const okNow = await req("PATCH", `/api/members/${mem5._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
  ok("Rule 54: fee recorded → enrollment completes", okNow.data.item.enrollment_status === "Completed", okNow.data.item.enrollment_status);
  const cand5b = (await req("GET", `/api/candidates/${cand5._id}`)).data.item;
  ok("R-J: the fee travels on the candidate", cand5b.fee_amount === 500 && !!cand5b.fee_paid_on && cand5b.fee_reference === "UPI-" + stamp,
    JSON.stringify({ a: cand5b.fee_amount, r: cand5b.fee_reference }));
  await req("PUT", "/api/defaults", { fee_required_for_enrollment: false }, 200); // default OFF for the rest of the wall
}
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
await req("POST", "/api/trainers", { name: "Halted Nominee " + stamp, phone: "5800" + stamp, nominated_for_location: gateLoc._id, nominated_for_program: prog._id }, 409);
const reNom = (await req("POST", "/api/trainers", { name: "Re-nominee " + stamp, phone: "5900" + stamp }, 201)).data.item;
await req("PATCH", `/api/trainers/${reNom._id}`, { nominated_for_location: gateLoc._id }, 409); // re-pointing is hiring too
await req("PATCH", `/api/locations/${gateLoc._id}`, { operational_status: "Active", status_reason: "resumed" }, 200);
await req("POST", "/api/trainer-requests", { location: gateLoc._id, program: prog._id, required_by_date: today }, 201); // resumes with the centre
await req("PATCH", `/api/locations/${gateLoc._id}`, { operational_status: "Stopped", status_reason: "test again" }, 200); // restore for Rule 1 asserts below

// ---- F-A3 → QA-150/QA-152 (-81): the TOT lead time is a PLAN verdict, not a Mark-Ready gate ----
// Manish (14/08) asked for "TOT ≥ 3 days before start" as a hard gate; Umesh (15/08), on a batch
// entered after it began, ruled such warnings live only inside the batch's plan. The verdict is
// still computed (readiness.plan_flags) but the four operational checks alone gate Ready.
const totTr = (await req("POST", "/api/trainers", { name: "TOT Lead " + stamp, phone: "5600" + stamp, skills: ["totlead" + stamp], pipeline_status: "TOT In Progress" }, 201)).data.item;
const totCert = await req("POST", `/api/trainers/${totTr._id}/transition`, { target: "Certified", payload: { tr_id: "TRL" + stamp } }, 200);
ok("F-A3 fixture: certification stamps tot_done_on", !!totCert.data.item.tot_done_on, JSON.stringify(totCert.data.item.tot_done_on));
const totBatch = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: totTr._id, room: room._id, planned_start: today, target_size: 1 }, 201)).data.item;
const totCand = (await req("POST", "/api/candidates", { name: "TOT Cand " + stamp, phone: "5500" + stamp, location: loc._id, program: prog._id }, 201)).data.item;
const totMem = (await req("POST", `/api/batches/${totBatch._id}/members`, { candidate: totCand._id }, 201)).data.item;
await req("PATCH", `/api/members/${totMem._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
const totRead = (await req("GET", `/api/batches/${totBatch._id}`)).data.readiness;
ok("QA-150: readiness.checks is exactly the four operational checks (what the checklist renders)",
  JSON.stringify(Object.keys(totRead.checks)) === JSON.stringify(["location_approved", "room_assigned", "trainer_ready", "roster_80pct"]), JSON.stringify(Object.keys(totRead.checks)));
ok("QA-152: TOT lead verdict still computed, as a plan flag (TOT today + start today → false)", totRead.plan_flags?.tot_lead_ok === false && !!totRead.plan_flags?.tot_due, JSON.stringify(totRead.plan_flags));
const totHealth = (await req("GET", `/api/batches/${totBatch._id}`)).data.health;
ok("QA-150: the health banner no longer says 'TOT not done' for a batch that is otherwise ready", !(totHealth?.reasons ?? []).some((r) => /TOT/.test(r.label)), JSON.stringify(totHealth?.reasons));
await req("POST", `/api/batches/${totBatch._id}/transition`, { target: "Ready" }, 200); // TOT lead does not gate Ready any more
await req("POST", `/api/batches/${totBatch._id}/transition`, { target: "Planning" }, 200);
// bypass with an explicit TOT date (the trainer page's -81 prompt) is honoured
const totBypass = await req("POST", `/api/trainers/${totTr._id}/transition`, { target: "TOT In Progress", bypass: true }, 200);
ok("bypass fixture: back to TOT In Progress", totBypass.data.item.pipeline_status === "TOT In Progress");
const totBack = await req("POST", `/api/trainers/${totTr._id}/transition`, { target: "Certified", bypass: true, date: "2026-01-05", payload: { tr_id: "TRL" + stamp } }, 200);
ok("-81: bypass Certified with a date stamps tot_done_on = that date (paperwork after the fact)", String(totBack.data.item.tot_done_on).startsWith("2026-01-05"), JSON.stringify(totBack.data.item.tot_done_on));
// Cancel the fixture so its future dates don't hold the shared room against later batches (Rule 13).
await req("POST", `/api/batches/${totBatch._id}/transition`, { target: "Cancelled", reason: "F-A3 fixture done" }, 200);

// ---- Rule 48: enrolled count capped at batch capacity ----
const capBatch = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: today, target_size: 1 }, 201)).data.item;
const capCands = [];
for (let i = 0; i < 2; i++) {
  capCands.push((await req("POST", "/api/candidates", { name: `Cap ${i} ${stamp}`, phone: `770${stamp}${i}`, location: loc._id, program: prog._id }, 201)).data.item);
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
  b4Cands.push((await req("POST", "/api/candidates", { name: `R${i} ${stamp}`, phone: `660${stamp}${i}`, location: loc._id, program: prog._id }, 201)).data.item);
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
// -108: the route is preview → confirm now. `certPreview` stages files and returns the proposed
// mapping (nothing attached); `certConfirm` attaches the pairs given. `certUpload` keeps the old
// call shape for the existing pins by doing both with the server's own proposal — which is exactly
// the "auto-match and commit" behaviour those pins were written against.
async function certPreview(batchId, files, expect) {
  const fd = new FormData();
  for (const [name, bytes] of files) fd.append("files", new File([bytes], name, { type: "application/pdf" }));
  const res = await fetch(`${BASE}/api/batches/${batchId}/certificates`, { method: "POST", headers: { cookie }, body: fd });
  const data = await res.json().catch(() => ({}));
  if (expect !== undefined) ok(`POST certificates preview → ${expect}`, res.status === expect, `(got ${res.status}: ${JSON.stringify(data).slice(0, 140)})`);
  return data;
}
async function certConfirm(batchId, pairs, discard) {
  return (await req("POST", `/api/batches/${batchId}/certificates`, { confirm: true, pairs, discard: discard ?? [] })).data;
}
async function certUpload(batchId, files, expect) {
  const pre = await certPreview(batchId, files, expect);
  const pairs = (pre.staged ?? []).filter((s) => s.member).map((s) => ({ url: s.url, member: s.member }));
  const discard = (pre.staged ?? []).filter((s) => !s.member).map((s) => s.url);
  const done = pairs.length ? await certConfirm(batchId, pairs, discard) : { attached: [], refused: [], summary: { attached: 0 } };
  // Fold both halves into the shape the older pins read.
  const unmatched = [
    ...(pre.rejected ?? []).map((r) => ({ filename: r.filename, reason: r.reason })),
    ...(pre.staged ?? []).filter((s) => !s.member).map((s) => ({ filename: s.original_name, reason: s.reason })),
    ...(done.refused ?? []).map((r) => ({ filename: r.candidate ?? r.url, reason: r.reason })),
  ];
  return {
    preview: pre,
    matched: (done.attached ?? []).map((a) => ({ candidate: a.candidate, file: a.file, original: a.original, ...(a.created_result ? { created_result: true } : {}) })),
    unmatched,
    summary: { received: files.length, matched: (done.attached ?? []).length, unmatched: unmatched.length },
  };
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
  up1.unmatched?.some((u) => /needs a Pass/.test(u.reason)), JSON.stringify(up1.unmatched));
const afterUp = (await req("GET", `/api/batches/${b4._id}/results`)).data.items;
const upPassRow = afterUp.find((i) => i.result?.result === "Pass").result;
ok("cert bulk: certificate_file landed on the result row", /\/api\/files\//.test(upPassRow.certificate_file ?? ""), upPassRow.certificate_file);
{
  // -83 (QA-145 third door): certificates used to bypass the storage adapter (raw disk write, no
  // StoredFile row) — Drive ON would still have lost them on the next deploy. Same adapter now.
  const { MongoClient } = await import("mongodb");
  const mc = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
  await mc.connect();
  const certName = String(upPassRow.certificate_file).split("/").pop();
  const certRow = await mc.db(process.env.MONGODB_DB || "center_erp_ci").collection("storedfiles").findOne({ name: certName });
  await mc.close();
  ok("-83: a bulk-uploaded certificate leaves a StoredFile row (entity Batch, folder …/certificates)",
    !!certRow && certRow.entity === "Batch" && /certificates$/.test(certRow.folder_path ?? "") && certRow.backend === "local", JSON.stringify(certRow && { entity: certRow.entity, folder: certRow.folder_path, backend: certRow.backend }));
  const certRead = await fetch(BASE + String(upPassRow.certificate_file).replace(/^\/erp/, ""), { headers: { cookie } });
  ok("-83: …and it reads back through the proxy", certRead.status === 200 && certRead.headers.get("content-type") === "application/pdf", `${certRead.status}`);
}
// ---- -101 (Umesh 17/08, "CRUD ke saare operations chalne chahiye"): the D of the certificate.
// It could be uploaded and replaced but never REMOVED — a scan attached to the wrong candidate was
// permanent, and its stored object was unreclaimable (the discard door refuses a referenced file,
// correctly). Removing the FILE only: status, number and date are what the awarding body said. ----
{
  const { MongoClient } = await import("mongodb");
  const mc = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
  await mc.connect();
  const sf = mc.db(process.env.MONGODB_DB || "center_erp_ci").collection("storedfiles");
  const certUrl = String(upPassRow.certificate_file);
  const certName = certUrl.split("/").pop();
  const statusBefore = upPassRow.certificate_status;
  // the discard door must still refuse it — it is attached to a record
  const discard = await req("DELETE", `/api/files/${certName}`);
  ok("-101: an attached certificate is still refused by the file-discard door (409) — it leaves through the record", discard.status === 409, String(discard.status));
  ok("-101: removing a certificate file without a reason is refused (it is audited evidence)", (await req("DELETE", `/api/results/${upPassRow._id}/certificate`)).status === 400);
  const del = await req("DELETE", `/api/results/${upPassRow._id}/certificate`, { reason: "-101 pin: wrong candidate's scan" });
  const gone = await fetch(BASE + certUrl.replace(/^\/erp/, ""), { headers: { cookie } });
  const rowAfter = await sf.findOne({ name: certName });
  const resAfter = (await req("GET", `/api/batches/${b4._id}/results`)).data.items.find((i) => String(i.result?._id) === String(upPassRow._id)).result;
  ok("-101: the certificate file is removed — 200, the URL answers 410, and the StoredFile row stays as 'deleted' with who/when",
    del.status === 200 && gone.status === 410 && rowAfter?.status === "deleted" && !!rowAfter?.deleted_at && !!rowAfter?.deleted_by,
    JSON.stringify({ d: del.status, g: gone.status, s: rowAfter?.status }));
  ok("-101: the result row no longer points at a file…", !resAfter.certificate_file, String(resAfter.certificate_file));
  ok("-101: …but the certificate STATUS, number and date are untouched (Rule 46 owns those, not a file deletion)",
    resAfter.certificate_status === statusBefore && !!resAfter.certificate_no, JSON.stringify({ st: resAfter.certificate_status, was: statusBefore, no: resAfter.certificate_no }));
  const aud = await mc.db(process.env.MONGODB_DB || "center_erp_ci").collection("auditlogs").findOne({ field: "certificate_file_removed" }, { sort: { created_at: -1 } });
  ok("-101: the removal is audited with the old file and the reason", !!aud && /wrong candidate's scan/.test(String(aud.new_value ?? "")) && String(aud.old_value ?? "").includes(certName), JSON.stringify(aud && { o: String(aud.old_value).slice(-40), n: String(aud.new_value).slice(0, 80) }));
  ok("-101: removing again says there is no file (404), it does not pretend to succeed", (await req("DELETE", `/api/results/${upPassRow._id}/certificate`, { reason: "again" })).status === 404);
  await mc.close();
  // restore the fixture: the same CAN id re-uploaded, so the freeze test below is unchanged
  await certUpload(b4._id, [[`CAN_77${stamp.slice(-4)}1.pdf`, pdf]], 200);
  const restored = (await req("GET", `/api/batches/${b4._id}/results`)).data.items.find((i) => String(i.result?._id) === String(upPassRow._id)).result;
  ok("-101: a fresh certificate can be uploaded again after a removal (the slot is genuinely free)", /\/api\/files\//.test(restored.certificate_file ?? ""), restored.certificate_file);
  upPassRow.certificate_file = restored.certificate_file;
}

// same CAN id again while file exists + batch still Closing → upsert path allows overwrite
// pre-completion; the freeze is tested after Completed below.

// -155: certification now requires every enrolled student's portal Candidate ID (the government
// issues no certificate without one). The R-roster's CANs match the certificate filenames this
// flow already uploads, so the two stay one story.
for (const [i, c] of b4Cands.entries()) await req("PATCH", `/api/candidates/${c._id}`, { sidh_candidate_id: `CAN_77${stamp.slice(-4)}${i + 1}` }, 200);
await req("PUT", `/api/batches/${b4._id}/closure`, { certification_status: "Completed", certification_date: today }, 200);
await req("PUT", `/api/batches/${b4._id}/closure`, { ready_for_invoice: true }, 200);
ok("invoice linkage unchanged by per-candidate mode", (await req("GET", `/api/batches/${b4._id}/closure`)).data.invoice?.status === "Ready");
await req("POST", `/api/batches/${b4._id}/transition`, { target: "Completed" }, 200);

// -101: DEC-6 holds for the new door too — a Completed batch's certificate file is frozen.
{
  const frozen = await req("DELETE", `/api/results/${upPassRow._id}/certificate`, { reason: "-101 pin: should be refused" });
  ok("-101: a Completed batch refuses the certificate-file removal (409, DEC-6 — no admin override)", frozen.status === 409 && /closed|frozen/i.test(String(frozen.data?.error ?? "")), `${frozen.status} ${String(frozen.data?.error ?? "").slice(0, 90)}`);
  const still = (await req("GET", `/api/batches/${b4._id}/results`)).data.items.find((i) => String(i.result?._id) === String(upPassRow._id)).result;
  ok("-101: …and the file is still there after the refusal", /\/api\/files\//.test(still.certificate_file ?? ""), still.certificate_file);
}

// ---- -103: a candidate can be UN-MARKED — the last missing D on the results row ----
// Found by the -102 cleanup actually running on production: the new member-removal door refused
// the maker's two test rows because each carried a Pass result, and nothing could remove a
// CandidateResult — only PATCH it to another value. Two live consequences: a row created on the
// wrong candidate was permanent, and because `legacy` is decided by "zero CandidateResult rows",
// one accidental row flipped a batch to per-candidate marking forever and its closure figures then
// derive from that row. Narrow door, same shape as the -101 certificate one.
{
  // target_size 1 — Rule 16's roster_80pct check is against the TARGET, so a 2-seat batch with one
  // candidate never reaches Ready.
  const rb = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, room: room._id, planned_start: today, target_size: 1 }, 201)).data.item;
  const rc = (await req("POST", "/api/candidates", { name: `Unmark Me ${stamp}`, phone: `85000${stamp.slice(0, 5)}`, location: loc._id, program: prog._id }, 201)).data.item;
  const rm2 = (await req("POST", `/api/batches/${rb._id}/members`, { candidate: rc._id }, 201)).data.item;
  await req("PATCH", `/api/members/${rm2._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
  await req("POST", `/api/batches/${rb._id}/transition`, { target: "Ready" }, 200);
  await req("POST", `/api/batches/${rb._id}/transition`, { target: "Active" }, 200);
  ok("-103 fixture: a batch with no results at all reads as legacy (batch-level figures)",
    (await req("GET", `/api/batches/${rb._id}/results`)).data.legacy !== false, String((await req("GET", `/api/batches/${rb._id}/results`)).data.legacy));
  await req("PUT", `/api/batches/${rb._id}/results`, { rows: [{ member: String(rm2._id), result: "Pass", score: 71, max_score: 100, assessed_on: today }] }, 200);
  const rRow = (await req("GET", `/api/batches/${rb._id}/results`)).data.items.find((i) => String(i.result?.candidate?._id ?? i.result?.candidate) === String(rc._id)).result;
  ok("-103 fixture: ONE row flips the batch to per-candidate marking (this is why an accidental row mattered)",
    (await req("GET", `/api/batches/${rb._id}/results`)).data.legacy === false);
  // The member-removal door (-102) must refuse while that row exists — the guard that found this gap.
  const blockedByResult = await req("DELETE", `/api/members/${rm2._id}`, { reason: "-103 pin: should be refused, they carry a result" });
  ok("-102/-103: the member-removal door refuses a row that carries a result (409), naming it",
    blockedByResult.status === 409 && /assessment\/certification result/i.test(String(blockedByResult.data?.error ?? "")),
    `${blockedByResult.status} ${String(blockedByResult.data?.error ?? "").slice(0, 110)}`);
  ok("-103: un-marking without a reason is refused (400) — it destroys the assessment history", (await req("DELETE", `/api/results/${rRow._id}`)).status === 400);
  // A certificate FILE must leave first, or the object would be orphaned in the bucket.
  // Rule 46 owns this ladder: Pending → Processing → Generated (a number is required to generate).
  await req("PATCH", `/api/results/${rRow._id}`, { certificate_status: "Processing" }, 200);
  await req("PATCH", `/api/results/${rRow._id}`, { certificate_status: "Generated", certificate_no: "CERT-U" + stamp, certificate_date: today }, 200);
  const certPdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const fdU = new FormData();
  fdU.append("file", new File([certPdf], "unmark-cert.pdf", { type: "application/pdf" }));
  fdU.append("folder_centre", "_e2e"); fdU.append("folder_kind", "certificates");
  const upU = await fetch(`${BASE}/api/upload`, { method: "POST", headers: { cookie }, body: fdU }).then((r) => r.json()).catch(() => ({}));
  if (upU?.url) {
    await req("PATCH", `/api/results/${rRow._id}`, { certificate_file: upU.url }, 200);
    const withFile = await req("DELETE", `/api/results/${rRow._id}`, { reason: "-103 pin: should be refused while a file is attached" });
    ok("-103: un-marking is refused while a certificate FILE is attached (409) — remove the file first, never orphan the object",
      withFile.status === 409 && /certificate first/i.test(String(withFile.data?.error ?? "")), `${withFile.status} ${String(withFile.data?.error ?? "").slice(0, 110)}`);
    await req("DELETE", `/api/results/${rRow._id}/certificate`, { reason: "-103 pin: clearing the file so the row can be un-marked" }, 200);
  }
  // An ATTESTED closure blocks it — the figures have been reported.
  await req("PUT", `/api/batches/${rb._id}/closure`, { assessment_status: "Completed", assessment_date: today }, 200);
  const attested = await req("DELETE", `/api/results/${rRow._id}`, { reason: "-103 pin: should be refused, assessment signed off" });
  ok("-103: un-marking is refused once assessment/certification has been signed off (409) — reported figures are not rewritten",
    attested.status === 409 && /signed off/i.test(String(attested.data?.error ?? "")), `${attested.status} ${String(attested.data?.error ?? "").slice(0, 110)}`);
  await req("PUT", `/api/batches/${rb._id}/closure`, { assessment_status: "Pending" }, 200);
  // Happy path.
  const un = await req("DELETE", `/api/results/${rRow._id}`, { reason: "-103 pin: marked against the wrong candidate" });
  ok("-103: with nothing attested and no file, the row is un-marked (200) and the batch is told it has none left",
    un.status === 200 && un.data?.rows_left_on_batch === 0 && un.data?.batch_returns_to_legacy === true, JSON.stringify(un.data));
  ok("-103: the batch genuinely returns to batch-level figures — the flip is reversible now",
    (await req("GET", `/api/batches/${rb._id}/results`)).data.legacy !== false);
  const unAud = ((await req("GET", `/api/audit/CandidateResult/${rRow._id}`)).data.items ?? []).find((a) => a.field === "removed");
  ok("-103: the removal is audited with the WHOLE row (result, score, certificate state, attempt count) and the reason",
    !!unAud && /Pass/.test(JSON.stringify(unAud.old_value)) && /71/.test(JSON.stringify(unAud.old_value)) && /wrong candidate/.test(String(unAud.new_value)) && /batch-level figures/.test(String(unAud.new_value)),
    JSON.stringify(unAud && { o: unAud.old_value, n: unAud.new_value }).slice(0, 240));
  ok("-103: un-marking again is an honest 404", (await req("DELETE", `/api/results/${rRow._id}`, { reason: "again" })).status === 404);
  // …and now the -102 member door lets go, which is the whole reason this exists.
  const nowFree = await req("DELETE", `/api/members/${rm2._id}`, { reason: "-103 pin: enrolled by mistake, now un-marked" });
  ok("-102/-103: with the result gone the roster row can finally be removed — the pair that clears a test row off a real batch",
    nowFree.status === 200, `${nowFree.status} ${String(nowFree.data?.error ?? "").slice(0, 100)}`);
  await req("DELETE", `/api/candidates/${rc._id}`, undefined, 200);
  await req("POST", `/api/batches/${rb._id}/transition`, { target: "Cancelled", reason: "-103 fixture done" }, 200);
}

// Rule 47: lifecycle splits by result
const lcPass = (await req("GET", `/api/candidates/${b4Cands[0]._id}`)).data.item;
const lcFail = (await req("GET", `/api/candidates/${b4Cands[1]._id}`)).data.item;
const lcAbs = (await req("GET", `/api/candidates/${b4Cands[2]._id}`)).data.item;
ok("Rule 47: Pass → Completed, Fail/Absent → Failed",
  lcPass.lifecycle_status === "Completed" && lcFail.lifecycle_status === "Failed" && lcAbs.lifecycle_status === "Failed",
  `${lcPass.lifecycle_status}/${lcFail.lifecycle_status}/${lcAbs.lifecycle_status}`);

await req("PUT", `/api/batches/${b4._id}/results`, { rows: [{ member: b4Members[0]._id, result: "Pass" }] }, 400); // Rule 41: closed batch
const candHistory = (await req("GET", `/api/candidates/${b4Cands[0]._id}/results`, undefined, 200)).data;
ok("candidate result history available", candHistory.items?.length >= 1 && candHistory.items[0].batch?.code === b4.code, JSON.stringify(candHistory.items?.[0]?.batch));

// ---- Cert bulk upload vs DEC-6 on Completed batches ----
// Rewriting an existing certificate file after completion is refused by name.
const upFrozen = await certUpload(b4._id, [[`CAN_77${stamp.slice(-4)}1.pdf`, pdf]], 200);
ok("cert bulk: Completed + existing file → frozen (DEC-6)",
  upFrozen.summary?.matched === 0 && /frozen/.test(upFrozen.unmatched?.[0]?.reason ?? ""), JSON.stringify(upFrozen.unmatched));

// But FILLING an absent file on a Completed batch is the CEO's own flow (the Gurgaon
// case: batch long done, certificates arrive later as a folder) — allowed, once.
const b5 = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, room: room._id, planned_start: today, target_size: 2 }, 201)).data.item;
const c5a = (await req("POST", "/api/candidates", { name: `LateCert A ${stamp}`, phone: `677${stamp}7`, location: loc._id, program: prog._id, sidh_candidate_id: `CAN88${stamp.slice(-4)}` }, 201)).data.item;
// -155: a CAN at creation, because certification later in this flow now requires it.
const c5b = (await req("POST", "/api/candidates", { name: `LateCert B ${stamp}`, phone: `677${stamp}8`, location: loc._id, program: prog._id, sidh_candidate_id: `CAN89${stamp.slice(-4)}` }, 201)).data.item;
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
  upLate2.summary?.matched === 0 && /frozen/.test(upLate2.unmatched?.[0]?.reason ?? ""), JSON.stringify(upLate2.unmatched));

// ---- Late-ARRIVAL results (2026-08-14, Manish's Gurugram batch-1 certificates): a batch
// completed legacy-style — batch-level closure figures, ZERO per-candidate rows — and
// Rule 41 forbids marking after completion. The NSDC certificate arriving now IS the pass
// evidence: the upload creates the Pass row carrying it, and the recorded batch-level
// closure figures stay exactly as typed (Rule 42 / S0 clobber guard).
const b6 = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, room: room._id, planned_start: today, target_size: 2 }, 201)).data.item;
const c6a = (await req("POST", "/api/candidates", { name: `LateRes A ${stamp}`, phone: `688${stamp}1`, location: loc._id, program: prog._id, sidh_candidate_id: `CAN99${stamp.slice(-4)}` }, 201)).data.item;
// c6b carries its own CAN id so the QA-042 second-tranche case can be tested below.
const c6b = (await req("POST", "/api/candidates", { name: `LateRes B ${stamp}`, phone: `688${stamp}2`, location: loc._id, program: prog._id, sidh_candidate_id: `CAN98${stamp.slice(-4)}` }, 201)).data.item;
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
  upNew2.summary?.matched === 0 && /frozen/.test(upNew2.unmatched?.[0]?.reason ?? ""), JSON.stringify(upNew2.unmatched));
// QA-042 (checker): the SECOND tranche of certificates must not recompute the protected
// batch-level figures. The old guard tested "were there rows before this request", which is
// false once tranche one has landed — so tranche two silently rewrote closure.
// c6b was on the roster from the start (added before completion) and never got a
// certificate in tranche one — it is exactly the "second tranche arrives later" case.
const upTranche2 = await certUpload(b6._id, [[`CAN_98${stamp.slice(-4)}.pdf`, pdf]], 200);
ok("late-arrival tranche two: the certificate still lands", upTranche2.summary?.matched === 1, JSON.stringify(upTranche2.summary));
const cl6b = (await req("GET", `/api/batches/${b6._id}/closure`)).data.closure;
ok("QA-042: tranche two does NOT rewrite the recorded batch-level figures",
  cl6b?.appeared === 2 && cl6b?.passed === 1 && cl6b?.certificates_issued === 1,
  JSON.stringify({ appeared: cl6b?.appeared, passed: cl6b?.passed, ci: cl6b?.certificates_issued }));

// ---- Empty-shell delete (2026-08-14, Umesh: "agar data ka koi source nahi hai toh remove
// that"). A batch carrying ANY record is history and must be refused; an empty one goes. ----
{
  const shell = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: today, target_size: 5 }, 201)).data.item;
  const del1 = await req("DELETE", `/api/batches/${shell._id}`, undefined, 200);
  ok("empty batch deletes", del1.data.deleted === shell.code, JSON.stringify(del1.data));
  ok("…and is gone from the list", !((await req("GET", "/api/batches?limit=2000")).data.items ?? []).some((x) => x.code === shell.code));
  await req("GET", `/api/batches/${shell._id}`, undefined, 404);
  // b4 carries results/closure/members — the guard must refuse it BY NAME.
  // QA-1431 (2026-08-26): Admin now implicitly holds batches.delete_with_data (every togglable
  // right), so the plain Admin actor this suite normally runs as would hit the NEW "supply a
  // reason to force-delete" 400 path here instead of the old hard 409 refusal — that is the
  // intended product change (Umesh: Admin/anyone granted the right can now force-delete a batch
  // with data), not a regression. This assertion's own point — that a batch carrying data cannot
  // be silently vaporized and the guard must name what it carries — is still true for anyone who
  // does NOT hold batches.delete_with_data, so it now runs as Operations (which holds
  // batches.delete by default but not the new, separately-grantable batches.delete_with_data).
  const opsCookieDel = await loginAs("ops@vidysea.com", "CiOnly@123");
  const savedForDel = cookie;
  if (opsCookieDel) cookie = opsCookieDel;
  const del2 = await req("DELETE", `/api/batches/${b4._id}`);
  ok("a batch with recorded work refuses deletion and names what it carries",
    del2.status === 409 && /members|results|closure/.test(del2.data?.error ?? "") && /cancelled, never deleted/i.test(del2.data?.error ?? ""),
    `got ${del2.status}: ${del2.data?.error ?? ""}`);
  cookie = savedForDel;
}

// ---- QA-048: the post-Completed money chain is visible, derived from Closure+Invoice ----
{
  const listRows = (await req("GET", "/api/batches?limit=2000")).data.items ?? [];
  const doneRows = listRows.filter((x) => ["Completed", "Closed"].includes(x.status));
  ok("QA-048: every Completed/Closed row carries a settlement stage", doneRows.length > 0 && doneRows.every((x) => typeof x.settlement_stage === "string" && x.settlement_stage.length > 3), JSON.stringify(doneRows.map((x) => [x.code, x.settlement_stage])));
  const b5row = listRows.find((x) => x._id === b5._id);
  ok("QA-048: certified-but-unraised batch names the invoice step", /invoice/i.test(b5row?.settlement_stage ?? ""), b5row?.settlement_stage);
  const det = (await req("GET", `/api/batches/${b5._id}`)).data;
  ok("QA-048: the detail payload carries the same stage", det.settlement_stage === b5row.settlement_stage, det.settlement_stage);
}

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

// QA-627: the SERVER-side half of the contract the client's saveContacts fix depends on - a save
// must hand the minted `_id`s straight back on the SAME response, not only on a later GET, or the
// client has nothing to seed its next save from. Two saves in a row, the second reusing exactly
// what the first returned (the "same page visit, no reload" shape the bug lived in).
{
  const r1 = (await req("PATCH", `/api/locations/${loc._id}`, { contacts: [{ name: "QA-627 Contact A " + stamp, role_label: "Contact" }] }, 200)).data.item;
  const idA = r1.contacts?.find((c) => c.name.startsWith("QA-627 Contact A"))?._id;
  ok("QA-627: a save's own response carries the freshly minted _id, not just a later GET", !!idA, JSON.stringify(r1.contacts));
  const r2 = (await req("PATCH", `/api/locations/${loc._id}`, {
    contacts: [
      { _id: idA, name: "QA-627 Contact A " + stamp, role_label: "Contact" },
      { name: "QA-627 Contact B " + stamp, role_label: "Contact" },
    ],
  }, 200)).data.item;
  const idAafter = r2.contacts?.find((c) => c.name.startsWith("QA-627 Contact A"))?._id;
  ok("QA-627: reusing the id a prior save returned keeps that contact's identity across a second save in the same visit",
    !!idAafter && String(idAafter) === String(idA), JSON.stringify({ idA, idAafter }));
}

await req("POST", `/api/locations/${loc._id}/notes`, { met_with: "Principal", note: "Discussed batch plan " + stamp }, 201);
await req("POST", `/api/locations/${loc._id}/notes`, { met_with: "Nobody" }, 400); // note text required
const notes = (await req("GET", `/api/locations/${loc._id}/notes`, undefined, 200)).data.items;
ok("meeting note recorded with author", notes.length === 1 && !!notes[0].logged_by?.name, JSON.stringify(notes[0]).slice(0, 120));

// ---- Trainer pipeline warning ----
const pipeTrainer = (await req("POST", "/api/trainers", {
  name: "Pipeline Trainer " + stamp, phone: "97777" + stamp.slice(0, 5),
  skills: ["TestSkill" + stamp], pipeline_status: "Shortlisted", tr_id: "TR" + stamp,
}, 201)).data.item;
const warnBatch = await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: pipeTrainer._id, planned_start: "2027-03-01", target_size: 3 }, 201);
ok("booking a not-Ready trainer warns, not blocks", String(warnBatch.data.warning ?? "").includes("Shortlisted"), JSON.stringify(warnBatch.data.warning));
await req("POST", `/api/batches/${warnBatch.data.item._id}/transition`, { target: "Cancelled", reason: "pipeline test cleanup" }, 200);

// ---- Backward batch planner ----
const plan = (await req("GET", "/api/plan-batch?start=2026-09-20", undefined, 200)).data;
ok("planner: 8 milestones, sorted by date", plan.milestones?.length === 8 &&
  plan.milestones.every((m, i, a) => i === 0 || new Date(a[i - 1].due_date) <= new Date(m.due_date)), JSON.stringify(plan.milestones?.map((m) => m.key)));
const totMs = plan.milestones.find((m) => m.key === "tot_done");
const totGap = Math.round((new Date("2026-09-20") - new Date(totMs?.due_date)) / 86400e3);
ok("planner: TOT due 3 days before start", totGap === 3, `gap=${totGap}d due=${totMs?.due_date}`);
const planBatch = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: "2027-04-01", target_size: 3 }, 201)).data.item;
// QA-152 (-81, Umesh): "planning is a deliberate act, not a side-effect of saving a batch".
ok("QA-152: a new batch carries NO plan (milestones empty, plan_enabled false)", (planBatch.milestones?.length ?? 0) === 0 && planBatch.plan_enabled === false, JSON.stringify({ n: planBatch.milestones?.length, plan_enabled: planBatch.plan_enabled }));
await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { key: "mobilization", done: true }, 409); // nothing to tick without a plan
await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { regenerate: true }, 409); // nothing to regenerate either
const planMade = (await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { create: true }, 200)).data.item;
ok("QA-152: 'Create backward plan' makes the 8 milestones and enables the plan", planMade.milestones?.length === 8 && planMade.plan_enabled === true, `count=${planMade.milestones?.length} enabled=${planMade.plan_enabled}`);
const ticked = (await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { key: "mobilization", done: true }, 200)).data.item;
ok("milestone tick-off records done_on", !!ticked.milestones.find((m) => m.key === "mobilization")?.done_on);
await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { regenerate: true }, 200);
const regen = (await req("GET", `/api/batches/${planBatch._id}`)).data.item;
ok("regenerate keeps ticked milestones done", !!regen.milestones.find((m) => m.key === "mobilization")?.done_on);

// ---- QA-607 (Umesh, 2026-08-27): a backward plan can be made on a batch that is ALREADY RUNNING ----
// Plan sharing (QA-557/558/621, seven fix cycles) shipped correct and unopenable: the only status
// that accepted `{ create: true }` was Planning, and on live -191 all six batches were Active or
// Completed. Every local fixture starts a batch in Planning, which is exactly why no suite here
// could see it — so this block takes a batch up the ORDINARY ladder (Planning -> Ready -> Active,
// no backdate_override) and then asks for a plan, which is the sentence the live check failed on.
{
  const aRoom = (await req("POST", `/api/locations/${loc._id}/rooms`, { name: `Active Plan Room ${stamp}`, type: "Classroom", capacity: 30 }, 201)).data.item;
  // planned_start is TODAY, so planBatchBackward's rows land on days that have ALREADY PASSED —
  // which is the whole point of a backward plan on a running batch, and the precondition for the
  // alert question below.
  const ab = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, room: aRoom._id, planned_start: today, target_size: 1 }, 201)).data.item;
  const ac = (await req("POST", "/api/candidates", { name: `Active Plan One ${stamp}`, phone: `833${stamp}0`, location: loc._id, program: prog._id }, 201)).data.item;
  const am = (await req("POST", `/api/batches/${ab._id}/members`, { candidate: ac._id }, 201)).data.item;
  await req("PATCH", `/api/members/${am._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
  await req("POST", `/api/batches/${ab._id}/transition`, { target: "Ready" }, 200);
  await req("POST", `/api/batches/${ab._id}/transition`, { target: "Active" }, 200);
  const activeNow = (await req("GET", `/api/batches/${ab._id}`)).data.item;
  ok("QA-607 precondition: the batch reached Active by the ordinary ladder, with no plan on it",
    activeNow.status === "Active" && activeNow.plan_enabled === false,
    JSON.stringify({ status: activeNow.status, plan_enabled: activeNow.plan_enabled }));

  // THE FIX. Before it this returned 409 "A backward plan is made while the batch is in Planning."
  // `?? {}` (QA-1529 observation): when this pin legitimately FAILS the response carries no item,
  // and `.data.item.milestones` then threw a TypeError that took the whole 1497-assertion suite
  // down — a future regression here would surface as a CRASHED suite instead of one red line.
  const made = (await req("PATCH", `/api/batches/${ab._id}/milestones`, { create: true }, 200)).data.item ?? {};
  ok("QA-607: 'Create backward plan' works on a RUNNING batch — the 8 milestones exist and the plan is enabled",
    made.milestones?.length === 8 && made.plan_enabled === true,
    JSON.stringify({ n: made.milestones?.length, plan_enabled: made.plan_enabled }));

  // …and REGENERATION is deliberately NOT widened: it recuts every due date from planned_start, and
  // a running batch's plan is a record of what happened, not a schedule to be recut.
  const regenActive = await req("PATCH", `/api/batches/${ab._id}/milestones`, { regenerate: true });
  ok("QA-607: regenerate is still refused on a running batch (creation widened, regeneration not)",
    regenActive.status === 409 && /regenerated while the batch is in Planning/.test(String(regenActive.data?.error)),
    JSON.stringify({ s: regenActive.status, e: regenActive.data?.error }));

  // QA-1529 (checker on cycle 1): the assertion above is a pin on a BODY KEY, and the guard it was
  // pinning tested the same body key — so both agreed with each other and neither saw the operation.
  // A second `{ create: true }` on a batch that already HAS a plan reaches the identical mergePlan
  // call `{ regenerate: true }` does: it takes due_date and label from the freshly computed plan and
  // keeps only done_on/notes/owner_label/custom. On live -191 code that returned 200 and silently
  // recut a running batch's plan — a plan that is now a publicly shareable artifact (QA-558/621),
  // so an external recipient's link changes under them. This pin tests the OPERATION: hand-edit a
  // row the way a planner would, re-send the create-shaped body, and assert the edit SURVIVED.
  const HAND_DATE = "2027-09-15", HAND_LABEL = "HAND EDITED BY PLANNER";
  await req("PATCH", `/api/batches/${ab._id}/milestones`, { edit: { key: "mobilization", due_date: HAND_DATE, label: HAND_LABEL } }, 200);
  const recut = await req("PATCH", `/api/batches/${ab._id}/milestones`, { create: true });
  ok("QA-1529: a SECOND create-shaped call on a running batch that already has a plan is refused as the regeneration it is",
    recut.status === 409 && /regenerated while the batch is in Planning/.test(String(recut.data?.error)),
    JSON.stringify({ s: recut.status, e: recut.data?.error }));
  const afterRecut = (await req("GET", `/api/batches/${ab._id}`)).data.item ?? {};
  const handRow = (afterRecut.milestones ?? []).find((m) => m.key === "mobilization");
  ok("QA-1529: …and the planner's hand-edited due date and label survived it (the pin is the DATA, not the status code)",
    String(handRow?.due_date ?? "").slice(0, 10) === HAND_DATE && handRow?.label === HAND_LABEL,
    JSON.stringify({ due_date: handRow?.due_date, label: handRow?.label }));
  // The other half of the same fact: the refusal is about the RECUT, not about being Active. A
  // Planning batch that already has a plan may still be recut by either body shape — otherwise this
  // fix would have quietly broken the one workflow the feature was built for.
  const planningRecut = await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { create: true }, 200);
  ok("QA-1529: a create-shaped call on a PLANNING batch that already has a plan still recuts — the guard is the recut, not the door",
    (planningRecut.data.item?.milestones?.length ?? 0) === 8 && planningRecut.data.item?.plan_enabled === true,
    JSON.stringify({ n: planningRecut.data.item?.milestones?.length }));
  // Put the row back so the retroactive-overdue assertion below measures the generated plan.
  await req("PATCH", `/api/batches/${ab._id}/milestones`, { edit: { key: "mobilization", due_date: today, label: "Candidate mobilization complete" } }, 200);

  // "Ready" is NOT in the widened list, and that is load-bearing rather than an oversight:
  // alerts.ts's milestone_overdue rule queries `status: { $in: ["Planning", "Ready"] }`, so a plan
  // minted on a Ready batch whose earlier dates have passed raises an overdue alert immediately.
  // Its own room: `aRoom` is already booked for these dates by the batch above, and a room hosts
  // one batch at a time.
  const rRoom = (await req("POST", `/api/locations/${loc._id}/rooms`, { name: `Ready Plan Room ${stamp}`, type: "Classroom", capacity: 30 }, 201)).data.item;
  const rTrainer = (await req("POST", "/api/trainers", { name: `Ready Plan Trainer ${stamp}`, phone: `98888${stamp.slice(0, 5)}`, skills: ["TestSkill" + stamp] }, 201)).data.item;
  const readyB = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: rTrainer._id, room: rRoom._id, planned_start: today, target_size: 1 }, 201)).data.item;
  const readyC = (await req("POST", "/api/candidates", { name: `Ready Plan One ${stamp}`, phone: `834${stamp}0`, location: loc._id, program: prog._id }, 201)).data.item;
  const readyM = (await req("POST", `/api/batches/${readyB._id}/members`, { candidate: readyC._id }, 201)).data.item;
  await req("PATCH", `/api/members/${readyM._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
  await req("POST", `/api/batches/${readyB._id}/transition`, { target: "Ready" }, 200);
  const readyPlan = await req("PATCH", `/api/batches/${readyB._id}/milestones`, { create: true });
  ok("QA-607: Ready is deliberately still refused — it is inside the milestone_overdue alert query, Active is not",
    readyPlan.status === 409, JSON.stringify({ s: readyPlan.status, e: readyPlan.data?.error }));
  await req("POST", `/api/batches/${readyB._id}/transition`, { target: "Cancelled", reason: "QA-607 ready-gate probe cleanup" }, 200);

  // The plan on the running batch DOES carry overdue rows — so the alerts question below is a real
  // one, not one answered by there being nothing to alert about. (A pin that passes vacuously is
  // not a pin — QA-598, learned on this same file.)
  const art = (await req("GET", `/api/batches/${ab._id}/plan`)).data;
  ok("QA-607: the backward plan on a running batch is retroactive — its rows are already overdue",
    (art?.counts?.overdue ?? 0) > 0, JSON.stringify(art?.counts));
  // …and alerts.ts never sees this batch: milestone_overdue selects Planning/Ready only, and the
  // batch is Active. Asserted at the level a suite can assert it — the batch's status is outside
  // that query — with the engine's own behaviour measured in qa/manifests/qa-607-plan-on-active-batches.md.
  ok("QA-607: …and the batch it sits on is Active, which the milestone_overdue rule does not select",
    art?.batch?.status === "Active", String(art?.batch?.status));

  // The now-reachable end of the feature: a plan link can actually be minted and opened. This is
  // QA-558/621's machinery, unchanged — asserted here only to show this unit did not break it.
  const planContact = ((await req("GET", `/api/locations/${loc._id}`)).data.item.contacts ?? [])[0];
  const mint = await req("POST", "/api/public-tokens", { purpose: "plan", batch: ab._id, recipient_name: planContact.name, recipient_role_label: planContact.role_label, recipient_ref: `contact:${planContact._id}` }, 201);
  const shared = await fetch(BASE + `/api/public/plan/${mint.data.item?.token ?? mint.data.token}`);
  const sharedJ = shared.status === 200 ? await shared.json() : null;
  ok("QA-607: the plan on a running batch can be shared, and the link opens — the sentence live -191 could not reach",
    shared.status === 200 && (sharedJ?.milestones ?? []).length === 8,
    JSON.stringify({ mint: mint.status, open: shared.status, n: (sharedJ?.milestones ?? []).length }));

  await req("POST", `/api/batches/${ab._id}/transition`, { target: "Cancelled", reason: "QA-607 plan-on-active probe cleanup" }, 200);
}

// ---- -196 (Umesh 22/08): "jaise dates aate rahengi woh usi values mein fill hote rahengi" ----
// The Planning grid is filled from a sheet DAYS after the fact, so the date the operator types is
// the fact. Before this release a tick always stamped `new Date()`, which meant every date typed
// into that grid was silently replaced by today's - the grid would agree with itself and disagree
// with the sheet it was copied from. The pin is the DATE, not the presence of a date: the old
// behaviour also produced a truthy done_on, so "records done_on" above cannot catch this.
{
  // A PAST date - the grid is filled from a sheet days late, which is the whole case for this
  // argument. (QA-644 now refuses a future done_on, and the first version of this pin used 2027,
  // which would have been refused by the fix that followed it.)
  const backdated = "2026-03-09";
  const bd = (await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { key: "enrollment_done", done: true, done_on: backdated }, 200)).data.item;
  const got = bd.milestones.find((m) => m.key === "enrollment_done")?.done_on;
  ok("-196: an explicit done_on is stored as typed, not overwritten with today",
    !!got && String(got).slice(0, 10) === backdated, `done_on=${got} expected=${backdated}`);
  // A bare tick still means now - the new argument must not change what the old callers do.
  const now = (await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { key: "trainer_mapped_sidh", done: true }, 200)).data.item;
  const nowOn = now.milestones.find((m) => m.key === "trainer_mapped_sidh")?.done_on;
  ok("-196: a tick with no date still means today",
    !!nowOn && String(nowOn).slice(0, 10) === new Date().toISOString().slice(0, 10), `done_on=${nowOn}`);
  // Garbage is refused rather than quietly becoming an Invalid Date on the document.
  // This assertion reads the RESPONSE. Its first form passed `true` and let req()'s own status
  // line do the detecting - which made it a pin that could not fail (QA-598 / QA-613 / QA-624 /
  // QA-628 / QA-639), and the REQ-388 trap is what caught it: it stayed green on the pre-fix route
  // while the behaviour it names was absent.
  const junk = await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { key: "enrollment_done", done: true, done_on: "not-a-date" });
  ok("-196: an unparseable done_on is refused", junk.status === 400 && /done_on/.test(junk.data?.error ?? ""),
    `status=${junk.status} error=${JSON.stringify(junk.data?.error ?? null)}`);
  // QA-644 (-197): done_on says something HAPPENED, so the future is refused the way Rule 25
  // refuses a future left_on. It is load-bearing: `overdue` is `!done_on && due_date < today`, so a
  // milestone ticked into 2087 would stop being overdue for sixty years.
  const future = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const far = await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { key: "enrollment_done", done: true, done_on: future });
  ok("-197: a done_on in the future is refused", far.status === 400 && /future/i.test(far.data?.error ?? ""),
    `status=${far.status} error=${JSON.stringify(far.data?.error ?? null)}`);
  // QA-650 (-198): -197 compared raw milliseconds with 24h of slack, so TOMORROW was accepted as
  // already done while the message said "cannot be a future date". The rules it cites all compare
  // CALENDAR dates on the IST footing. This is the pin that catches the slack, not the year-away
  // one above - that one passed on -197 too.
  const istNow = new Date(Date.now() + 330 * 60 * 1000);
  const tomorrow = new Date(istNow.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const tm = await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { key: "enrollment_done", done: true, done_on: tomorrow });
  ok("-198: TOMORROW is refused too, not just a date a year out", tm.status === 400 && /future/i.test(tm.data?.error ?? ""),
    `done_on=${tomorrow} status=${tm.status} error=${JSON.stringify(tm.data?.error ?? null)}`);
  // An empty string is a cleared input, not "no date given" - -197 let it fall through to now.
  const empty = await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { key: "enrollment_done", done: true, done_on: "" });
  ok("-198: an empty done_on is refused rather than silently meaning now", empty.status === 400 && /done_on/.test(empty.data?.error ?? ""),
    `status=${empty.status} error=${JSON.stringify(empty.data?.error ?? null)}`);
  // QA-660 (-200): -198 guarded the empty STRING and then tested truthiness on the next line, so
  // `0`, `null` and `false` still fell through to today. One rule now: absent means today, anything
  // present must be a real date. Each shape is its own assertion - a single "falsy" test would let
  // the next one through the way "" got through the last check.
  // `0` is the one that proves the rule has to be an allow-list: it is not empty, not null and not
  // a boolean, so a refuse-list waved it through into `new Date(0)` - a valid 1 Jan 1970, stored as
  // a fact. This wall caught that on the -200 run before it shipped.
  for (const [label, value] of [["null", null], ["zero", 0], ["false", false], ["whitespace", "   "], ["an object", { d: 1 }]]) {
    const r = await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { key: "enrollment_done", done: true, done_on: value });
    ok(`-200: done_on sent as ${label} is refused`, r.status === 400,
      `status=${r.status} error=${JSON.stringify(r.data?.error ?? null)}`);
  }
  // QA-683 (-203, checker on qa-198): the allow-list above was on EMPTINESS, not on being a date,
  // and the string "0" is not empty. new Date("0") is 1 Jan 2000 and new Date("1") is 2001 - real
  // dates, comfortably in the past, so the future check waved them through and stored them as fact
  // exactly the way 1970 was. Same defect as the row above it, one type narrower. The strings a
  // person actually types are here too: a date written the Indian way must be refused rather than
  // half-read.
  for (const junk of ["0", "1", "2026", "yesterday", "14-08-2026", "2026/08/14"]) {
    const r = await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { key: "enrollment_done", done: true, done_on: junk });
    ok(`-203/QA-683: done_on sent as the string "${junk}" is refused`, r.status === 400,
      `status=${r.status} error=${JSON.stringify(r.data?.error ?? null)}`);
  }
  const stored1970 = (await req("GET", `/api/batches/${planBatch._id}`)).data.item.milestones.find((m) => m.key === "enrollment_done")?.done_on;
  ok("-200/-203: none of those refusals left an epoch or a Y2K date on the milestone",
    !["1970", "2000", "2001"].includes(String(stored1970).slice(0, 4)), `done_on=${stored1970}`);
  // and absent still means today, which is the behaviour all of that is protecting
  const absent = (await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { key: "trainer_mapped_sidh", done: true }, 200)).data.item;
  ok("-200: with done_on absent it still records today",
    String(absent.milestones.find((m) => m.key === "trainer_mapped_sidh")?.done_on ?? "").slice(0, 10) === new Date().toISOString().slice(0, 10),
    JSON.stringify(absent.milestones.find((m) => m.key === "trainer_mapped_sidh")?.done_on ?? null));
  // Today must still be accepted - the boundary is "not the future", not "not today".
  const today = new Date().toISOString().slice(0, 10);
  const now2 = await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { key: "enrollment_done", done: true, done_on: today }, 200);
  ok("-197: today is still accepted", String(now2.data?.item?.milestones?.find((m) => m.key === "enrollment_done")?.done_on ?? "").slice(0, 10) === today,
    JSON.stringify(now2.data?.item?.milestones?.find((m) => m.key === "enrollment_done")?.done_on ?? null));
  // put the backdated value back so the assertion below still describes what it says it does
  await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { key: "enrollment_done", done: true, done_on: backdated }, 200);
  const still = (await req("GET", `/api/batches/${planBatch._id}`)).data.item.milestones.find((m) => m.key === "enrollment_done")?.done_on;
  ok("-196: the refused write left the stored date alone", String(still).slice(0, 10) === backdated, `done_on=${still}`);
}

// ---- -164: the planner stops being one shape for every batch ----
// REQ-388: every assertion in this block FAILS on pre-fix code. planBatchBackward was a
// hard-coded seven-element array with ZERO conditionals, and /api/plan-batch read only ?start=.
{
  // (f) QA-503 - the milestone this unit ADDED sorted into an impossible place. Its default lead
  // was 5, and a BIGGER lead means an EARLIER date, so it landed 5 days before start while
  // tot_done sits at 3: the plan said map the trainer on the SIDH portal two days BEFORE their
  // TOT completed. The comment directly above that line in rules.ts exists to forbid exactly it.
  //
  // THIS RUNS FIRST, and that placement is the pin. The first version of this block sat after
  // (d), which PUTs lead_trainer_mapped_sidh_days itself - so it was asserting against a value
  // the suite had just written, and it PASSED on pre-fix code. My own pre-fix run caught that,
  // which is the qa-163 lesson landing one unit later: ask of every assertion whether it could
  // fail if the feature were absent, and here the answer was no.
  const shipped = (await req("GET", "/api/defaults", undefined, 200)).data.item;
  ok("QA-503 (-164 c2): the SHIPPED default puts trainer_mapped_sidh after tot_done (lead must be smaller)",
    shipped.lead_trainer_mapped_sidh_days < shipped.lead_tot_done_days,
    JSON.stringify({ mapped_sidh: shipped.lead_trainer_mapped_sidh_days, tot_done: shipped.lead_tot_done_days }));
  const ordPlan = (await req("GET", "/api/plan-batch?start=2028-06-01", undefined, 200)).data.milestones;
  const dueOf = (k) => new Date(ordPlan.find((m) => m.key === k)?.due_date).getTime();
  ok("QA-503 (-164 c2): and the plan shows it - trainer_mapped_sidh falls AFTER tot_done",
    dueOf("trainer_mapped_sidh") > dueOf("tot_done"),
    JSON.stringify(ordPlan.map((m) => [m.key, String(m.due_date).slice(0, 10)])));
  ok("QA-503 (-164 c2): ...and reads BEFORE mobilization even though both fall on the same day - declared stage order breaks the tie",
    dueOf("trainer_mapped_sidh") === dueOf("mobilization")
      && ordPlan.findIndex((m) => m.key === "trainer_mapped_sidh") < ordPlan.findIndex((m) => m.key === "mobilization"),
    JSON.stringify(ordPlan.map((m) => m.key)));

  // (a) QA-460 - the 'Not needed' skip path. 3 of the 16 rows on Karunn sir's own sheet have a
  // trainer who is already certified, and the planner handed all three TOT deadlines anyway.
  const certTrainer = (await req("POST", "/api/trainers", {
    name: "Certified Trainer " + stamp, phone: "96666" + stamp.slice(0, 5),
    skills: ["TestSkill" + stamp], pipeline_status: "Certified", tr_id: "TRC" + stamp,
  }, 201)).data.item;
  const certBatch = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: certTrainer._id, planned_start: "2028-03-10", target_size: 3 }, 201)).data.item;
  const certPlan = (await req("PATCH", `/api/batches/${certBatch._id}/milestones`, { create: true }, 200)).data.item;
  const certKeys = (certPlan.milestones ?? []).map((m) => m.key);
  ok("QA-460 (-164): a batch whose trainer is Certified gets NO tot_start and NO tot_done",
    !certKeys.includes("tot_start") && !certKeys.includes("tot_done"), JSON.stringify(certKeys));
  ok("QA-460 (-164 c2): ...and keeps every other milestone - it skips, it does not truncate",
    ["trainer_found", "trainer_mapped_sidh", "mobilization", "trainer_ready", "enrollment_done"].every((k) => certKeys.includes(k)) && certKeys.length === 5,
    JSON.stringify(certKeys));
  // contract §7 fold (cycle 2): trainer_ready_for_tot goes with the TOT rows. Asking whether a
  // trainer is "available & ready for TOT" they finished in January is the same dead deadline.
  ok("-164 c2 (fold): trainer_ready_for_tot is skipped too, not left asking about a finished TOT",
    !certKeys.includes("trainer_ready_for_tot"), JSON.stringify(certKeys));

  // (b) the OTHER way a trainer becomes certified: the pipeline itself. A bypass jump stamps
  // tot_done_on, and the plan must drop TOT for that trainer too.
  //
  // HONEST LIMIT, measured rather than assumed. planBatchBackward also skips on tot_done_on
  // ALONE, and that arm is deliberately NOT pinned because it cannot be built through the
  // product: tot_done_on is not in the trainer create/update allowlist (trainers/route.ts:66)
  // - only the Certified transition writes it - and PATCHing pipeline_status back to an earlier
  // stage is a silent no-op. The arm stays in the code for legacy and imported rows, where a
  // date exists without the stage; here it would only be pinned by faking a row the app cannot
  // make, which proves nothing about the app. First fixture for this assertion tried exactly
  // that and the fixture guard below caught it.
  const pipeTrainer2 = (await req("POST", "/api/trainers", {
    name: "Bypass-certified Trainer " + stamp, phone: "95555" + stamp.slice(0, 5),
    skills: ["TestSkill" + stamp], pipeline_status: "Fresh Lead",
  }, 201)).data.item;
  const jumped = (await req("POST", `/api/trainers/${pipeTrainer2._id}/transition`, { target: "Certified", bypass: true, payload: { tr_id: "TRB" + stamp, tot_certificate_no: "TOTB-" + stamp } }, 200)).data.item;
  ok("-164 fixture guard: the bypass jump really stamps tot_done_on (without this the next assertion proves nothing)", !!jumped.tot_done_on && jumped.pipeline_status === "Certified", JSON.stringify({ tot_done_on: jumped.tot_done_on, stage: jumped.pipeline_status }));
  const dateBatch = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: pipeTrainer2._id, planned_start: "2028-02-10", target_size: 3 }, 201)).data.item;
  const datePlan = (await req("PATCH", `/api/batches/${dateBatch._id}/milestones`, { create: true }, 200)).data.item;
  const dateKeys = (datePlan.milestones ?? []).map((m) => m.key);
  ok("QA-460 (-164): a trainer certified THROUGH THE PIPELINE also gets no TOT rows",
    !dateKeys.includes("tot_start") && !dateKeys.includes("tot_done") && dateKeys.length === 5, JSON.stringify({ stage: jumped.pipeline_status, keys: dateKeys }));

  // (c) a batch with NO trainer keeps the full plan - the calculator is used before anyone is
  // hired, and there the full plan is the honest answer, not a shortened one.
  ok("-164: a batch with no trainer still gets all 8, TOT included", (planMade.milestones ?? []).map((m) => m.key).includes("tot_done"), JSON.stringify((planMade.milestones ?? []).map((m) => m.key)));

  // (d) contract criterion 6 - trainer_mapped_sidh is Karunn sir's column 14 and its lead time
  // is a Default, not a constant. Proved by moving the Default and watching the date move.
  const mapped0 = (certPlan.milestones ?? []).find((m) => m.key === "trainer_mapped_sidh");
  const gap0 = Math.round((new Date("2028-03-10") - new Date(mapped0?.due_date)) / 86400e3);
  ok("-164 c2: trainer_mapped_sidh defaults to 2 days before start", gap0 === 2, `gap=${gap0}d due=${mapped0?.due_date}`);
  await req("PUT", "/api/defaults", { lead_trainer_mapped_sidh_days: 1 }, 200);
  const reMapped = (await req("PATCH", `/api/batches/${certBatch._id}/milestones`, { regenerate: true }, 200)).data.item.milestones.find((m) => m.key === "trainer_mapped_sidh");
  const gap1 = Math.round((new Date("2028-03-10") - new Date(reMapped?.due_date)) / 86400e3);
  ok("-164 c2: ...and it is READ from Defaults, not hard-coded (2 -> 1 moves the date)", gap1 === 1, `gap=${gap1}d due=${reMapped?.due_date}`);
  await req("PUT", "/api/defaults", { lead_trainer_mapped_sidh_days: 2 }, 200); // restore for the rest of the wall

  // (e) REQ-186 / QA-461 - the calculator becomes centre-aware, and answers 'which date is even
  // possible' instead of only 'if I pick this date, what is due when'.
  const bare = (await req("GET", "/api/plan-batch?start=2028-06-01", undefined, 200)).data;
  ok("-164: WITHOUT ?location= nothing changes - no scope, no earliest, full plan (today's behaviour preserved)",
    bare.scoped_to === null && bare.earliest_possible_start === null && bare.milestones.length === 8 && bare.tot_skipped === false,
    JSON.stringify({ scoped: bare.scoped_to, earliest: bare.earliest_possible_start, n: bare.milestones.length }));
  const scoped = (await req("GET", `/api/plan-batch?start=2028-06-01&location=${loc._id}&program=${prog._id}`, undefined, 200)).data;
  ok("QA-461 (-164): ?location= changes the answer - the centre's certified trainer removes the TOT rows",
    scoped.tot_skipped === true && scoped.milestones.length === 5 && !scoped.milestones.some((m) => m.key === "tot_done") && scoped.scoped_to?.trainer?.name === certTrainer.name,
    JSON.stringify({ skipped: scoped.tot_skipped, n: scoped.milestones.length, trainer: scoped.scoped_to?.trainer?.name }));
  // ---- QA-657 / QA-658 (-200): the ROUND TRIP, because the source-text pin certified a no-op ----
  // -198 claimed to fix "the plan you approve is not the plan that gets saved" by sending
  // `scoped_to.trainer?._id` from the Planning strip. `scoped_to.trainer` had no `_id`, so the guard
  // was always false and nothing changed - and the structural pin that certified it matched the new
  // source TEXT, went green, and a 3,151-assertion wall shipped with the S2 live. That is the sixth
  // pin in this project that could not fail for the defect it names, and the first to certify its
  // own release's headline item.
  //
  // So this pin drives what the SCREEN does, in the screen's own order, and compares the two plans.
  // It is written with the client's exact optional-chain (`?._id`) on purpose: if the API stops
  // sending the id, this pin reproduces the defect instead of stepping around it.
  {
    ok("QA-657: the preview names its trainer with an id the caller can act on",
      !!scoped.scoped_to?.trainer?._id, JSON.stringify(scoped.scoped_to?.trainer ?? null));
    const previewKeys = scoped.milestones.map((m) => m.key).sort();
    // exactly what PlanningCreate.save() does, in order
    const stripBatch = (await req("POST", "/api/batches", {
      location: loc._id, program: prog._id, planned_start: "2028-06-01", session: "Full Day",
      ...(scoped.scoped_to?.trainer?._id ? { trainer: scoped.scoped_to.trainer._id } : {}),
      target_size: 7,
    }, 201)).data.item;
    const stripPlan = (await req("PATCH", `/api/batches/${stripBatch._id}/milestones`, { create: true }, 200)).data.item;
    const storedKeys = (stripPlan.milestones ?? []).map((m) => m.key).sort();
    ok("QA-657: the plan STORED on the batch is the plan the preview showed - same milestones, no TOT rows added back",
      JSON.stringify(storedKeys) === JSON.stringify(previewKeys),
      `preview=${JSON.stringify(previewKeys)} stored=${JSON.stringify(storedKeys)}`);
    ok("QA-657: and the batch really carries the trainer the preview was scoped to",
      String(stripBatch.trainer?._id ?? stripBatch.trainer ?? "") === String(certTrainer._id),
      `trainer=${JSON.stringify(stripBatch.trainer ?? null)} expected=${certTrainer._id}`);
    await req("POST", `/api/batches/${stripBatch._id}/transition`, { target: "Cancelled", reason: "QA-657 pin cleanup" }, 200);
  }

  const eps = scoped.earliest_possible_start;
  const epsKeys = (eps?.basis ?? []).map((b) => b.key);
  ok("QA-461 (-164): earliest_possible_start comes back WITH its basis - all three constraints named",
    !!eps?.date && epsKeys.includes("mobilisation") && epsKeys.includes("trainer") && epsKeys.includes("room") && (eps.basis ?? []).every((b) => !!b.note),
    JSON.stringify({ date: eps?.date, basis: epsKeys }));
  ok("QA-461 (-164): the date is the MAX of the constraints, never earlier than any one of them",
    (eps.basis ?? []).filter((b) => b.date).every((b) => new Date(b.date) <= new Date(eps.date)),
    JSON.stringify((eps.basis ?? []).map((b) => [b.key, String(b.date).slice(0, 10)])));
  const tooSoon = (await req("GET", `/api/plan-batch?start=2020-01-01&location=${loc._id}&program=${prog._id}`, undefined, 200)).data;
  ok("QA-461 (-164): a start the centre cannot meet is FLAGGED instead of silently back-dated",
    tooSoon.starts_too_soon === true && new Date(tooSoon.earliest_possible_start.date) > new Date("2020-01-01"),
    JSON.stringify({ flag: tooSoon.starts_too_soon, earliest: tooSoon.earliest_possible_start?.date }));
  ok("-164: the mobilisation lead is a real floor - the earliest is never inside it",
    new Date(eps.date) >= new Date((eps.basis.find((b) => b.key === "mobilisation") ?? {}).date),
    JSON.stringify({ date: eps.date, mob: eps.basis.find((b) => b.key === "mobilisation")?.date }));


  // ---- -164 CYCLE 2: four defects a checker found that cycle 1 shipped or mis-stated ----


  // (g) QA-504 - the skip was DELETING RECORDED WORK, on the normal path. Both callers rebuilt
  // the array with .map() over the new plan, so a row the new plan omits was dropped with its
  // tick, its note and its owner. -164 is what made omission normal. Certify the trainer, edit
  // the start date, and the evidence that the TOT actually happened was gone.
  const lossBatch = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, planned_start: "2028-08-01", target_size: 3 }, 201)).data.item;
  await req("PATCH", `/api/batches/${lossBatch._id}/milestones`, { create: true }, 200);
  await req("PATCH", `/api/batches/${lossBatch._id}/milestones`, { key: "tot_done", done: true }, 200);
  await req("PATCH", `/api/batches/${lossBatch._id}/milestones`, { edit: { key: "tot_done", notes: "TOT finished, certificate in hand", owner_label: "Divya" } }, 200);
  // now the thing that makes tot_done disappear from the plan: a certified trainer
  const afterLoss = (await req("PATCH", `/api/batches/${lossBatch._id}`, { trainer: certTrainer._id, planned_start: "2028-08-15" }, 200)).data.item;
  const keptRow = (afterLoss.milestones ?? []).find((m) => m.key === "tot_done");
  ok("QA-504 (-164 c2): a regenerated plan may move a date - it may NEVER erase a tick, a note or an owner",
    !!keptRow?.done_on && keptRow?.notes === "TOT finished, certificate in hand" && keptRow?.owner_label === "Divya",
    JSON.stringify({ present: !!keptRow, done_on: keptRow?.done_on, notes: keptRow?.notes, owner: keptRow?.owner_label, keys: (afterLoss.milestones ?? []).map((m) => m.key) }));
  ok("QA-504 (-164 c2): ...and the rows the new plan does want are still there, so it kept work without refusing to skip",
    (afterLoss.milestones ?? []).some((m) => m.key === "trainer_mapped_sidh") && !(afterLoss.milestones ?? []).some((m) => m.key === "tot_start"),
    JSON.stringify((afterLoss.milestones ?? []).map((m) => m.key)));

  // (h) QA-505 - the scoped query had no status filter, so a CANCELLED batch could decide
  // whether the TOT rows appear, while the room and cap logic in the same file has always
  // filtered on ACTIVE_BATCH_STATUSES. "Who teaches this here" means a LIVE batch.
  const deadLoc = (await req("POST", "/api/locations", { code: "PD" + stamp, name: "TEST-PlanDead " + stamp, approval_status: "Approved", city: "Meerut" }, 201)).data.item;
  const deadBatch = (await req("POST", "/api/batches", { location: deadLoc._id, program: prog._id, trainer: certTrainer._id, planned_start: "2028-09-01", target_size: 3 }, 201)).data.item;
  await req("POST", `/api/batches/${deadBatch._id}/transition`, { target: "Cancelled", reason: "-164 c2: QA-505 pin" }, 200);
  const deadPlan = (await req("GET", `/api/plan-batch?start=2028-12-01&location=${deadLoc._id}&program=${prog._id}`, undefined, 200)).data;
  ok("QA-505 (-164 c2): a CANCELLED batch does not decide the plan - its certified trainer no longer removes the TOT rows",
    deadPlan.tot_skipped === false && deadPlan.scoped_to?.trainer === null && deadPlan.milestones.length === 8,
    JSON.stringify({ skipped: deadPlan.tot_skipped, trainer: deadPlan.scoped_to?.trainer, n: deadPlan.milestones.length }));

  // (j) QA-506 - a constraint that CANNOT be satisfied was silently dropped instead of binding.
  // earliestPossibleStart pushed a null date for "no active room at this centre" and the reducer
  // filtered nulls out, so such a centre was handed a date it cannot possibly meet and
  // starts_too_soon said false. deadLoc above has no room, which makes it the right fixture.
  const noRoom = (await req("GET", `/api/plan-batch?start=2030-01-01&location=${deadLoc._id}&program=${prog._id}`, undefined, 200)).data;
  ok("QA-506 (-164 c2): a centre with no room is told the plan is BLOCKED, not handed a date it cannot meet",
    noRoom.earliest_possible_start?.blocked === true
      && (noRoom.earliest_possible_start?.basis ?? []).some((b) => b.key === "room" && b.blocking === true && b.date === null),
    JSON.stringify({ blocked: noRoom.earliest_possible_start?.blocked, basis: (noRoom.earliest_possible_start?.basis ?? []).map((b) => [b.key, b.date, b.blocking]) }));
  ok("QA-506 (-164 c2): ...and even a start five years out reads starts_too_soon, because no date meets an unmeetable constraint",
    noRoom.starts_too_soon === true, JSON.stringify({ start: "2030-01-01", too_soon: noRoom.starts_too_soon, earliest: noRoom.earliest_possible_start?.date }));
  ok("QA-506 (-164 c2): a centre that HAS rooms is not blocked - the flag means blocked, not merely constrained",
    scoped.earliest_possible_start?.blocked === false,
    JSON.stringify({ blocked: scoped.earliest_possible_start?.blocked }));

  // ---- -173 (QA-523): a write door says what it would not write ----
  // pick() is the write whitelist and it stays exactly as strict - it is what stops a request
  // setting a field nobody meant to expose. What was wrong is that it worked in SILENCE: a PATCH
  // carrying a field the door does not accept came back 200 with the field untouched, and the
  // caller could not tell a saved field from an ignored one.
  //
  // The fixture is the REAL case that found it, on qa-171: nsdc_submitted_on / nsdc_result_on /
  // paid_on are stamped by the pipeline transitions and must not be settable here. There it only
  // proved a test fixture wrong. In front of an operator the same shape means they save something,
  // the screen agrees, and nothing changed.
  //
  // ONE pin and four GUARDS, and the split is deliberate: the defect is exactly one thing -
  // silence - so exactly one assertion can be red before the fix. The other four exist to catch
  // the ways a fix like this goes wrong: loosening the whitelist, refusing the whole request,
  // putting the field on every response, or reporting the ids a client naturally echoes back.
  {
    const igTrainer = (await req("POST", "/api/trainers", {
      name: "Ignored Fields " + stamp, phone: "97000" + stamp.slice(0, 5), skills: ["TestSkill" + stamp],
    }, 201)).data.item;
    const res = await req("PATCH", `/api/trainers/${igTrainer._id}`, {
      name: "Ignored Fields Renamed " + stamp,          // accepted
      nsdc_submitted_on: "2027-01-05",                    // refused - the pipeline stamps it
      paid_on: "2027-01-25",                              // refused, same reason
    }, 200);
    const ig = res.data.ignored_fields ?? [];
    ok("QA-523 (-173): the door NAMES the fields it would not write, instead of dropping them in silence",
      ig.includes("nsdc_submitted_on") && ig.includes("paid_on"),
      JSON.stringify({ ignored: ig }));
    ok("QA-523 (-173) [guard]: ...and it is still strict - the refused fields really did not land",
      !res.data.item?.nsdc_submitted_on && !res.data.item?.paid_on,
      JSON.stringify({ sub: res.data.item?.nsdc_submitted_on ?? null, paid: res.data.item?.paid_on ?? null }));
    ok("QA-523 (-173) [guard]: ...and the field it DOES accept was written, so this is a report and not a refusal",
      res.data.item?.name === "Ignored Fields Renamed " + stamp,
      JSON.stringify({ name: res.data.item?.name }));

    // A clean write must stay clean: no key on the response when nothing was ignored, or every
    // caller learns to skip past a field that is always there.
    const clean = await req("PATCH", `/api/trainers/${igTrainer._id}`, { name: "Ignored Fields Clean " + stamp }, 200);
    ok("QA-523 (-173) [guard]: a request that asked for nothing extra carries no ignored_fields at all",
      !("ignored_fields" in (clean.data ?? {})), JSON.stringify({ keys: Object.keys(clean.data ?? {}) }));

    // The ids a client echoes back from a GET are not attempts to write, and reporting them would
    // make the field noise on every save the UI does.
    const echo = await req("PATCH", `/api/trainers/${igTrainer._id}`, { _id: igTrainer._id, createdAt: "2020-01-01", name: "Ignored Fields Echo " + stamp }, 200);
    ok("QA-523 (-173) [guard]: echoed ids and timestamps are not reported - they are not attempts to write",
      !("ignored_fields" in (echo.data ?? {})), JSON.stringify({ ignored: echo.data?.ignored_fields ?? null }));
  }

  // ---- -171 (QA-399): Karunn sir's Back-dated Planning table ----
  // His sheet is 18 columns x 16 rows, one row per (Location x Job Role x Batch). The columns sit
  // at THREE grains - 1 on the location, TEN on the trainer, 7 on the batch - and getting that
  // wrong is the only way this can fail badly, because a trainer does TOT ONCE and runs up to
  // four batches. Every assertion below exists to keep that true.
  //
  // Every read is guarded. Three times in the previous unit a pin took the whole suite down by
  // assuming the pre-fix answer would have the same shape as the post-fix one; on pre-fix code
  // this endpoint does not exist and returns Next's 404 HTML.
  {
    const tkTrainer = (await req("POST", "/api/trainers", {
      name: "Tracker Trainer " + stamp, phone: "91111" + stamp.slice(0, 5),
      skills: ["TestSkill" + stamp], pipeline_status: "Fresh Lead",
    }, 201)).data.item;
    // Dates on the TRAINER, which is where his columns 5-13 live.
    //
    // MEASURED, not assumed: nsdc_submitted_on / nsdc_result_on / paid_on are NOT settable through
    // this door and should not be - the pipeline transitions stamp them, which is why the trainer
    // journey is a journey and not a form. The first draft of this pin set them anyway; `pick()`
    // dropped them silently, the door still answered 200, and the assertion failed with three
    // nulls. The three dates below ARE editable, because they are exactly the three that had
    // nowhere to live before this unit.
    await req("PATCH", `/api/trainers/${tkTrainer._id}`, {
      sidh_profile_verified_on: "2027-01-02", eligibility_checked_on: "2027-01-03",
      tot_result_expected_on: "2027-02-10",
    }, 200);
    // QA-689 (checker on qa-192 cycle 2): the pipeline-stamped three - nsdc_submitted_on,
    // nsdc_result_on, paid_on - are refused on the plain PATCH above (QA-523) and were never
    // populated anywhere else in this fixture either, so they sat null on every "Fresh Lead"
    // trainer and "Not needed" on every certified one: two values, but never DIFFERING WITHIN a
    // swapped pair, which is what let break H (a swap between exactly two of these) through
    // invisibly. correctTrainerDates (the SAME door -173's own correction PATCH uses, not the
    // refused door above) sets them directly - it is a real, shipped feature ("agar koi wrong
    // value set ho gayi toh baad me edit nahi kar pa raha hai", Umesh 22/08), not a test backdoor.
    await req("PATCH", `/api/trainers/${tkTrainer._id}/transition`, {
      nsdc_submitted_on: "2026-01-15", nsdc_result_on: "2026-01-20", paid_on: "2026-01-25",
    }, 200);

    // TWO batches, ONE trainer. This is the case the whole design turns on.
    const tkA = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: tkTrainer._id, planned_start: "2029-03-01", target_size: 3 }, 201)).data.item;
    const tkB = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: tkTrainer._id, planned_start: "2029-04-01", target_size: 3 }, 201)).data.item;
    await req("PATCH", `/api/batches/${tkA._id}/milestones`, { create: true }, 200);
    await req("PATCH", `/api/batches/${tkB._id}/milestones`, { create: true }, 200);

    const tk = (await req("GET", "/api/plan-tracker", undefined, 200)).data;
    const rowA = (tk.rows ?? []).find((r) => String(r.batch?._id) === String(tkA._id));
    const rowB = (tk.rows ?? []).find((r) => String(r.batch?._id) === String(tkB._id));
    ok("QA-399 (-171) fixture guard: both batches appear as tracker rows (without this the next assertions prove nothing)",
      !!rowA && !!rowB, JSON.stringify({ a: !!rowA, b: !!rowB, n: (tk.rows ?? []).length }));

    // THE assertion this whole design turns on. Every trainer column is read off the trainer
    // document, so one trainer on two batches shows ONE set of dates on both rows - because it IS
    // one set. Any implementation that copied them onto the batch would give two copies free to
    // drift, and this fails the moment they do.
    ok("QA-399 (-171): ONE trainer on TWO batches shows ONE set of trainer dates - the same values on both rows, because it IS the same document",
      !!rowA && !!rowB
        && String(rowA.sidh_profile_verified_on) === String(rowB.sidh_profile_verified_on)
        && String(rowA.eligibility_checked_on) === String(rowB.eligibility_checked_on)
        && String(rowA.tot_result_expected_on) === String(rowB.tot_result_expected_on)
        && String(rowA.sidh_profile_verified_on ?? "").startsWith("2027-01-02"),
      JSON.stringify({ a: rowA?.sidh_profile_verified_on, b: rowB?.sidh_profile_verified_on }));
    // …and the pipeline-stamped half travels the same way: same object, so same value on both rows.
    ok("QA-399 (-171): the NSDC round-trip is read from the trainer too - identical on both rows whatever it holds",
      !!rowA && !!rowB
        && String(rowA.nsdc_submitted_on) === String(rowB.nsdc_submitted_on)
        && String(rowA.nsdc_result_on) === String(rowB.nsdc_result_on)
        && String(rowA.paid_on) === String(rowB.paid_on),
      JSON.stringify({ sub: [rowA?.nsdc_submitted_on, rowB?.nsdc_submitted_on], res: [rowA?.nsdc_result_on, rowB?.nsdc_result_on] }));

    ok("QA-399 (-171): his columns 5, 6 and 13 come off the trainer too - the three dates that had nowhere to live before",
      !!rowA
        && String(rowA.sidh_profile_verified_on ?? "").startsWith("2027-01-02")
        && String(rowA.eligibility_checked_on ?? "").startsWith("2027-01-03")
        && String(rowA.tot_result_expected_on ?? "").startsWith("2027-02-10"),
      JSON.stringify({ p: rowA?.sidh_profile_verified_on, e: rowA?.eligibility_checked_on, r: rowA?.tot_result_expected_on }));

    // All 18 of his columns, by name. A tracker that quietly drops one is a tracker he goes back
    // to Excel for.
    const need18 = ["sl", "location", "job_role", "batch", "trainer", "sidh_profile_verified_on",
      "eligibility_checked_on", "ready_for_tot", "nsdc_submitted_on", "nsdc_result_on", "paid_on",
      "tot_start", "tot_done_on", "tot_result_expected_on", "trainer_mapped_sidh", "mobilization",
      "enrollment_done", "planned_start", "planned_end"];
    ok("QA-399 (-171): every one of his 18 columns is present on the row",
      !!rowA && need18.every((k) => k in rowA), JSON.stringify(need18.filter((k) => !(rowA ?? {})[k] && !(k in (rowA ?? {})))));

    // Column 15 is a STATE and a COUNT ("Yes - 38"), and the count is derived from the roster,
    // never stored - trainers_required already carries the comment explaining why.
    const tkCand = (await req("POST", "/api/candidates", { name: "Tracker Cand " + stamp, phone: "93333" + stamp.slice(0, 5), location: loc._id, program: prog._id }, 201)).data.item;
    await req("POST", `/api/batches/${tkA._id}/members`, { candidate: tkCand._id }, 201);
    const tk2 = (await req("GET", "/api/plan-tracker", undefined, 200)).data;
    const rowA2 = (tk2.rows ?? []).find((r) => String(r.batch?._id) === String(tkA._id));
    ok("QA-399 (-171): column 15 carries a state AND a count, and the count is the roster - derived, never stored",
      rowA2?.mobilization?.count === 1 && typeof rowA2?.mobilization?.status === "string",
      JSON.stringify(rowA2?.mobilization));

    // A certified trainer's TOT columns read HIS word - "Not needed" - rather than sitting blank,
    // because blank reads as "nobody has done it yet". Rows 7, 14 and 15 of his own sheet.
    const tkCert = (await req("POST", "/api/trainers", { name: "Tracker Certified " + stamp, phone: "94444" + stamp.slice(0, 5), skills: ["TestSkill" + stamp], pipeline_status: "Certified", tr_id: "TRT" + stamp }, 201)).data.item;
    const tkC = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: tkCert._id, planned_start: "2029-05-01", target_size: 3 }, 201)).data.item;
    await req("PATCH", `/api/batches/${tkC._id}/milestones`, { create: true }, 200);
    const tk3 = (await req("GET", "/api/plan-tracker", undefined, 200)).data;
    const rowC = (tk3.rows ?? []).find((r) => String(r.batch?._id) === String(tkC._id));
    ok("QA-399 (-171): a certified trainer's TOT columns say \"Not needed\" - his own word - instead of leaving cells blank",
      rowC?.nsdc_submitted_on === "Not needed" && rowC?.tot_start === "Not needed" && rowC?.ready_for_tot === "Not needed",
      JSON.stringify({ sub: rowC?.nsdc_submitted_on, start: rowC?.tot_start, ready: rowC?.ready_for_tot }));

    // SCOPING from the SCOPED login: authz builds $in from .map(String) and mongoose does not
    // cast inside a pipeline. Four live defects came from that, and none is visible as an admin.
    const tkSpoc = await loginAs("spoc.jpr03@vidysea.com", "CiOnly@123");
    const scopedTk = await fetch(BASE + "/api/plan-tracker", { headers: { cookie: tkSpoc } });
    const scopedTkJson = await scopedTk.json().catch(() => ({}));
    const scopedBatches = (scopedTkJson.rows ?? []).map((r) => String(r.batch?._id));
    ok("QA-399 (-171): a scoped login sees only its own centres' batches - measured from that login",
      scopedTk.status === 200 && !scopedBatches.includes(String(tkA._id)),
      JSON.stringify({ status: scopedTk.status, n: scopedBatches.length, leaked: scopedBatches.includes(String(tkA._id)) }));

    // ---- QA-765: roz-basis mobilisation, inside column 15 ----
    // The CEO put this ABOVE reverse planning: "kitne candidate mobilise ho gaye, ek ek ke, abhi
    // tak, ROZ BASIS pe". Every read below is guarded before it is used - in a pre-fix run
    // `days` is undefined, and asserting on undefined.length is a suite crash, not a red pin.
    //
    // CYCLE 2, and this is the correction that matters. Cycle 1's version of this block made
    // e2e.mjs MACHINE-DEPENDENT for the first time - 1282/0 in IST, 1281/1 under TZ=UTC (QA-1132),
    // while the parent commit was 1266/0 in BOTH zones. The bucketing was never the problem: the
    // checker read the SAME stored rows through an IST server and a UTC server and got a
    // byte-identical payload (same md5). The problem was that my fixture wrote its rows over HTTP,
    // and the WRITE path is zone-dependent - the members route hands addMemberChecked a Date and
    // dayKey() reads LOCAL getters, so one HTTP body stores 2029-02-25 on an IST server and
    // 2029-02-24 on a UTC one. My pin therefore exercised write+read while its NAME claimed only
    // the read. A pin must claim exactly what it proves, so the timezone row is now SEEDED
    // DIRECTLY as a fixed BSON instant (the pattern this file already uses at :197 and :233) and
    // the assertion is named for the read. The write path's own zone-dependence is not this unit's
    // and stays on QA-1132's row rather than being smuggled into a rename.
    {
      const { MongoClient, ObjectId } = await import("mongodb");
      const mcQ = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
      await mcQ.connect();
      const dbQ = mcQ.db(process.env.MONGODB_DB || "center_erp_ci");
      const dCand = async (nm) => (await req("POST", "/api/candidates", {
        name: nm, phone: "9" + String(Date.now()).slice(-9), location: loc._id, program: prog._id,
      }, 201)).data.item;

      // tkA is planned to start 2029-03-01, and the server REFUSES a joining date after a batch's
      // planned start - correctly, because mobilisation happens BEFORE a batch begins, which is the
      // whole reason this view exists. These three go through the real door at 06:00Z, the same
      // calendar day in both zones (06:00 UTC / 11:30 IST), so the fixture itself cannot drift.
      const joins = ["2029-02-20T06:00:00Z", "2029-02-20T07:00:00Z", "2029-02-22T06:00:00Z"];
      let added = 0;
      for (let i = 0; i < joins.length; i++) {
        const c = await dCand("QA765 Mob " + i + " " + String(Date.now()).slice(-5));
        const r = await req("POST", `/api/batches/${tkA._id}/members`, { candidate: c._id, joined_on: joins[i] }, 201).catch(() => null);
        if (r) added++;
      }
      // The timezone row, seeded as a FIXED INSTANT so no server's clock can move it: 20:00 UTC on
      // the 24th IS 01:30 IST on the 25th. What this proves is the READ - that the bucketing asks
      // mongo for +05:30 and never consults the node process zone.
      const tzCand = await dCand("QA765 TZ " + String(Date.now()).slice(-5));
      await dbQ.collection("batchmembers").insertOne({
        batch: new ObjectId(String(tkA._id)), candidate: new ObjectId(String(tzCand._id)),
        joined_on: new Date("2029-02-24T20:00:00Z"), left_on: null,
        createdAt: new Date(), updatedAt: new Date(),
      });

      const tkD = (await req("GET", "/api/plan-tracker", undefined, 200)).data;
      const rowD = (tkD.rows ?? []).find((r) => String(r.batch?._id) === String(tkA._id));
      const days = Array.isArray(rowD?.mobilization?.days) ? rowD.mobilization.days : null;

      ok("QA-765 fixture guard: three roster rows through the door plus one seeded instant really landed on the tracker batch",
        added === 3 && (rowD?.mobilization?.count ?? 0) >= 4,
        JSON.stringify({ added, count: rowD?.mobilization?.count }));

      // 1. The series exists at all. FAILS before this unit - column 15 carried only
      //    {status, count} and nothing in the product could answer "kis din kitne".
      ok("QA-765: column 15 carries a day-by-day series, not just a total",
        !!days && days.length > 0 && days.every((d) => typeof d.joined === "number"),
        JSON.stringify(days));

      // 2. THE assertion the design turns on. The opened cell and the closed cell are ONE query,
      //    so the increments cannot fail to add up to the number printed beside them. An
      //    implementation that counted twice would drift the first time a member was dropped.
      ok("QA-765: the day increments sum EXACTLY to the count in the closed cell - one query, not two",
        !!days && days.length > 0 && days.reduce((a, d) => a + d.joined, 0) === rowD.mobilization.count,
        JSON.stringify({ sum: (days ?? []).reduce((a, d) => a + d.joined, 0), count: rowD?.mobilization?.count }));

      // 3. Cumulative is a real running total and ends on the count - he asked for "abhi tak",
      //    not for a column the reader has to add up themselves.
      ok("QA-765: cumulative is the running total and its last value IS the count",
        !!days && days.length > 0 && days.every((d, i) => d.cumulative === days.slice(0, i + 1).reduce((a, x) => a + x.joined, 0))
          && days[days.length - 1].cumulative === rowD.mobilization.count,
        JSON.stringify((days ?? []).map((d) => [d.date, d.joined, d.cumulative])));

      // 4. Ascending, so the curve reads left to right without the screen re-sorting it.
      ok("QA-765: dated days come back oldest-first",
        !!days && days.filter((d) => d.date).every((d, i, a) => i === 0 || a[i - 1].date < d.date),
        JSON.stringify((days ?? []).map((d) => d.date)));

      // 5. THE READ IS ZONE-PROOF. The row above was stored as a fixed instant, so this assertion
      //    has the same answer on an IST machine and a UTC one - which is what cycle 1's version
      //    CLAIMED in its name and did not deliver (QA-1132). Bucketing happens in mongo with a
      //    literal +05:30; move it into node's dayKey() and this splits by machine again.
      ok("QA-765: a roster row STORED at 20:00 UTC on the 24th is read onto the IST day (the 25th), not the UTC day (the 24th) - the bucketing does not consult the node process zone",
        !!days && days.some((d) => d.date === "2029-02-25") && !days.some((d) => d.date === "2029-02-24"),
        JSON.stringify({ tz: process.env.TZ ?? "(unset)", offsetMin: -new Date().getTimezoneOffset(), dates: (days ?? []).map((d) => d.date) }));

      // 6. Two on one day is ONE row carrying 2, not two rows - a bucket, not a log.
      ok("QA-765: two candidates joining on one day make ONE row of 2",
        !!days && (days.find((d) => d.date === "2029-02-20")?.joined ?? 0) === 2,
        JSON.stringify(days?.find((d) => d.date === "2029-02-20")));

      // 7. QA-1133 (checker, cycle 1): $dateToString THROWS on a non-Date, and cycle 1's version
      //    let that throw take the WHOLE tracker down - every row, every user, plus the export that
      //    shares the function. At the parent this row was harmless because the group stage never
      //    looked at joined_on. Seeded on tkB so tkA's series above is untouched, and removed after.
      // Its OWN candidate: BatchMember carries a partial-unique index on {candidate} where
      // left_on is null (models:588), so one person can be active on only one batch. Reusing
      // tzCand here threw E11000 and took the suite down - my mistake, caught by the index doing
      // exactly its job.
      const badCand = await dCand("QA765 Bad " + String(Date.now()).slice(-5));
      const badId = (await dbQ.collection("batchmembers").insertOne({
        batch: new ObjectId(String(tkB._id)), candidate: new ObjectId(String(badCand._id)),
        joined_on: "2029-01-05", left_on: null, createdAt: new Date(), updatedAt: new Date(),
      })).insertedId;
      const hurt = await req("GET", "/api/plan-tracker");
      const rowB = (hurt.data?.rows ?? []).find((r) => String(r.batch?._id) === String(tkB._id));
      const daysB = Array.isArray(rowB?.mobilization?.days) ? rowB.mobilization.days : null;
      ok("QA-1133: one roster row with an unreadable joining date costs THAT ROW, not the whole tracker - the screen still answers 200",
        hurt.status === 200, JSON.stringify({ status: hurt.status }));
      ok("QA-1133: the undated row is still COUNTED (count === sum of days holds) and its date comes back null, for the screen to name in words rather than print as 'null'",
        !!daysB && daysB.reduce((a, d) => a + d.joined, 0) === rowB.mobilization.count
          && daysB.some((d) => d.date === null),
        JSON.stringify({ days: daysB, count: rowB?.mobilization?.count }));
      await dbQ.collection("batchmembers").deleteOne({ _id: badId });
      await mcQ.close();
    }

    // ---- -174 (QA-526): the planning table downloads ----
    // The report got an export in -170 because Manish sir asked. Nobody asked for this one, and
    // that is the reason it exists: Karunn sir keeps this table in a SPREADSHEET today, so a
    // version he cannot download is a version he reads once and then goes back to Excel for.
    //
    // Every read below is guarded before it is used. In a pre-fix run this route does not exist,
    // so the answer is a 404 HTML page - three suite crashes in -170 were all the same mistake:
    // assuming the response has the shape the feature would have given it.
    {
      const ex = await fetch(BASE + "/api/plan-tracker/export", { headers: { cookie } });
      const exBuf = Buffer.from(await ex.arrayBuffer().catch(() => new ArrayBuffer(0)));
      const isXlsx = ex.status === 200 && exBuf.length > 4 && exBuf.slice(0, 2).toString() === "PK"
        && /spreadsheetml/.test(ex.headers.get("content-type") ?? "");
      ok("QA-526 (-174): the planning table downloads as a real xlsx",
        isXlsx,
        `status=${ex.status} ct=${ex.headers.get("content-type")} len=${exBuf.length}`);

      // Same rows as the screen. An export that recomputes is an export that eventually
      // disagrees, and then nobody can say which one is the plan.
      let exCodes = null, exCols = null, exRows = null;
      if (isXlsx) {
        try {
          const wb = XLSX.read(exBuf, { type: "buffer" });
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
          exRows = rows;
          exCodes = rows.map((r) => String(r.Batch ?? "")).filter(Boolean);
          exCols = Object.keys(rows[0] ?? {});
        } catch { /* left null - the assertions below fail loudly rather than crash the suite */ }
      }
      const screen = (await req("GET", "/api/plan-tracker", undefined, 200)).data;
      const screenCodes = (screen.rows ?? []).map((r) => String(r.batch?.code ?? "")).filter(Boolean);
      ok("QA-526 (-174): the file carries the SAME rows the screen carries - it reads planTrackerRows, it does not recount",
        !!exCodes && screenCodes.length > 0 && exCodes.length === screenCodes.length
          && screenCodes.every((c) => exCodes.includes(c)),
        JSON.stringify({ file: (exCodes ?? []).slice(0, 4), screen: screenCodes.slice(0, 4), nf: exCodes?.length ?? null, ns: screenCodes.length }));

      // His column order, his headings. A download that renames his columns is a download he has
      // to translate before he can use it.
      // QA-640 (-192): the expected names moved with the screen. They are now the same words on
      // both surfaces - the download used to say "TOT starts" where the screen said "Starts", which
      // is one column with two names depending on where you looked (QA-565's defect, alive here).
      // This pin reads the DOWNLOADED FILE, so it is the stronger of the two: the source scan in
      // check-user-copy can only see what was written, this sees what arrives.
      ok("QA-526 (-174) / QA-640: his own headings are on the file, not the API field names",
        !!exCols && ["SL#", "Location", "Job Role", "Batch", "Trainer Name", "TR ID",
          "TOT start date", "Expected batch start date", "Trainer available & ready for TOT",
          "Registration & enrolment done on SIDH"].every((h) => exCols.includes(h)),
        JSON.stringify({ cols: (exCols ?? []).slice(0, 8) }));
      // ...and no two of them are the same word. `Starts` and `Ends` each appeared twice on the
      // screen for two different dates; a download that did the same would be unusable as a sheet.
      ok("QA-640: no two columns of the download share a heading",
        !!exCols && new Set(exCols).size === exCols.length,
        JSON.stringify({ n: exCols?.length ?? null, unique: exCols ? new Set(exCols).size : null }));

      // ---- QA-672 (-203): the headings being RIGHT says nothing about what is UNDER them ----
      // The qa-192 checker swapped two value expressions in the export route so the file printed the
      // TOT END date under "TOT start date". Every heading pin above stayed green, because every
      // heading was still there and still unique. A column with the wrong data under a correct name
      // is worse than a renamed column: the reader has no way to notice.
      const dCell = (v) => (v == null ? "" : v === "Not needed" ? "Not needed" : String(v).slice(0, 10));
      const PAIRS = [
        ["Trainer profile verified on SIDH", "sidh_profile_verified_on"],
        ["Trainer eligibility check", "eligibility_checked_on"],
        ["Trainer available & ready for TOT", "ready_for_tot"],
        ["Profile submitted to SSC/NSDC", "nsdc_submitted_on"],
        ["SSC/NSDC approved the profile", "nsdc_result_on"],
        ["TOT fee paid to SSC/NSDC", "paid_on"],
        ["TOT start date", "tot_start"],
        ["TOT end date", "tot_done_on"],
        ["TOT result & certificate expected", "tot_result_expected_on"],
        ["Trainer mapped on SIDH portal", "trainer_mapped_sidh"],
        ["Registration & enrolment done on SIDH", "enrollment_done"],
        ["Expected batch start date", "planned_start"],
        ["Expected batch end date", "planned_end"],
      ];
      const byCode = new Map((screen.rows ?? []).map((r) => [String(r.batch?.code ?? ""), r]));
      const mismatches = [];
      for (const fileRow of exRows ?? []) {
        const src = byCode.get(String(fileRow.Batch ?? ""));
        if (!src) continue;
        for (const [heading, field] of PAIRS) {
          const want = dCell(src[field]);
          const got = String(fileRow[heading] ?? "");
          if (want !== got) mismatches.push({ batch: fileRow.Batch, heading, want, got });
        }
      }
      ok("QA-672: every column of the download carries the value the screen has under that same name",
        !!exRows && byCode.size > 0 && mismatches.length === 0,
        JSON.stringify({ checked: byCode.size, bad: mismatches.slice(0, 3) }));

      // ...and the fixture must actually be able to catch a SWAP. If every mapped column holds the
      // same value on every row, the pin above passes whatever order they are printed in - which is
      // the "cannot fail" shape this whole block exists to close, one level deeper.
      // QA-689 (checker on qa-192 cycle 2): "at least 2 columns vary" let break H through - it swapped
      // nsdc_submitted_on <-> nsdc_result_on, a pair that is UNIFORM in this fixture (both null on the
      // Fresh-Lead trainer, both "Not needed" on the certified one), while six OTHER columns varied
      // and satisfied the >=2 threshold. Varying is a PER-PAIR property: a swap between two uniform
      // columns is invisible no matter how many other columns move. Every mapped column must vary.
      const distinctPerCol = PAIRS.map(([h]) => new Set((exRows ?? []).map((r) => String(r[h] ?? ""))).size);
      const uniformCols = PAIRS.filter((_, i) => distinctPerCol[i] < 2).map(([h]) => h);
      ok("QA-689: the fixture varies enough for that check to notice a swap between ANY pair, not just some",
        !!exRows && uniformCols.length === 0,
        JSON.stringify({ uniform: uniformCols, perColumn: Object.fromEntries(PAIRS.map(([h], i) => [h, distinctPerCol[i]])) }));

      // The scoping landmine, measured from the scoped login itself. authz builds its $in from
      // .map(String) and mongoose does not cast inside a pipeline - four live defects came from
      // exactly that, and none of them is visible from an admin session.
      const exScoped = await fetch(BASE + "/api/plan-tracker/export", { headers: { cookie: tkSpoc } });
      const exScopedBuf = Buffer.from(await exScoped.arrayBuffer().catch(() => new ArrayBuffer(0)));
      let scopedCodes = null;
      if (exScoped.status === 200 && exScopedBuf.length > 4 && exScopedBuf.slice(0, 2).toString() === "PK") {
        try {
          const wb2 = XLSX.read(exScopedBuf, { type: "buffer" });
          scopedCodes = XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]]).map((r) => String(r.Batch ?? ""));
        } catch { /* stays null */ }
      }
      ok("QA-526 (-174): a scoped login downloads only its own centres' rows",
        !!scopedCodes && !scopedCodes.includes(String(tkA.code)),
        JSON.stringify({ status: exScoped.status, n: scopedCodes?.length ?? null, leaked: scopedCodes ? scopedCodes.includes(String(tkA.code)) : null }));
    }

    for (const b of [tkA, tkB, tkC]) {
      await req("POST", `/api/batches/${b._id}/transition`, { target: "Cancelled", reason: "-171 QA-399 pin cleanup" }, 200);
    }
  }
  // ---- -170 (QA-398): the high-level report ----
  // Karunn sir, 18:51: "aapki ek ye high level aur doosra batch planning - bas in do mein saara
  // kaam nikal jaata hai." This is the first of the two, and these are the assertions that decide
  // whether it can be trusted.
  {
    // ONE centre, ONE job role, TWO programmes. This is the shape that breaks a report: a
    // programme is scheme-x-job-role fused, his columns are job roles alone, so two programmes
    // land on one cell. Writing cell[centre][role] = value is keep-last - and keep-last was
    // measured to leave Approved reading EXACTLY RIGHT while Target went quietly short, which
    // fools precisely the reviewer who checks the total that reconciles.
    const rpLoc = (await req("POST", "/api/locations", { code: "RP" + stamp, name: "TEST-Report " + stamp, approval_status: "Approved", city: "Meerut" }, 201)).data.item;
    const ROLE = "Report Role " + stamp;
    // Real schemes, and deliberately the live shape: Khurja and Madihan each carry an RPL-AVPL row
    // beside a PMKVY-BECIL one. The first draft invented "SchemeA"/"SchemeB", the product refused
    // them by its own enum, and the pin then died on undefined._id - taking every assertion after
    // it down with it. A fixture the product would never accept proves nothing either way.
    const rpA = (await req("POST", "/api/programs", { code: "RPA" + stamp, name: ROLE, scheme: "RPL-AVPL", trainer_skill: "RPSkillA" + stamp }, 201)).data.item;
    const rpB = (await req("POST", "/api/programs", { code: "RPB" + stamp, name: ROLE, scheme: "PMKVY-BECIL", trainer_skill: "RPSkillB" + stamp }, 201)).data.item;
    ok("-170 fixture guard: both programmes exist before anything is asserted about summing them",
      !!rpA?._id && !!rpB?._id, JSON.stringify({ a: rpA?._id ?? null, b: rpB?._id ?? null }));
    if (rpA?._id && rpB?._id) {
      await req("PUT", `/api/locations/${rpLoc._id}/targets`, { program: rpA._id, approved_target: 180, tc_status: "Approved" }, 200);
      await req("PUT", `/api/locations/${rpLoc._id}/targets`, { program: rpB._id, approved_target: 280, tc_status: "" }, 200);
    }

    const rep = (await req("GET", "/api/reports/rollup", undefined, 200)).data;
    const rpRow = (rep.rows ?? []).find((r) => String(r.location._id) === String(rpLoc._id));
    ok("QA-398 (-170): two programmes on ONE job role are SUMMED, not assigned - keep-last silently loses a target while the approved column still reconciles",
      rpRow?.cells?.[ROLE]?.target === 460,
      JSON.stringify({ target: rpRow?.cells?.[ROLE]?.target, expected: 460, cell: rpRow?.cells?.[ROLE] }));
    ok("QA-398 (-170): ...and Approved counts only the row whose TC Status actually reads Approved",
      rpRow?.cells?.[ROLE]?.approved === 180,
      JSON.stringify({ approved: rpRow?.cells?.[ROLE]?.approved, expected: 180 }));

    // The grand total has to reconcile from BOTH directions. A report that adds up one way and
    // not the other is a report with a hole somebody will find in front of the client.
    const byRow = (rep.rows ?? []).reduce((a, r) => a + (r.total?.target ?? 0), 0);
    const byRole = (rep.rows ?? []).reduce((a, r) => a + (rep.roles ?? []).reduce((b, role) => b + (r.cells?.[role]?.target ?? 0), 0), 0);
    ok("QA-398 (-170): the grand total reconciles by centre AND by job role, independently",
      !!rep.total && byRow === rep.total.target && byRole === rep.total.target,
      JSON.stringify({ byRow, byRole, grand: rep.total?.target ?? null }));

    // ---- QA-1074: the tiles are clickable, and what opens has to BE the tile ----
    // Umesh: "yeh total targets me main click karoon to woh mujhe 12,090 waali rows par le jaaye
    // na?" The panel is fed by `detail` — one entry per LocationTarget row, filled inside the same
    // loop that sums the cells — so the promise is that the panel's footer and the tile above it
    // are the same arithmetic done once. This is that promise, as an assertion, for EVERY measure
    // rather than for the one that happened to be checked by hand.
    {
      const keys = Object.keys(rep.labels ?? {});
      const off = keys.filter((k) => (rep.detail ?? []).reduce((a, d) => a + (d[k] || 0), 0) !== rep.total?.[k]);
      ok("QA-1074: sum(detail[k]) === total[k] for EVERY measure - a tile and the panel it opens cannot disagree",
        keys.length === 7 && off.length === 0,
        JSON.stringify({ keys: keys.length, mismatched: off.map((k) => ({ k, detail: (rep.detail ?? []).reduce((a, d) => a + (d[k] || 0), 0), total: rep.total?.[k] })) }));

      // The fixture's own two rows, found in `detail` by (centre, job role). They were created one
      // Approved and one blank a few lines above, so this pin also proves `row_status` is the ROW's
      // status and not the centre's - the whole point of shipping both.
      const mine = (rep.detail ?? []).filter((d) => String(d.location?._id) === String(rpLoc._id));
      ok("QA-1074: detail carries one row per (centre x job role) target row, each with its OWN tc_status beside the centre's",
        mine.length === 2
        && mine.every((d) => typeof d.row_status === "string" && typeof d.centre_status === "string" && d.role === ROLE)
        && mine.filter((d) => d.row_status === "Approved").length === 1
        && mine.filter((d) => d.row_status === "").length === 1,
        JSON.stringify(mine.map((d) => ({ role: d.role, code: d.program_code, target: d.target, row: d.row_status, centre: d.centre_status }))));

      // QA-1074 - the vocabulary Umesh chose, shipped from the server so the tile, the table header
      // and the Excel info tab cannot drift into three different words for one measure.
      ok("QA-1074: the report names its own measures - Total Target / Approved Target / Pending Target",
        rep.labels?.target?.label === "Total Target" && rep.labels?.approved?.label === "Approved Target"
        && rep.labels?.unknown?.label === "Pending Target" && rep.labels?.unknown?.short === "Pending",
        JSON.stringify(rep.labels ?? null));
    }

    // Mobilised is every candidate for that centre x job role at any stage, off
    // Candidate.location + Candidate.program. NOT interested_programs - measured, those carry
    // data on 2 of 252 records, so a report built on them reads near-empty and gets believed.
    if (rpA?._id) await req("POST", "/api/candidates", { name: "Report Cand " + stamp, phone: "92222" + stamp.slice(0, 5), location: rpLoc._id, program: rpA._id }, 201);
    const rep2 = (await req("GET", "/api/reports/rollup", undefined, 200)).data;
    // QA-1074 - the stamp that ends the "Passed is under-counting" class of report. It was measured
    // that /reports drops none of the 53 Pass results; 27 of them were simply entered after the tab
    // in the screenshot had loaded, and the screen had no way to say so. A timestamp that could
    // never differ between two reads would be decoration - so the pin is that it MOVES, not merely
    // that it is present (QA-212). Several API calls separate these two reads.
    ok("QA-1074: every rollup says when it was counted, and a later read says a later time",
      !!rep.measured_at && !!rep2.measured_at && Date.parse(rep2.measured_at) > Date.parse(rep.measured_at),
      JSON.stringify({ first: rep.measured_at, second: rep2.measured_at }));
    const rpRow2 = (rep2.rows ?? []).find((r) => String(r.location._id) === String(rpLoc._id));
    // QA-556 (-177) - THIS PIN'S RULE CHANGED, on Umesh's instruction, and the old assertion is
    // rewritten rather than deleted so the change is visible in the diff. It used to read
    // "Mobilised counts a candidate at ANY stage" and assert mobilised === 1 for a candidate who
    // was on no batch at all. He corrected the column's own stated source on the live screen:
    // "mobilized vo hoga jo koi bhi ENROLLED hoga uss batch mai. enrollment is needed."
    //
    // So the same fixture now proves the OPPOSITE, and that is the point: a candidate typed into
    // the pool is not mobilised until they are actually on a batch.
    ok("QA-556 (-177): a candidate entered but NOT on any batch is not counted as mobilised - enrolment is what mobilised means",
      rpRow2?.cells?.[ROLE]?.mobilised === 0 && rpRow2?.cells?.[ROLE]?.in_training === 0,
      JSON.stringify({ mob: rpRow2?.cells?.[ROLE]?.mobilised, intrg: rpRow2?.cells?.[ROLE]?.in_training }));

    // ...and the moment they ARE enrolled onto a batch here, they count. Same candidate, one
    // roster row of difference - which is exactly the line Umesh drew.
    {
      const mobBatch = (await req("POST", "/api/batches", { location: rpLoc._id, program: rpA._id, planned_start: "2029-04-02", target_size: 5 }, 201)).data.item;
      const mobCand = (await req("GET", "/api/candidates?limit=200", undefined, 200)).data.items.find((x) => x.name === "Report Cand " + stamp);
      ok("-177 fixture guard: the batch and the candidate both exist before the enrolment is asserted",
        !!mobBatch?._id && !!mobCand?._id, JSON.stringify({ b: mobBatch?._id ?? null, c: mobCand?._id ?? null }));
      if (mobBatch?._id && mobCand?._id) {
        await req("POST", `/api/batches/${mobBatch._id}/members`, { candidate: mobCand._id }, 201);
        const rep2b = (await req("GET", "/api/reports/rollup", undefined, 200)).data;
        const row2b = (rep2b.rows ?? []).find((r) => String(r.location._id) === String(rpLoc._id));
        ok("QA-556 (-177): once enrolled onto a batch at this centre x job role, the SAME candidate counts as mobilised",
          row2b?.cells?.[ROLE]?.mobilised === 1,
          JSON.stringify({ mob: row2b?.cells?.[ROLE]?.mobilised, intrg: row2b?.cells?.[ROLE]?.in_training }));

        // The column's stated source has to say the new rule too - the screen prints it, and a
        // definition that changed in code and not in the sentence beside it is how a reader ends
        // up trusting the wrong one.
        ok("QA-556 (-177): the stated source says mobilised means ENROLLED, not merely entered",
          /ENROLLED onto a batch/i.test(rep2b.sources?.mobilised ?? ""),
          JSON.stringify({ m: (rep2b.sources?.mobilised ?? "").slice(0, 110) }));

        await req("POST", `/api/batches/${mobBatch._id}/transition`, { target: "Cancelled", reason: "-177 QA-559 pin cleanup" }, 200);
      }
    }

    // ---- -253 (Umesh, on the client's own OneDrive sheet's Batch ID column): "location wise,
    // batch wise analytics" ----
    // Three things pinned on the SAME (rpLoc, rpA) fixture the -170/-177 blocks above already
    // built: (a) a batch's own detail row carries its own count and the centre row for that
    // (location, role) drops to zero on the three batch-scoped measures; (b) a candidate who
    // switches batches at the SAME centre x role is counted once, under their LATEST membership,
    // not once per batch; (c) a batch with no activity still gets its own row, at zero, never
    // absent; (d) rpB - which has a target but never gets a batch anywhere in this file - keeps
    // exactly the one placeholder row it always had. rpA and rpB share one `role` string on
    // purpose (the -170 fixture's whole point), so every lookup below disambiguates on
    // `program_code`, never on `role` alone.
    {
      const batX = (await req("POST", "/api/batches", { location: rpLoc._id, program: rpA._id, planned_start: "2029-05-01", target_size: 5 }, 201)).data.item;
      const batY = (await req("POST", "/api/batches", { location: rpLoc._id, program: rpA._id, planned_start: "2029-05-02", target_size: 5 }, 201)).data.item;
      const batZ = (await req("POST", "/api/batches", { location: rpLoc._id, program: rpA._id, planned_start: "2029-05-03", target_size: 5 }, 201)).data.item;
      const swCand = (await req("POST", "/api/candidates", { name: "Report Switch " + stamp, phone: "93222" + stamp.slice(0, 5), location: rpLoc._id, program: rpA._id }, 201)).data.item;
      ok("-253 fixture: three batches and one candidate exist before anything batch-wise is asserted",
        !!batX?._id && !!batY?._id && !!batZ?._id && !!swCand?._id,
        JSON.stringify({ x: batX?._id ?? null, y: batY?._id ?? null, z: batZ?._id ?? null, c: swCand?._id ?? null }));

      if (batX?._id && batY?._id && batZ?._id && swCand?._id) {
        const forA = (rep) => (rep.detail ?? []).filter((d) => String(d.location?._id) === String(rpLoc._id) && d.program_code === rpA.code);

        // (a) enrol into Batch X - its own row shows mobilised 1, the centre row for (rpLoc, rpA)
        // reads zero on all three batch-scoped measures (they now live on the batch rows only).
        const memX = (await req("POST", `/api/batches/${batX._id}/members`, { candidate: swCand._id }, 201)).data.item;
        const repX = (await req("GET", "/api/reports/rollup", undefined, 200)).data;
        const detX = forA(repX);
        const rowX = detX.find((d) => String(d.batch?._id) === String(batX._id));
        const centreRowX = detX.find((d) => !d.batch);
        ok("-253: a batch's own detail row carries its OWN mobilised count, and the centre row for the same (location, role) reads zero on the batch-scoped measures",
          rowX?.mobilised === 1 && centreRowX?.mobilised === 0 && centreRowX?.in_training === 0 && centreRowX?.certified === 0,
          JSON.stringify({ rowX: rowX ? { mobilised: rowX.mobilised } : null, centreRowX: centreRowX ? { mobilised: centreRowX.mobilised, in_training: centreRowX.in_training, certified: centreRowX.certified } : null }));
        ok("-253: and the centre row's OWN measures - the ones this change must not touch - are exactly what they were set to, unaffected by any batch existing",
          centreRowX?.target === 180 && centreRowX?.approved === 180 && centreRowX?.row_status === "Approved",
          JSON.stringify({ target: centreRowX?.target, approved: centreRowX?.approved, row_status: centreRowX?.row_status }));
        ok("-253: the Batch ID travels on the row - code, govt_batch_id and status all present",
          rowX?.batch?.code === batX.code && "govt_batch_id" in (rowX?.batch ?? {}) && rowX?.batch?.status === "Planning",
          JSON.stringify(rowX?.batch ?? null));

        // (b) drop from Batch X, enrol into Batch Y (SAME centre x role) - only the LATEST
        // membership counts. Batch X's row must fall to zero, Batch Y's must show 1, and the
        // centre-level `cells` aggregate (untouched code, feeds the tile) must still read 1 - not
        // 2 - or the batch-rows' own sum would read higher than the tile above them.
        await req("POST", `/api/members/${memX._id}/drop`, { left_on: today, drop_reason: "-253 pin: switching batches" }, 200);
        await req("POST", `/api/batches/${batY._id}/members`, { candidate: swCand._id }, 201);
        const repY = (await req("GET", "/api/reports/rollup", undefined, 200)).data;
        const detY = forA(repY);
        const rowXafter = detY.find((d) => String(d.batch?._id) === String(batX._id));
        const rowY = detY.find((d) => String(d.batch?._id) === String(batY._id));
        const cellRow = (repY.rows ?? []).find((r) => String(r.location._id) === String(rpLoc._id));
        // The cell total is 2, not 1: the -177 block above already put `mobCand` on this same
        // (rpLoc, rpA) cell via `mobBatch`, and this candidate is a SECOND mobilised member of
        // that same cell - the row-level split is what this assertion is really pinning.
        ok("-253: switching batches at the same centre x role counts the candidate ONCE, under their LATEST membership - not once per batch",
          rowXafter?.mobilised === 0 && rowY?.mobilised === 1 && cellRow?.cells?.[ROLE]?.mobilised === 2,
          JSON.stringify({ x: rowXafter?.mobilised, y: rowY?.mobilised, cell: cellRow?.cells?.[ROLE]?.mobilised }));

        // (c) Batch Z has no members at all - it must still appear, at zero, not be silently left out.
        const rowZ = detY.find((d) => String(d.batch?._id) === String(batZ._id));
        ok("-253: a batch with no activity for these measures still gets its own row, at zero - not absent",
          !!rowZ && rowZ.mobilised === 0 && rowZ.in_training === 0 && rowZ.certified === 0,
          JSON.stringify(rowZ ?? null));

        // (d) rpB has a target (280, blank TC Status - set alongside rpA at the top of this
        // fixture) but never gets a batch anywhere in this file. It must keep exactly the ONE
        // placeholder row it has always had, values untouched.
        const detB = (repY.detail ?? []).filter((d) => String(d.location?._id) === String(rpLoc._id) && d.program_code === rpB.code);
        ok("-253: a (centre, role) with a target but NO batches anywhere keeps exactly the one placeholder row it always had",
          detB.length === 1 && detB[0].batch === null && detB[0].target === 280 && detB[0].row_status === "",
          JSON.stringify(detB));

        // (e) the invariant this whole change was designed around: every measure's full value
        // lives on exactly one kind of row (centre or batch), so summing `detail` still equals
        // `total` for all seven keys - re-asserted here, on a payload that NOW mixes both row
        // shapes, not merely inherited from the -170/QA-1074 read taken before any batch existed.
        {
          const keys = Object.keys(repY.labels ?? {});
          const off = keys.filter((k) => (repY.detail ?? []).reduce((a, d) => a + (d[k] || 0), 0) !== repY.total?.[k]);
          ok("-253: sum(detail[k]) === total[k] for every measure STILL holds once detail mixes centre rows and batch rows",
            keys.length === 7 && off.length === 0,
            JSON.stringify({ mismatched: off }));
        }

        // (f) -256 (Umesh, 2026-08-26): "agar batch bnn hi nhi skta tho vo batch successfull wali
        // report mai aayega bhi nhi naa. report mai location wise batch wise aana chaiyee data."
        // The batch-scoped drill now lists BATCH rows only - the centre placeholder rows are gone
        // from it. That is a client-side filter, so what has to be pinned here is the fact that
        // MAKES it free: every batch-scoped measure lives entirely on batch rows, so the footer
        // under a batch-only table is still the number on the tile. If a future change ever moves
        // any part of mobilised/in_training/certified onto a centre row, this goes red and the
        // drill silently under-reports rather than the wall telling anyone.
        {
          const batchOnly = (repY.detail ?? []).filter((d) => d.batch);
          const centreOnly = (repY.detail ?? []).filter((d) => !d.batch);
          const scoped = Object.entries(repY.labels ?? {}).filter(([, v]) => v && v.batch_scoped).map(([k]) => k);
          const offScoped = scoped.filter((k) => batchOnly.reduce((a, d) => a + (d[k] || 0), 0) !== repY.total?.[k]);
          const centreCarries = scoped.filter((k) => centreOnly.some((d) => (d[k] || 0) !== 0));
          ok("-256: every batch-scoped measure lives ENTIRELY on batch rows, so a drill that shows batches only still foots to its tile",
            scoped.length === 3 && offScoped.length === 0 && centreCarries.length === 0,
            JSON.stringify({ scoped, mismatched: offScoped, centreRowsCarryingBatchMeasures: centreCarries, centreRows: centreOnly.length, batchRows: batchOnly.length }));
          // ...and the centre rows that the drill drops are still THERE in the payload, carrying
          // their own target - they have not been deleted from the report, only from the batch view.
          ok("-256: the dropped centre rows still exist in the payload with their targets intact - the batch drill hides them, nothing deletes them",
            centreOnly.length > 0 && centreOnly.some((d) => (d.target || 0) > 0),
            JSON.stringify({ centreRows: centreOnly.length, withTarget: centreOnly.filter((d) => (d.target || 0) > 0).length }));
        }
      }
    }

    // -253: a source-level pin for the inline Batch ID edit - it must call the EXISTING batch
    // PATCH door, never a new endpoint. The filtering/rendering itself is client-side, so no HTTP
    // assertion can see it; the repo already runs source scans for exactly this reason (see the
    // `plannerLocations` pin further below in this same file).
    {
      const src = (await import("node:fs")).readFileSync("src/app/(app)/reports/page.tsx", "utf8");
      ok("-253: the inline Batch ID edit calls the batch's own PATCH door, not a new endpoint",
        /api\(`\/api\/batches\/\$\{row\.batch\._id\}`,\s*\{\s*method:\s*"PATCH"/.test(src),
        "BatchIdCell source pattern not found");
      // -256: the three client-side halves of the same unit. Written as SHAPE tests that the
      // pre-fix file fails: it had `disabled={busy || !canEdit}` with no read-only arm at all, and
      // `canEdit` ended in `&& !closed`, which is precisely the box that said "type ID" at somebody
      // who could not type in it.
      ok("-256: a Batch ID cell this login cannot edit renders the VALUE, never a box that refuses to be typed in",
        /if \(!canEdit\)\s*\{[\s\S]{0,600}?<span/.test(src) && !/disabled=\{busy \|\| !canEdit\}/.test(src),
        "expected a read-only arm before the input, and no `disabled={busy || !canEdit}` box");
      ok("-256: ...and a CLOSED batch's id is editable only by an Admin - the same rule api/batches/[id] enforces",
        /const canEdit = mayEdit && \(!closed \|\| role === "Admin"\)/.test(src),
        "expected canEdit to gate a closed batch on the Admin role");
      ok("-256: a batch-scoped drill lists batch rows ONLY - a row with no batch has no place in a batch report",
        /const drillRows = batchDrill\s*\r?\n\s*\? detailAll\.filter\(\(d\) => d\.batch\)/.test(src)
          && !/hasBatchFor/.test(src),
        "expected drillRows to keep only rows carrying a batch, and hasBatchFor to be gone");
      // QA-1288's own maker_note (quoting QA-246 "chaar jhoothi ginti"): a batch row's
      // target/approved/not_approved/unknown must render as "-" with an explanation, never as a
      // plain 0 - those measures belong to the centre x role, not to any one batch under it.
      ok("-253: a batch row dashes the four centre-only measures instead of printing a false zero",
        /r\.batch && !L\[k\]\?\.batch_scoped/.test(src) && /does not apply on a batch row/.test(src),
        "dash treatment for non-batch-scoped measures not found in drillNum");
    }

    // REQ-367: the sources travel WITH the payload, so the screen cannot render a number
    // whose origin only exists in someone's memory. The caveat is asserted too, because a reader
    // who sees Mobilised and In training almost equal would otherwise take that for a finding.
    //
    // -177: this assertion used to require the word "pre-batch pool" in the caveat, which was the
    // OLD apology - Mobilised counted every candidate record, so it tracked In training closely
    // and the caveat explained why. Umesh changed the rule (QA-559): mobilised means enrolled onto
    // a batch. The wall caught the stale words the same hour, which is the pin doing its job - a
    // definition that changes in code and not in the sentence beside it is how a reader ends up
    // trusting the wrong one. Rewritten to the NEW rule rather than loosened.
    ok("QA-398 (-170) / QA-556 (-177): every column carries a stated source, and Mobilised's says ENROLLED",
      typeof rep.sources?.target === "string" && /client sheet/i.test(rep.sources.target)
        && /our records/i.test(rep.sources.mobilised) && /ENROLLED onto a batch/i.test(rep.sources.mobilised)
        && /finished, failed or dropped/i.test(rep.sources.caveat),
      JSON.stringify(rep.sources));

    // SCOPING, run from the SCOPED login on purpose: authz builds its $in from .map(String), and
    // mongoose casts strings inside find() but NOT inside an aggregation pipeline. Four live
    // defects came from exactly that (QA-302/347/350/395), and none of them is visible from an
    // admin session.
    const rpSpoc = await loginAs("spoc.jpr03@vidysea.com", "CiOnly@123");
    const scopedRep = await fetch(BASE + "/api/reports/rollup", { headers: { cookie: rpSpoc } });
    // A 404 from a route that does not exist yet is Next's HTML page, not JSON. Parsing it
    // unguarded is how this pin took the suite down on its third attempt - the same shape as
    // the two crashes before it, in a raw fetch this time rather than a fixture.
    const scopedJson = await scopedRep.json().catch(() => ({}));
    const scopedIds = (scopedJson.rows ?? []).map((r) => String(r.location._id));
    ok("QA-398 (-170): a scoped login sees ONLY its own centres - measured from that login, never inferred from an admin view",
      scopedRep.status === 200 && scopedIds.length > 0 && !scopedIds.includes(String(rpLoc._id)),
      JSON.stringify({ status: scopedRep.status, n: scopedIds.length, leaked: scopedIds.includes(String(rpLoc._id)) }));

    // QA-441: the export must carry the SAME numbers. An export that recomputes is an export
    // that eventually disagrees, and then nobody can say which one is the report.
    const xl = await fetch(BASE + "/api/reports/rollup/export", { headers: { cookie } });
    const xlBuf = Buffer.from(await xl.arrayBuffer());
    // ---- -176 (QA-551): a snapshot for LOOKING at screens carries no live credential ----
    // A checker found this against the file QA-536 had just fixed. QA-536's lesson was written
    // as "the worst secret is a FIELD, not a collection" - and applying it, I stopped looking at
    // collections. publictokens is 59 rows of which 58 are active, the 32-hex token IS the
    // credential, and 45 of them open one NAMED candidate's whole record on the live site.
    //
    // A SOURCE pin, and labelled as one: mirror-prod.mjs talks to production, so no assertion
    // that RUNS it belongs in the wall. What can be checked mechanically is that the guard names
    // the collection - and that the rule and the list cannot drift apart again, which is exactly
    // how this was missed: the comment above SKIP already said "collections whose rows are
    // credentials or one-time tokens" and the set did not contain the one collection that is.
    {
      const mir = (await import("node:fs")).readFileSync("scripts/mirror-prod.mjs", "utf8");
      const skipLine = (mir.match(/const SKIP = new Set\(\[[^\]]*\]\)/) ?? [""])[0];
      ok("QA-551 (-176) [source pin]: the mirror refuses to copy publictokens - every row of it is a live credential",
        /publictokens/.test(skipLine), JSON.stringify({ skip: skipLine.slice(0, 160) }));

      // The other half of the same lesson: the FIELD redaction must still be there. Losing it
      // while adding the collection would be the same mistake with the halves swapped.
      ok("QA-536 (-176) [source pin]: and it still redacts the government-portal password field",
        /tc_password/.test(mir) && /REDACT/.test(mir), JSON.stringify({ hasRedact: /REDACT/.test(mir), hasTcPassword: /tc_password/.test(mir) }));

      // The guard that stops the mirror being written onto the host it was read from. It exists
      // because the first draft did exactly that, on production.
      ok("QA-530 (-176) [source pin]: and it refuses a target on the SAME HOST as the source",
        /SAME HOST as the source/.test(mir) && /MIRROR_TARGET_URL/.test(mir), JSON.stringify({ ok: /SAME HOST/.test(mir) }));
    }

    // ---- -176 (QA-552): an unrecognised status is NAMED, never absorbed ----
    // `unknown` is a DEFAULT bucket, so it takes a blank AND any word nobody taught tcVerdict -
    // and the screen labelled the whole bucket "BLANK". Same two-meanings-one-number defect that
    // QA-527 exists to end, one level down, written by me while fixing it. Karunn sir says
    // "transferable" out loud at 12:31 about the very rows in dispute.
    {
      const oddProg = (await req("POST", "/api/programs", { code: "RPD" + stamp, name: "Report Role Odd " + stamp, scheme: "RPL-AVPL", trainer_skill: "RPSkillD" + stamp }, 201)).data.item;
      ok("-176 fixture guard: the odd-status programme exists", !!oddProg?._id, JSON.stringify({ d: oddProg?._id ?? null }));
      if (oddProg?._id) {
        await req("PUT", `/api/locations/${rpLoc._id}/targets`, { program: oddProg._id, approved_target: 70, tc_status: "Transferable" }, 200);
        const rp4 = (await req("GET", "/api/reports/rollup", undefined, 200)).data;
        const odd = (rp4.unrecognised_status ?? []).find((u) => u.value === "Transferable");
        ok("QA-552 (-176): a status the report does not recognise is reported by NAME, not silently counted as blank",
          !!odd && odd.rows >= 1, JSON.stringify({ unrecognised: rp4.unrecognised_status ?? null }));

        // It still has to be COUNTED somewhere, or the row would stop adding up - the honest
        // place is `unknown`, and the screen says so rather than the label pretending it is blank.
        const bad4 = (rp4.rows ?? []).filter((r) => {
          const t = r.total ?? {};
          return (t.approved ?? 0) + (t.not_approved ?? 0) + (t.unknown ?? 0) !== (t.target ?? 0);
        });
        ok("QA-552 (-176): ...and the three buckets still add back to Target with it in play",
          bad4.length === 0, JSON.stringify({ offenders: bad4.slice(0, 2).map((r) => r.total) }));

        ok("QA-552 (-176): the stated source no longer claims the bucket is only blanks",
          /BLANK/.test(rp4.sources?.unknown ?? "") && /does not recognise|not recognise/.test(rp4.sources?.unknown ?? ""),
          JSON.stringify({ un: (rp4.sources?.unknown ?? "").slice(0, 120) }));

        // A clean sheet reports an EMPTY list, not a missing key - a caller should not have to
        // tell 'nothing odd' from 'this build does not check'.
        await req("PUT", `/api/locations/${rpLoc._id}/targets`, { program: oddProg._id, approved_target: 70, tc_status: "Approved" }, 200);
        const rp5 = (await req("GET", "/api/reports/rollup", undefined, 200)).data;
        ok("QA-552 (-176): with nothing odd in the data the list is present and EMPTY, not absent",
          Array.isArray(rp5.unrecognised_status) && rp5.unrecognised_status.length === 0,
          JSON.stringify({ v: rp5.unrecognised_status ?? null }));
      }
    }

    // ---- -175 (QA-527): a blank verdict is not a refusal ----
    // Umesh, reading the shipped report: "ye approved location ka hai ya not approved ka, vo pata
    // nahi chal raha." He was right, and the production data says why - measured 2026-08-21 over
    // all 55 rows: 31 Approved (7,315), 24 BLANK (4,775), and ZERO rows saying Unapproved. So the
    // figure the screen rendered as "0 approved" was, for a third of the target, nobody's decision
    // at all. Karunn sir asks for the split in his own words at 17:09 - "approve kitne hain, NOT
    // APPROVED kitne hain" - and at 13:08 says the blanks are why "koi reporting kabhi fix ho hi
    // nahi sakti".
    //
    // The fixture already above this block is exactly the shape: rpA is Approved 180 and rpB is
    // BLANK 280. A third programme is added under a DIFFERENT role name on purpose - putting it on
    // ROLE would change the 460 the sum-not-assign pin above asserts, and a pin that quietly moves
    // another pin's fixture is how a suite starts agreeing with itself instead of with the product.
    {
      const ROLE_U = "Report Role U " + stamp;
      const rpC = (await req("POST", "/api/programs", { code: "RPC" + stamp, name: ROLE_U, scheme: "RPL-AVPL", trainer_skill: "RPSkillC" + stamp }, 201)).data.item;
      ok("-175 fixture guard: the third programme exists before anything is asserted about it",
        !!rpC?._id, JSON.stringify({ c: rpC?._id ?? null }));
      if (rpC?._id) {
        await req("PUT", `/api/locations/${rpLoc._id}/targets`, { program: rpC._id, approved_target: 120, tc_status: "Unapproved" }, 200);
      }

      const rp3 = (await req("GET", "/api/reports/rollup", undefined, 200)).data;
      const row3 = (rp3.rows ?? []).find((r) => String(r.location._id) === String(rpLoc._id));
      const cellA = row3?.cells?.[ROLE] ?? {};
      const cellU = row3?.cells?.[ROLE_U] ?? {};

      // THE pin. rpB carries a blank TC Status, and blank must land in `unknown` - never in
      // not_approved, which would put a refusal in the client's mouth that nobody made.
      ok("QA-527 (-175): a BLANK TC Status counts as no verdict, not as a refusal",
        cellA.unknown === 280 && cellA.not_approved === 0,
        JSON.stringify({ unknown: cellA.unknown ?? null, not_approved: cellA.not_approved ?? null, approved: cellA.approved ?? null }));

      ok("QA-527 (-175): a row that really does say Unapproved counts as not approved",
        cellU.not_approved === 120 && cellU.unknown === 0 && cellU.approved === 0,
        JSON.stringify({ not_approved: cellU.not_approved ?? null, unknown: cellU.unknown ?? null }));

      // The three buckets must ADD BACK to target, on every row and on the grand total. Without
      // this a reader cannot check the split without a calculator, and a split nobody can check
      // is a split nobody trusts.
      const bad = (rp3.rows ?? []).filter((r) => {
        const t = r.total ?? {};
        return (t.approved ?? 0) + (t.not_approved ?? 0) + (t.unknown ?? 0) !== (t.target ?? 0);
      });
      ok("QA-527 (-175): approved + not approved + no verdict equals Target on EVERY row",
        bad.length === 0,
        JSON.stringify({ offenders: bad.slice(0, 3).map((r) => ({ n: r.location?.name, t: r.total })) }));

      const g = rp3.total ?? {};
      ok("QA-527 (-175): ...and on the grand total too",
        (g.approved ?? 0) + (g.not_approved ?? 0) + (g.unknown ?? 0) === (g.target ?? 0) && (g.target ?? 0) > 0,
        JSON.stringify({ grand: g }));

      // The two new figures say where they came from, on the payload, like every other column.
      ok("QA-527 (-175): both new columns carry a stated source",
        typeof rp3.sources?.not_approved === "string" && /BLANK/i.test(rp3.sources?.unknown ?? ""),
        JSON.stringify({ na: rp3.sources?.not_approved ?? null, un: rp3.sources?.unknown ?? null }));

      // ---- -175 (QA-528): the planner may only offer what is approved ----
      // Karunn sir, 08:21: "ek batch ki plan, and that is to be ONLY FOR APPROVE LOCATION AND
      // APPROVE COURSES", and 08:49: "approve location aur wo sab to DROPDOWN se aa jaayegi."
      // -174 shipped the centre select with every centre in it.
      const locsRes = (await req("GET", "/api/locations?limit=2000", undefined, 200)).data;
      const rpLocRow = (locsRes.items ?? []).find((l) => String(l._id) === String(rpLoc._id));
      const jr = rpLocRow?.job_roles ?? [];
      const byRole = Object.fromEntries(jr.map((r) => [r.program, r]));
      ok("QA-528 (-175): every job role on a centre carries its programme id, so a screen never has to match on the NAME",
        jr.length > 0 && jr.every((r) => !!r.program_id),
        JSON.stringify({ n: jr.length, missing: jr.filter((r) => !r.program_id).map((r) => r.program) }));

      // ONE definition of 'approved', decided on the server. A client re-testing the string would
      // be the second copy ARCHITECTURE section 3 exists to prevent.
      ok("QA-528 (-175): the server states the verdict - approved / not_approved / unknown - instead of leaving the caller to re-decide it",
        byRole[ROLE_U]?.tc_verdict === "not_approved" && jr.every((r) => ["approved", "not_approved", "unknown"].includes(r.tc_verdict)),
        JSON.stringify({ u: byRole[ROLE_U]?.tc_verdict ?? null, all: jr.map((r) => r.tc_verdict) }));

      // The value is typed by a human into a spreadsheet, so the comparison has to survive a
      // trailing space and a capital letter. A strict === would read "Approved " as not approved.
      if (rpC?._id) {
        await req("PUT", `/api/locations/${rpLoc._id}/targets`, { program: rpC._id, approved_target: 120, tc_status: "  approved " }, 200);
        const locs2 = (await req("GET", "/api/locations?limit=2000", undefined, 200)).data;
        const jr2 = (locs2.items ?? []).find((l) => String(l._id) === String(rpLoc._id))?.job_roles ?? [];
        ok("QA-528 (-175): \"  approved \" typed into a spreadsheet is still approved - the verdict trims and lowercases",
          (jr2.find((r) => r.program === ROLE_U) ?? {}).tc_verdict === "approved",
          JSON.stringify({ v: (jr2.find((r) => r.program === ROLE_U) ?? {}).tc_verdict ?? null }));
        // put it back so nothing after this block inherits a changed fixture
        await req("PUT", `/api/locations/${rpLoc._id}/targets`, { program: rpC._id, approved_target: 120, tc_status: "Unapproved" }, 200);
      }

      // A SOURCE-LEVEL pin, and it is labelled as one. The filtering itself is client-side, so no
      // HTTP assertion can see it - and the checker's -174 verdict made exactly this point: the
      // repo already runs source scans (check-user-copy, check-home-structure), a markup pin was
      // available, and a screenshot is not machine-repeatable. This is that pin.
      {
        const src = (await import("node:fs")).readFileSync("src/app/(app)/batches/page.tsx", "utf8");
        // `[^)]*` was wrong here on the first attempt and the wall caught it: the filter's own
        // arrow head `(l: any) =>` contains a `)`, so the class stopped before it ever reached
        // approval_status and the pin failed against code that was correct. A pin that fails for
        // its own reasons is worse than no pin - it teaches you to read past a FAIL.
        const derives = /plannerLocations\s*=\s*locations\.filter\([\s\S]{0,120}?approval_status/.test(src);
        // QA-553 (-176): the anti-regression half used to be anchored to the UI sentence "Not a
        // specific centre". That is ordinary copy, this repo edits copy constantly (check-user-copy
        // exists for it), and once the sentence changed the negative lookup could no longer match -
        // so the clause would go PERMANENTLY TRUE and the pin would quietly degrade to "a variable
        // called plannerLocations exists somewhere" while still reporting PASS. A pin that stops
        // testing without failing is worse than one that was never written.
        //
        // Anchored to STRUCTURE instead: the drawer must not map the unfiltered `locations` inside
        // any <select>, anywhere in the file. Copy can change freely; a revert to the full list
        // cannot.
        // Scoped to the PLANNER's own selects, identified by the handler they call. "No select in
        // this file maps `locations`" was the first attempt and it was wrong in the other
        // direction: the New Batch form's centre select maps the full list and SHOULD - you may
        // create a batch at a centre you cannot yet plan one at. A pin that forbids correct code is
        // as bad as one that permits broken code, and this one was caught by running it against
        // -175, where it failed a fix that was present.
        const selectBlocks = src.match(/<select[\s\S]*?<\/select>/g) ?? [];
        const plannerSelects = selectBlocks.filter((b) => /runPlanner\(/.test(b));
        const usesFiltered = plannerSelects.length > 0
          && plannerSelects.some((b) => /\{plannerLocations\.map\(/.test(b))
          && !plannerSelects.some((b) => /\{locations\.map\(/.test(b));
        ok("QA-528 (-175) [source pin]: the planner centre list is derived by filtering on approval_status, and the drawer renders THAT list - not the full one",
          derives && usesFiltered, JSON.stringify({ derives, usesFiltered }));
      }
    }

    ok("QA-441 (-170): the report downloads as a real xlsx",
      xl.status === 200 && xlBuf.slice(0, 2).toString() === "PK" && /spreadsheetml/.test(xl.headers.get("content-type") ?? ""),
      `status=${xl.status} ct=${xl.headers.get("content-type")} len=${xlBuf.length}`);
  }
  // (k) QA-509 (-168) - ONE earliest-possible-start, not four. The batch form computed it in the
  // browser, POST /api/batches computed it again, PATCH computed it a third time, and -164 added
  // a fourth that also knew about rooms and the trainer's concurrency cap. Four answers to one
  // question is how a screen and the server that serves it end up disagreeing about one centre.
  //
  // The pin is a DISAGREEMENT test, not a presence test: build a centre whose rooms are busy so
  // the room constraint is the binding one, then check that the create door, the reschedule door
  // and the planner endpoint all name the SAME date. The three old copies knew nothing about
  // rooms, so on this fixture they answered earlier than the truth - which is exactly the shape
  // of the bug and exactly what this catches.
  const busyLoc = (await req("POST", "/api/locations", { code: "EP" + stamp, name: "TEST-EarliestOne " + stamp, approval_status: "Approved", city: "Meerut" }, 201)).data.item;
  const busyRoom = (await req("POST", `/api/locations/${busyLoc._id}/rooms`, { name: "OnlyRoom", type: "Classroom" }, 201)).data.item;
  const busyTrainer = (await req("POST", "/api/trainers", { name: "Earliest Trainer " + stamp, phone: "93333" + stamp.slice(0, 5), skills: ["TestSkill" + stamp] }, 201)).data.item;
  // one live batch holding the only room well into the future
  const holder = (await req("POST", "/api/batches", { location: busyLoc._id, program: prog._id, trainer: busyTrainer._id, room: busyRoom._id, planned_start: "2029-06-01", target_size: 3 }, 201)).data.item;
  const epsRes = (await req("GET", `/api/plan-batch?start=2029-01-01&location=${busyLoc._id}&program=${prog._id}&trainer=${busyTrainer._id}`, undefined, 200)).data.earliest_possible_start;
  // SUPPORTING, not a pin: -164's implementation already knew about rooms, so this passes before
  // the collapse too. It is here to catch the collapse LOSING that knowledge, which is the way a
  // "make them all agree" change usually goes wrong - everyone agreeing on the weakest answer.
  ok("QA-509 (-168) [supporting]: the surviving definition still accounts for the room being held - the collapse did not agree DOWN to the old formula",
    !!epsRes && new Date(epsRes.date) > new Date("2029-06-01"),
    JSON.stringify({ date: epsRes?.date, basis: (epsRes?.basis ?? []).map((b) => [b.key, b.date]) }));
  ok("QA-509 (-168): ...and it comes with ONE note, assembled from that same reasoning",
    typeof epsRes?.note === "string" && epsRes.note.length > 0 && epsRes.note.includes("mobilise"),
    JSON.stringify({ note: epsRes?.note }));

  // the create door must quote the SAME date the planner just gave
  const dateIn = (msg) => (String(msg).match(/earliest possible start ([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4})/) ?? [])[1] ?? null;
  const created = await req("POST", "/api/batches", { location: busyLoc._id, program: prog._id, planned_start: "2029-01-15", target_size: 3 }, 201);
  const epsDay = new Date(epsRes.date).toLocaleDateString("en-IN");
  // Pre-fix this did not merely disagree - it said NOTHING. The old create-door formula was
  // max(mobilisation lead, trainer.available_from), which on this fixture lands in 2026, so a start
  // in Jan 2029 looked fine to it while the only room is held until mid-2029. Silence on a date
  // that cannot work is worse than a wrong date, because there is nothing for the operator to doubt.
  ok("QA-509 (-168): the CREATE door warns AT ALL, and with the same date the planner reports",
    dateIn(created.data.warning) === epsDay, JSON.stringify({ fromPlanner: epsDay, fromCreate: dateIn(created.data.warning), warning: String(created.data.warning ?? "").slice(0, 140) }));

  // and so must the reschedule door
  const resched = await req("PATCH", `/api/batches/${created.data.item._id}`, { planned_start: "2029-02-01" }, 200);
  ok("QA-509 (-168): the RESCHEDULE door agrees with both - a create and an edit cannot name different dates for one centre",
    dateIn(resched.data.warning) === epsDay, JSON.stringify({ fromPlanner: epsDay, fromReschedule: dateIn(resched.data.warning), warning: String(resched.data.warning ?? "").slice(0, 140) }));

  await req("POST", `/api/batches/${created.data.item._id}/transition`, { target: "Cancelled", reason: "-168 QA-509 pin cleanup" }, 200);
  await req("POST", `/api/batches/${holder._id}/transition`, { target: "Cancelled", reason: "-168 QA-509 pin cleanup" }, 200);

  // (i) QA-507 - cycle 1 claimed the DATE-ONLY arm was unreachable through the product and
  // therefore left it unpinned. That claim was wrong and a checker disproved it: Certified ->
  // Dropped -> Fresh Lead are ordinary TRAINER_FLOW edges and NOTHING ever clears tot_done_on.
  // So the arm is reachable, and here it is, pinned.
  // Free the trainer first. Rule: a trainer still assigned to a LIVE batch cannot be Dropped
  // (409, "Reassign that batch") - the first draft of this pin ignored that and both of its
  // transitions failed, which then made the second one report a misleading reason. The gate is
  // correct product behaviour, not an obstacle: it is why the reopened-trainer route is a real
  // route rather than a trick.
  await req("POST", `/api/batches/${dateBatch._id}/transition`, { target: "Cancelled", reason: "-164 c2: free the trainer for the QA-507 pin" }, 200);
  const reopened = (await req("POST", `/api/trainers/${pipeTrainer2._id}/transition`, { target: "Dropped", reason: "-164 c2: QA-507 pin" }, 200)).data.item;
  const back = (await req("POST", `/api/trainers/${pipeTrainer2._id}/transition`, { target: "Fresh Lead" }, 200)).data.item;
  ok("QA-507 (-164 c2) fixture guard: the reopened trainer really is out of Certified and STILL carries tot_done_on",
    back.pipeline_status === "Fresh Lead" && !!back.tot_done_on,
    JSON.stringify({ dropped: reopened.pipeline_status, now: back.pipeline_status, tot_done_on: back.tot_done_on }));
  const armBatch = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: pipeTrainer2._id, planned_start: "2028-10-01", target_size: 3 }, 201)).data.item;
  const armPlan = (await req("PATCH", `/api/batches/${armBatch._id}/milestones`, { create: true }, 200)).data.item;
  const armKeys = (armPlan.milestones ?? []).map((m) => m.key);
  ok("QA-507 (-164 c2): tot_done_on ALONE skips TOT - the date is the fact, the stage is not",
    !armKeys.includes("tot_start") && !armKeys.includes("tot_done") && !armKeys.includes("trainer_ready_for_tot") && armKeys.length === 5,
    JSON.stringify({ stage: back.pipeline_status, keys: armKeys }));
  await req("POST", `/api/batches/${armBatch._id}/transition`, { target: "Cancelled", reason: "-164 c2 pin cleanup" }, 200);
  await req("POST", `/api/batches/${lossBatch._id}/transition`, { target: "Cancelled", reason: "-164 c2 pin cleanup" }, 200);
  await req("POST", `/api/batches/${certBatch._id}/transition`, { target: "Cancelled", reason: "-164 planner pin cleanup" }, 200);
}


// ---- QA-152 part 2 (-82): the plan as an editable, shareable, exportable artifact ----
{
  const edited = (await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { edit: { key: "tot_done", due_date: "2027-03-20", notes: "TOT at Gurugram HO", owner_label: "Divya" } }, 200)).data.item;
  const td = edited.milestones.find((m) => m.key === "tot_done");
  ok("-82: planner edits a row (due date, notes, owner)", String(td.due_date).startsWith("2027-03-20") && td.notes === "TOT at Gurugram HO" && td.owner_label === "Divya", JSON.stringify(td));
  await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { edit: { key: "tot_done", label: "" } }, 400);
  const added = (await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { add: { label: "Lab equipment delivered", due_date: "2027-03-25", owner_label: "Ops" } }, 201)).data.item;
  const custom = added.milestones.find((m) => m.custom);
  ok("-82: planner adds a custom row, kept in date order", !!custom && custom.label === "Lab equipment delivered" && added.milestones.length === 9
    && added.milestones.every((m, i, a) => i === 0 || new Date(a[i - 1].due_date) <= new Date(m.due_date)), JSON.stringify(added.milestones.map((m) => [m.key, String(m.due_date).slice(0, 10)])));
  const planView = (await req("GET", `/api/batches/${planBatch._id}/plan`)).data;
  ok("-82: GET /plan returns the artifact (batch, 9 milestones, counts, plan_flags, no share yet)", planView.batch?.code === planBatch.code && planView.milestones?.length === 9 && planView.counts?.total === 9 && "tot_lead_ok" in (planView.plan_flags ?? {}) && planView.share === null, JSON.stringify({ n: planView.milestones?.length, counts: planView.counts, share: planView.share }));
  const xl = await fetch(BASE + `/api/batches/${planBatch._id}/plan/export`, { headers: { cookie } });
  const xlBuf = Buffer.from(await xl.arrayBuffer());
  ok("-82: Excel export is a real xlsx (PK zip header, xlsx content-type, filename carries the batch code)", xl.status === 200 && xlBuf.slice(0, 2).toString() === "PK" && /spreadsheetml/.test(xl.headers.get("content-type") ?? "") && (xl.headers.get("content-disposition") ?? "").includes(planBatch.code), `status=${xl.status} ct=${xl.headers.get("content-type")} len=${xlBuf.length}`);
  // share: read-only link
  // REQ-392: a plan share records WHO it went to. These two named people carry the -82 assertions
  // below unchanged - re-sharing to the SAME person still rotates that person's old link off - and
  // then QA-558 uses them to prove the thing that used to be broken: sending to one must not cut
  // off the other.
  const rcpA = { recipient_name: "Plan SPOC A", recipient_phone: "9" + Date.now().toString().slice(-9), recipient_role_label: "SPOC", recipient_ref: "spoc" };
  const rcpB = { recipient_name: "Plan Principal B", recipient_phone: "8" + Date.now().toString().slice(-9), recipient_role_label: "Principal", recipient_ref: "principal" };
  await req("POST", "/api/public-tokens", { purpose: "plan", batch: planBatch._id, ...rcpA, recipient_name: "" }, 400); // REQ-392: a share needs a person
  const linkRO = (await req("POST", "/api/public-tokens", { purpose: "plan", batch: planBatch._id, ...rcpA }, 201)).data.item;
  ok("-82: a plan link is minted (32-hex, purpose plan, read-only by default)", /^[a-f0-9]{32}$/.test(linkRO.token) && linkRO.purpose === "plan" && linkRO.allow_updates === false, JSON.stringify({ t: linkRO.token?.length, p: linkRO.purpose, u: linkRO.allow_updates }));
  const pub = await fetch(BASE + `/api/public/plan/${linkRO.token}`);
  const pubJ = await pub.json();
  ok("-82: the public plan opens with NO login and carries the same rows", pub.status === 200 && pubJ.milestones?.length === 9 && pubJ.batch?.code === planBatch.code && pubJ.allow_updates === false && !pubJ.batch?._id, JSON.stringify({ s: pub.status, n: pubJ.milestones?.length, code: pubJ.batch?.code, id: pubJ.batch?._id }));
  const pubTick = await fetch(BASE + `/api/public/plan/${linkRO.token}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "trainer_found", done: true }) });
  ok("-82: a read-only link cannot tick (403)", pubTick.status === 403, `status=${pubTick.status}`);
  const pubXl = await fetch(BASE + `/api/public/plan/${linkRO.token}?format=xlsx`);
  ok("-82: the public link also downloads the Excel", pubXl.status === 200 && /spreadsheetml/.test(pubXl.headers.get("content-type") ?? ""), `status=${pubXl.status}`);
  ok("-82: GET /plan now shows the active share link", (await req("GET", `/api/batches/${planBatch._id}/plan`)).data.share?.token === linkRO.token);
  // re-share as status-updatable: old link dies, new one ticks
  const linkRW = (await req("POST", "/api/public-tokens", { purpose: "plan", batch: planBatch._id, allow_updates: true, ...rcpA }, 201)).data.item;
  ok("-82: re-sharing to the SAME person switches that person's old link off", (await fetch(BASE + `/api/public/plan/${linkRO.token}`)).status === 404);

  // QA-558 / REQ-393 — the sharpest rule in the sharing contract, and the pin the contract itself
  // specified: "a test that shares to two different recipients and asserts both links stay active
  // fails now and passes after". Before this, public-tokens/route.ts revoked by BATCH, so sending
  // the Principal their plan silently killed the SPOC's working link and told neither of them. The
  // first symptom would have been a centre-side person reporting a dead link days later.
  const linkB = (await req("POST", "/api/public-tokens", { purpose: "plan", batch: planBatch._id, allow_updates: true, ...rcpB }, 201)).data.item;
  const aStillUp = await fetch(BASE + `/api/public/plan/${linkRW.token}`);
  const bUp = await fetch(BASE + `/api/public/plan/${linkB.token}`);
  ok("QA-558: sharing with a SECOND person leaves the first person's link working",
    aStillUp.status === 200 && bUp.status === 200,
    JSON.stringify({ first: aStillUp.status, second: bUp.status }));
  // ...and revocation is still real, scoped to the one person it belongs to. Re-shared to B rather
  // than to A on purpose: A's link is what the -82 assertions below go on to tick, and a pin that
  // quietly breaks the tests after it is a pin that will be deleted rather than understood.
  const linkB2 = (await req("POST", "/api/public-tokens", { purpose: "plan", batch: planBatch._id, allow_updates: true, ...rcpB }, 201)).data.item;
  const bOld = (await fetch(BASE + `/api/public/plan/${linkB.token}`)).status;
  const bNew = (await fetch(BASE + `/api/public/plan/${linkB2.token}`)).status;
  const aAfter = (await fetch(BASE + `/api/public/plan/${linkRW.token}`)).status;
  ok("QA-558: re-sharing to the second person kills ONLY that person's old link — the first person's is untouched",
    bOld === 404 && bNew === 200 && aAfter === 200,
    JSON.stringify({ oldB: bOld, newB: bNew, A: aAfter }));
  // REQ-392: the screen can now answer "who has what" before anything is sent.
  const planGet = (await req("GET", `/api/batches/${planBatch._id}/plan`)).data;
  ok("REQ-392: the plan lists every live share WITH the person it went to",
    (planGet.shares ?? []).length === 2
    && planGet.shares.some((s) => s.recipient_name === rcpA.recipient_name && s.recipient_role_label === "SPOC")
    && planGet.shares.some((s) => s.recipient_name === rcpB.recipient_name && s.recipient_role_label === "Principal"),
    JSON.stringify((planGet.shares ?? []).map((s) => `${s.recipient_name}/${s.recipient_role_label}`)));
  // QA-613: this used to be `Array.isArray(...)` alone, which passes on an empty list - so the
  // contract's recipient ORDER (SPOC, Principal, Cluster Head, then contacts[]) had no assertion at
  // all. A pin that cannot fail is not a pin.
  ok("REQ-392: ...and offers the centre's own people as recipients, in the contract's order, so the admin picks rather than types",
    Array.isArray(planGet.recipients) && planGet.recipients.length > 0
    && planGet.recipients.every((r) => r.name && r.role_label && r.ref && r.key)
    && planGet.recipients.map((r) => r.ref).join(",") === planGet.recipients.map((r) => r.ref).sort((a, b) => {
      const order = (x) => (x === "spoc" ? 0 : x === "principal" ? 1 : x === "cluster_head" ? 2 : 3 + Number(String(x).split(":")[1] ?? 0));
      return order(a) - order(b);
    }).join(","),
    JSON.stringify({ n: (planGet.recipients ?? []).length, refs: (planGet.recipients ?? []).map((r) => r.ref) }));

  // The suffix these three pins share. `s6` lives in e2e-sync.mjs, not here - I replaced one
  // undefined name with another and the suite crashed before a single one of them ran.
  const rs = "R" + Date.now().toString().slice(-6);
  // QA-611 — the S1 SURVIVED -191 and a checker proved it: -191 revoked on the phone STRING, so a
  // centre recording ONE landline for its SPOC and its Principal had them cutting each other off,
  // exactly as before. Nothing prevents that: Location phone fields take any string at all.
  const shared = "9" + Date.now().toString().slice(-9);
  // Two REAL contacts on this centre who happen to share one landline - the shape that broke -191,
  // and the shape a slot-based identity has to keep apart. Invented refs would simply be refused now.
  // Created HERE, not 2,500 lines earlier: the first version relied on two contacts added at the
  // location's creation and something between had replaced that array, so the pair came back empty
  // and the block crashed on `undefined.token` before testing anything. A fixture that depends on
  // distant state is a fixture that fails for reasons unrelated to what it checks. Appended rather
  // than replacing, so nothing else on this centre is disturbed.
  const locBefore = (await req("GET", `/api/locations/${loc._id}`)).data.item;
  await req("PATCH", `/api/locations/${loc._id}`, { contacts: [
    ...(locBefore.contacts ?? []).map((c) => ({ _id: c._id, name: c.name, phone: c.phone, role_label: c.role_label })),
    { name: "Shared Line One " + rs, role_label: "SPOC" },
    { name: "Shared Line Two " + rs, role_label: "Principal" },
  ] }, 200);
  const planLocNow = (await req("GET", `/api/locations/${loc._id}`)).data.item;
  const sharedPair = (planLocNow.contacts ?? []).filter((c) => String(c.name).startsWith("Shared Line"));
  ok("QA-621 fixture: the two same-phone contacts really exist on this centre before they are used",
    sharedPair.length === 2, JSON.stringify({ n: sharedPair.length }));
  const twoOnOneNumber = sharedPair.map((c) => ({ recipient_name: c.name, recipient_phone: shared, recipient_role_label: c.role_label, recipient_ref: `contact:${c._id}` }));
  const tokA = (await req("POST", "/api/public-tokens", { purpose: "plan", batch: planBatch._id, ...twoOnOneNumber[0] }, 201)).data.item;
  const tokB = (await req("POST", "/api/public-tokens", { purpose: "plan", batch: planBatch._id, ...twoOnOneNumber[1] }, 201)).data.item;
  const sharedA = (await fetch(BASE + `/api/public/plan/${tokA.token}`)).status;
  const sharedB = (await fetch(BASE + `/api/public/plan/${tokB.token}`)).status;
  ok("QA-611: two people who share ONE phone number are two people - sending to the second does not cut off the first",
    sharedA === 200 && sharedB === 200, JSON.stringify({ spoc: sharedA, principal: sharedB }));

  // QA-612 / QA-618 / QA-621 — a TYPED recipient is now refused outright, and that is the point.
  // Four releases tried to work out who a typed name meant: -191 by phone, -193 by slot number,
  // -194 by name+role. The last created a NEW S1 - two different people who share a name and a role
  // label cut each other's links off - which a checker proved by running one script against a -193
  // server and a -194 server. There is no attribute of a person that is safe to use as their
  // identity, so the product asks WHICH of the centre's people this is, and refuses to guess.
  const typed = await req("POST", "/api/public-tokens", { purpose: "plan", batch: planBatch._id, recipient_name: "Typed Person " + rs, recipient_role_label: "Contact" }, 400);
  ok("QA-621: a plan link that does not say WHICH of the centre's people it is for is refused, not guessed at",
    typed.status === 400 && /name WHICH of the centre's people/i.test(String(typed.data?.error ?? "")),
    JSON.stringify({ status: typed.status, error: String(typed.data?.error ?? "").slice(0, 90) }));
  const stale = await req("POST", "/api/public-tokens", { purpose: "plan", batch: planBatch._id, recipient_name: "Gone Person " + rs, recipient_role_label: "Contact", recipient_ref: "contact:6a00000000000000000000ff" }, 400);
  ok("QA-621: ...and a slot that centre no longer has is refused too, rather than pointing at whoever is there now",
    stale.status === 400 && /not one of this centre's contacts/i.test(String(stale.data?.error ?? "")),
    JSON.stringify({ status: stale.status }));

  // QA-615 — the S1's THIRD shape, and the checker's own reproduction, run through the product's
  // API exactly as it did: share with someone, let an admin REMOVE an earlier contact so everyone
  // below shifts up a slot, then share with whoever now occupies the departed slot. On -193 that
  // revoked the first person's live link, because their key was the slot number.
  const cs = "C" + Date.now().toString().slice(-6);
  const shiftLoc = (await req("POST", "/api/locations", { code: "SH" + cs, name: "Shift Centre " + cs, external_id: "SH" + cs, approval_status: "Approved", city: "Kanpur",
    contacts: [{ name: "Alice " + cs, role_label: "Contact" }, { name: "Bob " + cs, role_label: "Contact" }, { name: "Carol " + cs, role_label: "Contact" }, { name: "Dave " + cs, role_label: "Contact" }] }, 201)).data.item;
  const shiftBatch = (await req("POST", "/api/batches", { location: shiftLoc._id, program: prog._id, planned_start: "2027-06-01", target_size: 3 }, 201)).data.item;
  await req("PATCH", `/api/batches/${shiftBatch._id}/milestones`, { create: true }, 200);
  const offered1 = (await req("GET", `/api/batches/${shiftBatch._id}/plan`)).data.recipients ?? [];
  const carol = offered1.find((r) => String(r.name).startsWith("Carol"));
  const carolTok = (await req("POST", "/api/public-tokens", { purpose: "plan", batch: shiftBatch._id, recipient_name: carol.name, recipient_phone: carol.phone, recipient_role_label: carol.role_label, recipient_ref: carol.ref }, 201)).data.item;
  // The admin removes Bob. Everyone below him slides up one slot.
  // QA-624: this used to strip `_id` here, which regenerated every contact id and so made the two
  // keys unable to collide - the pin could not fail for the property it claims to test. It now sends
  // `_id` back, exactly as the Locations screen does since QA-622, so the ids really are stable and
  // the collision really is possible.
  await req("PATCH", `/api/locations/${shiftLoc._id}`, { contacts: (shiftLoc.contacts ?? []).filter((c) => !String(c.name).startsWith("Bob")).map((c) => ({ _id: c._id, name: c.name, phone: c.phone, role_label: c.role_label })) }, 200);
  const offered2 = (await req("GET", `/api/batches/${shiftBatch._id}/plan`)).data.recipients ?? [];
  const dave = offered2.find((r) => String(r.name).startsWith("Dave"));
  const daveTok = (await req("POST", "/api/public-tokens", { purpose: "plan", batch: shiftBatch._id, recipient_name: dave.name, recipient_phone: dave.phone, recipient_role_label: dave.role_label, recipient_ref: dave.ref }, 201)).data.item;
  const carolLive = (await fetch(BASE + `/api/public/plan/${carolTok.token}`)).status;
  const daveLive = (await fetch(BASE + `/api/public/plan/${daveTok.token}`)).status;
  ok("QA-615: removing a contact must not hand one person's link to another - sending to the person who moved INTO a freed slot leaves the previous occupant's link alive",
    carolLive === 200 && daveLive === 200,
    JSON.stringify({ carol: carolLive, dave: daveLive }));

  // QA-622 — the half the QA-615 pin never asked, and the half that was still broken: after that
  // edit, is Carol still HERSELF? Her id has to survive the save, or her own key matches nothing and
  // re-sending to her ADDS a second live link instead of replacing hers, while the screen shows her
  // as never sent to. That is what a maker found by reading, and a checker then measured.
  const offered3 = (await req("GET", `/api/batches/${shiftBatch._id}/plan`)).data.recipients ?? [];
  const carolAfter = offered3.find((r) => String(r.name).startsWith("Carol"));
  ok("QA-622: a contact keeps its identity across an unrelated edit to the centre's contact list",
    !!carolAfter && carolAfter.ref === carol.ref,
    JSON.stringify({ before: carol.ref, after: carolAfter?.ref }));
  const carolAgain = (await req("POST", "/api/public-tokens", { purpose: "plan", batch: shiftBatch._id, recipient_name: carolAfter.name, recipient_phone: carolAfter.phone, recipient_role_label: carolAfter.role_label, recipient_ref: carolAfter.ref }, 201)).data.item;
  const carolOld = (await fetch(BASE + `/api/public/plan/${carolTok.token}`)).status;
  const carolNew = (await fetch(BASE + `/api/public/plan/${carolAgain.token}`)).status;
  ok("QA-622: ...so re-sending to her after that edit REPLACES her link rather than leaving two live",
    carolOld === 404 && carolNew === 200,
    JSON.stringify({ old: carolOld, fresh: carolNew }));

  // QA-616 / QA-623 — a token minted before shares had to name a slot carries no key. -194 tried to
  // INVENT one from the name, and a checker showed that could revoke a different same-named person.
  // Nothing is invented now: such a link is listed, marked as belonging to nobody the centre still
  // lists, and revoked by hand. What must NOT happen is it being silently matched to somebody.
  const alice = offered3.find((r) => String(r.name).startsWith("Alice"));
  const legacyTok = (await req("POST", "/api/public-tokens", { purpose: "plan", batch: shiftBatch._id, recipient_name: alice.name, recipient_phone: alice.phone, recipient_role_label: alice.role_label, recipient_ref: alice.ref }, 201)).data.item;
  {
    const { MongoClient, ObjectId } = await import("mongodb");
    const mc = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
    await mc.connect();
    // Exactly what a pre-rule row looks like: a recipient name, and no way to say which slot.
    await mc.db(process.env.MONGODB_DB).collection("publictokens")
      .updateOne({ _id: new ObjectId(String(legacyTok._id)) }, { $unset: { recipient_key: "", recipient_ref: "" } });
    await mc.close();
  }
  const afterLegacy = (await req("GET", `/api/batches/${shiftBatch._id}/plan`)).data;
  const legacyRow = (afterLegacy.shares ?? []).find((x) => x.token === legacyTok.token);
  ok("QA-623: a link that cannot say which of the centre's people it is for is shown as exactly that, not matched to somebody",
    !!legacyRow && !legacyRow.recipient_key,
    JSON.stringify({ found: !!legacyRow, key: legacyRow?.recipient_key ?? null }));
  const aliceFresh = (await req("POST", "/api/public-tokens", { purpose: "plan", batch: shiftBatch._id, recipient_name: alice.name, recipient_phone: alice.phone, recipient_role_label: alice.role_label, recipient_ref: alice.ref }, 201)).data.item;
  ok("QA-623: ...and sending to that person again leaves the unmatched link ALONE rather than guessing it was theirs",
    (await fetch(BASE + `/api/public/plan/${legacyTok.token}`)).status === 200
    && (await fetch(BASE + `/api/public/plan/${aliceFresh.token}`)).status === 200,
    JSON.stringify({ unmatched: (await fetch(BASE + `/api/public/plan/${legacyTok.token}`)).status, fresh: (await fetch(BASE + `/api/public/plan/${aliceFresh.token}`)).status }));
  // ...and it can be got rid of, or it simply lives on.
  await req("PATCH", `/api/public-tokens/${legacyRow._id}`, { active: false }, 200);
  ok("QA-623: ...and it can be revoked by hand",
    (await fetch(BASE + `/api/public/plan/${legacyTok.token}`)).status === 404,
    String((await fetch(BASE + `/api/public/plan/${legacyTok.token}`)).status));

  // ══ QA-558 / QA-621 cycle 5 — ONE SLOT, TWO PEOPLE, AT TWO DIFFERENT TIMES ══════════════════
  // Every pin above this line puts two different people on the centre AT THE SAME MOMENT. That is
  // the shape four fixes were written and tested against, and it is not the shape that kept killing
  // links: -195 shipped with `ref:spoc` as the identity and a checker moved the SPOC slot from one
  // human to another, which no simultaneous-pair test can see. The seven pins below are all the
  // over-TIME shape, on both kinds of ref, and two of them deliberately break the mechanism that is
  // supposed to catch it to prove something else still does.
  const ts = "T" + Date.now().toString().slice(-6);
  const slotLoc = (await req("POST", "/api/locations", { code: "SL" + ts, name: "Slot Centre " + ts, external_id: "SL" + ts, approval_status: "Approved", city: "Jhansi",
    spoc_name: "Sunita " + ts, spoc_phone: "9800000001",
    contacts: [{ name: "Alice Row " + ts, role_label: "Contact" }] }, 201)).data.item;
  const slotBatch = (await req("POST", "/api/batches", { location: slotLoc._id, program: prog._id, planned_start: "2027-07-01", target_size: 3 }, 201)).data.item;
  await req("PATCH", `/api/batches/${slotBatch._id}/milestones`, { create: true }, 200);
  // Recipients always come from the product's own picker, never hand-built: a fixture that invents
  // a ref tests the fixture (QA-624, where a stripped `_id` made the collision under test
  // impossible and the pin could not fail).
  const slotPick = async (startsWith) => ((await req("GET", `/api/batches/${slotBatch._id}/plan`)).data.recipients ?? [])
    .find((r) => String(r.name).startsWith(startsWith));
  const slotMint = async (r) => (await req("POST", "/api/public-tokens", { purpose: "plan", batch: slotBatch._id, recipient_name: r.name, recipient_phone: r.phone, recipient_role_label: r.role_label, recipient_ref: r.ref }, 201)).data.item;
  const slotLive = async (t) => (await fetch(BASE + `/api/public/plan/${t.token}`)).status;

  // (1) The -195 shape itself, through the product's own doors: the centre's SPOC is replaced.
  const sunita = await slotPick("Sunita");
  const sunitaTok = await slotMint(sunita);
  await req("PATCH", `/api/locations/${slotLoc._id}`, { spoc_name: "Vikram " + ts }, 200);
  const vikram = await slotPick("Vikram");
  ok("QA-621 cycle 5 fixture: the SPOC slot really did change hands, and still offers the same ref",
    !!vikram && vikram.ref === "spoc" && vikram.key !== sunita.key,
    JSON.stringify({ ref: vikram?.ref, keyMoved: vikram?.key !== sunita.key }));
  const vikramTok = await slotMint(vikram);
  ok("QA-621 cycle 5: handing a centre's SPOC slot to a DIFFERENT person does not revoke the previous SPOC's live link",
    (await slotLive(sunitaTok)) === 200 && (await slotLive(vikramTok)) === 200,
    JSON.stringify({ sunita: await slotLive(sunitaTok), vikram: await slotLive(vikramTok) }));

  // (2) ...and the other half of REQ-393: the same occupant re-sent still replaces their OWN link.
  const vikramAgainTok = await slotMint(await slotPick("Vikram"));
  ok("REQ-393: re-sending to the SAME occupant of a slot rotates that person's own link off, and nobody else's",
    (await slotLive(vikramTok)) === 404 && (await slotLive(vikramAgainTok)) === 200 && (await slotLive(sunitaTok)) === 200,
    JSON.stringify({ vikramOld: await slotLive(vikramTok), vikramNew: await slotLive(vikramAgainTok), sunita: await slotLive(sunitaTok) }));

  // (3) THE FOURTH SHAPE, and the one -195's generation counters cannot see: a `contact:<id>` row
  // renamed IN PLACE. The subdocument id is durable (QA-615) - which is exactly the problem, because
  // an admin replacing a centre's contact person by typing over the name keeps the id and changes
  // the human. Same failure as `spoc_name` being edited, one level down, with no counter on it.
  const aliceRow = await slotPick("Alice Row");
  const aliceRowTok = await slotMint(aliceRow);
  const locNow = (await req("GET", `/api/locations/${slotLoc._id}`)).data.item;
  await req("PATCH", `/api/locations/${slotLoc._id}`, { contacts: (locNow.contacts ?? []).map((c) => ({
    _id: c._id, phone: c.phone, role_label: c.role_label,
    name: String(c.name).startsWith("Alice Row") ? "Zoe Row " + ts : c.name,
  })) }, 200);
  const zoeRow = await slotPick("Zoe Row");
  ok("QA-558 cycle 5 fixture: the renamed contact really is the SAME row - same id, different person, so the collision is genuinely possible",
    !!zoeRow && zoeRow.ref === aliceRow.ref,
    JSON.stringify({ before: aliceRow.ref, after: zoeRow?.ref }));
  const zoeRowTok = await slotMint(zoeRow);
  ok("QA-558 cycle 5: a contact row typed over with a DIFFERENT person's name does not revoke the previous person's link",
    (await slotLive(aliceRowTok)) === 200 && (await slotLive(zoeRowTok)) === 200,
    JSON.stringify({ alice: await slotLive(aliceRowTok), zoe: await slotLive(zoeRowTok) }));

  // (4) The generation counters are maintained by four write paths remembering to call
  // slotGenerationBumps(). "Remembering to" is how each of the four earlier fixes died, so this pin
  // BREAKS that mechanism on purpose - the occupant is changed by a raw write, exactly as a future
  // write path that forgets would - and asserts nobody's link dies anyway.
  {
    const { MongoClient, ObjectId } = await import("mongodb");
    const mc = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
    await mc.connect();
    await mc.db(process.env.MONGODB_DB).collection("locations")
      .updateOne({ _id: new ObjectId(String(slotLoc._id)) }, { $set: { spoc_name: "Farida " + ts } });
    await mc.close();
  }
  const faridaTok = await slotMint(await slotPick("Farida"));
  ok("QA-558 cycle 5: an occupant change written by a path that FORGETS to bump the slot generation still cannot revoke the previous occupant's link",
    (await slotLive(vikramAgainTok)) === 200 && (await slotLive(faridaTok)) === 200,
    JSON.stringify({ vikram: await slotLive(vikramAgainTok), farida: await slotLive(faridaTok) }));

  // (5) ...and the mirror case, which is why the generation stays in the key rather than being
  // replaced by the occupant snapshot: a NAME can come back to a slot in a different person. The
  // generation moves forward and never returns, so the earlier holder is still safe.
  await req("PATCH", `/api/locations/${slotLoc._id}`, { spoc_name: "Vikram " + ts }, 200);
  const vikramTheSecondTok = await slotMint(await slotPick("Vikram"));
  ok("QA-621 cycle 5: a name RETURNING to a slot as a different person does not revoke the earlier holder of that name's link",
    (await slotLive(vikramAgainTok)) === 200 && (await slotLive(vikramTheSecondTok)) === 200,
    JSON.stringify({ firstVikram: await slotLive(vikramAgainTok), secondVikram: await slotLive(vikramTheSecondTok) }));

  // (6) The rows already in production carry the OLD single-signal key. Here are two of them
  // wearing the identical old key - the -193/-195 collision, on disk - and the send has to tell
  // them apart by what each row itself recorded, then rotate only the right one.
  {
    const { MongoClient, ObjectId } = await import("mongodb");
    const mc = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
    await mc.connect();
    const col = mc.db(process.env.MONGODB_DB).collection("publictokens");
    // Exactly what a row minted before this change looks like: the old single-signal key, and no
    // `recipient_occupant` at all - so the upgrade has nothing to read but the name each row
    // itself recorded, which is the only recorded fact such a row has.
    for (const t of [aliceRowTok, zoeRowTok]) {
      await col.updateOne({ _id: new ObjectId(String(t._id)) },
        { $set: { recipient_key: `ref:${zoeRow.ref}` }, $unset: { recipient_occupant: "" } });
    }
    await mc.close();
  }
  const zoeAgainTok = await slotMint(await slotPick("Zoe Row"));
  ok("QA-558 cycle 5: two pre-existing links wearing the identical OLD key are told apart by what each recorded - the current occupant's own link rotates",
    (await slotLive(zoeRowTok)) === 404 && (await slotLive(zoeAgainTok)) === 200,
    JSON.stringify({ zoeOld: await slotLive(zoeRowTok), zoeNew: await slotLive(zoeAgainTok) }));
  ok("QA-558 cycle 5: ...and the OTHER person's pre-existing link, which shared that same old key, survives it",
    (await slotLive(aliceRowTok)) === 200,
    JSON.stringify({ alice: await slotLive(aliceRowTok) }));

  // ══ QA-1502 / QA-1503 / QA-1505 (cycle 6) — THE INTERSECTIONS, AND THE CENTRE ═══════════════════
  // The seven pins above are each individually right and TOGETHER they miss three shapes a checker
  // then reproduced end to end. Every one of them is the same {404, 200}: a real person's live plan
  // link, silently dead, with nothing on any screen explaining why.
  //
  //   * pin (4) breaks the generation bump with a name that DIFFERS; pin (5) tests a RETURNING name
  //     through a path that DOES bump. Nothing tested their intersection — and two shipped,
  //     Admin-clickable routes sat exactly there (QA-1502).
  //   * no pin had ever moved a batch to another centre. `ref:spoc` names a role on whatever centre
  //     the batch sits on, and per-Location counters both start at 0, so two centres' SPOCs sharing
  //     a name minted a byte-identical key (QA-1503).
  //   * no pin had ever compared the PICKER's key with the key the mint actually STORED. They
  //     agreed by coincidence of implementation, not because one function answered the question
  //     (QA-1505).
  const cy = "Y" + Date.now().toString().slice(-6);
  // Liveness is read from the PUBLIC door, because "is this person's link dead" is a question only
  // the door can answer. But `public/plan/[token]` rate-limits on `clientKey(req)` — 60 reads per
  // client per 10 minutes, one bucket shared by every token — and the pins above have already spent
  // most of it, so a naive read here returns 429 and a pin would fail for the INSTRUMENT rather than
  // for the product (cycle 1's checker lost a whole run to exactly this and said so). Each read
  // therefore arrives from its own client address, which is what a rate limit is defined against;
  // nothing else about the request changes. Statuses are also taken ONCE per checkpoint and reused
  // in the assertion and its message, rather than re-fetched to print.
  let planReadClient = 0;
  const liveOf = async (t) => (await fetch(BASE + `/api/public/plan/${t.token}`, {
    headers: { "x-forwarded-for": `10.58.${(++planReadClient >> 8) & 255}.${planReadClient & 255}` },
  })).status;
  const planBatchFor = async (locId, start) => {
    const b = (await req("POST", "/api/batches", { location: locId, program: prog._id, planned_start: start, target_size: 3 }, 201)).data.item;
    await req("PATCH", `/api/batches/${b._id}/milestones`, { create: true }, 200);
    return b;
  };
  const pickFrom = async (batchId, startsWith) => ((await req("GET", `/api/batches/${batchId}/plan`)).data.recipients ?? [])
    .find((r) => String(r.name).startsWith(startsWith));
  const mintFor = async (batchId, r) => (await req("POST", "/api/public-tokens", { purpose: "plan", batch: batchId, recipient_name: r.name, recipient_phone: r.phone, recipient_role_label: r.role_label, recipient_ref: r.ref }, 201)).data.item;
  // A sheet-change fixture: a one-row CSV that maps a centre's SPOC column onto `spoc_name`, so the
  // rename below arrives through the SYNC INBOX exactly as it does in production — the ★-recommended
  // "Apply value" button on a row a human is looking at — rather than through a hand-built write.
  const spocSheet = async (extId, spocName, name) => {
    const fd = new FormData();
    fd.append("file", new File([`Center ID,SPOC\n${extId},${spocName}\n`], name, { type: "text/csv" }));
    return new URL((await fetch(`${BASE}/api/upload`, { method: "POST", headers: { cookie }, body: fd }).then((r) => r.json())).url, BASE).href;
  };
  const openSpocRow = async (locId) => ((await req("GET", "/api/sheet-changes?status=Open")).data.items ?? [])
    .find((c) => String(c.location?._id ?? c.location) === String(locId) && c.field_name === "spoc_name");

  // ── (7) QA-1502 — the Sync Inbox's "Apply value" is a slot reassignment, and it never bumped ──
  // `spoc_name` is in LOCATION_FIELDS and classifyChange RECOMMENDS "Apply value" on it, so this is
  // one ordinary press of a starred button. Two of them — rename, then rename back — used to leave
  // spoc_gen at 0 through both, and the first Meena's link died when the second Meena's was minted.
  // The fix is not a call added here; it is that the counter is maintained by the schema, so a
  // route that has never heard of it (this one, the revert door below, and whatever is written
  // next) cannot fail to move it.
  const applyLoc = (await req("POST", "/api/locations", { code: "AV" + cy, name: "Apply Centre " + cy, external_id: "AV" + cy, approval_status: "Approved", city: "Rewa", spoc_name: "Meena " + cy, spoc_phone: "9810000001" }, 201)).data.item;
  const applyBatch = await planBatchFor(applyLoc._id, "2027-08-01");
  const meenaOne = await pickFrom(applyBatch._id, "Meena");
  const meenaOneTok = await mintFor(applyBatch._id, meenaOne);
  const applySrc = (await req("POST", "/api/sync-sources", {
    name: "Apply Src " + cy, source_url: await spocSheet("AV" + cy, "Naveen " + cy, "av1" + cy + ".csv"),
    field_mappings: { "Center ID": "external_id", "SPOC": "spoc_name" },
  }, 201)).data.item;
  await req("POST", `/api/sync-sources/${applySrc._id}/run`, undefined, 200);
  const row1 = await openSpocRow(applyLoc._id);
  await req("POST", `/api/sheet-changes/${row1?._id}/apply`, { action: "Apply value" }, 200);
  const naveen = await pickFrom(applyBatch._id, "Naveen");
  ok("QA-1502: a Sync Inbox 'Apply value' that renames a centre's SPOC moves that slot's generation - the picker's key for the chair is no longer the one the previous occupant's link carries",
    !!naveen && naveen.ref === "spoc" && naveen.key !== meenaOne.key && /:g[1-9]/.test(naveen.key),
    JSON.stringify({ before: meenaOne.key, after: naveen?.key }));
  const naveenTok = await mintFor(applyBatch._id, naveen);
  // ...and now the intersection nothing tested: the SAME NAME comes back through that same
  // non-bumping route. The occupant snapshot matches (it is the same string), so the generation is
  // the only thing that can tell the two Meenas apart.
  await req("PATCH", `/api/sync-sources/${applySrc._id}`, { source_url: await spocSheet("AV" + cy, "Meena " + cy, "av2" + cy + ".csv") }, 200);
  await req("POST", `/api/sync-sources/${applySrc._id}/run`, undefined, 200);
  const row2 = await openSpocRow(applyLoc._id);
  await req("POST", `/api/sheet-changes/${row2?._id}/apply`, { action: "Apply value" }, 200);
  const meenaTwoTok = await mintFor(applyBatch._id, await pickFrom(applyBatch._id, "Meena"));
  const applyLive = { firstMeena: await liveOf(meenaOneTok), naveen: await liveOf(naveenTok), secondMeena: await liveOf(meenaTwoTok) };
  ok("QA-1502: two 'Apply value' presses hand a centre's SPOC chair away and back, and the FIRST holder of that name keeps their live link",
    Object.values(applyLive).every((s) => s === 200), JSON.stringify(applyLive));

  // ── (8) QA-1502 — the revert door is the same write, one route over ──
  // `POST /api/sheet-changes/[id]/revert` puts the old value back with the identical
  // `doc.set(); doc.save()`, so undoing an applied SPOC change is ALSO a slot reassignment. It is
  // the cheapest way to produce the returning-name shape in production: apply, then undo.
  const revLoc = (await req("POST", "/api/locations", { code: "RV" + cy, name: "Revert Centre " + cy, external_id: "RV" + cy, approval_status: "Approved", city: "Satna", spoc_name: "Ravi " + cy, spoc_phone: "9810000002" }, 201)).data.item;
  const revBatch = await planBatchFor(revLoc._id, "2027-08-15");
  const ravi = await pickFrom(revBatch._id, "Ravi");
  const raviTok = await mintFor(revBatch._id, ravi);
  const revSrc = (await req("POST", "/api/sync-sources", {
    name: "Revert Src " + cy, source_url: await spocSheet("RV" + cy, "Sonal " + cy, "rv1" + cy + ".csv"),
    field_mappings: { "Center ID": "external_id", "SPOC": "spoc_name" },
  }, 201)).data.item;
  await req("POST", `/api/sync-sources/${revSrc._id}/run`, undefined, 200);
  const revRow = await openSpocRow(revLoc._id);
  await req("POST", `/api/sheet-changes/${revRow?._id}/apply`, { action: "Apply value" }, 200);
  const sonalTok = await mintFor(revBatch._id, await pickFrom(revBatch._id, "Sonal"));
  await req("POST", `/api/sheet-changes/${revRow?._id}/revert`, undefined, 200);
  const raviBack = await pickFrom(revBatch._id, "Ravi");
  ok("QA-1502: reverting an applied SPOC change is a slot reassignment too, so it moves the generation - the restored name is not offered under the departed occupant's key",
    !!raviBack && raviBack.key !== ravi.key && /:g[1-9]/.test(raviBack.key),
    JSON.stringify({ beforeApply: ravi.key, afterRevert: raviBack?.key }));
  const raviBackTok = await mintFor(revBatch._id, raviBack);
  const revLive = { ravi: await liveOf(raviTok), sonal: await liveOf(sonalTok), raviBack: await liveOf(raviBackTok) };
  ok("QA-1502: ...and neither the original Ravi's link nor Sonal's is revoked by minting for the restored name",
    Object.values(revLive).every((s) => s === 200), JSON.stringify(revLive));

  // ── (9) QA-1503 — two centres, one name, and a batch that moved between them ──
  // No rename. No missed bump. No raw write. Two ordinary supported operations — create two centres
  // whose SPOCs happen to share a name (`avpl-rebase` forward-fills the master sheet's SPOC column,
  // so consecutive centres in one import inherit exactly that), and move a batch from one to the
  // other — and on cycle 1 the second mint killed the first centre's SPOC's link, because `ref:spoc`
  // said WHICH CHAIR and never WHICH BUILDING.
  const sameer = "Sameer " + cy;
  const centreX = (await req("POST", "/api/locations", { code: "CX" + cy, name: "Centre X " + cy, external_id: "CX" + cy, approval_status: "Approved", city: "Ujjain", spoc_name: sameer, spoc_phone: "9810000003" }, 201)).data.item;
  const centreY = (await req("POST", "/api/locations", { code: "CY" + cy, name: "Centre Y " + cy, external_id: "CY" + cy, approval_status: "Approved", city: "Dewas", spoc_name: sameer, spoc_phone: "9810000004" }, 201)).data.item;
  const moveBatch = await planBatchFor(centreX._id, "2027-09-01");
  const spocX = await pickFrom(moveBatch._id, "Sameer");
  const spocXTok = await mintFor(moveBatch._id, spocX);
  await req("PATCH", `/api/batches/${moveBatch._id}`, { location: centreY._id }, 200);
  const spocY = await pickFrom(moveBatch._id, "Sameer");
  ok("QA-1503 fixture: after the batch moves, the picker offers the NEW centre's SPOC under the SAME ref and the SAME name - so the collision is genuinely available",
    !!spocY && spocY.ref === spocX.ref && spocY.name === spocX.name,
    JSON.stringify({ ref: spocY?.ref, sameName: spocY?.name === spocX.name }));
  ok("QA-1503: ...and their keys still differ, because a slot ref means (centre, role) and never role alone",
    !!spocY && spocY.key !== spocX.key && spocY.key.startsWith("loc:") && spocX.key.startsWith("loc:"),
    JSON.stringify({ x: spocX.key, y: spocY?.key }));
  const spocYTok = await mintFor(moveBatch._id, spocY);
  const moveLive = { centreX: await liveOf(spocXTok), centreY: await liveOf(spocYTok) };
  ok("QA-1503: sending the plan to the new centre's SPOC does not revoke the old centre's SPOC's live link, though the two share a name",
    moveLive.centreX === 200 && moveLive.centreY === 200, JSON.stringify(moveLive));
  // ...and the half that is not about safety: back on centre Y, re-sending to Y's own SPOC still
  // rotates Y's own link off. A key qualified by the centre must not cost REQ-393 its rotation.
  const spocYAgainTok = await mintFor(moveBatch._id, await pickFrom(moveBatch._id, "Sameer"));
  const rotLive = { yOld: await liveOf(spocYTok), yNew: await liveOf(spocYAgainTok), x: await liveOf(spocXTok) };
  ok("QA-1503: REQ-393 still holds across the move - re-sending to the CURRENT centre's SPOC rotates that person's own link and nobody else's",
    rotLive.yOld === 404 && rotLive.yNew === 200 && rotLive.x === 200, JSON.stringify(rotLive));

  // ── (10) QA-1505 — the picker and the mint answer "who occupies this ref" with ONE function ──
  // Cycle 1's manifest said both doors called occupantName(); the picker did not, and passed a name
  // it had read for itself. Two contacts sharing one subdocument `_id` made the divergence visible:
  // the screen told two people apart and the mint — which takes the FIRST row with that id —
  // collapsed them, and revoked the wrong one. The duplicate is refused at the door now, and the
  // pin below is the general property, checked for EVERY ref the centre offers rather than for the
  // one that happened to break: what the screen shows as this person's key is what the mint stores.
  const dupLoc = (await req("POST", "/api/locations", { code: "DP" + cy, name: "Dup Centre " + cy, external_id: "DP" + cy, approval_status: "Approved", city: "Guna", spoc_name: "Dup Spoc " + cy, spoc_phone: "9810000005", principal_name: "Dup Principal " + cy, contacts: [{ name: "Dup One " + cy, role_label: "Contact", phone: "9810000006" }] }, 201)).data.item;
  const dupBatch = await planBatchFor(dupLoc._id, "2027-09-15");
  const dupNow = (await req("GET", `/api/locations/${dupLoc._id}`)).data.item;
  const dupContact = (dupNow.contacts ?? [])[0];
  const dupWrite = await req("PATCH", `/api/locations/${dupLoc._id}`, { contacts: [
    { _id: dupContact._id, name: "Dup One " + cy, role_label: "Contact", phone: "9810000006" },
    { _id: dupContact._id, name: "Dup Two " + cy, role_label: "Contact", phone: "9810000007" },
  ] }, 400);
  ok("QA-1505: a centre cannot be saved with two contacts sharing one id, and the refusal says why rather than 'contacts is not valid'",
    /same id/i.test(String(dupWrite.data?.error ?? "")),
    JSON.stringify({ error: String(dupWrite.data?.error ?? "").slice(0, 180) }));
  const dupAfter = (await req("GET", `/api/locations/${dupLoc._id}`)).data.item;
  ok("QA-1505: ...and the refusal is a refusal - the duplicate row is not half-written onto the centre",
    (dupAfter.contacts ?? []).length === 1 && String(dupAfter.contacts[0].name).startsWith("Dup One"),
    JSON.stringify((dupAfter.contacts ?? []).map((c) => c.name)));
  {
    const offeredAll = (await req("GET", `/api/batches/${dupBatch._id}/plan`)).data.recipients ?? [];
    const minted = [];
    for (const r of offeredAll) minted.push([r, await mintFor(dupBatch._id, r)]);
    const shares = (await req("GET", `/api/batches/${dupBatch._id}/plan`)).data.shares ?? [];
    const mismatched = minted.filter(([r, t]) => (shares.find((s) => s.token === t.token) ?? {}).recipient_key !== r.key);
    ok("QA-1505: for every person the plan screen offers, the key it shows is byte-identical to the key the mint stored - one function answers 'who occupies this ref', not two readers agreeing by luck",
      offeredAll.length >= 3 && mismatched.length === 0,
      JSON.stringify({ offered: offeredAll.length, mismatched: mismatched.map(([r]) => r.ref) }));
  }

  // ── (11) QA-1503 — a row that cannot say WHICH CENTRE it was sent from is never matched ──
  // The same discipline as QA-623, one field over. The centre is recovered from `recipient_location`
  // stamped at mint time and from nowhere else — deliberately NOT from where the batch sits today,
  // because that is exactly the guess QA-1503 is made of. So a row with no recorded centre keeps its
  // key, matches no mint, and shows up on the plan screen as belonging to nobody: an EXTRA live
  // link, revocable by hand, which is the failure direction this unit chose over a silently dead one.
  const orphanTok = await mintFor(dupBatch._id, await pickFrom(dupBatch._id, "Dup Spoc"));
  {
    const { MongoClient, ObjectId } = await import("mongodb");
    const mc = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
    await mc.connect();
    await mc.db(process.env.MONGODB_DB).collection("publictokens").updateOne(
      { _id: new ObjectId(String(orphanTok._id)) },
      { $set: { recipient_key: "ref:spoc" }, $unset: { recipient_location: "", recipient_occupant: "" } });
    await mc.close();
  }
  const orphanRow = ((await req("GET", `/api/batches/${dupBatch._id}/plan`)).data.shares ?? []).find((s) => s.token === orphanTok.token);
  ok("QA-1503: a link whose row cannot say which centre it was sent from is shown as belonging to nobody, not guessed onto today's centre",
    !!orphanRow && !orphanRow.recipient_key,
    JSON.stringify({ found: !!orphanRow, key: orphanRow?.recipient_key ?? null }));
  const orphanFreshTok = await mintFor(dupBatch._id, await pickFrom(dupBatch._id, "Dup Spoc"));
  const orphanLive = { orphan: await liveOf(orphanTok), fresh: await liveOf(orphanFreshTok) };
  ok("QA-1503: ...and re-sending to that same slot leaves the unmatched link alive rather than revoking a link the system cannot prove is theirs",
    orphanLive.orphan === 200 && orphanLive.fresh === 200, JSON.stringify(orphanLive));

  // QA-617 — "may this user share?" was asked in two places that disagreed in BOTH directions. The
  // direction pinned here is the one my own first fix got wrong: an Admin with `can_edit: false` -
  // the schema's DEFAULT - can mint a link (requireEdit exempts Admin) but was shown nobody to send
  // to, because I had restated the gate as `can_edit !== false` instead of running it.
  const roEmail = `ro.admin.${rs}@vidysea.com`;
  await req("POST", "/api/users", { name: "ReadOnly Admin " + rs, email: roEmail, password: "Test@12345", role: "Admin", can_edit: false }, 201);
  const roCookie = await loginAs(roEmail, "Test@12345");
  const roPlan = await fetch(BASE + `/api/batches/${planBatch._id}/plan`, { headers: { cookie: roCookie } });
  const roPlanJ = roPlan.status === 200 ? await roPlan.json() : null;
  // Its OWN contact, so proving the GATE does not revoke somebody else's link on the way past. A
  // plan share must now name a slot that exists (QA-621), so this probe creates one first.
  const gateBefore = (await req("GET", `/api/locations/${loc._id}`)).data.item;
  await req("PATCH", `/api/locations/${loc._id}`, { contacts: [
    ...(gateBefore.contacts ?? []).map((c) => ({ _id: c._id, name: c.name, phone: c.phone, role_label: c.role_label })),
    { name: "Gate Probe " + rs, role_label: "Contact" },
  ] }, 200);
  const gateContact = ((await req("GET", `/api/locations/${loc._id}`)).data.item.contacts ?? []).find((c) => String(c.name).startsWith("Gate Probe"));
  const roMint = await fetch(BASE + "/api/public-tokens", { method: "POST", headers: { "Content-Type": "application/json", cookie: roCookie },
    body: JSON.stringify({ purpose: "plan", batch: planBatch._id, recipient_name: gateContact.name, recipient_role_label: gateContact.role_label, recipient_ref: `contact:${gateContact._id}` }) });
  ok("QA-617: whoever may SEND a plan is shown who to send it to - the two gates are one rule, not two statements of it",
    roPlan.status === 200 && roMint.status === 201 && roPlanJ?.may_share === true,
    JSON.stringify({ plan: roPlan.status, may_share: roPlanJ?.may_share, mint: roMint.status }));

  // QA-614 — centre staff names and personal phone numbers were handed to anyone who could see the
  // batch, Trainers included; the picker was gated in the browser only, which is not a gate.
  // The first draft of this pin let a non-200 satisfy it - and `planBatch` has no trainer, so on
  // pre-fix code the Trainer simply could not see it and the pin PASSED without testing anything.
  // A pin that passes before the fix is not a pin (QA-598, learned on this same file). So it now
  // uses a batch the Trainer genuinely CAN see, and a 200 is required, not tolerated.
  const planTrainerCookie = await loginAs("trainer.jpr03@vidysea.com", "CiOnly@123");
  const trOwn = ((await (await fetch(BASE + "/api/batches", { headers: { cookie: planTrainerCookie } })).json()).items ?? [])[0];
  // No plan is created here on purpose. The first attempt PATCHed one into existence and hit
  // "A backward plan is made while the batch is in Planning" - a 409 the suite counts as a failure,
  // for a step this pin never needed: the endpoint answers `may_share` and `recipients` whether or
  // not the batch has a plan, and those two are the whole question.
  const planAsTrainer = trOwn ? await fetch(BASE + `/api/batches/${trOwn._id}/plan`, { headers: { cookie: planTrainerCookie } }) : null;
  const planAsTrainerJ = planAsTrainer?.status === 200 ? await planAsTrainer.json() : null;
  ok("QA-614: a Trainer looking at a batch THEY run does not get the centre's staff list or their phone numbers",
    !!trOwn && planAsTrainer?.status === 200
    && planAsTrainerJ?.may_share === false
    && (planAsTrainerJ?.recipients ?? []).length === 0
    && (planAsTrainerJ?.shares ?? []).every((s) => s.recipient_phone === null),
    JSON.stringify({ own: !!trOwn, status: planAsTrainer?.status, may_share: planAsTrainerJ?.may_share, n: (planAsTrainerJ?.recipients ?? []).length }));
  const tick2 = await fetch(BASE + `/api/public/plan/${linkRW.token}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "trainer_found", done: true }) });
  const tick2J = await tick2.json();
  const tf = (tick2J.milestones ?? []).find((m) => m.key === "trainer_found");
  ok("-82: a status-updatable link ticks a milestone (recorded as via link, no user)", tick2.status === 200 && !!tf?.done_on && tf.done_via === "link", JSON.stringify({ s: tick2.status, tf }));
  const after = (await req("GET", `/api/batches/${planBatch._id}`)).data.item;
  const tfDb = after.milestones.find((m) => m.key === "trainer_found");
  ok("-82: the tick from the link is on the batch itself (done_by empty)", !!tfDb?.done_on && !tfDb.done_by && tfDb.done_via === "link", JSON.stringify(tfDb));
  await fetch(BASE + `/api/public/plan/${linkRW.token}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "trainer_found", done: false }) });
  ok("-82: unknown key via link → 404", (await fetch(BASE + `/api/public/plan/${linkRW.token}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "nope", done: true }) })).status === 404);
  const removed = (await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { remove: custom.key }, 200)).data.item;
  ok("-82: planner removes the custom row", removed.milestones.length === 8 && !removed.milestones.some((m) => m.key === custom.key));
  await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { remove: "nope" }, 404);
  await req("POST", "/api/public-tokens", { purpose: "plan" }, 400); // batch required
  ok("-82: a bad public token → 404", (await fetch(BASE + `/api/public/plan/${"0".repeat(32)}`)).status === 404);
}
await req("POST", `/api/batches/${planBatch._id}/transition`, { target: "Cancelled", reason: "planner test cleanup" }, 200);

// ---- -84 (QA-146 part 2): candidates get the QA-130 delete verb — junk rows can leave ----
{
  const junk = (await req("POST", "/api/candidates", { name: "Salutation", phone: "9800" + stamp.slice(-6), location: loc._id, program: prog._id }, 201)).data.item;
  await req("DELETE", `/api/candidates/${junk._id}`, undefined, 200);
  await req("GET", `/api/candidates/${junk._id}`, undefined, 404);
  ok("-84: an Admin deletes a junk candidate row and it is gone", true);
  const hist = ((await req("GET", `/api/audit/Candidate/${junk._id}`)).data.items ?? []);
  ok("-84: the deletion is audited with what went", hist.some((a) => /deleted \(Salutation/.test(String(a.new_value))), JSON.stringify(hist.map((a) => a.new_value)));
  const rosterCand = (await req("GET", `/api/batches/${batch._id}/members`)).data.items?.[0]?.candidate;
  if (rosterCand?._id) {
    const refused = await req("DELETE", `/api/candidates/${rosterCand._id}`, undefined, 409);
    ok("-84: a candidate with batch history cannot be deleted (drop them from the batch instead)", /batch history/.test(refused.data?.error ?? ""), refused.data?.error);
  }
  await req("DELETE", `/api/candidates/${"0".repeat(24)}`, undefined, 404);
}

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
// 15/08 (Umesh): email is mandatory on self-registration — without it the form refuses,
// naming the field; with it the candidate lands carrying the email.
const noEmail = await fetch(BASE + `/api/public/register/${regToken.token}`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "NoMail Cand " + stamp, phone: "7666601" + stamp.slice(0, 3) }),
});
const noEmailBody = await noEmail.json().catch(() => ({}));
ok("T2: self-registration without email is refused, naming the field",
  noEmail.status === 400 && /email/i.test(noEmailBody.error ?? ""), `status=${noEmail.status} ${noEmailBody.error ?? ""}`);
const pubPost = await fetch(BASE + `/api/public/register/${regToken.token}`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "SelfReg Cand " + stamp, phone: "7666600" + stamp.slice(0, 3), email: `selfreg.${stamp}@test.local`, dob: "2001-05-05", education: "12th Pass" }),
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
ok("T2: the self-registered candidate carries the email", selfReg[0]?.email === `selfreg.${stamp}@test.local`, JSON.stringify(selfReg[0]?.email));
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
  const tr = (await req("POST", "/api/trainers", { name: `Comp ${stamp}`, phone: "955555" + stamp.slice(2), skills: ["Skill" + stamp], compensation_type: "Incentive-based" }, 201)).data.item;
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

// ---- admin reset endpoints (2026-08-14 CEO order). The TEMPORARY wipe endpoint was removed
// in -14-33 after the reset ran (a wipe surface must not outlive its one job) — the route
// must be GONE, not merely guarded. The AVPL rebase endpoint is permanent: Admin-only. ----
{
  await req("POST", "/api/admin/wipe", {}, 404); // removed — 404 proves the surface no longer exists
  const spocCookie = await loginAs("spoc.jpr03@vidysea.com", "CiOnly@123");
  if (spocCookie) {
    const saved = cookie; cookie = spocCookie;
    await req("POST", "/api/admin/avpl-rebase", {}, 403);
    cookie = saved;
  }
}

// ---- T1 (15/08 team feedback): the upload endpoint takes every promised type ----
{
  const up = async (name, type) => {
    const fd = new FormData();
    fd.append("file", new File([Buffer.from("probe")], name, { type }));
    const res = await fetch(BASE + "/api/upload", { method: "POST", headers: { cookie }, body: fd });
    return res.status;
  };
  ok("T1: png uploads", (await up("t.png", "image/png")) === 200);
  ok("T1: docx uploads", (await up("t.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")) === 200);
  ok("T1: heic uploads (iPhone default)", (await up("t.heic", "image/heic")) === 200);
  // 15/08 (team, via checker): voice notes are field evidence too.
  ok("T1: m4a audio uploads (voice notes)", (await up("t.m4a", "audio/mp4")) === 200);
  ok("T1: an executable is refused", (await up("t.exe", "application/octet-stream")) === 400);
  // -81 (Umesh's video test, 15/08): a 24 MB body used to die at ~10 MB — Next buffers the
  // body for src/proxy.ts (proxyClientMaxBodySize default 10 MB) and truncated it, formData()
  // failed, the route said 413. /api/upload is now outside the proxy matcher: streams whole.
  {
    const big = Buffer.alloc(24 * 1024 * 1024, 7);
    const fd = new FormData();
    fd.append("file", new File([big], "big-evidence.mp4", { type: "video/mp4" }));
    const res = await fetch(BASE + "/api/upload", { method: "POST", headers: { cookie }, body: fd });
    const j = await res.json().catch(() => ({}));
    ok("-81: a 24 MB video body reaches the handler whole (was 413 at ~10 MB)", res.status === 200 && !!j.url, `status=${res.status} ${JSON.stringify(j).slice(0, 120)}`);
    if (j.url) {
      const back = await fetch(BASE.replace(/\/erp$/, "") + j.url, { headers: { cookie } });
      const bytes = Buffer.from(await back.arrayBuffer());
      ok("-81: and reads back at full length", back.status === 200 && bytes.length === big.length, `status=${back.status} len=${bytes.length}`);
    }
    // the proxy skip must NOT open the door: no session → 401 from the route itself
    const anon = await fetch(BASE + "/api/upload", { method: "POST", body: (() => { const f = new FormData(); f.append("file", new File([Buffer.from("x")], "a.png", { type: "image/png" })); return f; })() });
    ok("-81: /api/upload without a session is still refused (route-level auth)", anon.status === 401, `status=${anon.status}`);
  }
}

// ---- QA-145 (-77): durable evidence storage. CI runs UNCONFIGURED (no Drive creds), so
// this pins the graceful-off shape: every upload gets a StoredFile row (backend "local"),
// the proxied read still serves the bytes, and the product tells the truth about it —
// version endpoint says local-ephemeral, admin health says NOT connected. Real Drive
// durability is proven live once Umesh completes drive-storage-setup.md.
{
  const fd = new FormData();
  fd.append("file", new File([Buffer.from("qa145-evidence")], "ev.png", { type: "image/png" }));
  fd.append("folder_centre", "TEST-CENTRE"); fd.append("folder_batch", "TEST-BATCH-01"); fd.append("folder_kind", "evidence");
  const upRes = await fetch(BASE + "/api/upload", { method: "POST", headers: { cookie }, body: fd });
  const upJ = await upRes.json();
  ok("QA-145: upload answers with its backend (local in CI)", upRes.status === 200 && upJ.backend === "local", JSON.stringify(upJ));
  const fname = String(upJ.url ?? "").split("/").pop();
  const { MongoClient } = await import("mongodb");
  const mc = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
  await mc.connect();
  const row = await mc.db(process.env.MONGODB_DB || "center_erp_ci").collection("storedfiles").findOne({ name: fname });
  await mc.close();
  ok("QA-145: every upload leaves a StoredFile row (backend, size, original name, uploader)",
    !!row && row.backend === "local" && row.size === 14 && row.original_name === "ev.png" && !!row.uploaded_by, JSON.stringify(row && { backend: row.backend, size: row.size }));
  const rd = await fetch(BASE + upJ.url.replace(/^\/erp/, ""), { headers: { cookie } });
  ok("QA-145: the proxied read serves the bytes back", rd.status === 200 && (await rd.text()) === "qa145-evidence", String(rd.status));
  ok("-83 (QA-155): the folder hints and entity a caller sends are RECORDED (Drive tree + 'which files belong to this batch')",
    row?.folder_path === "TEST-CENTRE/TEST-BATCH-01/evidence", JSON.stringify({ folder_path: row?.folder_path, entity: row?.entity }));
  // -83 (QA-156): honest file reads — Range → 206 with the exact slice, Accept-Ranges advertised,
  // media types real and inline, a missing file 404, a bad range 416.
  const rangeRes = await fetch(BASE + upJ.url.replace(/^\/erp/, ""), { headers: { Range: "bytes=0-4", cookie } });
  ok("QA-156: Range request → 206 with exactly the asked bytes + Content-Range",
    rangeRes.status === 206 && (await rangeRes.text()) === "qa145" && rangeRes.headers.get("content-range") === "bytes 0-4/14" && rangeRes.headers.get("accept-ranges") === "bytes",
    `${rangeRes.status} ${rangeRes.headers.get("content-range")}`);
  const tailRes = await fetch(BASE + upJ.url.replace(/^\/erp/, ""), { headers: { Range: "bytes=-3", cookie } });
  ok("QA-156: suffix Range (last 3 bytes) → 206", tailRes.status === 206 && (await tailRes.text()) === "nce", `${tailRes.status}`);
  const badRange = await fetch(BASE + upJ.url.replace(/^\/erp/, ""), { headers: { Range: "bytes=50-60", cookie } });
  ok("QA-156: unsatisfiable Range → 416", badRange.status === 416, `${badRange.status}`);
  const missing = await fetch(BASE + "/api/files/" + "0".repeat(32) + ".png", { headers: { cookie } });
  ok("QA-156: a missing file is 404, not a crash", missing.status === 404, `${missing.status}`);
  {
    const fdA = new FormData();
    fdA.append("file", new File([Buffer.from("voice-note-bytes")], "note.m4a", { type: "audio/mp4" }));
    const upA = await (await fetch(BASE + "/api/upload", { method: "POST", headers: { cookie }, body: fdA })).json();
    const rdA = await fetch(BASE + String(upA.url).replace(/^\/erp/, ""), { headers: { cookie } });
    ok("QA-156: a voice note (.m4a) is served as audio/mp4 INLINE, not an octet-stream download",
      rdA.status === 200 && rdA.headers.get("content-type") === "audio/mp4" && /^inline/.test(rdA.headers.get("content-disposition") ?? "") && rdA.headers.get("content-length") === "16",
      `${rdA.headers.get("content-type")} ${rdA.headers.get("content-disposition")}`);
  }
  const ver = await (await fetch(BASE + "/api/public/version")).json();
  ok("QA-145: version endpoint tells the truth — evidence_storage is local-ephemeral in CI", ver.evidence_storage === "local-ephemeral", ver.evidence_storage);
  const cfg = (await req("GET", "/api/test-email", undefined, 200)).data;
  ok("QA-145: admin health names the loss honestly (NOT connected, lost on deploy) and names GCS as the decided backend",
    cfg.storage?.configured === false && /LOST on every deploy/.test(cfg.storage?.reason ?? "") && /GCS_BUCKET/.test(cfg.storage?.reason ?? "") && /WIF identity is baked in|None of the storage names|forced OFF by STORAGE_DISABLE/.test(cfg.storage?.hint ?? ""), JSON.stringify(cfg.storage));
  // -79 rider: the one-click storage probe REFUSES to run unconfigured (it would only prove
  // the disk that deploys wipe) and says why — the live proof is a click away once Drive is on.
  const probe = await req("POST", "/api/test-storage", {});
  ok("QA-145: storage probe refuses unconfigured with the reason named (400)", probe.status === 400 && /not connected/i.test(probe.data?.error ?? ""), `${probe.status} ${probe.data?.error}`);
  const probeGet = await req("GET", "/api/test-storage", undefined, 200);
  ok("QA-145: storage probe GET reports health", probeGet.data?.storage?.configured === false);
  ok("-87 (QA-157): the storage health names its compression tools + totals", typeof probeGet.data?.tools?.sharp === "boolean" && typeof probeGet.data?.tools?.gs === "boolean" && typeof probeGet.data?.compression?.totals?.files === "number", JSON.stringify(probeGet.data?.tools));
  // -89 (Umesh: "sab .env me hai, tu check kar le"): the app SAYS which Drive names reached this
  // container (names only, never values), with SES/Mongo as the control, and a plain hint.
  const env = probeGet.data?.env;
  ok("-89: health carries the env diagnostic — names + lengths, never values", !!env?.env_seen && "GDRIVE_OAUTH_CLIENT_ID" in env.env_seen && "SES_SMTP_USER" in env.env_seen && "MONGODB_URL" in env.env_seen && typeof env.env_seen.MONGODB_URL.length === "number" && !JSON.stringify(env).includes(process.env.MONGODB_URL ?? "mongodb://127.0.0.1"), JSON.stringify(Object.keys(env?.env_seen ?? {}).slice(0, 5)));
  // -95: the bucket is named in code, so the wall runs with STORAGE_DISABLE=1 and the diagnostic
  // says so — and still names the bucket this build is for (would_be), so nobody mistakes the
  // switch for a missing bucket.
  ok("-95: CI wall is forced off by STORAGE_DISABLE and the hint SAYS so (never 'bucket missing') and names the bucket the build is for", typeof env?.hint === "string" && /forced OFF by STORAGE_DISABLE/.test(env.hint) && /vidysea-erp-storage/.test(env.hint) && env.env_seen.MONGODB_URL.present === true, env?.hint);
  ok("-95: would_be says gcs + vidysea-erp-storage (default) via the baked WIF file", env?.would_be?.mode === "gcs" && env?.would_be?.bucket === "vidysea-erp-storage" && env?.would_be?.bucket_from === "default" && /gcs-wif\.json/.test(env?.would_be?.cred_from ?? ""), JSON.stringify(env?.would_be));
  ok("-95: the CORS rule the app applies names the production origin, PUT+POST, and exposes Location/Range/Content-Range/x-goog-resumable", Array.isArray(env?.cors_rule?.origin) && env.cors_rule.origin.includes("https://www.vidysea.com") && ["PUT", "POST", "GET"].every((m) => env.cors_rule.method.includes(m)) && ["Location", "Range", "Content-Range", "x-goog-resumable"].every((h) => env.cors_rule.responseHeader.includes(h)) && env.cors_rule.maxAgeSeconds === 3600, JSON.stringify(env?.cors_rule));
  ok("-95: the project id is derived from the impersonated SA (no GOOGLE_CLOUD_PROJECT needed)", env?.project === "gen-lang-client-0677023624", String(env?.project));
  ok("-95: STORAGE_DISABLE is listed in the diagnostic (names only) and reported as the reason", "STORAGE_DISABLE" in (env?.env_seen ?? {}) && env?.disabled?.on === true && env?.disabled?.name === "STORAGE_DISABLE", JSON.stringify(env?.disabled));
  ok("-93: the WIF identity file ships in the build (no private key) and names the impersonated service account", env?.wif?.present === true && /erp-storage-380@/.test(env?.wif?.impersonating ?? "") && typeof env?.aws?.container_creds === "boolean", JSON.stringify(env?.wif));
  ok("-92 (QA-161): the diagnostic lists the GCS names too (GCS_BUCKET, GCS_SA_JSON) — the decided backend", "GCS_BUCKET" in (env?.env_seen ?? {}) && "GCS_SA_JSON" in (env?.env_seen ?? {}), JSON.stringify(Object.keys(env?.env_seen ?? {}).slice(0, 4)));
  ok("-89: storage health itself carries the hint (the admin banner shows it)", typeof probeGet.data?.storage?.hint === "string" && probeGet.data.storage.hint.length > 20, probeGet.data?.storage?.hint);
  ok("-89: the probe's refusal names the hint, not a bare 'GDRIVE_SA_JSON missing'", /None of the storage names|register them|WIF identity is baked in|forced OFF by STORAGE_DISABLE/.test(probe.data?.error ?? ""), probe.data?.error);
  ok("-90: storage health carries rss_mb (memory is measurable, not asserted)", typeof probeGet.data?.rss_mb === "number" && probeGet.data.rss_mb > 0, String(probeGet.data?.rss_mb));
}

// ---- -90 (DESIGN-video-upload.md): direct-to-Drive resumable path — CI has no Drive, so the
// contract pins are structural: intent says 409 + fallback (the client then uses multipart),
// validation is honest, complete/abort refuse unknown names, and the ordinary door still
// stamps rows READY (the only state /api/files serves).
{
  const intent = await req("POST", "/api/upload/intent", { name: "session.mp4", size: 100 * 1024 * 1024, mime: "video/mp4", folder_centre: "TEST-CENTRE", folder_batch: "TEST-BATCH-01", folder_kind: "videos" }, 409);
  ok("-90: with Drive off, intent answers 409 + fallback:true (client falls back to multipart)", intent.data?.fallback === true && /not connected/i.test(intent.data?.error ?? ""), JSON.stringify(intent.data));
  await req("POST", "/api/upload/intent", { name: "evil.exe", size: 10, mime: "application/octet-stream" }, 400);
  await req("POST", "/api/upload/intent", { name: "x.mp4", size: 0, mime: "video/mp4" }, 400);
  await req("POST", "/api/upload/intent", { name: "x.mp4", size: 6 * 1024 * 1024 * 1024, mime: "video/mp4" }, 413);
  await req("POST", "/api/upload/complete", { name: "0".repeat(32) + ".mp4", drive_file_id: "abc" }, 404);
  await req("POST", "/api/upload/complete", { name: "not-a-name", drive_file_id: "abc" }, 400);
  await req("POST", "/api/upload/abort", { name: "0".repeat(32) + ".mp4" }, 404);
  const anonIntent = await fetch(BASE + "/api/upload/intent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "a.mp4", size: 10, mime: "video/mp4" }) });
  ok("-90: intent needs a session (401 anon)", anonIntent.status === 401, String(anonIntent.status));
  {
    const { MongoClient } = await import("mongodb");
    const mc = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
    await mc.connect();
    const anyRow = await mc.db(process.env.MONGODB_DB || "center_erp_ci").collection("storedfiles").findOne({}, { sort: { createdAt: -1 } });
    await mc.close();
    ok("-90: rows written by the multipart door are READY (the only state /api/files serves)", !!anyRow && (anyRow.status === "ready" || anyRow.status === undefined), JSON.stringify(anyRow && anyRow.status));
  }
}

// ---- -97: QA-162 / QA-164 (compress first, reasons travel), file lifecycle (delete → 410),
// "where did it go" (admin list), CORS hygiene ----
{
  const { MongoClient } = await import("mongodb");
  const mc = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
  await mc.connect();
  const sf = mc.db(process.env.MONGODB_DB || "center_erp_ci").collection("storedfiles");
  const upload = async (bytes, name, type, extra = {}) => {
    const fd = new FormData();
    fd.append("file", new File([Buffer.from(bytes)], name, { type }));
    fd.append("folder_centre", "TEST-CENTRE"); fd.append("folder_batch", "TEST-BATCH-01"); fd.append("folder_kind", "evidence");
    for (const [k, v] of Object.entries(extra)) fd.append(k, String(v));
    const r = await fetch(BASE + "/api/upload", { method: "POST", headers: { cookie }, body: fd });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  // QA-164: a device REASON ("none:<why>") is recorded as the reason, never as a compression
  const r1 = await upload("qa164-video-bytes", "clip.mp4", "video/mp4", { client_compression: "none:this browser cannot re-encode video", client_original_size: 17 });
  const row1 = r1.status === 200 ? await sf.findOne({ name: String(r1.data.url).split("/").pop() }) : null;
  ok("-97 (QA-164): a 'none:<reason>' from the device lands on the row as the REASON, compressed=false", !!row1 && /\(device: this browser cannot re-encode video\)/.test(row1.compression ?? "") && row1.compressed === false, JSON.stringify(row1 && { c: row1.compression, compressed: row1.compressed }));
  ok("-97 (QA-164): …and the response label carries it too (the screen shows why)", /device: this browser cannot re-encode video/.test(r1.data?.compression ?? ""), r1.data?.compression);
  // QA-164: a real device label is combined with what the server did (never overwritten)
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const r2 = await upload(png, "device.jpg", "image/jpeg", { client_compression: "image-1600-q75 (device)", client_original_size: 5000000 });
  const row2 = r2.status === 200 ? await sf.findOne({ name: String(r2.data.url).split("/").pop() }) : null;
  ok("-97 (QA-162): a device-compressed image records client:<label> and keeps the device's original size", !!row2 && /^client:image-1600-q75 \(device\)/.test(row2.compression ?? "") && row2.compressed === true && row2.original_size === 5000000, JSON.stringify(row2 && { c: row2.compression, o: row2.original_size }));
  // intent path: reason vs label
  const i1 = await req("POST", "/api/upload/intent", { name: "big.mp4", size: 50 * 1024 * 1024, mime: "video/mp4", client_compression: "none:no duration/size metadata" });
  ok("-97 (QA-164): intent with a device reason is refused only because storage is off (409), never for the reason field", i1.status === 409, String(i1.status));

  // Lifecycle: an unreferenced upload can be DISCARDED by its uploader → 410 afterwards; row kept as audit
  const r3 = await upload("discard-me", "wrong.png", "image/png");
  const n3 = String(r3.data.url).split("/").pop();
  const before = await fetch(BASE + "/api/files/" + n3, { headers: { cookie } });
  const del = await req("DELETE", "/api/files/" + n3);
  const after = await fetch(BASE + "/api/files/" + n3, { headers: { cookie } });
  const row3 = await sf.findOne({ name: n3 });
  ok("-97 (lifecycle): uploader discards an unattached upload → 200, then the URL answers 410 and the row stays as 'deleted' with who/when", before.status === 200 && del.status === 200 && after.status === 410 && row3?.status === "deleted" && !!row3?.deleted_at && !!row3?.deleted_by, JSON.stringify({ b: before.status, d: del.status, a: after.status, s: row3?.status }));
  ok("-97 (lifecycle): discarding again is idempotent (200 already)", (await req("DELETE", "/api/files/" + n3)).data?.already === true);
  ok("-97 (lifecycle): a bad name is 400, an unknown name is 404", (await req("DELETE", "/api/files/not-a-name")).status === 400 && (await req("DELETE", "/api/files/" + "0".repeat(32) + ".png")).status === 404);
  // someone else's upload → 403 (ops is not Admin and not the uploader)
  const r4 = await upload("not-yours", "mine.png", "image/png");
  const n4 = String(r4.data.url).split("/").pop();
  const opsC = await loginAs("ops@vidysea.com", "CiOnly@123");
  const foreign = await fetch(BASE + "/api/files/" + n4, { method: "DELETE", headers: { cookie: opsC } });
  ok("-97 (lifecycle): only the uploader (or an Admin) may discard — Operations on the Admin's file → 403", foreign.status === 403, String(foreign.status));
  // a referenced file (attached to a saved candidate document) → 409 from the discard door; the record's own delete removes it → 410
  const candList = await req("GET", "/api/candidates?limit=1");
  const cand = (candList.data?.items ?? [])[0];
  if (cand) {
    const r5 = await upload("%PDF-1.4 aadhaar", "aadhaar.pdf", "application/pdf");
    const n5 = String(r5.data.url).split("/").pop();
    const att = await req("POST", `/api/candidates/${cand._id}/documents`, { doc_type: "Aadhaar", file_url: r5.data.url, original_name: "aadhaar.pdf" });
    const blocked = await req("DELETE", "/api/files/" + n5);
    ok("-97 (lifecycle): a file attached to a saved record cannot be discarded through the file door (409) — it leaves through the record", att.status === 201 && blocked.status === 409, `${att.status} ${blocked.status}`);
    const docId = att.data?.item?._id ?? att.data?._id;
    const rm = docId ? await req("DELETE", `/api/candidates/${cand._id}/documents/${docId}`) : { status: 0 };
    const gone = await fetch(BASE + "/api/files/" + n5, { headers: { cookie } });
    const row5 = await sf.findOne({ name: n5 });
    ok("-97 (lifecycle): deleting the candidate document deletes the stored object too — URL 410, row 'deleted'", rm.status === 200 && gone.status === 410 && row5?.status === "deleted", JSON.stringify({ rm: rm.status, gone: gone.status, s: row5?.status }));
    // -101: REPLACING a document type used to delete the row and leave its object readable and
    // unreferenced in the bucket — an orphan nobody could see in any list. Replace now removes it.
    const rA = await upload("%PDF-1.4 first", "aadhaar-v1.pdf", "application/pdf");
    const nA = String(rA.data.url).split("/").pop();
    const attA = await req("POST", `/api/candidates/${cand._id}/documents`, { doc_type: "Aadhaar", file_url: rA.data.url, original_name: "aadhaar-v1.pdf" });
    const rB = await upload("%PDF-1.4 corrected", "aadhaar-v2.pdf", "application/pdf");
    const attB = await req("POST", `/api/candidates/${cand._id}/documents`, { doc_type: "Aadhaar", file_url: rB.data.url, original_name: "aadhaar-v2.pdf" });
    const oldGone = await fetch(BASE + "/api/files/" + nA, { headers: { cookie } });
    const oldRow = await sf.findOne({ name: nA });
    const newRead = await fetch(BASE + String(rB.data.url).replace(/^\/erp/, ""), { headers: { cookie } });
    ok("-101: re-uploading the same doc_type removes the superseded file from storage (410, row 'deleted') and keeps the new one readable",
      attA.status === 201 && attB.status === 201 && oldGone.status === 410 && oldRow?.status === "deleted" && newRead.status === 200,
      JSON.stringify({ a: attA.status, b: attB.status, old: oldGone.status, s: oldRow?.status, nw: newRead.status }));
    const docsNow = (await req("GET", `/api/candidates/${cand._id}/documents`)).data.items ?? [];
    ok("-101: …and only one Aadhaar row survives the replace", docsNow.filter((d) => d.doc_type === "Aadhaar").length === 1, String(docsNow.filter((d) => d.doc_type === "Aadhaar").length));
    // clean up the fixture document so the candidate is left as found
    const bId = attB.data?.item?._id ?? attB.data?._id;
    if (bId) await req("DELETE", `/api/candidates/${cand._id}/documents/${bId}`);
  } else ok("-97 (lifecycle): candidate available for the attach/delete pin", false, "no candidate in CI");

  // "where did it go": Admin list, filterable, console link shape (gcs only), non-admin 403
  const list = await req("GET", "/api/files?prefix=TEST-CENTRE/TEST-BATCH-01&limit=20");
  ok("-97 (visibility): GET /api/files lists stored files newest-first with folder_path, status, uploader, url", list.status === 200 && Array.isArray(list.data?.items) && list.data.items.length > 0 && list.data.items.every((i) => /^TEST-CENTRE\/TEST-BATCH-01/.test(i.folder_path ?? "")) && list.data.items[0].url?.startsWith("/erp/api/files/") && "console_url" in list.data.items[0] && list.data.layout === "<Centre>/<Batch>/<kind>/<file>", JSON.stringify(list.data?.items?.[0]));
  ok("-97 (visibility): status filter works and deleted rows are kept in the list as the audit trail", (await req("GET", "/api/files?status=deleted&limit=5")).data?.items?.some((i) => i.name === n3 && i.status === "deleted") === true);
  const forbidden = await fetch(BASE + "/api/files?limit=1", { headers: { cookie: opsC } });
  ok("-97 (visibility): the file list is Admin-only (Operations → 403)", forbidden.status === 403, String(forbidden.status));
  // CORS hygiene: production origin only (the wall sets APP_ORIGIN to the production origin)
  const envNow = (await req("GET", "/api/test-storage")).data?.env;
  ok("-97 (hygiene): the CORS rule names ONLY the production origin (no localhost on the production bucket)", Array.isArray(envNow?.cors_rule?.origin) && envNow.cors_rule.origin.length === 1 && envNow.cors_rule.origin[0] === "https://www.vidysea.com", JSON.stringify(envNow?.cors_rule?.origin));
  await mc.close();
}

// ---- -98 (QA-163, checker): stored evidence needs a LOGIN — anonymous 401 (the 32-hex name stays
// as the second layer); same-origin tags send the cookie; the sync engine's loopback read of an
// uploaded sheet still works through the internal header (never exposed). ----
{
  const fd = new FormData();
  fd.append("file", new File([Buffer.from("TC ID,Name\nTC-1,Asha\nTC-2,Ravi\n")], "roster.csv", { type: "text/csv" }));
  fd.append("folder_centre", "TEST-CENTRE"); fd.append("folder_batch", "TEST-BATCH-01"); fd.append("folder_kind", "sheets");
  const up = await fetch(BASE + "/api/upload", { method: "POST", headers: { cookie }, body: fd });
  const upJ = await up.json();
  const url = String(upJ.url ?? "");
  const anon = await fetch(BASE + url.replace(/^\/erp/, ""));
  ok("-98 (QA-163): an ANONYMOUS read of a stored file is refused (401) — the link alone no longer opens evidence", anon.status === 401, String(anon.status));
  const anonRange = await fetch(BASE + url.replace(/^\/erp/, ""), { headers: { Range: "bytes=0-4" } });
  ok("-98 (QA-163): …a Range request without a session is refused too", anonRange.status === 401, String(anonRange.status));
  const authed = await fetch(BASE + url.replace(/^\/erp/, ""), { headers: { cookie } });
  ok("-98 (QA-163): a signed-in read still serves the bytes (200) — same-origin <img>/<video>/PDF viewers send the cookie", authed.status === 200 && /TC-1,Asha/.test(await authed.text()), String(authed.status));
  const forged = await fetch(BASE + url.replace(/^\/erp/, ""), { headers: { "x-erp-internal-file": "0".repeat(64) } });
  ok("-98 (QA-163): a forged internal header is refused (401)", forged.status === 401, String(forged.status));
  // the sync engine's loopback read of a sheet uploaded INTO the ERP (safe-fetch's narrow exception) still probes green
  const probe = await req("POST", "/api/sync-sources/test", { source_url: `http://127.0.0.1:${new URL(BASE).port || 3000}${url}` });
  ok("-98 (QA-163): the sync engine can still read an uploaded sheet over loopback (internal header, never exposed) — probe green with its columns", probe.data?.ok === true && JSON.stringify(probe.data?.tabs ?? []).includes("TC ID"), `${probe.status} ${JSON.stringify(probe.data).slice(0, 160)}`);
}

// ---- -87 (QA-157, Umesh 15/08: "jo kuch bhi media jaye — sab compress"): the ONE door compresses ----
{
  const sharp = (await import("sharp")).default;
  const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: { r: 200, g: 120, b: 40 } } })
    .composite([{ input: Buffer.from(`<svg width="3000" height="2000"><rect x="100" y="100" width="1200" height="800" fill="#123456"/><text x="200" y="600" font-size="200" fill="#fff">EVIDENCE</text></svg>`), top: 0, left: 0 }])
    .jpeg({ quality: 95 }).toBuffer();
  const fdBig = new FormData();
  fdBig.append("file", new File([big], "field-photo.jpg", { type: "image/jpeg" }));
  const upBig = await (await fetch(BASE + "/api/upload", { method: "POST", headers: { cookie }, body: fdBig })).json();
  ok("-87: a 3000×2000 photo is compressed at the storage door (label image-1600-q75, stored < original)",
    upBig.compression === "image-1600-q75" && upBig.size < upBig.original_size && upBig.original_size === big.length, JSON.stringify({ o: upBig.original_size, s: upBig.size, c: upBig.compression }));
  const backBig = Buffer.from(await (await fetch(BASE + String(upBig.url).replace(/^\/erp/, ""), { headers: { cookie } })).arrayBuffer());
  const metaBig = await sharp(backBig).metadata();
  ok("-87: what reads back is the compressed image — longest edge 1600, still a JPEG", metaBig.width === 1600 && metaBig.height === 1067 && metaBig.format === "jpeg" && backBig.length === upBig.size, JSON.stringify({ w: metaBig.width, h: metaBig.height, f: metaBig.format }));
  {
    const { MongoClient } = await import("mongodb");
    const mc = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
    await mc.connect();
    const row = await mc.db(process.env.MONGODB_DB || "center_erp_ci").collection("storedfiles").findOne({ name: String(upBig.url).split("/").pop() });
    await mc.close();
    ok("-87: the StoredFile row records original vs stored + the label", !!row && row.original_size === big.length && row.size === upBig.size && row.compressed === true && row.compression === "image-1600-q75" && typeof row.compression_ms === "number", JSON.stringify(row && { o: row.original_size, s: row.size, c: row.compression, comp: row.compressed }));
  }
  const small = await sharp({ create: { width: 200, height: 150, channels: 3, background: { r: 10, g: 200, b: 90 } } }).png().toBuffer();
  const fdSmall = new FormData();
  fdSmall.append("file", new File([small], "tiny.png", { type: "image/png" }));
  const upSmall = await (await fetch(BASE + "/api/upload", { method: "POST", headers: { cookie }, body: fdSmall })).json();
  ok("-87: a tiny image is left alone and SAYS so (none:already small)", upSmall.compression === "none:already small" && upSmall.size === small.length && /\.png$/.test(upSmall.url), JSON.stringify({ c: upSmall.compression, s: upSmall.size }));
  const pdf = Buffer.from(["%PDF-1.4", "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj", "trailer<</Root 1 0 R>>", "%%EOF"].join(String.fromCharCode(10)));
  const fdPdf = new FormData();
  fdPdf.append("file", new File([pdf], "scan.pdf", { type: "application/pdf" }));
  const upPdf = await (await fetch(BASE + "/api/upload", { method: "POST", headers: { cookie }, body: fdPdf })).json();
  ok("-87: a PDF passes the door with a recorded verdict (Ghostscript pass, or 'none:gs …' where gs is absent, never silent)",
    typeof upPdf.compression === "string" && (/^pdf-gs-ebook$/.test(upPdf.compression) || /^none:(gs |original smaller)/.test(upPdf.compression)), JSON.stringify(upPdf.compression));
  const mp4 = Buffer.alloc(1024, 1);
  const fdMp4 = new FormData();
  fdMp4.append("file", new File([mp4], "clip.mp4", { type: "video/mp4" }));
  const upMp4 = await (await fetch(BASE + "/api/upload", { method: "POST", headers: { cookie }, body: fdMp4 })).json();
  ok("-87: video is untouched here and says why (client-side compress-first is the next release)", /^none:video/.test(upMp4.compression ?? "") && upMp4.size === 1024, JSON.stringify(upMp4.compression));
  // -91 (Umesh: "pehle compress, phir upload"): when the DEVICE compressed the clip, it says so and the row records it.
  const fdWebm = new FormData();
  fdWebm.append("file", new File([Buffer.alloc(2048, 3)], "evidence-2026-08-16.webm", { type: "video/webm" }));
  fdWebm.append("client_compression", "video-720p-1500k"); fdWebm.append("client_original_size", String(50 * 1024 * 1024));
  const upWebm = await (await fetch(BASE + "/api/upload", { method: "POST", headers: { cookie }, body: fdWebm })).json();
  ok("-91: an in-app/browser-compressed video (.webm) is accepted and the row records client:video-720p-1500k with the original size", upWebm.compression === "client:video-720p-1500k" && upWebm.original_size === 50 * 1024 * 1024 && /\.webm$/.test(upWebm.url), JSON.stringify({ c: upWebm.compression, o: upWebm.original_size, u: upWebm.url }));
  const rdWebm = await fetch(BASE + String(upWebm.url).replace(/^\/erp/, ""), { headers: { cookie } });
  ok("-91: .webm reads back as video/webm inline", rdWebm.status === 200 && rdWebm.headers.get("content-type") === "video/webm" && /^inline/.test(rdWebm.headers.get("content-disposition") ?? ""), `${rdWebm.headers.get("content-type")}`);
  {
    const { MongoClient } = await import("mongodb");
    const mc = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017");
    await mc.connect();
    const row = await mc.db(process.env.MONGODB_DB || "center_erp_ci").collection("storedfiles").findOne({ name: String(upWebm.url).split("/").pop() });
    await mc.close();
    ok("-91: StoredFile row: compressed=true, compression client:…, needs_compression=false", !!row && row.compressed === true && row.compression === "client:video-720p-1500k" && row.needs_compression === false, JSON.stringify(row && { c: row.compression, comp: row.compressed, need: row.needs_compression }));
  }
  const defsV = (await req("GET", "/api/defaults", undefined, 200)).data.item;
  ok("-91: Defaults carry the video knobs (compress on, 720p, 1500 kbps, 64 kbps)", defsV.video_compress === true && Number(defsV.video_max_height) === 720 && Number(defsV.video_bitrate_kbps) === 1500 && Number(defsV.video_audio_kbps) === 64, JSON.stringify({ c: defsV.video_compress, h: defsV.video_max_height, b: defsV.video_bitrate_kbps, a: defsV.video_audio_kbps }));
  await req("PUT", "/api/defaults", { video_max_height: 480, video_bitrate_kbps: 800 }, 200);
  const defsV2 = (await req("GET", "/api/defaults", undefined, 200)).data.item;
  ok("-91: the video knobs are live-tunable", Number(defsV2.video_max_height) === 480 && Number(defsV2.video_bitrate_kbps) === 800);
  await req("PUT", "/api/defaults", { video_max_height: 720, video_bitrate_kbps: 1500 }, 200);
  // knobs: the door reads Defaults — turn the edge to 800 and a fresh upload obeys
  const defsBefore = (await req("GET", "/api/defaults", undefined, 200)).data.item ?? (await req("GET", "/api/defaults")).data;
  ok("-87: Defaults carry the compression knobs (image_max_px 1600, image_quality 75, pdf_compress on)", Number(defsBefore.image_max_px) === 1600 && Number(defsBefore.image_quality) === 75 && defsBefore.pdf_compress !== false, JSON.stringify({ px: defsBefore.image_max_px, q: defsBefore.image_quality, pdf: defsBefore.pdf_compress }));
  await req("PUT", "/api/defaults", { image_max_px: 800 }, 200);
  const fdBig2 = new FormData();
  fdBig2.append("file", new File([big], "field-photo-2.jpg", { type: "image/jpeg" }));
  const upBig2 = await (await fetch(BASE + "/api/upload", { method: "POST", headers: { cookie }, body: fdBig2 })).json();
  const back2 = Buffer.from(await (await fetch(BASE + String(upBig2.url).replace(/^\/erp/, ""), { headers: { cookie } })).arrayBuffer());
  ok("-87: turning the knob changes the next upload (800 px edge, label image-800-q75)", upBig2.compression === "image-800-q75" && (await sharp(back2).metadata()).width === 800, JSON.stringify(upBig2.compression));
  await req("PUT", "/api/defaults", { image_max_px: 1600 }, 200);
}

// ---- QA-115 (15/08): the mail layer — CI runs UNCONFIGURED, so this pins the SKIP path:
// hooks fire (MailLog rows appear), sends are recorded as skipped, and no business flow
// ever breaks on mail. Real sending is proven live via the admin test-email endpoint.
{
  const cfg = (await req("GET", "/api/test-email", undefined, 200)).data;
  ok("QA-115: CI reports mail unconfigured (skip path active)", cfg.configured === false, JSON.stringify(cfg.configured));
  // The self-registration earlier in this suite must have left a SKIPPED confirmation row
  // for the candidate's address. The send is fire-and-forget — poll briefly for the row.
  const wantTo = `selfreg.${stamp}@test.local`;
  let row = null;
  for (let i = 0; i < 10 && !row; i++) {
    const log = (await req("GET", "/api/test-email", undefined, 200)).data.log ?? [];
    row = log.find((l) => l.to === wantTo);
    if (!row) await new Promise((r) => setTimeout(r, 200));
  }
  ok("QA-115: the register hook attempted the confirmation mail (MailLog row exists)", !!row, wantTo);
  // QA-129 (-69): the structural test-environment gate fires BEFORE the config check now,
  // so the honest reason on a wall is "test environment (…)"; "not configured" stays valid
  // for a non-test env without creds.
  ok("QA-115: …and it is honestly 'skipped' with the reason named", row?.status === "skipped" && /not configured|test environment/.test(row?.reason ?? ""), JSON.stringify({ s: row?.status, r: row?.reason }));
  // Verify endpoint contract: admin POST without creds → 400 naming configuration.
  const post = await req("POST", "/api/test-email", {});
  ok("QA-115: admin test-email without creds → 400 naming the env gap", post.status === 400 && /not configured|environment/.test(post.data?.error ?? ""), `${post.status} ${post.data?.error ?? ""}`);
  // Non-admin never reaches the mail surface.
  const opsCookie2 = await loginAs("ops@vidysea.com", "CiOnly@123");
  const denied = await fetch(BASE + "/api/test-email", { headers: { cookie: opsCookie2 } });
  ok("QA-115: non-admin test-email → 403", denied.status === 403, String(denied.status));
}

// ---- QA-1195: the Details save now SPEAKS, and these pin the SERVER half it speaks from ----
// Reported by Umesh (25/08) as "details save nahi ho rahi" and measured to be the opposite: the
// PATCH persists every field on that form and answers 200, while the screen rendered NOTHING -
// no success line, no error, and the `warning` this route computes was thrown away by
// EditDetails. So a save that worked and a save that did nothing were identical from the seat.
//
// HONEST SCOPE, because a pin that overclaims is worse than none (REQ-388, QA-696): the FIX is a
// client render and these two assertions do NOT prove it - they were green before the fix and the
// proof of the fix is a real-browser A/B recorded in the manifest. What they DO hold is the
// contract the new render depends on: if this route stops answering with a warning, or stops
// moving the field, the screen goes silent again and nothing else in this suite would notice.
{
  const dLoc = (await req("POST", "/api/locations", { code: "QL" + stamp, name: "QA1195 Loc " + stamp, external_id: "QX" + stamp, approval_status: "Approved", spoc_name: "S", principal_name: "P" }, 201)).data.item;
  const dRoom = (await req("POST", `/api/locations/${dLoc._id}/rooms`, { name: "QA1195 Room", type: "Classroom", capacity: 30 }, 201)).data.item;
  const dTr = (await req("POST", "/api/trainers", { name: "QA1195 Tr " + stamp, phone: "955" + stamp.padEnd(7, "0").slice(0, 7), skills: ["TestSkill" + stamp] }, 201)).data.item;
  const dProgB = (await req("POST", "/api/programs", { code: "QP" + stamp, name: "QA1195 Prog B " + stamp, trainer_skill: "TestSkill" + stamp, duration_days: 15, buffer_days: 5, default_batch_size: 30, completion_deadline_days: 90 }, 201)).data.item;
  const _f = new Date(Date.now() + 45 * 86400000);
  const fStart = `${_f.getFullYear()}-${String(_f.getMonth() + 1).padStart(2, "0")}-${String(_f.getDate()).padStart(2, "0")}`;
  const dB = (await req("POST", "/api/batches", { location: dLoc._id, program: prog._id, trainer: dTr._id, room: dRoom._id, planned_start: fStart, target_size: 5 }, 201)).data.item;

  // The EXACT payload EditDetails sends on an ordinary click, with NOTHING on the form changed -
  // location/program are dropped by the form's own unchanged-guard, so they are absent here too.
  const unchanged = {
    trainer: dB.trainer ? String(dB.trainer) : null,
    room: dB.room ? String(dB.room) : null,
    session: dB.session,
    planned_start: fStart,
    planned_end: String(dB.planned_end ?? "").slice(0, 10),
    target_size: dB.target_size,
    slot_start: dB.slot_start ?? "",
    slot_end: dB.slot_end ?? "",
    relevant_skills: dB.relevant_skills ?? [],
    govt_batch_id: dB.govt_batch_id ?? "",
  };
  const q = await req("PATCH", `/api/batches/${dB._id}`, unchanged, 200);
  ok("QA-1195: an ordinary Details save answers WITH the warning the form now prints - this trainer is not certified and carries no TR ID for the portal",
    typeof q.data?.warning === "string" && q.data.warning.trim().length > 0,
    JSON.stringify(q.data?.warning ?? null).slice(0, 180));

  // ...and the save it was accused of not doing really does move the field. Planning + empty
  // roster is exactly the pair route.ts:104 requires, and it is the state Umesh's batch was in.
  await req("PATCH", `/api/batches/${dB._id}`, { ...unchanged, program: dProgB._id }, 200);
  const dRe = (await req("GET", `/api/batches/${dB._id}`, undefined, 200)).data.item;
  ok("QA-1195: changing the job role on a Planning batch with an empty roster really persists - the save was never the broken half",
    String(dRe?.program?._id ?? dRe?.program) === String(dProgB._id),
    JSON.stringify({ wanted: String(dProgB._id), got: String(dRe?.program?._id ?? dRe?.program) }));
}

// ---- public build marker (deploy verification, no auth) ----
const verRes = await fetch(BASE + "/api/public/version");
const verBody = await verRes.json().catch(() => ({}));
ok("version endpoint is public and names the release", verRes.status === 200 && !!verBody.release, `status=${verRes.status} ${JSON.stringify(verBody).slice(0, 80)}`);
// -249 (QA-1202): `release` is HAND-BUMPED, so it names what the last editor of version.ts intended,
// not what is running. On 2026-08-25 production served four commits past its own marker and the
// string `-246` truthfully named two different trees in one afternoon - one where QA-1145 was a
// live defect and one where it was fixed - so every validated_on_release stamp in that window is
// unfalsifiable. `build_id` comes from .next/BUILD_ID, which Next rewrites on EVERY build, so two
// responses sharing a `release` and differing in `build_id` are two different BUILDS - a rebuild of
// the same commit changes it too, so it proves a redeploy happened, NOT that the source moved
// (-250, QA-1270: cycle 1 said "trees" and the checker disproved it on byte-identical source).
// Strict !== null: on the pre-fix build this field does not exist at all, so this pin goes red there.
ok("-249 (QA-1202): the version endpoint identifies the BUILD, not just the hand-bumped release name",
  verBody.build_id !== null && verBody.build_id !== undefined && String(verBody.build_id).length > 0,
  `build_id=${JSON.stringify(verBody.build_id)} release=${JSON.stringify(verBody.release)}`);
// The commit stays null until CodeBuild passes --build-arg GIT_COMMIT (a devops action, and the
// Dockerfile now declares the ARG for it). Asserting the KEY is present keeps the contract visible
// without pretending the pipeline is wired - and turns red if someone deletes the field.
ok("-249 (QA-1202): ...and still carries the commit slot for when CodeBuild passes the SHA",
  Object.prototype.hasOwnProperty.call(verBody, "commit"),
  `keys=${Object.keys(verBody).join(",")}`);
// -250 (QA-1309): `commit` is null OR a real sha - never "". -249's own Dockerfile made the variable
// ALWAYS set (ARG GIT_COMMIT="" + ENV GIT_COMMIT=$GIT_COMMIT), and `??` does not collapse an empty
// string, so live production answered `"commit":""` while this file, route.ts and OPERATIONS.md all
// promised `null`, and wait-for-release.mjs printed a blank where it used to print "(not set)".
// HONEST LIMIT, stated rather than implied: the wall's own server runs with GIT_COMMIT UNSET, so this
// passes on BOTH builds here and does NOT discriminate locally. What discriminates is the live
// measurement (prod on -249 returned "") and the three-state proof: unset->null both ways,
// ""->"" old vs ""->null new, sha->sha both ways. Recorded so nobody counts this as a pin it is not.
ok("-250 (QA-1309): commit is null or a real sha, never an empty string",
  verBody.commit === null || (typeof verBody.commit === "string" && verBody.commit.length > 0),
  `commit=${JSON.stringify(verBody.commit)}`);
// QA-099 (15/08): the app sends security headers now — frame-deny, sniff-deny, HSTS.
ok("QA-099: X-Frame-Options DENY", verRes.headers.get("x-frame-options") === "DENY", String(verRes.headers.get("x-frame-options")));
ok("QA-099: nosniff", verRes.headers.get("x-content-type-options") === "nosniff");
ok("QA-099: HSTS present", /max-age=\d+/.test(verRes.headers.get("strict-transport-security") ?? ""), String(verRes.headers.get("strict-transport-security")));

// -111 (Umesh 18/08, "rule this, rule that — user ko direct rule dikha deta hai"): not one API
// refusal in this whole run carried a Rule/DEC/QA code — plain() at apiHandler is the door.
ok(`-111: no API error in this run carries a Rule/DEC/QA code (${codeLeaks.length} leak(s))`, codeLeaks.length === 0, codeLeaks.slice(0, 5).join(" | "));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
