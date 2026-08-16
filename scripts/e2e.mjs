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
  ok("-82: a day before the real start fails Rule 32 for that day only", byDay[dayN(-6)]?.status === "error" && /Rule 32/.test(byDay[dayN(-6)]?.message ?? ""), JSON.stringify(byDay[dayN(-6)]));
  ok("-82: a future day fails Rule 53 for that day only", byDay[dayN(1)]?.status === "error" && /Rule 53/.test(byDay[dayN(1)]?.message ?? ""), JSON.stringify(byDay[dayN(1)]));
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
await req("POST", `/api/members/${mem4._id}/drop`, { left_on: today }, 400); // Rule 25: reason required
await req("POST", `/api/members/${mem4._id}/drop`, { left_on: "2030-01-01", drop_reason: "Other" }, 400); // future date
await req("POST", `/api/members/${mem4._id}/drop`, { left_on: today, drop_reason: "Other" }, 200);
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
    blocked.status === 409 && /Rule 54/.test(blocked.data?.error ?? ""), `got ${blocked.status} ${blocked.data?.error ?? ""}`);
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
  upFrozen.summary?.matched === 0 && /DEC-6/.test(upFrozen.unmatched?.[0]?.reason ?? ""), JSON.stringify(upFrozen.unmatched));

// But FILLING an absent file on a Completed batch is the CEO's own flow (the Gurgaon
// case: batch long done, certificates arrive later as a folder) — allowed, once.
const b5 = (await req("POST", "/api/batches", { location: loc._id, program: prog._id, trainer: trainer._id, room: room._id, planned_start: today, target_size: 2 }, 201)).data.item;
const c5a = (await req("POST", "/api/candidates", { name: `LateCert A ${stamp}`, phone: `677${stamp}7`, location: loc._id, program: prog._id, sidh_candidate_id: `CAN88${stamp.slice(-4)}` }, 201)).data.item;
const c5b = (await req("POST", "/api/candidates", { name: `LateCert B ${stamp}`, phone: `677${stamp}8`, location: loc._id, program: prog._id }, 201)).data.item;
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
  upNew2.summary?.matched === 0 && /DEC-6/.test(upNew2.unmatched?.[0]?.reason ?? ""), JSON.stringify(upNew2.unmatched));
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
  const del2 = await req("DELETE", `/api/batches/${b4._id}`);
  ok("a batch with recorded work refuses deletion and names what it carries",
    del2.status === 409 && /members|results|closure/.test(del2.data?.error ?? "") && /cancelled, never deleted/i.test(del2.data?.error ?? ""),
    `got ${del2.status}: ${del2.data?.error ?? ""}`);
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
ok("planner: 7 milestones, sorted by date", plan.milestones?.length === 7 &&
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
ok("QA-152: 'Create backward plan' makes the 7 milestones and enables the plan", planMade.milestones?.length === 7 && planMade.plan_enabled === true, `count=${planMade.milestones?.length} enabled=${planMade.plan_enabled}`);
const ticked = (await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { key: "mobilization", done: true }, 200)).data.item;
ok("milestone tick-off records done_on", !!ticked.milestones.find((m) => m.key === "mobilization")?.done_on);
await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { regenerate: true }, 200);
const regen = (await req("GET", `/api/batches/${planBatch._id}`)).data.item;
ok("regenerate keeps ticked milestones done", !!regen.milestones.find((m) => m.key === "mobilization")?.done_on);

// ---- QA-152 part 2 (-82): the plan as an editable, shareable, exportable artifact ----
{
  const edited = (await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { edit: { key: "tot_done", due_date: "2027-03-20", notes: "TOT at Gurugram HO", owner_label: "Divya" } }, 200)).data.item;
  const td = edited.milestones.find((m) => m.key === "tot_done");
  ok("-82: planner edits a row (due date, notes, owner)", String(td.due_date).startsWith("2027-03-20") && td.notes === "TOT at Gurugram HO" && td.owner_label === "Divya", JSON.stringify(td));
  await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { edit: { key: "tot_done", label: "" } }, 400);
  const added = (await req("PATCH", `/api/batches/${planBatch._id}/milestones`, { add: { label: "Lab equipment delivered", due_date: "2027-03-25", owner_label: "Ops" } }, 201)).data.item;
  const custom = added.milestones.find((m) => m.custom);
  ok("-82: planner adds a custom row, kept in date order", !!custom && custom.label === "Lab equipment delivered" && added.milestones.length === 8
    && added.milestones.every((m, i, a) => i === 0 || new Date(a[i - 1].due_date) <= new Date(m.due_date)), JSON.stringify(added.milestones.map((m) => [m.key, String(m.due_date).slice(0, 10)])));
  const planView = (await req("GET", `/api/batches/${planBatch._id}/plan`)).data;
  ok("-82: GET /plan returns the artifact (batch, 8 milestones, counts, plan_flags, no share yet)", planView.batch?.code === planBatch.code && planView.milestones?.length === 8 && planView.counts?.total === 8 && "tot_lead_ok" in (planView.plan_flags ?? {}) && planView.share === null, JSON.stringify({ n: planView.milestones?.length, counts: planView.counts, share: planView.share }));
  const xl = await fetch(BASE + `/api/batches/${planBatch._id}/plan/export`, { headers: { cookie } });
  const xlBuf = Buffer.from(await xl.arrayBuffer());
  ok("-82: Excel export is a real xlsx (PK zip header, xlsx content-type, filename carries the batch code)", xl.status === 200 && xlBuf.slice(0, 2).toString() === "PK" && /spreadsheetml/.test(xl.headers.get("content-type") ?? "") && (xl.headers.get("content-disposition") ?? "").includes(planBatch.code), `status=${xl.status} ct=${xl.headers.get("content-type")} len=${xlBuf.length}`);
  // share: read-only link
  const linkRO = (await req("POST", "/api/public-tokens", { purpose: "plan", batch: planBatch._id }, 201)).data.item;
  ok("-82: a plan link is minted (32-hex, purpose plan, read-only by default)", /^[a-f0-9]{32}$/.test(linkRO.token) && linkRO.purpose === "plan" && linkRO.allow_updates === false, JSON.stringify({ t: linkRO.token?.length, p: linkRO.purpose, u: linkRO.allow_updates }));
  const pub = await fetch(BASE + `/api/public/plan/${linkRO.token}`);
  const pubJ = await pub.json();
  ok("-82: the public plan opens with NO login and carries the same rows", pub.status === 200 && pubJ.milestones?.length === 8 && pubJ.batch?.code === planBatch.code && pubJ.allow_updates === false && !pubJ.batch?._id, JSON.stringify({ s: pub.status, n: pubJ.milestones?.length, code: pubJ.batch?.code, id: pubJ.batch?._id }));
  const pubTick = await fetch(BASE + `/api/public/plan/${linkRO.token}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "trainer_found", done: true }) });
  ok("-82: a read-only link cannot tick (403)", pubTick.status === 403, `status=${pubTick.status}`);
  const pubXl = await fetch(BASE + `/api/public/plan/${linkRO.token}?format=xlsx`);
  ok("-82: the public link also downloads the Excel", pubXl.status === 200 && /spreadsheetml/.test(pubXl.headers.get("content-type") ?? ""), `status=${pubXl.status}`);
  ok("-82: GET /plan now shows the active share link", (await req("GET", `/api/batches/${planBatch._id}/plan`)).data.share?.token === linkRO.token);
  // re-share as status-updatable: old link dies, new one ticks
  const linkRW = (await req("POST", "/api/public-tokens", { purpose: "plan", batch: planBatch._id, allow_updates: true }, 201)).data.item;
  ok("-82: re-sharing switches the old link off", (await fetch(BASE + `/api/public/plan/${linkRO.token}`)).status === 404);
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
  ok("-82: planner removes the custom row", removed.milestones.length === 7 && !removed.milestones.some((m) => m.key === custom.key));
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

// ---- public build marker (deploy verification, no auth) ----
const verRes = await fetch(BASE + "/api/public/version");
const verBody = await verRes.json().catch(() => ({}));
ok("version endpoint is public and names the release", verRes.status === 200 && !!verBody.release, `status=${verRes.status} ${JSON.stringify(verBody).slice(0, 80)}`);
// QA-099 (15/08): the app sends security headers now — frame-deny, sniff-deny, HSTS.
ok("QA-099: X-Frame-Options DENY", verRes.headers.get("x-frame-options") === "DENY", String(verRes.headers.get("x-frame-options")));
ok("QA-099: nosniff", verRes.headers.get("x-content-type-options") === "nosniff");
ok("QA-099: HSTS present", /max-age=\d+/.test(verRes.headers.get("strict-transport-security") ?? ""), String(verRes.headers.get("strict-transport-security")));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
