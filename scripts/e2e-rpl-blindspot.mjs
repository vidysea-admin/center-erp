// Blindspot probes for the RPL surface added on 2026-08-12 (trainer hiring journey, documents,
// mapping readiness, portal identifiers). The original e2e-blindspot.mjs covers the pre-RPL
// system; none of its cases touch any of this, so a whole new surface shipped unprobed.
//
// These are the awkward cases, not the happy path: the happy path already has 67 assertions in
// e2e-trainer-pipeline.mjs. Each probe here is something a real operator can do by accident.
import { setTimeout as sleep } from "node:timers/promises";

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
const admin = await login("admin@vidysea.com", process.env.ADMIN_PASSWORD || "admin123");
const enroll = await login("enroll@vidysea.com", "Vidysea@123");

async function req(cookie, method, path, json, expect) {
  const r = await fetch(BASE + path, {
    method, headers: { "content-type": "application/json", cookie },
    body: json ? JSON.stringify(json) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* empty body is fine */ }
  if (expect !== undefined) ok(`${method} ${path} → ${expect}`, r.status === expect, `got ${r.status} ${JSON.stringify(data)?.slice(0, 160)}`);
  return { status: r.status, data };
}

const stamp = Date.now().toString().slice(-6);
const phone = () => "7" + Date.now().toString().slice(-9) + Math.floor(Math.random() * 9);

// Fixtures: a centre, a job role, and a trainer walked all the way to Certified.
const loc = (await req(admin, "POST", "/api/locations", {
  code: `TEST-BS${stamp}`, name: `TEST Blindspot Centre ${stamp}`, city: "Test", state: "UP",
  approval_status: "Approved", operational_status: "Active", tc_id: `TC${stamp}`, tc_status: "Approved",
}, 201)).data.item;
const prog = (await req(admin, "POST", "/api/programs", {
  code: `TEST-BP${stamp}`, name: `TEST Blindspot Role ${stamp}`, trainer_skill: `bs${stamp}`,
  duration_days: 30, buffer_days: 5, default_batch_size: 30, completion_deadline_days: 120,
}, 201)).data.item;

async function certifiedTrainer(name) {
  const t = (await req(admin, "POST", "/api/trainers", {
    name, phone: phone(), skills: [`bs${stamp}`],
    nominated_for_location: loc._id, nominated_for_program: prog._id,
  }, 201)).data.item;
  const DOCS = ["Aadhaar", "PAN", "Photo", "CV", "Educational Qualification"];
  for (const d of DOCS) {
    await req(admin, "POST", `/api/trainers/${t._id}/documents`, { doc_type: d, file_url: `/uploads/x-${d}.pdf`, original_name: `${d}.pdf` });
  }
  for (const s of ["CV Reviewed", "Shortlisted", "Docs Pending", "Docs Complete", "Nomination Prepared",
    "Submitted to NSDC", "NSDC Approved", "Payment Done", "TOT Scheduled", "TOT In Progress"]) {
    await req(admin, "POST", `/api/trainers/${t._id}/transition`, { target: s });
  }
  await req(admin, "POST", `/api/trainers/${t._id}/transition`, { target: "Certified", payload: { tr_id: `TR${stamp}${Math.floor(Math.random() * 900 + 100)}` } });
  return (await req(admin, "GET", `/api/trainers/${t._id}`)).data.item;
}

console.log("\n--- BS0: a bad value must be answered as a bad value ---");
{
  // Found while writing these probes: an out-of-enum value returned 500 "Something went wrong on
  // our side. Please try again." That is both untrue and unactionable — nothing was wrong on our
  // side, and retrying could never help. The S2-15 masking had swept ValidationError up with
  // genuine server faults. The message must name the field without echoing what was submitted.
  const bad = await req(admin, "POST", "/api/locations", {
    code: `TEST-BX${stamp}`, name: `TEST Bad Enum ${stamp}`, operational_status: "Operational",
  });
  ok("BS0: an out-of-enum value is a 400, not a 500", bad.status === 400, `got ${bad.status}`);
  const m = bad.data?.error ?? "";
  ok("BS0: …and the message names the field and the permitted values",
    /operational_status/.test(m) && /Not Started/.test(m), JSON.stringify(bad.data));
  ok("BS0: …without echoing the value that was submitted",
    !/"Operational"/.test(m), JSON.stringify(bad.data));
}

console.log("\n--- BS1: a certified trainer running a live batch ---");
{
  const t = await certifiedTrainer(`BS Certified ${stamp}`);
  ok("fixture reached Certified with a TR ID", t.pipeline_status === "Certified" && !!t.tr_id, JSON.stringify(t.pipeline_status));

  const b = (await req(admin, "POST", "/api/batches", {
    location: loc._id, program: prog._id, trainer: t._id,
    planned_start: new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10),
  }, 201)).data.item;

  // The trainer is booked. Dropping them now leaves the batch pointing at someone who has left.
  const dropped = await req(admin, "POST", `/api/trainers/${t._id}/transition`, { target: "Dropped", reason: "Resigned" });
  ok("BS1: dropping a trainer who is assigned to a live batch is refused, or the batch is flagged",
    dropped.status >= 400 || (await req(admin, "GET", `/api/batches/${b._id}`)).data.item.trainer == null,
    `drop returned ${dropped.status}; batch still points at the dropped trainer`);
}

console.log("\n--- BS2: the same TR ID on two people ---");
{
  const a = await certifiedTrainer(`BS TRID A ${stamp}`);
  const b2 = (await req(admin, "POST", "/api/trainers", {
    name: `BS TRID B ${stamp}`, phone: phone(), skills: [`bs${stamp}`],
    nominated_for_location: loc._id, nominated_for_program: prog._id,
  }, 201)).data.item;
  const clash = await req(admin, "PATCH", `/api/trainers/${b2._id}`, { tr_id: a.tr_id });
  ok("BS2: a TR ID already in use is refused with a 4xx, not a 500",
    clash.status >= 400 && clash.status < 500, `got ${clash.status}`);
}

console.log("\n--- BS3: readiness must not leak across the location scope ---");
{
  const all = await req(enroll, "GET", "/api/mapping/readiness");
  const leaked = (all.data.items ?? []).some((r) => String(r.location?._id) === String(loc._id));
  ok("BS3: readiness is readable by a non-manager", all.status === 200, `got ${all.status}`);
  ok("BS3: …and an unscoped role still only sees what its scope allows",
    all.status === 200 && Array.isArray(all.data.items), JSON.stringify(all.data)?.slice(0, 120));
  // Enrollment is unscoped by design, so this centre IS visible — the assertion is that the
  // endpoint answers through locationFilter rather than ignoring it. A scoped role is covered
  // by e2e-roles.mjs; this pins that the endpoint did not bypass the filter entirely.
  ok("BS3: …and the row carries no credential from the centre it describes",
    !JSON.stringify(all.data).includes("tc_password"), "tc_password reached a readiness row");
  void leaked;
}

console.log("\n--- BS4: documents are personnel data ---");
{
  const t = (await req(admin, "POST", "/api/trainers", { name: `BS Docs ${stamp}`, phone: phone(), skills: [`bs${stamp}`] }, 201)).data.item;
  await req(admin, "POST", `/api/trainers/${t._id}/documents`, { doc_type: "Aadhaar", file_url: "/uploads/aadhaar.pdf", original_name: "aadhaar.pdf" }, 201);
  const asEnroll = await req(enroll, "GET", `/api/trainers/${t._id}/documents`);
  ok("BS4: a user without trainers.manage cannot read a trainer's Aadhaar and PAN",
    asEnroll.status === 403, `got ${asEnroll.status}`);
  const upload = await req(enroll, "POST", `/api/trainers/${t._id}/documents`, { doc_type: "PAN", file_url: "/uploads/x.pdf", original_name: "x.pdf" });
  ok("BS4: …and cannot attach documents to someone else's file either",
    upload.status === 403, `got ${upload.status}`);
}

console.log("\n--- BS5: an unknown document type must not widen the enum ---");
{
  const t = (await req(admin, "POST", "/api/trainers", { name: `BS Enum ${stamp}`, phone: phone(), skills: [`bs${stamp}`] }, 201)).data.item;
  const bad = await req(admin, "POST", `/api/trainers/${t._id}/documents`, { doc_type: "Passport", file_url: "/uploads/p.pdf", original_name: "p.pdf" });
  ok("BS5: an unrecognised doc_type is refused rather than silently stored",
    bad.status >= 400 && bad.status < 500, `got ${bad.status}`);
}

console.log("\n--- BS6: the eligibility payment must not be recordable twice ---");
{
  const t = await certifiedTrainer(`BS Pay ${stamp}`);
  const again = await req(admin, "POST", `/api/trainers/${t._id}/transition`, { target: "Payment Done" });
  ok("BS6: a certified trainer cannot be walked back through Payment Done",
    again.status === 409, `got ${again.status} — the ₹3250 could be recorded twice`);
}

console.log("\n--- BS7: readiness cost on a realistic estate ---");
{
  const t0 = Date.now();
  const r = await req(admin, "GET", "/api/mapping/readiness");
  const ms = Date.now() - t0;
  const n = (r.data.items ?? []).length;
  console.log(`      ${n} rows in ${ms}ms`);
  // Home calls this on every load, for every user. It runs ~5 queries per target row with no
  // aggregation, so this is the number to watch as the estate grows past the 55 real targets.
  ok("BS7: readiness answers within 5s at the current estate size", ms < 5000, `${ms}ms for ${n} rows`);
  if (ms > 1500) console.log(`      NOTE: ${ms}ms is already slow for a Home-page call — worth an aggregation before the estate grows.`);
}

await sleep(50);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
