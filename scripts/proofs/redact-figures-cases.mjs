// Offline behaviour harness for redactFiguresInText. Extracts BOTH the helper and the
// plausibleDate function it now depends on — the previous version extracted only one of the two and
// crashed at the second .replace, which is its own small lesson about harnesses.
import fs from "node:fs";

const src = fs.readFileSync(new URL("../../src/lib/permissions.ts", import.meta.url), "utf8");
const grab = (sig) => {
  const i = src.indexOf(sig);
  if (i < 0) throw new Error(`not found: ${sig}`);
  return src.slice(i, src.indexOf("\n}\n", i) + 2);
};
const js = (s) => s
  .replace("export function redactFiguresInText(text: string): string {", "function redactFiguresInText(text) {")
  .replace("function plausibleDate(yy: string, mm: string, dd: string): boolean {", "function plausibleDate(yy, mm, dd) {")
  .replace("const kept: string[] = [];", "const kept = [];")
  .replace("const enc = (n: number) =>", "const enc = (n) =>")
  .replace("const dec = (s: string) =>", "const dec = (s) =>");
const f = new Function(`${js(grab("function plausibleDate"))}\n${js(grab("export function redactFiguresInText"))}\nreturn redactFiguresInText;`)();

let bad = 0;
const must = (n, c, d = "") => { console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? "  " + d : ""}`); if (!c) bad++; };
const noFig = (s) => !/\d{3,}|\d,\d\d,\d\d\d|\d\d\d,\d\d\d/.test(f(s).replace(/\d{4}-\d{2}-\d{2}(?:T[\d:.+\-Z]+)?/g, ""));

// QA-1872 — the LOOKBEHIND half, which nothing pinned. Year 2026 is plausible, so the plausibility
// test cannot save these: only the not-preceded-by-a-digit guard can.
must("QA-1872: a figure whose tail completes a PLAUSIBLE date is redacted", noFig("advance 422026-01-02 cleared"), `-> ${JSON.stringify(f("advance 422026-01-02 cleared"))}`);
must("QA-1872: ...and again with another prefix", noFig("ref 992026-09-05"), `-> ${JSON.stringify(f("ref 992026-09-05"))}`);
// QA-1873 — the TIME tail
must("QA-1873: a figure riding the datetime tail is redacted", !/424242/.test(f("paid 2026-09-05T424242 done")), `-> ${JSON.stringify(f("paid 2026-09-05T424242 done"))}`);
must("QA-1874: a figure riding the FRACTIONAL seconds is redacted", !/424242/.test(f("at 2026-09-05T10:00:00.424242 paid")), `-> ${JSON.stringify(f("at 2026-09-05T10:00:00.424242 paid"))}`);
must("QA-1874: a real millisecond timestamp still survives intact", f("at 2026-09-05T18:30:00.123Z ok").includes("2026-09-05T18:30:00.123Z"));
must("QA-1873: a garbage time costs the TAIL, not the date beside it", f("at 2026-09-05T99:99:99").includes("2026-09-05"), `-> ${JSON.stringify(f("at 2026-09-05T99:99:99"))}`);
// QA-1870 stays closed
must("QA-1870: implausible month/day", !/4242-42/.test(f("ref 4242-42-42")), `-> ${JSON.stringify(f("ref 4242-42-42"))}`);
must("QA-1870: implausible-year tail", !/424242/.test(f("paid 424242-01-02")), `-> ${JSON.stringify(f("paid 424242-01-02"))}`);
// Real values survive INTACT
for (const s of ["2026-09-05", "1998-05-05", "2026-09-05T18:30:00Z", "2026-09-05T18:30", "2026-09-05T18:30:00.123Z", "2026-09-05T18:30:00+05:30"])
  must(`survives intact: ${s}`, f(`at ${s} ok`).includes(s), `-> ${JSON.stringify(f(`at ${s} ok`))}`);
must("two-digit counts survive", f("batch of 25 students").includes("25"));
// QA-1869 — the placeholder
const many = Array.from({ length: 200 }, (_, k) => `2026-01-${String((k % 28) + 1).padStart(2, "0")}`).join(" ");
must("QA-1869: 200 dates in one string all survive", (f(many).match(/2026-01-/g) || []).length === 200, `kept ${(f(many).match(/2026-01-/g) || []).length}`);
must("QA-1869: no corrupt placeholder or undefined", !/@@D|undefined/.test(f(many)));
must("QA-1869: user text cannot impersonate a placeholder", !/undefined/.test(f("@@DABD@@ 999999 on 2026-01-02")), `-> ${JSON.stringify(f("@@DABD@@ 999999 on 2026-01-02"))}`);
// QA-1867 stays closed
for (const [s, why] of [["Rs.424242", "dot before"], ["424242rs", "letter after"], ["_424242_", "underscore"], ["4,24,242", "en-IN"], ["424,242", "en-US"], ["(424242)", "brackets"], ["ref#424242", "hash"]])
  must(`QA-1867 stays closed: ${why}`, !/42424|4,24,24/.test(f(s)), `-> ${JSON.stringify(f(s))}`);

console.log(bad ? `\n${bad} FAILED` : "\nall green");
process.exit(bad ? 1 : 0);
