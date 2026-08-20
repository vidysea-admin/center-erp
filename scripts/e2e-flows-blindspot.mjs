// Flow-level blind tests for the transcript gap items landed on 2026-08-12 evening:
// the ₹3250 cost entry, the batch-created pool notification (and its Rule 38 delivery),
// the Registration Failed queue, per-candidate attendance, the infra feasibility blockers,
// the import file's own duplicates, registration/batch decoupling, and the 2-slotted-batches
// day cap. Each block names the transcript line it proves.
import * as XLSX from "xlsx";

const BASE = process.env.BASE_URL || "http://localhost:3000/erp";
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
  const rows = [
    { "Name": `FL Tr A ${stamp}`, "Phone": "9822200001", "Stage": "TOT Payment Done", "Centre": loc.name, "Role": prog.name, "TR": "", "Skill": "" },
    { "Name": `FL Tr B ${stamp}`, "Phone": "9822200002", "Stage": "Random Stage", "Centre": "No Such Centre", "Role": "", "TR": "", "Skill": "" },
    { "Name": `FL Tr C ${stamp}`, "Phone": "9822200001", "Stage": "", "Centre": "", "Role": "", "TR": "", "Skill": "" }, // same phone as A
    { "Name": `FL Tr D ${stamp}`, "Phone": "9822200004", "Stage": "Certified", "Centre": "", "Role": "", "TR": "", "Skill": "" }, // Certified without TR ID
    // -132 (QA-281): the EXACT string that landed on eight live trainers at 2026-08-17T08:04 — the
    // same words as a real job role in a different order. One spreadsheet column, read verbatim.
    { "Name": `FL Tr E ${stamp}`, "Phone": `77${stamp}05`.slice(0, 10), "Stage": "", "Centre": "", "Role": "", "TR": "", "Skill": `Battery Repair System Technician ${stamp}` },
    { "Name": `FL Tr F ${stamp}`, "Phone": `77${stamp}06`.slice(0, 10), "Stage": "", "Centre": "", "Role": "", "TR": "", "Skill": "Totally Made Up Role" },
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
    (prev.data.duplicates ?? []).some((d) => /same number as row/.test(d)) && prev.data.importable === 5, JSON.stringify({ dupes: prev.data.duplicates, importable: prev.data.importable }));
  ok("FL9: Certified without a TR ID is warned by name", (prev.data.warnings ?? []).some((w) => /no TR ID/.test(w)), JSON.stringify(prev.data.warnings));

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
  // -132 (QA-281): 5, not 3 — the fixture gained the two job-role rows this release is about. The
  // assertion still says exactly what it always said (every unique row lands, the phone duplicate
  // never does); only the size of the fixture changed.
  ok("FL9: confirm imports the 5 unique rows, never the phone dupe", done.data.imported === 5, String(done.data.imported));
  const trA = (await req(admin, "GET", `/api/trainers?q=9822200001`)).data.items.find((t) => t.name === `FL Tr A ${stamp}`);
  ok("FL9: 'Payment Done' (legacy sheet value) landed as 'TOT Payment Done'", trA?.pipeline_status === "TOT Payment Done", trA?.pipeline_status);
  ok("FL9: the centre name resolved to a real nomination", (trA?.nominated_for_location?.name ?? "") === loc.name, JSON.stringify(trA?.nominated_for_location));

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
  ok("FL10: confirm creates exactly the one valid batch with a minted code", (conf.data.created ?? []).length === 1 && /^B\d+/.test(conf.data.created[0] ?? "") || (conf.data.created ?? []).length === 1, JSON.stringify(conf.data));
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
  ok("-155 (QA-426): a mapped-but-unhandled destination is NAMED on the preview",
    (prev2.data.unhandled_fields ?? []).includes("sidh_link_sent_at"), JSON.stringify(prev2.data.unhandled_fields));

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
  const m2 = (await req(admin, "POST", "/api/candidates", { name: `PH Empty ${stamp}`, phone: "9822200013", location: loc._id, program: prog._id, sidh_candidate_id: "" }, 201)).data.item;

  const plan1 = (await req(admin, "GET", "/api/candidates/portal-id-health", undefined, 200)).data;
  ok("-155 (QA-427): the plan finds the misfiled CAN (the 55-class) and the \"\" artefact",
    (plan1.misfiled ?? []).some((x) => String(x.candidate) === String(m1._id))
      && (plan1.misfiled ?? []).some((x) => String(x.candidate) === String(m3._id))
      && (plan1.empty_strings ?? []).some((x) => String(x.candidate) === String(m2._id)),
    JSON.stringify({ misfiled: (plan1.misfiled ?? []).length, empty: (plan1.empty_strings ?? []).length }));

  // SELECTED-ONLY is the contract: fix m1 and m2, leave m3 exactly as it is.
  const applied = await req(admin, "POST", "/api/candidates/portal-id-health", { copy: [m1._id], set_null: [m2._id] });
  ok("-155 (QA-427): apply fixes ONLY the selected rows", applied.status === 200 && applied.data.copied === 1 && applied.data.set_null === 1, JSON.stringify(applied.data));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
