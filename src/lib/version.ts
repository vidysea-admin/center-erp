// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-32";
export const RELEASE_NOTE =
  "CEO reset tooling. POST /api/admin/wipe (TEMPORARY - Admin only, dry-run by " +
  "default, applies only with the exact confirmation phrase): removes every " +
  "business record while preserving logins, the permission matrix, approval " +
  "rules, masters and the batch-code counter - the CEO-ordered clean slate. " +
  "POST /api/admin/avpl-rebase (permanent): rebuilds Locations, Programmes and " +
  "LocationTargets from the client's AVPL OneDrive master workbook, dry-run " +
  "first, upsert-by-code - no trainers, candidates or batches are invented. " +
  "Data re-enters only via team entry, Excel importers, or sheet-sync accepts.";
