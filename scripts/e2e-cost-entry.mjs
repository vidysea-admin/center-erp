// QA-1828b / QA-1828c — what a cost entry records, when "pre-approved" means it, and what happens
// when the head you need is not in the list.
//
// WHY THESE PINS EXIST IN THIS SHAPE. Everything this unit ships stays green under `tsc`,
// `check-user-copy` and every structural pin in the wall even if the feature is completely wrong:
// a field that is never written, a pre-approval that waves everything through, a queue that posts
// straight to the ledger — none of those break a type or a string. This session has already shipped
// one report full of nulls that satisfied every structural assertion around it (QA-1948), and three
// pins of its own that could not fail (QA-1950). So every assertion below is behavioural, and each
// one is derived from the INPUTS rather than from the output it is checking.
//
// Its own file rather than e2e-roles.mjs: a concurrent session holds that file. One working tree,
// two sessions — see the QA-1942/QA-609 family.
import { requireLocalBase } from "./db-guard.mjs";
// QA-2449: the shared bare-digit leak detector, so this pin and every future live check hunt the
// same shape instead of each re-deriving a regex that a correct partial fix can blind.
import { bareFigures } from "./e2e-lib.mjs";
import { MongoClient, ObjectId } from "mongodb";
import * as XLSX from "xlsx";
import { readFileSync } from "node:fs";

// This is deliberately a source-level runtime mutant, not a second Next build. The focused
// suite drives the compiled route, whereas this mode extracts the exact private helper below,
// replaces only its post-persist conditional fence, and executes both versions against the same
// in-memory collection. It therefore remains runnable when a disposable Next build cannot fetch
// Google Fonts or start a server. The expected mutant result is non-zero: a Pending Formula row
// survives after its simulated Batch confirmation rejects.
if (process.env.FORMULA_POST_PERSIST_MUTANT === "1") {
  const rulesSource = readFileSync(new URL("../src/lib/rules.ts", import.meta.url), "utf8");
  const helperStart = rulesSource.indexOf("async function persistFormulaReservation(");
  const helperEnd = rulesSource.indexOf("\nasync function cancelFormulaReservation(", helperStart);
  const helper = helperStart >= 0 && helperEnd > helperStart ? rulesSource.slice(helperStart, helperEnd) : "";
  const postPersistStart = helper.indexOf("  if (durableEntry.batch) {");
  const braceEnd = (text, opening) => {
    let depth = 0, quote = "", escaped = false;
    for (let i = opening; i < text.length; i++) {
      const char = text[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
        continue;
      }
      if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
      if (char === "{") depth++;
      if (char === "}" && --depth === 0) return i;
    }
    return -1;
  };
  const postPersistEnd = postPersistStart < 0 ? -1 : braceEnd(helper, helper.indexOf("{", postPersistStart));
  const toExecutable = (candidate) => candidate
    .replace("entry: CostEntryDraft,", "entry,")
    .replace("options: { simulateAmbiguousAfterCreate?: boolean } = {},", "options = {},")
    .replace(") as CostEntryDraft;", ");");
  const execute = async (candidate) => {
    const rows = new Map();
    let confirmations = 0;
    function Entry() { this.validateSync = () => null; }
    Entry.collection = {
      insertOne: async (row) => { rows.set(String(row._id), row); },
      deleteOne: async (filter) => {
        const row = rows.get(String(filter._id));
        const matches = !!row && String(row.batch) === String(filter.batch)
          && row.reservation_kind === filter.reservation_kind;
        if (matches) rows.delete(String(filter._id));
        return { deletedCount: matches ? 1 : 0 };
      },
    };
    const Types = { ObjectId: class { constructor(value) { this.value = String(value); } toString() { return this.value; } } };
    const makePersist = new Function("CostEntry", "readBackCostEntry", "Types", "confirmBatchAcceptingFinanceWork",
      `${toExecutable(candidate)}\nreturn persistFormulaReservation;`);
    const persist = makePersist(Entry, async () => null, Types, async () => {
      confirmations++;
      throw new Error("simulated post-persist Batch deletion fence");
    });
    let thrown = null;
    try {
      await persist({ _id: "formula-post-persist-mutant", batch: "batch-being-deleted", reservation_kind: "Formula" });
    } catch (error) {
      thrown = error;
    }
    return { confirmations, thrown, stranded: rows.has("formula-post-persist-mutant") };
  };
  if (!helper || postPersistStart < 0 || postPersistEnd < 0
      || (helper.match(/await confirmBatchAcceptingFinanceWork\(durableEntry\.batch\);/g) ?? []).length !== 1) {
    console.error("FAIL formula post-persist mutant setup: the exact helper/fence could not be uniquely located");
    process.exit(2);
  }
  const normal = await execute(helper);
  const mutant = await execute(helper.slice(0, postPersistStart) + helper.slice(postPersistEnd + 1));
  const normalProtected = normal.confirmations === 1 && !!normal.thrown && !normal.stranded;
  const mutantFailsGuarantee = mutant.confirmations === 0 && !mutant.thrown && mutant.stranded;
  console.log(`formula post-persist normal: confirmation=${normal.confirmations} thrown=${!!normal.thrown} stranded=${normal.stranded}`);
  console.error(`formula post-persist mutant: confirmation=${mutant.confirmations} thrown=${!!mutant.thrown} stranded=${mutant.stranded}`);
  if (!normalProtected || !mutantFailsGuarantee) {
    console.error("FAIL formula post-persist mutant: harness did not distinguish the real confirmation from its removal");
    process.exit(2);
  }
  console.error("FAIL formula post-persist mutant: removed final conditional confirmation leaves a Formula reservation stranded");
  process.exit(1);
}
// QA-1966: never write through a BASE_URL nobody checked. This suite creates cost heads, posts
// money and decides approvals; run against a non-local address it would do all three on production.
const BASE = requireLocalBase("e2e-cost-entry", process.env.BASE_URL || "http://localhost:3000/erp");
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + "   " + x); } };

async function login(email, password) {
  const csrfRes = await fetch(BASE + "/api/auth/csrf");
  const { csrfToken } = await csrfRes.json();
  const csrfCookie = csrfRes.headers.get("set-cookie").split(";")[0];
  const res = await fetch(BASE + "/api/auth/callback/credentials", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: csrfCookie },
    body: new URLSearchParams({ csrfToken, email, password }), redirect: "manual",
  });
  const session = (res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")]).flat().filter(Boolean)
    .map((c) => c.split(";")[0]).find((c) => c.includes("session-token"));
  return session ? [csrfCookie, session].join("; ") : null;
}
async function req(cookie, method, p, body) {
  const res = await fetch(BASE + p, { method, headers: { "Content-Type": "application/json", cookie }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function reqBuffer(cookie, p) {
  const res = await fetch(BASE + p, { headers: { cookie } });
  return { status: res.status, data: Buffer.from(await res.arrayBuffer()) };
}

const rawClient = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017", { serverSelectionTimeoutMS: 8000 });
await rawClient.connect();
const rawDb = rawClient.db((process.env.MONGODB_DB || "center_erp_ci").trim());
const rawCosts = rawDb.collection("costentries");
const rawCategories = rawDb.collection("costcategories");
const rawApprovals = rawDb.collection("approvalrequests");
const rawAudits = rawDb.collection("auditlogs");
const rawUsers = rawDb.collection("users");
const rawBatches = rawDb.collection("batches");

const batchDeletionFields = [
  "deletion_state", "deletion_started_at", "deletion_actor", "deletion_reason",
  "deletion_recorded_work", "deletion_requires_finance", "deletion_audit_event_id",
];

const PW = "CiOnly@123";
const admin = await login("admin@vidysea.com", process.env.ADMIN_PASSWORD || "admin123");
const ops = await login("ops@vidysea.com", PW);
const spoc = await login("spoc.jpr03@vidysea.com", PW);
const trainerUser = await login("trainer.jpr03@vidysea.com", PW);
const enroll = await login("enroll@vidysea.com", PW);
const viewer = await login("viewer.jpr03@vidysea.com", PW);
ok("[precondition] cost-entry personas can sign in", !!admin && !!ops && !!spoc && !!trainerUser && !!enroll && !!viewer,
  `admin=${!!admin} ops=${!!ops} spoc=${!!spoc} trainer=${!!trainerUser} enroll=${!!enroll} viewer=${!!viewer}`);

const stamp = Date.now().toString(36);
const proposedHeadForMine = `ZZ Proposed ${stamp}`;
const anyLoc = ((await req(admin, "GET", "/api/locations?limit=5")).data?.items ?? [])[0]?._id;
ok("[precondition] a location exists to hang entries on", !!anyLoc, "none");

// Rule 37 needs one of location/batch/trainer; a location is the simplest.
const baseEntry = (extra = {}) => ({ entry_date: "2026-09-07", location: anyLoc, amount: 500, note: "pin: what this was for", ...extra });

// -------------------------------- every operational role may submit, but only inside its scope
{
  // Pin the rule OFF here so a successful scoped submission has one unambiguous outcome (201).
  // Later blocks turn it on and verify the parking path separately.
  const ruleOff = await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: false, approver_role: "Admin" });
  ok("cost scope [precondition]: cost.post approval is OFF for direct-write assertions", ruleOff.status === 200, `got ${ruleOff.status}`);

  const allLocs = (await req(admin, "GET", "/api/locations?limit=2000")).data?.items ?? [];
  const ownLoc = allLocs.find((l) => l.code === "JPR03");
  const foreignLoc = allLocs.find((l) => l.code === "KOT02");
  const ownBatch = ((await req(spoc, "GET", "/api/batches?limit=2000")).data?.items ?? [])[0];
  const foreignBatch = ((await req(admin, "GET", `/api/batches?location=${foreignLoc?._id}&limit=2000`)).data?.items ?? [])
    .find((b) => String(b.location?._id ?? b.location) === String(foreignLoc?._id));
  const ownTrainer = ((await req(spoc, "GET", "/api/trainers?limit=2000")).data?.items ?? [])[0];
  const foreignTrainer = ((await req(admin, "GET", `/api/trainers?home_location=${foreignLoc?._id}&limit=2000`)).data?.items ?? [])[0];
  const cat = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])[0];
  ok("cost scope [precondition]: own and foreign fixtures exist for all three dimensions",
    !!ownLoc && !!foreignLoc && !!ownBatch && !!foreignBatch && !!ownTrainer && !!foreignTrainer && !!cat,
    JSON.stringify({ ownLoc: ownLoc?.code, foreignLoc: foreignLoc?.code, ownBatch: ownBatch?.code, foreignBatch: foreignBatch?.code, ownTrainer: ownTrainer?.name, foreignTrainer: foreignTrainer?.name, cat: cat?.name }));

  const scopeStamp = `scope-${stamp}`;
  const post = (cookie, extra, note) => req(cookie, "POST", "/api/costs", {
    entry_date: "2026-09-07", category: cat?._id, amount: 111, note: `${scopeStamp}-${note}`, ...extra,
  });

  if (ownLoc && foreignLoc && ownBatch && foreignBatch && ownTrainer && foreignTrainer && cat) {
    const badLocation = await post(spoc, { location: foreignLoc._id }, "bad-location");
    const badBatch = await post(spoc, { batch: foreignBatch._id }, "bad-batch");
    const badTrainer = await post(spoc, { trainer: foreignTrainer._id }, "bad-trainer");
    ok("cost scope: a Location user cannot POST a foreign location", badLocation.status === 403, `got ${badLocation.status}`);
    ok("cost scope: a Location user cannot POST a foreign batch", badBatch.status === 403, `got ${badBatch.status}`);
    ok("cost scope: a Location user cannot POST a foreign trainer", badTrainer.status === 403, `got ${badTrainer.status}`);

    // A missing scope guard and a working one both return a response; prove the refusals happened
    // before any durable side effect, including the approval queue.
    const ledgerAfterRefusals = (await req(admin, "GET", "/api/costs")).data?.items ?? [];
    const mineAfterRefusals = (await req(spoc, "GET", "/api/approvals?mine=1")).data?.items ?? [];
    ok("cost scope: refused foreign dimensions create no ledger row and no parked request",
      !ledgerAfterRefusals.some((c) => String(c.note ?? "").startsWith(scopeStamp))
        && !mineAfterRefusals.some((a) => String(a.summary ?? "").includes(scopeStamp)),
      JSON.stringify({ ledger: ledgerAfterRefusals.filter((c) => String(c.note ?? "").startsWith(scopeStamp)).length, approvals: mineAfterRefusals.filter((a) => String(a.summary ?? "").includes(scopeStamp)).length }));

    const goodLocation = await post(spoc, { location: ownLoc._id }, "good-location");
    const goodBatch = await post(spoc, { batch: ownBatch._id }, "good-batch");
    const goodTrainer = await post(spoc, { trainer: ownTrainer._id }, "good-trainer");
    ok("cost scope: the same Location user can POST its own location", goodLocation.status === 201, `got ${goodLocation.status}`);
    ok("cost scope: the same Location user can POST its own batch", goodBatch.status === 201, `got ${goodBatch.status}`);
    ok("cost scope: the same Location user can POST an own-centre trainer", goodTrainer.status === 201, `got ${goodTrainer.status}`);

    const trainerOwnBatch = await post(trainerUser, { batch: ownBatch._id }, "trainer-own-batch");
    const enrollmentAnyLocation = await post(enroll, { location: foreignLoc._id }, "enrollment-location");
    ok("cost submission: Trainer can POST a cost against a batch in their scope", trainerOwnBatch.status === 201, `got ${trainerOwnBatch.status}`);
    ok("cost submission: central Enrollment can POST a location cost (empty scope means all locations)", enrollmentAnyLocation.status === 201, `got ${enrollmentAnyLocation.status}`);
    ok("cost submission: a view-only Location login still cannot POST", (await post(viewer, { location: ownLoc._id }, "viewer-refused")).status === 403);

    ok("finance boundary: cost submitters still cannot read the cost ledger",
      (await Promise.all([spoc, trainerUser, enroll].map((cookie) => req(cookie, "GET", "/api/costs")))).every((r) => r.status === 403));
  }
}

// ---------------------------------------------------------------- item 5: the fields
{
  const cat = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])
    .find((c) => !c.pre_approved && c.active !== false);
  ok("[precondition] a normal cost head exists", !!cat, "none");

  // The description is the CEO's *"डिस्क्रिप्शन हो"* and it is REQUIRED on the server, not merely
  // on a disabled button. A client-side rule is a courtesy; this is the rule.
  const noDesc = await req(admin, "POST", "/api/costs", { ...baseEntry({ category: cat?._id }), note: "" });
  ok("QA-1828b: a cost entry with no description is refused by the SERVER, not just a greyed button",
    noDesc.status === 400, `got ${noDesc.status}`);

  const made = await req(admin, "POST", "/api/costs", baseEntry({
    category: cat?._id, vendor_payee: `Vendor ${stamp}`, voucher_no: `V-${stamp}`, payment_mode: "UPI",
  }));
  ok("QA-1828b: an entry carrying vendor / voucher / payment mode is accepted", made.status === 201, `got ${made.status}`);
  const madeId = made.data?.item?._id;

  // Written, not merely accepted. A route that takes a field and drops it returns 201 all the same.
  const back = ((await req(admin, "GET", "/api/costs")).data?.items ?? []).find((c) => String(c._id) === String(madeId));
  ok("QA-1828b: ...and they are STORED, read back from the ledger",
    !!back && back.vendor_payee === `Vendor ${stamp}` && back.voucher_no === `V-${stamp}` && back.payment_mode === "UPI",
    JSON.stringify(back ? { v: back.vendor_payee, n: back.voucher_no, m: back.payment_mode } : null));

  // ...and they reach the REPORT, which is the only place anybody actually reads them. The screen
  // apologised for their absence on every load for a week; a field that exists but never reaches
  // the register would leave that apology true while looking fixed.
  const reg = ((await req(admin, "GET", "/api/reports/costs")).data?.register ?? []).find((r) => String(r.id) === String(madeId));
  ok("QA-1828b: ...and they reach the finance register, which is where they are actually read",
    !!reg && reg.vendor_payee === `Vendor ${stamp}` && reg.payment_mode === "UPI",
    JSON.stringify(reg ? { v: reg.vendor_payee, m: reg.payment_mode } : null));

  const badMode = await req(admin, "POST", "/api/costs", baseEntry({ category: cat?._id, payment_mode: "by hand" }));
  ok("QA-1828b: payment mode is a vocabulary, not free text - an unlisted value is refused",
    badMode.status >= 400, `got ${badMode.status}`);


  // Ordinary ledger corrections are still supported. The cap guard below is intentionally scoped
  // only to rows whose pre-approval commitment was applied at post time.
  if (madeId) {
    const corrected = await req(admin, "PATCH", `/api/costs/${madeId}`, { amount: 501, note: "ordinary correction remains editable" });
    ok("cost correction: a normal (not pre-approved) row remains mutable",
      corrected.status === 200 && corrected.data?.item?.amount === 501,
      `got ${corrected.status} ${JSON.stringify(corrected.data?.error ?? "")}`);
    const removed = await req(admin, "DELETE", `/api/costs/${madeId}`);
    const afterDelete = ((await req(admin, "GET", "/api/costs")).data?.items ?? [])
      .find((c) => String(c._id) === String(madeId));
    ok("cost correction: a normal (not pre-approved) row remains deletable",
      removed.status === 200 && !afterDelete, `delete=${removed.status} remains=${!!afterDelete}`);
  }
}

// A CostEntry is the money fact; a temporary audit transport failure after that fact must not turn
// a successful POST into a retriable 500. Both acknowledgement windows leave a durable marker,
// and a normal ledger read drains it exactly once.
{
  const cat = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])
    .find((c) => !c.pre_approved && c.active !== false);
  for (const window of ["before", "after"]) {
    const note = `audit-${window}-${stamp}`;
    const made = await req(admin, "POST", "/api/costs", baseEntry({
      category: cat?._id, amount: window === "before" ? 611 : 612, note,
      ...(window === "before" ? { _test_fail_audit_before_insert: true } : { _test_fail_audit_after_insert: true }),
    }));
    const costId = made.data?.item?._id;
    const raw = costId ? await rawCosts.findOne({ _id: new ObjectId(String(costId)) }) : null;
    const eventId = raw?._audit_events?.[0]?.event_id;
    const beforeCount = eventId ? await rawAudits.countDocuments({ _id: new ObjectId(String(eventId)) }) : -1;
    ok(`durable audit ${window} [precondition]: business write returns 201 with one persisted audit marker`,
      made.status === 201 && !!raw && !!eventId,
      JSON.stringify({ status: made.status, cost: !!raw, eventId }));
    ok(`durable audit ${window}: injected delivery failure does not create a duplicate liability`,
      await rawCosts.countDocuments({ note }) === 1,
      `rows=${await rawCosts.countDocuments({ note })}`);
    ok(`durable audit ${window} [precondition]: injection reached the intended acknowledgement window`,
      window === "before" ? beforeCount === 0 : beforeCount === 1,
      `audit rows before recovery=${beforeCount}`);

    const concurrentReads = await Promise.all(Array.from({ length: 8 }, () => req(admin, "GET", "/api/costs")));
    const recovered = eventId ? await rawAudits.countDocuments({ _id: new ObjectId(String(eventId)) }) : -1;
    const recoveredRow = eventId ? await rawAudits.findOne({ _id: new ObjectId(String(eventId)) }) : null;
    const ownerAfter = costId ? await rawCosts.findOne({ _id: new ObjectId(String(costId)) }) : null;
    await req(admin, "GET", "/api/costs");
    const afterSecondRead = eventId ? await rawAudits.countDocuments({ _id: new ObjectId(String(eventId)) }) : -1;
    ok(`durable audit ${window}: a subsequent ordinary ledger read delivers and acknowledges the pending event`,
      concurrentReads.every((r) => r.status === 200) && recovered === 1
        && (ownerAfter?._audit_delivered_event_ids ?? []).includes(String(eventId)),
      JSON.stringify({ reads: concurrentReads.map((r) => r.status), recovered, delivered: ownerAfter?._audit_delivered_event_ids }));
    ok(`durable audit ${window}: repeated recovery remains exactly one AuditLog row`,
      afterSecondRead === 1,
      `audit rows after second read=${afterSecondRead}`);
    const auditKeys = recoveredRow ? Object.keys(recoveredRow).sort() : [];
    ok(`durable audit ${window}: raw AuditLog uses the canonical contract exactly`,
      recoveredRow?.actor_type === "USER" && recoveredRow?.created_at instanceof Date
        && recoveredRow?.createdAt === undefined && recoveredRow?.updatedAt === undefined
        && JSON.stringify(auditKeys) === JSON.stringify(["_id", "actor", "actor_type", "created_at", "entity", "entity_id", "field", "new_value", "old_value"]),
      JSON.stringify({ actor_type: recoveredRow?.actor_type, keys: auditKeys }));
  }
}

// Deleting the business owner before its creation event is confirmed would erase recovery. A
// foreign deterministic AuditLog occupant must preserve the now-hidden tombstone. Once the
// occupant clears, an ordinary read must deliver both immutable owner events exactly once and
// garbage-collect the tombstone without ever returning a live row beside a final deleted audit.
{
  const cat = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])
    .find((c) => !c.pre_approved && c.active !== false);
  const note = `audit-delete-${stamp}`;
  const made = await req(admin, "POST", "/api/costs", baseEntry({
    category: cat?._id, amount: 613, note, _test_fail_audit_before_insert: true,
  }));
  const costId = made.data?.item?._id;
  const owner = costId ? await rawCosts.findOne({ _id: new ObjectId(String(costId)) }) : null;
  const eventId = owner?._audit_events?.[0]?.event_id;
  if (costId && eventId) {
    const eventObjectId = new ObjectId(String(eventId));
    const foreign = {
      _id: eventObjectId,
      entity: "ForeignAuditOccupant", entity_id: new ObjectId(), field: null,
      old_value: null, new_value: null, actor: new ObjectId(), actor_type: "USER",
      created_at: new Date(),
    };
    await rawAudits.insertOne(foreign);
    const refused = await req(admin, "DELETE", `/api/costs/${costId}`);
    const preserved = await rawCosts.findOne({ _id: new ObjectId(String(costId)) });
    const deletionEvent = (preserved?._audit_events ?? []).find((event) => event?.field === "deleted");
    const occupant = await rawAudits.findOne({ _id: eventObjectId });
    const hidden = (await req(admin, "GET", "/api/costs")).data?.items ?? [];
    ok("audit-owner delete: a foreign deterministic occupant preserves a hidden tombstone with both owner events",
      refused.status === 409 && preserved?.deletion_state === "Pending" && !!deletionEvent
        && occupant?.entity === foreign.entity && !hidden.some((c) => String(c._id) === String(costId))
        && !(preserved?._audit_delivered_event_ids ?? []).includes(String(eventId)),
      JSON.stringify({ status: refused.status, state: preserved?.deletion_state, deletionEvent: deletionEvent?.event_id, occupant: occupant?.entity, visible: hidden.some((c) => String(c._id) === String(costId)), delivered: preserved?._audit_delivered_event_ids }));

    await rawAudits.deleteOne({ _id: eventObjectId, entity: foreign.entity });
    const drain = await req(admin, "GET", "/api/costs");
    const deliveredCreation = await rawAudits.findOne({ _id: eventObjectId });
    const deliveredDeletion = deletionEvent?.event_id
      ? await rawAudits.findOne({ _id: new ObjectId(String(deletionEvent.event_id)) }) : null;
    const ownerAfterDrain = await rawCosts.findOne({ _id: new ObjectId(String(costId)) });
    const visibleAfterDrain = (drain.data?.items ?? []).some((c) => String(c._id) === String(costId));
    ok("audit-owner delete: a later ordinary read delivers creation plus deletion exactly once and collects the tombstone",
      drain.status === 200 && deliveredCreation?.entity === "CostEntry" && deliveredDeletion?.field === "deleted"
        && await rawAudits.countDocuments({ _id: eventObjectId }) === 1
        && await rawAudits.countDocuments({ _id: new ObjectId(String(deletionEvent.event_id)) }) === 1
        && !ownerAfterDrain && !visibleAfterDrain,
      JSON.stringify({ drain: drain.status, creation: deliveredCreation?.entity, deletion: deliveredDeletion?.field, owner: !!ownerAfterDrain, visible: visibleAfterDrain }));
  } else {
    ok("audit-owner delete [precondition]: pending creation owner exists", false, JSON.stringify({ status: made.status, costId, eventId }));
  }
}

// One poison page must not monopolise every future drain. The valid owner is deliberately the
// 101st id, after one full page of missing/empty ids: the exact silent-success branch that used
// to consume all 100 delivery-budget slots without settling any owner.
{
  const cat = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])
    .find((c) => !c.pre_approved && c.active !== false);
  const actor = await rawUsers.findOne({ email: "admin@vidysea.com" });
  const poisonIds = Array.from({ length: 100 }, () => new ObjectId());
  const validOwnerId = new ObjectId();
  const validEventId = new ObjectId();
  const ownerBase = (id, event) => ({
    _id: id, entry_date: new Date("2026-09-07"), location: new ObjectId(String(anyLoc)),
    category: new ObjectId(String(cat?._id)), amount: 1, note: `drain-page-${stamp}`,
    reservation_state: "Applied", entered_by: actor?._id,
    _audit_events: [event], createdAt: new Date(), updatedAt: new Date(),
  });
  if (cat?._id && actor?._id) {
    await rawCosts.insertMany(poisonIds.map((id, i) => ownerBase(id, i % 2 === 0 ? {} : { event_id: "" })));
    await rawCosts.insertOne(ownerBase(validOwnerId, {
      event_id: validEventId.toHexString(), entity: "CostEntry", entity_id: validOwnerId, field: null,
      old_value: null, new_value: "valid after poison page", actor: actor._id, actor_type: "USER",
    }));
    const drained = await req(admin, "GET", "/api/costs");
    const validAudit = await rawAudits.findOne({ _id: validEventId });
    const validOwner = await rawCosts.findOne({ _id: validOwnerId });
    ok("audit drain pagination: 100 missing/empty-id owners cannot consume the budget or starve the later valid owner",
      drained.status === 200 && validAudit?.new_value === "valid after poison page"
        && (validOwner?._audit_delivered_event_ids ?? []).includes(validEventId.toHexString()),
      JSON.stringify({ status: drained.status, validAudit: validAudit?.new_value, delivered: validOwner?._audit_delivered_event_ids }));
    await rawCosts.deleteMany({ _id: { $in: [...poisonIds, validOwnerId] } });
    await rawAudits.deleteOne({ _id: validEventId });
  } else {
    ok("audit drain pagination [precondition]: category and actor exist", false, JSON.stringify({ category: cat?._id, actor: actor?._id }));
  }
}

// A request may contain more poison than one hard attempt budget. The first read must stop at the
// bound instead of synchronously walking the whole collection, but it must still drain approvals
// independently. The rotating cursor lets the next read reach the valid cost instead of rescanning.
{
  const cat = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])
    .find((c) => !c.pre_approved && c.active !== false);
  const actor = await rawUsers.findOne({ email: "admin@vidysea.com" });
  const poisonIds = Array.from({ length: 250 }, () => new ObjectId());
  const validOwnerId = new ObjectId();
  const validEventId = new ObjectId();
  const approvalId = new ObjectId();
  const approvalEventId = new ObjectId();
  const ownerBase = (id, event) => ({
    _id: id, entry_date: new Date("2026-09-07"), location: new ObjectId(String(anyLoc)),
    category: new ObjectId(String(cat?._id)), amount: 1, note: `bounded-drain-${stamp}`,
    reservation_state: "Applied", entered_by: actor?._id,
    _audit_events: [event], createdAt: new Date(), updatedAt: new Date(),
  });
  if (cat?._id && actor?._id) {
    await rawCosts.insertMany(poisonIds.map((id, i) => ownerBase(id, i % 2 === 0 ? {} : { event_id: "" })));
    await rawCosts.insertOne(ownerBase(validOwnerId, {
      event_id: validEventId.toHexString(), entity: "CostEntry", entity_id: validOwnerId, field: null,
      old_value: null, new_value: "valid beyond hard poison bound", actor: actor._id, actor_type: "USER",
    }));
    await rawApprovals.insertOne({
      _id: approvalId, action: "cost.post", summary: `approval drain independent ${stamp}`,
      payload: {}, initiator: actor._id, approver_role: "Admin", status: "Approved",
      _audit_events: [{
        event_id: approvalEventId.toHexString(), entity: "ApprovalRequest", entity_id: approvalId,
        field: "status", old_value: "Applying", new_value: "Approved", actor: actor._id, actor_type: "USER",
      }], createdAt: new Date(), updatedAt: new Date(),
    });
    const first = await req(admin, "GET", "/api/costs");
    const validAfterFirst = await rawAudits.countDocuments({ _id: validEventId });
    const approvalAfterFirst = await rawAudits.countDocuments({ _id: approvalEventId });
    ok("bounded audit drain: a read stops before a valid owner beyond 200 poison attempts",
      first.status === 200 && validAfterFirst === 0,
      JSON.stringify({ status: first.status, validAfterFirst }));
    ok("bounded audit drain: poisoned costs do not starve the independently bounded approval owner",
      approvalAfterFirst === 1,
      `approval audit rows after first read=${approvalAfterFirst}`);

    const second = await req(admin, "GET", "/api/costs");
    const validOwner = await rawCosts.findOne({ _id: validOwnerId });
    ok("bounded audit drain: the next read resumes after poison and delivers the later valid cost exactly once",
      second.status === 200 && await rawAudits.countDocuments({ _id: validEventId }) === 1
        && (validOwner?._audit_delivered_event_ids ?? []).includes(validEventId.toHexString()),
      JSON.stringify({ status: second.status, delivered: validOwner?._audit_delivered_event_ids }));
    await rawCosts.deleteMany({ _id: { $in: [...poisonIds, validOwnerId] } });
    await rawAudits.deleteMany({ _id: { $in: [validEventId, approvalEventId] } });
    await rawApprovals.deleteOne({ _id: approvalId });
  } else {
    ok("bounded audit drain [precondition]: category and actor exist", false, JSON.stringify({ category: cat?._id, actor: actor?._id }));
  }
}

// The logical deletion claim and immutable event are atomic. Both delivery failure windows must
// hide and freeze the row, retain the owner until acknowledgement, then recover exactly once and
// garbage-collect without requiring a second DELETE.
{
  const cat = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])
    .find((c) => !c.pre_approved && c.active !== false);
  for (const window of ["before", "after"]) {
    const original = { amount: window === "before" ? 614 : 615, note: `delete-audit-${window}-${stamp}` };
    const made = await req(admin, "POST", "/api/costs", baseEntry({ category: cat?._id, ...original }));
    const costId = made.data?.item?._id;
    if (!costId) {
      ok(`deletion audit ${window} [precondition]: an ordinary cost exists`, false, `status=${made.status}`);
      continue;
    }
    const refused = await req(admin, "DELETE", `/api/costs/${costId}?_test_fail_audit=${window}`);
    const ownerAfterRefusal = await rawCosts.findOne({ _id: new ObjectId(String(costId)) });
    const deletionEvent = (ownerAfterRefusal?._audit_events ?? []).find((event) => event?.field === "deleted");
    const deletionEventId = deletionEvent?.event_id ? new ObjectId(String(deletionEvent.event_id)) : null;
    const auditBeforeRecovery = deletionEventId ? await rawAudits.countDocuments({ _id: deletionEventId }) : -1;
    ok(`deletion audit ${window}: failure preserves a hidden tombstone and immutable deletion snapshot`,
      refused.status === 409 && ownerAfterRefusal?.deletion_state === "Pending" && !!deletionEventId
        && deletionEvent?.old_value?.amount === original.amount && deletionEvent?.old_value?.note === original.note
        && auditBeforeRecovery === (window === "after" ? 1 : 0),
      JSON.stringify({ status: refused.status, state: ownerAfterRefusal?.deletion_state, event: deletionEvent, auditBeforeRecovery }));

    const patched = await req(admin, "PATCH", `/api/costs/${costId}`, {
      amount: original.amount + 1000, note: `must-not-change-${window}-${stamp}`,
    });
    const ownerAfterPatch = await rawCosts.findOne({ _id: new ObjectId(String(costId)) });
    ok(`deletion audit ${window}: PATCH after the logical delete claim is refused and cannot mutate the snapshot`,
      patched.status === 409 && ownerAfterPatch?.amount === original.amount && ownerAfterPatch?.note === original.note
        && (ownerAfterPatch?._audit_events ?? []).filter((event) => event?.field === "deleted").length === 1,
      JSON.stringify({ status: patched.status, amount: ownerAfterPatch?.amount, note: ownerAfterPatch?.note }));

    const drain = await req(admin, "GET", "/api/costs");
    const deletionAudit = deletionEventId ? await rawAudits.findOne({ _id: deletionEventId }) : null;
    const remains = await rawCosts.findOne({ _id: new ObjectId(String(costId)) });
    const visible = (drain.data?.items ?? []).some((c) => String(c._id) === String(costId));
    ok(`deletion audit ${window}: ordinary read publishes once, never returns the deleted row, and garbage-collects only after ack`,
      drain.status === 200 && deletionAudit?.field === "deleted"
        && deletionAudit?.old_value?.amount === original.amount && deletionAudit?.old_value?.note === original.note
        && await rawAudits.countDocuments({ _id: deletionEventId }) === 1 && !remains && !visible,
      JSON.stringify({ drain: drain.status, audit: deletionAudit, remains: !!remains, visible }));
    await req(admin, "GET", "/api/costs");
    const repeatDelete = await req(admin, "DELETE", `/api/costs/${costId}`);
    ok(`deletion audit ${window}: repeated recovery/delete cannot duplicate or resurrect the committed deletion`,
      repeatDelete.status === 404 && await rawAudits.countDocuments({ _id: deletionEventId }) === 1,
      `delete=${repeatDelete.status} auditCount=${await rawAudits.countDocuments({ _id: deletionEventId })}`);
  }
}

// The dangerous PATCH race starts before the delete claim. A delayed PATCH must not be able to
// save by `_id` after DELETE has atomically hidden and snapshotted the row.
{
  const cat = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])
    .find((c) => !c.pre_approved && c.active !== false);
  const original = { amount: 616, note: `patch-delete-race-${stamp}` };
  const made = await req(admin, "POST", "/api/costs", baseEntry({ category: cat?._id, ...original }));
  const costId = made.data?.item?._id;
  if (costId) {
    const barrier = `patch-first-${stamp}`;
    const patchPromise = req(admin, "PATCH", `/api/costs/${costId}?_test_wait_after_patch_load=${barrier}`, {
      amount: 1616, note: `late-patch-${stamp}`,
    });
    let barrierSeen = false;
    for (let i = 0; i < 100 && !barrierSeen; i++) {
      const row = await rawCosts.findOne({ _id: new ObjectId(String(costId)) });
      barrierSeen = row?._test_patch_loaded_barrier === barrier;
      if (!barrierSeen) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const deleteResult = await req(admin, "DELETE", `/api/costs/${costId}?_test_fail_audit=before`);
    const tombstoneBeforePatch = await rawCosts.findOne({ _id: new ObjectId(String(costId)) });
    await rawCosts.updateOne({ _id: new ObjectId(String(costId)) }, { $unset: { _test_patch_loaded_barrier: "" } });
    const patchResult = await patchPromise;
    const tombstoneAfterPatch = await rawCosts.findOne({ _id: new ObjectId(String(costId)) });
    const deletionEvent = (tombstoneAfterPatch?._audit_events ?? []).find((event) => event?.field === "deleted");
    ok("PATCH/delete race [precondition]: the route barrier proves PATCH loaded before DELETE claimed the tombstone",
      barrierSeen && deleteResult.status === 409 && tombstoneBeforePatch?.deletion_state === "Pending",
      JSON.stringify({ barrierSeen, delete: deleteResult.status, state: tombstoneBeforePatch?.deletion_state }));
    ok("PATCH/delete race: the late PATCH loses the write CAS and cannot change the committed deletion snapshot",
      patchResult.status === 409 && tombstoneAfterPatch?.amount === original.amount && tombstoneAfterPatch?.note === original.note
        && deletionEvent?.old_value?.amount === original.amount && deletionEvent?.old_value?.note === original.note,
      JSON.stringify({ patch: patchResult.status, amount: tombstoneAfterPatch?.amount, note: tombstoneAfterPatch?.note, snapshot: deletionEvent?.old_value }));
    await req(admin, "GET", "/api/costs");
  } else {
    ok("PATCH/delete race [precondition]: an ordinary cost exists", false, `status=${made.status}`);
  }
}

// Reverse the interleaving: DELETE loads first, then a correction or Payment Done wins. updatedAt
// is part of the tombstone claim CAS, so neither kind of successful PATCH can be followed by a
// stale deletion snapshot; the loser is an explicit 409, not a generic handler 500.
for (const variant of ["ordinary", "mark_paid"]) {
  const cat = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])
    .find((c) => !c.pre_approved && c.active !== false);
  const original = { amount: variant === "ordinary" ? 616.1 : 616.2, note: `delete-loads-${variant}-${stamp}` };
  const made = await req(admin, "POST", "/api/costs", baseEntry({
    category: cat?._id, ...original, vendor_payee: `before-${variant}-${stamp}`, payment_mode: "Cash",
  }));
  const costId = made.data?.item?._id;
  if (!costId) {
    ok(`DELETE-loads/${variant} [precondition]: an ordinary cost exists`, false, `status=${made.status}`);
    continue;
  }
  const barrier = `delete-first-${variant}-${stamp}`;
  const deletePromise = req(admin, "DELETE", `/api/costs/${costId}?_test_wait_after_delete_load=${barrier}`);
  let barrierSeen = false;
  for (let i = 0; i < 100 && !barrierSeen; i++) {
    const row = await rawCosts.findOne({ _id: new ObjectId(String(costId)) });
    barrierSeen = row?._test_delete_loaded_barrier === barrier;
    if (!barrierSeen) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const patchBody = variant === "ordinary"
    ? { amount: original.amount + 100, note: `patch-won-${variant}-${stamp}` }
    : { mark_paid: true, paid_on: "2026-09-08", payment_ref: `RACE-${stamp}`, vendor_payee: `paid-${stamp}`, payment_mode: "UPI" };
  const patchResult = await req(admin, "PATCH", `/api/costs/${costId}`, patchBody);
  await rawCosts.updateOne({ _id: new ObjectId(String(costId)) }, { $unset: { _test_delete_loaded_barrier: "" } });
  const deleteResult = await deletePromise;
  const after = await rawCosts.findOne({ _id: new ObjectId(String(costId)) });
  const deletionAudits = await rawAudits.countDocuments({
    entity: "CostEntry", entity_id: new ObjectId(String(costId)), field: "deleted",
  });
  ok(`DELETE-loads/${variant} [precondition]: route barrier proves DELETE loaded before the PATCH won`,
    barrierSeen && patchResult.status === 200,
    JSON.stringify({ barrierSeen, patch: patchResult.status }));
  ok(`DELETE-loads/${variant}: stale tombstone claim loses with 409 and writes no deletion event/audit`,
    deleteResult.status === 409 && after?.deletion_state === undefined && deletionAudits === 0
      && (variant === "ordinary"
        ? after?.amount === patchBody.amount && after?.note === patchBody.note
        : after?.payment_status === "Paid" && after?.payment_ref === patchBody.payment_ref),
    JSON.stringify({ delete: deleteResult.status, state: after?.deletion_state, audits: deletionAudits, amount: after?.amount, note: after?.note, payment: after?.payment_status, ref: after?.payment_ref }));
  await req(admin, "DELETE", `/api/costs/${costId}`);
}

// The winning DELETE must stay successful if an ordinary recovery read acknowledges and collects
// its tombstone while the claimant is paused after the atomic claim.
{
  const cat = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])
    .find((c) => !c.pre_approved && c.active !== false);
  const made = await req(admin, "POST", "/api/costs", baseEntry({
    category: cat?._id, amount: 617, note: `delete-get-race-${stamp}`,
  }));
  const costId = made.data?.item?._id;
  if (costId) {
    let deleteSettled = false;
    const deletePromise = req(admin, "DELETE", `/api/costs/${costId}?_test_pause_after_delete_claim_ms=700`)
      .finally(() => { deleteSettled = true; });
    let tombstone = null;
    for (let i = 0; i < 30 && !tombstone; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      tombstone = await rawCosts.findOne({ _id: new ObjectId(String(costId)), deletion_state: "Pending" });
    }
    const claimantStillPaused = !deleteSettled;
    const recovery = await req(admin, "GET", "/api/costs");
    const deleteResult = await deletePromise;
    const deletionAudits = await rawAudits.find({
      entity: "CostEntry", entity_id: new ObjectId(String(costId)), field: "deleted",
    }).toArray();
    ok("DELETE/GET race [precondition]: recovery observed the committed tombstone while its claimant was paused",
      !!tombstone && claimantStillPaused && recovery.status === 200,
      JSON.stringify({ tombstone: !!tombstone, claimantStillPaused, recovery: recovery.status }));
    ok("DELETE/GET race: recovery may acknowledge and collect first without turning the claimant into a false 500",
      deleteResult.status === 200 && deletionAudits.length === 1
        && !(await rawCosts.findOne({ _id: new ObjectId(String(costId)) })),
      JSON.stringify({ delete: deleteResult.status, audits: deletionAudits.length, remains: !!(await rawCosts.findOne({ _id: new ObjectId(String(costId)) })) }));
  } else {
    ok("DELETE/GET race [precondition]: an ordinary cost exists", false, `status=${made.status}`);
  }
}

// Batch force-delete is a second physical delete door. It may erase ordinary carried costs, but a
// hidden unacknowledged tombstone is still the audit outbox owner and must survive that cascade.
{
  const template = await rawBatches.findOne({});
  const cat = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])
    .find((c) => !c.pre_approved && c.active !== false);
  const batchId = new ObjectId();
  if (template?.location && template?.program && cat?._id) {
    await rawBatches.insertOne({
      _id: batchId, code: `ZZ-CASCADE-${stamp}`, status: "Planning",
      location: template.location, program: template.program, target_size: 1,
      planned_start: new Date("2026-09-01"), planned_end: new Date("2026-09-30"),
      createdAt: new Date(), updatedAt: new Date(),
    });
    const doomed = await req(admin, "POST", "/api/costs", baseEntry({
      category: cat._id, batch: batchId, amount: 618, note: `cascade-tombstone-${stamp}`,
    }));
    const ordinary = await req(admin, "POST", "/api/costs", baseEntry({
      category: cat._id, batch: batchId, amount: 619, note: `cascade-visible-${stamp}`,
    }));
    const doomedId = doomed.data?.item?._id;
    const ordinaryId = ordinary.data?.item?._id;
    if (doomedId && ordinaryId) {
      const formulaHead = await req(admin, "POST", "/api/master-lists/cost-categories", {
        name: `ZZ Cascade Formula ${stamp}`, pre_approved: true,
        pre_approved_unit: "Per billable passed", pre_approved_amount: 50,
        pre_approved_min_billable: 0, pre_approved_basis: "cycle 10 cascade race",
      });
      await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: true, approver_role: "Admin" });
      const formulaNote = `cascade-formula-pending-${stamp}`;
      const formulaPromise = req(ops, "POST", "/api/costs", {
        entry_date: "2026-09-07", batch: batchId, category: formulaHead.data?.item?._id,
        amount: 1, note: formulaNote, _test_formula_wait_for_batch_deletion_fence_ms: 3000,
      });
      let formulaPendingBeforeCascade = null;
      for (let i = 0; i < 100 && !formulaPendingBeforeCascade; i++) {
        formulaPendingBeforeCascade = await rawCosts.findOne({
          batch: batchId, note: formulaNote, reservation_state: "Pending",
        });
        if (!formulaPendingBeforeCascade) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Claim only after the formula POST has passed its initial recovery drain; otherwise that
      // POST would correctly acknowledge and collect the tombstone before the cascade attack.
      const claimed = await req(admin, "DELETE", `/api/costs/${doomedId}?_test_fail_audit=before`);
      // The formula has persisted and is waiting only for the force-delete's durable marker. The
      // deletion route pauses after claiming it, so this is an ordered race, not a sleep guess:
      // pre-fix code would cancel and queue a request during this window.
      const cascadePromise = req(admin, "DELETE", `/api/batches/${batchId}?_test_pause_after_deletion_fence_ms=2000`, { reason: "cycle 11 formula deletion-fence attack" });
      let sawDeletionFence = false;
      for (let i = 0; i < 100 && !sawDeletionFence; i++) {
        const fence = await rawBatches.findOne({ _id: batchId }, { projection: { deletion_state: 1 } });
        sawDeletionFence = fence?.deletion_state === "Deleting";
        if (!sawDeletionFence) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const formulaResult = await formulaPromise;
      const cascade = await cascadePromise;
      await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: false, approver_role: "Admin" });
      const tombstoneAfterCascade = await rawCosts.findOne({ _id: new ObjectId(String(doomedId)) });
      const ordinaryAfterCascade = await rawCosts.findOne({ _id: new ObjectId(String(ordinaryId)) });
      const formulaAfterCascade = await rawCosts.findOne({ batch: batchId, note: formulaNote });
      const formulaApprovalsAfterCascade = await rawApprovals.find({ batch: batchId, action: "cost.post" }).toArray();
      const deletionEvent = (tombstoneAfterCascade?._audit_events ?? []).find((event) => event?.field === "deleted");
      const auditBeforeRecovery = deletionEvent?.event_id
        ? await rawAudits.countDocuments({ _id: new ObjectId(String(deletionEvent.event_id)) }) : -1;
      ok("batch cascade [precondition]: force-delete ran while a tombstone and a live Formula Pending reservation both existed",
        claimed.status === 409 && !!formulaPendingBeforeCascade && sawDeletionFence && cascade.status === 200
          && tombstoneAfterCascade?.deletion_state === "Pending",
        JSON.stringify({ claimed: claimed.status, formulaPending: !!formulaPendingBeforeCascade, sawDeletionFence, cascade: cascade.status, state: tombstoneAfterCascade?.deletion_state }));
      ok("batch deletion fence: a Formula POST paused at its durable reservation returns 409 and leaves no cost or approval orphan",
        formulaResult.status === 409 && !ordinaryAfterCascade && !formulaAfterCascade
          && formulaApprovalsAfterCascade.length === 0 && !!tombstoneAfterCascade && auditBeforeRecovery === 0,
        JSON.stringify({ formulaResult: formulaResult.status, ordinary: !!ordinaryAfterCascade, formula: !!formulaAfterCascade, approvals: formulaApprovalsAfterCascade.length, tombstone: !!tombstoneAfterCascade, auditBeforeRecovery }));
      await req(admin, "GET", "/api/costs");
      ok("batch cascade: later audit acknowledgement collects the surviving tombstone exactly once",
        !!deletionEvent?.event_id && !(await rawCosts.findOne({ _id: new ObjectId(String(doomedId)) }))
          && await rawAudits.countDocuments({ _id: new ObjectId(String(deletionEvent?.event_id)) }) === 1,
        `remains=${!!(await rawCosts.findOne({ _id: new ObjectId(String(doomedId)) }))}`);
    } else {
      ok("batch cascade [precondition]: two carried costs exist", false,
        JSON.stringify({ doomed: doomed.status, ordinary: ordinary.status }));
    }
    await rawBatches.deleteOne({ _id: batchId });
    await rawCosts.deleteMany({ batch: batchId });
  } else {
    ok("batch cascade [precondition]: batch/category fixture exists", false,
      JSON.stringify({ batch: !!template, category: cat?._id }));
  }
}

// Cycle 12: every batch-backed finance materialisation has to lose cleanly even when the force
// delete already passed deleteMany.  These are ordered races (we observe the newborn row before
// deleting), not timing guesses; raw reads prove no late cost/request survives the 409.
{
  const template = await rawBatches.findOne({});
  const cat = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])
    .find((c) => !c.pre_approved && c.active !== false);
  const makeBatch = async (suffix) => {
    const batchId = new ObjectId();
    await rawBatches.insertOne({
      _id: batchId, code: `ZZ-C12-${suffix}-${stamp}`, status: "Planning", location: template.location,
      program: template.program, target_size: 1, planned_start: new Date("2026-09-01"),
      planned_end: new Date("2026-09-30"), createdAt: new Date(), updatedAt: new Date(),
    });
    return batchId;
  };
  const waitFor = async (read) => {
    for (let i = 0; i < 100; i++) {
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return null;
  };
  if (template?.location && template?.program && cat?._id) {
    const directBatch = await makeBatch("DIRECT");
    const directNote = `c12-direct-${stamp}`;
    const directPromise = req(admin, "POST", "/api/costs", baseEntry({
      batch: directBatch, category: cat._id, amount: 701, note: directNote,
      _test_pause_after_cost_create_ms: 2500,
    }));
    const directNewborn = await waitFor(() => rawCosts.findOne({ batch: directBatch, note: directNote }));
    const directDelete = await req(admin, "DELETE", `/api/batches/${directBatch}`, { reason: "cycle 12 direct post race" });
    const directResult = await directPromise;
    ok("batch materialization [precondition]: fixed direct cost reached its final batch fence after its row existed",
      !!directNewborn && directDelete.status === 200,
      JSON.stringify({ newborn: !!directNewborn, cascade: directDelete.status }));
    ok("batch materialization: fixed direct post loses the post-cascade race with 409 and leaves no late cost",
      directResult.status === 409 && !(await rawCosts.findOne({ batch: directBatch, note: directNote }))
        && !(await rawBatches.findOne({ _id: directBatch })),
      JSON.stringify({ post: directResult.status, cost: !!(await rawCosts.findOne({ batch: directBatch, note: directNote })), batch: !!(await rawBatches.findOne({ _id: directBatch })) }));

    await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: true, approver_role: "Admin" });
    const queuedBatch = await makeBatch("QUEUE");
    const queuedNote = `c12-queued-${stamp}`;
    const queuePromise = req(admin, "POST", "/api/costs", baseEntry({
      batch: queuedBatch, category: cat._id, amount: 702, note: queuedNote,
      _test_pause_after_approval_request_create_ms: 2500,
    }));
    const queuedNewborn = await waitFor(() => rawApprovals.findOne({ batch: queuedBatch, action: "cost.post" }));
    const queueDelete = await req(admin, "DELETE", `/api/batches/${queuedBatch}`, { reason: "cycle 12 queue post-create race" });
    const queueResult = await queuePromise;
    ok("batch materialization [precondition]: queued cost paused after ApprovalRequest.create",
      !!queuedNewborn && queueDelete.status === 200,
      JSON.stringify({ newborn: !!queuedNewborn, cascade: queueDelete.status }));
    ok("batch materialization: post-create approval fence returns 409 and leaves no request or cost orphan",
      queueResult.status === 409 && !(await rawApprovals.findOne({ batch: queuedBatch }))
        && !(await rawCosts.findOne({ batch: queuedBatch })),
      JSON.stringify({ post: queueResult.status, request: !!(await rawApprovals.findOne({ batch: queuedBatch })), cost: !!(await rawCosts.findOne({ batch: queuedBatch })) }));

    const replayBatch = await makeBatch("REPLAY");
    const opsUser = await rawUsers.findOne({ email: "ops@vidysea.com" });
    const replayId = new ObjectId();
    await rawApprovals.insertOne({
      _id: replayId, action: "cost.post", entity: "CostEntry", entity_id: replayId,
      summary: `c12 applying replay ${stamp}`,
      payload: { entry_date: "2026-09-07", location: template.location, batch: replayBatch, category: cat._id,
        amount: 703, note: `c12-replay-${stamp}`, _test_pause_after_cost_create_ms: 2500 },
      location: template.location, batch: replayBatch, initiator: opsUser?._id ?? new ObjectId(),
      approver_role: "Admin", approver_users: [], status: "Pending", createdAt: new Date(), updatedAt: new Date(),
    });
    const replayPromise = req(admin, "POST", `/api/approvals/${replayId}`, { decision: "Approved", note: "cycle 12 replay race" });
    const replayNewborn = await waitFor(() => rawCosts.findOne({ _id: replayId, batch: replayBatch }));
    const replayDelete = await req(admin, "DELETE", `/api/batches/${replayBatch}`, { reason: "cycle 12 applying replay race" });
    const replayResult = await replayPromise;
    ok("batch materialization [precondition]: Applying replay created its deterministic cost before final fence",
      !!replayNewborn && replayDelete.status === 200,
      JSON.stringify({ newborn: !!replayNewborn, cascade: replayDelete.status }));
    ok("batch materialization: Applying replay race returns 409 with neither request nor deterministic cost left behind",
      replayResult.status === 409 && !(await rawApprovals.findOne({ _id: replayId }))
        && !(await rawCosts.findOne({ _id: replayId })),
      JSON.stringify({ replay: replayResult.status, request: !!(await rawApprovals.findOne({ _id: replayId })), cost: !!(await rawCosts.findOne({ _id: replayId })) }));

    // The staged head belongs to the Applying replay, not to the Batch cascade. Observe it first,
    // then its deterministic newborn CostEntry, before deleting the Batch. This forces the replay
    // through the final batch fence rather than merely proving a request was removed before it ran.
    const headReplayBatch = await makeBatch("HEAD-REPLAY");
    const headReplayId = new ObjectId();
    const headReplayName = `ZZ C13 Deleted Batch Head ${stamp}`;
    await rawApprovals.insertOne({
      _id: headReplayId, action: "costcategory.create", entity: "CostCategory", entity_id: headReplayId,
      summary: `c13 staged-head applying replay ${stamp}`,
      payload: {
        entry_date: "2026-09-07", location: template.location, batch: headReplayBatch,
        amount: 703, new_subhead: headReplayName, note: `c13-head-replay-${stamp}`,
        _test_pause_after_cost_create_ms: 2500,
      },
      location: template.location, batch: headReplayBatch, initiator: opsUser?._id ?? new ObjectId(),
      approver_role: "Admin", approver_users: [], status: "Pending", createdAt: new Date(), updatedAt: new Date(),
    });
    const headReplayPromise = req(admin, "POST", `/api/approvals/${headReplayId}`, { decision: "Approved", note: "cycle 13 staged-head replay race" });
    const stagedHead = await waitFor(() => rawCategories.findOne({
      _id: headReplayId, active: false, staged_by_approval: headReplayId, name: headReplayName,
    }));
    const stagedHeadCost = await waitFor(() => rawCosts.findOne({
      _id: headReplayId, batch: headReplayBatch, category: headReplayId,
      approval_request: headReplayId, reservation_kind: "ApprovalHead", reservation_state: "Pending",
    }));
    const headReplayDelete = await req(admin, "DELETE", `/api/batches/${headReplayBatch}`, { reason: "cycle 13 staged head applying replay race" });
    const headReplayResult = await headReplayPromise;
    const [headReplayRequestAfter, headReplayCostAfter, headReplayCategoryAfter] = await Promise.all([
      rawApprovals.findOne({ _id: headReplayId }),
      rawCosts.findOne({ _id: headReplayId }),
      rawCategories.findOne({ _id: headReplayId }),
    ]);
    ok("batch materialization [precondition]: staged cost head and its Pending deterministic cost both existed before the cascade",
      !!stagedHead && !!stagedHeadCost && headReplayDelete.status === 200,
      JSON.stringify({ stagedHead: !!stagedHead, stagedCost: !!stagedHeadCost, cascade: headReplayDelete.status }));
    ok("batch materialization: deleted-batch staged-head replay returns 409 and compensates only its inactive head before removing request/cost",
      headReplayResult.status === 409 && !headReplayRequestAfter && !headReplayCostAfter && !headReplayCategoryAfter,
      JSON.stringify({ replay: headReplayResult.status, request: !!headReplayRequestAfter, cost: !!headReplayCostAfter, category: !!headReplayCategoryAfter }));
    await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: false, approver_role: "Admin" });

    for (const [label, crashParam] of [["before", "_test_crash_after_deletion_claim=1"], ["during", "_test_crash_during_deletion_cascade=1"]]) {
      const crashBatch = await makeBatch(`CRASH-${label}`);
      await rawCosts.insertOne({ _id: new ObjectId(), batch: crashBatch, location: template.location, category: cat._id,
        amount: 704, note: `c12-crash-${label}-${stamp}`, payment_status: "Payment Pending", reservation_state: "Applied", createdAt: new Date(), updatedAt: new Date() });
      const first = await req(admin, "DELETE", `/api/batches/${crashBatch}?${crashParam}`, { reason: `cycle 12 ${label} crash original reason` });
      const claim = await rawBatches.findOne({ _id: crashBatch });
      const retry = await req(admin, "DELETE", `/api/batches/${crashBatch}`, { reason: `different retry reason must not replace durable claim` });
      const auditCount = claim?.deletion_audit_event_id
        ? await rawAudits.countDocuments({ _id: new ObjectId(String(claim.deletion_audit_event_id)) }) : 0;
      ok(`batch deletion recovery [${label}]: crash leaves one durable original claim and retry completes it exactly once`,
        first.status === 500 && claim?.deletion_state === "Deleting" && retry.status === 200
          && !(await rawBatches.findOne({ _id: crashBatch })) && !(await rawCosts.findOne({ batch: crashBatch }))
          && auditCount === 1,
        JSON.stringify({ first: first.status, state: claim?.deletion_state, retry: retry.status, auditCount,
          batch: !!(await rawBatches.findOne({ _id: crashBatch })), cost: !!(await rawCosts.findOne({ batch: crashBatch })) }));
      const audit = claim?.deletion_audit_event_id ? await rawAudits.findOne({ _id: new ObjectId(String(claim.deletion_audit_event_id)) }) : null;
      ok(`batch deletion recovery [${label}]: retry preserves the original actor/reason audit input, not its new reason`,
        String(audit?.new_value ?? "").includes(`cycle 12 ${label} crash original reason`)
          && !String(audit?.new_value ?? "").includes("different retry reason"),
        String(audit?.new_value ?? ""));
    }
  } else {
    ok("batch materialization [precondition]: batch/category fixture exists", false,
      JSON.stringify({ template: !!template, category: cat?._id }));
  }
}

// Cycle 13: force-delete recovery is Batch-owned, and its seven durable fields must never become
// accidental Candidate attributes or leak from an ordinary Batch list while a crash claim is live.
{
  const source = readFileSync(new URL("../src/models/index.ts", import.meta.url), "utf8");
  const candidateSchema = source.slice(source.indexOf("const CandidateSchema"), source.indexOf("// ---------- Batch ----------"));
  const batchSchema = source.slice(source.indexOf("const BatchSchema"), source.indexOf("// ---------- BatchMember"));
  ok("batch deletion schema ownership: all seven durable recovery fields belong only to BatchSchema and are select:false",
    batchDeletionFields.every((field) => new RegExp(`${field}:\\s*\\{[^}]*select:\\s*false`).test(batchSchema))
      && batchDeletionFields.every((field) => !candidateSchema.includes(field)),
    JSON.stringify({ candidateHas: batchDeletionFields.filter((field) => candidateSchema.includes(field)), batchHas: batchDeletionFields.filter((field) => batchSchema.includes(field)) }));

  const template = await rawBatches.findOne({});
  const crashActor = await rawUsers.findOne({ email: "admin@vidysea.com" });
  if (template?.location && template?.program && crashActor?._id) {
    const crashBatch = new ObjectId();
    await rawBatches.insertOne({
      _id: crashBatch, code: `ZZ-C13-PRIVATE-${stamp}`, status: "Planning", location: template.location,
      program: template.program, target_size: 1, planned_start: new Date("2026-09-01"),
      createdAt: new Date(), updatedAt: new Date(), deletion_state: "Deleting", deletion_started_at: new Date(),
      deletion_actor: crashActor._id, deletion_reason: `c13 privacy ${stamp}`,
      deletion_recorded_work: "0 members, 0 finance rows", deletion_requires_finance: false,
      deletion_audit_event_id: new ObjectId().toHexString(),
    });
    const ordinaryList = (await req(admin, "GET", "/api/batches?limit=2000")).data?.items ?? [];
    const stranded = ordinaryList.find((batch) => String(batch._id) === String(crashBatch));
    ok("batch deletion list privacy: an ordinary GET keeps a crash-stranded Batch listable without its seven private recovery fields",
      !!stranded && batchDeletionFields.every((field) => !(field in stranded)),
      JSON.stringify({ found: !!stranded, leaked: batchDeletionFields.filter((field) => field in (stranded ?? {})) }));
    await rawBatches.deleteOne({ _id: crashBatch });
  } else {
    ok("batch deletion list privacy [precondition]: Batch and Admin fixture exist", false,
      JSON.stringify({ batch: !!template, admin: !!crashActor }));
  }
}

// ------------------------------------------------- item 6: pre-approved is a CONDITION
{
  const capName = `ZZ Capped ${stamp}`;
  const cap = await req(admin, "POST", "/api/master-lists/cost-categories", {
    name: capName, pre_approved: true, pre_approved_amount: 1000, pre_approved_basis: "Rs 50 per child, up to 1000",
  });
  ok("QA-1828b [precondition] a head with a machine-checkable pre-approved AMOUNT exists",
    cap.status === 201 || cap.status === 200, `got ${cap.status}`);
  const capId = cap.data?.item?._id;

  const ruleOn = await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: true, approver_role: "Admin" });
  ok("QA-1828b [precondition] the cost.post approval rule is ON, so 'skipped the queue' means something",
    ruleOn.status === 200, `got ${ruleOn.status}`);

  if (capId) {
    // WITHIN the cap: the commitment already covers it, so nobody is asked to re-derive arithmetic
    // somebody already agreed to. 201, not 202.
    const inside = await req(ops, "POST", "/api/costs", baseEntry({ category: capId, amount: 900 }));
    ok("QA-1828b: an entry WITHIN a pre-approved amount posts straight to the ledger",
      inside.status === 201, `got ${inside.status} ${JSON.stringify(inside.data).slice(0, 100)}`);
    const insideId = inside.data?.item?._id;
    const insideBack = ((await req(admin, "GET", "/api/costs")).data?.items ?? []).find((c) => String(c._id) === String(insideId));
    ok("QA-1828b: ...and it records THAT it was pre-approved, and on what basis",
      !!insideBack && insideBack.pre_approved_applied === true && String(insideBack.pre_approved_basis ?? "").length > 3,
      JSON.stringify(insideBack ? { a: insideBack.pre_approved_applied, b: insideBack.pre_approved_basis } : null));
    if (insideId) {
      const correctedFixed = await req(admin, "PATCH", `/api/costs/${insideId}`, { amount: 800, note: "fixed-cap correction remains editable" });
      const removedFixed = await req(admin, "DELETE", `/api/costs/${insideId}`);
      const fixedAfterDelete = ((await req(admin, "GET", "/api/costs")).data?.items ?? [])
        .find((c) => String(c._id) === String(insideId));
      ok("fixed pre-approval: a non-cumulative row remains correctable",
        correctedFixed.status === 200 && correctedFixed.data?.item?.amount === 800,
        `got ${correctedFixed.status}`);
      ok("fixed pre-approval: a non-cumulative row remains deletable",
        removedFixed.status === 200 && !fixedAfterDelete,
        `delete=${removedFixed.status} remains=${!!fixedAfterDelete}`);
    }

    const fixedAmbiguousNote = `fixed ambiguous ${stamp}`;
    const fixedAmbiguous = await req(ops, "POST", "/api/costs", baseEntry({
      category: capId, amount: 400, note: fixedAmbiguousNote, _test_ambiguous_after_create: true,
    }));
    const fixedAmbiguousRows = ((await req(admin, "GET", "/api/costs")).data?.items ?? [])
      .filter((c) => c.note === fixedAmbiguousNote);
    ok("fixed pre-approval ambiguity: an error after create is confirmed by deterministic id and full payload",
      fixedAmbiguous.status === 201 && fixedAmbiguousRows.length === 1
        && String(fixedAmbiguousRows[0]._id) === String(fixedAmbiguous.data?.item?._id),
      JSON.stringify({ status: fixedAmbiguous.status, rows: fixedAmbiguousRows.map((c) => c._id) }));

    // ABOVE the cap: this is the CEO's own counter-example - *"अब अगर उसके 29 रह गए… तो वो एक बार
    // अप्रूव होनी चाहिए।"* A flag-shaped implementation waves this through, which is precisely the
    // case he named as needing approval.
    const above = await req(ops, "POST", "/api/costs", baseEntry({ category: capId, amount: 5000 }));
    ok("QA-1828b: an entry ABOVE the pre-approved amount PARKS - the flag is a condition, not a pass",
      above.status === 202, `got ${above.status}`);
  }

  // A head marked pre-approved with only a free-text basis cannot be checked by a machine at all.
  // It must park WITH the basis quoted, so the approver ticks rather than rediscovers.
  const textName = `ZZ Basis ${stamp}`;
  const textCat = await req(admin, "POST", "/api/master-lists/cost-categories", {
    name: textName, pre_approved: true, pre_approved_basis: "per batch at 30+ pass-outs",
  });
  const textId = textCat.data?.item?._id;
  if (textId) {
    const parked = await req(ops, "POST", "/api/costs", baseEntry({ category: textId, amount: 700 }));
    ok("QA-1828b: a pre-approved head whose basis is a RULE the system cannot evaluate still parks",
      parked.status === 202, `got ${parked.status}`);
    const summary = String(parked.data?.item?.summary ?? "");
    ok("QA-1828b: ...and the basis travels in the summary, so the approver ticks instead of rediscovering it",
      /30\+ pass-outs/.test(summary), summary.slice(0, 120));
  }
}

// ---------------- structured per-pass commitment + partial sanction + outgoing payment
{
  const allBatches = (await req(admin, "GET", "/api/batches?limit=2000")).data?.items ?? [];
  let closedBatch = null;
  let billable = null;
  for (const b of allBatches.filter((x) => ["Completed", "Closed"].includes(x.status))) {
    const got = await req(admin, "GET", `/api/batches/${b._id}/closure`);
    const c = got.data?.item ?? got.data?.closure ?? got.data;
    const n = typeof c?.billable_passed === "number" ? c.billable_passed : c?.passed;
    if (typeof n === "number" && n > 0) { closedBatch = b; billable = n; break; }
  }
  ok("finance policy [precondition]: a batch has a recorded billable-pass result", !!closedBatch && billable > 0,
    JSON.stringify({ batch: closedBatch?.code, billable }));

  if (closedBatch && billable > 0) {
    const formula = await req(admin, "POST", "/api/master-lists/cost-categories", {
      name: `ZZ PerPass ${stamp}`, pre_approved: true,
      pre_approved_unit: "Per billable passed", pre_approved_amount: 50,
      pre_approved_min_billable: billable, pre_approved_basis: "Rs 50 per billable passed at the recorded threshold",
    });
    const formulaId = formula.data?.item?._id;
    ok("finance policy: structured per-pass commitment can be configured", formula.status === 201 && !!formulaId, `got ${formula.status}`);
    if (formulaId) {
      const within = await req(ops, "POST", "/api/costs", {
        entry_date: "2026-09-07", batch: closedBatch._id, category: formulaId,
        amount: 50 * billable, note: "structured formula pin",
      });
      ok("finance policy: Rs 50 x billable pass-outs is calculated and posts without re-approval",
        within.status === 201 && within.data?.item?.pre_approved_unit === "Per billable passed",
        `got ${within.status} unit=${within.data?.item?.pre_approved_unit} ${JSON.stringify(within.data).slice(0, 140)}`);
      const withinId = within.data?.item?._id;
      if (withinId) {
        const otherBatch = allBatches.find((b) => String(b._id) !== String(closedBatch._id));
        const otherCategory = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])
          .find((c) => String(c._id) !== String(formulaId));
        const amountEdit = await req(admin, "PATCH", `/api/costs/${withinId}`, { amount: (50 * billable) - 1 });
        const batchEdit = await req(admin, "PATCH", `/api/costs/${withinId}`, { batch: otherBatch?._id ?? "000000000000000000000001" });
        const categoryEdit = await req(admin, "PATCH", `/api/costs/${withinId}`, { category: otherCategory?._id ?? "000000000000000000000002" });
        const deleted = await req(admin, "DELETE", `/api/costs/${withinId}`);
        ok("formula reservation: an applied amount cannot be resized to release capacity",
          amountEdit.status === 409, `got ${amountEdit.status}`);
        ok("formula reservation: an applied row cannot move its capacity to another batch",
          batchEdit.status === 409, `got ${batchEdit.status}`);
        ok("formula reservation: an applied row cannot move its capacity to another category",
          categoryEdit.status === 409, `got ${categoryEdit.status}`);
        ok("formula reservation: an applied row cannot be deleted to disguise or re-spend its capacity",
          deleted.status === 409, `got ${deleted.status}`);
        const unchanged = ((await req(admin, "GET", `/api/costs?batch=${closedBatch._id}&category=${formulaId}`)).data?.items ?? [])
          .find((c) => String(c._id) === String(withinId));
        ok("formula reservation: refused mutations leave the reserved ledger row unchanged",
          !!unchanged && unchanged.amount === 50 * billable
            && String(unchanged.batch?._id ?? unchanged.batch) === String(closedBatch._id)
            && String(unchanged.category?._id ?? unchanged.category) === String(formulaId),
          JSON.stringify(unchanged ? { amount: unchanged.amount, batch: unchanged.batch?._id ?? unchanged.batch, category: unchanged.category?._id ?? unchanged.category } : null));
      }
      const exhausted = await req(ops, "POST", "/api/costs", {
        entry_date: "2026-09-07", batch: closedBatch._id, category: formulaId,
        amount: 1, note: "cumulative cap pin",
      });
      ok("finance policy: the per-batch commitment is cumulative, so a second entry above the remainder parks",
        exhausted.status === 202, `got ${exhausted.status}`);
    }

    const raceFormula = await req(admin, "POST", "/api/master-lists/cost-categories", {
      name: `ZZ PerPass Race ${stamp}`, pre_approved: true,
      pre_approved_unit: "Per billable passed", pre_approved_amount: 50,
      pre_approved_min_billable: billable, pre_approved_basis: "atomic cumulative cap pin",
    });
    const raceFormulaId = raceFormula.data?.item?._id;
    ok("formula race [precondition]: an unused per-pass commitment exists", raceFormula.status === 201 && !!raceFormulaId, `got ${raceFormula.status}`);
    if (raceFormulaId) {
      const totalCap = 50 * billable;
      const raced = await Promise.all(Array.from({ length: 8 }, (_, i) => req(ops, "POST", "/api/costs", {
        entry_date: "2026-09-07", batch: closedBatch._id, category: raceFormulaId,
        amount: totalCap, note: `atomic formula race ${i}`,
      })));
      const direct = raced.filter((r) => r.status === 201);
      const parked = raced.filter((r) => r.status === 202);
      ok("formula race: concurrent requests cannot spend the same remainder twice",
        direct.length === 1 && parked.length === 7,
        JSON.stringify(raced.map((r) => r.status)));
      const raceRows = ((await req(admin, "GET", `/api/costs?batch=${closedBatch._id}&category=${raceFormulaId}`)).data?.items ?? [])
        .filter((c) => String(c.category?._id ?? c.category) === String(raceFormulaId) && c.pre_approved_applied === true);
      ok("formula race: the durable pre-approved ledger never exceeds the calculated cap",
        raceRows.length === 1 && raceRows.reduce((n, c) => n + Number(c.amount || 0), 0) <= totalCap,
        JSON.stringify(raceRows.map((c) => c.amount)));
    }

    const recoveryFormula = await req(admin, "POST", "/api/master-lists/cost-categories", {
      name: `ZZ PerPass Recovery ${stamp}`, pre_approved: true,
      pre_approved_unit: "Per billable passed", pre_approved_amount: 50,
      pre_approved_min_billable: billable, pre_approved_basis: "crash and ambiguous-write recovery pin",
    });
    const recoveryId = recoveryFormula.data?.item?._id;
    ok("formula recovery [precondition]: a fresh per-pass commitment exists", recoveryFormula.status === 201 && !!recoveryId, `got ${recoveryFormula.status}`);
    if (recoveryId) {
      const totalCap = 50 * billable;
      const zombieNote = `expired zombie ${stamp}`;
      const winnerNote = `barrier winner ${stamp}`;
      const zombiePromise = req(ops, "POST", "/api/costs", {
        entry_date: "2026-09-07", batch: closedBatch._id, category: recoveryId,
        amount: totalCap, note: zombieNote,
        _test_formula_ttl_ms: 100, _test_formula_pause_after_reserve_ms: 350,
      });
      await new Promise((resolve) => setTimeout(resolve, 160));
      const recovered = await req(ops, "POST", "/api/costs", {
        entry_date: "2026-09-07", batch: closedBatch._id, category: recoveryId,
        amount: totalCap, note: winnerNote, _test_ambiguous_after_create: true,
      });
      const zombie = await zombiePromise;
      ok("formula fencing: an expired Pending owner is CAS-cancelled, and its resumed zombie cannot bypass the normal approval queue",
        recovered.status === 201 && zombie.status === 202 && zombie.data?.queued === true,
        JSON.stringify({ winner: recovered.status, winnerBody: recovered.data, zombie: zombie.status, zombieBody: zombie.data }));

      const rawReservationRows = await rawCosts.find({
        category: new ObjectId(String(recoveryId)), batch: new ObjectId(String(closedBatch._id)),
        note: { $in: [zombieNote, winnerNote] },
      }).toArray();
      ok("formula fencing: the durable states prove one Applied winner and one Cancelled zombie",
        rawReservationRows.length === 2
          && rawReservationRows.filter((r) => r.reservation_state === "Applied").length === 1
          && rawReservationRows.filter((r) => r.reservation_state === "Cancelled").length === 1,
        JSON.stringify(rawReservationRows.map((r) => ({ note: r.note, state: r.reservation_state }))));

      const recoveryRows = ((await req(admin, "GET", `/api/costs?batch=${closedBatch._id}&category=${recoveryId}`)).data?.items ?? [])
        .filter((c) => String(c.category?._id ?? c.category) === String(recoveryId) && c.pre_approved_applied === true);
      const retryAboveCap = await req(ops, "POST", "/api/costs", {
        entry_date: "2026-09-07", batch: closedBatch._id, category: recoveryId,
        amount: 1, note: "ambiguous insert must not duplicate or free capacity",
      });
      ok("formula recovery: ambiguous confirmation produces exactly one deterministic-id liability and does not free its spent cap",
        recoveryRows.length === 1 && Number(recoveryRows[0].amount) === totalCap && retryAboveCap.status === 202,
        JSON.stringify({ rows: recoveryRows.map((c) => ({ id: c._id, amount: c.amount })), retry: retryAboveCap.status }));

      const report = await req(admin, "GET", `/api/reports/costs?batch=${closedBatch._id}&category=${recoveryId}`);
      const reportText = JSON.stringify(report.data ?? {});
      const exported = await reqBuffer(admin, `/api/reports/costs/export?batch=${closedBatch._id}&category=${recoveryId}`);
      let exportText = "";
      if (exported.status === 200) {
        const wb = XLSX.read(exported.data, { type: "buffer" });
        exportText = JSON.stringify(Object.fromEntries(wb.SheetNames.map((n) => [n, XLSX.utils.sheet_to_json(wb.Sheets[n])])))
      }
      ok("hidden formula rows: Pending/Cancelled notes are absent from ledger GET, report aggregates/register and XLSX export",
        !JSON.stringify(recoveryRows).includes(zombieNote)
          && report.status === 200 && !reportText.includes(zombieNote)
          && exported.status === 200 && !exportText.includes(zombieNote),
        JSON.stringify({ report: report.status, export: exported.status, ledgerLeak: JSON.stringify(recoveryRows).includes(zombieNote), reportLeak: reportText.includes(zombieNote), exportLeak: exportText.includes(zombieNote) }));
    }

    const rollbackFormula = await req(admin, "POST", "/api/master-lists/cost-categories", {
      name: `ZZ PerPass Rollback ${stamp}`, pre_approved: true,
      pre_approved_unit: "Per billable passed", pre_approved_amount: 50,
      pre_approved_min_billable: billable, pre_approved_basis: "reservation rollback pin",
    });
    const rollbackId = rollbackFormula.data?.item?._id;
    if (rollbackId) {
      const totalCap = 50 * billable;
      const invalid = await req(ops, "POST", "/api/costs", {
        entry_date: "2026-09-07", batch: closedBatch._id, category: rollbackId,
        amount: totalCap, note: "reservation must roll back", payment_mode: "not-a-payment-mode",
      });
      const retry = await req(ops, "POST", "/api/costs", {
        entry_date: "2026-09-07", batch: closedBatch._id, category: rollbackId,
        amount: totalCap, note: "capacity survives failed create",
      });
      ok("formula reservation: a failed CostEntry create releases the reserved capacity",
        invalid.status === 400 && retry.status === 201,
        `invalid=${invalid.status} retry=${retry.status}`);
    } else ok("formula rollback [precondition]: a per-pass commitment exists", false, `got ${rollbackFormula.status}`);

    const threshold = await req(admin, "POST", "/api/master-lists/cost-categories", {
      name: `ZZ Threshold ${stamp}`, pre_approved: true,
      pre_approved_unit: "Per billable passed", pre_approved_amount: 50,
      pre_approved_min_billable: billable + 1, pre_approved_basis: "minimum pass-outs pin",
    });
    const below = threshold.data?.item?._id ? await req(ops, "POST", "/api/costs", {
      entry_date: "2026-09-07", batch: closedBatch._id, category: threshold.data.item._id,
      amount: 50, note: "threshold miss pin",
    }) : { status: 0 };
    ok("finance policy: below the configured pass-out threshold parks for a human decision",
      below.status === 202, `got ${below.status}`);
  }

  // QA-2427: an Admin with NO finance grant at all. The audit routes are open to any signed-in
  // reader by design (the trail answers "kaunsa admin, kya kiya"); what must not travel with it
  // is the money. Built here rather than reused from the policy block below, because that one is
  // created after this pin runs.
  const makeAuditReader = async (tag) => {
    const email = `zz.audit.${tag}@vidysea-test.local`;
    const made = await req(admin, "POST", "/api/users", {
      name: `Audit reader ${tag}`, email, password: PW, role: "Admin", can_edit: true, location_scope: [],
    });
    return { made, cookie: await login(email, PW) };
  };
  const adminUserId = ((await req(admin, "GET", "/api/users")).data?.items ?? [])
    .find((u) => String(u.email) === "admin@vidysea.com")?._id;

  const normal = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])
    .find((c) => !c.pre_approved);
  ok("partial approval [precondition]: a normal cost head exists", !!normal, "none");
  if (normal) {
    const parked = await req(ops, "POST", "/api/costs", baseEntry({
      category: normal._id, amount: 1000, vendor_payee: `Partial vendor ${stamp}`, payment_mode: "UPI",
      note: "partial sanction pin",
    }));
    const requestId = parked.data?.item?._id;
    ok("partial approval [precondition]: requested Rs 1,000 is parked", parked.status === 202 && !!requestId, `got ${parked.status}`);
    if (requestId) {
      const noReason = await req(admin, "POST", `/api/approvals/${requestId}`, { decision: "Approved", approved_amount: 800 });
      ok("partial approval: reducing an amount without a reason is refused", noReason.status === 400, `got ${noReason.status}`);
      const increase = await req(admin, "POST", `/api/approvals/${requestId}`, { decision: "Approved", approved_amount: 1200, note: "invalid" });
      ok("partial approval: an approver cannot sanction more than requested", increase.status === 400, `got ${increase.status}`);
      const approved = await req(admin, "POST", `/api/approvals/${requestId}`, { decision: "Approved", approved_amount: 800, note: "Rs 200 unsupported" });
      ok("partial approval: one peer can sanction a lower amount with a remark", approved.status === 200, `got ${approved.status}`);
      const cost = ((await req(admin, "GET", "/api/costs")).data?.items ?? [])
        .find((c) => String(c.approval_request) === String(requestId));
      ok("partial approval: ledger uses Rs 800 and preserves the original Rs 1,000 request",
        !!cost && cost.amount === 800 && cost.requested_amount === 1000 && cost.payment_status === "Payment Pending",
        JSON.stringify(cost ? { amount: cost.amount, requested: cost.requested_amount, status: cost.payment_status } : null));

      // QA-2427 (checker, cycle 14): the sanctioned figure was masked on the QUEUE and published
      // in the AUDIT TRAIL of the same decision. GET /api/audit/ApprovalRequest/<id> and
      // /api/audit/by-user/<id> returned `new_value.approved_amount` raw to a reader with no
      // finance.view - an ungranted Admin, and ops/spoc/viewer for an in-scope request - on the
      // release whose whole purpose is that only three people see money. Masking one surface and
      // leaving the trail of the same act open is this module's tenth money door and its oldest
      // shape: a new money FIELD added to a record that was already readable.
      {
        const blind = await makeAuditReader(`audit.${stamp}`);
        ok("QA-2427 [precondition] a reader WITHOUT finance.view exists and can read the audit trail",
          !!blind.cookie, `made=${blind.made.status}`);
        const hunt = (rows) => {
          const flat = JSON.stringify(rows ?? []);
          return {
            key: /"(approved_amount|requested_amount)"/.test(flat),
            figure: /\b(800|1,?000|1000)\b/.test(flat),
          };
        };
        if (blind.cookie) {
          const byEntity = await req(blind.cookie, "GET", `/api/audit/ApprovalRequest/${requestId}`);
          const byUser = await req(blind.cookie, "GET", `/api/audit/by-user/${adminUserId}`);
          const e = hunt(byEntity.data?.items), u = hunt(byUser.data?.items);
          ok("QA-2427 [precondition] that reader really reaches the audit trail of this decision",
            byEntity.status === 200 && (byEntity.data?.items ?? []).length > 0,
            `status=${byEntity.status} rows=${(byEntity.data?.items ?? []).length} - if it reads nothing the pin below proves nothing`);
          ok("QA-2427: the audit trail does not hand the SANCTIONED amount to a reader without finance.view",
            !e.key && !e.figure,
            `GET /api/audit/ApprovalRequest/${requestId} still carries ${e.key ? "an amount KEY" : ""}${e.key && e.figure ? " and " : ""}${e.figure ? "the figure itself" : ""}`);
          ok("QA-2427: nor does the by-user trail of the approver who sanctioned it",
            byUser.status !== 200 || (!u.key && !u.figure),
            `GET /api/audit/by-user/${adminUserId} status=${byUser.status} key=${u.key} figure=${u.figure}`);
        }

        // QA-2442 (checker, cycle 15) - the MIRROR of QA-2427, one cycle later, on the surface this
        // release changed. The queue handed a reader with approvals.decide and no finance.view the
        // figures people TYPED into notes - `Cost entry ₹— ... cash advance 445599 paid to vendor` -
        // the masked figure sitting in the same sentence as the raw one, while the AUDIT TRAIL of
        // that same record masked both.
        //
        // THREE ARMS, NOT ONE, and that is the whole point. A mask repaired and a mask over-applied
        // show the blind reader exactly the same thing: no figures. One assertion cannot tell them
        // apart, so `redact everything for everyone` would pass a leak test forever. This asserts the
        // leak is gone, that the SENTENCE survives, and that the grant-holder still sees the number.
        // The third arm is what makes the first one mean anything.
        {
          const blindQ = await makeAuditReader(`queue.${stamp}`);
          const typed = `cash advance 445599 paid to vendor INV-2026-0456 on 07-09-2026 by Prashant Kumar`;
          const parked2 = await req(admin, "POST", "/api/costs", baseEntry({ category: normal._id, amount: 500, note: typed }));
          const rid2 = parked2.data?.item?._id;
          ok("QA-2442 [precondition] a second cost parks with a figure TYPED into its note",
            parked2.status === 202 && !!rid2 && !!blindQ.cookie,
            `parked=${parked2.status} reader=${!!blindQ.cookie} - without both, every arm below is vacuous`);
          if (rid2 && blindQ.cookie) {
            await req(admin, "POST", `/api/approvals/${rid2}`, { decision: "Rejected", note: `only 33221 is supported` });
            const row = ((await req(blindQ.cookie, "GET", "/api/approvals?status=all")).data?.items ?? [])
              .find((r) => String(r._id) === String(rid2));
            const flat = JSON.stringify(row ?? {});
            const has = (re) => re.test(flat);
            ok("QA-2442 [precondition] the blind reader actually reaches that row", !!row,
              `no row for ${rid2} - the arms below would all pass on an empty object`);

            ok("QA-2442: a reader without finance.view gets none of the figures the queue was asked to hide",
              !!row && !has(/445599/) && !has(/33221/) && !has(/\b500\b/),
              `still present -> typed:${has(/445599/)} decision:${has(/33221/)} amount:${has(/\b500\b/)}`);

            // The OPPOSITE failure. `redact everything` also passes the arm above, and it destroys the
            // sentence - QA-1851 measured an approver's mail turned into `chairs delivered on the —th,
            // —% advance`. A date and a person's name are not money and must survive. The VOUCHER
            // deliberately does not: `invoice_no` is money-class by this module's own
            // INVOICE_MONEY_FIELDS rule, so it is asserted as REDACTED rather than quietly ignored.
            ok("QA-2442: ...and the sentence survives - a date and a person's name are not money",
              !!row && has(/07-09-2026/) && has(/Prashant Kumar/),
              `over-redacted -> date:${has(/07-09-2026/)} name:${has(/Prashant Kumar/)} | ${String(row?.summary ?? "").slice(0, 120)}`);
            ok("QA-2442: ...while the voucher IS hidden, because invoice_no is money by this module's own rule",
              !!row && !has(/INV-2026-0456/),
              `the voucher survived for a reader without finance.view: ${String(row?.summary ?? "").slice(0, 120)}`);

            const richRow = ((await req(admin, "GET", "/api/approvals?status=all")).data?.items ?? [])
              .find((r) => String(r._id) === String(rid2));
            ok("QA-2442: ...and the grant-holder still sees the figure, so this is a MASK and not a deletion",
              !!richRow && /445599/.test(JSON.stringify(richRow)),
              `a reader WITH finance.view lost it too - that is over-redaction wearing a fix's clothes`);

            // QA-2447 (checker, qa-2411 cycle 16; then reproduced ON PRODUCTION on -302) - THE
            // THIRD AND FOURTH HOUSE OF THIS ONE STRING. The queue was taught to mask a typed
            // figure and the BELL beside it was not: `src/lib/approvals.ts` built its notification
            // and its mail subject with the PAYLOAD-DRIVEN redactor alone, which can only hunt
            // figures the payload NAMES. A number a person types into a note is not a payload
            // value, so an Admin with no finance.view read this in their alert inbox on the live
            // system: `Cost entry Rs-- ... cash advance 445599 paid to vendor on 07-09-2026` - the
            // masked figure and the raw one in one sentence. QA-1850's recorded lesson, verbatim:
            // three consumers of a string fixed and the fourth missed.
            //
            // ASSERTED ON THE STORED STRING, not on one reader's copy, and that is deliberate. A
            // Notification row HAS NO READER - it is written once and read by whoever holds the
            // approver role - so the guarantee the product makes is about what was WRITTEN. Pinning
            // one reader's view would leave the guarantee untested the day the targeting changes.
            {
              const notifs = ((await req(admin, "GET", "/api/notifications?status=all")).data?.items ?? [])
                .filter((n) => String(n.entity_id) === String(rid2));
              const mailRows = ((await req(admin, "GET", "/api/test-email")).data?.log ?? [])
                .filter((m) => String(m.entity_id) === String(rid2));
              ok("QA-2447 [precondition] the bell and the mail both wrote a row for this request",
                notifs.length > 0 && mailRows.length > 0,
                `notifications=${notifs.length} mail=${mailRows.length} - with either at zero the arms below assert nothing`);

              // THE DETECTOR IS THE OTHER HALF OF THIS FINDING (QA-2449). The live probe that first
              // looked here asserted on a rupee sign followed by digits, found none because the
              // product had correctly masked THAT figure, and printed PASS while `445599` sat in the
              // payload it had just written to disk. A leak detector keyed to a currency symbol is
              // blind exactly where that symbol has been stripped. `bareFigures` hunts digit runs.
              const notifFigures = notifs.flatMap((n) => bareFigures(String(n.message ?? "")));
              const mailFigures = mailRows.flatMap((m) => bareFigures(String(m.subject ?? "")));
              ok("QA-2447: the approval notification carries no figure a person typed",
                notifFigures.length === 0,
                `leaked ${JSON.stringify(notifFigures)} in: ${notifs.map((n) => String(n.message ?? "")).join(" | ").slice(0, 200)}`);
              ok("QA-2447: ...and neither does the mail SUBJECT, which survives on a lock screen",
                mailFigures.length === 0,
                `leaked ${JSON.stringify(mailFigures)} in: ${mailRows.map((m) => String(m.subject ?? "")).join(" | ").slice(0, 200)}`);

              // The two arms that stop `redact it all` and `write nothing at all` from passing the
              // two above. Both of those show a reader zero figures, exactly like a correct fix.
              const notifText = notifs.map((n) => String(n.message ?? "")).join(" ");
              ok("QA-2447: ...and the sentence survives - the date and the person's name are not money",
                /07-09-2026/.test(notifText) && /Prashant Kumar/.test(notifText),
                `over-redacted -> date:${/07-09-2026/.test(notifText)} name:${/Prashant Kumar/.test(notifText)} | ${notifText.slice(0, 200)}`);
              ok("QA-2447: ...and the alert still says what is waiting, so this is a MASK and not a deleted bell",
                /Approval needed/.test(notifText) && notifText.length > 40,
                `the bell went quiet instead of going blind: ${JSON.stringify(notifText.slice(0, 120))}`);
            }
          }
        }

        // QA-2450 (live checker, measured on production -302), AND THE SECOND PLACE THIS PIN HAS
        // LIVED. The first version sat beside the QA-1828b payment-mode pin near the top of this
        // file, and a senior review proved it could not fail: `cost.post` is switched OFF at
        // line 167 for the direct-write assertions, so `requireApproval` returns null, the POST
        // takes the straight-to-ledger branch, and Mongoose's own schema enum throws a 400 with
        // the new door guard DELETED. It was the exact defect it was written to prevent - and
        // this file already carries that lesson two hundred lines away, at the QA-2010 comment.
        //
        // Here the rule is ON - the request above parked with 202 - so this is the real
        // production shape: a submitter whose cost PARKS. Asserted on the GUARANTEE and not on
        // the status code: the refusal must leave NOTHING behind, because the defect was never
        // the 400, it was the Pending request nobody could ever say yes to.
        const qa2450 = `qa2450-${stamp}`;
        const badModeParked = await req(ops, "POST", "/api/costs", baseEntry({
          category: normal._id, payment_mode: "Bank Transfer", note: qa2450,
        }));
        ok("QA-2450: with the approval rule ON, the parking door refuses an unlisted payment mode",
          badModeParked.status === 400,
          `got ${badModeParked.status} - 202 means it parked a request that can only ever be rejected`);
        const ledger2450 = ((await req(admin, "GET", "/api/costs")).data?.items ?? [])
          .filter((c) => String(c.note ?? "").includes(qa2450));
        const queued2450 = ((await req(admin, "GET", "/api/approvals?status=all")).data?.items ?? [])
          .filter((a) => JSON.stringify(a).includes(qa2450));
        ok("QA-2450: ...and it left nothing behind - no ledger row, and no Pending request to strand an approver",
          ledger2450.length === 0 && queued2450.length === 0,
          JSON.stringify({ ledger: ledger2450.length, parked: queued2450.length }));
      }      if (cost) {
        const missingRef = await req(admin, "PATCH", `/api/costs/${cost._id}`, { mark_paid: true, payment_mode: "UPI", vendor_payee: `Partial vendor ${stamp}` });
        ok("outgoing payment: Payment Done cannot be recorded without a reference", missingRef.status === 400, `got ${missingRef.status}`);
        const paid = await req(admin, "PATCH", `/api/costs/${cost._id}`, {
          mark_paid: true, paid_on: "2026-09-08", payment_ref: `UTR-${stamp}`,
          payment_mode: "UPI", vendor_payee: `Partial vendor ${stamp}`,
        });
        ok("outgoing payment: Accounts records Payment Done with date, reference and payee", paid.status === 200, `got ${paid.status}`);
        const paidBack = ((await req(admin, "GET", "/api/costs")).data?.items ?? []).find((c) => String(c._id) === String(cost._id));
        ok("outgoing payment: paid state and reference read back from the ledger",
          paidBack?.payment_status === "Paid" && paidBack?.payment_ref === `UTR-${stamp}` && String(paidBack?.paid_on ?? "").startsWith("2026-09-08"),
          JSON.stringify(paidBack ? { status: paidBack.payment_status, ref: paidBack.payment_ref, on: paidBack.paid_on } : null));

        const XLSX = await import("xlsx");
        const exported = await fetch(BASE + "/api/reports/costs/export", { headers: { cookie: admin } });
        ok("finance export parity [precondition]: the cost workbook downloads", exported.status === 200, `got ${exported.status}`);
        if (exported.status === 200) {
          const wb = XLSX.read(new Uint8Array(await exported.arrayBuffer()), { type: "array" });
          const rows = XLSX.utils.sheet_to_json(wb.Sheets["cost entry register"] ?? {}, { defval: null });
          const row = rows.find((r) => String(r["Payment reference"] ?? "") === `UTR-${stamp}`);
          ok("finance export parity: requested amount, payment status/date/reference reach the workbook together",
            !!row && Number(row["Requested amount"]) === 1000 && row["Payment status"] === "Paid"
              && String(row["Paid on"] ?? "").startsWith("2026-09-08") && row["Payment reference"] === `UTR-${stamp}`,
            JSON.stringify(row ?? null));
        }
      }
    }
  }
}

// A pre-approval policy can bypass a human decision, so finance.view is insufficient to author
// one. Exercise the same PATCH as an ungranted Admin, a view-only Admin, and an approver.
{
  const policyHead = await req(admin, "POST", "/api/master-lists/cost-categories", {
    name: `ZZ Policy Auth ${stamp}`, description: "policy authorization pin",
  });
  const policyId = policyHead.data?.item?._id;
  ok("pre-approval policy auth [precondition]: a neutral cost head exists", policyHead.status === 201 && !!policyId, `got ${policyHead.status}`);

  const makeAdmin = async (tag, grants) => {
    const email = `zz.policy.${tag}.${stamp}@vidysea-test.local`;
    const made = await req(admin, "POST", "/api/users", {
      name: `Policy ${tag} ${stamp}`, email, password: PW, role: "Admin", can_edit: true, location_scope: [],
    });
    if (made.data?.item?._id && grants.length) {
      await req(admin, "PATCH", `/api/users/${made.data.item._id}`, { extra_permissions: grants });
    }
    return { made, cookie: await login(email, PW) };
  };
  const ungranted = await makeAdmin("none", []);
  const viewOnly = await makeAdmin("view", ["finance.view"]);
  ok("pre-approval policy auth [precondition]: ungranted and finance.view-only Admins sign in",
    ungranted.made.status === 201 && !!ungranted.cookie && viewOnly.made.status === 201 && !!viewOnly.cookie);

  if (policyId && ungranted.cookie && viewOnly.cookie) {
    const fields = [
      ["pre_approved", true],
      ["pre_approved_amount", 50],
      ["pre_approved_unit", "Per billable passed"],
      ["pre_approved_min_billable", 30],
      ["pre_approved_basis", "Rs 50 per billable passed"],
    ];
    for (const [cookie, label] of [[ungranted.cookie, "ungranted Admin"], [viewOnly.cookie, "finance.view-only Admin"]]) {
      const attempts = await Promise.all(fields.map(([field, value]) =>
        req(cookie, "PATCH", `/api/master-lists/cost-categories/${policyId}`, { [field]: value })));
      ok(`pre-approval policy auth: ${label} cannot change any bypass-policy field`,
        attempts.every((r) => r.status === 403),
        JSON.stringify(attempts.map((r) => r.status)));
    }
    const allowed = await req(admin, "PATCH", `/api/master-lists/cost-categories/${policyId}`, {
      pre_approved: true, pre_approved_amount: 50, pre_approved_unit: "Per billable passed",
      pre_approved_min_billable: 30, pre_approved_basis: "Rs 50 per billable passed",
    });
    ok("pre-approval policy auth: finance.approve can author the full structured policy",
      allowed.status === 200 && allowed.data?.item?.pre_approved === true
        && allowed.data?.item?.pre_approved_amount === 50
        && allowed.data?.item?.pre_approved_unit === "Per billable passed"
        && allowed.data?.item?.pre_approved_min_billable === 30,
      `got ${allowed.status} ${JSON.stringify(allowed.data ?? {}).slice(0, 220)}`);
  }
}

// ------------------------------------------------ item 7: a missing head is a queue
{
  const proposed = proposedHeadForMine;
  const catsBefore = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? []).length;
  const costsBefore = ((await req(admin, "GET", "/api/costs")).data?.items ?? []).length;

  // The route REFUSES rather than inventing an approver, so the rule for THIS action has to be on.
  // The pin failed with 409 "there is no approver set up for new cost heads yet" on its first run,
  // which is the route behaving exactly as designed and the fixture not having read its own design.
  const catRule = await req(admin, "PUT", "/api/approvals", { action: "costcategory.create", enabled: true, approver_role: "Admin" });
  ok("QA-1828c [precondition] an approver is configured for new cost heads", catRule.status === 200, `got ${catRule.status}`);

  const q = await req(ops, "POST", "/api/costs", { ...baseEntry(), new_subhead: proposed });
  ok("QA-1828c: naming a head that does not exist parks the entry instead of refusing it",
    q.status === 202, `got ${q.status} ${JSON.stringify(q.data).slice(0, 120)}`);
  const ownUnknownHead = ((await req(ops, "GET", "/api/approvals?mine=1")).data?.items ?? [])
    .find((r) => String(r._id) === String(q.data?.item?._id));
  ok("My submissions: an unknown-head proposal is returned beside ordinary cost.post requests",
    ownUnknownHead?.action === "costcategory.create" && String(ownUnknownHead.summary ?? "").includes(proposed),
    JSON.stringify(ownUnknownHead ? { action: ownUnknownHead.action, summary: ownUnknownHead.summary } : null));

  // NOTHING may have been written yet - not the head, not the entry. "The whole entry parks" is
  // the claim (Umesh, D8), and a queue that half-writes is worse than no queue.
  const catsMid = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? []).length;
  const costsMid = ((await req(admin, "GET", "/api/costs")).data?.items ?? []).length;
  ok("QA-1828c: ...and NOTHING is written yet - no head, no ledger row",
    catsMid === catsBefore && costsMid === costsBefore,
    `cats ${catsBefore}->${catsMid}, costs ${costsBefore}->${costsMid}`);

  const reqId = q.data?.item?._id;
  if (reqId) {
    const decided = await req(admin, "POST", `/api/approvals/${reqId}`, { decision: "Approved", note: "pin" });
    ok("QA-1828c: approving it does BOTH writes in one decision", decided.status === 200, `got ${decided.status}`);
    const catsAfter = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? []);
    const costsAfter = ((await req(admin, "GET", "/api/costs")).data?.items ?? []);
    ok("QA-1828c: ...the head now exists", catsAfter.some((c) => c.name === proposed), `${catsAfter.length} heads`);
    ok("QA-1828c: ...and the cost entry is in the ledger, filed under it",
      costsAfter.some((c) => c.category?.name === proposed || String(c.category?._id) === String(catsAfter.find((x) => x.name === proposed)?._id)),
      `${costsAfter.length} entries`);
  }

  // The CEO's OTHER option - *"एप्रोप्रियेट हेड सब हेड में डाल पाएं"*. Approving with a mapping
  // must file the cost under the existing head and create NOTHING.
  const mapTarget = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])[0];
  const q2 = await req(ops, "POST", "/api/costs", { ...baseEntry({ amount: 321 }), new_subhead: `ZZ Never ${stamp}` });
  const catsBeforeMap = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? []).length;
  if (q2.data?.item?._id && mapTarget) {
    const mapped = await req(admin, "POST", `/api/approvals/${q2.data.item._id}`, { decision: "Approved", note: "file it here", map_to_category: mapTarget._id });
    ok("QA-1828c: approving WITH a mapping is accepted", mapped.status === 200, `got ${mapped.status}`);
    const catsAfterMap = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? []);
    ok("QA-1828c: ...and it creates NO new head - the proposed name never appears",
      catsAfterMap.length === catsBeforeMap && !catsAfterMap.some((c) => c.name === `ZZ Never ${stamp}`),
      `${catsBeforeMap} -> ${catsAfterMap.length}`);
    const filed = ((await req(admin, "GET", "/api/costs")).data?.items ?? []).find((c) => c.amount === 321);
    ok("QA-1828c: ...and the cost is filed under the head the approver chose",
      !!filed && String(filed.category?._id ?? filed.category) === String(mapTarget._id),
      JSON.stringify(filed ? { cat: filed.category?.name } : null));
  }

  // Umesh, 2026-09-07: an Admin already creates heads (Rule 40) and IS the evaluator, so routing
  // them through a queue would mean waiting for another Admin - this system refuses self-approval.
  const inlineName = `ZZ Inline ${stamp}`;
  const reqsBefore = ((await req(admin, "GET", "/api/approvals?status=all")).data?.items ?? [])
    .filter((r) => r.action === "costcategory.create").length;
  const inline = await req(admin, "POST", "/api/costs", { ...baseEntry({ amount: 654 }), new_subhead: inlineName });

  // THIS PIN WAS WRONG ON ITS FIRST RUN and the code was right. It expected 201, and got 202 -
  // because `cost.post` is enabled in this suite and QA-1826 DELETED the Admin short-circuit that
  // used to let a configured approver skip their own queue. So an Admin's COST parks like anybody
  // else's, which is the two-point check working: *"जो रेज करेगा वो खुद ही अप्रूव नहीं करेगा"*.
  //
  // What is Admin-specific is the HEAD, not the cost. So that is what this asserts now: the head
  // exists immediately and no costcategory.create request was raised. Asserting the status code was
  // asserting the wrong thing about the right behaviour.
  ok("QA-1828c: an Admin's cost still goes through the cost.post queue like everyone else's",
    inline.status === 201 || inline.status === 202, `got ${inline.status}`);
  const inlineCats = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? []);
  ok("QA-1828c: ...but the HEAD they named exists straight away, with no approval in between",
    inlineCats.some((c) => c.name === inlineName), `${inlineCats.length} heads`);
  const reqsAfter = ((await req(admin, "GET", "/api/approvals?status=all")).data?.items ?? [])
    .filter((r) => r.action === "costcategory.create").length;
  ok("QA-1828c: ...and no new-head request was raised for them - they are the evaluator",
    reqsAfter === reqsBefore, `${reqsBefore} -> ${reqsAfter}`);
}

// ------------------------------------- the asymmetry this unit was most exposed to
// A CostEntry is built in two places - the direct write and the approval replay - and the inbound
// payload was never filtered, so a new field reaches the queue for free and is dropped on the way
// out unless it is named. That would make an entry's CONTENTS depend on whether the cost.post rule
// happened to be enabled, which is invisible to every other assertion here.
{
  const cat = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? []).find((c) => !c.pre_approved);
  const payload = baseEntry({ category: cat?._id, amount: 111, vendor_payee: `Both ${stamp}`, voucher_no: `B-${stamp}`, payment_mode: "Cheque" });
  const parked = await req(ops, "POST", "/api/costs", payload);
  ok("QA-1828b [precondition] with the rule ON, an ordinary entry parks", parked.status === 202, `got ${parked.status}`);
  if (parked.data?.item?._id) {
    const decided = await req(admin, "POST", `/api/approvals/${parked.data.item._id}`, { decision: "Approved", note: "pin" });
    // The first run reported only "not found", which describes the SEARCH and not the world - the
    // approval could have been refused and the pin would have said the same thing. Assert the
    // decision landed, then look for what it should have written.
    ok("QA-1828b [precondition] the parked entry is approved, so there is a replay to inspect",
      decided.status === 200, `got ${decided.status} ${JSON.stringify(decided.data?.error ?? "").slice(0, 90)}`);
    const ledger = (await req(admin, "GET", "/api/costs")).data?.items ?? [];
    const viaQueue = ledger.find((c) => String(c.voucher_no ?? "") === `B-${stamp}`);
    ok("QA-1828b: an entry written by the APPROVAL REPLAY carries the same fields as a direct write",
      !!viaQueue && viaQueue.vendor_payee === `Both ${stamp}` && viaQueue.payment_mode === "Cheque",
      viaQueue ? JSON.stringify({ v: viaQueue.vendor_payee, m: viaQueue.payment_mode })
        : `no ledger row carries voucher B-${stamp}; ${ledger.length} rows, amounts ${ledger.slice(0, 5).map((c) => c.amount).join(",")}`);
  }
}

// Two authorized approvers can click together. The Pending compare-and-swap must make exactly
// one the winner, and the unique approval_request link must leave exactly one ledger effect.
{
  const email = `zz.approver.race.${stamp}@vidysea-test.local`;
  const made = await req(admin, "POST", "/api/users", {
    name: `Approval Race ${stamp}`, email, password: PW, role: "Admin", can_edit: true, location_scope: [],
  });
  if (made.data?.item?._id) {
    await req(admin, "PATCH", `/api/users/${made.data.item._id}`, { extra_permissions: ["finance.view", "finance.approve"] });
  }
  const peer = await login(email, PW);
  const normal = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])
    .find((c) => !c.pre_approved && c.active !== false);
  const parked = normal ? await req(ops, "POST", "/api/costs", baseEntry({
    category: normal._id, amount: 654, note: `approval race ${stamp}`,
  })) : { status: 0, data: {} };
  const requestId = parked.data?.item?._id;
  ok("approval race [precondition]: a second authorized approver and one pending cost exist",
    made.status === 201 && !!peer && parked.status === 202 && !!requestId,
    `made=${made.status} peer=${!!peer} parked=${parked.status}`);
  if (peer && requestId) {
    const decisions = await Promise.all([admin, peer].map((cookie, i) =>
      req(cookie, "POST", `/api/approvals/${requestId}`, { decision: "Approved", note: `race click ${i}` })));
    const statuses = decisions.map((r) => r.status).sort((a, b) => a - b);
    ok("approval race: exactly one approver wins and the loser receives 409",
      statuses.length === 2 && statuses[0] === 200 && statuses[1] === 409,
      JSON.stringify(statuses));
    const rows = ((await req(admin, "GET", "/api/costs")).data?.items ?? [])
      .filter((c) => String(c.approval_request) === String(requestId));
    ok("approval race: exactly one CostEntry exists for the approval request",
      rows.length === 1, JSON.stringify(rows.map((c) => c._id)));

    // Deletion has a separate race: the logical tombstone claim fixes both actor and snapshot.
    // Exactly one caller may own it; the other cannot republish a different actor even if both
    // loaded the visible row before either request reached the compare-and-swap.
    const ruleOff = await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: false, approver_role: "Admin" });
    const deleteRace = normal ? await req(admin, "POST", "/api/costs", baseEntry({
      category: normal._id, amount: 655, note: `delete race ${stamp}`,
    })) : { status: 0, data: {} };
    await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: true, approver_role: "Admin" });
    const deleteCostId = deleteRace.data?.item?._id;
    if (ruleOff.status === 200 && deleteRace.status === 201 && deleteCostId) {
      const deleters = [
        { cookie: admin, actor: String((await rawUsers.findOne({ email: "admin@vidysea.com" }))?._id) },
        { cookie: peer, actor: String(made.data.item._id) },
      ];
      const deletions = await Promise.all(deleters.map((entry) => req(entry.cookie, "DELETE", `/api/costs/${deleteCostId}`)));
      const winner = deletions.findIndex((result) => result.status === 200);
      const loser = winner === 0 ? 1 : 0;
      const deletionAudits = await rawAudits.find({
        entity: "CostEntry", entity_id: new ObjectId(String(deleteCostId)), field: "deleted",
      }).toArray();
      ok("deletion race: exactly one authorized caller commits and the other cannot replace its claim",
        winner >= 0 && [404, 409].includes(deletions[loser]?.status) && deletionAudits.length === 1,
        JSON.stringify({ statuses: deletions.map((r) => r.status), audits: deletionAudits.length }));
      ok("deletion race: the durable audit actor is the caller whose logical deletion won",
        winner >= 0 && String(deletionAudits[0]?.actor) === deleters[winner].actor
          && !(await rawCosts.findOne({ _id: new ObjectId(String(deleteCostId)) })),
        JSON.stringify({ winner, expectedActor: winner >= 0 ? deleters[winner].actor : null, actualActor: deletionAudits[0]?.actor, remains: !!(await rawCosts.findOne({ _id: new ObjectId(String(deleteCostId)) })) }));
    } else {
      ok("deletion race [precondition]: a direct cost exists for two authorized deleters", false,
        JSON.stringify({ ruleOff: ruleOff.status, made: deleteRace.status, costId: deleteCostId }));
    }
  }
}

// ==========================================================================================
// QA-2010 (checker, cycle 2, S2) — THE THREE FIXES THAT NOTHING PROTECTED.
//
// Cycle 1 filed six findings and all six were fixed. The checker then reverted three of the
// fixes one at a time, rebuilt, and this suite stayed **30/0 every time** while its own probe
// reproduced each original defect verbatim. A fix nothing can see is a fix that survives until
// the next person tidies it away.
//
// Worse, and this is the part worth remembering: the cycle-2 manifest claimed the pin
// "NOTHING is written yet - no head, no ledger row" proved the QA-1975 guarantee had survived
// the QA-2013 repair. It does not. That pin tests the PARK path, and it passes identically with
// the pre-validation entirely disabled. The sentence a PASS would have rested on could not see
// the thing it was offered as evidence for.
//
// The three assertions below are the checker's own (Q1c/Q1d/Q1e, Q3a/Q3b, Q4a/Q4b/Q4c), brought
// into the wall so the mutants that killed the probe now kill the suite.
{
  const catList = async () => ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? []);

  // ---- QA-1975: a replay that cannot produce a valid entry must write NEITHER half, and must
  // leave the request decidable. Cycle 1 measured head-created + no-ledger-row + permanently
  // Approved: a cost head invented, no money recorded, and no way to decide it again.
  {
    const nm = `ZZ Half ${stamp}`;
    const before = (await catList()).length;
    const parked = await req(ops, "POST", "/api/costs", baseEntry({ amount: 777, new_subhead: nm, payment_mode: "by hand" }));
    if (parked.data?.item?._id) {
      await req(admin, "POST", `/api/approvals/${parked.data.item._id}`, { decision: "Approved", note: "pin" });
      const headMade = (await catList()).some((c) => c.name === nm);
      const ledger = (await req(admin, "GET", "/api/costs?limit=200")).data?.items ?? [];
      const entryMade = ledger.some((c) => c.amount === 777 && String(c.note ?? "").startsWith("pin:"));
      const reqNow = ((await req(admin, "GET", "/api/approvals?status=all")).data?.items ?? [])
        .find((r) => String(r._id) === String(parked.data.item._id));
      ok("QA-1975: a refused replay is NOT a half-write - head and ledger row are both present or both absent",
        headMade === entryMade, `headCreated=${headMade} entryCreated=${entryMade}`);
      ok("QA-1975: ...and the request is left PENDING, still decidable, not Approved-but-unapplied",
        reqNow?.status === "Pending", `status=${reqNow?.status}`);
      ok("QA-1975: ...and the head count is unchanged by the refusal",
        (await catList()).length === before, `${before} -> ${(await catList()).length}`);
    } else {
      ok("QA-1975: the invalid-payload entry parked so there is a replay to refuse", false,
        `nothing parked (status ${parked.status}) - this pin measured nothing`);
    }
  }

  // A failure AFTER a new head exists exercises the compensation path rather than the earlier
  // payload-validation guard. The head must disappear BEFORE the request is reopened.
  {
    const nm = `ZZ Compensate ${stamp}`;
    const before = (await catList()).length;
    const parked = await req(ops, "POST", "/api/costs", baseEntry({
      amount: 778, new_subhead: nm, payment_mode: "Cash", _test_fail_after_head: true,
    }));
    if (parked.data?.item?._id) {
      const applied = await req(admin, "POST", `/api/approvals/${parked.data.item._id}`, { decision: "Approved", note: "fault pin" });
      const requestNow = ((await req(admin, "GET", "/api/approvals?status=all")).data?.items ?? [])
        .find((r) => String(r._id) === String(parked.data.item._id));
      const headsNow = await catList();
      const ledgerNow = (await req(admin, "GET", "/api/costs?limit=200")).data?.items ?? [];
      const rawHeadNow = await rawCategories.findOne({ name: nm });
      const rawCostNow = await rawCosts.findOne({ approval_request: new ObjectId(String(parked.data.item._id)) });
      ok("new-head compensation [precondition]: the injected post-head failure reached the replay catch",
        applied.status === 500, `got ${applied.status}`);
      ok("new-head compensation: the newly created still-unreferenced head is removed before replay can reopen",
        !rawHeadNow && !rawCostNow && !headsNow.some((c) => c.name === nm) && !ledgerNow.some((c) => Number(c.amount) === 778),
        JSON.stringify({ rawHead: !!rawHeadNow, rawCost: rawCostNow && rawCostNow.reservation_state, visibleHead: headsNow.some((c) => c.name === nm), visibleEntry: ledgerNow.some((c) => Number(c.amount) === 778) }));
      ok("new-head compensation: only after compensation is proven does the request return to Pending",
        requestNow?.status === "Pending" && headsNow.length === before,
        JSON.stringify({ status: requestNow?.status, heads: `${before}->${headsNow.length}` }));
    } else {
      ok("new-head compensation [precondition]: a valid request parked for the fault simulation", false,
        `nothing parked (status ${parked.status})`);
    }
  }

  {
    const nm = `ZZ Cost Compensate ${stamp}`;
    const note = `staged cost compensate ${stamp}`;
    const parked = await req(ops, "POST", "/api/costs", baseEntry({
      amount: 778.5, note, new_subhead: nm, payment_mode: "Cash", _test_fail_after_cost_before_publish: true,
    }));
    if (parked.data?.item?._id) {
      const requestId = parked.data.item._id;
      const applied = await req(admin, "POST", `/api/approvals/${requestId}`, { decision: "Approved", note: "cost compensation pin" });
      const rawHead = await rawCategories.findOne({ _id: new ObjectId(String(requestId)) });
      const rawCost = await rawCosts.findOne({ _id: new ObjectId(String(requestId)) });
      const requestNow = ((await req(admin, "GET", "/api/approvals?status=all")).data?.items ?? [])
        .find((r) => String(r._id) === String(requestId));
      const ledgerText = JSON.stringify((await req(admin, "GET", "/api/costs")).data ?? {});
      const reportText = JSON.stringify((await req(admin, "GET", "/api/reports/costs")).data ?? {});
      ok("staged cost compensation: failure before publish removes only its proven-cancelled deterministic cost and its own inactive head",
        applied.status === 500 && !rawHead && !rawCost,
        JSON.stringify({ status: applied.status, head: rawHead && { active: rawHead.active, owner: rawHead.staged_by_approval }, cost: rawCost && { state: rawCost.reservation_state, approval: rawCost.approval_request } }));
      ok("staged cost compensation: no internal cost leaks into ledger/report and only then request reopens",
        !ledgerText.includes(note) && !reportText.includes(note) && requestNow?.status === "Pending",
        JSON.stringify({ ledgerLeak: ledgerText.includes(note), reportLeak: reportText.includes(note), request: requestNow?.status }));

      // Remove the test-only fault from the parked payload and prove compensation did not poison
      // the request's deterministic category/cost id: the same request must now complete once.
      await rawApprovals.updateOne(
        { _id: new ObjectId(String(requestId)), status: "Pending" },
        { $unset: { "payload._test_fail_after_cost_before_publish": "" } },
      );
      const retried = await req(admin, "POST", `/api/approvals/${requestId}`, { decision: "Approved", note: "compensated retry pin" });
      const retriedHead = await rawCategories.findOne({ _id: new ObjectId(String(requestId)) });
      const retriedCost = await rawCosts.findOne({ _id: new ObjectId(String(requestId)) });
      ok("staged cost compensation: after proven cleanup the same approval can retry its deterministic ids exactly once",
        retried.status === 200 && retriedHead?.active === true && !retriedHead?.staged_by_approval
          && retriedCost?.reservation_state === "Applied" && String(retriedCost?.approval_request) === String(requestId),
        JSON.stringify({ status: retried.status, head: retriedHead && { active: retriedHead.active, owner: retriedHead.staged_by_approval }, cost: retriedCost && { state: retriedCost.reservation_state, approval: retriedCost.approval_request } }));
    } else {
      ok("staged cost compensation [precondition]: a valid unknown-head request parked", false, `got ${parked.status}`);
    }
  }

  // The proposed head exists durably while approval replay is paused, but it is inactive and
  // owned by that request. During this exact window no ordinary cost/head door may observe or use
  // it; after replay it is published once with its one deterministic associated cost.
  {
    const nm = `ZZ Staged Race ${stamp}`;
    const parked = await req(ops, "POST", "/api/costs", baseEntry({
      amount: 779, new_subhead: nm, payment_mode: "Cash", _test_pause_after_head_ms: 450,
    }));
    const requestId = parked.data?.item?._id;
    if (requestId) {
      const approvalPromise = req(admin, "POST", `/api/approvals/${requestId}`, { decision: "Approved", note: "staged race pin" });
      let stagedRaw = null;
      for (let i = 0; i < 20 && !stagedRaw; i++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        stagedRaw = await rawCategories.findOne({ _id: new ObjectId(String(requestId)) });
      }
      ok("staged head [precondition]: replay persisted its own inactive head before the associated cost",
        stagedRaw?.active === false && String(stagedRaw?.staged_by_approval) === String(requestId),
        JSON.stringify(stagedRaw && { active: stagedRaw.active, owner: stagedRaw.staged_by_approval }));

      const visibleWhileStaged = (await catList()).some((c) => String(c._id) === String(requestId));
      const directCost = await req(admin, "POST", "/api/costs", baseEntry({ category: requestId, amount: 11, note: `must not use staged ${stamp}` }));
      const child = await req(admin, "POST", "/api/master-lists/cost-categories", { name: `ZZ Child Race ${stamp}`, parent: requestId });
      const sameName = await req(admin, "POST", "/api/costs", baseEntry({ new_subhead: nm, amount: 12, note: `must not reuse staged ${stamp}` }));
      ok("staged head race: the unpublished head is hidden and every normal cost/child/same-name write rejects it",
        !visibleWhileStaged && directCost.status === 409 && child.status === 409 && sameName.status === 409,
        JSON.stringify({ visibleWhileStaged, directCost: directCost.status, child: child.status, sameName: sameName.status }));

      const approved = await approvalPromise;
      const afterHead = (await catList()).find((c) => String(c._id) === String(requestId));
      const afterCosts = ((await req(admin, "GET", "/api/costs")).data?.items ?? [])
        .filter((c) => String(c.approval_request) === String(requestId));
      ok("staged head publish: approval publishes exactly its own head and one associated cost",
        approved.status === 200 && afterHead?.active !== false && afterCosts.length === 1 && afterCosts[0].amount === 779,
        JSON.stringify({ approval: approved.status, head: afterHead && { id: afterHead._id, active: afterHead.active }, costs: afterCosts.map((c) => ({ id: c._id, amount: c.amount })) }));
    } else {
      ok("staged head [precondition]: a valid unknown-head request parked", false, `got ${parked.status}`);
    }
  }

  // A crash after publication cannot be compensated backwards: ordinary users may already have
  // observed the head. The request therefore stays Applying, remains in the default queue, and a
  // retry resumes the request-owned Pending cost instead of trying to recreate either row.
  {
    const nm = `ZZ Resume Published ${stamp}`;
    const note = `resume-published-${stamp}`;
    const parked = await req(ops, "POST", "/api/costs", baseEntry({
      amount: 780, note, new_subhead: nm, payment_mode: "Cash",
      _test_fail_after_publish_before_cost_apply: true,
    }));
    const requestId = parked.data?.item?._id;
    if (requestId) {
      const interrupted = await req(admin, "POST", `/api/approvals/${requestId}`, { decision: "Approved", note: "publish interruption" });
      const rawHead = await rawCategories.findOne({ _id: new ObjectId(String(requestId)) });
      const rawCost = await rawCosts.findOne({ _id: new ObjectId(String(requestId)) });
      const rawRequest = await rawApprovals.findOne({ _id: new ObjectId(String(requestId)) });
      const decisionSnapshot = (row) => JSON.stringify({
        approved_amount: { present: Object.prototype.hasOwnProperty.call(row ?? {}, "approved_amount"), value: row?.approved_amount },
        decision_note: { present: Object.prototype.hasOwnProperty.call(row ?? {}, "decision_note"), value: row?.decision_note },
        decision_map_to_category: {
          present: Object.prototype.hasOwnProperty.call(row ?? {}, "decision_map_to_category"),
          value: row?.decision_map_to_category === undefined ? undefined : String(row.decision_map_to_category),
        },
      });
      const immutableDecision = decisionSnapshot(rawRequest);
      const snapshotMutants = [
        { ...rawRequest, approved_amount: 1 },
        { ...rawRequest, decision_note: "changed note" },
        { ...rawRequest, decision_map_to_category: new ObjectId() },
      ].map(decisionSnapshot);
      ok("Applying saga immutability [instrument]: the raw snapshot distinguishes amount, note and category-map mutations independently",
        snapshotMutants.every((mutant) => mutant !== immutableDecision) && new Set(snapshotMutants).size === 3,
        JSON.stringify({ immutableDecision, snapshotMutants }));
      const opsUser = await rawUsers.findOne({ email: "ops@vidysea.com" });
      const fillerIds = Array.from({ length: 101 }, () => new ObjectId());
      if (opsUser?._id) {
        await rawApprovals.insertMany(fillerIds.map((id, i) => ({
          _id: id, action: "cost.post", summary: `newer pending filler ${i}`,
          payload: { amount: i + 1 }, initiator: opsUser._id, approver_role: "Admin",
          status: "Pending", createdAt: new Date(Date.now() + i + 1000), updatedAt: new Date(),
        })));
      }
      const defaultQueue = (await req(admin, "GET", "/api/approvals?status=Pending")).data?.items ?? [];
      const applyingOnly = (await req(admin, "GET", "/api/approvals?status=Applying")).data?.items ?? [];
      ok("Applying saga [precondition]: injected interruption landed after head publication and before cost visibility",
        interrupted.status === 500 && rawHead?.active === true && !rawHead?.staged_by_approval
          && rawCost?.reservation_state === "Pending" && rawRequest?.status === "Applying",
        JSON.stringify({ status: interrupted.status, head: rawHead && { active: rawHead.active, owner: rawHead.staged_by_approval }, cost: rawCost?.reservation_state, request: rawRequest?.status }));
      ok("Applying saga: the default Pending queue still returns an interrupted Applying request",
        defaultQueue[0]?.status === "Applying" && defaultQueue.some((r) => String(r._id) === String(requestId))
          && applyingOnly.some((r) => String(r._id) === String(requestId)),
        JSON.stringify({ first: defaultQueue[0]?.status, found: defaultQueue.filter((r) => String(r._id) === String(requestId)).map((r) => r.status), applyingOnly: applyingOnly.length }));

      let browser, context;
      try {
        const { chromium } = await import("playwright");
        browser = await chromium.launch({ headless: true });
        context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
        const page = await context.newPage();
        await page.goto(BASE, { waitUntil: "networkidle" });
        const email = page.locator('input[type="email"], input[name="email"]').first();
        if (await email.count()) {
          await email.fill("admin@vidysea.com");
          await page.locator('input[type="password"]').first().fill(process.env.ADMIN_PASSWORD || "admin123");
          await page.locator('button[type="submit"]').first().click();
          await page.waitForURL((u) => !/login/i.test(String(u)), { timeout: 30000 }).catch(() => {});
        }
        await page.goto(`${BASE}/admin?tab=Approvals`, { waitUntil: "networkidle" });
        const exactRow = page.locator(`#approval-request-${requestId}`);
        await exactRow.waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
        const text = await exactRow.innerText().catch(() => "");
        ok("Applying saga UI: the approver sees the interrupted row and a Resume apply control",
          await exactRow.count() === 1 && text.includes(nm) && text.includes("Applying") && text.includes("Resume apply"),
          text.slice(0, 400));
      } finally {
        try { await context?.close(); } catch {}
        try { await browser?.close(); } catch {}
      }

      await rawApprovals.deleteMany({ _id: { $in: fillerIds } });

      const changedAmount = await req(admin, "POST", `/api/approvals/${requestId}`, {
        decision: "Approved", approved_amount: 1, note: "publish interruption",
      });
      const afterAmountAttack = await rawApprovals.findOne({ _id: new ObjectId(String(requestId)) });
      ok("Applying saga: retry cannot change the already-claimed sanctioned amount",
        changedAmount.status === 409 && afterAmountAttack?.status === "Applying"
          && decisionSnapshot(afterAmountAttack) === immutableDecision,
        `got ${changedAmount.status} before=${immutableDecision} after=${decisionSnapshot(afterAmountAttack)}`);
      const changedNote = await req(admin, "POST", `/api/approvals/${requestId}`, {
        decision: "Approved", note: "changed note",
      });
      const afterNoteAttack = await rawApprovals.findOne({ _id: new ObjectId(String(requestId)) });
      ok("Applying saga: retry cannot change the already-claimed decision note",
        changedNote.status === 409 && afterNoteAttack?.status === "Applying"
          && decisionSnapshot(afterNoteAttack) === immutableDecision,
        `got ${changedNote.status} before=${immutableDecision} after=${decisionSnapshot(afterNoteAttack)}`);
      const mapTarget = (await catList()).find((c) => c.active !== false && String(c._id) !== String(requestId));
      const changedMap = await req(admin, "POST", `/api/approvals/${requestId}`, {
        decision: "Approved", map_to_category: mapTarget?._id,
      });
      const afterMapAttack = await rawApprovals.findOne({ _id: new ObjectId(String(requestId)) });
      ok("Applying saga: retry cannot change the already-claimed category mapping",
        !!mapTarget && changedMap.status === 409
          && afterMapAttack?.status === "Applying" && decisionSnapshot(afterMapAttack) === immutableDecision,
        `target=${mapTarget?._id} got ${changedMap.status} before=${immutableDecision} after=${decisionSnapshot(afterMapAttack)}`);
      await rawApprovals.updateOne(
        { _id: new ObjectId(String(requestId)), status: "Applying" },
        { $unset: { "payload._test_fail_after_publish_before_cost_apply": "" } },
      );
      const resumed = await req(admin, "POST", `/api/approvals/${requestId}`, { decision: "Approved" });
      const afterHead = await rawCategories.findOne({ _id: new ObjectId(String(requestId)) });
      const afterCosts = await rawCosts.find({ approval_request: new ObjectId(String(requestId)) }).toArray();
      const afterRequest = await rawApprovals.findOne({ _id: new ObjectId(String(requestId)) });
      ok("Applying saga: retry resumes published-head plus Pending-cost and finalizes only after visibility",
        resumed.status === 200 && afterHead?.active === true && afterCosts.length === 1
          && afterCosts[0].reservation_state === "Applied" && afterRequest?.status === "Approved",
        JSON.stringify({ status: resumed.status, head: afterHead?.active, costs: afterCosts.map((c) => c.reservation_state), request: afterRequest?.status }));
    } else {
      ok("Applying saga [precondition]: published-head interruption request parked", false, `got ${parked.status}`);
    }
  }

  // The other crash window is after the cost itself is visible. It must remain a single liability
  // and move forward from Applying on retry; returning it to Pending would let a fresh replay bill
  // the same approved request twice.
  {
    const cat = (await catList()).find((c) => !c.pre_approved && c.active !== false);
    const note = `resume-applied-${stamp}`;
    const parked = await req(ops, "POST", "/api/costs", baseEntry({
      category: cat?._id, amount: 781, note, _test_fail_after_cost_applied: true,
    }));
    const requestId = parked.data?.item?._id;
    if (requestId) {
      const interrupted = await req(admin, "POST", `/api/approvals/${requestId}`, { decision: "Approved", note: "cost visible interruption" });
      const rawRequest = await rawApprovals.findOne({ _id: new ObjectId(String(requestId)) });
      const rows = await rawCosts.find({ approval_request: new ObjectId(String(requestId)) }).toArray();
      ok("Applying cost saga: interruption after visible CostEntry leaves one liability and an Applying claim",
        interrupted.status === 500 && rawRequest?.status === "Applying" && rows.length === 1 && rows[0].reservation_state === "Applied",
        JSON.stringify({ status: interrupted.status, request: rawRequest?.status, rows: rows.map((c) => c.reservation_state) }));
      await rawApprovals.updateOne(
        { _id: new ObjectId(String(requestId)), status: "Applying" },
        { $unset: { "payload._test_fail_after_cost_applied": "" } },
      );
      const resumed = await req(admin, "POST", `/api/approvals/${requestId}`, { decision: "Approved" });
      ok("Applying cost saga: retry confirms the existing deterministic cost and approves without duplication",
        resumed.status === 200
          && (await rawApprovals.findOne({ _id: new ObjectId(String(requestId)) }))?.status === "Approved"
          && await rawCosts.countDocuments({ approval_request: new ObjectId(String(requestId)) }) === 1,
        `got ${resumed.status}`);
    } else {
      ok("Applying cost saga [precondition]: ordinary cost request parked", false, `got ${parked.status}`);
    }
  }

  // Negative ownership: a deterministic id occupied by somebody else's head is never adopted or
  // deleted. The claimed request fails closed in Applying for reconciliation.
  {
    const nm = `ZZ Foreign Owner ${stamp}`;
    const parked = await req(ops, "POST", "/api/costs", baseEntry({ amount: 782, new_subhead: nm, payment_mode: "Cash" }));
    const requestId = parked.data?.item?._id;
    if (requestId) {
      const foreign = {
        _id: new ObjectId(String(requestId)), name: `ZZ Foreign Occupant ${stamp}`, active: true,
        createdAt: new Date(), updatedAt: new Date(),
      };
      await rawCategories.insertOne(foreign);
      const refused = await req(admin, "POST", `/api/approvals/${requestId}`, { decision: "Approved" });
      const occupant = await rawCategories.findOne({ _id: foreign._id });
      const afterRequest = await rawApprovals.findOne({ _id: new ObjectId(String(requestId)) });
      ok("Applying ownership: foreign deterministic-id head is preserved and request fails closed",
        refused.status >= 400 && occupant?.name === foreign.name && afterRequest?.status === "Applying",
        JSON.stringify({ status: refused.status, occupant: occupant?.name, request: afterRequest?.status }));
      await rawCategories.deleteOne({ _id: foreign._id, name: foreign.name });
    } else {
      ok("Applying ownership [precondition]: unknown-head request parked", false, `got ${parked.status}`);
    }
  }

  // ---- QA-1980: a DEACTIVATED head is not a place to file new money. `active` was selected and
  // never read, so the field was there and the check was not.
  {
    const dead = await req(admin, "POST", "/api/master-lists/cost-categories", { name: `ZZ Dead ${stamp}`, active: false });
    const deadId = dead.data?.item?._id;
    const parked = await req(ops, "POST", "/api/costs", baseEntry({ amount: 999, new_subhead: `ZZ NeverMap ${stamp}`, payment_mode: "Cash" }));
    if (deadId && parked.data?.item?._id) {
      const d = await req(admin, "POST", `/api/approvals/${parked.data.item._id}`, { decision: "Approved", map_to_category: deadId });
      ok("QA-1980: filing a cost under a DEACTIVATED head is refused", d.status >= 400, `got ${d.status}`);
      const reqNow = ((await req(admin, "GET", "/api/approvals?status=all")).data?.items ?? [])
        .find((r) => String(r._id) === String(parked.data.item._id));
      ok("QA-1980: ...and that refusal leaves the request still Pending", reqNow?.status === "Pending", `status=${reqNow?.status}`);
    } else {
      ok("QA-1980: the fixture for the deactivated-head refusal built", false,
        `dead=${dead.status} parked=${parked.status} - this pin measured nothing`);
    }
  }

  // ---- QA-1976: pre-approval does NOT inherit. A subhead nobody marked could ride its parent's
  // cap and post 90,000 unapproved. Q4b/Q4c are here so the fix cannot be "disable the feature".
  {
    const h = await req(admin, "POST", "/api/master-lists/cost-categories", {
      name: `ZZ BigHead ${stamp}`, pre_approved: true, pre_approved_amount: 100000, pre_approved_basis: "big commitment",
    });
    const hId = h.data?.item?._id;
    const sub = await req(admin, "POST", "/api/master-lists/cost-categories", { name: `ZZ CheapSub ${stamp}`, parent: hId });
    const sId = sub.data?.item?._id;
    if (hId && sId) {
      const r1 = await req(ops, "POST", "/api/costs", baseEntry({ category: sId, amount: 90000, payment_mode: "Cash" }));
      ok("QA-1976: a subhead that is not itself pre-approved does NOT ride its parent's cap - 90,000 PARKS",
        r1.status === 202, `got ${r1.status} - 201 means it posted straight to the ledger, unapproved`);
      const r2 = await req(ops, "POST", "/api/costs", baseEntry({ category: hId, amount: 50, payment_mode: "Cash" }));
      ok("QA-1976: ...while the head that IS marked still pre-approves within its cap (the fix did not just disable the feature)",
        r2.status === 201, `got ${r2.status}`);
      const r3 = await req(ops, "POST", "/api/costs", baseEntry({ category: hId, amount: 500000, payment_mode: "Cash" }));
      ok("QA-1976: ...and ABOVE that cap it parks - the marker is a condition, not a pass",
        r3.status === 202, `got ${r3.status}`);
    } else {
      ok("QA-1976: the parent/subhead fixture built", false, `head=${h.status} sub=${sub.status} - this pin measured nothing`);
    }
  }
}

// ---------------- QA-2295 / QA-2296 — THE REJECTION REASON, ON A SCREEN ----------------
//
// Found by the live browser checker on -299, and it could not have been found any other way. The
// field was ALWAYS in the payload: `/api/approvals?mine=1` returned `decision_note` correctly, so
// every API assertion in this file would have passed over the defect. The only thing that never
// showed it was the screen.
//
// The mechanism is a permission irony. `costs/page.tsx` rendered "My submissions" - the one table
// carrying an "Admin's note" column - only when `postOnly` was true, and `postOnly` means
// `!can("finance.view")`. So the CEO, who HOLDS finance.view, got the whole ledger instead and
// never saw his own rejected entry. The grant that let him see more took away the reason his own
// cost was refused. On a system built for "koi bhi cheez system se chhutegi nahi", a rejection
// nobody can read is a cost that quietly never gets reposted.
//
// So this block drives a real browser. A structural pin would only prove the JSX exists somewhere;
// this proves a person holding finance.view can READ the reason.
{
  const stamp2 = Date.now().toString(36);
  const REASON = `ZZPIN-${stamp2} rejected because the voucher for ₹500 is missing`;
  let browser2, ctx2;
  try {
    const { chromium } = await import("playwright");

    // The raiser must hold finance.view - that is the CONDITION of the defect, not incidental to
    // it. A post-only raiser was always fine; this pin would be vacuous without the grant.
    const email2 = `zzfin.reason.${stamp2}@vidysea-test.local`;
    const made = await req(admin, "POST", "/api/users", {
      name: `ZZFIN REASON ${stamp2}`, email: email2, password: PW,
      role: "Admin", can_edit: true, location_scope: [],
    });
    ok("QA-2295 [precondition] a raiser account was created", made.status === 201 && !!made.data?.item?._id,
      `got ${made.status} ${JSON.stringify(made.data ?? {}).slice(0, 160)}`);
    const raiserId = made.data?.item?._id;
    if (raiserId) {
      await req(admin, "PATCH", `/api/users/${raiserId}`, { extra_permissions: ["finance.view"] });
      const back = ((await req(admin, "GET", "/api/users")).data?.items ?? []).find((u) => String(u._id) === String(raiserId));
      ok("QA-2295 [precondition] the raiser HOLDS finance.view - the condition of the defect",
        (back?.extra_permissions ?? []).includes("finance.view"),
        `extra=[${(back?.extra_permissions ?? []).join(", ")}] - without this grant the old code already showed the note and this pin proves nothing`);
    }

    // The rule must be ON, or the cost lands in the ledger and there is no decision to read.
    await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: true, approver_role: "Admin" });
    const raiser = await login(email2, PW);
    ok("QA-2295 [precondition] the raiser can sign in", !!raiser, "no session");

    const cat2 = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])[0];
    const posted = await req(raiser, "POST", "/api/costs", baseEntry({ category: cat2?._id, note: `ZZPIN ${stamp2} awaiting a decision` }));
    ok("QA-2295 [precondition] the raiser's cost PARKS rather than landing in the ledger",
      posted.status === 202 && posted.data?.queued === true,
      `got ${posted.status} ${JSON.stringify(posted.data ?? {}).slice(0, 160)}`);

    const pending = ((await req(admin, "GET", "/api/approvals?status=Pending")).data?.items ?? [])
      .find((r) => String(r.summary ?? "").includes(stamp2) || String(r.payload?.note ?? "").includes(stamp2));
    ok("QA-2295 [precondition] the request reached the approver's queue", !!pending, "not found");

    if (pending) {
      const rej = await req(admin, "POST", `/api/approvals/${pending._id}`, { decision: "Rejected", note: REASON });
      ok("QA-2295 [precondition] the approver rejects it WITH a reason", rej.status === 200, `got ${rej.status}`);

      // The API half, kept because it is the thing that was already true and hid the defect.
      const minePayload = ((await req(raiser, "GET", "/api/approvals?mine=1")).data?.items ?? [])
        .find((r) => String(r._id) === String(pending._id));
      ok("QA-2295: the reason is in the raiser's own PAYLOAD - it always was, which is why no API pin caught this",
        String(minePayload?.decision_note ?? "").includes(stamp2),
        `decision_note=${JSON.stringify(minePayload?.decision_note ?? null)}`);
      // QA-2356 (checker, cycle 1): rendering `decision_note` handed the approver's typed figure to
      // a reader the SAME route blinds one line earlier - it stripped the amount from the payload
      // and then published it inside the reason. The mask named `summary` and only `summary`, so
      // the moment a second free-text field appeared on the row the money walked back out.
      {
        const blindEmail = `zzfin.blind.${stamp2}@vidysea-test.local`;
        const mk = await req(admin, "POST", "/api/users", { name: `ZZFIN BLIND ${stamp2}`, email: blindEmail, password: PW, role: "Admin", can_edit: true, location_scope: [] });
        ok("QA-2356 [precondition] a reader WITHOUT finance.view exists", mk.status === 201, `got ${mk.status}`);
        const blind = await login(blindEmail, PW);
        // The list defaults to status=Pending and this row is Rejected, so a bare GET can never
        // contain it - the first version of this pin reported `null` three times and would have
        // been read as "no leak". Ask for the status the row actually has.
        const seen = ((await req(blind, "GET", "/api/approvals?status=Rejected")).data?.items ?? [])
          .find((r) => String(r._id) === String(pending._id));
        ok("QA-2356 [precondition] that reader really is blind to the money - the payload amount is stripped",
          !!seen && seen.payload?.amount === undefined,
          `payload.amount=${JSON.stringify(seen?.payload?.amount ?? null)} - if this is visible the pin below proves nothing`);
        ok("QA-2356: the rejection REASON does not leak the figure the same response just stripped",
          !!seen && !/₹\s?5/.test(String(seen.decision_note ?? "")),
          `decision_note=${JSON.stringify(seen?.decision_note ?? null)} - the amount is redacted from the payload and published in the reason`);
        ok("QA-2356 [discrimination] ...while the rest of the reason survives, so this is redaction and not deletion",
          !!seen && String(seen.decision_note ?? "").includes(`ZZPIN-${stamp2}`),
          `decision_note=${JSON.stringify(seen?.decision_note ?? null)} - over-redaction hides the reason as effectively as the leak did`);
      }
      ok("QA-2296: the decision TIME is stored, not only the request time",
        !!minePayload?.decided_at && String(minePayload.decided_at) !== String(minePayload.createdAt),
        `decided_at=${JSON.stringify(minePayload?.decided_at ?? null)} createdAt=${JSON.stringify(minePayload?.createdAt ?? null)}`);

      // ---- and now the half that only a browser can answer ----
      try {
        browser2 = await chromium.launch({ headless: true });
      } catch (e) {
        // Not a skip. A missing browser means this block verified NOTHING, and it says so in red.
        ok("QA-2295 [precondition] chromium launches from the `playwright` devDependency", false,
          String(e.message).slice(0, 200) + " -- run `npx playwright install chromium`");
        throw e;
      }
      ctx2 = await browser2.newContext({ viewport: { width: 1400, height: 1000 } });
      const page2 = await ctx2.newPage();

      await page2.goto(BASE, { waitUntil: "networkidle" });
      const box2 = page2.locator('input[type="email"], input[name="email"]').first();
      if (await box2.count()) {
        await box2.fill(email2);
        await page2.locator('input[type="password"]').first().fill(PW);
        await page2.locator('button[type="submit"]').first().click();
        await page2.waitForURL((u) => !/login/i.test(String(u)), { timeout: 30000 }).catch(() => {});
      }
      ok("QA-2295 [precondition] the raiser's BROWSER is signed in, not sitting on the login screen",
        !/login/i.test(page2.url()), page2.url());

      await page2.goto(`${BASE}/costs`, { waitUntil: "networkidle" });
      // The page fetches client-side; wait for its own content rather than a stopwatch. A fixed
      // sleep on a slow runner produces the defect's exact signature and gets a real pin dismissed
      // as flaky.
      await page2.waitForFunction(
        (s) => /My submissions|All cost entries|Costs/i.test(document.body.innerText),
        undefined, { timeout: 45000 },
      ).catch(() => {});
      const bodyText = await page2.locator("body").innerText();

      const ownRights = await req(raiser, "GET", "/api/permissions/me");
      ok("finance read-only UI [precondition]: this browser persona has finance.view but not finance.approve edit",
        ownRights.data?.levels?.["finance.view"] === "edit" && !ownRights.data?.levels?.["finance.approve"],
        JSON.stringify(ownRights.data?.levels ?? {}));
      const ledgerRows = page2.locator("tbody tr");
      ok("finance read-only UI [precondition]: the finance.view browser has a ledger row to try to open",
        await ledgerRows.count() > 0, `rows=${await ledgerRows.count()}`);
      if (await ledgerRows.count()) await ledgerRows.last().click();
      await page2.waitForTimeout(100);
      const afterReadOnlyClick = await page2.locator("body").innerText();
      ok("finance read-only UI: row click cannot open edit and delete/payment controls are absent without finance.approve:edit",
        !/Edit cost entry/i.test(afterReadOnlyClick)
          && !/Mark payment done/i.test(afterReadOnlyClick)
          && !/^Delete$/m.test(afterReadOnlyClick),
        afterReadOnlyClick.slice(0, 300));

      // THE MUTANT CAUGHT THIS ASSERTION, NOT THE CODE (2026-09-09). It used to test
      // `bodyText.includes(stamp2)`, and `stamp2` is in BOTH the rejection REASON and the cost's
      // own note - so on the pre-fix build, where "My submissions" is not rendered at all, the
      // stamp was still on the page via the entry itself and this pin passed over the exact defect
      // it is named for. A pin that is green on the broken build and green on the fixed one has
      // measured nothing. The reason string is the only text that exists SOLELY in
      // `decision_note`, so that is what has to appear.
      ok("QA-2295: a raiser WITH finance.view can READ the rejection reason on their own screen",
        bodyText.includes(REASON),
        `the /costs page does not contain the reason "${REASON}". This is the defect: the note is in the payload and on no screen the raiser can reach. body starts: ${bodyText.slice(0, 240)}`);
      ok("QA-2295 [discrimination] the reason is not merely the cost's own note echoed back",
        !bodyText.includes(`ZZPIN ${stamp2} awaiting a decision`) || bodyText.includes(REASON),
        `the page shows the entry's note but not the approver's reason - that is the defect wearing the pin's clothes`);
      ok("QA-2295: ...and the entry is shown as Rejected beside it, so the reason has something to explain",
        /Rejected/i.test(bodyText),
        `no "Rejected" anywhere on the raiser's costs page`);

      // QA-2357 (checker, cycle 1): the admin/page.tsx half of this unit was pinned by NOTHING -
      // delete either render and the suite stayed 50/0, which makes QA-2296's fix indistinguishable
      // from its absence. The one QA-2296 assertion tested STORAGE, which nothing disputed. So the
      // approver's own screen is driven too, in the same browser run.
      {
        const actx = await browser2.newContext({ viewport: { width: 1400, height: 1000 } });
        try {
          const ap = await actx.newPage();
          await ap.goto(BASE, { waitUntil: "networkidle" });
          const ab = ap.locator('input[type="email"], input[name="email"]').first();
          if (await ab.count()) {
            await ab.fill("admin@vidysea.com");
            await ap.locator('input[type="password"]').first().fill(process.env.ADMIN_PASSWORD || "admin123");
            await ap.locator('button[type="submit"]').first().click();
            await ap.waitForURL((u) => !/login/i.test(String(u)), { timeout: 30000 }).catch(() => {});
          }
          await ap.goto(`${BASE}/admin?tab=Approvals`, { waitUntil: "networkidle" });
          // Find the status filter by its OPTIONS, never by position - a new <select> above it
          // would silently make this pin drive the wrong control.
          // FLAKY ONCE, FIXED HERE: the first version passed one run and failed the next on the
          // IDENTICAL build. It selected before the option list had rendered and swallowed the
          // error, so the page stayed on its default filter and the row was simply absent. A pin
          // that fails intermittently is worse than one that fails always - it gets dismissed as
          // noise, which is how a real defect gets waved through. It now waits for the control,
          // asserts the selection took, and re-tries once through the 'all' option.
          const pickStatus = async (want) => {
            const sels = ap.locator("select");
            await ap.waitForFunction(() => document.querySelectorAll("select option").length > 0, undefined, { timeout: 30000 }).catch(() => {});
            for (let n = 0; n < (await sels.count()); n++) {
              const opts = await sels.nth(n).locator("option").allTextContents();
              const hit = opts.find((o) => o.trim().toLowerCase() === want.toLowerCase());
              if (!hit) continue;
              await sels.nth(n).selectOption({ label: hit });
              return true;
            }
            return false;
          };
          const picked = await pickStatus("Rejected");
          ok("QA-2295 [precondition] the approvals screen has a status filter offering Rejected",
            picked, "no <select> on /admin?tab=Approvals carries a 'Rejected' option - the pin below cannot reach the row it judges");
          let seenIt = await ap.waitForFunction((s) => document.body.innerText.includes(s), REASON, { timeout: 30000 }).then(() => true).catch(() => false);
          if (!seenIt) {
            await pickStatus("All").catch(() => false);
            seenIt = await ap.waitForFunction((s) => document.body.innerText.includes(s), REASON, { timeout: 20000 }).then(() => true).catch(() => false);
          }
          const abody = await ap.locator("body").innerText();
          ok("QA-2295: the approver's own screen shows the reason that was typed",
            abody.includes(REASON),
            `/admin?tab=Approvals does not contain "${REASON}" - the render is unpinned and could be deleted unnoticed. body starts: ${abody.slice(0, 240)}`);
          // ANCHORED TO OUR OWN ROW, and that is the whole fix. The first version took
          // `indexOf("decided by")` - the FIRST decided row anywhere on the screen, which with 13
          // requests in the queue is usually somebody else's, seeded without a decision time. So
          // the pin passed or failed depending on what else happened to be in the list, which is
          // exactly the flakiness that gets a real red dismissed as noise.
          ok("QA-2296: the DECISION time is on that screen, not only the request time",
            (() => { const z = abody.indexOf(`ZZPIN-${stamp2}`); const anchor = z >= 0 ? z : abody.indexOf(`ZZPIN ${stamp2}`); if (anchor < 0) return false; const row = abody.slice(Math.max(0, anchor - 400), anchor + 200); const k = row.indexOf("decided by"); return k >= 0 && /·[^·]*\d/.test(row.slice(k, k + 200)); })(),
            `no 'decided by X · <time>' on OUR OWN row (${stamp2}) on the approvals screen - QA-2296 renders decided_at and nothing asserted it. body starts: ${abody.slice(0, 240)}`);
        } finally {
          try { await actx.close(); } catch {}
        }
      }

      // QA-2368 (checker, cycle 2): the empty-state fix was the smallest change in the commit and
      // the only one with no assertion - revert `(mine.length > 0 || postOnly)` to `mine.length > 0`
      // and the suite stayed byte-identical while a real browser took two assertions red. Precisely
      // as deletable as the two renders this cycle was called in to pin.
      {
        const pctx = await browser2.newContext({ viewport: { width: 1400, height: 1000 } });
        try {
          const pEmail = `zzfin.postonly.${stamp2}@vidysea-test.local`;
          const pm = await req(admin, "POST", "/api/users", { name: `ZZFIN POSTONLY ${stamp2}`, email: pEmail, password: PW, role: "Operations", can_edit: true, location_scope: [] });
          ok("QA-2368 [precondition] a POST-ONLY raiser exists with nothing submitted", pm.status === 201, `got ${pm.status}`);
          const pp = await pctx.newPage();
          await pp.goto(BASE, { waitUntil: "networkidle" });
          const pb = pp.locator('input[type="email"], input[name="email"]').first();
          if (await pb.count()) {
            await pb.fill(pEmail);
            await pp.locator('input[type="password"]').first().fill(PW);
            await pp.locator('button[type="submit"]').first().click();
            await pp.waitForURL((u) => !/login/i.test(String(u)), { timeout: 30000 }).catch(() => {});
          }
          await pp.goto(`${BASE}/costs`, { waitUntil: "networkidle" });
          await pp.waitForFunction(() => /My submissions|Post a cost|Costs/i.test(document.body.innerText), undefined, { timeout: 45000 }).catch(() => {});
          const pbody = await pp.locator("body").innerText();
          ok("QA-2368: a post-only raiser with NO submissions still sees the section and its empty state",
            /My submissions/i.test(pbody) && /Nothing submitted yet/i.test(pbody),
            `the /costs page shows no My-submissions empty state - the section vanishes entirely, which reads as a broken page rather than an empty one. body starts: ${pbody.slice(0, 240)}`);
        } finally {
          try { await pctx.close(); } catch {}
        }
      }

      // The new-head request uses a different action name (`costcategory.create`) from an
      // ordinary parked cost (`cost.post`). Drive the actual Operations screen so a filter that
      // accidentally keeps only the old action cannot pass on API evidence alone.
      {
        const uctx = await browser2.newContext({ viewport: { width: 1400, height: 1000 } });
        try {
          const up = await uctx.newPage();
          await up.goto(BASE, { waitUntil: "networkidle" });
          const ub = up.locator('input[type="email"], input[name="email"]').first();
          if (await ub.count()) {
            await ub.fill("ops@vidysea.com");
            await up.locator('input[type="password"]').first().fill(PW);
            await up.locator('button[type="submit"]').first().click();
            await up.waitForURL((u) => !/login/i.test(String(u)), { timeout: 30000 }).catch(() => {});
          }
          await up.goto(`${BASE}/costs`, { waitUntil: "networkidle" });
          const shown = await up.waitForFunction(
            (name) => document.body.innerText.includes(String(name)), proposedHeadForMine,
            { timeout: 45000 },
          ).then(() => true).catch(() => false);
          const ubody = await up.locator("body").innerText();
          ok("My submissions UI: the unknown-head request is visible to its raiser alongside ordinary cost requests",
            shown && /My submissions/i.test(ubody),
            `unknown head ${proposedHeadForMine} is absent from the Operations /costs screen. body starts: ${ubody.slice(0, 260)}`);
        } finally {
          try { await uctx.close(); } catch {}
        }
      }
    }
  } catch (e) {
    ok("QA-2295: the browser block ran without error", false, String((e && e.message) || e).slice(0, 300));
  } finally {
    try { if (ctx2) await ctx2.close(); } catch {}
    try { if (browser2) await browser2.close(); } catch {}
  }
}

// leave the rule as we found it, so the next suite is not measuring ours
await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: false, approver_role: "Admin" });
await req(admin, "PUT", "/api/approvals", { action: "costcategory.create", enabled: false, approver_role: "Admin" });
await rawClient.close();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
