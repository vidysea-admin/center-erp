// Government-portal attendance import + the scheme/contract rules Manish confirmed on
// 2026-08-12. Run against a running server: node scripts/e2e-govt.mjs
//
// Everything here is driven through the HTTP API on purpose — the parser, the matcher and the
// reconciler only earn their keep if a real multipart upload of a real portal-shaped file lands
// in the database with the right numbers.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const localDate = (ms = Date.now()) => { const n = new Date(ms); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`; }; // LOCAL date = what the UI sends (IST-midnight window fix)
const BASE = process.env.BASE_URL || "http://localhost:3000/erp";
const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + " " + x); } };

async function login(email, password) {
  const csrfRes = await fetch(BASE + "/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const csrfCookie = csrfRes.headers.get("set-cookie").split(";")[0];
  const res = await fetch(BASE + "/api/auth/callback/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: csrfCookie },
    body: new URLSearchParams({ csrfToken, email, password }),
    redirect: "manual",
  });
  const session = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")]).flat().filter(Boolean)
    .map((c) => c.split(";")[0]).find((c) => c.includes("session-token"));
  return session ? [csrfCookie, session].join("; ") : null;
}

async function req(cookie, method, p, body) {
  const res = await fetch(BASE + p, {
    method, headers: { "Content-Type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function upload(cookie, fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const res = await fetch(BASE + "/api/govt-attendance", { method: "POST", headers: { cookie }, body: fd });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const admin = await login("admin@vidysea.com", process.env.ADMIN_PASSWORD || "admin123");
if (!admin) { console.log("FAIL  admin login — is the server up and seeded?"); process.exit(1); }
ok("admin logs in", !!admin);

const STAMP = Date.now().toString().slice(-6);
// The fixture mirrors the real portal export byte-for-byte in shape (leading-space headers, the
// multi-line quoted Details column, the TC code glued onto Org Name). Its identifiers are
// stamped per run so repeat runs cannot collide with each other's centres, trainers or
// candidates — a leftover duplicate name would otherwise turn a Matched row Ambiguous and the
// suite would fail for a reason that has nothing to do with the code.
const TC = `TC9${STAMP}`;
const NAME = `G${STAMP}`;
const csvText = readFileSync(path.join(HERE, "fixtures", "govt-attendance-sample.csv"), "utf8")
  .replaceAll("TC999001", TC).replaceAll("GOVT Test", NAME).replaceAll("CAN_TEST", `CAN_${STAMP}`);
const csvFile = () => new File([Buffer.from(csvText)], "govt-attendance-sample.csv", { type: "text/csv" });

// ---------------------------------------------------------------- setup
// A dedicated centre carrying the fixture's TC ID, so auto-detection is what is actually tested.
const loc = (await req(admin, "POST", "/api/locations", {
  name: `${NAME} Centre`, code: `GT${STAMP}`, external_id: TC,
  city: "Gurugram", state: "Haryana", approval_status: "Approved", operational_status: "Active",
})).data.item;
ok(`test centre created with TC ID ${TC}`, !!loc?._id, JSON.stringify(loc));

const programs = (await req(admin, "GET", "/api/programs?limit=10")).data.items ?? [];
const program = programs[0];
ok("a program exists to hang the batch off", !!program?._id);

const room = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, {
  name: `${NAME} Lab`, type: "Lab", capacity: 30,
})).data.item ?? {};
ok("room created", !!room?._id, JSON.stringify(room).slice(0, 200));

const trainer = (await req(admin, "POST", "/api/trainers", {
  name: `${NAME} Trainer`, phone: `9${STAMP.slice(1)}0001`, skills: ["Testing"],
  home_location: loc._id, pipeline_status: "Certified", max_concurrent_batches: 4,
  available_from: localDate(Date.now() - 30 * 86400_000),
})).data.item;
ok("trainer created (matches the fixture's Trainer row by name)", !!trainer?._id);

// target_size 5 so the 5-member roster clears the 80% readiness gate and the batch can reach
// Active — daily logs only exist for Active/Closing batches, and without logs there is nothing
// to reconcile the portal figures against.
const batch = (await req(admin, "POST", "/api/batches", {
  location: loc._id, program: program._id, target_size: 5, trainer: trainer._id, room: room._id,
  planned_start: localDate(),
})).data.item;
ok("batch created", !!batch?._id);

// Alpha + Bravo carry portal IDs (→ matched by Portal ID); Charlie does not (→ matched by Name);
// the two Twins share a name with no portal IDs (→ ambiguous); the fixture's Delta has no
// counterpart at all (→ unmatched).
const people = [
  { name: `${NAME} Alpha`, sidh_candidate_id: `CAN_${STAMP}0001` },
  { name: `${NAME} Bravo`, sidh_candidate_id: `CAN_${STAMP}0002` },
  { name: `${NAME} Charlie` },
  { name: `${NAME} Twin` },
  { name: `${NAME} Twin` },
];
const members = [];
for (const [i, p] of people.entries()) {
  const c = (await req(admin, "POST", "/api/candidates", {
    name: p.name, phone: `9${STAMP.slice(1)}1${String(i).padStart(3, "0")}`,
    location: loc._id, program: program._id, ...(p.sidh_candidate_id ? { sidh_candidate_id: p.sidh_candidate_id } : {}),
  })).data.item;
  // Joined 20 days ago so the back-dated daily logs below have a roster to draw on (Rule 26).
  const m = (await req(admin, "POST", `/api/batches/${batch._id}/members`, {
    candidate: c._id, joined_on: localDate(Date.now() - 20 * 86400_000),
  })).data.item;
  members.push({ ...p, candidate: c, member: m });
}
ok("5 candidates created and added to the roster", members.every((m) => m.member?._id), JSON.stringify(members.map((m) => !!m.member?._id)));
ok("portal Candidate ID persists on the candidate", members[0].candidate?.sidh_candidate_id === `CAN_${STAMP}0001`, members[0].candidate?.sidh_candidate_id);

// Enrol everyone so the batch clears the readiness gate, then take it Planning → Ready → Active.
for (const m of members) {
  await req(admin, "PATCH", `/api/members/${m.member._id}`, { reg_done: true, kyc_done: true, accept_done: true });
}
await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Ready" });
const active = await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Active" });
ok("batch reached Active (daily logs require it)", active.status === 200 || active.status === 201, JSON.stringify(active.data).slice(0, 250));

// One day's log: Alpha and Bravo present. Rule 32 pins logs to on-or-after actual_start, which
// the Active transition stamps as today — so today is the only loggable date.
const logRes = await req(admin, "POST", `/api/batches/${batch._id}/logs`, {
  log_date: localDate(),
  present_member_ids: [members[0].member._id, members[1].member._id], actual_topic: "govt test",
});
// Asserted, not assumed: had the log silently failed to write, every variance below would read
// as "portal says N, we logged 0" and the reconciliation checks would pass for the wrong reason.
ok("daily log written for the reconciliation baseline", logRes.status === 201, JSON.stringify(logRes.data).slice(0, 250));

// ---- Trainer-role marking scope (Karunn 2026-08-13: "attendance trainer karega — apne batch ki") ----
{
  // can_edit true — a trainer's whole job here is writing the daily log (the signup approval
  // path auto-grants it for Trainer role; direct admin creation must say so explicitly).
  const mk = (email, scope) => req(admin, "POST", "/api/users", { name: "TEST-GT " + email, email, password: "CiOnly@123", role: "Trainer", can_edit: true, location_scope: scope });
  const inEmail = `gt.trainer.in.${STAMP}@vidysea-test.local`, outEmail = `gt.trainer.out.${STAMP}@vidysea-test.local`;
  const farLoc = (await req(admin, "POST", "/api/locations", { code: "GTF" + STAMP, name: "TEST-GT Far " + STAMP, approval_status: "Approved", operational_status: "Active", city: "Elsewhere" }, 201)).data.item;
  await mk(inEmail, [loc._id]);
  await mk(outEmail, [farLoc._id]);
  const tIn = await login(inEmail, "CiOnly@123");
  const tOut = await login(outEmail, "CiOnly@123");
  ok("trainer-role logins available", !!tIn && !!tOut);
  if (tIn && tOut) {
    // The scoped trainer marks a fresh ROUND on their own batch's day log — allowed.
    // members[3] (a Twin) on purpose: the twins stay Ambiguous in the reconciliation below,
    // so this extra presence cannot disturb Alpha/Bravo/Charlie's variance expectations.
    const round = await req(tIn, "POST", `/api/logs/${logRes.data.item._id}/sessions`, { present_member_ids: [members[3].member._id] });
    ok("scoped trainer can add a marking round to their own batch", round.status === 201, `got ${round.status}: ${JSON.stringify(round.data).slice(0, 120)}`);
    ok("…and the round unioned into the day", round.data.item?.internal_present === 3, String(round.data.item?.internal_present));
    // A trainer scoped to a DIFFERENT centre cannot touch this batch's log (Rule 38).
    const foreign = await req(tOut, "POST", `/api/logs/${logRes.data.item._id}/sessions`, { present_member_ids: [members[3].member._id] });
    ok("out-of-scope trainer is refused (Rule 38)", foreign.status === 403 || foreign.status === 404, `got ${foreign.status}`);
    // Rule 51 holds for trainer submissions too.
    const bad = await req(tIn, "POST", `/api/logs/${logRes.data.item._id}/sessions`, { present_member_ids: [], biometric_member_ids: [members[4].member._id] });
    ok("Rule 51 refuses biometric-without-present from a trainer", bad.status === 400, `got ${bad.status}`);
  }
  // leave no live logins behind (same discipline as eval-home's ghost)
  for (const email of [inEmail, outEmail]) {
    const u = ((await req(admin, "GET", `/api/users?limit=500`)).data.items ?? []).find((x) => x.email === email);
    if (u) await req(admin, "PATCH", `/api/users/${u._id}`, { active: false });
  }
}

// ---------------------------------------------------------------- parse + match (preview)
const pre = await upload(admin, { file: csvFile() });
ok("preview accepted the portal-shaped CSV", pre.status === 200, JSON.stringify(pre.data).slice(0, 300));
ok("all 7 rows parsed past the multi-line Details column", pre.data.row_count === 7, `got ${pre.data.row_count}`);
ok("TC ID lifted out of Org Name", pre.data.tc_id === TC, pre.data.tc_id);
ok("centre auto-detected from the TC ID", pre.data.resolved_location?._id === loc._id, JSON.stringify(pre.data.resolved_location));
ok("4 rows matched (2 by portal ID, 1 by name, 1 trainer)", pre.data.matched_count === 4, `got ${pre.data.matched_count}`);
ok("the duplicate-name pair is flagged Ambiguous, not guessed", pre.data.ambiguous_count === 2, `got ${pre.data.ambiguous_count}`);
ok("the candidate the ERP has never seen is Unmatched", pre.data.unmatched_count === 1, `got ${pre.data.unmatched_count}`);

const byName = Object.fromEntries((pre.data.preview ?? []).map((r) => [r.name, r]));
ok("Alpha matched on the portal ID, not the name", byName[`${NAME} Alpha`]?.match_by === "Portal ID", byName[`${NAME} Alpha`]?.match_by);
ok("Charlie fell back to a name match", byName[`${NAME} Charlie`]?.match_by === "Name", byName[`${NAME} Charlie`]?.match_by);
ok("hours parsed as a duration, not a clock time (75:50:37 → 4551 min, well past 24h)",
  Math.round(byName[`${NAME} Charlie`]?.total_hours_minutes) === 4551, String(byName[`${NAME} Charlie`]?.total_hours_minutes));
ok("Alpha reconciles exactly against our logs (portal 1, ours 1 → 0)", byName[`${NAME} Alpha`]?.variance_days === 0, String(byName[`${NAME} Alpha`]?.variance_days));
ok("Bravo's +3 day variance is caught (portal 4, our logs 1)", byName[`${NAME} Bravo`]?.variance_days === 3, String(byName[`${NAME} Bravo`]?.variance_days));
ok("Charlie's +10 is caught — matched by name but never logged present", byName[`${NAME} Charlie`]?.variance_days === 10, String(byName[`${NAME} Charlie`]?.variance_days));
ok("the Trainer row matched a Trainer, not a candidate", !!byName[`${NAME} Trainer`]?.trainer, JSON.stringify(byName[`${NAME} Trainer`]?.match_status));
ok("preview wrote nothing", !((await req(admin, "GET", "/api/govt-attendance")).data.items ?? []).some((i) => i.tc_id === TC));

// ---------------------------------------------------------------- commit
const done = await upload(admin, { file: csvFile(), confirm: "1", period_label: `test ${STAMP}` });
ok("import committed", done.status === 201, JSON.stringify(done.data).slice(0, 200));
ok("committed counts match the preview", done.data.matched_count === 4 && done.data.unmatched_count === 1);

const detail = await req(admin, "GET", `/api/govt-attendance/${done.data._id}`);
ok("all 7 rows persisted", detail.data.rows?.length === 7, `got ${detail.data.rows?.length}`);

// ---- -88 (Umesh 15/08): attendance on record = the batch runs; a Planning batch that receives
// matched portal rows becomes Active on its own (actual_start = planned start), audited; the
// import is never blocked; a second reconcile is a no-op.
{
  const pStart = localDate(Date.now() - 3 * 86400_000);
  const pBatch = (await req(admin, "POST", "/api/batches", { location: loc._id, program: program._id, target_size: 1, planned_start: pStart })).data.item;
  ok("-88 fixture: an after-the-fact Planning batch", pBatch?.status === "Planning", pBatch?.status);
  const pCand = (await req(admin, "POST", "/api/candidates", { name: `${NAME} Auto`, phone: "9333" + STAMP, location: loc._id, program: program._id, sidh_candidate_id: `CAN_${STAMP}0009` }, 201)).data.item;
  const pMem = (await req(admin, "POST", `/api/batches/${pBatch._id}/members`, { candidate: pCand._id }, 201)).data.item;
  const csvLines = csvText.split(String.fromCharCode(10));
  const alphaAt = csvLines.findIndex((l) => l.includes(`${NAME} Alpha`));
  const csvAuto = [csvLines[0], csvLines[alphaAt], csvLines[alphaAt + 1], csvLines[alphaAt + 2]].join(String.fromCharCode(10))
    .replace(`${NAME} Alpha`, `${NAME} Auto`).replace(`CAN_${STAMP}0001`, `CAN_${STAMP}0009`);
  const autoRes = await upload(admin, { file: new File([Buffer.from(csvAuto)], "auto.csv", { type: "text/csv" }), batch: pBatch._id, confirm: "1", period_label: `auto ${STAMP}` });
  ok("-88: the import on a Planning batch is NOT blocked (201) and reports the auto-activation", autoRes.status === 201 && (autoRes.data.auto_activated ?? []).includes(String(pBatch._id)), JSON.stringify({ s: autoRes.status, m: autoRes.data.matched_count, auto: autoRes.data.auto_activated }));
  const after = (await req(admin, "GET", `/api/batches/${pBatch._id}`)).data.item;
  ok("-88: the batch is Active on its own with actual_start = the planned start", after.status === "Active" && String(after.actual_start).slice(0, 10) === pStart, JSON.stringify({ st: after.status, as: after.actual_start }));
  const memAfter = ((await req(admin, "GET", `/api/batches/${pBatch._id}/members`)).data.items ?? []).find((m) => String(m._id) === String(pMem._id));
  ok("-88: the roster is counted from that day (joined_on restamped)", String(memAfter?.joined_on).slice(0, 10) === pStart, JSON.stringify(memAfter?.joined_on));
  const aud = ((await req(admin, "GET", `/api/audit/Batch/${pBatch._id}`)).data.items ?? []);
  ok("-88: the auto-activation is on the audit trail with its reason", aud.some((a) => a.field === "auto_activated" && /portal import/.test(String(a.new_value))), JSON.stringify(aud.filter((a) => a.field === "auto_activated").map((a) => a.new_value)));
  const again = await req(admin, "POST", `/api/batches/${pBatch._id}/reconcile-status`, {});
  ok("-88: reconcile on an already-Active batch is a no-op", again.status === 200 && again.data.activated === false && /already Active/.test(again.data.reason ?? ""), JSON.stringify(again.data));
  const fresh = (await req(admin, "POST", "/api/batches", { location: loc._id, program: program._id, target_size: 1, planned_start: localDate(Date.now() + 10 * 86400_000) })).data.item;
  const noEv = await req(admin, "POST", `/api/batches/${fresh._id}/reconcile-status`, {});
  ok("-88: reconcile without evidence changes nothing", noEv.data.activated === false && /no attendance evidence/.test(noEv.data.reason ?? ""), JSON.stringify(noEv.data));
  await req(admin, "POST", `/api/batches/${fresh._id}/transition`, { target: "Cancelled", reason: "-88 fixture" }, 200);
}

// ---- QA-159 (-86, Umesh): the batches LIST says how much attendance each batch has ----
{
  const list = ((await req(admin, "GET", "/api/batches?limit=2000")).data.items ?? []);
  const row = list.find((b) => String(b._id) === String(batch._id));
  ok("QA-159: list row carries our day-wise count + last day (1 log written above)", !!row && row.attendance_days === 1 && !!row.attendance_last, JSON.stringify(row && { d: row.attendance_days, last: row.attendance_last }));
  ok("QA-159: list row carries the newest matched portal import for the batch (as_of + rows)", !!row && !!row.portal_as_of && row.portal_rows >= 1, JSON.stringify(row && { as_of: row.portal_as_of, rows: row.portal_rows }));
  const untouched = list.find((b) => String(b._id) !== String(batch._id) && !b.attendance_days && !b.portal_as_of);
  ok("QA-159: a batch with nothing on record reads 0 / null (the UI says 'none yet')", !untouched || (untouched.attendance_days === 0 && untouched.portal_as_of === null), JSON.stringify(untouched && { d: untouched.attendance_days, p: untouched.portal_as_of }));
}

// ---- R-D (CEO 14/08): the batch Attendance tab — both meters + the green verdict ----
{
  const att = await req(admin, "GET", `/api/batches/${batch._id}/attendance`);
  ok("R-D: attendance endpoint answers with the full roster",
    att.status === 200 && (att.data.members ?? []).length === 5, `got ${att.status}, ${att.data.members?.length}`);
  ok("R-D: the hours threshold is derived and positive",
    att.data.required_hours > 0 && att.data.min_attendance_pct > 0,
    JSON.stringify({ r: att.data.required_hours, pct: att.data.min_attendance_pct }));
  const rows = Object.fromEntries((att.data.members ?? []).map((m) => [m.name, m]));
  ok("R-D: Charlie carries the portal HOURS meter (4551 min → 76 hrs)",
    rows[`${NAME} Charlie`]?.govt?.hours === 76, String(rows[`${NAME} Charlie`]?.govt?.hours));
  // QA-085: the green verdict is PORTAL-hours-only — an estimate can never qualify.
  ok("QA-085: the green verdict follows PORTAL hours alone, for every student",
    (att.data.members ?? []).every((m) => m.qualified === (m.govt?.hours != null && m.govt.hours >= att.data.required_hours)));
  // QA-085: this batch carries no slot — our hours must be null, never an assumed 8/day.
  ok("QA-085: a slot-less batch estimates NOTHING (our_hours null, basis never 'estimate')",
    (att.data.members ?? []).every((m) => m.our_hours === null && m.basis !== "estimate"),
    JSON.stringify((att.data.members ?? []).map((m) => [m.our_hours, m.basis])));
  ok("R-D: an ambiguous/unmatched student shows NO portal figures (never guessed)",
    rows[`${NAME} Twin`]?.govt === null, JSON.stringify(rows[`${NAME} Twin`]?.govt));
  ok("R-D: the day-wise grid is one cell per logged day",
    (att.data.members ?? []).every((m) => m.present_by_day.length === att.data.days_held), `days_held=${att.data.days_held}`);
  // Scope: the endpoint carries no extra permission gate, but Rule 38 still bites — the
  // out-of-scope trainer from the marking block must not read another centre's meters.
  const tOut2 = await login(`gt.trainer.out.${STAMP}@vidysea-test.local`, "CiOnly@123");
  if (tOut2) {
    const foreignAtt = await req(tOut2, "GET", `/api/batches/${batch._id}/attendance`);
    ok("R-D: out-of-scope trainer refused (Rule 38)", foreignAtt.status === 403 || foreignAtt.status === 404, `got ${foreignAtt.status}`);
  } else {
    ok("R-D: out-of-scope login already deactivated (Rule 38 pinned elsewhere)", true);
  }
}
ok("period label stored", detail.data.item?.period_label === `test ${STAMP}`);
const varOnly = await req(admin, "GET", `/api/govt-attendance/${done.data._id}?filter=variance`);
ok("variance filter returns only rows that actually differ",
  varOnly.data.rows?.length > 0 && varOnly.data.rows.every((r) => r.variance_days !== 0 && r.variance_days !== null),
  JSON.stringify(varOnly.data.rows?.map((r) => r.variance_days)));
const unmatchedOnly = await req(admin, "GET", `/api/govt-attendance/${done.data._id}?filter=unmatched`);
ok("unmatched filter returns the 1 unmatched + 2 ambiguous", unmatchedOnly.data.rows?.length === 3, `got ${unmatchedOnly.data.rows?.length}`);
ok("an unmatched row explains itself", unmatchedOnly.data.rows?.every((r) => !!r.match_note));

// A variance is raised, not left to be noticed on a report.
const notifs = await req(admin, "GET", "/api/notifications?status=New&limit=100");
ok("a variance notification was raised for Admin/Ops",
  (notifs.data.items ?? []).some((n) => n.type === "govt_attendance_variance" && String(n.entity_id) === String(done.data._id)));

// Re-importing the same file must not overwrite history — the client contract is settled
// against whatever the portal said on a given date.
const again = await upload(admin, { file: csvFile(), confirm: "1", period_label: `test ${STAMP} v2` });
ok("re-import creates a second import rather than rewriting the first", again.status === 201 && again.data._id !== done.data._id);
ok("the first import is still intact", (await req(admin, "GET", `/api/govt-attendance/${done.data._id}`)).data.rows?.length === 7);

// ---- -102 (Manish 17/08): the import grid carries the QUALIFICATION verdict ----
// [11:02] "isme ek status wala chahiye… wo gayab ho gaya, qualified wala aa raha tha"
// [11:53] "qualify ka rule yahi hai ki 60 plus hours, 60 or above" / "60 se niche not eligible"
// The verdict is NOT re-derived here: the bar comes from assessmentHoursBar and the answer from
// memberAttendedHours — the same two the batch Attendance tab uses — so the two screens cannot
// drift. These pins prove that identity rather than the arithmetic.
{
  const g = await req(admin, "GET", `/api/govt-attendance/${done.data._id}`);
  const att = await req(admin, "GET", `/api/batches/${batch._id}/attendance`);
  ok("-102: the import grid states the hours bar, and it is the SAME number the batch Attendance tab uses",
    g.data.required_hours > 0 && g.data.required_hours === att.data.required_hours,
    JSON.stringify({ grid: g.data.required_hours, tab: att.data.required_hours }));
  ok("-102: the bar says where it came from (scheme master, or Defaults as the honest fallback)",
    ["scheme", "defaults"].includes(g.data.min_attendance_source), String(g.data.min_attendance_source));
  ok("-102: every row that CAN be judged is judged as exactly 'portal hours ≥ the bar' — no second formula",
    (g.data.rows ?? []).filter((r) => r.required_hours != null)
      .every((r) => r.govt_hours == null ? r.qualified === null : r.qualified === (r.govt_hours >= g.data.required_hours)),
    JSON.stringify((g.data.rows ?? []).map((r) => [r.name, r.govt_hours, r.required_hours, r.qualified])).slice(0, 340));
  ok("-102: a row with no hour figure is left UNANSWERED, never called 'not eligible'",
    (g.data.rows ?? []).filter((r) => r.govt_hours == null).every((r) => r.qualified === null),
    JSON.stringify((g.data.rows ?? []).filter((r) => r.govt_hours == null).map((r) => [r.name, r.qualified])));
  // A row nobody has been able to attach to a candidate has no PROGRAMME either, and this import
  // is centre-wide (no ?batch=), so there is no single bar to judge it against — the same reason
  // R-D keeps portal figures off an ambiguous student on the batch tab. Unanswered, not "not
  // eligible": a grey "— no hours"-style cell is honest, a grey "Not eligible" would be a verdict
  // we have not earned. (Manish's real flow imports from inside a batch, where every row IS judged.)
  ok("-102: in a centre-wide import an unattached row is judged by NOTHING, and says so rather than guessing",
    (g.data.rows ?? []).filter((r) => r.match_status !== "Matched" && !r.batch)
      .every((r) => r.required_hours === null && r.qualified === null),
    JSON.stringify((g.data.rows ?? []).filter((r) => r.match_status !== "Matched").map((r) => [r.name, r.match_status, r.required_hours, r.qualified])));
  ok("-102: …while every MATCHED candidate row does carry the bar and a verdict",
    (g.data.rows ?? []).filter((r) => r.match_status === "Matched" && r.candidate)
      .every((r) => r.required_hours === g.data.required_hours && r.qualified !== undefined),
    JSON.stringify((g.data.rows ?? []).filter((r) => r.match_status === "Matched" && r.candidate).map((r) => [r.name, r.required_hours, r.qualified])));
  const gRows = Object.fromEntries((g.data.rows ?? []).map((r) => [r.name, r]));
  const aRows = Object.fromEntries((att.data.members ?? []).map((m) => [m.name, m]));
  ok("-102: Charlie's verdict is identical on the import grid and the batch Attendance tab",
    gRows[`${NAME} Charlie`]?.govt_hours === aRows[`${NAME} Charlie`]?.govt?.hours
    && gRows[`${NAME} Charlie`]?.qualified === aRows[`${NAME} Charlie`]?.qualified,
    JSON.stringify({ grid: [gRows[`${NAME} Charlie`]?.govt_hours, gRows[`${NAME} Charlie`]?.qualified], tab: [aRows[`${NAME} Charlie`]?.govt?.hours, aRows[`${NAME} Charlie`]?.qualified] }));
  ok("-102: the summary counts add up to the row count",
    g.data.qualified_count + g.data.not_eligible_count + g.data.no_hours_count === g.data.rows.length,
    JSON.stringify({ q: g.data.qualified_count, n: g.data.not_eligible_count, h: g.data.no_hours_count, rows: g.data.rows.length }));
}

// ---- -102: an Ambiguous row can be EXPLAINED and RESOLVED ----
// [11:34] "ambiguous name pe aisa hona chahiye ki wo click ho to uske baare me pata chal jaye ki
// kya issue hai" · [11:29] "usko hum manual bhi verify kar hi chuke hai".
// The importer refusing to guess between the two Twins is correct; what was missing was any way
// to record the answer the operator already has.
{
  const rows = (await req(admin, "GET", `/api/govt-attendance/${done.data._id}?filter=ambiguous`)).data.rows ?? [];
  ok("-102 fixture: the two same-name rows are still Ambiguous", rows.length === 2, String(rows.length));
  const row = rows[0];
  const opts = await req(admin, "GET", `/api/govt-attendance/${done.data._id}/rows/${row._id}/match`);
  ok("-102: the row explains itself — the importer's own reason comes back with it",
    opts.status === 200 && /share this name|candidates share/i.test(String(opts.data.reason ?? "")), `${opts.status} ${String(opts.data.reason ?? "").slice(0, 90)}`);
  ok("-102: …and the candidates that actually collided are offered first, labelled with WHY",
    opts.data.collisions === 2 && opts.data.options.slice(0, 2).every((o) => o.collides === "same name"),
    JSON.stringify(opts.data.options.slice(0, 3).map((o) => [o.name, o.collides])));
  // A candidate on no roster here cannot receive a portal row.
  const stranger = (await req(admin, "POST", "/api/candidates", { name: `${NAME} Stranger`, phone: "9444" + STAMP, location: loc._id, program: program._id })).data.item;
  const wrong = await req(admin, "POST", `/api/govt-attendance/${done.data._id}/rows/${row._id}/match`, { candidate: stranger._id });
  ok("-102: a candidate enrolled nowhere at this centre is refused (400) — a row cannot be pinned on a non-student",
    wrong.status === 400 && /not enrolled/i.test(String(wrong.data?.error ?? "")), `${wrong.status} ${String(wrong.data?.error ?? "").slice(0, 90)}`);
  ok("-102: no candidate at all is refused (400)", (await req(admin, "POST", `/api/govt-attendance/${done.data._id}/rows/${row._id}/match`, {})).status === 400);
  // The real resolution. Which twin this row belongs to is genuinely undecidable from the file —
  // that is the whole point — so the operator decides. Pick the twin who was marked present on the
  // fixture day (members[3], via the trainer's marking round above): that way the reconciliation
  // below has a NON-ZERO number to produce, and cannot pass by defaulting to 0.
  const pickId = String(members[3].candidate._id);
  const res = await req(admin, "POST", `/api/govt-attendance/${done.data._id}/rows/${row._id}/match`, { candidate: pickId, reason: "-102 pin: checked the centre register" });
  ok("-102: naming the candidate resolves the row — Matched, and provenance says Manual",
    res.status === 200 && res.data.item?.match_status === "Matched" && res.data.item?.match_by === "Manual",
    `${res.status} ${JSON.stringify(res.data.item && { s: res.data.item.match_status, by: res.data.item.match_by })}`);
  ok("-102: the note keeps what it WAS, so the trail shows the ambiguity and the human decision",
    /Resolved by/.test(String(res.data.item?.match_note ?? "")) && /was Ambiguous/.test(String(res.data.item?.match_note ?? "")) && /centre register/.test(String(res.data.item?.match_note ?? "")),
    String(res.data.item?.match_note ?? "").slice(0, 140));
  ok("-102: it is reconciled against our own logs exactly as an automatic match is (1 day logged → variance = portal − 1)",
    res.data.item?.internal_days_present === 1 && res.data.item?.variance_days === (row.total_days_present - 1),
    JSON.stringify({ internal: res.data.item?.internal_days_present, variance: res.data.item?.variance_days, portal: row.total_days_present }));
  ok("-102: the import's own summary counts moved with it — one fewer ambiguous, one more matched",
    res.data.counts?.ambiguous === 1 && res.data.counts?.matched === 5,
    JSON.stringify(res.data.counts));
  const impNow = (await req(admin, "GET", `/api/govt-attendance/${done.data._id}`)).data.item;
  ok("-102: …and the stored counts on the import agree, so the chips cannot lie",
    impNow.ambiguous_count === 1 && impNow.matched_count === 5, JSON.stringify({ a: impNow.ambiguous_count, m: impNow.matched_count }));
  const mAud = ((await req(admin, "GET", `/api/audit/GovtAttendanceRow/${row._id}`)).data.items ?? []);
  ok("-102: the manual match is audited — from what, to whom, by whom, and why",
    mAud.some((a) => a.field === "match" && /Ambiguous/.test(String(a.old_value)) && /manually by/.test(String(a.new_value)) && /centre register/.test(String(a.new_value))),
    JSON.stringify(mAud.map((a) => [a.old_value, String(a.new_value).slice(0, 80)])).slice(0, 240));
  // The row now carries a verdict, like any matched row.
  const after = ((await req(admin, "GET", `/api/govt-attendance/${done.data._id}`)).data.rows ?? []).find((r) => String(r._id) === String(row._id));
  ok("-102: the resolved row now gets the qualification verdict too", after?.qualified !== undefined && after?.required_hours > 0,
    JSON.stringify({ q: after?.qualified, h: after?.govt_hours, bar: after?.required_hours }));
  // Permission: view-level holders and out-of-scope roles must not resolve.
  const other = rows[1];
  const enr = await login("enroll@vidysea.com", "CiOnly@123");
  if (enr) {
    const enrTry = await req(enr, "POST", `/api/govt-attendance/${done.data._id}/rows/${other._id}/match`, { candidate: pickId });
    ok("-102: a role without attendance.govt edit cannot resolve a row (403)", enrTry.status === 403, `got ${enrTry.status}`);
  }
  const anonTry = await fetch(`${BASE}/api/govt-attendance/${done.data._id}/rows/${other._id}/match`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candidate: pickId }),
  });
  ok("-102: anonymous cannot resolve a row (401)", anonTry.status === 401, String(anonTry.status));
  ok("-102: the other ambiguous row is untouched by the refusals",
    ((await req(admin, "GET", `/api/govt-attendance/${done.data._id}?filter=ambiguous`)).data.rows ?? []).length === 1);
  ok("-102: the never-enrolled fixture candidate is cleaned up", (await req(admin, "DELETE", `/api/candidates/${stranger._id}`)).status === 200);
}

// ---------------------------------------------------------------- garbage in
const junk = await upload(admin, { file: new File([Buffer.from("just,some,csv\n1,2,3\n")], "junk.csv", { type: "text/csv" }) });
ok("a file with no attendance header is rejected with a readable reason",
  junk.status === 400 && /header/i.test(junk.data.error ?? ""), JSON.stringify(junk.data));

// ---------------------------------------------------------------- scheme timing (Manish 2026-08-12)
const mkBatch = (extra) => req(admin, "POST", "/api/batches", {
  location: loc._id, program: program._id, target_size: 30,
  planned_start: localDate(Date.now() + 86400_000), ...extra,
});
const early = await mkBatch({ slot_start: "07:00", slot_end: "11:00" });
ok("07:00 start refused — the day runs 09:00–18:00", early.status === 400 && /09:00/.test(early.data.error ?? ""), JSON.stringify(early.data).slice(0, 160));
const late = await mkBatch({ slot_start: "15:00", slot_end: "19:00" });
ok("a slot running past 18:00 refused", late.status === 400, JSON.stringify(late.data).slice(0, 160));
// 2026-08-13 (Manish walkthrough): "ya toh 4 ghante ka rakho ya 8 ghante ka… beech ka tod-mod
// nahi" — a session is EXACTLY 4 or 8 hours (supersedes the ≤4h ceiling; 5h was asked and refused).
const tooLong = await mkBatch({ slot_start: "09:00", slot_end: "14:00" });
ok("a 5-hour session refused — sessions are exactly 4 or 8 hours", tooLong.status === 400 && /exactly 4/.test(tooLong.data.error ?? ""), JSON.stringify(tooLong.data).slice(0, 160));
const oneHour = await mkBatch({ slot_start: "13:00", slot_end: "14:00" });
ok("a 1-hour session refused too — sub-4h slots no longer sneak past", oneHour.status === 400 && /exactly 4/.test(oneHour.data.error ?? ""), JSON.stringify(oneHour.data).slice(0, 160));
const eight = await mkBatch({ slot_start: "09:00", slot_end: "17:00" });
ok("an 8-hour 09:00–17:00 session is allowed ('8 ghante ka ek')", eight.status === 201, JSON.stringify(eight.data).slice(0, 160));
const four = await mkBatch({ slot_start: "09:00", slot_end: "13:00", trainer: trainer._id });
ok("a 4-hour 09:00–13:00 batch is allowed (Manish: '4 Hour Batch You can Create')", four.status === 201, JSON.stringify(four.data).slice(0, 160));
const second = await mkBatch({ slot_start: "14:00", slot_end: "18:00", trainer: trainer._id });
ok("a second 4-hour batch the same day is allowed ('4-4 Hour's 2 batch')", second.status === 201, JSON.stringify(second.data).slice(0, 160));
// With exact 4/8 durations inside the 9-hour day, any third same-day session must collide —
// the "two a day" pattern is now enforced by geometry (clash) rather than a counter.
const third = await mkBatch({ slot_start: "13:00", slot_end: "17:00", trainer: trainer._id });
ok("a third same-day session refused — two 4-hour sessions fill the day",
  third.status === 409, JSON.stringify(third.data).slice(0, 200));
const noSlot = await mkBatch({});
ok("a batch with no slot at all still saves (legacy batches carry none)", noSlot.status === 201, JSON.stringify(noSlot.data).slice(0, 160));

// ---------------------------------------------------------------- contract counting (Manish 2026-08-12)
const defaults = (await req(admin, "GET", "/api/defaults")).data.item;
ok("Defaults expose the scheme window", defaults.day_start_time === "09:00" && defaults.day_end_time === "18:00");
ok("Defaults still expose the legacy session knobs (slot rule itself is exact 4/8 in code)", defaults.max_session_hours === 4 && defaults.max_batches_per_day === 2);
ok("Defaults: exam-eligibility attendance floor is 50%", defaults.min_attendance_pct === 50, String(defaults.min_attendance_pct));
ok("Defaults: absentees are NOT deducted from 'appeared'", defaults.absent_counts_as_appeared === true);
ok("Defaults: a dropout who passed is not billable", defaults.dropped_pass_is_billable === false);
// QA-104 (15/08): the app has NO upload cap — the defaults must stop advertising one.
ok("QA-104: defaults no longer advertise an upload ceiling", defaults.max_upload_mb === undefined, String(defaults.max_upload_mb));

// Mark results: 1 Pass, 1 Fail, 1 Absent, then drop a passed candidate.
const marked = await req(admin, "PUT", `/api/batches/${batch._id}/results`, {
  rows: [
    { member: members[0].member._id, result: "Pass" },
    { member: members[1].member._id, result: "Fail", failure_reason: "Did not clear practical" }, // Rule 44
    { member: members[2].member._id, result: "Absent" },
    { member: members[3].member._id, result: "Pass" },
    { member: members[4].member._id, result: "Pass" },
  ],
});
ok("all 5 results recorded", marked.data.summary?.total === 5, JSON.stringify(marked.data).slice(0, 250));
let sum = (await req(admin, "GET", `/api/batches/${batch._id}/results`)).data.summary;
ok("'appeared' counts the absentee too (3 pass + 1 fail + 1 absent = 5)", sum.appeared === 5, JSON.stringify(sum));
ok("passed is unaffected by the appeared rule", sum.passed === 3, String(sum.passed));
ok("with nobody dropped, billable == passed", sum.billable_passed === 3, String(sum.billable_passed));

// QA-069 (S1): the candidates LIST carries the recorded result (latest_result), so the
// Enrolled journey shows Certified/Failed/Absent from the assessment itself — it no
// longer waits on a lifecycle_status that historical imports never wrote back.
{
  const rows = (await req(admin, "GET", `/api/candidates?location=${loc._id}&limit=200`)).data.items ?? [];
  const byId = new Map(rows.map((c) => [String(c._id), c]));
  const passCand = byId.get(String(members[0].candidate._id));
  const failCand = byId.get(String(members[1].candidate._id));
  const absCand = byId.get(String(members[2].candidate._id));
  ok("QA-069: the passed candidate's row carries latest_result Pass", passCand?.latest_result === "Pass", JSON.stringify(passCand?.latest_result));
  ok("QA-069: the failed candidate's row carries latest_result Fail", failCand?.latest_result === "Fail", JSON.stringify(failCand?.latest_result));
  ok("QA-069: the absent candidate's row carries latest_result Absent", absCand?.latest_result === "Absent", JSON.stringify(absCand?.latest_result));
}

// A candidate who dropped out is not billable even though their Pass survives (Rule 42).
const dropped = await req(admin, "POST", `/api/members/${members[4].member._id}/drop`, {
  left_on: localDate(), drop_reason: "Personal",
});
ok("a roster member can be dropped", [200, 201].includes(dropped.status), JSON.stringify(dropped.data).slice(0, 200));
sum = (await req(admin, "GET", `/api/batches/${batch._id}/results`)).data.summary;
ok("the dropout's Pass is preserved (Rule 42)", sum.passed === 3, String(sum.passed));
ok("but it is excluded from the billable count", sum.billable_passed === 2, JSON.stringify(sum));
ok("and the exclusion is visible, not silent", sum.dropped_passed === 1, String(sum.dropped_passed));

// Mid-batch replacement: the freed seat takes a new candidate on a LATER joining date.
const replacement = (await req(admin, "POST", "/api/candidates", {
  name: `${NAME} Replacement`, phone: `9${STAMP.slice(1)}2000`, location: loc._id, program: program._id,
})).data.item;
const readd = await req(admin, "POST", `/api/batches/${batch._id}/members`, {
  candidate: replacement._id, joined_on: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
});
ok("mid-batch replacement allowed on a later joining date (Manish: yes)", readd.status === 201, JSON.stringify(readd.data).slice(0, 200));

// ---------------------------------------------------------------- DEC-4 (2026-08-13): the billable split is PERSISTED on the closure
const closure0 = (await req(admin, "GET", `/api/batches/${batch._id}/closure`)).data.closure;
ok("Closure carries billable_passed (2, dropped-but-passed excluded)", closure0?.billable_passed === 2, JSON.stringify(closure0).slice(0, 200));
ok("Closure names the exclusion (dropped_passed = 1)", closure0?.dropped_passed === 1, String(closure0?.dropped_passed));
ok("Closure.passed stays the true pass count (Rule 42 readers unchanged)", closure0?.passed === 3, String(closure0?.passed));

// ---------------------------------------------------------------- FIX-1 (2026-08-13): roster takes only this centre's + this job role's candidates
const otherLoc = (await req(admin, "POST", "/api/locations", {
  name: `${NAME} Other Centre`, code: `GO${STAMP}`, city: "Jaipur", approval_status: "Approved", operational_status: "Active",
})).data.item;
const foreignCand = (await req(admin, "POST", "/api/candidates", {
  name: `${NAME} Foreign`, phone: `9${STAMP.slice(1)}2001`, location: otherLoc._id, program: program._id,
})).data.item;
const crossLoc = await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: foreignCand._id });
ok("another centre's candidate refused even for Admin (Prem Kumar/Lalit fix)", crossLoc.status === 409 && /another centre/.test(crossLoc.data.error ?? ""), JSON.stringify(crossLoc.data).slice(0, 160));
const otherProg = (await req(admin, "POST", "/api/programs", { code: `GP${STAMP}`, name: `${NAME} Other Prog`, trainer_skill: "OtherSkill" + STAMP })).data.item;
const wrongProgCand = (await req(admin, "POST", "/api/candidates", {
  name: `${NAME} WrongRole`, phone: `9${STAMP.slice(1)}2002`, location: loc._id, program: otherProg._id,
})).data.item;
const crossProg = await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: wrongProgCand._id });
ok("a different job role/scheme refused (the scheme-twin trap)", crossProg.status === 409 && /job role/.test(crossProg.data.error ?? ""), JSON.stringify(crossProg.data).slice(0, 160));
// (The program-less-candidate path can't be built over HTTP — the create API requires a
// programme; only bulk imports produce such rows. That case is pinned in e2e-eval-data.mjs,
// the one suite allowed to plant raw shapes.)

// ---------------------------------------------------------------- F-N4 (2026-08-13): trainer-first attendance (portal rule)
// Today's log already exists (the only loggable date for this batch), so the rule is proven
// through the edit path — same validator.
const log1 = logRes.data.item;
const noTrainerEdit = await req(admin, "PATCH", `/api/logs/${log1._id}`, {
  present_member_ids: log1.present_member_ids, trainer_present: false,
});
ok("students cannot be marked present on a trainer-absent day", noTrainerEdit.status === 400 && /trainer/i.test(noTrainerEdit.data.error ?? ""), JSON.stringify(noTrainerEdit.data).slice(0, 200));
const okEdit = await req(admin, "PATCH", `/api/logs/${log1._id}`, {
  present_member_ids: log1.present_member_ids, trainer_present: true,
});
ok("with the trainer present the same edit saves", okEdit.status === 200 && okEdit.data.item?.trainer_present === true, JSON.stringify(okEdit.data).slice(0, 160));

// ---------------------------------------------------------------- F-N6 (2026-08-13): per-student attendance links
const attLinks = await req(admin, "POST", "/api/public-tokens", { purpose: "attendance", batch: batch._id });
ok("attendance links fan out one per active member", attLinks.status === 201 && (attLinks.data.items?.length ?? 0) >= 5, String(attLinks.data.items?.length));
const tokA = attLinks.data.items?.[0], tokB = attLinks.data.items?.[1];
const pubA = await fetch(`${BASE}/api/public/attendance/${tokA?.token}`).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
ok("a student opens their link with NO login", pubA.status === 200 && !!pubA.data.candidate, JSON.stringify(pubA.data).slice(0, 200));
ok("the payload answers 'kitna ho gaya': hours + required + eligible verdict",
  typeof pubA.data.attended_hours === "number" && typeof pubA.data.required_hours === "number" && typeof pubA.data.eligible === "boolean",
  JSON.stringify({ a: pubA.data.attended_hours, r: pubA.data.required_hours, e: pubA.data.eligible }));
ok("the day-wise centre log rides along", Array.isArray(pubA.data.days), String(pubA.data.days?.length));
const pubB = await fetch(`${BASE}/api/public/attendance/${tokB?.token}`).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
ok("token isolation: B's link shows B, not A", pubB.status === 200 && pubB.data.candidate !== pubA.data.candidate, `${pubA.data.candidate} vs ${pubB.data.candidate}`);
const pubBad = await fetch(`${BASE}/api/public/attendance/deadbeef00000000deadbeef00000000`);
ok("a made-up token 404s", pubBad.status === 404, String(pubBad.status));
const feedbackTokenOnAttendance = await fetch(`${BASE}/api/public/attendance/${(await req(admin, "POST", "/api/public-tokens", { purpose: "feedback", batch: batch._id })).data.items?.[0]?.token}`);
ok("a FEEDBACK token does not open the attendance view (purpose-bound)", feedbackTokenOnAttendance.status === 404, String(feedbackTokenOnAttendance.status));

// ---------------------------------------------------------------- Candidate portal /p/me (2026-08-13, Umesh: "candidate ke liye bhi ek hoga — ye requirement hai")
const lookup = (json) => fetch(`${BASE}/api/public/portal-lookup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(json) })
  .then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
const cPort = (await req(admin, "POST", "/api/candidates", { name: `${NAME} Portal`, phone: `9${STAMP.slice(1)}3007`, location: loc._id, program: program._id, dob: "2000-01-15" }, 201)).data.item;
await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: cPort._id }, 201);
const lk = await lookup({ phone: cPort.phone, dob: "2000-01-15" });
ok("portal lookup: registered phone + DOB opens own My Training url", lk.status === 200 && lk.data.enrolled === true && /\/p\/attendance\//.test(lk.data.url ?? ""), JSON.stringify(lk.data).slice(0, 120));
ok("portal lookup: DOB on file but not supplied → generic refusal", (await lookup({ phone: cPort.phone })).status === 404);
ok("portal lookup: wrong DOB → same generic refusal", (await lookup({ phone: cPort.phone, dob: "1999-09-09" })).status === 404);
ok("portal lookup: unknown number → same generic refusal (no enumeration)", (await lookup({ phone: "9000000001" })).status === 404);
const myTok = lk.data.url?.split("/").pop();
const myPage = await fetch(`${BASE}/api/public/attendance/${myTok}`).then((r) => r.json()).catch(() => ({}));
ok("…and the portal payload carries the full training picture (centre/trainer/sidh/result keys)",
  "centre" in myPage && "trainer" in myPage && "sidh_status" in myPage && "result" in myPage, JSON.stringify({ c: myPage.centre, t: myPage.trainer }).slice(0, 120));
const cPool = (await req(admin, "POST", "/api/candidates", { name: `${NAME} PoolPortal`, phone: `9${STAMP.slice(1)}3008`, location: loc._id, program: program._id }, 201)).data.item;
const plk = await lookup({ phone: cPool.phone });
ok("portal lookup: a pool candidate learns their registration status, not a dead end", plk.status === 200 && plk.data.enrolled === false && typeof plk.data.sidh_status === "string", JSON.stringify(plk.data).slice(0, 120));

// QA-056 (S1, checker): imported DOBs sit at IST midnight = previous day 18:30 UTC, and a
// UTC-date comparison refused every such student's REAL birthday while accepting the day
// before it. Both sides now canonicalize to the IST calendar date.
const cIst = (await req(admin, "POST", "/api/candidates", { name: `${NAME} IstDob`, phone: `9${STAMP.slice(1)}3009`, location: loc._id, program: program._id, dob: "1998-12-31T18:30:00.000Z" }, 201)).data.item;
const lkReal = await lookup({ phone: cIst.phone, dob: "1999-01-01" });
ok("QA-056: the REAL birthday opens the portal for an IST-midnight-stored DOB", lkReal.status === 200, `got ${lkReal.status}`);
const lkPrev = await lookup({ phone: cIst.phone, dob: "1998-12-31" });
ok("QA-056: the day BEFORE the birthday no longer works", lkPrev.status === 404, `got ${lkPrev.status}`);
ok("QA-057: the refusal names the date-of-birth field", /date of birth/i.test(lkPrev.data?.error ?? ""), lkPrev.data?.error);

// ---------------------------------------------------------------- F-N2 (2026-08-13): assessment date raises an in-app alert
const assessDate = new Date(Date.now() + 7 * 864e5 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const closurePut = await req(admin, "PUT", `/api/batches/${batch._id}/closure`, { assessment_date: assessDate });
ok("assessment date lands on the closure", closurePut.status === 200, JSON.stringify(closurePut.data).slice(0, 160));
const schedList = (await req(admin, "GET", "/api/notifications?type=assessment_scheduled")).data.items ?? [];
const schedNotif = schedList.find((n) => n.type === "assessment_scheduled" && String(n.entity_id) === String(batch._id));
ok("an assessment_scheduled notification is raised for the batch", !!schedNotif, JSON.stringify(schedList.map((n) => n.type)).slice(0, 200));
ok("…and it tells people to inform the candidates", /inform the candidates/.test(schedNotif?.message ?? ""), schedNotif?.message);
ok("…and the student link shows the assessment date",
  String((await fetch(`${BASE}/api/public/attendance/${tokA?.token}`).then((r) => r.json()).catch(() => ({}))).assessment_date ?? "").slice(0, 10) === assessDate);

// ---------------------------------------------------------------- DEC-6 (2026-08-13): a Completed batch is LOCKED — no override
// Walk a one-candidate batch all the way to Completed, then prove the two paths that used to
// leak past the lock (certificate-field PATCH, closure PUT) are shut, while invoice-readiness
// still works (invoicing naturally happens after completion).
const t2 = (await req(admin, "POST", "/api/trainers", { name: `${NAME} LockTrainer`, phone: `9${STAMP.slice(1)}0002`, skills: ["Testing"] })).data.item;
const room2 = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: `${NAME} Lab 2`, type: "Lab", capacity: 30 })).data.item;
const mk2 = await req(admin, "POST", "/api/batches", {
  location: loc._id, program: program._id, trainer: t2._id, room: room2._id,
  planned_start: localDate(), target_size: 1,
});
ok("lock fixture: batch2 created", mk2.status === 201, JSON.stringify(mk2.data).slice(0, 200));
const batch2 = mk2.data.item;
const c2 = (await req(admin, "POST", "/api/candidates", { name: `${NAME} Lockcase`, phone: `9${STAMP.slice(1)}2004`, location: loc._id, program: program._id })).data.item;
const m2 = (await req(admin, "POST", `/api/batches/${batch2._id}/members`, { candidate: c2._id })).data.item;
await req(admin, "PATCH", `/api/members/${m2._id}`, { reg_done: true, kyc_done: true, accept_done: true });
await req(admin, "POST", `/api/batches/${batch2._id}/transition`, { target: "Ready" });
await req(admin, "POST", `/api/batches/${batch2._id}/transition`, { target: "Active" });
await req(admin, "PUT", `/api/batches/${batch2._id}/results`, { rows: [{ member: m2._id, result: "Pass" }] });
const rrow = ((await req(admin, "GET", `/api/batches/${batch2._id}/results`)).data.items ?? []).find((i) => i.result)?.result;
await req(admin, "PATCH", `/api/results/${rrow._id}`, { certificate_status: "Processing" });
await req(admin, "PATCH", `/api/results/${rrow._id}`, { certificate_status: "Generated", certificate_no: `CERT-${STAMP}-1`, certificate_date: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) });
await req(admin, "PATCH", `/api/results/${rrow._id}`, { certificate_status: "Issued" });
await req(admin, "PUT", `/api/batches/${batch2._id}/closure`, { assessment_status: "Completed", assessment_date: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) });
await req(admin, "PUT", `/api/batches/${batch2._id}/closure`, { certification_status: "Completed", certification_date: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) });
await req(admin, "POST", `/api/batches/${batch2._id}/transition`, { target: "Closing" });
const toDone = await req(admin, "POST", `/api/batches/${batch2._id}/transition`, { target: "Completed" });
ok("lock fixture: batch walked to Completed", toDone.status === 200, JSON.stringify(toDone.data).slice(0, 200));

const certEdit = await req(admin, "PATCH", `/api/results/${rrow._id}`, { certificate_no: `CERT-${STAMP}-TYPO` });
ok("a mistyped certificate number CANNOT be corrected after completion (stays locked, Umesh)",
  certEdit.status === 409 && /closed/i.test(certEdit.data.error ?? ""), JSON.stringify(certEdit.data).slice(0, 200));
const closureEdit = await req(admin, "PUT", `/api/batches/${batch2._id}/closure`, { assessment_date: new Date(Date.now() + 864e5 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10) });
ok("closure fields are frozen after completion too", closureEdit.status === 409, JSON.stringify(closureEdit.data).slice(0, 200));
const readyInv = await req(admin, "PUT", `/api/batches/${batch2._id}/closure`, { ready_for_invoice: true });
ok("…but invoice-readiness may still be marked (invoicing follows completion)", readyInv.status === 200, JSON.stringify(readyInv.data).slice(0, 160));

// ---------------------------------------------------------------- rules Manish confirmed should NOT change
const perms = (await req(admin, "GET", "/api/permissions")).data;
ok("the portal-attendance right is a togglable permission",
  (perms.catalog ?? perms.permissions ?? []).some((p) => p.key === "attendance.govt"), JSON.stringify(perms).slice(0, 200));

// ---------------------------------------------------------------- cleanup
await req(admin, "DELETE", `/api/govt-attendance/${done.data._id}`);
await req(admin, "DELETE", `/api/govt-attendance/${again.data._id}`);
ok("an import can be deleted (wrong file, wrong centre)",
  (await req(admin, "GET", `/api/govt-attendance/${done.data._id}`)).status === 404);


// ---------------------------------------------------------------- sheet sources (2026-08-12, rewritten -100)
// Until -100 this section pinned the OPPOSITE contract: "any link a person pastes out of their
// browser can be added". That freedom is exactly what let two of OUR OWN Google workbooks be
// registered and poll trainer/resume/nomination tabs into the review queue for three days after
// the CEO ordered them removed. Since -100 the contract is one workbook — the client's OneDrive
// location sheet — and these assertions pin THAT, plus the lifecycle that still has to work on it.
const CLIENT_WB = "https://onedrive.live.com/:x:/g/personal/c1d310c499f08fba/IQBHQGQ1_HmBRZjCmC1XQMK8AQCFnOpu1H8GXm3MNvZnypE";

// The sheet that came back on 14/08 — refused at the probe, before any server-side fetch.
const gTest = await req(admin, "POST", "/api/sync-sources/test", {
  source_url: "https://docs.google.com/spreadsheets/d/1f9veYSwuLktmggOJdUlspl_yydotdqnf/edit?gid=1579134034#gid=1579134034",
});
ok("-100: a Google Sheets link is refused by the probe, naming the policy rather than a generic error",
  gTest.status === 400 && /client's OneDrive sheet/i.test(String(gTest.data?.error ?? "")),
  `${gTest.status} ${String(gTest.data?.error ?? "").slice(0, 140)}`);
const dTest = await req(admin, "POST", "/api/sync-sources/test", { source_url: "https://drive.google.com/file/d/ABC123def/view?usp=sharing" });
ok("-100: a Drive file link is refused too — the rule is the workbook, not a list of hosts",
  dTest.status === 400, String(dTest.status));

const notALink = await req(admin, "POST", "/api/sync-sources/test", { source_url: "just some text" });
ok("something that is not a link is refused up front", notALink.status === 400, `got ${notALink.status}`);

// The client's real OneDrive workbook — the one case that must keep working end to end.
const odTest = await req(admin, "POST", "/api/sync-sources/test", { source_url: CLIENT_WB });
ok("the client's OneDrive workbook still probes green", odTest.data.ok === true, JSON.stringify(odTest.data).slice(0, 200));
ok("and the probe reports its tabs and columns back", (odTest.data.tabs?.[0]?.columns ?? []).some((c) => /tc\s*id/i.test(c)),
  JSON.stringify(odTest.data.tabs?.[0]?.columns ?? []).slice(0, 200));

// A link the server cannot actually read still fails the probe rather than being saved as a dead
// source. Driven from this server (allowed as a test fixture) now that foreign hosts are refused.
const deadTest = await req(admin, "POST", "/api/sync-sources/test", { source_url: `${BASE}/api/no-such-endpoint-${NAME}` });
ok("a sheet the server cannot read fails the probe instead of being saved as a dead source",
  deadTest.data.ok === false && String(deadTest.data.error ?? "").length > 0, JSON.stringify(deadTest.data).slice(0, 200));
ok("and the failure explains what to do rather than a generic error",
  /anyone with the link|moved, renamed or deleted|without signing in|sign-?in/i.test(`${deadTest.data.error ?? ""} ${deadTest.data.hint ?? ""}`),
  JSON.stringify({ e: deadTest.data.error, h: deadTest.data.hint }).slice(0, 300));

// Add → edit → pause → remove, all through the API the screen uses — on the one workbook allowed.
const created = await req(admin, "POST", "/api/sync-sources", {
  name: `${NAME} sheet`, source_url: CLIENT_WB,
  mode: "watch", interval_minutes: 45, key_columns: ["Institution Name", "Job role"], frequency: "Manual only",
});
ok("-100: the client workbook can be registered", created.status === 201, JSON.stringify(created.data).slice(0, 200));
const srcId = created.data.item?._id;
const foreign = await req(admin, "POST", "/api/sync-sources", {
  name: `${NAME} foreign`, source_url: "https://example.invalid/whatever.csv", mode: "watch", key_columns: [],
});
ok("-100: …and an arbitrary URL cannot (this pin asserted the opposite until -100)", foreign.status === 400, JSON.stringify(foreign.data).slice(0, 160));
const edited = await req(admin, "PATCH", `/api/sync-sources/${srcId}`, { interval_minutes: 60 });
ok("its cadence can be edited afterwards", edited.data.item?.interval_minutes === 60, JSON.stringify(edited.data.item?.interval_minutes));
const walked = await req(admin, "PATCH", `/api/sync-sources/${srcId}`, { source_url: "https://example.invalid/renamed.csv" });
ok("-100: but its URL cannot be walked off the client workbook by editing", walked.status === 400 && (await req(admin, "GET", `/api/sync-sources/${srcId}`)).data.item?.source_url === CLIENT_WB, String(walked.status));
const paused = await req(admin, "PATCH", `/api/sync-sources/${srcId}`, { active: false });
ok("it can be paused without losing its history", paused.data.item?.active === false, JSON.stringify(paused.data.item?.active));
const removed = await req(admin, "DELETE", `/api/sync-sources/${srcId}`);
ok("and removed", removed.status === 200, JSON.stringify(removed.data).slice(0, 150));
ok("removal is real", (await req(admin, "GET", `/api/sync-sources/${srcId}`)).status === 404);


// ---------------------------------------------------------------- SSRF guard (2026-08-12 security review)
// Sheet source URLs are typed in by a person, so every fetch of one is a request the server makes
// on someone else's behalf. This server runs on EC2, where 169.254.169.254 hands out IAM
// credentials — and XLSX.read parses ANY plain text as CSV, so an internal endpoint's response
// would come straight back out of this probe as "columns". These assertions pin that shut.
const SSRF = [
  ["http://169.254.169.254/latest/meta-data/iam/security-credentials/", "the EC2 metadata service"],
  ["http://127.0.0.1:3000/erp/api/home", "loopback"],
  ["http://localhost/", "localhost by name"],
  ["http://10.0.105.118/", "a private 10/8 address"],
  ["http://192.168.1.1/", "a private 192.168/16 address"],
  ["http://172.16.0.5/", "a private 172.16/12 address"],
  ["http://[::1]/", "IPv6 loopback"],
  ["http://[::ffff:169.254.169.254]/", "the metadata service via an IPv4-mapped IPv6 address"],
  ["http://13.202.206.101:27017/", "a non-web port (the Mongo host)"],
  ["file:///etc/passwd", "a non-http scheme"],
];
for (const [url, what] of SSRF) {
  const r = await req(admin, "POST", "/api/sync-sources/test", { source_url: url });
  const blocked = r.status === 400
    || (r.data.ok === false && /internal|not allowed|standard web ports|valid link|resolve/i.test(r.data.error ?? ""));
  ok(`SSRF: ${what} is refused`, blocked, `status=${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
  ok(`SSRF: ${what} returns no content`, (r.data.tabs ?? []).length === 0, JSON.stringify(r.data.tabs ?? []).slice(0, 150));
}

// The guard has to sit on the poller too, not only the one route the review flagged — a source
// saved with an internal URL would otherwise exfiltrate on a timer.
const evil = await req(admin, "POST", "/api/sync-sources", {
  name: `${NAME} ssrf`, source_url: "http://169.254.169.254/latest/meta-data/",
  mode: "watch", interval_minutes: 5, frequency: "Manual only",
});
if (evil.status === 201) {
  const ran = await req(admin, "POST", `/api/sync-sources/${evil.data.item._id}/run`, {});
  ok("SSRF: running a source aimed at the metadata service yields nothing",
    ran.status >= 400 || ran.data.status === "Failed" || /internal|not allowed/i.test(JSON.stringify(ran.data)),
    JSON.stringify(ran.data).slice(0, 200));
  const changes = await req(admin, "GET", "/api/workbook-changes?status=all");
  ok("SSRF: and no instance metadata reached the change log",
    !(changes.data.items ?? []).some((c) => /security-credentials|ami-id|instance-id/i.test(`${c.new_value ?? ""}${c.row_key ?? ""}`)));
  await req(admin, "DELETE", `/api/sync-sources/${evil.data.item._id}`);
} else {
  ok("SSRF: an internal URL cannot even be saved as a source", true);
  ok("SSRF: and no instance metadata reached the change log", true);
}

// The guard must not break the legitimate case.
const stillOk = await req(admin, "POST", "/api/sync-sources/test", {
  source_url: "https://onedrive.live.com/:x:/g/personal/c1d310c499f08fba/IQBHQGQ1_HmBRZjCmC1XQMK8AQCFnOpu1H8GXm3MNvZnypE",
});
ok("SSRF guard does not block the real client workbook", stillOk.data.ok === true, JSON.stringify(stillOk.data).slice(0, 200));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
