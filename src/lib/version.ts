// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.12-6";
export const RELEASE_NOTE =
  "Government portal attendance import + reconciliation, scheme timing guidelines " +
  "(09:00-18:00, 4h sessions, 2/day), contract counting rules (absent counts as appeared, " +
  "dropped-but-passed not billable), 100MB uploads, SMS alongside WhatsApp, " +
  "any-sheet sync sources with link testing";
