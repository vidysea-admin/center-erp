// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-22";
export const RELEASE_NOTE =
  "Checker round: 'Entered by' visible by default (QA-022); roster shows Result + " +
  "Certificate + Source (QA-043/039); Closure tab offers 'Derive figures from rows' " +
  "on legacy batches with no recorded closure (QA-044) via a guarded recompute " +
  "endpoint; every govt-attendance count is a clickable filter, on the list and in " +
  "the detail (QA-023); every importer offers its sample sheet (QA-028); the " +
  "Invoice section renders only for Admin/Operations (QA-038); Open Positions " +
  "gets its own navigation door (Karunn: 'side me chahiye').";
