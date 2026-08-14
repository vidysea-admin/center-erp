// Eval: Candidate registration + the 2026-08-13 edit surface. The candidates screen finally has
// an edit path (sheet-imported rows carry sheet mistakes) — this pins the whole contract:
// create validation, duplicate advisory, SIDH walk, edit round-trip, partial-PATCH semantics.
import { ok, req, adminLogin, login, finish, stamp, phone, today } from "./e2e-lib.mjs";

const admin = await adminLogin();
const s = stamp("EC");

const prog = (await req(admin, "POST", "/api/programs", { code: s, name: "EvalCand Prog " + s, trainer_skill: "ECSkill" + s }, 201)).data.item;
const prog2 = (await req(admin, "POST", "/api/programs", { code: "Q" + s, name: "EvalCand Prog2 " + s, trainer_skill: "ECSkill2" + s }, 201)).data.item;
const loc = (await req(admin, "POST", "/api/locations", { code: "L" + s, name: "TEST-EvalCand Loc " + s, approval_status: "Approved", city: "Mirzapur" }, 201)).data.item;
const loc2 = (await req(admin, "POST", "/api/locations", { code: "M" + s, name: "TEST-EvalCand Loc2 " + s, approval_status: "Approved", city: "Ghazipur" }, 201)).data.item;

// ---- create: validation ----
// [worst] the required quartet is enforced with a 400, never a 500.
await req(admin, "POST", "/api/candidates", { phone: phone("81"), location: loc._id, program: prog._id }, 400); // no name
await req(admin, "POST", "/api/candidates", { name: "TEST-EC NoProg " + s, phone: phone("82"), location: loc._id }, 400); // no program
// [worst] a nonsense enum value names the allowed values instead of a driver stack trace.
const badEnum = await req(admin, "POST", "/api/candidates", { name: "TEST-EC Bad " + s, phone: phone("83"), location: loc._id, program: prog._id, sidh_status: "Done" });
ok("[worst] invalid sidh_status → 400 naming the allowed values", badEnum.status === 400 && /Not Registered|Registered/.test(JSON.stringify(badEnum.data)), JSON.stringify(badEnum.data).slice(0, 120));

// [best] a clean create lands Unassigned with eligibility computed.
const dob21 = new Date(Date.now() - 21 * 365.25 * 24 * 3600 * 1000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const c1 = (await req(admin, "POST", "/api/candidates", { name: "TEST-EC One " + s, phone: phone("84"), location: loc._id, program: prog._id, dob: dob21, education: "12th Pass" }, 201)).data.item;
const c1Read = (await req(admin, "GET", `/api/candidates/${c1._id}`, undefined, 200)).data.item;
ok("[best] fresh candidate is Unassigned", c1Read.lifecycle_status === "Unassigned", c1Read.lifecycle_status);
ok("[best] eligibility is computed on read (21y, 12th Pass → eligible)", c1Read.eligibility?.eligible === true, JSON.stringify(c1Read.eligibility));

// [avg] duplicate advisory: same phone flags, never blocks (one number serves a family).
const dupCheck = (await req(admin, "POST", "/api/candidates/check-duplicate", { name: "Someone Else", phone: c1.phone }, 200)).data;
ok("[avg] duplicate probe flags the same phone", (dupCheck.duplicates ?? []).length > 0, JSON.stringify(dupCheck));
const c2 = await req(admin, "POST", "/api/candidates", { name: "TEST-EC Family " + s, phone: c1.phone, location: loc._id, program: prog._id });
ok("[avg] …but the save itself is advisory, not blocked", c2.status === 201, `got ${c2.status}`);

// ---- the edit surface (2026-08-13) ----
// [best] drawer round-trip: every correctable field the sheet can get wrong.
await req(admin, "PATCH", `/api/candidates/${c1._id}`, { name: "TEST-EC One Corrected " + s, dob: "2003-02-15", education: "Graduate", location: loc2._id, program: prog2._id, source: "mobiliser-Anita" }, 200);
const e1 = (await req(admin, "GET", `/api/candidates/${c1._id}`, undefined, 200)).data.item;
ok("[best] edit round-trip: name/dob/education/source", e1.name.includes("Corrected") && String(e1.dob).slice(0, 10) === "2003-02-15" && e1.education === "Graduate" && e1.source === "mobiliser-Anita", JSON.stringify({ n: e1.name, d: e1.dob, ed: e1.education }));
ok("[best] edit round-trip: location and program (wrong fuzzy match fixable)", String(e1.location?._id) === String(loc2._id) && String(e1.program?._id) === String(prog2._id));

// [avg] partial PATCH: one field travels, nothing else moves.
await req(admin, "PATCH", `/api/candidates/${c1._id}`, { phone: phone("85") }, 200);
const e2 = (await req(admin, "GET", `/api/candidates/${c1._id}`, undefined, 200)).data.item;
ok("[avg] phone-only PATCH leaves every other field alone", e2.education === "Graduate" && String(e2.program?._id) === String(prog2._id), JSON.stringify({ ed: e2.education }));

// [worst] lifecycle_status is system-owned — a plain edit cannot fake an enrollment.
await req(admin, "PATCH", `/api/candidates/${c1._id}`, { lifecycle_status: "Enrolled" }, 200); // silently dropped
const e3 = (await req(admin, "GET", `/api/candidates/${c1._id}`, undefined, 200)).data.item;
ok("[worst] lifecycle_status ignores a plain PATCH", e3.lifecycle_status === "Unassigned", e3.lifecycle_status);

// ---- SIDH walk ----
// [best] Link Sent → Registered, with timestamps.
await req(admin, "PATCH", `/api/candidates/${c1._id}`, { sidh_status: "Link Sent", sidh_link_sent_at: new Date().toISOString() }, 200);
await req(admin, "PATCH", `/api/candidates/${c1._id}`, { sidh_status: "Registered", sidh_registered_on: new Date().toISOString(), sidh_candidate_id: "CAN_" + s }, 200);
const sidh = (await req(admin, "GET", `/api/candidates/${c1._id}`, undefined, 200)).data.item;
ok("[best] SIDH walk lands Registered with the portal id", sidh.sidh_status === "Registered" && sidh.sidh_candidate_id === "CAN_" + s, JSON.stringify({ s: sidh.sidh_status, id: sidh.sidh_candidate_id }));

// [best] the CRM export answers with a spreadsheet, not JSON.
const exp = await fetch((process.env.BASE_URL || "http://localhost:3000/erp") + "/api/candidates/export-sidh?location=" + loc2._id, { headers: { cookie: admin } });
ok("[best] SIDH CRM export downloads (xlsx content type)", exp.status === 200 && /sheet|excel|octet/.test(exp.headers.get("content-type") ?? ""), `${exp.status} ${exp.headers.get("content-type")}`);

// ---- eligibility boundaries (defaults: min_age/max_age/cooldown) ----
const d = (await req(admin, "GET", "/api/defaults", undefined, 200)).data.item;
// [worst] a candidate below min_age is named ineligible with the reason.
const under = new Date(); under.setFullYear(under.getFullYear() - (d.min_age - 1));
const cU = (await req(admin, "POST", "/api/candidates", { name: "TEST-EC Under " + s, phone: phone("86"), location: loc._id, program: prog._id, dob: under.toISOString().slice(0, 10), education: "10th Pass" }, 201)).data.item;
const cURead = (await req(admin, "GET", `/api/candidates/${cU._id}`, undefined, 200)).data.item;
ok("[worst] under-age candidate is flagged ineligible with a reason", cURead.eligibility?.eligible === false && (cURead.eligibility?.reasons ?? []).length > 0, JSON.stringify(cURead.eligibility));
// [avg] a candidate with no DOB is "unverified", not silently eligible or blocked.
const cN = (await req(admin, "POST", "/api/candidates", { name: "TEST-EC NoDob " + s, phone: phone("87"), location: loc._id, program: prog._id }, 201)).data.item;
const cNRead = (await req(admin, "GET", `/api/candidates/${cN._id}`, undefined, 200)).data.item;
ok("[avg] missing DOB → eligibility unknown list names it", (cNRead.eligibility?.unknown ?? []).length > 0, JSON.stringify(cNRead.eligibility));

// [avg] recent govt training trips the cooldown.
const cT = (await req(admin, "POST", "/api/candidates", { name: "TEST-EC Cooldown " + s, phone: phone("88"), location: loc._id, program: prog._id, dob: dob21, education: "10th Pass", last_training_date: today() }, 201)).data.item;
const cTRead = (await req(admin, "GET", `/api/candidates/${cT._id}`, undefined, 200)).data.item;
ok("[avg] training today → cooldown makes them ineligible", cTRead.eligibility?.eligible === false, JSON.stringify(cTRead.eligibility));

// ---- scoping on the edit surface ----
// [worst] a scoped user cannot edit another centre's candidate by ID.
const spoc = await login("spoc.jpr03@vidysea.com", "Vidysea@123");
if (spoc) {
  const r = await req(spoc, "PATCH", `/api/candidates/${c1._id}`, { name: "hijacked" });
  ok("[worst] out-of-scope candidate edit → 403", r.status === 403, `got ${r.status}`);
}


// ---- 2026-08-13 list-UX cycle: the pill deep-link contracts ----
// [best] ?program=null (the "No programme" pill / KPI deep-link) excludes programme-carrying rows.
const noProg = (await req(admin, "GET", "/api/candidates?program=null&limit=2000", undefined, 200)).data.items ?? [];
ok("[best] ?program=null never returns a programme-carrying candidate", !noProg.some((c) => String(c._id) === String(c1._id)) && noProg.every((c) => c.program == null), `${noProg.length} rows`);
// [avg] "Failed" is a legal lifecycle filter value (renamed from "Not Certified", CEO 14/08).
const notCert = await req(admin, "GET", "/api/candidates?lifecycle_status=Not%20Certified&limit=2000");
ok("[avg] Failed filter is accepted and type-clean", notCert.status === 200 && (notCert.data.items ?? []).every((c) => c.lifecycle_status === "Failed"), `got ${notCert.status}, ${notCert.data.items?.length} rows`);

finish();
