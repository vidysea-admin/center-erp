// Prove the new wall pin (a) sees the real patterns, (b) passes on them, (c) fires on a regression.
// Written to a FILE rather than `node -e` because three inline repros today have been the broken
// instrument rather than the finding.
import fs from "node:fs";

// Line endings are normalised on read. The worktree is CRLF and every anchor below is written with
// a bare newline, so the FIRST committed version of this proof crashed the moment it ran in a fresh
// isolation copy — a proof that runs only on the machine that wrote it is the same defect the
// checker filed when it found this file was not in the tree at all, arriving a second time.
const src = fs.readFileSync(new URL("../../src/lib/permissions.ts", import.meta.url), "utf8")
  .split("\r\n").join("\n");
const NEEDLE = ".replace(/(?<!" + String.fromCharCode(92) + "d)";
const extract = (text) => text.split("\n")
  .filter((l) => l.includes(NEEDLE))
  .map((l) => l.slice(l.indexOf(".replace(/") + ".replace(".length, l.lastIndexOf("/g") + 2));
const unbounded = (p) => /[+*]|\{\d+,\}/.test(p.replace(/\[[^\]]*\]/g, "C"));

const parkers = extract(src);
console.log("parkers found:", parkers.length);
parkers.forEach((p) => console.log(`  unbounded=${unbounded(p)}  ${p.slice(0, 88)}`));

let bad = 0;
const must = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  " + d : ""}`); if (!c) bad++; };
must("the pin finds exactly two parking patterns", parkers.length === 2);
must("neither carries an unbounded quantifier today", parkers.every((p) => !unbounded(p)));
// The regression this pin exists to stop: the fraction goes back to \d+ (QA-1874's actual defect).
const regressed = parkers[0]?.replace("\\d{1,3}", "\\d+");
must("the pin FIRES when the fraction goes back to being unbounded", !!regressed && unbounded(regressed),
  regressed?.slice(0, 88));
// And it must not be fooled by the timezone sign, which is a character class and not a quantifier.
must("the pin is not fooled by the `[+-]` timezone sign", !unbounded("/(?<!\\d)(\\d{4})-(\\d{2})-(\\d{2})(?:Z|[+-]\\d{2}:\\d{2})?/g"));

// QA-1879: the width check, added because "bounded" was the wrong property to assert — `\d{1,9}`
// is bounded and is not a millisecond. These two cases are the pin's own regression test.
// The escaping here is the point of the exercise: `"\."` in JS source is just `"."`, so the first
// version of these two lines tested nothing and reported the shipped pattern as failing — a proof
// that indicted correct code. The wall's own copy of this rule was written with `"\\."` and was
// right all along. Doubt the instrument before the finding, on a three-line check as much as on a
// three-thousand-line one.
const widthOk = (p) => !p.includes("\\.") || p.includes("\\.\\d{1,3}");
must("the width check accepts the shipped pattern", parkers.every(widthOk));
must("the width check FIRES on a bounded-but-too-wide fraction",
  !widthOk(parkers[0].replace("\\d{1,3}", "\\d{1,9}")));
process.exit(bad ? 1 : 0);
