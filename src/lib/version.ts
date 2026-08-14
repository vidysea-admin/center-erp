// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-25";
export const RELEASE_NOTE =
  "Checker round three. QA-042: the certificate freeze now asks whether a batch " +
  "was EVER marked per-candidate (rows carry a late_arrival marker) instead of " +
  "counting rows that existed before this request - a second tranche of " +
  "certificates no longer rewrites protected batch-level figures. QA-031/045: " +
  "trainer availability is derived from real batch links (live_batches on every " +
  "row) and the CEO's own word - 'Ready to Train', not 'Available'. QA-053: " +
  "?limit=1e9 / 1.5 parse numerically instead of collapsing to 1. QA-051: Home " +
  "KPI labels wrap instead of truncating on a phone.";
