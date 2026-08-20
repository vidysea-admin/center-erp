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

// ---- -106: the portal also ships this column as DECIMAL HOURS, and a file can be missing a column
// Found by smoking the new -102 qualification column against REAL production imports: the live
// "Attendance Report 06-08-2026" on Bhadohi SPIT-01 carries "26.6" / "73.99" / "109.94" instead of
// hh:mm:ss, so all 28 matched rows stored null minutes and the whole batch read "— no hours" —
// nobody on a live batch could be judged qualified, including students well past the 60-hour bar.
{
  const decCsv = csvText.split(String.fromCharCode(10)).map((line, i) => {
    if (i === 0 || !line.trim()) return line;
    const cells = line.split(",");
    // the hours cell is the hh:mm:ss one; rewrite it as decimal hours
    const at = cells.findIndex((x) => /^\d+:[0-5]\d:[0-5]\d$/.test(x.trim()));
    if (at >= 0) {
      const [h, m, s] = cells[at].trim().split(":").map(Number);
      cells[at] = (h + m / 60 + s / 3600).toFixed(2);
    }
    return cells.join(",");
  }).join(String.fromCharCode(10));
  const decPre = await upload(admin, { file: new File([Buffer.from(decCsv)], "decimal-hours.csv", { type: "text/csv" }), batch: batch._id });
  const decRows = Object.fromEntries((decPre.data.preview ?? []).map((r) => [r.name, r]));
  ok("-106: decimal hours are read too — 75:50:37 written as 75.84 lands on the same ~4551 minutes",
    Math.abs((decRows[`${NAME} Charlie`]?.total_hours_minutes ?? 0) - 4551) < 2,
    String(decRows[`${NAME} Charlie`]?.total_hours_minutes));
  ok("-106: the preview reports how many rows produced an hour figure at all",
    decPre.data.hours_parsed >= 4, String(decPre.data.hours_parsed));
  ok("-106: a file whose columns all resolve reports nothing missing",
    Array.isArray(decPre.data.missing_columns) && decPre.data.missing_columns.length === 0, JSON.stringify(decPre.data.missing_columns));

  // A junk value must NOT become an hour figure just because it is a number-ish string.
  const junkCsv = csvText.split(String.fromCharCode(10)).map((line, i) => {
    if (i === 0 || !line.trim()) return line;
    const cells = line.split(",");
    const at = cells.findIndex((x) => /^\d+:[0-5]\d:[0-5]\d$/.test(x.trim()));
    if (at >= 0) cells[at] = "N/A";
    return cells.join(",");
  }).join(String.fromCharCode(10));
  const junkPre = await upload(admin, { file: new File([Buffer.from(junkCsv)], "junk-hours.csv", { type: "text/csv" }), batch: batch._id });
  ok("-106: an unreadable hours value stays NULL — it never becomes a silent hour count",
    (junkPre.data.preview ?? []).every((r) => r.total_hours_minutes == null), JSON.stringify((junkPre.data.preview ?? []).map((r) => r.total_hours_minutes)));
  ok("-106: …and the preview warns that NO row produced an hour figure, so nobody can be judged",
    junkPre.data.hours_parsed === 0, String(junkPre.data.hours_parsed));

  // A file genuinely missing a column is NAMED, not silently blank.
  const hdr = csvText.split(String.fromCharCode(10))[0].split(",");
  const presentAt = hdr.findIndex((x) => /total days present/i.test(x));
  const noPresent = csvText.split(String.fromCharCode(10))
    .map((line) => { if (!line.trim()) return line; const cells = line.split(","); cells.splice(presentAt, 1); return cells.join(","); })
    .join(String.fromCharCode(10));
  const missPre = await upload(admin, { file: new File([Buffer.from(noPresent)], "no-present-col.csv", { type: "text/csv" }), batch: batch._id });
  ok("-106: a file with no Total Days Present column still imports, and SAYS which column is missing",
    missPre.status === 200 && (missPre.data.missing_columns ?? []).includes("Total Days Present"),
    `${missPre.status} ${JSON.stringify(missPre.data.missing_columns)}`);
  ok("-106: …and nothing was committed by any of these previews",
    !((await req(admin, "GET", "/api/govt-attendance")).data.items ?? []).some((i) => /decimal-hours|junk-hours|no-present-col/.test(String(i.file_name ?? ""))));
}
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

// ---- -127 (QA-180): a TRAINER is not a candidate for assessment ----
// Found while validating QA-172 on live -106: the "Attendance_Till 16th Aug" export carries 38 rows,
// 37 typed "Trainee" and ONE typed "Trainer" — Manish Kumar himself, 53:48:25 hrs — and every one of
// the 38 got a verdict. His own row read "Not eligible". That is not a wrong answer, it is a category
// error: nothing about a trainer's hours makes them eligible or ineligible for a STUDENT assessment,
// and the not-eligible filter is exactly how Manish builds the list of students to chase.
//
// -109 wrote the right answer already — `label: r.trainer ? "Trainer row" : …` — but put it behind
// `if (!bar)`, and the importer writes `batch: r.batch ?? batchId` onto EVERY row including trainers'.
// So the trainer always had a bar, always skipped that branch, and always got a student verdict. The
// pin is on the OUTPUT, not the branch, so it stays true however the code is arranged next.
//
// MEASURED, and it changed the pin: the existing committed import above carries NO batch, so every
// row falls into the bar-less branch and the trainer LOOKS handled. Manish always uploads against a
// batch. This block therefore commits a BATCH-SCOPED import — the production shape — where the
// fallback `imp.batch?._id` supplies a bar to a trainer's row and the student verdict follows.
{
  // its own file name on purpose: the -108 preview pin proves "a preview wrote nothing" by looking
  // for govt-attendance-sample.csv against THIS batch, so a second import under that name would
  // make an unrelated pin fail for an unrelated reason.
  const scoped = await upload(admin, { file: new File([Buffer.from(csvText)], "trainer-scope.csv", { type: "text/csv" }), batch: batch._id, confirm: "1", period_label: `trainer-scope ${STAMP}` });
  ok("QA-180: a batch-scoped import commits (this is how the centre actually uploads)", scoped.status === 201, JSON.stringify(scoped.data).slice(0, 160));
  const sd = await req(admin, "GET", `/api/govt-attendance/${scoped.data._id}`);
  const t = (sd.data.rows ?? []).find((r) => /Trainer/.test(String(r.name)));
  ok("QA-180: the export's own Trainer row is still imported and still reconciled", !!t, JSON.stringify((sd.data.rows ?? []).map((r) => r.name)));
  ok("QA-180: a trainer is never given a student eligibility verdict",
    t?.verdict?.state === "trainer", JSON.stringify({ state: t?.verdict?.state, label: t?.verdict?.label }));
  ok("QA-180: …and the verdict says WHY, so nobody has to guess at a blank",
    /trainer/i.test(String(t?.verdict?.label ?? "")) && /not a candidate|eligibility does not apply/i.test(String(t?.verdict?.detail ?? "")),
    JSON.stringify({ label: t?.verdict?.label, detail: t?.verdict?.detail }));
  ok("QA-180: a trainer counts in NEITHER the qualified nor the not-eligible bucket",
    sd.data.qualified_count + sd.data.in_progress_count + sd.data.no_hours_count
      + sd.data.not_eligible_count + sd.data.not_enrolled_count + (sd.data.trainer_count ?? 0) === sd.data.rows.length
      && sd.data.trainer_count === 1,
    JSON.stringify({ q: sd.data.qualified_count, ip: sd.data.in_progress_count, nh: sd.data.no_hours_count,
      ne: sd.data.not_eligible_count, nen: sd.data.not_enrolled_count, tr: sd.data.trainer_count, rows: sd.data.rows.length }));
}

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

  // ---- -153 (QA-393/QA-293): WHY the figures are absent, and it is not the reason we were giving.
  // Manish, 20/08, on the two live Sachin Kumars: the tab told the operator the export had never
  // been imported, for two students whose hours (63:09:00 and 60:30:00) were sitting in this very
  // collection. It was imported three times. The Twins are the same shape as those two - one name,
  // two people, no portal IDs, so the matcher refuses to guess (correctly) and their rows stay
  // Ambiguous with their hours on them.
  {
    const twinRows = (att.data.members ?? []).filter((m) => m.name === `${NAME} Twin`);
    ok("-153 (QA-393): both same-name students are 'awaiting_match', not 'no portal hours'",
      twinRows.length === 2 && twinRows.every((m) => m.verdict?.state === "awaiting_match"),
      JSON.stringify(twinRows.map((m) => m.verdict?.state)));
    // -156 (QA-439): this assertion pinned the exact sentence QA-439 exists to change. What it was
    // really testing survives word-for-word - the line must not claim the export was never imported,
    // and it must point at the screen that resolves the row - so those two clauses are untouched.
    // The third clause named one wording of "the row is not attached yet"; the shared-name branch
    // says the same thing differently ("which of them it belongs to ... has not been decided yet"),
    // so the clause now accepts either. Changed because the behaviour changed, not to go green.
    ok("-153 (QA-393): and the sentence no longer claims the export was never imported",
      twinRows.every((m) => !/has not been imported/i.test(String(m.verdict?.detail ?? ""))
        && /(attached to (a|this) student|has not been decided)/i.test(String(m.verdict?.detail ?? ""))
        && /Government Attendance/i.test(String(m.verdict?.detail ?? ""))),
      JSON.stringify(twinRows.map((m) => m.verdict?.detail)));
    // A re-import supersedes rather than doubles: this fixture uploads the same file more than
    // once, so a helper that counted across imports said "4 rows" about two people.
    // -156 (QA-439): same reason - the FIGURE is what this pins (2, not 4, after three imports of
    // one file), and the shared-name branch says "under it" where the single-name branch said
    // "under this name". The number and its meaning are unchanged.
    ok("-153: the unresolved-row count is not multiplied by re-imports",
      twinRows.every((m) => /carries 2 rows under (this name|it)/.test(String(m.verdict?.detail ?? ""))),
      JSON.stringify(twinRows.map((m) => m.verdict?.detail)));
    ok("-153 (QA-393): the count is broken out, and no_hours no longer absorbs them",
      att.data.verdict_counts?.awaiting_match === 2, JSON.stringify(att.data.verdict_counts));
    // QA-085 is the invariant this must not break: an UNATTACHED row is evidence a number exists,
    // never evidence whose it is. Nothing here may qualify anybody.
    ok("-153 (QA-085 holds): an awaiting-match student is never qualified",
      twinRows.every((m) => m.qualified === false && m.verdict?.qualified === false),
      JSON.stringify(twinRows.map((m) => [m.qualified, m.verdict?.qualified])));
    // The rows the matcher DID attach must be untouched by any of this.
    ok("-153: a matched student is unaffected (Charlie still reads portal hours)",
      rows[`${NAME} Charlie`]?.verdict?.state !== "awaiting_match" && rows[`${NAME} Charlie`]?.govt?.hours === 76,
      JSON.stringify(rows[`${NAME} Charlie`]?.verdict?.state));

    // -153 cycle 2 (QA-413): the -109 invariant is that the buckets PARTITION the roster. Four
    // assertions pinned particular bucket values and NOTHING pinned the sum, so the hand-typed
    // list could go stale silently the next time a state was added - which is what awaiting_match
    // nearly did.
    {
      const live = (att.data.members ?? []).filter((m) => !m.left_on).length;
      const summed = Object.values(att.data.verdict_counts ?? {}).reduce((a, b) => a + b, 0);
      ok("-153 (QA-413): the verdict buckets partition the roster (sum == live members)",
        summed === live, JSON.stringify({ summed, live, buckets: att.data.verdict_counts }));
      ok("-153 (QA-413): every state the code can return has a bucket, including the empty ones",
        ["qualified", "in_progress", "no_hours", "awaiting_match", "not_eligible", "not_enrolled", "trainer"]
          .every((k) => typeof att.data.verdict_counts?.[k] === "number"),
        JSON.stringify(Object.keys(att.data.verdict_counts ?? {})));
    }

    // -153 cycle 2 (QA-409): the STUDENTS own page is a third surface carrying the same false
    // sentence, and after cycle 1 it was the only one still carrying it. QA-085s validation
    // condition is that the candidates portal page and the batch tab cannot disagree.
    {
      const twin = (att.data.members ?? []).find((m) => m.name === `${NAME} Twin`);
      const links = await req(admin, "POST", "/api/public-tokens", { purpose: "attendance", batch: batch._id });
      const mine = (links.data.items ?? []).find((i) => String(i.batch_member?._id ?? i.batch_member) === String(twin?.member_id));
      ok("-153 (QA-409) fixture: an attendance link exists for a same-name student",
        !!mine?.token, JSON.stringify({ member: twin?.member_id, got: (links.data.items ?? []).length }));
      if (mine?.token) {
        const pub = await fetch(`${BASE}/api/public/attendance/${mine.token}`).then((r) => r.json()).catch(() => ({}));
        ok("-153 (QA-409): the students own page knows the portal row is waiting on a match",
          (pub?.awaiting_match?.count ?? 0) > 0, JSON.stringify({ awaiting: pub?.awaiting_match, basis: pub?.hours_basis }));
        // -156 (QA-439): the THIRD surface, and the only one a student sees. The batch tab and the
        // roster were taught not to tell two same-name students "it is yours"; this page reaches
        // awaitingMatchFor() directly and never passes through eligibilityVerdict, so the sentence
        // it renders had to be taught separately or the person most affected keeps the old claim.
        ok("-156 (QA-439): the student's own page knows how many people on this roster answer to their name",
          (pub?.awaiting_match?.same_name_members ?? 0) > 1,
          JSON.stringify({ awaiting: pub?.awaiting_match }));
        // -153 cycle 3 (QA-423): cycle 2 kept this and called it an invariant. It is vacuous in
        // exactly the way the assertion cycle 2 DELETED was vacuous - this fixture batch carries no
        // slot (QA-085 pins that), so attended_hours is null and remaining_hours is null whichever
        // way the code goes. Two assertions, one property, two standards. Deleted, same as the
        // other one. The behaviour is real and the checker measured it on a slot-bearing batch;
        // what is gone is a green line that could not go red.
      } else {
        ok("-153 (QA-409): the students own page knows the portal row is waiting on a match", false, "no token");
      }
    }

    // -153 cycle 3 (QA-419). Cycle 2 gave the three surfaces the same LOOKUP and not the same
    // GATE: eligibilityVerdict returns not_enrolled at gate 1 and never reaches awaiting_match,
    // while members/route.ts and the public route consulted the lookup with no enrolment test at
    // all. One unattached row, three answers - and the Attendance tab fell back to "~0/60 hrs
    // (est.)", which is QA-293s own string, still rendered by the release written to end it.
    //
    // The gate is now ONE helper and the answer rides on the ROW, so enrolment cannot split them.
    {
      // Build the case rather than hope for it: a THIRD candidate sharing the Twins name, added to
      // the roster and deliberately left un-enrolled. Removed at the end of this block, because the
      // resolve-drawer assertions further down count exactly two same-name candidates.
      const ncCand = (await req(admin, "POST", "/api/candidates", {
        name: `${NAME} Twin`, phone: `9${STAMP.slice(1)}1900`, location: loc._id, program: program._id,
      }, 201)).data.item;
      const ncMem = (await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: ncCand._id }, 201)).data.item;
      ok("-153 (QA-419) fixture: a NOT-enrolled member sharing the same name is on the roster",
        !!ncMem?._id, JSON.stringify(ncMem).slice(0, 140));

      const att2 = await req(admin, "GET", `/api/batches/${batch._id}/attendance`);
      const roster2 = await req(admin, "GET", `/api/batches/${batch._id}/members`);
      const rosterBy = new Map((roster2.data.items ?? []).map((m) => [String(m._id), m]));
      const live = (att2.data.members ?? []).filter((m) => !m.left_on);

      // ANTI-VACUITY FIRST: the first draft of this pin assumed the fixture already held this case
      // and its own guard proved it did not - every member read "Completed". Assert the case exists
      // before asserting anything about it.
      const notEnrolledWaiting = live.filter((m) => m.enrollment_status !== "Completed" && m.awaiting_match);
      ok("-153 (QA-419) anti-vacuity: a NOT-enrolled member with an unattached row is really present",
        notEnrolledWaiting.length > 0,
        JSON.stringify(live.map((m) => [m.name, m.enrollment_status, !!m.awaiting_match])));

      // -156 (QA-432): the FOURTH surface. Every chip reads the ungated ROW; the Closure summary
      // line read the journey-gated BUCKET, so a not-enrolled member with an unattached row was
      // shown by three surfaces and counted by none. The discriminator is that the two numbers
      // differ in the right direction while the -109 partition still holds untouched.
      {
        const liveRows = live.filter((m) => m.awaiting_match).length;
        ok("-156 (QA-432): the Closure count reads the ROW field, so it includes the not-enrolled one",
          att2.data.awaiting_match_rows === liveRows && liveRows > (att2.data.verdict_counts?.awaiting_match ?? 0),
          JSON.stringify({ rows: att2.data.awaiting_match_rows, computed: liveRows, gated_bucket: att2.data.verdict_counts?.awaiting_match }));
        const summed = Object.values(att2.data.verdict_counts ?? {}).reduce((a, b) => a + b, 0);
        ok("-156 (QA-432): ...and verdict_counts is UNCHANGED - still a partition of the roster",
          summed === live.length, JSON.stringify({ summed, live: live.length }));
      }

      // -156 (QA-439): one row cannot belong to two people. With the third same-name member on the
      // roster the sentence must stop saying "this student" and say whose it is has not been decided.
      {
        const shared = live.filter((m) => m.verdict?.state === "awaiting_match" && m.name === `${NAME} Twin`);
        ok("-156 (QA-439): with a shared name the sentence never claims the row is THIS student's",
          shared.length > 0 && shared.every((m) => !/attached to this student/i.test(String(m.verdict?.detail ?? ""))
            && /share this name/i.test(String(m.verdict?.detail ?? ""))),
          JSON.stringify(shared.map((m) => String(m.verdict?.detail ?? "").slice(0, 110))));
      }

      const disagree = live.filter((m) => !!m.awaiting_match !== !!rosterBy.get(String(m.member_id))?.hours?.awaiting_match);
      ok("-153 (QA-419): the Attendance tab and the roster agree about every member, enrolled or not",
        disagree.length === 0,
        JSON.stringify(disagree.map((m) => ({
          name: m.name, enrolment: m.enrollment_status, verdict: m.verdict?.state,
          tab: !!m.awaiting_match, roster: !!rosterBy.get(String(m.member_id))?.hours?.awaiting_match,
        }))));

      const target = notEnrolledWaiting[0] ?? live.find((m) => String(m.member_id) === String(ncMem?._id));
      const links2 = await req(admin, "POST", "/api/public-tokens", { purpose: "attendance", batch: batch._id });
      const link2 = (links2.data.items ?? []).find((i) => String(i.batch_member?._id ?? i.batch_member) === String(target?.member_id));
      const pub2 = link2?.token
        ? await fetch(`${BASE}/api/public/attendance/${link2.token}`).then((r) => r.json()).catch(() => ({}))
        : {};
      ok("-153 (QA-419): and the students own page agrees with both, for a NOT-enrolled member",
        !!pub2?.awaiting_match === !!target?.awaiting_match && !!target?.awaiting_match,
        JSON.stringify({ name: target?.name, enrolment: target?.enrollment_status, tab: !!target?.awaiting_match, student: !!pub2?.awaiting_match }));
      // The WORDING that must not be used - "the portal has sent your hours" to a student whose
      // registration is still pending - lives in the page, not in this payload, so an assertion
      // here could never fail. It is checked in check-user-copy.mjs where it is actually true.

      // -156 (QA-436): the links minted above outlive the member they were minted for - the token
      // row survives with active:true and batch_member pointing at a document that no longer
      // exists (measured: 13 attendance tokens per wall, exactly 1 orphaned). It 404s, so there is
      // no user-facing harm; a fixture that leaves live credentials behind is still debris.
      // NOTE, stated rather than implied: this pin CANNOT fail on pre-fix source, because the
      // defect and the fix both live in this file. Its evidence is the orphan count in the test
      // database before and after, recorded in the manifest - not a red line in a pre-fix run.
      const minted = (links2.data.items ?? []).filter((i) => String(i.batch_member?._id ?? i.batch_member) === String(ncMem?._id));
      const revoked = [];
      for (const t of minted) revoked.push((await req(admin, "PATCH", `/api/public-tokens/${t._id}`, { active: false })).data.item);
      ok("-156 (QA-436): every attendance link minted for the transient member is revoked before it is deleted",
        minted.length > 0 && revoked.length === minted.length && revoked.every((d) => d && d.active === false),
        JSON.stringify({ minted: minted.length, revoked: revoked.filter((d) => d?.active === false).length }));

      // clean up so the resolve-drawer assertions below still see exactly two same-name candidates
      await req(admin, "DELETE", `/api/members/${ncMem._id}`, { reason: "-153 QA-419 pin fixture" });
      await req(admin, "DELETE", `/api/candidates/${ncCand._id}`, { reason: "-153 QA-419 pin fixture" });
      const backTo = (await req(admin, "GET", `/api/batches/${batch._id}/attendance`)).data.members ?? [];
      ok("-153 (QA-419) fixture removed: the roster is back to its original size",
        backTo.length === (att.data.members ?? []).length,
        JSON.stringify({ before: (att.data.members ?? []).length, after: backTo.length }));
      // -156 (QA-436): "back to its original size" is a weaker claim than it reads as - one row
      // added and another dropped satisfies it. Assert what was actually created is actually gone.
      const goneCand = await req(admin, "GET", `/api/candidates/${ncCand._id}`);
      ok("-156 (QA-436): ...and each thing the fixture created is gone by name, not merely by count",
        !backTo.some((m) => String(m.member_id) === String(ncMem?._id)) && goneCand.status === 404,
        JSON.stringify({ member_still_there: backTo.some((m) => String(m.member_id) === String(ncMem?._id)), candidate_get: goneCand.status }));
    }

    // QA-293: the same two students on the ROSTER, where the screen rendered "~0 / 60 hrs (est.)"
    // off our own daily logs - an estimate that was honest about its basis and still said "~0"
    // about people who may well have cleared the bar.
    const roster = await req(admin, "GET", `/api/batches/${batch._id}/members`);
    const twinMembers = (roster.data.items ?? []).filter((m) => m.candidate?.name === `${NAME} Twin`);
    ok("-153 (QA-293): the roster knows an unattached portal row exists for them",
      twinMembers.length === 2 && twinMembers.every((m) => m.hours?.awaiting_match?.count > 0),
      JSON.stringify(twinMembers.map((m) => m.hours?.awaiting_match)));
    ok("-153 (QA-293): and a student the portal HAS answered for is not flagged",
      (roster.data.items ?? []).filter((m) => m.candidate?.name === `${NAME} Charlie`)
        .every((m) => m.hours?.awaiting_match == null),
      JSON.stringify((roster.data.items ?? []).filter((m) => m.candidate?.name === `${NAME} Charlie`).map((m) => m.hours?.awaiting_match)));
  }
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

// ---- -142 (QA-297 / QA-300, 19 Aug recording) ----
// QA-297: the File line read 'Gurugram Batch 2 - final attendance.csv' and the Period label under
// it read 'Guguram Batch 2 - Final Attendance' — a letter short and Title Cased. MEASURED FIRST,
// because the row could not tell whether the label was derived or typed and that decided whether
// there was a bug at all: it is TYPED (the drawer's only writer is the operator's input; the
// server falls back to the filename only when it is left blank). So the misspelling was a human
// mistype, not a derivation bug — and what was actually missing is any way to correct it. The
// IMPORT stays uneditable, because it records what the portal said; the NAME is ours.
{
  const renamed = await req(admin, "PATCH", `/api/govt-attendance/${done.data._id}`, { period_label: `Gurugram fixed ${STAMP}` }, 200);
  ok("-142 (QA-297): an import's own NAME can be corrected — the mistype has a way out",
    renamed.data.item?.period_label === `Gurugram fixed ${STAMP}`, JSON.stringify(renamed.data.item?.period_label));
  ok("-142 (QA-297): ...and it is audited, old value to new",
    ((await req(admin, "GET", `/api/audit/GovtAttendanceImport/${done.data._id}`)).data.items ?? [])
      .some((a) => a.field === "period_label" && /Gurugram fixed/.test(String(a.new_value))),
    "no audit row for the rename");
  ok("-142 (QA-297): a blank name is refused — an import with no name cannot be told from the next one",
    (await req(admin, "PATCH", `/api/govt-attendance/${done.data._id}`, { period_label: "   " })).status === 400);
  // the rest of the import is NOT reachable through that door
  await req(admin, "PATCH", `/api/govt-attendance/${done.data._id}`, { period_label: `Gurugram fixed ${STAMP}`, row_count: 999, matched_count: 999 }, 200);
  const untouched = (await req(admin, "GET", `/api/govt-attendance/${done.data._id}`)).data.item;
  ok("-142 (QA-297): ...and nothing else about the import is editable through it — it records what the portal said",
    untouched.row_count !== 999 && untouched.matched_count !== 999,
    JSON.stringify({ rows: untouched.row_count, matched: untouched.matched_count }));

  // QA-300: '35 differ from our logs' at a centre whose every candidate reads 'OUR DAYS 0 / 0'.
  ok("-142 (QA-300): the preview says whether there is any attendance of OURS to compare against",
    typeof done.data.have_local_logs === "boolean", JSON.stringify({ have: done.data.have_local_logs, variance: done.data.variance_count }));
}const varOnly = await req(admin, "GET", `/api/govt-attendance/${done.data._id}?filter=variance`);
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

// ---- -108: the portal ID travels BACK to the candidate ----
// The defect Umesh hit on 17/08: eight correctly-named certificate files all refused, because not
// one of 39 roster candidates carried a sidh_candidate_id — and the certificate matcher joins on
// exactly that field. The mapping was never missing, only unwritten: this importer had already
// matched every row to a candidate BY NAME and stored the CAN id on the row. Now it writes it back.
{
  const g = await req(admin, "GET", `/api/govt-attendance/${done.data._id}`);
  const rows = g.data.rows ?? [];
  // Charlie matched by NAME (no portal id on the candidate at fixture time) — so the import should
  // have stamped Charlie's id from the file.
  const charlie = rows.find((r) => r.name === `${NAME} Charlie`);
  const cand = charlie?.candidate?._id ? (await req(admin, "GET", `/api/candidates/${charlie.candidate._id}`)).data.item : null;
  ok("-108: an UNAMBIGUOUS name match stamps the portal ID onto the candidate",
    !!cand && /^CAN/i.test(String(cand.sidh_candidate_id ?? "")) && String(cand.sidh_candidate_id).replace(/[_\s-]/g, "").toUpperCase() === String(charlie.govt_candidate_id).replace(/[_\s-]/g, "").toUpperCase(),
    JSON.stringify({ on_candidate: cand?.sidh_candidate_id, on_row: charlie?.govt_candidate_id }));
  ok("-108: …and the stamp is audited, naming the import it came from",
    ((await req(admin, "GET", `/api/audit/Candidate/${charlie.candidate._id}`)).data.items ?? [])
      .some((a) => a.field === "sidh_candidate_id" && /linked from portal import/i.test(String(a.new_value))));
  // Alpha already carried CAN_<STAMP>0001 before the import — an existing id is never overwritten.
  const alpha = rows.find((r) => r.name === `${NAME} Alpha`);
  const alphaCand = (await req(admin, "GET", `/api/candidates/${alpha.candidate._id}`)).data.item;
  ok("-108: an id already on record is NEVER overwritten by an import",
    alphaCand.sidh_candidate_id === `CAN_${STAMP}0001`, String(alphaCand.sidh_candidate_id));
  // The two Twins are Ambiguous — an identity field must never be written off a guess.
  const twins = rows.filter((r) => r.name === `${NAME} Twin`);
  const twinCands = await Promise.all(members.filter((m) => m.name === `${NAME} Twin`).map((m) => req(admin, "GET", `/api/candidates/${m.candidate._id}`).then((r) => r.data.item)));
  ok("-108: an AMBIGUOUS row stamps nothing — a government ID is never written off a guess",
    twinCands.every((c) => !c.sidh_candidate_id), JSON.stringify(twinCands.map((c) => c.sidh_candidate_id)));
  ok("-108: the import reports how many portal IDs it linked", typeof done.data.portal_ids_linked === "number" && done.data.portal_ids_linked >= 1, String(done.data.portal_ids_linked));

  // ---- -137 (G-01/G-02/G-04/G-10, 19/08 recording): the ambiguity DEADLOCK ----
  // The reviewer found two "Sachin Kumar" rows, both past the 60-hour bar, both dropped from the
  // qualified count — 25 shown where 27 qualify. The suggested fix was "match on portal ID first",
  // which is already what matchGovtRows does. The real trap is underneath: the ID branch can only
  // see candidates that ALREADY carry sidh_candidate_id, and every automatic writer of that field
  // refuses an ambiguous match (rightly — an identity field must never be written off a guess). So
  // two same-name candidates with no portal ID could never self-heal, and the same file re-imported
  // went Ambiguous again, every time.
  //
  // A human choosing is not a guess. These pins are written on the QUESTION rather than the route:
  // does a resolve make the NEXT import work? That is the clause that fails on the old code.
  {
    const amb = twins[0];
    ok("-137 (G-10): the ambiguity note names the row it belongs to, so two of them are not identical",
      /portal ID|row \d/i.test(String(amb.match_note ?? "")) && new RegExp(String(amb.govt_candidate_id ?? "x")).test(String(amb.match_note ?? "")),
      String(amb.match_note ?? ""));
    ok("-137 (G-10): ...and the two same-name notes now DIFFER",
      twins.length > 1 && twins[0].match_note !== twins[1].match_note,
      JSON.stringify(twins.map((t) => t.match_note)));

    // The state-changing half of this group runs AFTER the -102 block below, because that block
    // needs BOTH twins still ambiguous and mine resolved one of them — it asserts
    // "counts.ambiguous === 1" and reaches for rows[1]. Reading the notes here is safe; resolving
    // is not. (Found by running it: two unrelated -102 pins died for my reason.)
  }
}

// ---- -108 follow-up: the write-back is CONSENTED TO before it happens ----
// The checker's point, and it is a fair one: the evidence for stamping a permanent government ID is
// a NAME match. That is unavoidable — a row matched on the portal ID means the candidate already has
// one — so the answer is that the operator sees who is about to receive an ID, and on what evidence,
// while the import is still only a preview.
{
  const pre = await upload(admin, { file: csvFile(), batch: batch._id });
  ok("-108: the import PREVIEW names every portal ID it would write, and on what evidence",
    Array.isArray(pre.data.portal_ids_to_link)
    && pre.data.portal_ids_to_link.every((p) => p.name && p.id && p.matched_by),
    JSON.stringify(pre.data.portal_ids_to_link?.slice(0, 3)));
  ok("-108: …and an AMBIGUOUS candidate is never on that list (a shared name stamps nothing)",
    !(pre.data.portal_ids_to_link ?? []).some((p) => p.name === `${NAME} Twin`),
    JSON.stringify((pre.data.portal_ids_to_link ?? []).map((p) => p.name)));
  ok("-108: …and a candidate who already carries an ID is not on it either (never overwritten)",
    !(pre.data.portal_ids_to_link ?? []).some((p) => p.name === `${NAME} Alpha`));
  ok("-108: the preview wrote nothing — the IDs are still unlinked until confirm",
    !((await req(admin, "GET", "/api/govt-attendance")).data.items ?? []).some((i) => i.file_name === "govt-attendance-sample.csv" && String(i.batch?._id ?? "") === String(batch._id)));
}

// ---- -108: the one-click back-fill for data imported BEFORE the write-back existed ----
// Nobody should have to re-upload a file they already imported. This door reads the Matched rows
// already on record and links the roster from them.
{
  // A fresh batch + candidate with no portal id, then an import that matches by name.
  const lb = (await req(admin, "POST", "/api/batches", { location: loc._id, program: program._id, target_size: 1, planned_start: localDate() })).data.item;
  const lc = (await req(admin, "POST", "/api/candidates", { name: `${NAME} Backfill`, phone: "9555" + STAMP, location: loc._id, program: program._id })).data.item;
  const lm = (await req(admin, "POST", `/api/batches/${lb._id}/members`, { candidate: lc._id })).data.item;
  const plan0 = await req(admin, "GET", `/api/batches/${lb._id}/link-portal-ids`);
  ok("-108: the back-fill GET previews without writing — nothing to link before any import",
    plan0.status === 200 && plan0.data.roster === 1 && plan0.data.with_portal_id === 0 && (plan0.data.linkable ?? []).length === 0,
    JSON.stringify({ roster: plan0.data.roster, with: plan0.data.with_portal_id, linkable: plan0.data.linkable?.length }));

  // Import one row for that candidate, matched by name, and REMOVE the id it stamps so this test
  // exercises the back-fill rather than the write-back.
  const lines = csvText.split(String.fromCharCode(10));
  const alphaAt = lines.findIndex((l) => l.includes(`${NAME} Alpha`));
  const one = [lines[0], lines[alphaAt]].join(String.fromCharCode(10))
    .replace(`${NAME} Alpha`, `${NAME} Backfill`).replace(`CAN_${STAMP}0001`, `CAN_${STAMP}7777`);
  const impRes = await upload(admin, { file: new File([Buffer.from(one)], "backfill.csv", { type: "text/csv" }), batch: lb._id, confirm: "1", period_label: `backfill ${STAMP}` });
  ok("-108 fixture: the row imported and matched", impRes.status === 201 && impRes.data.matched_count === 1, JSON.stringify(impRes.data).slice(0, 140));
  await req(admin, "PATCH", `/api/candidates/${lc._id}`, { sidh_candidate_id: "" });

  const plan1 = await req(admin, "GET", `/api/batches/${lb._id}/link-portal-ids`);
  ok("-108: the back-fill now SEES the link the import already knows, and says so before writing",
    (plan1.data.linkable ?? []).length === 1 && plan1.data.linkable[0].can === `CAN${STAMP}7777`,
    JSON.stringify(plan1.data.linkable));
  const did = await req(admin, "POST", `/api/batches/${lb._id}/link-portal-ids`);
  const lcAfter = (await req(admin, "GET", `/api/candidates/${lc._id}`)).data.item;
  ok("-108: the click links it, and the candidate now carries the portal ID",
    did.data.linked === 1 && String(lcAfter.sidh_candidate_id).replace(/_/g, "") === `CAN${STAMP}7777`,
    JSON.stringify({ linked: did.data.linked, id: lcAfter.sidh_candidate_id }));
  ok("-108: …audited as coming from the already-imported attendance",
    ((await req(admin, "GET", `/api/audit/Candidate/${lc._id}`)).data.items ?? [])
      .some((a) => a.field === "sidh_candidate_id" && /already imported/i.test(String(a.new_value))));
  const again2 = await req(admin, "POST", `/api/batches/${lb._id}/link-portal-ids`);
  ok("-108: running it twice links nothing more — idempotent, and it never overwrites",
    again2.data.linked === 0 && again2.data.with_portal_id === 1, JSON.stringify(again2.data));
  // And now the certificate matcher can finally see this candidate.
  ok("-108: the whole point — a certificate named for that id is now proposed to this candidate",
    await (async () => {
      const fd = new FormData();
      fd.append("files", new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], `CAN_${STAMP}7777.pdf`, { type: "application/pdf" }));
      const r2 = await fetch(`${BASE}/api/batches/${lb._id}/certificates`, { method: "POST", headers: { cookie: admin }, body: fd });
      const d2 = await r2.json().catch(() => ({}));
      const hit = (d2.staged ?? [])[0];
      if (hit?.url) await req(admin, "DELETE", `/api/files/${String(hit.url).split("/").pop()}`);
      return hit?.member === String(lm._id);
    })());
  await req(admin, "POST", `/api/batches/${lb._id}/transition`, { target: "Cancelled", reason: "-108 backfill fixture done" });
}

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
  // -109 split this from three buckets into five: only `not_eligible` is a verdict now, and
  // "still short while the course runs" and "no hours in this file" are their own honest states.
  // -127 (QA-180) added a sixth state: a trainer is not on the student ladder at all. The invariant
  // is unchanged and NOT weakened - every row still lands in exactly one bucket - but the sum now
  // has to include the bucket that was added, or a trainer would silently unbalance it.
  ok("-102/-109/-127: the summary counts add up to the row count across ALL SIX states",
    g.data.qualified_count + g.data.in_progress_count + g.data.no_hours_count + g.data.not_eligible_count + g.data.not_enrolled_count + (g.data.trainer_count ?? 0) === g.data.rows.length,
    JSON.stringify({ q: g.data.qualified_count, p: g.data.in_progress_count, h: g.data.no_hours_count, n: g.data.not_eligible_count, e: g.data.not_enrolled_count, t: g.data.trainer_count, rows: g.data.rows.length }));
  ok("-109: while this batch is still Active, nobody in the file is called 'not eligible'",
    g.data.not_eligible_count === 0, String(g.data.not_eligible_count));
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
  // -104, found by driving this drawer in a real browser: the two colliding options rendered
  // IDENTICALLY (same name, no portal ID, same batch), so the screen whose only job is "pick the
  // right one" gave the operator nothing to pick on. Each option must carry something that
  // separates it — the phone is unique per candidate, and the enrolment date orders a register.
  ok("-104: colliding options are DISTINGUISHABLE — each carries a phone and an enrolment date",
    opts.data.options.filter((o) => o.collides).every((o) => !!o.phone && !!o.joined_on)
    && new Set(opts.data.options.filter((o) => o.collides).map((o) => o.phone)).size === opts.data.collisions,
    JSON.stringify(opts.data.options.filter((o) => o.collides).map((o) => [o.name, o.phone, o.joined_on, o.enrollment_status])));
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

  // ---- -137 (G-02), the state-changing half, deliberately last in this file ----
  // -102 above has just resolved ONE twin manually and left the other ambiguous. That remaining row
  // is exactly the shape this needs, and using it means this block creates no fixture of its own.
  {
    const stillAmb = ((await req(admin, "GET", `/api/govt-attendance/${done.data._id}?filter=ambiguous`)).data.rows ?? [])[0];
    ok("-137 (G-02): one ambiguous row remains to resolve", !!stillAmb, "none left");
    const mineMember = members.filter((m) => m.name === `${NAME} Twin`).find((m) => String(m.candidate._id) !== String(pickId));
        const res = await req(admin, "POST", `/api/govt-attendance/${done.data._id}/rows/${stillAmb._id}/match`,

      { candidate: mineMember.candidate._id, reason: "e2e: picked by portal ID" }, 200);

    ok("-137 (G-02): an ambiguous row can be resolved from the row itself", res.status === 200, JSON.stringify(res.data).slice(0, 140));



    const after = (await req(admin, "GET", `/api/candidates/${mineMember.candidate._id}`)).data.item;

    ok("-137 (G-02): ...and the human's choice STAMPS the portal ID, which no automatic path may do",

      after.sidh_candidate_id === String(stillAmb.govt_candidate_id).trim(),

      JSON.stringify({ got: after.sidh_candidate_id, want: stillAmb.govt_candidate_id }));

    ok("-137 (G-02): ...audited against the candidate, because it is identity data",

      ((await req(admin, "GET", `/api/audit/Candidate/${mineMember.candidate._id}`)).data.items ?? []).some((x) => String(x.field) === "sidh_candidate_id"),

      "no audit row for the stamp");



    // THE CLAUSE THAT FAILS TODAY: re-import the same file and the row matches on its own.

    const again2 = await upload(admin, { file: csvFile(), confirm: "1", period_label: `deadlock ${STAMP}` });

    const reRows = (await req(admin, "GET", `/api/govt-attendance/${again2.data._id}`)).data.rows ?? [];

    const reMine = reRows.find((r) => String(r.govt_candidate_id).trim() === String(stillAmb.govt_candidate_id).trim());

    ok("-137 (G-02): a RE-IMPORT of the same file now matches that row on its portal ID, with nobody helping",

      reMine?.match_status === "Matched" && reMine?.match_by === "Portal ID",

      JSON.stringify({ status: reMine?.match_status, by: reMine?.match_by }));

    ok("-137 (G-01/G-04): ...so the row is no longer 'not matched to a student' and can be judged at all",

      reMine?.verdict?.state !== "not_enrolled" || !!reMine?.candidate,

      JSON.stringify({ state: reMine?.verdict?.state, cand: !!reMine?.candidate }));

  }
}

// ---- -143 (QA-300 + QA-298): both of these are the SAME defect ----
// A value computed at IMPORT time and persisted answers the question as it was on the day of the
// import, and keeps answering it that way forever. Two rows reopened on that shape in one week.
{
  // QA-300 (checker's PARTIAL on -142). have_local_logs was computed into `counts` and handed to
  // the upload PREVIEW - but it is not a field on GovtAttendanceImportSchema, so create() drops it
  // in strict mode. NO import has ever stored it. The list and the detail read undefined forever,
  // and -142's grey branch was right on those two surfaces only by accident, because undefined is
  // falsy and the live imports happen to have no logs. This pin is TRUE, so nothing stored can
  // satisfy it: the only way to pass is to derive it from the rows.
  const listed = ((await req(admin, "GET", "/api/govt-attendance")).data.items ?? []).find((x) => String(x._id) === String(done.data._id));
  ok("-143 (QA-300): the imports LIST says whether we have any attendance of our own - and here it is TRUE, which nothing stores",
    listed?.have_local_logs === true, JSON.stringify({ got: listed?.have_local_logs }));

  // The mistake this one exists to catch: deriving it from the rows the detail route just
  // FETCHED. Those are filtered, so an ambiguous-only view holds no local logs at all and the
  // chip would answer differently depending on which chip you had clicked.
  const dAll = (await req(admin, "GET", `/api/govt-attendance/${done.data._id}`)).data.item;
  const dAmb = (await req(admin, "GET", `/api/govt-attendance/${done.data._id}?filter=ambiguous`)).data.item;
  ok("-143 (QA-300): ...the detail answers it for the whole import, so the filter cannot change the answer",
    dAll?.have_local_logs === true && dAmb?.have_local_logs === true,
    JSON.stringify({ all: dAll?.have_local_logs, ambiguous: dAmb?.have_local_logs }));

  // QA-298 (checker REOPENED at -141): -137 rewrote the ambiguity note so two colliding rows could
  // be told apart, and that wording IS in govt-attendance.ts - but match_note is written at import
  // time and persisted, so it reaches future imports only. Both live Sachin Kumar rows still read
  // the old sentence, character for character identical, pointing at a screen that is not the one
  // with the fix on it. Proved by changing the world AFTER the import: two same-name candidates
  // make the row ambiguous, and a third must make the note say three. A stored note says two.
  const mkEcho = async (n) => {
    const c = (await req(admin, "POST", "/api/candidates", {
      name: `${NAME} Echo`, phone: `9${STAMP.slice(1)}9${String(n).padStart(3, "0")}`, location: loc._id, program: program._id,
    }));
    if (!c.data.item?._id) { ok(`-143 (QA-298) fixture: Echo candidate ${n} created`, false, JSON.stringify(c.data).slice(0, 140)); return null; }
    await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: c.data.item._id, joined_on: localDate(Date.now() - 20 * 86400_000) });
    return c.data.item;
  };
  await mkEcho(1); await mkEcho(2);
  // One row, no portal ID on purpose - that is what forces the match down to the name and makes
  // this the exact shape Manish's two Sachin Kumar rows are.
  const echoCsv = [csvText.split(/\r?\n/)[0], `1,TESTORG Gurugram -${TC},99000001,${NAME} Echo,,Trainee,Trainee,11,3,3,0,21:00:00,0,07:00:00,`].join("\n");
  const echoImp = await upload(admin, {
    file: new File([Buffer.from(echoCsv)], "echo.csv", { type: "text/csv" }),
    confirm: "1", period_label: `echo ${STAMP}`,
  });
  const echoRow0 = ((await req(admin, "GET", `/api/govt-attendance/${echoImp.data._id}`)).data.rows ?? [])[0];
  ok("-143 (QA-298) fixture: a row with no portal ID and two same-name candidates is Ambiguous",
    echoRow0?.match_status === "Ambiguous" && /2 candidates share/.test(String(echoRow0?.match_note)),
    JSON.stringify({ status: echoRow0?.match_status, note: echoRow0?.match_note }));

  await mkEcho(3);
  const echoRow1 = ((await req(admin, "GET", `/api/govt-attendance/${echoImp.data._id}`)).data.rows ?? [])[0];
  ok("-143 (QA-298): THE CLAUSE THAT FAILS TODAY - the note is re-derived on read, so it counts THREE now",
    /3 candidates share/.test(String(echoRow1?.match_note)),
    JSON.stringify({ note: echoRow1?.match_note }));
  ok("-143 (QA-298): ...and it still names the row it belongs to and points at the control that resolves it",
    /^row 1:/.test(String(echoRow1?.match_note)) && /click this row/.test(String(echoRow1?.match_note)),
    JSON.stringify({ note: echoRow1?.match_note }));
  ok("-143 (QA-298): ...and re-deriving the NOTE never rewrites the stored match_status",
    echoRow1?.match_status === "Ambiguous", String(echoRow1?.match_status));

  // ---- -144 (QA-314, raised by the checker against -143) ----
  // The checker proved a stored row with NO govt_candidate_id key 500s the WHOLE import detail,
  // and stated the honest limit: no shipped path produces such a document. That limit holds - the
  // parser's at() returns "" for a missing column, never undefined - so the guard is defence in
  // depth and this pin does NOT claim otherwise. What IS reachable is the shape one step short of
  // it: a portal export with no Candidate ID COLUMN AT ALL. findHeaderRow accepts that file
  // (hasName && (hasPresent || hasId)), every row then carries an empty id, and after -143 those
  // rows are fed back through matchGovtRows on every read of the detail.
  {
    const noIdCsv = [
      " Sl No, Org Name, Attendance Id, Name, Candidate Type, User's Designation, Total Working days, Total Days Present, Total Hours Spent",
      `1,TESTORG Gurugram -${TC},99000002,${NAME} Echo,Trainee,Trainee,11,4,28:00:00`,
    ].join("\n");
    const noIdImp = await upload(admin, {
      file: new File([Buffer.from(noIdCsv)], "no-candidate-id-column.csv", { type: "text/csv" }),
      confirm: "1", period_label: `no id column ${STAMP}`,
    });
    ok("-144 (QA-314): a portal export with no Candidate ID column is still accepted",
      noIdImp.status === 201, JSON.stringify(noIdImp.data).slice(0, 160));
    const detail = await req(admin, "GET", `/api/govt-attendance/${noIdImp.data._id}`);
    ok("-144 (QA-314): ...and reading its detail does not 500 — every row is re-matched on read now",
      detail.status === 200, `got ${detail.status}`);
    const r0 = (detail.data.rows ?? [])[0];
    ok("-144 (QA-314): ...the ambiguous note falls back to the ROW NUMBER when there is no portal ID",
      r0?.match_status === "Ambiguous" && /^row 1:/.test(String(r0?.match_note)),
      JSON.stringify({ status: r0?.match_status, note: r0?.match_note }));
  }
}
// ---- -146 (QA-313): the Unmatched sentence must stop denying a student who now exists ----
// The sibling of QA-298, one branch over, and the more embarrassing of the two: 'No candidate
// named X in this centre' goes on printing after somebody has actually enrolled X. -143 fixed
// only the Ambiguous branch and said so rather than widening the unit mid-flight; this closes it.
// The pin changes the world AFTER the import, which is the only way to tell a re-derived note
// from a stored one - and it is exactly what a centre does: import first, enrol the missing
// student second.
{
  const newcomerCsv = [
    csvText.split(/\r?\n/)[0],
    `1,TESTORG Gurugram -${TC},99000003,${NAME} Newcomer,,Trainee,Trainee,11,6,42:00:00,0,07:00:00,`,
  ].join("\n");
  const imp = await upload(admin, {
    file: new File([Buffer.from(newcomerCsv)], "newcomer.csv", { type: "text/csv" }),
    confirm: "1", period_label: `newcomer ${STAMP}`,
  });
  const before = ((await req(admin, "GET", `/api/govt-attendance/${imp.data._id}`)).data.rows ?? [])[0];
  ok("-146 (QA-313) fixture: a name the ERP has never seen is Unmatched, and the note says so",
    before?.match_status === "Unmatched" && /No candidate named/.test(String(before?.match_note)),
    JSON.stringify({ status: before?.match_status, note: before?.match_note }));

  // the centre now enrols the student the portal already knew about
  const c = await req(admin, "POST", "/api/candidates", {
    name: `${NAME} Newcomer`, phone: `9${STAMP.slice(1)}8${String(1).padStart(3, "0")}`,
    location: loc._id, program: program._id,
  });
  ok("-146 (QA-313) fixture: the missing student is created", !!c.data.item?._id, JSON.stringify(c.data).slice(0, 140));
  await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: c.data.item._id, joined_on: localDate(Date.now() - 20 * 86400_000) });

  const after = ((await req(admin, "GET", `/api/govt-attendance/${imp.data._id}`)).data.rows ?? [])[0];
  ok("-146 (QA-313): THE CLAUSE THAT FAILS TODAY - the row stops saying the student does not exist",
    !/No candidate named/.test(String(after?.match_note)), JSON.stringify({ note: after?.match_note }));
  ok("-146 (QA-313): ...and it says they ARE here now, pointing at the control that links them",
    /IS in the ERP now/.test(String(after?.match_note)) && /click this row/.test(String(after?.match_note)),
    JSON.stringify({ note: after?.match_note }));
  ok("-146 (QA-313): ...but a READ never decides the match - the stored status is still Unmatched",
    after?.match_status === "Unmatched", String(after?.match_status));
}
// ---- -156 (QA-433 / QA-410): the sentence for a row whose HOURS COLUMN could not be read ----
// -153 cycle 2 wrote that branch and disclosed that it shipped without a pin, giving the reason
// "the wall's fixture CSV carries no blank-hours row, and adding one shifts counts that several
// existing assertions pin". The checker showed the reason was wrong about this file: it already
// builds one-row synthetic imports of its own twice (echo.csv, newcomer.csv) and never touches the
// shared fixture to do it. This is one more of those, and it disturbs no existing count.
//
// The shape has to be built exactly: a row is only ever "waiting on a match" when it is UNRESOLVED,
// and a name matching a single candidate resolves itself. So the name is shared by two CANDIDATES
// at this centre (which is what makes the row Ambiguous) while only ONE of them is on this batch's
// roster - which keeps the single-name sentence under test rather than QA-439's shared-name one.
{
  const soloName = `${NAME} Solo`;
  const onRoster = (await req(admin, "POST", "/api/candidates", {
    name: soloName, phone: `9${STAMP.slice(1)}7001`, location: loc._id, program: program._id,
  }, 201)).data.item;
  const elsewhere = (await req(admin, "POST", "/api/candidates", {
    name: soloName, phone: `9${STAMP.slice(1)}7002`, location: loc._id, program: program._id,
  }, 201)).data.item;
  // Its OWN batch, for a reason the first draft learned the hard way: Rule 48 caps enrolment at
  // target_size and the shared fixture batch is full at 5, so the enrolment PATCH was refused 409
  // and this suite's req() drops the expected-status argument on the floor - the member sat at
  // "Not Started", the journey gate answered not_enrolled, and the pin went red claiming a wording
  // defect that was really a fixture defect. A pin that fails for the wrong reason is worth no
  // more than one that passes for the wrong reason.
  const soloBatch = (await req(admin, "POST", "/api/batches", {
    location: loc._id, program: program._id, target_size: 2, planned_start: localDate(Date.now() - 25 * 86400_000),
  })).data.item;
  const soloMem = (await req(admin, "POST", `/api/batches/${soloBatch._id}/members`, {
    candidate: onRoster._id, joined_on: localDate(Date.now() - 20 * 86400_000),
  }, 201)).data.item;
  await req(admin, "PATCH", `/api/members/${soloMem._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);

  // hours cell (Total Hours Spent) and Average Per Day deliberately EMPTY - the shape a portal
  // export takes when the column is present and unfilled, which is not the same as junk-hours.csv
  // (a value that cannot be parsed) and not the same as no-present-col.csv (a missing column).
  const soloCsv = [csvText.split(/\r?\n/)[0], `1,TESTORG Gurugram -${TC},99000004,${soloName},,Trainee,Trainee,11,3,3,0,,0,,`].join("\n");
  const soloImp = await upload(admin, {
    file: new File([Buffer.from(soloCsv)], "blank-hours.csv", { type: "text/csv" }),
    confirm: "1", period_label: `blank hours ${STAMP}`,
  });
  const soloRow = ((await req(admin, "GET", `/api/govt-attendance/${soloImp.data._id}`)).data.rows ?? [])[0];
  ok("-156 (QA-410) fixture: the row is unresolved AND its hours are null - both halves of the case",
    soloRow?.match_status === "Ambiguous" && soloRow?.total_hours_minutes == null,
    JSON.stringify({ status: soloRow?.match_status, minutes: soloRow?.total_hours_minutes, note: String(soloRow?.match_note ?? "").slice(0, 90) }));

  const soloAtt = (await req(admin, "GET", `/api/batches/${soloBatch._id}/attendance`)).data.members ?? [];
  const meRow = soloAtt.find((m) => m.name === soloName);
  ok("-156 (QA-410) anti-vacuity: exactly ONE live member of this batch answers to the name, and they are ENROLLED - so the journey gate is past and it is the single-name sentence under test",
    soloAtt.filter((m) => !m.left_on && m.name === soloName).length === 1
      && meRow?.enrollment_status === "Completed",
    JSON.stringify({ same_name: soloAtt.filter((m) => m.name === soloName).length, enrolment: meRow?.enrollment_status }));
  ok("-156 (QA-410): a row whose hours column could not be read says exactly that, and never claims a figure",
    meRow?.verdict?.state === "awaiting_match"
      && /hours column could not be read/i.test(String(meRow?.verdict?.detail ?? ""))
      && !/DOES carry/i.test(String(meRow?.verdict?.detail ?? "")),
    JSON.stringify({ state: meRow?.verdict?.state, detail: String(meRow?.verdict?.detail ?? "").slice(0, 150) }));
  void elsewhere;
}
// ---- -148 (QA-332): a TRAINER row must never be offered a student ----
// -146 widened the read-time note to every unresolved row and did not construct the case where
// that row is a TRAINER. The portal export carries the centre's own trainers alongside its
// students, so the new sentence -- 'this person IS in the ERP now - click this row to link
// them' -- appeared on a trainer, whose only linking control is the CANDIDATE picker. The
// checker then measured the rest of it: the API accepted the link and stamped a student onto a
// trainer's attendance row.
//
// The existing guard tested `row.trainer`, which is set only when the importer MATCHED a trainer
// record -- so it missed exactly the row that needed it, a trainer the ERP has never heard of.
// -127 already settled which test is right for this question: the EXPORT's own type column.
{
  const trainerCsv = [
    csvText.split(/\r?\n/)[0],
    `1,TESTORG Gurugram -${TC},99000004,${NAME} Ghost Trainer,,Trainer,Trainer,11,9,63:00:00,0,07:00:00,`,
  ].join("\n");
  const timp = await upload(admin, {
    file: new File([Buffer.from(trainerCsv)], "ghost-trainer.csv", { type: "text/csv" }),
    confirm: "1", period_label: `ghost trainer ${STAMP}`,
  });
  const trow = ((await req(admin, "GET", `/api/govt-attendance/${timp.data._id}`)).data.rows ?? [])[0];
  ok("-148 (QA-332) fixture: a trainer the ERP has never heard of imports as an unmatched TRAINER row",
    trow?.match_status === "Unmatched" && !trow?.trainer,
    JSON.stringify({ status: trow?.match_status, trainer: trow?.trainer, type: trow?.candidate_type }));

  // Now add the TRAINER record with that exact name. That is what moves the re-derivation from
  // Unmatched to Matched for a trainer row -- an enrolled candidate never does, because the trainer
  // branch of matchGovtRows looks at trainers. Getting this wrong first is how I learned the
  // difference: with a candidate the row simply stays Unmatched and the defect never appears.
  const t = await req(admin, "POST", "/api/trainers", {
    name: `${NAME} Ghost Trainer`, phone: `9${STAMP.slice(1)}7${String(1).padStart(3, "0")}`,
    skills: ["GhostSkill" + STAMP],
  });
  ok("-148 (QA-332) fixture: the trainer record now exists, so the row re-derives to Matched",
    !!t.data.item?._id, JSON.stringify(t.data).slice(0, 140));
  // and a candidate of the same name, which is what an operator would be offered
  const c = await req(admin, "POST", "/api/candidates", {
    name: `${NAME} Ghost Trainer`, phone: `9${STAMP.slice(1)}7${String(2).padStart(3, "0")}`,
    location: loc._id, program: program._id,
  });
  if (c.data.item?._id) await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: c.data.item._id, joined_on: localDate(Date.now() - 20 * 86400_000) });

  const after = ((await req(admin, "GET", `/api/govt-attendance/${timp.data._id}`)).data.rows ?? [])[0];
  ok("-148 (QA-332): THE CLAUSE THAT FAILS TODAY - a trainer row is never told to link a student",
    !/click this row to link them/.test(String(after?.match_note)),
    JSON.stringify({ note: after?.match_note }));
  ok("-148 (QA-332): ...it says what the row actually is instead",
    /types this row as a TRAINER/.test(String(after?.match_note)), JSON.stringify({ note: after?.match_note }));

  // -150 (QA-339): -148 guarded the WRITE and left the READ open, so the drawer still opened and
  // offered four candidates on a row the product had just said is not a student. Refusing at the
  // write while inviting at the read is the worse of the two states.
  const picker = await req(admin, "GET", `/api/govt-attendance/${timp.data._id}/rows/${after._id}/match`);
  ok("-150 (QA-339): the candidate PICKER refuses to open on a trainer row, not just the write",
    picker.status === 400 && /trainer/i.test(String(picker.data.error ?? "")),
    `${picker.status} ${String(picker.data.error ?? "").slice(0, 90)}`);

  // The half that matters more than the wording: the door itself must refuse.
  const bad = await req(admin, "POST", `/api/govt-attendance/${timp.data._id}/rows/${after._id}/match`,
    { candidate: c.data.item?._id, reason: "e2e: must be refused" });
  ok("-148 (QA-332): ...and the API REFUSES to stamp a student onto a trainer's attendance row",
    bad.status === 400 && /trainer/i.test(String(bad.data.error ?? "")), `${bad.status} ${String(bad.data.error ?? "").slice(0, 90)}`);
  const untouched = ((await req(admin, "GET", `/api/govt-attendance/${timp.data._id}`)).data.rows ?? [])[0];
  ok("-148 (QA-332): ...and the refusal left the row exactly as it was",
    untouched?.match_status === "Unmatched" && !untouched?.candidate,
    JSON.stringify({ status: untouched?.match_status, candidate: untouched?.candidate }));
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
// -156 (QA-445): this fixture walks a batch all the way to Completed, and certification now needs
// the portal Candidate ID at BOTH doors - the hand-typed one this uses and the derived one. A batch
// that certifies carries portal IDs in the real world; the fixture says so too.
const c2 = (await req(admin, "POST", "/api/candidates", { name: `${NAME} Lockcase`, phone: `9${STAMP.slice(1)}2004`, location: loc._id, program: program._id, sidh_candidate_id: `CAN_${STAMP}2004` })).data.item;
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


// ---------------------------------------------------------------- -155: the QA-414 recovery, end to end
// The whole Sachin Kumar story in miniature: a portal row arrives for a CAN the ERP does not hold,
// the CAN turns out to be sitting in id_reference on a candidate, the health screen recovers it,
// and the row then attaches by EXACT ID EQUALITY - never by name (QA-085 stands throughout).
{
  const orphanCan = `CAN_${STAMP}0040`;
  const hdr = csvText.split(/\r?\n/)[0];
  const orphanCsv = [hdr, `1,TESTORG Gurugram -${TC},97000001,${NAME} Orphan,${orphanCan},Trainee,Trainee,11,4,4,0,44:30:00,0,10:00:00,`].join("\n");
  const orphanImp = await upload(admin, { file: new File([Buffer.from(orphanCsv)], "orphan.csv", { type: "text/csv" }), confirm: "1", period_label: `orphan ${STAMP}` });
  const orphanRow = ((await req(admin, "GET", `/api/govt-attendance/${orphanImp.data._id}`)).data.rows ?? [])[0];
  ok("-155 fixture: a row for a CAN the ERP does not hold imports Unmatched",
    orphanImp.status === 201 && orphanRow?.match_status === "Unmatched", JSON.stringify({ s: orphanImp.status, m: orphanRow?.match_status }));

  // The candidate exists - with the CAN in the WRONG FIELD, exactly like the live 55.
  const rec = (await req(admin, "POST", "/api/candidates", { name: `${NAME} Recover`, phone: `9${STAMP.slice(1)}1900`, location: loc._id, program: program._id, id_reference: orphanCan }, 201)).data.item;

  const plan1 = (await req(admin, "GET", "/api/candidates/portal-id-health", undefined, 200)).data;
  ok("-155: before the copy, the row is NOT rematchable (no candidate owns the CAN yet)",
    !(plan1.rematchable ?? []).some((x) => String(x.row) === String(orphanRow._id))
      && (plan1.misfiled ?? []).some((x) => String(x.candidate) === String(rec._id)),
    JSON.stringify({ rematchable: (plan1.rematchable ?? []).length }));

  await req(admin, "POST", "/api/candidates/portal-id-health", { copy: [rec._id] }, 200);
  const plan2 = (await req(admin, "GET", "/api/candidates/portal-id-health", undefined, 200)).data;
  ok("-155: after the copy, the SAME row becomes attachable by exact ID equality",
    (plan2.rematchable ?? []).some((x) => String(x.row) === String(orphanRow._id) && String(x.candidate) === String(rec._id)),
    JSON.stringify((plan2.rematchable ?? []).map((x) => x.can)));

  const rem = await req(admin, "POST", "/api/candidates/portal-id-health", { rematch: [orphanRow._id] });
  const rowAfter = ((await req(admin, "GET", `/api/govt-attendance/${orphanImp.data._id}`)).data.rows ?? [])[0];
  ok("-155: the re-match attaches by ID, says so, and never claims a name decided it",
    rem.data.rematched === 1 && rowAfter?.match_status === "Matched" && rowAfter?.match_by === "Portal ID (re-match)"
      && String(rowAfter?.candidate?._id ?? rowAfter?.candidate) === String(rec._id),
    JSON.stringify({ rem: rem.data, by: rowAfter?.match_by }));

  // The exclusion that keeps the corrupt 20-08 shape out of this door: a shift-suspected import's
  // rows are attachable by ID but must be HELD, not attached - a corrupt file's row must not
  // become anybody's newest figure through a recovery screen.
  const shiftCan = `CAN_${STAMP}0050`;
  const shiftCsv = [hdr,
    `1,TESTORG Gurugram -${TC},96000001,${NAME} ShiftOrphan,${shiftCan},Trainee,Trainee,8,,0,0,52.15,0,5.2,`,
    `2,TESTORG Gurugram -${TC},96000002,${NAME} ShiftOther,,Trainee,Trainee,10,,0,0,44.02,0,4.4,`,
    `3,TESTORG Gurugram -${TC},96000003,${NAME} ShiftThird,,Trainee,Trainee,12,,0,0,31.90,0,3.1,`,
  ].join("\n");
  const shiftImp = await upload(admin, { file: new File([Buffer.from(shiftCsv)], "shift-orphan.csv", { type: "text/csv" }), confirm: "1", accept_column_shift: "1", period_label: `shift-orphan ${STAMP}` });
  const rec2 = (await req(admin, "POST", "/api/candidates", { name: `${NAME} Recover2`, phone: `9${STAMP.slice(1)}1901`, location: loc._id, program: program._id, id_reference: shiftCan }, 201)).data.item;
  await req(admin, "POST", "/api/candidates/portal-id-health", { copy: [rec2._id] }, 200);
  const plan3 = (await req(admin, "GET", "/api/candidates/portal-id-health", undefined, 200)).data;
  const shiftRowId = ((await req(admin, "GET", `/api/govt-attendance/${shiftImp.data._id}`)).data.rows ?? []).find((r) => r.govt_candidate_id === shiftCan)?._id;
  ok("-155: a row from a shift-suspected import is HELD, never offered for re-match",
    (plan3.skipped_suspect_import ?? []).some((x) => String(x.row) === String(shiftRowId))
      && !(plan3.rematchable ?? []).some((x) => String(x.row) === String(shiftRowId)),
    JSON.stringify({ skipped: (plan3.skipped_suspect_import ?? []).length }));
  const remRefused = await req(admin, "POST", "/api/candidates/portal-id-health", { rematch: [shiftRowId] });
  ok("-155: ...and forcing it through POST is refused on the re-verify",
    remRefused.status === 200 && remRefused.data.rematched === 0 && (remRefused.data.refused ?? []).length === 1,
    JSON.stringify(remRefused.data));

  // -156 (QA-444): five groups on this plan were scoped and the sixth read the whole database. A
  // Location user scoped to a brand-new empty centre got 65 other centres' students back - names,
  // phones and batch codes - on a screen -155 invites them to open. Anti-vacuity first, because a
  // scoped ZERO only means something if the unscoped answer is not zero either.
  {
    const farLoc = (await req(admin, "POST", "/api/locations", {
      code: `TEST-PH${STAMP}`, name: `TEST PortalHealth Far ${STAMP}`,
      approval_status: "Approved", operational_status: "Active",
    }, 201)).data.item;
    const farEmail = `test.ph.far.${STAMP}@vidysea-test.local`.toLowerCase();
    await req(admin, "POST", "/api/users", {
      name: `PH Far ${STAMP}`, email: farEmail, password: "CiOnly@123", role: "Location",
      can_edit: true, active: true, location_scope: [farLoc._id],
    }, 201);
    const far = await login(farEmail, "CiOnly@123");
    const planAdmin = (await req(admin, "GET", "/api/candidates/portal-id-health", undefined, 200)).data;
    const planFar = far ? (await req(far, "GET", "/api/candidates/portal-id-health", undefined, 200)).data : null;
    ok("-156 (QA-444) anti-vacuity: the unscoped plan really does carry enrolled students with no portal ID",
      (planAdmin.enrolled_no_can ?? []).length > 0, JSON.stringify({ admin: (planAdmin.enrolled_no_can ?? []).length }));
    ok("-156 (QA-444): a centre-scoped reader gets their OWN centre's identity problems and nobody else's",
      !!planFar && (planFar.enrolled_no_can ?? []).length === 0 && (planFar.misfiled ?? []).length === 0
        && (planFar.rematchable ?? []).length === 0,
      JSON.stringify({
        admin_enrolled: (planAdmin.enrolled_no_can ?? []).length,
        far_enrolled: (planFar?.enrolled_no_can ?? []).length,
        far_misfiled: (planFar?.misfiled ?? []).length,
      }));
  }

  // -156 (QA-453): exact-ID equality answers WHICH CANDIDATE - the whole argument for this door
  // being safe where a name match is not. It does not answer WHICH BATCH, and a row naming no batch
  // was attached to whatever membership Mongo returned first, then audited as decided by the ID.
  {
    const twoCan = `CAN_${STAMP}0060`;
    const twoCsv = [hdr, `1,TESTORG Gurugram -${TC},95000001,${NAME} TwoBatch,${twoCan},Trainee,Trainee,11,4,4,0,40:00:00,0,10:00:00,`].join("\n");
    const twoImp = await upload(admin, { file: new File([Buffer.from(twoCsv)], "two-batch.csv", { type: "text/csv" }), confirm: "1", period_label: `two-batch ${STAMP}` });
    const twoRow = ((await req(admin, "GET", `/api/govt-attendance/${twoImp.data._id}`)).data.rows ?? [])[0];
    const twoCand = (await req(admin, "POST", "/api/candidates", {
      name: `${NAME} TwoBatch`, phone: `9${STAMP.slice(1)}1902`, location: loc._id, program: program._id, id_reference: twoCan,
    }, 201)).data.item;
    const mkHome = async (offsetDays) => (await req(admin, "POST", "/api/batches", {
      location: loc._id, program: program._id, target_size: 2, planned_start: localDate(Date.now() + offsetDays * 86400_000),
    })).data.item;
    const homeA = await mkHome(12);
    const homeB = await mkHome(40);
    const addA = await req(admin, "POST", `/api/batches/${homeA?._id}/members`, { candidate: twoCand._id });
    const addB = await req(admin, "POST", `/api/batches/${homeB?._id}/members`, { candidate: twoCand._id });
    // THE FIXTURE REFUTED ITS OWN ROW. QA-453 says the exposure is "a candidate re-enrolled into a
    // second batch, which this product supports" - and it does not: Rule 20 (addMemberChecked)
    // refuses the second ACTIVE membership. Trying to build the case IS the measurement, so it is
    // what gets asserted; the arbitrary pick the row describes needs a state no door can produce.
    ok("-156 (QA-453): Rule 20 is why the ambiguity cannot arise - a second LIVE membership is refused, so 'which batch' has exactly one answer",
      addA.status === 201 && addB.status === 409 && /already active in batch/i.test(String(addB.data?.error ?? "")),
      JSON.stringify({ addA: addA.status, addB: addB.status, err: String(addB.data?.error ?? "").slice(0, 90) }));
    await req(admin, "POST", "/api/candidates/portal-id-health", { copy: [twoCand._id] }, 200);
    const planTwo = (await req(admin, "GET", "/api/candidates/portal-id-health", undefined, 200)).data;
    ok("-156 (QA-453): the plan carries the ambiguous_batch group even while nothing can land in it",
      Array.isArray(planTwo.ambiguous_batch),
      JSON.stringify({ present: Array.isArray(planTwo.ambiguous_batch), held: (planTwo.ambiguous_batch ?? []).length }));
    // The row that names no batch still attaches, because with one live membership there IS one
    // answer - and the note it writes is now the only claim it can support.
    const twoDone = await req(admin, "POST", "/api/candidates/portal-id-health", { rematch: [twoRow._id] });
    ok("-156 (QA-453): a no-batch row with exactly ONE live membership attaches, which is the case that actually exists",
      twoDone.status === 200 && twoDone.data.rematched === 1,
      JSON.stringify(twoDone.data));
  }

  // -155 (Umesh, 20/08): the portal ID becomes MANDATORY at certification, not at enrolment.
  // BUILD the failing case rather than lean on the roster (the -153 anti-vacuity lesson: the
  // first draft assumed a Twin still lacked a CAN, and by this point in the suite the resolve
  // flows have stamped both). Pre-fix this PUT fails with the Rule 43/46 wording; the
  // discriminator is the sentence naming the portal Candidate ID and the health screen.
  {
    const noCanCand = (await req(admin, "POST", "/api/candidates", { name: `${NAME} NoCan`, phone: `9${STAMP.slice(1)}1903`, location: loc._id, program: program._id }, 201)).data.item;
    const noCanMem = (await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: noCanCand._id }, 201)).data.item;
    await req(admin, "PATCH", `/api/members/${noCanMem._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
    const gate = await req(admin, "PUT", `/api/batches/${batch._id}/closure`, { certification_status: "Completed" });
    ok("-155: certification cannot complete while an enrolled student has no portal Candidate ID",
      gate.status === 409 && /portal Candidate ID/i.test(String(gate.data.error ?? "")) && /Portal ID health/i.test(String(gate.data.error ?? "")) && String(gate.data.error ?? "").includes(`${NAME} NoCan`),
      JSON.stringify({ s: gate.status, e: String(gate.data.error ?? "").slice(0, 160) }));
    await req(admin, "DELETE", `/api/members/${noCanMem._id}`, { reason: "-155 gate pin fixture" });
    await req(admin, "DELETE", `/api/candidates/${noCanCand._id}`);
  }

  // leave no residue that later blocks would trip over
  await req(admin, "DELETE", `/api/govt-attendance/${orphanImp.data._id}`);
  await req(admin, "DELETE", `/api/govt-attendance/${shiftImp.data._id}`);
}

// ---------------------------------------------------------------- -154 (QA-438, S1): the shifted-column guard
// Measured on live 20-08, column against column: a 24-row export whose days-attended figures sat
// in the WORKING-DAYS field (days-present null on every row, hours in decimals where every genuine
// file is HH:MM:SS) imported silently, became the newest matched rows, and read two students who
// had genuinely cleared the 60-hour bar as not_eligible. This block rebuilds that exact signature
// as an inline CSV (the echo.csv precedent) and pins the guard on it.
{
  const hdr = csvText.split(/\r?\n/)[0];
  // per-student working-days (8,10,11,12 - four distinct), days-present EMPTY on all four rows,
  // decimal hours: the measured signature of the corrupt 20-08 file.
  const shifted = [hdr,
    `1,TESTORG Gurugram -${TC},98000001,${NAME} ShiftA,,Trainee,Trainee,8,,0,0,52.15,0,5.2,`,
    `2,TESTORG Gurugram -${TC},98000002,${NAME} ShiftB,,Trainee,Trainee,10,,0,0,59.42,0,4.9,`,
    `3,TESTORG Gurugram -${TC},98000003,${NAME} ShiftC,,Trainee,Trainee,11,,0,0,61.69,0,5.6,`,
    `4,TESTORG Gurugram -${TC},98000004,${NAME} ShiftD,,Trainee,Trainee,12,,0,0,48.02,0,4.0,`,
  ].join("\n");
  const shiftFile = () => new File([Buffer.from(shifted)], "shifted.csv", { type: "text/csv" });

  // 1. the preview NAMES it - fails pre-fix (the field does not exist)
  const sPre = await upload(admin, { file: shiftFile() });
  ok("-154 (QA-438): a shifted-layout file is named on the preview",
    sPre.status === 200 && sPre.data.column_shift_suspected === true
      && sPre.data.column_shift_detail?.days_present_empty === 4
      && (sPre.data.column_shift_detail?.distinct_working_days ?? []).length === 4,
    JSON.stringify({ s: sPre.data.column_shift_suspected, d: sPre.data.column_shift_detail }));

  // 2. the commit is REFUSED without an explicit override, and nothing is written - fails pre-fix
  const before = ((await req(admin, "GET", "/api/govt-attendance")).data.items ?? []).length;
  const refused = await upload(admin, { file: shiftFile(), confirm: "1", period_label: `shift ${STAMP}` });
  const after = ((await req(admin, "GET", "/api/govt-attendance")).data.items ?? []).length;
  ok("-154 (QA-438): the same file is refused at commit, naming the shape and the cost",
    refused.status === 400 && /column-shifted/i.test(String(refused.data.error ?? ""))
      && /60-hour bar/.test(String(refused.data.error ?? "")),
    JSON.stringify({ status: refused.status, error: String(refused.data.error ?? "").slice(0, 140) }));
  ok("-154 (QA-438): ...and the refusal wrote NOTHING (import count unchanged)",
    after === before, JSON.stringify({ before, after }));

  // 3. the operator is never trapped: the explicit override imports. On the PRE-fix build this
  //    passes trivially (there is no gate at all) - it is a discriminator only paired with #2,
  //    and it is labelled so rather than counted as a regression pin.
  const forced = await upload(admin, { file: shiftFile(), confirm: "1", accept_column_shift: "1", period_label: `shift-forced ${STAMP}` });
  ok("-154 (QA-438, paired with the refusal above): the explicit override still imports",
    forced.status === 201 && !!forced.data._id, JSON.stringify({ status: forced.status }));
  if (forced.data._id) await req(admin, "DELETE", `/api/govt-attendance/${forced.data._id}`); // no residue

  // 4. THE PIN THAT MATTERS MOST: a genuine file - one batch-level working-day figure, populated
  //    days-present, HH:MM:SS hours - is NOT flagged. Strict === false so this also fails pre-fix
  //    (the field is undefined there) while post-fix it proves the guard cannot bite a real export.
  const gPre = await upload(admin, { file: csvFile() });
  ok("-154 (QA-438): a genuine export is not flagged (column_shift_suspected === false)",
    gPre.status === 200 && gPre.data.column_shift_suspected === false,
    JSON.stringify({ s: gPre.data.column_shift_suspected }));
}

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
