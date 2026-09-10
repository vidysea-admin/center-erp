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
import { MongoClient, ObjectId } from "mongodb";
import * as XLSX from "xlsx";
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
      if (cost) {
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
