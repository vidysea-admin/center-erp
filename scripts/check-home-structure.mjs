// -111 cycle 2 (checker, QA-176 reopened): the "Log today's attendance" strip on Home exists for the
// TRAINER — and the first -111 cut nested it inside the Admin-only `!leanHome && trainers_by_role`
// block, so the trainer lost it while the wall stayed green (the -102 pin asserts the API JSON, not
// the rendered page, and Home is a client component the wall cannot render). This is the structural
// pin the wall CAN run: in src/app/(app)/page.tsx the strip must sit at the top level of the return,
// AFTER the KPI grid closes and BEFORE the trainers-by-role block opens, and its own gate must not
// mention leanHome. Output matches the other suites so run-e2e.mjs counts it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "app", "(app)", "page.tsx");
const CR = String.fromCharCode(13);
const src = fs.readFileSync(file, "utf8").split(CR).join(""); // CRLF-safe: drop carriage returns
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { if (cond) { pass++; console.log(`PASS  ${name}`); } else { fail++; console.log(`FAIL  ${name} ${extra}`); } };

const grid = src.indexOf('<div className="grid grid-cols-2 gap-3 md:grid-cols-5">');
const stripGate = src.indexOf('{q.today_logging.length > 0 && role !== "Location" && (');
const stripText = src.indexOf("Log today&apos;s attendance:");
const byRole = src.indexOf("{!leanHome && (data.kpis.trainers_by_role ?? []).length > 0 && (");
ok("home: KPI grid, strip gate, strip text and trainers-by-role block all present", grid > 0 && stripGate > 0 && stripText > 0 && byRole > 0, JSON.stringify({ grid, stripGate, stripText, byRole }));

// The KPI grid's closing tag is the first 6-space-indented "</div>" line after the grid opens.
const gridClose = src.indexOf("\n      </div>\n", grid);
ok("home: the strip comes AFTER the KPI grid closes (cards first — Umesh 18/08)", gridClose > 0 && stripGate > gridClose, `gridClose=${gridClose} stripGate=${stripGate}`);
ok("home: the strip comes BEFORE the Admin-only trainers-by-role block opens (not nested inside it — QA-176)", stripGate < byRole, `stripGate=${stripGate} byRole=${byRole}`);
// The strip's own gate line sits at the top level of the fragment: 6-space indent, and no leanHome
// anywhere between the grid close and the strip gate.
const gateLineStart = src.lastIndexOf("\n", stripGate) + 1;
ok("home: the strip's gate is at top level (6-space indent) — its only gates are today_logging + not-Location",
  src.slice(gateLineStart, stripGate) === "      " && !/leanHome/.test(src.slice(gridClose, stripGate)),
  JSON.stringify(src.slice(gateLineStart, stripGate)));
// The strip's JSX closes (the 6-space "      )}" line) before the trainers-by-role block opens.
const stripClose = src.indexOf("\n      )}\n", stripText);
ok("home: the strip's JSX closes before the trainers-by-role block", stripClose > 0 && stripClose < byRole, `stripClose=${stripClose} byRole=${byRole}`);


// -162 (QA-397, Manish sir 20/08): "Total attendance 30% and the below thing is confusing and not
// clear". The headline was ONE percentage over TWO incompatible meters - a portal roster of 1,447
// and an own-log roster of 270 summed into 1,717. The government meter decides eligibility (QA-085);
// our logs are an estimate; adding them answers a question nobody asked.
//
// Pinned as the defect: the tile must not headline the FUSED figure, and when both meters exist it
// must say they are not added. Limit, stated: this proves the fusion is gone, not that the wording
// reads well - and it cannot render the page, only read its source.
{
  const fused = src.includes("attendance.pct}%") || src.includes("attendance?.pct}%");
  ok("-162 (QA-397): the attendance tile does not headline one percentage fused from two different meters",
    !fused, fused ? "value still reads attendance.pct" : "");
  const saysApart = src.includes("counted separately, never added");
  ok("-162 (QA-397): ...and when both meters are present the line says they are not added together",
    saysApart, saysApart ? "" : "no sentence separates the two meters");
  const labelled = src.includes('"Attendance \u2014 government portal"') && src.includes('"Attendance \u2014 our own logs"');
  ok("-162 (QA-397): ...and the tile names WHICH attendance the number is",
    labelled, labelled ? "" : "the label does not name the meter");
}

// ---- -224 (QA-880): the batch CLOSURE screen, for the same reason Home is pinned here ----
// This file's premise is "the structural pin the wall CAN run" on a client component the wall cannot
// render. qa-224 needed exactly that and did not have it: THREE fix cycles on
// batches/[id]/page.tsx were each caught by a human driving a browser, and the wall was green every
// time. The seven -224 e2e pins test the SERVER contract and that unit changed no server file, so
// they pass against pre-fix code - QA-880. Below are the client facts those three cycles turned on.
// Each FAILS against the code as it was before its own fix, and none can be satisfied by a green
// server. Limit, stated plainly: these pin STRUCTURE, not behaviour - they prove the guard is asked
// and the surface is written, not that the pixels land where a person is looking.
{
  // BATCH_PAGE_OVERRIDE exists so these pins can be proved FALSIFIABLE: run them against an older
  // commit's copy of this file and they must FAIL. A pin only verified against the fixed code is the
  // QA-212 defect - a pin that cannot fail. Unset in CI and in the wall; it changes nothing there.
  const bf = process.env.BATCH_PAGE_OVERRIDE
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "app", "(app)", "batches", "[id]", "page.tsx");
  const b = fs.readFileSync(bf, "utf8").split(CR).join("");

  // QA-878: the reopen control must ask the SAME question its server guard asks. rules.ts refuses on
  // TWO facts - sign-off Completed AND zero per-candidate rows - and this predicate asked only the
  // first, so it rendered on DERIVED sign-offs where its own confirm was false and pressing it was a
  // no-op. `legacy` is the client's name for "zero rows".
  const reopenGate = b.indexOf('closure?.assessment_status === "Completed" && !statusClosedTab && mayMarkTab');
  const gateLine = reopenGate > 0 ? b.slice(b.lastIndexOf("\n", reopenGate) + 1, reopenGate) : "";
  ok("-229 (QA-878): the standing Reopen control also asks the zero-rows half of its server guard",
    reopenGate > 0 && /legacy\s*&&\s*$/.test(gateLine.replace(/^\s*\{/, "")),
    reopenGate > 0 ? `gate reads: ${JSON.stringify(gateLine.trim())}` : "reopen gate not found");

  // ...and the confirm must READ provenance, not assert it. Asserting "recorded by hand" on a
  // derived sign-off is a falsehood told to obtain consent.
  ok("-229 (QA-878): the reopen confirm reads assessment_derived instead of asserting how the figures were made",
    b.includes("assessment_derived"), "assessment_derived appears 0 times in this file");

  // QA-877: a SUCCESSFUL bulk mark must clear the per-card refusals it has just disproved, or a
  // stale "cannot mark" stands beside a green Pass. mark() already did this; bulkApply did not.
  const bulk = b.indexOf("async function bulkApply");
  const bulkEnd = b.indexOf("async function certPatch", bulk);
  const bulkBody = bulk > 0 && bulkEnd > bulk ? b.slice(bulk, bulkEnd) : "";
  ok("-229 (QA-877): a successful bulk mark clears the per-card errors of the members it updated",
    /setCardErrors/.test(bulkBody) && /delete\s+n\[/.test(bulkBody),
    bulkBody ? "bulkApply never removes a cardErrors entry" : "could not locate bulkApply");

  // QA-862: "Generate & issue" must not close its own drawer on failure - that is what made the
  // Drawer's existing `error` slot useless and left N refusals showing as one, after the panel the
  // operator was reading had vanished.
  const gen = b.indexOf("Generate &amp; issue");
  const genStart = gen > 0 ? b.lastIndexOf("<Btn onClick={async () => {", gen) : -1;
  const genBody = genStart > 0 ? b.slice(genStart, gen) : "";
  ok("-229 (QA-862): Generate & issue does not close its drawer unconditionally after the loop",
    genBody.length > 0 && !/\n\s*setCertDrawer\(false\);\s*await load\(\)/.test(genBody),
    genBody ? "setCertDrawer(false) still runs straight after the loop" : "could not locate the handler");
  ok("-229 (QA-862): ...and it collects every refusal instead of each overwriting the last",
    /failures\.push\(/.test(genBody), "no failures[] accumulation in the issue loop");

  // QA-886: and it must not silently skip candidates whose number is blank while issuing the rest.
  ok("-229 (QA-886): Generate & issue counts the candidates it left out for want of a number",
    /skipped\.push\(/.test(genBody), "blank-number candidates are still skipped in silence");

  // QA-856: the marking grid's failures must reach a surface AT the press, not only the page-top
  // banner thousands of pixels above a viewport scrolled through 46 cards.
  const mark = b.indexOf("async function mark(");
  const markEnd = b.indexOf("async function bulkApply", mark);
  const markBody = mark > 0 && markEnd > mark ? b.slice(mark, markEnd) : "";
  // -232 (QA-833) -> -235 (QA-961, QA-962: checker on qa-232 cycle 1). The quietest member of the
  // dead-control family on this tab: not a button that refuses, an INPUT that accepts your typing
  // beside a Save that cannot fire, so the value is taken and then discarded with nothing said.
  //
  // THIS PIN WAS AN INSTANCE PIN AND THAT IS WHY IT MISSED. Cycle 1 named the six date fields, I
  // gated those six, and the checker found a SEVENTH ungated input in the same two cards
  // (`certificates_issued`) that the pin could not see - `grep -c certificates_issued` on it was 0.
  // Re-scanning the region then found TWO MORE nobody had named (`appeared`, `passed`). Nine inputs,
  // three still open after a fix that "closed" the row. So it asks the CLASS question now: every
  // input inside the Assessment and Certification cards must carry the same gate their Save carries.
  // A new field added tomorrow is covered without anyone remembering to add a pin.
  //
  // QA-962: matched anywhere in the tag, so `disabled={closed}` written AFTER `value=` is fine -
  // the old pin false-redded on semantically identical code, the same shape as qa-221's formatter.
  {
    // QA-983 (checker on qa-232 c2): the region must be the two cards this pin NAMES. It ran
    // Assessment -> INVOICE, so any new card added between them was dragged into the gate, and
    // renaming an UNRELATED card (Invoice) turned this pin red. It ends at the Certification
    // card's own </Section> now \u2014 a boundary neither a third card nor a rename can move.
    const a = b.indexOf("title={`Assessment \u2014 ");
    const cert = b.indexOf("title={`Certification \u2014");
    const endTag = cert > 0 ? b.indexOf("</Section>", cert) : -1;
    const region = a > 0 && cert > a && endTag > cert ? b.slice(a, endTag) : "";
    // QA-982 (same checker, and the sharper of the two): `<input \u2026/>` matched LAZILY to the next
    // `/>`, so a NON-self-closing `<input \u2026></input>` was invisible AND the match ran on until it
    // swallowed the Save button's own `disabled={closed}` \u2014 the pin then reported "0 ungated" with
    // the real defect standing. It was mutation-proved: re-open `certificates_issued` in that shape
    // and the pin still passed. A tag body cannot contain `<`, so stopping there closes both holes.
    const inputs = [...region.matchAll(/<input[^<]*/g)].map((m) => m[0]);
    const nameOf = (t) => (/value=\{(?:toInputDate\()?form\.(\w+)/.exec(t) || [, "?"])[1];
    // QA-1299 / QA-1265 (-250): this pin demanded the literal token `closed` and, on 2026-08-25, it
    // went red on a DELIBERATE product decision. Umesh's QA-1265: the two dates that can only be
    // KNOWN after a batch completes - certificate distribution and SIDH portal upload - must stay
    // writable after completion, and the server half is POST_COMPLETION_WRITABLE, so their Save is
    // not dead. The pin's own sentence is "the same gate its Save carries"; `closed` was only ever
    // the spelling that happened to be true when it was written, and the pin had confused the two.
    //
    // A weaker pin was NOT the answer - it would have let anything through. This holds BOTH
    // decisions instead: everything carries `closed`, except exactly the two fields QA-1265 names,
    // which must carry `!mayMarkTab`. So a new ungated field still reddens it, AND these two
    // drifting back to `closed` reddens it too, which is the regression that would silently undo
    // QA-1265. This pin has now been wrong four times (QA-961, QA-962, QA-982, QA-983); the fifth
    // was not a hole, it was an invariant that had outlived one of its own terms.
    const POST_COMPLETION_WRITABLE = ["certificate_distribution_date", "sidh_uploaded_on"];
    // QA-2426 / QA-2428 (two checkers, from opposite sides of a branch divergence, same day): this
    // pin demanded the LITERAL tokens `closed` and `!mayMarkTab`, so when QA-2420 gave the closure
    // inputs a saving gate (`closed || closureBusy`) no page could satisfy both this pin and
    // QA-2420's own - the wall was deterministically red for as long as the release shipped, and
    // neither unit could go green without the other going red. That is the FIFTH time this pin has
    // been wrong (QA-961, QA-962, QA-982, QA-983, QA-1265) and every time for the same reason: it
    // spelled out the gate that happened to be true the day it was written, while its own sentence
    // says "the gate its own Save carries".
    //
    // So the expected gate is now DERIVED from the Save controls in this very region. The region has
    // two of them - the ordinary Save and the post-completion Save - and they are told apart by
    // which one mentions `mayMarkTab`, not by their order. A field and its Save can no longer drift
    // apart in either direction, and nobody has to come back and edit this line again.
    const gateOf = (re) => {
      const m = [...region.matchAll(/<Btn[^>]*?disabled=\{([^}]*)\}/g)].map((x) => x[1].trim());
      return m.find(re) ?? null;
    };
    const postGate = gateOf((g) => /mayMarkTab/.test(g));
    const ordinaryGate = gateOf((g) => /\bclosed\b/.test(g) && !/mayMarkTab/.test(g));
    const norm = (g) => String(g).replace(/\s+/g, "");
    const carries = (tag, gate) => gate !== null && norm(tag).includes("disabled={" + norm(gate) + "}");
    // If either Save cannot be found, the pin has lost its own reference point and must FAIL rather
    // than pass vacuously - a derived expectation with nothing to derive from is not an expectation.
    const gatesFound = ordinaryGate !== null && postGate !== null;
    const wrongGate = !gatesFound ? inputs : inputs.filter((t) =>
      !carries(t, POST_COMPLETION_WRITABLE.includes(nameOf(t)) ? postGate : ordinaryGate));
    // The exception must not become a way to have no fields at all: both named fields have to BE here.
    const namedPresent = POST_COMPLETION_WRITABLE.filter((f) => inputs.some((t) => nameOf(t) === f));
    ok("-250 (QA-833/QA-961/QA-1265/QA-2426): EVERY input in the closure cards carries the gate its own Save carries",
      region.length > 0 && gatesFound && inputs.length >= 6 && wrongGate.length === 0 && namedPresent.length === POST_COMPLETION_WRITABLE.length,
      region.length === 0 ? "could not locate the closure cards"
        : !gatesFound ? `could not read both Save gates from the region (ordinary=${ordinaryGate}, post-completion=${postGate}) - the pin has no reference point to derive from`
        : `${inputs.length} inputs, ${wrongGate.length} with the wrong gate: ${wrongGate.map(nameOf).join(", ") || "(none)"}`
          + ` | expected ordinary \`${ordinaryGate}\`, post-completion \`${postGate}\``
          + ` | post-completion fields found: ${namedPresent.join(", ") || "(none)"}`);
  }

  // QA-2435 (Umesh, on the live screen): the two batch-transition buttons sit side by side and must
  // read the same way - ACTION then STATE. `Assessment done → Result Awaited` always did;
  // the new one shipped as a bare `Assessment Awaited`, which names where the batch lands and not
  // what the person is telling the system. The file's own -102 note says these carry "the client's
  // words for these two steps", so the bare label contradicted the rule written directly above it.
  //
  // Pinned rather than just fixed, because a label is the easiest thing in this file to lose in a
  // later edit and the cheapest to get wrong: -296 existed only to correct one sentence in -295.
  // The STORED status stays `Assessment Awaited` - this asserts the button text, never the enum.
  {
    const row = b.slice(b.indexOf("transition("), b.indexOf("setExamHeldOpen(true)") + 400);
    const labels = [...row.matchAll(/>([^<>{}]{6,60})<\/Btn>/g)].map((m) => m[1].trim())
      .filter((t) => /Awaited/.test(t));
    const bare = labels.filter((t) => !t.includes("→"));
    ok("QA-2435: both batch-transition buttons name the ACTION and the state, not the state alone",
      labels.length >= 2 && bare.length === 0,
      labels.length < 2
        ? `found ${labels.length} Awaited-transition button label(s) where 2 are expected - the region moved, so this pin is reading the wrong place`
        : `bare state label(s): ${bare.join(" | ")} - a person pressing this is saying what HAPPENED, so the button says it`);
  }

  // -224 (QA-880, recommended by the cycle-3 checker): the CLASS pin, not another instance pin.
  // Every instance above says "this one handler is fixed". This one says "no handler in this panel
  // may regress into the defect at all": inside CandidateResults, a catch that reports ONLY through
  // the page-level setError is the whole fault this unit exists to remove - the refusal lands in a
  // banner thousands of pixels above the press. `fail()` and `report()` are the two surfaces that
  // reach the operator. The checker's point about this pin is the reason it is here: it would have
  // failed cycle 1 in under a second, with no browser and no server, and cycle 1 instead took a
  // human driving production to find. It also covers handlers nobody has written yet.
  const cr = b.indexOf("function CandidateResults");
  const crEnd = cr > 0 ? (b.indexOf("\nfunction ", cr + 10) === -1 ? b.length : b.indexOf("\nfunction ", cr + 10)) : -1;
  const crBody = cr > 0 ? b.slice(cr, crEnd) : "";
  const bareCatches = [];
  if (crBody) {
    const re = /catch\s*\([^)]*\)\s*\{/g;
    let m;
    while ((m = re.exec(crBody)) !== null) {
      // walk to the matching brace so nested blocks do not truncate the body
      let depth = 1, i = m.index + m[0].length;
      while (i < crBody.length && depth > 0) { const c = crBody[i]; if (c === "{") depth++; else if (c === "}") depth--; i++; }
      const body = crBody.slice(m.index, i);
      if (/setError\s*\(/.test(body) && !/\b(fail|report)\s*\(/.test(body)) {
        bareCatches.push(body.replace(/\s+/g, " ").slice(0, 90));
      }
    }
  }
  ok("-230 (QA-880 class pin): no catch in CandidateResults reports only through the page-level banner",
    crBody.length > 0 && bareCatches.length === 0,
    crBody.length === 0 ? "could not locate CandidateResults" : `${bareCatches.length} bare: ${JSON.stringify(bareCatches[0] ?? "")}`);

  ok("-229 (QA-856): a failed per-candidate mark pins its refusal to that candidate's own card",
    /setCardErrors/.test(markBody), markBody ? "mark() still reports only through the page-level banner" : "could not locate mark()");
}

console.log(`\ncheck-home-structure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
