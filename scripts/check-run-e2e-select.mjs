// check-run-e2e-select - the pre-push suite SELECTOR in run-e2e.mjs (ISS-39, 2026-10-19).
//
// WHY: the 6c pre-push wall always ran every suite (~39 suites, ~8k tests, 44-233 min). run-e2e.mjs
// can now pick the suites a change can reach (--affected / --files / --suites). A selector that
// UNDER-selects ships a regression behind a green, so its rules are pinned here: docs-only stays
// cheap, a suite file selects itself, shared test infra / config / unknown paths fall back to the
// FULL wall (and say why), and a route change selects the suites that call that route.
//
// No server, no database, no port: it only runs `run-e2e.mjs --list`, which exits before any guard.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const runner = path.join(dir, "run-e2e.mjs");
let passed = 0, failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (extra === undefined ? "" : "  -> " + extra)); }
};

function list(args) {
  const r = spawnSync(process.execPath, [runner, "--list", ...args], { encoding: "utf-8" });
  const out = r.stdout ?? "";
  return {
    status: r.status,
    stderr: r.stderr ?? "",
    mode: out.match(/^MODE=(\w+)/m)?.[1],
    reason: out.match(/^REASON=(.*)$/m)?.[1] ?? "",
    suites: [...out.matchAll(/^SUITE (\S+)$/gm)].map((m) => m[1]),
    total: Number(out.match(/^SELECTED \d+ of (\d+)/m)?.[1]),
    shards: Number(out.match(/^SHARDS=(\d+)/m)?.[1]),
  };
}
const STATIC = ["check-user-copy.mjs", "check-home-structure.mjs", "check-money-mask.mjs", "check-no-seed-literal.mjs"];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sel-"));
const files = (...paths) => { const f = path.join(tmp, "files.txt"); fs.writeFileSync(f, paths.join("\n") + "\n"); return ["--files", "@" + f]; };

const full = list([]);
ok("full wall lists every suite and reports mode=full", full.status === 0 && full.mode === "full" && full.suites.length === full.total && full.total > 30, JSON.stringify([full.status, full.mode, full.total]));
ok("this check is itself in the wall", full.suites.includes("check-run-e2e-select.mjs"));

const docs = list(files("README.md", "docs/x.md", "qa/foo.md"));
ok("docs-only change selects only the no-server static checks", docs.mode === "scoped" && docs.suites.length === STATIC.length && STATIC.every((s) => docs.suites.includes(s)), docs.suites.join(","));

const own = list(files("scripts/e2e-dropout.mjs"));
ok("a changed suite file selects itself plus the static checks, not the whole wall", own.mode === "scoped" && own.suites.includes("e2e-dropout.mjs") && STATIC.every((s) => own.suites.includes(s)) && !own.suites.includes("e2e-roles.mjs"), own.suites.join(","));

for (const infra of ["package.json", "scripts/e2e-lib.mjs", "scripts/seed.mjs", "scripts/run-e2e.mjs", ".github/workflows/ci.yml", "src/models/index.ts", "src/proxy.ts"]) {
  const r = list(files(infra));
  ok("shared infra/config falls back to FULL: " + infra, r.mode === "full" && r.suites.length === r.total && /\S/.test(r.reason), r.mode + " " + r.suites.length);
}
const unknown = list(files("weird/thing.xyz"));
ok("an unmapped path falls back to FULL and says why", unknown.mode === "full" && /unmapped/i.test(unknown.reason), unknown.reason);

const route = list(files("src/app/api/candidates/import/route.ts"));
ok("a route change selects the suite that calls that route", route.mode === "scoped" && route.suites.includes("e2e-import-into-batch.mjs"), route.mode + " " + route.suites.length);
ok("a route change does not select unrelated suites", route.mode === "scoped" && !route.suites.includes("e2e-proxy.mjs") && !route.suites.includes("e2e-admin-floor.mjs"), route.suites.join(","));

const lib = list(files("src/lib/daily-digest.ts"));
ok("a lib change selects the suite that loads it", lib.mode === "scoped" && lib.suites.includes("e2e-daily-digest.mjs"), lib.mode + " " + lib.suites.join(","));

const named = list(["--suites", "e2e-dropout,e2e-proxy.mjs"]);
ok("--suites picks exactly the named suites (name with or without .mjs)", named.mode === "scoped" && named.suites.join(",") === "e2e-dropout.mjs,e2e-proxy.mjs", named.suites.join(","));
const bad = list(["--suites", "nope"]);
ok("--suites with an unknown name is refused (exit 2)", bad.status === 2 && /unknown suite/i.test(bad.stderr), bad.status + " " + bad.stderr.slice(0, 80));
const onlyFlags = list(["--bogus"]);
ok("a lone unknown flag is refused rather than running the whole wall", onlyFlags.status === 2, String(onlyFlags.status));

const serial = list(["--suites", "e2e-dropout,e2e-proxy", "--concurrency", "4"]);
ok("server/DB suites never run in parallel (shards stays 1)", serial.shards === 1, String(serial.shards));
const par = list(["--suites", STATIC.join(","), "--concurrency", "3"]);
ok("the no-server static checks may run in a pool (shards = 3)", par.shards === 3, String(par.shards));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\ncheck-run-e2e-select: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
