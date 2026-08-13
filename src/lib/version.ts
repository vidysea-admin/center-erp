// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-14";
export const RELEASE_NOTE =
  "F-A9 (Manish): the readiness screen's empty trainer slots become TrainerRequests " +
  "in one click - new POST /api/trainer-requests/from-shortfall scans centre x job-role " +
  "rows whose pipeline is empty, skips halted/unapproved centres and existing Open " +
  "requests (each skip named), notifies Ops per request; 'Raise requests for gaps' " +
  "button on the centre's Trainer-slots panel.";
