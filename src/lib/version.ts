// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-40";
export const RELEASE_NOTE =
  "R-H polish, from the CEO's own clicks. The programme master now carries its " +
  "scheme, QP training hours (the number behind 'qualified for assessments') " +
  "and the amount we receive - which the API shows to Admin ALONE, masked for " +
  "every other login. Candidate rows: the location and the batch number are " +
  "real links to their detail pages. The Source column leaves the Enrollment " +
  "view ('we don't need it once the data is included here') while Admin/Ops " +
  "keep provenance. And the enroll dashboard no longer greets as 'Shubham " +
  "enrollment' - the role account carries a role name.";
