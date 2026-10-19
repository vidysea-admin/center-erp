// costs-approval-box (Umesh, 2026-10-19: "yes top box with filters, and also with tabs we can show
// along with home page too"). An approver could not find a parked cost: it lives as an approval
// request, decided only under Admin -> Approvals. The Costs page now carries a box at the top,
// "Waiting for your approval (N)", for whoever may decide a cost request, with filters, a
// Pending / Approved / Rejected tab strip and a Home card that points at it. UI-only: the server
// rules are untouched, so every arm below reads what a person sees AND what the server then holds.
//
// Criteria (each arm name carries its tag):
//   K1  the box is visible to a decider and lists the Pending cost requests, count in the title
//   K2  Approve / Reject from the box use the SAME decide path and rules (own request has no
//       buttons and the server still refuses it; a partial amount needs a note; Reject writes no
//       ledger row; Approve writes the ledger exactly as the Admin tab's path does)
//   K3  filters (centre, requested by, search) narrow the list; the Approved / Rejected tabs are
//       read-only and show decider, time and note
//   K4  the Home card is shown to deciders only, carries the number, and links to /costs#approvals
//   K5  a non-decider (Operations; an Admin without finance.approve) sees nothing new, fetches
//       nothing of the queue, and no money leaks onto their page
//   K6  (fix cycle 1, 6c r2 on release 330) the count is the TRUE number of Pending cost.post
//       requests even when more than 100 approvals of mixed kinds are pending: the box title and
//       the Home card read it from the server (GET /api/approvals?action=cost.post -> total), the
//       list says when it is cut off, and the new `action` narrowing never widens what a caller can
//       see. Every count in this suite is read from the database at the moment it is asserted, or
//       is relative to a baseline read before this suite parked anything, never an absolute total:
//       other suites leave Pending approvals behind (the r2 wall had 65 cost.post, 40
//       costcategory.create and 4 others).
//
// Fixtures are made through the real doors (POST /api/costs with cost.post approval ON parks a
// request) and removed at the end; the approval rule is put back as it was.
import { requireLocalBase } from "./db-guard.mjs";
import { MongoClient, ObjectId } from "mongodb";

const BASE = requireLocalBase("e2e-cost-approval-box", process.env.BASE_URL || "http://localhost:3000/erp");
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

const client = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017", { serverSelectionTimeoutMS: 8000 });
await client.connect();
const db = client.db((process.env.MONGODB_DB || "center_erp_ci").trim());
const rawCosts = db.collection("costentries");
const rawApprovals = db.collection("approvalrequests");
const rawUsers = db.collection("users");

const PW = "CiOnly@123";
const ADMIN_PW = process.env.ADMIN_PASSWORD || (() => { throw new Error("ADMIN_PASSWORD env var is required (no default)"); })();
// Letters only: a three-digit run in an approval summary is redacted for a reader without finance.view.
const stamp = Date.now().toString(36).replace(/[0-9]/g, (d) => "qrstuvwxyz"[Number(d)]);
const tag = (k) => `zzbox ${stamp} ${k}`;
const AMT = { t1: 1111, t2: 2222, t3: 3333, t4: 4444, t5: 5555 };
const fmt = (n) => "₹" + Number(n).toLocaleString("en-IN");

const admin = await login("admin@vidysea.com", ADMIN_PW);
const ops = await login("ops@vidysea.com", PW);
ok("[precondition] admin (finance grants) and operations sign in", !!admin && !!ops, `admin=${!!admin} ops=${!!ops}`);
const adminRow = await rawUsers.findOne({ email: "admin@vidysea.com" });

const created = { users: [], requests: [], ledgerNotes: [], seeded: [] };
let ruleBefore = null;
const mkUser = async (name, email, grants, role = "Admin") => {
  const made = await req(admin, "POST", "/api/users", { name, email, password: PW, role, can_edit: true, location_scope: [] });
  if (made.data?.item?._id) {
    created.users.push(String(made.data.item._id));
    if (grants.length) await req(admin, "PATCH", `/api/users/${made.data.item._id}`, { extra_permissions: grants });
  }
  return { id: made.data?.item?._id, name, email, cookie: await login(email, PW) };
};
const approverB = await mkUser(`Approver Bee ${stamp}`, `zz.box.bee.${stamp}@vidysea-test.local`, ["finance.view", "finance.approve"]);
const adminNoFin = await mkUser(`Admin Nofin ${stamp}`, `zz.box.nofin.${stamp}@vidysea-test.local`, []);
// A non-Admin holding the finance grants but NOT the queue right: the server lists head sign-offs to them and nothing else.
const headOnly = await mkUser(`Head Only ${stamp}`, `zz.box.headonly.${stamp}@vidysea-test.local`, ["finance.view", "finance.approve"], "Operations");
ok("[precondition] a second approver, an Admin without the finance rights and a head-sign-off-only reader exist and sign in",
  !!approverB.cookie && !!adminNoFin.cookie && !!headOnly.cookie, JSON.stringify({ b: !!approverB.cookie, n: !!adminNoFin.cookie, h: !!headOnly.cookie }));

const locs = ((await req(admin, "GET", "/api/locations?limit=2000")).data?.items ?? []).filter((l) => l.name);
const locA = locs[0], locB = locs.find((l) => l.name !== locA?.name);
ok("[precondition] two differently named centres exist", !!locA && !!locB);
const cats = (await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [];
const plain = cats.find((c) => !c.pre_approved && !/^(other|misc)/i.test(String(c.name)) && !c.parent);
ok("[precondition] a plain cost head exists", !!plain);

const withBrowser = async (fn) => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try { return await fn(browser); } finally { try { await browser.close(); } catch {} }
};

try {
  const cfg = (await req(admin, "GET", "/api/approvals?status=Pending")).data?.config ?? [];
  ruleBefore = cfg.find((c) => c.action === "cost.post") ?? { enabled: false, approver_role: "Admin" };
  ok("[precondition] cost.post approval is ON (Admin decides) so a posted cost parks",
    (await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: true, approver_role: "Admin" })).status === 200);

  // ---- fixtures, through the real door ------------------------------------------------------
  const park = async (who, k, loc) => {
    const r = await req(who, "POST", "/api/costs", { entry_date: "2031-05-04", location: loc._id, category: plain._id, amount: AMT[k], note: tag(k) });
    const id = r.data?.item?._id ? String(r.data.item._id) : "";
    if (id) created.requests.push(id);
    created.ledgerNotes.push(tag(k));
    return { status: r.status, id };
  };
  const baseline = await rawApprovals.countDocuments({ action: "cost.post", status: { $in: ["Pending", "Applying"] } });
  console.log(`info: Pending|Applying cost.post requests left by earlier suites: ${baseline}; all Pending|Applying approvals: ${await rawApprovals.countDocuments({ status: { $in: ["Pending", "Applying"] } })}`);
  const T = {
    t1: await park(ops, "t1", locA), t2: await park(ops, "t2", locB), t3: await park(approverB.cookie, "t3", locA),
    t4: await park(ops, "t4", locA), t5: await park(ops, "t5", locB),
  };
  ok("[precondition] five cost requests parked (202) and none reached the ledger",
    Object.values(T).every((t) => t.status === 202 && t.id) && (await rawCosts.countDocuments({ note: { $regex: `^zzbox ${stamp} ` } })) === 0,
    JSON.stringify(T));
  const pendingN = () => rawApprovals.countDocuments({ action: "cost.post", status: { $in: ["Pending", "Applying"] } });

  const asPage = async (browser, email, password, watch = null) => {
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();
    if (watch) page.on("request", (r) => watch.push(r.url()));
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
  const box = (page) => page.locator("[data-cost-approval-box]");
  const row = (page, id) => page.locator(`[data-cost-approval-id="${id}"]`);
  const idsShown = (page) => page.$$eval("[data-cost-approval-id]", (els) => els.map((e) => e.getAttribute("data-cost-approval-id")));
  const mine = (ids) => ids.filter((i) => created.requests.includes(i));
  const waitBox = async (page) => { await box(page).waitFor({ state: "visible", timeout: 30000 }).catch(() => {}); await row(page, T.t1.id).waitFor({ state: "visible", timeout: 30000 }).catch(() => {}); };
  const settle = (page) => page.waitForLoadState("networkidle").catch(() => {});
  const title = async (page) => ((await box(page).locator("h3").first().innerText().catch(() => "")) || "").trim();

  await withBrowser(async (browser) => {
    // ---- K4 Home card: deciders only -----------------------------------------------------------
    const a = await asPage(browser, "admin@vidysea.com", ADMIN_PW);
    const nHome = await pendingN();
    await a.page.goto(BASE + "/", { waitUntil: "networkidle" });
    const card = a.page.locator("[data-cost-approvals-card]");
    await card.waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    const cardText = (await card.count()) ? (await card.first().innerText()).replace(/\s+/g, " ") : "";
    ok("K4 Home: a decider sees the card with the number of cost requests waiting", new RegExp(`^${nHome} cost approvals? waiting for you`).test(cardText), `want ${nHome} got "${cardText}"`);
    ok("K4 Home: the card links to /costs#approvals", ((await card.first().getAttribute("href").catch(() => "")) ?? "").endsWith("/costs#approvals"),
      String(await card.first().getAttribute("href").catch(() => "")));
    await card.first().click().catch(() => {});
    await a.page.waitForURL((u) => /\/costs/.test(String(u)), { timeout: 30000 }).catch(() => {});
    await waitBox(a.page);
    ok("K4 Home: following the card lands on /costs#approvals with the box on screen", /\/costs#approvals$/.test(a.page.url()) && (await box(a.page).isVisible()), a.page.url());

    // ---- K1 the box for a decider --------------------------------------------------------------
    await a.page.goto(BASE + "/costs", { waitUntil: "networkidle" });
    await waitBox(a.page);
    const nBox = await pendingN();
    ok("K1 box: a decider sees the box titled with the number waiting", (await title(a.page)) === `Waiting for your approval (${nBox})`, `want (${nBox}) got "${await title(a.page)}"`);
    const shown0 = mine(await idsShown(a.page));
    ok("K1 box: the title is the baseline read before this suite parked anything plus its five requests (whatever other suites left behind)",
      (await title(a.page)) === `Waiting for your approval (${baseline + 5})`, `baseline ${baseline}, title "${await title(a.page)}"`);
    ok("K1 box: all five parked cost requests are listed, Pending by default", [T.t1, T.t2, T.t3, T.t4, T.t5].every((t) => shown0.includes(t.id)), JSON.stringify(shown0));
    const t1text = (await row(a.page, T.t1.id).innerText()).replace(/\s+/g, " ");
    ok("K1 box: a row carries the summary, centre, who requested it and the Pending status",
      t1text.includes(tag("t1")) && t1text.includes(locA.name) && /requested by/.test(t1text) && /Pending/.test(t1text), t1text.slice(0, 300));
    ok("K1 box: the box sits ABOVE the register", await a.page.evaluate(() => {
      const b = document.querySelector("[data-cost-approval-box]"); const t = [...document.querySelectorAll("h3")].find((h) => /All cost entries/.test(h.textContent || ""));
      return !!b && (!t || !!(b.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING));
    }));

    // ---- K3 filters ----------------------------------------------------------------------------
    await box(a.page).locator('select[aria-label="Filter by centre"]').selectOption({ label: locA.name });
    const byCentre = mine(await idsShown(a.page));
    ok("K3 filter: centre narrows the list to that centre's requests", [T.t1, T.t3, T.t4].every((t) => byCentre.includes(t.id)) && ![T.t2, T.t5].some((t) => byCentre.includes(t.id)), JSON.stringify(byCentre));
    await box(a.page).locator('select[aria-label="Filter by centre"]').selectOption("");
    await box(a.page).locator('select[aria-label="Filter by requested by"]').selectOption({ label: approverB.name });
    const byWho = mine(await idsShown(a.page));
    ok("K3 filter: requested-by narrows to that person's request", byWho.length === 1 && byWho[0] === T.t3.id, JSON.stringify(byWho));
    await box(a.page).locator('select[aria-label="Filter by requested by"]').selectOption("");
    await box(a.page).locator('input[aria-label="Search requests"]').fill(tag("t2"));
    const bySearch = mine(await idsShown(a.page));
    ok("K3 filter: text search narrows to the matching request", bySearch.length === 1 && bySearch[0] === T.t2.id, JSON.stringify(bySearch));
    await box(a.page).locator('input[aria-label="Search requests"]').fill(`zzbox ${stamp} nosuchthing`);
    ok("K3 filter: a search that matches nothing says so", /No requests match these filters/.test(await box(a.page).innerText()));
    await box(a.page).locator('input[aria-label="Search requests"]').fill("");
    ok("K3 filter: clearing the filters brings every request back", mine(await idsShown(a.page)).length === 5);
    await box(a.page).getByRole("button", { name: "Rejected", exact: true }).click();
    await settle(a.page);
    ok("K1/K3 title: the number in the title is the PENDING count even while another tab is open",
      (await title(a.page)) === `Waiting for your approval (${await pendingN()})`, await title(a.page));
    await box(a.page).getByRole("button", { name: "Pending", exact: true }).click();
    await a.context.close();

    // ---- K2 own request: no buttons, and the server still refuses ------------------------------
    const b = await asPage(browser, approverB.email, PW);
    await b.page.goto(BASE + "/costs", { waitUntil: "networkidle" });
    await waitBox(b.page);
    const own = (await row(b.page, T.t3.id).count()) ? (await row(b.page, T.t3.id).innerText()).replace(/\s+/g, " ") : "";
    ok("K2 own request: the raiser sees their own request in the box", own.includes(tag("t3")), own.slice(0, 200));
    ok("K2 own request: with NO Approve / Reject and the reason in words",
      (await row(b.page, T.t3.id).locator("button").count()) === 0 && own.includes("Your own request - another approver decides."), own.slice(0, 300));
    ok("K2 own request: another person's request in the same box does offer the buttons",
      (await row(b.page, T.t1.id).getByRole("button", { name: /Approve & apply/ }).count()) === 1 && (await row(b.page, T.t1.id).getByRole("button", { name: "Reject" }).count()) === 1);
    await b.context.close();
    const selfTry = await req(approverB.cookie, "POST", `/api/approvals/${T.t3.id}`, { decision: "Approved" });
    ok("K2 own request: the server still refuses the raiser deciding it (403) and wrote nothing",
      selfTry.status === 403 && (await rawApprovals.findOne({ _id: new ObjectId(T.t3.id) }))?.status === "Pending" && (await rawCosts.countDocuments({ note: tag("t3") })) === 0,
      JSON.stringify(selfTry));

    // ---- K5 non-deciders -----------------------------------------------------------------------
    for (const [label, email, pw, mustNotSee] of [
      ["Operations", "ops@vidysea.com", PW, [tag("t3"), fmt(AMT.t3)]],
      ["Admin without finance.approve", adminNoFin.email, PW, [tag("t1"), tag("t3"), fmt(AMT.t1), fmt(AMT.t3)]],
    ]) {
      const seen = [];
      const p = await asPage(browser, email, pw, seen);
      await p.page.goto(BASE + "/", { waitUntil: "networkidle" });
      await settle(p.page);
      ok(`K5 ${label}: Home has no cost-approval card`, (await p.page.locator("[data-cost-approvals-card]").count()) === 0);
      await p.page.goto(BASE + "/costs", { waitUntil: "networkidle" });
      await settle(p.page);
      ok(`K5 ${label}: Costs has no approval box`, (await box(p.page).count()) === 0);
      ok(`K5 ${label}: neither page asked for the approval queue`, !seen.some((u) => /\/api\/approvals\?status=/.test(u)), JSON.stringify(seen.filter((u) => /api\/approvals/.test(u))));
      const bodyText = await p.page.locator("body").innerText();
      ok(`K5 ${label}: no other person's cost request or amount is on the page`, mustNotSee.every((s) => !bodyText.includes(s)), mustNotSee.filter((s) => bodyText.includes(s)).join(" | "));
      await p.context.close();
    }

    // ---- K2 deciding from the box --------------------------------------------------------------
    const d = await asPage(browser, "admin@vidysea.com", ADMIN_PW);
    await d.page.goto(BASE + "/costs", { waitUntil: "networkidle" });
    await waitBox(d.page);
    const R = (id) => row(d.page, id);
    const gone = (id) => R(id).waitFor({ state: "detached", timeout: 30000 }).then(() => true).catch(() => false);
    const amtInput = (id) => R(id).locator('input[type="number"]');
    const noteInput = (id) => R(id).locator('input[placeholder="Note (optional)"]');

    // The register's own total is the evidence it was reloaded after each decision.
    const regTotal = async () => {
      const h = await d.page.locator("h3").filter({ hasText: /All cost entries/ }).first().innerText().catch(() => "");
      const m = h.match(/total ₹([\d,]+)/);
      return m ? Number(m[1].replace(/,/g, "")) : NaN;
    };
    const waitTotal = (want) => d.page.waitForFunction((w) => {
      const h = [...document.querySelectorAll("h3")].find((x) => /All cost entries/.test(x.textContent || ""));
      const m = h && (h.textContent || "").match(/total ₹([\d,]+)/);
      return !!m && Number(m[1].replace(/,/g, "")) === w;
    }, want, { timeout: 30000 }).catch(() => {});
    await settle(d.page);
    const totalStart = await regTotal();
    // partial amount needs a note - the same refusal the Admin tab gets
    await amtInput(T.t5.id).fill("3000");
    await R(T.t5.id).getByRole("button", { name: /Approve & apply/ }).click();
    await d.page.getByText(/Add a note explaining a partial approval/).first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    ok("K2 partial: a lower amount with no note is refused, the error shows in the banner",
      (await d.page.getByText(/Add a note explaining a partial approval/).count()) > 0);
    ok("K2 partial: and nothing was written - request still Pending, no ledger row",
      (await rawApprovals.findOne({ _id: new ObjectId(T.t5.id) }))?.status === "Pending" && (await rawCosts.countDocuments({ note: tag("t5") })) === 0);
    await noteInput(T.t5.id).fill("cut to the voucher total");
    await R(T.t5.id).getByRole("button", { name: /Approve & apply/ }).click();
    const t5gone = await gone(T.t5.id);
    const t5led = await rawCosts.findOne({ note: tag("t5") });
    await waitTotal(totalStart + 3000);
    ok("K2 partial: with a note it is approved at the lower amount and the request leaves Pending",
      t5gone && t5led?.amount === 3000 && t5led?.requested_amount === AMT.t5, JSON.stringify({ t5gone, amount: t5led?.amount, req: t5led?.requested_amount }));

    // approve in full
    await R(T.t1.id).getByRole("button", { name: /Approve & apply/ }).click();
    const t1gone = await gone(T.t1.id);
    const t1led = await rawCosts.findOne({ note: tag("t1") });
    ok("K2 approve: Approve & apply writes ONE ledger row at the requested amount, linked to the request",
      t1gone && (await rawCosts.countDocuments({ note: tag("t1") })) === 1 && t1led?.amount === AMT.t1 && String(t1led?.approval_request) === T.t1.id,
      JSON.stringify({ t1gone, amount: t1led?.amount, link: String(t1led?.approval_request) }));
    ok("K2 approve: the request is Approved and decided by the signed-in approver",
      (await rawApprovals.findOne({ _id: new ObjectId(T.t1.id) }))?.status === "Approved"
        && String((await rawApprovals.findOne({ _id: new ObjectId(T.t1.id) }))?.decided_by) === String(adminRow._id));
    await settle(d.page);
    await waitTotal(totalStart + 3000 + AMT.t1);
    const totalAfter = await regTotal();
    ok("K2 approve: the register on the same page was reloaded after each decision - its total rose by the two approved amounts (3000 sanctioned + 1111)",
      Number.isFinite(totalStart) && totalAfter === totalStart + 3000 + AMT.t1, `start=${totalStart} after=${totalAfter}`);

    // reject
    await noteInput(T.t2.id).fill("no voucher");
    await R(T.t2.id).getByRole("button", { name: "Reject" }).click();
    const t2gone = await gone(T.t2.id);
    const t2req = await rawApprovals.findOne({ _id: new ObjectId(T.t2.id) });
    ok("K2 reject: Reject writes NO ledger row, marks the request Rejected and keeps the note",
      t2gone && (await rawCosts.countDocuments({ note: tag("t2") })) === 0 && t2req?.status === "Rejected" && t2req?.decision_note === "no voucher",
      JSON.stringify({ t2gone, status: t2req?.status, note: t2req?.decision_note }));

    // same path as the Admin tab: a twin request decided through POST /api/approvals/[id] directly
    const tw = await req(admin, "POST", `/api/approvals/${T.t4.id}`, { decision: "Approved" });
    const t4led = await rawCosts.findOne({ note: tag("t4") });
    // `_audit_*` carry the new row's own id and event id, so they differ by construction; everything else must match.
    const skip = new Set(["_id", "note", "amount", "approval_request", "createdAt", "updatedAt", "__v", "requested_amount", "entry_key", "idempotency_key"]);
    const shape = (doc) => Object.keys(doc ?? {}).filter((k) => !skip.has(k) && !k.startsWith("_audit")).sort().map((k) => `${k}=${JSON.stringify(doc[k])}`).join("|");
    ok("K2 same path: a cost approved from the box is written exactly as one approved through the Admin tab's endpoint (same fields, same values bar id/note/amount)",
      tw.status === 200 && !!t4led && !!t1led && shape(t1led) === shape(t4led), `\nbox:  ${shape(t1led)}\ntab:  ${shape(t4led)}`);

    // ---- K3 tabs -------------------------------------------------------------------------------
    await d.page.goto(BASE + "/costs", { waitUntil: "networkidle" });
    await box(d.page).waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    await box(d.page).getByRole("button", { name: "Approved", exact: true }).click();
    await row(d.page, T.t1.id).waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    const apprIds = mine(await idsShown(d.page));
    ok("K3 tabs: Approved lists the approved requests, not the rejected one", [T.t1, T.t4, T.t5].every((t) => apprIds.includes(t.id)) && !apprIds.includes(T.t2.id), JSON.stringify(apprIds));
    const t5text = (await row(d.page, T.t5.id).innerText()).replace(/\s+/g, " ");
    ok("K3 tabs: an approved row is read-only and shows decider, time, note and the sanctioned amount",
      (await row(d.page, T.t5.id).locator("button").count()) === 0 && /decided by/.test(t5text) && t5text.includes(adminRow.name) && /Note: cut to the voucher total/.test(t5text) && t5text.includes("Approved amount: " + fmt(3000)),
      t5text.slice(0, 300));
    await box(d.page).getByRole("button", { name: "Rejected", exact: true }).click();
    await row(d.page, T.t2.id).waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    const rejIds = mine(await idsShown(d.page));
    const t2text = (await row(d.page, T.t2.id).innerText()).replace(/\s+/g, " ");
    ok("K3 tabs: Rejected lists only the rejected request, read-only, with the reason",
      rejIds.length === 1 && rejIds[0] === T.t2.id && (await row(d.page, T.t2.id).locator("button").count()) === 0 && /Reason: no voucher/.test(t2text) && /decided by/.test(t2text),
      JSON.stringify({ rejIds, t2text: t2text.slice(0, 300) }));
    await box(d.page).getByRole("button", { name: "Pending", exact: true }).click();
    await settle(d.page);
    const pendAfter = mine(await idsShown(d.page));
    ok("K3 tabs: Pending no longer lists anything we decided, and still lists the raiser's own request", pendAfter.length === 1 && pendAfter[0] === T.t3.id, JSON.stringify(pendAfter));
    await d.context.close();

    // ---- K6 masking, read BEFORE the window is filled: the plain list and the narrowed one still contain our request
    // (an Admin without finance.view sees the narrowed row exactly as the plain list shows it)
    // money masking: an Admin without finance.view sees the narrowed row exactly as the plain list shows it
    const nfPlain = await req(adminNoFin.cookie, "GET", "/api/approvals?status=Pending");
    const nfNar = await req(adminNoFin.cookie, "GET", "/api/approvals?status=Pending&action=cost.post");
    const nfA = (nfPlain.data?.items ?? []).find((r) => String(r._id) === T.t3.id);
    const nfB = (nfNar.data?.items ?? []).find((r) => String(r._id) === T.t3.id);
    ok("K6 masking: a reader without finance.view gets the cost request through ?action=cost.post byte-for-byte as the plain list gives it, and no amount in it",
      !!nfA && !!nfB && JSON.stringify(nfA) === JSON.stringify(nfB) && JSON.stringify(nfB).indexOf(String(AMT.t3)) < 0 && JSON.stringify(nfB).indexOf(fmt(AMT.t3)) < 0,
      `plain=${!!nfA} narrowed=${!!nfB} ${JSON.stringify(nfB).slice(0, 240)}`);

    // ---- K6 the true count past the 100-row window ---------------------------------------------
    const seedRow = (action, k, extra = {}) => ({
      action, summary: `zzbox ${stamp} seed ${action} ${k}`, payload: {}, status: "Pending", approver_role: "Admin",
      initiator: adminRow._id, approver_users: [], createdAt: new Date(), updatedAt: new Date(), ...extra,
    });
    const otherActions = ["batch.cancel", "invoice.raise", "location.close", "costcategory.create"];
    const seedOther = Array.from({ length: 110 }, (_, i) => seedRow(otherActions[i % otherActions.length], i));
    const insOther = await rawApprovals.insertMany(seedOther);
    created.seeded.push(...Object.values(insOther.insertedIds));
    const trueCost = await pendingN();
    const win = (await req(admin, "GET", "/api/approvals?status=Pending")).data?.items ?? [];
    const costInWin = win.filter((r) => r.action === "cost.post").length;
    ok("K6 [precondition]: the unfiltered Pending list is full (100) and hides every cost request - the scenario the r2 wall hit",
      win.length === 100 && costInWin < trueCost, `window=${win.length} costInWindow=${costInWin} trueCost=${trueCost}`);
    const nar = await req(admin, "GET", "/api/approvals?status=Pending&action=cost.post");
    const narItems = nar.data?.items ?? [];
    ok("K6 API: ?action=cost.post returns only cost.post rows and the server's true count",
      nar.status === 200 && narItems.length === Math.min(100, trueCost) && narItems.every((r) => r.action === "cost.post") && nar.data?.total === trueCost,
      `status ${nar.status} items=${narItems.length} total=${nar.data?.total} trueCost=${trueCost}`);
    ok("K6 API: the cost.post list still carries this suite's own pending request although 110 newer approvals of other kinds exist",
      narItems.some((r) => String(r._id) === T.t3.id));

    const h = await asPage(browser, "admin@vidysea.com", ADMIN_PW);
    await h.page.goto(BASE + "/", { waitUntil: "networkidle" });
    const hcard = h.page.locator("[data-cost-approvals-card]");
    await hcard.waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    const hcardText = (await hcard.count()) ? (await hcard.first().innerText()).replace(/\s+/g, " ") : "";
    ok("K6 Home: with more than 100 mixed approvals pending the card shows the TRUE number of cost requests waiting",
      new RegExp(`^${trueCost} cost approvals? waiting for you`).test(hcardText), `want ${trueCost} got "${hcardText}"`);
    await h.page.goto(BASE + "/costs", { waitUntil: "networkidle" });
    await box(h.page).waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    await row(h.page, T.t3.id).waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    ok("K6 box: the title shows the TRUE number of Pending cost requests with more than 100 mixed approvals pending",
      (await title(h.page)) === `Waiting for your approval (${trueCost})`, `want (${trueCost}) got "${await title(h.page)}"`);
    ok("K6 box: and the list has the cost requests (not emptied by the other kinds)", mine(await idsShown(h.page)).includes(T.t3.id));
    await box(h.page).getByRole("button", { name: "Rejected", exact: true }).click();
    await settle(h.page);
    ok("K6 box: the title stays the true Pending number while another tab is open", (await title(h.page)) === `Waiting for your approval (${trueCost})`, await title(h.page));
    await box(h.page).getByRole("button", { name: "Pending", exact: true }).click();
    await settle(h.page);

    // push the cost.post queue itself past 100, and the list must say it is cut off
    const needCost = Math.max(0, 101 - trueCost);
    if (needCost) {
      const insCost = await rawApprovals.insertMany(Array.from({ length: needCost }, (_, i) =>
        seedRow("cost.post", i, { location: locA._id, payload: { amount: 10, category: String(plain._id) } })));
      created.seeded.push(...Object.values(insCost.insertedIds));
    }
    const bigCost = await pendingN();
    await h.page.goto(BASE + "/costs", { waitUntil: "networkidle" });
    await box(h.page).waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    await h.page.locator("[data-cost-approval-truncated]").waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    const truncLoc = h.page.locator("[data-cost-approval-truncated]");
    const trunc = (await truncLoc.count()) ? (await truncLoc.first().innerText()).replace(/\s+/g, " ") : "";
    ok(`K6 box: past 100 Pending cost requests the title is still the true number (${bigCost})`, (await title(h.page)) === `Waiting for your approval (${bigCost})`, `want (${bigCost}) got "${await title(h.page)}"`);
    const shownRows = (await idsShown(h.page)).length;
    ok("K6 box: ...and it says the list is cut off, with the shown and the true number",
      bigCost > 100 && trunc === `Showing the newest 100 of ${bigCost} pending cost requests. Decide some to see the rest.` && shownRows === 100, `trunc "${trunc}" rows=${shownRows}`);
    const bigNar = await req(admin, "GET", "/api/approvals?status=Pending&action=cost.post");
    ok("K6 API: past 100 the list is capped at 100 rows and total is the true count", bigNar.data?.items?.length === 100 && bigNar.data?.total === bigCost, `items=${bigNar.data?.items?.length} total=${bigNar.data?.total} want ${bigCost}`);
    await h.context.close();

    // ---- K6 the narrowing never widens ---------------------------------------------------------
    const idsOf = (r) => (r.data?.items ?? []).map((x) => String(x._id));
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    // a head-sign-off-only reader: no parked cost, whatever they ask for
    const hoPlain = await req(headOnly.cookie, "GET", "/api/approvals?status=Pending");
    const hoCost = await req(headOnly.cookie, "GET", "/api/approvals?status=Pending&action=cost.post");
    const hoCat = await req(headOnly.cookie, "GET", "/api/approvals?status=Pending&action=costcategory.create");
    const hoBatch = await req(headOnly.cookie, "GET", "/api/approvals?status=Pending&action=batch.cancel");
    ok("K6 no widening: a reader without the queue right who asks action=cost.post gets NO cost request (and total 0)",
      hoCost.status === 200 && (hoCost.data?.items ?? []).length === 0 && hoCost.data?.total === 0, `status ${hoCost.status} ${JSON.stringify(hoCost.data).slice(0, 200)}`);
    ok("K6 no widening: asking for another action (batch.cancel) gives that reader nothing either",
      hoBatch.status === 200 && (hoBatch.data?.items ?? []).length === 0 && hoBatch.data?.total === 0, `status ${hoBatch.status} items=${(hoBatch.data?.items ?? []).length}`);
    const seededCat = (hoCat.data?.items ?? []).filter((r) => String(r.summary).startsWith(`zzbox ${stamp} seed`));
    ok("K6 no widening: asking for costcategory.create gives them head sign-offs only, never this suite's non-head costcategory.create rows",
      hoCat.status === 200 && seededCat.length === 0 && (hoCat.data?.items ?? []).every((r) => ["head-approval", "cap-approval"].includes(r.payload?.kind)),
      `status ${hoCat.status} seededVisible=${seededCat.length}`);
    ok("K6 no widening: that reader's plain list is untouched (head sign-offs only, no rule config)",
      hoPlain.status === 200 && (hoPlain.data?.items ?? []).every((r) => r.action === "costcategory.create" && ["head-approval", "cap-approval"].includes(r.payload?.kind)) && (hoPlain.data?.config ?? []).length === 0,
      `status ${hoPlain.status}`);
    // a caller with no approvals right at all is refused the same way with or without the parameter
    const opsPlain = await req(ops, "GET", "/api/approvals?status=Pending");
    const opsCost = await req(ops, "GET", "/api/approvals?status=Pending&action=cost.post");
    ok("K6 no widening: a caller with no approvals right gets the same refusal with or without ?action=cost.post (and no rows)",
      opsPlain.status === opsCost.status && opsCost.status !== 200 && !(opsCost.data?.items ?? []).length, `plain ${opsPlain.status} narrowed ${opsCost.status}`);
    // an unknown action value is ignored (the list is exactly the un-narrowed one), never widened and never an error
    const unk = await req(admin, "GET", "/api/approvals?status=Pending&action=no.such.action");
    const unkPlain = await req(admin, "GET", "/api/approvals?status=Pending");
    ok("K6 unknown action: an unrecognised value is ignored - same rows as no parameter, no total, no error",
      unk.status === 200 && same(idsOf(unk), idsOf(unkPlain)) && unk.data?.total === undefined, `status ${unk.status} total=${unk.data?.total}`);
    const inj = await req(admin, "GET", "/api/approvals?status=Pending&action[$ne]=cost.post&action=%24ne");
    ok("K6 unknown action: an operator-shaped value is ignored too (same rows, no total)", inj.status === 200 && same(idsOf(inj), idsOf(unkPlain)) && inj.data?.total === undefined, `status ${inj.status}`);
  });
} catch (e) {
  ok("the suite ran without a crash", false, String(e?.stack ?? e).slice(0, 500));
} finally {
  // Leave the database as found: the rule as it was, every fixture removed.
  try {
    if (ruleBefore) await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: !!ruleBefore.enabled, approver_role: ruleBefore.approver_role ?? "Admin" });
    await rawCosts.deleteMany({ note: { $regex: `^zzbox ${stamp} ` } });
    await rawApprovals.deleteMany({ _id: { $in: [...created.requests.map((i) => new ObjectId(i)), ...created.seeded] } });
    await rawUsers.deleteMany({ _id: { $in: created.users.map((i) => new ObjectId(i)) } });
    const left = (await rawCosts.countDocuments({ note: { $regex: `^zzbox ${stamp} ` } })) + (await rawApprovals.countDocuments({ _id: { $in: [...created.requests.map((i) => new ObjectId(i)), ...created.seeded] } }))
      + (await rawApprovals.countDocuments({ summary: { $regex: `^zzbox ${stamp} seed` } }))
      + (await rawUsers.countDocuments({ _id: { $in: created.users.map((i) => new ObjectId(i)) } }));
    ok("cleanup read back: every fixture this suite made is gone", left === 0, `left=${left}`);
  } catch (e) { console.log("cleanup note: " + String(e?.message ?? e).slice(0, 200)); }
  await client.close();
}
console.log(`\ne2e-cost-approval-box.mjs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
