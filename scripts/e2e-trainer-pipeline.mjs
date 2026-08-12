// Trainer preparation pipeline E2E (2026-08-12, Manish's RPL walkthrough).
// Walks a trainer from Applied to Certified, and proves the parts that matter operationally:
// documents gate the nomination, an NSDC rejection can be corrected and resent, a TR ID is
// required to certify, and the per-centre counters are derived rather than stored.
// Run: node scripts/e2e-trainer-pipeline.mjs
const BASE = process.env.BASE_URL || "http://localhost:3000/erp";
let cookie = "";
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + " " + x); } };

async function req(method, path, body, expect) {
  const res = await fetch(BASE + path, {
    method, headers: { "Content-Type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {}; try { data = await res.json(); } catch {}
  if (expect !== undefined) {
    ok(`${method} ${path.split("?")[0]} → ${expect}`, res.status === expect, `(got ${res.status}: ${JSON.stringify(data).slice(0, 130)})`);
  }
  return { status: res.status, data };
}

// login
const csrfRes = await fetch(BASE + "/api/auth/csrf");
const { csrfToken } = await csrfRes.json();
const csrfCookie = csrfRes.headers.get("set-cookie").split(";")[0];
const loginRes = await fetch(BASE + "/api/auth/callback/credentials", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: csrfCookie },
  body: new URLSearchParams({ csrfToken, email: "admin@vidysea.com", password: process.env.ADMIN_PASSWORD || "admin123" }),
  redirect: "manual",
});
const session = (loginRes.headers.getSetCookie?.() ?? [loginRes.headers.get("set-cookie")]).flat().filter(Boolean).map((c) => c.split(";")[0]).find((c) => c.includes("session-token"));
cookie = [csrfCookie, session].join("; ");
ok("login", !!session);

const stamp = "TP" + Date.now().toString().slice(-6);

// A real-shaped fixture: a scheme-bearing job role and a centre with an approved TC.
const prog = (await req("POST", "/api/programs", {
  code: "P" + stamp, name: "Drone Service Technician " + stamp, trainer_skill: "DST" + stamp,
  scheme: "RPL-AVPL", qp_code: "ASC/Q" + stamp.slice(-4), scheme_priority: 1,
}, 201)).data.item;
ok("programme carries its scheme", prog.scheme === "RPL-AVPL", prog.scheme);

const loc = (await req("POST", "/api/locations", {
  code: "L" + stamp, name: "Govt. ITI " + stamp, state: "UP", district: "Muzaffarnagar",
  tc_id: "TC" + stamp, tc_status: "Approved", operating_partner: "Vidysea", approval_status: "Approved",
}, 201)).data.item;
ok("centre carries its TC identity", loc.tc_id === "TC" + stamp && loc.tc_status === "Approved", JSON.stringify({ tc: loc.tc_id, s: loc.tc_status }));

const tr = (await req("POST", "/api/trainers", {
  name: "Pipeline Trainer " + stamp, phone: "9" + Date.now().toString().slice(-9),
  skills: ["DST" + stamp], home_location: loc._id, pipeline_status: "Applied",
  nominated_for_location: loc._id, nominated_for_program: prog._id,
}, 201)).data.item;
const T = `/api/trainers/${tr._id}/transition`;

// ---- the machine will not let you skip the journey ----
await req("POST", T, { target: "Certified" }, 409);
await req("POST", T, { target: "Submitted to NSDC" }, 409);
await req("POST", T, { target: "CV Reviewed" }, 200);
await req("POST", T, { target: "Shortlisted" }, 200);
await req("POST", T, { target: "Docs Pending" }, 200);

// ---- documents gate the nomination (Rule T2) ----
const D = `/api/trainers/${tr._id}/documents`;
const before = (await req("GET", D)).data;
ok("every mandatory document is reported missing up front", before.summary.missing.length === 5, JSON.stringify(before.summary.missing));
await req("POST", T, { target: "Nomination Prepared" }, 409); // still missing everything

await req("POST", D, { doc_type: "Aadhaar", file_url: "/erp/api/files/aaaa.pdf", original_name: "aadhaar.pdf" }, 201);
await req("POST", D, { doc_type: "PAN", file_url: "/erp/api/files/bbbb.pdf" }, 201);
await req("POST", D, { doc_type: "Photo", file_url: "/erp/api/files/cccc.jpg" }, 201);
await req("POST", D, { doc_type: "CV", file_url: "/erp/api/files/dddd.docx" }, 201);
await req("POST", T, { target: "Docs Complete" }, 200);
await req("POST", T, { target: "Nomination Prepared" }, 409); // one still missing
const partial = (await req("GET", D)).data;
ok("the gate names exactly what is still missing", partial.summary.missing.join() === "Educational Qualification", JSON.stringify(partial.summary.missing));

await req("POST", D, { doc_type: "Educational Qualification", file_url: "/erp/api/files/eeee.pdf" }, 201);
const complete = (await req("GET", D)).data;
ok("documents complete once the last one is in", complete.summary.complete === true);
// re-uploading a type replaces rather than duplicates — what happens when NSDC bounces a profile
await req("POST", D, { doc_type: "PAN", file_url: "/erp/api/files/pan-v2.pdf" }, 201);
const afterReplace = (await req("GET", D)).data;
ok("re-uploading a document replaces it instead of stacking duplicates",
  afterReplace.items.filter((d) => d.doc_type === "PAN").length === 1, `${afterReplace.items.filter((d) => d.doc_type === "PAN").length}`);

await req("POST", T, { target: "Nomination Prepared" }, 200);
await req("POST", T, { target: "Submitted to NSDC" }, 200);

// ---- the NSDC round-trip: rejection must carry remarks, and must be recoverable ----
await req("POST", T, { target: "NSDC Rejected" }, 400); // no remarks
const rej = await req("POST", T, { target: "NSDC Rejected", remarks: "Experience certificate not attested" }, 200);
ok("a rejection records what NSDC actually said", rej.data.item.nsdc_remarks === "Experience certificate not attested", rej.data.item.nsdc_remarks);
// "profile mein truti batate hain… hum isko correct karke wapas bhej rahe hain" — this must work
await req("POST", T, { target: "Docs Pending" }, 200);
await req("POST", D, { doc_type: "Industry Experience", file_url: "/erp/api/files/exp.docx" }, 201);
await req("POST", T, { target: "Docs Complete" }, 200);
await req("POST", T, { target: "Nomination Prepared" }, 200);
await req("POST", T, { target: "Submitted to NSDC" }, 200);
const appr = await req("POST", T, { target: "NSDC Approved" }, 200);
ok("approval clears the old rejection remarks", !appr.data.item.nsdc_remarks, appr.data.item.nsdc_remarks);

// ---- payment, TOT, TR ID ----
const paid = await req("POST", T, { target: "Payment Done", payload: { payment_reference: "NEFT-" + stamp } }, 200);
ok("the ₹3250 eligibility payment is recorded", paid.data.item.eligibility_payment_amount === 3250 && !!paid.data.item.paid_on,
  JSON.stringify({ amt: paid.data.item.eligibility_payment_amount, on: paid.data.item.paid_on }));
await req("POST", T, { target: "TOT Scheduled", date: new Date().toISOString() }, 200);
await req("POST", T, { target: "TOT In Progress" }, 200);
await req("POST", T, { target: "Certified" }, 400); // Rule T5 — no TR ID
const cert = await req("POST", T, { target: "Certified", payload: { tr_id: "TR" + stamp, tot_certificate_no: "TOT-" + stamp } }, 200);
ok("certification records the TR ID the portal asks for", cert.data.item.tr_id === "TR" + stamp, cert.data.item.tr_id);
ok("…and stamps the TOT completion date", !!cert.data.item.tot_done_on);

// ---- the counters are derived, not stored ----
await req("PUT", `/api/locations/${loc._id}/targets`, { program: prog._id, approved_target: 135, trainers_required: 2 }, 200);
const ready = await req("GET", `/api/mapping/readiness?location=${loc._id}`, undefined, 200);
const row = (ready.data.items ?? [])[0];
ok("readiness reports the derived certified count", row?.trainers?.certified === 1, JSON.stringify(row?.trainers));
ok("…against the requirement from the sheet", row?.trainers?.required === 2, JSON.stringify(row?.trainers));
ok("…and blocks on candidates, since the centre and trainer are now ready",
  row && row.ready === false && /candidates/.test(row.next_action), JSON.stringify(row?.next_action));

// a second trainer must not be creatable on the same phone (the model had no unique index at all)
const dup = await req("POST", "/api/trainers", { name: "Dup", phone: tr.phone, skills: ["x"] });
ok("a duplicate trainer phone is refused", dup.status >= 400, `got ${dup.status}`);

// ---- terminal state needs a reason ----
const t2 = (await req("POST", "/api/trainers", { name: "Drop Me " + stamp, phone: "8" + Date.now().toString().slice(-9), skills: ["x" + stamp] }, 201)).data.item;
await req("POST", `/api/trainers/${t2._id}/transition`, { target: "Dropped" }, 400);
await req("POST", `/api/trainers/${t2._id}/transition`, { target: "Dropped", reason: "Took another offer" }, 200);
const reopened = await req("POST", `/api/trainers/${t2._id}/transition`, { target: "Applied" }, 200);
ok("a dropped trainer can be re-opened if they come back", reopened.data.item.pipeline_status === "Applied" && reopened.data.item.active === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
