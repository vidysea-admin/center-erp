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
  "e2e-roles.mjs",
  "e2e-sync.mjs",
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
];

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
  const db = process.env.MONGODB_DB || "center_erp_ci";
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
