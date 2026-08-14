// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-58";
export const RELEASE_NOTE =
  "QA-105: candidates get a document store - the full trainer pattern " +
  "(Aadhaar/PAN/photo/education/bank-passbook, multi-pick with the type " +
  "detected per filename, re-upload replaces, DELETE from day one with " +
  "the audit log keeping what left and who removed it, Rule 38 scope " +
  "from the candidate's own centre). QA-099: the app sends security " +
  "headers now - frame-deny, nosniff, HSTS, referrer policy, and a " +
  "report-only CSP to grow into. QA-065: no more buttons that exist " +
  "only to bounce - a view-only user or a role the server refuses gets " +
  "no Add/Import/Quick-add affordance on the trainers page. Plus the " +
  "Institution ID joins the centre detail's Master fields form.";
