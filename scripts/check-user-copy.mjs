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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const CODE = /\b(?:Rules?|DEC|QA)[-\s]?T?\d+\b/;
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

// QA-681 / QA-685 (-204, two checkers on the same day): every pin in this file that wanted to look
// inside one function did `src.slice(src.indexOf("function NAME"))` — which runs to the END OF FILE.
// So anything declared BELOW the function satisfies a check aimed at its body. Both findings are
// that one bug: on qa-198 a checker deleted the trainer spread from `PlanningCreate.save()`, put the
// same expression in an UNCALLED helper underneath, and every pin stayed green; on qa-202 the same
// slice shape meant the Nomination card's Save could lose its whole date half unnoticed.
//
// blankStrings keeps the length identical (string bodies become spaces, newlines survive) so the
// brace scan cannot be thrown by a `{` or `}` inside a literal, and the index it finds still points
// at the right place in the ORIGINAL text.
function blankStrings(s) {
  let out = "", q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\") { out += "  "; i++; continue; }
      if (c === q) { q = null; out += c; continue; }
      out += (c === "\n" ? "\n" : " ");
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { q = c; out += c; continue; }
    out += c;
  }
  return out;
}

// The body of `function NAME(...) { ... }`, bounded by its own braces. Empty string when absent —
// callers must treat that as a failure, not as "nothing to check".
function fnBody(src, name) {
  const start = src.indexOf("function " + name);
  if (start < 0) return "";
  const scan = blankStrings(src);
  // Step over the PARAMETER LIST first. The first version of this brace-matched from the first `{`
  // after the name, which on `function PlanningCreate({ a, b }: { a: X, b: Y }) {` is the
  // DESTRUCTURING brace - so it returned the parameter object and four pins failed on correct code.
  // Paren-match the arguments, then the next `{` is the body.
  const paren = scan.indexOf("(", start);
  if (paren < 0) return "";
  let pd = 0, afterParams = -1;
  for (let i = paren; i < scan.length; i++) {
    if (scan[i] === "(") pd++;
    else if (scan[i] === ")") { pd--; if (pd === 0) { afterParams = i + 1; break; } }
  }
  if (afterParams < 0) return "";
  const open = scan.indexOf("{", afterParams);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < scan.length; i++) {
    if (scan[i] === "{") depth++;
    else if (scan[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return "";
}

let passed = 0, failed = 0;
const hits = [];
// -153 (QA-372): the structural/copy split used to be a REGEX over the rendered message, so every
// new structural check had to REMEMBER to enrol in it - and -151's control-character scan and
// -152's gate-pattern scan both forgot. The result: a maker who had just written a NUL into
// product code was told to "rewrite as what happened + what to do". That regressed QA-324, which
// had been Validated three releases earlier. Classification now happens where the finding is
// RAISED, not where it is printed. QA-377: the FIRST version of that claimed a new check "cannot
// silently be misfiled" while converting only 5 of 16 raise sites - so the two checks the old
// regex happened to classify correctly were now misfiled instead. The misfiling ROTATED. What
// actually enforces it is the reconciliation at the bottom of this file: every hit must be in one
// register or the other, and check-user-copy FAILS ITSELF if any is in neither.
const structuralIdx = new Set();
const pushStructural = (msg) => { structuralIdx.add(hits.length); hits.push(msg); };
const copyIdx = new Set();
const pushCopy = (msg) => { copyIdx.add(hits.length); hits.push(msg); };
for (const file of walk(root)) {
  const rel = path.relative(root, file).replace(/\\/g, "/");
  if (SKIP_FILES.has(rel)) continue;
  const src = stripComments(fs.readFileSync(file, "utf8"));
  const isTsx = file.endsWith(".tsx");
  const lines = src.split("\n");
  let fileHits = 0;
  lines.forEach((line, idx) => {
    if (!CODE.test(line)) return;
    // Server-side messages thrown as HttpError / fail() pass through plain() at apiHandler, so they
    // MAY carry a code — but only in a shape plain() strips cleanly. QA-239 (checker) probed the
    // function and found the gap: a bare code mid-sentence ("blocked by Rule 27 and Rule 43 today")
    // either survives or leaves a hole, and no regex repairs English. So the shape is enforced here
    // rather than guessed there: leading "Rule 45:", a parenthetical "(Rule 45…)", or a trailing
    // "— Rule 45". Anything else fails the wall with the line printed.
    // -128 (QA-272): a throw whose message sits on the NEXT line (`throw new HttpError(409,` then
    // the backtick on its own line) was judged by the generic literal rule instead of the thrown-message
    // rule, and reported as a leak even when the shape strips cleanly. Look back one line before
    // deciding. This makes the pin more accurate, not weaker — the code must still be strippable.
    const prevLine = idx > 0 ? lines[idx - 1] : "";
    const thrownHere = /\b(?:HttpError\(|fail\(|throw\b)/.test(line)
      || (/\b(?:HttpError\(|fail\(|throw\b)/.test(prevLine) && /,\s*$|\(\s*$/.test(prevLine.trim()));
    if (!isTsx && thrownHere) {
      const safe = /(["`])\s*(?:Rules?|DEC|QA)[-\s]?T?\d+\s*[:—-]/.test(line)          // leading
        || /\((?:Rules?|DEC|QA)[-\s]?T?\d+[^)]*\)/.test(line)                          // parenthetical
        || /[—,-]\s*(?:Rules?|DEC|QA)[-\s]?T?\d+\s*(?:\.\s*)?(["`])/.test(line);       // trailing
      if (safe) return;
      pushCopy(`${rel}:${idx + 1}: [thrown message: the code must lead ("Rule 45: …"), sit in brackets, or trail — this shape does not strip cleanly] ${line.trim().slice(0, 120)}`);
      fileHits++;
      return;
    }
    // string / template literals carrying a code
    const inLiteral = /(["'`])(?:(?!\1)[^\\]|\\.)*?(?:Rules?|DEC|QA)[-\s]?T?\d+(?:(?!\1)[^\\]|\\.)*?\1/.test(line);
    // JSX text: a code between a ">" (or the "}" closing an inline expression) and the next "<"/"{"
    const inJsx = isTsx && /[>}][^<{]*\b(?:Rules?|DEC|QA)[-\s]?T?\d+\b[^<{]*/.test(line);
    // JSX text continued on its own line (no tags at all on the line, inside a .tsx file)
    const bareJsx = isTsx && !/[<>{}=;]/.test(line.trim()) && /^\s*[A-Za-z(]/.test(line) && CODE.test(line);
    if (inLiteral || inJsx || bareJsx) { fileHits++; pushCopy(`${rel}:${idx + 1}: ${line.trim().slice(0, 140)}`); }
  });
  if (fileHits) failed++; else passed++;
}

// ---- -127 (QA-265): the file this suite deliberately SKIPS was the one that was broken ----
// src/lib/version.ts was one constant whose continuation lines carried no `+`. JavaScript then
// applied automatic semicolon insertion: the first line became RELEASE_NOTE and the other 329
// became dead no-op expression statements. tsc was happy, the build was happy, and production
// published a 97-character release note for an unknown number of releases. Nothing in the wall
// could see it, because a truncated string is still a valid string.
//
// This is a source-shape trap, not a copy problem, so it lives in the source-scan suite: two string
// literals on consecutive lines with no operator between them are always a mistake, in ANY file.
{
  let asiHits = 0;
  for (const rel of ["lib/version.ts"]) {
    const lines = fs.readFileSync(path.join(root, rel), "utf-8").split(String.fromCharCode(10)).map((l) => l.replace(String.fromCharCode(13), ""));
    for (let i = 1; i < lines.length; i++) {
      const cur = lines[i].trim(), prev = lines[i - 1].trim();
      if (!cur.startsWith('"') || !prev.startsWith('"')) continue;
      if (/(?:\+|,|\(|\[)$/.test(prev)) continue;   // legitimately continued
      if (/;$/.test(prev)) continue;                 // previous statement genuinely ended
      asiHits++;
      pushStructural(`${rel}:${i + 1}: [ASI trap] this string literal follows another with no operator, so everything from here is a dead no-op statement — join them with " +"`);
    }
  }
  if (asiHits) failed++; else passed++;

  // and the published marker must actually describe THIS build, which is the symptom a reader sees
  const src = fs.readFileSync(path.join(root, "lib/version.ts"), "utf-8");
  const rel = (src.match(/export const RELEASE = "([^"]+)"/) ?? [])[1] ?? "";
  const curNote = (src.split("export const RELEASE_NOTE_CURRENT =")[1] ?? "").split("const RELEASE_NOTE_ARCHIVE")[0];
  const tag = "-" + rel.split("-").pop();
  if (rel && curNote.includes(tag)) passed++;
  else { failed++; pushStructural(`lib/version.ts: the published note does not mention ${tag} — RELEASE was bumped without writing what changed`); }

  // -128: and the archive must NOT ride along. QA-265 split the note in two precisely so the
  // unauthenticated build marker publishes what THIS build changed rather than forty releases of
  // internal commentary — and then the very next bump spliced the old note into CURRENT instead of
  // moving it to the archive, silently republishing it. Prose may REFER to an older release ("-111
  // built plain() so nobody reads Rule 45"); what must never appear is the archive's own opening.
  const archive = (src.split("const RELEASE_NOTE_ARCHIVE =")[1] ?? "");
  const archiveHead = (archive.match(/"([^"]{40,})"/) ?? [])[1] ?? "";
  if (!archiveHead || !curNote.includes(archiveHead)) passed++;
  else { failed++; pushStructural("lib/version.ts: RELEASE_NOTE_CURRENT contains the start of the archive — the old note was spliced in rather than moved, so the public marker republishes it"); }

  // -129: and the sharper version of the same test, because the one above missed it. Splicing the
  // PREVIOUS note into CURRENT leaves the archive's own opening untouched, so "does CURRENT contain
  // the archive head" answers no while the marker still publishes two releases. I did exactly that
  // on the -128 bump AND again on the -129 bump. The previous release's own opening marker is the
  // thing that must not be there — mechanical, and it does not care how the text was moved.
  const n = parseInt((rel.split("-").pop() ?? "0"), 10);
  const prevTag = n > 1 ? `"-${n - 1}` : "";  // -139: ANY separator. The -138 block opened `"-138,`
  // and slipped past both `"-138 ` and `"-138:` — the pin's THIRD hole, found the same way as the
  // first two: by reading the endpoint after a deploy rather than trusting the pin.           // how every block opens: `"-128 (QA-...`
  const prevTagAlt = n > 1 ? `"-${n - 1}:` : "";         // older blocks open `"-126: ...`
  if (!n || (!curNote.includes(prevTag) && !curNote.includes(prevTagAlt))) passed++;
  else { failed++; pushStructural(`lib/version.ts: RELEASE_NOTE_CURRENT still opens a -${n - 1} block — the previous note was left in CURRENT instead of moved to the archive, so the public marker publishes two releases`); }
}

// ---- -128 (QA-266): a drawer must be able to show its own failure ----
// The Drawer is a fixed inset-0 z-50 overlay, so a page-level error banner is painted over by it.
// Every drawer in this app did exactly that: the refusal was fetched, caught, stored and rendered
// underneath the modal. Divya read it as "nothing happens". The component has an `error` slot now;
// this pin is what stops the next drawer being added without one.
{
  let missing = 0;
  const drawerFiles = [];
  const walkAll = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walkAll(full);
      else if (/\.tsx$/.test(e.name)) drawerFiles.push(full);
    }
  };
  walkAll(root);
  for (const full of drawerFiles) {
    const src = fs.readFileSync(full, "utf-8");
    if (!src.includes("<Drawer ")) continue;
    const rel = path.relative(root, full).split(path.sep).join("/");
    let i = 0;
    for (;;) {
      const at = src.indexOf("<Drawer ", i);
      if (at === -1) break;
      let j = at + 8, depth = 0, quote = "";
      for (; j < src.length; j++) {
        const c = src[j];
        if (quote) { if (c === quote) quote = ""; continue; }
        if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
        if (c === "{") depth++; else if (c === "}") depth--;
        else if (c === ">" && depth === 0) break;
      }
      if (!/\berror=/.test(src.slice(at, j))) {
        missing++;
        pushStructural(`${rel}:${src.slice(0, at).split(String.fromCharCode(10)).length}: [drawer] this <Drawer> passes no \`error\` prop, so a failure inside it renders in the page banner the drawer covers`);
      }
      i = j;
    }
  }
  if (missing) failed++; else passed++;
}

// ---- -129 (QA-268): the doc-type list is written out three times ----
// TRAINER_DOC_TYPE lives in models/index.ts, which pulls mongoose, so the two client pages cannot
// import it - they carry hand-copies. That is exactly how "CIPSA Certificate" survived in three
// places at once. The copies are allowed; drifting from the enum is not.
{
  const modelSrc = fs.readFileSync(path.join(root, "models/index.ts"), "utf-8");
  const enumBlock = (modelSrc.split("export const TRAINER_DOC_TYPE = [")[1] ?? "").split("] as const;")[0];
  const enumVals = [...enumBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const copies = [
    ["app/(app)/trainers/[id]/page.tsx", "const DOC_TYPES = ["],
    ["app/(app)/admin/page.tsx", "Extra mandatory trainer documents"],
  ];
  let drift = 0;
  for (const [rel, marker] of copies) {
    const src = fs.readFileSync(path.join(root, rel), "utf-8");
    const after = src.slice(src.indexOf(marker));
    const block = after.slice(0, after.indexOf("]") + 1);
    const vals = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((v) => enumVals.includes(v) || /Certificate|Experience|Aadhaar|PAN|Photo|CV|Qualification|Other/.test(v));
    const strays = vals.filter((v) => !enumVals.includes(v));
    if (strays.length) { drift++; pushStructural(`${rel}: doc-type list has ${JSON.stringify(strays)} which is not in TRAINER_DOC_TYPE — the copy has drifted from the enum`); }
  }
  if (enumVals.some((v) => /CIPSA/i.test(v))) { drift++; pushStructural("models/index.ts: TRAINER_DOC_TYPE still carries CIPSA — the credential is CITS"); }
  if (drift) failed++; else passed++;
}

// ---- -131 (QA-278): the backfill script carries a COPY of hhmmssToMinutes ----
// It has to: src/lib/govt-attendance.ts imports @/models, so a plain node migration cannot reach it
// without dragging mongoose and the whole alias graph in — which is why every other migration here
// uses raw mongo. -129 hit the same wall with the doc-type lists and answered it the same way: the
// copy is allowed, DRIFTING is not. The script self-tests against a fixed table; the APP's side of
// that same table is pinned at runtime by e2e-govt.mjs's decimal-hours and junk-hours blocks, so
// both ends are anchored to one set of expectations. Run it rather than parse it — nothing is eval'd.
{
  const r = spawnSync(process.execPath, [path.join(root, "..", "scripts", "reparse-govt-hours.mjs"), "--selftest"], { encoding: "utf-8" });
  const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
  if (r.status === 0) passed++;
  else { failed++; pushStructural(`scripts/reparse-govt-hours.mjs: its copy of hhmmssToMinutes no longer agrees with the expected table — ${out.split(String.fromCharCode(10))[0]}`); }
}

// ---- -136 (QA-282): a surface a person opens must have a way to close ----
// Umesh, 19/08: "platform me aisi bahut sari jagah hai, toh woh sab main kaise bataata rahoon?"
// He raised the same thing on 15/08; it was fixed for HealthBanner and ShareLinkPanel and the
// panels BESIDE them still had no way out four days later.
//
// THE SCAN TOOK THREE VERSIONS AND BOTH EARLIER ONES WERE WRONG IN OPPOSITE DIRECTIONS.
// v1 required the setter to sit inside an onClick, found 2, and missed `attLinks` — the single
// example he actually gave, which is filled inside an async handler. v2 fixed that and then
// OVER-reported: it read a setter's argument with `set\w+\(([^)]*)`, which stops at the first
// ')', so `setShowSources((s) => !s)` came back as '(s' and three working toggles plus an
// accordion looked trapped. v3 balances the parentheses. A scan that misses the reported case
// proves nothing; one that invents four proves less than nothing, because it turns a real
// complaint into noise.
//
// THE TRIAGE IS DONE and the remaining 15 are NOT defects — each was read, not guessed:
//   fLoc x2, sheet-watch `source`  — filter values on a <select> that can be set back to ''
//   driveRoot                      — a bare <a> link, not a panel
//   selected                       — a ring/highlight className
//   uploadNote, knobs, shortfallMsg — <span>s of text beside a control
//   invoice                        — loaded from data (setInvoice(d.invoice)), not click-opened
//   legacy                         — a mode flag read in an `actions=` prop
//   perCandidate                   — a DELIBERATE one-way switch: you do not un-start
//                                    per-candidate marking and go back to the legacy count
//   p/enrol email+phone, p/register submitted, wizard `src` — form state and wizard steps
//
// So of the 22 v3 would have flagged, THREE were real and all three are fixed. The ceiling stays
// as a guard against the next one, not as a claim that 15 things are broken.
{
  const CEILING = 15;
  const argOf = (src, i) => {
    let depth = 0, out = "";
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "(") { depth++; if (depth === 1) continue; }
      else if (c === ")") { depth--; if (depth === 0) break; }
      out += c;
    }
    return out.trim();
  };
  const openable = [];
  const walkTsx = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walkTsx(full); continue; }
      if (!/\.tsx$/.test(e.name)) continue;
      const src = fs.readFileSync(full, "utf-8");
      const rel = path.relative(root, full).split(path.sep).join("/");
      for (const m of src.matchAll(/const \[(\w+), (set\w+)\] = useState/g)) {
        const get = m[1], set = m[2];
        const gates = new RegExp("\\{\\s*" + get + "\\s*&&").test(src)
          || new RegExp("\\{" + get + " \\?").test(src)
          || new RegExp("open=\\{!!\\s*" + get + "\\}").test(src)
          || new RegExp("open=\\{" + get + "\\}").test(src);
        if (!gates) continue;
        const args = [];
        for (const c of src.matchAll(new RegExp(set + "\\(", "g"))) args.push(argOf(src, c.index + set.length));
        const truthy = args.some((a) => a && !/^(null|false|undefined|""|''|\[\]|\{\})$/.test(a));
        const clears = args.some((a) => /^(null|false|undefined|""|''|\[\])$/.test(a)
          || /=>\s*!/.test(a) || /^!/.test(a) || /\?\s*null\s*:/.test(a) || /:\s*null\s*$/.test(a)
          // -196: a value taken from a checkbox's own `checked` is two-way by construction - the
          // same control that turns the surface on turns it off. Without this the check reads a
          // toggle as a one-way door and asks for an exit that is already there, which is a false
          // positive that costs the next person a real finding's worth of attention.
          || /\.checked\b/.test(a));
        if (truthy && !clears) openable.push(rel + " · " + get);
      }
    }
  };
  walkTsx(root);
  if (openable.length <= CEILING) passed++;
  else {
    failed++;
    pushStructural(`a surface was added that opens and nothing can close: ${openable.length} now, ceiling ${CEILING}. Give it a way out, or lower the ceiling if you closed some: ${openable.slice(0, 6).join(" | ")}`);
  }
}

// -144 (QA-314): matchGovtRows must never read a row field bare. -143 widened who feeds that
// function -- it used to see only rows fresh off the parser, where every field is a string, and
// now the import DETAIL route feeds it PERSISTED documents on every read. A missing key then
// throws inside the loop that builds the whole response, so the cost is a 500 on the entire
// import view rather than one row's note. The wall cannot pin this: it drives the HTTP API on
// purpose, and no HTTP path produces such a document (the parser's column reader returns "" for a
// missing column, never undefined). A source scan can, and it fails on the pre-fix file.
{
  const f = path.join(root, "lib/govt-attendance.ts");
  const src = fs.readFileSync(f, "utf-8");
  const body = src.slice(src.indexOf("export async function matchGovtRows"));
  // a bare `r.<field>.` or `r.<field>?.` chained call -- guarded forms go through String(... ?? "")
  const bare = [...body.matchAll(/(?<!String\()\br\.([a-z_]+)\??\.(trim|toUpperCase|toLowerCase|replace|split)\(/g)];
  if (!bare.length) passed++;
  else {
    failed++;
    pushStructural(`lib/govt-attendance.ts: matchGovtRows reads ${bare.map((m) => "r." + m[1]).join(", ")} bare. Since -143 this function is fed STORED documents as well as parsed rows, and a missing key throws for the whole import detail, not one row. Derive it once via String(r.<field> ?? "") and reuse.`);
  }
}

// -145 (QA-302): A SCOPE FILTER MUST NOT BE OVERWRITABLE BY A SIBLING KEY.
// { ...batchScope, batch: { $nin: [...] } } sets 'batch' twice and the object literal's own key
// wins, so the scope silently disappears -- Rule 38 and LANDMINE L4 both defeated by JS, not by
// logic, which is why it survives review. It cost a live scope leak: every scoped role was shown
// the whole country's "our logs" attendance while every figure beside it was correctly narrowed.
// This is the general form, not a patch on the one site: for every '...<x>Scope' spread, read what
// that scope object actually defines in the same file and refuse any sibling key that collides.
{
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.tsx?$/.test(e.name)) files.push(f);
    }
  })(root);
  let collisions = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf-8");
    for (const line of src.split(/\r?\n/).entries()) {
      const [i, l] = line;
      // a scanner that flags PROSE is a scanner people switch off - this pin's own
      // explanatory comment quotes the bad pattern verbatim and tripped it.
      const t = l.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      const m = /\.\.\.(\w*[Ss]cope)\b/.exec(l);
      if (!m) continue;
      const scopeName = m[1];
      // what does that scope object define? read its const in the same file
      const def = new RegExp("const\\s+" + scopeName + "\\s*=[^;]*", "s").exec(src);
      if (!def) continue;
      const owned = new Set([...def[0].matchAll(/\{\s*([a-z_][a-zA-Z_]*)\s*:/g)].map((x) => x[1]));
      // QA-323 taught this the mirror case: a key declared BEFORE the spread is overwritten BY it,
      // and looking only at what follows the spread misses exactly half the class. Both sides now.
      const before = l.slice(0, m.index);
      const after = l.slice(m.index + m[0].length);
      const keys = [...before.matchAll(/([a-z_][a-zA-Z_]*)\s*:/g), ...after.matchAll(/([a-z_][a-zA-Z_]*)\s*:/g)].map((x) => x[1]);
      for (const k of keys) {
        if (!owned.has(k)) continue;
        collisions++;
        pushStructural(
          path.relative(root, f).replace(/\\/g, "/") + ":" + (i + 1) +
          ": the literal key '" + k + "' sits beside '..." + scopeName + "', which also defines '" + k +
          "'. The literal wins and the scope is silently dropped. Merge both conditions into one '" +
          k + "' object instead."
        );
      }
    }
  }
  if (collisions) failed++; else passed++;
}

// -151 (QA-349): NO CONTROL CHARACTERS IN SOURCE. This class has now bitten four times in one
// session - a backslash escape written into a file as the raw byte it names. Three were inert
// checks that reported green; the fourth was PRODUCT CODE, a NUL in field-catalog.ts that made a
// '??' guard a no-op AND made the file binary to git grep - so the byte that broke it also hid it.
// Cheap to detect, invisible to review, and it silently disables whatever it lands in.
{
  const ctrl = [];
  const walkAll = (d) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (!/node_modules|[.]next|[.]git/.test(f)) walkAll(f); }
      else if (/[.](ts|tsx|mjs|js)$/.test(e.name)) {
        const buf = fs.readFileSync(f);
        for (let k = 0; k < buf.length; k++) {
          const c = buf[k];
          if (c <= 8 || c === 11 || c === 12) {
            const line = buf.slice(0, k).toString("utf8").split(/\r?\n/).length;
            ctrl.push(f.replace(/\\/g, "/") + ":" + line + ": a control character (byte 0x" +
              c.toString(16).padStart(2, "0") + ") is in the SOURCE. It is almost certainly an escape " +
              "written as the raw byte it names; it disables whatever expression it sits in, and it " +
              "makes this file binary to grep.");
            break;
          }
        }
      }
    }
  };
  walkAll(root);
  walkAll("scripts");
  if (ctrl.length) { failed++; for (const c of ctrl) pushStructural(c); } else passed++;
}

// -152 (QA-367): THE GATE HAS ONE PATTERN AND TWO READERS. qa/hooks/mc-sessionstart.ps1 and
// qa/tools/unmanifested-releases.mjs each used to carry their own copy; QA-342 tightened one, and
// the tool then reported 9 documented gaps where the hook reported 10 - with the string silencing
// -133 in the tool being a sentence in a manifest DOCUMENTING the QA-327 fix. Both read
// qa/tools/gate-patterns.json now, and neither may re-inline a release pattern. Same lesson as
// ARCHITECTURE.md section 3, applied to the machinery instead of the app.
{
  const gateFiles = [
    path.join(root, "..", "..", "qa", "hooks", "mc-sessionstart.ps1"),
    path.join(root, "..", "..", "qa", "tools", "unmanifested-releases.mjs"),
  ];
  const shared = path.join(root, "..", "..", "qa", "tools", "gate-patterns.json");
  if (!fs.existsSync(shared)) {
    // the root repo is not always present beside a checkout; only enforce when it is
    if (gateFiles.some((f) => fs.existsSync(f))) { failed++; pushStructural("qa/tools/gate-patterns.json is missing while the gate readers exist - they will drift again."); }
    else passed++;
  } else {
    const inlined = [];
    for (const f of gateFiles) {
      if (!fs.existsSync(f)) continue;
      const src = fs.readFileSync(f, "utf-8");
      if (!/gate-patterns\.json/.test(src)) { inlined.push(path.basename(f) + " does not read gate-patterns.json at all"); continue; }
      // a release-shaped literal anywhere OTHER than the fallback line is a second copy
      for (const [n, line] of src.split(/\r?\n/).entries()) {
        if (/\\d\{4\}\\\.\\d\{2\}/.test(line) && !/else \{/.test(line) && !/^\s*(#|\/\/)/.test(line)) {
          inlined.push(path.basename(f) + ":" + (n + 1) + " re-inlines a release pattern instead of reading the shared one");
        }
      }
    }
    if (inlined.length) { failed++; for (const x of inlined) pushStructural(x); } else passed++;
  }
}

// -153 cycle 3. Two facts that live in JSX and therefore cannot be reached by an HTTP suite, both
// raised by the checker against cycle 2. Source-level because that is where they are true, and
// each was proved failing by breaking the line it watches and watching this file go red.
{
  // QA-421: the student's progress bar was still filled from the our-logs ESTIMATE while every
  // sentence around it had been suppressed for waiting on a match - remaining_hours went null and
  // the bar went on painting 13%. A quantity in a bar is a quantity.
  const bar = fs.readFileSync(path.join(root, "app/p/attendance/[token]/page.tsx"), "utf-8");
  // -156 (QA-437): this asked whether the identifier "awaiting_match" appeared ANYWHERE on the
  // first line matching the width pattern. Two rewrites walked past it while keeping the defect:
  // `width: ${data.awaiting_match ? pct : pct}%` mentions it and paints the estimate anyway, and a
  // SECOND bar added below the first was never looked at, because .find() stops at one. It now
  // checks EVERY width line and requires the gate to yield zero - the property, not the name.
  const widthLines = bar.split(/\r?\n/).filter((l) => /style=\{\{ width:/.test(l));
  const unGated = widthLines.filter((l) => !/awaiting_match\s*\?\s*0\b/.test(l));
  if (widthLines.length > 0 && unGated.length === 0) passed++;
  else {
    failed++;
    pushStructural(widthLines.length === 0
      ? "app/p/attendance/[token]/page.tsx: no progress bar width expression found at all - the QA-421 check has lost its subject and is no longer watching anything"
      : `app/p/attendance/[token]/page.tsx: ${unGated.length} of ${widthLines.length} progress bars do not resolve to 0 while awaiting_match, so a bar paints a figure derived from OUR daily logs while every sentence around it says the portal row is still being matched (QA-421)`);
  }

  // QA-422: QA-413 made the PAYLOAD derive its buckets from ELIGIBILITY_STATES, and the sentence a
  // human reads went on hand-listing six of the seven. The next state added would be counted, would
  // keep the pinned sum invariant true, and would silently not appear in the line - the same
  // guard-made-of-memory one layer up. The line must carry a generic arm for anything unnamed.
  // QA-419: and the sentence it shows must be true for a student whose portal REGISTRATION is
  // still pending. "The government portal has sent your hours" is a confident falsehood told to
  // the reader least able to check it - what is true in every case is that a row under their NAME
  // is waiting to be attached. This lives in the page, so an API assertion could never catch it.
  // -156 (QA-437): banning one exact phrasing is not the same as requiring the true sentence -
  // "the portal has sent your attendance hours" walked straight past /sent your hours/. Both halves
  // are asserted now: the page MUST attribute the record to the NAME (which is all anyone knows
  // while the row is unattached), and must not claim the hours are the reader's under any wording.
  // -156 (QA-439): the shared-name branch on the student's own page. A page that says "your centre
  // is confirming that it is yours" to BOTH students of one name tells one of them something
  // nobody knows yet - and this is the reader least able to check it.
  if (/same_name_members/.test(bar) && /shares your name/i.test(bar)) passed++;
  else {
    failed++;
    pushCopy("app/p/attendance/[token]/page.tsx: the waiting-on-a-match sentence has no shared-name branch, so two students of one name are both told the record is being confirmed as theirs - one of them is being told something nobody knows (QA-439)");
  }
  const saysUnderYourName = /under your name/i.test(bar);
  const claimsTheyAreYours = /sent\s+your\s+(\w+\s+){0,3}hours/i.test(bar);
  if (saysUnderYourName && !claimsTheyAreYours) passed++;
  else {
    failed++;
    pushCopy(claimsTheyAreYours
      ? "app/p/attendance/[token]/page.tsx: tells the student the portal sent THEIR hours, which is not true for a student whose registration is still pending - it is a row under their name (QA-419)"
      : "app/p/attendance/[token]/page.tsx: the waiting-on-a-match sentence no longer says the record is under the student's NAME, which is the only thing that is true of an unattached row (QA-419)");
  }

  const bp = fs.readFileSync(path.join(root, "app/(app)/batches/[id]/page.tsx"), "utf-8");
  // -156 (QA-437): requiring the literal "Object.entries(attMeta.verdict_counts" inside the
  // sentence proved the generic arm was WRITTEN, not that it does anything - ".filter(() => false)"
  // passes it while rendering nothing. What is checkable from source, and what actually matters, is
  // the correspondence: the arm skips exactly the states that have a phrase of their own. A state
  // excluded with no phrase is silently dropped; a state with a phrase and no exclusion is printed
  // twice. Stated plainly, because QA-437 is about pins that overclaim: this does NOT prove the arm
  // renders in a browser - it proves the two lists cannot drift apart, which is the defect QA-422
  // was raised for.
  // -159 (QA-474): the sibling of the window -158 fixed, and the checker measured its headroom at
  // 440 characters - about five lines of comment - over a 33,997-character remainder. -158 diagnosed
  // "a subject that can slide out of its own window" and repaired exactly one of the two instances
  // in this file. Bounded by the paragraph's own close now, like the other one.
  const summary = ((bp.split("Attendance hours (bar ")[1] ?? "").split("</p>")[0]) ?? "";
  const inclLine = summary.split(/\r?\n/).find((l) => /\.includes\(k\)/.test(l)) ?? "";
  const excluded = [...inclLine.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  // a state is "named" when the sentence reads its own count - either the bucket
  // (verdict_counts.no_hours) or a count of its own beside the buckets (attMeta.awaiting_match_rows).
  const named = new Set([
    ...[...summary.matchAll(/verdict_counts\.([a-z_]+)/g)].map((m) => m[1]),
    ...[...summary.matchAll(/attMeta\.([a-z_]+)_rows/g)].map((m) => m[1]),
  ]);
  const droppedSilently = excluded.filter((k) => !named.has(k));
  const printedTwice = [...named].filter((k) => !excluded.includes(k));
  const why = !summary ? "the sentence anchor 'Attendance hours (bar ' is gone, so this check has no subject"
    : !/Object\.entries\(attMeta\.verdict_counts/.test(summary) ? "there is no generic arm over verdict_counts at all"
      : !/n > 0/.test(inclLine) ? "the generic arm no longer filters on the count, so zero-valued states would print"
        : !excluded.length ? "the generic arm excludes nothing, so it either prints every state twice or (with a constant-false filter) nothing at all"
          : droppedSilently.length ? `${JSON.stringify(droppedSilently)} is excluded from the generic arm and has no phrase of its own - it would be counted in the payload and silently missing from the sentence`
            : printedTwice.length ? `${JSON.stringify(printedTwice)} has a phrase of its own AND is not excluded from the generic arm - it would appear twice in one sentence`
              : "";
  if (!why) passed++;
  else {
    failed++;
    pushStructural(`app/(app)/batches/[id]/page.tsx: the attendance summary line and its generic arm have drifted - ${why} (QA-422)`);
  }

  // -157 (QA-462): a guard that changes what a screen will do has to explain itself ON that screen.
  // -156 emitted certification_blocked_no_can and no component read it, so certification silently
  // stopped deriving behind a button that still looked live - and the release note told production
  // users the screen said who was missing one. Three properties, because any one alone can be true
  // while the operator still learns it from a 409: the page must READ the field, the Certification
  // section must RENDER it, and the button must be gated on it.
  {
    // -158: bounded by the section END, not by a character count. The 4,000-char window was
    // already too small the moment a comment was added inside the section - the sentence this
    // check looks for sat at offset 4,183 - and a check whose subject can quietly slide out of its
    // own window is the same failure as a check that cannot see a deletion.
    // -159 (QA-473): read the source with COMMENTS STRIPPED. The checker showed that deleting the
    // rendered span and leaving a comment that quotes both phrases returned this file to 207/0 -
    // strictly harder to trip than the defect it replaced, and still the same class the block
    // exists to end. stripComments() was already in this file and this block was not using it.
    const bpCode = stripComments(bp);
    const cert = ((bpCode.split("<Section title={`Certification")[1] ?? "").split("</Section>")[0]) ?? "";
    const markLine = cert.split(/\r?\n/).find((l) => /Mark Completed<\/Btn>/.test(l)) ?? "";
    const faults = [];
    if (!/certification_blocked_no_can/.test(bpCode)) faults.push("the page never reads certification_blocked_no_can, so the closure route is talking to nobody");
    if (!cert) faults.push("the Certification section could not be located - this check has lost its subject rather than passed");
    // -158 (QA-470): this used to look for `noCan.length > 0` anywhere in the Certification slice -
    // and the BUTTON's disabled= expression carries that same token, so deleting the whole rendered
    // span (sentence, tooltip and link) left the check green. Proved by a mutation matrix, not by
    // reading. It now looks for the SENTENCE a person sees, and for the tooltip being built from
    // the rows rather than from a fixed string, which is what the button line cannot satisfy.
    else if (!/no portal Candidate ID/.test(cert)) faults.push("the Certification section renders no sentence about students with no portal Candidate ID - the payload arrives and the screen says nothing");
    // -159 (QA-472): the shape moved from a hand-written join to the ONE shared labeller, because
    // this page had FOUR tooltips naming people and -158 fixed one. What is pinned is unchanged in
    // substance: the tooltip is built from the rows, not from a fixed string.
    else if (!/title=\{personList\(noCan\)\}/.test(cert)) faults.push("the Certification line's tooltip is not built from the rows, so it cannot tell two students of one name apart (QA-471's shape)");
    if (!markLine || !/noCan\.length > 0/.test(markLine)) faults.push("the Mark Completed button is not gated on the missing portal IDs, so it invites a press the server refuses with a 409");
    if (!faults.length) passed++;
    else { failed++; for (const f of faults) pushStructural("app/(app)/batches/[id]/page.tsx: " + f + " (QA-462)"); }
  }

  // -162 (QA-394, Manish sir 20/08): "save, mark completed, ye buttons kaam hi nahi kar raha hai...
  // inke upar hover karne pe kuch information aa rahi hai ki dikkat kya hai?" On a FINISHED batch
  // both Mark Completed buttons were dead AND silent, because the status that DISABLED them was the
  // same status every explanation beside them was gated AGAINST. QA-245 fixed the
  // blocked-while-Active case and is untouched; nobody had covered the other end.
  //
  // Pinned as the DEFECT rather than the shape of the fix: a section whose button disables on
  // `=== "Completed"` must also RENDER something on `=== "Completed"`. Stated limits, because this
  // file has over-claimed before: it proves an explanation EXISTS, not that its wording is good,
  // and it finds the two sections by their headings.
  {
    const SECTIONS = [["Assessment", "assessment_status"], ["Certification", "certification_status"]];
    const code = stripComments(bp);
    const NLC = String.fromCharCode(10);
    const faults = [];
    for (const [name, field] of SECTIONS) {
      const after = code.split("title={`" + name)[1];
      const sec = after ? after.split("</Section>")[0] : "";
      if (!sec) { faults.push(name + ": section not found - this check has lost its subject rather than passed"); continue; }
      const lines = sec.split(NLC);
      const markLine = lines.find((l) => l.includes("Mark Completed</Btn>")) ?? "";
      const disablesOnDone = markLine.includes('closure?.' + field + ' === "Completed"');
      const explainsDone = sec.includes('closure?.' + field + ' === "Completed" &&');
      const saveIdx = sec.indexOf(">Save</Btn>");
      const saveGated = saveIdx < 0 || sec.slice(0, saveIdx).includes("disabled={closed}");
      if (!markLine) faults.push(name + ": no Mark Completed button found");
      else if (!disablesOnDone) faults.push(name + ": the button no longer disables on its own completed status");
      if (!explainsDone) faults.push(name + ": the button disables when the batch is finished and NOTHING on screen says so - the condition that kills it also hides its reason");
      if (!saveGated) faults.push(name + ": Save is live on a frozen batch, so it posts a value the server refuses and the 409 lands in the banner at the top of the page");
    }
    if (!faults.length) passed++;
    else { failed++; for (const f of faults) pushCopy("app/(app)/batches/[id]/page.tsx: " + f + " (QA-394)"); }
  }

  // -162 (QA-396, Manish sir 20/08): "9 already have one - 9 without a certificate number : iska
  // kya matlab hai bhai". certNoNumber is certDone.filter(...) - a SUBSET of the same nine - and it
  // was printed as its own bullet beside them, so one group of nine read as eighteen people.
  //
  // The defect shape, which is what gets pinned: a subset must not be rendered as a peer bullet of
  // the group it belongs to. Limit, stated: this knows the two identifiers by name.
  {
    const code = stripComments(bp);
    const faults = [];
    const bulletOwn = code.includes("{certNoNumber.length > 0 && <> " + String.fromCharCode(183));
    const relative = code.includes("certNoNumber.length === certDone.length");
    if (bulletOwn) faults.push("the certificate-number figure is its own bullet beside the group it is a subset of, so one group of nine reads as eighteen people");
    if (!relative) faults.push("the certificate-number figure is not stated relative to the group it belongs to");
    if (!faults.length) passed++;
    else { failed++; for (const f of faults) pushCopy("app/(app)/batches/[id]/page.tsx: " + f + " (QA-396)"); }
  }

  // -156 (QA-434): QA-410 taught the VERDICT to say only what the row holds - "the export carries a
  // row under this name but its hours column could not be read" - and two sibling tooltips in this
  // same page went on asserting hours unconditionally, and asserting they were THIS student's while
  // two people shared the name. A tooltip is a sentence; it is held to the sentence's standard.
  // -161 (QA-483 / QA-484): the guard now scans every file this checker already walks, because
  // the previous one read THREE HARD-CODED FILES and I called its only limit "it knows the
  // payloads by name". Three more limits existed: file scope, a 200-character window, and
  // token-only matching - and a private module-scope helper walked past it, which is the exact
  // shape the comment beside it claimed was closed.
  //
  // WHAT IT CHECKS, precisely, so nobody has to infer it:
  //   A. no file outside lib/person.ts writes the "name (separator)" rule by hand;
  //   B. no known person payload reaches a bare .name / ["name"] / destructured name.
  //
  // WHAT IT DOES NOT CATCH, measured rather than guessed - the checker defeated each of these and
  // they are listed so the next reader does not have to rediscover them:
  //   - a person list arriving under an identifier not in PERSON_PAYLOADS;
  //   - a name reached more than WINDOW characters from its payload;
  //   - a surface that renders a name with NO join and no .name token at all, which is how
  //     `sub={r.sidh_candidate_id ?? undefined}` (QA-430) hid from three consecutive censuses;
  //   - string concatenation instead of a template literal in check A.
  // It is a net, not a proof. Saying so is the point: this pin has now over-claimed three times.
  {
    const HAND_WRITTEN = /`\$\{[a-z]\w*(?:\.\w+)*\.name\}[^`]{0,12}\(\$\{[a-z]\w*(?:\.\w+)*\.(?:phone|sidh_candidate_id)/;
    // The rendering shape of "a list of people, by name": map over rows, reach a name, join into
    // one string. Narrowed from a proximity window that reported 24 sites of which most were not
    // person lists at all - including one already using the helper. A pin its author has to argue
    // with gets narrowed until it is green, which is how the last three versions of this were born.
    const NAME_JOIN = /\.map\(\s*\(?[^)]{0,60}\)?\s*=>[^)]{0,120}?(?:\.name\b|\["name"\])[^;]{0,160}?\.join\(/;
    const PERSON_SCREENS = new Set([
      "app/(app)/batches/[id]/page.tsx",
      "app/(app)/candidates/page.tsx",
      "app/(app)/trainers/page.tsx",
    ]);
    const copies = [];
    const lists = [];
    for (const abs of walk(root)) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (rel === "lib/person.ts" || SKIP_FILES.has(rel)) continue;
      const code = stripComments(fs.readFileSync(abs, "utf-8"));
      // CHECK A is whole-app on purpose: "someone wrote the rule by hand" is a syntactic
      // question and this answers it precisely. It just caught a seventh copy I had missed.
      if (HAND_WRITTEN.test(code)) copies.push(rel);
      // CHECK B IS SCOPED, and the scope is a confession. Asking "is this list PEOPLE?" is a
      // semantic question and a regex cannot answer it: run app-wide, this shape reported 11
      // sites of which four were centres, a generic array renderer, and certificate filenames
      // that the file column already separates. A check that fails on things that are not
      // defects gets narrowed by the next person until it is green - which is exactly how the
      // three previous versions of this check came to exist. So it guards the screens this unit
      // owns and measured, and what it found beyond them is a LEDGER ROW (QA-487), not a
      // silently dropped result.
      if (!PERSON_SCREENS.has(rel)) continue;
      for (const line of code.split(/\r?\n/).entries()) {
        const [n, text] = line;
        // A list that already renders a SEPARATOR alongside the name satisfies REQ-389 by its own
        // means and is not a defect: the certificate-filename list pairs each name with its
        // CAN-derived file, and that column is what tells two same-named students apart. This is a
        // principled exemption rather than a spoofable one - it asks whether the reader was given
        // something to tell two people apart, which is the requirement itself.
        const carriesSeparator = /\b(phone|sidh_candidate_id|file)\b/.test(text);
        if (NAME_JOIN.test(text) && !carriesSeparator && !/person(Label|List|Separator)/.test(text)) lists.push(rel + ":~" + (n + 1));
      }
    }
    if (!copies.length) passed++;
    else { failed++; pushStructural(`${copies.length} file(s) write the "name (separator)" rule by hand instead of reading lib/person.ts - one rule, ${copies.length + 1} copies, which is what ARCHITECTURE section 3 exists to prevent (QA-484): ${copies.slice(0, 8).join(", ")}`); }
    if (!lists.length) passed++;
    else { failed++; pushCopy(`${lists.length} person list(s) reach a bare name, so two people of one name read identically - render them through personLabel/personList from @/lib/person (QA-476/QA-482): ${lists.slice(0, 8).join(" | ")}`); }
  }
  const tips = bp.split(/\r?\n/).filter((l) => /title=/.test(l) && /awaiting_match/.test(l));
  const tipFaults = [];
  if (tips.length < 3) tipFaults.push(`app/(app)/batches/[id]/page.tsx: only ${tips.length} of the three awaiting-match tooltips (Candidates chip, Attendance chip, Closure summary) can be found - this check has lost a subject rather than passed (QA-434)`);
  for (const l of tips) {
    if (/carries hours/i.test(l)) tipFaults.push("app/(app)/batches/[id]/page.tsx: a tooltip still states the export CARRIES HOURS under this name, which is false for a row whose hours column could not be read (QA-434)");
    if (/this student/i.test(l)) tipFaults.push("app/(app)/batches/[id]/page.tsx: a tooltip still says the row is not attached to THIS STUDENT yet, which asserts the row is theirs - the thing nobody knows while two people share the name (QA-434)");
    // A ROW-level tooltip (one that reads this row's own awaiting_match) has to be built FROM the
    // row. The Closure summary tooltip is deliberately not held to this - it describes a group and
    // reads attMeta.awaiting_match_rows, which this test does not match.
    const titleExpr = l.slice(l.indexOf("title="));
    if (/[hr]\.awaiting_match\b/.test(l) && (/^title="/.test(titleExpr) || !/(awaiting_match|verdict)/.test(titleExpr)))
      tipFaults.push("app/(app)/batches/[id]/page.tsx: a row-level tooltip is a fixed string beside a row that carries the facts (count, hours_minutes) - it can only be right by luck (QA-434)");
  }
  if (!tipFaults.length) passed++;
  else { failed++; for (const t of [...new Set(tipFaults)]) pushCopy(t); }
}

// -175: this loop used to sit HERE, and every check below it pushed findings that were counted
// and never printed. The wall then reported "check-user-copy: 217 passed, 1 failed" with no line
// saying what failed, and the summary underneath said the finding was "above" when nothing was.
// It cost real minutes to bisect, and a checker reading only the suite output could not have done
// it at all. The printing belongs after the LAST check, which is where it is now.
// ---- -182 (QA-574): the release step with no gate is the one that keeps getting skipped ----
// Fourth generation. QA-364, then QA-383, then QA-547 — which was closed by BACKFILLING two rows
// while correctly writing down that the step has no gate — and then five more releases shipped
// without a CHANGELOG row in the four hours after that. Diagnosing a hole is not plugging it.
//
// So the gate: whatever RELEASE version.ts declares must have a row in qa/CHANGELOG.jsonl.
//
// Honest limit, stated rather than discovered later: qa/ lives in the ROOT repo (d:/erp), not in
// this app repo, so CI has no copy of it. When the file is unreachable this check SKIPS rather
// than failing — a gate that fails in CI for being in the wrong repo gets disabled within a day,
// and a skip that is announced is more durable than a failure that gets muted. Locally it fires on
// every wall run, and a wall run is what every release passes through.
{
  const relLine = fs.readFileSync(path.join(root, "lib/version.ts"), "utf-8").match(/export const RELEASE = "([^"]+)"/);
  const rel = relLine ? relLine[1] : "";
  const chPath = path.resolve(root, "..", "..", "qa", "CHANGELOG.jsonl");
  if (!rel || !fs.existsSync(chPath)) {
    passed++;
    if (rel) console.log("  ·   CHANGELOG gate skipped — qa/CHANGELOG.jsonl is in the root repo and is not present here");
  } else {
    const ch = fs.readFileSync(chPath, "utf-8");
    // QA-1012 (2026-08-24): this was a raw substring match on `"release":"<rel>"` — with NO space
    // after the colon. A row written by `JSON.stringify(obj, null, 1)`, or by any hand that typed a
    // space, is valid JSON carrying the right data and the gate still reported the release as
    // undeclared. That happened for real: the -240 row existed, the ledger parsed clean at 425 rows,
    // and this pin held the whole tree's wall red while the thing it demanded was already on disk.
    // A gate that can be defeated by one space is not checking the data, it is checking the
    // formatting — and it fails in the direction that costs most, blocking a correct release.
    // PARSE, then compare. Unparseable lines are counted and named rather than silently skipped:
    // "I could not read the file" and "the row is not there" are different answers.
    const chLines = ch.trim().split(String.fromCharCode(10)).map((x) => x.trim()).filter(Boolean);
    let chBad = 0, chHas = false;
    for (const line of chLines) {
      try { if (JSON.parse(line).release === rel) chHas = true; } catch { chBad++; }
    }
    if (chBad) console.log(`  ·   CHANGELOG: ${chBad} unparseable line(s) — the release check read the rest`);
    if (chHas) passed++;
    else { failed++; pushStructural(`qa/CHANGELOG.jsonl: no row for ${rel} — QA-574. This is the one release step with nothing in front of it, which is why it has now been missed in four separate generations of this defect. Add the row before pushing.`); }
  }
}

// ---- -172 (QA-524): the report's total row has to be ON THE PAGE ----
// A checker measured the live report: tfoot 0 rows, and the only "Grand Total" in the table was a
// column-group header - while GET /api/reports/rollup had been returning the totals all along. The
// figure was computed, returned, and never shown. His own pivot HAS that row (row 15: 1080, 900,
// 1120, 3215, 6315) and 6,315 is the number he speaks in: "main 6,315 pe hi kaam kar sakta hoon".
// Without it a reader adds twenty rows by eye, which is the habit this report exists to end.
//
// A STRUCTURE check, not an API one: no request can tell you whether a number reached the screen.
// QA-640 (-192) — Umesh, 2026-08-22, with the client's "Back-dated Planning" tab open beside the
// Planning table: "yeh saare column hone chahiye". All eighteen were already there; his NAMES were
// not. The screen said `Submitted` / `Approved` / `Fee paid`, and `Starts` and `Ends` each appeared
// TWICE - once for TOT and once for the batch - so two different dates answered to one word and a
// reader holding the sheet could not find their own columns.
//
// Three things are pinned, because all three could come back quietly:
//   (a) every one of his eighteen headings is carried VERBATIM, so the disclosure card can prove
//       which column is which. Typos included - his sheet says "verificaiton" and "experiene", and
//       tidying them is the edit that puts the doubt back;
//   (b) no two columns share a label - that is the condition that made `Starts` ambiguous, and it
//       is also what let one Columns-picker entry weld two dates together (QA-580);
//   (c) the SCREEN label and the EXPORT heading are the same words for every column. They were not:
//       the download said "TOT starts" where the screen said "Starts". One column with two names
//       depending on the surface is exactly QA-565, which was closed on the report and was still
//       alive here.
{
  const planSrc = stripComments(fs.readFileSync(path.join(root, "app/(app)/batches/page.tsx"), "utf8"));
  const planExportSrc = stripComments(fs.readFileSync(path.join(root, "app/api/plan-tracker/export/route.ts"), "utf8"));

  const SHEET_HEADINGS = [
    "SL#", "Location", "Job Role", "Trainer Name",
    "Trainer Profile/documents etc verificaiton and Generate TR ID and experiene letter (Industry + Teaching) on SIDH portal.",
    "Trainer Eligibility Check? Yes/No",
    "Trainer Available & Ready for TOT?",
    "Trainer profile submitted Date to SSC/NSDC?",
    "Is SSC/NSDC approved the trainer profile for TOT?",
    "Approved candidate TOT fee paid to SSC/NSDC?",
    "Start date for TOT?", "End date for TOT?",
    "Expected date of TOT result and certificate?",
    "Date for Trainer Mapping on SIDH Portal?",
    "Is Mobilization done for this batch?",
    "Dates for candidates registration & enrollment done on SIDH portal?",
    "Expected Batch Start date", "Expected Batch End Date",
  ];
  const missingHeadings = SHEET_HEADINGS.filter((h) => !planSrc.includes(h));
  if (!missingHeadings.length) passed++;
  else { failed++; pushStructural("app/(app)/batches: the planning table no longer carries " + missingHeadings.length + " of the client's own column headings verbatim, so the card cannot prove which column is which: " + JSON.stringify(missingHeadings.slice(0, 3)) + " - QA-640. His sheet's typos are part of the quote."); }

  // The labels of the plan-tracker column list. Scoped to the block between `const columns` and its
  // close, so the tab's OTHER tables cannot lend it a label or steal one.
  const planCols = planSrc.slice(planSrc.indexOf("const columns: any[] = ["));
  const planColBlock = planCols.slice(0, planCols.indexOf(String.fromCharCode(10) + "  ];"));
  const planLabels = [...planColBlock.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
  const dupLabels = planLabels.filter((l, i) => planLabels.indexOf(l) !== i);
  if (planLabels.length >= 18 && !dupLabels.length) passed++;
  else { failed++; pushStructural("app/(app)/batches: the planning table has " + planLabels.length + " columns and these labels repeat: " + JSON.stringify([...new Set(dupLabels)]) + " - QA-640. Two different dates answering to one word is what sent Umesh back to his spreadsheet; `Starts` used to mean the TOT's and the batch's."); }

  // One column, one name, on both surfaces.
  const exportOnly = planLabels.filter((l) => l !== "Batch" && l !== "SL#" && !planExportSrc.includes(`"${l}"`));
  if (!exportOnly.length) passed++;
  else { failed++; pushStructural("app/api/plan-tracker/export: " + exportOnly.length + " screen column(s) are named differently in the download: " + JSON.stringify(exportOnly.slice(0, 4)) + " - QA-640 / QA-565. Downloading the table should not rename its columns."); }

  // The card itself, closed by default - it is reference, consulted once, not a warning.
  const planCard = /<details[^>]*>[\s\S]{0,400}?Which column of the planning sheet is which/.test(planSrc)
    && /PLAN_COLUMN_SOURCE\[c\.key\]/.test(planSrc)
    && !/<details open[\s\S]{0,400}?Which column of the planning sheet/.test(planSrc);
  if (planCard) passed++;
  else { failed++; pushStructural("app/(app)/batches: the planning table has no collapsed card mapping each column to the client's sheet heading - QA-640. Without it the verbatim headings are stored and never shown, which is the same as not having them."); }

  // ---- QA-672 (-203): the four pins above verify SOURCE TEXT, and the card is a KEY JOIN ----
  // The checker on qa-192 cycle 1 broke this screen three ways and left all four green. The worst:
  // prefix the `columns[]` keys in a refactor and leave PLAN_COLUMN_SOURCE behind, and the card
  // renders ZERO rows while every pin above still passes - the card pin's own failure message
  // ("the verbatim headings are stored and never shown") coming true while it reports success.
  //
  // The card is `columns.filter(c => PLAN_COLUMN_SOURCE[c.key])`. Nothing above ever evaluates that
  // join. This does: every heading Umesh gave must be reachable from a column that actually exists.
  const srcTail = planSrc.slice(planSrc.indexOf("const PLAN_COLUMN_SOURCE"));
  const srcBlock = srcTail.slice(0, srcTail.indexOf(String.fromCharCode(10) + "};"));
  const sourceKeys = [...srcBlock.matchAll(/^\s{2}([A-Za-z_][A-Za-z_0-9]*):\s*"/gm)].map((m) => m[1]);
  const colKeys = [...planColBlock.matchAll(/key: "([^"]+)"/g)].map((m) => m[1]);
  const orphanKeys = sourceKeys.filter((k) => !colKeys.includes(k));
  const cardRows = sourceKeys.length - orphanKeys.length;
  if (sourceKeys.length === 18 && !orphanKeys.length) passed++;
  else {
    failed++;
    pushStructural("app/(app)/batches: the sheet-heading card would render " + cardRows + " of 18 rows - PLAN_COLUMN_SOURCE has " + sourceKeys.length
      + " headings and " + orphanKeys.length + " of them match no column key: " + JSON.stringify(orphanKeys.slice(0, 4))
      + " - QA-672. The card is a JOIN on c.key; renaming either side silently empties it while every heading is still present in the source.");
  }
}

// QA-622 (-195): the Locations screen must send each contact's `_id` back when it saves the list.
// Mongoose replaces a document array wholesale on assign, so an entry arriving WITHOUT an id is
// given a new one - and this screen stripped ids, so adding one contact silently renewed the
// identity of every contact at that centre. Nothing on this screen showed it. What it broke was the
// plan share, which names its recipient by that id: after any contact edit a person's link stopped
// being theirs, re-sending added a second live link instead of replacing one, and the screen listed
// them as never sent to.
//
// Pinned HERE and not in e2e on purpose, and the reason is worth stating because it caught me: an
// e2e pin drives the API directly, so it supplies `_id` itself and passes whether or not the SCREEN
// does - it cannot fail for the thing that actually broke. I wrote exactly that pin first and the
// pre-fix run showed it green on the broken build. The wall has no browser harness (the same limit
// disclosed on qa-178), so the honest instrument for a screen's request shape is its source.
{
  const locPageSrc = stripComments(fs.readFileSync(path.join(root, "app/(app)/locations/[id]/page.tsx"), "utf8"));
  const saveCall = locPageSrc.match(/api\(`\/api\/locations\/\$\{loc\._id\}`,[\s\S]{0,320}?contacts:[\s\S]{0,240}?\}\)/);
  const sendsId = !!saveCall && /\{\s*_id\s*,/.test(saveCall[0]) && /\(\{\s*_id\s*,/.test(saveCall[0]);
  if (sendsId) passed++;
  else { failed++; pushStructural("app/(app)/locations/[id]/page.tsx: the contacts save does not send each contact's `_id` back (found the call: " + !!saveCall + ") - QA-622. Mongoose mints a fresh id for every entry that arrives without one, so one added contact renews the identity of all of them, and every plan link sent to those people quietly stops being theirs."); }
}

// stripComments runs first, so writing the promise in a comment cannot satisfy it.
{
  const reportSrc = stripComments(fs.readFileSync(path.join(root, "app/(app)/reports/page.tsx"), "utf8"));
  const tableSrc = stripComments(fs.readFileSync(path.join(root, "components/ui.tsx"), "utf8"));
  if (!(/<tfoot/.test(tableSrc) && /c\.total/.test(tableSrc))) {
    failed++; pushStructural("components/ui.tsx: the shared table cannot render a totals row (no tfoot driven by a column total) - QA-524, and his own pivot has that row.");
  }
  const roleN = (reportSrc.match(/total: roleTotal\(/g) || []).length;
  const grandN = (reportSrc.match(/total: grandTotal\(/g) || []).length;
  // -175: this read `grandN !== 5` and went stale the moment the Grand Total group gained the
  // approved/not-approved split (QA-527) - it failed a report that had MORE totals than before,
  // which is the opposite of what it exists to catch. Counting the declared columns instead means
  // the rule is "every Grand Total column carries a total", and it cannot go stale again by
  // someone adding a column.
  const grandCols = (reportSrc.match(/group: "Grand Total"/g) || []).length;
  if (roleN < 5 || grandN < 5 || grandN !== grandCols) {
    failed++; pushStructural("app/(app)/reports/page.tsx: the report does not ask for a totals row per job role AND a total on every Grand Total column (roleTotal x" + roleN + ", grandTotal x" + grandN + ", Grand Total columns " + grandCols + ") - QA-524. The tiles at the top only total across ALL job roles; his row 15 totals each one.");
  }
  if (!/c\.total\(view\)/.test(tableSrc)) {
    failed++; pushStructural("components/ui.tsx: the totals row is computed from something other than the filtered rows - QA-524. A total that ignores the filter describes something the reader is not looking at.");
  }
}

// ---- -176 (QA-542 / QA-543 / QA-544): the report has to be WORKABLE, not just correct ----
// Umesh, reading the -175 report on live: "bas centre pr label show krne se kuch nhi hoga naa…
// ya ek status wala column de de aur uss column mai status daal dena", and "her column ko filters
// … taaki selective row ko bhi filter out kiya jaya saka … first two columns … woh FREEZE rahe."
//
// -175 put the approval verdict in a CHIP to save table width. A chip cannot be filtered, cannot
// be sorted, and does not leave the screen as a value - so the trade bought width with the one
// thing the answer was for. A checker reached the same place from the other side (QA-554): 7 of
// the 20 live centres read "mixed", and those seven carry the largest targets.
//
// Structural, because none of it is visible over HTTP.
{
  const reportSrc = stripComments(fs.readFileSync(path.join(root, "app/(app)/reports/page.tsx"), "utf8"));
  const tableSrc = stripComments(fs.readFileSync(path.join(root, "components/ui.tsx"), "utf8"));
  const tableSrcRules = stripComments(fs.readFileSync(path.join(root, "lib/rules.ts"), "utf8"));
  const exportSrc = stripComments(fs.readFileSync(path.join(root, "app/api/reports/rollup/export/route.ts"), "utf8"));

  // QA-542: a Status COLUMN, and it must be filterable - a status you cannot filter by is a label.
  const hasCol = /key:\s*"verdict"/.test(reportSrc);
  // The column's own declaration line, not the whole file: `[^}]*` would stop at the first `}`
  // inside a render arrow, and matching across the file would let a `filterable: true` on some
  // OTHER column satisfy this.
  const verdictDecl = (reportSrc.match(/key:\s*"verdict"[^\n]*/) ?? [""])[0];
  const colFilterable = /filterable:\s*true/.test(verdictDecl);
  if (hasCol && colFilterable) passed++;
  else { failed++; pushStructural("app/(app)/reports/page.tsx: the approval verdict is not a filterable COLUMN (verdict column " + hasCol + ", filterable " + colFilterable + ") - QA-542. A chip cannot be filtered, sorted, or exported, which is the whole reason the column exists."); }

  // QA-544: the shared table must be able to freeze leading columns, and the report must use it.
  const tableCanFreeze = /freeze\?:\s*number/.test(tableSrc) && /sticky/.test(tableSrc);
  const reportFreezes = /freeze=\{\s*2\s*\}/.test(reportSrc);
  if (tableCanFreeze && reportFreezes) passed++;
  else { failed++; pushStructural("components/ui.tsx / reports: leading columns do not stay put on horizontal scroll (table supports it " + tableCanFreeze + ", report asks for it " + reportFreezes + ") - QA-544. The report is four job roles of five figures plus a seven-column total group; the centre name leaves the screen and every figure after it is unattributed."); }

  // QA-562 (-177): on a GROUPED table an UNGROUPED column must still render its own header - the
  // label, the sort control and the FUNNEL. It did not: the banner row printed `{s.group ?? ""}`,
  // which is blank for an ungrouped column, and the second header row renders only grouped ones.
  // Institution had no header from -170 (a row label is recognisable without one, so nobody saw
  // it), and then -176 put the Status column - the one thing Umesh asked for, "agar main sirf
  // approved ko filter out karna chahun" - into the same hole. MEASURED on live -176:
  // hasStatusHeader false, 20 funnels, none on Status. The column shipped and its control did not.
  const ungroupedHeader = tableSrc.includes("headerCell(s.col)") && tableSrc.includes("funnel(s.col)");
  if (ungroupedHeader) passed++;
  else { failed++; pushStructural("components/ui.tsx: on a grouped table an ungrouped column renders no header, so its label, sort and funnel exist nowhere - QA-556. That is why the report's Status column cannot be filtered even though the column and its data are there."); }

  // QA-563 (-177): and the frozen columns ARE the ungrouped ones, so the freeze has to be applied
  // in that same banner row. -176 applied it only to the second header row, so on live the body
  // cells stayed put while their headers scrolled away with the figures.
  const frozenHeaderRow = tableSrc.includes('frozenCell(s.at, "head")');
  if (frozenHeaderRow) passed++;
  else { failed++; pushStructural("components/ui.tsx: frozen columns keep their body cells in place but not their header cells - QA-557. Scrolling sideways leaves a pinned column under a header that has moved on."); }

  // QA-562 (-177): the two ungrouped columns are the ones a person reads a row BY, so they carry
  // Umesh's own names - "first column ka name hoga batch location aur second column ka heading
  // status rakh, aur inme bhi filters daal" - and both must be filterable. The names are asserted
  // because a rename back to "Institution" would be a silent step away from what he asked for.
  const nameCol = (reportSrc.match(/key:\s*"name"[^\n]*/) ?? [""])[0];
  const namedRight = /label:\s*"Batch Location"/.test(nameCol) && /filterable:\s*true/.test(nameCol);
  if (namedRight) passed++;
  else { failed++; pushStructural("app/(app)/reports/page.tsx: the first column is not a filterable \"Batch Location\" - QA-558. Umesh named these two columns himself and asked for filters on both."); }

  // QA-559: and the verdict WORD is computed once, server-side, so the screen and the Excel export
  // cannot answer "is this centre approved" differently. rules.ts pulls in mongoose, so the page
  // cannot import centreVerdict() - it reads the value off the row instead of deriving its own.
  const verdictShared = tableSrcRules.includes("export function centreVerdict")
    && reportSrc.includes("r?.verdict") && exportSrc.includes("centreVerdict(r.total)");
  if (verdictShared) passed++;
  else { failed++; pushStructural("lib/rules.ts + reports page + rollup export: the centre verdict is not computed in ONE place and read by both surfaces - QA-559. A screen and its download must not be able to disagree about a centre's status."); }

  // QA-555: on a GROUPED table the Columns picker must SECTION by group. Umesh, on the report:
  // "isme bahut saari duplicate entries hai, bas unique ones hi aani chahiye" - twenty-eight rows
  // of which twenty-five read Target / Appr. / Mob. / In trg / Passed, with nothing saying which
  // job role. Two things are asserted, and the second is the one that would rot: the picker reads
  // the group, AND the group carries its own toggle - a section header with no toggle is just a
  // relabelling of the same unusable list.
  // -179 (QA-538): sectioning was NOT what Umesh asked for - "bas unique ones hi aani chaiye" - and
  // a checker measured what -176 actually shipped: 34 entries, 20 exact repeats. The list is now
  // built so each entry appears once: ungrouped columns as themselves, each MEASURE once (toggling
  // every column with that label), each GROUP once. The assertion moved with it.
  // -182: this asserted one exact expression, so writing the same comparison the other way round
  // (`c.label === m.label`) made it FAIL correct code - a pin that accuses the innocent, which is
  // the mirror image of one that lets the guilty through, and this file has now shipped both.
  // Behaviour, not spelling: the merge exists, and it is REPORT-ONLY per REQ-397.
  const pickerUnique = /measures\.find\(/.test(tableSrc) && tableSrc.includes("Visible columns");
  const pickerGroupToggle = tableSrc.includes("cols.forEach((c) => setColVisible");
  // QA-580: REQ-397's scope clause, and its "a check must prove it" half. The unique list must be
  // opt-in and the report must be the ONLY caller - the plan-tracker is the other grouped table and
  // merging on label alone welded its TOT start to its batch start.
  // -183: a checker found three ways past this and all three are closed here.
  //   (a) `&& false` after the guard neutered it silently  -> the guard expression must be the
  //       WHOLE condition, so the `if` line is matched as a unit;
  //   (b) `pickerMode={"unique"}` in braces evaded a grep for the quoted attribute -> match both
  //       spellings;
  //   (c) swapping the merge key from `m.label` to `m.key` rebuilt the 34-entry duplicate list
  //       with the pin still green -> assert the merge is keyed on the LABEL, which is the whole
  //       point of merging.
  const gated = /if \(pickerMode !== "unique"\) \{/.test(tableSrc) && /pickerMode\?: "unique"/.test(tableSrc);
  const mergesOnLabel = /measures\.find\(\(m\) => m\.label === c\.label\)|measures\.find\(\(m\) => c\.label === m\.label\)/.test(tableSrc);
  // A character class, not `\{?`: in a JS string `\{` collapses to a bare `{`, and `{` is an
  // interval operator in ERE - so the pattern silently matched nothing and the pin reported
  // `callers []`, accusing correct code. Escapes have been eaten six times in this file's history;
  // `[{]` needs none.
  const callers = (spawnSync("git", ["grep", "-lE", 'pickerMode=[{]?"unique"', "--", "src"], { cwd: path.join(root, ".."), encoding: "utf8" }).stdout || "")
    .split(String.fromCharCode(10)).filter(Boolean);
  const onlyReport = callers.length === 1 && callers[0].includes("reports/page.tsx");
  if (gated && mergesOnLabel && onlyReport) passed++;
  else { failed++; pushStructural("components/ui.tsx + reports: the unique-entry Columns picker is not gated to the report, or does not merge on the LABEL (opt-in " + gated + ", merges on label " + mergesOnLabel + ", callers " + JSON.stringify(callers) + ") - QA-580 / REQ-397. The other grouped table is the plan-tracker, where TOT -> Starts and Batch -> Starts share a label and merging on label alone hides both at once."); }
  if (pickerUnique && pickerGroupToggle) passed++;
  else { failed++; pushStructural("components/ui.tsx: the Columns picker still repeats a label once per group instead of listing it ONCE (unique " + pickerUnique + ", group toggle " + pickerGroupToggle + ") - QA-538. Umesh asked for unique entries only; -176 grouped them, which made the repeats legible without removing them - 34 entries, 20 exact repeats."); }

  // QA-584 (-183): the header LABEL refuses to wrap. Two releases tried to buy the same outcome
  // with pixels - -179 raised minWidth, -182 pushed the widths into the colgroup so they actually
  // reached the column - and both were measured against a header with no filter funnel on it. The
  // funnel costs 16px and only appears at 2-25 distinct values, so the widths were right for the
  // data that happened to be loaded and wrong for the data that arrives later. Measured on a
  // running -183 with 102 header cells: with this class every label button is 16px tall and none
  // is clipped (scrollWidth == clientWidth); strip the class in the live DOM and nine cells jump
  // to 31px - `In training`, `Not approved`, `No verdict`, exactly the three the checker named.
  //
  // Pinned as position, not membership: the class must sit on the SORT-LABEL button - the one that
  // renders `{c.label}` - not merely somewhere in a file that already uses `whitespace-nowrap` in
  // four other components. A membership test would have stayed green if the class landed on the
  // Button primitive or a nav tab instead.
  // -184 (QA-587): the cycle-3 checker proved this pin did NOT test what the comment above claims.
  // `.includes()` ran against the WHOLE 240-char match - the button's attributes plus any child
  // before `{c.label}` - so two mutations kept it green with the button carrying no nowrap at all:
  // a hidden sibling `<span className="hidden whitespace-nowrap">`, and the class name appearing
  // only inside `title="Sort by this column (whitespace-nowrap)"`. Both leave the heading free to
  // wrap. Capture the className and test THAT, as a token rather than a substring, so neither a
  // neighbouring element nor prose in an attribute can stand in for the class.
  //
  // -184 cycle 2 (QA-594 + the rest of QA-587): the -184 attempt was still wrong in BOTH directions,
  // and the checker found each by pointing this pin's own thesis back at it.
  //   (a) `String.match` without /g returns the FIRST match. A decoy `<button className="...">`
  //       earlier in the file shadows the real one, and the pin goes green while the sort label
  //       carries nothing. This is the SAME "an earlier element captures the regex" family that
  //       has now burned this file three times (QA-567's card, QA-567's caveat, and now this).
  //   (b) The capture was anchored on the literal prefix `flex items-center gap-1`, so simply
  //       REORDERING the class list - or writing className as a template expression - made the pin
  //       FAIL CORRECT CODE. QA-587's own filing row said to drop the anchor and I did not.
  //
  // Anchor from the LABEL BACKWARDS instead. `{c.label}` is the thing whose wrapping is at stake,
  // so find every place it is rendered and walk back to the button that encloses it. A decoy
  // elsewhere is then irrelevant - it renders no label - and the class list may be in any order,
  // because the whole className is read rather than matched from its first token.
  //
  // -185 cycle 3 (QA-596 + QA-597): cycle 2 revived BOTH diseases in the lines written to cure them.
  //   (a) QA-596 - `indexOf(">", open)` ends the tag at the first ">" CHARACTER, and in JSX that is
  //       usually the arrow of `onClick={() =>`. It only worked because className happens to be
  //       written before onClick today; move one attribute and the pin reports `class lists seen:
  //       [null]`, sending a reader to fix a class that was never wrong. A tag ends at the ">" that
  //       is at brace-depth 0 and outside quotes - so scan for it, do not guess.
  //   (b) QA-597 - gating on `setSort` made the pin's sight depend on where the handler is written.
  //       Extract the onClick to a named handler and the REAL site disappears from the list; any
  //       other setSort button then satisfies `every` alone, and the pin is green with the heading
  //       unprotected. Both earlier revisions caught that shape; cycle 2 stopped catching it.
  //
  // The structural fact is ENCLOSURE: a label can only wrap inside the box that contains it. So a
  // site is a `{c.label}` whose nearest preceding `<button>` has not already closed before it.
  // Measured on this file: of the three `{c.label}` renders, only the header's is enclosed - the
  // Columns picker entry and the card label sit after their nearest button has closed.
  //
  // `setSort` is now used for NOTHING but the failure message. A tiebreak was tried first - check
  // only the enclosing sites that call setSort - and this proof caught it reopening the very hole
  // it was meant to close: extract the handler and add a decoy that both setSorts and renders a
  // label, and the decoy became the only "sort site", satisfying the check while the real heading
  // carried nothing. Any button enclosing a rendered label is a box that label can wrap inside, so
  // EVERY one of them must refuse to wrap. On this file that is exactly one site today. If a future
  // design deliberately wants a wrapping label inside some other button, that is a deliberate change
  // and it should arrive with a deliberate change to this pin - not be pre-forgiven by a tiebreak
  // that also forgives the defect.
  const tagEndAt = (from) => {                    // the ">" that really ends this opening tag
    let depth = 0, quote = null;
    for (let i = from; i < tableSrc.length; i++) {
      const ch = tableSrc[i];
      if (quote) { if (ch === quote && tableSrc[i - 1] !== "\\") quote = null; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) return i;
    }
    return -1;
  };
  const enclosingSites = [...tableSrc.matchAll(/\{c\.label\}/g)].map((m) => {
    const open = tableSrc.lastIndexOf("<button", m.index);
    if (open < 0) return null;
    const close = tableSrc.indexOf("</button>", open);
    if (close < 0 || close < m.index) return null;   // that button closed before the label: not its box
    const end = tagEndAt(open);
    if (end < 0) return null;
    const tag = tableSrc.slice(open, end + 1);
    // Both spellings: className="..." and className={`...`} / {clsx(...)}. Reading the braced form
    // too is what stops a future refactor to a template literal from being called a defect.
    const q = tag.match(/className="([^"]*)"/);
    const b = q ? null : tag.match(/className=\{([\s\S]*)\}?\s*$/);
    return { at: m.index, cls: q ? q[1] : (b ? b[1] : null), sorts: tableSrc.slice(open, close).includes("setSort") };
  }).filter(Boolean);
  const sortSites = enclosingSites.filter((s) => s.sorts);   // reported, never used to narrow
  const labelClasses = enclosingSites.map((s) => s.cls);
  const labelNoWrap = enclosingSites.length > 0 && labelClasses.every(
    (cls) => cls !== null && cls.split(/[\s`'"+${}]+/).includes("whitespace-nowrap"));
  if (labelNoWrap) passed++;
  else { failed++; pushStructural("components/ui.tsx: a header label can still wrap - " + enclosingSites.length + " button(s) enclose a rendered {c.label}, " + sortSites.length + " of them call setSort, and not all of them carry whitespace-nowrap (class lists seen: " + JSON.stringify(labelClasses) + ") - QA-584 / QA-594 / QA-597. A null class list means the opening tag could not be read, not that the class is missing. Widths cannot hold this: the filter funnel adds 16px only once a column has 2-25 distinct values, so a width that fits today breaks when the data grows. Umesh has now reported this heading wrapping twice."); }

  // QA-564 (-178): the column definitions fold into a disclosure card - Umesh, "ye definations wala
  // dropdown type card hoga" - but the WARNINGS stay outside it. REQ-367 puts these sources "on the
  // screen, not in a footnote", and a warning behind a click is a warning the reader has to already
  // know about. So two things are asserted, and the second is the one that would quietly rot: the
  // card exists, AND the caveat is not inside it.
  // QA-567 (-180): the checker took this pin apart and it was right on all three counts. The old
  // "caveat is outside" assertion (a) PASSED with the caveat moved INSIDE spelled `{s?.caveat}` -
  // because the string "s?.caveat" does not contain "s.caveat", and `s?.caveat` is this file's own
  // idiom one line above; (b) passed on `<details open>`, so the hidden-BY-DEFAULT behaviour Umesh
  // actually asked for was held by nothing at all; (c) went vacuous the moment any earlier
  // <details> appeared, because the regex matched that one instead.
  //
  // Rebuilt to test position rather than membership: find the card by its own summary, require it
  // to carry no `open`, and require the caveat to appear AFTER the card closes. Honest limit,
  // stated rather than hidden: this is still a SOURCE scan. The checker's preferred fix is a DOM
  // suite that opens and closes the card and looks - the wall has no browser harness today, so
  // that is a gap this pin narrows and does not close.
  const cardStart = reportSrc.indexOf("Where these numbers come from");
  const openTag = cardStart < 0 ? "" : reportSrc.slice(reportSrc.lastIndexOf("<details", cardStart), cardStart);
  const cardEnd = cardStart < 0 ? -1 : reportSrc.indexOf("</details>", cardStart);
  // -184 (QA-567, the remainder): this used to accept the GUARD (`s?.caveat &&`) as an anchor, and
  // the guard is not the caveat - it sits one line above the thing that actually renders. `search`
  // returns the FIRST match, so the anchor landed on the guard every time, and the depth count
  // below then measured the nesting at the guard rather than at the text. Split them and the pin
  // goes green on a caveat that is plainly hidden:
  //     {s?.caveat && (              <- depth 0 here, so the pin was satisfied
  //       <details><p>{s.caveat}</p></details>   <- and the warning is behind a click anyway
  //     )}
  // Anchor on what is RENDERED. Both spellings of the rendered expression are accepted, because
  // this pin has already once failed correct code over a spelling (`m.label === c.label`); the dot
  // is now required, so `{scaveat}` no longer counts as a caveat.
  const caveatAt = reportSrc.search(/\{s\??\.caveat\}/);
  const hasCard = cardStart >= 0 && openTag.startsWith("<details");
  // Written carefully: the first attempt put a real 0x08 byte here - a regex word-boundary
  // that collapsed into a backspace on the way through a shell heredoc - and THIS FILE's own
  // control-character scan caught it one run later. That check exists for exactly this, and a
  // pin catching the maker's hand is the pin earning its keep.
  const closedByDefault = hasCard && !/ open|\sopen=/.test(openTag);
  // -181 (QA-567, cycle 3): `caveatAt > cardEnd` asks "after THIS card". REQ-367b asks "outside
  // ANY disclosure card" - and a checker proved the gap by wrapping the caveat in its OWN <details>
  // placed after the definitions card: the pin passed while the rule was broken. That is QA-567's
  // own definition of the defect, landed on the very unit that taught this page to fold things
  // into cards, which is exactly where it would have drifted.
  //
  // Balance is the answer and it needs no browser: count the tags before the caveat. Nesting depth
  // zero means every <details> opened before it has also closed, so the caveat sits outside all of
  // them - not merely after one.
  const before = reportSrc.slice(0, caveatAt < 0 ? 0 : caveatAt);
  const depth = (before.match(/<details\b/g) ?? []).length - (before.match(/<\/details>/g) ?? []).length;
  const caveatOutside = hasCard && caveatAt > cardEnd && cardEnd > 0 && depth === 0;
  if (hasCard && closedByDefault && caveatOutside) passed++;
  else { failed++; pushStructural("app/(app)/reports/page.tsx: the definitions card is not collapsed-by-default with the caveat left OUTSIDE it (card " + hasCard + ", closed by default " + closedByDefault + ", caveat after the card " + caveatOutside + ") - QA-564 / QA-567. Folding the warning behind a click hides the one line that changes how the figures beside it should be read."); }

  // QA-566 (-180): every KPI tile names its SOURCE. REQ-367 asks each figure to say which of the
  // sources it came from - and before this, four tiles said "Client sheet" while our three said
  // "3% of approved", which is a denominator. So folding the definitions in -178 took provenance
  // away from OUR columns only and left the client's intact. Measured by a checker on live: with
  // the card closed, "Client sheet" rendered and "Our records" rendered nowhere.
  const ourTiles = (reportSrc.match(/Our records ·/g) ?? []).length;
  if (ourTiles >= 3) passed++;
  else { failed++; pushStructural("app/(app)/reports/page.tsx: the Mobilised / In training / Passed tiles do not name their source (found " + ourTiles + " of 3) - QA-566. A percentage is a denominator, not a provenance, so with the definitions card closed those three figures say where they came from nowhere on the screen."); }

  // QA-565 (-179): the screen must call a column what the DOWNLOAD calls it. The report read
  // APPR. / MOB. / IN TRG while rollup/export writes Approved / Mobilised / In training, so one
  // column had two names and downloading silently renamed every one of them. Umesh: "column name
  // kya complete rakhna chaiye, abhi ye 2-3-4 letters hai" - and his own argument settles the width
  // objection, because the table already offers resize, hide and horizontal scroll.
  // -182: a checker broke this pin in the obvious direction - it asserted the ABSENCE of four exact
  // strings, so restoring the abbreviations as `Mob` / `In trg.` / `Not appr` (no trailing dot) left
  // it green. Asserting the PRESENCE of the full names cannot be dodged by respelling the short
  // ones, because there is nothing to respell: the words either appear or they do not.
  const wantLabels = ["Target", "Approved", "Mobilised", "In training", "Passed", "Not approved", "No verdict"];
  // -183: presence-once left 20 of 27 columns unprotected - abbreviating the PER-ROLE `In training`
  // while the Grand Total group kept the full name passed. The five per-role measures appear once
  // per job role plus once in Grand Total, so each must appear at least twice.
  const twice = new Set(["Target", "Approved", "Mobilised", "In training", "Passed"]);
  const countOf = (w) => (reportSrc.match(new RegExp('label: "' + w.replace(/ /g, " ") + '"', "g")) ?? []).length;
  const missingLabels = wantLabels.filter((w) => countOf(w) < (twice.has(w) ? 2 : 1));
  if (!missingLabels.length) passed++;
  else { failed++; pushStructural("app/(app)/reports/page.tsx: the report does not use the full column names the Excel export uses - QA-565. Missing: " + missingLabels.join(", ") + ". One column, two names is the defect; the export has always spelled them out."); }

  // QA-552: the report must SURFACE a status value it does not recognise. `unknown` is a default
  // bucket, so without this it silently absorbs any new word the client's sheet grows.
  if (/unrecognised_status/.test(reportSrc)) passed++;
  else { failed++; pushStructural("app/(app)/reports/page.tsx: an unrecognised TC Status is not surfaced on the screen - QA-552. The no-verdict bucket is a DEFAULT, so anything nobody taught the report lands there under a label saying the cell is blank."); }
}

// ---- -196 (QA-634): one Planning tab, one table, and an edit switch that actually gates ----
// Umesh, 2026-08-22, with the "Backward batch plan" drawer open: "tho 2 hai kyu, plan a batch pr
// sidha planning wala hi tab open ho shutter wala hta hi do ... ek hi planning tab aaye aur usme
// bhi proper only 1 table only ... abhi manually kisi ko edit krna hai tho edit ka button nhi aa
// rhaa yhaa prr".
//
// Structural, because none of it is reachable over HTTP: the tab set, which control opens what,
// and whether a switch GATES the editors are all decided in the browser bundle. Each check below
// is written to fail against a plausible half-fix, not only against the previous release - a tab
// hidden while its branch survives, a switch added beside editors it does not control, a delete
// button shown to everyone (QA-598 / QA-624 / QA-628, three pins in one day that could not fail).
{
  const raw = fs.readFileSync(path.join(root, "app/(app)/batches/page.tsx"), "utf8");
  const src = stripComments(raw);

  // 1. Two tabs, and the third one's BRANCH is gone too. Hiding a label while `tab === "Preparation"`
  //    still renders a second table is exactly the half-fix he would still be looking at.
  const tabsCall = src.match(/<Tabs\s+tabs=\{\[([^\]]*)\]\}/);
  const tabNames = tabsCall ? (tabsCall[1].match(/"[^"]*"|`[^`]*`/g) || []) : [];
  if (tabsCall && tabNames.length === 2 && /"Batches"/.test(tabsCall[1]) && /"Planning"/.test(tabsCall[1])) passed++;
  else { failed++; pushStructural('app/(app)/batches/page.tsx: the Batches screen does not offer exactly two tabs ("Batches", "Planning") - found ' + JSON.stringify(tabNames) + '. -196: "ek hi planning tab aaye".'); }
  if (!/tab === "Preparation"/.test(src)) passed++;
  else { failed++; pushStructural('app/(app)/batches/page.tsx: a `tab === "Preparation"` branch is still rendered - the tab was taken off the strip but its table is still in the page, which is the same two-tables screen with one door hidden.'); }

  // 2. The shutter. Its title is the string he pointed at, and `planner.open` is the state that
  //    made it a drawer at all - both must be gone, or it was moved rather than removed.
  if (!/"Backward batch plan"/.test(src) && !/planner\.open/.test(src)) passed++;
  else { failed++; pushStructural('app/(app)/batches/page.tsx: the "Backward batch plan" drawer is still in the page - "shutter wala hta hi do". Its inputs belong inline above the Planning table, not behind a drawer that cannot create the batch it plans.'); }

  // 3. "Plan a batch" must land ON the Planning tab with the form already open, and there must be
  //    only ONE such control on screen at a time. -196 shipped the header button unconditionally,
  //    so on the Planning tab it stacked directly above the strip's identical one (Umesh, with a
  //    screenshot: "plan a batch k 2 buttons aa rhee hai, keep only one" - QA-655). Two assertions,
  //    because either alone can be faked: the header button is guarded by the tab, and it opens.
  // ONE. Not "one per tab", not "two that never render together" - one control in the file.
  // -198 answered this by hiding the HEADER button on the Planning tab and keeping the strip's;
  // Umesh's answer was the other one: "agar tujhe header wala hi rakhna hai toh header wala rakh.
  // Uske baad koi dousra wala create hi mat kar ... ek remove krr" (QA-656). Three assertions,
  // because each of the first two survives a plausible half-fix on its own.
  // QA-662 (-200): a checker evaded the first version of these NINE ways and the wall stayed 254/0.
  // Two of the evasions were not even adversarial - the same <Btn> with prettier-style multi-line
  // children slipped the count, and the exact -198 defect re-spelled as a TERNARY slipped the very
  // check whose failure message names that defect. So:
  //   - count CONTROLS, not one byte sequence: <Btn> and plain <button>, children on any number of
  //     lines, whitespace tolerated.
  //   - forbid ANY conditional near that control rather than one hand-written shape.
  //
  // NOTE the regex shape: an opening tag contains `=>` inside its onClick, so `[^>]*` stops at the
  // arrow and matches nothing at all - that is how an earlier version reported "0 buttons" on
  // correct code. These match across the tag with a bounded [\s\S].
  const CTRL = /<(?:Btn|button)\b[\s\S]{0,400}?>\s*Plan a batch\s*<\//g;
  const ctrls = [...src.matchAll(CTRL)];
  if (ctrls.length === 1) passed++;
  else { failed++; pushStructural('app/(app)/batches/page.tsx: ' + ctrls.length + ' controls are labelled "Plan a batch" - QA-656, and exactly one is right. (The strip\'s own <h2> says the same words and is not a control; this counts <Btn> and <button>, children on any number of lines.)'); }
  // that one is the header's: it opens BOTH the tab and the form...
  const headerBtn = src.match(/onClick=\{\(\) => \{([^}]*)\}\}>\s*Plan a batch\s*</);
  const opensBoth = !!headerBtn && /setTab\("Planning"\)/.test(headerBtn[1]) && /setPlanOpen\(true\)/.test(headerBtn[1]);
  // ...and NOTHING makes it conditional. Looking at the 150 characters in front of the control
  // catches `&&`, a ternary, a parenthesised guard and a role gate alike - the previous version
  // named one syntax and three others walked past it.
  const before = ctrls.length === 1 ? src.slice(Math.max(0, ctrls[0].index - 150), ctrls[0].index) : "";
  const guard = before.match(/(tab === |role ===|\?\s*<|&&\s*<)/);
  if (opensBoth && !guard) passed++;
  else { failed++; pushStructural('app/(app)/batches/page.tsx: the one "Plan a batch" control must be the header\'s, UNCONDITIONAL, and open the Planning tab AND the form (opensBoth=' + opensBoth + ', guard=' + JSON.stringify(guard ? guard[1] : null) + ') - QA-656/QA-662. Making it conditional is how -198 kept the wrong one of the two, and re-spelling that guard as a ternary is how the first version of this check was walked past.'); }
  // and the strip renders NOTHING when it is closed - a prompt row with no button is still the
  // duplicate surface he asked to be removed, and would pass both checks above.
  // QA-681: this used to slice to end of file. See fnBody's note.
  const createBlk = fnBody(src, "PlanningCreate");
  if (/if \(!open\) return null;/.test(createBlk)) passed++;
  else { failed++; pushStructural('app/(app)/batches/page.tsx: PlanningCreate still renders something when it is closed - QA-656. Closed means gone; a collapsed prompt repeating "Plan a batch" is the second surface, whether or not it carries a <Btn>.'); }

  // 4. The strip has to CREATE, not just calculate - that was the drawer's whole failing. Three
  //    facts: his new target-candidates input, the POST that makes the batch, and the PATCH that
  //    attaches the plan to it. A strip with the input and no POST is the old calculator with a
  //    new field.
  // QA-681: bounded to PlanningCreate's own braces. An uncalled helper below it used to satisfy
  // every check in this block, which is exactly how a checker disconnected the strip's Save while
  // the whole wall stayed green.
  const create = fnBody(src, "PlanningCreate");
  if (create && /function PlanningCreate/.test(src)) passed++;
  else { failed++; pushStructural("app/(app)/batches/page.tsx: there is no PlanningCreate strip above the Planning table - the drawer's inputs went nowhere."); }
  if (/target_size/.test(create)) passed++;
  else { failed++; pushStructural('app/(app)/batches/page.tsx: the Planning create strip does not carry target_size - Umesh 22/08: "batch mein kitne target persons lena chahte ho, n number of candidates".'); }
  // QA-654 (-198): the batch must be created WITH the trainer the preview counted the plan for.
  // Found by running this on live: /api/plan-batch scopes the preview to whoever teaches at that
  // centre, correctly dropped the TOT steps for an already-certified trainer and showed SIX
  // milestones - and the save sent no trainer, so the plan attached to the batch was rebuilt with
  // trainer null and came back with EIGHT. The checklist a person approves has to be the one stored.
  // QA-658 (-200): the version of this check that shipped in -198 asserted ONLY that the client
  // source contains `scopedTo?.trainer?._id ? { trainer: ... }`. It was red pre-fix and green
  // post-fix while the behaviour did not change by one byte, because the API never put an `_id` in
  // `scoped_to.trainer` and the guard was always false. A pin that matches the text of a fix cannot
  // prove the fix. The BEHAVIOUR is now pinned in scripts/e2e.mjs (QA-657: preview keys vs stored
  // keys, driven through the strip's own call order); what stays here is the other half of the
  // contract, which a source scan CAN see - that the API still sends the id the client reads.
  if (/scopedTo\?\.trainer\?\._id \? \{ trainer:/.test(create)) passed++;
  else { failed++; pushStructural("app/(app)/batches/page.tsx: the Planning strip creates the batch WITHOUT the trainer its preview scoped the plan to - QA-654. /api/plan-batch drops the TOT steps for an already-certified trainer; a batch created with no trainer gets them back, so the saved checklist differs from the one that was approved."); }
  {
    const planApi = stripComments(fs.readFileSync(path.join(root, "app/api/plan-batch/route.ts"), "utf8"));
    const scopedLit = planApi.match(/trainer: trainer \? \{([^}]*)\}/);
    if (scopedLit && /_id:/.test(scopedLit[1])) passed++;
    else { failed++; pushStructural("app/api/plan-batch/route.ts: `scoped_to.trainer` does not carry an `_id` (found " + JSON.stringify(scopedLit ? scopedLit[1].trim().slice(0, 80) : null) + ") - QA-657. The Planning strip creates the batch with `scoped_to.trainer?._id`; without it that guard is always false, the batch is created with no trainer, and the stored plan silently disagrees with the preview. This is the half of the pair a source scan can see - the round trip itself is pinned in e2e.mjs."); }
  }
  if (/"\/api\/batches"/.test(create) && /method: "POST"/.test(create) && /milestones`/.test(create) && /create: true/.test(create)) passed++;
  else { failed++; pushStructural("app/(app)/batches/page.tsx: the Planning strip does not create the batch AND attach its plan (POST /api/batches then PATCH .../milestones {create:true}) - a plan that cannot become a batch is the calculator this replaced."); }

  // 5. The switch, and that it GATES. `editMode` merely existing proves nothing; the editor helper
  //    must refuse to render an input while it is off.
  if (/setEditMode\(/.test(src) && /Edit mode/.test(src)) passed++;
  else { failed++; pushStructural('app/(app)/batches/page.tsx: the Planning table has no "Edit mode" switch - Umesh 22/08: "edit ka button nhi aa rhaa yhaa prr", and three cells have been silently clickable since -171.'); }
  // The first version of this pin sliced from `const editable =` to `const del =` and asked whether
  // "!editMode" appeared ANYWHERE in that span. It could not fail: the span also contains `mcell`,
  // whose own gate satisfied the regex after `editable`'s was deleted. That is the fourth pin in two
  // days that could not fail for the defect it names (QA-598 / QA-613 / QA-624 / QA-628), so this
  // one is written the other way round - find EVERY helper that renders a date input, and require
  // each one, individually, to gate. A new editor added later without a gate fails this too.
  // QA-646: the second version of this pin sliced from `function PlanningTable` to end of file and
  // was blind to anything defined ABOVE that line - so extracting a cell into its own module-level
  // component, which is the ordinary React refactor, hid an ungated date input from it. A checker
  // proved it: an ungated `function TargetCell()` inserted just above PlanningTable, and the wall
  // still read 247 passed, 0 failed. It scans the WHOLE file now, and both declaration forms
  // (`const X = (` and `function X(`), because the mutation that beat it used the second one.
  //
  // The create strip's own inputs are exempt BY NAME rather than by position: PlanningCreate is the
  // form for making a batch, its date field is always meant to be typeable, and there is no edit
  // switch there to gate on. Everything else that renders a date input in this file must gate.
  // The scan is anchored on the DATE INPUTS, not on declarations - a span that runs from one
  // declaration to the next is wrong wherever declarations are sparse, and the first attempt at
  // this rewrite blamed `plannerRoles` and `lines` for JSX that merely followed them.
  //
  // Two owners are exempt BY NAME, and the reason is that neither has an edit switch to gate on:
  // `PlanningCreate` is the form for making a batch, and `BatchesInner` holds the New Batch drawer.
  // Any OTHER owner of a date input in this file - including a cell component extracted to module
  // level, which is what beat the previous version - has to gate.
  // QA-651 (-198): the by-name exemptions were too wide and the gate test too weak, and a checker
  // proved both. `BatchesInner` was exempt WHOLESALE, so any ungated date editor anywhere in the
  // page shell was invisible; and `gated` was a substring test over the helper's whole body, so an
  // input placed BEFORE the early return still counted as gated. Both are narrowed here:
  //   - inside the exempt components, a date input is only allowed if it is bound to that
  //     component's own form state (`form.` for the New Batch drawer, `planner.` for the strip).
  //     Anything else there has to gate like everything else.
  //   - the gate must appear BEFORE the first date input in the helper, because an early return
  //     only guards what comes after it.
  const FORM_OWNERS = { PlanningCreate: /\bplanner\./, BatchesInner: /\bform\./ };
  const comps = [...src.matchAll(/\n(?:export )?(?:function (\w+)\s*\(|const (\w+) = (?:async )?\()/g)]
    .map((m) => ({ name: m[1] ?? m[2], start: m.index }));
  const compAt = (idx) => { let c = null; for (const d of comps) { if (d.start < idx) c = d; else break; } return c; };
  const compBody = (c) => src.slice(c.start, comps.find((d) => d.start > c.start)?.start ?? src.length);
  const gatesBeforeFirstInput = (body) => {
    const inp = body.indexOf('<input type="date"');
    const gate = body.indexOf("!editMode");
    return inp >= 0 && gate >= 0 && gate < inp;
  };

  const editors = [];
  const seen = new Set();
  // (a) component level - catches a cell extracted to its own component, the refactor that beat an
  //     earlier version of this pin (an ungated `function TargetCell()` above PlanningTable).
  for (const m of src.matchAll(/<input type="date"/g)) {
    const c = compAt(m.index);
    if (!c) continue;
    const ownForm = FORM_OWNERS[c.name];
    if (ownForm) {
      // allowed only if THIS input reads the component's own form state, within its own tag
      const tag = src.slice(m.index, src.indexOf(">", m.index) + 1);
      if (ownForm.test(tag)) continue;
      editors.push({ name: `${c.name} (a date input that is not its own form field)`, gated: gatesBeforeFirstInput(compBody(c)) });
      continue;
    }
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    editors.push({ name: c.name, gated: gatesBeforeFirstInput(compBody(c)) });
  }
  // (b) helper level INSIDE PlanningTable - it is not enough that the component mentions editMode
  //     somewhere; each cell renderer has to gate for itself, BEFORE it renders an input.
  const ptc = comps.find((c) => c.name === "PlanningTable");
  if (ptc) {
    const body = compBody(ptc);
    // QA-659 (-200): this scanned only `const NAME = (` helpers, so a `function NAME(` helper
    // declared inside PlanningTable was invisible to BOTH halves of the check - a checker beat it on
    // the first attempt and the wall stayed 253/0. Both declaration forms now.
    for (const m of body.matchAll(/\n  (?:const (\w+) = (?:async )?\(|function (\w+)\s*\()/g)) {
      const name = m[1] ?? m[2];
      const nextRel = body.slice(m.index + m[0].length).search(/\n  (?:const|function) \w+/);
      const h = nextRel < 0 ? body.slice(m.index) : body.slice(m.index, m.index + m[0].length + nextRel);
      if (/<input type="date"/.test(h)) editors.push({ name: `PlanningTable.${name}`, gated: gatesBeforeFirstInput(h) });
    }
  }
  const ungated = editors.filter((e) => !e.gated).map((e) => e.name);
  if (editors.length >= 2 && !ungated.length) passed++;
  else { failed++; pushStructural("app/(app)/batches/page.tsx: " + (editors.length < 2 ? "the Planning table has fewer date editors than the two it needs (trainer dates and milestone dates) - found " + editors.length : "these Planning-table cell editors offer an input without checking editMode: " + JSON.stringify(ungated)) + " - a switch that does not gate every editor is a decoration, and those cells stay editable with it off."); }

  // 6. Delete on the row, gated by the RIGHT and by Edit mode. DELETE /api/batches/:id refuses
  //    anyone without the right anyway; showing the button teaches people to click into a 403.
  //
  //    QA-904 (2026-08-24): this pin used to require the literal `editMode && role === "Admin"`.
  //    Umesh moved delete off the Admin role onto a togglable right ("vo bhi respective acess wale
  //    persons"), so that spelling is now the WRONG thing to demand - the pin would have forced the
  //    old rule back. UPDATED rather than deleted: what it guards is still real (a delete verb exists
  //    on the row, and it is gated), only the gate's name changed. A pin rewritten to match whatever
  //    the code now says would be worthless, so it still demands BOTH halves - a gate, and editMode.
  if (/method: "DELETE"/.test(src) && /canRightP\("batches\.delete", "edit"\)/.test(src) && /editMode && rightsLoadedP && canRightP\("batches\.delete", "edit"\)/.test(src)) passed++;
  else { failed++; pushStructural('app/(app)/batches/page.tsx: the Planning table has no permission-gated delete on the row, gated by Edit mode - "batch ko delete krne k liye kuch nhi hai" (QA-904: the gate is `batches.delete`, not the Admin role).'); }

  // ---- -197: the three things the -196 checker found that no pin above could have caught ----

  // QA-641: a tab removed is a tab whose CALLERS move with it. -196 deleted the Preparation tab and
  // left five links to it on Home, one of them a button labelled "Preparation board", so a reader
  // asking for centre x job-role positions was handed a grid of batches. A redirect is not an
  // answer. Scanned across all of src/ - the point is precisely that the defect was in a file this
  // unit never opened.
  {
    const strays = [];
    for (const f of walk(root)) {
      const rel = path.relative(root, f).split(path.sep).join("/");
      if (rel === "app/(app)/batches/page.tsx") continue; // its own redirect comment names the string
      if (/tab=Preparation/.test(stripComments(fs.readFileSync(f, "utf8")))) strays.push(rel);
    }
    if (!strays.length) passed++;
    else { failed++; pushStructural("these files still link to the deleted Preparation tab: " + JSON.stringify(strays) + " - QA-641. The tab was removed in -196 and its callers were not, so a link promising the centre x job-role board lands on a table of batches."); }
  }

  // QA-642: the Planning table's refetch must be something a caller can CALL. -196 signalled
  // "reload" by setting the rows to null, which is not a dependency of the effect that loads them,
  // so React never re-ran it and the table sat on its loading skeleton after every single write.
  // Two halves, because either alone can be faked: a named loader, and nobody blanking state.
  {
    if (/const loadTrack = /.test(src) && /onSaved=\{loadTrack\}/.test(src) && /loadTrack\(\)/.test(src)) passed++;
    else { failed++; pushStructural("app/(app)/batches/page.tsx: the Planning table has no callable refetch wired to its save/create callbacks - QA-642. A screen that signals 'reload' by blanking its own rows leaves itself on a skeleton, because the effect that loads them does not depend on them."); }
    if (!/setTrack\(null\)/.test(src)) passed++;
    else { failed++; pushStructural("app/(app)/batches/page.tsx: setTrack(null) is back - QA-642. That is the signal that never reloaded anything; call the loader instead."); }
  }

  // QA-643: the download sitting on top of a narrowed table carries rows the table just said had
  // left. It is not narrowed to match on purpose (the sheet it mirrors is the whole live picture),
  // so the button has to SAY so - a bare "Download Excel" over a filtered table is the disagreement.
  {
    const table = src.slice(src.indexOf("function PlanningTable"));
    const narrowed = /NOT_STARTED = \[/.test(table);
    const btn = table.match(/>Download Excel[^<]*</);
    if (!narrowed || (btn && /all live batches/i.test(btn[0]))) passed++;
    else { failed++; pushStructural("app/(app)/batches/page.tsx: the Planning table is narrowed to the batches that have not started, but its Download button (" + JSON.stringify(btn ? btn[0].slice(1, -1) : null) + ") does not say that the file carries the started ones too - QA-643. The export reads all four live statuses and cannot be told otherwise from here."); }
  }

  // 7. The row leaves Planning when the batch starts. planTrackerRows returns all four live
  //    statuses (that is right - the export and the Batches tab both want them), so the view is
  //    what narrows, and it must narrow to the two that have not started.
  const table = src.slice(src.indexOf("function PlanningTable"));
  const notStarted = table.match(/NOT_STARTED = \[([^\]]*)\]/);
  const listed = notStarted ? (notStarted[1].match(/"[^"]*"/g) || []).map((s) => s.slice(1, -1)) : [];
  if (listed.length === 2 && listed.includes("Planning") && listed.includes("Ready") && /rows \?\? \[\]\)\.filter\(/.test(table)) passed++;
  else { failed++; pushStructural('app/(app)/batches/page.tsx: the Planning table does not narrow to the batches that have not started (found ' + JSON.stringify(listed) + ') - Umesh 22/08: "jaise batch start ho jayega planning wale se, woh batch wale tab mein shift ho jayega".'); }
}

// -149 (QA-324): this file started as one check and now carries several - the ASI trap, the
// drawer ceiling, the scope-collision scan. Every finding was summarised as "user-facing
// string(s) still carry a Rule/DEC/QA code", so a scope leak was reported as a copy problem and
// the suggested fix was to rewrite a sentence. A summary that misnames what it found sends the
// reader to the wrong place, which is the same defect this file exists to catch.
// ---- -202: the trainer's Nomination & TOT card, and the allow-list it must NOT be bolted onto ----
// Umesh, 22/08: "agar koi wrong value set ho gayi toh baad me edit nahi kar pa raha hai - edit ka
// button bhi de bhai." The correction door is PATCH on /api/trainers/[id]/transition. Three ways
// that could regress into looking right while being wrong, so three checks.
{
  const rulesSrc = fs.readFileSync(path.join(root, "lib/rules.ts"), "utf-8");
  const pageRel = "app/(app)/trainers/[id]/page.tsx";
  const pageSrc = fs.readFileSync(path.join(root, pageRel), "utf-8");
  let bad = 0;

  // (a) The client cannot import CORRECTABLE_TRAINER_DATES (lib/rules.ts pulls mongoose), so the
  // screen hand-copies the six names — the same situation as DOC_TYPES above, answered the same
  // way: the copy is allowed, drifting is not. Drift here means the card offers a field the door
  // refuses, or hides one it accepts, and neither says anything out loud.
  const serverBlock = (rulesSrc.split("export const CORRECTABLE_TRAINER_DATES = [")[1] ?? "").split("] as const;")[0];
  const serverNames = [...serverBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const clientBlock = (pageSrc.split("const PIPELINE_DATES")[1] ?? "").split("];")[0];
  const clientNames = [...clientBlock.matchAll(/\["([a-z_]+)"/g)].map((m) => m[1]);
  if (serverNames.length !== 6 || clientNames.join(",") !== serverNames.join(",")) {
    bad++;
    pushStructural(pageRel + ": PIPELINE_DATES has drifted from CORRECTABLE_TRAINER_DATES in lib/rules.ts - screen [" + clientNames.join(",") + "] vs door [" + serverNames.join(",") + "]");
  }

  // (b) The six must stay OFF the plain trainer PATCH allow-list. That absence is what qa-196's
  // ratified invariant rests on, and widening the list is the shortcut a future change would most
  // plausibly take - it is one line and it would make every pin above still pass.
  const trainerRouteRel = "app/api/trainers/[id]/route.ts";
  const trainerRoute = fs.readFileSync(path.join(root, trainerRouteRel), "utf-8");
  const allowBlock = (trainerRoute.split("fields: [")[1] ?? "").split("]")[0];
  const leaked = serverNames.filter((n) => allowBlock.includes('"' + n + '"'));
  if (leaked.length) {
    bad++;
    pushStructural(trainerRouteRel + ": " + leaked.join(", ") + " reached the plain PATCH allow-list. These are written only through the pipeline door; on that list a hand-made request bypasses every TRAINER_FLOW guard.");
  }

  // (c) The card's affordance must read as an edit and be single. The old label was "Set nomination",
  // which is why nobody found the one editable row on the card for six weeks; and a TR ID input must
  // exist on this page, because the Certified banner has always told people to record it "here".
  // stripComments, because the history of this label belongs in the comments and only the LABEL
  // itself is the finding — the first run of this pin failed on its own explanatory comment.
  if (/Set nomination/.test(stripComments(pageSrc))) {
    bad++;
    pushStructural(pageRel + ': the card action still reads "Set nomination" - it is an edit over the whole card now, and the old label is what hid it.');
  }
  if (!/onClick=\{openCard\}/.test(pageSrc) || (pageSrc.match(/onClick=\{openCard\}/g) ?? []).length !== 1) {
    bad++;
    pushStructural(pageRel + ": expected exactly one Edit control opening the Nomination & TOT card (onClick={openCard}), found " + ((pageSrc.match(/onClick=\{openCard\}/g) ?? []).length));
  }
  if (!/card\.tr_id/.test(pageSrc)) {
    bad++;
    pushStructural(pageRel + ': no TR ID input on this page, while the Certified banner says "Record it here (Edit -> TR ID)".');
  }

  // ---- QA-685 (-204): the four checks above prove the Edit mode EXISTS. None proved it is WIRED ----
  // The qa-202 checker deleted the whole date half of saveCard(): all six inputs still rendered,
  // Save still closed the card, nothing was written - and this file returned a byte-identical
  // 255/1. The unit's entire reason for existing could be disconnected without one assertion going
  // red, because `check-user-copy.mjs` is the only script in scripts/ that reads this page and no
  // e2e suite fetches an HTML route.
  //
  // This closes the mutation that was demonstrated: Save must reach BOTH doors from inside its own
  // body. It does NOT close the general case - a source scan cannot prove a React handler runs, and
  // saying otherwise is how the last four of these were written. The general case is answered by
  // driving the built app in a browser, which this cycle does once by hand and records; making that
  // a standing 18th suite is a real proposal, not something to slip in under a pin.
  const saveBody = fnBody(pageSrc, "saveCard");
  const hitsDates = /\/transition/.test(saveBody) && /PIPELINE_DATES/.test(saveBody);
  const hitsProfile = /nominated_for_location|tr_id/.test(saveBody);
  const wired = /onClick=\{saveCard\}/.test(pageSrc);
  if (saveBody && hitsDates && hitsProfile && wired) passed++;
  else {
    bad++;
    pushStructural(pageRel + ": the Nomination & TOT Save is not wired to both doors (saveCard found=" + !!saveBody
      + ", reaches /transition with PIPELINE_DATES=" + hitsDates + ", reaches the profile fields=" + hitsProfile
      + ", a Save button calls it=" + wired + ") - QA-685. Dropping the date half leaves every input on screen and writes nothing.");
  }
  // And the read-only half must stay read-only: every input on this card lives behind the edit
  // state, never in the <dl>.
  const dlBlock = (pageSrc.split('<dl className="grid grid-cols-2 gap-y-2 text-sm">')[1] ?? "").split("</dl>")[0];
  if (/<input|<select/.test(dlBlock)) {
    bad++;
    pushStructural(pageRel + ": the read-only Nomination & TOT list carries an input - the edit mode is supposed to replace it, not sit inside it.");
  }

  if (bad) failed++; else passed++;
}

// ---- -204: a running batch must still have its status controls ----
// Umesh, 22/08, on AVP-GURU-RPLAVP-DST-02: "button hi nahi aa raha hai abhi, unko complete mark
// karne ka... pehle toh aa raha tha, ye hil kyu gaya?" It had not moved - it had fallen out. -112
// collapsed the readiness checklist once a batch is running and -134 filled the hole with the
// "Right now" card; every status control lived inside the collapsed half and nobody carried it
// across. From -112 onward, a batch that had started could not be completed, reopened, closed or
// cancelled from this screen at all. Measured on live before the fix: that batch rendered no status
// button of any kind.
//
// This is NOT a text match on the buttons - all of them were present in the source the whole time,
// which is exactly why nothing caught it. It measures NESTING: the control row must sit OUTSIDE the
// `running ? … : …` ternary, so that neither branch can take it away again.
{
  const rel = "app/(app)/batches/[id]/page.tsx";
  const src = stripComments(fs.readFileSync(path.join(root, rel), "utf-8"));
  const scan = blankStrings(src);
  // -205 changed what this measures, and the new statement is Umesh's own: "overview mai jo Complete
  // Batch button hai, that must be come beside these above buttons in the same card, not anywhere
  // else." -204 satisfied "not inside the ternary" by making the row a sibling of the card. That
  // cleared the S1 but it is not where he wants it. The controls are now ONE declared value rendered
  // in BOTH branches - inside the "Right now" card while the batch runs, and inside the readiness
  // Section before it starts - so the invariant worth holding is that NEITHER branch can lose it.
  const runIdx = scan.indexOf("{running ? (");
  let closeIdx = -1;
  if (runIdx >= 0) {
    let depth = 0;
    for (let i = runIdx; i < scan.length; i++) {
      if (scan[i] === "{") depth++;
      else if (scan[i] === "}") { depth--; if (depth === 0) { closeIdx = i; break; } }
    }
  }
  const span = closeIdx > runIdx ? scan.slice(runIdx, closeIdx + 1) : "";
  const split = span.search(/\r?\n\s{6}\) : \(/);
  const hasDecl = /const statusActions = canTransition \? \(/.test(scan);
  const inRunning = split > 0 && /\{statusActions\}/.test(span.slice(0, split));
  const inReadiness = split > 0 && /\{statusActions\}/.test(span.slice(split));
  // QA-696 (-206, checker on qa-204): both of the above stay TRUE if you append `&& !running` to
  // canTransition. The value is still declared, still referenced in both branches — and it renders
  // the "moved by Operations/Admin" note instead of the controls, which is QA-693 restored exactly.
  // The checker did it in one token, with tsc rc=0 and this file at 259 passed / 0 failed. So the
  // GUARD itself is pinned: whatever canTransition is, it must be about the ROLE, and must not
  // consult whether the batch is running or what status it is at.
  const decl = /const canTransition = ([^;]*);/.exec(scan);
  const guardSrc = decl ? decl[1] : "";
  const guardClean = !!guardSrc && !/\brunning\b/.test(guardSrc) && !/\bb\.status\b/.test(guardSrc) && !/\bstatus\b/.test(guardSrc);
  if (hasDecl && inRunning && inReadiness && guardClean) passed++;
  else {
    failed++;
    pushStructural(rel + ": the batch status controls do not render in both states"
      + " (declared=" + hasDecl + ", in the \"Right now\" card=" + inRunning + ", in the readiness Section=" + inReadiness
      + ", canTransition is role-only=" + guardClean + (guardClean ? "" : " -> " + JSON.stringify(guardSrc.trim().slice(0, 90))) + ")"
      + " - whichever of those is false, a batch in that state has NO way to be completed, reopened,"
      + " closed or cancelled from this screen. That is what -112 shipped and nobody noticed for 92"
      + " releases; Umesh asked for the control to sit in the card, not merely to exist, and one"
      + " appended token on the guard puts it all back.");
  }
}

// ---- -208: the portal-ID gap is ONE widget, mounted where the work happens ----
// Umesh, 23/08: "even attendance wale tab me bhi vo kar de, yeh closer wale me kar dhe." Two places
// is what he asked for; two COPIES is what this repo's ARCHITECTURE.md section 3 is a catalogue of,
// and this widget carries a WRITE - a second copy would be a second door onto a candidate's identity
// field. So: declared once, mounted at least twice, and the parent must not have kept its own copy
// of the state or the saver.
{
  const rel = "app/(app)/batches/[id]/page.tsx";
  const src = stripComments(fs.readFileSync(path.join(root, rel), "utf-8"));
  const decls = (src.match(/function PortalIdGaps\(/g) ?? []).length;
  const mounts = (src.match(/<PortalIdGaps\b/g) ?? []).length;
  const leftovers = /const \[showMissing|const \[canDraft|async function saveCan\(/.test(src);
  if (decls === 1 && mounts >= 2 && !leftovers) passed++;
  else {
    failed++;
    pushStructural(rel + ": the portal-ID gap widget is not one component in two homes"
      + " (declarations=" + decls + ", mounts=" + mounts + ", the parent still holds its own copy of the state or saver=" + leftovers + ")"
      + " - Umesh asked for it on the Certificates tab AND the Attendance tab; two literals of a"
      + " widget that WRITES a candidate's portal ID is a second door onto an identity field, which"
      + " is the class ARCHITECTURE.md section 3 exists to list.");
  }
}

// ---- -220 (QA-806/QA-813): a ROUTE_RULES perm that can never be read is dead text ----
// `routeAllowed` returns true for Admin BEFORE it looks at `perm`. So a rule whose `roles` ceiling
// is only ["Admin"] can never reach its permission check - and every in-screen gate written behind
// that route is unreachable code with it. -218 shipped exactly that on /sync and I wrote a manifest
// section boasting about the gates; -219 fixed that one line and left the IDENTICAL fault on
// /sheet-watch, one line above it. Twice is a shape, not a slip, so the SHAPE is pinned: no rule may
// carry a `perm` that only Admin can reach. (A rule with no `perm` is fine - /admin is role-only on
// purpose.)
{
  const rel = "components/shell.tsx";
  const raw = stripComments(fs.readFileSync(path.join(root, rel), "utf-8"));
  // QA-818 (-221, checker on qa-220): the -220 version of this pin matched today's SPELLING, not the
  // shape. Six mutations that are the IDENTICAL defect and all compile (`tsc` exit 0) left it green
  // at 270/0: `["Admin",]` · `["Admin","Admin"]` · `['Admin']` · `["Admin", ]` · prettier's multiline
  // `[\n "Admin",\n]` · and a SECOND rules array declared AFTER `routeAllowed`, which the old
  // `slice(…, indexOf("export function routeAllowed"))` never even looked at. Two of those are what
  // `prettier`/`eslint --fix` emit, so running a formatter would have silently disarmed the pin —
  // a pin that a formatter can turn off was never pinning the class. So: normalise quoting and
  // whitespace first, read EVERY rule object in the file rather than one block, parse the roles
  // array as a SET, and refuse to pass at all if the parser did not account for every rule present.
  const src = raw.replace(/'/g, '"').replace(/\s+/g, " ");
  const rules = [...src.matchAll(/\{ ?prefix: ?"[^"]+"[^{}]*\}/g)].map((m) => m[0]);
  const prefixCount = (src.match(/prefix: ?"/g) ?? []).length;
  const rolesOf = (r) => {
    const m = /roles: ?\[([^\]]*)\]/.exec(r);
    if (!m) return null;
    return [...new Set(m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean))];
  };
  const dead = rules
    .filter((r) => /perm: ?"/.test(r))
    .filter((r) => { const roles = rolesOf(r); return Array.isArray(roles) && roles.length === 1 && roles[0] === "Admin"; })
    .map((r) => (/prefix: ?"([^"]+)"/.exec(r) ?? [])[1]);
  // …and routeAllowed must still short-circuit Admin, or this pin is measuring the wrong thing.
  const adminShortCircuits = /perms\.role ?=== ?"Admin" ?\) ?return true/.test(src);
  // A rule the parser could not read is a rule this pin did not check — that must FAIL, not pass
  // quietly. Silent under-counting is how the second-array mutation walked past the -220 pin.
  const parsedAll = rules.length === prefixCount;
  if (rules.length >= 5 && parsedAll && adminShortCircuits && dead.length === 0) passed++;
  else {
    failed++;
    pushStructural(rel + ": a ROUTE_RULES entry carries a permission only an Admin can reach"
      + " (rules parsed=" + rules.length + "/" + prefixCount + ", Admin short-circuits=" + adminShortCircuits
      + ", unreachable=" + JSON.stringify(dead) + ")"
      + " - routeAllowed returns true for Admin before it reads `perm`, so that permission is dead"
      + " text and every gate written behind that screen is unreachable with it. QA-806 shipped this"
      + " on /sync and QA-813 found it still standing on /sheet-watch one line above the fix.");
  }
}

// ---- -217 (QA-785): EVERY component on the Closure tab asks whether this person may mark ----
// The class has now shipped five times (QA-712, QA-723, QA-754, QA-775, QA-785) and the last two
// were the SAME TAB: -216 gated the card component and left its parent, 250 lines up, on a
// status-only `closed`. A Trainer pressed an enabled "Mark Completed" and was refused. Counting
// gates is not enough either - what matters is that no component on this tab decides "disabled"
// from the batch status ALONE. So: both components must derive their disable term from a
// permission, and the certificate control must not be gated on the collapsed `closed` (widening it
// made that control render MORE often, because its condition is inverted).
{
  const rel = "app/(app)/batches/[id]/page.tsx";
  const src = stripComments(fs.readFileSync(path.join(root, rel), "utf-8"));
  const tab = fnBody(src, "ClosureTab");
  const gated = (b) => /closure\.manage/.test(b) && /const closed =[^;]*mayMark/.test(b);
  const tabGated = gated(tab);
  // the card component is not a top-level function in every refactor, so look at what is left
  const outsideTab = src.split(tab).join("");
  const cardGated = gated(outsideTab);
  // the inverted certificate condition must no longer read the collapsed term
  const certSafe = !/\{!closed \|\| !i\.result\?\.certificate_file/.test(src);
  if (tabGated && cardGated && certSafe) passed++;
  else {
    failed++;
    pushStructural(rel + ": a Closure control is still disabled by batch status alone"
      + " (ClosureTab asks the permission=" + tabGated + ", the card component asks it=" + cardGated
      + ", the certificate control is off the collapsed term=" + certSafe + ")"
      + " - QA-785: a Trainer pressed an ENABLED \"Mark Completed\" and was told they lack the right,"
      + " the fifth outing of this class and the second on this tab. `closed` is about the BATCH;"
      + " whether a person may mark is a different question and both components have to ask it.");
  }
}

// ---- -215 (QA-770): the blocked-student panel must offer the ids that are already here ----// ---- -215 (QA-770): the blocked-student panel must offer the ids that are already here ----
// 57 candidates on live hold a CAN-shaped value in `id_reference` with `sidh_candidate_id` empty,
// ten of them on the batch Umesh has been chasing all week. The remedy was built and never run
// because it lives on a different screen. If this panel ever stops offering it, a centre is back to
// typing ids the system already has - so the offer is pinned, and so is the safety sentence, because
// "we moved 57 identity fields for you" is a claim that has to say what it will not overwrite.
{
  const rel = "app/(app)/batches/[id]/page.tsx";
  const src = stripComments(fs.readFileSync(path.join(root, rel), "utf-8"));
  const body = fnBody(src, "PortalIdGaps");
  const reads = /portal-id-health/.test(body);
  const scoped = /blockedIds/.test(body);            // system-wide plan, narrowed to THIS batch
  const applies = /copy:/.test(body);
  const saysSafe = /never overwritten|only fills an empty|Only fills an empty/i.test(body);
  if (reads && scoped && applies && saysSafe) passed++;
  else {
    failed++;
    pushStructural(rel + ": the portal-ID panel does not offer the ids that already exist"
      + " (reads the health plan=" + reads + ", narrowed to this batch=" + scoped
      + ", can apply the move=" + applies + ", says what it will NOT overwrite=" + saysSafe + ")"
      + " - QA-770: ten of Umesh's \"missing\" ids were in id_reference the whole time, and the fix"
      + " existed on a screen he was not standing on.");
  }
}

// ---- -212 (Umesh 23/08): the portal ID on EVERY candidate row, from ONE chip ----// ---- -212 (Umesh 23/08): the portal ID on EVERY candidate row, from ONE chip ----
// "jo candidate card hai, usme har kisi ki portal id bhi properly highlight karke dikha ... even
// attendance wale tab me bhi wo kar de". -208 had put the portal ID on this screen but only as a
// list of the students MISSING one, so the ID a student DOES hold was invisible outside the edit
// drawer. Three mounts, because he named three places: the roster card and both attendance
// pickers. One declaration, for the same reason PortalIdGaps has one - and here the page must not
// keep its own copy of the CAN regex either, which is what it had before this release.
{
  const rel = "app/(app)/batches/[id]/page.tsx";
  const raw = fs.readFileSync(path.join(root, rel), "utf-8");
  const src = stripComments(raw);
  const decls = (src.match(/function PortalIdChip\(/g) ?? []).length;
  const mounts = (src.match(/<PortalIdChip\b/g) ?? []).length;
  const inlineRegex = /\/CAN\[/.test(src);   // any near-copy of the matcher living on this screen
  // QA-754 (-213): counting mounts was NOT enough and the checker proved it by opening the app.
  // -212 had three mounts and every one of them was on a tab Umesh did not name - the chip was on
  // Enrollment and Daily Execution while the tabs he asked for, `Candidates` and `Attendance`,
  // showed nothing. A count cannot tell you WHERE. So the two components that render those two tabs
  // are named, and each must contain a mount.
  const inRoster = /<PortalIdChip\b/.test(fnBody(src, "Roster"));
  const inAttendance = /<PortalIdChip\b/.test(fnBody(src, "AttendanceTab"));
  if (decls === 1 && mounts >= 3 && inRoster && inAttendance && !inlineRegex) passed++;
  else {
    failed++;
    pushStructural(rel + ": the portal-ID chip is not on the tabs Umesh named"
      + " (declarations=" + decls + ", mounts=" + mounts + ", inside Roster (the Candidates tab)=" + inRoster
      + ", inside AttendanceTab=" + inAttendance + ", page still carries its own CAN regex=" + inlineRegex + ")"
      + " - he said \"candidate card\" and \"attendance wale tab\"; -212 mounted three copies and not"
      + " one was on either of those tabs. A mount COUNT cannot tell you where a thing renders.");
  }
}

// ---- -212 (QA-728/QA-729, checker on qa-210): ONE spelling of "what a portal CAN looks like" ----
// The line for this concept in ARCHITECTURE.md section 3 reads, in as many words, "Never write a
// near-copy of that regex" - and -210 pasted `looksLikeCan` into BOTH candidate route files. They
// had already drifted inside their own commit: one 400 message used an em dash, the other a hyphen,
// so the same refusal read differently depending on which door you hit. It also left behind an
// import of `normalizeCan` that is never called - the leftover of the abandoned first attempt, and
// a false signal that this door normalises through the shared matcher, which is exactly the
// misreading the release's own comment spends five lines warning against.
{
  const files = ["app/api/candidates/route.ts", "app/api/candidates/[id]/route.ts"];
  const defs = [];
  const deadImports = [];
  for (const rel of files) {
    const raw = fs.readFileSync(path.join(root, rel), "utf-8");
    const src = stripComments(raw);
    if (/const\s+looksLikeCan\s*=/.test(src)) defs.push(rel);
    // imported and never used: the name appears in the import line and nowhere else in live code
    for (const sym of ["normalizeCan", "looksLikeCan"]) {
      const imported = new RegExp("import\\s*\\{[^}]*\\b" + sym + "\\b[^}]*\\}").test(src);
      const calls = (src.match(new RegExp("\\b" + sym + "\\s*\\(", "g")) ?? []).length;
      if (imported && calls === 0) deadImports.push(rel + ":" + sym);
    }
  }
  // The home is lib/validate.ts - the PURE module, importing nothing - because the client screens
  // need these too and lib/govt-attendance imports the mongoose models. govt-attendance re-exports
  // them so every existing server caller keeps working; both halves are pinned.
  const pure = stripComments(fs.readFileSync(path.join(root, "lib/validate.ts"), "utf-8"));
  const defined = /export const looksLikeCan\s*=/.test(pure) && /export const normalizeCan\s*=/.test(pure)
    && /export const storedCanIsUnreadable\s*=/.test(pure);
  const pureIsPure = !/^\s*import\s/m.test(pure);   // the property that makes it client-reachable
  const reexported = /export\s*\{[^}]*looksLikeCan[^}]*\}\s*from\s*"@\/lib\/validate"/.test(
    stripComments(fs.readFileSync(path.join(root, "lib/govt-attendance.ts"), "utf-8")));
  const exported = defined && pureIsPure && reexported;
  if (defs.length === 0 && exported && deadImports.length === 0) passed++;
  else {
    failed++;
    pushStructural("the portal-CAN shape test is not one exported definition in the pure module"
      + " (local re-definitions=" + JSON.stringify(defs) + ", defined in lib/validate.ts=" + defined
      + ", lib/validate.ts still imports nothing=" + pureIsPure + ", re-exported from govt-attendance=" + reexported
      + ", imported-but-never-called=" + JSON.stringify(deadImports) + ")"
      + " - ARCHITECTURE.md section 3 says of this exact concept \"Never write a near-copy of that"
      + " regex\", and the two copies -210 shipped had already drifted in their error text. A dead"
      + " import of normalizeCan beside it falsely signals that the door normalises through the"
      + " matcher - QA-728/QA-729.");
  }
}

// ---- -209: the three ways completing a batch was quietly broken or lying ----
// All three came from the qa-207 checker, and all three are the same species: a screen or a door
// that says one thing while the system does another.
{
  const pageRel = "app/(app)/batches/[id]/page.tsx";
  const routeRel = "app/api/batches/[id]/complete/route.ts";
  const page = stripComments(fs.readFileSync(path.join(root, pageRel), "utf-8"));
  const route = stripComments(fs.readFileSync(path.join(root, routeRel), "utf-8"));
  let bad = 0;

  // QA-712: the Closure tab's own button was DEAD from the moment -206 shipped. It renders only when
  // blockers exist, and -206 refuses a press without `force` whenever blockers exist — the same
  // condition that shows it. Every press returned "Nothing has been changed". No suite presses that
  // door, which is why the wall stayed green over it for two releases.
  // QA-722 (-211, checker on qa-209): the first version of this counted force-carrying POSTs against
  // the number of functions NAMED `completeAsAdmin`. The checker beat it twice in a minute - a third
  // sender under any other name is invisible to it, and so is a rename-plus-drop, which is the exact
  // shape QA-712 was. It counts by SHAPE now: every POST to /complete on this page, whatever the
  // function around it is called, must carry `force`.
  // QA-722 residual (-234): counting by SHAPE closed the rename-plus-drop, but only ON THIS PAGE.
  // A sender in ANY OTHER FILE was still invisible - the same blind spot one directory out. It scans
  // every client file now. `/api/upload/complete` is a DIFFERENT endpoint (chunked-upload finish)
  // and is excluded by name, not by luck: it takes no `force` and never will.
  const senders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp); continue; }
      if (!/\.(tsx|ts)$/.test(e.name)) continue;
      if (fp.includes(path.join("api", "batches"))) continue;      // the route itself, not a sender
      const src = stripComments(fs.readFileSync(fp, "utf-8"));
      // QA-1006 (-238, checker on qa-237): the match now carries its own URL, and the exclusion
      // reads THAT rather than guessing from the 120 characters in front of it. The old test was
      // `/upload/.test(<preceding 120 chars>)` — substring proximity, not the endpoint — so a
      // force-less sender inside a function that merely took a param named `uploadBusy` was skipped
      // in silence. Proved by mutation, not argued.
      for (const m of src.matchAll(/`[^`]*\/complete`\s*,\s*\{[\s\S]{0,240}?\}\s*\)/g)) {
        if (/\/upload\/complete`/.test(m[0])) continue;   // a DIFFERENT endpoint: chunked-upload finish, takes no force
        senders.push({ file: path.relative(root, fp).split(path.sep).join("/"), text: m[0] });
      }
    }
  };
  // QA-1006: rooted at `src`, not `src/app`. The comment claimed "every client file" while the walk
  // covered only `src/app` — so a force-less POST in a real "use client" component under
  // `src/components` left the wall byte-identical. That is the THIRD iteration of one species on this
  // very pin (-209 counted by function NAME, -211/-234 by shape on ONE page, -234 widened to
  // `src/app` while still saying "every client file"): each fix closed the instance in front of it
  // and left the sentence claiming more than the code enforced. Which is what QA-722 was about.
  walk(root);
  const posts = senders.map((x) => x.text);
  const withoutForce = posts.filter((p) => !/force:\s*true/.test(p));
  if (posts.length >= 1 && withoutForce.length === 0) passed++;
  else {
    bad++;
    pushStructural(pageRel + ": " + (posts.length ? withoutForce.length + " of " + posts.length + " POSTs to /complete do not send `force`" : "no POST to /complete found at all")
      + " - the door refuses a bare press whenever anything is open, which is exactly when the button"
      + " that sends it is on screen, so every such press fails with \"Nothing has been changed\" - QA-712/QA-722.");
  }

  // QA-723: -209 offered the Complete control to a non-Admin on an ACTIVE batch, where the only arm
  // into Completed is Closing -> Completed, so every press could only 409. The visibility has to know
  // the difference between the two doors.
  if (/isAdmin \? \["Active", "Closing"\] : \["Closing"\]/.test(page)) passed++;
  else {
    bad++;
    pushStructural(pageRel + ": the Complete Batch control does not distinguish the Admin force door"
      + " (Active or Closing) from the ordinary one (Closing only) - transitionBatch has no"
      + " Active -> Completed arm, so offering it there gives a non-Admin a button that can only 409"
      + " - QA-723.");
  }

  // ...and it promised the wrong outcome while it was at it: ABSENT, which -204 changed to Fail on
  // Umesh's ruling, with the banner two lines above already saying Fail.
  if (!/recorded ABSENT|will be recorded ABSENT/i.test(page)) passed++;
  else {
    bad++;
    pushStructural(pageRel + ": a completion prompt still promises the unmarked students are recorded ABSENT."
      + " -204 changed that to Fail because Umesh chose Fail, and the banner beside it already says Fail."
      + " One write described two ways is worse than one described none - QA-712.");
  }

  // QA-708: RPL M24 gates `batch.complete`, /transition has always honoured it, and this door did
  // not - which stopped being harmless the moment -207 made it the only completion control on the
  // Overview.
  if (/requireApproval\("batch\.complete"/.test(route)) passed++;
  else {
    bad++;
    pushStructural(routeRel + ": the completion door does not call requireApproval(\"batch.complete\")"
      + " while the /transition door it replaced does - so with the approval matrix switched on, the"
      + " Overview's completion button walks straight past it - QA-708.");
  }

  if (bad) failed++;
}

// ---- -222 (Umesh, 2026-08-24): all THREE intake doors ask geography the same way ----
// "candidate form - state - selected state dropdown - respective district - respective sub district".
// State/District/Sub-district were three free-text inputs written out THREE separate times, on
// three doors with three different label wrappers. The class this pin exists for is not the free
// text - it is the THREE COPIES: QA-271 is the standing row for `offerable` living in three files,
// where the one master that needed it most was missed in all three, and ARCHITECTURE.md section 3
// exists to list exactly this. So the pin is not "the cascade is present on the door I edited"; it
// is "no intake door still asks for these as free text, and every one of them goes through the one
// component". A fourth door added later fails this until it does the same.
{
  const doors = [
    "app/(app)/candidates/page.tsx",
    "app/p/register/[token]/page.tsx",
    "app/p/enrol/page.tsx",
  ];
  const missing = [];
  const freeText = [];
  for (const rel of doors) {
    const src = stripComments(fs.readFileSync(path.join(root, rel), "utf-8"));
    if (!/GeographyFields/.test(src)) missing.push(rel);
    // an <input> bound to any of the three fields is the shape that was replaced
    if (/<input[^>]*value=\{form\.(state|district|sub_district)/.test(src)) freeText.push(rel);
  }
  const endpoint = fs.existsSync(path.join(root, "app/api/public/geography/route.ts"));
  const data = fs.existsSync(path.join(root, "data/lgd-geography.json"));
  if (!missing.length && !freeText.length && endpoint && data) passed++;
  else {
    failed++;
    pushStructural("candidate intake: the State/District/Sub-district cascade is not on every intake door"
      + " (no GeographyFields=" + JSON.stringify(missing)
      + ", still free text=" + JSON.stringify(freeText)
      + ", public endpoint=" + endpoint + ", bundled LGD list=" + data + ")"
      + " - these fields feed the government portal, and a door left on free text is a door that"
      + " keeps producing spellings SIDH will not accept. Three copies of one field group is the"
      + " QA-271 shape, which is why this pin counts DOORS and not the one that was edited.");
  }
}

// ---- -223 (QA-825/QA-828): "the batch is finished" may NEVER be decided by a permission ----
// A client outage, and mine. -216/-217 folded two facts into one name:
//     const closed = ["Completed","Cancelled"].includes(batch?.status) || !mayMarkTab;
// `closed` is correct for `disabled=`. It is WRONG for deciding what renders and WRONG for choosing
// a sentence, and it was doing both. The marking grid's ONLY door rendered on `!closed`, so a person
// without `closure.manage` got no door at all - and four places told them "the batch is finished"
// while the header showed the Active chip. Three client-visible symptoms, one expression.
//
// The SHAPE is pinned, not the wording: a batch-finished sentence must be reached only through a
// term built from `batch?.status` ALONE, and the grid's door must render on that same term.
// Counting the sentences would not have caught this - all four read correctly and all four were
// reached by the wrong test.
//
// (The first draft of this very pin measured the wrong thing: it rejected the status-only term
// because `/can[A-Z(]/i` matched the "Can" in "Cancelled". A pin that fails on correct code is as
// useless as one that passes on broken code, which is why it was run before being believed.)
{
  const rel = "app/(app)/batches/[id]/page.tsx";
  const src = stripComments(fs.readFileSync(path.join(root, rel), "utf-8"));

  // 1. a status-only term must EXIST and must not smuggle a permission into itself.
  const decl = /const\s+statusClosedTab\s*=\s*([^;]+);/.exec(src);
  const body = decl ? decl[1] : "";
  const statusOnly = Boolean(decl) && /batch\?\.status/.test(body)
    && !/mayMark|canClose|permsReady|closeTabReady|\bcan\(/.test(body);

  // 2. EVERY batch-finished sentence is reached only through a status-only term. Walk each
  //    occurrence and read the gate that sits in front of it.
  const SENT = "the batch is finished";
  const gates = [];
  for (let i = src.indexOf(SENT); i >= 0; i = src.indexOf(SENT, i + 1)) {
    gates.push(src.slice(Math.max(0, i - 170), i));
  }
  const badGate = gates.filter((g) => !/statusClosedTab|batchClosedByStatus/.test(g));

  // 3. the grid's only door renders on the batch's state, not on this person's rights.
  const doorOnStatus = /actions=\{legacy && !perCandidate && !statusClosedTab \?/.test(src);

  // 4. and the sign-off button reads the SAME inert term every other control on the card reads,
  //    or it renders enabled and 403s - the class that has now shipped eight times.
  const markGates = [...src.matchAll(/disabled=\{([^}]*?)\}>Mark Completed<\/Btn>/g)].map((m) => m[1]);
  const markUngated = markGates.filter((g) => !/\bclosed\b/.test(g));

  const ok = statusOnly && gates.length >= 4 && badGate.length === 0
    && doorOnStatus && markGates.length >= 2 && markUngated.length === 0;
  if (ok) passed++;
  else {
    failed++;
    pushStructural(rel + ": a batch-finished sentence, or the marking grid's door, is decided by a"
      + " term that mixes the batch's state with this person's rights"
      + " (status-only term declared=" + statusOnly
      + ", finished-sentences found=" + gates.length
      + ", wrongly gated=" + badGate.length
      + ", door on status=" + doorOnStatus
      + ", Mark Completed buttons=" + markGates.length + " of which ungated=" + markUngated.length + ")"
      + " - a person without the right then reads that an ACTIVE batch is finished, and the door to"
      + " the marking grid disappears instead of opening read-only. That took pass/fail marking and"
      + " certificate upload away from five live users for a day.");
  }
}

// ---- -223: every date the Closure card SHOWS is a date it SENDS, and both copies agree ----
// The card renders six date inputs; `Save` sent two. mock_test_date, result_expected_date,
// certificate_distribution_date and sidh_uploaded_on were on the model AND in the server's PUT
// allow-list, and no client payload ever carried them - so an operator typed a date, pressed Save,
// and watched load() overwrite it from the server. Silent data loss, never filed.
// The cause was FOUR hand-written patch literals. So the pin refuses the CAUSE: one list, one
// builder, every call site through it, and the client's list must be a subset of the server's -
// two allow-lists drifting apart is what QA-522 was, one layer out.
{
  const rel = "app/(app)/batches/[id]/page.tsx";
  const src = stripComments(fs.readFileSync(path.join(root, rel), "utf-8"));
  const srvRel = "app/api/batches/[id]/closure/route.ts";
  const srv = stripComments(fs.readFileSync(path.join(root, srvRel), "utf-8"));

  const decl = /const\s+CLOSURE_DATE_FIELDS\s*=\s*\[([^\]]*)\]/.exec(src);
  const names = decl ? [...decl[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]) : [];
  // every date input the card renders must be in that list
  const rendered = [...src.matchAll(/toInputDate\(form\.([a-z_]+)\)/g)].map((m) => m[1]);
  const shownNotListed = [...new Set(rendered)].filter((f) => !names.includes(f));
  // …and every listed field must be one the server will actually accept
  const notAccepted = names.filter((f) => !srv.includes('"' + f + '"'));
  // …and no saveClosure call may hand-write a date literal instead of using the builder
  const calls = [...src.matchAll(/saveClosure\(\{([^;]*?)\}\)/g)].map((m) => m[1]);
  const handWritten = calls.filter((c) => /[a-z_]*_date:|sidh_uploaded_on:/.test(c) && !/closureDatePatch\(/.test(c));

  const ok = names.length === 6 && shownNotListed.length === 0 && notAccepted.length === 0
    && handWritten.length === 0;
  if (ok) passed++;
  else {
    failed++;
    pushStructural(rel + ": a date the Closure card shows is not a date it sends"
      + " (fields listed=" + names.length
      + ", shown but unlisted=" + JSON.stringify(shownNotListed)
      + ", listed but the server will not accept=" + JSON.stringify(notAccepted)
      + ", saveClosure calls hand-writing a date instead of the builder=" + handWritten.length + ")"
      + " - the operator types the date, presses Save, and load() overwrites it from the server."
      + " Four of six were lost this way and nobody filed it, because no assertion in this repo"
      + " renders the card and no API test can see a field the client never sends.");
  }
}

// ---- -223: a failed fetch must never read as an empty answer ----
// Three instances of this on ONE screen, and each cost something different:
//   * loadBlockers 403s for anyone without `batches.manage`, the failure was swallowed, `blockers`
//     became null, and `(blockers?.unmarked?.length ?? 0) > 0` went FALSE - so LESS permission made
//     the sign-off button MORE pressable. It rendered enabled and 403'd on press.
//   * activity.tsx swallowed its error and printed "No activity recorded.", making a 403
//     indistinguishable from an empty history - on the very surface used to answer "who did this".
// Both must distinguish "could not load" from "loaded, and empty", and the first must disable.
{
  const rel = "app/(app)/batches/[id]/page.tsx";
  const src = stripComments(fs.readFileSync(path.join(root, rel), "utf-8"));
  const act = stripComments(fs.readFileSync(path.join(root, "components/activity.tsx"), "utf-8"));

  const blockersFlagged = /setBlockersFailed\(true\)/.test(src) && /blockersFailed/.test(src);
  const marks = [...src.matchAll(/disabled=\{([^}]*?)\}>Mark Completed<\/Btn>/g)].map((m) => m[1]);
  const marksReadFlag = marks.length >= 2 && marks.every((m) => /blockersFailed/.test(m));
  // a bare swallow anywhere in the activity component is the defect itself
  const bareSwallow = /\.catch\(\(\)\s*=>\s*\{\s*\}\)/.test(act);
  const actFlags = /setFailed\(true\)/.test(act);

  if (blockersFlagged && marksReadFlag && !bareSwallow && actFlags) passed++;
  else {
    failed++;
    pushStructural("Closure tab / activity: a failed fetch is being read as an empty answer"
      + " (blocker failure tracked=" + blockersFlagged
      + ", Mark Completed buttons reading it=" + marks.filter((m) => /blockersFailed/.test(m)).length + "/" + marks.length
      + ", activity.tsx still swallows bare=" + bareSwallow
      + ", activity.tsx tracks failure=" + actFlags + ")"
      + " - a 403 then looks like 'nothing pending' or 'no history', which enabled a button the"
      + " server refuses and turned the audit trail into unusable evidence.");
  }
}

{
  // QA-377: the registers must ACCOUNT FOR EVERY HIT. A raise site that forgets to classify is
  // exactly how this check misfiled twice; now it cannot be forgotten silently, because an
  // unclassified finding fails this file rather than being quietly summarised as copy drift.
  const unclassified = hits.map((_, n) => n).filter((n) => !structuralIdx.has(n) && !copyIdx.has(n));
  if (unclassified.length) {
    failed++;
    for (const n of unclassified) {
      structuralIdx.add(n);
      hits.push('check-user-copy.mjs: finding #' + n + ' was raised through a bare hits.push and is in neither register - classify it with pushStructural() or pushCopy() (QA-377).');
      structuralIdx.add(hits.length - 1);
    }
  }
// ---- -225: how the BATCH-CODE PREFIX is spelled - two byte-identical copies, and the map did not
// know. nextBatchCode() builds `${Location.code}-${Program.code}-NN`, and both of those codes are
// MINTED upstream by the same three pieces of logic written out TWICE: the app route
// api/admin/avpl-rebase and the script scripts/seed-rpl.mjs. The route's own header admits it -
// "the parsing rules are kept in lockstep with that script" - and "kept in lockstep" by hand is the
// disease ARCHITECTURE section 3 is a list of. A drift in either copy silently re-partitions every
// prefix in the product: the same institution starts minting under a different centre code, its old
// batches keep the old prefix, and the numbering restarts at -01 with nothing on any screen to say
// why. They CANNOT be collapsed - a Next route cannot import from scripts/ and the script cannot
// import the route - so they are pinned, exactly as reparse-govt-hours' hhmmssToMinutes copy is.
{
  const routeRel = "app/api/admin/avpl-rebase/route.ts";
  const routeSrc = fs.readFileSync(path.join(root, routeRel), "utf-8");
  const seedRel = "scripts/seed-rpl.mjs";
  const seedSrc = fs.readFileSync(path.join(root, "..", "scripts", "seed-rpl.mjs"), "utf-8");
  // The only legitimate difference between the two is TypeScript annotation, so strip exactly that
  // before comparing - never normalise anything that could hide a real change.
  const deTs = (t) => t.replace(/: Record<string, (?:string|number)>/g, "").replace(/\((\w+): (?:string|unknown)\)/g, "($1)");
  let bad = 0;

  // (a) JOB_ROLE_CODES - the second half of every programme code (DST, BSRT, SPIT, DSWT).
  const roles = (t) => ((t.split("JOB_ROLE_CODES")[1] ?? "").split("};")[0].match(/"([^"]+)":\s*"([^"]+)"/g) ?? []).join("|");
  if (!roles(routeSrc) || roles(routeSrc) !== roles(seedSrc)) {
    bad++;
    pushStructural(routeRel + ": JOB_ROLE_CODES has drifted from " + seedRel + " - the two mint different programme codes, so the same job role would get two different batch-code prefixes");
  }

  // (b) slug() - the centre code itself ("Govt. ITI Charthwal, Muzaffarnagar" -> "MUZ-CHAR").
  const slugBody = (t) => deTs((t.split("const slug = ")[1] ?? "").split("};")[0]).replace(/\s+/g, " ").trim();
  if (!slugBody(routeSrc) || slugBody(routeSrc) !== slugBody(seedSrc)) {
    bad++;
    pushStructural(routeRel + ": slug() has drifted from " + seedRel + " - the two mint different CENTRE codes, which silently re-partitions every batch-code prefix");
  }

  // (c) the programme-code formula itself (scheme letters, first 6, + the job-role code).
  const formula = (t) => (t.match(/code:\s*`\$\{scheme[^`]*`/) ?? [""])[0].replace(/\s+/g, " ");
  if (!formula(routeSrc) || formula(routeSrc) !== formula(seedSrc)) {
    bad++;
    pushStructural(routeRel + ": the programme-code formula has drifted from " + seedRel);
  }

  if (bad) failed++; else passed++;
}

// ---- -232 (QA-946): the Sync Inbox action vocabulary, and the ONE place it is allowed to live ----
//
// The drawer used to carry its own copy of the seven actions, plus two more hardcoded subsets for
// the reason label and the follow-up warning. The apply door in lib/sync.ts accepts at most one of
// the top two on any row (`Update target` needs a "<field>:<CODE>" row, `Apply value` needs a bare
// one - exact complements), so a copy that could not see the row's kind put a guaranteed-400 option
// at the top of every dropdown. Umesh hit it on a `tc_password` row.
//
// Two pins, because the two halves fail differently:
//   (a) the page must not re-grow a lifecycle vocabulary of its own;
//   (b) classifyChange must describe EVERY action the schema enum names - an action added to
//       SHEET_CHANGE_ACTION and not here does not become a wrong option, it silently stops being
//       offered at all, which is the quieter and worse failure.
{
  const syncPage = stripComments(fs.readFileSync(path.join(root, "app/(app)/sync/page.tsx"), "utf8"));

  // (a) The four lifecycle actions are decided server-side now. `Update target` / `Apply value`
  // are deliberately NOT in this list: the row-actions column still names that pair for REVERT,
  // which is a different question (what can be undone) answered by a different route, and pinning
  // it here would make this check lie about what it is protecting.
  const LIFECYCLE = ["Start location", "Put on hold", "Stop location", "Close location"];
  const leaked = LIFECYCLE.filter((a) => syncPage.includes('"' + a + '"') || syncPage.includes("'" + a + "'"));
  if (!leaked.length) passed++;
  else {
    failed++;
    pushStructural("app/(app)/sync: the drawer names " + JSON.stringify(leaked) + " itself again - QA-946. Which action fits a row is decided by classifyChange in lib/sync.ts and travels in the GET payload, because the apply door refuses through that same predicate. A second copy here is how a guaranteed-400 option sat at the top of every row's dropdown with nothing on screen saying so.");
  }

  // …and it must be reading the server's verdicts, not an array it rebuilt under another name.
  const readsVerdicts = /actions/.test(syncPage) && /recommended/.test(syncPage) && /requires_note/.test(syncPage);
  if (readsVerdicts) passed++;
  else { failed++; pushStructural("app/(app)/sync: the drawer no longer reads the per-row action verdicts (actions / recommended / requires_note) from the API - QA-946. Without them the Action list cannot say which option this row accepts, which is the whole defect."); }

  // (b) every schema action has a description, and the emitted order comes from the enum.
  const syncLib = fs.readFileSync(path.join(root, "lib/sync.ts"), "utf8");
  const modelsSrc = fs.readFileSync(path.join(root, "models/index.ts"), "utf8");
  const enumLine = modelsSrc.match(/SHEET_CHANGE_ACTION = \[([^\]]+)\]/);
  const enumActions = enumLine ? [...enumLine[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  const byActionBlock = syncLib.slice(syncLib.indexOf("const byAction"), syncLib.indexOf("return SHEET_CHANGE_ACTION.map"));
  const undescribed = enumActions.filter((a) => !byActionBlock.includes('"' + a + '"'));
  if (enumActions.length === 7 && !undescribed.length) passed++;
  else {
    failed++;
    pushStructural("lib/sync classifyChange: " + JSON.stringify(undescribed) + " of the " + enumActions.length + " SHEET_CHANGE_ACTION values have no verdict - QA-946. An action the schema accepts and this map does not describe is not offered on any row at all, and nothing else on the screen would show that it went missing.");
  }

  // The refusals must come from the verdict, not from their own sentences - that is what makes the
  // door's 400 and the drawer's disabled option the same words.
  // Pinned on the PROPERTY, not on a variable name: cycle 2 renamed the argument from `change`
  // to a `facts` bundle (it now carries the pending-follow-ups count and the target-row
  // existence the predicate needs), and a name-shaped pin failed on a change that made the
  // thing it protects STRONGER. What matters is that each guard asks verdictFor for the action
  // it is about to run, and that neither hand-written refusal has crept back.
  const codeOnly = syncLib.replace(/\/\/[^\n]*/g, "");
  const asks = (a) => new RegExp('verdictFor\\([A-Za-z_$][\\w$]*, "' + a + '"\\)').test(codeOnly);
  const refusalsShared = asks("Update target") && asks("Apply value")
    && asks("No action")                                   // QA-986: Rule 7 on the SINGLE-row door
    && !/"Not a target-row change\."/.test(codeOnly)
    && !/cannot be written by Apply value/.test(codeOnly);
  if (refusalsShared) passed++;
  else { failed++; pushStructural("lib/sync: the apply door no longer refuses THROUGH classifyChange - QA-946. When the door writes its own refusal, the sentence the screen shows and the sentence the server returns can disagree, and the one a person reads is whichever they hit first."); }

  // QA-987 (checker on qa-234 cycle 1): the cleared-value wording was applied to the DRAWER and
  // not to the LIST cell, so half of QA-668 was closed while the surface QA-668's own report
  // names FIRST stayed broken. The helper exists precisely so both surfaces say one thing; a
  // single call site means somebody is again rendering a blank as a blank in only one place.
  const shownValueCalls = (syncPage.match(/shownValue\(/g) ?? []).length;
  const rawNewValueRender = /<b>\{review\.new_value\}<\/b>|<b>\{r\.new_value\}<\/b>/.test(syncPage);
  if (shownValueCalls >= 2 && !rawNewValueRender) passed++;
  else {
    failed++;
    pushStructural("app/(app)/sync: a cleared sheet value is not named as cleared on every surface - shownValue() is called " + shownValueCalls + " time(s) (the two call sites that matter are the drawer and the list cell) and a raw {new_value} render is " + (rawNewValueRender ? "still present" : "absent") + " - QA-987 / QA-668. A blank that prints as empty space is the defect: the list is what a reviewer scans, and 'Apply value' writes that invisible blank into the record.");
  }

  // QA-989 (same verdict): the Revert button must not carry its own copy of what can be undone.
  // The page's copy was looser than revert/route.ts, so every applied tc_status:/tc_id: row
  // rendered a button that answered 400 after the user confirmed.
  const revertShared = /r\.revert\?\.ok/.test(syncPage)
    && !/\["Update target", "Apply value"\]\.includes\(r\.action_taken\)/.test(syncPage)
    && /canRevert/.test(fs.readFileSync(path.join(root, "app/api/sheet-changes/[id]/revert/route.ts"), "utf8"))
    && /export function canRevert/.test(syncLib);
  if (revertShared) passed++;
  else { failed++; pushStructural("app/(app)/sync + api/sheet-changes/[id]/revert: whether an applied change can be put back is decided in two places again - QA-989. The page used to test action_taken itself while the door additionally required 'approved_target:', so a tc_status row showed a Revert button, took the confirm, and then refused with 'Not a target change.' - the sibling of the very sentence this unit replaced."); }
}

// ---- QA-976 (-232 cycle 2, checker): a report lane the API returns and no screen renders ----
//
// Cycle 2 added THREE report lanes to the candidate importer and rendered NONE of them, then
// defended a 17-of-20 row loss with "the operator is warned before confirming". They were not: the
// server said it and the drawer never repeated it. The checker proved it with a control — the
// portal-CAN lane, same response, same drawer, renders fine.
//
// This pin is deliberately a CLASS pin, not three instance pins. The failure was not "I forgot
// apaar_duplicate"; it was "nothing makes a lane's renderer mandatory". So: every `*_count` key the
// import route puts in its payload must be referenced by the import drawer. A lane added next month
// is covered without anyone remembering this.
{
  const importSrc = fs.readFileSync(path.join(root, "app/api/candidates/import/route.ts"), "utf-8");
  const drawerSrc = fs.readFileSync(path.join(root, "app/(app)/candidates/page.tsx"), "utf-8");
  const lanes = [...new Set([...importSrc.matchAll(/(\w+_count)\s*:/g)].map((m) => m[1]))];
  const unrendered = lanes.filter((k) => !drawerSrc.includes(k));
  if (lanes.length === 0) {
    failed++;
    pushStructural("check-user-copy: found NO *_count report lanes in the candidate import route — this pin has stopped measuring anything, which is worse than a failure");
  } else if (unrendered.length) {
    failed++;
    pushStructural(
      `candidates import: ${unrendered.length} of ${lanes.length} report lane(s) are returned by the API and rendered NOWHERE in the import drawer — ` +
      `${unrendered.join(", ")}. The operator is told nothing, so any claim that they were "warned before confirming" is false.`,
    );
  } else {
    passed++;
  }
}

  // -175: every finding, printed once, AFTER every check has had its say. See the note where this
  // loop used to live.
  for (const h of hits) console.log("  ✗ " + h);
  const copyHits = hits.filter((h, n) => copyIdx.has(n));
  const structural = hits.length - copyHits.length;
  // no escape sequences in these template literals on purpose: the last two attempts at this file
  // wrote a backspace byte and then a real newline into the source (-144, and this line).
  if (hits.length) console.log("");
  if (copyHits.length) console.log(copyHits.length + ' user-facing string(s) still carry a Rule/DEC/QA code - rewrite as "what happened + what to do".');
  if (structural) console.log(structural + ' structural finding(s) above are NOT copy problems - read the line, not this summary.');
}



console.log(`\ncheck-user-copy: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
