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

const admin = await login("admin@vidysea.com", process.env.ADMIN_PASSWORD || "admin123");
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
const signOff = async (headId) => {
  const hr = await rawApprovals.findOne({ action: "costcategory.create", entity_id: new ObjectId(String(headId)), status: "Pending" });
  return hr ? (await req(approverB.cookie, "POST", `/api/approvals/${hr._id}`, { decision: "Approved", note: "fixture: sign off" })).status : 0;
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
    byB.length === 2 && byB.every((r) => r.approved_by === approverName) && byB.some((r) => r.note === rows5.approver.note), JSON.stringify(byB.map((r) => r.note)));
  const gB = await fg(`approved_by=${approverB.id}`);
  ok("R5 filter: ...and on the register, where the KPI total narrows with it (totals.entries == register rows)",
    gB.register.every((r) => r.approved_by === approverName) && gB.totals.entries === gB.register.length && mine(gB.register).length === 2, JSON.stringify({ n: gB.register.length, t: gB.totals.entries }));
  const bPre = await fl("approved_by=pre-approved"), bDir = await fl("approved_by=direct");
  ok("R5 filter: approved_by=pre-approved keeps only pre-approved rows", bPre.length >= 1 && bPre.every((r) => r.approved_by_kind === "pre-approved") && bPre.some((r) => r.note === rows5.pre.note));
  ok("R5 filter: approved_by=direct keeps only direct rows, and not the approver's", bDir.length >= 4 && bDir.every((r) => r.approved_by_kind === "direct") && !bDir.some((r) => r.note === rows5.approver.note));
  const opts = (await req(admin, "GET", "/api/costs")).data?.approver_options ?? [];
  ok("R5 filter: the drop-down lists the real approver by name, plus Pre-approved and Direct",
    opts.some((o) => o.value === String(approverB.id) && o.label === approverName) && opts.some((o) => o.value === "pre-approved") && opts.some((o) => o.value === "direct"), JSON.stringify(opts.slice(0, 5)));
  const day = istDay(rows5.approver.decided_at);
  const inDay = await fl(`approved_by=${approverB.id}&approved_from=${day}&approved_to=${day}`);
  const after = await fl(`approved_by=${approverB.id}&approved_from=${dayShift(day, 1)}`);
  const before = await fl(`approved_by=${approverB.id}&approved_to=${dayShift(day, -1)}`);
  ok("R5 filter: 'approved on' range includes the approval's own IST day and excludes the days either side",
    inDay.length === 2 && after.length === 0 && before.length === 0, `in=${inDay.length} after=${after.length} before=${before.length}`);
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
  ok("R9 filter: Paid + Pending partition the unfiltered register (nothing lost, nothing double-counted)",
    gPaid.register.length + gPend.register.length === all.register.length, `${gPaid.register.length}+${gPend.register.length} vs ${all.register.length}`);
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

  // approved_from / approved_to must be real days
  const badDay = await req(admin, "GET", "/api/costs?approved_from=2026-02-31");
  const goodDay = await req(admin, "GET", "/api/costs?approved_from=2026-02-28");
  ok("R5 filter: a date that is not a real day (2026-02-31) is a 400, a real one is a 200", badDay.status === 400 && goodDay.status === 200, `${badDay.status}/${goodDay.status}`);

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

await rule(false);
await client.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
