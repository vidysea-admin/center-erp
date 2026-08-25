// QA-1287 + QA-1289 — the SIDH batch id at the CREATE door, and the duplicate warning.
//
// Client, 2026-08-25: "aap batch create karte waqt ek batch ID daalne ka option daal dijiye."
// The field was on the schema and in the PATCH allow-list all along; only POST never took it —
// ARCHITECTURE section 3.9's "divergent by omission" entry. Umesh's decision on validation, asked
// directly with three options on the table: FREE TEXT plus a duplicate WARNING, never a refusal.
//
// Each assertion below is written so it goes RED without the fix, not merely green with it — the
// pre-fix output is pinned in the manifest.
import { adminLogin, req, ok, finish, stamp, today } from "./e2e-lib.mjs";

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

finish();
