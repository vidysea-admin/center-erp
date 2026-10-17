// check-no-seed-literal - the repo must never again carry the seed/test admin password as a literal.
//
// WHY: the seed/CI admin default was written into ci.yml, seed.mjs (and printed by it), every e2e
// harness (`process.env.ADMIN_PASSWORD || "<literal>"`) and the docs, and checkers then copied those
// into qa/evidence/**. A name-based guard missed it. This check works by VALUE and by SHAPE, and it
// prints only file:line - never the matched text.
//
// The value is identified by the first 8 hex chars of its sha256 (H1 = 240be518), so this file
// holds no plaintext. No server, no database, no port.
//   1. VALUE: no 8-char window of any tracked (or new, non-ignored) text file hashes to H1.
//   2. SHAPE: no `ADMIN_PASSWORD || "..."` / `?? "..."` fallback, and no literal `ADMIN_PASSWORD: x` in YAML.
//   3. CI: the workflow generates the credentials per run, masks them and exports via GITHUB_ENV.
//   4. SEED: seed.mjs takes the password from the environment and never logs it.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const H1_PREFIX = "240be518";
const WINDOW = 8;

let passed = 0, failed = 0;
const ok = (name, cond, extra) => {
  if (cond) { passed++; console.log("PASS  " + name); }
  else { failed++; console.log("FAIL  " + name + (extra === undefined ? "" : "  -> " + (Array.isArray(extra) ? extra.slice(0, 20).join(", ") : extra))); }
};

const listed = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 1 << 28 })
  .toString().split("\0").filter(Boolean);

const read = (f) => { try { const b = readFileSync(path.join(root, f)); return b.includes(0) ? null : b.toString("utf8"); } catch { return null; } };

const valueHits = [], shapeHits = [];
const FALLBACK = /ADMIN_PASSWORD\s*(?:\|\||\?\?)\s*["'`]/;
const YAML_LITERAL = /ADMIN_PASSWORD:\s*["']?[A-Za-z0-9]/;
for (const f of listed) {
  const text = read(f);
  if (text === null) continue;
  const isYaml = /\.ya?ml$/.test(f);
  text.split("\n").forEach((line, i) => {
    if (line.length > 3000) return;
    for (let k = 0; k + WINDOW <= line.length; k++) {
      if (createHash("sha256").update(line.slice(k, k + WINDOW)).digest("hex").startsWith(H1_PREFIX)) { valueHits.push(f + ":" + (i + 1)); break; }
    }
    if (f !== "scripts/check-no-seed-literal.mjs" && (FALLBACK.test(line) || (isYaml && YAML_LITERAL.test(line)))) shapeHits.push(f + ":" + (i + 1));
  });
}
ok("VALUE: no tracked file contains the seed/test admin password (sha256 prefix " + H1_PREFIX + ")", valueHits.length === 0, valueHits);
ok("SHAPE: no `ADMIN_PASSWORD || \"literal\"` fallback and no literal ADMIN_PASSWORD in YAML", shapeHits.length === 0, shapeHits);

const ci = read(".github/workflows/ci.yml") ?? "";
ok("CI: workflow masks a generated per-run password", /openssl rand/.test(ci) && /::add-mask::/.test(ci));
ok("CI: generated credentials are exported through GITHUB_ENV", /GITHUB_ENV/.test(ci));

const seed = read("scripts/seed.mjs") ?? "";
ok("SEED: reads the admin password from process.env.ADMIN_PASSWORD", /process\.env\.ADMIN_PASSWORD/.test(seed));
ok("SEED: exits non-zero when ADMIN_PASSWORD is unset", /ADMIN_PASSWORD[\s\S]{0,200}process\.exit\(1\)/.test(seed));
ok("SEED: never logs the password", !/console\.(log|info|warn|error)\([^)]*adminPassword/.test(seed) && !/console\.(log|info)\([^)]*process\.env\.ADMIN_PASSWORD/.test(seed));

console.log(`\ncheck-no-seed-literal: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
