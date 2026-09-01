// Trainer preparation pipeline E2E (2026-08-12, Manish's RPL walkthrough).
// Walks a trainer from Fresh Lead to Certified, and proves the parts that matter operationally:
// documents gate the nomination, an NSDC rejection can be corrected and resent, a TR ID is
// required to certify, and the per-centre counters are derived rather than stored.
// Run: node scripts/e2e-trainer-pipeline.mjs
// QA-1692: guarded via requireLocalBase (db-guard.mjs) — see e2e.mjs's own note.
import { requireLocalBase } from "./db-guard.mjs";
const BASE = requireLocalBase("e2e-trainer-pipeline", process.env.BASE_URL || "http://localhost:3000/erp");
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
  skills: ["DST" + stamp], home_location: loc._id, pipeline_status: "Fresh Lead",
  nominated_for_location: loc._id, nominated_for_program: prog._id,
}, 201)).data.item;
const T = `/api/trainers/${tr._id}/transition`;

// ---- the machine will not let you skip the journey (2026-08-14 merged stages) ----
await req("POST", T, { target: "Certified" }, 409);
await req("POST", T, { target: "Sent to NSDC" }, 409);
await req("POST", T, { target: "Docs Pending" }, 409); // retired name (2026-08-14 CEO vocabulary)
await req("POST", T, { target: "Shortlisted" }, 200);
await req("POST", T, { target: "Docs Complete" }, 409); // retired name — never a stage again

// ---- documents gate the nomination (Rule T2 — the T1 check lives here since the merge) ----
const D = `/api/trainers/${tr._id}/documents`;
const before = (await req("GET", D)).data;
ok("every mandatory document is reported missing up front", before.summary.missing.length === 5, JSON.stringify(before.summary.missing));
await req("POST", T, { target: "Documents Completed" }, 409); // still missing everything

await req("POST", D, { doc_type: "Aadhaar", file_url: "/erp/api/files/aaaa.pdf", original_name: "aadhaar.pdf" }, 201);
await req("POST", D, { doc_type: "PAN", file_url: "/erp/api/files/bbbb.pdf" }, 201);
await req("POST", D, { doc_type: "Photo", file_url: "/erp/api/files/cccc.jpg" }, 201);
await req("POST", D, { doc_type: "CV", file_url: "/erp/api/files/dddd.docx" }, 201);
// Four of five is refused, and the refusal names the one still missing (was Rule T1's job).
const halfway = await req("POST", T, { target: "Documents Completed" });
ok("the gate names exactly what is still missing",
  halfway.status === 409 && /Educational Qualification/.test(halfway.data?.error ?? ""), `got ${halfway.status} ${halfway.data?.error ?? ""}`);

await req("POST", D, { doc_type: "Educational Qualification", file_url: "/erp/api/files/eeee.pdf" }, 201);
const complete = (await req("GET", D)).data;
ok("documents complete once the last one is in", complete.summary.complete === true);
// re-uploading a type replaces rather than duplicates — what happens when NSDC bounces a profile
await req("POST", D, { doc_type: "PAN", file_url: "/erp/api/files/pan-v2.pdf" }, 201);
const afterReplace = (await req("GET", D)).data;
ok("re-uploading a document replaces it instead of stacking duplicates",
  afterReplace.items.filter((d) => d.doc_type === "PAN").length === 1, `${afterReplace.items.filter((d) => d.doc_type === "PAN").length}`);

// ---- QA-112 (15/08): a wrong file is REMOVABLE — delete exists, audited, then re-add ----
{
  const pan = afterReplace.items.find((d) => d.doc_type === "PAN");
  const del = await req("DELETE", `${D}/${pan._id}`, undefined, 200);
  ok("QA-112: deleting a document reports the fresh summary", del.data.summary?.missing?.includes("PAN"), JSON.stringify(del.data.summary?.missing));
  await req("DELETE", `${D}/${pan._id}`, undefined, 404); // gone is gone
  const gate = await req("POST", T, { target: "Documents Completed" });
  ok("QA-112: the docs gate honestly reopens after the delete", gate.status === 409 && /PAN/.test(gate.data?.error ?? ""), `got ${gate.status}`);
  await req("POST", D, { doc_type: "PAN", file_url: "/erp/api/files/pan-v3.pdf" }, 201); // replace = delete + re-add
}

await req("POST", T, { target: "Documents Completed" }, 200);

// ---- QA-1284: the Locations grid's own "Nominated to NSDC" figure ----
// Client, 2026-08-25, on Basti: "NSDC ko toh yeh TOT in progress hai ... toh apne ko is wale me
// locations me Basti wale me apne ko dikhni chahiye Nominated. Yeh update nahi ho raha sir."
// Until this release that column carried ONLY the number typed into the client's workbook, so a
// nomination we had actually sent moved nothing. The assertion is a BEFORE/AFTER across one
// transition, because a bare "it is 1" would also pass if the field counted the wrong thing.
// This suite had never needed a LocationTarget, and the Locations grid's job_roles rows are BUILT
// from LocationTarget - no target, no row, and my first version of these three assertions failed
// with `{}` because of that, not because the product was wrong. PUT is the verb: the targets route
// exports GET/PUT/PATCH and no POST, and PUT upserts on {location, program} (the same trap the
// locations-admin suite hit and fixed in 553fc6e).
//
// DO NOT ADD `tc_status` TO THIS LINE. It carried `tc_status: "Approved"` for one release and that
// silently broke the R-G block ~70 lines below, which opens by saying "The target above was written
// WITHOUT a TC approval - the DEFAULT board must not list it". That sentence became false here, so
// R-G went red on two assertions ("7 rows", "null") and read like an Open Positions defect. It was
// not: it was this line. R-G's whole narrative is unapproved -> approve -> appears, and it does its
// own approving at the end. QA-1284 does not need the approval either - its assertions are about
// `trainers_nominated` / `trainers_nsdc`, and the job_roles row exists because the TARGET exists,
// not because it is approved.
//
// This is the fourth time in one day that fixing a fixture exposed a LATER assertion whose
// precondition it had quietly destroyed. Writing the dependency down is the only thing that stops
// the fifth.
await req("PUT", `/api/locations/${loc._id}/targets`, { program: prog._id, trainers_required: 1, approved_target: 30 }, 200);

const nsdcOf = async () => {
  const rows = (await req("GET", "/api/locations?limit=2000")).data.items ?? [];
  const jr = (rows.find((l) => String(l._id) === String(loc._id))?.job_roles ?? [])
    .find((j) => String(j.program_id) === String(prog._id));
  return jr ?? {};
};
const beforeNsdc = await nsdcOf();
ok("QA-1284: a trainer at Documents Completed is nominated to the centre but has NOT reached NSDC",
  (beforeNsdc.trainers_nominated ?? 0) === 1 && (beforeNsdc.trainers_nsdc ?? 0) === 0,
  JSON.stringify({ nominated: beforeNsdc.trainers_nominated, nsdc: beforeNsdc.trainers_nsdc }));

await req("POST", T, { target: "Sent to NSDC" }, 200);

const afterNsdc = await nsdcOf();
ok("QA-1284: sending that same trainer to NSDC moves the centre's own Nominated-to-NSDC figure",
  (afterNsdc.trainers_nsdc ?? 0) === 1,
  JSON.stringify({ nominated: afterNsdc.trainers_nominated, nsdc: afterNsdc.trainers_nsdc }));
// QA-1283's sibling: the grid also needs the in-pipeline figure it was already computing and dropping.
ok("QA-1284: the in-pipeline figure reaches the grid too",
  (afterNsdc.trainers_in_pipeline ?? 0) >= 1, JSON.stringify({ in_pipeline: afterNsdc.trainers_in_pipeline }));

// ---- the NSDC round-trip: rejection must carry remarks, and must be recoverable ----
await req("POST", T, { target: "NSDC Rejected" }, 400); // no remarks
const rej = await req("POST", T, { target: "NSDC Rejected", remarks: "Experience certificate not attested" }, 200);
ok("a rejection records what NSDC actually said", rej.data.item.nsdc_remarks === "Experience certificate not attested", rej.data.item.nsdc_remarks);
// "profile mein truti batate hain… hum isko correct karke wapas bhej rahe hain" — this must work
await req("POST", T, { target: "Shortlisted" }, 200);
await req("POST", D, { doc_type: "Industry Experience", file_url: "/erp/api/files/exp.docx" }, 201);
await req("POST", T, { target: "Documents Completed" }, 200);
await req("POST", T, { target: "Sent to NSDC" }, 200);
const appr = await req("POST", T, { target: "NSDC Approved" }, 200);
ok("approval clears the old rejection remarks", !appr.data.item.nsdc_remarks, appr.data.item.nsdc_remarks);

// ---- payment, TOT, TR ID ----
const paid = await req("POST", T, { target: "TOT Payment Done", payload: { payment_reference: "NEFT-" + stamp } }, 200);
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

// Infra feasibility (2026-08-08: "classroom do hi hai, lab ek hi hai — can that be managed or
// not"): with no room on record, readiness must say so; adding one clears it.
{
  const noRoom = await req("GET", `/api/mapping/readiness?location=${loc._id}`, undefined, 200);
  const r0 = (noRoom.data.items ?? [])[0];
  ok("a centre with no room is named as such", r0?.blockers?.some((b) => /no room/.test(b)), JSON.stringify(r0?.blockers));
  await req("POST", `/api/locations/${loc._id}/rooms`, { name: "Room 1", type: "Classroom", capacity: 30 }, 201);
}

const ready = await req("GET", `/api/mapping/readiness?location=${loc._id}`, undefined, 200);
const row = (ready.data.items ?? [])[0];
ok("readiness reports the derived certified count", row?.trainers?.certified === 1, JSON.stringify(row?.trainers));
ok("…against the requirement from the sheet", row?.trainers?.required === 2, JSON.stringify(row?.trainers));
ok("…and the room blocker cleared once a room exists", !row?.blockers?.some((b) => /no room/.test(b)), JSON.stringify(row?.blockers));
ok("…and blocks on candidates, since the centre and trainer are now ready",
  row && row.ready === false && /candidates/.test(row.next_action), JSON.stringify(row?.next_action));

// ---- R-G (CEO 14/08 [07:56, 09:01, 09:12]): the Open Positions board maps the pipeline ----
{
  // The target above was written without a TC approval — the DEFAULT board must not list it…
  const def = await req("GET", "/api/open-positions", undefined, 200);
  ok("R-G: an unapproved position stays off the default board",
    !(def.data.items ?? []).some((p) => String(p.location._id) === String(loc._id)), `${def.data.items?.length} rows`);
  // …but ?approved=all shows it, with the reason named.
  const all = await req("GET", "/api/open-positions?approved=all", undefined, 200);
  const mineAll = (all.data.items ?? []).find((p) => String(p.location._id) === String(loc._id));
  ok("R-G: ?approved=all surfaces it with the reason named",
    !!mineAll && mineAll.approved === false && /TC status/.test(mineAll.approved_reason ?? ""), JSON.stringify(mineAll?.approved_reason));
  // Approve the row; the position appears with the pipeline mapped and the trainer named.
  await req("PUT", `/api/locations/${loc._id}/targets`, { program: prog._id, tc_status: "Approved" }, 200);
  const board = await req("GET", "/api/open-positions", undefined, 200);
  const mine = (board.data.items ?? []).find((p) => String(p.location._id) === String(loc._id));
  ok("R-G: the approved position lists with the pipeline mapped",
    !!mine && mine.stages?.certified === 1 && mine.status === "Open" && mine.balance === 1, JSON.stringify(mine?.stages));
  ok("R-G: a stage count is backed by the actual people (clickable)",
    (mine?.stage_trainers?.certified ?? []).some((t) => t.name === tr.name), JSON.stringify(mine?.stage_trainers?.certified));
}

// a second trainer must not be creatable on the same phone (the model had no unique index at all)
const dup = await req("POST", "/api/trainers", { name: "Dup", phone: tr.phone, skills: ["x"] });
ok("a duplicate trainer phone is refused", dup.status >= 400, `got ${dup.status}`);

// ---- the job role decides the extra paperwork (2026-08-12, Manish) ----
// "industry experience aur teaching experience required hai — mendetary hai TVP mein jaane ke
// lie", and it differs by job role. A role naming extras gates on the union; a plain role
// still passes with the universal five.
{
  const strictProg = (await req("POST", "/api/programs", {
    code: "TESTX" + stamp, name: "Strict Role " + stamp, trainer_skill: "sx" + stamp,
    duration_days: 15, buffer_days: 5, default_batch_size: 30, completion_deadline_days: 90,
    mandatory_trainer_docs: ["Industry Experience", "Teaching Experience"],
  }, 201)).data.item;
  ok("a programme can name extra mandatory documents",
    (strictProg.mandatory_trainer_docs ?? []).length === 2, JSON.stringify(strictProg.mandatory_trainer_docs));

  const tx = (await req("POST", "/api/trainers", {
    name: "Strict Docs " + stamp, phone: "6" + Date.now().toString().slice(-9), skills: ["sx" + stamp],
    nominated_for_location: loc._id, nominated_for_program: strictProg._id,
  }, 201)).data.item;
  const TX = `/api/trainers/${tx._id}/transition`;
  await req("POST", TX, { target: "Shortlisted" }, 200); // docs are collected while Shortlisted
  for (const d of ["Aadhaar", "PAN", "Photo", "CV", "Educational Qualification"]) {
    await req("POST", `/api/trainers/${tx._id}/documents`, { doc_type: d, file_url: `/uploads/x-${d}.pdf`, original_name: `${d}.pdf` }, 201);
  }
  const refused = await req("POST", TX, { target: "Documents Completed" });
  ok("the five alone do not clear a role that demands experience certificates",
    refused.status === 409 && /Industry Experience/.test(refused.data?.error ?? ""), `got ${refused.status} ${refused.data?.error ?? ""}`);
  for (const d of ["Industry Experience", "Teaching Experience"]) {
    await req("POST", `/api/trainers/${tx._id}/documents`, { doc_type: d, file_url: `/uploads/x-${d}.pdf`, original_name: `${d}.pdf` }, 201);
  }
  await req("POST", TX, { target: "Documents Completed" }, 200);
  const sum = await req("GET", `/api/trainers/${tx._id}/documents`, undefined, 200);
  ok("the documents summary names the role's full required set (7)",
    (sum.data.summary?.required ?? []).length === 7, JSON.stringify(sum.data.summary?.required));
}

// ---- -128 (QA-266 / QA-272): the nomination gate, and the words it uses ----
// Divya's recording: Move -> Documents Completed -> "Saving..." -> reverts, nothing saved, no message.
// The server was answering 409 the whole time; the page rendered the refusal in a banner its own
// drawer scrim covers. This suite never caught it because EVERY fixture above is created WITH a
// nomination, so Rule T3 has not once fired in the wall. A trainer with no nomination is the real
// shape - it is the state a trainer is in for their whole Shortlisted life.
{
  const nn = (await req("POST", "/api/trainers", {
    name: "No Nomination " + stamp, phone: "8" + Date.now().toString().slice(-9), skills: ["nn" + stamp],
  }, 201)).data.item;
  const NT = `/api/trainers/${nn._id}/transition`;
  await req("POST", NT, { target: "Shortlisted" }, 200);
  for (const d of ["Aadhaar", "PAN", "Photo", "CV", "Educational Qualification"]) {
    await req("POST", `/api/trainers/${nn._id}/documents`, { doc_type: d, file_url: `/uploads/nn-${d}.pdf`, original_name: `${d}.pdf` }, 201);
  }
  const t3 = await req("POST", NT, { target: "Documents Completed" });
  ok("-128 (QA-266): every document in, but no nomination - the move is REFUSED, not silently dropped",
    t3.status === 409, `got ${t3.status}`);
  ok("-128 (QA-266): ...and the refusal says which two things are missing, in words a centre can act on",
    /centre/i.test(t3.data?.error ?? "") && /job role/i.test(t3.data?.error ?? ""), String(t3.data?.error ?? ""));
  // -128 (QA-272): -111 built plain() so a user never reads "Rule 45". The trainer pipeline numbers
  // its rules T2..T8, and \d+ never matched a letter-then-digit, so this exact message reached the
  // screen with "Rule T3:" on the front. Divya photographed it.
  ok("-128 (QA-272): ...and it carries NO internal rule code - the T-codes leak past plain() no more",
    !/\b(?:Rules?|DEC|QA)[-\s]?T?\d+\b/.test(t3.data?.error ?? ""), String(t3.data?.error ?? ""));

  // Setting the nomination is the whole fix, and it must actually clear the gate.
  await req("PATCH", `/api/trainers/${nn._id}`, { nominated_for_location: loc._id, nominated_for_program: prog._id }, 200);
  await req("POST", NT, { target: "Documents Completed" }, 200);
  ok("-128 (QA-266): setting the nomination is what unblocks it - the drawer now says so before the click", true);

  // -128 (QA-272): the same leak on the other refusals this suite already provokes.
  const noReason = await req("POST", NT, { target: "Dropped" });
  ok("-128 (QA-272): a refusal for a missing reason carries no rule code either",
    noReason.status >= 400 && !/\b(?:Rules?|DEC|QA)[-\s]?T?\d+\b/.test(noReason.data?.error ?? ""), String(noReason.data?.error ?? ""));
}

// ---- terminal state needs a reason ----
const t2 = (await req("POST", "/api/trainers", { name: "Drop Me " + stamp, phone: "8" + Date.now().toString().slice(-9), skills: ["x" + stamp] }, 201)).data.item;
await req("POST", `/api/trainers/${t2._id}/transition`, { target: "Dropped" }, 400);
const droppedRes = await req("POST", `/api/trainers/${t2._id}/transition`, { target: "Dropped", reason: "Took another offer" }, 200);
// CEO 13/08: "har stage pe Accepted/Rejected dikhe" — the profile records WHERE it died.
ok("dropping records the stage the journey ended at", droppedRes.data.item.dropped_from_stage === "Fresh Lead", droppedRes.data.item.dropped_from_stage);
const reopened = await req("POST", `/api/trainers/${t2._id}/transition`, { target: "Fresh Lead" }, 200);
ok("a dropped trainer can be re-opened if they come back", reopened.data.item.pipeline_status === "Fresh Lead" && reopened.data.item.active === true);

// ---- the targets endpoint must derive its own trainer counts (B5) ----
// The two client sheets disagree (nominated 23 vs 20, certified 18 vs 16). Ours is computed from
// Trainer rows; theirs is reported alongside. A regression that drops either half puts the ERP
// back to trusting a spreadsheet it cannot verify.
{
  const t = (await req("GET", `/api/locations/${loc._id}/targets`, undefined, 200)).data.items
    .find((x) => String(x.program?._id ?? x.program) === String(prog._id));
  ok("targets derive the certified trainer count from Trainer rows", t?.trainers?.certified === 1, JSON.stringify(t?.trainers));
  ok("…and carry the sheet's requirement beside it", t?.trainers?.required === 2, JSON.stringify(t?.trainers));
  ok("…and report the shortfall rather than making the reader subtract", t?.trainers?.shortfall === 1, JSON.stringify(t?.trainers));

  // The sheet's own enrolled figure is kept, never merged into ours, and the variance is stated.
  await req("PUT", `/api/locations/${loc._id}/targets`, { program: prog._id, enrolled_reported: 7 }, 200);
  const t2r = (await req("GET", `/api/locations/${loc._id}/targets`, undefined, 200)).data.items
    .find((x) => String(x.program?._id ?? x.program) === String(prog._id));
  ok("the sheet's reported enrolment is kept separate from ours", t2r?.reported?.enrolled === 7, JSON.stringify(t2r?.reported));
  ok("…and the variance against our own count is stated",
    t2r?.reported?.enrolled_variance === (t2r.achieved.enrolled - 7), JSON.stringify(t2r?.reported));
}

// ---- the portal identifiers must be writable (C) ----
// Both fields sat on the Batch schema but were missing from the PATCH whitelist, so they could
// never be written or read. A schema field the API refuses to accept does not exist.
{
  const b = (await req("POST", "/api/batches", {
    location: loc._id, program: prog._id, planned_start: new Date(Date.now() + 30 * 864e5 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10),
  }, 201)).data.item;
  const saved = await req("PATCH", `/api/batches/${b._id}`, {
    govt_batch_id: `SIDH-${stamp}`, drive_folder_url: "https://drive.google.com/drive/folders/abc",
  }, 200);
  ok("the SIDH batch id can be recorded", saved.data.item.govt_batch_id === `SIDH-${stamp}`, JSON.stringify(saved.data.item.govt_batch_id));
  ok("…and the Drive evidence folder alongside it",
    saved.data.item.drive_folder_url === "https://drive.google.com/drive/folders/abc", JSON.stringify(saved.data.item.drive_folder_url));
}

// ---- 15/08 (Umesh): pipeline BYPASS — a grantable right to set any status directly ----
// Use-case: a trainer who already works with us goes straight to Certified; TR ID follows later.
// The gates (docs, NSDC round-trip, TR ID) deliberately do NOT run — that is the point, and why
// the right is Admin-held and the UI double-confirms.
{
  const bt = (await req("POST", "/api/trainers", {
    name: "Bypass Trainer " + stamp, phone: "8" + Date.now().toString().slice(-9),
    skills: ["DST" + stamp], nominated_for_location: loc._id, nominated_for_program: prog._id,
  }, 201)).data.item;
  const BT = `/api/trainers/${bt._id}/transition`;
  // The normal machine refuses the jump; bypass takes it — no docs, no NSDC, no TR ID.
  await req("POST", BT, { target: "Certified" }, 409);
  const jump = await req("POST", BT, { target: "Certified", bypass: true }, 200);
  ok("bypass jumps Fresh Lead → Certified with no gates", jump.data.item?.pipeline_status === "Certified", JSON.stringify(jump.data.item?.pipeline_status));
  ok("bypass leaves a signed note on the profile", /BYPASS by /.test(jump.data.item?.pipeline_note ?? ""), JSON.stringify(jump.data.item?.pipeline_note));
  // Garbage target still refused, bypass or not.
  await req("POST", BT, { target: "Wizard", bypass: true }, 400);
  // Dropped still demands its reason even under bypass (T6 survives).
  await req("POST", BT, { target: "Dropped", bypass: true }, 400);
  const drop = await req("POST", BT, { target: "Dropped", bypass: true, reason: "left the org" }, 200);
  ok("bypass-drop records the reason and deactivates", drop.data.item?.dropped_reason === "left the org" && drop.data.item?.active === false, JSON.stringify({ r: drop.data.item?.dropped_reason, a: drop.data.item?.active }));
  // Ops HAS trainers.manage but NOT pipeline.bypass — the 403 below is the bypass check
  // itself firing, not a generic write denial.
  const vCsrfRes = await fetch(BASE + "/api/auth/csrf");
  const { csrfToken: vTok } = await vCsrfRes.json();
  const vCsrf = vCsrfRes.headers.get("set-cookie").split(";")[0];
  const vLogin = await fetch(BASE + "/api/auth/callback/credentials", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: vCsrf },
    body: new URLSearchParams({ csrfToken: vTok, email: "ops@vidysea.com", password: "CiOnly@123" }), redirect: "manual",
  });
  const vSession = (vLogin.headers.getSetCookie?.() ?? [vLogin.headers.get("set-cookie")]).flat().filter(Boolean).map((c) => c.split(";")[0]).find((c) => c.includes("session-token"));
  const vCookie = [vCsrf, vSession].join("; ");
  const deniedRes = await fetch(BASE + BT, { method: "POST", headers: { "Content-Type": "application/json", cookie: vCookie }, body: JSON.stringify({ target: "Certified", bypass: true }) });
  ok("bypass without the right → 403", deniedRes.status === 403, `got ${deniedRes.status}`);
}

// ---- -129 (QA-268): the document type is CITS, and CIPSA is gone from the door ----
// The label IS the stored value here - there is no display layer for TRAINER_DOC_TYPE - so the
// rename has to hold at the API or the old string lives on in the database and in every export.
{
  const dt = (await req("POST", "/api/trainers", {
    name: "Doc Type " + stamp, phone: "5" + Date.now().toString().slice(-9), skills: ["dt" + stamp],
  }, 201)).data.item;
  const DD = `/api/trainers/${dt._id}/documents`;
  const good = await req("POST", DD, { doc_type: "CITS Certificate", file_url: "/uploads/cits.pdf", original_name: "CITS Certificate.pdf" }, 201);
  ok("-129 (QA-268): 'CITS Certificate' is an accepted document type", good.status === 201, JSON.stringify(good.data).slice(0, 120));
  const bad = await req("POST", DD, { doc_type: "CIPSA Certificate", file_url: "/uploads/x.pdf" });
  ok("-129 (QA-268): the old 'CIPSA Certificate' is REFUSED at the door - the rename is real, not cosmetic",
    bad.status === 400, `got ${bad.status}`);
  ok("-129 (QA-268): ...and the refusal lists the types that ARE allowed, with CITS among them",
    /CITS Certificate/.test(bad.data?.error ?? "") && !/CIPSA/.test(bad.data?.error ?? ""), String(bad.data?.error ?? "").slice(0, 140));

  // ---- -129 (QA-270): home location is a TOWN, and typing one must not be lost ----
  // Divya: the field offered CENTRES, so it could not hold what its name promises. -125 fixed only
  // the list column. The store-and-read-back is the -116 lesson: a field the route does not accept
  // looks saved and is gone on the next read.
  await req("PATCH", `/api/trainers/${dt._id}`, { home_location_other: "Sant Ravidas Nagar" }, 200);
  const back = (await req("GET", `/api/trainers/${dt._id}`, undefined, 200)).data.item;
  ok("-129 (QA-270): a home TOWN stores and reads back, with no centre invented for it",
    back.home_location_other === "Sant Ravidas Nagar" && !back.home_location,
    JSON.stringify({ town: back.home_location_other, centre: back.home_location }));
}

// ---- -202 (Umesh 22/08): correcting what the pipeline already stamped ----
// "ek baar values kuch bhi fill ho jaati hai toh edit nahi kar pa raha hai... agar koi wrong value
// set ho gayi toh baad me edit nahi kar pa raha hai. Edit ka button bhi de bhai."
// He was looking at a trainer bypassed straight to Certified: TOT completed and TR ID filled, the
// five NSDC/payment/schedule dates permanently blank, and nothing in the product able to write them.
// These pins are behaviour, not source text — each one creates the state and reads it back. On the
// pre-fix tree every one of them fails, and the failure IS the defect he reported.
{
  const istDay = (offset) => new Date(Date.now() + 330 * 60_000 + offset * 86_400_000).toISOString().slice(0, 10);
  const TOMORROW = istDay(1), TODAY = istDay(0);

  const ct = (await req("POST", "/api/trainers", {
    name: "Correct Dates " + stamp, phone: "6" + Date.now().toString().slice(-9),
    skills: ["DST" + stamp], nominated_for_location: loc._id, nominated_for_program: prog._id,
  }, 201)).data.item;
  const CT = `/api/trainers/${ct._id}/transition`;

  // Reproduce his exact starting state: bypass to Certified stamps tot_done_on and NOTHING else.
  // "TRC", not "TR" + stamp: the certify block above already claimed that one, and tr_id carries a
  // unique partial index — the first run of this block collided with it and the 409 cascaded into
  // the next assertion. The wall caught it before it shipped, which is what the wall is for.
  await req("POST", CT, { target: "Certified", bypass: true, date: "2026-08-14", payload: { tr_id: "TRC" + stamp } }, 200);
  const stranded = (await req("GET", `/api/trainers/${ct._id}`, undefined, 200)).data.item;
  ok("-202: a bypass to Certified leaves the five NSDC/payment/schedule dates blank - the state Umesh hit",
    !stranded.nomination_sent_on && !stranded.nsdc_submitted_on && !stranded.nsdc_result_on
    && !stranded.paid_on && !stranded.tot_scheduled_on && !!stranded.tot_done_on,
    JSON.stringify({ n: stranded.nomination_sent_on, s: stranded.nsdc_submitted_on, r: stranded.nsdc_result_on, p: stranded.paid_on, ts: stranded.tot_scheduled_on }));

  // THE headline pin: the five blanks can now be filled, and they read back.
  await req("PATCH", CT, {
    nomination_sent_on: "2026-06-01", nsdc_submitted_on: "2026-06-10", nsdc_result_on: "2026-06-20",
    paid_on: "2026-06-25", tot_scheduled_on: "2026-08-01",
  }, 200);
  const readBack = (await req("GET", `/api/trainers/${ct._id}`, undefined, 200)).data.item;
  ok("-202: the five stranded dates are filled and READ BACK - not a 200 that wrote nothing (the QA-523 shape)",
    readBack.nomination_sent_on?.slice(0, 10) === "2026-06-01" && readBack.nsdc_submitted_on?.slice(0, 10) === "2026-06-10"
    && readBack.nsdc_result_on?.slice(0, 10) === "2026-06-20" && readBack.paid_on?.slice(0, 10) === "2026-06-25"
    && readBack.tot_scheduled_on?.slice(0, 10) === "2026-08-01",
    JSON.stringify({ n: readBack.nomination_sent_on, s: readBack.nsdc_submitted_on, r: readBack.nsdc_result_on, p: readBack.paid_on, ts: readBack.tot_scheduled_on }));

  // The plain trainer door must STILL refuse them — that is qa-196's invariant I2, and this fix
  // deliberately did not widen it. A 200 here with the value changed would mean the correction had
  // been bolted onto the allow-list instead of the pipeline door.
  await req("PATCH", `/api/trainers/${ct._id}`, { nsdc_submitted_on: "2020-01-01" }, 200);
  const untouched = (await req("GET", `/api/trainers/${ct._id}`, undefined, 200)).data.item;
  ok("-202: the plain trainer PATCH still cannot write these - the allow-list was not widened",
    untouched.nsdc_submitted_on?.slice(0, 10) === "2026-06-10", JSON.stringify(untouched.nsdc_submitted_on));

  // A wrong value is CHANGEABLE, which is the actual complaint. And clearing works.
  await req("PATCH", CT, { tot_done_on: "2026-01-14" }, 200);
  const moved = (await req("GET", `/api/trainers/${ct._id}`, undefined, 200)).data.item;
  ok("-202: a wrong TOT date can be corrected, not just filled once",
    moved.tot_done_on?.slice(0, 10) === "2026-01-14", JSON.stringify(moved.tot_done_on));
  // Written out rather than folded into the ok() call: the first draft of this line carried
  // `(filled.data.warnings ?? []).length >= 0` as one of its conjuncts, which is true of every
  // array that has ever existed. A clause that cannot be false inside a pin is the same disease
  // this project has now found seven times, just smaller.
  const movedAgain = await req("PATCH", CT, { tot_done_on: "2026-01-15" }, 200);
  ok("-202: correcting the TOT date SAYS that 'Available from' did not move with it",
    /Available from/.test(JSON.stringify(movedAgain.data.warnings ?? [])),
    JSON.stringify(movedAgain.data.warnings ?? []).slice(0, 200));
  // Asserts the value was THERE first. Without that half this pin passes on pre-fix code, where the
  // date was never written at all and "it is now absent" is trivially true - which is a pin that
  // cannot fail wearing a different hat. Caught by running the baseline, not by reading it.
  const beforeClear = (await req("GET", `/api/trainers/${ct._id}`, undefined, 200)).data.item;
  await req("PATCH", CT, { nsdc_result_on: null }, 200);
  const cleared = (await req("GET", `/api/trainers/${ct._id}`, undefined, 200)).data.item;
  ok("-202: a date that WAS set can be CLEARED, so a value typed into the wrong row is recoverable",
    !!beforeClear.nsdc_result_on && !cleared.nsdc_result_on,
    JSON.stringify({ before: beforeClear.nsdc_result_on, after: cleared.nsdc_result_on }));

  // No future dates — the -197 rule, which the trainer doors never got. BOTH doors, because two
  // doors in one file disagreeing about tomorrow is the shape -198 shipped once already.
  await req("PATCH", CT, { tot_scheduled_on: TOMORROW }, 400);
  await req("POST", CT, { target: "TOT Scheduled", bypass: true, date: TOMORROW }, 400);
  ok("-202: today is still accepted - the check is 'future', not 'past only'",
    (await req("PATCH", CT, { tot_scheduled_on: TODAY })).status === 200, "today refused");

  // QA-660's lesson one door over: an ALLOW-list, so 0 cannot walk into new Date(0) = 1 Jan 1970.
  for (const junk of [0, false, true, 123, {}, []]) {
    await req("PATCH", CT, { paid_on: junk }, 400);
  }
  // QA-683 (checker on qa-198, -203): the STRING "0" is the one that walks past a non-empty check -
  // new Date("0") is 1 Jan 2000 and new Date("1") is 2001, both real and both safely in the past, so
  // the future-date guard and everything after it wave them through. Same shape one door over; the
  // fix is to require the shape, and these are the pins for it. "14-08-2026" is here because it is
  // what a person types, and accepting it silently would store 14 Aug 2026 or nothing at all
  // depending on the runtime's mood.
  for (const junkStr of ["0", "1", "2026", "yesterday", "14-08-2026", "2026/08/14"]) {
    await req("PATCH", CT, { paid_on: junkStr }, 400);
  }
  const noY2K = (await req("GET", `/api/trainers/${ct._id}`, undefined, 200)).data.item;
  ok("-202/QA-683: no 2000-01-01 was left behind by the string shapes either",
    !String(noY2K.paid_on ?? "").startsWith("2000") && !String(noY2K.paid_on ?? "").startsWith("2001"),
    JSON.stringify(noY2K.paid_on));
  // ...and the same shape check guards the OTHER door on this file, which takes its date from an
  // admin prompt rather than a date input.
  await req("POST", CT, { target: "TOT Scheduled", bypass: true, date: "0" }, 400);
  const noEpoch = (await req("GET", `/api/trainers/${ct._id}`, undefined, 200)).data.item;
  ok("-202: no 1970 was left behind by any of the refused shapes",
    !String(noEpoch.paid_on ?? "").startsWith("1970"), JSON.stringify(noEpoch.paid_on));

  // The stage the trainer is at NOW must not gate the correction. This is the pin against the
  // rank-based guard I designed and dropped: the NSDC round-trip (Rejected → Shortlisted) and the
  // Dropped → Fresh Lead re-open both leave a trainer standing BEHIND dates that are correctly on
  // their record, and a rank test would have refused to fix exactly those.
  await req("POST", CT, { target: "Dropped", bypass: true, reason: "test reopen" }, 200);
  await req("POST", CT, { target: "Fresh Lead", bypass: true }, 200);
  const reopened = (await req("GET", `/api/trainers/${ct._id}`, undefined, 200)).data.item;
  ok("-202: re-opening a dropped trainer leaves the TOT date on the record",
    !!reopened.tot_done_on && reopened.pipeline_status === "Fresh Lead", JSON.stringify({ d: reopened.tot_done_on, s: reopened.pipeline_status }));
  const clearAtFresh = await req("PATCH", CT, { tot_done_on: null }, 200);
  const afterClear = (await req("GET", `/api/trainers/${ct._id}`, undefined, 200)).data.item;
  ok("-202: that stale TOT date can be cleared at Fresh Lead - the one correction the product most needed",
    !afterClear.tot_done_on, JSON.stringify(afterClear.tot_done_on));
  ok("-202: ...and clearing it SAYS the three TOT steps come back into future plans, instead of doing it silently",
    /TOT steps/.test(JSON.stringify(clearAtFresh.data.warnings ?? [])), JSON.stringify(clearAtFresh.data.warnings ?? []).slice(0, 200));

  // Money: the fee entry is never created by this door, and the mismatch is reported.
  const costsBefore = (await req("GET", "/api/costs?limit=1000", undefined, 200)).data.items?.length ?? 0;
  const paidFix = await req("PATCH", CT, { paid_on: "2026-05-05" }, 200);
  const costsAfter = (await req("GET", "/api/costs?limit=1000", undefined, 200)).data.items?.length ?? 0;
  // Both halves, for the same reason as the clear pin above: on pre-fix code no cost row is minted
  // because NOTHING happens at all, so "the count did not move" alone is not evidence of restraint.
  const paidBack = (await req("GET", `/api/trainers/${ct._id}`, undefined, 200)).data.item;
  ok("-202: the payment date MOVES and no cost row is minted - posting a cost has its own approval gate",
    paidBack.paid_on?.slice(0, 10) === "2026-05-05" && costsAfter === costsBefore,
    JSON.stringify({ paid_on: paidBack.paid_on, costs: `${costsBefore} -> ${costsAfter}` }));
  ok("-202: ...and it says so, rather than leaving the profile and the cost ledger quietly disagreeing",
    /Costs/.test(JSON.stringify(paidFix.data.warnings ?? [])), JSON.stringify(paidFix.data.warnings ?? []).slice(0, 200));

  // Umesh's ruling on who: "Admin, Ops aur centre". Operations does NOT hold pipeline.bypass, so a
  // 200 here proves the correction sits on trainers.manage and was not accidentally fenced behind
  // the bypass right — which is what my first design would have done.
  const oCsrfRes = await fetch(BASE + "/api/auth/csrf");
  const { csrfToken: oTok } = await oCsrfRes.json();
  const oCsrf = oCsrfRes.headers.get("set-cookie").split(";")[0];
  const oLogin = await fetch(BASE + "/api/auth/callback/credentials", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: oCsrf },
    body: new URLSearchParams({ csrfToken: oTok, email: "ops@vidysea.com", password: "CiOnly@123" }), redirect: "manual",
  });
  const oSession = (oLogin.headers.getSetCookie?.() ?? [oLogin.headers.get("set-cookie")]).flat().filter(Boolean).map((c) => c.split(";")[0]).find((c) => c.includes("session-token"));
  const oCookie = [oCsrf, oSession].join("; ");
  const opsFix = await fetch(BASE + CT, { method: "PATCH", headers: { "Content-Type": "application/json", cookie: oCookie }, body: JSON.stringify({ nomination_sent_on: "2026-05-02" }) });
  ok("-202: Operations can correct a date without holding pipeline.bypass (Umesh: 'Admin, Ops aur centre')",
    opsFix.status === 200, `got ${opsFix.status}`);
  const opsBypass = await fetch(BASE + CT, { method: "POST", headers: { "Content-Type": "application/json", cookie: oCookie }, body: JSON.stringify({ target: "Certified", bypass: true }) });
  ok("-202: ...while the bypass right itself is still denied to them - correcting a date is not setting a status",
    opsBypass.status === 403, `got ${opsBypass.status}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
