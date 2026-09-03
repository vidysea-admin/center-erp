// QA-1287 + QA-1289 — the SIDH batch id at the CREATE door, and the duplicate warning.
//
// Client, 2026-08-25: "aap batch create karte waqt ek batch ID daalne ka option daal dijiye."
// The field was on the schema and in the PATCH allow-list all along; only POST never took it —
// ARCHITECTURE section 3.9's "divergent by omission" entry. Umesh's decision on validation, asked
// directly with three options on the table: FREE TEXT plus a duplicate WARNING, never a refusal.
//
// Each assertion below is written so it goes RED without the fix, not merely green with it — the
// pre-fix output is pinned in the manifest.
import { adminLogin, login, req, ok, finish, stamp, today } from "./e2e-lib.mjs";

const admin = await adminLogin();
const s = stamp("GBI");

const prog = (await req(admin, "POST", "/api/programs", { code: s, name: "GovtBatchId Prog " + s, trainer_skill: "GBISkill" + s }, 201)).data.item;
const loc = (await req(admin, "POST", "/api/locations", { code: "L" + s, name: "TEST-GovtBatchId " + s, approval_status: "Approved", city: "Meerut" }, 201)).data.item;

const mk = (extra) => ({ location: loc._id, program: prog._id, planned_start: today(), ...extra });
const PORTAL_ID = "PRJ/" + s + "/2026";

// ---------------------------------------------------------------- 1. it arrives through CREATE
// THE defect. Before the fix POST ignored the key entirely and this read back undefined.
const c1 = await req(admin, "POST", "/api/batches", mk({ govt_batch_id: PORTAL_ID }), 201);
ok("QA-1287: a SIDH batch ID typed on the CREATE door is stored",
  c1.data.item?.govt_batch_id === PORTAL_ID, `(got ${JSON.stringify(c1.data.item?.govt_batch_id)})`);

// ...and survives a re-read, not just the create response.
const back = await req(admin, "GET", `/api/batches/${c1.data.item._id}`, undefined, 200);
ok("QA-1287: it is still there on a fresh read of the batch",
  back.data.item?.govt_batch_id === PORTAL_ID, `(got ${JSON.stringify(back.data.item?.govt_batch_id)})`);

// no duplicate exists yet, so nothing should be warned about
ok("QA-1289: the FIRST batch to carry an ID is not warned about",
  !/already recorded/.test(c1.data.warning ?? ""), `(warning: ${c1.data.warning})`);

// ---------------------------------------------------------------- 2. blank stores NULL, not ""
// The trap both candidate ids already handle at their own doors: "" is a value — it reads back as
// "there is an id here", and it would make every blank batch a duplicate of every other blank one.
const c2 = await req(admin, "POST", "/api/batches", mk({ govt_batch_id: "   " }), 201);
ok("QA-1287: a blank ID is stored as absent, never as an empty string",
  c2.data.item?.govt_batch_id == null, `(got ${JSON.stringify(c2.data.item?.govt_batch_id)})`);

const c3 = await req(admin, "POST", "/api/batches", mk({ govt_batch_id: "  " + PORTAL_ID + "  " }), 201);
ok("QA-1287: surrounding whitespace is trimmed before storing",
  c3.data.item?.govt_batch_id === PORTAL_ID, `(got ${JSON.stringify(c3.data.item?.govt_batch_id)})`);

// ---------------------------------------------------------------- 3. duplicate WARNS, never refuses
ok("QA-1289: a duplicate ID is CREATED, not refused (Umesh: warn, never block)",
  c3.status === 201, `(status ${c3.status})`);
ok("QA-1289: ...and the warning NAMES the batch already carrying it",
  (c3.data.warning ?? "").includes(c1.data.item.code),
  `(warning: ${JSON.stringify(c3.data.warning)} — expected it to name ${c1.data.item.code})`);

// The name is the whole point: govt_batch_id is on no list screen, so "duplicate" without a code
// sends the operator to search for something they cannot search for.
ok("QA-1289: the warning does not fob the reader off with an ObjectId",
  !/[0-9a-f]{24}/.test(c3.data.warning ?? ""), `(warning: ${c3.data.warning})`);

// ---------------------------------------------------------------- 4. the EDIT door agrees
const c4 = await req(admin, "POST", "/api/batches", mk({}), 201);
const p1 = await req(admin, "PATCH", `/api/batches/${c4.data.item._id}`, { govt_batch_id: PORTAL_ID }, 200);
ok("QA-1289: PATCH warns on a duplicate too, and names the same batch",
  (p1.data.warning ?? "").includes(c1.data.item.code), `(warning: ${JSON.stringify(p1.data.warning)})`);
ok("QA-1289: PATCH still SAVES the duplicate",
  p1.data.item?.govt_batch_id === PORTAL_ID, `(got ${JSON.stringify(p1.data.item?.govt_batch_id)})`);

// ---------------------------------------------------------------- 5. self-exclusion
// Without `selfId` every re-save of an unchanged field warns about itself, and a warning that
// fires on a no-op is a warning people learn to click past.
const p2 = await req(admin, "PATCH", `/api/batches/${c1.data.item._id}`, { govt_batch_id: PORTAL_ID }, 200);
ok("QA-1289: re-saving its OWN unchanged ID does not warn the batch about itself",
  !(p2.data.warning ?? "").includes(c1.data.item.code), `(warning: ${JSON.stringify(p2.data.warning)})`);

// clearing it through the edit door lands as null, same helper as create
const p3 = await req(admin, "PATCH", `/api/batches/${c4.data.item._id}`, { govt_batch_id: "" }, 200);
ok("QA-1287: clearing the ID on the EDIT door stores absent, not an empty string",
  p3.data.item?.govt_batch_id == null, `(got ${JSON.stringify(p3.data.item?.govt_batch_id)})`);

// ================================================================ 6. -256: a CLOSED batch and the id
// Umesh, 2026-08-26, with a screenshot of the "Passed" drill on /reports: "top ke 2 mei toh main
// input nii kar pa raha hon, niche ke jaha par id karke aarek type id, waha par type ho pa raha
// hai, toh ye kya mili bhagat hai".
//
// Those two rows were COMPLETED batches. `PATCH /api/batches/[id]` refused every field on a
// Completed/Cancelled batch, so the screen greyed the box out - and SIDH issues the batch ID at or
// AFTER completion, which makes the one status where the id actually arrives the one status that
// would not take it. The batch page had been nagging for it on Completed batches the whole time
// ("Still missing on this finished batch: the SIDH batch ID - fill them below") over a form whose
// Save the API then refused.
//
// Umesh's decision, asked directly with both options on the table: ADMIN ONLY, and the id ALONE.
// Every assertion below reads 409 before the fix, or measures a refusal that must SURVIVE it.
const CLOSED_ID = "PRJ/" + s + "/CLOSED";

// ---------------------------------------------------------------- 6a. Cancelled: the door opens
const cx = (await req(admin, "POST", "/api/batches", mk({}), 201)).data.item;
await req(admin, "POST", `/api/batches/${cx._id}/transition`, { target: "Cancelled", reason: "-256 fixture" }, 200);
const cxIs = await req(admin, "GET", `/api/batches/${cx._id}`, undefined, 200);
ok("-256 fixture: the batch really is closed before anything is asked of it",
  cxIs.data.item?.status === "Cancelled", `(status ${cxIs.data.item?.status})`);

const cxp = await req(admin, "PATCH", `/api/batches/${cx._id}`, { govt_batch_id: CLOSED_ID }, 200);
ok("-256: an Admin can record the SIDH batch ID on a CLOSED batch - pre-fix this door answered 409",
  cxp.status === 200 && cxp.data.item?.govt_batch_id === CLOSED_ID,
  `(status ${cxp.status}, got ${JSON.stringify(cxp.data.item?.govt_batch_id)})`);

// Echoed is not stored. The whole complaint was about a value that would not land.
const cxBack = await req(admin, "GET", `/api/batches/${cx._id}`, undefined, 200);
ok("-256: ...and it is STORED, not just echoed back by the write",
  cxBack.data.item?.govt_batch_id === CLOSED_ID, `(got ${JSON.stringify(cxBack.data.item?.govt_batch_id)})`);

// ---------------------------------------------------------------- 6b. and closes again behind it
// The exception is the id ALONE. A body carrying a second field is a plan edit wearing an id.
const sizeBefore = cxBack.data.item?.target_size;
const cxMix = await req(admin, "PATCH", `/api/batches/${cx._id}`, { govt_batch_id: CLOSED_ID + "-X", target_size: 99 }, 409);
ok("-256: a second field riding along with the id is still refused on a closed batch",
  cxMix.status === 409, `(status ${cxMix.status})`);
const cxAfterMix = await req(admin, "GET", `/api/batches/${cx._id}`, undefined, 200);
ok("-256: ...and the refusal wrote NOTHING - not the id it carried, not the field it smuggled",
  cxAfterMix.data.item?.govt_batch_id === CLOSED_ID && cxAfterMix.data.item?.target_size === sizeBefore,
  JSON.stringify({ id: cxAfterMix.data.item?.govt_batch_id, size: cxAfterMix.data.item?.target_size, was: sizeBefore }));

// `location` and `program` are handled in their own block further down the door, so a test written
// only against the assignment list would have let this pair through the freeze.
const loc2 = (await req(admin, "POST", "/api/locations", { code: "M" + s, name: "TEST-GovtBatchId2 " + s, approval_status: "Approved", city: "Meerut" }, 201)).data.item;
const cxLoc = await req(admin, "PATCH", `/api/batches/${cx._id}`, { govt_batch_id: CLOSED_ID, location: loc2._id }, 409);
ok("-256: the separately-handled fields (location/program) cannot ride the id through the freeze either",
  cxLoc.status === 409, `(status ${cxLoc.status})`);

// An empty body must not answer 200 having done nothing on a frozen batch.
const cxNone = await req(admin, "PATCH", `/api/batches/${cx._id}`, {}, 409);
ok("-256: a body that asks for nothing is still refused on a closed batch, never a silent 200",
  cxNone.status === 409, `(status ${cxNone.status})`);

// ---------------------------------------------------------------- 6c. ADMIN ONLY - Umesh's call
// Operations carries batches.manage by default, so it REACHES this door and is turned away here, on
// the status rather than at the permission. A 403 would mean the fixture lost the right, not that
// the rule held - so the assertion says that out loud instead of passing quietly.
const ops = await login("ops@vidysea.com", "CiOnly@123");
const opsClosed = await req(ops, "PATCH", `/api/batches/${cx._id}`, { govt_batch_id: CLOSED_ID + "-OPS" }, 409);
ok("-256: Operations is refused the id on a CLOSED batch - Umesh chose Admin-only for this exception",
  opsClosed.status === 409, `(status ${opsClosed.status} - 403 would mean the fixture lost batches.manage, not that the rule held)`);
ok("-256: ...and the refusal SAYS an Admin can, instead of a bare 'Batch is closed.'",
  /Admin/i.test(String(opsClosed.data?.error ?? opsClosed.data?.message ?? "")),
  `(message ${JSON.stringify(opsClosed.data?.error ?? opsClosed.data?.message)})`);

// The carve-out took nothing from anybody: Operations edits an OPEN batch exactly as before.
const openForOps = (await req(admin, "POST", "/api/batches", mk({}), 201)).data.item;
const OPEN_ID = "PRJ/" + s + "/OPEN";
const opsOpen = await req(ops, "PATCH", `/api/batches/${openForOps._id}`, { govt_batch_id: OPEN_ID }, 200);
ok("-256: Operations still edits an OPEN batch's id - the exception narrowed nothing that worked before",
  opsOpen.status === 200 && opsOpen.data.item?.govt_batch_id === OPEN_ID,
  `(status ${opsOpen.status}, got ${JSON.stringify(opsOpen.data.item?.govt_batch_id)})`);

// ---------------------------------------------------------------- 6d. the id keeps its own rules
// A blank on the closed path lands as absent, same helper as everywhere else - or a cleared id reads
// back as "there is an id here" and every blank batch matches every other on the duplicate check.
const cxBlank = await req(admin, "PATCH", `/api/batches/${cx._id}`, { govt_batch_id: "   " }, 200);
// `status === 200` is load-bearing, not decoration. Measured on the pre-fix build: without it the
// PATCH answered 409, `data.item` was undefined, `undefined == null` was true, and this assertion
// read GREEN on the exact behaviour it exists to catch. It was the only one of the fourteen here
// that did - found by running the reverted build rather than by reading the line.
ok("-256 + QA-1287: clearing the id on a CLOSED batch stores absent, not an empty string",
  cxBlank.status === 200 && "item" in (cxBlank.data ?? {}) && cxBlank.data.item?.govt_batch_id == null,
  `(status ${cxBlank.status}, got ${JSON.stringify(cxBlank.data.item?.govt_batch_id)})`);
const cxDup = await req(admin, "PATCH", `/api/batches/${cx._id}`, { govt_batch_id: PORTAL_ID }, 200);
ok("-256 + QA-1289: a duplicate on a closed batch still WARNS and still SAVES, never blocks",
  cxDup.status === 200 && cxDup.data.item?.govt_batch_id === PORTAL_ID && (cxDup.data.warning ?? "").includes(c1.data.item.code),
  JSON.stringify({ id: cxDup.data.item?.govt_batch_id, warning: cxDup.data.warning }));

// ---------------------------------------------------------------- 6e. the SCHEDULING checks
// The door asserts slot guidelines, trainer availability and room availability on every PATCH. Those
// are refusals about a request that MOVES the schedule, and on the id-only path nothing moves - so
// running them would fail this edit for a reason it has nothing to do with. Built as the real case:
// a trainer who has SINCE been given a live batch at the same hour.
const tr = (await req(admin, "POST", "/api/trainers", { name: "GBI Trainer " + s, phone: "8" + s.slice(3) + "02", skills: ["GBISkill" + s] }, 201)).data.item;
const rm1 = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "GBI Room A " + s, type: "Classroom", capacity: 20 }, 201)).data.item;
const rm2 = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "GBI Room B " + s, type: "Classroom", capacity: 20 }, 201)).data.item;
const clashA = (await req(admin, "POST", "/api/batches", mk({ trainer: tr._id, room: rm1._id, slot_start: "09:00", slot_end: "13:00" }), 201)).data.item;
await req(admin, "POST", `/api/batches/${clashA._id}/transition`, { target: "Cancelled", reason: "-256 clash fixture" }, 200);
// Only creatable because a closed batch is not an ACTIVE_BATCH_STATUS - which is the point: the
// clash exists from clashA's side, and from clashA's side only.
const clashB = await req(admin, "POST", "/api/batches", mk({ trainer: tr._id, room: rm2._id, slot_start: "09:00", slot_end: "13:00" }), 201);
ok("-256 fixture: the trainer now teaches a LIVE batch in the same hour as the closed one",
  clashB.status === 201, `(status ${clashB.status})`);
const CLASH_ID = "PRJ/" + s + "/CLASH";
const clashPatch = await req(admin, "PATCH", `/api/batches/${clashA._id}`, { govt_batch_id: CLASH_ID }, 200);
ok("-256: recording the id on a closed batch is not blocked by a clash it is not creating",
  clashPatch.status === 200 && clashPatch.data.item?.govt_batch_id === CLASH_ID,
  `(status ${clashPatch.status}, ${JSON.stringify(clashPatch.data?.error ?? clashPatch.data.item?.govt_batch_id)})`);

// ---------------------------------------------------------------- 6f. COMPLETED, the real case
// Cancelled is the cheap fixture; COMPLETED is the status Umesh was actually looking at, and the one
// the portal's timing is about. Walked the long way on purpose - assessment, certificate, closure
// derivation - so this is the real end state and not a shortcut into it.
const cmTr = (await req(admin, "POST", "/api/trainers", { name: "GBI CmpTrainer " + s, phone: "7" + s.slice(3) + "03", skills: ["GBISkill" + s] }, 201)).data.item;
const cmRoom = (await req(admin, "POST", `/api/locations/${loc._id}/rooms`, { name: "GBI Room C " + s, type: "Classroom", capacity: 20 }, 201)).data.item;
const cmB = (await req(admin, "POST", "/api/batches", { location: loc._id, program: prog._id, trainer: cmTr._id, room: cmRoom._id, planned_start: today(), target_size: 1 }, 201)).data.item;
const cmCand = (await req(admin, "POST", "/api/candidates", { name: "GBI Cmp Cand " + s, phone: "9" + s.slice(3) + "04", location: loc._id, program: prog._id, sidh_candidate_id: "CAN_" + s.slice(3) + "9" }, 201)).data.item;
const cmMem = (await req(admin, "POST", `/api/batches/${cmB._id}/members`, { candidate: cmCand._id }, 201)).data.item;
// Being ON the roster is not being enrolled - Rule 17's threshold counts finished enrolments, and
// without this the walk stops at Ready. Found by this suite's own fixture assertion below, which is
// the only reason the id pin under it is not still reading green on a batch that never closed.
await req(admin, "PATCH", `/api/members/${cmMem._id}`, { reg_done: true, kyc_done: true, enroll_done: true, accept_done: true }, 200);
await req(admin, "POST", `/api/batches/${cmB._id}/transition`, { target: "Ready" }, 200);
await req(admin, "POST", `/api/batches/${cmB._id}/transition`, { target: "Active" }, 200);
await req(admin, "PUT", `/api/batches/${cmB._id}/results`, { rows: [{ member: String(cmMem._id), result: "Pass", score: 70, max_score: 100, assessed_on: today() }] }, 200);
// Certification is the last gate before Completed, and it will not derive until every Pass row's
// certificate is Issued. The other way in is a certificate FILE, and /api/upload writes to GCS on
// this build - storage with nothing to do with what this unit is about, and everything to do with
// whether the fixture can be built offline. So the Rule 46 ladder is walked by hand instead:
// Pending -> Processing -> Generated (number + date) -> Issued.
const cmRows = (await req(admin, "GET", `/api/batches/${cmB._id}/results`, undefined, 200)).data.items ?? [];
const cmRes = cmRows[0]?.result?._id;
ok("-256 fixture: the Pass row exists, so there is a certificate to settle",
  !!cmRes, JSON.stringify(cmRows.map((r) => ({ m: r.member, res: r.result?.result })) ));
await req(admin, "PATCH", `/api/results/${cmRes}`, { certificate_status: "Processing" }, 200);
await req(admin, "PATCH", `/api/results/${cmRes}`, { certificate_status: "Generated", certificate_no: "CERT-GBI-" + s, certificate_date: today() }, 200);
await req(admin, "PATCH", `/api/results/${cmRes}`, { certificate_status: "Issued" }, 200);
// Already Completed by derivation is a 200 no-op here, so this states the fact either way.
await req(admin, "PUT", `/api/batches/${cmB._id}/closure`, { certification_status: "Completed" }, 200);
await req(admin, "POST", `/api/batches/${cmB._id}/transition`, { target: "Closing" }, 200);
await req(admin, "POST", `/api/batches/${cmB._id}/transition`, { target: "Completed" }, 200);
const cmIs = await req(admin, "GET", `/api/batches/${cmB._id}`, undefined, 200);
ok("-256 fixture: a genuinely COMPLETED batch, walked the whole ladder",
  cmIs.data.item?.status === "Completed", `(status ${cmIs.data.item?.status})`);
const DONE_ID = "PRJ/" + s + "/DONE";
const cmPatch = await req(admin, "PATCH", `/api/batches/${cmB._id}`, { govt_batch_id: DONE_ID }, 200);
// The status is asserted INSIDE the pin, from the write's own answer. Written that way after this
// assertion read green on a batch still sitting at Ready: the walk above had stopped early, the
// batch was simply OPEN, and "the id saved" was true for the ordinary reason. A pin that does not
// name the condition it is about will pass for the wrong one.
ok("-256: THE REPORTED CASE - the SIDH id lands on a COMPLETED batch, which is when the portal issues it",
  cmPatch.status === 200 && cmPatch.data.item?.govt_batch_id === DONE_ID && cmPatch.data.item?.status === "Completed",
  `(status ${cmPatch.status}, batch ${JSON.stringify(cmPatch.data.item?.status)}, ${JSON.stringify(cmPatch.data?.error ?? cmPatch.data.item?.govt_batch_id)})`);
// DEC-6 is not repealed: the training facts on a Completed batch stay frozen.
const cmFrozen = await req(admin, "PATCH", `/api/batches/${cmB._id}`, { target_size: 42 }, 409);
ok("-256: DEC-6 unbroken - a Completed batch's plan is still frozen against everything else",
  cmFrozen.status === 409, `(status ${cmFrozen.status})`);

finish();
