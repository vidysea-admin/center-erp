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

// ---- QA-105 (15/08): the candidate document store — mirror of the trainer pattern ----
{
  const d1 = await req(admin, "POST", `/api/candidates/${c1._id}/documents`, { doc_type: "Aadhaar", file_url: "/erp/api/files/qa105a.pdf", original_name: "aadhaar.pdf" });
  ok("QA-105: a document attaches", d1.status === 201, `got ${d1.status}`);
  await req(admin, "POST", `/api/candidates/${c1._id}/documents`, { doc_type: "Photo", file_url: "/erp/api/files/qa105b.jpg" }, 201);
  const list1 = (await req(admin, "GET", `/api/candidates/${c1._id}/documents`, undefined, 200)).data.items ?? [];
  ok("QA-105: both documents list", list1.length === 2, `${list1.length}`);
  // Re-uploading a type REPLACES it — the trainer rule, same here.
  await req(admin, "POST", `/api/candidates/${c1._id}/documents`, { doc_type: "Aadhaar", file_url: "/erp/api/files/qa105c.pdf" }, 201);
  const list2 = (await req(admin, "GET", `/api/candidates/${c1._id}/documents`, undefined, 200)).data.items ?? [];
  ok("QA-105: re-upload replaces, never stacks", list2.filter((d) => d.doc_type === "Aadhaar").length === 1, JSON.stringify(list2.map((d) => d.doc_type)));
  ok("QA-105: an unknown doc_type is refused", (await req(admin, "POST", `/api/candidates/${c1._id}/documents`, { doc_type: "Ration Card", file_url: "/erp/api/files/x.pdf" })).status === 400);
  // Delete from day one (QA-112's lesson).
  const aad = list2.find((d) => d.doc_type === "Aadhaar");
  ok("QA-105: delete works", (await req(admin, "DELETE", `/api/candidates/${c1._id}/documents/${aad._id}`)).status === 200);
  ok("QA-105: gone is gone", (await req(admin, "DELETE", `/api/candidates/${c1._id}/documents/${aad._id}`)).status === 404);
}

// ---- scoping on the edit surface ----
// [worst] a scoped user cannot edit another centre's candidate by ID.
const spoc = await login("spoc.jpr03@vidysea.com", "CiOnly@123");
if (spoc) {
  const r = await req(spoc, "PATCH", `/api/candidates/${c1._id}`, { name: "hijacked" });
  ok("[worst] out-of-scope candidate edit → 403", r.status === 403, `got ${r.status}`);
  // QA-105 scope: the document store honours Rule 38 like everything else.
  ok("QA-105: out-of-scope candidate's documents unreadable → 403", (await req(spoc, "GET", `/api/candidates/${c1._id}/documents`)).status === 403);
  ok("QA-105: out-of-scope document attach → 403", (await req(spoc, "POST", `/api/candidates/${c1._id}/documents`, { doc_type: "Photo", file_url: "/erp/api/files/x.jpg" })).status === 403);
}


// ---- 2026-08-13 list-UX cycle: the pill deep-link contracts ----
// [best] ?program=null (the "No programme" pill / KPI deep-link) excludes programme-carrying rows.
const noProg = (await req(admin, "GET", "/api/candidates?program=null&limit=2000", undefined, 200)).data.items ?? [];
ok("[best] ?program=null never returns a programme-carrying candidate", !noProg.some((c) => String(c._id) === String(c1._id)) && noProg.every((c) => c.program == null), `${noProg.length} rows`);
// [avg] "Failed" is a legal lifecycle filter value (renamed from "Not Certified", CEO 14/08).
const notCert = await req(admin, "GET", "/api/candidates?lifecycle_status=Not%20Certified&limit=2000");
ok("[avg] Failed filter is accepted and type-clean", notCert.status === 200 && (notCert.data.items ?? []).every((c) => c.lifecycle_status === "Failed"), `got ${notCert.status}, ${notCert.data.items?.length} rows`);

// ---- -135 (QA-283): the SIDH documents mark, and who is allowed to say who gave it ----
// Umesh, 19/08: "ab document dobara mark nahi kar payenge, SIDH portal pe sab kar liya." For a
// cohort that ran before this ERP existed the paperwork cannot be re-marked here, so the only
// honest route is a person asserting it. The security property is the point of these pins: the
// caller may assert the FACT, never the provenance. A mark whose 'who' the client can write is a
// field, not evidence.
{
  const c = (await req(admin, "POST", "/api/candidates", { name: "EC SIDH " + s, phone: phone("73"), location: loc._id, program: prog._id }, 201)).data.item;
  const fresh = (await req(admin, "GET", `/api/candidates/${c._id}`, undefined, 200)).data.item;
  ok("-135 (QA-283): a candidate starts with no SIDH-documents mark", !fresh.sidh_docs_verified, String(fresh.sidh_docs_verified));

  // the forgery attempt: the client tries to name somebody else as the person who confirmed it
  await req(admin, "PATCH", `/api/candidates/${c._id}`, { sidh_docs_verified: true, sidh_docs_verified_by: "000000000000000000000000", sidh_docs_verified_on: "1999-01-01" }, 200);
  const marked = (await req(admin, "GET", `/api/candidates/${c._id}`, undefined, 200)).data.item;
  ok("-135 (QA-283): the mark is stored", marked.sidh_docs_verified === true, String(marked.sidh_docs_verified));
  ok("-135 (QA-283): ...and the SERVER stamped who confirmed it — the client's own value is ignored",
    !!marked.sidh_docs_verified_by && String(marked.sidh_docs_verified_by?._id ?? marked.sidh_docs_verified_by) !== "000000000000000000000000",
    JSON.stringify(marked.sidh_docs_verified_by));
  ok("-135 (QA-283): ...and stamped WHEN, not the date the client sent",
    !!marked.sidh_docs_verified_on && new Date(marked.sidh_docs_verified_on).getFullYear() > 2020, String(marked.sidh_docs_verified_on));

  // undo must not leave a stale signature behind
  await req(admin, "PATCH", `/api/candidates/${c._id}`, { sidh_docs_verified: false }, 200);
  const cleared = (await req(admin, "GET", `/api/candidates/${c._id}`, undefined, 200)).data.item;
  ok("-135 (QA-283): clearing the mark clears WHO and WHEN too — an un-marked record keeps no signature",
    !cleared.sidh_docs_verified && !cleared.sidh_docs_verified_by && !cleared.sidh_docs_verified_on,
    JSON.stringify({ v: cleared.sidh_docs_verified, by: cleared.sidh_docs_verified_by, on: cleared.sidh_docs_verified_on }));
}

// ---- -222 (Umesh, 2026-08-24): State -> District -> Sub-district, the government's own list ----
// "candidate form - state - selected state dropdown - respective district - respective sub district".
// The three fields existed on all three intake doors as FREE TEXT, so nothing stopped a spelling
// the government portal will not accept. The list is now LGD's own (bundled, export 2026-08-23),
// served by a public endpoint because two of the three doors have no session.
{
  const g = async (qs) => await req("", "GET", `/api/public/geography${qs}`, undefined, 200);

  const states = (await g("")).data;
  ok("-222: the geography endpoint answers unauthenticated with every state and UT",
    states.level === "state" && states.items.length === 36, `level=${states.level} n=${states.items?.length}`);
  ok("-222: ...and it is LGD's list, not a hand-typed one (Uttar Pradesh present, marked a State not a UT)",
    states.items.some((x) => x.name === "Uttar Pradesh" && x.ut === false),
    JSON.stringify(states.items.slice(0, 2)));

  const upD = (await g("?state=Uttar%20Pradesh")).data;
  ok("-222: districts cascade from the chosen state",
    upD.level === "district" && upD.known === true && upD.items.length > 70, `n=${upD.items?.length}`);
  ok("-222: ...and carry the real district names (Jalaun - the one on Umesh's SIDH screenshot)",
    upD.items.some((d) => d.name === "Jalaun"), "Jalaun missing");

  const bhS = (await g("?state=Uttar%20Pradesh&district=Bhadohi")).data;
  ok("-222: sub-districts cascade from the chosen district (Aurai under Bhadohi)",
    bhS.level === "subDistrict" && bhS.known === true && bhS.items.some((x) => x.name === "Aurai"),
    JSON.stringify(bhS.items?.slice(0, 4)));

  // SIDH renders the same names in UPPER CASE (the screenshot says UTTAR PRADESH / JALAUN) and our
  // own live rows carry a third casing. Comparing raw strings would have made every stored value
  // look absent, so the match is case- and spacing-insensitive on BOTH sides. Pinned, because a
  // future "tidy up" of that comparison would silently amber-flag the whole database.
  const shout = (await g("?state=UTTAR%20PRADESH")).data;
  ok("-222: the same state in SIDH's upper case resolves to the same districts",
    shout.known === true && shout.items.length === upD.items.length, `${shout.items?.length} vs ${upD.items?.length}`);
  const spaced = (await g("?state=%20uttar%20%20pradesh%20")).data;
  ok("-222: ...and so does stray whitespace, rather than reading as a different state",
    spaced.known === true && spaced.items.length === upD.items.length, `n=${spaced.items?.length}`);

  // Umesh's second decision, at the API layer: "purana data chhedo mat, sirf batao". A value LGD
  // does not carry is NOT an error - it is a fact about an old row, and the caller is told so.
  // This is not a hypothetical: our own live centre reads "Sant Ravidasnagar", and LGD renamed that
  // district to Bhadohi. If this endpoint 404'd or 500'd on it, opening such a candidate to fix a
  // phone number would have blanked their district.
  const gone = await req("", "GET", "/api/public/geography?state=Uttar%20Pradesh&district=Sant%20Ravidas%20Nagar", undefined, 200);
  ok("-222: a district LGD no longer carries is reported, not refused (Sant Ravidas Nagar -> Bhadohi)",
    gone.data.known === false && Array.isArray(gone.data.items) && gone.data.items.length === 0,
    JSON.stringify(gone.data).slice(0, 120));
  const nonsense = await req("", "GET", "/api/public/geography?state=Nowhereland", undefined, 200);
  ok("-222: ...and an unknown state is the same shape, never a 500",
    nonsense.data.known === false && nonsense.data.items.length === 0, JSON.stringify(nonsense.data).slice(0, 120));
}

finish();
