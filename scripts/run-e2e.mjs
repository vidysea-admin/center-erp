// Test runner (2026-08-13): runs EVERY suite and reports a per-suite table at the end.
// Replaces the fail-fast `&&` chain in package.json — one broken suite used to hide whether
// the other seven passed, and the suite list was hand-duplicated between package.json and
// ci.yml. This file is now the single place the list lives.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));

const SUITES = [
  // -111: static source scan — no user-facing string may carry a Rule/DEC/QA code. No server needed.
  "check-user-copy.mjs",
  // -112: structural pin — the trainer's daily-log strip must not be nested inside an Admin-only block.
  "check-home-structure.mjs",
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
{
  const args = process.argv.slice(2);
  const asked = args.filter((a) => !a.startsWith("-"));
  // QA-1272 (checker, Mode A on qa-1096 — the maker asked for exactly this to be hunted): arguments
  // were given and NONE of them survived the flag filter, so the block below is skipped and the FULL
  // wall runs while the operator believes they asked for one suite. The line that would have said so
  // ("running N of the full wall") is inside that block, so nothing prints. A typo'd leading dash is
  // all it takes. Loud, in the same shape as the unknown-suite refusal below, so there is no second
  // predicate to drift from this one.
  if (args.length && !asked.length) {
    console.error("");
    console.error("run-e2e: every argument was read as a flag, so no suite was selected: " + args.join(", "));
    console.error("Running the whole wall here would look like the subset you asked for. Refusing instead.");
    console.error("To run the full wall, pass no arguments at all (`npm test`).");
    console.error("");
    process.exit(2);
  }
  if (asked.length) {
    const unknown = asked.filter((a) => !SUITES.includes(a));
    if (unknown.length) {
      console.error("");
      console.error("run-e2e: unknown suite(s): " + unknown.join(", "));
      console.error("Known suites (the list lives here, so this is the whole set):");
      for (const s of SUITES) console.error("    " + s);
      console.error("");
      process.exit(2);
    }
    SUITES.length = 0;
    SUITES.push(...asked);
    console.log("run-e2e: running " + asked.length + " of the full wall - " + asked.join(", "));
    console.log("  (a subset is not a wall. Its green is evidence about these suites only.)");
  }
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
for (const suite of SUITES) {
  console.log(`\n━━━ ${suite} ━━━`);
  const r = spawnSync(process.execPath, [path.join(dir, suite)], { encoding: "utf-8", env: process.env, maxBuffer: 32 * 1024 * 1024 });
  process.stdout.write(r.stdout ?? "");
  if (r.stderr) process.stderr.write(r.stderr);
  const m = (r.stdout ?? "").match(/(\d+) passed, (\d+) failed\s*$/m);
  results.push({
    suite,
    passed: m ? Number(m[1]) : 0,
    failed: m ? Number(m[2]) : 0,
    crashed: !m || r.status === null, // no final count = the suite died before finishing
    exit: r.status,
  });
}

console.log("\n━━━ Summary ━━━");
let totalPass = 0, totalFail = 0, bad = 0;
for (const r of results) {
  totalPass += r.passed; totalFail += r.failed;
  const state = r.crashed ? "CRASHED" : r.failed > 0 ? "FAILED" : "ok";
  if (r.crashed || r.failed > 0 || r.exit !== 0) bad++;
  console.log(`${state.padEnd(8)} ${r.suite.padEnd(32)} ${r.passed} passed, ${r.failed} failed${r.crashed ? " (no final count — crashed?)" : ""}`);
}
// -153 (QA-354): a CRASHED suite reports `passed: 0, failed: 0`, so it adds nothing to either
// total and the TOTAL line read "0 failed" while suites were dying. The per-suite rows do say
// CRASHED - but the TOTAL line is the one that gets QUOTED, into manifests, commit messages and
// release notes, and it is the line that has to refuse to look clean. Measured today: a run in
// which 15 of 17 suites crashed still printed a totals line reading 0 failed.
const crashedSuites = results.filter((r) => r.crashed);
const quietFailures = results.filter((r) => !r.crashed && r.failed === 0 && r.exit !== 0);
let totalLine = `\nTOTAL: ${totalPass} passed, ${totalFail} failed across ${results.length} suites`;
if (crashedSuites.length) {
  totalLine += `\n!! ${crashedSuites.length} SUITE(S) CRASHED and contributed NO counts, so the numbers above are NOT a pass: ` +
    crashedSuites.map((r) => r.suite).join(", ");
}
if (quietFailures.length) {
  totalLine += `\n!! ${quietFailures.length} suite(s) reported no failures but exited non-zero: ` +
    quietFailures.map((r) => `${r.suite} (exit ${r.exit})`).join(", ");
}
console.log(totalLine);
process.exit(bad ? 1 : 0);
