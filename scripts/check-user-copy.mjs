// -111 (Umesh 18/08, "rule this, rule that — aisa koi rule hai nahi"): static wall check that no
// user-facing string in src/ carries one of OUR ledger codes ("Rule 45", "DEC-6", "QA-142").
//
// What counts as user-facing here: JSX text and string/template literals in .tsx files, plus
// string literals in .ts files that are NOT thrown as HttpError / fail() — those two go through
// apiHandler, where plain() strips codes at the door (src/lib/user-copy.ts). Comments are ignored
// (rule numbers in comments are for us and are useful). src/lib/version.ts is ignored (release
// notes for the deploy poll, never rendered on a screen).
//
// Output matches the other suites ("N passed, M failed") so run-e2e.mjs counts it as a suite.
// Runs with no server and no DB — pure source scan.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const CODE = /\b(?:Rules?|DEC|QA)[-\s]?\d+\b/;
const SKIP_FILES = new Set(["lib/version.ts"]);

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(tsx?|ts)$/.test(e.name)) yield p;
  }
}

function stripComments(src) {
  // block comments (incl. JSX {/* */}) → same number of newlines so line numbers hold
  let s = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  // line comments — but not "//" inside a string ("https://…") — approximate: only when preceded
  // by start-of-line/whitespace/;/{/( and not inside quotes on that line before it
  s = s.split("\n").map((line) => {
    let out = "", q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { out += c; if (c === "\\") { out += line[++i] ?? ""; continue; } if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; out += c; continue; }
      if (c === "/" && line[i + 1] === "/") break;
      out += c;
    }
    return out;
  }).join("\n");
  return s;
}

let passed = 0, failed = 0;
const hits = [];
for (const file of walk(root)) {
  const rel = path.relative(root, file).replace(/\\/g, "/");
  if (SKIP_FILES.has(rel)) continue;
  const src = stripComments(fs.readFileSync(file, "utf8"));
  const isTsx = file.endsWith(".tsx");
  const lines = src.split("\n");
  let fileHits = 0;
  lines.forEach((line, idx) => {
    if (!CODE.test(line)) return;
    // Server-side messages thrown as HttpError / fail() pass through plain() at apiHandler — the
    // chokepoint covers them, and the wall pins that separately. Everything else must be clean.
    if (!isTsx && /\b(?:HttpError\(|fail\(|throw\b)/.test(line)) return;
    // string / template literals carrying a code
    const inLiteral = /(["'`])(?:(?!\1)[^\\]|\\.)*?(?:Rules?|DEC|QA)[-\s]?\d+(?:(?!\1)[^\\]|\\.)*?\1/.test(line);
    // JSX text: a code between a ">" (or the "}" closing an inline expression) and the next "<"/"{"
    const inJsx = isTsx && /[>}][^<{]*\b(?:Rules?|DEC|QA)[-\s]?\d+\b[^<{]*/.test(line);
    // JSX text continued on its own line (no tags at all on the line, inside a .tsx file)
    const bareJsx = isTsx && !/[<>{}=;]/.test(line.trim()) && /^\s*[A-Za-z(]/.test(line) && CODE.test(line);
    if (inLiteral || inJsx || bareJsx) { fileHits++; hits.push(`${rel}:${idx + 1}: ${line.trim().slice(0, 140)}`); }
  });
  if (fileHits) failed++; else passed++;
}

for (const h of hits) console.log("  ✗ " + h);
if (hits.length) console.log(`\n${hits.length} user-facing string(s) still carry a Rule/DEC/QA code — rewrite as "what happened + what to do".`);
console.log(`\ncheck-user-copy: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
