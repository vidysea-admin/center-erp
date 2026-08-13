// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.13-1";
export const RELEASE_NOTE =
  "Self-serve sheet ingestion: the tab-mapping wizard (propose → user approves columns → the " +
  "5-minute watch imports the tab on its own; changes to existing records stay human-gated with " +
  "Apply value + revert). Edit-after-import: candidate edit drawer, batch centre/role correction " +
  "window, cost entry edit/delete, TC identity fields, targets behind locations.manage. Eval " +
  "refresh: 15 suites / ~1,100 assertions via scripts/run-e2e.mjs — which found and fixed the " +
  "severity-sort, stage-jump-by-PATCH, dropped-Defaults-writes, negative-cost and Sync-Now-gating defects";
