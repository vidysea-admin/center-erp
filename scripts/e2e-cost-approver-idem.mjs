// mtg-a3 (Umesh, 2026-10-06 meeting) - R5 "Approved by / Approved on", R7 cost-POST idempotency,
// R9 payment-status filter.
//
// WHY THESE PINS ARE SHAPED THIS WAY. Everything this unit ships stays green under `tsc` and every
// structural pin even if the feature is wrong: a column that is always "Pre-approved", a key that is
// stored but never consulted, a filter that is read and ignored. So every arm below is behavioural
// and derived from INPUTS - the approver's name comes from who actually pressed Approve (a second
// approver with a unique name, never the poster and never the default admin), the duplicate count
// comes from the raw collection, and the race is eight real parallel POSTs.
//
// Each arm names the single guard it falsifies; the mutants in the evidence folder each break one
// guard and must turn that arm red:
//   join      - "approved by" is the approval request's decided_by, not the poster
//   label     - Pre-approved / Direct (<role>) come from pre_approved_applied and the poster's role
//   unique    - the unique sparse index on idempotency_key
//   race      - E11000 from the index is turned into a replay of the winner, not an error
//   user      - the key is scoped to the caller
//   filter    - approved_by / payment_status are applied, not just read
//   scope     - the ledger stays inside the caller's location scope
import { requireLocalBase } from "./db-guard.mjs";
import { MongoClient, ObjectId } from "mongodb";
import * as XLSX from "xlsx";

const BASE = requireLocalBase("e2e-cost-approver-idem", process.env.BASE_URL || "http://localhost:3000/erp");
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
async function req(cookie, method, p, body, headers = {}) {
  const res = await fetch(BASE + p, {
    method, headers: { "Content-Type": "application/json", cookie, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})), headers: res.headers };
}
async function reqBuffer(cookie, p) {
  const res = await fetch(BASE + p, { headers: { cookie } });
  return { status: res.status, data: Buffer.from(await res.arrayBuffer()) };
}

const client = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017", { serverSelectionTimeoutMS: 8000 });
await client.connect();
const db = client.db((process.env.MONGODB_DB || "center_erp_ci").trim());
const rawCosts = db.collection("costentries");
const rawApprovals = db.collection("approvalrequests");
const rawUsers = db.collection("users");

const PW = "CiOnly@123";
const stamp = Date.now().toString(36);
const TAG = `a3-${stamp}`;

const admin = await login("admin@vidysea.com", (process.env.ADMIN_PASSWORD || (() => { throw new Error("ADMIN_PASSWORD env var is required (no default)"); })()));
const ops = await login("ops@vidysea.com", PW);
const spoc = await login("spoc.jpr03@vidysea.com", PW);
ok("[precondition] personas sign in", !!admin && !!ops && !!spoc, `admin=${!!admin} ops=${!!ops} spoc=${!!spoc}`);

const adminRow = await rawUsers.findOne({ email: "admin@vidysea.com" });
const opsRow = await rawUsers.findOne({ email: "ops@vidysea.com" });
const spocRow = await rawUsers.findOne({ email: "spoc.jpr03@vidysea.com" });

// A SECOND approver with a unique name: "approved by" must be the person who pressed Approve.
const approverName = `Approver Bee ${stamp}`;
const mkUser = async (name, email, role, grants, scope = []) => {
  const made = await req(admin, "POST", "/api/users", { name, email, password: PW, role, can_edit: true, location_scope: scope });
  if (made.data?.item?._id && grants.length) await req(admin, "PATCH", `/api/users/${made.data.item._id}`, { extra_permissions: grants });
  return { made, id: made.data?.item?._id, cookie: await login(email, PW) };
};
const approverB = await mkUser(approverName, `zz.a3.bee.${stamp}@vidysea-test.local`, "Admin", ["finance.view", "finance.approve"]);
const ungranted = await mkUser(`Ungranted ${stamp}`, `zz.a3.none.${stamp}@vidysea-test.local`, "Admin", []);
ok("[precondition] a second approver and an ungranted admin exist", !!approverB.id && !!approverB.cookie && !!ungranted.cookie,
  JSON.stringify({ b: approverB.made.status, n: ungranted.made.status }));

const locs = (await req(admin, "GET", "/api/locations?limit=2000")).data?.items ?? [];
const ownLoc = locs.find((l) => l.code === "JPR03");
const foreignLoc = locs.find((l) => l.code === "KOT02");
ok("[precondition] own and foreign locations exist", !!ownLoc && !!foreignLoc);

const cats = (await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [];
const plain = cats.find((c) => !c.pre_approved && !/^(other|misc)/i.test(String(c.name)));
const cap = await req(admin, "POST", "/api/master-lists/cost-categories", {
  name: `ZZ A3 Capped ${stamp}`, pre_approved: true, pre_approved_amount: 5000, pre_approved_basis: "Rs 5000 a time, agreed in the meeting",
});
const capId = cap.data?.item?._id;
const formula = await req(admin, "POST", "/api/master-lists/cost-categories", {
  name: `ZZ A3 PerPass ${stamp}`, pre_approved: true, pre_approved_unit: "Per billable passed",
  pre_approved_amount: 50, pre_approved_min_billable: 1, pre_approved_basis: "Rs 50 per billable passed",
});
const formulaId = formula.data?.item?._id;
ok("[precondition] a plain head, a capped head and a formula head exist", !!plain && !!capId && !!formulaId,
  JSON.stringify({ plain: plain?.name, cap: cap.status, formula: formula.status }));
// Umesh, 2026-10-07 (43f31fa, "Pending head pe auto-approve band"): every new head starts Pending and
// evaluatePreApproval auto-posts nothing under a Pending head. So the two fixture heads are signed off
// through the real approvals door by the SECOND approver (finance.approve, not the head's creator),
// exactly as production would - otherwise every pre-approved arm below parks (202) for the wrong reason.
// pending-head-cap-bind: signing off a Pending head carries the limit the approver saw (the whole limit: amount, unit, min_billable, basis).
const seenCap = async (hr) => { const h = await db.collection("costcategories").findOne({ _id: new ObjectId(String(hr.entity_id)) }); return h?.pre_approved === true ? { amount: typeof h.pre_approved_amount === "number" ? h.pre_approved_amount : null, unit: h.pre_approved_unit || "Fixed amount", min_billable: typeof h.pre_approved_min_billable === "number" ? h.pre_approved_min_billable : 0, basis: typeof h.pre_approved_basis === "string" && h.pre_approved_basis.trim() ? h.pre_approved_basis : null } : { amount: null, unit: "Fixed amount", min_billable: 0, basis: null }; };
const signOff = async (headId) => {
  const hr = await rawApprovals.findOne({ action: "costcategory.create", entity_id: new ObjectId(String(headId)), status: "Pending" });
  return hr ? (await req(approverB.cookie, "POST", `/api/approvals/${hr._id}`, { decision: "Approved", note: "fixture: sign off", seen_cap: await seenCap(hr) })).status : 0;
};
const [capSign, formulaSign] = [await signOff(capId), await signOff(formulaId)];
ok("[precondition] the capped and the formula head were signed off by the second approver (not the creator)", capSign === 200 && formulaSign === 200, `cap=${capSign} formula=${formulaSign}`);

const rule = (enabled) => req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled, approver_role: "Admin" });
const entry = (note, extra = {}) => ({ entry_date: "2026-09-07", location: ownLoc._id, category: plain._id, amount: 321, note: `${TAG}-${note}`, ...extra });
const istDay = (d) => new Date(new Date(d).getTime() + 330 * 60_000).toISOString().slice(0, 10);
const dayShift = (day, n) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);

// ======================================================= R7 - idempotency, direct path (rule OFF)
{
  ok("[precondition] cost.post approval is OFF for the direct-path arms", (await rule(false)).status === 200);
  const key = `k-direct-${stamp}`;
  const first = await req(admin, "POST", "/api/costs", entry("direct"), { "Idempotency-Key": key });
  const again = await req(admin, "POST", "/api/costs", entry("direct"), { "Idempotency-Key": key });
  const rows = await rawCosts.find({ note: `${TAG}-direct` }).toArray();
  ok("R7 direct: the first POST with a key creates the entry (201)", first.status === 201 && !!first.data?.item?._id, `got ${first.status} ${JSON.stringify(first.data).slice(0, 120)}`);
  ok("R7 direct: a repeat POST with the same key returns the FIRST result, same status and id",
    again.status === 201 && String(again.data?.item?._id) === String(first.data?.item?._id),
    `got ${again.status} first=${first.data?.item?._id} again=${again.data?.item?._id}`);
  ok("R7 direct: exactly ONE ledger row exists for the key (raw count)", rows.length === 1, `count=${rows.length}`);
  ok("R7 direct: the key is stored on the row as '<user id>:<key>' (scoped), never bare",
    rows[0]?.idempotency_key === `${adminRow._id}:${key}`, JSON.stringify(rows[0]?.idempotency_key));
  ok("R7 direct: the key is never echoed in the API response", !JSON.stringify(first.data).includes(key) && !JSON.stringify(again.data).includes(key));

  const changed = await req(admin, "POST", "/api/costs", entry("direct", { amount: 999 }), { "Idempotency-Key": key });
  ok("R7 direct: a repeat with a different body still returns the first result and creates nothing",
    changed.status === 201 && String(changed.data?.item?._id) === String(first.data?.item?._id) && changed.data?.item?.amount === 321
      && (await rawCosts.countDocuments({ note: `${TAG}-direct` })) === 1);

  const other = await req(admin, "POST", "/api/costs", entry("direct-other"), { "Idempotency-Key": `k-direct-2-${stamp}` });
  const other2 = await req(admin, "POST", "/api/costs", entry("direct-other"), { "Idempotency-Key": `k-direct-3-${stamp}` });
  ok("R7 direct: a DIFFERENT key creates a different entry (the key, not the content, is the identity)",
    other.status === 201 && other2.status === 201 && String(other.data?.item?._id) !== String(other2.data?.item?._id)
      && (await rawCosts.countDocuments({ note: `${TAG}-direct-other` })) === 2);

  const n1 = await req(admin, "POST", "/api/costs", entry("nokey"));
  const n2 = await req(admin, "POST", "/api/costs", entry("nokey"));
  ok("R7 direct: POSTs with no key behave exactly as before (two rows)", n1.status === 201 && n2.status === 201
    && (await rawCosts.countDocuments({ note: `${TAG}-nokey` })) === 2);

  const bad = await req(admin, "POST", "/api/costs", entry("badkey"), { "Idempotency-Key": "x" });
  ok("R7: a malformed key is refused with 400 and creates nothing", bad.status === 400 && (await rawCosts.countDocuments({ note: `${TAG}-badkey` })) === 0, `got ${bad.status}`);

  // ---- the race: eight real parallel POSTs, one key
  const raceKey = `k-race-${stamp}`;
  const raced = await Promise.all(Array.from({ length: 8 }, () => req(admin, "POST", "/api/costs", entry("race"), { "Idempotency-Key": raceKey })));
  const raceIds = new Set(raced.map((r) => String(r.data?.item?._id)));
  ok("R7 race: eight parallel POSTs with one key ALL answer 201 (the losers replay the winner, none errors)",
    raced.every((r) => r.status === 201), raced.map((r) => r.status).join(","));
  ok("R7 race: ...with ONE id between them", raceIds.size === 1, [...raceIds].join(","));
  ok("R7 race: ...and exactly ONE row in the ledger (raw count)", (await rawCosts.countDocuments({ note: `${TAG}-race` })) === 1,
    `count=${await rawCosts.countDocuments({ note: `${TAG}-race` })}`);

  // ---- the index itself
  const costIdx = (await rawCosts.indexes()).find((i) => i.key?.idempotency_key === 1);
  const apprIdx = (await rawApprovals.indexes()).find((i) => i.key?.idempotency_key === 1);
  ok("R7 unique: costentries has a unique sparse index on idempotency_key", !!costIdx && costIdx.unique === true && costIdx.sparse === true, JSON.stringify(costIdx));
  ok("R7 unique: approvalrequests has a unique sparse index on idempotency_key", !!apprIdx && apprIdx.unique === true && apprIdx.sparse === true, JSON.stringify(apprIdx));
  let dupCode = null;
  try {
    const stored = rows[0];
    await rawCosts.insertOne({ ...stored, _id: new ObjectId() });
  } catch (e) { dupCode = e?.code; }
  ok("R7 unique: the database itself refuses a second row with the same key (E11000)", dupCode === 11000, `code=${dupCode}`);
  ok("R7 unique: rows without a key stay out of the index (many keyless rows exist)", (await rawCosts.countDocuments({ idempotency_key: { $exists: false } })) >= 2);
}

// ======================================================= R7 - per user
{
  const key = `k-user-${stamp}`;
  const a = await req(admin, "POST", "/api/costs", entry("user-a"), { "Idempotency-Key": key });
  const b = await req(spoc, "POST", "/api/costs", entry("user-b"), { "Idempotency-Key": key });
  ok("R7 user: a different user posting with the SAME key text gets their own entry, not the first user's",
    a.status === 201 && b.status === 201 && String(a.data?.item?._id) !== String(b.data?.item?._id) && b.data?.item?.note === `${TAG}-user-b`,
    `a=${a.status} b=${b.status} bnote=${b.data?.item?.note}`);
  const stored = await rawCosts.find({ note: { $in: [`${TAG}-user-a`, `${TAG}-user-b`] } }).project({ idempotency_key: 1, note: 1 }).toArray();
  ok("R7 user: each row carries its own caller's id in the stored key",
    stored.some((r) => r.note.endsWith("user-a") && r.idempotency_key === `${adminRow._id}:${key}`)
      && stored.some((r) => r.note.endsWith("user-b") && r.idempotency_key === `${spocRow._id}:${key}`), JSON.stringify(stored));
  const bAgain = await req(spoc, "POST", "/api/costs", entry("user-b"), { "Idempotency-Key": key });
  ok("R7 user: the second user's own repeat still replays THEIR result", bAgain.status === 201 && String(bAgain.data?.item?._id) === String(b.data?.item?._id));
}

// ======================================================= R7 - parked path (rule ON)
let parkedA = null; // the request approved later, for the R5 join arm
{
  ok("[precondition] cost.post approval is ON for the parked-path arms", (await rule(true)).status === 200);
  const key = `k-park-${stamp}`;
  const first = await req(ops, "POST", "/api/costs", entry("park", { amount: 777 }), { "Idempotency-Key": key });
  const again = await req(ops, "POST", "/api/costs", entry("park", { amount: 777 }), { "Idempotency-Key": key });
  ok("R7 parked: the first POST parks (202)", first.status === 202 && !!first.data?.item?._id, `got ${first.status}`);
  ok("R7 parked: a repeat returns the SAME request, same status (202), and opens no second request",
    again.status === 202 && String(again.data?.item?._id) === String(first.data?.item?._id)
      && (await rawApprovals.countDocuments({ summary: { $regex: `${TAG}-park` } })) === 1,
    `got ${again.status}; requests=${await rawApprovals.countDocuments({ summary: { $regex: `${TAG}-park` } })}`);
  const reqRow = await rawApprovals.findOne({ _id: new ObjectId(first.data.item._id) });
  ok("R7 parked: the key is stored on the ApprovalRequest as '<user id>:<key>'", reqRow?.idempotency_key === `${opsRow._id}:${key}`, JSON.stringify(reqRow?.idempotency_key));
  ok("R7 parked: the key is not in the request payload or the 202 body",
    !JSON.stringify(reqRow?.payload ?? {}).includes(key) && !JSON.stringify(first.data).includes(key));

  const raceKey = `k-park-race-${stamp}`;
  const raced = await Promise.all(Array.from({ length: 8 }, () => req(ops, "POST", "/api/costs", entry("park-race"), { "Idempotency-Key": raceKey })));
  const ids = new Set(raced.map((r) => String(r.data?.item?._id)));
  ok("R7 parked race: eight parallel POSTs with one key ALL answer 202 with ONE request id",
    raced.every((r) => r.status === 202) && ids.size === 1, `${raced.map((r) => r.status).join(",")} ids=${ids.size}`);
  ok("R7 parked race: exactly ONE approval request exists (raw count)", (await rawApprovals.countDocuments({ summary: { $regex: `${TAG}-park-race` } })) === 1);

  // approve it, then repeat the POST: still the first result, and no ledger row appears from the repeat
  const approved = await req(approverB.cookie, "POST", `/api/approvals/${first.data.item._id}`, { decision: "Approved", note: "ok" });
  ok("[precondition] the second approver approves the parked request", approved.status === 200, `got ${approved.status} ${JSON.stringify(approved.data).slice(0, 120)}`);
  const after = await req(ops, "POST", "/api/costs", entry("park", { amount: 777 }), { "Idempotency-Key": key });
  ok("R7 parked: a repeat AFTER approval still returns the first request and posts nothing new",
    after.status === 202 && String(after.data?.item?._id) === String(first.data.item._id)
      && (await rawCosts.countDocuments({ note: `${TAG}-park` })) === 1,
    `got ${after.status}; costs=${await rawCosts.countDocuments({ note: `${TAG}-park` })}`);
  parkedA = { requestId: first.data.item._id };

  // Current authority belongs to the stored submission, never the retry body. Use a dedicated
  // Location session and the real user PATCH so the same live cookie observes revocation now.
  const scopedPoster = await mkUser(`Replay scope ${stamp}`, `zz.a3.replay.${stamp}@vidysea-test.local`, "Location", ["costs.manage"], [String(ownLoc._id)]);
  ok("R7 replay scope [precondition]: dedicated editable Location poster exists", !!scopedPoster.id && !!scopedPoster.cookie);
  const batchOnly = await db.collection("batches").findOne({ location: new ObjectId(String(ownLoc._id)), archived_at: null,
    deletion_state: { $exists: false }, status: { $nin: ["Completed", "Closed", "Cancelled"] } });
  const trainerOnly = await db.collection("trainers").findOne({ archived_at: null, $or: [
    { nominated_for_location: new ObjectId(String(ownLoc._id)) }, { home_location: new ObjectId(String(ownLoc._id)) },
    { capable_locations: new ObjectId(String(ownLoc._id)) },
  ] });
  ok("R7 empty-reference [precondition]: a live own-centre batch and scoped trainer exist", !!batchOnly && !!trainerOnly);
  for (const queued of [false, true]) {
    await rule(queued);
    for (const [dimension, association] of [["batch", batchOnly], ["trainer", trainerOnly]]) {
      const emptyKey = `k-empty-${dimension}-${queued}-${stamp}`, note = `empty-${dimension}-${queued}`;
      const submitted = entry(note, { location: "", batch: "", trainer: "", [dimension]: String(association?._id ?? "") });
      const original = await req(scopedPoster.cookie, "POST", "/api/costs", submitted, { "Idempotency-Key": emptyKey });
      const expectedStatus = queued ? 202 : 201;
      ok(`R7 empty-reference ${dimension} ${queued ? "queued" : "direct"}: actual first POST accepts explicit empty unused references`,
        original.status === expectedStatus && !!original.data?.item?._id, `got ${original.status}`);
      const collections = [rawCosts, rawApprovals, db.collection("auditlogs"), db.collection("costcategories"), db.collection("batches")];
      const before = await Promise.all(collections.map((collection) => collection.find({}).sort({ _id: 1 }).toArray()));
      const replay = await req(scopedPoster.cookie, "POST", "/api/costs", submitted, { "Idempotency-Key": emptyKey });
      const after = await Promise.all(collections.map((collection) => collection.find({}).sort({ _id: 1 }).toArray()));
      ok(`R7 empty-reference ${dimension} ${queued ? "queued" : "direct"}: replay returns first ID/status/header without effects`,
        replay.status === expectedStatus && String(replay.data?.item?._id) === String(original.data?.item?._id)
          && replay.headers.get("Idempotent-Replay") === "true" && JSON.stringify(after) === JSON.stringify(before), `got ${replay.status}`);
    }
  }
  await rule(false);
  const directKey = `k-revoke-direct-${stamp}`, queuedKey = `k-revoke-queued-${stamp}`;
  const directFirst = await req(scopedPoster.cookie, "POST", "/api/costs", entry("revoke-direct"), { "Idempotency-Key": directKey });
  await rule(true);
  const queuedFirst = await req(scopedPoster.cookie, "POST", "/api/costs", entry("revoke-queued", { amount: 846 }), { "Idempotency-Key": queuedKey });
  ok("R7 replay scope [precondition]: direct and queued originals were accepted at the original centre",
    directFirst.status === 201 && queuedFirst.status === 202 && !!directFirst.data?.item?._id && !!queuedFirst.data?.item?._id,
    `direct=${directFirst.status} queued=${queuedFirst.status}`);
  const scopeRevoked = await req(admin, "PATCH", `/api/users/${scopedPoster.id}`, { location_scope: [String(foreignLoc._id)] });
  ok("R7 replay scope [precondition]: real user API revoked the original centre and retained another centre", scopeRevoked.status === 200
    && JSON.stringify(scopeRevoked.data?.item?.location_scope) === JSON.stringify([String(foreignLoc._id)]));

  const rawAudits = db.collection("auditlogs");
  const directId = new ObjectId(String(directFirst.data.item._id)), queuedId = new ObjectId(String(queuedFirst.data.item._id));
  const costEventId = new ObjectId(), requestEventId = new ObjectId(), tombstoneEventId = new ObjectId(), tombstoneId = new ObjectId();
  const ownedAuditIds = [costEventId, requestEventId, tombstoneEventId];
  const now = new Date();
  const costEvent = { event_id: String(costEventId), entity: "CostEntry", entity_id: directId, field: "created", new_value: { amount: 321 }, actor: new ObjectId(String(scopedPoster.id)), actor_type: "USER" };
  const requestEvent = { event_id: String(requestEventId), entity: "ApprovalRequest", entity_id: queuedId, field: "status", old_value: "Applying", new_value: "Approved", actor: new ObjectId(String(approverB.id)), actor_type: "USER" };
  const tombstoneEvent = { event_id: String(tombstoneEventId), entity: "CostEntry", entity_id: tombstoneId, field: "deleted", old_value: { amount: 17 }, new_value: { deleted: true }, actor: new ObjectId(String(scopedPoster.id)), actor_type: "USER" };
  // The approved raw request is a drain owner only; the real partial-decision acceptance below
  // has its own fresh request and goes through the actual approver endpoint.
  await rawCosts.updateOne({ _id: directId }, { $push: { _audit_events: costEvent } });
  await rawApprovals.updateOne({ _id: queuedId }, { $set: { status: "Approved" }, $push: { _audit_events: requestEvent } });
  const tombstone = { ...(await rawCosts.findOne({ _id: directId })), _id: tombstoneId, note: `${TAG}-replay-tombstone`, amount: 17,
    deletion_state: "Pending", deletion_audit_event_id: String(tombstoneEventId), _audit_events: [tombstoneEvent], _audit_delivered_event_ids: [String(tombstoneEventId)] };
  delete tombstone.idempotency_key;
  delete tombstone.approval_request;
  try {
    await rawCosts.insertOne(tombstone);
    const { event_id, ...durableTombstoneEvent } = tombstoneEvent;
    await rawAudits.insertOne({ _id: tombstoneEventId, ...durableTombstoneEvent, created_at: now });
    const protectedCollections = [rawCosts, rawApprovals, rawAudits, db.collection("costcategories"), db.collection("batches")];
    const before = await Promise.all(protectedCollections.map((collection) => collection.find({}).sort({ _id: 1 }).toArray()));
    const pendingCost = before[0].find((row) => String(row._id) === String(directId));
    const pendingRequest = before[1].find((row) => String(row._id) === String(queuedId));
    const settledTombstone = before[0].find((row) => String(row._id) === String(tombstoneId));
    ok("R7 denied replay [precondition]: real undelivered cost/request audits and an acknowledged settled tombstone are drain-eligible",
      pendingCost?.reservation_state === "Applied" && pendingCost._audit_events.some((event) => event.event_id === String(costEventId))
        && !pendingCost._audit_delivered_event_ids?.includes(String(costEventId))
        && pendingRequest?.status === "Approved" && pendingRequest._audit_events.some((event) => event.event_id === String(requestEventId))
        && !pendingRequest._audit_delivered_event_ids?.includes(String(requestEventId))
        && settledTombstone?.deletion_state === "Pending" && settledTombstone._audit_delivered_event_ids?.includes(String(tombstoneEventId))
        && !before[2].some((row) => [String(costEventId), String(requestEventId)].includes(String(row._id)))
        && before[2].some((row) => String(row._id) === String(tombstoneEventId)));
    const beforeBytes = before.map((rows) => JSON.stringify(rows));
    for (const [kind, key] of [["direct", directKey], ["queued", queuedKey]]) {
      const denied = await req(scopedPoster.cookie, "POST", "/api/costs", entry(`revoke-${kind}`, { location: foreignLoc._id }), { "Idempotency-Key": key });
      ok(`R7 current scope: ${kind} replay is exactly 403 despite a currently permitted retry body`, denied.status === 403, `got ${denied.status}`);
      const after = await Promise.all(protectedCollections.map((collection) => collection.find({}).sort({ _id: 1 }).toArray()));
      const changed = after.map((rows, i) => JSON.stringify(rows) !== beforeBytes[i] ? protectedCollections[i].collectionName : null).filter(Boolean);
      ok(`R7 denied replay: ${kind} leaves raw costs, approvals, audits, outboxes, tombstone, categories and batches unchanged`, changed.length === 0, `changed=${changed.join(",")}`);
    }
    const restored = await req(admin, "PATCH", `/api/users/${scopedPoster.id}`, { location_scope: [String(ownLoc._id)] });
    ok("R7 replay scope [precondition]: original centre restored through the real user API", restored.status === 200);
    for (const [kind, key, original, status] of [["direct", directKey, directFirst, 201], ["queued", queuedKey, queuedFirst, 202]]) {
      const restoredReplay = await req(scopedPoster.cookie, "POST", "/api/costs", entry(`revoke-${kind}`, { location: foreignLoc._id, amount: 999 }), { "Idempotency-Key": key });
      ok(`R7 restored scope: ${kind} returns original ID/status/header and original requested amount despite foreign retry body`, restoredReplay.status === status
        && String(restoredReplay.data?.item?._id) === String(original.data.item._id)
        && restoredReplay.headers.get("Idempotent-Replay") === "true"
        && (status === 201 ? restoredReplay.data.item.amount === 321 : restoredReplay.data.item.payload?.amount === 846));
    }
    const drainedCost = await rawCosts.findOne({ _id: directId }), drainedRequest = await rawApprovals.findOne({ _id: queuedId });
    ok("R7 authorized replay positive: both pending audit events deliver exactly once and the settled tombstone is collected",
      drainedCost?._audit_delivered_event_ids?.includes(String(costEventId)) && drainedRequest?._audit_delivered_event_ids?.includes(String(requestEventId))
        && await rawAudits.countDocuments({ _id: { $in: [costEventId, requestEventId] } }) === 2 && !await rawCosts.findOne({ _id: tombstoneId }));
    ok("R7 restored scope: replay created no extra direct cost or queued request", await rawCosts.countDocuments({ note: `${TAG}-revoke-direct` }) === 1
      && await rawApprovals.countDocuments({ idempotency_key: `${scopedPoster.id}:${queuedKey}` }) === 1
      && await rawCosts.countDocuments({ note: `${TAG}-revoke-queued` }) === 0);

    // Fail closed on stored malformed/missing/foreign dimensions and inconsistent owners, even
    // though this caller and this retry body are legitimate. Restore exact owning raw rows first.
    const originals = [await rawCosts.findOne({ _id: directId }), await rawApprovals.findOne({ _id: queuedId })];
    for (const [kind, collection, id, key, original, changes, removes] of [
      ["direct malformed", rawCosts, directId, directKey, originals[0], { location: "not-an-id" }, {}],
      ["direct missing scope", rawCosts, directId, directKey, originals[0], {}, { location: "", batch: "", trainer: "" }],
      ["direct actor", rawCosts, directId, directKey, originals[0], { entered_by: adminRow._id }, {}],
      ["queued payload foreign", rawApprovals, queuedId, queuedKey, originals[1], { "payload.location": String(foreignLoc._id) }, {}],
      ["queued metadata foreign", rawApprovals, queuedId, queuedKey, originals[1], { location: new ObjectId(String(foreignLoc._id)) }, {}],
      ["queued malformed trainer", rawApprovals, queuedId, queuedKey, originals[1], { "payload.trainer": "not-an-id" }, {}],
      ["queued whitespace trainer", rawApprovals, queuedId, queuedKey, originals[1], { "payload.trainer": " " }, {}],
      ["queued actor", rawApprovals, queuedId, queuedKey, originals[1], { initiator: adminRow._id }, {}],
    ]) {
      try {
        await collection.updateOne({ _id: id }, { ...(Object.keys(changes).length ? { $set: changes } : {}), ...(Object.keys(removes).length ? { $unset: removes } : {}) });
        const state = await Promise.all(protectedCollections.map((collection) => collection.find({}).sort({ _id: 1 }).toArray()));
        const response = await req(scopedPoster.cookie, "POST", "/api/costs", entry("malformed-retry"), { "Idempotency-Key": key });
        const after = await Promise.all(protectedCollections.map((collection) => collection.find({}).sort({ _id: 1 }).toArray()));
        ok(`R7 stored authority: ${kind} refuses exactly 403 without effects`, response.status === 403 && JSON.stringify(after) === JSON.stringify(state), `got ${response.status}`);
      } finally { await collection.replaceOne({ _id: id }, original); }
    }
    await rule(false);
    for (const keyed of [true, false]) {
      const ordinaryEventId = new ObjectId();
      ownedAuditIds.push(ordinaryEventId);
      await rawCosts.updateOne({ _id: directId }, { $push: { _audit_events: { ...costEvent, event_id: String(ordinaryEventId) } } });
      await rawCosts.insertOne(tombstone);
      const seededOwner = await rawCosts.findOne({ _id: directId });
      ok(`R7 ordinary ${keyed ? "keyed" : "keyless"} drain [precondition]: pending audit and settled tombstone exist`,
        seededOwner._audit_events.some((event) => event.event_id === String(ordinaryEventId))
          && !seededOwner._audit_delivered_event_ids?.includes(String(ordinaryEventId)) && !!await rawCosts.findOne({ _id: tombstoneId })
          && await rawAudits.countDocuments({ _id: ordinaryEventId }) === 0);
      const posted = await req(scopedPoster.cookie, "POST", "/api/costs", entry(`ordinary-drain-${keyed}`), keyed ? { "Idempotency-Key": `k-ordinary-drain-${stamp}` } : {});
      const owner = await rawCosts.findOne({ _id: directId });
      ok(`R7 ordinary ${keyed ? "keyed" : "keyless"} success still drains pre-existing audit work and collects settled tombstones`, posted.status === 201
        && owner._audit_delivered_event_ids?.includes(String(ordinaryEventId)) && await rawAudits.countDocuments({ _id: ordinaryEventId }) === 1
        && !await rawCosts.findOne({ _id: tombstoneId }) && await rawCosts.countDocuments({ note: `${TAG}-ordinary-drain-${keyed}` }) === 1);
    }
  } finally {
    await rawCosts.deleteOne({ _id: tombstoneId });
    await rawAudits.deleteMany({ _id: { $in: ownedAuditIds } });
  }

  await rule(true);
  const moneyKey = `k-replay-money-${stamp}`, decisionNote = "Partial sanction; unrelated vendor total 919191";
  const moneyFirst = await req(scopedPoster.cookie, "POST", "/api/costs", entry("replay-money", { amount: 846 }), { "Idempotency-Key": moneyKey });
  const moneyDecision = await req(approverB.cookie, "POST", `/api/approvals/${moneyFirst.data?.item?._id}`, { decision: "Approved", approved_amount: 423, note: decisionNote });
  const moneyStored = await rawApprovals.findOne({ _id: new ObjectId(String(moneyFirst.data.item._id)) });
  ok("R7 replay money [precondition]: a real partial approval stored both sanctioned amount and unrelated-money decision prose",
    moneyFirst.status === 202 && moneyDecision.status === 200 && moneyStored?.approved_amount === 423 && moneyStored.decision_note === decisionNote,
    `post=${moneyFirst.status} decision=${moneyDecision.status}`);
  const moneyReplay = await req(scopedPoster.cookie, "POST", "/api/costs", entry("replay-money", { amount: 999 }), { "Idempotency-Key": moneyKey });
  ok("R7 replay money: nonfinance creator sees only original requested amount, no sanctioned amount or decision note",
    moneyReplay.status === 202 && String(moneyReplay.data?.item?._id) === String(moneyFirst.data.item._id)
      && moneyReplay.headers.get("Idempotent-Replay") === "true" && moneyReplay.data.item.payload?.amount === 846
      && !Object.hasOwn(moneyReplay.data.item, "approved_amount") && !Object.hasOwn(moneyReplay.data.item, "decision_note")
      && !JSON.stringify(moneyReplay.data).includes("919191"));
  const financeGrant = await req(admin, "PATCH", `/api/users/${scopedPoster.id}`, { extra_permissions: ["costs.manage", "finance.view"] });
  const financeReplay = await req(scopedPoster.cookie, "POST", "/api/costs", entry("replay-money"), { "Idempotency-Key": moneyKey });
  ok("R7 replay money positive: current finance grant reveals the original decision facts on the same request",
    financeGrant.status === 200 && financeReplay.status === 202 && String(financeReplay.data?.item?._id) === String(moneyFirst.data.item._id)
      && financeReplay.data.item.payload?.amount === 846 && financeReplay.data.item.approved_amount === 423 && financeReplay.data.item.decision_note === decisionNote);
  ok("R7 replay money: both visibility modes leave exactly one approval and its one partially sanctioned liability",
    await rawApprovals.countDocuments({ idempotency_key: `${scopedPoster.id}:${moneyKey}` }) === 1
      && await rawCosts.countDocuments({ note: `${TAG}-replay-money`, amount: 423 }) === 1);
  parkedA.replayMoneyRequestId = moneyFirst.data.item._id;
  await req(admin, "PATCH", `/api/users/${scopedPoster.id}`, { active: false });
}

// ======================================================= R7 - formula reservation frees the key
if (formulaId) {
  ok("[precondition] cost.post approval is OFF for the formula arm", (await rule(false)).status === 200);
  const key = `k-formula-${stamp}`;
  // No batch -> the Formula reservation is persisted (carrying the key) and then CANCELLED, and the
  // entry carries on as an ordinary liability under a fresh id. The cancelled fencing row must have
  // let go of the key or that second row can never be written.
  const first = await req(admin, "POST", "/api/costs", entry("formula", { category: formulaId, amount: 100 }), { "Idempotency-Key": key });
  ok("R7 formula: a Formula head whose reservation is cancelled still posts under the key (201)", first.status === 201, `got ${first.status} ${JSON.stringify(first.data).slice(0, 160)}`);
  const rows = await rawCosts.find({ note: `${TAG}-formula` }).toArray();
  ok("R7 formula [reaches the reservation]: a Formula fencing row WAS written and then Cancelled (so the arm is not vacuous on a head that never reserves)",
    rows.some((r) => r.reservation_state === "Cancelled"), JSON.stringify(rows.map((r) => ({ s: r.reservation_state, kind: r.reservation_kind }))));
  const keyed = rows.filter((r) => r.idempotency_key);
  ok("R7 formula: the cancelled fencing row no longer holds the key; exactly one row does",
    keyed.length === 1 && keyed[0].reservation_state !== "Cancelled", JSON.stringify(rows.map((r) => ({ s: r.reservation_state, k: !!r.idempotency_key }))));
  const again = await req(admin, "POST", "/api/costs", entry("formula", { category: formulaId, amount: 100 }), { "Idempotency-Key": key });
  ok("R7 formula: a repeat returns the first result", again.status === 201 && String(again.data?.item?._id) === String(first.data?.item?._id), `got ${again.status}`);
}

// ======================================================= R5 - approved by / approved on
const rows5 = {};
{
  // approval-backed (parked above, approved by approverB)
  const reqDoc = await rawApprovals.findOne({ _id: new ObjectId(parkedA.requestId) });
  rows5.approver = { note: `${TAG}-park`, decided_at: reqDoc?.decided_at, decided_by: String(reqDoc?.decided_by) };
  ok("[precondition] the approval-backed row was decided by the second approver, not the poster",
    String(reqDoc?.decided_by) === String(approverB.id) && String(reqDoc?.initiator) === String(opsRow._id) && !!reqDoc?.decided_at,
    JSON.stringify({ by: String(reqDoc?.decided_by), b: approverB.id }));

  // pre-approved (rule ON, within cap)
  await rule(true);
  const pre = await req(ops, "POST", "/api/costs", entry("preapproved", { category: capId, amount: 900 }));
  ok("[precondition] a within-cap entry on the capped head posts without a queue (201, pre-approved)", pre.status === 201 && pre.data?.item?.pre_approved_applied === true, `got ${pre.status}`);
  rows5.pre = { note: `${TAG}-preapproved` };
  // direct, Admin and Operations (rule OFF)
  await rule(false);
  const dAdmin = await req(admin, "POST", "/api/costs", entry("direct-admin"));
  const dOps = await req(ops, "POST", "/api/costs", entry("direct-ops"));
  ok("[precondition] two direct postings (Admin, Operations) exist", dAdmin.status === 201 && dOps.status === 201, `${dAdmin.status}/${dOps.status}`);
  // a foreign-location row approved by B, for the scope arm
  await rule(true);
  const fPark = await req(ops, "POST", "/api/costs", entry("foreign", { location: foreignLoc._id }));
  const fApprove = fPark.data?.item?._id ? await req(approverB.cookie, "POST", `/api/approvals/${fPark.data.item._id}`, { decision: "Approved", note: "ok" }) : { status: 0 };
  ok("[precondition] a foreign-centre cost approved by the second approver exists", fPark.status === 202 && fApprove.status === 200, `${fPark.status}/${fApprove.status}`);
  await rule(false);

  // Capture the oracle from the requests we actually created, before any reader and before the
  // later deliberate park-date rewrite. Approval IDs join liabilities; they are not cost IDs.
  const approvedFixtures = [];
  for (const fixture of [
    { requestId: parkedA.requestId, note: `${TAG}-park`, amount: 777 },
    { requestId: parkedA.replayMoneyRequestId, note: `${TAG}-replay-money`, amount: 423 },
    { requestId: fPark.data?.item?._id, note: `${TAG}-foreign`, amount: 321 },
  ]) {
    const requestId = new ObjectId(String(fixture.requestId));
    const approval = await rawApprovals.findOne({ _id: requestId });
    const liabilities = await rawCosts.find({ approval_request: requestId }).toArray();
    ok(`R5 filter fixture ${fixture.note}: its exact created request is Approved by B and joins exactly one intended liability`,
      approval?.status === "Approved" && String(approval.decided_by) === String(approverB.id)
        && approval.payload?.note === fixture.note && !!approval.decided_at && liabilities.length === 1
        && liabilities[0].note === fixture.note && liabilities[0].amount === fixture.amount,
      JSON.stringify({ requestId: fixture.requestId, costs: liabilities.map((row) => String(row._id)), status: approval?.status, by: String(approval?.decided_by) }));
    approvedFixtures.push({ ...fixture, costId: String(liabilities[0]?._id ?? ""), decided_at: approval?.decided_at });
  }
  ok("R5 filter fixture identities: all three created requests, joined costs and intended notes are distinct",
    new Set(approvedFixtures.map((fixture) => String(fixture.requestId))).size === approvedFixtures.length
      && new Set(approvedFixtures.map((fixture) => fixture.costId)).size === approvedFixtures.length
      && approvedFixtures.every((fixture) => !!fixture.costId)
      && new Set(approvedFixtures.map((fixture) => fixture.note)).size === approvedFixtures.length);
  const expectedApprovedTuples = approvedFixtures.map((fixture) => [fixture.costId, fixture.note]).sort((a, b) => a[0].localeCompare(b[0]));
  const day = istDay(rows5.approver.decided_at);
  ok("R5 date fixture precondition: all original approval decisions share the selected IST day before the later date rewrite",
    approvedFixtures.every((fixture) => fixture.decided_at && istDay(fixture.decided_at) === day),
    JSON.stringify(approvedFixtures.map((fixture) => ({ note: fixture.note, decided_at: fixture.decided_at }))));

  const ledger = (await req(admin, "GET", "/api/costs")).data?.items ?? [];
  const reg = (await req(admin, "GET", "/api/reports/costs")).data?.register ?? [];
  const byNote = (list, n) => list.find((r) => r.note === n);
  const L = (n) => byNote(ledger, n), G = (n) => byNote(reg, n);

  const lApprover = L(rows5.approver.note), gApprover = G(rows5.approver.note);
  ok("R5 join: the approval-backed row shows the APPROVER's name (decided_by), on the ledger and on the register",
    lApprover?.approved_by === approverName && gApprover?.approved_by === approverName,
    JSON.stringify({ ledger: lApprover?.approved_by, register: gApprover?.approved_by, poster: "Operations", expected: approverName }));
  ok("R5 join: ...and 'approved on' is the request's decided_at",
    !!lApprover?.approved_on && new Date(lApprover.approved_on).getTime() === new Date(rows5.approver.decided_at).getTime()
      && new Date(gApprover?.approved_on).getTime() === new Date(rows5.approver.decided_at).getTime(),
    JSON.stringify({ l: lApprover?.approved_on, g: gApprover?.approved_on, want: rows5.approver.decided_at }));
  ok("R5 join: ...and the stamp cites its field", String(lApprover?.approved_basis ?? "").includes("decided_by"), String(lApprover?.approved_basis));

  const lPre = L(rows5.pre.note), gPre = G(rows5.pre.note);
  ok("R5 label: a pre-approved posting shows 'Pre-approved' (from pre_approved_applied), not a person",
    lPre?.approved_by === "Pre-approved" && gPre?.approved_by === "Pre-approved" && lPre?.approved_by_kind === "pre-approved",
    JSON.stringify({ l: lPre?.approved_by, g: gPre?.approved_by }));
  ok("R5 label: ...with the posting time as its date, and the field cited",
    !!lPre?.approved_on && String(lPre?.approved_basis).includes("pre_approved_applied"), JSON.stringify({ on: lPre?.approved_on, basis: lPre?.approved_basis }));
  const lDA = L(`${TAG}-direct-admin`), lDO = L(`${TAG}-direct-ops`);
  ok("R5 label: an Admin's direct posting shows 'Direct (Admin)' and has no approval date",
    lDA?.approved_by === "Direct (Admin)" && lDA?.approved_on === null && G(`${TAG}-direct-admin`)?.approved_by === "Direct (Admin)",
    JSON.stringify({ by: lDA?.approved_by, on: lDA?.approved_on }));
  ok("R5 label: an Operations direct posting says 'Direct (Operations)' - the label follows the POSTER's role, it is not a constant",
    lDO?.approved_by === "Direct (Operations)" && G(`${TAG}-direct-ops`)?.approved_by === "Direct (Operations)", String(lDO?.approved_by));

  // ledger == register == Excel
  const xl = XLSX.read((await reqBuffer(admin, "/api/reports/costs/export")).data, { type: "buffer" });
  const xrows = XLSX.utils.sheet_to_json(xl.Sheets["cost entry register"]);
  const xl_ = (n) => xrows.find((r) => r.Description === n);
  const ymd = (d) => (d ? new Date(new Date(d).getTime() + 330 * 60_000).toISOString().slice(0, 10) : "—"); // IST day, like the export
  const same = [rows5.approver.note, rows5.pre.note, `${TAG}-direct-admin`, `${TAG}-direct-ops`].every((n) => {
    const l = L(n), g = G(n), x = xl_(n);
    return !!l && !!g && !!x && l.approved_by === g.approved_by && g.approved_by === x["Approved by"]
      && ymd(l.approved_on) === ymd(g.approved_on) && ymd(g.approved_on) === x["Approved on"];
  });
  ok("R5 one function: ledger, register and Excel export carry the SAME 'Approved by' and 'Approved on' for every kind of row", same,
    JSON.stringify([rows5.approver.note, `${TAG}-direct-ops`].map((n) => ({ l: L(n)?.approved_by, g: G(n)?.approved_by, x: xl_(n)?.["Approved by"], xo: xl_(n)?.["Approved on"] }))));

  // ---- filters (ledger + register)
  const mine = (list) => list.filter((r) => String(r.note ?? "").startsWith(TAG));
  const fl = async (qs) => mine((await req(admin, "GET", `/api/costs?${qs}`)).data?.items ?? []);
  const fg = async (qs) => (await req(admin, "GET", `/api/reports/costs?${qs}`)).data;
  const byB = await fl(`approved_by=${approverB.id}`);
  ok("R5 filter: approved_by=<approver> keeps exactly that approver's rows (ledger)",
    byB.length === approvedFixtures.length && byB.every((r) => r.approved_by === approverName)
      && JSON.stringify(byB.map((r) => [String(r._id), r.note]).sort((a, b) => a[0].localeCompare(b[0]))) === JSON.stringify(expectedApprovedTuples), JSON.stringify(byB.map((r) => r.note)));
  const gB = await fg(`approved_by=${approverB.id}`);
  ok("R5 filter: ...and on the register, where the KPI total narrows with it (totals.entries == register rows)",
    gB.register.every((r) => r.approved_by === approverName) && gB.totals.entries === gB.register.length
      && mine(gB.register).length === approvedFixtures.length
      && JSON.stringify(mine(gB.register).map((r) => [String(r.id), r.note]).sort((a, b) => a[0].localeCompare(b[0]))) === JSON.stringify(expectedApprovedTuples), JSON.stringify({ n: gB.register.length, t: gB.totals.entries }));
  const bPre = await fl("approved_by=pre-approved"), bDir = await fl("approved_by=direct");
  ok("R5 filter: approved_by=pre-approved keeps only pre-approved rows", bPre.length >= 1 && bPre.every((r) => r.approved_by_kind === "pre-approved") && bPre.some((r) => r.note === rows5.pre.note));
  ok("R5 filter: approved_by=direct keeps only direct rows, and not the approver's", bDir.length >= 4 && bDir.every((r) => r.approved_by_kind === "direct") && !bDir.some((r) => r.note === rows5.approver.note));
  const opts = (await req(admin, "GET", "/api/costs")).data?.approver_options ?? [];
  ok("R5 filter: the drop-down lists the real approver by name, plus Pre-approved and Direct",
    opts.some((o) => o.value === String(approverB.id) && o.label === approverName) && opts.some((o) => o.value === "pre-approved") && opts.some((o) => o.value === "direct"), JSON.stringify(opts.slice(0, 5)));
  const inDay = await fl(`approved_by=${approverB.id}&approved_from=${day}&approved_to=${day}`);
  const after = await fl(`approved_by=${approverB.id}&approved_from=${dayShift(day, 1)}`);
  const before = await fl(`approved_by=${approverB.id}&approved_to=${dayShift(day, -1)}`);
  ok("R5 filter: 'approved on' range includes the approval's own IST day and excludes the days either side",
    inDay.length === approvedFixtures.length
      && JSON.stringify(inDay.map((r) => [String(r._id), r.note]).sort((a, b) => a[0].localeCompare(b[0]))) === JSON.stringify(expectedApprovedTuples)
      && after.length === 0 && before.length === 0, `in=${inDay.length} after=${after.length} before=${before.length}`);
  const bad = await req(admin, "GET", "/api/costs?approved_by=not-a-user");
  ok("R5 filter: a nonsense approver is refused (400), not silently ignored", bad.status === 400, `got ${bad.status}`);
  const xf = XLSX.read((await reqBuffer(admin, `/api/reports/costs/export?approved_by=${approverB.id}`)).data, { type: "buffer" });
  const xfRows = XLSX.utils.sheet_to_json(xf.Sheets["cost entry register"]);
  ok("R5 filter: the Excel export honours the same filter", xfRows.length > 0 && xfRows.every((r) => r["Approved by"] === approverName), `n=${xfRows.length}`);

  // ---- permissions / masking unchanged
  const doors = await Promise.all([
    req(ungranted.cookie, "GET", `/api/costs?approved_by=direct`), req(ungranted.cookie, "GET", `/api/reports/costs?approved_by=direct`),
    reqBuffer(ungranted.cookie, "/api/reports/costs/export?approved_by=direct"), req(spoc, "GET", "/api/costs?approved_by=direct"),
  ]);
  ok("R5 permissions: an Admin with no finance grant, and a location user, are still refused (403) on every door with the new filter",
    doors.every((d) => d.status === 403), doors.map((d) => d.status).join(","));

  // ---- scope: a location-scoped finance viewer sees only their centre
  const scoped = await mkUser(`Scoped viewer ${stamp}`, `zz.a3.scoped.${stamp}@vidysea-test.local`, "Location", ["finance.view"], [ownLoc._id]);
  if (scoped.cookie) {
    const sl = (await req(scoped.cookie, "GET", `/api/costs?approved_by=${approverB.id}`)).data?.items ?? [];
    const sg = (await req(scoped.cookie, "GET", `/api/reports/costs?approved_by=${approverB.id}`)).data?.register ?? [];
    ok("R5 scope: a location-scoped finance viewer never sees the foreign-centre row, on the ledger or the register",
      !sl.some((r) => r.note === `${TAG}-foreign`) && !sg.some((r) => r.note === `${TAG}-foreign`) && sl.some((r) => r.note === rows5.approver.note),
      JSON.stringify({ ledger: sl.map((r) => r.note), register: sg.map((r) => r.note) }));
  } else ok("R5 scope [precondition]: a location-scoped finance viewer can sign in", false, JSON.stringify(scoped.made.data).slice(0, 160));
  ok("R5 scope: the all-centres reader does see the foreign-centre row (the arm above is not vacuous)", !!L(`${TAG}-foreign`));

  // ===================================================== R9 - payment status
  const target = L(`${TAG}-direct-admin`);
  const paid = await req(admin, "PATCH", `/api/costs/${target._id}`, { mark_paid: true, vendor_payee: "Vendor X", payment_ref: `UTR-${stamp}`, payment_mode: "UPI" });
  ok("[precondition] one entry is marked Paid", paid.status === 200, `got ${paid.status} ${JSON.stringify(paid.data).slice(0, 100)}`);
  const lPaid = await fl("payment_status=Paid"), lPend = await fl("payment_status=Payment%20Pending");
  ok("R9 filter (ledger): payment_status=Paid returns only Paid rows, and includes the one just paid",
    lPaid.length >= 1 && lPaid.every((r) => r.payment_status === "Paid") && lPaid.some((r) => String(r._id) === String(target._id)), JSON.stringify(lPaid.map((r) => r.payment_status)));
  ok("R9 filter (ledger): payment_status=Payment Pending returns only pending rows and excludes the paid one",
    lPend.length >= 3 && lPend.every((r) => r.payment_status === "Payment Pending") && !lPend.some((r) => String(r._id) === String(target._id)));
  const gPaid = await fg("payment_status=Paid"), gPend = await fg("payment_status=Payment%20Pending");
  ok("R9 filter (register): same rule, and the KPI total narrows with it",
    gPaid.register.length >= 1 && gPaid.register.every((r) => r.payment_status === "Paid") && gPaid.totals.entries === gPaid.register.length
      && gPend.register.every((r) => r.payment_status === "Payment Pending") && gPend.totals.entries === gPend.register.length,
    JSON.stringify({ paid: gPaid.register.length, pend: gPend.register.length }));
  const all = await fg("");
  // QA-2911: the old form compared the two filtered lengths with the WHOLE unfiltered register. On a shared
  // database (the wall) any earlier suite's rows that carry no payment_status at all (it is optional on the
  // schema, so they belong to NEITHER filter) made the totals differ, red in the wall and green alone. The
  // partition is asserted over THIS suite's own rows (note starts with TAG), by id: every one of our rows that
  // is Paid or Payment Pending must come back from exactly one of the two filters, and no id may come back
  // from both. A filter that drops one of our rows, or returns it twice, still fails (the set is compared,
  // not a count). The non-vacuity guard demands both partitions carry at least one of our rows.
  const ownReg = (rows) => rows.filter((r) => String(r.note ?? "").startsWith(TAG));
  const ownAll = ownReg(all.register).filter((r) => r.payment_status === "Paid" || r.payment_status === "Payment Pending");
  const ownPaidIds = ownReg(gPaid.register).map((r) => r.id), ownPendIds = ownReg(gPend.register).map((r) => r.id);
  const expectIds = ownAll.map((r) => r.id).sort().join(",");
  ok("R9 filter: Paid + Pending partition the unfiltered register (nothing lost, nothing double-counted)",
    ownPaidIds.length >= 1 && ownPendIds.length >= 1 && expectIds.length > 0
      && [...ownPaidIds, ...ownPendIds].sort().join(",") === expectIds
      && ownPaidIds.every((id) => !ownPendIds.includes(id)),
    `own paid=${ownPaidIds.length} pend=${ownPendIds.length} own paid-or-pending in the unfiltered register=${ownAll.length}`);
  const bp = await req(admin, "GET", "/api/costs?payment_status=Settled");
  ok("R9 filter: an unknown payment status is refused (400), not silently ignored", bp.status === 400, `got ${bp.status}`);
  const xp = XLSX.read((await reqBuffer(admin, "/api/reports/costs/export?payment_status=Paid")).data, { type: "buffer" });
  const xpRows = XLSX.utils.sheet_to_json(xp.Sheets["cost entry register"]);
  ok("R9 filter: the Excel export honours payment_status", xpRows.length === gPaid.register.length && xpRows.every((r) => r["Payment status"] === "Paid"), `x=${xpRows.length} g=${gPaid.register.length}`);
  ok("R9 filter: variance/budget go to '—' under a payment filter, as for every other narrowing filter", gPaid.totals.budget_comparable === false);
}

// ======================================================= review fixes (senior-software-engineer, mtg-a3)
{
  // IST day in the export: 2026-09-08T20:00Z is 01:30 on the 9th in India; a UTC slice would say the 8th.
  await rawApprovals.updateOne({ _id: new ObjectId(parkedA.requestId) }, { $set: { decided_at: new Date("2026-09-08T20:00:00Z") } });
  const xi = XLSX.read((await reqBuffer(admin, "/api/reports/costs/export")).data, { type: "buffer" });
  const xir = XLSX.utils.sheet_to_json(xi.Sheets["cost entry register"]).find((r) => r.Description === `${TAG}-park`);
  ok("R5 export: 'Approved on' is the IST day (decided 20:00 UTC on the 8th reads 2026-09-09)", xir?.["Approved on"] === "2026-09-09", String(xir?.["Approved on"]));

  // GET /api/costs?location= intersects the caller's scope
  const scopedV = await mkUser(`Scoped viewer2 ${stamp}`, `zz.a3.scoped2.${stamp}@vidysea-test.local`, "Location", ["finance.view"], [ownLoc._id]);
  ok("[precondition] a location-scoped finance viewer can sign in", !!scopedV.cookie, JSON.stringify(scopedV.made.data).slice(0, 160));
  const foreignQ = await req(scopedV.cookie, "GET", `/api/costs?location=${foreignLoc._id}`);
  ok("scope: a scoped user naming a FOREIGN centre on the ledger is refused (403), not handed that centre's rows (and by the SCOPE rule, not some other 403)", foreignQ.status === 403 && /scope/i.test(JSON.stringify(foreignQ.data)), `got ${foreignQ.status} items=${foreignQ.data?.items?.length}`);
  const ownQ = await req(scopedV.cookie, "GET", `/api/costs?location=${ownLoc._id}`);
  ok("scope: naming their OWN centre still works (200)", ownQ.status === 200, `got ${ownQ.status}`);

  // All four date keys must be real calendar days on every finance reader. The invalid reads run
  // BEFORE any valid read: Costs GET drains audit owners, so an empty queue would prove nothing.
  // Guard-removal falsification: remove parseCostFilters' calendar loop; the exact-400 arm must go
  // red, and an invalid Costs GET must also turn this seeded raw zero-write arm red by draining it.
  {
    const rawAudits = db.collection("auditlogs");
    const dateNotes = ["before", "leap", "after"].map((suffix) => `${TAG}-calendar-${suffix}`);
    const dateDays = ["2024-02-28", "2024-02-29", "2024-03-01"];
    const dateCostIds = dateDays.map(() => new ObjectId());
    const dateRequestIds = dateDays.map(() => new ObjectId());
    const dateAmounts = [281, 292, 303];
    const costEventId = new ObjectId(), approvalEventId = new ObjectId(), tombstoneEventId = new ObjectId();
    const tombstoneId = new ObjectId();
    const dateNow = new Date();
    const dateCosts = dateDays.map((day, i) => ({
      _id: dateCostIds[i], entry_date: new Date(`${day}T00:00:00Z`),
      location: new ObjectId(String(ownLoc._id)), category: new ObjectId(String(plain._id)),
      amount: dateAmounts[i], note: dateNotes[i], entered_by: adminRow._id,
      approval_request: dateRequestIds[i], reservation_state: "Applied", payment_status: "Payment Pending",
      createdAt: new Date(`${day}T12:01:00+05:30`), updatedAt: new Date(`${day}T12:01:00+05:30`),
    }));
    dateCosts[1]._audit_events = [{
      event_id: costEventId.toHexString(), entity: "CostEntry", entity_id: dateCostIds[1], field: null,
      old_value: null, new_value: { amount: dateAmounts[1], note: dateNotes[1] }, actor: adminRow._id, actor_type: "USER",
    }];
    dateCosts[1]._audit_delivered_event_ids = [];
    const dateRequests = dateDays.map((day, i) => ({
      _id: dateRequestIds[i], action: "cost.post", entity: "CostEntry", entity_id: dateCostIds[i],
      summary: dateNotes[i], payload: { entry_date: day, location: String(ownLoc._id), category: String(plain._id), amount: dateAmounts[i], note: dateNotes[i] },
      location: new ObjectId(String(ownLoc._id)), initiator: adminRow._id, approver_role: "Admin",
      status: "Approved", approved_amount: dateAmounts[i], decided_by: new ObjectId(String(approverB.id)),
      decided_at: new Date(`${day}T12:00:00+05:30`), createdAt: new Date(`${day}T08:00:00+05:30`), updatedAt: new Date(`${day}T12:00:00+05:30`),
    }));
    dateRequests[1]._audit_events = [{
      event_id: approvalEventId.toHexString(), entity: "ApprovalRequest", entity_id: dateRequestIds[1],
      field: "status", old_value: "Applying", new_value: "Approved", actor: new ObjectId(String(approverB.id)), actor_type: "USER",
    }];
    dateRequests[1]._audit_delivered_event_ids = [];
    // This is the hidden hard-delete tombstone (not a recoverable archived cost): a normal drain
    // collects it even though its deletion event is already acknowledged and needs no new delivery.
    const tombstoneCost = { ...dateCosts[0], _id: tombstoneId, note: `${TAG}-calendar-tombstone`, amount: 17, updatedAt: dateNow };
    delete tombstoneCost.approval_request; // omit it, rather than storing null in the unique sparse index
    const tombstoneEvent = {
      event_id: tombstoneEventId.toHexString(), entity: "CostEntry", entity_id: tombstoneId, field: "deleted",
      old_value: {
        entry_date: tombstoneCost.entry_date, location: tombstoneCost.location, batch: null, trainer: null,
        category: tombstoneCost.category, amount: tombstoneCost.amount, vendor_payee: null, voucher_no: null,
        payment_mode: null, paid_on: null, payment_ref: null, note: tombstoneCost.note,
      },
      new_value: { deleted: true, reason: "calendar refusal fixture" }, actor: adminRow._id, actor_type: "USER",
    };
    const dateState = async () => {
      const [costs, approvals, audits] = await Promise.all([
        rawCosts.find({}).sort({ _id: 1 }).toArray(), rawApprovals.find({}).sort({ _id: 1 }).toArray(),
        rawAudits.find({}).sort({ _id: 1 }).toArray(),
      ]);
      return { costs, approvals, audits };
    };
    try {
      await rawCosts.insertMany([...dateCosts, {
        ...tombstoneCost, deletion_state: "Pending", deletion_audit_event_id: tombstoneEvent.event_id,
        _audit_events: [tombstoneEvent], _audit_delivered_event_ids: [tombstoneEvent.event_id],
      }]);
      await rawApprovals.insertMany(dateRequests);
      const { event_id, ...durableTombstoneEvent } = tombstoneEvent;
      await rawAudits.insertOne({ _id: tombstoneEventId, ...durableTombstoneEvent, created_at: dateNow });
      const dateBefore = await dateState();
      const queuedCost = dateBefore.costs.find((r) => String(r._id) === String(dateCostIds[1]));
      const queuedRequest = dateBefore.approvals.find((r) => String(r._id) === String(dateRequestIds[1]));
      const settledTombstone = dateBefore.costs.find((r) => String(r._id) === String(tombstoneId));
      ok("calendar refusal [precondition]: Applied cost and Approved request have undelivered audits; an acknowledged deletion tombstone is drain-eligible",
        queuedCost?.reservation_state === "Applied" && queuedCost._audit_events?.[0]?.event_id === costEventId.toHexString()
          && queuedCost._audit_delivered_event_ids?.length === 0
          && queuedRequest?.status === "Approved" && queuedRequest._audit_events?.[0]?.event_id === approvalEventId.toHexString()
          && queuedRequest._audit_delivered_event_ids?.length === 0
          && settledTombstone?.deletion_state === "Pending" && settledTombstone.deletion_audit_event_id === tombstoneEvent.event_id
          && settledTombstone._audit_delivered_event_ids?.includes(tombstoneEvent.event_id)
          && !dateBefore.audits.some((r) => [String(costEventId), String(approvalEventId)].includes(String(r._id)))
          && dateBefore.audits.some((r) => String(r._id) === String(tombstoneEventId)));
      const beforeBytes = Object.fromEntries(Object.entries(dateBefore).map(([k, rows]) => [k, JSON.stringify(rows)]));
      const doors = [
        ["Costs", "/api/costs"], ["Finance", "/api/reports/costs"], ["Excel", "/api/reports/costs/export"],
      ];
      const invalidDays = ["2026-13-01", "2026-02-29"];
      const invalidQueries = ["approved_from=2026-02-31", ...["from", "to", "approved_from", "approved_to"]
        .flatMap((key) => invalidDays.map((day) => `${key}=${day}`))];
      let badDay;
      for (const [door, path] of doors) {
        for (const query of invalidQueries) {
          // Keep the original rolled-over approval-date assertion on Costs; the two-class matrix
          // covers every key on every door without multiplying redundant ordinary-day examples.
          if (query === "approved_from=2026-02-31" && door !== "Costs") continue;
          const response = door === "Excel" ? await reqBuffer(admin, `${path}?${query}`) : await req(admin, "GET", `${path}?${query}`);
          if (query === "approved_from=2026-02-31") badDay = response;
          ok(`calendar refusal: ${door} ${query} returns exactly 400`, response.status === 400, `got ${response.status}`);
          const after = await dateState();
          const changed = Object.keys(beforeBytes).filter((k) => JSON.stringify(after[k]) !== beforeBytes[k]);
          ok(`calendar refusal: ${door} ${query} leaves raw money, requests, audits and outbox/tombstone ownership unchanged`,
            changed.length === 0, `changed=${changed.join(",")}`);
        }
      }
      // First valid read is the negative control: these exact queues MUST deliver and the settled
      // tombstone MUST disappear, proving the invalid no-write assertions had something to protect.
      const goodDay = await req(admin, "GET", "/api/costs?approved_from=2026-02-28");
      ok("R5 filter: a date that is not a real day (2026-02-31) is a 400, a real one is a 200", badDay.status === 400 && goodDay.status === 200, `${badDay.status}/${goodDay.status}`);
      const drainedCost = await rawCosts.findOne({ _id: dateCostIds[1] });
      const drainedRequest = await rawApprovals.findOne({ _id: dateRequestIds[1] });
      ok("calendar refusal negative control: a valid Costs GET delivers both pending events exactly once and collects the settled deletion tombstone",
        goodDay.status === 200 && drainedCost?._audit_delivered_event_ids?.includes(costEventId.toHexString())
          && drainedRequest?._audit_delivered_event_ids?.includes(approvalEventId.toHexString())
          && await rawAudits.countDocuments({ _id: { $in: [costEventId, approvalEventId] } }) === 2
          && !await rawCosts.findOne({ _id: tombstoneId }));

      const leapCases = [
        { query: "from=2024-02-29", finance: [1, 2], costs: [0, 1, 2] },
        { query: "to=2024-02-29", finance: [0, 1], costs: [0, 1, 2] },
        { query: "approved_from=2024-02-29", finance: [1, 2], costs: [1, 2] },
        { query: "approved_to=2024-02-29", finance: [0, 1], costs: [0, 1] },
        { query: "from=2024-02-29&to=2024-02-29", finance: [1], costs: [0, 1, 2] },
        { query: "approved_from=2024-02-29&approved_to=2024-02-29", finance: [1], costs: [1] },
      ];
      for (const test of leapCases) {
        const ledger = await req(admin, "GET", `/api/costs?${test.query}`);
        const finance = await req(admin, "GET", `/api/reports/costs?${test.query}`);
        const excel = await reqBuffer(admin, `/api/reports/costs/export?${test.query}`);
        const register = finance.data?.register ?? [];
        const workbook = excel.status === 200 ? XLSX.read(excel.data, { type: "buffer" }) : null;
        const xRows = workbook ? XLSX.utils.sheet_to_json(workbook.Sheets["cost entry register"]) : [];
        ok(`calendar leap-day: all three readers accept ${test.query} (200)`,
          ledger.status === 200 && finance.status === 200 && excel.status === 200, `${ledger.status}/${finance.status}/${excel.status}`);
        const ledgerIds = (ledger.data?.items ?? []).filter((r) => dateNotes.includes(r.note)).map((r) => String(r._id)).sort();
        const expectedLedger = test.costs.map((i) => String(dateCostIds[i])).sort();
        ok(`calendar leap-day: Costs ${test.query} has exactly the expected fixture IDs (valid from/to remain ignored)`,
          JSON.stringify(ledgerIds) === JSON.stringify(expectedLedger), `${ledgerIds.length}/${expectedLedger.length}`);
        const registerIds = register.filter((r) => dateNotes.includes(r.note)).map((r) => String(r.id)).sort();
        const expectedRegister = test.finance.map((i) => String(dateCostIds[i])).sort();
        const excelNotes = xRows.filter((r) => dateNotes.includes(r.Description)).map((r) => r.Description).sort();
        const expectedNotes = test.finance.map((i) => dateNotes[i]).sort();
        ok(`calendar leap-day: Finance/Excel ${test.query} include the known leap fixtures and exclude the known neighbouring days`,
          JSON.stringify(registerIds) === JSON.stringify(expectedRegister) && JSON.stringify(excelNotes) === JSON.stringify(expectedNotes),
          `finance=${registerIds.length} excel=${excelNotes.length} expected=${expectedNotes.length}`);
        const registerRows = register.map((r) => JSON.stringify([
          r.note, r.amount, new Date(r.entry_date).toISOString().slice(0, 10), r.approved_on ? istDay(r.approved_on) : "—",
        ])).sort();
        const excelRows = xRows.map((r) => JSON.stringify([r.Description, r.Amount, r.Date, r["Approved on"]])).sort();
        ok(`calendar leap-day: Finance and Excel ${test.query} have identical rows, dates and amounts; Finance totals tie`,
          JSON.stringify(registerRows) === JSON.stringify(excelRows) && finance.data?.totals?.entries === register.length
            && finance.data?.totals?.actual === register.reduce((sum, r) => sum + r.amount, 0), `finance=${register.length} excel=${xRows.length}`);
      }
    } finally {
      await rawCosts.deleteMany({ _id: { $in: [...dateCostIds, tombstoneId] } });
      await rawApprovals.deleteMany({ _id: { $in: dateRequestIds } });
      await rawAudits.deleteMany({ _id: { $in: [costEventId, approvalEventId, tombstoneEventId] } });
    }
  }

  // an orphaned (expired) Formula reservation must not park the key behind a 409 for ever
  const adminId = String(adminRow._id);
  const reserve = (suffix, expiresAt) => rawCosts.insertOne({
    entry_date: "2026-09-07", location: new ObjectId(String(ownLoc._id)), category: new ObjectId(String(formulaId)), amount: 77,
    note: `${TAG}-resv-${suffix}`, entered_by: adminRow._id, reservation_state: "Pending", reservation_kind: "Formula",
    reservation_expires_at: expiresAt, idempotency_key: `${adminId}:k-resv-${suffix}-${stamp}`, createdAt: new Date(), updatedAt: new Date(),
  });
  await rule(false);
  await reserve("dead", new Date(Date.now() - 60_000));
  const deadKey = `k-resv-dead-${stamp}`;
  const t0 = Date.now();
  const afterDead = await req(admin, "POST", "/api/costs", entry("after-dead"), { "Idempotency-Key": deadKey });
  const deadRow = await rawCosts.findOne({ note: `${TAG}-resv-dead` });
  ok("R7 reservation: an EXPIRED Pending reservation holding the key is cancelled and the POST goes through (201, no 10 s wait)",
    afterDead.status === 201 && Date.now() - t0 < 8000 && deadRow?.reservation_state === "Cancelled" && !deadRow?.idempotency_key,
    `status=${afterDead.status} ms=${Date.now() - t0} state=${deadRow?.reservation_state} key=${deadRow?.idempotency_key}`);
  await reserve("live", new Date(Date.now() + 120_000));
  const liveKey = `k-resv-live-${stamp}`;
  const afterLive = await req(admin, "POST", "/api/costs", entry("after-live"), { "Idempotency-Key": liveKey });
  const afterLiveRows = await rawCosts.countDocuments({ note: `${TAG}-after-live` });
  ok("R7 reservation: a LIVE Pending reservation holding the key is in flight - the repeat is refused (409) and creates nothing",
    afterLive.status === 409 && afterLiveRows === 0, `status=${afterLive.status} rows=${afterLiveRows}`);
  await rawCosts.updateOne({ note: `${TAG}-resv-live` }, { $set: { reservation_state: "Cancelled" }, $unset: { idempotency_key: "", reservation_expires_at: "" } });
}

// ======================================================= Q-1007a - two cost-head money rules (Umesh, 2026-10-07 ~16:40 IST)
// (a) QA-2889, "Limit badhana bhi 2-person": raising the pre-approved cap of an APPROVED head does not
//     take effect until a finance approver other than the person who raised it approves it; the old
//     cap keeps working until then.
// (b) QA-2888, "Pending head pe cost hamesha roko": a cost under a Pending (or Rejected) head waits
//     for approval even when the cost.post rule is OFF, until the head is approved.
// Each arm reads the raw collections, never only the HTTP reply. The guarantee arms (the head's own
// stored cap unchanged; zero ledger rows) are the ones that go red when the lock is removed.
{
  const rawCats = db.collection("costcategories");
  const oid = (id) => new ObjectId(String(id));
  const costCount = (headId, note) => rawCosts.countDocuments({ category: oid(headId), note: `${TAG}-q1007a-${note}` });
  const parkedCount = (headId) => rawApprovals.countDocuments({ action: "cost.post", status: "Pending", "payload.category": { $in: [String(headId), oid(headId)] } });
  const q = (note, extra = {}) => entry(`q1007a-${note}`, extra);

  // ---- (a) raise the cap of the Approved, capped head: it waits for a second finance approver
  await rule(true);
  const capBefore = await rawCats.findOne({ _id: oid(capId) });
  const raise = await req(admin, "PATCH", `/api/master-lists/cost-categories/${capId}`, { pre_approved_amount: 9000 });
  const raiseReq = raise.data?.pending_cap_approval?.request_id;
  ok("Q-1007a (a) [precondition]: the head is Approved with cap 5000 and the raise was accepted as a PROPOSAL, not applied",
    capBefore?.approval_status !== "Pending" && capBefore?.pre_approved_amount === 5000 && raise.status === 200 && !!raiseReq,
    JSON.stringify({ st: capBefore?.approval_status, cap: capBefore?.pre_approved_amount, http: raise.status, req: raiseReq }));
  ok("Q-1007a (a): the raise is not applied - the stored cap is still 5000 (raw)", (await rawCats.findOne({ _id: capBefore._id }))?.pre_approved_amount === 5000);
  const withinOld = await req(ops, "POST", "/api/costs", q("a-within", { category: capId, amount: 4000 }));
  ok("Q-1007a (a): the OLD cap still applies meanwhile - 4000 posts pre-approved (201)", withinOld.status === 201 && withinOld.data?.item?.pre_approved_applied === true, `got ${withinOld.status}`);
  const betweenCaps = await req(ops, "POST", "/api/costs", q("a-between", { category: capId, amount: 6000 }));
  ok("Q-1007a (a): 6000 is above the old cap and below the proposed one - it waits (202) and writes no ledger row",
    betweenCaps.status === 202 && betweenCaps.data?.queued === true && await costCount(capId, "a-between") === 0, `got ${betweenCaps.status} rows=${await costCount(capId, "a-between")}`);
  const selfDecide = raiseReq ? await req(admin, "POST", `/api/approvals/${raiseReq}`, { decision: "Approved", note: "raiser approving own raise" }) : { status: 0 };
  ok("Q-1007a (a): the person who raised the cap cannot approve it (403) and the stored cap is still 5000",
    selfDecide.status === 403 && (await rawCats.findOne({ _id: capBefore._id }))?.pre_approved_amount === 5000, `got ${selfDecide.status}`);
  const otherDecide = raiseReq ? await req(approverB.cookie, "POST", `/api/approvals/${raiseReq}`, { decision: "Approved", note: "second finance approver" }) : { status: 0 };
  ok("Q-1007a (a): a different finance approver approves it (200) and only then does the stored cap become 9000",
    otherDecide.status === 200 && (await rawCats.findOne({ _id: capBefore._id }))?.pre_approved_amount === 9000, `got ${otherDecide.status}`);
  const afterNew = await req(ops, "POST", "/api/costs", q("a-after", { category: capId, amount: 6000 }));
  ok("Q-1007a (a): once approved, the new cap applies - 6000 posts pre-approved (201)", afterNew.status === 201 && afterNew.data?.item?.pre_approved_applied === true, `got ${afterNew.status}`);

  // ---- (b) the cost.post rule is OFF: a cost under a Pending / Rejected head still waits
  const mkHead = async (name) => (await req(admin, "POST", "/api/master-lists/cost-categories", {
    name: `ZZ Q1007a ${name} ${stamp}`, pre_approved: true, pre_approved_amount: 5000, pre_approved_basis: "q1007a",
  })).data?.item?._id;
  const pendingHead = await mkHead("Pending");
  const rejectedHead = await mkHead("Rejected");
  const rejReq = rejectedHead ? await rawApprovals.findOne({ action: "costcategory.create", entity_id: oid(rejectedHead), status: "Pending" }) : null;
  const rejected = rejReq ? await req(approverB.cookie, "POST", `/api/approvals/${rejReq._id}`, { decision: "Rejected", note: "q1007a fixture" }) : { status: 0 };
  const pH = pendingHead ? await rawCats.findOne({ _id: oid(pendingHead) }) : null;
  const rH = rejectedHead ? await rawCats.findOne({ _id: oid(rejectedHead) }) : null;
  ok("Q-1007a (b) [precondition]: one capped head is Pending, one is Rejected, and both are capped",
    pH?.approval_status === "Pending" && rH?.approval_status === "Rejected" && rejected.status === 200 && pH?.pre_approved_amount === 5000 && rH?.pre_approved_amount === 5000,
    JSON.stringify({ p: pH?.approval_status, r: rH?.approval_status, rej: rejected.status }));
  ok("Q-1007a (b) [precondition]: cost.post approval is OFF", (await rule(false)).status === 200);
  const underPending = await req(ops, "POST", "/api/costs", q("b-pending", { category: pendingHead, amount: 100 }));
  ok("Q-1007a (b): rule OFF, Pending head, amount inside its cap - waits (202), zero ledger rows, one parked request",
    underPending.status === 202 && underPending.data?.queued === true && await costCount(pendingHead, "b-pending") === 0 && await parkedCount(pendingHead) === 1,
    `got ${underPending.status} rows=${await costCount(pendingHead, "b-pending")} parked=${await parkedCount(pendingHead)}`);
  const underRejected = await req(ops, "POST", "/api/costs", q("b-rejected", { category: rejectedHead, amount: 100 }));
  ok("Q-1007a (b): rule OFF, Rejected head - waits (202), zero ledger rows, one parked request",
    underRejected.status === 202 && underRejected.data?.queued === true && await costCount(rejectedHead, "b-rejected") === 0 && await parkedCount(rejectedHead) === 1,
    `got ${underRejected.status} rows=${await costCount(rejectedHead, "b-rejected")} parked=${await parkedCount(rejectedHead)}`);
  const control = await req(ops, "POST", "/api/costs", q("b-control", { category: capId, amount: 100 }));
  ok("Q-1007a (b) [control]: rule OFF, the APPROVED head posts straight to the ledger (201) - the wait follows the head, not the rule",
    control.status === 201 && await costCount(capId, "b-control") === 1, `got ${control.status}`);
  const parkedUnderRejected = await rawApprovals.findOne({ action: "cost.post", status: "Pending", "payload.category": { $in: [String(rejectedHead), oid(rejectedHead)] } });
  const rejectedReplay = parkedUnderRejected ? await req(approverB.cookie, "POST", `/api/approvals/${parkedUnderRejected._id}`, { decision: "Approved", note: "q1007a" }) : { status: 0 };
  ok("Q-1007a (b): the cost parked under the Rejected head cannot be approved (409) and still writes no ledger row",
    rejectedReplay.status === 409 && await costCount(rejectedHead, "b-rejected") === 0, `got ${rejectedReplay.status}`);
  const parkedUnderPending = await rawApprovals.findOne({ action: "cost.post", status: "Pending", "payload.category": { $in: [String(pendingHead), oid(pendingHead)] } });
  const earlyReplay = parkedUnderPending ? await req(approverB.cookie, "POST", `/api/approvals/${parkedUnderPending._id}`, { decision: "Approved", note: "q1007a early" }) : { status: 0 };
  ok("Q-1007a (b): the cost parked under the Pending head cannot be approved before the head is (409) and writes no ledger row",
    earlyReplay.status === 409 && await costCount(pendingHead, "b-pending") === 0, `got ${earlyReplay.status}`);
  ok("Q-1007a (b): the Pending head is signed off by the second approver", (await signOff(pendingHead)) === 200);
  const afterSignOff = await req(ops, "POST", "/api/costs", q("b-after", { category: pendingHead, amount: 100 }));
  ok("Q-1007a (b): once the head is approved and the rule is still OFF, the cost posts (201)", afterSignOff.status === 201 && await costCount(pendingHead, "b-after") === 1, `got ${afterSignOff.status}`);
  const lateReplay = parkedUnderPending ? await req(approverB.cookie, "POST", `/api/approvals/${parkedUnderPending._id}`, { decision: "Approved", note: "q1007a late" }) : { status: 0 };
  ok("Q-1007a (b): the cost that waited is approved after the head (200) and now has its ledger row",
    lateReplay.status === 200 && await costCount(pendingHead, "b-pending") === 1, `got ${lateReplay.status} rows=${await costCount(pendingHead, "b-pending")}`);
}


// ======================================================= pending-head-cap-bind (Umesh, 2026-10-19 ~16:00 IST: "go with best way")
// The approver of a Pending cost head must SEE its cap, the creator may still edit the cap while the head is
// Pending (no lock), and Approve carries the cap the approver saw: if the cap changed since, the server refuses
// (409), writes nothing, and says so. Each arm reads the raw collections, not only the HTTP reply; the arms that
// stand on the GUARANTEE (request still Pending, head still Pending, no new audit row) are the ones that go red
// when the compare is removed.
//   C1 - the approvals list carries the head's cap for a finance.view reader and not for one without it
//   C2 - the creator edits the cap of a Pending head (no lock, no proposal)
//   C3 - Approve with a stale / missing seen_cap is refused (409), nothing written; the current one goes through
//   C4 - Reject needs no seen_cap; a cap-raise proposal (cap-approval) and a cost entry approve as before (Q-1007a above)
{
  const rawCats = db.collection("costcategories");
  const rawAudits = db.collection("auditlogs");
  const oid = (id) => new ObjectId(String(id));
  const mk = async (name, body) => {
    const r = await req(admin, "POST", "/api/master-lists/cost-categories", { name: `ZZ PHCB ${name} ${stamp}`, ...body });
    const id = r.data?.item?._id;
    const hr = id ? await rawApprovals.findOne({ action: "costcategory.create", entity_id: oid(id), status: "Pending" }) : null;
    return { id, hr, status: r.status };
  };
  const auditCount = (a) => rawAudits.countDocuments({ $or: [{ entity_id: { $in: [oid(a.id), a.hr._id] } }, { entityId: { $in: [oid(a.id), a.hr._id] } }] });
  const listFor = async (cookie, a) => ((await req(cookie, "GET", "/api/approvals?status=Pending&kind=head-approval")).data?.items ?? []).find((x) => String(x._id) === String(a.hr?._id));
  // The whole limit the approver looks at (head_cap) goes back as seen_cap: amount, unit, min_billable, basis.
  const lim = (amount, o = {}) => ({ amount, unit: "Fixed amount", min_billable: 0, basis: null, ...o });
  const A = await mk("Capped", { pre_approved: true, pre_approved_amount: 5000, pre_approved_basis: "phcb" });
  const N0 = await mk("NoCap", {});
  ok("PHCB [precondition]: a capped head and a head with no cap exist, both Pending with their own sign-off request",
    !!A.id && !!A.hr && !!N0.id && !!N0.hr && (await rawCats.findOne({ _id: oid(A.id) }))?.approval_status === "Pending",
    JSON.stringify({ a: A.status, aReq: !!A.hr, n: N0.status, nReq: !!N0.hr }));

  // C1 - the approver sees the cap
  const seenByB = await listFor(approverB.cookie, A);
  ok("PHCB C1: the approvals list shows the head's cap (5000) to a finance.view approver", seenByB?.head_cap?.amount === 5000, JSON.stringify(seenByB?.head_cap));
  const seenNone = await listFor(approverB.cookie, N0);
  ok("PHCB C1: a head with no cap says so (amount null), it does not invent one", !!seenNone && seenNone.head_cap?.amount === null, JSON.stringify(seenNone?.head_cap));
  const seenUngranted = await listFor(ungranted.cookie, A);
  ok("PHCB C1: a reader WITHOUT finance.view gets no cap figure (REQ-235a masking holds)",
    !!seenUngranted && !JSON.stringify(seenUngranted).includes("5000") && seenUngranted.head_cap === undefined, JSON.stringify(seenUngranted?.head_cap));

  // C2 - the creator can still change the cap while Pending
  const edit = await req(admin, "PATCH", `/api/master-lists/cost-categories/${A.id}`, { pre_approved_amount: 6000 });
  const afterEdit = await rawCats.findOne({ _id: oid(A.id) });
  ok("PHCB C2: the creator edits the cap of a Pending head - 200, stored cap is 6000, no proposal raised, head still Pending",
    edit.status === 200 && afterEdit?.pre_approved_amount === 6000 && !edit.data?.pending_cap_approval && afterEdit?.approval_status === "Pending",
    JSON.stringify({ http: edit.status, cap: afterEdit?.pre_approved_amount, st: afterEdit?.approval_status }));
  ok("PHCB C2: the list now shows the edited cap to the approver", (await listFor(approverB.cookie, A))?.head_cap?.amount === 6000);

  // C3 - Approve carries the cap that was seen
  const aBefore = await auditCount(A);
  const stale = await req(approverB.cookie, "POST", `/api/approvals/${A.hr._id}`, { decision: "Approved", note: "phcb stale", seen_cap: lim(5000, { basis: "phcb" }) });
  const afterStale = await rawApprovals.findOne({ _id: A.hr._id });
  const headStale = await rawCats.findOne({ _id: oid(A.id) });
  ok("PHCB C3: Approve with the OLD cap (5000, now 6000) is refused 409 with the stated message",
    stale.status === 409 && /Limit changed from .*5,?000.* to .*6,?000.*, please review again\./.test(String(stale.data?.error ?? "")),
    `got ${stale.status} ${JSON.stringify(stale.data?.error)}`);
  ok("PHCB C3 [guarantee]: ...and NOTHING was written - request still Pending with no decider, head still Pending, cap 6000, no new audit row",
    afterStale?.status === "Pending" && !afterStale?.decided_by && headStale?.approval_status === "Pending" && headStale?.pre_approved_amount === 6000 && (await auditCount(A)) === aBefore,
    JSON.stringify({ req: afterStale?.status, decider: afterStale?.decided_by, head: headStale?.approval_status, audits: [aBefore, await auditCount(A)] }));
  const missing = await req(approverB.cookie, "POST", `/api/approvals/${A.hr._id}`, { decision: "Approved", note: "phcb no seen" });
  const afterMissing = await rawApprovals.findOne({ _id: A.hr._id });
  ok("PHCB C3: Approve with NO seen_cap is refused too (409, fail closed) and the request is still Pending",
    missing.status === 409 && afterMissing?.status === "Pending" && (await rawCats.findOne({ _id: oid(A.id) }))?.approval_status === "Pending", `got ${missing.status}`);
  const nonNumeric = await req(approverB.cookie, "POST", `/api/approvals/${A.hr._id}`, { decision: "Approved", note: "phcb junk", seen_cap: "6000" });
  ok("PHCB C3: a seen_cap that is not a number (or null) is refused as well (409), still Pending",
    nonNumeric.status === 409 && (await rawApprovals.findOne({ _id: A.hr._id }))?.status === "Pending", `got ${nonNumeric.status}`);
  const bareNum = await req(approverB.cookie, "POST", `/api/approvals/${A.hr._id}`, { decision: "Approved", note: "phcb bare number", seen_cap: 6000 });
  const partial = await req(approverB.cookie, "POST", `/api/approvals/${A.hr._id}`, { decision: "Approved", note: "phcb amount only", seen_cap: { amount: 6000 } });
  ok("PHCB C3b: a bare amount (6000), or an amount with no unit / min_billable / basis, is not the whole limit - 409 each (fail closed), still Pending",
    bareNum.status === 409 && partial.status === 409 && (await rawApprovals.findOne({ _id: A.hr._id }))?.status === "Pending", `got ${bareNum.status} ${partial.status}`);
  const selfNoCap = await req(admin, "POST", `/api/approvals/${A.hr._id}`, { decision: "Approved", note: "phcb own" });
  ok("PHCB C3: the creator approving their own head is still the 403 (not turned into a cap 409)", selfNoCap.status === 403, `got ${selfNoCap.status}`);
  const good = await req(approverB.cookie, "POST", `/api/approvals/${A.hr._id}`, { decision: "Approved", note: "phcb current", seen_cap: lim(6000, { basis: "phcb" }) });
  const goodHead = await rawCats.findOne({ _id: oid(A.id) });
  ok("PHCB C3: Approve with the CURRENT cap (6000) goes through - 200, head Approved, cap unchanged",
    good.status === 200 && goodHead?.approval_status === "Approved" && goodHead?.pre_approved_amount === 6000, `got ${good.status} ${goodHead?.approval_status}`);
  const noneStaleNum = await req(approverB.cookie, "POST", `/api/approvals/${N0.hr._id}`, { decision: "Approved", note: "phcb nocap stale", seen_cap: lim(100) });
  ok("PHCB C3: a head with NO cap: a seen_cap of 100 is stale -> 409, still Pending", noneStaleNum.status === 409 && (await rawApprovals.findOne({ _id: N0.hr._id }))?.status === "Pending", `got ${noneStaleNum.status}`);
  const noneMissing = await req(approverB.cookie, "POST", `/api/approvals/${N0.hr._id}`, { decision: "Approved", note: "phcb nocap no seen" });
  ok("PHCB C3: a head with NO cap is not approvable by a request that carries no seen_cap at all (409, fail closed - absent is not the same as 'no limit seen'), still Pending",
    noneMissing.status === 409 && (await rawApprovals.findOne({ _id: N0.hr._id }))?.status === "Pending", `got ${noneMissing.status}`);
  const noneOk = await req(approverB.cookie, "POST", `/api/approvals/${N0.hr._id}`, { decision: "Approved", note: "phcb nocap", seen_cap: lim(null) });
  ok("PHCB C3: a head with NO cap approves when the approver saw none (seen_cap null) - 200, Approved",
    noneOk.status === 200 && (await rawCats.findOne({ _id: oid(N0.id) }))?.approval_status === "Approved", `got ${noneOk.status}`);

  // C3b - the limit is the WHOLE rule, not the amount: a unit / minimum-billable / basis change with the same
  // amount is refused too (rules.ts reads a "Per billable passed" 4000 as amount x passed).
  const U = await mk("WholeLimit", { pre_approved: true, pre_approved_amount: 4000, pre_approved_basis: "phcb-u" });
  const uSeen = lim(4000, { basis: "phcb-u" });
  const uTry = async (label, patch, back, expectText) => {
    const e = await req(admin, "PATCH", `/api/master-lists/cost-categories/${U.id}`, patch);
    const before = await auditCount(U);
    const r = await req(approverB.cookie, "POST", `/api/approvals/${U.hr._id}`, { decision: "Approved", note: `phcb ${label}`, seen_cap: uSeen });
    const reqAfter = await rawApprovals.findOne({ _id: U.hr._id });
    const headAfter = await rawCats.findOne({ _id: oid(U.id) });
    ok(`PHCB C3b: the creator changes the ${label} with the amount held at 4000 (edit 200) - Approve with the old limit is refused 409 saying what changed`,
      e.status === 200 && r.status === 409 && expectText.test(String(r.data?.error ?? "")), `edit ${e.status} approve ${r.status} ${JSON.stringify(r.data?.error)}`);
    ok(`PHCB C3b [guarantee]: ${label}: nothing written - request Pending with no decider, head Pending, no new audit row`,
      reqAfter?.status === "Pending" && !reqAfter?.decided_by && headAfter?.approval_status === "Pending" && (await auditCount(U)) === before,
      JSON.stringify({ req: reqAfter?.status, decider: reqAfter?.decided_by, head: headAfter?.approval_status }));
    return (await req(admin, "PATCH", `/api/master-lists/cost-categories/${U.id}`, back)).status;
  };
  const b1 = await uTry("unit (Fixed amount to Per billable passed)", { pre_approved_unit: "Per billable passed" }, { pre_approved_unit: "Fixed amount" }, /Limit changed from .* to .*per billable passed.*, please review again\./);
  const b2 = await uTry("minimum billable (0 to 3)", { pre_approved_min_billable: 3 }, { pre_approved_min_billable: 0 }, /Limit changed from .* to .*minimum 3 billable.*, please review again\./);
  const b3 = await uTry("basis (phcb-u to phcb-u2)", { pre_approved_basis: "phcb-u2" }, { pre_approved_basis: "phcb-u" }, /Limit changed from .* to .*phcb-u2.*, please review again\./);
  const uNow = await rawCats.findOne({ _id: oid(U.id) });
  ok("PHCB C3b [precondition]: the three edits were put back - the head holds exactly the limit the approver saw",
    b1 === 200 && b2 === 200 && b3 === 200 && uNow?.pre_approved_amount === 4000 && (uNow?.pre_approved_unit ?? "Fixed amount") === "Fixed amount" && !(uNow?.pre_approved_min_billable > 0) && uNow?.pre_approved_basis === "phcb-u",
    JSON.stringify({ b1, b2, b3, unit: uNow?.pre_approved_unit, min: uNow?.pre_approved_min_billable, basis: uNow?.pre_approved_basis }));
  const uGood = await req(approverB.cookie, "POST", `/api/approvals/${U.hr._id}`, { decision: "Approved", note: "phcb whole limit current", seen_cap: uSeen });
  ok("PHCB C3b: Approve with the full limit as it stands now goes through - 200, head Approved",
    uGood.status === 200 && (await rawCats.findOne({ _id: oid(U.id) }))?.approval_status === "Approved", `got ${uGood.status} ${JSON.stringify(uGood.data?.error)}`);

  // C3c - the compare is atomic with the flip: the creator edits the cap AFTER the route's compare passed and
  // BEFORE the head is flipped (the replay is held there by a CI-only barrier). The flip carries the seen limit
  // as a condition, so it matches nothing: 409, claim rolled back, and the head is never Approved on a limit
  // that is not the one seen.
  const Rc = await mk("Race", { pre_approved: true, pre_approved_amount: 3000, pre_approved_basis: "phcb-r" });
  await rawApprovals.updateOne({ _id: Rc.hr._id }, { $set: { "payload._test_head_pause_before_flip": true } });
  const racing = req(approverB.cookie, "POST", `/api/approvals/${Rc.hr._id}`, { decision: "Approved", note: "phcb race", seen_cap: lim(3000, { basis: "phcb-r" }) });
  let reached = false;
  for (let i = 0; i < 300 && !reached; i++) {
    reached = (await rawApprovals.findOne({ _id: Rc.hr._id }))?.payload?._test_head_reached_before_flip === true;
    if (!reached) await new Promise((r) => setTimeout(r, 100));
  }
  const raceEdit = reached ? await req(admin, "PATCH", `/api/master-lists/cost-categories/${Rc.id}`, { pre_approved_amount: 3500 }) : { status: 0 };
  const rBefore = await auditCount(Rc); // after the creator's own edit (it writes its own audit row); the refused Approve must add none
  await rawApprovals.updateOne({ _id: Rc.hr._id }, { $set: { "payload._test_head_release_before_flip": true } });
  const raced = await racing;
  const rReq = await rawApprovals.findOne({ _id: Rc.hr._id });
  const rHead = await rawCats.findOne({ _id: oid(Rc.id) });
  ok("PHCB C3c [precondition]: the replay reached the barrier and the creator's edit (3000 to 3500) landed inside the window",
    reached && raceEdit.status === 200 && rHead?.pre_approved_amount === 3500, JSON.stringify({ reached, edit: raceEdit.status, cap: rHead?.pre_approved_amount }));
  ok("PHCB C3c: the Approve that raced the edit is refused 409 with the stated message (the flip matched nothing)",
    raced.status === 409 && /Limit changed from .*3,?000.* to .*3,?500.*, please review again\./.test(String(raced.data?.error ?? "")), `got ${raced.status} ${JSON.stringify(raced.data?.error)}`);
  ok("PHCB C3c [guarantee]: the head is NOT Approved on a limit that was not seen - head still Pending, cap 3500, request rolled back to Pending with no decider, no audit row",
    rHead?.approval_status === "Pending" && rHead?.pre_approved_amount === 3500
      && rReq?.status === "Pending" && !rReq?.decided_by && (await auditCount(Rc)) === rBefore,
    JSON.stringify({ head: rHead?.approval_status, req: rReq?.status, decider: rReq?.decided_by }));

  // C4 - Reject is unaffected
  const R = await mk("RejectMe", { pre_approved: true, pre_approved_amount: 700, pre_approved_basis: "phcb" });
  await req(admin, "PATCH", `/api/master-lists/cost-categories/${R.id}`, { pre_approved_amount: 800 });
  const rej = R.hr ? await req(approverB.cookie, "POST", `/api/approvals/${R.hr._id}`, { decision: "Rejected", note: "phcb reject" }) : { status: 0 };
  ok("PHCB C4: Reject needs no seen_cap, even after the cap changed - 200, head Rejected",
    rej.status === 200 && (await rawCats.findOne({ _id: oid(R.id) }))?.approval_status === "Rejected", `got ${rej.status}`);
}
await rule(false);
await client.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
