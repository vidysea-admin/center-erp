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

const PW = "CiOnly@123";
const admin = await login("admin@vidysea.com", process.env.ADMIN_PASSWORD || "admin123");
const ops = await login("ops@vidysea.com", PW);
ok("[precondition] an Admin and an Operations session exist", !!admin && !!ops, `admin=${!!admin} ops=${!!ops}`);

const stamp = Date.now().toString(36);
const anyLoc = ((await req(admin, "GET", "/api/locations?limit=5")).data?.items ?? [])[0]?._id;
ok("[precondition] a location exists to hang entries on", !!anyLoc, "none");

// Rule 37 needs one of location/batch/trainer; a location is the simplest.
const baseEntry = (extra = {}) => ({ entry_date: "2026-09-07", location: anyLoc, amount: 500, note: "pin: what this was for", ...extra });

// ---------------------------------------------------------------- item 5: the fields
{
  const cat = ((await req(admin, "GET", "/api/master-lists/cost-categories")).data?.items ?? [])[0];
  ok("[precondition] a cost head exists", !!cat, "none");

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

// ------------------------------------------------ item 7: a missing head is a queue
{
  const proposed = `ZZ Proposed ${stamp}`;
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
        const seen = ((await req(blind, "GET", "/api/approvals")).data?.items ?? [])
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
          const sels = ap.locator("select");
          for (let n = 0; n < (await sels.count()); n++) {
            const opts = (await sels.nth(n).locator("option").allTextContents()).join("|");
            if (/Rejected/i.test(opts)) { await sels.nth(n).selectOption({ label: /Rejected/i.test(opts) ? "Rejected" : undefined }).catch(() => {}); break; }
          }
          await ap.waitForFunction((s) => document.body.innerText.includes(s), REASON, { timeout: 30000 }).catch(() => {});
          const abody = await ap.locator("body").innerText();
          ok("QA-2295: the approver's own screen shows the reason that was typed",
            abody.includes(REASON),
            `/admin?tab=Approvals does not contain "${REASON}" - the render is unpinned and could be deleted unnoticed. body starts: ${abody.slice(0, 240)}`);
          ok("QA-2296: the DECISION time is on that screen, not only the request time",
            (() => { const k = abody.indexOf("decided by"); return k >= 0 && /\d/.test(abody.slice(k, k + 80)) && abody.slice(k, k + 80).includes("·"); })(),
            `no 'decided by X · <time>' on the approvals screen - QA-2296 renders decided_at and nothing asserted it. body starts: ${abody.slice(0, 240)}`);
        } finally {
          try { await actx.close(); } catch {}
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
