// QA-2852 (S3), queue row Q-1006c (Umesh, 2026-10-07: "ye bhi krna hi hai").
//
// A cost head that is not approved (CostCategory.approval_status Pending or Rejected) says so in
// three more places than the picker and the Admin badge: the Finance cost-head FILTER, the cost
// REGISTER rows (Finance register and the Costs ledger), and the APPROVALS summary of a cost that is
// parked under such a head (the Admin queue and the raiser's own "My submissions"). A head with no
// flag at all reads as approved, so legacy heads carry no mark. Display only: nothing is written.
//
// WHY THESE PINS ARE SHAPED THIS WAY. A mark that is wired to the wrong field (always on, always off,
// stored in the summary at park time) passes every structural check. So every arm reads what a person
// reads - the rendered text of the option, the row, the queue entry - and each head is a fixture of a
// different STATE, so an always-on or an always-off mark fails one arm:
//   Pending head, Rejected head, Approved head, an approved head's PENDING subhead, and a legacy head
//   whose document has no approval_status field at all.
// And the mark must follow the head's CURRENT state, not the state when the cost was parked: the head
// is approved at the end and the parked cost's mark must go.
//
// Named guards (each has a mutant in the evidence folder that must turn the arm red):
//   filter    - the Finance cost-head filter labels carry the mark
//   fin-reg   - the Finance register Cost head / Subhead cells carry it (server sends the status)
//   cost-reg  - the Costs ledger Category cell carries it (GET /api/costs sends the status)
//   queue     - the Admin Approvals row of a parked cost carries it (GET /api/approvals sends cost_head)
//   mine      - the raiser's own My submissions row carries it (the masked ?mine=1 path too)
//   legacy    - a head with no approval_status gets NO mark anywhere (missing reads as approved)
//   live      - the mark follows the head's current state; nothing is stored in the summary
import { requireLocalBase } from "./db-guard.mjs";
import { MongoClient, ObjectId } from "mongodb";

const BASE = requireLocalBase("e2e-cost-head-not-approved-mark", process.env.BASE_URL || "http://localhost:3000/erp");
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
  const res = await fetch(BASE + p, {
    method, headers: { "Content-Type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const client = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017", { serverSelectionTimeoutMS: 8000 });
await client.connect();
const db = client.db((process.env.MONGODB_DB || "center_erp_ci").trim());
const rawCats = db.collection("costcategories");
const rawCosts = db.collection("costentries");
const rawApprovals = db.collection("approvalrequests");

const PW = "CiOnly@123";
// Letters only: -303 redacts every run of three digits in an approval summary for a reader without
// finance.view (ops), and a head name or note with a digit run would turn into a false RED.
const stamp = Date.now().toString(36).replace(/[0-9]/g, (d) => "qrstuvwxyz"[Number(d)]);
const N = {
  pend: `ZZ Mark Pend ${stamp}`, rej: `ZZ Mark Rej ${stamp}`, appr: `ZZ Mark Appr ${stamp}`, sub: `ZZ Mark Sub ${stamp}`,
};
const tag = (k) => `zzmark ${stamp} ${k}`;
const NOT_APPROVED = " (not approved)";
const REJECTED = " (rejected)";

const admin = await login("admin@vidysea.com", (process.env.ADMIN_PASSWORD || (() => { throw new Error("ADMIN_PASSWORD env var is required (no default)"); })()));
const ops = await login("ops@vidysea.com", PW);
ok("[precondition] personas sign in", !!admin && !!ops, `admin=${!!admin} ops=${!!ops}`);

const anyLoc = ((await req(admin, "GET", "/api/locations?limit=5")).data?.items ?? [])[0]?._id;
ok("[precondition] a location exists to hang entries on", !!anyLoc);
const entry = (extra) => ({ entry_date: "2031-05-04", location: anyLoc, amount: 410, ...extra });

// Real queued requests and explicit historical ledger fixtures have separate cleanup identities.
const created = { cats: [], requests: [], headRequests: [], costs: [] };
let ruleBefore = null;
try {
  // ---- fixtures through the real doors ------------------------------------------------------
  const cfg = (await req(admin, "GET", "/api/approvals?status=Pending")).data?.config ?? [];
  ruleBefore = cfg.find((c) => c.action === "cost.post") ?? { enabled: false, approver_role: "Admin" };
  const rule = (enabled) => req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled, approver_role: ruleBefore.approver_role ?? "Admin" });
  ok("[precondition] cost.post approval OFF while unapproved-head requests are exercised", (await rule(false)).status === 200);
  const fixtureActor = await db.collection("users").findOne({ email: "ops@vidysea.com" }, { projection: { _id: 1 } });
  ok("[precondition] historical display fixtures have the real isolated Operations enterer", !!fixtureActor?._id);

  // A head named on the cost form exists at once, NOT approved (QA-1977).
  const mkHead = async (name, extra = {}) => {
    const note = tag(name === N.pend ? "pend" : name === N.rej ? "rej" : name === N.appr ? "appr" : "sub");
    const r = await req(ops, "POST", "/api/costs", entry({ new_subhead: name, note, ...extra }));
    const head = await rawCats.findOne({ name });
    if (head) created.cats.push(head._id);
    if (r.data?.item?._id) {
      if (r.status === 202) created.requests.push(String(r.data.item._id));
      else if (r.status === 201) created.costs.push(String(r.data.item._id));
    }
    const headReq = head ? await rawApprovals.findOne({ action: "costcategory.create", entity_id: head._id }) : null;
    if (headReq) created.headRequests.push(String(headReq._id));
    const ledgerCount = await rawCosts.countDocuments({ note });
    const costRequest = r.data?.item?._id && r.status === 202
      ? await rawApprovals.findOne({ _id: new ObjectId(String(r.data.item._id)), action: "cost.post", status: "Pending" }) : null;
    ok(`guard: naming ${name} with cost.post OFF queues the real cost and writes no ledger row`,
      r.status === 202 && !!costRequest && ledgerCount === 0,
      JSON.stringify({ status: r.status, queued: !!costRequest, ledgerCount }));
    return { r, head, headReq, ledgerCount };
  };
  const P = await mkHead(N.pend);
  const R = await mkHead(N.rej);
  const A = await mkHead(N.appr);
  ok("[precondition] three heads named on the cost form exist Pending and their costs are queued, with zero ledger writes",
    [P, R, A].every((x) => x.r.status === 202 && x.ledgerCount === 0 && x.head?.approval_status === "Pending" && x.headReq?.status === "Pending"),
    JSON.stringify([P, R, A].map((x) => [x.r.status, x.head?.approval_status, x.headReq?.status])));
  const S = await mkHead(N.sub, { new_head_parent: String(A.head?._id) });
  // The Approved head is signed off, the Rejected one is rejected, both through the real approvals door.
  const apprDecision = await req(admin, "POST", `/api/approvals/${A.headReq?._id}`, { decision: "Approved", note: "fixture" });
  const rejDecision = await req(admin, "POST", `/api/approvals/${R.headReq?._id}`, { decision: "Rejected", note: "fixture: not a real head" });
  const [pDoc, rDoc, aDoc, sDoc] = await Promise.all([P, R, A, S].map((x) => rawCats.findOne({ _id: x.head?._id })));
  ok("[precondition] states: Pending head, Rejected head, Approved head, and a PENDING subhead under the approved head",
    pDoc?.approval_status === "Pending" && rDoc?.approval_status === "Rejected" && aDoc?.approval_status === "Approved"
      && sDoc?.approval_status === "Pending" && String(sDoc?.parent) === String(aDoc?._id) && apprDecision.status === 200 && rejDecision.status === 200,
    JSON.stringify([pDoc?.approval_status, rDoc?.approval_status, aDoc?.approval_status, sDoc?.approval_status, sDoc?.parent && String(sDoc.parent) === String(aDoc?._id), apprDecision.status, rejDecision.status]));
  // Keep the note free of status words: the later display-only assertion deliberately hunts
  // those words in stored requests, so a caller's own note must not impersonate the marker.
  const rejectedOff = await req(ops, "POST", "/api/costs", entry({ category: String(rDoc?._id), note: tag("hold off"), amount: 415 }));
  if (rejectedOff.status === 202 && rejectedOff.data?.item?._id) created.requests.push(String(rejectedOff.data.item._id));
  else if (rejectedOff.status === 201 && rejectedOff.data?.item?._id) created.costs.push(String(rejectedOff.data.item._id));
  ok("guard: an already-Rejected head with cost.post OFF queues the real request and writes no ledger row",
    rejectedOff.status === 202 && !!rejectedOff.data?.queued && await rawCosts.countDocuments({ note: tag("hold off") }) === 0,
    `status=${rejectedOff.status}`);

  // The new write rule correctly prevents these rows from being posted today. They deliberately
  // model costs recorded before that safeguard, so their CURRENT category-state labels still need
  // to be readable in Finance/Costs. Raw insertion is isolated test setup, never evidence that an
  // unapproved head may reach the ledger through POST. No synthetic approval/audit is invented.
  for (const [key, head] of [["pend", pDoc], ["rej", rDoc], ["appr", aDoc], ["sub", sDoc]]) {
    const id = new ObjectId();
    const now = new Date();
    await rawCosts.insertOne({
      _id: id, entry_date: new Date("2031-05-04T00:00:00.000Z"), location: new ObjectId(String(anyLoc)),
      category: head._id, amount: 410, requested_amount: 410, note: tag(key),
      entered_by: fixtureActor._id, payment_status: "Payment Pending", reservation_state: "Applied",
      pre_approved_applied: false, createdAt: now, updatedAt: now,
      _audit_events: [], _audit_delivered_event_ids: [],
    });
    created.costs.push(String(id));
  }
  ok("[precondition] four explicit historical ledger fixtures preserve Pending/Rejected/Approved/subhead display coverage",
    await rawCosts.countDocuments({ _id: { $in: created.costs.map((id) => new ObjectId(id)) } }) === 4);
  // A legacy head: an active top-level head whose document has NO approval_status field at all.
  const legacy = await rawCats.findOne({ approval_status: { $exists: false }, active: { $ne: false }, parent: { $exists: false }, pre_approved: { $ne: true }, name: { $not: /^(other|misc)/i } });
  ok("[precondition] a legacy head with no approval_status field exists (the seed's heads carry none)", !!legacy, "none found");
  const L = { head: legacy };
  const legRow = await req(admin, "POST", "/api/costs", entry({ category: String(legacy?._id), note: tag("leg") }));
  if (legRow.data?.item?._id) created.costs.push(String(legRow.data.item._id));
  ok("[precondition] a ledger row was posted under the legacy head", legRow.status === 201, `got ${legRow.status}`);

  // Park one cost under each head with the rule ON.
  ok("[precondition] cost.post approval ON so Operations' entries park", (await rule(true)).status === 200);
  const park = async (head, k) => {
    const r = await req(ops, "POST", "/api/costs", entry({ category: String(head._id), note: tag(`park ${k}`), amount: 420 }));
    const id = r.data?.item?._id ? String(r.data.item._id) : "";
    if (id && r.status === 202) created.requests.push(id);
    else if (id && r.status === 201) created.costs.push(id);
    const ledgerCount = await rawCosts.countDocuments({ note: tag(`park ${k}`) });
    const requestExists = id && r.status === 202
      ? !!(await rawApprovals.findOne({ _id: new ObjectId(id), action: "cost.post", status: "Pending" })) : false;
    return { status: r.status, id, ledgerCount, requestExists };
  };
  const pk = {
    pend: await park(pDoc, "pend"), rej: await park(rDoc, "rej"), appr: await park(aDoc, "appr"),
    sub: await park(sDoc, "sub"), leg: await park(legacy, "leg"),
  };
  ok("[precondition] one real cost is parked under each of the five heads, with zero ledger writes",
    Object.values(pk).every((x) => x.status === 202 && x.id && x.requestExists && x.ledgerCount === 0),
    JSON.stringify(pk));

  // Snapshot for the display-only arm.
  const snap = async () => JSON.stringify({
    cats: await rawCats.find({ _id: { $in: created.cats } }).sort({ _id: 1 }).toArray(),
    reqs: (await rawApprovals.find({ _id: { $in: created.requests.map((i) => new ObjectId(i)) } }).sort({ _id: 1 }).toArray())
      .map((r) => ({ status: r.status, summary: r.summary, payload: r.payload })),
  });
  const before = await snap();

  // ---- API arms ------------------------------------------------------------------------------
  const note = (st) => (st === "Pending" ? NOT_APPROVED : st === "Rejected" ? REJECTED : "");
  const finRows = (await req(admin, "GET", "/api/reports/costs")).data?.register ?? [];
  const finRow = (k) => finRows.find((r) => String(r.note) === tag(k));
  ok("[precondition] four historical display fixtures plus the real legacy-head post are in the Finance register", ["pend", "rej", "appr", "sub", "leg"].every((k) => !!finRow(k)),
    JSON.stringify(["pend", "rej", "appr", "sub", "leg"].map((k) => !!finRow(k))));
  ok("fin-reg (API): the register row carries the head's status - Pending, Rejected, Approved, none",
    finRow("pend")?.head_approval_status === "Pending" && finRow("rej")?.head_approval_status === "Rejected"
      && finRow("appr")?.head_approval_status === "Approved" && !finRow("leg")?.head_approval_status,
    JSON.stringify(["pend", "rej", "appr", "leg"].map((k) => finRow(k)?.head_approval_status)));
  ok("fin-reg (API): a Pending SUBHEAD's status rides on the subhead field, and the approved head above it stays approved",
    finRow("sub")?.subhead_approval_status === "Pending" && finRow("sub")?.head_approval_status === "Approved"
      && !finRow("pend")?.subhead_approval_status,
    JSON.stringify([finRow("sub")?.subhead_approval_status, finRow("sub")?.head_approval_status, finRow("pend")?.subhead_approval_status]));
  const ledger = (await req(admin, "GET", "/api/costs")).data?.items ?? [];
  const ledgerRow = (k) => ledger.find((r) => String(r.note) === tag(k));
  ok("cost-reg (API): the ledger row's category carries the head's status",
    ledgerRow("pend")?.category?.approval_status === "Pending" && ledgerRow("rej")?.category?.approval_status === "Rejected"
      && ledgerRow("appr")?.category?.approval_status === "Approved" && !ledgerRow("leg")?.category?.approval_status,
    JSON.stringify(["pend", "rej", "appr", "leg"].map((k) => ledgerRow(k)?.category?.approval_status)));
  const queue = (await req(admin, "GET", "/api/approvals?status=Pending")).data?.items ?? [];
  const q = (k) => queue.find((r) => String(r._id) === pk[k].id);
  ok("queue (API): a parked cost names its head and the head's status",
    q("pend")?.cost_head?.approval_status === "Pending" && q("pend")?.cost_head?.name === N.pend
      && q("rej")?.cost_head?.approval_status === "Rejected" && q("appr")?.cost_head?.approval_status === "Approved"
      && q("sub")?.cost_head?.approval_status === "Pending" && !q("leg")?.cost_head?.approval_status,
    JSON.stringify(["pend", "rej", "appr", "sub", "leg"].map((k) => q(k)?.cost_head)));
  const mine = (await req(ops, "GET", "/api/approvals?mine=1")).data?.items ?? [];
  const m = (k) => mine.find((r) => String(r._id) === pk[k].id);
  ok("mine (API): the raiser's own masked list carries it too",
    m("pend")?.cost_head?.approval_status === "Pending" && m("rej")?.cost_head?.approval_status === "Rejected"
      && !m("leg")?.cost_head?.approval_status,
    JSON.stringify([m("pend")?.cost_head, m("rej")?.cost_head, m("leg")?.cost_head]));
  ok("legacy (API): a head with no approval_status reads as approved - no status on any of its three surfaces",
    !finRow("leg")?.head_approval_status && !ledgerRow("leg")?.category?.approval_status && !q("leg")?.cost_head?.approval_status);

  // ---- rendered arms (what a person reads) ---------------------------------------------------
  let browser;
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
    const asPage = async (email, password) => {
      const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
      const page = await context.newPage();
      await page.goto(BASE, { waitUntil: "networkidle" });
      const em = page.locator('input[type="email"], input[name="email"]').first();
      if (await em.count()) {
        await em.fill(email);
        await page.locator('input[type="password"]').first().fill(password);
        await page.locator('button[type="submit"]').first().click();
        await page.waitForURL((u) => !/login/i.test(String(u)), { timeout: 30000 }).catch(() => {});
      }
      return { page, context };
    };
    const rowText = async (page, sel, hasText) => {
      const row = page.locator(sel).filter({ hasText }).first();
      await row.waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
      return (await row.count()) ? (await row.innerText()).replace(/\s+/g, " ") : "";
    };
    const has = (text, needle) => text.includes(needle);

    const adm = await asPage("admin@vidysea.com", (process.env.ADMIN_PASSWORD || (() => { throw new Error("ADMIN_PASSWORD env var is required (no default)"); })()));
    // filter
    await adm.page.goto(`${BASE}/finance`, { waitUntil: "networkidle" });
    await adm.page.locator("select", { has: adm.page.locator("option", { hasText: "All heads" }) }).first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    await adm.page.waitForFunction((n) => [...document.querySelectorAll("option")].some((o) => o.textContent?.includes(n)), N.pend, { timeout: 30000 }).catch(() => {});
    const labels = await adm.page.$$eval("select option, select optgroup", (els) => els.map((e) => (e.tagName === "OPTGROUP" ? e.getAttribute("label") : e.textContent) ?? ""));
    const lab = (name) => labels.filter((l) => l.includes(name));
    ok("filter: a Pending head is offered as '<name> (not approved)' and a Rejected one as '<name> (rejected)'",
      lab(N.pend).includes(N.pend + NOT_APPROVED) && lab(N.rej).includes(N.rej + REJECTED), JSON.stringify([lab(N.pend), lab(N.rej)]));
    ok("filter: an approved head carries no mark - its group label and its 'All of' option",
      lab(N.appr).includes(N.appr) && lab(N.appr).includes(`All of ${N.appr}`) && !lab(N.appr).some((l) => l.includes("(") && l.includes(N.appr + " (")),
      JSON.stringify(lab(N.appr)));
    ok("filter: a Pending SUBHEAD under an approved head is marked, and only the subhead",
      lab(N.sub).includes(N.sub + NOT_APPROVED), JSON.stringify(lab(N.sub)));
    ok("legacy (filter): a head with no approval_status is offered with no mark",
      labels.includes(legacy.name) && !labels.includes(legacy.name + NOT_APPROVED) && !labels.includes(legacy.name + REJECTED),
      JSON.stringify(lab(legacy.name)));

    // finance register
    const frow = (k) => rowText(adm.page, "tr", tag(k));
    const [fp, fr, fa, fs, fl] = [await frow("pend"), await frow("rej"), await frow("appr"), await frow("sub"), await frow("leg")];
    ok("[precondition] the Finance register renders all five fixture rows", [fp, fr, fa, fs, fl].every(Boolean), JSON.stringify([fp, fr, fa, fs, fl].map((t) => t.slice(0, 60))));
    ok("fin-reg: the Cost head cell of a Pending / Rejected head carries the mark",
      has(fp, N.pend + NOT_APPROVED) && has(fr, N.rej + REJECTED), JSON.stringify([fp.slice(0, 160), fr.slice(0, 160)]));
    ok("fin-reg: an approved head's row has no mark; a Pending subhead is marked beside an unmarked head",
      !fa.includes("(not approved)") && !fa.includes("(rejected)") && has(fs, N.sub + NOT_APPROVED) && !has(fs, N.appr + " ("),
      JSON.stringify([fa.slice(0, 160), fs.slice(0, 160)]));
    ok("legacy (fin-reg): the legacy head's row has no mark", !fl.includes("(not approved)") && !fl.includes("(rejected)"), fl.slice(0, 160));

    // costs ledger
    await adm.page.goto(`${BASE}/costs`, { waitUntil: "networkidle" });
    const crow = (k) => rowText(adm.page, "tr", tag(k));
    const [cp, cr, ca, cs, cl] = [await crow("pend"), await crow("rej"), await crow("appr"), await crow("sub"), await crow("leg")];
    ok("[precondition] the Costs ledger renders all five fixture rows", [cp, cr, ca, cs, cl].every(Boolean), JSON.stringify([cp, cr, ca, cs, cl].map((t) => t.slice(0, 60))));
    ok("cost-reg: the Category cell of a Pending / Rejected head carries the mark",
      has(cp, N.pend + NOT_APPROVED) && has(cr, N.rej + REJECTED) && has(cs, N.sub + NOT_APPROVED),
      JSON.stringify([cp.slice(0, 140), cr.slice(0, 140), cs.slice(0, 140)]));
    ok("cost-reg: an approved head's row and the legacy head's row have no mark",
      !ca.includes("(not approved)") && !ca.includes("(rejected)") && !cl.includes("(not approved)") && !cl.includes("(rejected)"),
      JSON.stringify([ca.slice(0, 140), cl.slice(0, 140)]));

    // admin approvals queue
    await adm.page.goto(`${BASE}/admin?tab=Approvals`, { waitUntil: "networkidle" });
    const arow = async (k) => { const s = `#approval-request-${pk[k].id}`; await adm.page.locator(s).waitFor({ state: "visible", timeout: 30000 }).catch(() => {}); return (await adm.page.locator(s).count()) ? (await adm.page.locator(s).first().innerText()).replace(/\s+/g, " ") : ""; };
    const [ap, ar, aa, as_, al] = [await arow("pend"), await arow("rej"), await arow("appr"), await arow("sub"), await arow("leg")];
    ok("[precondition] the Admin queue renders all five parked costs", [ap, ar, aa, as_, al].every(Boolean), JSON.stringify([ap, ar, aa, as_, al].map((t) => t.slice(0, 60))));
    ok("queue: a cost parked under a Pending / Rejected head says so beside the entry",
      has(ap, N.pend + NOT_APPROVED) && has(ar, N.rej + REJECTED) && has(as_, N.sub + NOT_APPROVED),
      JSON.stringify([ap.slice(0, 200), ar.slice(0, 200), as_.slice(0, 200)]));
    ok("queue: a cost under an approved head, or a legacy head, has no mark",
      !aa.includes("(not approved)") && !aa.includes("(rejected)") && !al.includes("(not approved)") && !al.includes("(rejected)"),
      JSON.stringify([aa.slice(0, 200), al.slice(0, 200)]));
    await adm.context.close();

    // the raiser's own list (Operations has no finance.view: the masked path)
    const op = await asPage("ops@vidysea.com", PW);
    await op.page.goto(`${BASE}/costs`, { waitUntil: "networkidle" });
    const orow = (k) => rowText(op.page, "tr", tag(`park ${k}`));
    const [op1, op2, op3, op4, op5] = [await orow("pend"), await orow("rej"), await orow("appr"), await orow("sub"), await orow("leg")];
    ok("[precondition] My submissions renders the five parked costs for the raiser", [op1, op2, op3, op4, op5].every(Boolean), JSON.stringify([op1, op2, op3, op4, op5].map((t) => t.slice(0, 60))));
    ok("mine: the raiser sees the mark on a cost parked under a Pending / Rejected head",
      has(op1, N.pend + NOT_APPROVED) && has(op2, N.rej + REJECTED) && has(op4, N.sub + NOT_APPROVED),
      JSON.stringify([op1.slice(0, 200), op2.slice(0, 200), op4.slice(0, 200)]));
    ok("mine: and none on an approved head or a legacy head",
      !op3.includes("(not approved)") && !op3.includes("(rejected)") && !op5.includes("(not approved)") && !op5.includes("(rejected)"),
      JSON.stringify([op3.slice(0, 200), op5.slice(0, 200)]));
    await op.context.close();

    // ---- display only, and live ---------------------------------------------------------------
    const after = await snap();
    ok("live: reading the screens wrote nothing - head documents and the parked requests (summary, payload) are byte-identical",
      after === before, "a document changed while the screens were read");
    ok("live: the mark is not stored in a parked request's summary or payload",
      !(await rawApprovals.find({ _id: { $in: created.requests.map((i) => new ObjectId(i)) } }).toArray())
        .some((r) => /not approved|rejected/i.test(String(r.summary)) || JSON.stringify(r.payload ?? {}).includes("not approved")));

    const approveP = await req(admin, "POST", `/api/approvals/${P.headReq._id}`, { decision: "Approved", note: "fixture: now approved" });
    const queue2 = (await req(admin, "GET", "/api/approvals?status=Pending")).data?.items ?? [];
    const adm2 = await asPage("admin@vidysea.com", (process.env.ADMIN_PASSWORD || (() => { throw new Error("ADMIN_PASSWORD env var is required (no default)"); })()));
    await adm2.page.goto(`${BASE}/admin?tab=Approvals`, { waitUntil: "networkidle" });
    const ap2 = await (async () => { const s = `#approval-request-${pk.pend.id}`; await adm2.page.locator(s).waitFor({ state: "visible", timeout: 30000 }).catch(() => {}); return (await adm2.page.locator(s).count()) ? (await adm2.page.locator(s).first().innerText()).replace(/\s+/g, " ") : ""; })();
    ok("live: once the head is approved the mark is gone from the parked cost - API and screen",
      approveP.status === 200 && queue2.find((r) => String(r._id) === pk.pend.id)?.cost_head?.approval_status === "Approved"
        && !!ap2 && !ap2.includes("(not approved)"),
      JSON.stringify([approveP.status, queue2.find((r) => String(r._id) === pk.pend.id)?.cost_head, ap2.slice(0, 200)]));
    await adm2.context.close();
  } catch (e) {
    ok("rendered arms ran without a crash", false, String(e?.stack ?? e).slice(0, 400));
  } finally {
    try { await browser?.close(); } catch {}
  }
} finally {
  // Leave the CI database as found: the rule as it was, and every fixture this suite made removed.
  try {
    if (ruleBefore) await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: !!ruleBefore.enabled, approver_role: ruleBefore.approver_role ?? "Admin" });
    const catIds = created.cats;
    await rawApprovals.deleteMany({ $or: [
      { _id: { $in: [...created.requests, ...created.headRequests].map((i) => new ObjectId(i)) } },
      { entity_id: { $in: catIds } }, { "payload.category": { $in: [...catIds, ...catIds.map(String)] } },
    ] });
    await rawCosts.deleteMany({ $or: [{ _id: { $in: created.costs.map((i) => new ObjectId(i)) } },
      { note: { $regex: `^zzmark ${stamp} ` } }, { category: { $in: catIds } }] });
    await rawCats.deleteMany({ _id: { $in: catIds } });
  } catch (e) { console.log("cleanup note: " + String(e?.message ?? e).slice(0, 200)); }
  await client.close();
}
console.log(`\ne2e-cost-head-not-approved-mark.mjs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
