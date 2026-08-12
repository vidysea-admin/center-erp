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
const phone = () => "7" + Date.now().toString().slice(-9) + Math.floor(Math.random() * 9);

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
  for (const s of ["CV Reviewed", "Shortlisted", "Docs Pending", "Docs Complete", "Nomination Prepared", "Submitted to NSDC", "NSDC Approved"]) {
    await req(admin, "POST", `/api/trainers/${t._id}/transition`, { target: s });
  }
  await req(admin, "POST", `/api/trainers/${t._id}/transition`, { target: "Payment Done", payload: { payment_reference: `NEFT-FL${stamp}` } }, 200);
  const costs = (await req(admin, "GET", `/api/costs?trainer=${t._id}`)).data.items ?? [];
  const fee = costs.filter((c) => /eligibility/i.test(c.category?.name ?? ""));
  ok("FL1: the eligibility fee landed in the cost model", fee.length === 1 && fee[0].amount === 3250, JSON.stringify(fee.map((f) => f.amount)));

  // Walk the same trainer out and back through the stage — the fee must not book twice.
  await req(admin, "POST", `/api/trainers/${t._id}/transition`, { target: "Dropped", reason: "Test detour" }, 200);
  await req(admin, "POST", `/api/trainers/${t._id}/transition`, { target: "Applied" }, 200);
  for (const s of ["CV Reviewed", "Shortlisted", "Docs Pending", "Docs Complete", "Nomination Prepared", "Submitted to NSDC", "NSDC Approved", "Payment Done"]) {
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
    location: loc._id, program: prog._id, planned_start: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
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
    available_from: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10),
  }, 201)).data.item;
  const room2 = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "FL Room 2", type: "Classroom", capacity: 30 }, 201)).data.item;
  const b = (await req(admin, "POST", "/api/batches", {
    location: loc._id, program: prog._id, trainer: tr._id, room: room2._id, target_size: 2,
    planned_start: new Date().toISOString().slice(0, 10),
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
    log_date: new Date().toISOString().slice(0, 10),
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
    { "Student Name": `FL Imp A ${stamp}`, "Mobile": "9811100001", "Junk": "x" },
    { "Student Name": `FL Imp B ${stamp}`, "Mobile": "9811100002", "Junk": "y" },
    { "Student Name": `FL Imp C ${stamp}`, "Mobile": "9811100001", "Junk": "z" }, // same phone as A
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
}

console.log("\n--- FL7: an unregistered candidate can still be assigned (decoupled, by design) ---");
{
  // GD-78/80: registration and batch-assignment are separate facilities; assignment must not
  // demand prior SIDH registration — the readiness gate reports the shortfall instead.
  const c = (await req(admin, "POST", "/api/candidates", { name: `FL Unreg ${stamp}`, phone: phone(), location: loc._id, program: prog._id }, 201)).data.item;
  const b = (await req(admin, "POST", "/api/batches", {
    location: loc._id, program: prog._id, planned_start: new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10),
  }, 201)).data.item;
  const add = await req(admin, "POST", `/api/batches/${b._id}/members`, { candidate: c._id });
  ok("FL7: assignment succeeds although SIDH status is Not Registered", add.status === 201, `got ${add.status}`);
}

console.log("\n--- FL8: the day holds two slotted batches per trainer, never three ---");
{
  // GD-118/123: "chaar-chaar ghante ke do batch" — up to 4 concurrent, but 2 slotted per DAY.
  const tr = (await req(admin, "POST", "/api/trainers", {
    name: `FL Slots ${stamp}`, phone: phone(), skills: [`fl${stamp}`], pipeline_status: "Certified",
    available_from: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), max_concurrent_batches: 4,
  }, 201)).data.item;
  const start = new Date(Date.now() + 50 * 864e5).toISOString().slice(0, 10);
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
    planned_start: new Date(Date.now() + 150 * 864e5).toISOString().slice(0, 10), slot_start: "10:00", slot_end: "14:00",
  });
  ok("FL8: the same slot after the earlier batches END is fine", later.status === 201, `got ${later.status}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
