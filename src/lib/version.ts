// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.13-2";
export const RELEASE_NOTE =
  "Manish-walkthrough cycle: six operational decisions recorded and enforced (dropped-but-passed " +
  "never bills — Closure carries the billable split; Completed batches fully locked incl. the " +
  "certificate-PATCH and closure-PUT leaks; sessions exactly 4 or 8 hours inside 09:00–18:00). " +
  "Live-reported fixes: roster/pool now takes only the batch's own centre+job role (server-enforced), " +
  "trainer row/search opens the hiring-journey page, program dropdowns show the scheme, Home KPI " +
  "counts Approved locations. New: per-student attendance links (/p/attendance — days, hours, exam " +
  "eligibility at min_attendance_pct of programme hours), trainer-present-first daily logs (portal " +
  "rule), per-batch portal-attendance import + Govt days roster column, assessment-date alert, " +
  "trainer home-location Others. Baseline 1,130 asserts / 15 suites";
