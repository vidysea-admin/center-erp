// Test runner (2026-08-13): runs EVERY suite and reports a per-suite table at the end.
// Replaces the fail-fast `&&` chain in package.json — one broken suite used to hide whether
// the other seven passed, and the suite list was hand-duplicated between package.json and
// ci.yml. This file is now the single place the list lives.
import { spawnSync } from "node:child_process";
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
console.log(`\nTOTAL: ${totalPass} passed, ${totalFail} failed across ${results.length} suites`);
process.exit(bad ? 1 : 0);
