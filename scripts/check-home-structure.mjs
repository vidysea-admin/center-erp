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
  ok("-224 (QA-878): the standing Reopen control also asks the zero-rows half of its server guard",
    reopenGate > 0 && /legacy\s*&&\s*$/.test(gateLine.replace(/^\s*\{/, "")),
    reopenGate > 0 ? `gate reads: ${JSON.stringify(gateLine.trim())}` : "reopen gate not found");

  // ...and the confirm must READ provenance, not assert it. Asserting "recorded by hand" on a
  // derived sign-off is a falsehood told to obtain consent.
  ok("-224 (QA-878): the reopen confirm reads assessment_derived instead of asserting how the figures were made",
    b.includes("assessment_derived"), "assessment_derived appears 0 times in this file");

  // QA-877: a SUCCESSFUL bulk mark must clear the per-card refusals it has just disproved, or a
  // stale "cannot mark" stands beside a green Pass. mark() already did this; bulkApply did not.
  const bulk = b.indexOf("async function bulkApply");
  const bulkEnd = b.indexOf("async function certPatch", bulk);
  const bulkBody = bulk > 0 && bulkEnd > bulk ? b.slice(bulk, bulkEnd) : "";
  ok("-224 (QA-877): a successful bulk mark clears the per-card errors of the members it updated",
    /setCardErrors/.test(bulkBody) && /delete\s+n\[/.test(bulkBody),
    bulkBody ? "bulkApply never removes a cardErrors entry" : "could not locate bulkApply");

  // QA-862: "Generate & issue" must not close its own drawer on failure - that is what made the
  // Drawer's existing `error` slot useless and left N refusals showing as one, after the panel the
  // operator was reading had vanished.
  const gen = b.indexOf("Generate &amp; issue");
  const genStart = gen > 0 ? b.lastIndexOf("<Btn onClick={async () => {", gen) : -1;
  const genBody = genStart > 0 ? b.slice(genStart, gen) : "";
  ok("-224 (QA-862): Generate & issue does not close its drawer unconditionally after the loop",
    genBody.length > 0 && !/\n\s*setCertDrawer\(false\);\s*await load\(\)/.test(genBody),
    genBody ? "setCertDrawer(false) still runs straight after the loop" : "could not locate the handler");
  ok("-224 (QA-862): ...and it collects every refusal instead of each overwriting the last",
    /failures\.push\(/.test(genBody), "no failures[] accumulation in the issue loop");

  // QA-886: and it must not silently skip candidates whose number is blank while issuing the rest.
  ok("-224 (QA-886): Generate & issue counts the candidates it left out for want of a number",
    /skipped\.push\(/.test(genBody), "blank-number candidates are still skipped in silence");

  // QA-856: the marking grid's failures must reach a surface AT the press, not only the page-top
  // banner thousands of pixels above a viewport scrolled through 46 cards.
  const mark = b.indexOf("async function mark(");
  const markEnd = b.indexOf("async function bulkApply", mark);
  const markBody = mark > 0 && markEnd > mark ? b.slice(mark, markEnd) : "";
  ok("-224 (QA-856): a failed per-candidate mark pins its refusal to that candidate's own card",
    /setCardErrors/.test(markBody), markBody ? "mark() still reports only through the page-level banner" : "could not locate mark()");
}

console.log(`\ncheck-home-structure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
