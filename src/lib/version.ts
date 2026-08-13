// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-5";
export const RELEASE_NOTE =
  "Pipeline speaks the CEO's words: Applied shows as Fresh Lead, Shortlisted as " +
  "Shortlisted (for TOT), Payment Done as TOT Payment Done — display labels only, " +
  "the stored stages never change. A Dropped trainer now NAMES the stage the journey " +
  "ended at (chip says Dropped at CV Reviewed; the journey rail marks rejected here) " +
  "— har stage pe accepted/rejected ab dikhta hai.";
