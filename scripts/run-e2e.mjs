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
