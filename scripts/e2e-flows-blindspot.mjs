// Flow-level blind tests for the transcript gap items landed on 2026-08-12 evening:
// the ₹3250 cost entry, the batch-created pool notification (and its Rule 38 delivery),
// the Registration Failed queue, per-candidate attendance, the infra feasibility blockers,
// the import file's own duplicates, registration/batch decoupling, and the 2-slotted-batches
// day cap. Each block names the transcript line it proves.
import * as XLSX from "xlsx";
// QA-1692: guarded via requireLocalBase (db-guard.mjs) — see e2e.mjs's own note.
import { requireLocalBase } from "./db-guard.mjs";

const BASE = requireLocalBase("e2e-flows-blindspot", process.env.BASE_URL || "http://localhost:3000/erp");
let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log("PASS ", name); }
  else { fail++; console.log("FAIL ", name, detail ? ` — ${detail}` : ""); }
};

async function login(email, password) {
  const r0 = await fetch(`${BASE}/api/auth/csrf`);
  const jar = (r0.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const { csrfToken } = await r0.json();
  const r = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar },
    body: new URLSearchParams({ csrfToken, email, password }),
  });
  const set = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]);
  return [jar, ...set].join("; ");
}
async function req(cookie, method, path, json, expect) {
  const r = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json", cookie },
    body: json ? JSON.stringify(json) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (expect !== undefined) ok(`${method} ${path} → ${expect}`, r.status === expect, `got ${r.status} ${JSON.stringify(data)?.slice(0, 160)}`);
  return { status: r.status, data };
}
async function multipart(cookie, path, fields, expect) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(BASE + path, { method: "POST", headers: { cookie }, body: fd });
  let data = null;
  try { data = await r.json(); } catch { /* empty */ }
  if (expect !== undefined) ok(`POST ${path} → ${expect}`, r.status === expect, `got ${r.status} ${JSON.stringify(data)?.slice(0, 160)}`);
  return { status: r.status, data };
}

const admin = await login("admin@vidysea.com", process.env.ADMIN_PASSWORD || "admin123");
const stamp = Date.now().toString().slice(-6);
const phone = () => "7" + Date.now().toString().slice(-8) + Math.floor(Math.random() * 9); // QA-141: 10 digits

// ---------------------------------------------------------------- fixtures
const loc = (await req(admin, "POST", "/api/locations", {
  code: `TEST-FL${stamp}`, name: `TEST Flows Centre ${stamp}`, city: "Test", state: "UP",
  approval_status: "Approved", operational_status: "Active", tc_id: `TCF${stamp}`, tc_status: "Approved",
}, 201)).data.item;
const otherLoc = (await req(admin, "POST", "/api/locations", {
  code: `TEST-FO${stamp}`, name: `TEST Flows Other ${stamp}`, approval_status: "Approved", operational_status: "Active",
}, 201)).data.item;
const prog = (await req(admin, "POST", "/api/programs", {
  code: `TEST-FP${stamp}`, name: `TEST Flows Role ${stamp}`, trainer_skill: `fl${stamp}`,
  duration_days: 30, buffer_days: 5, default_batch_size: 30, completion_deadline_days: 120,
}, 201)).data.item;
await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "FL Room", type: "Classroom", capacity: 30 }, 201);

// A Location-role login scoped to the fixture centre, and one scoped elsewhere — the pool
// notification must reach the first and never the second (Rule 38 on the inbox).
const mkUser = async (email, scope) => {
  await req(admin, "POST", "/api/users", {
    name: email.split("@")[0], email, password: "Test@12345", role: "Location",
    can_edit: true, active: true, location_scope: [scope],
  }, 201);
  return login(email, "Test@12345");
};
const spocHere = await mkUser(`test.spoc.fl${stamp}@vidysea-test.local`, loc._id);
const spocElse = await mkUser(`test.spoc.fo${stamp}@vidysea-test.local`, otherLoc._id);

console.log("\n--- FL1: the ₹3250 books itself as a cost, exactly once ---");
{
  // "har stage pe cost capture karni hai" + "3250 rupee payment karne ke lie dedenge"
  const t = (await req(admin, "POST", "/api/trainers", {
    name: `FL Pay ${stamp}`, phone: phone(), skills: [`fl${stamp}`],
    nominated_for_location: loc._id, nominated_for_program: prog._id,
  }, 201)).data.item;
  for (const d of ["Aadhaar", "PAN", "Photo", "CV", "Educational Qualification"]) {
    await req(admin, "POST", `/api/trainers/${t._id}/documents`, { doc_type: d, file_url: `/uploads/${d}.pdf`, original_name: `${d}.pdf` });
  }
  for (const s of ["Shortlisted", "Documents Completed", "Sent to NSDC", "NSDC Approved"]) {
    await req(admin, "POST", `/api/trainers/${t._id}/transition`, { target: s });
  }
  await req(admin, "POST", `/api/trainers/${t._id}/transition`, { target: "TOT Payment Done", payload: { payment_reference: `NEFT-FL${stamp}` } }, 200);
  const costs = (await req(admin, "GET", `/api/costs?trainer=${t._id}`)).data.items ?? [];
  const fee = costs.filter((c) => /eligibility/i.test(c.category?.name ?? ""));
  ok("FL1: the eligibility fee landed in the cost model", fee.length === 1 && fee[0].amount === 3250, JSON.stringify(fee.map((f) => f.amount)));

  // Walk the same trainer out and back through the stage — the fee must not book twice.
  await req(admin, "POST", `/api/trainers/${t._id}/transition`, { target: "Dropped", reason: "Test detour" }, 200);
  await req(admin, "POST", `/api/trainers/${t._id}/transition`, { target: "Fresh Lead" }, 200);
  for (const s of ["Shortlisted", "Documents Completed", "Sent to NSDC", "NSDC Approved", "TOT Payment Done"]) {
    await req(admin, "POST", `/api/trainers/${t._id}/transition`, { target: s });
  }
  const again = (await req(admin, "GET", `/api/costs?trainer=${t._id}`)).data.items ?? [];
  ok("FL1: re-entering Payment Done does not book the fee twice",
    again.filter((c) => /eligibility/i.test(c.category?.name ?? "")).length === 1,
    `${again.length} entries`);
}

console.log("\n--- FL2: batch opens → the centre is told, with its pool count ---");
{
  // "Batch open hote hi inke paas aana chahiye — bhaiya tere candidate pool mein 50"
  for (let i = 0; i < 3; i++) {
    await req(admin, "POST", "/api/candidates", { name: `FL Pool ${stamp}-${i}`, phone: phone(), location: loc._id, program: prog._id }, 201);
  }
  const b = (await req(admin, "POST", "/api/batches", {
    location: loc._id, program: prog._id, planned_start: new Date(Date.now() + 30 * 864e5 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
  }, 201)).data.item;

  const inbox = (await req(spocHere, "GET", "/api/notifications?type=batch_created")).data.items ?? [];
  const mine = inbox.find((n) => String(n.entity_id) === String(b._id));
  ok("FL2: the centre's SPOC is notified the moment the batch opens", !!mine, JSON.stringify(inbox.slice(0, 2)));
  ok("FL2: …and the message carries the pool count", /3 candidates/.test(mine?.message ?? ""), mine?.message);

  const elsewhere = (await req(spocElse, "GET", "/api/notifications?type=batch_created")).data.items ?? [];
  ok("FL2: a SPOC of another centre never sees it (Rule 38)",
    !elsewhere.some((n) => String(n.entity_id) === String(b._id)), JSON.stringify(elsewhere.slice(0, 2)));
}

console.log("\n--- FL3: the portal said no → the candidate lands in the failed queue with the why ---");
{
  // "main bacche ko drop karke doosri queue mein dalunga… reason bhi de denge"
  const c = (await req(admin, "POST", "/api/candidates", { name: `FL RegFail ${stamp}`, phone: phone(), location: loc._id, program: prog._id }, 201)).data.item;
  await req(admin, "PATCH", `/api/candidates/${c._id}`, { sidh_status: "Registration Failed", sidh_failure_reason: "OTP not received on any number" }, 200);
  const home = (await req(admin, "GET", "/api/home")).data;
  const row = (home.queues?.registration_failed ?? []).find((r) => String(r._id) === String(c._id));
  ok("FL3: the failed registration appears on the Home queue", !!row, JSON.stringify(home.queues?.registration_failed?.slice(0, 2)));
  ok("FL3: …carrying the reason, because the queue is useless without it",
    row?.sidh_failure_reason === "OTP not received on any number", row?.sidh_failure_reason);
  // Recovery: marking them registered clears the reason with the status.
  await req(admin, "PATCH", `/api/candidates/${c._id}`, { sidh_status: "Registered", sidh_registered_on: new Date().toISOString(), sidh_failure_reason: "" }, 200);
  const after = (await req(admin, "GET", "/api/home")).data;
  ok("FL3: a later successful registration takes them off the queue",
    !(after.queues?.registration_failed ?? []).some((r) => String(r._id) === String(c._id)));
}

console.log("\n--- FL4: per-candidate attendance is counted from the logs, not typed ---");
{
  // "kitne bacche ki kitni-kitni attendance chal rahi hai"
  const tr = (await req(admin, "POST", "/api/trainers", {
    name: `FL Trainer ${stamp}`, phone: phone(), skills: [`fl${stamp}`], pipeline_status: "Certified",
    available_from: new Date(Date.now() - 30 * 864e5 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
  }, 201)).data.item;
  const room2 = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "FL Room 2", type: "Classroom", capacity: 30 }, 201)).data.item;
  const b = (await req(admin, "POST", "/api/batches", {
    location: loc._id, program: prog._id, trainer: tr._id, room: room2._id, target_size: 2,
    planned_start: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
  }, 201)).data.item;
  const members = [];
  for (const nm of ["Att A", "Att B"]) {
    const c = (await req(admin, "POST", "/api/candidates", { name: `FL ${nm} ${stamp}`, phone: phone(), location: loc._id, program: prog._id }, 201)).data.item;
    const m = (await req(admin, "POST", `/api/batches/${b._id}/members`, { candidate: c._id }, 201)).data.item;
    await req(admin, "PATCH", `/api/members/${m._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
    members.push(m);
  }
  await req(admin, "POST", `/api/batches/${b._id}/transition`, { target: "Ready" }, 200);
  await req(admin, "POST", `/api/batches/${b._id}/transition`, { target: "Active" }, 200);
  // One loggable day (today): A present, B absent.
  await req(admin, "POST", `/api/batches/${b._id}/logs`, {
    log_date: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
    present_member_ids: [members[0]._id], actual_topic: "attendance probe",
  }, 201);
  const roster = (await req(admin, "GET", `/api/batches/${b._id}/members`)).data.items ?? [];
  const a = roster.find((m) => String(m._id) === String(members[0]._id));
  const bb = roster.find((m) => String(m._id) === String(members[1]._id));
  ok("FL4: the present member shows 1/1 (100%)", a?.attendance?.present === 1 && a?.attendance?.pct === 100, JSON.stringify(a?.attendance));
  ok("FL4: the absent member shows 0/1 (0%)", bb?.attendance?.present === 0 && bb?.attendance?.pct === 0, JSON.stringify(bb?.attendance));
}

console.log("\n--- FL5: a lab job role at a centre with no lab is named as blocked ---");
{
  // "aapne teen trainer to rakh diye, classroom do hi hai, lab ek hi hai — can that be managed?"
  const labProg = (await req(admin, "POST", "/api/programs", {
    code: `TEST-FLB${stamp}`, name: `TEST Lab Role ${stamp}`, trainer_skill: `flb${stamp}`, requires_lab: true,
    duration_days: 30, buffer_days: 5, default_batch_size: 30, completion_deadline_days: 120,
  }, 201)).data.item;
  await req(admin, "PUT", `/api/locations/${loc._id}/targets`, { program: labProg._id, approved_target: 60, trainers_required: 1 }, 200);
  const before = (await req(admin, "GET", `/api/mapping/readiness?location=${loc._id}`)).data.items ?? [];
  const rowB = before.find((r) => String(r.program?._id) === String(labProg._id));
  ok("FL5: no lab + lab job role → readiness says exactly that", rowB?.blockers?.some((x) => /no lab/.test(x)), JSON.stringify(rowB?.blockers));
  await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "FL Lab", type: "Lab", capacity: 20 }, 201);
  const after = (await req(admin, "GET", `/api/mapping/readiness?location=${loc._id}`)).data.items ?? [];
  const rowA = after.find((r) => String(r.program?._id) === String(labProg._id));
  ok("FL5: adding the lab clears the blocker", !rowA?.blockers?.some((x) => /no lab/.test(x)), JSON.stringify(rowA?.blockers));
}

console.log("\n--- FL6: the import flags the file's own duplicates and refuses a blind mapping ---");
{
  const rows = [
    { "Student Name": `FL Imp A ${stamp}`, "Mobile": "9811100001", "Junk": "x", "DOB": "2001-04-15", "Edu": "12th pass", "Last Training": "2025-11-20" },
    { "Student Name": `FL Imp B ${stamp}`, "Mobile": "9811100002", "Junk": "y", "DOB": "1999-01-02", "Edu": "BTech", "Last Training": "" }, // BTech is not an enum value
    { "Student Name": `FL Imp C ${stamp}`, "Mobile": "9811100001", "Junk": "z", "DOB": "", "Edu": "", "Last Training": "" }, // same phone as A
  ];
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const file = new File([buf], "import-probe.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

  // No mapping yet → columns come back for the mapping UI, nothing is written.
  const step1 = await multipart(admin, "/api/candidates/import", { file, location: loc._id, program: prog._id }, 200);
  ok("FL6: step 1 returns the real columns", (step1.data.columns ?? []).includes("Student Name") && step1.data.columns.includes("Junk"), JSON.stringify(step1.data.columns));

  // A mapping that never names phone must be refused — guessing is how wrong data gets in.
  const bad = await multipart(admin, "/api/candidates/import", {
    file, location: loc._id, program: prog._id, mapping: JSON.stringify({ "Student Name": "name" }),
  });
  ok("FL6: a mapping without phone is refused", bad.status === 400, `got ${bad.status}`);

  const preview = await multipart(admin, "/api/candidates/import", {
    file, location: loc._id, program: prog._id,
    mapping: JSON.stringify({ "Student Name": "name", "Mobile": "phone" }),
  }, 200);
  ok("FL6: the duplicate inside the file is flagged before anything is written",
    preview.data.duplicate_count >= 1 && (preview.data.duplicates ?? []).some((d) => /same number as row/.test(d)),
    JSON.stringify(preview.data.duplicates));
  ok("FL6: …and it is a flag, not a block — all 3 rows stay importable", preview.data.valid === 3, String(preview.data.valid));

  // ---- -212 (QA-727, checker on qa-210): the portal Candidate ID at the BULK door. ----
  //
  // -210 hardened the two hand-typed candidate doors and left this one writing any string verbatim,
  // then excused it in a comment naming a "normalize-and-report lane" for this field that did not
  // exist - normalizeCan was not even imported into that route. This is the door the file's own
  // header calls how rosters actually arrive, so a mis-mapped column could fill a whole roster with
  // values the certification gate cannot read, 201, silently. Each one then blocks the automatic
  // linker for that student PERMANENTLY, because link-portal-ids only ever fills an EMPTY id.
  //
  // REPORT, never refuse (QA-141: client rows are not dropped over format) - but never in silence,
  // and on the PREVIEW, so the mapping can be fixed before the rows land.
  const canRows = [
    { "Student Name": `FL Can A ${stamp}`, "Mobile": "9811100011", "Candidate ID": "40918461" },     // no CAN at all
    // CAN-shaped and accepted by the door's shape test, but normalizeCan reads only the DIGITS after
    // CAN - a letter first means it reads as NO id at all. STAMPED, because e2e-govt pins the same
    // class on the same shared database and two suites sharing one literal collide on the QA-417
    // partial unique index (it cost this release a red wall).
    { "Student Name": `FL Can B ${stamp}`, "Mobile": "9811100012", "Candidate ID": `CAN_A${stamp}` },
    { "Student Name": `FL Can C ${stamp}`, "Mobile": "9811100013", "Candidate ID": `CAN_${stamp}44` }, // genuinely fine
  ];
  const canWs = XLSX.utils.json_to_sheet(canRows);
  const canWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(canWb, canWs, "Sheet1");
  const canBuf = XLSX.write(canWb, { type: "buffer", bookType: "xlsx" });
  const canFile = () => new File([canBuf], "can-probe.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const canMap = JSON.stringify({ "Student Name": "name", "Mobile": "phone", "Candidate ID": "sidh_candidate_id" });

  const canPrev = await multipart(admin, "/api/candidates/import",
    { file: canFile(), location: loc._id, program: prog._id, mapping: canMap }, 200);
  ok("-212 (QA-727): the importer REPORTS portal Candidate IDs the gate cannot read, on the preview",
    canPrev.data.candidate_id_invalid_count === 2,
    `count=${canPrev.data.candidate_id_invalid_count} list=${JSON.stringify(canPrev.data.candidate_id_invalid ?? null)}`);
  ok("-212 (QA-727): …and it names WHICH ones, both kinds — the non-CAN and the unreadable-CAN",
    (canPrev.data.candidate_id_invalid ?? []).some((s) => s.includes("40918461"))
    && (canPrev.data.candidate_id_invalid ?? []).some((s) => s.includes(`CAN_A${stamp}`)),
    JSON.stringify(canPrev.data.candidate_id_invalid ?? null));
  ok("-212 (QA-727): …and the good one is NOT reported — a report everything flags is not a report",
    !(canPrev.data.candidate_id_invalid ?? []).some((s) => s.includes(`CAN_${stamp}44`)),
    JSON.stringify(canPrev.data.candidate_id_invalid ?? null));
  const canDone = await multipart(admin, "/api/candidates/import",
    { file: canFile(), location: loc._id, program: prog._id, mapping: canMap, confirm: "1" }, 201);
  ok("-212 (QA-727): the rows still IMPORT — this is a report, not a refusal (QA-141)",
    canDone.data.imported === 3 && canDone.data.candidate_id_invalid_count === 2,
    `imported=${canDone.data.imported} flagged=${canDone.data.candidate_id_invalid_count}`);

  // ---- -212 (QA-726, checker on qa-210): the LIVE regression, and it can only be reproduced here.
  //
  // -210's guard ran on every PATCH that carried sidh_candidate_id, and the Candidates drawer
  // re-sends that field on every edit (openEdit loads it into the form). So a record already holding
  // a value the guard refuses could not be edited AT ALL - not the name, the phone, the email or the
  // centre. The one record most in need of correction was the one you could not touch.
  //
  // It has to be pinned HERE because the importer is now the only door that can still put such a
  // value on a record - and that is exactly why the defect existed. My first attempt at this pin
  // lived in e2e-govt and planted "CAN_CHK208A", which the guard ACCEPTS, so it passed against the
  // mutated build too: a pin that cannot fail. The mutation run is the only reason that was caught.
  const badCand = ((await req(admin, "GET", "/api/candidates?q=9811100011&limit=5")).data?.items ?? [])[0];
  ok("-212 (QA-726): the importer really did store the unreadable value (the precondition)",
    badCand?.sidh_candidate_id === "40918461", JSON.stringify(badCand?.sidh_candidate_id ?? null));
  const edit = await req(admin, "PATCH", `/api/candidates/${badCand?._id}`, {
    // shaped exactly as saveCandidate builds it: every non-empty form field, the stored ID included
    name: badCand?.name, phone: badCand?.phone, email: `flcan.${stamp}@example.com`,
    sidh_candidate_id: badCand?.sidh_candidate_id,
  });
  ok("-212 (QA-726): THE REGRESSION — a candidate holding an unreadable ID can still be edited",
    edit.status === 200, `status=${edit.status} error=${JSON.stringify(edit.data?.error ?? null).slice(0, 150)}`);
  const stillGuarded = await req(admin, "PATCH", `/api/candidates/${badCand?._id}`, { sidh_candidate_id: "CANDIDATE" });
  ok("-212 (QA-726): …and the guard did NOT go soft — a genuinely new junk value is still refused",
    stillGuarded.status === 400, `status=${stillGuarded.status}`);

  // QA-146 part 2 (-83, checker on the CHI-ITI import): the sheet's own column-number,
  // header and description rows were stored as candidates ("1"/"5", "Salutation"/"EmailID",
  // "Input field, Mr, Ms, Mrs, Mx *"). Not a format drop on client rows — a template row is
  // one whose phone is not a phone at all AND whose text reads like a label/instruction.
  {
    const trows = [
      { "Student Name": "1", "Mobile": "5", "Email": "7" },
      { "Student Name": "Salutation", "Mobile": "EmailID", "Email": "FullName" },
      { "Student Name": "Input field,\nMr,\nMs,\nMrs,\nMx *", "Mobile": "Input field\nAlphanumeric (50) with email address validations *", "Email": "Input field\nText (50) *" },
      { "Student Name": `FL Real ${stamp}`, "Mobile": "9811100077", "Email": `real${stamp}@t.local` },
      { "Student Name": `FL OddPhone ${stamp}`, "Mobile": "12345", "Email": "" }, // a CLIENT row with a bad phone (5 digits) — stays, reported, never dropped
    ];
    const tws = XLSX.utils.json_to_sheet(trows);
    const twb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(twb, tws, "Sheet1");
    const tfile = new File([XLSX.write(twb, { type: "buffer", bookType: "xlsx" })], "template-rows.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const tp = await multipart(admin, "/api/candidates/import", {
      file: tfile, location: loc._id, program: prog._id,
      mapping: JSON.stringify({ "Student Name": "name", "Mobile": "phone", "Email": "email" }),
    }, 200);
    ok("QA-146p2: the three template/description rows are skipped and named by row number",
      tp.data.template_rows_skipped_count === 3 && (tp.data.template_rows_skipped ?? []).some((r) => /row 2:/.test(r)) && (tp.data.template_rows_skipped ?? []).some((r) => /Salutation/.test(r)),
      JSON.stringify(tp.data.template_rows_skipped));
    ok("QA-146p2: the real rows stay importable — including the one with an odd phone (report-only, never dropped)",
      tp.data.valid === 2 && tp.data.phone_invalid_count === 1, JSON.stringify({ valid: tp.data.valid, bad: tp.data.phone_invalid_count, skipped: tp.data.skipped }));
  }

  // F-B4: the eligibility fields ride the same mapping — dob, education, last training,
  // and comma-separated interest NAMES resolving to real centres / job roles.
  rows[0]["Interests"] = `${prog.name}, Nonexistent Program`;
  const ws2 = XLSX.utils.json_to_sheet(rows);
  const wb2 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2, ws2, "Sheet1");
  const file2 = new File([XLSX.write(wb2, { type: "buffer", bookType: "xlsx" })], "import-probe2.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const fullMap = JSON.stringify({ "Student Name": "name", "Mobile": "phone", "DOB": "dob", "Edu": "education", "Last Training": "last_training_date", "Interests": "interested_programs" });
  const prev2 = await multipart(admin, "/api/candidates/import", { file: file2, location: loc._id, program: prog._id, mapping: fullMap }, 200);
  ok("FL6b: the unrecognised education spelling is reported, not guessed",
    (prev2.data.education_unmatched ?? []).includes("BTech"), JSON.stringify(prev2.data.education_unmatched));
  ok("FL6b: the unknown interest name is reported, the real one resolves",
    (prev2.data.interest_unmatched ?? []).includes("Nonexistent Program") && !(prev2.data.interest_unmatched ?? []).includes(prog.name),
    JSON.stringify(prev2.data.interest_unmatched));
  const done = await multipart(admin, "/api/candidates/import", { file: file2, location: loc._id, program: prog._id, mapping: fullMap, confirm: "1" }, 201);
  ok("FL6b: confirm imports all rows", done.data.imported === 3, String(done.data.imported));
  const impA = (await req(admin, "GET", `/api/candidates?q=9811100001`)).data.items.find((c) => c.name === `FL Imp A ${stamp}`);
  ok("FL6b: education normalised to the enum ('12th pass' → '12th Pass')", impA?.education === "12th Pass", impA?.education);
  ok("FL6b: dob and last_training_date landed as dates",
    (impA?.dob ?? "").startsWith("2001-04-15") && (impA?.last_training_date ?? "").startsWith("2025-11-20"),
    JSON.stringify({ dob: impA?.dob, lt: impA?.last_training_date }));
  ok("FL6b: the resolved interest landed as a real program id",
    (impA?.interested_programs ?? []).length === 1, JSON.stringify(impA?.interested_programs));
  const impB = (await req(admin, "GET", `/api/candidates?q=9811100002`)).data.items.find((c) => c.name === `FL Imp B ${stamp}`);
  ok("FL6b: the BTech row imported with education left null", impB && impB.education == null, JSON.stringify(impB?.education));

  // ---- QA-097/098: the importer reads its own template's date format ----
  // new Date() read "05-06-2001" as May 5th and dropped "15-06-2001" silently; an .xlsx
  // hands dates over as Excel serials. All must parse day-first; junk is named BY ROW.
  {
    const p3 = (n) => `97222${stamp.slice(0, 3)}1${n}`;
    const rows3 = [
      { "Student Name": `FL Date A ${stamp}`, "Mobile": p3(1), "DOB": "15-06-2001" },
      { "Student Name": `FL Date B ${stamp}`, "Mobile": p3(2), "DOB": "05-06-2001" }, // both ≤12 → DD-MM wins
      { "Student Name": `FL Date C ${stamp}`, "Mobile": p3(3), "DOB": 37057 },        // Excel serial = 2001-06-15
      { "Student Name": `FL Date D ${stamp}`, "Mobile": p3(4), "DOB": "junk-date" },
    ];
    const ws3 = XLSX.utils.json_to_sheet(rows3);
    const wb3 = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb3, ws3, "Sheet1");
    const file3 = new File([XLSX.write(wb3, { type: "buffer", bookType: "xlsx" })], "import-dates.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const dateMap = JSON.stringify({ "Student Name": "name", "Mobile": "phone", "DOB": "dob" });
    const prev3 = await multipart(admin, "/api/candidates/import", { file: file3, location: loc._id, program: prog._id, mapping: dateMap }, 200);
    ok("QA-097: the unreadable date is reported BY ROW, nothing guessed",
      (prev3.data.date_unparseable ?? []).some((x) => /row 5/.test(x) && /junk-date/.test(x)), JSON.stringify(prev3.data.date_unparseable));
    await multipart(admin, "/api/candidates/import", { file: file3, location: loc._id, program: prog._id, mapping: dateMap, confirm: "1" }, 201);
    const byPhone = async (ph) => (await req(admin, "GET", `/api/candidates?q=${ph}`)).data.items.find((c) => String(c.phone) === ph);
    const [dA, dB, dC, dD] = [await byPhone(p3(1)), await byPhone(p3(2)), await byPhone(p3(3)), await byPhone(p3(4))];
    ok("QA-097: DD-MM-YYYY parses as the template promises (15-06-2001 → 15 June)",
      (dA?.dob ?? "").startsWith("2001-06-15"), dA?.dob);
    ok("QA-097: an ambiguous day ≤12 is still DAY-first (05-06-2001 → 5 June, not 6 May)",
      (dB?.dob ?? "").startsWith("2001-06-05"), dB?.dob);
    ok("QA-098: an Excel serial date lands as the real date (37057 → 15 June 2001)",
      (dC?.dob ?? "").startsWith("2001-06-15"), dC?.dob);
    ok("QA-097: the junk-date row still imports, dob honestly empty", dD && dD.dob == null, JSON.stringify(dD?.dob));
  }

  // ---- 15/08 (Umesh): custom columns — unknown columns accepted, never restricted away ----
  {
    const p4 = (n) => `97333${stamp.slice(0, 3)}1${n}`;
    const rows4 = [
      { "Student Name": `FL Cust A ${stamp}`, "Mobile": p4(1), "WhatsApp Group": "Basti-Batch-3", "Sponsor": "GramSevak" },
      { "Student Name": `FL Cust B ${stamp}`, "Mobile": p4(2), "WhatsApp Group": "", "Sponsor": "SelfPay" },
    ];
    const ws4 = XLSX.utils.json_to_sheet(rows4);
    const wb4 = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb4, ws4, "Sheet1");
    const mkFile = () => new File([XLSX.write(wb4, { type: "buffer", bookType: "xlsx" })], "import-custom.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const custMap = JSON.stringify({ "Student Name": "name", "Mobile": "phone" });
    // Preview names the columns the ERP does not know.
    const prev4 = await multipart(admin, "/api/candidates/import", { file: mkFile(), location: loc._id, program: prog._id, mapping: custMap }, 200);
    ok("T3: preview names the unknown columns",
      (prev4.data.unknown_columns ?? []).includes("WhatsApp Group") && (prev4.data.unknown_columns ?? []).includes("Sponsor"),
      JSON.stringify(prev4.data.unknown_columns));
    // Accepted → each row's values land under the sheet's own column names.
    await multipart(admin, "/api/candidates/import", { file: mkFile(), location: loc._id, program: prog._id, mapping: custMap, accept_unknown: "1", confirm: "1" }, 201);
    const cA = (await req(admin, "GET", `/api/candidates?q=${p4(1)}`)).data.items.find((c) => String(c.phone) === p4(1));
    ok("T3: accepted unknown columns are stored on the candidate",
      cA?.custom_fields?.["WhatsApp Group"] === "Basti-Batch-3" && cA?.custom_fields?.Sponsor === "GramSevak",
      JSON.stringify(cA?.custom_fields));
    const cB = (await req(admin, "GET", `/api/candidates?q=${p4(2)}`)).data.items.find((c) => String(c.phone) === p4(2));
    ok("T3: an empty cell stores nothing under that column", cB?.custom_fields?.["WhatsApp Group"] === undefined && cB?.custom_fields?.Sponsor === "SelfPay", JSON.stringify(cB?.custom_fields));
    // Unticked (no accept flag) → ignored, like before.
    const rows5 = [{ "Student Name": `FL Cust C ${stamp}`, "Mobile": p4(3), "Sponsor": "IgnoreMe" }];
    const wb5 = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb5, XLSX.utils.json_to_sheet(rows5), "Sheet1");
    const file5 = new File([XLSX.write(wb5, { type: "buffer", bookType: "xlsx" })], "import-custom2.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await multipart(admin, "/api/candidates/import", { file: file5, location: loc._id, program: prog._id, mapping: custMap, confirm: "1" }, 201);
    const cC = (await req(admin, "GET", `/api/candidates?q=${p4(3)}`)).data.items.find((c) => String(c.phone) === p4(3));
    ok("T3: without accept the unknown column is ignored (today's behaviour)", cC && cC.custom_fields == null, JSON.stringify(cC?.custom_fields));

    // ---- QA-110 (-73): being ignored is never silent any more — both answers SAY it. ----
    const prevIgn = await multipart(admin, "/api/candidates/import", { file: mkFile(), location: loc._id, program: prog._id, mapping: custMap }, 200);
    ok("QA-110: preview without accept names the columns about to be DROPPED",
      (prevIgn.data.ignored_columns ?? []).includes("Sponsor") && (prevIgn.data.extra_columns_stored ?? []).length === 0,
      JSON.stringify([prevIgn.data.ignored_columns, prevIgn.data.extra_columns_stored]));
    const prevAcc = await multipart(admin, "/api/candidates/import", { file: mkFile(), location: loc._id, program: prog._id, mapping: custMap, accept_unknown: "1" }, 200);
    ok("QA-110: preview with accept reports them as STORED, ignored empty",
      (prevAcc.data.ignored_columns ?? []).length === 0 && (prevAcc.data.extra_columns_stored ?? []).includes("Sponsor"),
      JSON.stringify([prevAcc.data.ignored_columns, prevAcc.data.extra_columns_stored]));
    const rows6 = [{ "Student Name": `FL Cust D ${stamp}`, "Mobile": p4(4), "Sponsor": "IgnoreMe2" }];
    const wb6 = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb6, XLSX.utils.json_to_sheet(rows6), "Sheet1");
    const file6 = new File([XLSX.write(wb6, { type: "buffer", bookType: "xlsx" })], "import-custom3.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const conf6 = await multipart(admin, "/api/candidates/import", { file: file6, location: loc._id, program: prog._id, mapping: custMap, confirm: "1" }, 201);
    ok("QA-110: the CONFIRM response also carries ignored_columns (the operator's last chance to notice)",
      (conf6.data.ignored_columns ?? []).includes("Sponsor"), JSON.stringify(conf6.data.ignored_columns));
  }
}

console.log("\n--- FL7: an unregistered candidate can still be assigned (decoupled, by design) ---");
{
  // GD-78/80: registration and batch-assignment are separate facilities; assignment must not
  // demand prior SIDH registration — the readiness gate reports the shortfall instead.
  const c = (await req(admin, "POST", "/api/candidates", { name: `FL Unreg ${stamp}`, phone: phone(), location: loc._id, program: prog._id }, 201)).data.item;
  const b = (await req(admin, "POST", "/api/batches", {
    location: loc._id, program: prog._id, planned_start: new Date(Date.now() + 40 * 864e5 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
  }, 201)).data.item;
  const add = await req(admin, "POST", `/api/batches/${b._id}/members`, { candidate: c._id });
  ok("FL7: assignment succeeds although SIDH status is Not Registered", add.status === 201, `got ${add.status}`);
}

console.log("\n--- FL8: the day holds two slotted batches per trainer, never three ---");
{
  // GD-118/123: "chaar-chaar ghante ke do batch" — up to 4 concurrent, but 2 slotted per DAY.
  const tr = (await req(admin, "POST", "/api/trainers", {
    name: `FL Slots ${stamp}`, phone: phone(), skills: [`fl${stamp}`], pipeline_status: "Certified",
    available_from: new Date(Date.now() - 30 * 864e5 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10), max_concurrent_batches: 4,
  }, 201)).data.item;
  const start = new Date(Date.now() + 50 * 864e5 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  const mk = (s, e) => req(admin, "POST", "/api/batches", {
    location: loc._id, program: prog._id, trainer: tr._id, planned_start: start, slot_start: s, slot_end: e,
  });
  ok("FL8: first 4h slot books", (await mk("09:00", "13:00")).status === 201);
  ok("FL8: second, non-overlapping 4h slot books", (await mk("14:00", "18:00")).status === 201);
  const third = await mk("13:00", "14:00");
  ok("FL8: a third slotted batch the same day is refused", third.status >= 400, `got ${third.status}`);
  // A batch runs ~35 calendar days (30 + 5 buffer), so "another day" must mean AFTER the first
  // two end — a start inside their range still clashes on the daily slot, and rightly so.
  const later = await req(admin, "POST", "/api/batches", {
    location: loc._id, program: prog._id, trainer: tr._id,
    planned_start: new Date(Date.now() + 150 * 864e5 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10), slot_start: "10:00", slot_end: "14:00",
  });
  ok("FL8: the same slot after the earlier batches END is fine", later.status === 201, `got ${later.status}`);
}

console.log("\n--- FL9: trainer import — stages by display name, nominations by centre/role name ---");
{
  // QA-1136: this file's own trainer-import route is one of the six UNCOVERED
  // HALTED_LOCATION_STATUSES readers - route.ts:184 leaves nominated_for_location blank (F-B5:
  // "a halted centre does not hire") when the row's centre name resolves to a halted centre, and
  // no suite ever drove a row through it. Stamped so a warm DB cannot collide with itself.
  const fl9HaltLoc = (await req(admin, "POST", "/api/locations", { code: "FL9H" + stamp, name: `FL9 Halted ${stamp}`, approval_status: "Approved", operational_status: "Stopped" }, 201)).data.item;
  const rows = [
    { "Name": `FL Tr A ${stamp}`, "Phone": "9822200001", "Stage": "TOT Payment Done", "Centre": loc.name, "Role": prog.name, "TR": "", "Skill": "" },
    { "Name": `FL Tr B ${stamp}`, "Phone": "9822200002", "Stage": "Random Stage", "Centre": "No Such Centre", "Role": "", "TR": "", "Skill": "" },
    { "Name": `FL Tr C ${stamp}`, "Phone": "9822200001", "Stage": "", "Centre": "", "Role": "", "TR": "", "Skill": "" }, // same phone as A
    { "Name": `FL Tr D ${stamp}`, "Phone": "9822200004", "Stage": "Certified", "Centre": "", "Role": "", "TR": "", "Skill": "" }, // Certified without TR ID
    // -132 (QA-281): the EXACT string that landed on eight live trainers at 2026-08-17T08:04 — the
    // same words as a real job role in a different order. One spreadsheet column, read verbatim.
    { "Name": `FL Tr E ${stamp}`, "Phone": `77${stamp}05`.slice(0, 10), "Stage": "", "Centre": "", "Role": "", "TR": "", "Skill": `Battery Repair System Technician ${stamp}` },
    { "Name": `FL Tr F ${stamp}`, "Phone": `77${stamp}06`.slice(0, 10), "Stage": "", "Centre": "", "Role": "", "TR": "", "Skill": "Totally Made Up Role" },
    // QA-1136 (site: route.ts:184) - a REAL, resolvable centre name that is halted, distinct from
    // row B's "No Such Centre" (unmatched) case just above.
    { "Name": `FL Tr G ${stamp}`, "Phone": `77${stamp}07`.slice(0, 10), "Stage": "", "Centre": fl9HaltLoc.name, "Role": "", "TR": "", "Skill": "" },
  ];
  // -132 (QA-281): the near-match only means something if the correct spelling is a role we KNOW, so
  // put it in the job-roles master first. Stamped, so a warm DB does not collide with itself.
  await req(admin, "POST", "/api/master-lists/job-roles", { name: `Battery System Repair Technician ${stamp}` }, 201);
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const file = new File([buf], "trainers-probe.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

  const step1 = await multipart(admin, "/api/trainers/import", { file }, 200);
  ok("FL9: step 1 returns the columns", (step1.data.columns ?? []).includes("Stage"), JSON.stringify(step1.data.columns));

  const mapping = JSON.stringify({ "Name": "name", "Phone": "phone", "Stage": "pipeline_status", "Centre": "nominated_for_location", "Role": "nominated_for_program", "TR": "tr_id", "Skill": "skills" });
  const prev = await multipart(admin, "/api/trainers/import", { file, mapping }, 200);
  ok("FL9: the display label resolved, the junk stage is reported not guessed",
    (prev.data.stage_unmatched ?? []).includes("Random Stage") && !(prev.data.stage_unmatched ?? []).includes("TOT Payment Done"),
    JSON.stringify(prev.data.stage_unmatched));
  ok("FL9: the unknown centre is reported", (prev.data.centre_unmatched ?? []).includes("No Such Centre"), JSON.stringify(prev.data.centre_unmatched));
  ok("FL9: the in-file phone duplicate is flagged and excluded (phone is unique)",
    (prev.data.duplicates ?? []).some((d) => /same number as row/.test(d)) && prev.data.importable === 6, JSON.stringify({ dupes: prev.data.duplicates, importable: prev.data.importable }));
  ok("FL9: Certified without a TR ID is warned by name", (prev.data.warnings ?? []).some((w) => /no TR ID/.test(w)), JSON.stringify(prev.data.warnings));
  // QA-1136: row G names a real, halted centre - the nomination must be left BLANK (not silently
  // pointed at a centre that "does not hire", F-B5) and the warning must name the centre and why.
  ok("QA-1136: a halted centre's nomination is warned by name, not silently dropped",
    (prev.data.warnings ?? []).some((w) => new RegExp(`FL9 Halted ${stamp}.*Stopped`).test(String(w)) && /halted centre does not hire/.test(String(w))),
    JSON.stringify((prev.data.warnings ?? []).filter((w) => /Stopped/.test(String(w)))));

  // ---- -132 (QA-281): the skills column is checked like its three neighbours ----
  // It used to be stored verbatim while pipeline_status, nominated_for_location and
  // nominated_for_program — in the SAME loop — each resolved against real records and reported what
  // did not match. That asymmetry is how one wrong string reached eight trainers in one second.
  // It still WARNS rather than blocks (-69's decision, reaffirmed in -128), but a warning that NAMES
  // the near match is what stops a second spelling being created.
  {
    const w = prev.data.warnings ?? [];
    const transposed = w.find((x) => /Battery Repair System Technician/.test(String(x)));
    ok("-132 (QA-281): a job-role value that matches no known role is WARNED at import time",
      !!transposed, JSON.stringify(w));
    ok("-132 (QA-281): ...and the warning NAMES the existing role it is a re-ordering of, so the person can pick it",
      /same words as the existing job role/.test(String(transposed ?? "")) && new RegExp(`Battery System Repair Technician ${stamp}`).test(String(transposed ?? "")),
      String(transposed ?? ""));
    ok("-132 (QA-281): a genuinely unknown role is reported too, but WITHOUT inventing a correction",
      w.some((x) => /Totally Made Up Role/.test(String(x)) && /matches no job role we know/.test(String(x))),
      JSON.stringify(w.filter((x) => /Made Up/.test(String(x)))));
    ok("-132 (QA-281): warning, never blocking — the rows are still importable",
      (prev.data.importable ?? 0) >= 3, String(prev.data.importable));
  }

  const done = await multipart(admin, "/api/trainers/import", { file, mapping, confirm: "1" }, 201);
  // -132 (QA-281) / QA-1136: 6, not 3 — the fixture gained the two job-role rows -132 is about plus
  // QA-1136's own halted-centre row G (imported as a trainer, just without the nomination). The
  // assertion still says exactly what it always said (every unique row lands, the phone duplicate
  // never does); only the size of the fixture changed.
  ok("FL9: confirm imports the 6 unique rows, never the phone dupe", done.data.imported === 6, String(done.data.imported));
  const trA = (await req(admin, "GET", `/api/trainers?q=9822200001`)).data.items.find((t) => t.name === `FL Tr A ${stamp}`);
  ok("FL9: 'Payment Done' (legacy sheet value) landed as 'TOT Payment Done'", trA?.pipeline_status === "TOT Payment Done", trA?.pipeline_status);
  ok("FL9: the centre name resolved to a real nomination", (trA?.nominated_for_location?.name ?? "") === loc.name, JSON.stringify(trA?.nominated_for_location));
  const trG = (await req(admin, "GET", `/api/trainers?q=${`77${stamp}07`.slice(0, 10)}`)).data.items.find((t) => t.name === `FL Tr G ${stamp}`);
  ok("QA-1136: the trainer still lands, but with no nomination to the halted centre",
    !!trG && !trG.nominated_for_location, JSON.stringify({ found: !!trG, nom: trG?.nominated_for_location }));

  // 15/08 (Umesh): custom columns ride the trainer importer too.
  const wbT = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbT, XLSX.utils.json_to_sheet([{ "Name": `FL Tr Cust ${stamp}`, "Phone": "9822200005", "Languages": "Hindi, Bhojpuri" }]), "S1");
  const fileT = new File([XLSX.write(wbT, { type: "buffer", bookType: "xlsx" })], "trainers-custom.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const custPrev = await multipart(admin, "/api/trainers/import", { file: fileT, mapping: JSON.stringify({ "Name": "name", "Phone": "phone" }) }, 200);
  ok("T3: trainer preview names the unknown column", (custPrev.data.unknown_columns ?? []).includes("Languages"), JSON.stringify(custPrev.data.unknown_columns));
  await multipart(admin, "/api/trainers/import", { file: fileT, mapping: JSON.stringify({ "Name": "name", "Phone": "phone" }), accept_unknown: "1", confirm: "1" }, 201);
  const trCust = (await req(admin, "GET", `/api/trainers?q=9822200005`)).data.items.find((t) => t.name === `FL Tr Cust ${stamp}`);
  ok("T3: accepted unknown column stored on the trainer", trCust?.custom_fields?.Languages === "Hindi, Bhojpuri", JSON.stringify(trCust?.custom_fields));
}

console.log("\n--- FL10: batch import (QA-028) — centres/roles by name, unknowns reported, codes minted ---");
{
  const rows = [
    { "Centre": loc.name, "Job Role": prog.name, "Start": "2027-04-01", "Size": "24", "Session": "Full Day" },
    { "Centre": "No Such Centre", "Job Role": prog.name, "Start": "2027-04-01", "Size": "", "Session": "" },
    { "Centre": loc.name, "Job Role": "No Such Role", "Start": "2027-04-01", "Size": "", "Session": "" },
    { "Centre": loc.name, "Job Role": prog.name, "Start": "not-a-date", "Size": "", "Session": "" },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "S1");
  const file = new File([XLSX.write(wb, { type: "buffer", bookType: "xlsx" })], "batches-probe.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

  const step1 = await multipart(admin, "/api/batches/import", { file }, 200);
  ok("FL10: step 1 returns the columns", (step1.data.columns ?? []).includes("Centre"), JSON.stringify(step1.data.columns));
  const mapping = JSON.stringify({ "Centre": "location", "Job Role": "program", "Start": "planned_start", "Size": "target_size", "Session": "session" });
  const prev = await multipart(admin, "/api/batches/import", { file, mapping }, 200);
  ok("FL10: exactly one row is importable, three are reported by reason",
    prev.data.valid === 1 && prev.data.skipped_count === 3, JSON.stringify({ v: prev.data.valid, s: prev.data.skipped_count }));
  ok("FL10: the unknown centre and role are named", (prev.data.location_unmatched ?? []).includes("No Such Centre") && (prev.data.program_unmatched ?? []).includes("No Such Role"), JSON.stringify([prev.data.location_unmatched, prev.data.program_unmatched]));
  const conf = await multipart(admin, "/api/batches/import", { file, mapping, confirm: "1" }, 201);
  // -225: this line used to read `len === 1 && /^B\d+/.test(code) || len === 1`, which is just
  // `len === 1` - the code half could never fail it. That is how the importer shipped a whole
  // release minting LEGACY B### codes (its Location select omitted `code`, so nextBatchCode fell
  // into the global-counter branch) with the wall green the entire time. The dead `/^B\d+/` branch
  // suggests someone SAW B### here and encoded it as acceptable. Now it is exact, and the legacy
  // shape is precisely what it refuses.
  // -227: cycle 1 replaced a tautology with an assertion that could never PASS - `\d` inside a
  // template literal is not an escape, it collapses to `d`, so the regex read `^...-d{2,}$`. Same
  // disease, opposite sign, in the very line removing it. No regex over a built string now: compare
  // the prefix literally and test the tail with a character class that has no escape to lose.
  {
    const got = String((conf.data.created ?? [])[0] ?? "");
    const want = `${loc.code}-${prog.code}-`;
    const tail = got.slice(want.length);
    ok("FL10 (-227): the imported batch carries the CENTRE-PROGRAMME-NN code, never the legacy B### fallback",
      (conf.data.created ?? []).length === 1 && got.startsWith(want) && tail.length >= 2 && /^[0-9]+$/.test(tail),
      JSON.stringify({ got, want }));
  }
  const listed = ((await req(admin, "GET", "/api/batches?limit=2000", undefined, 200)).data.items ?? []).find((b) => b.code === conf.data.created[0]);
  ok("FL10: the imported batch carries creator + file provenance",
    !!listed && listed.created_by?.name && /^Import: batches-probe\.xlsx$/.test(listed.source ?? ""), JSON.stringify({ code: listed?.code, by: listed?.created_by?.name, src: listed?.source }));
  ok("FL10 (QA-152, -81): an imported batch carries NO auto plan — planning is on demand", ((await req(admin, "GET", `/api/batches/${listed?._id}`)).data.item?.milestones ?? []).length === 0);
  // cleanup so room/trainer fixtures elsewhere stay unaffected
  await req(admin, "POST", `/api/batches/${listed?._id}/transition`, { target: "Cancelled", reason: "FL10 fixture cleanup" }, 200);

  // 15/08 (Umesh): custom columns ride the batch importer too.
  const wbB = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbB, XLSX.utils.json_to_sheet([{ "Centre": loc.name, "Job Role": prog.name, "Start": "2027-05-01", "Funding": "CSR-2026" }]), "S1");
  const fileB = new File([XLSX.write(wbB, { type: "buffer", bookType: "xlsx" })], "batches-custom.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const bMap = JSON.stringify({ "Centre": "location", "Job Role": "program", "Start": "planned_start" });
  const bPrev = await multipart(admin, "/api/batches/import", { file: fileB, mapping: bMap }, 200);
  ok("T3: batch preview names the unknown column", (bPrev.data.unknown_columns ?? []).includes("Funding"), JSON.stringify(bPrev.data.unknown_columns));
  const bConf = await multipart(admin, "/api/batches/import", { file: fileB, mapping: bMap, accept_unknown: "1", confirm: "1" }, 201);
  const bCust = ((await req(admin, "GET", "/api/batches?limit=2000", undefined, 200)).data.items ?? []).find((b) => b.code === (bConf.data.created ?? [])[0]);
  ok("T3: accepted unknown column stored on the batch", bCust?.custom_fields?.Funding === "CSR-2026", JSON.stringify(bCust?.custom_fields));
  await req(admin, "POST", `/api/batches/${bCust?._id}/transition`, { target: "Cancelled", reason: "T3 fixture cleanup" }, 200);
}

console.log("\n--- -155 (QA-414 S1 / 415 / 424 / 425 / 426): the portal ID lands, over the catalog ---");
{
  // 55 live candidates hold their portal ID in id_reference because the mapping screen never
  // offered sidh_candidate_id and the writer would have dropped it anyway. These pins walk the
  // whole door: offered -> written -> readable, plus the refusals that make silence impossible.
  const can = `CAN_${stamp}77001`;
  const rows = [{
    "Student Name": `PI Land ${stamp}`, "Mobile": "9822200001", "Candidate ID": can,
    "Email": `pi${stamp}@t.local`, "Reg Status": "Registered", "Edu": "12th Pass",
  }];
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const file = new File([XLSX.write(wb, { type: "buffer", bookType: "xlsx" })], "portal-id.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const mapping = JSON.stringify({
    "Student Name": "name", "Mobile": "phone", "Candidate ID": "sidh_candidate_id",
    "Email": "email", "Reg Status": "sidh_status", "Edu": "education",
  });

  const conf = await multipart(admin, "/api/candidates/import", { file, location: loc._id, program: prog._id, mapping, confirm: "1" });
  // FIXTURE, not a regression pin - pre-fix this also returns 201 (the unknown field is silently
  // dropped, which IS the defect); the discriminator is the LANDS pin right below.
  ok("-155 (QA-414/415) fixture: a mapped Candidate ID column imports at all", conf.status === 201 && conf.data.imported === 1, JSON.stringify({ s: conf.status, d: conf.data }));
  const landed = ((await req(admin, "GET", `/api/candidates?q=${encodeURIComponent(can)}&limit=5`, undefined, 200)).data.items ?? [])[0];
  const detail = landed ? (await req(admin, "GET", `/api/candidates/${landed._id}`, undefined, 200)).data.item : null;
  ok("-155 (QA-414 S1): the value LANDS in sidh_candidate_id - the field both government matchers join on",
    detail?.sidh_candidate_id === can, JSON.stringify({ sidh: detail?.sidh_candidate_id, id_ref: detail?.id_reference }));
  ok("-155 (QA-425): the other mapped fields round-trip through the same catalog-driven door",
    detail?.email === `pi${stamp}@t.local` && detail?.sidh_status === "Registered" && detail?.education === "12th Pass",
    JSON.stringify({ email: detail?.email, sidh_status: detail?.sidh_status, education: detail?.education }));

  // QA-426: a mapped field NO branch handles is reported, never silently dropped. sidh_link_sent_at
  // is a real Candidate field that the import deliberately does not offer or handle.
  const prev2 = await multipart(admin, "/api/candidates/import", {
    file, location: loc._id, program: prog._id,
    mapping: JSON.stringify({ "Student Name": "name", "Mobile": "phone", "Candidate ID": "sidh_link_sent_at" }),
  }, 200);
  // QA-1233 (checker, qa-1191 cycle 1): this asserted MEMBERSHIP, so a field wrongly named as
  // unhandled rode along free - the wall was 3907/0 green with batch_interest sitting in this list
  // claiming the importer discards it. A report lane is only honest if it names the unhandled fields
  // and NO others, so the assertion is now the exact set.
  ok("-155 (QA-426): the preview names the mapped-but-unhandled destination - and NOTHING ELSE (a false name here is a lie about what the importer discards)",
    JSON.stringify([...(prev2.data.unhandled_fields ?? [])].sort()) === JSON.stringify(["sidh_link_sent_at"]),
    JSON.stringify(prev2.data.unhandled_fields));

  // QA-448 (REQ-385): QA-425 above spot-checks THREE fields by hand - exactly the species of
  // hand-maintained list that cost 55 records (QA-414). This loop is the mechanical version:
  // it walks every non-identity, non-list key CANDIDATE_IMPORT_FIELDS actually offers today
  // (imported live from field-catalog.ts, not copied), so it goes red the day a field STOPS
  // being offered - not just the day one of the three hand-picked ones breaks.
  //
  // FIELD_TESTS below is the INDEPENDENT half that makes this a real mutation-detector rather
  // than a loop testing itself: it is hand-authored, not derived from the catalog, so (a) a
  // catalog key silently REMOVED still fails here (the "is it in CANDIDATE_IMPORT_FIELDS"
  // assertion below), and (b) a NEW catalog key with no entry here fails LOUD instead of
  // silently riding along untested (the "no FIELD_TESTS entry" branch below) - the exact shape
  // of defect QA-425/QA-448 exist to catch, proved failing by construction rather than assumed.
  {
    const { CANDIDATE_IMPORT_FIELDS } = await import("../src/lib/field-catalog.ts");
    // Always the identity/dedup key on every import in this whole suite - not re-tested here.
    const IDENTITY_EXCLUDED = new Set(["name", "phone"]);
    // Resolve by NAME against real Program/Location documents (list-typed) - a generic
    // single-cell round-trip can't synthesize a matching entity safely; documented exclusion,
    // same shape as location/program's own exclusion from CANDIDATE_IMPORT_FIELDS itself.
    const LIST_TYPE_EXCLUDED = new Set(["interested_programs", "interested_locations"]);
    const FIELD_TESTS = {
      alt_phone: { cell: "97" + stamp.slice(-8), expect: (v, sent) => v === sent },
      gender: { cell: "Female", expect: (v) => v === "Female" },
      dob: { cell: "15-06-2001", expect: (v) => typeof v === "string" && v.slice(0, 10) === "2001-06-15" },
      education: { cell: "12th Pass", expect: (v) => v === "12th Pass" },
      source: { cell: `QA448-${stamp}`, expect: (v, sent) => v === sent },
      sidh_status: { cell: "Registered", expect: (v) => v === "Registered" },
      sidh_candidate_id: { cell: `CAN_${stamp}9Q`, expect: (v, sent) => v === sent },
      apaar_id: { cell: "190305516099", expect: (v) => v === "190305516099" },
      email: { cell: `q448.${stamp}@t.local`, expect: (v, sent) => v === sent },
      aadhaar_no: { cell: "234567890123", expect: (v) => v === "234567890123" },
      batch_interest: { cell: "current", expect: (v) => v === "Current" },
      id_reference: { cell: `IDREF-${stamp}`, expect: (v, sent) => v === sent },
      last_training_date: { cell: "01-01-2024", expect: (v) => typeof v === "string" && v.slice(0, 10) === "2024-01-01" },
    };
    const catalogKeys = new Set(CANDIDATE_IMPORT_FIELDS.map((f) => f.key));
    const tested = new Set();
    for (const [key, t] of Object.entries(FIELD_TESTS)) {
      if (!catalogKeys.has(key)) {
        ok(`QA-448: "${key}" is still offered by CANDIDATE_IMPORT_FIELDS`, false,
          "field-catalog.ts no longer offers this key - either update this suite's FIELD_TESTS (deliberate removal) or the catalog regressed");
        continue;
      }
      const uniquePhone = "96" + String(Date.now() + tested.size).slice(-8);
      const rowsQ = [{ "Name": `Q448 ${key} ${stamp}`, "Phone": uniquePhone, "V": t.cell }];
      const wsQ = XLSX.utils.json_to_sheet(rowsQ);
      const wbQ = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wbQ, wsQ, "S1");
      const fileQ = new File([XLSX.write(wbQ, { type: "buffer", bookType: "xlsx" })], `q448-${key}.xlsx`, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const mappingQ = JSON.stringify({ "Name": "name", "Phone": "phone", "V": key });
      const confQ = await multipart(admin, "/api/candidates/import", { file: fileQ, location: loc._id, program: prog._id, mapping: mappingQ, confirm: "1" }, 201);
      ok(`QA-448: "${key}" is accepted (offered+written), not dropped`, confQ.status === 201 && confQ.data.imported === 1, JSON.stringify({ key, status: confQ.status, data: confQ.data }));
      const landedQ = ((await req(admin, "GET", `/api/candidates?q=${encodeURIComponent(uniquePhone)}&limit=5`, undefined, 200)).data.items ?? [])[0];
      const detailQ = landedQ ? (await req(admin, "GET", `/api/candidates/${landedQ._id}`, undefined, 200)).data.item : null;
      ok(`QA-448: "${key}" round-trips through the detail route`, !!detailQ && t.expect(detailQ[key], t.cell), JSON.stringify({ key, got: detailQ?.[key], sent: t.cell }));
      tested.add(key);
    }
    const eligible = [...catalogKeys].filter((k) => !IDENTITY_EXCLUDED.has(k) && !LIST_TYPE_EXCLUDED.has(k));
    ok("QA-448 (REQ-385): every loop-eligible catalog key has a FIELD_TESTS entry - a NEW key ships tested or fails here, not silently untested",
      eligible.every((k) => Object.prototype.hasOwnProperty.call(FIELD_TESTS, k)),
      JSON.stringify({ eligible, missing: eligible.filter((k) => !Object.prototype.hasOwnProperty.call(FIELD_TESTS, k)) }));
  }

  // QA-179 (2026-09-02, Manish 17/08 + Umesh 17/08): the trainer-triggered "tell the candidates
  // their assessment date" send. Real mail is never pressed here (this wall runs against a test
  // database - lib/mailer.ts's testEnvironmentShape() suppresses every send structurally - so
  // sendMail always returns "skipped", never "sent", and the assertions below are written for
  // that): the proof this block gives is that the route REFUSES correctly, mints one link per
  // enrolled candidate, attempts (and logs) exactly one mail per enrolled candidate with no one
  // silently dropped, and reports the count back honestly - not that a real inbox receives mail.
  {
    const c1 = (await req(admin, "POST", "/api/candidates", { name: `FL179 A ${stamp}`, phone: phone(), email: `fl179a.${stamp}@t.local`, location: loc._id, program: prog._id }, 201)).data.item;
    const c2 = (await req(admin, "POST", "/api/candidates", { name: `FL179 B ${stamp}`, phone: phone(), location: loc._id, program: prog._id }, 201)).data.item; // deliberately NO email
    const b179 = (await req(admin, "POST", "/api/batches", {
      location: loc._id, program: prog._id, target_size: 2,
      planned_start: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
    }, 201)).data.item;
    await req(admin, "POST", `/api/batches/${b179._id}/members`, { candidate: c1._id }, 201);
    await req(admin, "POST", `/api/batches/${b179._id}/members`, { candidate: c2._id }, 201);

    // Refusal BEFORE a date is ever saved - the safety requirement the ledger row itself named:
    // "the first press mails every candidate a blank date and cannot be recalled".
    const refused = await req(admin, "POST", `/api/batches/${b179._id}/closure/notify-assessment`, {}, 409);
    ok("QA-179: refuses to notify when no assessment date is saved yet", refused.status === 409, JSON.stringify(refused.data));

    await req(admin, "PUT", `/api/batches/${b179._id}/closure`, { assessment_date: "2026-10-15" }, 200);
    const sent = (await req(admin, "POST", `/api/batches/${b179._id}/closure/notify-assessment`, {}, 200)).data;
    ok("QA-179: once a date is saved, both enrolled candidates are attempted - nobody silently dropped",
      sent.total === 2, JSON.stringify(sent));
    ok("QA-179: the mailable candidate is not reported as skipped for a bad reason (only the test-suppression path applies here)",
      !sent.skipped.find((s) => s.name.includes("FL179 A"))
      || /test environment/i.test(sent.skipped.find((s) => s.name.includes("FL179 A")).reason),
      JSON.stringify(sent.skipped));
    ok("QA-179: the candidate with no email on record is reported by name, not silently skipped",
      sent.skipped.some((s) => s.name.includes("FL179 B") && /recipient address/i.test(s.reason)), JSON.stringify(sent.skipped));

    // MailLog is the audit trail QA-115 exists for - both attempts must land there, addressed to
    // the right person, naming the right entity, even though the send itself was suppressed.
    const logs179 = (await req(admin, "GET", "/api/test-email", undefined, 200)).data.log ?? [];
    const rowA = logs179.find((l) => l.to === `fl179a.${stamp}@t.local`);
    ok("QA-179: the mailable candidate's attempt is in MailLog, subject carries the date", !!rowA && /15 October 2026/.test(rowA.subject ?? ""), JSON.stringify(rowA));

    // A second press must not mint a SECOND link per candidate - notify-assessment reuses the
    // same idempotent mintMemberLinks door the roster's own "share attendance links" action uses.
    const countLinks = (items) => items.filter((l) => l.batch_member && [c1._id, c2._id].map(String).includes(String(l.batch_member.candidate?._id))).length;
    const linksBefore = (await req(admin, "GET", `/api/public-tokens?purpose=attendance`, undefined, 200)).data.items ?? [];
    const countBefore = countLinks(linksBefore);
    await req(admin, "POST", `/api/batches/${b179._id}/closure/notify-assessment`, {}, 200);
    const linksAfter = (await req(admin, "GET", `/api/public-tokens?purpose=attendance`, undefined, 200)).data.items ?? [];
    const countAfter = countLinks(linksAfter);
    ok("QA-179: a second notify press reuses the same links rather than minting new ones", countAfter === countBefore && countBefore === 2, JSON.stringify({ countBefore, countAfter }));
  }

  // QA-491 (REQ-389a, Umesh: "har jagah, bina exception"): the three server-side person lists
  // that back a closure REFUSAL must name people the same way the client tooltip that warned
  // about them already does - portal ID when present, otherwise phone. Two faults measured live
  // on -161: Rule 43's refusal named NOBODY for a roster member with no CandidateResult row yet
  // (the exact case the gate exists to catch - the name was read off the row, not the roster),
  // and Rule 46 / the noCan gate both used bare names with no separator for two same-name people.
  {
    const c491pass = (await req(admin, "POST", "/api/candidates", { name: `FL491PASS ${stamp}`, phone: phone(), location: loc._id, program: prog._id }, 201)).data.item;
    const c491p1 = (await req(admin, "POST", "/api/candidates", { name: `FL491DUP ${stamp}`, phone: phone(), location: loc._id, program: prog._id }, 201)).data.item;
    const c491p2 = (await req(admin, "POST", "/api/candidates", { name: `FL491DUP ${stamp}`, phone: phone(), location: loc._id, program: prog._id }, 201)).data.item; // same name as c491p1 on purpose (REQ-389a boundary)
    const b491 = (await req(admin, "POST", "/api/batches", {
      location: loc._id, program: prog._id, target_size: 3,
      planned_start: new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
    }, 201)).data.item;
    const m491pass = (await req(admin, "POST", `/api/batches/${b491._id}/members`, { candidate: c491pass._id }, 201)).data.item;
    const m491p1 = (await req(admin, "POST", `/api/batches/${b491._id}/members`, { candidate: c491p1._id }, 201)).data.item;
    const m491p2 = (await req(admin, "POST", `/api/batches/${b491._id}/members`, { candidate: c491p2._id }, 201)).data.item;
    for (const m of [m491pass, m491p1, m491p2]) await req(admin, "PATCH", `/api/members/${m._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);

    // One Pass row exists (switches the batch into per-candidate mode, batchUsesPerCandidateResults);
    // the other two members deliberately have NO CandidateResult row at all - exactly the case
    // assessmentCompleteness walks the ROSTER (not the rows) to catch. Pre-fix, their name was
    // read off the nonexistent row, so the refusal named nobody at all.
    await req(admin, "PUT", `/api/batches/${b491._id}/results`, { rows: [{ member: m491pass._id, result: "Pass" }] }, 200);
    await req(admin, "PUT", `/api/batches/${b491._id}/closure`, { assessment_date: "2026-10-20" }, 200);
    const r43 = await req(admin, "PUT", `/api/batches/${b491._id}/closure`, { assessment_status: "Completed" }, 409);
    ok("QA-491: Rule 43's refusal names the pending candidates, not nobody",
      r43.data.error?.includes("FL491DUP"), JSON.stringify(r43.data));
    ok("QA-491: Rule 43's refusal separates the two same-name pending candidates by phone",
      r43.data.error?.includes(c491p1.phone) && r43.data.error?.includes(c491p2.phone), JSON.stringify(r43.data));

    // noCan gate: both DUP members are enrolled (Completed), no portal Candidate ID on record,
    // and share a name - the REQ-389a boundary case ("har jagah, bina exception").
    const r46noCan = await req(admin, "PUT", `/api/batches/${b491._id}/closure`, { certification_status: "Completed" }, 409);
    ok("QA-491: the noCan refusal names the candidates missing a portal ID, not just a count",
      r46noCan.data.error?.includes("FL491DUP"), JSON.stringify(r46noCan.data));
    ok("QA-491: the noCan refusal separates the two same-name candidates by phone, not silently merging them",
      r46noCan.data.error?.includes(c491p1.phone) && r46noCan.data.error?.includes(c491p2.phone), JSON.stringify(r46noCan.data));
  }

  // QA-1745 (REQ-389a, filed by the checker against qa-491): the TRAINER half of lib/rules.ts.
  // QA-491 routed the three candidate lists through personList and left fifteen bare
  // `Trainer ${name}` / `${t.name}` interpolations standing in the same file. A trainer is a human
  // being and these are server messages a user is shown, so REQ-389a ("har jagah, bina exception")
  // binds them too. Pinned on the Rule 10 slot-clash refusal, which is the one an operator hits
  // routinely, with two same-name trainers so a bare name would be provably ambiguous.
  {
    const trName = `FL1745 TWIN ${stamp}`;
    const tr1 = (await req(admin, "POST", "/api/trainers", {
      name: trName, phone: phone(), skills: [`fl1745${stamp}`],
      nominated_for_location: loc._id, nominated_for_program: prog._id,
    }, 201)).data.item;
    const tr2 = (await req(admin, "POST", "/api/trainers", {
      name: trName, phone: phone(), skills: [`fl1745${stamp}`], // SAME name, different phone
      nominated_for_location: loc._id, nominated_for_program: prog._id,
    }, 201)).data.item;
    ok("QA-1745: two trainers may share a name - the case the separator exists for", tr1._id !== tr2._id && tr1.phone !== tr2.phone, JSON.stringify({ p1: tr1.phone, p2: tr2.phone }));

    const day1745 = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const mk = (extra) => req(admin, "POST", "/api/batches", {
      location: loc._id, program: prog._id, trainer: tr1._id, planned_start: day1745, target_size: 3, ...extra,
    }, extra.expect ?? 201);
    await mk({ slot_start: "09:00", slot_end: "13:00" });
    // Same trainer, same day, overlapping slot -> Rule 10's time-slot clash refusal.
    const clash = await req(admin, "POST", "/api/batches", {
      location: loc._id, program: prog._id, trainer: tr1._id, planned_start: day1745, target_size: 3,
      slot_start: "10:00", slot_end: "14:00",
    }, 409);
    ok("QA-1745: the Rule 10 slot-clash refusal names the trainer at all", clash.data.error?.includes("FL1745 TWIN"), JSON.stringify(clash.data));
    ok("QA-1745: ...and separates the two same-name trainers by phone, so the operator knows WHICH one is double-booked",
      clash.data.error?.includes(tr1.phone) && !clash.data.error?.includes(tr2.phone), JSON.stringify(clash.data));

    // trainerBookingWarnings: a second, independent site in the same file (its own Trainer.findById
    // with its own .select, which had to gain phone + govt_candidate_id for this to be possible).
    const warnB = (await req(admin, "POST", "/api/batches", {
      location: loc._id, program: prog._id, trainer: tr2._id, planned_start: day1745, target_size: 3,
    }, 201)).data;
    // NOTE: the route returns `warning` (singular, joined), not `warnings` — reading the plural
    // key made both assertions below pass vacuously against `[]` on the first draft.
    const warnText = String(warnB.warning ?? "");
    // Written STRICTLY on purpose: the permissive form of this assertion ("either the name is
    // absent or the phone is present") passes vacuously if the warning never fires at all, which
    // would pin nothing. tr2 is a Fresh Lead, so trainerBookingWarnings must produce the
    // not-yet-Certified warning, and it must carry the separator.
    ok("QA-1745: the pipeline-status booking WARNING actually fires for a Fresh Lead trainer",
      warnText.includes("not yet Certified"), warnText);
    // Targeted at THIS sentence, not at the joined blob: the first draft asserted the joined
    // string contained `Name (phone)` and passed even with this site reverted, because the
    // trainer-availability note in the same blob (another site this unit fixed) supplied it.
    // A pin that survives a revert of the line it names is pinning something else.
    const pipelineSentence = warnText.split(" — not yet Certified")[0] ?? "";
    ok("QA-1745: ...and THAT sentence names the trainer with its separator, not bare",
      pipelineSentence.includes(`FL1745 TWIN ${stamp} (${tr2.phone})`), pipelineSentence);
  }

  // QA-1749 + QA-1751 (checker FAIL on qa-1745 cycle 1). Two separate lessons pinned here:
  //   QA-1749 - the trainer sweep missed the CANDIDATE names in the same file, because its verify
  //     grep was scoped to `${t.name}`/`${trainer.name}` - the exact class being fixed. The Rule 51
  //     attendance refusal below is the surface REQ-389's founding failure story is about.
  //   QA-1751 - a `.select()` that stops fetching the separator fields degrades the message to a
  //     bare name while tsc, a tree-wide grep and the whole suite all stay green. Only a
  //     behavioural pin catches it, so the earliest-start note gets one.
  {
    const dupName = `FL1749 SAME ${stamp}`;
    const cA = (await req(admin, "POST", "/api/candidates", { name: dupName, phone: phone(), location: loc._id, program: prog._id }, 201)).data.item;
    const cB = (await req(admin, "POST", "/api/candidates", { name: dupName, phone: phone(), location: loc._id, program: prog._id }, 201)).data.item;
    const tr1749 = (await req(admin, "POST", "/api/trainers", {
      name: `FL1749 TR ${stamp}`, phone: phone(), skills: [`fl1749${stamp}`],
      nominated_for_location: loc._id, nominated_for_program: prog._id,
    }, 201)).data.item;

    const day1749 = new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const room1749 = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: `FL1749 Room ${stamp}`, type: "Classroom", capacity: 30 }, 201)).data.item;
    // target_size 2 with 2 enrolled = 100% roster, and a room, so the batch can reach Active
    // (readiness gates room_assigned + roster_80pct).
    const created = (await req(admin, "POST", "/api/batches", {
      location: loc._id, program: prog._id, trainer: tr1749._id, room: room1749._id, planned_start: day1749, target_size: 2,
    }, 201)).data;

    // QA-1751: the trainer-availability note comes from earliestPossibleStart's OWN .select(),
    // a different fetch from the two the pipeline warning uses. Reverting just that .select()
    // leaves tsc/grep/suite green, so this pin is the only thing standing under it.
    // Targeted at the availability SENTENCE, not the joined blob. The blob also carries the
    // pipeline warning, which names the same trainer with the same separator from a DIFFERENT
    // fetch - so a blob-wide assertion passes even with this .select() reverted. That mistake was
    // made twice in this unit (cycle 1 on the pipeline sentence, cycle 2 here) before being caught
    // by mutation both times; a pin that survives a revert of the line it names pins nothing.
    const noteText = String(created.warning ?? "");
    const availSentence = (noteText.match(/[^.]*(?:is free from|has no availability date on file|is at the \d+-batch cap)[^.]*/) ?? [""])[0];
    ok("QA-1751: the earliest-start trainer note fires at all", availSentence.length > 0, noteText);
    ok("QA-1751: ...and THAT sentence carries the separator, not a bare name",
      availSentence.includes(`FL1749 TR ${stamp} (${tr1749.phone})`), availSentence || noteText);

    const b1749 = created.item;
    const mA = (await req(admin, "POST", `/api/batches/${b1749._id}/members`, { candidate: cA._id }, 201)).data.item;
    const mB = (await req(admin, "POST", `/api/batches/${b1749._id}/members`, { candidate: cB._id }, 201)).data.item;
    for (const m of [mA, mB]) await req(admin, "PATCH", `/api/members/${m._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
    await req(admin, "POST", `/api/batches/${b1749._id}/transition`, { target: "Ready" }, 200);
    await req(admin, "POST", `/api/batches/${b1749._id}/transition`, { target: "Active" }, 200);

    // QA-1749 / Rule 51: biometric-done but not present. Two candidates share a name, so a bare
    // name in this refusal cannot tell the operator which student to tick.
    const r51 = await req(admin, "POST", `/api/batches/${b1749._id}/logs`, {
      log_date: day1749, present_member_ids: [String(mA._id)], biometric_member_ids: [String(mB._id)], actual_topic: "QA-1749",
    }, 400);
    ok("QA-1749: the Rule 51 attendance refusal names the student at all", r51.data.error?.includes("FL1749 SAME"), JSON.stringify(r51.data));
    ok("QA-1749: ...and separates the two same-name students by phone - the surface REQ-389 was written for",
      r51.data.error?.includes(cB.phone) && !r51.data.error?.includes(cA.phone), JSON.stringify(r51.data));
  }

  // Umesh ("blank ko accept hi kyun kar raha hai - it should ask"): a mapped column whose cells
  // are EMPTY is reported per column - never blocked (a fresh roster legitimately has no CANs),
  // never silent (an all-blank mapped column is what a mis-aligned sheet looks like).
  const rows3 = [
    { "Student Name": `PI Blank A ${stamp}`, "Mobile": "9822200002", "Candidate ID": "" },
    { "Student Name": `PI Blank B ${stamp}`, "Mobile": "9822200003", "Candidate ID": "" },
  ];
  const ws3 = XLSX.utils.json_to_sheet(rows3);
  const wb3 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb3, ws3, "Sheet1");
  const file3 = new File([XLSX.write(wb3, { type: "buffer", bookType: "xlsx" })], "blanks.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const prev3 = await multipart(admin, "/api/candidates/import", {
    file: file3, location: loc._id, program: prog._id,
    mapping: JSON.stringify({ "Student Name": "name", "Mobile": "phone", "Candidate ID": "sidh_candidate_id" }),
  }, 200);
  ok("-155: an all-blank mapped column is counted per field on the preview",
    prev3.data.blank_by_field?.sidh_candidate_id === 2 && prev3.data.row_count === 2, JSON.stringify(prev3.data.blank_by_field));
  const conf3 = await multipart(admin, "/api/candidates/import", { file: file3, location: loc._id, program: prog._id, mapping: JSON.stringify({ "Student Name": "name", "Mobile": "phone", "Candidate ID": "sidh_candidate_id" }), confirm: "1" }, 201);
  // PAIRED with the blank_by_field pin above (which fails pre-fix). Pre-fix this passes for a
  // boring reason - the field was never written at all - so it is labelled, not counted.
  ok("-155 (QA-417 groundwork, paired): blank cells import as ABSENT, never as empty-string",
    conf3.data.imported === 2, JSON.stringify(conf3.data));
  const blankA = ((await req(admin, "GET", `/api/candidates?q=${encodeURIComponent(`PI Blank A ${stamp}`)}&limit=5`, undefined, 200)).data.items ?? [])[0];
  const blankDetail = blankA ? (await req(admin, "GET", `/api/candidates/${blankA._id}`, undefined, 200)).data.item : null;
  ok("-155 (paired): ...verified on the record itself", blankDetail != null && (blankDetail.sidh_candidate_id == null || blankDetail.sidh_candidate_id === undefined), JSON.stringify({ sidh: blankDetail?.sidh_candidate_id }));

  // QA-417: one portal ID, at most one candidate - enforced by the DATABASE.
  const dup = await req(admin, "POST", "/api/candidates", { name: `PI Dup ${stamp}`, phone: "9822200004", location: loc._id, program: prog._id, sidh_candidate_id: can });
  ok("-155 (QA-417): a second candidate claiming the same portal ID is refused by the unique index",
    dup.status === 409, `got ${dup.status}: ${JSON.stringify(dup.data).slice(0, 120)}`);
}

console.log("\n--- -155 (QA-427): the portal-ID health screen - see it, select it, fix it ---");
{
  // Seed the three fixable states deliberately.
  const canM = `CAN_${stamp}77101`;
  const m1 = (await req(admin, "POST", "/api/candidates", { name: `PH Misfiled ${stamp}`, phone: "9822200011", location: loc._id, program: prog._id, id_reference: canM }, 201)).data.item;
  const m3 = (await req(admin, "POST", "/api/candidates", { name: `PH MisfiledB ${stamp}`, phone: "9822200012", location: loc._id, program: prog._id, id_reference: `CAN_${stamp}77102` }, 201)).data.item;
  // -156 (QA-450): this fixture used to be the proof that "" reaches the database - it posted an
  // empty portal ID and the empty_strings group found it. That was the defect, not the feature: ""
  // IS a string, so the QA-417 partial unique index indexed it, and the SECOND person saved with a
  // blank field was refused with "That sidh candidate id is already in use." - a duplicate identity
  // that does not exist. The door now stores absence, so the fixture proves the door instead.
  const m2 = (await req(admin, "POST", "/api/candidates", { name: `PH Empty ${stamp}`, phone: "9822200013", location: loc._id, program: prog._id, sidh_candidate_id: "" }, 201)).data.item;
  const m2Read = (await req(admin, "GET", `/api/candidates/${m2._id}`, undefined, 200)).data.item;
  // == null, not !value: "" is FALSY, so the first draft of this line passed on the very state it
  // exists to forbid. The distinction between "" and absent IS the issue.
  ok("-156 (QA-450): a blank portal ID is stored as ABSENT, never as \"\" - absence of an identity is not an identity",
    m2Read?.sidh_candidate_id == null, JSON.stringify({ stored: m2Read?.sidh_candidate_id ?? "(absent)" }));
  const m2b = await req(admin, "POST", "/api/candidates", { name: `PH Empty B ${stamp}`, phone: "9822200014", location: loc._id, program: prog._id, sidh_candidate_id: "" });
  ok("-156 (QA-450): a SECOND person with no portal ID is not a collision with the first",
    m2b.status === 201, `got ${m2b.status}: ${JSON.stringify(m2b.data).slice(0, 140)}`);
  const m2c = await req(admin, "PATCH", `/api/candidates/${m2._id}`, { sidh_candidate_id: "   " });
  const m2cRead = (await req(admin, "GET", `/api/candidates/${m2._id}`, undefined, 200)).data.item;
  ok("-156 (QA-450): and clearing the field through the edit door clears it, rather than storing whitespace",
    m2c.status === 200 && m2cRead?.sidh_candidate_id == null, JSON.stringify({ s: m2c.status, stored: m2cRead?.sidh_candidate_id ?? "(absent)" }));

  const plan1 = (await req(admin, "GET", "/api/candidates/portal-id-health", undefined, 200)).data;
  // -156 (QA-450): the empty_strings clause is gone from this assertion because no door can create
  // that state any more - it is now a HISTORICAL group, cleaning rows written before -156, and the
  // suite cannot construct one to select. That loss is disclosed rather than papered over: the
  // set_null apply path is exercised by no pin after this change, and the group's presence on the
  // payload is covered by the six-groups assertion in e2e-govt.
  ok("-155 (QA-427): the plan finds the misfiled CAN - the 55-class - on both candidates",
    (plan1.misfiled ?? []).some((x) => String(x.candidate) === String(m1._id))
      && (plan1.misfiled ?? []).some((x) => String(x.candidate) === String(m3._id)),
    JSON.stringify({ misfiled: (plan1.misfiled ?? []).length, empty: (plan1.empty_strings ?? []).length }));

  // SELECTED-ONLY is the contract: fix m1, leave m3 exactly as it is.
  const applied = await req(admin, "POST", "/api/candidates/portal-id-health", { copy: [m1._id] });
  ok("-155 (QA-427): apply fixes ONLY the selected rows", applied.status === 200 && applied.data.copied === 1, JSON.stringify(applied.data));
  const m1After = (await req(admin, "GET", `/api/candidates/${m1._id}`, undefined, 200)).data.item;
  const m3After = (await req(admin, "GET", `/api/candidates/${m3._id}`, undefined, 200)).data.item;
  ok("-155 (QA-427): the copy lands in the matcher's field and id_reference is untouched",
    m1After?.sidh_candidate_id === canM && m1After?.id_reference === canM, JSON.stringify({ sidh: m1After?.sidh_candidate_id, ref: m1After?.id_reference }));
  ok("-155 (QA-427): the UNSELECTED row is untouched - wholesale fixes are not a thing here",
    !m3After?.sidh_candidate_id, JSON.stringify({ sidh: m3After?.sidh_candidate_id }));

  // Refusal on re-verify: give m3 a DIFFERENT id by hand, then ask the screen to copy - it must
  // refuse rather than overwrite, because the plan is recomputed at write time.
  await req(admin, "PATCH", `/api/candidates/${m3._id}`, { sidh_candidate_id: `CAN_${stamp}77999` }, 200);
  const refused = await req(admin, "POST", "/api/candidates/portal-id-health", { copy: [m3._id] });
  ok("-155 (QA-427 / REQ-381): a value that appeared since the plan was read is never overwritten",
    refused.status === 200 && refused.data.copied === 0 && (refused.data.refused ?? []).length === 1,
    JSON.stringify(refused.data));

  // An empty selection is a mistake, not a mass-fix.
  const empty = await req(admin, "POST", "/api/candidates/portal-id-health", {});
  ok("-155 (QA-427): an empty selection is refused - nothing is applied wholesale", empty.status === 400, `got ${empty.status}`);
}

console.log("\n--- FL13 (-225): the batch code's number is the count of batches for that centre x programme ---");
{
  // Umesh, 2026-08-24, on AVP-GURU-RPLAVP-DST-04 holding three batches: "the code must be location
  // wise and program wise". Its OWN centre + programme pair, because `loc` x `prog` above already
  // carries batches from FL10 and other blocks, so a sequence asserted there would be guesswork.
  const nLoc = (await req(admin, "POST", "/api/locations", {
    code: `TEST-NM${stamp}`, name: `TEST Numbering Centre ${stamp}`, city: "Test", state: "UP",
    approval_status: "Approved", operational_status: "Active",
  }, 201)).data.item;
  const nProg = (await req(admin, "POST", "/api/programs", {
    code: `TEST-NP${stamp}`, name: `TEST Numbering Role ${stamp}`, trainer_skill: `nm${stamp}`,
    duration_days: 30, buffer_days: 5, default_batch_size: 30, completion_deadline_days: 120,
  }, 201)).data.item;
  const P = `${nLoc.code}-${nProg.code}`;
  const mk = async (expect = 201) => (await req(admin, "POST", "/api/batches",
    { location: nLoc._id, program: nProg._id, planned_start: "2027-06-01", target_size: 20 }, expect)).data.item;

  const b1 = await mk(), b2 = await mk(), b3 = await mk();
  ok("FL13: the first batch for this centre x programme is -01", b1?.code === `${P}-01`, String(b1?.code));
  ok("FL13: the second is -02", b2?.code === `${P}-02`, String(b2?.code));
  ok("FL13: the third is -03", b3?.code === `${P}-03`, String(b3?.code));

  // THE LEAK, reproduced. `planned_start: "not-a-date"` passes the required-field check in the create
  // route, becomes an Invalid Date, survives computePlannedEnd, and dies inside the write. Before
  // -225 the code was minted as an ARGUMENT to Batch.create, so the number was already gone by then:
  // no delete, no cancel, one malformed POST, one number burned. That is how a prefix reaches -04
  // with three batches on record.
  await req(admin, "POST", "/api/batches",
    { location: nLoc._id, program: nProg._id, planned_start: "not-a-date", target_size: 20 }, 400);
  const b4 = await mk();
  ok("FL13: a REFUSED create consumes no number - the next batch is -04, not -05", b4?.code === `${P}-04`, String(b4?.code));

  // Contiguity, and its honest cost, asserted rather than footnoted. A hard delete is Admin-only and
  // is refused for any batch carrying a member, log, result, cost, closure, portal row or invoice -
  // b2 is an empty shell, which is the only kind of number that can ever come back.
  await req(admin, "DELETE", `/api/batches/${b2._id}`, undefined, 200);
  const b5 = await mk();
  ok("FL13: Umesh's rule - the number counts the batches on record, so a deleted shell's number returns",
    b5?.code === `${P}-02`, String(b5?.code));

  // A CANCELLED batch keeps its row and its code, so it still counts. This is the line that keeps
  // contiguity safe: a batch that ever held anything can only be cancelled, never deleted.
  await req(admin, "POST", `/api/batches/${b3._id}/transition`, { target: "Cancelled", reason: "FL13 fixture" }, 200);
  const b6 = await mk();
  ok("FL13: a CANCELLED batch keeps its number - the next is -05, and -03 is never reissued",
    b6?.code === `${P}-05`, String(b6?.code));

  for (const b of [b1, b4, b5, b6]) {
    await req(admin, "POST", `/api/batches/${b._id}/transition`, { target: "Cancelled", reason: "FL13 fixture cleanup" }, 200);
  }
}

console.log("\n--- FL14 (-226): a batch that ALREADY RAN can be recorded, and the gates become a note ---");
{
  // Umesh, 2026-08-24, stuck on MUZ-CHAR-RPLHSL-SPIT-01 (planned start 24 Jul, entered in August):
  // "at least allow admin to start a batch in past date and all, just notify them once that this is
  // a past date but dont stop them. humko puraane completed batch bhi tho system mai daalne hai."
  // The past date was never the blocker - Rule 17 only refuses starting BEFORE planned_start. The
  // blocker was the readiness chain (roster >= 80% of target can never be true for a batch typed in
  // months later) plus a screen that told him to press a button that only rendered on Ready.
  // qa-226 disclosed this against itself and did not fix it: this helper built its dates from the
  // UTC calendar day while the product decides on the IST one, so every FL14/FL15 pin was wrong for
  // the ~5.5 hours a day when the two disagree. That window arrived - UTC 2026-08-24 while IST was
  // already 2026-08-25 - and eleven assertions went red at once, none of them a product defect:
  // `day(1)` was "tomorrow" in UTC and TODAY in IST, so "a future actual_start is still a 400"
  // measured a date that was not in the future. A pin that is unreliable by the clock is on its way
  // to being deleted by whoever it wakes at 3am. Same expression as istDay() below, on purpose.
  const day = (n) => new Date(Date.now() + 5.5 * 3600 * 1000 + n * 86400000).toISOString().slice(0, 10);
  const bdLoc = (await req(admin, "POST", "/api/locations", {
    code: `TEST-BD${stamp}`, name: `TEST Backdate Centre ${stamp}`, city: "Test", state: "UP",
    approval_status: "Approved", operational_status: "Active",
  }, 201)).data.item;
  const bdProg = (await req(admin, "POST", "/api/programs", {
    code: `TEST-BP${stamp}`, name: `TEST Backdate Role ${stamp}`, trainer_skill: `bd${stamp}`,
    duration_days: 30, buffer_days: 5, default_batch_size: 30, completion_deadline_days: 120,
  }, 201)).data.item;
  // target_size 20 with an empty roster: roster_80pct needs 16 and has 0, and enrollment_ok is false
  // too. Both gates are genuinely failing - this is not a batch that would have passed anyway.
  const mkBd = async (start) => (await req(admin, "POST", "/api/batches",
    { location: bdLoc._id, program: bdProg._id, planned_start: start, target_size: 20 }, 201)).data.item;

  const old = await mkBd(day(-30));
  const rd = (await req(admin, "GET", `/api/batches/${old._id}`)).data.readiness;
  ok("FL14: precondition - readiness genuinely fails, so nothing here passes by accident",
    rd?.ready === false && rd?.checks?.roster_80pct === false, JSON.stringify(rd?.checks));

  // 1. The refusal Umesh actually hit, and it now carries the way out in its own words.
  const plain = await req(admin, "POST", `/api/batches/${old._id}/transition`, { target: "Active" });
  ok("FL14: Planning -> Active without the override is still refused",
    plain.status === 409 && /record it with the real date/i.test(String(plain.data?.error ?? "")),
    `${plain.status} ${JSON.stringify(plain.data)}`);

  // 2. Recording it without the real date is the -81 damage all over again: actual_start becomes
  //    today, is unwritable afterwards, and Rule 32 then refuses every real day of the batch.
  const noDate = await req(admin, "POST", `/api/batches/${old._id}/transition`, { target: "Active", backdate_override: true });
  ok("FL14: the override without the real start date is refused", noDate.status === 409, `${noDate.status} ${JSON.stringify(noDate.data)}`);

  // 3. The future guard survives the override - it is not weakened by it.
  const future = await req(admin, "POST", `/api/batches/${old._id}/transition`, { target: "Active", backdate_override: true, actual_start: day(1) });
  ok("FL14: a future actual_start is still a 400, override or not", future.status === 400, `${future.status} ${JSON.stringify(future.data)}`);

  // 4. THE SAFETY PIN, and the most important assertion in this block. The override exists only for
  //    a batch that already began. On a batch planned for TODAY there is nothing to record after the
  //    fact, so passing the flag must not become a general way past readiness.
  const todayBatch = await mkBd(day(0));
  const notPast = await req(admin, "POST", `/api/batches/${todayBatch._id}/transition`, { target: "Active", backdate_override: true, actual_start: day(0) });
  ok("FL14: the override is REFUSED when planned_start has not passed - it is not a readiness bypass",
    notPast.status === 409 && /nothing to record after the fact/i.test(String(notPast.data?.error ?? "")),
    `${notPast.status} ${JSON.stringify(notPast.data)}`);

  // 5. The whole point: it goes in, carrying the day it really started.
  const done = await req(admin, "POST", `/api/batches/${old._id}/transition`, { target: "Active", backdate_override: true, actual_start: day(-30), reason: "old completed batch from the centre register" }, 200);
  ok("FL14: recorded - status Active and actual_start is the REAL day, not today",
    done.data?.item?.status === "Active" && String(done.data?.item?.actual_start ?? "").slice(0, 10) === day(-30),
    JSON.stringify({ s: done.data?.item?.status, a: done.data?.item?.actual_start }));

  // 6. Advisory, not enforced: the checks are still computed and still say what they said.
  const after = (await req(admin, "GET", `/api/batches/${old._id}`)).data.readiness;
  ok("FL14: readiness is still FALSE after activation - the gate became a note, it did not become true",
    after?.ready === false && after?.checks?.roster_80pct === false, JSON.stringify(after?.checks));

  // 7. And the note is on the record, naming what was not met - in the same words the screen uses.
  const trail = (await req(admin, "GET", `/api/audit/Batch/${old._id}`)).data;
  const rows = trail?.items ?? trail?.rows ?? (Array.isArray(trail) ? trail : []);
  const bd = rows.find((r) => r.field === "backdated_start");
  ok("FL14: an audit row names the gates that were skipped, in READINESS_FAILURE_TEXT's own words",
    !!bd && /roster below threshold/.test(String(bd.new_value ?? bd.newValue ?? "")),
    JSON.stringify(bd ?? rows.map((r) => r.field)));

  // 8. Rule 32 now measures against the REAL start, which is the entire reason the date matters.
  const okDay = await req(admin, "POST", `/api/batches/${old._id}/logs`, { log_date: day(-20), present_member_ids: [], actual_topic: "FL14" });
  const badDay = await req(admin, "POST", `/api/batches/${old._id}/logs`, { log_date: day(-40), present_member_ids: [], actual_topic: "FL14" });
  ok("FL14: a day AFTER the real start is loggable, a day BEFORE it is not",
    okDay.status < 400 && badDay.status >= 400,
    JSON.stringify({ after: okDay.status, before: badDay.status, e: badDay.data?.error }));

  // ---- FL15 (-230, QA-892): the roster of a backdated batch counts from the day it BEGAN ----
  // The half of Umesh's ask that -226 did not finish. `transitionBatch` restamps the roster to
  // actual_start when Start is pressed (rules.ts:712) - but that fires ONCE, and the roster is
  // normally built AFTER the batch exists. Anyone added later landed on today's date, Rule 29
  // (rosterOnDate, :385) admits a member only where joined_on <= D, and so every real day of a
  // July batch read "not on the roster" for them. The attendance the centre actually holds could
  // not be entered at all, and nothing said so until someone sat down to enter it weeks later.
  console.log("\n--- FL15 (-230): candidates added AFTER a backdated start still count from the real start ---");
  {
    const mkCand = async (nm) => (await req(admin, "POST", "/api/candidates",
      { name: `FL15 ${nm} ${stamp}`, phone: phone(), location: bdLoc._id, program: bdProg._id }, 201)).data.item;

    // `old` is Active with actual_start = day(-30), and its roster is still empty.
    const late = await mkCand("Late");
    const asg = await req(admin, "POST", "/api/candidates/assign", { batch: old._id, candidate_ids: [late._id] }, 200);
    ok("FL15: bulk assign reports the day the student is counted from",
      String(asg.data?.results?.[0]?.joined_on ?? "").slice(0, 10) === day(-30),
      JSON.stringify(asg.data?.results?.[0]));

    const mem = (await req(admin, "GET", `/api/batches/${old._id}/members`)).data.items
      .find((m) => String(m.candidate?._id ?? m.candidate) === String(late._id));
    ok("FL15: joined_on is the batch's REAL start, not the day of entry",
      String(mem?.joined_on ?? "").slice(0, 10) === day(-30),
      JSON.stringify({ joined_on: mem?.joined_on, expected: day(-30), today: day(0) }));

    // The whole point: a day the batch really ran must now be enterable FOR THIS STUDENT.
    const log = await req(admin, "POST", `/api/batches/${old._id}/logs`,
      { log_date: day(-19), present_member_ids: [String(mem._id)], actual_topic: "FL15" });
    ok("FL15: a real training day can be entered with this student marked present",
      log.status < 400, `${log.status} ${JSON.stringify(log.data?.error ?? "")}`);

    // ...and the safety valve: someone who genuinely joined mid-course is still a real case, so an
    // explicit date from the caller must still win over the default.
    const mid = await mkCand("Mid");
    await req(admin, "POST", `/api/batches/${old._id}/members`,
      { candidate: mid._id, joined_on: day(-10) }, 201);
    const midMem = (await req(admin, "GET", `/api/batches/${old._id}/members`)).data.items
      .find((m) => String(m.candidate?._id ?? m.candidate) === String(mid._id));
    ok("FL15: an explicit joined_on still wins - the default only fills a silence",
      String(midMem?.joined_on ?? "").slice(0, 10) === day(-10),
      JSON.stringify({ joined_on: midMem?.joined_on, expected: day(-10) }));

    // And a batch that has NOT begun is untouched: today's date is still right for it.
    const fresh = await mkBd(day(3));
    const c3 = await mkCand("Fresh");
    await req(admin, "POST", "/api/candidates/assign", { batch: fresh._id, candidate_ids: [c3._id] }, 200);
    const freshMem = (await req(admin, "GET", `/api/batches/${fresh._id}/members`)).data.items
      .find((m) => String(m.candidate?._id ?? m.candidate) === String(c3._id));
    ok("FL15: a batch that has not started still records today - the default is scoped, not global",
      String(freshMem?.joined_on ?? "").slice(0, 10) === day(0),
      JSON.stringify({ joined_on: freshMem?.joined_on, expected: day(0) }));

    // ---- QA-907: the leak cycle 1 shipped, and the reason this block exists twice ----
    // Cycle 1 asked "did this batch start on a past day?" — true of almost every RUNNING batch — so
    // the default escaped onto batches nobody asked it to change. A walk-in added today to an
    // ordinary running batch was written ten days early, and a daily log marking them present
    // BEFORE they arrived went 400 -> 201. The pin below is the one that was missing: cycle 1
    // tested the not-started boundary, and the leak was at the started-NORMALLY boundary.
    // The batch must genuinely reach Active by the ORDINARY path, so readiness has to pass for real:
    // a trainer, a room, and a member whose enrolment steps are done. A first version of this pin
    // skipped all three, the Ready transition 409'd on `room_assigned, trainer_ready`, the batch
    // stayed in Planning with no actual_start — and the assertions below PASSED anyway, for the
    // wrong reason. A pin that cannot fail is not a pin (QA-212), so the transitions are asserted
    // with an expected 200 rather than fired and hoped over.
    const bdTr = (await req(admin, "POST", "/api/trainers", {
      name: `FL15 Trainer ${stamp}`, phone: phone(), skills: [`bd${stamp}`], pipeline_status: "Certified",
      available_from: day(-60),
    }, 201)).data.item;
    const bdRoom = (await req(admin, "POST", `/api/locations/${bdLoc._id}/rooms`,
      { name: `FL15 Room ${stamp}`, type: "Classroom", capacity: 30 }, 201)).data.item;
    const normal = (await req(admin, "POST", "/api/batches",
      { location: bdLoc._id, program: bdProg._id, trainer: bdTr._id, room: bdRoom._id,
        planned_start: day(-10), target_size: 1 }, 201)).data.item;
    const early = await mkCand("Early");
    const earlyM = (await req(admin, "POST", `/api/batches/${normal._id}/members`,
      { candidate: early._id, joined_on: day(-10) }, 201)).data.item;
    await req(admin, "PATCH", `/api/members/${earlyM._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
    await req(admin, "POST", `/api/batches/${normal._id}/transition`, { target: "Ready" }, 200);
    // The ordinary path: no backdate_override, so NO `backdated_start` audit row is written.
    await req(admin, "POST", `/api/batches/${normal._id}/transition`, { target: "Active", actual_start: day(-10) }, 200);
    const normalNow = (await req(admin, "GET", `/api/batches/${normal._id}`)).data.item;
    ok("FL15/QA-907: precondition - the control batch really IS Active with a past actual_start",
      normalNow?.status === "Active" && String(normalNow?.actual_start ?? "").slice(0, 10) === day(-10),
      JSON.stringify({ status: normalNow?.status, actual_start: normalNow?.actual_start, expected: day(-10) }));

    const walkIn = await mkCand("WalkIn");
    await req(admin, "POST", "/api/candidates/assign", { batch: normal._id, candidate_ids: [walkIn._id] }, 200);
    const wm = (await req(admin, "GET", `/api/batches/${normal._id}/members`)).data.items
      .find((m) => String(m.candidate?._id ?? m.candidate) === String(walkIn._id));
    ok("FL15/QA-907: a walk-in joining a NORMALLY running batch is recorded TODAY, not at its start",
      String(wm?.joined_on ?? "").slice(0, 10) === day(0),
      JSON.stringify({ joined_on: wm?.joined_on, expected: day(0), batch_started: day(-10) }));

    // The consequence, which is what actually matters: attendance before they arrived stays refused.
    const before = await req(admin, "POST", `/api/batches/${normal._id}/logs`,
      { log_date: day(-5), present_member_ids: [String(wm._id)], actual_topic: "QA-907" });
    ok("FL15/QA-907: marking that walk-in present BEFORE they joined is still refused",
      before.status >= 400,
      `${before.status} ${JSON.stringify(before.data?.error ?? "")} — a 201 here means the guard is gone`);

    // ---- QA-957: the SERVER's answer must reach the screen, and cover BOTH after-the-fact doors ----
    // Cycle 2 fixed the roster rule and left the client re-deriving the same question from a date,
    // so the confirmation and the amber note promised a back-dated enrolment on every ordinary
    // past-started batch. The list payload now carries the server's own answer; these pins are on
    // that field, because it is the one both surfaces read.
    const listRow = async (b) => ((await req(admin, "GET", "/api/batches?limit=2000")).data.items ?? [])
      .find((x) => String(x._id) === String(b._id));

    const normalRow = await listRow(normal);
    ok("FL15/QA-957: an ordinary past-started batch is NOT flagged after-the-fact to the screen",
      normalRow?.start_recorded_after_the_fact === false,
      JSON.stringify({ flag: normalRow?.start_recorded_after_the_fact, actual_start: normalRow?.actual_start }));

    const oldRow = await listRow(old);
    ok("FL15/QA-957: a batch recorded AFTER it ran IS flagged after-the-fact to the screen",
      oldRow?.start_recorded_after_the_fact === true,
      JSON.stringify({ flag: oldRow?.start_recorded_after_the_fact }));

    const freshRow = await listRow(fresh);
    ok("FL15/QA-957: a batch that has not started is not flagged either",
      freshRow?.start_recorded_after_the_fact === false,
      JSON.stringify({ flag: freshRow?.start_recorded_after_the_fact }));

    await req(admin, "POST", `/api/batches/${normal._id}/transition`, { target: "Cancelled", reason: "FL15 fixture cleanup" }, 200);
    await req(admin, "POST", `/api/batches/${fresh._id}/transition`, { target: "Cancelled", reason: "FL15 fixture cleanup" }, 200);
  }

  await req(admin, "POST", `/api/batches/${todayBatch._id}/transition`, { target: "Cancelled", reason: "FL14 fixture cleanup" }, 200);
}


console.log("\n--- FL16 (QA-902): the government APAAR ID, on the door the Closure card writes through ---");
{
  // Umesh 24/08: "hrr individual candidate k liye jaise abhi candidate id aati hai vaise hi govt
  // APAAR ID hota hai... card mai iske liye bhi jagah bnaao same as candidate id."
  // The box sits on the batch Closure card, so the write goes through PUT /api/batches/:id/results
  // on `closure.manage` - the same door the Candidate ID box uses, so a Trainer can fill one in.
  //
  // These pins also close a gap QA-880 named out loud: the identity-write path on THIS door had no
  // automated coverage for EITHER field, which is how -214, -216 and -217 each shipped a
  // write-then-refuse defect that only a human driving a browser ever caught. The block below is
  // written against the GENERALISED loop, so most of it pins the portal Candidate ID too.
  const dayF = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const apaar = (n) => `19${stamp}${String(n).padStart(4, "0")}`;   // exactly 12 digits, unique per run
  const AADHAAR = "234567890124";                                   // Verhoeff-valid, first digit not 0/1

  const b = (await req(admin, "POST", "/api/batches",
    { location: loc._id, program: prog._id, planned_start: dayF(0), target_size: 20 }, 201)).data.item;
  const mk = async (nm, extra = {}) => (await req(admin, "POST", "/api/candidates",
    { name: `FL16 ${nm} ${stamp}`, phone: phone(), location: loc._id, program: prog._id, ...extra }, 201)).data.item;
  const c1 = await mk("One"), c2 = await mk("Two"), c3 = await mk("Three", { aadhaar_no: AADHAAR });
  await req(admin, "POST", "/api/candidates/assign", { batch: b._id, candidate_ids: [c1._id, c2._id, c3._id] }, 200);
  const memOf = async () => (await req(admin, "GET", `/api/batches/${b._id}/members`)).data.items ?? [];
  const members = await memOf();
  const memFor = (c) => members.find((m) => String(m.candidate?._id ?? m.candidate) === String(c._id));
  const m1 = memFor(c1), m2 = memFor(c2), m3 = memFor(c3);
  const put = (rows, expect) => req(admin, "PUT", `/api/batches/${b._id}/results`, { rows }, expect);
  const items = async () => (await req(admin, "GET", `/api/batches/${b._id}/results`)).data.items ?? [];
  const candOf = async (m) => (await items()).find((i) => String(i.member) === String(m._id))?.candidate ?? null;

  // 1. It writes at all, and it comes back on the payload the card reads.
  await put([{ member: String(m1._id), apaar_id: apaar(1) }], 200);
  ok("FL16: a 12-digit APAAR written through the Closure door lands on the candidate",
    (await candOf(m1))?.apaar_id === apaar(1), JSON.stringify({ got: (await candOf(m1))?.apaar_id ?? null }));
  ok("FL16: ...and rides the ROSTER payload too - without this the roster column renders empty on a record that has one",
    ((await memOf()).find((m) => String(m._id) === String(m1._id))?.candidate?.apaar_id) === apaar(1));

  // 2. Spaces and hyphens are how a 12-digit number gets typed; they are normalised, not refused.
  //    This matters beyond tidiness: the partial unique index is built on the RAW string (QA-730).
  await put([{ member: String(m2._id), apaar_id: `19 ${stamp} 000-2` }], 200);
  ok("FL16 (QA-730): a spaced/hyphenated APAAR is stored as the bare 12 digits",
    (await candOf(m2))?.apaar_id === apaar(2), JSON.stringify({ got: (await candOf(m2))?.apaar_id ?? null }));

  // 3. REFUSE BEFORE WRITING ANYTHING - and prove it ACROSS fields, which is the property the
  //    generalised loop had to keep. A valid portal id rides in the same row as a bad APAAR: if the
  //    door wrote as it went, the CAN would be on the record after a request that said it refused.
  //    That is the -206/-213/QA-780 class, and it shipped three times on this door.
  const canary = `CAN_FL16${stamp}`;
  const bad = await put([{ member: String(m1._id), sidh_candidate_id: canary, apaar_id: apaar(1).slice(0, 11) }]);
  ok("FL16: an 11-digit APAAR is refused at the door, in words that say what is wrong",
    bad.status === 400 && /12 digits/i.test(String(bad.data?.error ?? "")), `${bad.status} ${JSON.stringify(bad.data)}`);
  const afterBad = await candOf(m1);
  ok("FL16 (QA-780, cross-field): the VALID portal id in that same request was not written either - nothing was saved",
    (afterBad?.sidh_candidate_id ?? null) === null && afterBad?.apaar_id === apaar(1),
    JSON.stringify({ can: afterBad?.sidh_candidate_id ?? null, apaar: afterBad?.apaar_id ?? null }));

  // 4. Two rows of ONE request claiming the same APAAR (QA-786: the DB pre-check cannot see this).
  const twin = await put([{ member: String(m1._id), apaar_id: apaar(9) }, { member: String(m2._id), apaar_id: apaar(9) }]);
  ok("FL16 (QA-786): the same APAAR given to two students in one save is refused",
    twin.status === 409 && /two different students/i.test(String(twin.data?.error ?? "")), `${twin.status} ${JSON.stringify(twin.data)}`);
  ok("FL16 (QA-786): ...and NEITHER was written - both keep what they had",
    (await candOf(m1))?.apaar_id === apaar(1) && (await candOf(m2))?.apaar_id === apaar(2));

  // 5. An APAAR another candidate already holds - the 409 names the person, or it is unactionable.
  const clash = await put([{ member: String(m2._id), apaar_id: apaar(1) }]);
  ok("FL16 (QA-417): an APAAR already on another candidate is refused, NAMING them",
    clash.status === 409 && new RegExp(`FL16 One ${stamp}`).test(String(clash.data?.error ?? "")),
    `${clash.status} ${JSON.stringify(clash.data)}`);

  // 6. The QA-414 guard. APAAR and Aadhaar are both 12 digits; this is the one confusion that is
  //    knowable at the door rather than months later when the portal rejects the student.
  const cross = await put([{ member: String(m3._id), apaar_id: AADHAAR }]);
  ok("FL16 (QA-414 guard): a candidate's own Aadhaar typed into the APAAR box is refused BY NAME",
    cross.status === 400 && /Aadhaar number, not their APAAR/i.test(String(cross.data?.error ?? "")),
    `${cross.status} ${JSON.stringify(cross.data)}`);
  ok("FL16: ...and that candidate's APAAR is still absent - the refusal wrote nothing",
    ((await candOf(m3))?.apaar_id ?? null) === null);

  // 7. Clearing is how a WRONG id gets removed, and "" must never reach the record (QA-450): the
  //    partial unique index does not index null but DOES index the empty string, so a second blank
  //    would be refused as a duplicate identity that does not exist.
  await put([{ member: String(m1._id), apaar_id: "" }], 200);
  ok("FL16 (QA-450): clearing the box stores ABSENT, not an empty string",
    ((await candOf(m1))?.apaar_id ?? null) === null, JSON.stringify({ got: (await candOf(m1))?.apaar_id ?? "(absent)" }));
  const clear2 = await put([{ member: String(m2._id), apaar_id: "   " }]);
  ok("FL16 (QA-450): ...and a SECOND candidate can be cleared too - no false 'already in use'",
    clear2.status === 200 && ((await candOf(m2))?.apaar_id ?? null) === null, `${clear2.status} ${JSON.stringify(clear2.data)}`);

  // 8. The candidate doors (drawer Add / Edit), which is the other place Umesh asked for it.
  const badPost = await req(admin, "POST", "/api/candidates",
    { name: `FL16 Bad ${stamp}`, phone: phone(), location: loc._id, program: prog._id, apaar_id: "12345" });
  ok("FL16: the candidate CREATE door refuses a malformed APAAR", badPost.status === 400, `${badPost.status} ${JSON.stringify(badPost.data)}`);
  const blank = await mk("Blank", { apaar_id: "" });
  const blankRead = (await req(admin, "GET", `/api/candidates/${blank._id}`)).data.item;
  ok("FL16 (QA-450, create door): a blank APAAR is stored as absent, never an empty string",
    (blankRead?.apaar_id ?? null) === null, JSON.stringify({ got: blankRead?.apaar_id ?? "(absent)" }));
  const blank2 = await req(admin, "POST", "/api/candidates",
    { name: `FL16 Blank2 ${stamp}`, phone: phone(), location: loc._id, program: prog._id, apaar_id: "" });
  ok("FL16 (QA-450, create door): a SECOND blank is not a duplicate", blank2.status === 201, `${blank2.status} ${JSON.stringify(blank2.data)}`);

  const edited = await mk("Edit");
  await req(admin, "PATCH", `/api/candidates/${edited._id}`, { apaar_id: apaar(20) }, 200);
  ok("FL16 (-116 lesson): the EDIT door accepts it too - a create-only field looks saved and is gone on the next read",
    ((await req(admin, "GET", `/api/candidates/${edited._id}`)).data.item?.apaar_id) === apaar(20));
  await req(admin, "PATCH", `/api/candidates/${edited._id}`, { apaar_id: "" }, 200);
  ok("FL16: ...and the edit door can clear it back to absent",
    (((await req(admin, "GET", `/api/candidates/${edited._id}`)).data.item?.apaar_id) ?? null) === null);

  // 9. The bulk import: REPORTS, never refuses (QA-141) - and the record it leaves behind must stay
  //    EDITABLE in every other field (QA-726). -210 shipped the opposite and it took a checker to
  //    find: changing only the EMAIL of an imported candidate returned 400 naming an id the operator
  //    had never touched.
  const irows = [{ "Student Name": `FL16 Imp ${stamp}`, "Mobile": "9822216001", "APAAR ID": "99" }];
  const iwb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(iwb, XLSX.utils.json_to_sheet(irows), "Sheet1");
  const ifile = new File([XLSX.write(iwb, { type: "buffer", bookType: "xlsx" })], "apaar.xlsx",
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const imap = JSON.stringify({ "Student Name": "name", "Mobile": "phone", "APAAR ID": "apaar_id" });
  const iprev = await multipart(admin, "/api/candidates/import", { file: ifile, location: loc._id, program: prog._id, mapping: imap });
  ok("FL16 (QA-727 lane): the PREVIEW names a malformed APAAR instead of importing it in silence",
    iprev.data?.apaar_invalid_count === 1, JSON.stringify({ n: iprev.data?.apaar_invalid_count, rows: iprev.data?.apaar_invalid }));
  const iconf = await multipart(admin, "/api/candidates/import", { file: ifile, location: loc._id, program: prog._id, mapping: imap, confirm: "1" });
  ok("FL16 (QA-141): ...and the row is still IMPORTED - a client's sheet is never dropped over format",
    iconf.status === 201 && iconf.data?.imported === 1, JSON.stringify({ s: iconf.status, d: iconf.data?.imported }));
  const imported = ((await req(admin, "GET", `/api/candidates?q=${encodeURIComponent(`FL16 Imp ${stamp}`)}&limit=5`)).data.items ?? [])[0];
  const keepEditable = imported
    ? await req(admin, "PATCH", `/api/candidates/${imported._id}`, { email: `fl16imp${stamp}@t.local` })
    : { status: 0 };
  ok("FL16 (QA-726): a record holding an unreadable APAAR is still editable in every OTHER field",
    keepEditable.status === 200, `${keepEditable.status} ${JSON.stringify(keepEditable.data ?? {})}`);

  // 10. Search: Umesh asked for it on the roster, and the shell search rides the same field list.
  const notYet = (await req(admin, "GET", `/api/candidates?q=${apaar(20)}&limit=5`)).data.items ?? [];
  await req(admin, "PATCH", `/api/candidates/${edited._id}`, { apaar_id: apaar(20) }, 200);
  const nowFound = (await req(admin, "GET", `/api/candidates?q=${apaar(20)}&limit=5`)).data.items ?? [];
  ok("FL16: a candidate is findable BY their APAAR ID once it is on record",
    notYet.length === 0 && nowFound.some((x) => String(x._id) === String(edited._id)),
    JSON.stringify({ before: notYet.length, after: nowFound.length }));

  await req(admin, "POST", `/api/batches/${b._id}/transition`, { target: "Cancelled", reason: "FL16 fixture cleanup" }, 200);
}


console.log("\n--- FL17 (qa-232 cycle 2): the three the checker FAILED cycle 1 on ---");
{
  // Every assertion here was RED on cycle 1. The checker drove all three itself and the manifest
  // now carries its measurements, so these are regression pins, not decoration.
  const dayG = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const ap17 = (n) => `17${stamp}${String(n).padStart(4, "0")}`;
  const AADH17 = "234567890124";                       // Verhoeff-valid, first digit not 0/1

  // --- QA-948: the in-file duplicate detector skipped UNREADABLE values ---------------------
  // It sat behind `if (!canon) … continue`, so it missed exactly the case it creates: an
  // unreadable APAAR is still STORED (`canon ?? raw`) and the partial index is on $type:"string",
  // so it indexes any string. Checker measured on a 20-row sheet: preview said
  // apaar_duplicate_count=0, confirm answered a bare 409, and 3 of 20 rows landed - 17 lost.
  const badApaar = "99";                                // unreadable on purpose
  const dupRows = [
    { "Student Name": `FL17 Dup A ${stamp}`, "Mobile": "9822217001", "APAAR ID": badApaar },
    { "Student Name": `FL17 Dup B ${stamp}`, "Mobile": "9822217002", "APAAR ID": badApaar },
  ];
  const dwb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(dwb, XLSX.utils.json_to_sheet(dupRows), "Sheet1");
  const dfile = new File([XLSX.write(dwb, { type: "buffer", bookType: "xlsx" })], "apaar-dup.xlsx",
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const dmap = JSON.stringify({ "Student Name": "name", "Mobile": "phone", "APAAR ID": "apaar_id" });
  const dprev = await multipart(admin, "/api/candidates/import", { file: dfile, location: loc._id, program: prog._id, mapping: dmap });
  ok("FL17 (QA-948): two rows sharing an UNREADABLE APAAR are named on the preview - the case the detector used to skip",
    dprev.data?.apaar_duplicate_count === 1,
    JSON.stringify({ dup: dprev.data?.apaar_duplicate_count, rows: dprev.data?.apaar_duplicate, invalid: dprev.data?.apaar_invalid_count }));
  ok("FL17 (QA-948): ...and it is still reported as unreadable too - the two lists are not exclusive",
    dprev.data?.apaar_invalid_count === 2, JSON.stringify({ invalid: dprev.data?.apaar_invalid_count }));

  // --- QA-949: the QA-414 guard was missing on the door where QA-414 actually happened -------
  // The two hand-typed doors refused an APAAR equal to that candidate's Aadhaar; the IMPORTER,
  // which is how rosters actually arrive, stored both fields equal with no word. REPORTED here,
  // never refused - the QA-141 ruling that a client's sheet is not dropped over format.
  const sameRows = [{ "Student Name": `FL17 Same ${stamp}`, "Mobile": "9822217003", "APAAR ID": AADH17, "Aadhaar": AADH17 }];
  const swb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(swb, XLSX.utils.json_to_sheet(sameRows), "Sheet1");
  const sfile = new File([XLSX.write(swb, { type: "buffer", bookType: "xlsx" })], "apaar-same.xlsx",
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const smap = JSON.stringify({ "Student Name": "name", "Mobile": "phone", "APAAR ID": "apaar_id", "Aadhaar": "aadhaar_no" });
  const sprev = await multipart(admin, "/api/candidates/import", { file: sfile, location: loc._id, program: prog._id, mapping: smap });
  ok("FL17 (QA-949): the importer NAMES a row whose APAAR equals that candidate's own Aadhaar",
    sprev.data?.apaar_same_as_aadhaar_count === 1,
    JSON.stringify({ n: sprev.data?.apaar_same_as_aadhaar_count, rows: sprev.data?.apaar_same_as_aadhaar }));
  const sconf = await multipart(admin, "/api/candidates/import", { file: sfile, location: loc._id, program: prog._id, mapping: smap, confirm: "1" });
  ok("FL17 (QA-949 / QA-141): ...and REPORTS rather than refuses - the row still imports",
    sconf.status === 201 && sconf.data?.imported === 1, JSON.stringify({ s: sconf.status, imported: sconf.data?.imported }));

  // --- QA-950: the guard was one-directional ------------------------------------------------
  // Set the APAAR first and the Aadhaar second and it walked straight past. A guard that depends
  // on the order the operator types in is not a guard.
  // A DIFFERENT Verhoeff-valid number from AADH17 on purpose: the QA-949 import above stores
  // AADH17 as an apaar_id, and apaar_id is uniquely indexed - reusing it here made this pin fail
  // for a fixture reason (409 "already in use"), leaving apaar_id null so the second PATCH had
  // nothing to refuse. The pin was red for the wrong reason, which is its own kind of lie.
  const REV17 = "876543210988";
  const rev = (await req(admin, "POST", "/api/candidates",
    { name: `FL17 Rev ${stamp}`, phone: phone(), location: loc._id, program: prog._id }, 201)).data.item;
  await req(admin, "PATCH", `/api/candidates/${rev._id}`, { apaar_id: REV17 }, 200);
  const revBack = await req(admin, "PATCH", `/api/candidates/${rev._id}`, { aadhaar_no: REV17 });
  ok("FL17 (QA-950): setting the Aadhaar to a value already held as the APAAR is refused - the guard is not order-dependent",
    revBack.status === 400 && /APAAR ID, not their Aadhaar/i.test(String(revBack.data?.error ?? "")),
    `${revBack.status} ${JSON.stringify(revBack.data)}`);
  const revRead = (await req(admin, "GET", `/api/candidates/${rev._id}`)).data.item;
  ok("FL17 (QA-950): ...and the refusal wrote nothing - the two fields are not left equal",
    (revRead?.aadhaar_no ?? null) === null && revRead?.apaar_id === REV17,
    JSON.stringify({ aadhaar: revRead?.aadhaar_no ?? null, apaar: revRead?.apaar_id ?? null }));

  // The forward direction must still hold - fixing one direction must not cost the other.
  const FWD17 = "765432109878";
  const fwd = (await req(admin, "POST", "/api/candidates",
    { name: `FL17 Fwd ${stamp}`, phone: phone(), location: loc._id, program: prog._id, aadhaar_no: FWD17 }, 201)).data.item;
  const fwdBack = await req(admin, "PATCH", `/api/candidates/${fwd._id}`, { apaar_id: FWD17 });
  ok("FL17 (QA-414, still): the ORIGINAL direction is untouched - an APAAR equal to the stored Aadhaar is still refused",
    fwdBack.status === 400 && /Aadhaar number, not their APAAR/i.test(String(fwdBack.data?.error ?? "")),
    `${fwdBack.status} ${JSON.stringify(fwdBack.data)}`);
}


console.log("\n--- FL18 (qa-232 cycle 3, QA-977): the guard that could not fire on Umesh's own number ---");
{
  // All four doors asked "is this APAAR the same as the Aadhaar?" THROUGH `canonicalAadhaar()`,
  // which is a VALIDITY test - Verhoeff, and no leading 0 or 1. So whenever the Aadhaar side was
  // not a *valid* Aadhaar the comparison became `x === null` and the guard silently did nothing.
  // The most important instance is Umesh's own APAAR, 190305516076, which begins with 1.
  //
  // The reachable path is real, not contrived: the IMPORTER reports a malformed Aadhaar and stores
  // it anyway (QA-141), so a record holding a leading-1 "Aadhaar" exists by design.
  const LEAD1 = "190305516076";          // Umesh's own APAAR shape: 12 digits, begins with 1
  const rows18 = [{ "Student Name": `FL18 Lead1 ${stamp}`, "Mobile": "9822218001", "Aadhaar": LEAD1 }];
  const wb18 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb18, XLSX.utils.json_to_sheet(rows18), "Sheet1");
  const file18 = new File([XLSX.write(wb18, { type: "buffer", bookType: "xlsx" })], "lead1.xlsx",
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const map18 = JSON.stringify({ "Student Name": "name", "Mobile": "phone", "Aadhaar": "aadhaar_no" });
  const conf18 = await multipart(admin, "/api/candidates/import", { file: file18, location: loc._id, program: prog._id, mapping: map18, confirm: "1" });
  ok("FL18: precondition - the importer really does store a leading-1 value in aadhaar_no (reports, never refuses)",
    conf18.status === 201 && conf18.data?.imported === 1, JSON.stringify({ s: conf18.status, imported: conf18.data?.imported }));
  const who18 = ((await req(admin, "GET", `/api/candidates?q=${encodeURIComponent(`FL18 Lead1 ${stamp}`)}&limit=5`)).data.items ?? [])[0];
  const rec18 = who18 ? (await req(admin, "GET", `/api/candidates/${who18._id}`)).data.item : null;
  ok("FL18: precondition - that value is on the record", rec18?.aadhaar_no === LEAD1,
    JSON.stringify({ stored: rec18?.aadhaar_no ?? null }));

  // THE PIN. Before QA-977 this returned 200 and left both government-ID fields holding LEAD1.
  const guard18 = who18 ? await req(admin, "PATCH", `/api/candidates/${who18._id}`, { apaar_id: LEAD1 }) : { status: 0 };
  ok("FL18 (QA-977): an APAAR equal to the stored Aadhaar is refused EVEN WHEN that Aadhaar is not a valid one - equality, not validity",
    guard18.status === 400 && /Aadhaar number, not their APAAR/i.test(String(guard18.data?.error ?? "")),
    `${guard18.status} ${JSON.stringify(guard18.data)}`);
  const after18 = who18 ? (await req(admin, "GET", `/api/candidates/${who18._id}`)).data.item : null;
  ok("FL18 (QA-977): ...and nothing was written - the two fields are not left equal",
    (after18?.apaar_id ?? null) === null && after18?.aadhaar_no === LEAD1,
    JSON.stringify({ apaar: after18?.apaar_id ?? null, aadhaar: after18?.aadhaar_no ?? null }));

  // The reverse direction, same hole, same fix.
  const rev18 = (await req(admin, "POST", "/api/candidates",
    { name: `FL18 Rev ${stamp}`, phone: phone(), location: loc._id, program: prog._id, apaar_id: LEAD1 }, 201)).data.item;
  const revGuard18 = await req(admin, "PATCH", `/api/candidates/${rev18._id}`, { aadhaar_no: LEAD1 });
  ok("FL18 (QA-977, reverse): setting an Aadhaar equal to the stored APAAR is refused too, for a leading-1 value",
    revGuard18.status === 400, `${revGuard18.status} ${JSON.stringify(revGuard18.data)}`);

  // And the closure-card door, which had the identical comparison.
  const b18 = (await req(admin, "POST", "/api/batches",
    { location: loc._id, program: prog._id, planned_start: new Date().toISOString().slice(0, 10), target_size: 20 }, 201)).data.item;
  await req(admin, "POST", "/api/candidates/assign", { batch: b18._id, candidate_ids: [who18._id] }, 200);
  const mem18 = ((await req(admin, "GET", `/api/batches/${b18._id}/members`)).data.items ?? [])
    .find((m) => String(m.candidate?._id ?? m.candidate) === String(who18._id));
  const card18 = await req(admin, "PUT", `/api/batches/${b18._id}/results`, { rows: [{ member: String(mem18._id), apaar_id: LEAD1 }] });
  ok("FL18 (QA-977, Closure card): the same refusal on the third door",
    card18.status === 400 && /Aadhaar number, not their APAAR/i.test(String(card18.data?.error ?? "")),
    `${card18.status} ${JSON.stringify(card18.data)}`);
  await req(admin, "POST", `/api/batches/${b18._id}/transition`, { target: "Cancelled", reason: "FL18 fixture cleanup" }, 200);
}

console.log("\n--- FL19 (-235): a cancelled batch can be RESTORED, and a typed join date is validated ---");
{
  // Umesh, 2026-08-24, on MUZ-CHAR-RPLHSL-SPIT-01: "Money Sir ne galti se cancel mark kar diya hai,
  // isko phir se active kar dein." Cancel was a ONE-WAY door - there was no `Cancelled->` arm at all,
  // so every attempt fell to `default:` and 409'd, and `statusActions` renders no control whatsoever
  // on a cancelled batch. A mis-click on a live batch carrying 33 students was permanent.
  //
  // IST, not UTC. FL14's own day() builds from the UTC calendar day while the product decides on the
  // IST one - qa-226 disclosed that against itself. A pin that is wrong for five hours out of every
  // day is on its way to being deleted by whoever it wakes at 3am, so this one is right by the clock.
  const istDay = (n) => new Date(Date.now() + 5.5 * 3600 * 1000 + n * 86400000).toISOString().slice(0, 10);

  // An Operations login: it HOLDS batches.manage, so it clears the route's permission gate and lands
  // on the arm's own isAdmin check. A Location user would 403 one step earlier and prove nothing.
  const opsEmail = `test.ops.fl${stamp}@vidysea-test.local`;
  await req(admin, "POST", "/api/users", {
    name: "FL19 Ops", email: opsEmail, password: "Test@12345", role: "Operations", can_edit: true, active: true,
  }, 201);
  const ops = await login(opsEmail, "Test@12345");

  const mkB = async (start) => (await req(admin, "POST", "/api/batches",
    { location: loc._id, program: prog._id, planned_start: start, target_size: 20 }, 201)).data.item;
  const cancelled = async (b) => {
    await req(admin, "POST", `/api/batches/${b._id}/transition`, { target: "Cancelled", reason: "FL19 fixture" }, 200);
    return b;
  };

  // 1. The refusal Umesh actually hit. Before this unit every one of these was the `default:` 409,
  //    so this assertion is what says the arm exists at all.
  const b1 = await cancelled(await mkB(istDay(-30)));
  const restored = await req(admin, "POST", `/api/batches/${b1._id}/transition`,
    { target: "Planning", reason: "cancelled by mistake" }, 200);
  ok("FL19: an Admin can restore a cancelled batch to Planning",
    restored.data?.item?.status === "Planning", JSON.stringify({ s: restored.data?.item?.status }));

  // 2. The cancel reason is cleared - it describes a cancellation that no longer applies. If it
  //    survived, the next reader would find a live batch carrying a reason for being dead.
  ok("FL19: the cancel reason is cleared on restore",
    !restored.data?.item?.cancel_reason, JSON.stringify({ r: restored.data?.item?.cancel_reason }));

  // 3. ...but it is not LOST: it is quoted into the audit row, which is the record.
  const trail = (await req(admin, "GET", `/api/audit/Batch/${b1._id}`)).data;
  const rows = trail?.items ?? trail?.rows ?? (Array.isArray(trail) ? trail : []);
  const rr = rows.find((r) => r.field === "restored_from_cancelled");
  ok("FL19: an audit row records the restore AND quotes the reason it was cancelled for",
    !!rr && /FL19 fixture/.test(String(rr.new_value ?? rr.newValue ?? "")),
    JSON.stringify(rr ?? rows.map((r) => r.field)));

  // 4. And the status row now says what it moved FROM. It hardcoded oldValue: undefined before, so
  //    the one audit entry that records a status move rendered as `null -> "Planning"`.
  const st = rows.find((r) => r.field === "status" && (r.new_value ?? r.newValue) === "Planning");
  ok("FL19: the status audit row carries the previous status, not null",
    String(st?.old_value ?? st?.oldValue ?? "") === "Cancelled",
    JSON.stringify({ old: st?.old_value ?? st?.oldValue }));

  // 5. Reason is required - a restore is as auditable as the cancel it undoes.
  const b2 = await cancelled(await mkB(istDay(-30)));
  const noWhy = await req(admin, "POST", `/api/batches/${b2._id}/transition`, { target: "Planning" });
  ok("FL19: restoring without a reason is refused", noWhy.status === 409, `${noWhy.status} ${JSON.stringify(noWhy.data)}`);

  // 6. Admin only. Operations holds batches.manage and still cannot do this one.
  const notAdmin = await req(ops, "POST", `/api/batches/${b2._id}/transition`, { target: "Planning", reason: "ops try" });
  ok("FL19: a non-Admin holding batches.manage is still refused",
    notAdmin.status === 409 && /Only an Admin/i.test(String(notAdmin.data?.error ?? "")),
    `${notAdmin.status} ${JSON.stringify(notAdmin.data)}`);

  // 7. THE SAFETY PIN, and the most important assertion in this block. Restore-to-Active must not
  //    become a second, ungated Start door: a batch that never ran has no Active state to be put
  //    back into, and jumping there would walk past Rule 17 AND -226's backdate_override at once.
  const neverRan = await req(admin, "POST", `/api/batches/${b2._id}/transition`, { target: "Active", reason: "try to skip the ladder" });
  ok("FL19: restoring to Active is REFUSED when the batch never started - not a start bypass",
    neverRan.status === 409 && /never started/i.test(String(neverRan.data?.error ?? "")),
    `${neverRan.status} ${JSON.stringify(neverRan.data)}`);

  // 8. The one-way ladder is otherwise untouched: Cancelled still cannot jump to a finished state.
  const toDone = await req(admin, "POST", `/api/batches/${b2._id}/transition`, { target: "Completed", reason: "x" });
  const toClosed = await req(admin, "POST", `/api/batches/${b2._id}/transition`, { target: "Closed", reason: "x" });
  ok("FL19: Cancelled -> Completed and Cancelled -> Closed are both still refused",
    toDone.status === 409 && toClosed.status === 409,
    JSON.stringify({ completed: toDone.status, closed: toClosed.status }));

  // 9. A restore changes STATUS and no dates. The route forwards actual_start for any target Active,
  //    so it can arrive here - and silently dropping it would be worse than refusing it: the caller
  //    would believe it had corrected a date that never moved.
  const b3 = await cancelled(await mkB(istDay(-30)));
  const withDate = await req(admin, "POST", `/api/batches/${b3._id}/transition`,
    { target: "Active", reason: "restore", actual_start: istDay(-30), backdate_override: true });
  ok("FL19: a restore carrying a date is refused by name, never silently ignored",
    withDate.status === 409 && /changes no dates/i.test(String(withDate.data?.error ?? "")),
    `${withDate.status} ${JSON.stringify(withDate.data)}`);

  // ---- the join date the operator now types, and the guards it never had ----
  // The restore is only half of Umesh's ask: the batch then has to be able to take the students that
  // were missed. Adding them was never blocked once the batch is out of Cancelled - but the join date
  // was never ASKED for, so they landed on the day of entry and Rule 26 said they were on no day's
  // roster while the batch actually ran. QA-908 measured a joined_on 30 days in the FUTURE returning 201.
  // Straight Planning -> Active with the override, NOT via Ready. My first draft walked through Ready
  // and the suite failed it: this fixture has an empty roster, so Rule 16 refuses Mark Ready - which is
  // exactly the dead end -226 was written to get around, and I had just re-created it in my own test.
  await req(admin, "POST", `/api/batches/${b1._id}/transition`,
    { target: "Active", backdate_override: true, actual_start: istDay(-30), reason: "already ran" }, 200);

  const mkCand = async (nm) => (await req(admin, "POST", "/api/candidates",
    { name: `FL19 ${nm} ${stamp}`, phone: phone(), location: loc._id, program: prog._id }, 201)).data.item;

  // ---- Cancelled -> Ready, both directions. This is the gap a peer session caught, and it is the
  // path the actual operator takes: MUZ-CHAR-RPLHSL-SPIT-01 shows readiness 4/4 and has no
  // actual_start, so Ready is the target he will pick - and until now nothing pinned it either way.
  const notReady = await req(admin, "POST", `/api/batches/${b2._id}/transition`, { target: "Ready", reason: "restore" });
  // Asserted on the WORDS, not on "Rule 16" - this project strips Rule/DEC/QA codes out of every
  // user-facing error on the way out (that is what the -111 pin at the end of this suite guards), so
  // the server's `fail("Rule 16: readiness checks failing: ...")` reaches the caller as "Readiness
  // checks failing: room_assigned, trainer_ready, roster_80pct". Matching the code would have pinned
  // a string no user can ever see, and would have gone red the moment the sanitiser did its job.
  ok("FL19: restoring to Ready runs the readiness chain - a batch that cannot pass it is refused, and the refusal NAMES the checks",
    notReady.status === 409 && /readiness checks failing/i.test(String(notReady.data?.error ?? ""))
      && /roster_80pct/.test(String(notReady.data?.error ?? "")),
    `${notReady.status} ${JSON.stringify(notReady.data)}`);

  // A batch that genuinely satisfies readiness: a trainer carrying this programme's skill, a room,
  // and a roster that clears the 80% bar (target_size 1 with one enrolled member).
  const flTr = (await req(admin, "POST", "/api/trainers", {
    name: `FL19 Trainer ${stamp}`, phone: phone(), skills: [`fl${stamp}`],
    pipeline_status: "Certified", available_from: istDay(-60),
  }, 201)).data.item;
  const flRoom = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`,
    { name: `FL19 Room ${stamp}`, type: "Classroom", capacity: 30 }, 201)).data.item;
  const readyB = (await req(admin, "POST", "/api/batches",
    { location: loc._id, program: prog._id, trainer: flTr._id, room: flRoom._id,
      planned_start: istDay(-30), target_size: 1 }, 201)).data.item;
  const readyCand = await mkCand("ReadyOne");
  const readyM = (await req(admin, "POST", `/api/batches/${readyB._id}/members`,
    { candidate: readyCand._id, joined_on: istDay(-30) }, 201)).data.item;
  await req(admin, "PATCH", `/api/members/${readyM._id}`, { reg_done: true, kyc_done: true, accept_done: true }, 200);
  await req(admin, "POST", `/api/batches/${readyB._id}/transition`, { target: "Cancelled", reason: "FL19 ready fixture" }, 200);

  const backToReady = await req(admin, "POST", `/api/batches/${readyB._id}/transition`,
    { target: "Ready", reason: "cancelled by mistake" });
  ok("FL19: a batch that passes readiness restores to Ready - THE path a real operator takes",
    backToReady.status === 200 && backToReady.data?.item?.status === "Ready",
    `${backToReady.status} ${JSON.stringify(backToReady.data?.item?.status ?? backToReady.data)}`);

  // The restore must not have quietly started it. If actual_start appeared here, the batch would be
  // treated as having run from a date nobody chose, and Rule 32 would open every day since.
  ok("FL19: ...and it still carries NO actual_start - restoring did not secretly start it",
    !backToReady.data?.item?.actual_start,
    JSON.stringify({ actual_start: backToReady.data?.item?.actual_start ?? null }));
  await req(admin, "POST", `/api/batches/${readyB._id}/transition`, { target: "Cancelled", reason: "FL19 cleanup" }, 200);

  const future = await req(admin, "POST", `/api/batches/${b1._id}/members`,
    { candidate: (await mkCand("Future"))._id, joined_on: istDay(1) });
  ok("FL19 (QA-908): a join date in the FUTURE is refused - it used to return 201",
    future.status === 400 && /cannot join in the future/i.test(String(future.data?.error ?? "")),
    `${future.status} ${JSON.stringify(future.data)}`);

  const tooEarly = await req(admin, "POST", `/api/batches/${b1._id}/members`,
    { candidate: (await mkCand("Early"))._id, joined_on: istDay(-60) });
  ok("FL19: a join date BEFORE the batch began is refused",
    tooEarly.status === 400 && /cannot join before/i.test(String(tooEarly.data?.error ?? "")),
    `${tooEarly.status} ${JSON.stringify(tooEarly.data)}`);

  // The regression my first version of that guard shipped, now pinned so it cannot come back.
  // "Not in the future" is the wrong spelling of QA-908: a batch that has NOT started yet can be
  // rostered with that batch's own start date, and refusing it broke seed-sample.mjs outright
  // (:165 sends joined_on = planned_start; B3 is planned +3 days) - every member add 400'd, its
  // catch{} swallowed them, and the seed died on `PATCH /api/members/undefined`, taking B4/B5, the
  // daily logs, the trainer requests and the cost entries with it. Two sessions read that as a
  // broken seed script before anyone read it as a broken guard.
  const futureBatch = await mkB(istDay(5));
  const preReg = await req(admin, "POST", `/api/batches/${futureBatch._id}/members`,
    { candidate: (await mkCand("PreReg"))._id, joined_on: istDay(5) }, 201);
  ok("FL19: a NOT-YET-STARTED batch accepts its own planned start as the join date",
    preReg.status === 201, `${preReg.status} ${JSON.stringify(preReg.data?.error ?? "")}`);

  const beyondPlanned = await req(admin, "POST", `/api/batches/${futureBatch._id}/members`,
    { candidate: (await mkCand("TooFar"))._id, joined_on: istDay(6) });
  ok("FL19: ...but a day BEYOND that planned start is still refused - the bound is the batch, not 'today'",
    beyondPlanned.status === 400 && /planned to start/i.test(String(beyondPlanned.data?.error ?? "")),
    `${beyondPlanned.status} ${JSON.stringify(beyondPlanned.data)}`);
  await req(admin, "POST", `/api/batches/${futureBatch._id}/transition`, { target: "Cancelled", reason: "FL19 cleanup" }, 200);

  // The whole point of the unit: the late joiner lands on a real training day and can be marked
  // present for it. This is what "maximum data collect karna hai" actually needs to be true.
  const late = await mkCand("Late");
  await req(admin, "POST", `/api/batches/${b1._id}/members`, { candidate: late._id, joined_on: istDay(-20) }, 201);
  const mem = ((await req(admin, "GET", `/api/batches/${b1._id}/members`)).data.items ?? [])
    .find((m) => String(m.candidate?._id ?? m.candidate) === String(late._id));
  ok("FL19: the typed join date is what gets stored",
    String(mem?.joined_on ?? "").slice(0, 10) === istDay(-20),
    JSON.stringify({ joined_on: mem?.joined_on, expected: istDay(-20) }));

  const log = await req(admin, "POST", `/api/batches/${b1._id}/logs`,
    { log_date: istDay(-15), present_member_ids: [String(mem?._id)], actual_topic: "FL19" });
  ok("FL19: a real training day after that date can be entered with the late joiner present",
    log.status < 400, `${log.status} ${JSON.stringify(log.data?.error ?? "")}`);

  // The bulk door runs through the same function, so the same guard must hold there. ARCHITECTURE.md
  // section 3.1 / QA-273 is the record of what happens when a join rule ships on one door only.
  const bulkFuture = await req(admin, "POST", "/api/candidates/assign",
    { batch: b1._id, candidate_ids: [(await mkCand("BulkFuture"))._id], joined_on: istDay(2) });
  const bulkErr = JSON.stringify(bulkFuture.data ?? {});
  ok("FL19: the BULK door refuses the same future join date - one rule, both doors",
    /cannot join in the future/i.test(bulkErr), `${bulkFuture.status} ${bulkErr}`);


  // ---- cycle 2: the three the checker charged, pinned so they cannot come back ----

  // QA-1048: a reason of three spaces used to pass `!opts.reason` while the audit row, which trims,
  // recorded nothing at all. The guard and the record disagreed about what a reason IS.
  const b4 = await cancelled(await mkB(istDay(-30)));
  const blankReason = await req(admin, "POST", `/api/batches/${b4._id}/transition`, { target: "Planning", reason: "   " });
  ok("FL19 (QA-1048): a restore reason of only whitespace is refused, not audited as blank",
    blankReason.status === 409, `${blankReason.status} ${JSON.stringify(blankReason.data)}`);

  // QA-1049: before a batch is started there was NO lower bound at all, because the floor was
  // `actual_start` and that is not stamped yet - and roster-first, start-second is the NORMAL order.
  // A date years before the batch was ever planned went in, permanently.
  const notStarted = await mkB(istDay(3));
  const wayBack = await req(admin, "POST", `/api/batches/${notStarted._id}/members`,
    { candidate: (await mkCand("WayBack"))._id, joined_on: istDay(-400) }, 201);
  // WARNS, does not refuse — and the first version of this pin asserted the opposite, which is how a
  // 400 got shipped over the shape this whole product exists to support: a batch that really ran
  // earlier and is typed in today, so planned_start is today and the roster is older. That refusal
  // crashed e2e-govt and took four e2e.mjs assertions with it. REQ-411 decides this class outright:
  // "just notify them once that this is a past date but dont stop them."
  ok("FL19 (QA-1049): an early join date on a NOT-YET-STARTED batch is accepted",
    wayBack.status === 201, `${wayBack.status} ${JSON.stringify(wayBack.data?.error ?? "")}`);
  ok("FL19 (QA-1049): ...and it comes back with a warning that says it cannot be changed afterwards",
    /before this batch's planned start/i.test(String(wayBack.data?.warning ?? ""))
      && /cannot be changed afterwards/i.test(String(wayBack.data?.warning ?? "")),
    JSON.stringify({ warning: wayBack.data?.warning ?? null }));

  // The hard floor that REMAINS: once a batch has genuinely started, Rule 26 will not have someone on
  // the roster for days it did not run. That refusal is not softened by the above.
  const startedFloor = await req(admin, "POST", `/api/batches/${b1._id}/members`,
    { candidate: (await mkCand("BeforeStart"))._id, joined_on: istDay(-90) });
  ok("FL19 (QA-1049): a STARTED batch still hard-refuses a join date before it began",
    startedFloor.status === 400 && /began on/i.test(String(startedFloor.data?.error ?? "")),
    `${startedFloor.status} ${JSON.stringify(startedFloor.data)}`);
  await req(admin, "POST", `/api/batches/${notStarted._id}/transition`, { target: "Cancelled", reason: "FL19 cleanup" }, 200);

  // QA-1047 (S2) - the checker's headline, and the one that reaches a government-facing row.
  // Rule 28 freezes `roster_count` on a daily log at save time; `validateDailyLog` counts presence
  // against the roster AS IT IS NOW. Those agreed until this unit let an operator TYPE a join date:
  // back-date someone onto a day whose log is already frozen and the live roster for that day is
  // bigger than the number stored on the row, so `internal_present` walks straight past it.
  // The log day must sit AFTER every existing member's join date, or creating it is refused before
  // this pin can measure anything - b1's only member joined on istDay(-20).
  const logDay = istDay(-18);
  const beforeMembers = ((await req(admin, "GET", `/api/batches/${b1._id}/members`)).data.items ?? [])
    .map((m) => String(m._id));
  const frozenLog = (await req(admin, "POST", `/api/batches/${b1._id}/logs`,
    { log_date: logDay, present_member_ids: beforeMembers, actual_topic: "FL19 frozen day" }, 201)).data.item;
  ok("FL19 (QA-1047): precondition - the log froze a roster_count and it matches what was there",
    Number(frozenLog?.roster_count) === beforeMembers.length && beforeMembers.length > 0,
    JSON.stringify({ roster_count: frozenLog?.roster_count, members: beforeMembers.length }));

  // Now the late joiner, back-dated to BEFORE that day - exactly what this unit exists to allow.
  const backDated = await mkCand("BackDated");
  const bdMember = (await req(admin, "POST", `/api/batches/${b1._id}/members`,
    { candidate: backDated._id, joined_on: istDay(-19) }, 201)).data.item;
  const overfull = [...beforeMembers, String(bdMember._id)];
  // The `internal_present > roster_count` bound that once stood here was withdrawn because it broke
  // `e2e.mjs`: a member who joins and attends on the SAME DAY is ordinary and truthful, and the log
  // was frozen earlier that day with a smaller count (that over-refusal is QA-1055, S2). Rule 26
  // (REQ-119) said that member WAS on the roster; Rule 28 (REQ-202) said roster_count is never
  // recalculated. SETTLED 2026-08-27 by Umesh: the count may GROW to admit exactly such a member and
  // may never shrink. So the row is no longer allowed to read 2-of-1 — the denominator moves instead,
  // and that is what is pinned now.
  const stillAccepted = await req(admin, "PATCH", `/api/logs/${frozenLog._id}`, { present_member_ids: overfull });
  ok("FL19: a same-day/back-dated joiner can still be marked on a frozen day (the guard I over-reached with is gone)",
    stillAccepted.status === 200, `${stillAccepted.status} ${JSON.stringify(stillAccepted.data?.error ?? "")}`);
  ok("FL19 (QA-1055/REQ-202): ...and the day's roster_count GREW to admit them, so the row never reads more present than enrolled",
    Number(stillAccepted.data?.item?.roster_count) === overfull.length
    && Number(stillAccepted.data?.item?.internal_present) <= Number(stillAccepted.data?.item?.roster_count),
    JSON.stringify({ was: frozenLog?.roster_count, now: stillAccepted.data?.item?.roster_count, ip: stillAccepted.data?.item?.internal_present }));

  // The govt figure escaped entirely: its bound lived in an `else if`, so sending a present list AND
  // a government number in one PATCH skipped Rule 30 outright.
  const govtEscape = await req(admin, "PATCH", `/api/logs/${frozenLog._id}`,
    { present_member_ids: beforeMembers, govt_present: Number(frozenLog.roster_count) + 5 });
  ok("FL19 (QA-1047): government attendance is bounded even when sent together with a present list",
    govtEscape.status === 400 && /cannot exceed/i.test(String(govtEscape.data?.error ?? "")),
    `${govtEscape.status} ${JSON.stringify(govtEscape.data)}`);

  // QA-1064: the ceiling above travelled into this branch and the FLOOR did not, and I then wrote in a
  // release note that the check "now applies either way" - a sentence that is on the production
  // endpoint. A negative figure alone was refused; the same figure sent WITH a present list was stored,
  // and the screen rendered "-4/2 (-200%)". Both halves are pinned here so the note becomes true and
  // stays true.
  const govtNegative = await req(admin, "PATCH", `/api/logs/${frozenLog._id}`,
    { present_member_ids: beforeMembers, govt_present: -4 });
  ok("FL19 (QA-1064): a NEGATIVE government figure is refused in the present-list branch too",
    govtNegative.status === 400 && /whole number of zero or more/i.test(String(govtNegative.data?.error ?? "")),
    `${govtNegative.status} ${JSON.stringify(govtNegative.data)}`);

  const govtFraction = await req(admin, "PATCH", `/api/logs/${frozenLog._id}`,
    { present_member_ids: beforeMembers, govt_present: 1.5 });
  ok("FL19 (QA-1064): ...and a fractional one, which used to be stored as 1.5",
    govtFraction.status === 400 && /whole number/i.test(String(govtFraction.data?.error ?? "")),
    `${govtFraction.status} ${JSON.stringify(govtFraction.data)}`);

  // The refusals must not have written: a stored -4 is the whole defect.
  const govtAfter = (await req(admin, "GET", `/api/batches/${b1._id}/logs`)).data.items
    ?.find((l) => String(l._id) === String(frozenLog._id));
  ok("FL19 (QA-1064): none of the three refusals wrote anything to the stored figure",
    govtAfter && (govtAfter.govt_present ?? null) === (frozenLog.govt_present ?? null),
    JSON.stringify({ before: frozenLog?.govt_present ?? null, after: govtAfter?.govt_present ?? null }));

  // QA-1106: the guard above reads the MERGED value, so a day already holding a bad figure refuses an
  // edit to the PRESENT LIST - over a number the operator never typed and cannot see in their request.
  // The guard is right; the sentence was not. It must name the STORED value and the repair, or it is a
  // dead end of the -224 kind: a correct refusal whose remedy is not on screen.
  const stale = (await req(admin, "POST", `/api/batches/${b1._id}/logs`,
    { log_date: istDay(-17), present_member_ids: beforeMembers, actual_topic: "FL19 stale-govt" }, 201)).data.item;
  // Put a figure on it the honest way, then shrink the roster's frozen ceiling out from under it by
  // using a day whose count is smaller - the shape a pre-fix row already has in production.
  await req(admin, "PATCH", `/api/logs/${stale._id}`, { govt_present: Number(stale.roster_count) }, 200);
  const overCeiling = await req(admin, "PATCH", `/api/logs/${stale._id}`,
    { present_member_ids: beforeMembers, govt_present: Number(stale.roster_count) + 3 });
  // This asserted `/Rule 30/i` on the RESPONSE, and it could never pass: `apiHandler`
  // (authz.ts:105-108) runs every HttpError through `plain()`, and stripping ledger codes is that
  // chokepoint's whole purpose — "the ledger codes stay in code and audit, never on a screen".
  // The thrown text at rules.ts:1141 really does say "Rule 30: govt_present cannot exceed roster
  // count."; the caller receives it with the code already gone. So the pin was measuring the one
  // thing the architecture guarantees is absent, and it went red the moment it was written.
  // What is actually worth holding here is the same thing in observable terms: the refusal is a
  // 400, it carries NO ledger code (that is `-111`'s promise, and worth a live assertion rather
  // than only a static one), and — the assertion below — it does not blame a stored value.
  ok("FL19 (QA-1106): a figure the caller SENT is refused, and the refusal carries no ledger code",
    overCeiling.status === 400 && !/\b(Rule|DEC|QA)[-\s]?\d+/i.test(String(overCeiling.data?.error ?? "")),
    `${overCeiling.status} ${JSON.stringify(overCeiling.data)}`);
  ok("FL19 (QA-1106): ...and that refusal does NOT blame a stored value, because none was at fault",
    !/already recorded/i.test(String(overCeiling.data?.error ?? "")),
    JSON.stringify(overCeiling.data));

  // And the day still holds what it held - a refused edit must write nothing.
  const afterLog = (await req(admin, "GET", `/api/batches/${b1._id}/logs`)).data.items
    ?.find((l) => String(l._id) === String(frozenLog._id));
  ok("FL19 (QA-1047): the REFUSED govt edit wrote nothing - the stored figure is unchanged",
    afterLog && (afterLog.govt_present ?? null) === (frozenLog.govt_present ?? null),
    JSON.stringify({ before: frozenLog?.govt_present ?? null, after: afterLog?.govt_present ?? null }));

  // QA-1063 (checker on qa-235): b1 at this point is exactly the shape the checker's attack used —
  // genuinely started (actual_start set at :1380), real daily logs against it (:1471, :1531). Cancel
  // it fresh here (it is still Active, not yet cancelled again since the :1380 restore) so it is
  // Cancelled-with-actual_start when the restore attempts below run. Before this fix, restoring such
  // a batch to Planning/Ready kept actual_start while putting the status back to "not yet begun", and
  // the next Start silently re-stamped or orphaned those logs.
  await req(admin, "POST", `/api/batches/${b1._id}/transition`, { target: "Cancelled", reason: "QA-1063 fixture" }, 200);
  const restorePastPlanning = await req(admin, "POST", `/api/batches/${b1._id}/transition`,
    { target: "Planning", reason: "QA-1063 attempt" });
  ok("FL19 (QA-1063): restoring a batch that already started to Planning is refused, not silently allowed",
    restorePastPlanning.status === 409 && /already ran|real start date/i.test(String(restorePastPlanning.data?.error ?? "")),
    `${restorePastPlanning.status} ${JSON.stringify(restorePastPlanning.data)}`);

  const restorePastReady = await req(admin, "POST", `/api/batches/${b1._id}/transition`,
    { target: "Ready", reason: "QA-1063 attempt" });
  ok("FL19 (QA-1063): ...and the same refusal holds for Ready, even though this batch would otherwise pass readiness's own chain first",
    restorePastReady.status === 409 && /already ran|real start date/i.test(String(restorePastReady.data?.error ?? "")),
    `${restorePastReady.status} ${JSON.stringify(restorePastReady.data)}`);

  // The door this refusal points to must still work: restoring the SAME batch to Active is unaffected.
  const restorePastActive = await req(admin, "POST", `/api/batches/${b1._id}/transition`,
    { target: "Active", reason: "QA-1063 restore to where it belongs" });
  ok("FL19 (QA-1063): ...while restoring it to Active - where it genuinely was - still succeeds",
    restorePastActive.status === 200 && restorePastActive.data?.item?.status === "Active",
    `${restorePastActive.status} ${JSON.stringify(restorePastActive.data?.item?.status ?? restorePastActive.data)}`);

  // And its actual_start is untouched by any of the three attempts above - a refused restore, like
  // an accepted one, changes no dates.
  const b1After = (await req(admin, "GET", `/api/batches/${b1._id}`)).data.item;
  ok("FL19 (QA-1063): actual_start survived all three restore attempts unchanged",
    String(b1After?.actual_start ?? "").slice(0, 10) === istDay(-30),
    JSON.stringify({ actual_start: b1After?.actual_start ?? null, expected: istDay(-30) }));

  await req(admin, "POST", `/api/batches/${b1._id}/transition`, { target: "Cancelled", reason: "FL19 cleanup" }, 200);
  await req(admin, "POST", `/api/batches/${b3._id}/transition`, { target: "Planning", reason: "FL19 cleanup" }, 200);
}



console.log("\n--- FL20 (QA-1023): a .csv must not silently swap day and month ---");
{
  // PRE-EXISTING, not qa-232's - found by that unit's cycle-3 checker and deliberately not charged
  // to it. In a .csv, SheetJS converts a date-looking cell to an Excel serial AT READ TIME using a
  // US MM-DD reading, before any of our code sees it. So the shipped template's own format - its
  // header literally reads "DOB (DD-MM-YYYY)" - is transposed whenever the day is 12 or less:
  //     "05-06-2001" -> serial 37017 -> 6 MAY 2001     (the sheet said 5 June)
  //     "25-12-1999" -> stays a string -> 25 Dec 1999  (survives ONLY because 25 cannot be a month)
  // That second line is why it went unseen: invisible in any sheet whose rows use a day above 12,
  // including our own sample file. A silently wrong DOB changes who counts as eligible.
  const csv = [
    "Student Name,Mobile,DOB",
    `FL20 Swap ${stamp},9822219001,05-06-2001`,   // day 5 <= 12: the trap
    `FL20 Safe ${stamp},9822219002,25-12-1999`,   // day 25 > 12: survived even before the fix
  ].join("\n");
  const csvFile = new File([Buffer.from(csv)], "dates.csv", { type: "text/csv" });
  const cmap = JSON.stringify({ "Student Name": "name", "Mobile": "phone", "DOB": "dob" });
  const cconf = await multipart(admin, "/api/candidates/import",
    { file: csvFile, location: loc._id, program: prog._id, mapping: cmap, confirm: "1" });
  ok("FL20: the .csv imports at all", cconf.status === 201 && cconf.data?.imported === 2,
    JSON.stringify({ s: cconf.status, imported: cconf.data?.imported }));

  const findDob = async (nm) => {
    const hit = ((await req(admin, "GET", `/api/candidates?q=${encodeURIComponent(nm)}&limit=5`)).data.items ?? [])[0];
    if (!hit) return null;
    const d = (await req(admin, "GET", `/api/candidates/${hit._id}`)).data.item?.dob;
    return d ? String(d).slice(0, 10) : null;
  };
  const swap = await findDob(`FL20 Swap ${stamp}`);
  ok("FL20 (QA-1023): 05-06-2001 in a .csv is read as 5 JUNE, the format the template asks for - not 6 May",
    swap === "2001-06-05", JSON.stringify({ got: swap, expected: "2001-06-05" }));
  const safe = await findDob(`FL20 Safe ${stamp}`);
  ok("FL20: ...and the day-above-12 case still reads correctly - the fix did not cost the case that already worked",
    safe === "1999-12-25", JSON.stringify({ got: safe, expected: "1999-12-25" }));

  // A real .xlsx must be untouched by the change: a workbook stores the string AS a string, so only
  // the CSV parser was ever coercing. This pin is what stops the fix leaking into the xlsx path.
  const xrows = [{ "Student Name": `FL20 Xlsx ${stamp}`, "Mobile": "9822219003", "DOB": "05-06-2001" }];
  const xwb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(xwb, XLSX.utils.json_to_sheet(xrows), "Sheet1");
  const xfile = new File([XLSX.write(xwb, { type: "buffer", bookType: "xlsx" })], "dates.xlsx",
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const xconf = await multipart(admin, "/api/candidates/import",
    { file: xfile, location: loc._id, program: prog._id, mapping: cmap, confirm: "1" });
  ok("FL20: an .xlsx with the same value still imports", xconf.status === 201 && xconf.data?.imported === 1,
    JSON.stringify({ s: xconf.status, imported: xconf.data?.imported }));
  const xdob = await findDob(`FL20 Xlsx ${stamp}`);
  ok("FL20: ...and reads as 5 June too - the xlsx path is unchanged",
    xdob === "2001-06-05", JSON.stringify({ got: xdob, expected: "2001-06-05" }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
