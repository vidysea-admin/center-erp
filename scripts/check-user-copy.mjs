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
          || /=>\s*!/.test(a) || /^!/.test(a) || /\?\s*null\s*:/.test(a) || /:\s*null\s*$/.test(a));
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

  // -156 (QA-434): QA-410 taught the VERDICT to say only what the row holds - "the export carries a
  // row under this name but its hours column could not be read" - and two sibling tooltips in this
  // same page went on asserting hours unconditionally, and asserting they were THIS student's while
  // two people shared the name. A tooltip is a sentence; it is held to the sentence's standard.
  // -159 (QA-472): THE CLASS, not the instance. This page carries four tooltips that name people -
  // the complete-batch plan, the assessment blocker, the certification blocker and the portal-ID
  // line - and -158 fixed one of them, which is how "Sachin Kumar, Sachin Kumar" survived one line
  // above the tooltip that had just stopped saying it. Any title built by mapping rows to a bare
  // .name is the defect, wherever it appears; personLabel/personList is the one definition.
  {
    const bare = stripComments(bp).split(/\r?\n/)
      .filter((l) => /title=\{/.test(l) && /\.map\(/.test(l) && /\.name\b/.test(l) && !/personLabel|personList/.test(l));
    if (!bare.length) passed++;
    else {
      failed++;
      pushCopy(`app/(app)/batches/[id]/page.tsx: ${bare.length} tooltip(s) still name people by bare name, so two students of one name read identically - use the shared personList() (QA-472)`);
    }
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

for (const h of hits) console.log("  ✗ " + h);
// -149 (QA-324): this file started as one check and now carries several - the ASI trap, the
// drawer ceiling, the scope-collision scan. Every finding was summarised as "user-facing
// string(s) still carry a Rule/DEC/QA code", so a scope leak was reported as a copy problem and
// the suggested fix was to rewrite a sentence. A summary that misnames what it found sends the
// reader to the wrong place, which is the same defect this file exists to catch.
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
