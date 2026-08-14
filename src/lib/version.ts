// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-39";
export const RELEASE_NOTE =
  "R-G: the Open Positions board maps the whole trainer pipeline against every " +
  "position - Fresh / Shortlisted / Docs / NSDC / Approved / Certified counts " +
  "per centre x job role, so 'which position needs our focus' is readable at a " +
  "glance. Every stage count is CLICKABLE and opens the actual people (each " +
  "linking to their profile). New approved/not-approved toggle - the default " +
  "stays approved-only exactly as asked, and a not-approved row names WHY " +
  "(centre pending vs TC status pending). 'Closed' now reads 'Filled'.";
