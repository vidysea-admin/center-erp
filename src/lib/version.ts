// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-28";
export const RELEASE_NOTE =
  "Home KPIs stop misreading (checker round): a scoped user's Active Trainers " +
  "KPI now scopes the same way the trainers list does - nominated OR capable OR " +
  "home centre (QA-011); Total Attendance carries expected-so-far, so an empty " +
  "log book says 'no daily logs yet - N student-days expected' instead of '0 of " +
  "0' (QA-012); the certified total travels with 'N on approved positions' so " +
  "Home and the Open Positions board reconcile by construction (QA-002). " +
  "(-14-27 in the same train: visible money chain, honest Close button, " +
  "no-Green empty batches, Preparation banner.)";
