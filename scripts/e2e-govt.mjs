// Government-portal attendance import + the scheme/contract rules Manish confirmed on
// 2026-08-12. Run against a running server: node scripts/e2e-govt.mjs
//
// Everything here is driven through the HTTP API on purpose — the parser, the matcher and the
// reconciler only earn their keep if a real multipart upload of a real portal-shaped file lands
// in the database with the right numbers.
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

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
  name: `${NAME} Trainer`, phone: `9${STAMP}0001`, skills: ["Testing"],
  home_location: loc._id, pipeline_status: "Certified", max_concurrent_batches: 4,
  available_from: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10),
})).data.item;
ok("trainer created (matches the fixture's Trainer row by name)", !!trainer?._id);

// target_size 5 so the 5-member roster clears the 80% readiness gate and the batch can reach
// Active — daily logs only exist for Active/Closing batches, and without logs there is nothing
// to reconcile the portal figures against.
const batch = (await req(admin, "POST", "/api/batches", {
  location: loc._id, program: program._id, target_size: 5, trainer: trainer._id, room: room._id,
  planned_start: new Date().toISOString().slice(0, 10),
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
    name: p.name, phone: `9${STAMP}1${String(i).padStart(3, "0")}`,
    location: loc._id, program: program._id, ...(p.sidh_candidate_id ? { sidh_candidate_id: p.sidh_candidate_id } : {}),
  })).data.item;
  // Joined 20 days ago so the back-dated daily logs below have a roster to draw on (Rule 26).
  const m = (await req(admin, "POST", `/api/batches/${batch._id}/members`, {
    candidate: c._id, joined_on: new Date(Date.now() - 20 * 86400_000).toISOString().slice(0, 10),
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
  log_date: new Date().toISOString().slice(0, 10),
  present_member_ids: [members[0].member._id, members[1].member._id], actual_topic: "govt test",
});
// Asserted, not assumed: had the log silently failed to write, every variance below would read
// as "portal says N, we logged 0" and the reconciliation checks would pass for the wrong reason.
ok("daily log written for the reconciliation baseline", logRes.status === 201, JSON.stringify(logRes.data).slice(0, 250));

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

// ---------------------------------------------------------------- garbage in
const junk = await upload(admin, { file: new File([Buffer.from("just,some,csv\n1,2,3\n")], "junk.csv", { type: "text/csv" }) });
ok("a file with no attendance header is rejected with a readable reason",
  junk.status === 400 && /header/i.test(junk.data.error ?? ""), JSON.stringify(junk.data));

// ---------------------------------------------------------------- scheme timing (Manish 2026-08-12)
const mkBatch = (extra) => req(admin, "POST", "/api/batches", {
  location: loc._id, program: program._id, target_size: 30,
  planned_start: new Date(Date.now() + 86400_000).toISOString().slice(0, 10), ...extra,
});
const early = await mkBatch({ slot_start: "07:00", slot_end: "11:00" });
ok("07:00 start refused — the day runs 09:00–18:00", early.status === 400 && /09:00/.test(early.data.error ?? ""), JSON.stringify(early.data).slice(0, 160));
const late = await mkBatch({ slot_start: "15:00", slot_end: "19:00" });
ok("a slot running past 18:00 refused", late.status === 400, JSON.stringify(late.data).slice(0, 160));
const tooLong = await mkBatch({ slot_start: "09:00", slot_end: "14:00" });
ok("a 5-hour session refused — 4 hours is the ceiling", tooLong.status === 400 && /4 hours/.test(tooLong.data.error ?? ""), JSON.stringify(tooLong.data).slice(0, 160));
const four = await mkBatch({ slot_start: "09:00", slot_end: "13:00", trainer: trainer._id });
ok("a 4-hour 09:00–13:00 batch is allowed (Manish: '4 Hour Batch You can Create')", four.status === 201, JSON.stringify(four.data).slice(0, 160));
const second = await mkBatch({ slot_start: "14:00", slot_end: "18:00", trainer: trainer._id });
ok("a second 4-hour batch the same day is allowed ('4-4 Hour's 2 batch')", second.status === 201, JSON.stringify(second.data).slice(0, 160));
const third = await mkBatch({ slot_start: "13:00", slot_end: "14:00", trainer: trainer._id });
ok("a third same-day session refused — 2 per day is the sanctioned pattern",
  third.status === 409 && /2 sessions/.test(third.data.error ?? ""), JSON.stringify(third.data).slice(0, 200));
const noSlot = await mkBatch({});
ok("a batch with no slot at all still saves (legacy batches carry none)", noSlot.status === 201, JSON.stringify(noSlot.data).slice(0, 160));

// ---------------------------------------------------------------- contract counting (Manish 2026-08-12)
const defaults = (await req(admin, "GET", "/api/defaults")).data.item;
ok("Defaults expose the scheme window", defaults.day_start_time === "09:00" && defaults.day_end_time === "18:00");
ok("Defaults: 4-hour sessions, 2 a day", defaults.max_session_hours === 4 && defaults.max_batches_per_day === 2);
ok("Defaults: absentees are NOT deducted from 'appeared'", defaults.absent_counts_as_appeared === true);
ok("Defaults: a dropout who passed is not billable", defaults.dropped_pass_is_billable === false);
ok("Defaults: upload ceiling raised off 25 MB", defaults.max_upload_mb === 100, String(defaults.max_upload_mb));

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

// A candidate who dropped out is not billable even though their Pass survives (Rule 42).
const dropped = await req(admin, "POST", `/api/members/${members[4].member._id}/drop`, {
  left_on: new Date().toISOString().slice(0, 10), drop_reason: "Personal",
});
ok("a roster member can be dropped", [200, 201].includes(dropped.status), JSON.stringify(dropped.data).slice(0, 200));
sum = (await req(admin, "GET", `/api/batches/${batch._id}/results`)).data.summary;
ok("the dropout's Pass is preserved (Rule 42)", sum.passed === 3, String(sum.passed));
ok("but it is excluded from the billable count", sum.billable_passed === 2, JSON.stringify(sum));
ok("and the exclusion is visible, not silent", sum.dropped_passed === 1, String(sum.dropped_passed));

// Mid-batch replacement: the freed seat takes a new candidate on a LATER joining date.
const replacement = (await req(admin, "POST", "/api/candidates", {
  name: `${NAME} Replacement`, phone: `9${STAMP}2000`, location: loc._id, program: program._id,
})).data.item;
const readd = await req(admin, "POST", `/api/batches/${batch._id}/members`, {
  candidate: replacement._id, joined_on: new Date().toISOString().slice(0, 10),
});
ok("mid-batch replacement allowed on a later joining date (Manish: yes)", readd.status === 201, JSON.stringify(readd.data).slice(0, 200));

// ---------------------------------------------------------------- rules Manish confirmed should NOT change
const perms = (await req(admin, "GET", "/api/permissions")).data;
ok("the portal-attendance right is a togglable permission",
  (perms.catalog ?? perms.permissions ?? []).some((p) => p.key === "attendance.govt"), JSON.stringify(perms).slice(0, 200));

// ---------------------------------------------------------------- cleanup
await req(admin, "DELETE", `/api/govt-attendance/${done.data._id}`);
await req(admin, "DELETE", `/api/govt-attendance/${again.data._id}`);
ok("an import can be deleted (wrong file, wrong centre)",
  (await req(admin, "GET", `/api/govt-attendance/${done.data._id}`)).status === 404);


// ---------------------------------------------------------------- universal sheet sources (2026-08-12)
// The feature used to be one hard-coded URL registered by a script. These assertions pin the
// thing that actually matters: any link a person pastes out of their browser can be added,
// tested, edited, paused and removed.

// A Google Sheets /edit link is not downloadable; the export endpoint is. The system must make
// that translation itself — expecting a user to know it is how a source ends up silently dead.
const gTest = await req(admin, "POST", "/api/sync-sources/test", {
  source_url: "https://docs.google.com/spreadsheets/d/1f9veYSwuLktmggOJdUlspl_yydotdqnf/edit?gid=1579134034#gid=1579134034",
});
ok("a Google Sheets browser link is rewritten to its export URL",
  gTest.data.normalized_url === "https://docs.google.com/spreadsheets/d/1f9veYSwuLktmggOJdUlspl_yydotdqnf/export?format=xlsx",
  gTest.data.normalized_url);
// 2026-08-13: this sheet WAS the private fixture until Umesh opened its sharing — reality
// changed under the test. It now proves the happy path (probe succeeds, tabs listed); the
// private-failure path is proven against an ID that cannot exist.
ok("the (now shared) sheet probes clean with its tabs listed",
  gTest.data.ok === true && (gTest.data.tabs?.length ?? 0) >= 1, JSON.stringify(gTest.data).slice(0, 160));
const privTest = await req(admin, "POST", "/api/sync-sources/test", {
  source_url: "https://docs.google.com/spreadsheets/d/1PrivateFixture_DoesNotExist_0000000000000000/edit",
});
ok("a sheet the server cannot read fails the probe instead of being saved as a dead source",
  privTest.data.ok === false, JSON.stringify(privTest.data).slice(0, 200));
ok("and the failure explains what to do rather than a generic error",
  /anyone with the link|moved, renamed or deleted|sign-?in/i.test(`${privTest.data.error ?? ""} ${privTest.data.hint ?? ""}`),
  JSON.stringify({ e: privTest.data.error, h: privTest.data.hint }).slice(0, 300));

const dTest = await req(admin, "POST", "/api/sync-sources/test", { source_url: "https://drive.google.com/file/d/ABC123def/view?usp=sharing" });
ok("a Drive file link is rewritten to its download URL",
  dTest.data.normalized_url === "https://drive.google.com/uc?export=download&id=ABC123def", dTest.data.normalized_url);

const notALink = await req(admin, "POST", "/api/sync-sources/test", { source_url: "just some text" });
ok("something that is not a link is refused up front", notALink.status === 400, `got ${notALink.status}`);

// The client's real OneDrive workbook — the one case that must keep working end to end.
const odTest = await req(admin, "POST", "/api/sync-sources/test", {
  source_url: "https://onedrive.live.com/:x:/g/personal/c1d310c499f08fba/IQBHQGQ1_HmBRZjCmC1XQMK8AQCFnOpu1H8GXm3MNvZnypE",
});
ok("the client's OneDrive workbook still probes green", odTest.data.ok === true, JSON.stringify(odTest.data).slice(0, 200));
ok("and the probe reports its tabs and columns back", (odTest.data.tabs?.[0]?.columns ?? []).some((c) => /tc\s*id/i.test(c)),
  JSON.stringify(odTest.data.tabs?.[0]?.columns ?? []).slice(0, 200));

// Add → edit → pause → remove, all through the API the screen uses.
const created = await req(admin, "POST", "/api/sync-sources", {
  name: `${NAME} sheet`, source_url: "https://example.invalid/whatever.csv",
  mode: "watch", interval_minutes: 45, key_columns: ["Institution Name", "Job role"], frequency: "Manual only",
});
ok("any URL can be registered as a source", created.status === 201, JSON.stringify(created.data).slice(0, 200));
const srcId = created.data.item?._id;
const edited = await req(admin, "PATCH", `/api/sync-sources/${srcId}`, { source_url: "https://example.invalid/renamed.csv", interval_minutes: 60 });
ok("its URL and cadence can be edited afterwards",
  edited.data.item?.source_url === "https://example.invalid/renamed.csv" && edited.data.item?.interval_minutes === 60,
  JSON.stringify(edited.data.item).slice(0, 200));
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
