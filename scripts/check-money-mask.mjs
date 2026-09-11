// check-money-mask — the FUNCTION-LEVEL pin on the money maskers (QA-2443).
//
// WHY THIS FILE EXISTS, AND WHY IT IS NOT ANOTHER LINE IN AN EXISTING SUITE.
//
// QA-2427 shipped three edits to `src/lib/permissions.ts`. A checker then mutated each one
// separately and measured what the wall said:
//
//   M1  the DECISION list removed from maskMoneyInAuditRow's MONEY set  -> e2e-cost-entry 197/0 GREEN
//   M2  the structural `looksLikeMoneyField` number branch made dead    -> 197/0 GREEN, check-user-copy 364/0 GREEN
//   M1b the stripMoneyKeys DECISION loop removed                        -> 195/2, the pin reddens
//
// Two of the three could be deleted with the entire wall green. The reason is not carelessness: the
// shapes those edits catch are not reachable from any HTTP door today — no route writes an audit row
// whose FIELD is `approved_amount` as a scalar, and every `*_amount` field on the four money
// entities already sits in a list. An end-to-end suite cannot exercise a branch no route reaches,
// and a static source scan can only prove the LINE is present, not that it WORKS.
//
// So the instrument has to be the third kind: the real module, loaded and CALLED, with a synthetic
// row per shape. `run-e2e.mjs` already carries two no-server checkers of this family
// (`check-user-copy.mjs`, `check-home-structure.mjs`); this is the third, and it needs no server,
// no database and no port. Bolting a runtime probe into a static-source scanner would have been the
// drift, not this.
//
// THE RULE THIS FILE IS HERE TO ENFORCE, from CLAUDE.md 2026-09-07: a guard repaired and a guard
// DELETED have identical pass counts. Every assertion below must redden when its OWN edit is
// removed — measured one mutant at a time, never as a batch.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require_ = createRequire(import.meta.url);

let passed = 0, failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (extra === undefined ? "" : "  -> " + JSON.stringify(extra))); }
};

// jiti loads the REAL TypeScript module. `@` is the project's own path alias; without it
// permissions.ts cannot resolve its imports and the probe would silently measure nothing.
const jitiMod = require_(path.join(root, "node_modules/jiti"));
const createJiti = jitiMod.createJiti ?? jitiMod;
const jiti = createJiti(path.join(root, "scripts/check-money-mask.mjs"), {
  alias: { "@": path.join(root, "src") }, interopDefault: true,
});
const M = jiti(path.join(root, "src/lib/permissions.ts"));

const { maskApprovalMoney, maskMoneyInAuditRow, redactFiguresInText, looksLikeMoneyField } = M;

// INSTRUMENT GUARD. Every arm below asserts on ABSENCE, so a module that failed to load would give
// this file its most dangerous possible reading. Say so here, loudly, before anything else runs.
ok("[instrument] the real permissions module loaded and exports the four maskers under test",
  typeof maskApprovalMoney === "function" && typeof maskMoneyInAuditRow === "function"
    && typeof redactFiguresInText === "function" && typeof looksLikeMoneyField === "function",
  { maskApprovalMoney: typeof maskApprovalMoney, maskMoneyInAuditRow: typeof maskMoneyInAuditRow });
if (typeof maskApprovalMoney !== "function") {
  console.log(`\ncheck-money-mask: ${passed} passed, ${failed} failed`);
  process.exit(1);
}

const FIG = "445599";
const has = (o, s) => JSON.stringify(o).includes(s);

// ---------------------------------------------------------------------------
// 1. The MONEY set in maskMoneyInAuditRow — the M1 mutant's target.
//    Reachable from no route today, which is exactly why no e2e suite can hold it.
// ---------------------------------------------------------------------------
//
//    AND THE FIRST VERSION OF THIS BLOCK DID NOT DISCRIMINATE IT — measured, not assumed. It used
//    `{entity:"ApprovalRequest", field:"approved_amount", new_value: <number>}`, which the
//    STRUCTURAL branch in section 2 also catches, so deleting the MONEY-set edit left this file at
//    21/0. That is the exact defect this file was written to prevent, arriving in the file itself.
//    The two edits overlap on every numeric `*_amount` field of a money entity, so a shape that
//    tells them apart has to sit OUTSIDE the structural rule's conditions. MEASURED, one mutant at
//    a time: the discriminator is a money field name on a NON-MONEY entity — the MONEY set is
//    entity-independent by design, the structural rule is scoped to MONEY_ENTITIES, so only the
//    list can reach it. The string-valued arm below is a genuine guarantee but NOT a discriminator:
//    under the M1 mutant it still passes, because `redactFiguresInText` takes every figure out of
//    any string on a money entity anyway. It is kept and labelled rather than deleted, so nobody
//    later reads it as the thing holding that edit up.
{
  const strRow = { entity: "ApprovalRequest", field: "approved_amount", new_value: String(FIG), old_value: "1000" };
  const otherEntity = { entity: "Candidate", field: "approved_amount", new_value: Number(FIG) };
  ok("QA-2443: a money field recorded as a STRING is masked on a money entity [guarantee, not an M1 discriminator]",
    !has(maskMoneyInAuditRow(strRow, false), FIG), maskMoneyInAuditRow(strRow, false));
  ok("QA-2443/M1: ...and the same field name on a NON-money entity is masked too, because the list is entity-independent",
    !has(maskMoneyInAuditRow(otherEntity, false), FIG), maskMoneyInAuditRow(otherEntity, false));
  ok("QA-2443/M1: ...and the grant-holder still gets it, so this is a MASK and not a deletion",
    has(maskMoneyInAuditRow(strRow, true), FIG));
  ok("QA-2443/M1: ...and the row still names WHICH field changed, so the trail still answers what was done",
    String(maskMoneyInAuditRow(strRow, false).field) === "approved_amount", maskMoneyInAuditRow(strRow, false));
}

// ---------------------------------------------------------------------------
// 2. The STRUCTURAL looksLikeMoneyField branch — the M2 mutant's target.
//    The half added "because a list alone fails again the same way": a field named *_amount that is
//    in NEITHER list. Every such field that exists today is already listed, so this branch is for
//    the field somebody adds TOMORROW — precisely a shape no end-to-end suite can reach.
// ---------------------------------------------------------------------------
{
  const row = { entity: "CostEntry", field: "settlement_amount", new_value: Number(FIG) };
  ok("QA-2443/M2: a *_amount field in NEITHER money list is refused STRUCTURALLY on a money entity",
    !has(maskMoneyInAuditRow(row, false), FIG), maskMoneyInAuditRow(row, false));
  ok("QA-2443/M2: ...and the same field on a NON-money entity is left alone, so the rule is scoped",
    has(maskMoneyInAuditRow({ entity: "Candidate", field: "settlement_amount", new_value: Number(FIG) }, false), FIG));
  ok("QA-2443/M2: ...and the predicate accepts amount/amt and refuses a lookalike",
    looksLikeMoneyField("settlement_amount") && looksLikeMoneyField("adv_amt") && looksLikeMoneyField("amount")
      && !looksLikeMoneyField("amountable") && !looksLikeMoneyField("note"));
}

// ---------------------------------------------------------------------------
// 3. stripMoneyKeys — the M1b mutant's target — and the payload-string loop that was QA-2442.
//
//    SAME CORRECTION AS SECTION 1, same cause. The first version asserted that the TOP-LEVEL
//    `approved_amount`/`requested_amount` keys are gone, which is done by maskApprovalMoney's own
//    delete loop and NOT by stripMoneyKeys — so the M1b mutant left this file at 21/0 too. The
//    DECISION loop inside stripMoneyKeys governs the PAYLOAD copy of those keys; that is the shape
//    that discriminates it, and the top-level assertion stays because it pins a different line.
// ---------------------------------------------------------------------------
{
  const r = maskApprovalMoney({ summary: "Cost entry", payload: { amount: 128500, note: "cash advance " + FIG + " paid" } }, false);
  ok("QA-2443/M1b: a figure TYPED into payload.note is not handed to a blind reader", !has(r, FIG), r);
  const rp = maskApprovalMoney({ summary: "x", payload: { amount: 1, approved_amount: Number(FIG), requested_amount: Number(FIG) } }, false);
  ok("QA-2443/M1b: a decision amount sitting INSIDE the payload is stripped there too",
    !has(rp, FIG) && !("approved_amount" in (rp.payload ?? {})) && !("requested_amount" in (rp.payload ?? {})), rp);
  const r2 = maskApprovalMoney({ summary: "x", payload: { amount: 1 }, approved_amount: 8000, requested_amount: 12345 }, false);
  ok("QA-2443: ...and at the row's top level both decision amounts lose their KEYS, not merely their values",
    !("approved_amount" in r2) && !("requested_amount" in r2), r2);
}

// ---------------------------------------------------------------------------
// 4. THE OTHER DIRECTION. Every arm above also passes if the masker simply destroys everything.
//    These are the arms that tell a repair from an over-application.
// ---------------------------------------------------------------------------
{
  const r = maskApprovalMoney({
    summary: "Approved by Karunn Sharma on 07-09-2026, voucher V-778899",
    payload: { amount: 1, invoice_no: "V-778899" },
  }, false);
  ok("over-redaction: a dd-mm-yyyy date a person typed survives", String(r.summary).includes("07-09-2026"), r.summary);
  ok("over-redaction: a person's name survives", String(r.summary).includes("Karunn Sharma"), r.summary);
  ok("over-redaction: the voucher IS hidden, because invoice_no is money-class by this module's own rule",
    !String(r.summary).includes("778899"), r.summary);
  ok("over-redaction: an ISO timestamp survives whole",
    redactFiguresInText("at 2026-09-07T10:11:12Z").includes("2026-09-07T10:11:12Z"));
  ok("over-redaction: dd/mm/yyyy and dd.mm.yyyy survive",
    redactFiguresInText("paid 07/09/2026").includes("07/09/2026")
      && redactFiguresInText("paid 07.09.2026").includes("07.09.2026"));
  ok("date protection is by VALUE not by shape: 12-34-2026 is not a date and is redacted",
    !redactFiguresInText("on 12-34-2026").includes("2026"), redactFiguresInText("on 12-34-2026"));
  ok("date protection cannot be used to smuggle: 424242-01-02 is not a protected date",
    !redactFiguresInText("ref 424242-01-02").includes("424242"), redactFiguresInText("ref 424242-01-02"));
  ok("the grant-holder loses nothing",
    has(maskApprovalMoney({ summary: "cash advance " + FIG, payload: { amount: 1 }, approved_amount: 8000 }, true), FIG));

  // QA-2456 (peer checker, -303): the five arms above are dates, a name, a voucher, an ISO stamp
  // and dd/mm - and NOT ONE of them is a plain count or a batch code. So the collateral this rule
  // genuinely does take was the one thing this suite could not see move, and it was measured by
  // hand instead. Measured by hand is how a release note ends up contradicting its own code
  // comment, which is exactly what happened: the note said "the description is unchanged" while
  // the comment two files away listed what changes.
  //
  // ASSERTED AS IT IS, NOT AS ONE MIGHT WISH IT. This is deliberate collateral, not a defect -
  // on a record whose subject is money, guessing which figure is the secret is how the last four
  // leaks began. Pinning it here means a future widening or narrowing of the rule has to come past
  // an assertion rather than past somebody's memory.
  const coll = (t) => String(maskApprovalMoney({ summary: t, payload: { amount: 1 } }, false).summary);
  ok("QA-2456: a three-digit COUNT inside the description is taken too - deliberate, and now pinned",
    !coll("capacity 120 seats confirmed").includes("120"), coll("capacity 120 seats confirmed"));
  ok("QA-2456: ...and a batch code carrying a 3-digit run loses that run",
    !coll("Complete batch RPLAVP-2026-01").includes("2026"), coll("Complete batch RPLAVP-2026-01"));
  ok("QA-2456: ...while a two-digit count and a short code survive, so the rule is not total erasure",
    coll("Complete batch AVP-GURU-RPLAVP-DST-07 with 30 seats").includes("DST-07")
      && coll("Complete batch AVP-GURU-RPLAVP-DST-07 with 30 seats").includes("30"),
    coll("Complete batch AVP-GURU-RPLAVP-DST-07 with 30 seats"));
}

// ---------------------------------------------------------------------------
// 5. QA-2448 — KNOWN RED, SCHEDULED FOR -304, ASSERTED AS IT IS MEASURED TODAY.
//
//    maskApprovalMoney walks the payload exactly ONE level: nothing descends into a nested object
//    or an array, and a top-level *_amount NUMBER outside DECISION_MONEY_FIELDS is not touched.
//    Three of the four real `requireApproval` payload shapes are nested.
//
//    These arms assert TODAY'S BEHAVIOUR rather than the wanted one, so the wall stays readable and
//    this file cannot be quietly green about a gap that is open. When -304 lands the recursive walk
//    every one of them FLIPS and must be rewritten to the `!has` form — which is exactly the
//    before/after number that change needs, and the reason they are written now rather than then.
// ---------------------------------------------------------------------------
{
  const nested = maskApprovalMoney({ summary: "x", payload: { amount: 1, meta: { note: "cash advance " + FIG } } }, false);
  const arr = maskApprovalMoney({ summary: "x", payload: { amount: 1, notes: ["cash advance " + FIG] } }, false);
  const topObj = maskApprovalMoney({ summary: "x", payload: { amount: 1 }, decision: { note: "sanctioned " + FIG } }, false);
  const topNum = maskApprovalMoney({ summary: "x", payload: { amount: 1 }, sanctioned_amount: Number(FIG) }, false);
  ok("QA-2448 [KNOWN RED, -304]: the payload walk is still ONE level — a nested object still carries the figure",
    has(nested, FIG), "IF THIS FAILS THE WALK WAS FIXED — flip this arm and its three neighbours to !has");
  ok("QA-2448 [KNOWN RED, -304]: an array inside the payload still carries it", has(arr, FIG));
  ok("QA-2448 [KNOWN RED, -304]: a top-level non-payload object still carries it", has(topObj, FIG));
  ok("QA-2448 [KNOWN RED, -304]: a top-level *_amount NUMBER outside the decision list still carries it", has(topNum, FIG));
}

console.log(`\ncheck-money-mask: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
