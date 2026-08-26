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

  // -251 (QA-289, S1): the Locations LIST must never carry a live portal credential - for ANYONE,
  // the Admin included. The old gate was `maskLocationSecrets(items, user.role === "Admin")`, which
  // answered WHO may see it and never WHETHER it belongs on an unasked screen; for an Admin the
  // answer was permanently yes, on a grid of every centre, in every screenshot.
  //
  // This pin exists because the SEVEN behavioural pins for this unit sit in scripts/e2e-roles.mjs,
  // which cannot be committed - it also carries another session's uncommitted work, and committing
  // it would ride their unit into this one. So QA-289 would otherwise ship with NO guard at all
  // (the cycle-1 checker said exactly that). The list call must pass a LITERAL false; a role
  // expression there is the defect returning.
  {
    const locSrc = fs.readFileSync(path.join(root, "app/api/locations/route.ts"), "utf-8");
    const listCall = /maskLocationSecrets\(\s*items\s*,\s*false\s*[,)]/.test(locSrc);
    const roleGated = /maskLocationSecrets\(\s*items\s*,\s*user\.role/.test(locSrc);
    if (listCall && !roleGated) passed++;
    else { failed++; pushStructural(`app/api/locations/route.ts: the LIST must call maskLocationSecrets(items, false, …) — a role expression there puts every centre's live tc_password back in the list payload (QA-289)`); }
  }

  // -251 (QA-1319, S1): both doors onto FollowUpAction must MASK the SheetChange they populate.
  // They populated `source_change` whole - no select, no mask - so a live tc_password reached a
  // non-Admin Operations login on the LANDING PAGE, with nothing opened. The behavioural pins for
  // this live in e2e-roles.mjs and are VACUOUS on a fixture with no pending secret-bearing
  // follow-up, which this project has no API to create. So the guard that cannot go vacuous is
  // this one: the call has to be there, in both files, or the leak is back and nothing says so.
  for (const rel of ["app/api/home/route.ts", "app/api/follow-ups/route.ts"]) {
    const s = fs.readFileSync(path.join(root, rel), "utf-8");
    const populatesSourceChange = /populate\(\s*\{[^}]*path:\s*"source_change"/.test(s);
    // -251 (QA-1351, the checker's cycle-1 FAIL, and it was right): this asked only whether the FILE
    // mentions maskSheetChange anywhere. app/api/home/route.ts already called it at :324 for a
    // DIFFERENT queue, so the assertion passed with the follow-up door reverted to its leaking state
    // - 317/0 either way. A guard that cannot go red is worse than no guard, because the manifest
    // then cites it as the thing covering the vacuous behavioural pins. It was the only guard on the
    // landing-page S1.
    // The shape below is specific to masking THIS field: `source_change: maskSheetChange(`. The
    // pre-existing :324 call is `maskSheetChange(c, false)` inside a .map and does not match it.
    // -251 cycle 3 (QA-1353, raised by the cycle-2 checker): the shape test above never looked at
    // the SECOND argument, so `source_change: maskSheetChange(f.source_change, user.role === "Admin")`
    // read green - and that is THIS UNIT'S OWN DEFECT SHAPE. Role-gating the mask is precisely what
    // QA-289 was: an Admin keeps seeing the credential on an unasked surface, while the guard says
    // the door is closed. The sibling pin twelve lines above already refused a role expression
    // (`roleGated`); this one did not, and an asymmetry between two guards written in one sitting is
    // how the next author concludes the looser one is deliberate.
    const masks = /source_change:\s*maskSheetChange\s*\([^)]*,\s*false\s*\)/.test(s);
    const maskRoleGated = /source_change:\s*maskSheetChange\s*\([^)]*,\s*[^)]*\.role/.test(s);
    if (!populatesSourceChange || (masks && !maskRoleGated)) passed++;
    else { failed++; pushStructural(`${rel}: populates source_change without calling maskSheetChange — a live tc_password rides out of this list (QA-1319)`); }
  }

  // -251 (QA-1350, S1): crud.ts's itemRoutes PATCH replied with the raw saved document while its
  // own GET, three lines above it, ran the same record through cfg.mapItems first. Three of the
  // four itemRoutes entities use mapItems to mask a real secret - locations' tc_password, trainers'
  // SENSITIVE_FIELDS, programs' contract_amount - so any PATCH through this shared door handed the
  // writer their own edit back WITH the secret unmasked, even when their role could not see it via
  // GET (writeRoles and the mask's reveal check are separate axes here: locations gates the WRITE
  // on the togglable `locations.manage` permission but gates the REVEAL on `role === "Admin"`, so a
  // non-Admin holder of that permission could write and get the password back in the same response
  // that never appears on any screen they can open). Fixed once, in the shared function, rather than
  // per-route - the region below is `const PATCH = apiHandler(` through its matching `return { GET,
  // PATCH };`, so a fix landing on a DIFFERENT entity's route file cannot satisfy this pin.
  {
    const crudSrc = fs.readFileSync(path.join(root, "lib/crud.ts"), "utf-8");
    const start = crudSrc.indexOf("const PATCH = apiHandler(");
    const end = crudSrc.indexOf("return { GET, PATCH };", start);
    const region = start >= 0 && end > start ? stripComments(crudSrc.slice(start, end)) : "";
    // Anchored to the RETURN, not just "mentions mapItems anywhere" - QA-1351's exact lesson one
    // pin up: cfg.mapItems is already read once above (for beforeUpdate-adjacent logic in some
    // configs is not the case here, but the principle holds) so a bare substring match would be
    // satisfied by an unrelated read. The return statement must build its `item` from a variable
    // that mapItems assigned to, not from `existing` directly.
    // Broadened after my OWN mutation caught it: this first required literally `if (cfg.mapItems)`,
    // which false-reds a correct `cfg.mapItems ? await cfg.mapItems(...) : existing` ternary rewrite -
    // a shape difference, not a behaviour difference. What matters is that mapItems gets AWAITED
    // somewhere in the region and the reply does not build `item` from `existing` directly.
    const callsMapItems = /await\s+cfg\.mapItems\(/.test(region);
    const returnsRaw = /NextResponse\.json\(\{\s*item:\s*existing\b/.test(region);
    if (region.length > 0 && callsMapItems && !returnsRaw) passed++;
    else { failed++; pushStructural(`lib/crud.ts: itemRoutes' PATCH must run its saved record through cfg.mapItems before replying, the same as its own GET does — otherwise a masked secret (locations' tc_password, trainers' pay fields, programs' contract_amount) rides out in the writer's own PATCH response (QA-1350)`); }
  }

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
  // QA-1165: a state is "named" ONLY when the sentence reads THAT STATE'S OWN BUCKET.
  //
  // This used to accept `attMeta.<state>_rows` as a phrase too, and that one line is why this pin
  // could not fail on the defect it exists for. The page says it plainly two comments below:
  // `awaiting_match_rows` is NOT `verdict_counts.awaiting_match`. The bucket is journey-gated; the
  // rows count is ungated and CUTS ACROSS the buckets ("every name in it is ALSO counted in one of
  // the groups above"). They are different numbers about different sets.
  //
  // So a sentence could exclude `awaiting_match` from the generic arm, give it no phrase at all, and
  // still pass here because a DIFFERENT number happened to carry a similar name. That is precisely
  // what shipped: on CHI-ITI-RPLAVP-BSRT-01 the line read "0 qualified - 41 still short - 2 not
  // enrolled yet" = 43 under a chip saying "All 45", with the missing 2 being that bucket - live,
  // under a green pin. A checker proved it by mutation twice (pre-fix page: 297/0; post-fix minus
  // only the new branch: 297/0), which is the only way this class of hole ever shows itself.
  //
  // A cross-cutting count is not a bucket's phrase. If a future line wants to name one, it must
  // still print the bucket as well.
  const named = new Set(
    [...summary.matchAll(/verdict_counts\.([a-z_]+)/g)].map((m) => m[1]),
  );
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
  // QA-1087 (DRY roadmap unit 1, 2026-08-25): exactly ONE declaration of canonicalPhone may exist
  // in src/, and it must be lib/validate.ts - the STRICT canon ("12345" -> null, the caller
  // refuses). A second one lived in lib/rules.ts for four releases: same name, INVERTED contract
  // ("12345" came back "12345"), zero callers - residue of the -191 plan-share key that -195/QA-618
  // removed. The hazard was never the dead code; it was the import: every call site writes
  // `canonicalPhone(x)!`, which compiles unchanged against the loose copy and stores an unvalidated
  // fragment as a phone of record - the -126 defect one auto-import away. Declaration-matched, not
  // word-matched: the identifier appears in ~8 comments (validate.ts's own header included) and in
  // a version.ts release-note string, and a pin that cannot tell code from a comment about the code
  // is not a check (ARCHITECTURE 3.2c). SKIP_FILES honoured for the same reason.
  {
    const DECL = /(?:^|[^.\w])(?:export\s+)?(?:function\s+canonicalPhone\s*\(|const\s+canonicalPhone\s*=)/;
    const homes = [];
    for (const abs of walk(root)) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (SKIP_FILES.has(rel)) continue;
      const code = stripComments(fs.readFileSync(abs, "utf-8"));
      if (DECL.test(code)) homes.push(rel);
    }
    if (homes.length === 1 && homes[0] === "lib/validate.ts") passed++;
    else {
      failed++;
      pushStructural(
        `canonicalPhone is declared in ${homes.length} file(s) [${homes.join(", ")}] - its only home is lib/validate.ts (strict: refuses what is not a 10-digit mobile). A second declaration under this name is how an unvalidated phone reaches the database with every call site still compiling: the deleted rules.ts copy had the OPPOSITE contract and zero callers, and `+"`canonicalPhone(x)!`"+` reads identically against either (QA-1087).`,
      );
    }
  }
  // QA-1103 (DRY roadmap unit D2, 2026-08-25): parseSheetDate exists TWICE on purpose and the two
  // disagree on the YEAR. lib/rules.ts:166 handles Excel serials/ISO/day-first, range-validates,
  // and returns null so the caller can REPORT by row; lib/field-catalog.ts:29 parses "6th July"
  // and INVENTS the current year. Same name, same signature - a crossed import compiles silently
  // and changes which year a dob or planned_start lands in. The merge is roadmap unit D12 and is
  // GATED on two Umesh decisions (D-1 year rule, D-2 module home); until then this pin freezes the
  // blast radius: the census (exactly these two declarations), the wiring (each caller on its own
  // parser), and the purity of the SECOND import-free module (field-catalog is client-imported at
  // candidates/page.tsx - one added import there breaks the candidates page, the same property
  // the validate.ts pin below guards for the first one).
  {
    const DECL = /(?:^|[^.\w])(?:export\s+)?(?:function\s+parseSheetDate\s*\(|const\s+parseSheetDate\s*=)/;
    const declHomes = [];
    for (const abs of walk(root)) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (SKIP_FILES.has(rel)) continue;
      const code = stripComments(fs.readFileSync(abs, "utf-8"));
      if (DECL.test(code)) declHomes.push(rel);
    }
    const censusOk = declHomes.length === 2 && declHomes.includes("lib/rules.ts") && declHomes.includes("lib/field-catalog.ts");
    if (censusOk) passed++;
    else {
      failed++;
      pushStructural(
        `parseSheetDate is declared in [${declHomes.join(", ") || "nowhere"}] - the census is exactly TWO, lib/rules.ts + lib/field-catalog.ts (deliberately different year semantics, ARCHITECTURE 3.4). A third copy is the seventh-spelling disease; a lost one strands its callers on the wrong parser (QA-1103).`,
      );
    }
    const WIRES = [
      ["lib/tab-mapping.ts", "@/lib/field-catalog"],
      ["app/api/candidates/import/route.ts", "@/lib/rules"],
      ["app/api/batches/import/route.ts", "@/lib/rules"],
    ];
    const crossed = [];
    for (const [rel, want] of WIRES) {
      const code = stripComments(fs.readFileSync(path.join(root, rel), "utf-8"));
      const froms = [...code.matchAll(/import\s*(?:type\s*)?\{[^}]*?\bparseSheetDate\b[^}]*?\}\s*from\s*"([^"]+)"/g)].map((m) => m[1]);
      if (froms.length !== 1 || froms[0] !== want) crossed.push(`${rel} imports parseSheetDate from [${froms.join(", ") || "nowhere"}], expected "${want}"`);
    }
    if (!crossed.length) passed++;
    else {
      failed++;
      pushStructural(
        `parseSheetDate wiring crossed: ${crossed.join("; ")}. The two parsers disagree on which YEAR a spoken date lands in, and a crossed import compiles without a murmur (QA-1103).`,
      );
    }
    const fcCode = stripComments(fs.readFileSync(path.join(root, "lib/field-catalog.ts"), "utf-8"));
    if (!/^\s*import\s/m.test(fcCode)) passed++;
    else {
      failed++;
      pushStructural(
        `lib/field-catalog.ts now contains an import statement - it is the SECOND import-free pure module (client screens import it, candidates/page.tsx first among them) and one added import there breaks every one of them at compile (QA-1103; the same charter lib/validate.ts holds).`,
      );
    }
  }
  // QA-1123 (DRY roadmap unit D3, 2026-08-25): "the IST calendar day" is written in exactly TWO
  // places and they are DIFFERENT FUNCTIONS on purpose - lib/client.ts istTodayInput (what a date
  // input's max= wants) and lib/rules.ts istToday (what the server compares against). They are the
  // two sides of ONE date field: pinned EQUAL, never merged (the client cannot import rules.ts -
  // mongoose). A FOURTH inline copy of the client side was written in -235's own aftermath, in a
  // file already importing from lib/client, using the OTHER spelling of the same shift (330*60_000
  // vs 5.5*3600*1000) - so a grep for either function's body missed it. Three assertions:
  // (a) census - istTodayInput declared once, in lib/client.ts;
  // (b) no inline IST-shift (any spelling: 330*60_000, 5.5*3600*1000, bare 19800000) outside
  //     lib/client.ts and lib/rules.ts - rules.ts is a NAMED exclusion, it is the server twin
  //     (DO-NOT-MERGE list; an unnamed exclusion is how a pin gets narrowed to green, 3.0b);
  // (c) equality - the shift constants inside istTodayInput and istToday multiply out to the SAME
  //     milliseconds, so the two sides of the date field cannot drift apart silently.
  {
    const DECL = /(?:^|[^.\w])(?:export\s+)?(?:function\s+istTodayInput\s*\(|const\s+istTodayInput\s*=)/;
    const SHIFT = /Date\.now\(\)\s*\+\s*(330\s*\*\s*60_?000|5\.5\s*\*\s*3600\s*\*\s*1000|19_?800_?000)/;
    const declHomes = [];
    const inlineShifts = [];
    for (const abs of walk(root)) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (SKIP_FILES.has(rel)) continue;
      const code = stripComments(fs.readFileSync(abs, "utf-8"));
      if (DECL.test(code)) declHomes.push(rel);
      if (rel !== "lib/client.ts" && rel !== "lib/rules.ts" && SHIFT.test(code)) inlineShifts.push(rel);
    }
    if (declHomes.length === 1 && declHomes[0] === "lib/client.ts") passed++;
    else {
      failed++;
      pushStructural(
        `istTodayInput is declared in [${declHomes.join(", ") || "nowhere"}] - its only home is lib/client.ts. A local copy is how the fourth one hid: written in the OTHER shift spelling, in a file already importing from that module (QA-1123).`,
      );
    }
    if (!inlineShifts.length) passed++;
    else {
      failed++;
      pushStructural(
        `${inlineShifts.length} file(s) write an inline IST shift (330*60_000 / 5.5*3600*1000 / 19800000) instead of calling istTodayInput from @/lib/client: ${inlineShifts.join(", ")}. lib/rules.ts is the one named exclusion (istToday, the server twin) (QA-1123).`,
      );
    }
    const shiftMs = (file, fnRe) => {
      const code = stripComments(fs.readFileSync(path.join(root, file), "utf-8"));
      const i = code.search(fnRe);
      if (i < 0) return null;
      const m = code.slice(i, i + 400).match(/Date\.now\(\)\s*\+\s*([\d._*\s]+?)\)/);
      if (!m) return null;
      return m[1].replace(/_/g, "").split("*").map((s) => Number(s.trim())).reduce((a, b) => a * b, 1);
    };
    const clientMs = shiftMs("lib/client.ts", /function istTodayInput/);
    const rulesMs = shiftMs("lib/rules.ts", /function istToday\s*\(/);
    if (clientMs !== null && rulesMs !== null && clientMs === rulesMs) passed++;
    else {
      failed++;
      pushStructural(
        `the two sides of "the IST calendar day" disagree or cannot be read: istTodayInput (lib/client.ts) shifts by ${clientMs} ms, istToday (lib/rules.ts) by ${rulesMs} ms. Equal or red - a max= that refuses a date the server would take is how this class of bug reads to an operator (QA-1123).`,
      );
    }
  }
  // QA-1135 (DRY roadmap unit D4, 2026-08-25): which statuses HALT a centre (Rule 1) is ONE list,
  // exported from lib/rules.ts. Five inline copies existed only because the const was private.
  // NAMED exclusions this pin's regex cannot hit but the next person must not "fix": the 5-value
  // OPERATIONAL_STATUS in models/index.ts and its rendered copy in locations/[id]/page.tsx answer
  // a DIFFERENT question (what a status may be SET to - DO-NOT-MERGE #9); both begin with
  // "Not Started" so the exact 3-element literal below does not match them, and widening this
  // regex to catch subsequences would make it fail on those non-defects - which is how a pin gets
  // narrowed to uselessness by the next person (3.0b).
  {
    if (/(?:^|[^.\w])export\s+const\s+HALTED_LOCATION_STATUSES\s*=/.test(stripComments(fs.readFileSync(path.join(root, "lib/rules.ts"), "utf-8")))) passed++;
    else {
      failed++;
      pushStructural(`lib/rules.ts no longer EXPORTS HALTED_LOCATION_STATUSES - five importers depend on it; un-exporting strands them or, worse, invites the inline copies back (QA-1135).`);
    }
    const LIT = /\[\s*"On Hold"\s*,\s*"Stopped"\s*,\s*"Closed"\s*\]/;
    const copies = [];
    for (const abs of walk(root)) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (rel === "lib/rules.ts" || SKIP_FILES.has(rel)) continue;
      if (LIT.test(stripComments(fs.readFileSync(abs, "utf-8")))) copies.push(rel);
    }
    if (!copies.length) passed++;
    else {
      failed++;
      pushStructural(
        `${copies.length} file(s) write the halted-statuses literal ["On Hold","Stopped","Closed"] by hand instead of importing HALTED_LOCATION_STATUSES from @/lib/rules: ${copies.join(", ")}. The recorded failure of this class is a status added to the canon that silently does not halt one door (QA-1135).`,
      );
    }
  }
  // QA-1182 (DRY roadmap unit D5, 2026-08-25): CHIP_COLORS is a PROJECTION of TRAINER_PIPELINE,
  // not a copy of it — it also colours batch statuses, candidate journey states and schemes, so
  // "import the enum" is not the fix here (and ui.tsx is a client component; @/models pulls
  // mongoose). What IS checkable is TOTALITY, both directions:
  //   (1) every TRAINER_PIPELINE stage has a colour — a stage added to the enum and missed here
  //       greys out silently, which is the quieter and worse failure (the QA-946 lesson);
  //   (2) no CHIP_COLORS key LOOKS like a retired pipeline stage — three did until today
  //       ("Docs Requested", "Nominated to NSDC", "TOT Passed", all removed from the enum in the
  //       2026-08-14 rename), and they were the standing evidence that nobody was checking.
  // Direction (2) can only be a NAMED list, not a pattern: CHIP_COLORS legitimately holds dozens of
  // non-pipeline keys and no regex can tell "Result Awaited" (a real candidate state) from
  // "TOT Passed" (a retired stage). A named list is honest about being a named list.
  {
    const uiSrc = stripComments(fs.readFileSync(path.join(root, "components/ui.tsx"), "utf-8"));
    const modelsSrc = stripComments(fs.readFileSync(path.join(root, "models/index.ts"), "utf-8"));
    const pipeM = modelsSrc.match(/export const TRAINER_PIPELINE = \[([\s\S]*?)\]/);
    const chipM = uiSrc.match(/CHIP_COLORS:\s*Record<string,\s*string>\s*=\s*\{([\s\S]*?)\n\};/);
    if (!pipeM || !chipM) {
      failed++;
      pushStructural(`the CHIP_COLORS/TRAINER_PIPELINE totality check cannot find its subject (pipeline=${!!pipeM}, chips=${!!chipM}) - a parser that has lost its place must go RED, never green (QA-1182).`);
    } else {
      const stages = [...pipeM[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      const chipKeys = new Set([...chipM[1].matchAll(/"([^"]+)"\s*:/g)].map((m) => m[1]));
      const uncoloured = stages.filter((s) => !chipKeys.has(s));
      if (stages.length >= 8 && !uncoloured.length) passed++;
      else {
        failed++;
        pushStructural(
          uncoloured.length
            ? `${uncoloured.length} TRAINER_PIPELINE stage(s) have no CHIP_COLORS entry and will render GREY with no error: ${uncoloured.join(", ")} (QA-1182).`
            : `TRAINER_PIPELINE parsed to only ${stages.length} stages - the check has lost its subject rather than passed (QA-1182).`,
        );
      }
      // (2) retired stage names, by name — extend this list when a stage is renamed out of the enum.
      const RETIRED = ["Docs Requested", "Nominated to NSDC", "TOT Passed", "Ready to Train"];
      const zombies = RETIRED.filter((k) => chipKeys.has(k));
      if (!zombies.length) passed++;
      else {
        failed++;
        pushStructural(
          `CHIP_COLORS still colours ${zombies.length} RETIRED trainer stage(s): ${zombies.join(", ")}. They colour nothing and are the evidence that this map is not being read against the enum (QA-1182).`,
        );
      }
    }
  }
  // QA-1198 (DRY roadmap unit D6, 2026-08-25): "is this certificate SETTLED" had FOUR spellings of
  // the same literal — the certification-completeness gate, the upload route, the complete-batch
  // preview and the batch screen's "Passed, no certificate" filter. "Not Issued" is a SETTLED
  // outcome, so a bare `=== "Issued"` is wrong at all four, and four copies is four chances to
  // write it. Home: lib/candidate-journey.ts, the import-free module a client screen can reach —
  // the batch page cannot import rules.ts (mongoose), which is exactly why it grew its own copy.
  // TWO assertions, and the second is the one QA-987 taught: a shared helper with ONE caller means
  // somebody collapsed the definition and left the copies in place.
  {
    const LIT = /\[\s*"Issued"\s*,\s*"Not Issued"\s*\]/;
    const homes = [];
    const callers = [];
    for (const abs of walk(root)) {
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (SKIP_FILES.has(rel)) continue;
      const code = stripComments(fs.readFileSync(abs, "utf-8"));
      if (LIT.test(code)) homes.push(rel);
      if (/\bisCertificateSettled\b/.test(code)) callers.push(rel);
    }
    if (homes.length === 1 && homes[0] === "lib/candidate-journey.ts") passed++;
    else {
      failed++;
      pushStructural(
        `the settled-certificate literal ["Issued","Not Issued"] appears in [${homes.join(", ") || "nowhere"}] - its only home is lib/candidate-journey.ts (SETTLED_CERTIFICATE_STATUSES). A hand-written copy is how the four doors that decide whether a certificate is outstanding drifted apart (QA-1198).`,
      );
    }
    if (callers.length >= 4 && callers.includes("lib/candidate-journey.ts")) passed++;
    else {
      failed++;
      pushStructural(
        `isCertificateSettled is referenced in only ${callers.length} file(s) [${callers.join(", ")}] - the four doors that read it are lib/rules.ts, api/batches/[id]/certificates, api/batches/[id]/complete and app/(app)/batches/[id]/page.tsx. A shared predicate that loses its callers means the copies came back (QA-1198; QA-987's lesson).`,
      );
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

  // QA-1283 - A CLASS PIN, not a pin on one line. The Locations totals strip summed
  // `jr.trainers_ours`, a field no API has ever emitted, so that cell read 0 for every dataset that
  // has ever existed - directly under a column that was showing the right number. Nothing caught it
  // through QA-294, QA-295, QA-1262 and the whole of -249, which shipped to fix that very figure.
  //
  // Why no other kind of check could: `jr` is `any`, so TypeScript is silent; the column's own `key`
  // is the string "trainers_ours" while its render reads `trainers_certified`, so a grep for the
  // name SUCCEEDS and looks correct; and the wrong answer is 0, which on a sparse row is exactly
  // what a right answer looks like. A total that cannot be non-zero is worse than no total.
  //
  // So this asserts the JOIN rather than any one field: every `jr.<field>` the totals strip sums
  // must be a key the locations route actually puts on a job_roles entry.
  {
    // stripComments on BOTH sides matters: the fix for this defect writes the field names into a
    // comment, and a check that can match its own explanation always comes back green.
    const locPage = stripComments(fs.readFileSync(path.join(root, "app/(app)/locations/page.tsx"), "utf8"));
    const locApi = stripComments(fs.readFileSync(path.join(root, "app/api/locations/route.ts"), "utf8"));
    const totalsStart = locPage.indexOf("const cells: [string, number][] = [");
    if (totalsStart === -1) {
      failed++; pushStructural("app/(app)/locations: could not find the totals strip (`const cells: [string, number][]`) - QA-1283's pin cannot run, and a pin that silently stops running is worse than none. If the strip was renamed, repoint this check.");
    } else {
      const block = locPage.slice(totalsStart, locPage.indexOf("];", totalsStart));
      const summed = [...new Set([...block.matchAll(/jr\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
      // Scoped to the job_roles object literal itself (`byLoc.set(...{ ... }])`), because that is
      // exactly the shape `jr` has. An earlier version of this check anchored keys to the start of a
      // line and reported `approved_target` as phantom - it is emitted, but it shares a line with
      // two other keys, so the anchor never saw it. The instrument was wrong, not the product.
      const emitStart = locApi.indexOf("byLoc.set(");
      const emitBlock = emitStart === -1 ? "" : locApi.slice(emitStart, locApi.indexOf("}]);", emitStart));
      const emitted = new Set([...emitBlock.matchAll(/([a-z_][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1]));
      const phantom = summed.filter((f) => !emitted.has(f));
      if (summed.length && !phantom.length) passed++;
      else {
        failed++;
        pushStructural("app/(app)/locations: the totals strip sums " + JSON.stringify(phantom)
          + " which api/locations/route.ts never emits, so " + (phantom.length === 1 ? "that total is" : "those totals are")
          + " permanently 0 - QA-1283. `jr` is `any`, so nothing else will tell you: not tsc, not a grep for the name, and not the number itself, because the wrong answer is zero.");
      }
    }
  }

  // The card itself, closed by default - it is reference, consulted once, not a warning.
  const planCard = /<details[^>]*>[\s\S]{0,400}?Which column of the planning sheet is which/.test(planSrc)
    && /PLAN_COLUMN_SOURCE\[c\.key\]/.test(planSrc)
    && !/<details open[\s\S]{0,400}?Which column of the planning sheet/.test(planSrc);
  if (planCard) passed++;
  else { failed++; pushStructural("app/(app)/batches: the planning table has no collapsed card mapping each column to the client's sheet heading - QA-640. Without it the verbatim headings are stored and never shown, which is the same as not having them."); }

  // QA-688 (-203, checker on qa-192 cycle 2): the pin above only reads the TEXT of the card and
  // never asks whether it is actually reachable. Break D wrapped the whole <details> in
  // `{showSheetCard && (...)}` with `showSheetCard` a literal `false` a few lines above - the
  // regex above still matched (the JSX text is still there), so five green pins described a card
  // that renders nothing. The card is meant to be unconditionally present, collapsed by default via
  // <details> itself - not conditionally mounted by app logic - so ANY `{ident &&`/`{ident ?`
  // wrapper immediately before its opening tag is the defect, not just a false one.
  const planCardIdx = planSrc.search(/<details[^>]*>[\s\S]{0,400}?Which column of the planning sheet is which/);
  const beforeCard = planCardIdx < 0 ? "" : planSrc.slice(Math.max(0, planCardIdx - 200), planCardIdx);
  const cardGate = /[A-Za-z_$][\w.]*\s*(&&|\?)\s*\(?\s*$/.exec(beforeCard.replace(/\s+$/, ""));
  if (!cardGate) passed++;
  else { failed++; pushStructural("app/(app)/batches: the sheet-heading card sits behind a conditional (" + JSON.stringify(cardGate[0]) + ") - QA-688. The card renders on its OWN <details> collapse, not on an app-logic flag; a flag that is false, or never becomes true, hides the card while every text-scanning pin above stays green."); }

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

  // QA-688 (-208, checker on qa-192 cycle 2, break E): the key-join pin above checks the key SET and
  // the heading MULTISET - never which heading belongs to which key. Swapping two STRING VALUES
  // between two PLAN_COLUMN_SOURCE entries (e.g. tot_start <-> tot_done_on) leaves all 18 keys
  // present and all 18 headings present somewhere in the object, so both pins above stay green,
  // while the card now tells a reader holding the client's sheet the WRONG heading for two columns -
  // the exact doubt this card exists to remove. This pins the 18 key<->heading PAIRS explicitly,
  // zipped against the same SHEET_HEADINGS list above, in PLAN_COLUMN_SOURCE's own declared order
  // (the comment above the object lists it: sl, location, job_role, trainer, then the fourteen
  // trainer/TOT/batch date columns, ending planned_start, planned_end).
  {
    const SHEET_HEADING_KEYS = [
      "sl", "location", "job_role", "trainer",
      "sidh_profile_verified_on", "eligibility_checked_on", "ready_for_tot",
      "nsdc_submitted_on", "nsdc_result_on", "paid_on",
      "tot_start", "tot_done_on", "tot_result_expected_on",
      "trainer_mapped_sidh", "mobilization", "enrollment_done",
      "planned_start", "planned_end",
    ];
    const sourcePairs = [...srcBlock.matchAll(/^\s{2}([A-Za-z_][A-Za-z_0-9]*):\s*"((?:[^"\\]|\\.)*)"/gm)]
      .map((m) => [m[1], m[2]]);
    const sourceHeadingByKey = Object.fromEntries(sourcePairs);
    const wrongPairs = SHEET_HEADING_KEYS
      .map((k, i) => [k, SHEET_HEADINGS[i], sourceHeadingByKey[k]])
      .filter(([, want, got]) => got !== want);
    if (SHEET_HEADING_KEYS.length === SHEET_HEADINGS.length && !wrongPairs.length) passed++;
    else {
      failed++;
      pushStructural("app/(app)/batches: " + wrongPairs.length + " of PLAN_COLUMN_SOURCE's headings sit on the WRONG key: "
        + JSON.stringify(wrongPairs.slice(0, 4).map(([k, want, got]) => k + " should read \"" + String(want).slice(0, 40) + "...\" but reads \"" + String(got).slice(0, 40) + "...\""))
        + " - QA-688. The key SET and the heading SET can both be complete while a heading answers for the wrong column - a set check can never catch a pairwise swap.");
    }
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

  // QA-627 (cycle 2 - this pin was lost from the working tree once already before commit, a
  // concurrent-edit collision this project has not previously hit on a SOURCE file rather than a
  // qa/ file; re-applied and re-verified against the actual committed content this time, not just
  // a pre-commit working-tree snapshot): -195 (the pin above) closed the OUTGOING half - `_id`
  // travels out on every save. It left the INCOMING half open: `setContacts(next)` seeded local
  // state from the pre-save local array, never from what the server actually persisted, so a
  // contact added earlier in the same visit still had no `_id` in state when the NEXT save fired -
  // only the server had minted one. Two "Add contact" presses in one visit was enough to silently
  // re-mint the first one's id and detach the plan share already sent to them. The pin above cannot
  // catch this: it is satisfied by the outgoing shape alone and stays green whether or not state is
  // ever refreshed from the response. This one reads the other half - that `setContacts` is seeded
  // from the PATCH response, not from the argument that was passed in.
  const saveContactsFn = locPageSrc.match(/async function saveContacts\([^)]*\)\s*\{[\s\S]*?\n  \}/);
  const readsResponseBack = !!saveContactsFn
    && /const\s+res\s*=\s*await\s+api\(/.test(saveContactsFn[0])
    && /setContacts\(\s*res\??\.\??item\??\.\??contacts/.test(saveContactsFn[0]);
  if (readsResponseBack) passed++;
  else { failed++; pushStructural("app/(app)/locations/[id]/page.tsx: saveContacts still seeds local state from its own argument rather than from the PATCH response's `item.contacts` (found the function: " + !!saveContactsFn + ") - QA-627. A contact added earlier in the same visit has no `_id` in local state until a save round-trips it back; skipping that round-trip lets the NEXT save re-mint that contact's id and detach any plan share already sent to them."); }

  // QA-1399 (originally minted QA-1385 by the qa-627 checker, but a concurrent qa-192 checker the
  // same day independently claimed that same number for an unrelated git-grep-on-empty-index
  // artifact - only one landed in the ledger; re-filed under QA-1399, disclosed in that row): a
  // centre login's contacts save can be parked for Admin approval - `locations/[id]/route.ts`'s
  // `beforeUpdate` throws `HttpError(202, ...)` with no `item` key, and `api()` treats any 2xx as
  // success (`res.ok`), so it never throws. The pin above only checks that `readsResponseBack`
  // seeds from `res.item.contacts` - it says nothing about what happens when `res.item` does not
  // exist, which is exactly the parked case. Without this guard, `res?.item?.contacts ?? next`
  // falls through to the STALE local draft and displays an unsaved, un-minted-id edit as if it had
  // gone through - Overview.save() (the sibling function ~90 lines up this same file) already
  // handles this correctly with `if (res?.error) setError(res.error)`; this checks saveContacts
  // does the same before it ever reaches the `setContacts` fallback.
  const guardsParkedSave = !!saveContactsFn
    && /if\s*\(\s*res\?\.error\s*\)\s*\{[\s\S]{0,80}?setError\(res\??\.error\)[\s\S]{0,40}?return;?[\s\S]{0,10}?\}/.test(saveContactsFn[0]);
  if (guardsParkedSave) passed++;
  else {
    failed++;
    pushStructural("app/(app)/locations/[id]/page.tsx: saveContacts does not guard against an "
      + "approval-parked (202) PATCH response before falling back to the local draft (found the "
      + "function: " + !!saveContactsFn + ", has an early res.error return: " + guardsParkedSave
      + ") - QA-1399. A parked save has no `item` key, so `res?.item?.contacts ?? next` silently "
      + "adopts the unsaved local draft as if the write had gone through, and the caller's "
      + "onSaved() then fires as if nothing were wrong.");
  }
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
  //
  // QA-1074 (-245): THIS PIN'S MEASUREMENT MOVED, and the old one is rewritten rather than deleted
  // so the change is visible in the diff. It counted `Our records ·` in the PAGE. That worked while
  // the tile labels were a hand-written array in the page; -245 moved the seven measures' names and
  // source tags into REPORT_LABELS (rules.ts) so the tile, the table header and the Excel info tab
  // cannot say three different words. The guarantee is unchanged - those three tiles must still
  // name their source on screen - but the string now lives one file away, and a pin that greps the
  // old file would have gone green while measuring nothing. Blinding a pin by moving the value it
  // watches is the QA-1022 failure; so the pin follows the value: the tags must be DECLARED for all
  // three measures, and the tile must RENDER the tag rather than only the percentage.
  const rulesLib = stripComments(fs.readFileSync(path.join(root, "lib/rules.ts"), "utf8"));
  const tagged = ["mobilised", "in_training", "certified"]
    .filter((k) => new RegExp(`${k}:\\s*\\{[^}]*tag:\\s*"Our records"`).test(rulesLib)).length;
  const rendersTag = /meta\.tag/.test(reportSrc) && /of_approved/.test(reportSrc);
  if (tagged === 3 && rendersTag) passed++;
  else { failed++; pushStructural("app/(app)/reports/page.tsx + lib/rules.ts: the Mobilised / In training / Passed tiles do not name their source (declared " + tagged + " of 3, tile renders the tag " + rendersTag + ") - QA-566. A percentage is a denominator, not a provenance, so with the definitions card closed those three figures say where they came from nowhere on the screen."); }

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
  // QA-1074 (-245): ONE column is now deliberately exempt, and it is named here rather than quietly
  // dropped from `wantLabels`. Umesh renamed the tile to "Pending Target" and, asked where that
  // should land in the download, ruled the download OUT: "excel toh OneDrive wali client ki sheet
  // ki exact duplicate hai, usme kuch edit nahi kar sakte - isliye uske info button mein daalna
  // hoga ye naam." So screen and file legitimately differ on this one word, and QA-565's rule -
  // "one column, two names is the defect" - is satisfied a different way instead of being waived:
  // the screen column carries the new short name AND a hint spelling out what it used to be called,
  // and the workbook's info tab carries the mapping. All three are required below, so this is a
  // narrower exemption than deleting the entry would have been, not a wider one.
  const bridged = /label: L\.unknown\?\.short/.test(reportSrc) && /hint: L\.unknown\?\.was/.test(reportSrc)
    && /unknown:\s*\{[^}]*was:\s*"[^"]+"/.test(rulesLib)
    && /"Shown on screen as"/.test(fs.readFileSync(path.join(root, "app/api/reports/rollup/export/route.ts"), "utf-8"));
  const missingLabels = wantLabels.filter((w) => (w === "No verdict" ? !bridged : countOf(w) < (twice.has(w) ? 2 : 1)));
  if (!missingLabels.length) passed++;
  else { failed++; pushStructural("app/(app)/reports/page.tsx: the report does not use the full column names the Excel export uses - QA-565. Missing: " + missingLabels.join(", ") + ". One column, two names is the defect; the export has always spelled them out." + (missingLabels.includes("No verdict") ? " `No verdict` is allowed to differ ONLY while the screen column carries the renamed short label plus a hint naming the old one, and the export's info tab carries the mapping - one of those three is gone (QA-1074)." : "")); }

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
  // GUARD itself is pinned: it must not consult whether the batch is running or what status it is
  // at — those are a different question, asked separately beside it.
  //
  // The sentence here used to end "whatever canTransition is, it must be about the ROLE". That was
  // never what this test checks — it checks only that `running`/`status` stay out — and as of
  // QA-798 it is the wrong thing to want: the guard is now the PERMISSION the server itself asks
  // (`batches.manage`), not a blacklist of role names. Corrected in place rather than left to
  // mislead the next reader into restoring the literal, which is exactly the trap QA-1059 records
  // one tab over.
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

  // QA-701 (S2, re-opened on live -218, this cycle): `PortalIdGaps` used to return null the moment
  // nothing was BLOCKING (`gaps.length === 0`), even when the roster-wide `without_portal_id` count
  // was still positive — a batch in Planning with 29 people missing a portal ID rendered nothing at
  // all. The fix keeps `gaps.length === 0` collapsing to `return null` ONLY when the roster-wide
  // count is also zero; otherwise it renders a distinct, non-blocking informational line.
  const gapsBody = fnBody(scan, "PortalIdGaps");
  const oldCollapsedReturn = /if\s*\(!plan\s*\|\|\s*gaps\.length === 0\)\s*return null;/.test(gapsBody);
  const hasInfoBranch = /if\s*\(gaps\.length === 0\)\s*\{[\s\S]*?plan\.without_portal_id[\s\S]*?\}/.test(gapsBody);
  if (gapsBody && !oldCollapsedReturn && hasInfoBranch) passed++;
  else {
    failed++;
    pushStructural(rel + ": PortalIdGaps goes silent on a roster-wide portal-ID gap the moment"
      + " nothing is blocking certification (found the function: " + !!gapsBody
      + ", still collapses !plan||gaps.length===0 into one return null=" + oldCollapsedReturn
      + ", has a without_portal_id informational branch=" + hasInfoBranch + ") - QA-701. A batch"
      + " still in Planning can carry a large roster-wide gap with nobody enrolled yet, and the"
      + " operator working ahead of enrolment must not be shown an empty screen for it.");
  }

  // ---- QA-798 (sweep cycle 1, Umesh 2026-08-25 "go for 2"): the guard must ask the SAME thing
  // the server asks. `transition/route.ts` and `api/batches/[id]/route.ts:75` both call
  // `requirePerm(user, "batches.manage")`. The screen used to decide with
  // `role !== "Location" && role !== "Trainer" && role !== "Enrollment"` — a blacklist of three
  // names, wrong in BOTH directions once an Admin edits the matrix (which the product supports):
  // grant the right to Location and the screen hides controls they may use; revoke it from
  // Operations and the screen shows controls that 403 on press. The second is the dead-control
  // class this one screen has produced six times.
  //
  // Pinned as a PAIR on purpose: "no role literal" alone would pass on a guard that hard-codes
  // `true`, and "names the permission" alone would pass on `role === "Admin" || can(...)`. Both,
  // or it is not the server's question.
  {
    // TWO SOURCES ON PURPOSE, and both halves of this pin were wrong before this comment existed:
    //
    // `scan` is `blankStrings(src)` — it blanks the CONTENTS of string literals, so
    // `role !== "Location"` arrives as `role !== "        "` and `canBatchOv("batches.manage")` as
    // `canBatchOv("              ")`. My first version matched the role NAMES (can never fire), my
    // second matched the permission STRING (can never pass). Both were assertions about text that
    // does not exist by the time they run. I found it the only way that works: I mutated the guard
    // back to the role literal and read WHICH half went red — and the report said
    // `asks batches.manage=false, still has a role literal=false`, i.e. the pin was red for one
    // reason and blind to the other.
    //
    // So: the IDENTIFIER `role` survives blanking and is read off `scan` (real code, not a
    // comment — `hasDecl` above already proves the declaration is code). The permission NAME only
    // exists in the raw text, so it is read off `src`, from the same declaration. A comment cannot
    // fake it, because the declaration itself had to be found in the stripped source first.
    // CYCLE 3 (QA-1127/1128/1129, checker on cycle 2). Cycle 2 pinned the SHAPE and closed the four
    // evasions — and then the checker walked the ORIGINAL defect past it with a decoy: this regex
    // had no `g` and no scope anchor, so in a 4,000-line file it read the FIRST `const canTransition`
    // it met. Put one correct-but-unused declaration in the outer component, leave the real guard in
    // `Overview` as the role blacklist, and the pin reads the decoy: 288/0, build 0, tsc 0, and the
    // dead control visible in a browser. A guard-pin that does not say WHICH guard is not a pin.
    //
    // So: scoped to `Overview`'s own body via `fnBody` (the helper this file already uses at :1474,
    // :1731, :1969), and it additionally refuses if MORE THAN ONE declaration exists anywhere —
    // because a second one is either a decoy or a genuine second spelling, and both are findings.
    const ovRaw = fnBody(src, "Overview");
    const ovScan = fnBody(scan, "Overview");
    const declCount = (src.match(/const\s+canTransition\s*=/g) || []).length;
    const rawDecl = /const\s+canTransition\s*=\s*([^;]*);/.exec(ovRaw);
    const guardRaw = rawDecl ? rawDecl[1] : "";
    const scanDecl = /const\s+canTransition\s*=\s*([^;]*);/.exec(ovScan);
    const rolyLiteral = /\brole\b/.test(scanDecl ? scanDecl[1] : guardSrc);
    // CYCLE 2 (QA-1091, checker on cycle 1). Cycle 1 asked "does the text CONTAIN the permission",
    // and the checker walked FOUR rewrites straight past it, all green at 285/0:
    //     can("batches.manage","view")      <- controls hidden from people who may use them...
    //                                          or, on a door whose server asks edit, shown to
    //                                          people who may not. The dead control, restored.
    //     true || can("batches.manage",...) <- the permission never evaluated
    //     <live> && (dead && can(...))      <- present in the text, unreachable in the run
    //     owner_role !== "Location" && ...  <- a role blacklist renamed past the `\brole\b` test
    // The middle two defeat exactly the evasion the pair was built to close, so "contains" was
    // never the right question.
    //
    // So this pins the SHAPE, not the vocabulary: the guard must be `!<flag> || <fn>("batches.manage","edit")`
    // and nothing else — the same shape `mayMark` (:3027) and `mayMarkTab` (:2652) already use.
    // A whitelisted shape cannot carry a dead operand, cannot carry a constant disjunct, and cannot
    // carry a second predicate of any spelling, because there is nowhere left to put one.
    // The two identifiers must be the ones this component actually destructured from `usePerms()`,
    // which is what stops `!somethingElse || can(...)` reading as permissive-while-loading when it
    // is really permissive-always.
    // QA-1129: cycle 2's single regex was a whitelist of ONE spelling, so `Boolean(...)`, `!!`,
    // `?.()`, single quotes, a trailing comma and a swapped destructure order all went red on code
    // that means exactly the same thing. A pin that reds correct work gets deleted by the next
    // person, and then it guards nothing. So the guard is NORMALISED first, and only the DECISION
    // is judged — not the typing.
    const norm = guardRaw
      .replace(/\s+/g, "")
      .replace(/'/g, '"')
      .replace(/Boolean\(/g, "(")
      .replace(/!!/g, "")
      .replace(/\?\./g, "")
      .replace(/,\)/g, ")");
    const peel = (s) => { let t = s; while (/^\((.*)\)$/.test(t)) { const i = t.slice(1, -1); let d = 0, ok = true; for (const ch of i) { if (ch === "(") d++; else if (ch === ")") d--; if (d < 0) { ok = false; break; } } if (!ok || d !== 0) break; t = i; } return t; };
    const parts = norm.split("||");
    let shape = null;
    if (parts.length === 2 && !/&&/.test(norm) && !/\b(true|false)\b/.test(norm)) {
      // `true ||` and a dead `&&` operand both die here: no boolean literal may appear anywhere in
      // the decision, and there is exactly one operator. That is what makes this a DECISION test
      // and not a text test — a constant cannot hide inside an expression that admits no constants.
      const left = peel(parts[0]);
      const right = peel(parts[1]);
      const l = /^!([A-Za-z_$][\w$]*)$/.exec(left);
      const r = /^([A-Za-z_$][\w$]*)\("batches\.manage","edit"\)$/.exec(right);
      if (l && r) shape = [norm, l[1], r[1]];
    }
    // The two identifiers must be bound by a `usePerms()` destructure IN THIS COMPONENT — either
    // order (QA-1129: `loaded:` first is the same code).
    const hookOk = !!shape && (() => {
      const re = /const\s*\{([^}]*)\}\s*=\s*usePerms\(\)/g;
      let m;
      while ((m = re.exec(ovRaw))) {
        const inner = m[1];
        if (new RegExp("\\bcan\\s*:\\s*" + shape[2] + "\\b").test(inner)
          && new RegExp("\\bloaded\\s*:\\s*" + shape[1] + "\\b").test(inner)) return true;
      }
      return false;
    })();
    const asksPerm = !!shape && hookOk && declCount === 1;
    if (asksPerm && !rolyLiteral) passed++;
    else {
      failed++;
      // QA-1128: this used to print `guardSrc` — the STRING-BLANKED source — so `batches.delete` and
      // `batches.manage` with `"view"` came out byte-identical (14 chars / 4 chars), and the reader
      // could not tell which of five different wrongs they were looking at. It also said "ROLE NAME"
      // for four of the five, none of which contain a role name. Print the RAW guard, and say which
      // half actually failed.
      pushStructural(rel + ": the batch status controls do not decide by the permission the server"
        + " asks (declarations found=" + declCount + " [must be exactly 1 — a second one is a decoy"
        + " or a second spelling], shape ok=" + (!!shape) + ", identifiers bound by usePerms() in"
        + " Overview=" + hookOk + ", mentions `role`=" + rolyLiteral
        + ") -> " + JSON.stringify(String(guardRaw).trim().slice(0, 130))
        + " - `transition/route.ts` and `api/batches/[id]/route.ts:75` both call"
        + " requirePerm(user,\"batches.manage\"), so any principal the matrix moves across that line"
        + " sees Mark Ready / Start / Record start date / Back to Planning / Assessment done /"
        + " Complete / Cancel / the room picker either ENABLED and 403-ing on press, or hidden when"
        + " they may in fact use them. QA-798 is the map of ~45 such controls on this screen.");
    }
  }
}

// ---- QA-1145: a deep link may not preset a pill that does not exist ----
// Live on -245, found by opening the app. The Enrolled Students card links to
// /candidates?lifecycle_status=Enrolled. `lifecycle_status` is a STORED value on the candidate;
// the pills are JOURNEY labels (`FRESH_TAGS` / `JOURNEY_TAGS`), and "Enrolled" is in NEITHER.
// The page preset the pill from the stored value, the client-side filter matched nothing, and the
// screen rendered "Enrolled Candidates (332) · All 332" above ZERO rows and the empty-state
// sentence "No candidates — add or import." — advising a centre holding 332 candidates to create
// them again. The card's own count and its own list disagreed by 332.
//
// Pinned as the DECISION, not the spelling: whatever the initialiser is, it must consult BOTH pill
// lists before accepting a URL value as a pill. A value that can select nothing must select
// nothing — not everything-filtered-to-empty.
//
// HONEST LIMIT, and it is the same one three checkers charged today: this is a STATIC pin. It
// proves the initialiser consults the lists; it cannot prove the screen renders rows. Three static
// pins of mine were walked past by one more spelling each (QA-1091 → QA-1127 → QA-1141).
//
// QA-1247 (checker, qa-573 cycle 1): THIS PARAGRAPH USED TO END "the wall has NO rendered-state
// harness at all, so 'assert what the screen does' cannot be pinned here by anyone." That sentence
// is now FALSE, and it was made false by the same release that left it standing. A comment claiming
// the right tool does not exist is precisely the invitation to write a sixth regex, which is how
// QA-1091 → QA-1127 → QA-1141 → QA-1184 → QA-1214 happened.
//
// THE RENDERED-STATE HARNESS EXISTS: scripts/e2e-rendered-candidates.mjs, in the wall, driving a
// real chromium. It is where this defect is actually held, and it catches what no spelling of this
// pin can - it went red on the reverted fix naming the URLs, with the operator's own sentence in
// the failure. THIS pin is a smoke alarm for the careless case, nothing more. Do not tighten it;
// add the case to the rendered suite instead.
{
  const rel = "app/(app)/candidates/page.tsx";
  const cpath = path.join(root, "app/(app)/candidates/page.tsx");
  const csrc = fs.existsSync(cpath) ? fs.readFileSync(cpath, "utf-8") : "";
  if (!csrc) { failed++; pushStructural(rel + ": file not found - the QA-1145 pin cannot run."); }
  else {
    const cscan = stripComments(csrc);
    // CYCLE 2 (QA-1184, checker on cycle 1). Cycle 1 read only INSIDE the `useState(...)` parens and
    // keyed on the state variable being named `tag`. Both were wrong, and the checker proved it with
    // a mutation matrix against my own commit:
    //   - the fix itself HOISTS the url read into `presetTag`, OUTSIDE the parens, so `readsUrl` was
    //     false and the pin passed WITHOUT EVER REQUIRING THE LISTS. It never guarded the very fix
    //     it shipped with. Three wrong rewrites (same bug hoisted / dead branch / behind a helper)
    //     all went 298/0 SILENT.
    //   - and a CORRECT rename (`[tag,setTag]` -> `[pill,setPill]`) went red with a false message.
    // A pin that fails open is worse than no pin: it reports a guarantee it is not making.
    //
    // So the REGION is what is read, bounded by the two things this decision is actually made of —
    // the first `lifecycle_status` read, and the bucket's own `useState`. The state variable's name
    // is not part of the invariant and is no longer part of the test.
    //
    // ============================ READ THIS BEFORE TRUSTING THIS PIN ============================
    // QA-1214 (S2), cycle 2 checker, PROVEN not argued: THIS PIN STILL FAILS OPEN. The four
    // conditions below are four INDEPENDENT, UNANCHORED `.test()` calls over a region STRING. They
    // are never tied to the initialiser that actually runs, so ONE UNUSED DECOY LINE inside the
    // region satisfies all four while the bug sits reinstated beside it. The checker wrote that
    // mutation into the tree, rebuilt, re-seeded, restarted and drove the screen:
    // `check-user-copy: 300 passed, 0 failed` while `?lifecycle_status=Enrolled` rendered
    // "Enrolled Candidates (46)" above ZERO rows and "No candidates - add or import."
    // Screenshot: evidence-24-08/chk1145c2/A2MUT-pin-green-lifecycle-status-Enrolled.png
    // QA-1215 (S3): it also FALSE-REDS two correct rewrites — the bucket useState declared before
    // the tag useState (299/1, "names both lists=false"), and a type alias on the bucket useState
    // (299/1, "region found=false").
    //
    // DO NOT RE-SPELL THESE REGEXES. Three cycles now, and every tightening bought exactly one new
    // hole and one new false red; that is the instrument, not the spelling. What this pin honestly
    // provides is a SMOKE ALARM for the careless case, NOT a guarantee that the screen renders rows.
    // The unit that closes it is QA-573 (a rendered-state wall suite; Umesh approved it 2026-08-25),
    // and QA-1214/QA-1215 are to be carried INTO that unit rather than patched here. The checker's
    // re-runnable harness is evidence-24-08/chk1145c2/rendered-state-probe2.mjs — it discriminates
    // all three trees this static pin cannot: RED at 3416d45^ (7 of 17 URLs), GREEN at 3416d45
    // (0 of 17), RED on the decoy mutation (4 of 17).
    // ===========================================================================================
    const urlAt = cscan.indexOf("lifecycle_status");
    const bucketAt = cscan.search(/useState<\s*"Fresh"\s*\|\s*"Enrolled"\s*>/);
    const region = urlAt >= 0 && bucketAt > urlAt ? cscan.slice(urlAt, bucketAt) : "";
    const readsUrl = urlAt >= 0;
    // QA-1183: the union of both lists is NOT the right set — only the RESOLVED bucket's pills are
    // rendered. So the guard must name both lists AND choose between them, and the chosen list must
    // be the thing the preset is tested against.
    const namesBothLists = /FRESH_TAGS/.test(region) && /JOURNEY_TAGS/.test(region);
    const choosesList = /\?\s*FRESH_TAGS\s*:\s*JOURNEY_TAGS|\?\s*JOURNEY_TAGS\s*:\s*FRESH_TAGS/.test(region.replace(/\s+/g, " "));
    const testsMembership = /\.includes\(/.test(region);
    // ...and the membership test must actually DECIDE. `true || (…).includes(x)` names both lists,
    // chooses between them and calls .includes — and never evaluates any of it. I closed this exact
    // hole on the QA-798 pin one cycle earlier and then shipped it again here, which is why it is
    // written out rather than just fixed: a constant short-circuit is the cheapest way past every
    // structural pin in this file, and it must be refused by name in each of them.
    const shortCircuited = /(^|[^\w.])true\s*\|\||\|\|\s*true([^\w]|$)|(^|[^\w.])false\s*&&|&&\s*false([^\w]|$)/
      .test(region.replace(/\s+/g, " "));
    const guardsAgainstLists = namesBothLists && choosesList && testsMembership && !shortCircuited;
    const init = region.length > 0;
    if (init && (!readsUrl || guardsAgainstLists)) passed++;
    else {
      failed++;
      pushStructural(rel + ": the tag pill is preset from the URL without checking it is a pill"
        + " (region found=" + init + ", reads lifecycle_status=" + readsUrl
        + ", names both lists=" + namesBothLists + ", CHOOSES between them=" + choosesList
        + ", tests membership=" + testsMembership + ", short-circuited by a constant=" + shortCircuited + ") -> "
        + JSON.stringify(region.trim().replace(/\s+/g, " ").slice(0, 160))
        + " - `lifecycle_status` is a STORED value (\"Enrolled\", \"Assigned\", \"Completed\") and the"
        + " pills are JOURNEY labels; \"Enrolled\" is in neither list, so the filter matches nothing"
        + " and the card opens its own list showing the count above zero rows and an empty state"
        + " telling the centre to add or import candidates it already has. QA-1145.");
    }
  }
}

// ---- QA-1067 / QA-1042: the govt-attendance advisory arm must not fire over a mapping route ----
// Two checkers in a row said the same thing about this unit: NO PIN READS THE RENDERED SENTENCE.
// Four API pins held the flag truth table and were all green on a case where the screen printed
// "none of the students in this file are among them" two lines under a chip reading "2 ambiguous"
// and a row note saying "click this row to pick the right one" — because two departed members who
// share a name come back `Ambiguous`, never `Matched`, so `matched_student_count` stays 0 and reads
// byte-identical to the case the arm was written for. The API was right; the SCREEN lied.
//
// Umesh, 2026-08-25: "hn tho preview screen de doo naa baaki jo upload krr rha hai vo manual
// mapping krr lenge" — where a manual mapping route is open, this screen gives no advice at all.
// So the rule pinned here is not "add a token": the advisory arm must be conditioned on there being
// NO ambiguous rows, because an ambiguous row IS the mapping route.
{
  const rel = "app/(app)/govt-attendance/page.tsx";
  const gpath = path.join(root, "app/(app)/govt-attendance/page.tsx");
  const gsrc = fs.existsSync(gpath) ? fs.readFileSync(gpath, "utf-8") : "";
  if (!gsrc) { failed++; pushStructural(rel + ": file not found - the QA-1067 pin cannot run."); }
  else {
    // `stripComments`, NOT `blankStrings`. blankStrings treats `'` and a backtick as string
    // delimiters, and this page is JSX full of apostrophes in prose ("batch's", "don't") — one of
    // them flips its quote state and blanks everything after it, so the arm below simply is not
    // found and the pin reports `arm found=false` on correct code. That is exactly the failure this
    // file has caught in other people's pins twice; it caught mine on the first run.
    // stripComments keeps code and string CONTENTS and removes only comments, which is what is
    // wanted here: a commented-out copy of the condition must not satisfy this pin.
    const gscan = stripComments(gsrc);
    // The arm is the ternary branch that carries `roster_all_departed`. Read its CONDITION only —
    // everything up to the `?` — so wording changes in the message never turn this red, and a
    // condition change always does.
    const armIdx = gscan.indexOf("upload.roster_all_departed");
    const cond = armIdx < 0 ? "" : gscan.slice(Math.max(0, armIdx - 40), gscan.indexOf("?", armIdx) + 1);
    const guardsAmbiguous = /!\s*upload\.ambiguous_count/.test(cond);
    const guardsStudents = /upload\.matched_student_count\s*===\s*0/.test(cond);
    if (armIdx >= 0 && guardsAmbiguous && guardsStudents) passed++;
    else {
      failed++;
      pushStructural(rel + ": the 'everyone has left' advisory renders without excluding ambiguous"
        + " rows (arm found=" + (armIdx >= 0) + ", excludes ambiguous=" + guardsAmbiguous
        + ", still checks matched_student_count=" + guardsStudents + ") -> "
        + JSON.stringify(cond.trim().slice(0, 140))
        + " - two departed students who share a name come back Ambiguous, so matched_student_count"
        + " stays 0 and this arm fires, printing 'none of the students in this file are among them'"
        + " over a preview that is showing '2 ambiguous' and offering to map them by hand. QA-1067.");
    }
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
  const mountRe = /<PortalIdGaps\b/g;
  const mountPositions = [];
  for (let m; (m = mountRe.exec(src)); ) mountPositions.push(m.index);
  const mounts = mountPositions.length;
  // QA-716 (S3, -208 cycle-1 checker): the old pin (`decls===1 && mounts>=2 && !leftovers`, a
  // hard-coded name list) was beaten 4 of 6 ways in the checker's own attack: a parent regaining a
  // saver under a NEW name, a third re-implemented widget under a different name, both mounts
  // landing inside the SAME enclosing component, and a mount inside dead code nothing renders.
  // Hard-coded names cannot catch a rename; counting raw text matches cannot catch either shape
  // bug. This is a shape test instead:
  //   (a) no PATCH to /api/candidates/ carrying sidh_candidate_id exists ANYWHERE in this file
  //       OUTSIDE PortalIdGaps's own body - a renamed saver or a third widget both have to make
  //       that exact write, so this catches both without naming either.
  //   (b) the mounts sit in at least two DIFFERENT top-level component functions, not two mounts
  //       inside one.
  const gapsBody = fnBody(src, "PortalIdGaps");
  const outsideGaps = gapsBody ? src.replace(gapsBody, "") : src;
  // QA-1415 (S3, -208 cycle-2 checker): the first version anchored on one calling convention
  // (`api(\`/api/candidates/...\``) and was beaten by a string-concatenated URL (an idiom already
  // live elsewhere in this file) and by a raw `fetch(...)` bypassing the `api()` helper entirely.
  // Widened to not care HOW the call is made: any `api(`/`fetch(` call whose nearby text carries
  // both a PATCH-shaped method and the literal `sidh_candidate_id` is a second door.
  let secondSaverElsewhere = false;
  {
    const callRe = /\b(?:api|fetch)\s*\(/g;
    let cm;
    while ((cm = callRe.exec(outsideGaps))) {
      const windowText = outsideGaps.slice(cm.index, cm.index + 320);
      if (/PATCH/.test(windowText) && /sidh_candidate_id/.test(windowText)) { secondSaverElsewhere = true; break; }
    }
  }
  const topFnRe = /^function (\w+)\(/gm;
  const topFns = [];
  for (let m; (m = topFnRe.exec(src)); ) topFns.push({ name: m[1], start: m.index });
  topFns.sort((a, b) => a.start - b.start);
  const enclosingFn = (pos) => {
    let best = null;
    for (const f of topFns) if (f.start <= pos) best = f; else break;
    return best?.name ?? null;
  };
  const mountHomes = new Set(mountPositions.map(enclosingFn));
  const distinctHomes = mountHomes.size >= 2;
  if (decls === 1 && mounts >= 2 && distinctHomes && !secondSaverElsewhere) passed++;
  else {
    failed++;
    pushStructural(rel + ": the portal-ID gap widget is not one component in two GENUINELY separate homes"
      + " (declarations=" + decls + ", mounts=" + mounts + ", distinct enclosing components="
      + [...mountHomes].join("/") + ", a second write to sidh_candidate_id exists outside PortalIdGaps="
      + secondSaverElsewhere + ")"
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
// ---- -250 (Umesh, 25/08, on Ashish Rana / AVP-GURU-RPLAVP-DST-03): the departed row LEAVES ----
// "log rakho candidate wale mai but baaki jagah se tho data naa dikhee." The Attendance table
// rendered the raw payload, so a student who left three days earlier sat in it with a "Dropout" chip
// in the ELIGIBILITY column and the pager saying "1 of 55" over 54 people. Four things are pinned,
// and every one of them was true in the tree before this unit:
//   1. the table reads the filtered set, not data.members;
//   2. no Dropout chip is reachable on this tab (it described rows that no longer render, and its
//      own filterText had no matching branch, so chip and funnel disagreed for a departed row);
//   3. the portal chip's denominator counts what the table shows;
//   4. the filtering goes through the SHARED predicate. An inline re-spelling passes tsc and reads
//      correctly and is exactly how this concept came to have six hand-written copies and no name.
{
  const rel = "app/(app)/batches/[id]/page.tsx";
  const src = stripComments(fs.readFileSync(path.join(root, rel), "utf-8"));
  const tab = fnBody(src, "AttendanceTab");
  const tableFiltered = /rows=\{activeMembers\}/.test(tab) && !/rows=\{data\.members\}/.test(tab);
  const noDropoutChip = !/<Chip value="Dropout"/.test(tab);
  const denomFiltered = !/\/\{data\.members\.length\}/.test(tab);
  const sharedPredicate = /activeOnly\(/.test(tab)
    && /import \{[^}]*\bactiveOnly\b[^}]*\} from "@\/lib\/candidate-journey"/.test(src);
  if (tableFiltered && noDropoutChip && denomFiltered && sharedPredicate) passed++;
  else {
    failed++;
    pushStructural(rel + ": the Attendance tab can still render a student who has left the batch"
      + " (table reads the active set=" + tableFiltered + ", no Dropout chip=" + noDropoutChip
      + ", portal chip denominator filtered=" + denomFiltered
      + ", filters through the shared predicate=" + sharedPredicate + ")"
      + " - Umesh, 25/08: keep the log on the Candidates tab, show the data nowhere else. A count"
      + " that includes somebody the list below it does not is how three separate counting defects"
      + " were filed on this batch in one week.");
  }
}

// ---- -250: on the Closure tab a member who has LEFT is read-only, and every count says so ----
// Three separate things, one cause. (a) The card for a departed member used to carry LIVE
// Pass/Fail/Absent buttons directly under a tooltip promising "a member who has left cannot be
// marked" - the sentence was false until the server guard shipped with this unit. The ABSENCE of the
// bare term is asserted rather than the presence of the new one, because counting gates on this very
// tab was already proved insufficient once (QA-785, five lines up). (b) The card grid and the pill
// counts must derive from ONE named population; two surfaces each deriving their own is the whole
// mechanism behind the counting defects. (c) The "No portal ID" pill's own title used to end
// "including students who have left" - true when written, made FALSE by this change. Nothing in this
// toolchain compares prose to behaviour, so a prose pin is the only thing that can hold it.
// QA-1265 (2026-08-25, Umesh's own decision amending DEC-6): the two dates that can only be KNOWN
// after a batch completes - certificate distribution and the SIDH portal upload - must be gated on
// the PERMISSION half alone, never on completion. `closed` in this file is
// `statusClosedTab || !mayMarkTab`; these two fields must keep the second and drop the first.
//
// THIS PIN EXISTS BECAUSE A COMMENT DID NOT SURVIVE ONE AFTERNOON. The change shipped with a
// paragraph above it explaining exactly this, and a few hours later a reader saw `!mayMarkTab`,
// read it as a gate that had gone missing, and put `disabled={closed}` back (389b9b9, "do closure
// date box apna gate kho baithe the"). They were acting correctly on what they could see: nothing
// in the toolchain disagreed with them, so the revert was green. Prose cannot defend a deliberate
// asymmetry; only something that turns red can.
//
// It asserts the ABSENCE of the wrong form as well as the presence of the right one. Asserting only
// the presence would stay green if someone added a third, wrongly-gated copy of the field - which is
// the QA-785 mistake on this very file.
{
  const rel = "app/(app)/batches/[id]/page.tsx";
  const src = stripComments(fs.readFileSync(path.join(root, rel), "utf-8"));
  const AFTER_COMPLETION = ["certificate_distribution_date", "sidh_uploaded_on"];
  const bad = [];
  for (const f of AFTER_COMPLETION) {
    // The <Field> for this name, as one line - both forms live on a single line in this file.
    const line = src.split("\n").find((l) => l.includes("form." + f) && l.includes("<input"));
    if (!line) { bad.push(`${f}: no input line found at all`); continue; }
    if (/disabled=\{closed\}/.test(line)) bad.push(`${f} is gated on \`closed\`, which includes completion`);
    else if (!/disabled=\{!mayMarkTab\}/.test(line)) bad.push(`${f} is not gated on \`!mayMarkTab\``);
  }
  if (!bad.length) passed++;
  else {
    failed++;
    pushStructural(rel + ": a date that can only be known AFTER completion is disabled BY completion"
      + " (" + bad.join("; ") + ")"
      + " - QA-1265 is Umesh's amendment to DEC-6 and it is deliberately narrow: ONLY these two"
      + " fields lose the completion half, and only they. The other four closure dates stay frozen."
      + " If this needs to change, it is a decision, not a cleanup.");
  }
}

{
  const rel = "app/(app)/batches/[id]/page.tsx";
  const src = stripComments(fs.readFileSync(path.join(root, rel), "utf-8"));
  const body = fnBody(src, "CandidateResults");
  const bareClosed = (body.match(/disabled=\{closed\}/g) || []).length;
  // BOTH components, COUNTED - not "at least one somewhere in the body". The first draft used
  // .test() and would have stayed green with ResultButtons gated and the Card left wide open.
  // That is QA-785 on this exact tab: -216 gated the card component and left its parent. Two
  // components ask this question and both have to be seen asking it.
  // Both components, each seen exactly once. Not "at least one somewhere in the body": that is
  // QA-785 on this very tab, where -216 gated the card component and left its parent open.
  // Literal splits, no regex - the first attempt at this line lost its backslashes on the way to
  // disk and became an alternation, counting 0 and reddening correct code.
  const RO_RESULT_BUTTONS = "const readOnly = closed " + "|| hasLeft(i)";
  const RO_CARD = "const readOnly = closed " + "|| !!leftOn";
  const readOnlyDerivesFromLeft = body.split(RO_RESULT_BUTTONS).length - 1 === 1
    && body.split(RO_CARD).length - 1 === 1;
  const oneShownPopulation = /const shown = visible\.filter\(/.test(body)
    && /count: visible\.filter\(f\.test\)\.length/.test(body);
  const staleProse = /including students who have left/.test(body);
  // QA-1304 (S3, checker on cycle 2): the whole QA-1278 fix is two label strings in a 4,400-line
  // client file, and neither was held by anything - both revert silently, and the screen goes back
  // to printing three denominators of which only one names its population. The stale-prose check
  // above asserts an ABSENCE; these assert the PRESENCE of the words that replaced it. Both are
  // needed: dropping the label and dropping the correction are two different regressions.
  //
  // Matched on the distinguishing PHRASE, not the whole sentence, so ordinary rewording does not
  // redden this while a silent revert still does.
  const headerNamesItsPopulation = /still on the batch marked/.test(body);
  const portalLineNamesItsPopulation = /s roster carry a portal ID/.test(src);
  if (bareClosed === 0 && readOnlyDerivesFromLeft && oneShownPopulation && !staleProse
    && headerNamesItsPopulation && portalLineNamesItsPopulation) passed++;
  else {
    failed++;
    pushStructural(rel + ": a Closure control or count still ignores that the member has left"
      + " (bare disabled={closed} inside CandidateResults=" + bareClosed
      + ", readOnly derives from left_on=" + readOnlyDerivesFromLeft
      + ", grid and pills share one population=" + oneShownPopulation
      + ", stale 'including students who have left' prose still present=" + staleProse
      + ", header names its population=" + headerNamesItsPopulation
      + ", portal-ID line names its population=" + portalLineNamesItsPopulation + ")"
      + " - a control whose only possible outcome is a refusal is the dead-control class this tab has"
      + " now shipped twice, and a pill that counts rows the grid cannot show is the counting class."
      + " Certificate controls are DELIBERATELY not on readOnly: a candidate who passed and then left"
      + " keeps their card so the certificate they earned can still be attached, and that write goes"
      + " through a different door the server guard does not touch.");
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
  // -253 (QA-741, checker on qa-211): this WAS the literal test above - a single presence check for
  // one exact string. Mutation M9 beat it: leave the guarded control exactly as shipped and add a
  // SECOND, unguarded Complete control immediately above it, and the pin stays green. It constrained
  // the author who edits that one line and nobody else. It also went red on a semantically identical
  // rewrite of the same guard, which is the other half of a bad pin.
  //
  // Asked as a CLASS question now: EVERY control that opens the complete dialog must be guarded, and
  // the guard must distinguish the two doors. So a second opener reddens it (that is M9) and a
  // reworded guard does not (that is the false red). Same shape as the -251 lesson on my own pins:
  // a presence test cannot see what somebody ADDS, only what they remove.
  {
    const openers = [...page.matchAll(/setCompleteOpen\(\s*true\s*\)/g)];
    const guarded = openers.filter((m) => {
      const before = page.slice(Math.max(0, m.index - 260), m.index);
      return /isAdmin/.test(before) && /"Closing"/.test(before) && /includes\(\s*b\.status\s*\)/.test(before);
    });
    if (openers.length >= 1 && guarded.length === openers.length) passed++;
    else {
      bad++;
      pushStructural(pageRel + `: ${openers.length - guarded.length} of ${openers.length} control(s) opening the complete dialog are NOT guarded by the two-door test (isAdmin ? Active|Closing : Closing). transitionBatch has no Active -> Completed arm, so an unguarded control gives a non-Admin a button that can only 409 - QA-723/QA-741.`);
    }
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
  // QA-1022 (checker on qa-232 cycle 3): stripComments, because this pin used to read the RAW
  // source — so a bare `{/* TODO: apaar_duplicate_count */}` turned it GREEN while the lane
  // rendered nowhere. Proved by doing it: with the render deleted and only that comment left, the
  // suite reported 284 passed / 0 failed. A check that cannot tell code from a comment ABOUT the
  // code is not a check, and this one existed specifically to stop unrendered lanes.
  //
  // KEEP THIS BLOCK ABOVE the `for (const h of hits)` print loop below. At 432a5f9 it sat after it
  // and a failure printed no reason at all — only "281 passed, 1 failed". It is above it today by
  // someone else's insertions, not by design, so it is said here in words.
  const drawerSrc = stripComments(fs.readFileSync(path.join(root, "app/(app)/candidates/page.tsx"), "utf-8"));
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

// ---- QA-1010 (-244): the row verbs Umesh actually asked for, pinned as a PAIR ----
// Umesh's fourth ask, verbatim: "abhi candidate details edit and delete nhi hoo paa rhi hai naa
// like koi galti se candidate delete krr diyaa tho delete krne ka option dena hai team ko". The
// answer shipped at -241 (QA-904): a visible Edit/Delete pair on the Candidates row, copied in
// shape from the Trainers directory which already did it correctly.
//
// It shipped with NOTHING in this wall able to see it. Two consequences, both already paid for:
// QA-1052 - a manifest claimed a chip on that row that was not in the product, and only a checker
// opening a BROWSER caught it; and QA-1038 - trainer delete was WIDER than trainer-document delete,
// a defect that was invisible to any single-door assertion and only appeared in COMPARISON.
// So this is pinned the way QA-1038 had to be: as a PARITY between the two directories. Delete the
// Candidates cell and this fails; re-gate either list on a role while the other uses a right and
// this fails; wire either flag to the wrong permission key and this fails.
//
// WHAT IT PROVES - rewritten in cycle 2, because cycle 1's version of this paragraph was WRONG and
// the wrongness was the whole finding. It said the two lists "cannot drift apart". They could: the
// vector was computed by running the same regexes over the file TEXT, so any drift that changes
// BEHAVIOUR without changing SPELLING produced identical vectors on both sides and sailed through.
// A checker found five such drifts and proved the strongest in a browser - 25 rows, 0 Edit, 0
// Delete, `npm run build` exit 0, this pin reading 287/0. That is QA-437 - cited by cycle 1 as its
// reason NOT to string-match - reappearing inside the block written to avoid it, from the other side.
//
// So, precisely: this closes SIX named ways to lose the verbs while keeping the strings - spread out
// of the rendered array, a role test back in front, a `false &&` welded onto the flag, `disabled` on
// the buttons, `className="hidden"` on their span, and a DELETE repointed at another collection.
// It does NOT prove the controls render, and no source scan can. Six closed classes is not a closed
// class of one; a seventh is a finding, not a surprise. The rendering half needs a DOM-level suite,
// which this repo has no harness for - QA-1057 stays open for it and is deliberately NOT smuggled in
// here as a browser dependency on `npm test`.
{
  const rowVerbs = (rel, flag, permKey, resource) => {
    const raw = stripComments(fs.readFileSync(path.join(root, rel), "utf-8"));
    // QA-1060 (cycle 3): the cycle-2 walk counted brackets in the RAW source, so one unbalanced "("
    // inside an unrelated tooltip twenty lines above the cell collapsed the column array from 13
    // members to 9, made `editMember` the WRONG member - 913 chars became 5,703, starting at
    // `key: "sidh_status"` - and every regex below then ran over a four-column blob and reported
    // true. It failed OPEN: `liveMember` went TRUE for a cell that had been spread out of the array.
    // The repair was already in this file, one function above: blankStrings() at :58, written for
    // QA-681/QA-685 with the comment "so the brace scan cannot be thrown by a { or } inside a
    // literal". It preserves LENGTH, so every index found in `scan` still points at the right place
    // in `raw` - walk on `scan`, read content from `raw`.
    const scan = blankStrings(raw);
    const at = raw.indexOf('key: "_edit"');

    // the bracket ranges of every columns={[ ... ]} in the file
    const ranges = [...scan.matchAll(/columns=\{\[/g)].map((m) => {
      let i = m.index + m[0].length, d = 1;
      while (i < scan.length && d > 0) { if (scan[i] === "[") d++; else if (scan[i] === "]") d--; i++; }
      return [m.index + m[0].length, i - 1];
    });
    // QA-1061: cycle 2 used ranges.find(), which silently took the FIRST array mentioning the cell.
    // trainers/page.tsx has three. A second array carrying the same key is an ambiguity, not a
    // detail - so it is an error here rather than a coin toss.
    const holding = at < 0 ? [] : ranges.filter(([a, b]) => at >= a && at < b);

    // top-level members of the holding array, by index (walk on scan, slice from raw)
    let editMember = "", memberCount = 0;
    if (holding.length === 1) {
      const [a, b] = holding[0];
      let d = 0, start = a;
      for (let i = a; i < b; i++) {
        const c = scan[i];
        if (c === "[" || c === "{" || c === "(") d++;
        else if (c === "]" || c === "}" || c === ")") d--;
        else if (c === "," && d === 0) {
          memberCount++;
          if (at >= start && at < i) editMember = raw.slice(start, i);
          start = i + 1;
        }
      }
      memberCount++;
      if (at >= start && at < b) editMember = raw.slice(start, b);
    }
    const cellScan = blankStrings(editMember);

    // QA-1061 - "gate on the DECISION, not the token". Cycle 2 asked whether the string
    // `role === "Admin"` appeared. A checker wrote `!["Admin"].includes(role) ? null : (...)` - an
    // idiom that sits two columns above this cell in the same file - and restored the exact QA-904
    // defect, for the exact users the fix was for, with the wall green. Any spelling of any new gate
    // is a new decision about who sees these verbs, so the RULE is: this cell may contain exactly
    // ONE conditional, and it must be the delete flag. A ternary here is a gate whatever it says.
    const ands = [...cellScan.matchAll(/&&/g)].length;
    // QA-1081: the lookahead alone skipped the FIRST `?` of `??` and then matched the SECOND, so any
    // nullish default written in this cell read as a second permission gate and turned the wall RED
    // on an ordinary edit. A pin that false-REDs is not "safely strict" - it trains people to route
    // around it, which is how a real finding gets ignored later. The lookbehind pairs with it.
    const ternaries = [...cellScan.matchAll(/(?<!\?)\?(?![.?])/g)].length;
    const guardIsFlag = new RegExp("\\{\\s*" + flag + "\\s*&&").test(editMember);

    // M13: Edit stayed visible, enabled and unhidden while openEdit was emptied - and onRowClick
    // went with it, so the row lost BOTH ways in. A verb that calls a function which does nothing
    // is the reported defect wearing the fix's clothes.
    const openBody = (() => {
      const i = raw.search(/function openEdit\s*\(/);
      if (i < 0) return "";
      const s = raw.indexOf("{", i);
      let j = s, d = 0;
      do { if (scan[j] === "{") d++; else if (scan[j] === "}") d--; j++; } while (j < scan.length && d > 0);
      return raw.slice(s, j);
    })();

    // ...and it must not make an access decision of its OWN. A checker left the Edit button
    // untouched - rendered, enabled, unhidden - and put `if (!canRight("candidates.edit","edit"))
    // return;` at the top of openEdit, a right no role holds. Every JSX-reading assertion above
    // stayed green while the button did nothing for anybody. Who may edit is decided in the render,
    // in ONE place; a handler that quietly refuses is indistinguishable from a working one until
    // somebody presses it. So: no permission call inside the handler, and nothing returns before it
    // has opened something.
    const openScan = blankStrings(openBody);
    const firstSet = Math.min(...[openBody.indexOf("setDrawer("), openBody.indexOf("setForm(")].filter((i) => i >= 0).concat([Infinity]));
    const retIdx = openScan.search(/\breturn\b/);
    const firstReturn = retIdx < 0 ? Infinity : retIdx;

    const call = editMember.match(/api\(`\/api\/([a-z-]+)\/\$\{r\._id\}`,\s*\{\s*method:\s*"DELETE"/);
    const init = (raw.match(new RegExp("const\\s+" + flag + "\\s*=\\s*([^;]+);")) ?? [])[1] ?? "";

    return {
      file: rel,
      hasCell: at >= 0,
      oneArray: holding.length === 1,
      liveMember: editMember.trim().startsWith("{"),
      sane: memberCount >= 5,
      edit: /onClick=\{\(\) => openEdit\(r\)\}>\s*Edit\s*</.test(editMember),
      openEditReal: firstSet < Infinity && firstReturn > firstSet && !/canRight\(/.test(openBody),
      del: guardIsFlag && /\}>\s*Delete\s*</.test(editMember),
      oneGate: ands === 1 && ternaries === 0,
      permWired: new RegExp("const\\s+" + flag + "\\s*=[\\s\\S]{0,120}?" + permKey.replace(".", "\\.")).test(raw),
      flagClean: new RegExp("^rightsLoaded && canRight\\(\"" + permKey.replace(".", "\\.") + "\", \"edit\"\\)$").test(init.trim()),
      notInert: !/\bdisabled\b/.test(cellScan),
      notHidden: !/className="[^"]*\bhidden\b/.test(editMember),
      rightTarget: !!call && call[1] === resource,
    };
  };
  const cand = rowVerbs("app/(app)/candidates/page.tsx", "canDeleteCandidate", "candidates.delete", "candidates");
  const trn = rowVerbs("app/(app)/trainers/page.tsx", "canDeleteTrainer", "trainers.delete", "trainers");

  for (const v of [cand, trn]) {
    const why = !v.hasCell
      ? 'there is no `key: "_edit"` row-verb cell at all - the list has no visible Edit or Delete, which is the exact state Umesh reported ("edit and delete nhi hoo paa rhi hai naa").'
      : !v.oneArray
        ? "the `_edit` key appears in " + (v.file.includes("trainers") ? "an ambiguous number of" : "more than one") + " `columns={[...]}` arrays (or in none of them). Which list renders it is then a coin toss, and this check would silently measure whichever came first."
        : !v.sane
          ? "the column array parsed to fewer than five members, which no real list has - the structural walk has lost its place and every judgement below it would be about the wrong text. Failing here on purpose: a parser that cannot find its subject must go RED, never green."
          : !v.liveMember
            ? "the `_edit` cell is still WRITTEN but is not a live member of the rendered `columns={[...]}` array - it is spread out of it. The file compiles, the build passes, and every row loses both verbs."
            : !v.edit
              ? "the row offers no Edit control that opens the edit drawer (`onClick={() => openEdit(r)}>Edit<`)"
              : !v.openEditReal
                ? "the Edit control calls `openEdit`, but `openEdit` does not reliably open anything - it either opens nothing at all, or returns before it does, or makes an access decision of its own inside the handler. Who may edit is decided in the render and in ONE place; a handler that quietly refuses looks exactly like a working button until somebody presses it. The row also opens on click through this same function, so breaking it closes BOTH ways in while every control still looks right."
                : !v.oneGate
                  ? 'this cell contains more than one decision about who sees these verbs. Exactly one conditional belongs here - the delete right - and a second one (in ANY spelling: a role test, a ternary returning null, a negated list membership) decides who gets Edit and Delete. Umesh asked for "vo bhi respective acess wale persons"; that is the toggle at /erp/admin?tab=Permissions and nothing else.'
                  : !v.del
                    ? "the row offers no Delete control gated on the delete right - either the verb is gone or its gate is"
                    : !v.permWired
                      ? "the delete flag is not derived from its own permission key, so it gates on something other than the right it is named for"
                      : !v.flagClean
                        ? 'the delete flag\'s initialiser is no longer exactly `rightsLoaded && canRight(<key>, "edit")` - something else has been conjoined to it. A `false &&` in front still mentions the right key and hides the verb from EVERYONE, Admin included.'
                        : !v.notInert
                          ? "a row verb carries `disabled` - the buttons are on screen and do nothing, which reads to the user exactly like the state that was reported"
                          : !v.notHidden
                            ? "the row-verb span is hidden by its className - the controls are in the DOM and invisible on screen, and only the screen is what Umesh was describing"
                            : !v.rightTarget
                              ? "the row's Delete does not call this list's own collection - pressing it does not delete the record the row is about"
                              : "";
    if (!why) passed++;
    else { failed++; pushStructural(v.file + ": " + why + " (QA-1010)"); }
  }

  const shape = (v) => JSON.stringify([v.hasCell, v.oneArray, v.sane, v.liveMember, v.edit, v.openEditReal, v.oneGate, v.del, v.permWired, v.flagClean, v.notInert, v.notHidden, v.rightTarget]);
  if (shape(cand) === shape(trn)) passed++;
  else {
    failed++;
    pushStructural(
      "the Candidates and Trainers directories no longer offer the same row verbs under the same gate - " +
      "candidates=" + shape(cand) + " trainers=" + shape(trn) +
      " [hasCell, oneArray, sane, liveMember, edit, openEditReal, oneGate, delete, permWired, flagClean, notInert, notHidden, rightTarget]. " +
      "These two lists were deliberately made to behave alike; one of them has drifted. (QA-1010)",
    );
  }
}

// ---- QA-1074 (-245): the report's measure names live in ONE place, and the Excel file keeps its
// own headers ----
//
// Two pins, one block, and they pull in opposite directions on purpose.
//
// (a) The tiles must read their labels from the payload. `REPORT_LABELS` in rules.ts is the one
//     place the seven measures are named, because three surfaces have to agree on those words -
//     the tile, the table header, and the Excel workbook's info tab - and only two of the three
//     can import that module. Before this unit the tile labels were a hand-written array in the
//     page, which is how the screen came to say "No verdict yet" while everything else said
//     something else. This is the ARCHITECTURE section 3 disease and this file exists to catch it.
//
// (b) The Excel DATA sheet must NOT be renamed. Umesh, asked directly where the new vocabulary
//     should go in that file: "excel toh OneDrive wali client ki sheet ki exact duplicate hai, usme
//     kuch edit nahi kar sakte - isliye uske info button mein daalna hoga ye naam." A promise made
//     in a conversation is a promise nothing enforces; the headers are listed here so that renaming
//     one is a failing check rather than a discovery made downstream by whoever opens the file.
{
  const rulesSrc = fs.readFileSync(path.join(root, "lib/rules.ts"), "utf-8");
  const repPage = stripComments(fs.readFileSync(path.join(root, "app/(app)/reports/page.tsx"), "utf-8"));
  const exportSrc = fs.readFileSync(path.join(root, "app/api/reports/rollup/export/route.ts"), "utf-8");

  // (a) The names exist in rules.ts, travel in the payload, and the page reads them from there
  // rather than carrying its own copy of any of the three Umesh renamed.
  const named = /export const REPORT_LABELS/.test(rulesSrc)
    && /labels: REPORT_LABELS/.test(rulesSrc)
    && /data\?\.labels/.test(repPage);
  // Only the three names this unit introduced. "No verdict yet" is deliberately NOT in this list:
  // that word belongs to centreVerdict(), it labels a CENTRE rather than a measure, and it is
  // written straight into the Excel Status column - so the page keeping it in its colour/tooltip map
  // is correct, not drift. A first draft of this pin flagged it and was wrong about what it was
  // looking at.
  const ownCopy = ["Total Target", "Approved Target", "Pending Target"].filter((w) => repPage.includes(`"${w}"`) && !repPage.includes(`?? "${w}"`));
  if (named && ownCopy.length === 0) passed++;
  else {
    failed++;
    pushStructural(
      "app/(app)/reports: the report's measure names are not coming from one place (QA-1074). "
      + (named ? "" : "REPORT_LABELS is not exported / not shipped in the payload / not read by the page. ")
      + (ownCopy.length ? `The page carries its own literal for: ${ownCopy.join(", ")}. ` : "")
      + "The tile, the table header and the Excel info tab have to say the same words, and only rules.ts can be imported by all three.",
    );
  }

  // (b) The data sheet's headers, exactly as the client's duplicate has always had them.
  // Checked against the DATA SHEET's own construction, not against the file. Two earlier drafts of
  // this pin were unfalsifiable and the second one was PROVED so: with `Grand Total — No verdict`
  // and `${role} — No verdict` both renamed to Pending, it still reported green - because the
  // string survived in the info tab's `{ Column: "No verdict" }` row, which is a DIFFERENT sheet
  // and is exactly where the new vocabulary was supposed to go. A pin that its own subject cannot
  // break is QA-212's "pin that can never fail", written here by the hand that keeps filing it.
  //
  // So each heading is required in the exact expression the data sheet builds it with: the two
  // template forms for the seven measures, and the three literal keys that bracket them.
  const MEASURE_HEADS = ["Target", "Approved", "Not approved", "No verdict", "Mobilised", "In training", "Passed"];
  const missing = [];
  for (const h of MEASURE_HEADS) {
    if (!exportSrc.includes("${role} — " + h + "`")) missing.push(`\${role} — ${h}`);
    if (!exportSrc.includes(`"Grand Total — ${h}"`)) missing.push(`Grand Total — ${h}`);
  }
  if (!exportSrc.includes('"Batch Location"')) missing.push("Batch Location");
  if (!/Status:\s*centreVerdict\(/.test(exportSrc)) missing.push("Status");
  if (!exportSrc.includes('out["Check"]')) missing.push("Check");
  if (missing.length === 0) passed++;
  else {
    failed++;
    pushStructural(
      `api/reports/rollup/export: ${missing.length} column heading(s) the client's duplicate has always carried are gone - ${missing.join(", ")} (QA-1074). `
      + "Umesh's condition on this file was explicit: the workbook is a duplicate of the client's own sheet and its headings do not change; new names go on the "
      + "\"where the numbers come from\" tab. Renaming a heading here breaks every pivot anyone has built on the download.",
    );
  }
}


// ---- QA-1242: the base path has ONE spelling, and this is the check that says so ----
// QA-1188 fixed a hardcoded "/erp" at the line it named, and its evidence said "a grep for a
// hardcoded /erp/ across all of src/ returns exactly one hit, and it is this line". That was untrue
// when it was written: the grep pattern only matched a backtick-template opening `/erp/, so it
// missed two more template forms AND a plain double-quoted href. The finding closed while three
// instances stood.
// A pattern that decides whether a claim is true is part of the claim. This one asks for any quote
// character followed by /erp, which is every form the earlier greps could take between them, and it
// is a check rather than a one-off grep so the next instance is caught by the wall instead of by a
// checker reading a release. base-path.ts is where the constant is DEFINED, so it is the one file
// allowed to spell it.
{
  const bad = [];
  for (const file of walk(root)) {
    if (!/[.](tsx?|jsx?)$/.test(file)) continue;
    const rel = path.relative(root, file).split(path.sep).join("/");
    if (rel === "lib/base-path.ts") continue;
    const src = fs.readFileSync(file, "utf8");
    // split without a backslash escape on purpose - a generator collapsed one here and wrote a
    // real control byte into this file, which is the second time that has happened to it (-144).
    src.split(String.fromCharCode(10)).forEach((line, i) => {
      if (/['"`]\/erp(\/|['"`]|\$)/.test(line)) bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
    });
  }
  if (bad.length === 0) passed++;
  else {
    failed++;
    for (const b of bad) {
      pushStructural(
        `${b}
      hardcoded "/erp" - import BASE_PATH from "@/lib/base-path" instead. `
        + "The prefix is a deployment fact, not a string: when it moves, every copy of it that is not "
        + "BASE_PATH becomes a dead link, and dead links are found by users rather than by builds.",
      );
    }
  }
}

// ---- QA-1166: a filter pill must not print a number its own label has already broken down ----
// FilterPills renders `{label}{count != null ? " " + count : ""}`. When the roster chip's LABEL was
// changed to read "All 6 active - 1 left", the appended count came out behind it and the pill
// rendered "All 6 active - 1 left 7" - an unlabelled roster total trailing a label that had just
// split that same roster into its parts. On a screen whose entire complaint is numbers that do not
// reconcile, that is the complaint.
//
// This pins the INVARIANT, not either fix for it. Two different repairs are possible - suppress the
// appended count for a self-counting label, or keep every label wordless and let the count be the
// only number - and this check is deliberately blind to which one is in force. It asks the one
// question that makes the bug impossible either way: while this call site appends a count, no label
// in the list may interpolate a number of its own.
{
  const pageFile = path.join(root, "app", "(app)", "batches", "[id]", "page.tsx");
  const src = fs.readFileSync(pageFile, "utf8");
  const start = src.indexOf("const CARD_FILTERS");
  const end = src.indexOf("const q = cardSearch", start);
  const appendsCount = /options=[{]CARD_FILTERS[.]map[(][^]{0,400}?count:/.test(src);
  const labels = [];
  if (start >= 0 && end > start) {
    for (const m of src.slice(start, end).matchAll(/label: ([^,]+),/g)) labels.push(m[1].trim());
  }
  const numeric = labels.filter((l) => l.includes("${"));
  if (start < 0 || end < 0) {
    failed++;
    pushStructural("batches/[id]: CARD_FILTERS could not be located - this pin has stopped asking its question and needs re-anchoring, not deleting.");
  } else if (!appendsCount || numeric.length === 0) {
    passed++;
  } else {
    failed++;
    pushStructural(
      `batches/[id] card filters: ${numeric.length} pill label(s) interpolate their own numbers while the `
      + `call site still appends a count after them - ${numeric.join(" | ").slice(0, 160)}. `
      + 'That renders as "All 6 active - 1 left 7": a third number nobody asked for, on the one screen '
      + "whose complaint was numbers that do not add up. Either drop the count for that pill or keep the "
      + "label wordless - not both.",
    );
  }
}

// ---- QA-1239 (the UI half): the register form must not promise a seat it cannot promise ----
// The server payload has carried `batch.status` all along; this page only ever asked `batch.full`.
// A batch cancelled AFTER its link went out is not full - it is simply gone - so the "you will be
// added to this batch" line kept rendering to somebody who could not be. The behaviour half of this
// finding is pinned in e2e-blindspot; this is the half no API call can see.
{
  const f = path.join(root, "app", "p", "register", "[token]", "page.tsx");
  const src = fs.readFileSync(f, "utf8");
  const readsStatus = /batch[?][.]status/.test(src);
  const closedFirst = src.indexOf("Cancelled") >= 0
    && src.indexOf("Cancelled") < src.indexOf("meta.batch?.full");
  if (readsStatus && closedFirst) passed++;
  else {
    failed++;
    pushStructural(
      `p/register/[token]: the form decides what to promise from \`full\` alone `
      + `(reads-status:${readsStatus} closed-asked-first:${closedFirst}). A batch that is closed or `
      + "cancelled is not full, so it still reads \"you will be added to this batch\" to somebody who "
      + "cannot be - and the closed case has to be asked FIRST, or a batch that is both is described "
      + "by the condition that is not the one stopping it.",
    );
  }
}

// ---- QA-1167 (a): the attendance picker is an ALLOW-LIST, so a field it forgets is a field the
// screen silently never renders ----
// A-04 shipped `roster_count` and `left_count` on the route, and a sentence written to print them,
// and the screen showed nothing - because `setAttMeta` picks its keys by hand and those two stopped
// there. Every API assertion passed the whole time; it was found by LOOKING at the page. The finding
// then proved the gap survives the fix: revert only that picker line and the wall is still green, so
// nothing would catch the same drop tomorrow.
// This is the general form, not a re-statement of the one field: every `attMeta.X` the page READS
// must be a key the picker SETS. That is the invariant the class needs, and it would have caught the
// original drop without anyone knowing which field to look for.
{
  const pageFile = path.join(root, "app", "(app)", "batches", "[id]", "page.tsx");
  const src = fs.readFileSync(pageFile, "utf8");
  const call = src.indexOf("setAttMeta({");
  const set = new Set();
  if (call >= 0) {
    const seg = src.slice(call, src.indexOf("});", call));
    for (const m of seg.matchAll(/([a-z_][a-z0-9_]*):/gi)) set.add(m[1]);
  }
  const read = new Set();
  for (const m of src.matchAll(/attMeta[?]?[.]([a-z_][a-z0-9_]*)/gi)) read.add(m[1]);
  const dropped = [...read].filter((k) => !set.has(k));
  if (call < 0) {
    failed++;
    pushStructural("batches/[id]: setAttMeta({...}) could not be located - this pin has stopped asking its question and needs re-anchoring, not deleting.");
  } else if (dropped.length === 0) passed++;
  else {
    failed++;
    pushStructural(
      `batches/[id]: the page reads attMeta.${dropped.join(", attMeta.")} but setAttMeta never sets `
      + `${dropped.length === 1 ? "it" : "them"}. That picker is an allow-list: the field arrives from the `
      + "route, stops at this line, and the sentence written to print it renders nothing at all - with "
      + "every API assertion still green, because the payload was never the problem.",
    );
  }
}

// ---- QA-1167 (b): A-08 - one control, one predicate ----
// The button read "Issue certificates (17)", enabled, directly above a sentence reading "0 can take a
// certificate now". Both were true and neither was wrong alone: the button counted every Pass, the
// sentence counted passes with no certificate FILE. Two questions, one screen, nothing reconciling
// them. The repair was not to force the numbers to agree - they are different facts - but to make the
// button name what pressing it will actually do. This pins that the label is still derived from the
// same set the sentence beside it describes, and never again from the raw pass count.
{
  const pageFile = path.join(root, "app", "(app)", "batches", "[id]", "page.tsx");
  const src = fs.readFileSync(pageFile, "utf8");
  const oldLabel = src.includes("Issue certificates (${passes.length})");
  const newLabel = src.includes("Issue certificates (${certReady.length})");
  if (!oldLabel && newLabel) passed++;
  else {
    failed++;
    pushStructural(
      `batches/[id]: the certificate button labels itself from the wrong set `
      + `(counts-every-pass:${oldLabel} counts-what-it-will-do:${newLabel}). A button that says 17 above a `
      + "sentence that says 0 is the A-08 complaint, and it is a different fact - not a rounding gap.",
    );
  }
}

// ---- QA-496: the target MOVE has to be reachable, and gated by the right the SERVER asks ----
// -163 shipped `PATCH /api/locations/[id]/targets {from_program,to_program,reason}` to repair a row
// filed under a job role its own source sheet does not name. It shipped with NO SCREEN: a grep for
// `from_program` across every .tsx returned nothing for the whole life of the door, so the one
// defect it exists to fix - 560 of government-approved target sitting on PMKVYB-DST, a programme
// the client workbook has no row for - could not be repaired by any person using the product.
// A verb nobody can press is a verb that does not exist; this file already carries six findings of
// that shape (QA-798 / QA-1144 and their relatives), and this one had the added twist that the
// route's own tests were green the entire time.
//
// Pinned as a TRIO because any one alone is passable by something useless:
//   - the verb alone would pass on a button that opens nothing;
//   - the call alone would pass on a call no screen can reach;
//   - the gate alone would pass on a screen with no verb at all.
{
  const rel = "app/(app)/locations/[id]/page.tsx";
  const src = stripComments(fs.readFileSync(path.join(root, rel), "utf-8"));
  const scan = blankStrings(src);

  // 1. the verb is on the screen. Text match on the raw source, because the label is the thing a
  //    person looks for and blankStrings would erase it.
  const hasVerb = /Move job role/.test(src);
  // 2. it actually drives the move door - all three fields, since the route 400s without any of
  //    them and a call missing `reason` would be a button that always refuses.
  //    READ `src`, NOT `scan`, and this pin got it wrong on its first run: blankStrings() hollows
  //    out every string literal, so `method: "PATCH"` became `method: "     "` and the check
  //    reported false against code that was right in front of it. `src` is already comment-
  //    stripped, so matching it cannot be satisfied by a comment.
  const callsDoor = /from_program/.test(src) && /to_program/.test(src) && /reason/.test(src)
    && /method:\s*"PATCH"/.test(src);
  // 3. and it decides from the PERMISSION the route asks for, not from a role name. The route is
  //    `requirePerm(user, "locations.manage")`; a role blacklist here is wrong in both directions
  //    the moment an Admin edits the matrix, which the product supports. Same reason as above for
  //    reading `src`: the right's NAME only exists inside a string literal.
  const gateDecl = /const canMove = ([^;]*);/.exec(src);
  const gateSrc = gateDecl ? gateDecl[1] : "";
  const gateRight = !!gateSrc && /locations\.manage/.test(gateSrc) && !/\brole\b/.test(gateSrc);

  if (hasVerb && callsDoor && gateRight) passed++;
  else {
    failed++;
    pushStructural(rel + ": the targets card cannot move a row to another job role"
      + " (verb on screen=" + hasVerb + ", calls the move door=" + callsDoor
      + ", gated on locations.manage=" + gateRight + (gateRight ? "" : " -> " + JSON.stringify(gateSrc.trim().slice(0, 90))) + ")"
      + " - without all three, a target filed under the wrong job role can be created by an import"
      + " and never corrected by a person: PUT upserts on {location, program} so sending the right"
      + " programme ADDS a second row rather than moving the first, and there is no delete. That is"
      + " QA-496, and it is 560 of approved target reading in the wrong column of the CEO's report.");
  }
}

// QA-1195 (checker on qa-1195 itself, REQ-388): the fix was verified by hand, in a browser, on a
// pre/post A/B - and the wall's own two assertions for this unit stayed green on BOTH builds,
// because they hit the server directly and this bug lived entirely in the client discarding the
// response. "these two were green before the fix as well; they do not prove the fix" is the
// manifest's own honest line. This is the alarm that fires by itself: EditDetails's save() must
// both confirm success AND surface a server warning, or a save that WORKS and a save that does
// NOTHING go back to being byte-identical from the operator's seat.
{
  const pageSrc = stripComments(fs.readFileSync(path.join(root, "app/(app)/batches/[id]/page.tsx"), "utf8"));
  const editDetailsBody = fnBody(pageSrc, "EditDetails");
  const saveStart = editDetailsBody.indexOf("async function save(");
  const saveBody = saveStart < 0 ? "" : editDetailsBody.slice(saveStart, editDetailsBody.indexOf("\n  }\n", saveStart) + 1 || editDetailsBody.length);
  // Not a bare `setSaved(` test: save() ALSO resets to setSaved("") at the top on every call
  // (clearing a stale message before the request), so that alone is present even in the broken
  // pre-fix shape. Requires a non-empty string argument - the actual confirmation, not the reset.
  const setsSaved = /setSaved\(\s*["'][^"']*[A-Za-z]/.test(saveBody);
  const surfacesWarning = /res\??\.warning/.test(saveBody) && /setWarn\(/.test(saveBody);
  if (saveStart >= 0 && setsSaved && surfacesWarning) passed++;
  else {
    failed++;
    pushStructural("app/(app)/batches/[id]: EditDetails's save() no longer confirms success and surfaces the server's warning"
      + " (found save()=" + (saveStart >= 0) + ", sets a saved message=" + setsSaved + ", reads+shows res.warning=" + surfacesWarning + ")"
      + " - QA-1195. A save that persists but is never SHOWN to have persisted is indistinguishable from a save that silently failed,"
      + " which is the exact report this unit exists to close: \"batch ki details save nahi ho paa rhi hai\" when the save always worked.");
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
