// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-1";
export const RELEASE_NOTE =
  "Open Positions (the CEO's new section): a third tab on Trainers listing every approved " +
  "centre × approved job role with required / certified (ours, live) / in-pipeline / " +
  "balance-to-hire — sortable and filterable by location AND by job role, exactly the two " +
  "cuts Karunn asked for. A position closes BY ITSELF the moment the required number of " +
  "trainers is certified for that centre × job role ('do certify ho gaye toh wo location " +
  "close'). Derived fresh on every load, never stored. Divya's hiring workspace.";
