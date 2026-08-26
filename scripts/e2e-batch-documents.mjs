// Batch document checklist E2E (2026-08-26, RPL compliance ask).
// Covers the six new batch-level document types (BatchDocument/BATCH_DOC_TYPE), the
// attendance_sheet field added to DailyLog (rides the existing Daily Execution door), the
// permission gate (batches.daily_log — reused, not a new key), batch scope, and that the
// trainer-documentation pull-through never writes into BatchDocument (no duplicate storage).
// Performs a real PUT /api/permissions role toggle (revoke/restore batches.daily_log on
// Trainer) — same class of write e2e-roles.mjs guards, so this suite guards the same way.
// Run: node scripts/e2e-batch-documents.mjs
import { requireLocalBase } from "./db-guard.mjs";
const BASE = requireLocalBase("e2e-batch-documents", process.env.BASE_URL || "http://localhost:3000/erp");
let pass = 0, fail = 0;
// QA-1460: the Indian day, not the UTC one. `new Date().toISOString().slice(0,10)` is ALWAYS UTC -
// TZ=Asia/Kolkata does not touch it - so between 00:00 and 05:30 IST it returns YESTERDAY, and this
// suite then asks for a daily log dated before the batch the server just started today. It died
// exactly that way at 00:20 IST on 2026-08-27 ("Log date before batch actual start.", then a
// TypeError on the missing item), contributing 0 assertions to the wall. That is QA-1065's curve one
// layer down: red for 5.5 hours a day, green for the other 18.5, which reads as flakiness. Same
// formatter this repo already uses for this in scripts/migrate-logdate-tz.mjs.
const istDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

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
  const session = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")]).flat().filter(Boolean).map((c) => c.split(";")[0]).find((c) => c.includes("session-token"));
  return session ? [csrfCookie, session].join("; ") : null;
}

async function req(cookie, method, path, body, expect) {
  const res = await fetch(BASE + path, {
    method, headers: { "Content-Type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (expect !== undefined) ok(`${method} ${path.split("?")[0]} → ${expect}`, res.status === expect, `(got ${res.status}: ${JSON.stringify(data).slice(0, 150)})`);
  return { status: res.status, data };
}

const admin = await login("admin@vidysea.com", process.env.ADMIN_PASSWORD || "admin123");
ok("admin login", !!admin);

const stamp = "BD" + Date.now().toString().slice(-6);
const PW = "CiOnly@123";

// ---- fixture: an owning batch, with a trainer of ITS OWN (scope must come from ASSIGNMENT,
// not from location_scope, so out-of-scope refusal below is a real test) ----
const loc = (await req(admin, "POST", "/api/locations", {
  code: "L" + stamp, name: "Govt. ITI " + stamp, state: "UP", district: "Muzaffarnagar",
  tc_id: "TC" + stamp, tc_status: "Approved", operating_partner: "Vidysea", approval_status: "Approved",
}, 201)).data.item;
const prog = (await req(admin, "POST", "/api/programs", {
  code: "P" + stamp, name: "RPL Programme " + stamp, trainer_skill: "SK" + stamp,
  scheme: "RPL-AVPL", qp_code: "ASC/Q" + stamp.slice(-4), scheme_priority: 1,
}, 201)).data.item;
const tr = (await req(admin, "POST", "/api/trainers", {
  name: "Doc Trainer " + stamp, phone: "9" + Date.now().toString().slice(-9),
  email: `doctrainer.${stamp}@example.com`.toLowerCase(),
  skills: [prog.trainer_skill], home_location: loc._id, pipeline_status: "Fresh Lead",
}, 201)).data.item;
const room = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "Room " + stamp, type: "Classroom" }, 201)).data.item;
const batch = (await req(admin, "POST", "/api/batches", {
  code: "B" + stamp, location: loc._id, program: prog._id, trainer: tr._id, room: room._id,
  target_size: 1, planned_start: istDay(),
}, 201)).data.item;
const DOCS = `/api/batches/${batch._id}/documents`;

const mk = await req(admin, "POST", `/api/trainers/${tr._id}/create-login`, { password: PW }, 201);
const trainerCookie = await login(tr.email, PW);
ok("trainer login minted and can sign in", !!trainerCookie, JSON.stringify(mk.data));

// A second trainer, assigned to NO batch and a different centre — proves scope is the gate, not
// merely "any Trainer role".
const locOut = (await req(admin, "POST", "/api/locations", {
  code: "LX" + stamp, name: "Other ITI " + stamp, state: "UP", district: "Meerut",
  tc_id: "TCX" + stamp, tc_status: "Approved", operating_partner: "Vidysea", approval_status: "Approved",
}, 201)).data.item;
const trOut = (await req(admin, "POST", "/api/trainers", {
  name: "Outside Trainer " + stamp, phone: "8" + Date.now().toString().slice(-9),
  email: `outside.${stamp}@example.com`.toLowerCase(),
  skills: [prog.trainer_skill], home_location: locOut._id, pipeline_status: "Fresh Lead",
}, 201)).data.item;
await req(admin, "POST", `/api/trainers/${trOut._id}/create-login`, { password: PW }, 201);
const outsideCookie = await login(trOut.email, PW);

// ---- 1. empty state: every one of the six types is missing, nothing on file ----
const before = (await req(admin, "GET", DOCS, undefined, 200)).data;
ok("all six batch doc types reported missing up front", before.summary.missing.length === 6, JSON.stringify(before.summary.missing));
ok("no items yet", (before.items ?? []).length === 0);
const TYPES = before.summary.required;
ok("required list carries exactly the six new types", TYPES.length === 6, JSON.stringify(TYPES));

// ---- 2. out-of-scope trainer is refused before scope-holding trainer is even tried ----
ok("QA out-of-scope: a trainer not assigned to this batch is refused",
  (await req(outsideCookie, "POST", DOCS, { doc_type: TYPES[0], file_url: "/uploads/x1.jpg", original_name: "x1.jpg" })).status === 403);

// ---- 3. bad doc_type is refused ----
await req(admin, "POST", DOCS, { doc_type: "Not A Real Type", file_url: "/uploads/x.jpg" }, 400);
await req(admin, "POST", DOCS, { doc_type: TYPES[0] }, 400); // no file_url

// ---- 4. one file per type, uploaded by the ASSIGNED trainer (in scope by assignment) ----
const created = [];
for (const t of TYPES) {
  const r = await req(trainerCookie, "POST", DOCS, { doc_type: t, file_url: `/uploads/${stamp}-${encodeURIComponent(t)}.jpg`, original_name: `${t}.jpg` }, 201);
  ok(`POST records the right doc_type (${t})`, r.data.item?.doc_type === t, JSON.stringify(r.data.item));
  created.push(r.data.item);
}
const afterAll = (await req(admin, "GET", DOCS, undefined, 200)).data;
ok("complete once all six are on file", afterAll.summary.complete === true, JSON.stringify(afterAll.summary));
ok("all six items listed", afterAll.items.length === 6, String(afterAll.items.length));

// ---- 5. a doc_type accepts a SECOND file (append, not replace — unlike Trainer/CandidateDocument) ----
const secondSameType = await req(trainerCookie, "POST", DOCS, { doc_type: TYPES[0], file_url: `/uploads/${stamp}-second.jpg`, original_name: "second.jpg" }, 201);
const afterSeven = (await req(admin, "GET", DOCS, undefined, 200)).data;
ok("second file under the same type APPENDS (7 items, not 6)", afterSeven.items.length === 7, String(afterSeven.items.length));
ok("still complete — a doc_type with 2 files is not double-counted as missing", afterSeven.summary.complete === true);

// ---- 6. delete: removing the SPARE file (type still has one left) keeps complete; removing the
// last file of a type reopens it as missing ----
await req(trainerCookie, "DELETE", `${DOCS}/${secondSameType.data.item._id}`, undefined, 200);
const afterSpareDel = (await req(admin, "GET", DOCS, undefined, 200)).data;
ok("deleting the spare file: still complete (the type still has its original file)", afterSpareDel.summary.complete === true, JSON.stringify(afterSpareDel.summary));

const lastOfType = created.find((c) => c.doc_type === TYPES[1]);
await req(trainerCookie, "DELETE", `${DOCS}/${lastOfType._id}`, undefined, 200);
const afterLastDel = (await req(admin, "GET", DOCS, undefined, 200)).data;
ok("deleting the LAST file of a type reopens it as missing", afterLastDel.summary.missing.includes(TYPES[1]) && afterLastDel.summary.complete === false, JSON.stringify(afterLastDel.summary));
// restore for a clean final state
await req(trainerCookie, "POST", DOCS, { doc_type: TYPES[1], file_url: `/uploads/${stamp}-restore.jpg`, original_name: "restore.jpg" }, 201);

// ---- 7. permission gate: batches.daily_log decides, not the Trainer role ----
const permsBefore = (await req(admin, "GET", "/api/permissions")).data;
const trainerSetBefore = (permsBefore?.roles ?? []).find((r) => r.role === "Trainer")?.permissions ?? [];
ok("Trainer holds batches.daily_log by default", trainerSetBefore.includes("batches.daily_log"), JSON.stringify(trainerSetBefore));
await req(admin, "PUT", "/api/permissions", { role: "Trainer", permissions: trainerSetBefore.filter((p) => p !== "batches.daily_log") }, 200);
const revokedTry = await req(trainerCookie, "POST", DOCS, { doc_type: TYPES[2], file_url: `/uploads/${stamp}-revoked.jpg` });
ok("without batches.daily_log the same assigned trainer is refused (403)", revokedTry.status === 403, String(revokedTry.status));
await req(admin, "PUT", "/api/permissions", { role: "Trainer", permissions: trainerSetBefore }, 200);
const restoredTry = await req(trainerCookie, "POST", DOCS, { doc_type: TYPES[2], file_url: `/uploads/${stamp}-restored.jpg` });
ok("restoring batches.daily_log re-opens the door (the RIGHT decides, not the role)", restoredTry.status === 201, String(restoredTry.status));
const permsAfter = (await req(admin, "GET", "/api/permissions")).data;
const trainerSetAfter = (permsAfter?.roles ?? []).find((r) => r.role === "Trainer")?.permissions ?? [];
ok("Trainer's permission set is byte-restored", JSON.stringify([...trainerSetAfter].sort()) === JSON.stringify([...trainerSetBefore].sort()), JSON.stringify({ before: trainerSetBefore, after: trainerSetAfter }));

// ---- fixture: daily logs only exist on an Active/Closing batch — enrol one candidate through
// to Completed and start the batch, mirroring e2e.mjs's own Ready->Active walk ----
const cand = (await req(admin, "POST", "/api/candidates", { name: "Doc Candidate " + stamp, phone: "7" + Date.now().toString().slice(-9), location: loc._id, program: prog._id }, 201)).data.item;
await req(admin, "POST", `/api/batches/${batch._id}/members`, { candidate: cand._id }, 201);
const fixtureMembers = (await req(admin, "GET", `/api/batches/${batch._id}/members`)).data.items;
await req(admin, "PATCH", `/api/members/${fixtureMembers[0]._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Ready" }, 200);
await req(admin, "POST", `/api/batches/${batch._id}/transition`, { target: "Active" }, 200);

// ---- 8. attendance_sheet rides the existing Daily Execution door, not a new upload path ----
const logDate = istDay();
const logCreate = await req(trainerCookie, "POST", `/api/batches/${batch._id}/logs`, {
  log_date: logDate, present_member_ids: [], trainer_present: true, attendance_sheet: [`/uploads/${stamp}-att1.jpg`],
}, 201);
ok("daily log create persists attendance_sheet", (logCreate.data.item?.attendance_sheet ?? []).length === 1, JSON.stringify(logCreate.data.item?.attendance_sheet));
const logId = logCreate.data.item._id;
const logPatch = await req(trainerCookie, "PATCH", `/api/logs/${logId}`, { attendance_sheet: [...logCreate.data.item.attendance_sheet, `/uploads/${stamp}-att2.jpg`] }, 200);
ok("daily log edit persists a second attendance_sheet file (append)", (logPatch.data.item?.attendance_sheet ?? []).length === 2, JSON.stringify(logPatch.data.item?.attendance_sheet));
const logsList = (await req(admin, "GET", `/api/batches/${batch._id}/logs`, undefined, 200)).data;
const freshLog = logsList.items.find((l) => l._id === logId);
ok("the log list reflects the attendance_sheet field", (freshLog?.attendance_sheet ?? []).length === 2, JSON.stringify(freshLog?.attendance_sheet));

// ---- 9. trainer-documentation pull-through — read-only, no duplicate storage ----
// This trainer has zero TrainerDocument rows (no identity docs uploaded) even though the batch
// they are assigned to now carries 7 BatchDocument rows — proves the two collections never mix.
const trainerOwnDocs = (await req(admin, "GET", `/api/trainers/${tr._id}/documents`, undefined, 200)).data;
ok("the trainer's OWN document summary is untouched by the batch's document uploads (still the 5-item mandatory floor, all missing)",
  trainerOwnDocs.summary.missing.length === 5 && trainerOwnDocs.summary.complete === false, JSON.stringify(trainerOwnDocs.summary));
ok("the trainer's own document store has zero rows — the batch uploads never wrote into it", (trainerOwnDocs.items ?? []).length === 0, String(trainerOwnDocs.items?.length));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
