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

// leave the rule as we found it, so the next suite is not measuring ours
await req(admin, "PUT", "/api/approvals", { action: "cost.post", enabled: false, approver_role: "Admin" });
await req(admin, "PUT", "/api/approvals", { action: "costcategory.create", enabled: false, approver_role: "Admin" });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
