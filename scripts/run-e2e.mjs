// Test runner (2026-08-13): runs EVERY suite and reports a per-suite table at the end.
// Replaces the fail-fast `&&` chain in package.json — one broken suite used to hide whether
// the other seven passed, and the suite list was hand-duplicated between package.json and
// ci.yml. This file is now the single place the list lives.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const wallStart = Date.now();

const SUITES = [
  // -111: static source scan — no user-facing string may carry a Rule/DEC/QA code. No server needed.
  "check-user-copy.mjs",
  // -112: structural pin — the trainer's daily-log strip must not be nested inside an Admin-only block.
  "check-home-structure.mjs",
  // QA-2443: the THIRD no-server checker, and a different INSTRUMENT from the two above.
  // check-user-copy scans source text and check-home-structure scans structure; neither can say
  // whether a function WORKS. Two of QA-2427s three money-mask edits were deleted with this whole
  // wall green, because the shapes they catch are reachable from no HTTP door. This one loads the
  // real src/lib/permissions.ts through jiti and CALLS it with a synthetic row per shape.
  "check-money-mask.mjs",
  // 2026-10-17 (secret-leak-audit-repo): no-server VALUE+SHAPE scan - the seed/test admin password must never be a literal in a tracked file.
  "check-no-seed-literal.mjs",
  // ISS-39 (2026-10-19): no-server pin of the pre-push suite SELECTOR below (--affected / --files / --suites).
  "check-run-e2e-select.mjs",
  // The original eight (audit era)
  "e2e.mjs",
  // QA-814(a) (maker on qa-219 cycle 3, pre-push — release number TBD at ship time): e2e-roles.mjs's
  // -218/QA-806/-220(QA-814) block reads
  // `GET /api/sheet-changes?status=all` and only runs `if (anyChange)`. On a FRESH CI database that
  // guard was FALSE in this exact order — e2e.mjs never creates a sync-mode SheetChange (only
  // workbook-watch changes, a different collection) and e2e-sync.mjs, the suite that does, ran
  // AFTER e2e-roles.mjs. So the block that proves -218/-219/-220's permission-door fix silently
  // never executed in the wall CI actually runs — confirmed by grepping a full wall's own output for
  // "QA-806"/"QA-814" and finding zero lines, even after -220 fixed the accessor bug inside the same
  // block. e2e-sync.mjs now runs FIRST: it creates and leaves multiple SheetChange rows behind (CSV
  // imports, applies, reverts, Ignored rows — see its own e2e-sync-mjs run), so by the time
  // e2e-roles.mjs asks for `?status=all` there is always at least one. e2e-sync.mjs's own assertions
  // filter on rows it created itself (by stamp / tab / row_key), so running it before e2e-roles.mjs
  // changes nothing it measures.
  "e2e-sync.mjs",
  "e2e-roles.mjs",
  "e2e-blindspot.mjs",
  "e2e-govt.mjs",
  // The dropout suggestion, on a batch that carries a TIME SLOT. e2e-govt.mjs keeps a slotless
  // batch on purpose (QA-085 pins that), and that is exactly why half this feature could not fire
  // there: the projection arm never ran and the estimate-exclusion guard could be deleted with
  // every pin still green. Promoted from the checker probe that found both (QA-1787, QA-1791).
  "e2e-dropout.mjs",
  // The unmatched-row caveat's SCOPE, on a fixture of TWO batches at ONE centre. Every suite above
  // has a single batch per centre, where "this batch" and "this centre" are the same number and the
  // whole QA-1772/QA-1776 family is invisible. Promoted from the checker probe (QA-1777).
  "e2e-caveat-scope.mjs",
  "e2e-trainer-pipeline.mjs",
  "e2e-rpl-blindspot.mjs",
  "e2e-flows-blindspot.mjs",
  // Section-wise eval suites (2026-08-13) — see qa/EVAL-MATRIX.md for what each covers
  "e2e-eval-home.mjs",
  "e2e-eval-notifications.mjs",
  "e2e-eval-trainers-ui.mjs",
  "e2e-eval-candidates.mjs",
  "e2e-eval-enrollment.mjs",
  "e2e-eval-locations-admin.mjs",
  "e2e-eval-data.mjs",
  // QA-1287 + QA-1289 (client call 2026-08-25): the SIDH batch id at the CREATE door, and the
  // duplicate WARNING that Umesh chose over a refusal. This suite exists because the defect was
  // invisible to every other kind of check: the field was on the schema, in the model, in the PATCH
  // allow-list and on a screen — a grep for the NAME finds it everywhere and still finds nothing
  // wrong. Only driving the create door shows that the value goes in and does not come out.
  "e2e-govt-batch-id.mjs",
  // mtg-a2 (meeting 2026-10-06, R2): a batch is creatable with the trainer and/or room on "assign
  // later"; a clash is still refused (no override) at create AND at a later assignment, and the
  // refusal names the batch, says until when, and hints "Assign later". Own fixture, stamp-derived.
  "e2e-batch-assign-later.mjs",
  // RPL compliance (2026-08-26): the batch document checklist — six new batch-level document
  // types, attendance_sheet on DailyLog (Daily Execution door), the batches.daily_log permission
  // gate and batch scope, and that the trainer-documentation pull-through writes nothing into
  // BatchDocument (no duplicate storage of trainer identity docs under a batch).
  "e2e-batch-documents.mjs",
  // QA-1436 (2026-08-26): the batch Enrollment tab's new Edit-candidate button. Server-side, the
  // only real change is GET /api/batches/[id]/members populating the FULL candidate document — this
  // suite's load-bearing assertion is the regression guard proving that widening did NOT reopen
  // GET /api/candidates/[id] or GET /api/locations, both deliberately closed to Trainer (QA-060/095).
  "e2e-candidate-edit-from-batch.mjs",
  // QA-573 (2026-08-25, Umesh approved): the FIRST suite here that asserts what the SCREEN does
  // rather than what a source file spells. It drives a real chromium (`playwright` is a
  // devDependency now) and holds one operator-facing invariant: a screen that announces a count
  // above zero must render rows, and must never tell a centre with candidates to "add or import".
  // It exists because QA-1145 shipped live, was found by a person opening the app, and then survived
  // FIVE static pins in check-user-copy.mjs (QA-1091 -> QA-1127 -> QA-1141 -> QA-1184 -> QA-1214),
  // each of which bought exactly one new hole and one new false red. It is last in the list because
  // it is the slowest, and its preconditions are ASSERTIONS not skips - a browser that will not
  // launch turns this suite red rather than quietly green.
  "e2e-rendered-candidates.mjs",
  // QA-1829a: "change my own password". Its own file because a concurrent session held qa-1831 and
  // was editing e2e-roles.mjs at the time - two sessions, one file, is the collision CLAUDE.md
  // spends a page on. It creates and deactivates its own throwaway subject and touches no seeded
  // credential, so its position in this list does not matter.
  "e2e-password.mjs",
  // QA-1828b/c: the cost entry taxonomy. Own file for the same reason as e2e-password - a
  // concurrent session holds e2e-roles.mjs. It toggles the cost.post approval rule and puts it back.
  "e2e-cost-entry.mjs",
  // mtg-b2 (R6, meeting 2026-10-06): the cost head is chosen from a Head -> Subhead dropdown on both cost
  // forms; a typed head string never posts; the Costs ledger filters by head or subhead (a head means
  // its subheads too) on the same function as the register and the export. Its own file and browser.
  "e2e-cost-head-dropdown.mjs",
  // QA-1996/QA-1997: the last-Admin floor, and it RACES on purpose. The guard was reported to
  // Umesh as unreachable twice, on the strength of a pin that only ever sent one request at a
  // time; a checker reached the zero-Admin lockout 3 of 3 rounds by sending two. Its own file
  // because it deactivates Admins, which no other suite can tolerate running underneath it.
  "e2e-admin-floor.mjs",
  // QA-2644: this suite existed since the 2026-08-12 sign-out bug and had NEVER RUN — absent from
  // this list, from package.json and from ci.yml, on all 38 wall logs. It is the only suite that
  // reproduces the production shape: nginx in front, the app seeing an internal address, so any URL
  // the SERVER builds can point somewhere no browser can reach. That is the shape that put the bug
  // in production, and the suite written to catch it was never wired to anything.
  //
  // Its first run ever, 2026-09-14: it CRASHED at an unguarded readFileSync, contributing
  // 0 passed / 0 failed - which the wall reads as "crashed" rather than "this is missing" - and it
  // hid the fourteen assertions below that line. Guarded, and with the `.env.example` the same
  // commit added (the `.gitignore` `.env*` rule had been swallowing that name, so nobody could
  // have satisfied the assertion), it reads 22 passed / 0 failed.
  // QA-2651: an earlier version of this comment said 21/1 and "ten assertions" - both were true
  // mid-commit and false by the end of it.
  "e2e-proxy.mjs",
  // QA-2761 / QA-2763: the save-button feedback states (pending, check mark, reset on change, error)
  // and the handlers that used to swallow their own failures. A browser suite, in its own file
  // because e2e-rendered-candidates.mjs was locked by another unit when this was written.
  "e2e-save-feedback.mjs",
  // R8 + R1b + R1c (QA-2845/2846/2847, meeting 2026-10-06): the Candidates "Download Excel" door -
  // exactly the table's visible columns, every matching row, never a government number, never another
  // centre's candidates - plus the "N columns hidden · Reset" chip and the Locations Approval column.
  // Its own file, with its own fixture and browser, like e2e-save-feedback.mjs above.
  "e2e-candidate-export.mjs",
  // mtg-b1 (R3 + R1a, QA-2864/2865, meeting 2026-10-06): the Planning tab's Target / Mobilised / Gap
  // columns and this-week summary (IST week), and the /reports "Recently approved" strip (N-day window,
  // approved only, centre-scoped, stamped through the real write door). Its own file and browser.
  "e2e-planning-and-approved.mjs",
  // mtg-c1 (R4, QA-2871/2872/2873, meeting 2026-10-06): the daily digest - dailyDigest(day, viewer) read by the
  // /reports/daily screen, Publish now and the 21:00 IST mail; once per IST day under a lock and a durable day
  // key; finance only for finance.view; and the "digest only" toggle on the per-approval mails. Its own file and browser.
  "e2e-daily-digest.mjs",
  // mtg-a3 (R5/R7/R9, QA-2880/2881/2882, meeting 2026-10-06): "Approved by / on" on the register, ledger and export;
  // cost-POST idempotency key (direct + parked, race, per-user); payment-status filter. Its own file.
  "e2e-cost-approver-idem.mjs",
  // QA-2852 (Umesh, 2026-10-07): an unapproved cost head (Pending / Rejected) is marked "(not approved)" /
  // "(rejected)" in the Finance cost-head filter, the Finance register and Costs ledger rows, and the approvals
  // summary of a parked cost (Admin queue and My submissions); a head with no flag reads as approved. Its own file.
  "e2e-cost-head-not-approved-mark.mjs",
  // mtg-b3 (QA-2898/2899, Umesh 2026-10-07): the person who entered a cost edits / deletes it themselves
  // (Pending: free; Approved: asks, amount/head change goes back through cost.post; Paid: locked; soft delete).
  "e2e-cost-own-edit-delete.mjs",
  // qa-import-into-batch (release -325): the Candidates import drawer can add the sheet's people straight to a
  // batch - preview "N will be added", per-row refusals, portal-ID holders ticked or skipped (never a duplicate
  // candidate), truthful created / assigned / refused counts, import AND assign both required - and the join
  // rule it uses is the ONE copy now shared with the bulk-assign and single-add doors. Own fixtures (ZZIMP-).
  "e2e-import-into-batch.mjs",
  // approval-decision-mail (Umesh, 2026-10-19): the requester is mailed when their request is approved or rejected
  // (reason included), the "approval needed" mail skips the requester, and nobody decides their own request. A
  // function-level check against the real lib and the test database - no server; MailLog rows are the captured mail.
  "check-approval-decision-mail.mjs",
];

// QA-1096 (2026-08-25): this file's guards protected `npm test` and NOTHING ELSE. All fifteen
// `npm run test:*` scripts ran `node scripts/<suite>.mjs` directly, so a single-suite run was refused
// nothing - not the production-database check below, not the server-identity check under it, and not
// the timezone refusal that had just been added for QA-1065. We run single suites constantly while
// iterating, which is exactly when a wrong answer is cheapest to believe.
//
// It was worse than a gap. Once `npm test` refuses a run in the wrong timezone, a single-suite green
// beside it reads as MORE authoritative, not less - the loud guard makes the unguarded path look
// deliberate.
//
// The fix is NOT a copy of the predicate in each suite. It is that every documented way of running a
// suite comes through this file: `package.json` now spells them `run-e2e.mjs <suite>.mjs`. One
// predicate, one place - the same reasoning db-guard.mjs states in its own header, and the failure
// ARCHITECTURE section 3 exists to name.

// ISS-39 (2026-10-19, Umesh: "system wide krna hai"): THE PRE-PUSH SELECTOR.
// The 6c pre-push wall always ran node scripts/run-e2e.mjs over every suite (~39 suites, ~8k tests):
// 175, 44 and 233 minutes on 2026-10-17. A push does not need every suite; it needs the suites the
// change can REACH, and a loud fallback to the full wall whenever that cannot be said.
//
//   node scripts/run-e2e.mjs a.mjs b.mjs        positional suite names (unchanged)
//   node scripts/run-e2e.mjs --suites a,b       the same, comma list; the .mjs is optional
//   node scripts/run-e2e.mjs --files @list.txt  changed paths (one per line or comma list) -> reachable suites
//   node scripts/run-e2e.mjs --affected B..H    changed paths = `git diff --name-only B..H` -> reachable suites
//   --list | --dry-run     print the selection (MODE, REASON, SUITE lines, SHARDS) and exit 0 BEFORE any guard
//   --concurrency N        pool size for the no-server static checks (default min(4, cpus)); see PARALLEL below
//   --no-rerun | --rerun-once   a failed suite is rerun ONCE alone (default ON with --suites/--files/--affected)
//
// HOW A CHANGED FILE MAPS TO SUITES (textual reachability - the repo has no suite<->module table, so it is derived):
//   docs / qa / *.md                       -> only the cheap no-server static checks (always included)
//   scripts/<suite>.mjs                    -> that suite
//   scripts/{e2e-lib,db-guard,seed,seed-sample,run-e2e}.mjs, package.json, lockfile, next/ts/eslint config,
//   .github/**, Dockerfile, .env*, src/{proxy,auth,instrumentation}.ts, src/models/index.ts, src/lib/db.ts,
//   a root-level layout, any non-code file under src/, any unmapped path   -> the FULL wall, with the reason printed
//   other src/** files                     -> the file plus everything that imports it (transitively, `@/` and
//                                             relative imports). Every route/page among them contributes its URL
//                                             prefix (route groups dropped, stop at the first [dynamic] segment);
//                                             every other file contributes its module path (lib/foo). A suite is
//                                             selected when its source text mentions any of those strings.
// Under-selection is the failure that ships a regression behind a green, so every doubtful case widens.
//
// PARALLEL: the suites share ONE server (BASE_URL), ONE database (MONGODB_DB) and mutate global state
// (e2e-admin-floor deactivates Admins; e2e-sync leaves SheetChange rows e2e-roles reads), so server/DB suites
// ALWAYS run serially. Only the no-server static checks (PARALLEL_SAFE) run in the pool; shards=<n> reports it.
const ALL_SUITES = [...SUITES];
const STATIC_SUITES = ["check-user-copy.mjs", "check-home-structure.mjs", "check-money-mask.mjs", "check-no-seed-literal.mjs"];
const PARALLEL_SAFE = new Set([...STATIC_SUITES, "check-run-e2e-select.mjs"]);
const repoRoot = path.resolve(dir, "..");

const opts = { positional: [], suites: null, files: null, affected: null, concurrency: null, list: false, rerun: null };
{
  const VALUE_FLAGS = new Set(["--suites", "--files", "--affected", "--concurrency"]);
  const argv = process.argv.slice(2);
  const badFlags = [];
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], val = null;
    if (a.startsWith("--") && a.includes("=")) { val = a.slice(a.indexOf("=") + 1); a = a.slice(0, a.indexOf("=")); }
    if (VALUE_FLAGS.has(a)) {
      if (val === null) val = argv[++i];
      if (val === undefined || val === "") badFlags.push(a + " (needs a value)");
      else opts[a.slice(2)] = val;
    } else if (a === "--list" || a === "--dry-run") opts.list = true;
    else if (a === "--no-rerun") opts.rerun = false;
    else if (a === "--rerun-once") opts.rerun = true;
    else if (a.startsWith("-")) badFlags.push(a);
    else opts.positional.push(a);
  }
  // QA-1272: an argument that is not understood must never degrade into "run the whole wall" while the
  // operator believes they asked for a subset. Same refusal, now for every unknown flag.
  if (badFlags.length) {
    console.error("");
    console.error("run-e2e: unrecognised argument(s): " + badFlags.join(", "));
    console.error("Running the wall anyway would look like the selection you asked for. Refusing instead.");
    console.error("Flags: --suites a,b | --files @list|a,b | --affected BASE..HEAD | --list | --concurrency N | --no-rerun | --rerun-once");
    console.error("To run the full wall, pass no arguments at all (`npm test`).");
    console.error("");
    process.exit(2);
  }
}

const FULL_EXACT = new Set(["package.json", "package-lock.json", "next.config.ts", "tsconfig.json", "Dockerfile",
  "docker-compose.yml", "eslint.config.mjs", "postcss.config.mjs", "src/proxy.ts", "src/auth.ts", "src/instrumentation.ts",
  "src/models/index.ts", "src/lib/db.ts"]);
const SHARED_SCRIPTS = new Set(["e2e-lib.mjs", "db-guard.mjs", "seed.mjs", "seed-sample.mjs", "run-e2e.mjs"]);
const CODE_EXT = [".ts", ".tsx", ".js", ".mjs"];

function suiteName(n) {
  const t = n.trim();
  return t.endsWith(".mjs") ? t : t + ".mjs";
}

// src/app/<...>/{route,page,layout,...}.tsx -> the URL prefix it serves ("" is never returned; "/" = root-level shared).
function urlPrefixOf(f) {
  const m = f.match(/^src\/app\/(.*)$/);
  if (!m) return null;
  const segs = m[1].split("/");
  const file = segs.pop();
  if (!/^(route|page|layout|loading|error|not-found|template|default|global-error)\.(tsx?|jsx?)$/.test(file)) return null;
  const out = [];
  for (const s of segs) {
    if (/^\(.*\)$/.test(s)) continue;
    if (s.startsWith("[") || s.startsWith("@")) break;
    out.push(s);
  }
  return "/" + out.join("/");
}

function buildImporters() {
  const tracked = execFileSync("git", ["-C", repoRoot, "ls-files", "-z", "src"], { maxBuffer: 1 << 28 })
    .toString().split("\0").filter((f) => CODE_EXT.some((e) => f.endsWith(e)));
  const known = new Set(tracked);
  const importers = new Map();
  const resolve = (from, spec) => {
    let base;
    if (spec.startsWith("@/")) base = "src/" + spec.slice(2);
    else if (spec.startsWith(".")) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
    else return null;
    for (const c of [base, ...CODE_EXT.map((e) => base + e), ...CODE_EXT.map((e) => base + "/index" + e)]) if (known.has(c)) return c;
    return null;
  };
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)["']([^"'\n]+)["']/g;
  for (const f of tracked) {
    let text;
    try { text = fs.readFileSync(path.join(repoRoot, f), "utf-8"); } catch { continue; }
    for (const m of text.matchAll(re)) {
      const t = resolve(f, m[1]);
      if (!t) continue;
      if (!importers.has(t)) importers.set(t, new Set());
      importers.get(t).add(f);
    }
  }
  return importers;
}

// changed paths -> { full, reason, suites }.
function selectAffected(changed) {
  const sel = new Set(STATIC_SUITES);
  const notes = [];
  const full = (why) => ({ full: true, reason: why, suites: new Set(ALL_SUITES) });
  const suiteText = new Map();
  const textOf = (s) => {
    if (!suiteText.has(s)) { try { suiteText.set(s, fs.readFileSync(path.join(dir, s), "utf-8")); } catch { suiteText.set(s, ""); } }
    return suiteText.get(s);
  };
  const addMentions = (needle, why) => {
    let n = 0;
    for (const s of ALL_SUITES) if (!sel.has(s) && textOf(s).includes(needle)) { sel.add(s); n++; }
    if (n) notes.push(why + " -> +" + n);
  };
  const srcChanged = [];
  for (const raw of changed) {
    const f = raw.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (!f) continue;
    if (/\.md$/i.test(f) || /^(docs|qa|backups|uploads)[^/]*\//.test(f) || /^scripts\/proofs\//.test(f) || f === ".gitignore" || f === ".dockerignore") continue;
    const sm = f.match(/^scripts\/([^/]+\.mjs)$/);
    if (sm) {
      const n = sm[1];
      if (SHARED_SCRIPTS.has(n)) return full("shared test infrastructure changed: " + f);
      if (ALL_SUITES.includes(n)) { sel.add(n); notes.push(f + " is a suite"); }
      else addMentions(n.replace(/\.mjs$/, ""), f + " helper referenced by suites");
      continue;
    }
    if (FULL_EXACT.has(f)) return full("shared config/global module changed: " + f);
    if (f.startsWith(".github/") || f.startsWith("config/") || f.startsWith("scripts/fixtures/") || /^\.env/.test(f)) return full("shared config/fixtures changed: " + f);
    if (f.startsWith("src/")) {
      if (!CODE_EXT.some((e) => f.endsWith(e))) return full("non-code asset under src changed (not import-traceable): " + f);
      srcChanged.push(f);
      continue;
    }
    return full("unmapped path (cannot say which suites it reaches): " + f);
  }
  if (srcChanged.length) {
    const importers = buildImporters();
    const closure = new Set(srcChanged);
    const stack = [...srcChanged];
    while (stack.length) for (const imp of importers.get(stack.pop()) ?? []) if (!closure.has(imp)) { closure.add(imp); stack.push(imp); }
    const prefixes = new Set();
    const modules = new Set();
    for (const f of closure) {
      const p = urlPrefixOf(f);
      if (p === "/") return full("a root-level layout/page is reached by " + f);
      if (p) { prefixes.add(p); continue; }
      if (f.startsWith("src/app/")) continue; // an app helper: its importing route/page is already in the closure
      modules.add(f.replace(/^src\//, "").replace(/\/index\.[a-z]+$/, "").replace(/\.[a-z]+$/, ""));
    }
    for (const p of prefixes) addMentions(p, "route/page " + p);
    for (const m of modules) addMentions(m, "module " + m);
    notes.push(srcChanged.length + " src file(s) -> closure of " + closure.size + " file(s)");
  }
  return { full: false, reason: notes.join("; ") || "no suite-reaching change; static checks only", suites: sel };
}

let runMode = "full";            // "full" | "scoped" - what the summary line reports
let selectionReason = "no filter: the whole wall";
const scopedRequested = !!(opts.suites || opts.files || opts.affected);
if (opts.positional.length || scopedRequested) {
  const explicit = [...opts.positional, ...(opts.suites ? opts.suites.split(",").filter(Boolean) : [])].map(suiteName);
  const unknown = explicit.filter((a) => !ALL_SUITES.includes(a));
  if (unknown.length) {
    console.error("");
    console.error("run-e2e: unknown suite(s): " + unknown.join(", "));
    console.error("Known suites (the list lives here, so this is the whole set):");
    for (const s of ALL_SUITES) console.error("    " + s);
    console.error("");
    process.exit(2);
  }
  let changed = null;
  if (opts.files) {
    const spec = opts.files;
    const raw = spec.startsWith("@") ? fs.readFileSync(spec.slice(1), "utf-8") : spec;
    changed = raw.split(/[\r\n,]+/).filter(Boolean);
  }
  if (opts.affected) {
    if (!/^[A-Za-z0-9_][\w./@^~-]*\.\.[A-Za-z0-9_][\w./@^~-]*$/.test(opts.affected)) {
      console.error("run-e2e: --affected wants BASE..HEAD (two refs joined by two dots), got: " + opts.affected);
      process.exit(2);
    }
    let diff;
    try { diff = execFileSync("git", ["-C", repoRoot, "diff", "--name-only", opts.affected], { maxBuffer: 1 << 28 }).toString(); }
    catch (e) { console.error("run-e2e: git diff --name-only " + opts.affected + " failed: " + String(e?.message ?? e).slice(0, 160)); process.exit(2); }
    changed = [...(changed ?? []), ...diff.split(/\r?\n/).filter(Boolean)];
  }
  const chosen = new Set(explicit);
  selectionReason = explicit.length ? "explicit suites: " + explicit.join(", ") : "";
  if (changed) {
    const r = selectAffected(changed);
    for (const s of r.suites) chosen.add(s);
    selectionReason = (selectionReason ? selectionReason + "; " : "") + (r.full ? "FALLBACK TO FULL WALL - " : changed.length + " changed path(s): ") + r.reason;
    runMode = r.full ? "full" : "scoped";
    if (r.full) console.log("run-e2e: selection falls back to the FULL wall - " + r.reason);
  } else {
    runMode = "scoped";
  }
  SUITES.length = 0;
  SUITES.push(...ALL_SUITES.filter((s) => chosen.has(s)));
  if (runMode === "scoped") {
    console.log("run-e2e: running " + SUITES.length + " of " + ALL_SUITES.length + " suites - " + SUITES.join(", "));
    console.log("  (a subset is not a wall. Its green is evidence about these suites only.)");
  }
}

const cpuCap = Math.max(1, Math.min(4, os.cpus().length));
const poolWant = opts.concurrency === null ? cpuCap : Number.parseInt(opts.concurrency, 10);
if (!Number.isInteger(poolWant) || poolWant < 1) { console.error("run-e2e: --concurrency wants an integer >= 1, got: " + opts.concurrency); process.exit(2); }
const shards = Math.max(1, Math.min(poolWant, SUITES.filter((s) => PARALLEL_SAFE.has(s)).length));
const rerunOnce = opts.rerun ?? scopedRequested;

if (opts.list) {
  console.log("MODE=" + runMode);
  console.log("REASON=" + selectionReason);
  for (const s of SUITES) console.log("SUITE " + s);
  console.log("SELECTED " + SUITES.length + " of " + ALL_SUITES.length);
  console.log("SHARDS=" + shards);
  console.log("RERUN_ONCE=" + rerunOnce);
  process.exit(0);
}


// QA-851 (2026-08-24): the database HOST, which nothing guarded. CLAUDE.md pins the database NAME
// ("MONGODB_DB=center_erp_ci, never center_erp") and says nothing about WHICH MACHINE that name
// lives on - while `.env.local` resolves MONGODB_URL to the PRODUCTION Mongo at 13.202.206.101,
// the host QA-545 records as answering without authentication. So the default local path puts the
// suites on localhost and the server they are testing on production. On 2026-08-24 that split
// killed 15 of 17 suites at "FATAL: cannot log in" - a table indistinguishable from a real
// regression. Unlike the version check below this IS a refusal: no test suite has a reason to open
// the production database. WALL_ALLOW_REMOTE_DB=1 exists for the documented remote-server case and
// still never permits `center_erp`.
{
  const url = process.env.MONGODB_URL || "mongodb://127.0.0.1:27017";
  // QA-1528: trimmed, same fix as QA-1520 (src/lib/db.ts) and db-guard.mjs's requireSafeDb - an
  // untrimmed whitespace-padded "center_erp" from a hand-edited .env would make the `db ===
  // "center_erp"` refusal below fail to fire.
  const db = (process.env.MONGODB_DB || "center_erp_ci").trim();
  const host = url.replace(/^mongodb(\+srv)?:\/\//, "").replace(/^[^@]*@/, "").split("/")[0].split("?")[0];
  const loopback = /^(localhost|127\.0\.0\.1|\[::1\]|::1|host\.docker\.internal)(:\d+)?$/i.test(host);
  const die = (why) => {
    console.error("");
    console.error("################################################################");
    console.error("##  WALL REFUSED TO START (QA-851)");
    console.error("##  " + why);
    console.error("##  MONGODB_URL host: " + host);
    console.error("##  MONGODB_DB:       " + db);
    console.error("##  Pin them explicitly, e.g.");
    console.error("##    MONGODB_URL=mongodb://127.0.0.1:27017 MONGODB_DB=center_erp_ci_<slug>");
    console.error("################################################################");
    console.error("");
    process.exit(2);
  };
  if (db === "center_erp") die("MONGODB_DB is the PRODUCTION database. This is never a test target.");
  if (!loopback && !process.env.WALL_ALLOW_REMOTE_DB) {
    die("MONGODB_URL does not point at a loopback host, so this run would read/write a REMOTE database.");
  }
  if (!loopback) console.log("WALL: remote database permitted by WALL_ALLOW_REMOTE_DB - host " + host + ", db " + db);
}

// QA-1065 (2026-08-25): the TIMEZONE, which nothing guarded, and which decided whether a release
// was allowed to ship. Measured, not argued - the SAME commit (19eb673), the SAME physical copy,
// minutes apart, changing nothing but TZ:
//
//     TZ=Asia/Kolkata   3796 passed,  0 failed, 17/17          -> pushed to production on this
//     TZ=UTC            2515 passed, 21 failed, e2e.mjs CRASHED
//     GitHub CI (UTC)   2512 passed, 21 failed, e2e.mjs CRASHED   <- identical per-suite breakdown
//
// `ci.yml` ran `ubuntu-latest`, which is UTC, while every developer machine here runs IST. So the
// number the whole team treated as the authority to push was answering a DIFFERENT QUESTION than the
// one CI asked, and on 2026-08-25 a build reached production on a green local wall while CI was red
// on that exact commit.
//
// The date boundary is the whole mechanism: at 04:26 IST it is still the PREVIOUS DAY in UTC, and
// this product's rules are built on "today" - Rule 26 rosters, Rule 28 frozen counts, `joined_on`
// floors, government attendance. A fixture that computes an expected date in local time and a server
// that computes it in IST agree in Kolkata and disagree in London.
//
// AND IT WAS NEVER NEW. The two calendar dates differ only between 18:30 and 24:00 UTC (00:00-05:30
// IST), so outside that 5.5-hour window the bug cannot appear at all. Over 100 CI runs:
//     INSIDE  the window:   0 success, 18 failure
//     OUTSIDE the window:  82 success,  0 failure
// Perfect separation, no exception, back to 2026-08-20 in that sample alone. CI was never green on
// this - it was green by the clock, and every run that did land in the window failed, each one a
// release that deployed anyway (CodePipeline does not gate on GitHub Actions).
//
// THE DECISION (Umesh, 2026-08-25, recorded verbatim in qa/feedback-inbox.md):
//     "ye timeline wala issue bhi memory mai save krlee so that it does not repeate
//      aur system mai sabb IST mai hoga"
// Every machine runs IST - CI, production, dev. That does not test the bug, it deletes the class:
// this ERP serves Indian centres, government attendance reports on the Indian calendar day, and the
// product already decides in IST via `istToday()`/`dayKey()`. Only the machines disagreed.
//
// So this guard requires IST and refuses anything else, in the same shape as the QA-851 database
// guard above and for the same reason: a warning here would be read past. `WALL_ALLOW_LOCAL_TZ=1`
// exists for someone deliberately wanting another zone's picture - it must never be set in a run
// whose green is used to justify a push, and when it IS set the runner writes that sentence to
// qa/.last-tick, because what is said in a console gets walked past and what is written in qa/ is read.
//
// WHAT NOT TO DO, learned the expensive way on this very finding: do not fix the helpers and leave
// the runner in the other zone. Patching one side of a timezone mismatch and declaring it closed is
// how this arrived. Set the zone first; then make every helper agree with the product.
{
  const tz = process.env.TZ || "";
  const offsetMin = new Date().getTimezoneOffset();
  // Umesh, 2026-08-25, on this finding: "system mai sabb IST mai hoga". IST (UTC+5:30, so
  // getTimezoneOffset() === -330) is now the ONE zone every machine runs in - CI, prod and dev alike.
  // The first version of this guard refused anything that was not UTC: the right instinct pointed the
  // wrong way. It would have locked the harness to the zone the decision moved AWAY from, and the next
  // person would have made WALL_ALLOW_LOCAL_TZ=1 a habit just to get their own wall to run - which is
  // the exact outcome the hatch was written to make visible, not to encourage.
  const isIst = offsetMin === -330;
  if (!isIst && !process.env.WALL_ALLOW_LOCAL_TZ) {
    console.error("");
    console.error("################################################################");
    console.error("##  WALL REFUSED TO START (QA-1065)");
    console.error("##  This run is NOT in IST, so its result cannot stand in for CI's or production's.");
    console.error("##  TZ env:            " + (tz || "<unset - using the machine's local zone>"));
    console.error("##  UTC offset:        " + -offsetMin + " minutes");
    console.error("##  Local time now:    " + new Date().toString());
    console.error("##  This product decides on the INDIAN calendar day - istToday(), dayKey(), Rule 26");
    console.error("##  rosters, Rule 28 frozen counts, government attendance. On 19eb673 the same copy");
    console.error("##  was 3796/0 in IST and 2515/21 + a crashed suite in UTC, and 18 of 18 CI runs that");
    console.error("##  ever landed between 18:30 and 24:00 UTC failed while 82 of 82 outside it passed.");
    console.error("##  Run it the way the product thinks:");
    console.error("##    TZ=Asia/Kolkata MONGODB_URL=mongodb://127.0.0.1:27017 MONGODB_DB=center_erp_ci_<slug> npm test");
    console.error("##  If you genuinely want the local-timezone picture, set WALL_ALLOW_LOCAL_TZ=1 -");
    console.error("##  but a green from such a run is NOT authority to push.");
    console.error("################################################################");
    console.error("");
    process.exit(2);
  }
  const line = isIst
    ? "WALL TIMEZONE: IST - the one zone this system runs in"
    : "WALL TIMEZONE: NOT IST (" + (tz || "machine default") + "), offset " + -offsetMin + "min - WALL_ALLOW_LOCAL_TZ is set, so this green is NOT push authority (QA-1065)";
  console.log(line);
  // ...and when the hatch is used, that sentence goes to DISK, not only to a console nobody re-reads.
  // This is the night's whole lesson: what is said in a log gets walked past, what is written in
  // qa/ gets read by the next session, the sweep and the session-start hook. Best-effort by design -
  // an isolated copy has no ../../qa and must not fail its wall over an audit line it cannot write.
  if (!isIst) {
    try {
      // `dir` is this file's own directory, resolved at the top of this module - use it rather than
      // re-deriving it from import.meta.url, which is how a second, subtly different copy of the
      // same idea gets into a file.
      const tick = path.join(dir, "..", "..", "qa", ".last-tick");
      if (fs.existsSync(tick)) {
        fs.appendFileSync(tick, new Date().toISOString() + " WALL RUN OUTSIDE IST (WALL_ALLOW_LOCAL_TZ=1, offset " +
          -offsetMin + "min). Whatever this run reports, it is NOT CI's answer and NOT authority to push - QA-1065." + String.fromCharCode(10));
      }
    } catch { /* never fail a wall over its own audit line */ }
  }
}

// QA-1771 (2026-09-02): the database's UNIQUE INDEXES, which nothing guarded. Mongoose builds them
// when a MODEL FIRST TOUCHES ITS COLLECTION - not at server start, contrary to this guard's own
// first version. Drop the database and re-seed it without restarting the server (an easy mistake:
// the natural instinct is "clear the data", not "the indexes live on the connection, not the data")
// and a collection that already had its indexes built in THAT process's lifetime never gets them
// rebuilt - a document written through the same stale connection auto-creates the collection again,
// bare. Every uniqueness assertion in the wall then INVERTS - "a duplicate trainer phone is
// refused" gets 201, "a TR ID already in use is refused with 4xx" gets 200, member-collision checks
// flip 409/201 - eight assertions in the most alarming possible area (duplicate protection) look
// like real product regressions, and not one line of the output says why. Measured on IDENTICAL
// code: correct order (stop server -> drop DB -> seed -> START server -> seed:sample -> wall) = 5
// failures (the pre-existing set); drop under a live server = 13.
//
// QA-1813 (self-caught, on this guard's OWN first real release wall, minutes after a checker
// PASSed it): the first version of this guard only CHECKED for the three indexes and refused if
// absent - which sounds right and is wrong, because on a genuinely fresh database (exactly what
// CI's mongo:7 service container is, every single run) trainers/locations/batchmembers do not
// EXIST yet at the point this guard runs - seed.mjs and seed-sample.mjs never touch them, and
// Next.js does not eagerly load every model at server start, only on first request. So the
// passive check refused every legitimately fresh wall, CI included - the manifest's own "healthy
// database" verification had unknowingly reused collections left over from an earlier suite run
// in the same database, the same class of instrument mistake this whole finding is about.
//
// The fix is to ASSERT the indexes rather than merely check for them - `createIndex` is idempotent
// (a no-op if the correct index already exists) and MongoDB enforces uniqueness at the server for
// every future writer once an index exists, regardless of which client created it. So: ensure the
// three indexes ourselves, in the same shape as the QA-851/QA-1065 refusals above only as a REPAIR
// rather than a passive detector - and refuse loudly only if the assertion itself fails, which
// means real duplicate data already sits in the collection and creation is genuinely impossible.
//
// QA-2057 (2026-09-08), and it is the third instalment of the same story: this guard, written to
// stop the wall lying, made the wall UNRUNNABLE FROM A CLEAN DATABASE - in both seeding orders,
// and neither message pointed at the guard.
//   - `createIndex` was called with a bare `{ unique: true }` for all three. Two of the three are
//     bare in the schema and were fine. `Location.institution_id` is `unique + SPARSE`
//     (src/models/index.ts:154), and on a clean database mongoose has not built its own index yet,
//     so the `already` check finds nothing and this guard installs the NON-SPARSE one instead.
//   - Seed-only: every subsequent `POST /api/locations` without an institution_id collides with
//     the previous one - "That qa1771 guard is already in use" - and TWENTY-ONE suites crash,
//     each dying several lines later as `Cannot read properties of undefined (reading '_id')`,
//     which names the symptom and never the guard.
//   - CORRECTED BY THE CYCLE-1 CHECKER, QA-2073, and the correction matters more than the claim
//     it replaces. The first version of this comment said the seed + seed:sample order ALSO
//     failed - the bare index refusing to build over 8 null institution_ids - and concluded
//     "there was no order that worked". THAT IS FALSE. seed-sample.mjs:66 POSTs its locations
//     THROUGH THE SERVER, so mongoose builds its own `institution_id_1 {unique,sparse}` before
//     `npm test` ever runs, the `already` check below short-circuits, and this guard never gets
//     to install the bare one. The checker measured the real CI order and then ran the MUTANT
//     against exactly that state: exit 0, no refusal, no index created.
//     The maker's order-B "proof" preloaded those 8 locations with the RAW DRIVER, which skips
//     mongoose entirely - so it measured a state the documented sequence never reaches. The
//     seed-only order was genuinely broken; the documented order was not.
//     The maker's OWN failing run was real, but its cause was different and is worth knowing:
//     it dropped the database UNDER A LIVE SERVER, which is the QA-1771 trap at the top of this
//     very comment - mongoose does not rebuild indexes for a collection it has already touched
//     in that process's lifetime, so seed-sample's locations went in with no index at all and
//     the bare one could then not be built. Start the server FRESH after a drop and it does not
//     happen. Two different faults wearing one banner, and the maker fused them into a single
//     wrong story.
// Found by a maker running the wall before a push, four attempts in. The fix is the fourth element
// of EXPECTED: carry each index's real schema options instead of assuming every one is bare.
// Same family as QA-1813 above - that was this guard's options mismatch seen from the NAME side
// (mongoose's index and a plain one colliding by name); this is the same mismatch seen from the
// BEHAVIOUR side. And the same family as the CLAUDE.md rule corrected on 2026-09-07: a guard that
// fires on correct work gets skipped, and a guard that BREAKS correct work gets worked around in
// somebody's shell history and never written down.
{
  const { MongoClient } = await import("mongodb");
  const url = process.env.MONGODB_URL || "mongodb://127.0.0.1:27017";
  const dbName = (process.env.MONGODB_DB || "center_erp_ci").trim();
  // [collection, index key spec, human name, EXTRA SCHEMA OPTIONS] - one from each area QA-1771
  // measured inverting. The fourth element is QA-2057 and it is not decoration: this guard used to
  // create every index as a bare { unique: true }, and one of the three is NOT bare. Each entry
  // below cites the schema line it copies, because that is the only thing that keeps them in step.
  const EXPECTED = [
    ["trainers", { phone: 1 }, "Trainer.phone unique", {}],                                    // src/models/index.ts:599
    ["locations", { institution_id: 1 }, "Location.institution_id unique", { sparse: true }],  // src/models/index.ts:154
    ["batchmembers", { batch: 1, candidate: 1 }, "BatchMember (batch, candidate) unique", {}], // src/models/index.ts:924
  ];
  let client;
  try {
    client = new MongoClient(url, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const db = client.db(dbName);
    const failed = [];
    for (const [coll, keySpec, label, extra] of EXPECTED) {
      // QA-1813 (found on THIS guard's own next release wall, right after the first fix landed):
      // creating with a bare { unique: true } can collide by NAME with an index mongoose already
      // built for the same key but with EXTRA schema-level options (Location.institution_id is
      // `unique + sparse`, so mongoose's own index and a plain-unique one both default to the name
      // "institution_id_1" but disagree on options - Mongo refuses the second as a name conflict,
      // which is not a real duplicate at all). So: first check whether ANY unique index already
      // covers this exact key, by KEY alone, ignoring name and any extra options a caller here would
      // otherwise have to keep hand-synced with every schema file. Only if none exists do we create
      // our OWN, under a name that can never collide with mongoose's auto-generated one.
      const existing = await db.collection(coll).indexes().catch(() => []);
      const already = existing.some((ix) => ix.unique && JSON.stringify(ix.key) === JSON.stringify(keySpec));
      if (already) continue;
      try {
        await db.collection(coll).createIndex(keySpec, { unique: true, ...extra, name: "qa1771_guard_" + coll });
      } catch (e) {
        failed.push(label + " - " + String(e?.message ?? e).slice(0, 140));
      }
    }
    if (failed.length) {
      console.error("");
      console.error("################################################################");
      console.error("##  WALL REFUSED TO START (QA-1771)");
      console.error("##  " + failed.length + " expected UNIQUE index(es) could NOT be built on " + dbName + ":");
      for (const m of failed) console.error("##    - " + m);
      console.error("##  Usually this means the collection already holds a genuine DUPLICATE under");
      console.error("##  that key - real data to fix, not a harness timing issue.");
      console.error("##  BUT CHECK THE OPTIONS FIRST (QA-2057). This guard once created every index",);
      console.error("##  as a bare { unique: true } while Location.institution_id is declared");
      console.error("##  unique + SPARSE - and a sparse index exists precisely to permit many nulls.");
      console.error("##  seed-sample writes 8 locations with no institution_id, so the bare index");
      console.error("##  could not be built and this banner blamed the data for being correct.");
      console.error("##  If the key below is nullable, compare EXPECTED here against its schema line.");
      console.error("################################################################");
      console.error("");
      await client.close().catch(() => {});
      process.exit(2);
    }
    console.log("WALL: expected unique indexes asserted (" + EXPECTED.length + " ensured) - QA-1771/QA-1813");
  } catch (e) {
    // Never fail a wall over the preflight's OWN connectivity - the suites' first assertion will
    // surface a genuinely unreachable database far more clearly than this guard could.
    console.log("WALL NOTE: QA-1771 index preflight could not connect (" + String(e?.message ?? e).slice(0, 80) + ") - skipped, not refused.");
  } finally {
    await client?.close().catch(() => {});
  }
}

// QA-638 / QA-645 (-197): BEFORE any suite runs, prove the server at BASE_URL is the build in this
// working tree. On 2026-08-22 a wall reported "45 failed, 2 crashed" about a build it never started:
// a `next start` from an earlier session held the port, `npm start` died with EADDRINUSE into a log
// nobody read, and the readiness curl was answered by the PREVIOUS release with a different
// database. Every number in that run described somebody else's server. The guard that caught it
// afterwards lived in a throwaway scratch file, so the next session would have inherited the defect
// and not the fix - which is why it is here, in the runner every wall and CI already go through.
//
// It is a WARNING, not a refusal: this runner is also used against a deliberately older or remote
// server, and a hard stop would break that. What it must never do is stay silent.
{
  const base = process.env.BASE_URL || "http://localhost:3000/erp";
  let want = null;
  try {
    const v = fs.readFileSync(path.join(dir, "..", "src", "lib", "version.ts"), "utf-8");
    want = v.match(/RELEASE = "([^"]+)"/)?.[1] ?? null;
  } catch { /* no version file - nothing to compare against */ }
  if (want) {
    let got = "(no answer)";
    try {
      const res = await fetch(`${base}/api/public/version`, { signal: AbortSignal.timeout(15000) });
      got = (await res.json())?.release ?? "(no release field)";
    } catch (e) { got = `(unreachable: ${String(e?.message ?? e).slice(0, 60)})`; }
    if (got === want) {
      console.log(`server at ${base} is running ${got} — matches this tree`);
      // QA-852 (2026-08-24): the SERVER's own env decides whether this wall can pass. With
      // STORAGE_DISABLE unset the build reaches for GCS, WIF impersonation 403s off a developer
      // machine, and /api/upload + the certificate preview return 500 - which crashes e2e.mjs and
      // e2e-sync.mjs outright. That produced "4 failed, 3 crashed" on 2026-08-24 and read exactly
      // like broken code. The server reports which backend it chose, so ask it rather than guess.
      try {
        const vres = await fetch(`${base}/api/public/version`, { signal: AbortSignal.timeout(15000) });
        const st = (await vres.json())?.evidence_storage;
        if (st && st !== "local-ephemeral") {
          console.log("");
          console.log("################################################################");
          console.log(`##  WALL WARNING: server reports evidence_storage="${st}"`);
          console.log("##  The suites expect STORAGE_DISABLE=1 on the SERVER (see ci.yml).");
          console.log("##  Without it, upload/certificate suites fail or crash for ENVIRONMENT");
          console.log("##  reasons, and those failures are NOT code defects.");
          console.log("################################################################");
          console.log("");
        }
      } catch { /* the version fetch already succeeded above; a second failure is not fatal */ }
      // The rest of the canonical wall environment lives in .github/workflows/ci.yml - keep in step.
      for (const [k, v] of [["SYNC_ALLOW_TEST_SOURCES", "1"], ["SMS_DAILY_CAP", "6"], ["SMS_DISABLED", "1"]]) {
        if (!process.env[k]) console.log(`WALL NOTE: ${k} is unset - ci.yml sets it to "${v}"; some pins will not be exercised.`);
      }
    } else {
      console.log("");
      console.log("################################################################");
      console.log(`##  WALL WARNING: ${base}`);
      console.log(`##  is serving   ${got}`);
      console.log(`##  this tree is ${want}`);
      console.log("##  Every result below describes the server, NOT this tree.");
      console.log("##  Check nothing else is holding the port (QA-638).");
      console.log("################################################################");
      console.log("");
    }
  }
}

const results = [];
const parserDrift = [];

// ISS-39: async so the no-server static checks can share a pool; everything else still runs one at a time.
function runSuite(suite) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(dir, suite)], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const out = [], err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => resolve({ stdout: "", stderr: String(e?.message ?? e), status: null }));
    child.on("close", (code) => resolve({ stdout: Buffer.concat(out).toString("utf-8"), stderr: Buffer.concat(err).toString("utf-8"), status: code }));
  });
}

function scoreSuite(suite, r) {
  // QA-2540 / QA-2544 / QA-2549 / QA-2551: the summary-line parser and its SKIPPED vocabulary - see the history
  // kept in git; the pattern is unchanged by ISS-39 (it only moved here from the serial loop).
  const m = (r.stdout ?? "").match(/(\d+) passed, (\d+) failed(?:, (\d+) SKIPPED \(did not run[^)]*\))?\s*$/m);
  if (/SKIPPED/.test(r.stdout ?? "") && !(m && m[3])) parserDrift.push(suite);
  return {
    suite,
    passed: m ? Number(m[1]) : 0,
    failed: m ? Number(m[2]) : 0,
    skipped: m && m[3] ? Number(m[3]) : 0,
    crashed: !m || r.status === null, // no final count = the suite died before finishing
    exit: r.status,
  };
}
const isBad = (row) => row.crashed || row.failed > 0 || row.exit !== 0;

// One suite: run it, and (ISS-39, scoped selection) if it is red rerun THAT suite once, alone - never the set.
// A suite that recovers is reported as FLAKY with its first-run numbers, so a rerun can never hide a red.
async function execute(suite) {
  const lines = [`\n━━━ ${suite} ━━━`];
  const r = await runSuite(suite);
  lines.push(r.stdout ?? "");
  const errLines = r.stderr ? [r.stderr] : [];
  let row = scoreSuite(suite, r);
  if (isBad(row) && rerunOnce) {
    const first = row;
    lines.push(`\n━━━ ${suite} - RED on first run (${first.crashed ? "crashed" : first.failed + " failed"}, exit ${first.exit}); rerun 1 of 1, alone ━━━`);
    const r2 = await runSuite(suite);
    lines.push(r2.stdout ?? "");
    if (r2.stderr) errLines.push(r2.stderr);
    const second = scoreSuite(suite, r2);
    row = second;
    if (!isBad(second)) row = { ...second, flaky: { failed: first.failed, crashed: first.crashed, exit: first.exit } };
    else row = { ...second, rerunFailed: true };
  }
  return { row, lines, errLines };
}
function emit(res) {
  process.stdout.write(res.lines.join("\n") + "\n");
  for (const e of res.errLines) process.stderr.write(e);
  results.push(res.row);
}

if (shards > 1) {
  const par = SUITES.filter((s) => PARALLEL_SAFE.has(s));
  const rest = SUITES.filter((s) => !PARALLEL_SAFE.has(s));
  console.log(`run-e2e: ${par.length} no-server static check(s) in a pool of ${shards}; ${rest.length} server/database suite(s) run serially after (they share one server and one database).`);
  const done = new Array(par.length);
  let next = 0;
  await Promise.all(Array.from({ length: shards }, async () => {
    while (next < par.length) { const k = next++; done[k] = await execute(par[k]); }
  }));
  for (const res of done) emit(res);
  for (const suite of rest) emit(await execute(suite));
} else {
  for (const suite of SUITES) emit(await execute(suite));
}


console.log("\n━━━ Summary ━━━");
let totalPass = 0, totalFail = 0, bad = 0;
for (const r of results) {
  totalPass += r.passed; totalFail += r.failed;
  const state = r.crashed ? "CRASHED" : r.failed > 0 ? "FAILED" : r.flaky ? "FLAKY" : "ok";
  if (r.crashed || r.failed > 0 || r.exit !== 0) bad++;
  // QA-2543: the per-suite row carries the skip as well. "TOTAL is the line that gets quoted" was
  // true and incomplete - THIS unit's own manifest quoted the per-suite row as evidence the wall was
  // healthy, which is precisely how the dead CHANGELOG gate survived. A skip honest in TOTAL and
  // absent from the row a reader copies is the same defect one line up.
  console.log(`${state.padEnd(8)} ${r.suite.padEnd(32)} ${r.passed} passed, ${r.failed} failed${(r.skipped ?? 0) > 0 ? `, ${r.skipped} SKIPPED` : ""}${r.crashed ? " (no final count — crashed?)" : ""}${r.flaky ? ` (RED on first run: ${r.flaky.crashed ? "crashed" : r.flaky.failed + " failed"}, exit ${r.flaky.exit}; green on the single rerun)` : ""}${r.rerunFailed ? " (still RED on the single rerun)" : ""}`);
}
// -153 (QA-354): a CRASHED suite reports `passed: 0, failed: 0`, so it adds nothing to either
// total and the TOTAL line read "0 failed" while suites were dying. The per-suite rows do say
// CRASHED - but the TOTAL line is the one that gets QUOTED, into manifests, commit messages and
// release notes, and it is the line that has to refuse to look clean. Measured today: a run in
// which 15 of 17 suites crashed still printed a totals line reading 0 failed.
const crashedSuites = results.filter((r) => r.crashed);
const flakySuites = results.filter((r) => r.flaky);
const quietFailures = results.filter((r) => !r.crashed && r.failed === 0 && r.exit !== 0);
let totalLine = `\nTOTAL: ${totalPass} passed, ${totalFail} failed across ${results.length} suites`;
if (crashedSuites.length) {
  totalLine += `\n!! ${crashedSuites.length} SUITE(S) CRASHED and contributed NO counts, so the numbers above are NOT a pass: ` +
    crashedSuites.map((r) => r.suite).join(", ");
}
// QA-2540: the argument QA-354 makes for crashes, made for SKIPS. A skipped assertion contributes
// to neither total, so a run with a dead gate reads exactly like a run with a live one - which is
// how the CHANGELOG push gate stayed dead for the entire life of the isolation recipe. The TOTAL
// line is what gets quoted into manifests, commit messages and release notes, so it is the line
// that has to refuse to look clean.
const skippedSuites = results.filter((r) => (r.skipped ?? 0) > 0);
if (skippedSuites.length) {
  const n = skippedSuites.reduce((a, r) => a + (r.skipped ?? 0), 0);
  totalLine += String.fromCharCode(10) + "!! " + n + " assertion(s) SKIPPED - they did not run, and a skip is not a pass: " +
    skippedSuites.map((r) => r.suite + " (" + r.skipped + ")").join(", ");
}
if (flakySuites.length) {
  totalLine += String.fromCharCode(10) + "!! " + flakySuites.length +
    " suite(s) were RED on the first run and green on the single rerun (flaky, not clean) - quote this, do not hide it: " +
    flakySuites.map((r) => r.suite).join(", ");
}
if (parserDrift.length) {
  totalLine += String.fromCharCode(10) + "!! " + parserDrift.length +
    " suite(s) printed SKIPPED in a form this runner no longer parses - their skips are NOT in the numbers above: " +
    parserDrift.join(", ");
}
if (quietFailures.length) {
  totalLine += `\n!! ${quietFailures.length} suite(s) reported no failures but exited non-zero: ` +
    quietFailures.map((r) => `${r.suite} (exit ${r.exit})`).join(", ");
}
console.log(totalLine);
// ISS-39: the one machine-readable line the pre-push gate quotes (mode=full also when a scoped selection fell back to full).
console.log(`prepush_wall_min=${((Date.now() - wallStart) / 60000).toFixed(1)} tests=${totalPass + totalFail} mode=${runMode} shards=${shards}`);
// QA-2548 / QA-2550: SKIPS ARE DELIBERATELY EXCLUDED FROM THIS EXIT CODE - `bad` counts failures
// and crashes, never skips. The app repo contains no `qa/` at all, so the release-row gate skips on
// every CI run; exiting non-zero on a skip would make CI permanently red for being in the wrong
// repo, which is the exact outcome that gate's own comment was written to prevent. A skip must be
// LOUD - the per-suite row and the TOTAL warnings above both carry it - and must not be FATAL. The
// QA-2540/QA-2543 comments above argue hard that a skip is not a pass, which reads as an argument
// for the opposite; it is not, and unwritten this looked like an oversight rather than a call.
//
// QA-2550: the first version of this comment landed 439 lines away, above the process.exit(2) that
// ends argument parsing - where two of its own sentences were false ("the only place that decision
// exists"; "the comment above"). It was filed as a misplaced-location defect and I fixed it by
// moving the token rather than re-reading what it described, which is precisely the mistake the
// note clause beside it made in the same cycle. A comment about a line has to be read AT that line.
process.exit(bad ? 1 : 0);
