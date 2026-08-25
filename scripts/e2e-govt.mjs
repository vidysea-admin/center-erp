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
  // -248 (QA-1217): committing now HOLDS when rows that CARRY a portal Candidate ID were placed by
  // NAME instead. The fixture's Charlie is exactly such a row BY DESIGN (the roster gives him no
  // portal ID, the file gives him CAN_...0003), so every commit in this suite would start returning
  // 400 — and every one of those tests was written to assert something else entirely. The helper
  // consents on their behalf so they keep testing what they were written for.
  //
  // This does NOT weaken the gate's coverage, and the reason is narrower than the one cycle 1 gave.
  // It is gated on `confirm === "1"`, so it NEVER touches a preview - every `name_match_suspected`
  // assertion below sees ungated truth. On the commit path exactly ONE test opts out, by passing
  // accept_name_match "0", and it proves the refusal still fires and still writes nothing.
  //
  // Cycle 1's comment claimed THREE such tests. There is one (`grep -c 'accept_name_match: "0"'`).
  // The checker counted; I had not. A default that silences a guard everywhere is only safe if the
  // count of tests that turn it back on is a measured number, not a remembered one.
  if (fields.confirm === "1" && fields.accept_name_match === undefined) {
    fields = { ...fields, accept_name_match: "1" };
  }
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
// -248 (QA-1217): the OTHER shape SIDH serves under this feature — an "Attendance Report" stating the
// QP entitlement and the AEBAS attendance side by side. Same identifiers, same stamping, so it can be
// filed against the same roster as the AEBAS fixture and the two shapes compared directly.
const sidhText = readFileSync(path.join(HERE, "fixtures", "govt-attendance-sidh-report.csv"), "utf8")
  .replaceAll("GOVT Test", NAME).replaceAll("CAN_TEST", `CAN_${STAMP}`);
const sidhFile = (n = "sidh-report.csv") => new File([Buffer.from(sidhText)], n, { type: "text/csv" });

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
  // A-12 CHANGED THIS ASSERTION'S EXPECTED VALUE ON PURPOSE, and says so rather than quietly
  // widening it: `attendance_days` used to be 0 both for "never logged" and for "logged, zero days",
  // and the whole point of A-12 is that those are different claims. A batch with nothing on record
  // now reads `null`. The MEANING under test is unchanged - "nothing on record reads as nothing" -
  // and `portal_as_of` beside it is still null, as `attendance_last` always was in this same case.
  ok("QA-159 / A-12: a batch with nothing on record reads null / null (the UI says 'none yet')", !untouched || (untouched.attendance_days === null && untouched.portal_as_of === null), JSON.stringify(untouched && { d: untouched.attendance_days, p: untouched.portal_as_of }));
}

// ---- A-11 + A-12 (24-Aug issues sheet, Shiv + Manish clips; both measured on LIVE -244) ----
// A-11: the batches list printed "N students" from a count of attendance ROWS, so the figure grew
// with the number of IMPORTS instead of the number of people. Live: CHI-ITI-RPLAVP-BSRT-01 had 3
// imports and said "129 students" against 45 seats; AVP-GURU-RPLAVP-DST-02 said 130; the only row
// that read correctly had exactly one import. These pins were run against the pre-fix build first
// and BOTH fail there (see the manifest) - that is what makes them worth keeping.
{
  const before = ((await req(admin, "GET", "/api/batches?limit=2000")).data.items ?? []).find((b) => String(b._id) === String(batch._id));
  // A THIRD confirmed import of the SAME people onto the SAME batch. Nobody new arrives.
  // ITS OWN FILE NAME, and the reason is a defect this pin caused in cycle 1 (QA-1098). Written as
  // `csvFile()` it uploaded `govt-attendance-sample.csv` onto the suite-wide batch — which is exactly
  // the item the `-108` assertion 400 lines below asserts CANNOT exist
  // (`file_name === "govt-attendance-sample.csv" && batch === batch._id`). A confirmed import here
  // therefore turned a pre-existing assertion red, and the cycle-1 manifest then explained that
  // redness away as somebody else's. Same bytes, same people, same batch - only the name differs, so
  // what this pin measures is unchanged and it can no longer collide with shared suite state.
  await upload(admin, { file: new File([Buffer.from(csvText)], "a11-reimport.csv", { type: "text/csv" }), batch: batch._id, confirm: "1", period_label: `A-11 re-import ${STAMP}` });
  const after = ((await req(admin, "GET", "/api/batches?limit=2000")).data.items ?? []).find((b) => String(b._id) === String(batch._id));

  ok("A-11: the list carries a STUDENT count as its own number, not the row count wearing that label",
    typeof after?.portal_students === "number",
    JSON.stringify({ portal_students: after?.portal_students, portal_rows: after?.portal_rows }));

  ok("A-11: re-importing the same file adds ROWS but NOT students - nobody new arrived",
    typeof after?.portal_students === "number" && typeof before?.portal_students === "number"
      && after.portal_students === before.portal_students && after.portal_rows > before.portal_rows,
    JSON.stringify({ students_before: before?.portal_students, students_after: after?.portal_students,
      rows_before: before?.portal_rows, rows_after: after?.portal_rows }));

  // THIS PIN FAILED OPEN IN ITS FIRST DRAFT AND THE DRAFT IS WHY IT IS WRITTEN THIS WAY.
  // Written as `(b.portal_students ?? 0) <= b.target_size` it PASSED against the pre-fix build -
  // because the field did not exist there, `?? 0` made every batch read zero students, and zero is
  // under every target. A pin that cannot fail on the broken code it was written for is not a pin;
  // this repo has paid for that lesson under QA-219 and QA-1010 already. So the EXISTENCE of the
  // number is asserted first, on every batch that has portal data at all, and only then the bound.
  const all = ((await req(admin, "GET", "/api/batches?limit=2000")).data.items ?? []);
  const missing = all.filter((b) => b.portal_as_of && typeof b.portal_students !== "number");
  const over = all.filter((b) => b.target_size && typeof b.portal_students === "number" && b.portal_students > b.target_size);
  ok("A-11: every batch with portal data reports a real student COUNT, and no batch reports more students than it has seats",
    all.length > 0 && missing.length === 0 && over.length === 0,
    JSON.stringify({ batches: all.length, missing_the_field: missing.map((b) => b.code),
      over_target: over.map((b) => ({ code: b.code, students: b.portal_students, target: b.target_size })) }));

  // ---- A-04 + A-05 (24-Aug issues sheet): the buckets must account for EVERY member ----
  // The report filed these as two rows. They are one defect, and it is not the missing portal ID it
  // reasoned from: `verdict_counts` filters `!left_on`, so it partitions the ACTIVE roster, while
  // the tab chip on the same screen counts the WHOLE roster. On live -244,
  // BHA-ITI-RPLHSL-SPIT-01 printed "23 qualified - 17 with no portal hours imported - 5 not
  // eligible" = 45 under a chip reading "All 46". Exactly one member had left. (That batch also has
  // exactly one candidate with no portal ID - two unrelated 1s, which is what made the wrong guess
  // look right.) The payload now carries roster_count and left_count so every surface can state the
  // whole roster without widening the buckets, which the -109 partition invariant forbids.
  //
  // THIS BLOCK BUILDS ITS OWN BATCH, and the reason is a defect this same unit caused twice.
  // Written against the suite-wide `batch` it DROPPED a member from shared state, and seven later
  // assertions in this file depend on nobody having been dropped from it ("with nobody dropped,
  // billable == passed", the trainer-edit roster check, the per-active-member attendance fan-out).
  // A pin that mutates shared fixtures is not measuring the product, it is breaking the suite -
  // QA-1098 was exactly this, one block earlier in the same file.
  {
    const aStart = localDate(Date.now() - 2 * 86400_000);
    const aBatch = (await req(admin, "POST", "/api/batches",
      { location: loc._id, program: program._id, target_size: 3, planned_start: aStart })).data.item;
    ok("A-04 fixture: a batch of this block's own", !!aBatch?._id, aBatch?.code);
    const aMems = [];
    for (const n of [1, 2, 3]) {
      const c = (await req(admin, "POST", "/api/candidates",
        { name: `${NAME} Roster${n}`, phone: `9${STAMP.slice(1)}700${n}`, location: loc._id, program: program._id }, 201)).data.item;
      aMems.push((await req(admin, "POST", `/api/batches/${aBatch._id}/members`, { candidate: c._id }, 201)).data.item);
    }

    const att0 = (await req(admin, "GET", `/api/batches/${aBatch._id}/attendance`)).data;
    ok("A-04/A-05: the attendance payload states the WHOLE roster, not only the part it bucketed",
      typeof att0.roster_count === "number" && typeof att0.left_count === "number",
      JSON.stringify({ roster_count: att0.roster_count, left_count: att0.left_count }));

    const sum0 = Object.values(att0.verdict_counts ?? {}).reduce((a, b) => a + b, 0);
    ok("A-04: buckets + members who left account for every member on the roster (nobody falls in no bucket)",
      att0.roster_count === 3 && sum0 + (att0.left_count ?? 0) === att0.roster_count,
      JSON.stringify({ buckets: sum0, left: att0.left_count, roster: att0.roster_count }));

    // Now make somebody LEAVE - the exact shape that broke on live - on this block's OWN batch.
    await req(admin, "POST", `/api/members/${aMems[0]._id}/drop`,
      { left_on: localDate(Date.now()), drop_reason: `A-04 fixture ${STAMP}` }, 200);

    const att1 = (await req(admin, "GET", `/api/batches/${aBatch._id}/attendance`)).data;
    const sum1 = Object.values(att1.verdict_counts ?? {}).reduce((a, b) => a + b, 0);
    ok("A-04/A-05: after a member LEAVES, the roster is unchanged, left_count moves, and the sum still accounts for everyone",
      att1.roster_count === att0.roster_count
        && (att1.left_count ?? -1) === (att0.left_count ?? 0) + 1
        && sum1 + (att1.left_count ?? 0) === att1.roster_count,
      JSON.stringify({ roster_before: att0.roster_count, roster_after: att1.roster_count,
        left_before: att0.left_count, left_after: att1.left_count, buckets_after: sum1 }));

    // A REGRESSION GUARD, not a defect pin - it passes before the fix too, and its job is to catch
    // the fix over-reaching by quietly pulling departed members back INTO the buckets.
    ok("A-05 guard: the departed member is OUT of the buckets - that is what the header and the bulk button count",
      sum1 === sum0 - 1,
      JSON.stringify({ buckets_before: sum0, buckets_after: sum1 }));
  }

  // A-12: never-logged and logged-zero must be distinguishable on the payload the list reads.
  ok("A-12: a batch WITH day-wise logs still reports a real number, so null means absence and nothing else",
    after?.attendance_days === 1,
    JSON.stringify({ attendance_days: after?.attendance_days, attendance_last: after?.attendance_last }));
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

// ---- A-09 (24-Aug issues sheet): a NOT ELIGIBLE candidate cannot be Passed without a reason ----
// Screen-read, nobody raised it aloud. Cards carrying the red "Not eligible" pill - students who did
// not make the attendance bar - kept a fully live Pass button with no confirmation and nothing
// recorded. A Pass is what unlocks a certificate, so that was the route by which somebody who did
// not do the hours ends up certified with no trace that anyone decided it.
// Umesh, asked directly on 2026-08-25 who may override: "anyone who can mark". So there is NO role
// gate, and the whole weight falls on the record - which is why the reason is demanded by the
// server rather than by the screen.
//
// OWN BATCH, OWN CANDIDATES, OWN FILE NAME. This block marks results and drops nobody into shared
// state; QA-1098 and the qa-246 shared-batch drop were both this mistake and both cost a wall run.
{
  const nlA = String.fromCharCode(10);
  // A batch whose course is OVER while it is still markable - the only shape in which "not eligible"
  // is a verdict at all. courseIsFinished() turns true once the portal's own working days reach the
  // programme duration (15), so the file below reports 20 while the batch stays Active.
  const eBatch = (await req(admin, "POST", "/api/batches",
    { location: loc._id, program: program._id, target_size: 3, planned_start: localDate(Date.now() - 20 * 86400_000) })).data.item;
  const eCands = [];
  for (const n of [1, 2]) {
    const c = (await req(admin, "POST", "/api/candidates",
      { name: `${NAME} Elig${n}`, phone: `9${STAMP.slice(1)}80${n}0`, location: loc._id, program: program._id,
        sidh_candidate_id: `CAN_${STAMP}88${n}` }, 201)).data.item;
    const m = (await req(admin, "POST", `/api/batches/${eBatch._id}/members`, { candidate: c._id }, 201)).data.item;
    // ENROLLED, and that is not decoration. The -109 journey gate answers BEFORE the hours question:
    // a member who has not finished enrolling gets "not enrolled yet" as their verdict, never
    // "not eligible". The first draft of this block skipped these three steps and the fixture pin
    // caught it - state came back `not_enrolled` and the whole point of the block would have been
    // untested while looking green. Rule 24 derives Completed from the three steps.
    await req(admin, "PATCH", `/api/members/${m._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
    eCands.push({ c, m });
  }

  // Alpha's row spans three lines in the fixture (a quoted multi-line Details cell), so it is lifted
  // whole and renamed - the same shape the -88 block uses.
  const lines = csvText.split(nlA);
  const at = lines.findIndex((l) => l.includes(`${NAME} Alpha`));
  const eCsv = [lines[0], lines[at], lines[at + 1], lines[at + 2]].join(nlA)
    .replace(`${NAME} Alpha`, `${NAME} Elig1`)
    .replace(`CAN_${STAMP}0001`, `CAN_${STAMP}881`)
    .replace(",11,1,1,0,", ",20,1,1,0,");   // 20 working days > the 15-day programme => course over
  await upload(admin, { file: new File([Buffer.from(eCsv)], "a09-eligibility.csv", { type: "text/csv" }),
    batch: eBatch._id, confirm: "1", period_label: `A-09 ${STAMP}` });

  const att = (await req(admin, "GET", `/api/batches/${eBatch._id}/attendance`)).data;
  const row1 = (att.members ?? []).find((m) => m.name === `${NAME} Elig1`);
  ok("A-09 fixture: the course reads FINISHED (portal working days passed the programme duration), which is the only state in which 'not eligible' is a verdict",
    att.course_finished === true, JSON.stringify({ course_finished: att.course_finished, portal_working_days: att.portal_working_days }));
  ok("A-09 fixture: and a student below the bar is therefore NOT ELIGIBLE",
    row1?.verdict?.state === "not_eligible",
    JSON.stringify({ name: row1?.name, hours: row1?.attended_hours, bar: att.required_hours, state: row1?.verdict?.state }));

  const mem1 = eCands[0].m._id, mem2 = eCands[1].m._id;

  // THE DEFECT: this used to be a plain 200.
  const noReason = await req(admin, "PUT", `/api/batches/${eBatch._id}/results`,
    { rows: [{ member: mem1, result: "Pass" }] });
  const after1 = ((await req(admin, "GET", `/api/batches/${eBatch._id}/results`)).data.items ?? [])
    .find((i) => String(i.member) === String(mem1));
  ok("A-09: passing a NOT ELIGIBLE candidate with no reason is REFUSED, and the refusal names them and why",
    noReason.status >= 400 || (noReason.data?.errors ?? []).length > 0,
    JSON.stringify({ s: noReason.status, e: JSON.stringify(noReason.data).slice(0, 220) }));
  ok("A-09: …and NOTHING was written - a refused override leaves no result behind",
    !after1?.result || after1.result.result !== "Pass",
    JSON.stringify({ result: after1?.result?.result ?? null }));

  // The override itself: allowed for anyone who can mark, but recorded.
  const withReason = await req(admin, "PUT", `/api/batches/${eBatch._id}/results`,
    { rows: [{ member: mem1, result: "Pass", eligibility_override_reason: "Portal hours arrived late; centre has the signed register." }] }, 200);
  const after2 = ((await req(admin, "GET", `/api/batches/${eBatch._id}/results`)).data.items ?? [])
    .find((i) => String(i.member) === String(mem1));
  ok("A-09: with a reason the Pass goes through - the override is allowed, not blocked",
    withReason.status === 200 && after2?.result?.result === "Pass",
    JSON.stringify({ s: withReason.status, result: after2?.result?.result }));
  ok("A-09: and the reason, WHO overrode and WHEN are stored on the row - which is the whole point",
    !!after2?.result?.eligibility_override_reason && !!after2?.result?.eligibility_override_by && !!after2?.result?.eligibility_override_at,
    JSON.stringify({ reason: after2?.result?.eligibility_override_reason,
      by: !!after2?.result?.eligibility_override_by, at: after2?.result?.eligibility_override_at }));

  const aud = ((await req(admin, "GET", `/api/audit/CandidateResult/${after2.result._id}`)).data.items ?? []);
  ok("A-09: …and it is on the audit trail in words, not only on the row",
    aud.some((a) => a.field === "eligibility_override" && /Not eligible/i.test(String(a.new_value ?? ""))),
    JSON.stringify(aud.map((a) => a.field)));

  // Editing that row again must NOT re-demand the reason, or every later score edit would.
  const edit = await req(admin, "PUT", `/api/batches/${eBatch._id}/results`,
    { rows: [{ member: mem1, result: "Pass", score: 71 }] }, 200);
  ok("A-09: a row ALREADY passed under an override is not re-gated - a later score edit does not ask again",
    edit.status === 200, JSON.stringify({ s: edit.status }));

  // Fail and Absent are the ordinary outcome for a not-eligible student and need no ceremony.
  const fail = await req(admin, "PUT", `/api/batches/${eBatch._id}/results`,
    { rows: [{ member: mem2, result: "Fail", failure_reason: "Below cut-off" }] }, 200);
  ok("A-09: marking a not-eligible candidate FAIL needs no reason - only a Pass is an override",
    fail.status === 200, JSON.stringify({ s: fail.status }));
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
    // -157 (QA-464): STATED, because the checker measured it and it is true - this line asserts that
    // the key EXISTS on the payload, and a hardcoded `ambiguous_batch: []` would satisfy it. The
    // branch's own condition needs two live memberships, which Rule 20 forbids, so nothing in this
    // suite can run it. -144 (the precedent this unit cites) reached one step short of ITS
    // unreachable state and pinned a shape that runs the guarded path; there is no such step here,
    // because the step short of "two live memberships" is one, and one is the ordinary case pinned
    // on the next line. So this is a presence check and says so, rather than borrowing -144's credit.
    ok("-156 (QA-453): the plan carries the ambiguous_batch group even while nothing can land in it (presence only - see the note above)",
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

// ---------------------------------------------------------------- -248 (QA-1217): ID over name
// Umesh, 25/08, on the Chitrakoot export: "candidate id ke basis par wo karna chahiye, otherwise
// issue aata rahega". Two defects under one ask, plus the shape the ask arrived in.
{
  const impCount = async () => ((await req(admin, "GET", "/api/govt-attendance")).data.items ?? []).length;

  // 1. THE SHAPE. Pre-fix this file's "Total Days Attended" was claimed by total_working_days (the
  //    bare "total days" alias), days-present came back null on every row, and that null-everywhere
  //    column IS the column-shift signature - so a perfectly good file was refused with a diagnosis
  //    ("looks column-shifted") that was both wrong and unactionable. Strict === false / === 18.
  const sPre = await upload(admin, { file: sidhFile(), batch: batch._id });
  const sAlpha = (sPre.data.preview ?? []).find((r) => r.name === `${NAME} Alpha`);
  ok("-248 (QA-1217): the SIDH 'Attendance Report' shape parses - days-present read, not null",
    sPre.status === 200 && !(sPre.data.missing_columns ?? []).includes("Total Days Present")
      && sAlpha?.total_days_present === 1,
    JSON.stringify({ missing: sPre.data.missing_columns, alpha: sAlpha?.total_days_present }));
  ok("-248 (QA-1217): ...and 'Total Training Days (QP)' is the denominator, not the attended count",
    sAlpha?.total_working_days === 18, JSON.stringify({ wd: sAlpha?.total_working_days }));
  ok("-248 (QA-1217): ...so it is NOT misdiagnosed as column-shifted (it was, on all 45 live rows)",
    sPre.data.column_shift_suspected === false, JSON.stringify({ s: sPre.data.column_shift_suspected }));

  // 2. THE GATE NAMES IT.
  //
  //    NOT reusing the fixture's Charlie, and the reason is worth writing down: Charlie starts with
  //    no portal ID, but the AEBAS imports earlier in THIS suite already stamped CAN_...0003 onto
  //    him — that is the -108 write-back doing exactly its job. So by the time this block runs he
  //    matches by Portal ID and the gate correctly does not fire. A test that depended on that
  //    ordering measured the suite, not the product; it failed here first as `s:false` and the
  //    honest fix is a candidate this block owns.
  const gateCand = (await req(admin, "POST", "/api/candidates", {
    name: `${NAME} Gatecheck`, phone: `9${STAMP.slice(1)}7001`, location: loc._id, program: program._id,
  })).data.item;
  // joined_on is TODAY, not back-dated: this batch went Active earlier in this suite, which stamps
  // actual_start = today, and addMemberChecked refuses a join before a batch began (the QA-892/907
  // predicate). The original roster could back-date because it was enrolled BEFORE the transition.
  // Getting this wrong returns 400 silently, the candidate never reaches the roster, and the row
  // comes back Unmatched - which looks identical to the gate being broken.
  const gateMem = await req(admin, "POST", `/api/batches/${batch._id}/members`, {
    candidate: gateCand?._id, joined_on: localDate(),
  });
  // The ENROLMENT is asserted, not just the candidate. A candidate who is not on the roster is
  // invisible to the matcher's index, so his row comes back Unmatched and the gate correctly stays
  // quiet - which reads exactly like "the gate is broken" and is how the first version of this test
  // misread itself.
  ok("-248 (QA-1217): a candidate with NO portal ID is ON THE ROSTER for the gate to bite on",
    !!gateCand?._id && !gateCand?.sidh_candidate_id && !!gateMem.data?.item?._id,
    JSON.stringify({ cand: !!gateCand?._id, can: gateCand?.sidh_candidate_id, memberStatus: gateMem.status, member: !!gateMem.data?.item?._id, err: String(gateMem.data?.error ?? "").slice(0, 160) }));

  //    Alpha and Bravo hold their IDs and match on them; only Gatecheck is a name guess.
  // 6301/6302 deliberately: 7777 and 9999 are already minted elsewhere in this suite (the backfill
  // fixture holds CAN_<STAMP>7777), and a colliding id fails the stamp on the UNIQUE partial index
  // with 'That sidh candidate id is already in use' - a 409 that reads exactly like the gate being
  // broken. Measured, not guessed: it cost a full wall run to find.
  const gateHdr = "S.No,Candidate Name,Candidate ID,Total Training Days (QP),Total Hours Attended,Total Days Attended";
  const gateCsv = [
    gateHdr,
    `1,${NAME} Alpha,CAN_${STAMP}0001,18,7.05,1`,
    `2,${NAME} Bravo,CAN_${STAMP}0002,18,27.33,4`,
    `3,${NAME} Gatecheck,CAN_${STAMP}6301,18,12.63,3`,
  ].join("\n");
  const gateFile = (n = "gate.csv") => new File([Buffer.from(gateCsv)], n, { type: "text/csv" });

  const gPre = await upload(admin, { file: gateFile(), batch: batch._id });
  const named = (gPre.data.name_match_detail?.rows ?? []).map((r) => r.name);
  ok("-248 (QA-1217 / QA-416): the preview NAMES every row placed by name while carrying an ID",
    gPre.data.name_match_suspected === true && named.includes(`${NAME} Gatecheck`)
      && !named.includes(`${NAME} Alpha`) && !named.includes(`${NAME} Bravo`),
    JSON.stringify({ s: gPre.data.name_match_suspected, rows: gPre.data.name_match_detail?.rows,
      gatecheckRow: (gPre.data.preview ?? []).filter((r) => String(r.name).includes("Gatecheck"))
        .map((r) => ({ st: r.match_status, by: r.match_by, id: r.govt_candidate_id, note: String(r.match_note ?? "").slice(0, 90) })) }));
  ok("-248 (QA-1217): ...with the portal ID beside the name - the ID is the evidence, the name is the doubt",
    (gPre.data.name_match_detail?.rows ?? []).some((r) => r.name === `${NAME} Gatecheck` && r.id === `CAN_${STAMP}6301`),
    JSON.stringify(gPre.data.name_match_detail?.rows));

  // 3. THE GATE HOLDS, and writes nothing. accept_name_match "0" opts out of the helper's default.
  const before = await impCount();
  const held = await upload(admin, { file: gateFile("held.csv"), batch: batch._id, confirm: "1", accept_name_match: "0", period_label: `name-gate ${STAMP}` });
  const after = await impCount();
  ok("-248 (QA-1217 / QA-416): the commit is REFUSED without consent, and says where the ID goes",
    held.status === 400 && /placed by NAME/i.test(String(held.data.error ?? ""))
      && /Portal candidate ID/.test(String(held.data.error ?? ""))
      && /Link portal IDs/.test(String(held.data.error ?? "")),
    JSON.stringify({ status: held.status, error: String(held.data.error ?? "").slice(0, 200) }));
  ok("-248 (QA-1217): ...and the refusal wrote NOTHING (import count unchanged)",
    after === before, JSON.stringify({ before, after }));

  // 4. The operator is never trapped. Paired with #3 - alone it passes pre-fix trivially.
  const consented = await upload(admin, { file: gateFile("consented.csv"), batch: batch._id, confirm: "1", accept_name_match: "1", period_label: `name-gate-ok ${STAMP}` });
  ok("-248 (QA-1217, paired with the refusal above): explicit consent still imports",
    consented.status === 201 && !!consented.data._id,
    JSON.stringify({ status: consented.status, error: String(consented.data?.error ?? "").slice(0, 200), data: JSON.stringify(consented.data).slice(0, 200) }));
  if (consented.data._id) await req(admin, "DELETE", `/api/govt-attendance/${consented.data._id}`);

  // 5. THE SILENT ONE, and the reason this unit exists. Alpha IS on record - as CAN_...0001. A file
  //    that names Alpha but gives a DIFFERENT id used to match him anyway, by name, and stamp
  //    nothing (the stamp is conditional on the candidate having no id) - so one student's hours
  //    landed on another student's record with no warning and no trace, forever indistinguishable
  //    from a correct row. This is the Sandeep Kumar case from Umesh's own file.
  //    PRE-FIX this row comes back Matched/Name. Post-fix it must be Unmatched.
  const contra = [
    "S.No,Candidate Name,Candidate ID,Total Training Days (QP),Total Hours Attended,Total Days Attended",
    `1,${NAME} Alpha,CAN_${STAMP}6302,18,7.05,1`,
  ].join("\n");
  const cPre = await upload(admin, { file: new File([Buffer.from(contra)], "contradiction.csv", { type: "text/csv" }), batch: batch._id });
  const cRow = (cPre.data.preview ?? [])[0];
  ok("-248 (QA-1217): a name match onto a candidate already on record under a DIFFERENT portal ID is REFUSED",
    cRow?.match_status === "Unmatched",
    JSON.stringify({ status: cRow?.match_status, by: cRow?.match_by, note: String(cRow?.match_note ?? "").slice(0, 160) }));
  ok("-248 (QA-1217): ...and the note names BOTH ids, so the operator can see which is which",
    String(cRow?.match_note ?? "").includes(`CAN_${STAMP}6302`) && String(cRow?.match_note ?? "").includes(`CAN_${STAMP}0001`),
    String(cRow?.match_note ?? "").slice(0, 200));

  // 6. ONE MATCHER, NOT TWO. The old index keyed on String(x).trim().toUpperCase(), so a file
  //    written CAN41088877 could not find a candidate stored CAN_41088877 - two spellings of one
  //    identity, both legal under the partial-unique index because they are different STRINGS.
  //    normalizeCan reads only the digits. Pre-fix this row falls through to the NAME branch.
  const spell = [
    "S.No,Candidate Name,Candidate ID,Total Training Days (QP),Total Hours Attended,Total Days Attended",
    `1,Someone Else Entirely,CAN${STAMP}0001,18,7.05,1`,
  ].join("\n");
  const spPre = await upload(admin, { file: new File([Buffer.from(spell)], "spelling.csv", { type: "text/csv" }), batch: batch._id });
  const spRow = (spPre.data.preview ?? [])[0];
  ok("-248 (QA-1217): an ID spelled without the underscore still matches the same person, by ID",
    spRow?.match_status === "Matched" && spRow?.match_by === "Portal ID",
    JSON.stringify({ status: spRow?.match_status, by: spRow?.match_by }));

  // 7. THE PIN THAT KEEPS THE GATE HONEST: a file every row of which matches on its ID must NOT be
  //    flagged. Strict === false, so it also fails pre-fix (the field is undefined there) while
  //    post-fix it proves the gate cannot bite an import that did exactly what was asked of it.
  const clean = [
    "S.No,Candidate Name,Candidate ID,Total Training Days (QP),Total Hours Attended,Total Days Attended",
    `1,${NAME} Alpha,CAN_${STAMP}0001,18,7.05,1`,
    `2,${NAME} Bravo,CAN_${STAMP}0002,18,27.33,4`,
  ].join("\n");
  const clPre = await upload(admin, { file: new File([Buffer.from(clean)], "all-by-id.csv", { type: "text/csv" }), batch: batch._id });
  ok("-248 (QA-1217): a file whose every row matches on its portal ID is NOT flagged",
    clPre.status === 200 && clPre.data.name_match_suspected === false,
    JSON.stringify({ s: clPre.data.name_match_suspected, preview: (clPre.data.preview ?? []).map((r) => r.match_by) }));

  // 8. CYCLE 2 (QA-1226, raised by the checker against cycle 1 and correct).
  //
  //    `normalizeCan` reads only the DIGITS after CAN, so it returns null for `CAN_ED…` — a shape
  //    `looksLikeCan` accepts and this product stores (QA-714/-210). Cycle 1 keyed the ID index on
  //    the bare matcher, which dropped those candidates out of ID matching ENTIRELY: file and
  //    candidate carrying the IDENTICAL string went Matched/"Portal ID" -> Unmatched, and the note
  //    said "No candidate named X in this batch" about a candidate who was in the batch holding
  //    that exact id.
  //
  //    Nothing in this suite covered the shape, which is why a 3,916-green wall was silent about it.
  //    These four go RED on cycle 1 and on any future build that narrows the key again.
  const edId = `CAN_ED${STAMP}`;                 // looksLikeCan: true. normalizeCan: null.
  const edCand = (await req(admin, "POST", "/api/candidates", {
    name: `${NAME} Edshape`, phone: `9${STAMP}201`, location: loc._id, program: program._id,
    sidh_candidate_id: edId,
  })).data.item;
  const edMem = await req(admin, "POST", `/api/batches/${batch._id}/members`, {
    candidate: edCand?._id, joined_on: localDate(),
  });
  ok("-248 cycle 2 (QA-1226): a candidate CAN hold an id normalizeCan cannot read - the door accepts it",
    !!edCand?._id && edCand?.sidh_candidate_id === edId && !!edMem.data?.item?._id,
    JSON.stringify({ id: !!edCand?._id, stored: edCand?.sidh_candidate_id, member: !!edMem.data?.item?._id,
      err: String(edCand ? "" : "").slice(0, 120) }));

  //    DIFFERENT name on purpose: the name branch must not be what rescues this row. If the id is
  //    not doing the matching, this row cannot match at all.
  const edCsv = [
    "S.No,Candidate Name,Candidate ID,Total Training Days (QP),Total Hours Attended,Total Days Attended",
    `1,Totally Different Person,${edId},18,7.05,1`,
  ].join("\n");
  const edPre = await upload(admin, { file: new File([Buffer.from(edCsv)], "ed-shape.csv", { type: "text/csv" }), batch: batch._id });
  const edRow = (edPre.data.preview ?? [])[0];
  ok("-248 cycle 2 (QA-1226): an id normalizeCan CANNOT read still matches on the id when both sides carry it verbatim",
    edRow?.match_status === "Matched" && edRow?.match_by === "Portal ID",
    JSON.stringify({ st: edRow?.match_status, by: edRow?.match_by, note: String(edRow?.match_note ?? "").slice(0, 130) }));

  //    ...and the row must NOT be described with a sentence that is false about the only fact the
  //    operator can act on.
  ok("-248 cycle 2 (QA-1226): ...so it is never told 'No candidate named X' about a candidate who is right there holding that id",
    !/No candidate named/i.test(String(edRow?.match_note ?? "")),
    JSON.stringify({ note: String(edRow?.match_note ?? "").slice(0, 160) }));

  //    The contradiction refusal must reach this shape too. Cycle 1 read an unreadable stored id as
  //    "no id on record", so a file naming that person with a DIFFERENT readable id sailed through
  //    as a name match - the very mis-attribution QA-1218 exists to stop, still open for one shape.
  const edContra = [
    "S.No,Candidate Name,Candidate ID,Total Training Days (QP),Total Hours Attended,Total Days Attended",
    `1,${NAME} Edshape,CAN_${STAMP}6303,18,7.05,1`,
  ].join("\n");
  const ecPre = await upload(admin, { file: new File([Buffer.from(edContra)], "ed-contra.csv", { type: "text/csv" }), batch: batch._id });
  const ecRow = (ecPre.data.preview ?? [])[0];
  ok("-248 cycle 2 (QA-1226/QA-1218): a candidate holding an UNREADABLE id is still 'on record' - a different id cannot name-match onto them",
    ecRow?.match_status === "Unmatched",
    JSON.stringify({ st: ecRow?.match_status, by: ecRow?.match_by, note: String(ecRow?.match_note ?? "").slice(0, 160) }));

  //    And the consent gate has to SEE such a row as carrying an id. Cycle 1's filter asked
  //    `normalizeCan(...)`, so the row shape most likely to fall to a name match was the one shape
  //    the gate stayed silent about.
  //    A candidate this assertion OWNS. Gatecheck cannot serve here: test 4 above committed an
  //    import that stamped CAN_<STAMP>6301 onto him, so a file naming him with a different id is
  //    now correctly REFUSED by the QA-1218 contradiction guard and never reaches the gate at all.
  //    That is the guard working - and it made the first version of this assertion measure the
  //    wrong thing. Caught by the wall, not by review.
  const gate2 = (await req(admin, "POST", "/api/candidates", {
    name: `${NAME} Gatetwo`, phone: `9${STAMP}202`, location: loc._id, program: program._id,
  })).data.item;
  const gate2Mem = await req(admin, "POST", `/api/batches/${batch._id}/members`, {
    candidate: gate2?._id, joined_on: localDate(),
  });
  ok("-248 cycle 2 (QA-1226): a second un-stamped candidate is on the roster for the gate assertion",
    !!gate2?._id && !gate2?.sidh_candidate_id && !!gate2Mem.data?.item?._id,
    JSON.stringify({ cand: !!gate2?._id, can: gate2?.sidh_candidate_id, member: !!gate2Mem.data?.item?._id }));
  const edGate = [
    "S.No,Candidate Name,Candidate ID,Total Training Days (QP),Total Hours Attended,Total Days Attended",
    `1,${NAME} Gatetwo,CAN_ED${STAMP}77,18,12.63,3`,
  ].join("\n");
  const egPre = await upload(admin, { file: new File([Buffer.from(edGate)], "ed-gate.csv", { type: "text/csv" }), batch: batch._id });
  ok("-248 cycle 2 (QA-1226): the consent gate counts a row carrying an id normalizeCan cannot read",
    egPre.data.name_match_suspected === true
      && (egPre.data.name_match_detail?.rows ?? []).some((r) => r.id === `CAN_ED${STAMP}77`),
    JSON.stringify({ s: egPre.data.name_match_suspected, rows: egPre.data.name_match_detail?.rows }));
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

// ---- -205 (Umesh, 23/08): "ye jo 10 students remaining hai, ye 10 hai kaun se?" ----
// The panel printed a COUNT and told him to "map by hand below" with nothing below it. He could not
// find out which students, and neither could the centre: "team ko kya, mujhe bhi nahi pata chala ki
// wo 10 bachche hain kaun se, jinki candidate id nahi hai." And there was nowhere to type one in
// from the batch that is blocked by its absence — "individual candidate card me candidate id bharne
// wala koi form input value type hi nahi hai."
//
// These are behaviour pins: they build a roster where some ids are missing, read the payload the
// screen reads, and then type an id in the way the screen types it — through the ordinary candidate
// door — and watch the counts move.
{
  const nb = (await req(admin, "POST", "/api/batches", { location: loc._id, program: program._id, target_size: 5, planned_start: localDate() })).data.item;   // > the 3 members below: Rule 48 caps ENROLMENT at target_size, and an unenrolled member is invisible to the gate
  const c1 = (await req(admin, "POST", "/api/candidates", { name: `${NAME} NoId One`, phone: "9556" + STAMP, location: loc._id, program: program._id })).data.item;
  const c2 = (await req(admin, "POST", "/api/candidates", { name: `${NAME} NoId Two`, phone: "9557" + STAMP, location: loc._id, program: program._id, sidh_candidate_id: `CAN_${STAMP}8888` })).data.item;
  // The gate counts ENROLLED students, so the fixture has to enrol them - otherwise this block
  // would pass on an empty list and prove nothing, which is how the first -207 run reported roster 0.
  const mm1 = (await req(admin, "POST", `/api/batches/${nb._id}/members`, { candidate: c1._id })).data.item;
  const mm2 = (await req(admin, "POST", `/api/batches/${nb._id}/members`, { candidate: c2._id })).data.item;
  for (const mm of [mm1, mm2]) await req(admin, "PATCH", `/api/members/${mm._id}`, { reg_done: true, kyc_done: true, accept_done: true });

  const p0 = (await req(admin, "GET", `/api/batches/${nb._id}/link-portal-ids`)).data;
  ok("-205: the payload NAMES the students with no portal ID — a count alone is not actionable",
    Array.isArray(p0.missing) && p0.missing.length === 1 && p0.missing[0].name === `${NAME} NoId One`,
    JSON.stringify({ without: p0.without_portal_id, missing: (p0.missing ?? []).map((m) => m.name) }));
  // Every read below is guarded. The first baseline run of this block proved pin 1 red and then
  // CRASHED on `p0.missing.length` — pre-fix there is no `missing` at all — which killed every
  // assertion after it and turned a suite into an exception. A pin must FAIL, not fall over: a
  // crash and a red are not the same evidence, and a non-zero exit from a crash is exactly the
  // "EXHAUSTED reported as a result" trap this project has a rule about.
  const m0 = p0.missing ?? [];
  ok("-205: …and the list length agrees with the count the screen prints beside it",
    m0.length === p0.blocking && p0.with_portal_id === 1 && p0.roster === 2,
    JSON.stringify({ n: m0.length, blocking: p0.blocking, with: p0.with_portal_id, roster: p0.roster }));
  // His second question, answered on the row: "inke certificate to nahi honge na, matlab jo fail
  // wale bachche hain, unhi me se 10 hain, ya kaun se hain".
  ok("-205: …each named student carries their RESULT and phone, so the row identifies a person",
    m0[0]?.result === "Pending" && String(m0[0]?.phone ?? "").endsWith(STAMP)
    && typeof m0[0]?.candidate === "string",
    JSON.stringify(m0[0] ?? null));

  // QA-714 (-210, checker on qa-208): the hand-typed id was written with NO validation while every
  // reader of it counts through `normalizeCan`. "CAN_CHK208A" and "40918461" both SAVED, both audited
  // as a real change, and the student stayed on the blocked list with nothing on screen to say why -
  // the operator could not tell a working id from a broken one. And the junk then permanently blocked
  // the automatic linker for that candidate, because it only ever fills an EMPTY id.
  for (const junk of ["40918461", "CANDIDATE", "CAN_", "12345678", "can-abc"]) {
    const r = await req(admin, "PATCH", `/api/candidates/${c1._id}`, { sidh_candidate_id: junk });
    ok(`-210 (QA-714): "${junk}" is refused at the door instead of being stored in silence`,
      r.status === 400 && /portal Candidate ID/i.test(String(r.data?.error ?? "")),
      `status=${r.status} error=${JSON.stringify(r.data?.error ?? null).slice(0, 110)}`);
  }
  // ...and the other half, which is the one the wall taught me. My first version of this guard used
  // `normalizeCan` as the format. It is the MATCHER - it reads only digits after CAN - so it refused
  // `CAN_ED0711202`, a shape this product stores and every suite uses, and eleven assertions went
  // red before it could ship. A validator stricter than the data is a defect wearing a fix's clothes.
  for (const real of ["CAN_ED0711202", "CAN_21663167"]) {
    const r = await req(admin, "PATCH", `/api/candidates/${c1._id}`, { sidh_candidate_id: real });
    ok(`-210 (QA-714): "${real}" is ACCEPTED - the guard must not be stricter than the data`,
      r.status === 200, `status=${r.status} error=${JSON.stringify(r.data?.error ?? null).slice(0, 90)}`);
  }
  await req(admin, "PATCH", `/api/candidates/${c1._id}`, { sidh_candidate_id: null }, 200);
  const stillBlocked = (await req(admin, "GET", `/api/batches/${nb._id}/link-portal-ids`)).data;
  ok("-210 (QA-714): …and not one of them landed - the student is still on the list, unchanged",
    (stillBlocked.missing ?? []).some((m) => m.name === `${NAME} NoId One`),
    JSON.stringify((stillBlocked.missing ?? []).map((m) => m.name)));

  // ---- -212, checker on qa-210 (QA-725/726/730). Three defects the -210 guard SHIPPED. ----
  //
  // QA-726 is the live one and the worst: the Candidates drawer re-sends sidh_candidate_id on every
  // edit (openEdit loads it into the form), and -210 validated the field on every PATCH that carried
  // it. So a record already holding a value the guard refuses - typed before -210, or written by the
  // bulk importer, which still had no guard at all - became UNEDITABLE. Not the ID: the NAME, the
  // PHONE, the EMAIL, the CENTRE. The one record you most need to correct was the one you could not
  // touch. Written the way saveCandidate builds the request, or it would not reproduce.
  // QA-757 (-213, checker on qa-212): the QA-726 pin that USED to sit here is deleted, not moved
  // twice. It planted `CAN_CHK208A`, which `looksLikeCan` ACCEPTS, so the guard never fired and it
  // stayed green against a pre-fix build - I wrote about that failure in the -212 manifest and then
  // left the broken copy in this suite anyway. A pin that cannot fail is worse than no pin: it
  // spends a line of the wall asserting nothing while reading as coverage. The real reproduction
  // needs a value the guard REFUSES already sitting on the record, and the bulk importer is the only
  // door that can still put one there - so it lives in e2e-flows-blindspot, once.
  //
  // What is still worth pinning here is the OTHER half, and only because it is genuinely reachable:
  // a NEW junk value must still be refused at this door.
  const stillNew = await req(admin, "PATCH", `/api/candidates/${c1._id}`, { sidh_candidate_id: "40918461" });
  ok("-212 (QA-726): a genuinely NEW junk value is still refused - the guard did not go soft",
    stillNew.status === 400, `status=${stillNew.status}`);
  // QA-730: the guard blessed padded values and stored them untrimmed. The QA-417 partial unique
  // index is built on the RAW string, so a padded copy of an id someone else holds does not collide,
  // and the health screen's duplicate bucket groups on the raw value too - neither sees the pair.
  await req(admin, "PATCH", `/api/candidates/${c1._id}`, { sidh_candidate_id: `  CAN_${STAMP}7  ` }, 200);
  const padded = (await req(admin, "GET", `/api/candidates/${c1._id}`)).data?.item;
  ok("-212 (QA-730): a padded id is stored TRIMMED, so the partial unique index can still see it",
    padded?.sidh_candidate_id === `CAN_${STAMP}7`, JSON.stringify(padded?.sidh_candidate_id ?? null));
  // QA-726 part 2: clearing has to CLEAR. The drawer's `v !== ""` filter dropped an emptied field,
  // so the screen reported a saved edit while the old id stayed in the database - and that id is
  // exactly what blocks the automatic linker, which only ever fills an EMPTY one.
  await req(admin, "PATCH", `/api/candidates/${c1._id}`, { sidh_candidate_id: null }, 200);
  const cleared = (await req(admin, "GET", `/api/candidates/${c1._id}`)).data?.item;
  ok("-212 (QA-726): clearing the portal ID actually clears it on the record",
    cleared && !cleared.sidh_candidate_id, JSON.stringify(cleared?.sidh_candidate_id ?? null));
  // QA-725: the residue the -210 guard deliberately leaves. `looksLikeCan` accepts CAN followed by
  // letters; `normalizeCan` reads only the digits, so `CAN_CHK208A` is stored, valid to the door
  // that took it, and INVISIBLE to the gate. Until QA-719 is decided the row must SAY so - a blocked
  // student holding an unreadable id used to render exactly like one holding nothing, so the
  // operator retyped what was already there and nothing moved.
  // The SAME student, before and after — that is what makes the two states comparable. This roster
  // has one blocked student, so asserting "some other row is empty" was a fixture accident, not a
  // property; taken literally it would pass only where a second gap happened to exist.
  const emptyBefore = ((await req(admin, "GET", `/api/batches/${nb._id}/link-portal-ids`)).data.missing ?? [])
    .find((m) => m.name === `${NAME} NoId One`);
  ok("-212 (QA-725): a student genuinely holding nothing is reported as holding nothing",
    emptyBefore?.on_record === null && emptyBefore?.unreadable === false, JSON.stringify(emptyBefore ?? null));
  await req(admin, "PATCH", `/api/candidates/${c1._id}`, { sidh_candidate_id: `CAN_A${STAMP}` }, 200);
  const echoed = (await req(admin, "GET", `/api/batches/${nb._id}/link-portal-ids`)).data;
  const row = (echoed.missing ?? []).find((m) => m.name === `${NAME} NoId One`);
  ok("-212 (QA-725): …and once they hold an id the gate cannot read, the row is NOT blank any more",
    row?.unreadable === true && row?.on_record === `CAN_A${STAMP}`, JSON.stringify(row ?? null));
  ok("-212 (QA-725): …and they are STILL blocking — naming the id does not excuse it",
    Boolean(row) && echoed.blocking === (echoed.missing ?? []).length,
    JSON.stringify({ blocking: echoed.blocking, listed: (echoed.missing ?? []).length }));

  // ---- QA-770 (-215, checker on live -213): the blocked student who is not missing anything ----
  //
  // 57 candidates on live carry a CAN-shaped value in `id_reference` - the field the model itself
  // USED TO call "government ID reference, NOT the Aadhaar number itself" (until 2026-08-24, when
  // `aadhaar_no` became its own field) - with `sidh_candidate_id` empty.
  // TEN of them are on AVP-GURU-RPLAVP-DST-02, the batch this whole week has been about. Umesh has
  // been told ten IDs are missing; ten of them were already in the system, one column over.
  //
  // The remedy existed (portal-id-health's `misfiled` bucket, pinned in e2e-flows-blindspot) and was
  // never run, because it lives on the Candidates screen while the person with the problem stands on
  // the BATCH screen. What was never pinned is the CONNECTION: that a misfiled id is WHY a batch is
  // blocked, and that moving it clears the block. That is what -215 surfaces and this pins.
  {
    // Its OWN batch. My first version enrolled into `nb`, the shared fixture two blocks up, and the
    // extra member broke two EXISTING assertions there that count exactly (-205 "missing 0" and
    // -207 "roster 4"). A new pin that moves another pin's numbers is a pin that will be deleted by
    // whoever it inconveniences next.
    const rb = (await req(admin, "POST", "/api/batches", { location: loc._id, program: program._id, target_size: 3, planned_start: localDate() }, 201)).data.item;
    const ref = `CAN_${STAMP}31`;
    const cRef = (await req(admin, "POST", "/api/candidates", {
      // STAMP is 6 digits, so the phone must be prefixed to TEN - `97${STAMP}` was eight, the create
      // came back 400, `.data.item` was undefined and the whole suite crashed on `._id`. The wall
      // refused to count that run at all, which is the crash guard doing exactly its job.
      name: `${NAME} Misfiled One`, phone: `9558${STAMP}`, location: loc._id, program: program._id,
      id_reference: ref,   // the id is HERE, and sidh_candidate_id is deliberately left empty
    }, 201)).data.item;   // these routes wrap in `item` - reading `.data` gave an undefined _id and
                          // the whole block passed its ids as "undefined" to the API
    const mRef = (await req(admin, "POST", `/api/batches/${rb._id}/members`, { candidate: cRef._id }, 201)).data.item;
    await req(admin, "PATCH", `/api/members/${mRef._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);

    const blocked = (await req(admin, "GET", `/api/batches/${rb._id}/link-portal-ids`)).data;
    const row = (blocked.missing ?? []).find((m) => m.name === `${NAME} Misfiled One`);
    ok("-215 (QA-770): a student whose ID sits in id_reference is counted as BLOCKING the batch",
      Boolean(row) && row.on_record === null, JSON.stringify(row ?? null));

    // QA-776 (-216, checker on qa-215): the narrowing is the SERVER's job now, so it can be proved.
    // -215 did it in the browser and the checker showed every one of these assertions passed against
    // the pre-fix tree - the only thing guarding "whose students are these" was a regex looking for a
    // variable name. The failure that would have slipped through is a centre being handed another
    // centre's roster to "fix", which is not a cosmetic risk.
    const health = (await req(admin, "GET", `/api/candidates/portal-id-health?batch=${rb._id}`)).data;
    const mis = (health.misfiled ?? []).find((m) => String(m.candidate) === String(cRef._id));
    ok("-216 (QA-776): asking for ONE batch returns only that batch's students",
      (health.misfiled ?? []).every((m) => String(m.candidate) === String(cRef._id)),
      JSON.stringify({ n: (health.misfiled ?? []).length }));
    // …and the un-narrowed call still answers for everyone, so the Candidates screen is unchanged.
    const wide = (await req(admin, "GET", "/api/candidates/portal-id-health")).data;
    ok("-216 (QA-776): …and without ?batch= the plan is still system-wide",
      (wide.misfiled ?? []).length >= (health.misfiled ?? []).length,
      JSON.stringify({ wide: (wide.misfiled ?? []).length, narrowed: (health.misfiled ?? []).length }));
    // a DIFFERENT batch must not be offered this student at all - the whole point
    const other = (await req(admin, "GET", `/api/candidates/portal-id-health?batch=${nb._id}`)).data;
    ok("-216 (QA-776): THE POINT — another batch is never offered this batch's student",
      !(other.misfiled ?? []).some((m) => String(m.candidate) === String(cRef._id)),
      JSON.stringify((other.misfiled ?? []).map((m) => m.name)));
    ok("-215 (QA-770): …and the health plan already knows the id is there, one column over",
      Boolean(mis) && mis.can === ref, JSON.stringify(mis ?? null));

    const moved = await req(admin, "POST", "/api/candidates/portal-id-health", { copy: [String(cRef._id)] });
    ok("-215 (QA-770): moving it is one action, not ten typed IDs", moved.status === 200 && moved.data.copied === 1,
      JSON.stringify(moved.data).slice(0, 140));

    const after = (await req(admin, "GET", `/api/batches/${rb._id}/link-portal-ids`)).data;
    ok("-215 (QA-770): THE POINT — that student stops blocking the batch, with nothing typed",
      !(after.missing ?? []).some((m) => m.name === `${NAME} Misfiled One`),
      JSON.stringify((after.missing ?? []).map((m) => m.name)));
    const readBack = (await req(admin, "GET", `/api/candidates/${cRef._id}`)).data?.item;
    ok("-215 (QA-770): …and id_reference is left exactly as it was — a copy, not a move",
      readBack?.sidh_candidate_id === ref && readBack?.id_reference === ref,
      JSON.stringify({ sidh: readBack?.sidh_candidate_id, ref: readBack?.id_reference }));
  }

  // -212, Umesh 23/08: "jo candidate card hai, usme HAR KISI ki portal id bhi dikha... even
  // attendance wale tab me bhi". The chip is only as true as the payload behind it: the roster
  // route populated "name phone lifecycle_status" and nothing else, so a chip reading
  // sidh_candidate_id would have read "no portal ID" for every student on every batch - a
  // screen-wide falsehood no source-scanning pin can see, because the component would be right and
  // the data behind it empty. That is exactly how three green walls shipped broken screens today.
  await req(admin, "PATCH", `/api/candidates/${c1._id}`, { sidh_candidate_id: `CAN_${STAMP}5` }, 200);
  const roster = (await req(admin, "GET", `/api/batches/${nb._id}/members`)).data.items ?? [];
  const carried = roster.find((r) => String(r.candidate?._id) === String(c1._id));
  ok("-212: the roster payload CARRIES the portal ID, so the card can show it at all",
    carried?.candidate?.sidh_candidate_id === `CAN_${STAMP}5`,
    JSON.stringify(carried?.candidate ?? null).slice(0, 160));
  // The attendance payload flattens the candidate onto the row, so the field is `sidh_candidate_id`
  // directly - reading it under `.candidate` returned nulls and would have pinned nothing.
  //
  // QA-758 (-213, checker on qa-212): stated honestly, this one is a REGRESSION GUARD, not evidence
  // of new work - `/attendance` already carried this field before -212 (it has since -161/QA-430),
  // so it passes on pre-fix code and always would have. The -212 manifest listed it beside the
  // /members pin as though both proved the same thing. Only the /members pin does; this one exists
  // so the field cannot be dropped from the payload the Attendance tab reads.
  const att = (await req(admin, "GET", `/api/batches/${nb._id}/attendance`)).data;
  ok("-212 [regression guard, green pre-fix]: the attendance payload still carries the portal ID",
    (att.members ?? []).some((r) => r.sidh_candidate_id === `CAN_${STAMP}5`),
    JSON.stringify((att.members ?? []).slice(0, 3).map((r) => [r.name, r.sidh_candidate_id ?? null])));

  await req(admin, "PATCH", `/api/candidates/${c1._id}`, { sidh_candidate_id: null }, 200);

  // The hand-typed path — the one he asked for. Same door the screen uses.
  const typed = await req(admin, "PATCH", `/api/candidates/${c1._id}`, { sidh_candidate_id: `CAN_${STAMP}9999` });
  ok("-205: an id typed by hand is accepted on the ordinary candidate door", typed.status === 200,
    JSON.stringify(typed.data).slice(0, 120));
  const p1 = (await req(admin, "GET", `/api/batches/${nb._id}/link-portal-ids`)).data;
  ok("-205: THE ASK — after typing it, that student leaves the list and the counts move",
    (p1.missing ?? []).length === 0 && p1.blocking === 0 && p1.with_portal_id === 2,
    JSON.stringify({ missing: p1.missing?.length, blocking: p1.blocking, with: p1.with_portal_id }));

  // QA-676: the Overview caption said "Waiting on certificates" whenever certification was Pending,
  // which on the Gurugram batch was false — nothing was outstanding but the portal IDs. The payload
  // the caption reads must carry that fact, or the screen can only guess again.
  // -207 (QA-702): the -205 version of this asserted only `Array.isArray(cp.no_portal_id)`, which is
  // true of an empty array — so it passed on a payload that named nobody. It names them now, and it
  // is checked against the OTHER screen's list, because QA-704 was exactly the two disagreeing.
  const c3 = (await req(admin, "POST", "/api/candidates", { name: `${NAME} NoId Three`, phone: "9558" + STAMP, location: loc._id, program: program._id })).data.item;
  const m3 = (await req(admin, "POST", `/api/batches/${nb._id}/members`, { candidate: c3._id })).data.item;
  await req(admin, "PATCH", `/api/members/${m3._id}`, { reg_done: true, kyc_done: true, accept_done: true });
  const cp = (await req(admin, "GET", `/api/batches/${nb._id}/complete`)).data;
  const p2 = (await req(admin, "GET", `/api/batches/${nb._id}/link-portal-ids`)).data;
  ok("-207 (QA-702): the completion payload NAMES the students with no portal ID, not merely an array",
    Array.isArray(cp.no_portal_id) && cp.no_portal_id.length >= 1
    && cp.no_portal_id.some((x) => x.name === `${NAME} NoId Three`),
    JSON.stringify((cp.no_portal_id ?? []).map((x) => x.name)));
  // QA-704: two screens, one question, one answer. The Overview caption reads `no_portal_id` and
  // points the reader at the Certificates tab, which reads `missing` — on the Gurugram shape those
  // two disagreed and the screen printed three different numbers for what Umesh asked once.
  ok("-207 (QA-704): the caption's list and the Certificates tab's list are the SAME set",
    cp.no_portal_id.length >= 1 && (p2.missing ?? []).length >= 1
    && cp.no_portal_id.length === (p2.missing ?? []).length
    && cp.no_portal_id.map((x) => x.name).sort().join("|") === (p2.missing ?? []).map((x) => x.name).sort().join("|"),
    JSON.stringify({ caption: cp.no_portal_id.map((x) => x.name), tab: (p2.missing ?? []).map((x) => x.name) }));
  // QA-701: the count was a subtraction, so a member the list dropped stayed in the number - the
  // screen printed 8 while the button offered "show which 7".
  // QA-701: the number printed beside "show which N" must BE the length of that list. It used to be
  // a roster-wide subtraction, so an orphaned member stayed in the count and fell out of the list -
  // the panel read "8 without" beside a button offering "show which 7". `blocking` is that number
  // now; `without_portal_id` keeps its roster-wide meaning for the certificate-matching sentence,
  // and the screen never prints it beside the list.
  ok("-207 (QA-701): the count printed beside the list IS the length of that list",
    p2.blocking === (p2.missing ?? []).length,
    JSON.stringify({ blocking: p2.blocking, n: (p2.missing ?? []).length }));
  ok("-207: …and the roster-wide counts still describe the whole roster, so certificate matching is unaffected",
    p2.roster === 3 && p2.with_portal_id + p2.without_portal_id === p2.roster,
    JSON.stringify({ roster: p2.roster, with: p2.with_portal_id, without: p2.without_portal_id }));
}

// ---- QA-897: an empty roster is why nothing matched, and the upload must say so ----
// Umesh, 24/08, on MUZ-CHAR-RPLHSL-SPIT-01: "attandance upload kaam nhi krr rha hai properly".
// It was working. The batch had no students, so matchGovtRows (whose candidate index is built from
// THIS BATCH's members, :357) could not match a single student, every student row came back
// Unmatched, and the screen's standing note blamed the portal Candidate ID — sending the operator to
// fix a thing that was not broken. The roster is the answer, and only the server knows it.
// Trainer rows are a separate question: that lookup is global by design, so "nothing matched" was
// never the right claim — see the assertion below, which is where that error was caught.
console.log("\n--- QA-897: empty roster is named, not left to look like a failed upload ---");
{
  // No trainer and no room ON PURPOSE. The fixture batch above already holds both, and a second
  // batch naming the same ones is refused by assertTrainerAvailableForBatch /
  // assertRoomFreeForBatch — which is what made the first version of this pin die on
  // `undefined._id` instead of testing anything. Neither is required to create a batch, and this
  // one never has to reach Ready: an EMPTY roster is the whole point of it.
  const mk = await req(admin, "POST", "/api/batches", {
    location: loc._id, program: program._id,
    target_size: 5, planned_start: localDate(Date.now() + 3 * 864e5),
  }, 201);
  ok("QA-897: precondition - the empty-roster fixture batch was actually created",
    !!mk.data?.item?._id, `${mk.status} ${JSON.stringify(mk.data).slice(0, 200)}`);
  const emptyBatch = mk.data.item;

  const onEmpty = await upload(admin, { file: csvFile(), batch: emptyBatch._id });
  ok("QA-897: an upload aimed at a batch with NO roster reports roster_is_empty",
    onEmpty.status === 200 && onEmpty.data.roster_is_empty === true,
    JSON.stringify({ status: onEmpty.status, flag: onEmpty.data.roster_is_empty, matched: onEmpty.data.matched_count }));
  // This assertion read `matched_count === 0` and FAILED on the wall with empty_batch_matched 1 -
  // correctly. Trainer lookup in matchGovtRows is deliberately GLOBAL (govt-attendance.ts:401,
  // argued in -149/QA-334 and kept in -151/QA-350), so a trainer row in the file matches whatever
  // the roster holds. The claim the screen makes is about STUDENTS, so this is the number that
  // carries it. The over-strong version would have shipped a red block saying "none of these rows
  // can match anyone" over a preview that had just matched one.
  ok("QA-897: and it is genuinely the roster - not one STUDENT row matches on an empty batch",
    onEmpty.data.matched_student_count === 0,
    JSON.stringify({ students: onEmpty.data.matched_student_count, all_matched: onEmpty.data.matched_count }));

  // The control that makes the pin mean something: the SAME file on the populated batch must NOT
  // raise the flag. Without this, a pin that always returned true would pass.
  const onFull = await upload(admin, { file: csvFile(), batch: batch._id });
  ok("QA-897: a batch that HAS students does not raise the flag",
    onFull.data.roster_is_empty === false,
    JSON.stringify({ flag: onFull.data.roster_is_empty, matched: onFull.data.matched_count }));

  // EVERY date below goes through `localDate()` (:11), never `toISOString().slice(0,10)`. The first
  // version of these pins used the latter and Rule 25 refused both drops with a 400: `left_on` came
  // out as the UTC calendar day while `joined_on` had defaulted to `istToday()`, so between IST
  // midnight and UTC midnight — about five and a half hours every single day — left_on preceded
  // joined_on. The precondition pins caught it; without them rows 2 and 3 would have failed with a
  // flag reading that had nothing to do with the flag. Same class as qa-226's disclosed `day()`
  // helper in e2e-flows-blindspot.
  // QA-1041 — the same sentence, a THIRD time, and the checker's charge was that the fix "did not
  // remove the false sentence, it moved it to the other side". It was right, so these four pins now
  // hold the WHOLE truth table instead of one corner of it. Two questions were being answered by one
  // boolean: "can anything in this file match here?" (the matcher's index, `{batch}`) and "is anybody
  // on this batch right now?" (REQ-119's roster, `{batch, left_on: null}`). Each of the three
  // messages belongs to exactly one row below; the fourth row is the control that keeps them honest.
  {
    const mkLeft = async (label) => {
      const mk = await req(admin, "POST", "/api/batches", {
        location: loc._id, program: program._id,
        target_size: 5, planned_start: localDate(Date.now() + 4 * 864e5),
      }, 201);
      return mk.data.item;
    };
    // A departed member whose name the FILE DOES NOT CARRY. Fresh candidate, not one of `members` —
    // Rule 20 keeps those active on `batch`, so borrowing one would test the refusal, not the flag.
    const bNoneInFile = await mkLeft();
    const candOut = (await req(admin, "POST", "/api/candidates", {
      name: `${NAME} Departed`, phone: `9${STAMP.slice(1)}1900`,
      location: loc._id, program: program._id,
    }, 201)).data.item;
    const addOut = await req(admin, "POST", `/api/batches/${bNoneInFile._id}/members`, { candidate: candOut._id });
    ok("QA-1041: precondition - a member was actually added before being dropped",
      addOut.status === 201 && !!addOut.data?.item?._id, `${addOut.status} ${JSON.stringify(addOut.data).slice(0, 160)}`);
    const dropOut = await req(admin, "POST", `/api/members/${addOut.data.item._id}/drop`,
      { left_on: localDate(), drop_reason: "QA-1041 pin" }, 200);
    ok("QA-1041: precondition - and the drop stuck", dropOut.status === 200, `${dropOut.status}`);

    // A departed member whose name the FILE DOES CARRY. `${NAME} Alpha` is a row in the fixture CSV,
    // and matchGovtRows indexes per batch, so the same name living on `batch` cannot make this one
    // Ambiguous. This is the case e239139 was flipped FOR — and cycle 2 found it had no pin at all.
    const bInFile = await mkLeft();
    const candIn = (await req(admin, "POST", "/api/candidates", {
      name: `${NAME} Alpha`, phone: `9${STAMP.slice(1)}1901`,
      location: loc._id, program: program._id,
    }, 201)).data.item;
    const addIn = await req(admin, "POST", `/api/batches/${bInFile._id}/members`, { candidate: candIn._id });
    ok("QA-1041: precondition - the in-file member was added",
      addIn.status === 201 && !!addIn.data?.item?._id, `${addIn.status} ${JSON.stringify(addIn.data).slice(0, 160)}`);
    const dropIn = await req(admin, "POST", `/api/members/${addIn.data.item._id}/drop`,
      { left_on: localDate(), drop_reason: "QA-1041 pin" }, 200);
    ok("QA-1041: precondition - and that drop stuck too", dropIn.status === 200, `${dropIn.status}`);

    const upNever    = await upload(admin, { file: csvFile(), batch: emptyBatch._id });
    const upNoneInFile = await upload(admin, { file: csvFile(), batch: bNoneInFile._id });
    const upInFile   = await upload(admin, { file: csvFile(), batch: bInFile._id });
    const upActive   = await upload(admin, { file: csvFile(), batch: batch._id });

    // ROW 1 — nobody ever joined. "Add the students first." Nothing here can ever match.
    ok("QA-1041 [1/4] never had a member: roster_is_empty true, all_departed false",
      upNever.data.roster_is_empty === true && upNever.data.roster_all_departed === false,
      JSON.stringify({ empty: upNever.data.roster_is_empty, departed: upNever.data.roster_all_departed }));

    // ROW 2 — everyone left, and the file names none of them. THE CASE CYCLE 2 CHARGED: this used to
    // fall through to "set the portal Candidate ID", which cannot help and points at the wrong screen.
    ok("QA-1041 [2/4] all departed, none of them in the file: its OWN message, not the portal-ID note",
      upNoneInFile.data.roster_is_empty === false
        && upNoneInFile.data.roster_all_departed === true
        && upNoneInFile.data.matched_student_count === 0,
      JSON.stringify({ empty: upNoneInFile.data.roster_is_empty, departed: upNoneInFile.data.roster_all_departed, students: upNoneInFile.data.matched_student_count }));

    // ROW 3 — everyone left, but the file DOES name one of them, so rows really match and the
    // portal-ID note is the right advice for the rest. The red block must NOT appear here.
    ok("QA-1041 [3/4] all departed but one IS in the file: rows match, so the portal-ID note stands",
      upInFile.data.roster_all_departed === true && upInFile.data.matched_student_count >= 1,
      JSON.stringify({ departed: upInFile.data.roster_all_departed, students: upInFile.data.matched_student_count }));

    // ROW 4 — the control. A live roster raises neither flag; without this a pair of always-true
    // flags would pass rows 1-3 and mean nothing.
    ok("QA-1041 [4/4] control - a batch with a live roster raises neither flag",
      upActive.data.roster_is_empty === false && upActive.data.roster_all_departed === false,
      JSON.stringify({ empty: upActive.data.roster_is_empty, departed: upActive.data.roster_all_departed, students: upActive.data.matched_student_count }));

    // ROW 5 — QA-1067, the case the cycle-3 checker found and the four rows above could not see.
    // TWO departed members who SHARE a name the file carries come back `Ambiguous`, not `Matched`.
    // `matched_student_count` counts only "Matched", so it stays 0 — byte-identical to row 2's
    // reading — and the red block fired, telling the operator that none of the students in this
    // file are among them, two lines under a chip reading "2 ambiguous" and a row note saying
    // "click this row to pick the right one". Its next sentence was the exact inverse of the truth.
    //
    // Umesh, 2026-08-25: "hn tho preview screen de doo naa baaki jo upload krr rha hai vo manual
    // mapping krr lenge" — when a manual mapping route is OPEN, this screen gives no advice at all.
    {
      const bTwins = await mkLeft();
      const twinIds = [];
      const twinFail = [];
      // `190${n}` — TEN digits. The first version wrote `19${n}`, which is NINE, so every create was
      // refused and `c` came back undefined; the suite then died on `c._id` before a single pin ran,
      // and the whole file contributed ZERO counts to the wall. The precondition pin that should
      // have named this sat AFTER the loop, so it never executed — a precondition that runs after
      // the thing it guards is not a precondition. Each step is now checked where it happens, and a
      // refusal is carried out of the loop instead of thrown.
      for (const n of [2, 3]) {
        const cr = await req(admin, "POST", "/api/candidates", {
          name: `${NAME} Twin`, phone: `9${STAMP.slice(1)}190${n}`,
          location: loc._id, program: program._id,
        });
        if (cr.status !== 201 || !cr.data?.item?._id) { twinFail.push(`create ${n}: ${cr.status} ${JSON.stringify(cr.data).slice(0, 90)}`); continue; }
        const a = await req(admin, "POST", `/api/batches/${bTwins._id}/members`, { candidate: cr.data.item._id });
        if (a.status !== 201 || !a.data?.item?._id) { twinFail.push(`add ${n}: ${a.status} ${JSON.stringify(a.data).slice(0, 90)}`); continue; }
        const d = await req(admin, "POST", `/api/members/${a.data.item._id}/drop`,
          { left_on: localDate(), drop_reason: "QA-1067 pin" }, 200);
        if (d.status !== 200) { twinFail.push(`drop ${n}: ${d.status} ${JSON.stringify(d.data).slice(0, 90)}`); continue; }
        twinIds.push(a.data.item._id);
      }
      ok("QA-1067: precondition - both same-named members were added and dropped",
        twinIds.length === 2, twinFail.length ? twinFail.join(" | ") : JSON.stringify(twinIds.map(Boolean)));

      const onTwins = await upload(admin, { file: csvFile(), batch: bTwins._id });
      // The precondition FOR the case: the rows really are Ambiguous, and the count the old
      // condition leaned on really is 0. Without this, row 5 could pass on a batch where nothing
      // matched for some other reason entirely.
      ok("QA-1067: precondition - the shared name comes back Ambiguous, and matched_student_count is 0",
        onTwins.data.ambiguous_count >= 2 && onTwins.data.matched_student_count === 0,
        JSON.stringify({ amb: onTwins.data.ambiguous_count, students: onTwins.data.matched_student_count }));
      ok("QA-1067 [5/5] all departed AND ambiguous rows present: the flags still say departed, so the SCREEN must not advise",
        onTwins.data.roster_all_departed === true && onTwins.data.ambiguous_count > 0,
        JSON.stringify({ departed: onTwins.data.roster_all_departed, amb: onTwins.data.ambiguous_count, students: onTwins.data.matched_student_count }));
      await req(admin, "POST", `/api/batches/${bTwins._id}/transition`, { target: "Cancelled", reason: "QA-1067 fixture cleanup" }, 200);
    }

    await req(admin, "POST", `/api/batches/${bNoneInFile._id}/transition`, { target: "Cancelled", reason: "QA-1041 fixture cleanup" }, 200);
    await req(admin, "POST", `/api/batches/${bInFile._id}/transition`, { target: "Cancelled", reason: "QA-1041 fixture cleanup" }, 200);
  }

  await req(admin, "POST", `/api/batches/${emptyBatch._id}/transition`, { target: "Cancelled", reason: "QA-897 fixture cleanup" }, 200);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
