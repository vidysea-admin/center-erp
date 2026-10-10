// mtg-b2 R6 (meeting 2026-10-06, Umesh: "heading-subheading mein aap new create kar rahe the to usko
// dropdown banaunga ... taaki category nikalna easy"): a cost head is CHOSEN from a Head -> Subhead
// dropdown on every cost form, a new head is reached only by the explicit Others route, and the Costs
// ledger can be narrowed by head or subhead.
//
// WHAT WAS ALREADY BUILT (reconciled, not rebuilt): Q-1006a / af42b74 made the head a dropdown with a
// search box, a Head -> Subhead grouping, and a naming box that appears only after "Others"; 43f31fa
// made a head named on a cost form start Pending. This suite re-proves those so the unit stands on its
// own, and pins the gaps this unit closed:
//   filter    - GET /api/costs?category= took an id for EQUALITY, so a head showed only the entries filed
//               directly on it; it now means the head and everything under it (the Finance register and
//               its Excel export always did), a subhead means that one, a typed word is refused (400)
//   typed     - POST /api/costs with a typed head string answered 500 (BSON cast error) instead of a
//               refusal; a free-typed string can never post a cost
//   inactive  - the posting picker offered inactive heads that the server then refuses (409)
//   ui        - the Costs ledger carries a Cost head filter (Head -> Subhead, URL-held, clearable)
//
// Named guards (each has a mutant in the evidence folder that must turn its arm red):
//   expand    - filter on a head includes its subheads            (L1, L5)
//   leaf      - filter on a subhead is that subhead only          (L2)
//   badid     - a typed word on the filter is a 400, not a 500    (L3, L5b)
//   typed     - a typed head on POST is a 400, creates nothing    (P1)
//   inactive  - the picker does not offer an inactive head        (U-inact)
//   scope     - a location-scoped reader never sees another centre (S1)
//   ui-filter - the ledger renders the filter and it narrows      (U-filter)
// Identities come from the run stamp (letters only: -303 redacts digit runs in approval text).
import { requireLocalBase } from "./db-guard.mjs";
import { MongoClient, ObjectId } from "mongodb";
import * as XLSX from "xlsx";

const BASE = requireLocalBase("e2e-cost-head-dropdown", process.env.BASE_URL || "http://localhost:3000/erp");
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
async function reqBuffer(cookie, p) {
  const res = await fetch(BASE + p, { headers: { cookie } });
  return { status: res.status, data: Buffer.from(await res.arrayBuffer()) };
}

const client = new MongoClient(process.env.MONGODB_URL || "mongodb://127.0.0.1:27017", { serverSelectionTimeoutMS: 8000 });
await client.connect();
const db = client.db((process.env.MONGODB_DB || "center_erp_ci").trim());
const rawCats = db.collection("costcategories");
const rawCosts = db.collection("costentries");
const rawApprovals = db.collection("approvalrequests");

const PW = "CiOnly@123";
const stamp = Date.now().toString(36).replace(/[0-9]/g, (d) => "qrstuvwxyz"[Number(d)]);
const N = {
  h1: `ZZ B2 Alpha ${stamp}`, s1: `ZZ B2 Beta ${stamp}`, s2: `ZZ B2 Gamma ${stamp}`,
  h2: `ZZ B2 Delta ${stamp}`, s3: `ZZ B2 Epsilon ${stamp}`, off: `ZZ B2 Retired ${stamp}`,
  typed: `ZZ B2 Typed ${stamp}`, req: `ZZ B2 Requested ${stamp}`,
};
const TAG = (k) => `zzb2 ${stamp} ${k}`;

const admin = await login("admin@vidysea.com", process.env.ADMIN_PASSWORD || "admin123");
const ops = await login("ops@vidysea.com", PW);
ok("[precondition] personas sign in", !!admin && !!ops, `admin=${!!admin} ops=${!!ops}`);

const mkUser = async (name, email, role, grants, scope = []) => {
  const made = await req(admin, "POST", "/api/users", { name, email, password: PW, role, can_edit: true, location_scope: scope });
  if (made.data?.item?._id && grants.length) await req(admin, "PATCH", `/api/users/${made.data.item._id}`, { extra_permissions: grants });
  return { made, id: made.data?.item?._id, cookie: await login(email, PW) };
};
const approverB = await mkUser(`B2 Approver ${stamp}`, `zz.b2.appr.${stamp}@vidysea-test.local`, "Admin", ["finance.view", "finance.approve"]);

const locs = (await req(admin, "GET", "/api/locations?limit=2000")).data?.items ?? [];
const ownLoc = locs.find((l) => l.code === "JPR03");
const foreignLoc = locs.find((l) => l.code === "KOT02");
ok("[precondition] own and foreign locations exist; a second approver signs in", !!ownLoc && !!foreignLoc && !!approverB.cookie,
  JSON.stringify({ own: !!ownLoc, foreign: !!foreignLoc, b: approverB.made.status }));

const cfg = (await req(admin, "GET", "/api/approvals?status=Pending")).data?.config ?? [];
const ruleBefore = cfg.find((c) => c.action === "cost.post") ?? { enabled: false, approver_role: "Admin" };
const rule = (enabled) => req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled, approver_role: ruleBefore.approver_role ?? "Admin" });

let browser;
try {
  ok("[precondition] cost.post approval OFF while the fixture ledger rows are posted", (await rule(false)).status === 200);

  // ---- fixtures through the real doors -------------------------------------------------------
  const mkHead = async (name, parent) => {
    const r = await req(admin, "POST", "/api/master-lists/cost-categories", { name, ...(parent ? { parent } : {}) });
    const id = r.data?.item?._id;
    // signed off by the SECOND approver, as production does (a creator never approves their own head)
    const hr = id ? await rawApprovals.findOne({ action: "costcategory.create", entity_id: new ObjectId(String(id)), status: "Pending" }) : null;
    if (hr) await req(approverB.cookie, "POST", `/api/approvals/${hr._id}`, { decision: "Approved", note: "fixture: sign off" });
    return { id: id ? String(id) : "", status: r.status };
  };
  const H1 = await mkHead(N.h1);
  const S1 = await mkHead(N.s1, H1.id);
  const S2 = await mkHead(N.s2, H1.id);
  const H2 = await mkHead(N.h2);
  const S3 = await mkHead(N.s3, H2.id);
  const OFF = await mkHead(N.off);
  ok("[precondition] two heads, three subheads and a head to retire were created through the master-list door",
    [H1, S1, S2, H2, S3, OFF].every((x) => x.status === 201 && x.id), JSON.stringify([H1, S1, S2, H2, S3, OFF].map((x) => x.status)));

  const row = (cat, k, over = {}) => ({ entry_date: "2031-05-04", location: ownLoc._id, amount: 410, category: cat.id, note: TAG(k), ...over });
  const post = (cookie, body) => req(cookie, "POST", "/api/costs", body);
  const posted = await Promise.all([
    post(admin, row(H1, "h1")), post(admin, row(S1, "s1")), post(admin, row(S2, "s2")),
    post(admin, row(H2, "h2")), post(admin, row(S3, "s3")),
    post(admin, row(H1, "h1-foreign", { location: foreignLoc._id })),
  ]);
  ok("[precondition] six ledger rows posted: one on each head, one on each subhead, one foreign-centre row on the first head",
    posted.every((r) => r.status === 201), JSON.stringify(posted.map((r) => r.status)));

  const notesOf = (items) => (items ?? []).map((r) => String(r.note)).filter((n) => n.startsWith(`zzb2 ${stamp} `)).sort();
  const want = (...ks) => ks.map(TAG).sort();
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const ledger = async (cookie, qs) => req(cookie, "GET", `/api/costs?${qs}`);

  // ---- L: the ledger filter, API ------------------------------------------------------------
  const L1 = await ledger(admin, `category=${H1.id}`);
  ok("L1 expand: filtering the ledger on a HEAD returns the head's own entries AND every subhead's (and nothing from another head)",
    L1.status === 200 && same(notesOf(L1.data.items), want("h1", "h1-foreign", "s1", "s2")),
    `got ${L1.status} ${JSON.stringify(notesOf(L1.data.items))}`);
  const L2 = await ledger(admin, `category=${S1.id}`);
  ok("L2 leaf: filtering on a SUBHEAD returns that subhead's entries only - not its sibling, not its head",
    L2.status === 200 && same(notesOf(L2.data.items), want("s1")), `got ${L2.status} ${JSON.stringify(notesOf(L2.data.items))}`);
  const L3 = await ledger(admin, `category=${N.typed.replace(/ /g, "-")}`);
  ok("L3 badid: a typed word on the head filter is refused (400), not a 500 and not 'everything'", L3.status === 400, `got ${L3.status} ${JSON.stringify(L3.data).slice(0, 120)}`);
  const ghost = new ObjectId().toHexString();
  const L3b = await ledger(admin, `category=${ghost}`);
  ok("L3b: a well-formed id that names no head is an empty ledger (200), not an error",
    L3b.status === 200 && (L3b.data.items ?? []).length === 0, `got ${L3b.status} n=${(L3b.data.items ?? []).length}`);
  const L4 = await ledger(admin, `category=${H1.id}&location=${ownLoc._id}`);
  ok("L4: the head filter narrows together with Location (the foreign-centre row drops out)",
    L4.status === 200 && same(notesOf(L4.data.items), want("h1", "s1", "s2")), `got ${JSON.stringify(notesOf(L4.data.items))}`);
  // register and export share the filter function with the ledger
  const reg = (await req(admin, "GET", `/api/reports/costs?category=${H1.id}`)).data?.register ?? [];
  ok("L5 expand (register): the Finance register returns the same set for the same head filter as the ledger",
    same(notesOf(reg), want("h1", "h1-foreign", "s1", "s2")), JSON.stringify(notesOf(reg)));
  const xl = XLSX.read((await reqBuffer(admin, `/api/reports/costs/export?category=${H1.id}`)).data, { type: "buffer" });
  const xrows = XLSX.utils.sheet_to_json(xl.Sheets["cost entry register"] ?? {}).map((r) => ({ note: r.Description }));
  ok("L5 expand (export): the Excel export returns the same set", same(notesOf(xrows), want("h1", "h1-foreign", "s1", "s2")), JSON.stringify(notesOf(xrows)));
  const badReg = await req(admin, "GET", `/api/reports/costs?category=${N.typed.replace(/ /g, "-")}`);
  const badXl = await reqBuffer(admin, `/api/reports/costs/export?category=${N.typed.replace(/ /g, "-")}`);
  ok("L5b badid: a typed word is refused (400) on the register and on the export too - one parser for all three",
    badReg.status === 400 && badXl.status === 400, `register ${badReg.status}, export ${badXl.status}`);

  // ---- S: scope and permissions --------------------------------------------------------------
  const scoped = await mkUser(`B2 Scoped ${stamp}`, `zz.b2.scope.${stamp}@vidysea-test.local`, "Location", ["finance.view"], [ownLoc._id]);
  ok("[precondition] a location-scoped finance viewer signs in", !!scoped.cookie, JSON.stringify(scoped.made.data).slice(0, 140));
  if (scoped.cookie) {
    const sl = await ledger(scoped.cookie, `category=${H1.id}`);
    ok("S1 scope: a location-scoped reader filtering on the head sees only their own centre's rows (the foreign row is absent)",
      sl.status === 200 && same(notesOf(sl.data.items), want("h1", "s1", "s2")), `got ${sl.status} ${JSON.stringify(notesOf(sl.data.items))}`);
    ok("S1 non-vacuous: the all-centres reader does see that foreign row", notesOf(L1.data.items).includes(TAG("h1-foreign")));
  }
  const opsLedger = await ledger(ops, `category=${H1.id}`);
  ok("S2 permission: Operations (no finance.view) is refused (403) on the filtered ledger, as on the unfiltered one", opsLedger.status === 403, `got ${opsLedger.status}`);

  // ---- P: nothing typed ever posts a cost; the naming rules hold ------------------------------
  // counted on this run's own stamp, so another writer in the database cannot move the numbers
  const countHeads = () => rawCats.countDocuments({ name: { $regex: `typed|not-a-real-head|${ghost}`, $options: "i" } });
  const countRows = () => rawCosts.countDocuments({ note: TAG("typed") });
  const before = { heads: await countHeads(), rows: await countRows() };
  const typedBody = { entry_date: "2031-05-04", location: ownLoc._id, amount: 410, note: TAG("typed") };
  const P1a = await post(admin, { ...typedBody, category: N.typed });
  const P1b = await post(ops, { ...typedBody, category: "not-a-real-head" });
  const P1c = await post(admin, { ...typedBody, category: ghost });
  const P1d = await post(admin, { ...typedBody, category: ghost.slice(0, 12) });
  ok("P1 typed: a free-typed head string on POST /api/costs is refused with a 400 (admin and operations), not a 500",
    [P1a, P1b, P1d].every((r) => r.status === 400 && /choose a cost head from the list/i.test(String(r.data?.error))), `admin ${P1a.status}, ops ${P1b.status}, half-id ${P1d.status}`);
  ok("P1b: a well-formed id that is not in the master is refused (400)", P1c.status === 400 && /does not exist/i.test(String(P1c.data?.error)), `got ${P1c.status} ${JSON.stringify(P1c.data).slice(0, 120)}`);
  const after = { heads: await countHeads(), rows: await countRows() };
  ok("P1c: those four refusals created no head and no ledger row", after.heads === before.heads && after.rows === before.rows, JSON.stringify({ before, after }));

  // the explicit new-head route: a name through the form creates a Pending head AND its approval
  const P2 = await post(ops, { ...typedBody, note: TAG("requested"), new_subhead: N.req });
  const reqHead = await rawCats.findOne({ name: N.req });
  const reqApproval = reqHead ? await rawApprovals.findOne({ action: "costcategory.create", entity_id: reqHead._id }) : null;
  ok("P2 request: naming a new head creates it Pending and raises its own approval request (the raiser cannot sign it off)",
    P2.status === 202 && reqHead?.approval_status === "Pending" && reqApproval?.status === "Pending" && reqApproval?.payload?.kind === "head-approval" && await rawCosts.countDocuments({ note: TAG("requested") }) === 0,
    JSON.stringify({ post: P2.status, head: reqHead?.approval_status, request: reqApproval?.status, kind: reqApproval?.payload?.kind }));
  const selfSign = reqApproval ? await req(ops, "POST", `/api/approvals/${reqApproval._id}`, { decision: "Approved", note: "self" }) : { status: 0 };
  ok("P2b: the person who raised the head cannot approve it", selfSign.status >= 400 && selfSign.status < 500, `got ${selfSign.status}`);
  const P2c = await post(admin, { ...typedBody, note: TAG("requested-again"), new_subhead: `  ${N.req.toUpperCase()}  ` });
  ok("P2c: the same name typed again (other case, extra spaces) reuses that head - no duplicate is created",
    P2c.status === 202 && (await rawCats.countDocuments({ name: { $regex: `^${N.req}$`, $options: "i" } })) === 1 && await rawCosts.countDocuments({ note: TAG("requested-again") }) === 0,
    `got ${P2c.status}, heads named so: ${await rawCats.countDocuments({ name: { $regex: `^${N.req}$`, $options: "i" } })}`);

  const bad = {};
  for (const [k, v] of [["others", "Others"], ["misc", "misc"], ["miscellaneous", "  Miscellaneous "], ["short", "ab"]]) {
    bad[k] = await post(ops, { ...typedBody, note: TAG("bad-" + k), new_subhead: v });
  }
  ok("P3 naming: a new head called Others / Misc / Miscellaneous, or under three characters, is refused (400) with the reason",
    Object.values(bad).every((r) => r.status === 400 && String(r.data?.error ?? "").length > 10), JSON.stringify(Object.fromEntries(Object.entries(bad).map(([k, r]) => [k, r.status]))));
  ok("P3b: the Others refusal says to name the head", /not a label/i.test(String(bad.others.data?.error)), JSON.stringify(bad.others.data));
  const cats = (await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [];
  const bareOther = cats.find((c) => /^(others?|misc|miscellaneous)$/i.test(String(c.name)) && !c.parent && c.active !== false);
  if (bareOther) {
    const P3c = await post(ops, { ...typedBody, note: TAG("bare-other"), category: String(bareOther._id) });
    ok("P3c naming: a cost cannot be filed under the bare Other head with no name (400)", P3c.status === 400 && /name the new head/i.test(String(P3c.data?.error)),
      `got ${P3c.status} ${JSON.stringify(P3c.data).slice(0, 120)}`);
  } else ok("P3c [skipped]: this database has no bare Other head, so the bare-Other arm has nothing to drive (not a pass of the guard)", true);

  // ---- picker content ------------------------------------------------------------------------
  const retire = await req(admin, "PATCH", `/api/master-lists/cost-categories/${OFF.id}`, { active: false });
  const into = await post(admin, row(OFF, "into-retired"));
  ok("P4 inactive: a cost on a retired head is refused (409)", retire.status === 200 && into.status === 409, `patch ${retire.status}, post ${into.status}`);
  const list = (await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [];
  const byName = (n) => list.find((c) => c.name === n);
  ok("P5 two-level: the master list the picker reads carries each subhead's parent, and heads carry none",
    String(byName(N.s1)?.parent) === H1.id && String(byName(N.s2)?.parent) === H1.id && String(byName(N.s3)?.parent) === H2.id && !byName(N.h1)?.parent,
    JSON.stringify([byName(N.s1)?.parent, byName(N.h1)?.parent]));
  ok("P5b: a head named on the cost form is in the list marked Pending (the picker shows it as not approved); a signed-off head is not",
    byName(N.req)?.approval_status === "Pending" && byName(N.h1)?.approval_status !== "Pending",
    JSON.stringify([byName(N.req)?.approval_status, byName(N.h1)?.approval_status]));

  // ---- U: rendered (what a person sees) ------------------------------------------------------
  try {
    const { chromium } = await import("playwright");
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    ok("U [precondition] chromium launches from the `playwright` devDependency", false, String(e.message).slice(0, 200) + " -- run `npx playwright install chromium`");
  }
  if (browser) {
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
    // the options of the category select, grouped: [{ group: label|"", options: [text] }]
    const pickerSel = 'input[aria-label="Search cost heads"] + select';
    const groups = (page) => page.locator(pickerSel).first().evaluate((sel) => {
      const out = [];
      for (const ch of Array.from(sel.children)) {
        if (ch.tagName === "OPTGROUP") out.push({ group: ch.label, options: Array.from(ch.children).map((o) => o.textContent) });
        else out.push({ group: "", options: [ch.textContent] });
      }
      return out;
    });
    const flat = (g) => g.flatMap((x) => x.options);
    const waitForHead = async (page, name) => {
      for (let i = 0; i < 60; i++) {
        const g = await groups(page).catch(() => []);
        if (flat(g).some((t) => String(t).includes(name))) return g;
        await page.waitForTimeout(500);
      }
      return groups(page).catch(() => []);
    };
    const newBox = 'input[aria-label="Name of the new cost head"]';

    const a = await asPage("admin@vidysea.com", process.env.ADMIN_PASSWORD || "admin123");
    await a.page.goto(BASE + "/costs", { waitUntil: "networkidle" });
    const g0 = await waitForHead(a.page, N.h1);
    const grp1 = g0.find((x) => x.group.startsWith(N.h1));
    ok("U-picker: the Category dropdown is two-level - the head is a group, its two subheads sit under it",
      !!grp1 && grp1.options.some((t) => t.includes(N.s1)) && grp1.options.some((t) => t.includes(N.s2)) && !grp1.options.some((t) => t.includes(N.s3)),
      JSON.stringify(grp1));
    ok("U-default: the free-text new-head box is NOT on the form by default", (await a.page.locator(newBox).count()) === 0);
    ok("U-pending: a head named on the cost form (Pending) is offered and marked '(not approved)'; a signed-off head is not",
      flat(g0).some((t) => t.includes(N.req) && t.includes("(not approved)")) && flat(g0).some((t) => t === N.h1 || t.startsWith(N.h1 + " —")) && !flat(g0).some((t) => t.includes(N.h1) && t.includes("(not approved)")),
      JSON.stringify(flat(g0).filter((t) => t.includes(N.req) || t.includes(N.h1))));
    ok("U-inact (inactive): the retired head is NOT offered for posting", !flat(g0).some((t) => t.includes(N.off)), JSON.stringify(flat(g0).filter((t) => t.includes(N.off))));

    await a.page.locator('input[aria-label="Search cost heads"]').fill(N.s1);
    const g1 = await groups(a.page);
    ok("U-search: typing in the search box narrows the list to the matching subhead under its head, and drops the others",
      flat(g1).some((t) => t.includes(N.s1)) && g1.some((x) => x.group.startsWith(N.h1)) && !flat(g1).some((t) => t.includes(N.s2) || t.includes(N.s3) || t.includes(N.h2)),
      JSON.stringify(flat(g1).slice(0, 8)));
    await a.page.locator('input[aria-label="Search cost heads"]').fill("");
    // the explicit route: choose Others -> the naming box appears; choose a real head -> it goes
    const sel = a.page.locator(pickerSel).first();
    const sentinel = await sel.evaluate((s) => Array.from(s.options).find((o) => o.value === "__new_head__" || /^others?\b/i.test(o.textContent ?? ""))?.value ?? null);
    if (sentinel) {
      await sel.selectOption(sentinel);
      const showed = (await a.page.locator(newBox).count()) === 1;
      await sel.selectOption({ value: H1.id });
      ok("U-others: choosing Others reveals the naming box, and choosing a real head takes it away again",
        showed && (await a.page.locator(newBox).count()) === 0, `shown after Others: ${showed}`);
    } else ok("U-others: the dropdown has an Others route", false, "no Others / new-head option in the list");

    // the ledger filter
    await a.page.goto(BASE + "/costs", { waitUntil: "networkidle" });
    const filter = a.page.locator("select[data-cost-head-filter]").first();
    ok("U-filter: the Costs ledger carries a Cost head filter", (await filter.count()) === 1);
    if (await filter.count()) {
      const fOpts = await filter.evaluate((s) => Array.from(s.querySelectorAll("optgroup")).map((g) => ({ g: g.label, o: Array.from(g.children).map((o) => o.textContent) })));
      const fg = fOpts.find((x) => x.g.startsWith(N.h1));
      ok("U-filter options: two-level - 'All of <head>' then its subheads; the retired head is still listed so old rows can be found",
        !!fg && fg.o[0].startsWith("All of ") && fg.o.some((t) => t.includes(N.s1)) && fg.o.some((t) => t.includes(N.s2))
          && (await filter.evaluate((s, n) => Array.from(s.options).some((o) => (o.textContent ?? "").includes(n)), N.off)),
        JSON.stringify(fg));
      const bodyText = async () => (await a.page.locator("body").innerText()).replace(/\s+/g, " ");
      const waitNotes = async (present, absent) => {
        let t = "";
        for (let i = 0; i < 60; i++) {
          t = await bodyText();
          if (present.every((k) => t.includes(TAG(k))) && absent.every((k) => !t.includes(TAG(k)))) return { ok: true, t };
          await a.page.waitForTimeout(500);
        }
        return { ok: false, t };
      };
      await filter.selectOption({ value: H1.id });
      const r1 = await waitNotes(["h1", "s1", "s2"], ["s3", "h2"]);
      ok("U-filter head: choosing 'All of <head>' shows the head's and its subheads' entries and none of the other head's",
        r1.ok && a.page.url().includes(`category=${H1.id}`), `url ${a.page.url()}`);
      await a.page.locator("select[data-cost-head-filter]").first().selectOption({ value: S1.id });
      const r2 = await waitNotes(["s1"], ["s2", "h1", "s3"]);
      ok("U-filter subhead: choosing one subhead shows that subhead's entries only", r2.ok && a.page.url().includes(`category=${S1.id}`), `url ${a.page.url()}`);
      await a.page.getByRole("button", { name: "Clear" }).first().click().catch(() => {});
      await a.page.waitForURL((u) => !String(u).includes("category="), { timeout: 15000 }).catch(() => {});
      ok("U-filter clear: Clear takes the head filter off the URL and the control back to 'All cost heads'",
        !a.page.url().includes("category=") && (await a.page.locator("select[data-cost-head-filter]").first().inputValue()) === "", `url ${a.page.url()}`);
    }
    // a link carries its filter: opening the URL fresh applies it
    await a.page.goto(BASE + `/costs?category=${S3.id}`, { waitUntil: "networkidle" });
    let linked = false;
    for (let i = 0; i < 60 && !linked; i++) { linked = (await a.page.locator("body").innerText()).includes(TAG("s3")); if (!linked) await a.page.waitForTimeout(500); }
    const linkedText = await a.page.locator("body").innerText();
    ok("U-filter link: a /costs?category=<subhead> link opens already filtered (and the control shows it)",
      linked && !linkedText.includes(TAG("h2")) && (await a.page.locator("select[data-cost-head-filter]").first().inputValue()) === S3.id);
    await a.context.close();

    // the batch Costs tab: the same dropdown, the same default
    const prog = (await req(admin, "POST", "/api/programs", { code: "B2" + stamp.slice(0, 6).toUpperCase(), name: "B2 Prog " + stamp, trainer_skill: "B2Skill" + stamp })).data?.item;
    const day = new Date(); const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const batch = prog ? (await req(admin, "POST", "/api/batches", { location: ownLoc._id, program: prog._id, planned_start: ymd, target_size: 3 })).data?.item : null;
    ok("[precondition] a batch exists to open the Costs tab on", !!batch?._id, JSON.stringify(prog ?? {}).slice(0, 100));
    if (batch?._id) {
      const b = await asPage("admin@vidysea.com", process.env.ADMIN_PASSWORD || "admin123");
      await b.page.goto(BASE + `/batches/${batch._id}?tab=Costs`, { waitUntil: "networkidle" });
      const gb = await waitForHead(b.page, N.h1);
      const gbp = gb.find((x) => x.group.startsWith(N.h1));
      ok("U-batch: the batch Costs tab offers the same two-level dropdown, without the retired head, and no free-text box by default",
        !!gbp && gbp.options.some((t) => t.includes(N.s1)) && !flat(gb).some((t) => t.includes(N.off)) && (await b.page.locator(newBox).count()) === 0,
        JSON.stringify(gbp));
      await b.context.close();
    }

    // Operations: the same form, and no ledger (so no filter)
    const o = await asPage("ops@vidysea.com", PW);
    await o.page.goto(BASE + "/costs", { waitUntil: "networkidle" });
    const go = await waitForHead(o.page, N.h1);
    ok("U-ops: Operations sees the same two-level dropdown, no free-text box by default, and no ledger filter (the ledger is not theirs)",
      go.some((x) => x.group.startsWith(N.h1)) && (await o.page.locator(newBox).count()) === 0 && (await o.page.locator("select[data-cost-head-filter]").count()) === 0);
    await o.context.close();
  }
  // Approved takeover safeguard closure: forced queue, effective-policy CAS and recovery.
  const capId = new ObjectId(H1.id);
  const capPatch = (patch) => req(admin, "PATCH", `/api/master-lists/cost-categories/${H1.id}`, patch);
  const capDoc = () => rawCats.findOne({ _id: capId });
  const capDecide = (r, decision = "Approved", cookie = approverB.cookie) => req(cookie, "POST", `/api/approvals/${r.data?.pending_cap_approval?.request_id}`, { decision });
  const enable = await capPatch({ pre_approved: true, pre_approved_amount: 1000, pre_approved_unit: "Fixed amount", pre_approved_basis: "agreed cap" });
  ok("CAP enable: proposal is Pending and old disabled policy is effective", enable.status === 200 && !!enable.data?.pending_cap_approval && !(await capDoc()).pre_approved);
  const selfCap = await capDecide(enable, "Approved", admin);
  ok("CAP self approval refuses before effective policy write", selfCap.status === 403 && !(await capDoc()).pre_approved);
  const enabled = await capDecide(enable);
  ok("CAP second finance approver enables the proposed policy", enabled.status === 200 && (await capDoc()).pre_approved === true && (await capDoc()).pre_approved_amount === 1000);
  const increase = await capPatch({ pre_approved_amount: 2000 });
  ok("CAP increase: old amount remains effective while waiting", increase.status === 200 && !!increase.data?.pending_cap_approval && (await capDoc()).pre_approved_amount === 1000);
  await rule(true);
  const beforeIncreaseApproval = await post(ops, row(H1, "cap-between", { amount: 1500 }));
  ok("CAP pending increase cannot auto-post between old and proposed caps", beforeIncreaseApproval.status === 202 && await rawCosts.countDocuments({ note: TAG("cap-between") }) === 0);
  const capRejected = await capDecide(increase, "Rejected");
  ok("CAP rejection preserves old amount and releases proposal ownership", capRejected.status === 200 && (await capDoc()).pre_approved_amount === 1000 && !(await capDoc()).pre_approval_proposal);
  const stale = await capPatch({ pre_approved_amount: 2000 });
  const lowered = await capPatch({ pre_approved_amount: 700 });
  const staleDecision = await capDecide(stale);
  ok("CAP decrease is immediate and invalidates earlier increase snapshot", lowered.status === 200 && !lowered.data?.pending_cap_approval && staleDecision.status === 409 && (await capDoc()).pre_approved_amount === 700);
  await capDecide(stale, "Rejected");
  const proposals = await Promise.all([capPatch({ pre_approved_amount: 2100 }), capPatch({ pre_approved_amount: 2200 })]);
  const winning = proposals.find((r) => r.status === 200);
  ok("CAP concurrent proposals have one owner and one Pending request", proposals.filter((r) => r.status === 200).length === 1 && proposals.filter((r) => r.status === 409).length === 1 && await rawApprovals.countDocuments({ action: "costcategory.create", entity_id: capId, "payload.kind": "cap-approval", status: "Pending" }) === 1 && (await capDoc()).pre_approved_amount === 700);
  if (winning) {
    const apply = await capDecide(winning);
    const applied = await capDoc();
    const requestId = new ObjectId(winning.data.pending_cap_approval.request_id);
    await rawApprovals.updateOne({ _id: requestId }, { $set: { status: "Applying" } });
    await rawCats.updateOne({ _id: capId }, { $set: { pre_approval_proposal: requestId } });
    const replay = await capDecide(winning);
    const afterReplay = await capDoc();
    ok("CAP effect-before-finalize retry does not write policy twice", apply.status === 200 && replay.status === 200 && afterReplay.pre_approval_revision === applied.pre_approval_revision && afterReplay.pre_approved_amount === applied.pre_approved_amount && !(afterReplay.pre_approval_proposal));
  }
  const basisChange = await capPatch({ pre_approved_unit: "Per billable passed", pre_approved_min_billable: 5, pre_approved_basis: "changed formula basis" });
  ok("CAP unit/basis change is proposed without replacing effective unit", basisChange.status === 200 && !!basisChange.data?.pending_cap_approval && (await capDoc()).pre_approved_unit === "Fixed amount");
  await capDecide(basisChange, "Rejected");
  // QA-2905: raw CI markers establish each ordering; elapsed sleeps never establish a winner.
  if (!/^center_erp_ci(?:_|$)/.test(db.databaseName)) throw new Error("CAP recovery controls require an isolated center_erp_ci database");
  const capPolicy = (d) => JSON.stringify(Object.fromEntries([
    "pre_approved", "pre_approved_amount", "pre_approved_unit", "pre_approved_basis", "pre_approved_min_billable", "pre_approval_revision",
  ].map((k) => [k, d[k] ?? null])));
  const capClaim = (d) => JSON.stringify([d.status, String(d.decided_by ?? ""), d.decided_at, d.decision_note ?? null, d._audit_events ?? [], d._audit_delivered_event_ids ?? []]);
  const capRequest = (r) => new ObjectId(r.data.pending_cap_approval.request_id);
  const capMark = (rid, values) => rawApprovals.updateOne({ _id: rid }, { $set: Object.fromEntries(Object.entries(values).map(([k, v]) => [`payload._test_cap_${k}`, v])) });
  const capReached = async (rid, stage) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      const d = await rawApprovals.findOne({ _id: rid });
      if (d?.payload?.[`_test_cap_reached_${stage}`] === true) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  };
  const capAudits = (rid) => db.collection("auditlogs").find({ entity: "ApprovalRequest", entity_id: rid, field: "status" }).toArray();
  const approvedCapState = async (rid, before, target) => {
    const d = await capDoc(), a = await rawApprovals.findOne({ _id: rid }), events = await capAudits(rid);
    const expected = { ...before, ...a.payload.proposed, pre_approval_revision: Number(before.pre_approval_revision ?? 0) + 1 };
    return a.status === "Approved" && String(a.decided_by) === approverB.id
      && a.decided_at instanceof Date && capPolicy(d) === capPolicy(expected) && d.pre_approved_amount === target
      && !d.pre_approval_proposal && String(d.pre_approval_applied_request) === String(rid)
      && events.length === 1 && events[0].new_value === "Approved" && String(events[0].actor) === approverB.id
      && (a._audit_events ?? []).length === 1 && (a._audit_delivered_event_ids ?? []).length === 1
      && String(events[0]._id) === a._audit_events[0].event_id;
  };
  const cancelledCapState = async (rid, before) => {
    const d = await capDoc(), a = await rawApprovals.findOne({ _id: rid });
    return capPolicy(d) === capPolicy(before) && !d.pre_approval_proposal
      && String(d.pre_approval_applied_request ?? "") === String(before.pre_approval_applied_request ?? "")
      && a.status === "Pending" && !a.decided_by && !a.decided_at && !(a._audit_events ?? []).length
      && !(a._audit_delivered_event_ids ?? []).length && (await capAudits(rid)).length === 0;
  };
  // Apply wins its CAS, but is held before finalization. A failing resumed worker must stay forward.
  {
    const before = await capDoc(), target = before.pre_approved_amount + 1000;
    const r = await capPatch({ pre_approved_amount: target }), rid = capRequest(r);
    await capMark(rid, { pause_after_apply: true });
    const winner = capDecide(r);
    const reached = await capReached(rid, "after_apply"), claim = await rawApprovals.findOne({ _id: rid });
    ok("CAP recovery apply winner reaches barrier with one revision/receipt and Applying claim",
      reached && claim.status === "Applying" && (await capDoc()).pre_approval_revision === Number(before.pre_approval_revision ?? 0) + 1
        && String((await capDoc()).pre_approval_applied_request) === String(rid) && (await capAudits(rid)).length === 0);
    await capMark(rid, { pause_after_apply: false, fail_before_apply: true });
    const loser = await capDecide(r), still = await rawApprovals.findOne({ _id: rid });
    ok("CAP recovery apply winner: loser cannot reopen or discard the Applying claim/outbox",
      loser.status === 409 && capClaim(still) === capClaim(claim) && (await capAudits(rid)).length === 0);
    await capMark(rid, { fail_before_apply: false, release_after_apply: true });
    const finished = await winner;
    ok("CAP recovery apply winner finalizes once with exact raw policy, revision and audit", finished.status === 200 && await approvedCapState(rid, before, target));
    const cost = await post(ops, row(H1, "cap-recovery-applied", { amount: target - 1 }));
    ok("CAP recovery applied cap is effective for a cost above the previous cap", cost.status === 201
      && await rawCosts.countDocuments({ note: TAG("cap-recovery-applied"), pre_approved_applied: true }) === 1);
  }
  // Recovery reads no receipt, then another worker applies AND finalizes before its fence runs.
  {
    const before = await capDoc(), target = before.pre_approved_amount + 1000;
    const r = await capPatch({ pre_approved_amount: target }), rid = capRequest(r);
    await capMark(rid, { fail_before_apply: true, pause_before_fence: true });
    const loser = capDecide(r);
    const reached = await capReached(rid, "before_fence");
    ok("CAP receipt-before-fence control reaches recovery after a no-receipt read", reached
      && capPolicy(await capDoc()) === capPolicy(before) && (await rawApprovals.findOne({ _id: rid })).status === "Applying");
    await capMark(rid, { fail_before_apply: false, pause_before_fence: false });
    const winner = await capDecide(r), finalized = await rawApprovals.findOne({ _id: rid });
    await capMark(rid, { release_before_fence: true });
    const late = await loser;
    ok("CAP receipt-before-fence: applied receipt beats cancellation and late Approved recovery",
      winner.status === 200 && late.status === 409 && capClaim(await rawApprovals.findOne({ _id: rid })) === capClaim(finalized)
        && await approvedCapState(rid, before, target));
    const refusedReject = await capDecide(r, "Rejected");
    ok("CAP finalized approval cannot be contradicted by a late rejection", refusedReject.status === 409 && await approvedCapState(rid, before, target));
  }
  // A held policy writer loses when cancellation removes its category owner first.
  {
    const before = await capDoc(), target = before.pre_approved_amount + 1000;
    const r = await capPatch({ pre_approved_amount: target }), rid = capRequest(r);
    await capMark(rid, { pause_before_apply: true });
    const held = capDecide(r);
    const reached = await capReached(rid, "before_apply");
    ok("CAP cancellation control reaches held apply before any policy write", reached && capPolicy(await capDoc()) === capPolicy(before));
    await capMark(rid, { pause_before_apply: false, fail_before_apply: true });
    const cancellation = await capDecide(r);
    ok("CAP cancellation winner reopens only after owner removal, with zero policy/audit effect",
      cancellation.status === 409 && await cancelledCapState(rid, before));
    await capMark(rid, { fail_before_apply: false, release_before_apply: true });
    const staleWriter = await held;
    ok("CAP held apply cannot pass the cancelled proposal fence", [409, 500].includes(staleWriter.status) && await cancelledCapState(rid, before));
    const cannotReapply = await capDecide(r);
    const reject = await capDecide(r, "Rejected"), final = await rawApprovals.findOne({ _id: rid }), events = await capAudits(rid);
    ok("CAP fenced Pending proposal refuses reapply but remains rejectable", cannotReapply.status === 409 && reject.status === 200
      && final.status === "Rejected" && capPolicy(await capDoc()) === capPolicy(before) && !(await capDoc()).pre_approval_proposal
      && events.length === 1 && events[0].new_value === "Rejected" && String(events[0].actor) === approverB.id);
    const cost = await post(ops, row(H1, "cap-recovery-cancelled", { amount: target - 1 }));
    ok("CAP cancelled cap stays ineffective for a cost above the preserved cap", cost.status === 202
      && await rawCosts.countDocuments({ note: TAG("cap-recovery-cancelled") }) === 0);
  }
  // Interruption after owner removal must retain Applying; a retry can finish safe cancellation.
  {
    const before = await capDoc(), target = before.pre_approved_amount + 1000;
    const r = await capPatch({ pre_approved_amount: target }), rid = capRequest(r);
    await capMark(rid, { fail_before_apply: true, pause_after_fence: true, fail_after_fence: true });
    const interrupted = capDecide(r);
    const reached = await capReached(rid, "after_fence"), heldClaim = await rawApprovals.findOne({ _id: rid });
    ok("CAP interruption reaches after-fence barrier with owner removed and original policy", reached && heldClaim.status === "Applying"
      && capPolicy(await capDoc()) === capPolicy(before) && !(await capDoc()).pre_approval_proposal && (await capAudits(rid)).length === 0);
    await capMark(rid, { release_after_fence: true });
    const failed = await interrupted;
    ok("CAP interruption after fence preserves exact Applying claim/outbox", failed.status === 409
      && capClaim(await rawApprovals.findOne({ _id: rid })) === capClaim(heldClaim));
    await capMark(rid, { fail_before_apply: false, pause_after_fence: false, fail_after_fence: false });
    const retried = await capDecide(r);
    ok("CAP Applying ownership mismatch reaches recovery and safely returns fenced Pending", retried.status === 409 && await cancelledCapState(rid, before));
    const rejected = await capDecide(r, "Rejected");
    ok("CAP interrupted cancellation remains rejectable with preserved cap", rejected.status === 200
      && (await rawApprovals.findOne({ _id: rid })).status === "Rejected" && capPolicy(await capDoc()) === capPolicy(before));
  }
  // Every guarded branch must leave neither a posted ledger row nor a Formula reservation.
  for (const enabledRule of [false, true]) {
    await rule(enabledRule);
    for (const status of ["Pending", "Rejected"]) {
      await rawCats.updateOne({ _id: capId }, { $set: { approval_status: status, pre_approved: true, pre_approved_amount: 100000, pre_approved_unit: "Per billable passed" } });
      const note = TAG(`guard-${status}-${enabledRule}`);
      const held = await post(admin, row(H1, "guard", { note, amount: 10 }));
      const replay = held.data?.item?._id ? await req(approverB.cookie, "POST", `/api/approvals/${held.data.item._id}`, { decision: "Approved" }) : { status: 0 };
      ok(`HEAD ${status} rule ${enabledRule}: forced queue and replay refusal write no ledger/reservation`, held.status === 202 && replay.status === 409 && await rawCosts.countDocuments({ note }) === 0);
    }
  }
  await rawCats.updateOne({ _id: capId }, { $set: { approval_status: "Approved", pre_approved_unit: "Fixed amount" } });
  await rawCats.updateOne({ _id: new ObjectId(S1.id) }, { $set: { approval_status: "Approved" } });
  await rawCats.updateOne({ _id: capId }, { $set: { approval_status: "Pending" } });
  await rule(false);
  const underPendingParent = await post(admin, row(S1, "pending-parent"));
  ok("HEAD approved subhead cannot bypass its Pending parent", underPendingParent.status === 202 && await rawCosts.countDocuments({ note: TAG("pending-parent") }) === 0);
  const terminalId = new ObjectId();
  await db.collection("batches").insertOne({ _id: terminalId, code: `ZZCAP-${stamp}`, location: new ObjectId(ownLoc._id), program: new ObjectId(), status: "Completed", target_size: 1, planned_start: new Date("2031-05-04"), createdAt: new Date(), updatedAt: new Date() });
  const terminal = await post(admin, row(H1, "terminal-pending", { batch: String(terminalId) }));
  ok("HEAD terminal-batch Admin shortcut cannot bypass Pending head", terminal.status === 202 && await rawCosts.countDocuments({ note: TAG("terminal-pending") }) === 0);
  await db.collection("batches").deleteOne({ _id: terminalId });
  await rawCats.updateOne({ _id: capId }, { $set: { approval_status: "Approved" } });
} finally {
  if (browser) await browser.close().catch(() => {});
  await rule(ruleBefore.enabled === true).catch(() => {});
  await client.close().catch(() => {});
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
