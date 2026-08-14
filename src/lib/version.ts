// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-23";
export const RELEASE_NOTE =
  "Trainer pipeline stages MERGED per the CEO (QA-020): CV Reviewed absorbs " +
  "Shortlisted (label: CV Review & Shortlist), Docs Pending absorbs Docs Complete " +
  "(label: Documents) - the papers-in gate now runs at Nomination Prepared (Rule " +
  "T2, unchanged strength); old names stay importable as aliases; prod rows " +
  "remapped by the 14/08 migration. Fresh candidates get their own journey " +
  "(QA-021): Fresh Lead / Portal Link Sent / Registered on Portal, derived from " +
  "sidh_status. Sample-sheet headers speak English.";
