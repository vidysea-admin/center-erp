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

console.log(`\ncheck-home-structure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
