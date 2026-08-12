// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.12-4";
export const RELEASE_NOTE =
  "Sheet Watch, backward planner, eligibility+SIDH, public forms, feedback, " +
  "role permissions, self-signup with Admin approval";
