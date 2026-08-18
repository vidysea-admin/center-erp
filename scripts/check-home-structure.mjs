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

console.log(`\ncheck-home-structure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
