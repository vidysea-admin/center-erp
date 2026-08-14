// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-37";
export const RELEASE_NOTE =
  "R-E: Operations is post-only on money. An Operations cost entry now PARKS " +
  "in the Admin's approval queue (202) - the ledger row is written only by the " +
  "approval itself, owned by the person who posted it; a rejection carries the " +
  "Admin's note so it can be fixed and reposted. The ledger, batch Costs tab " +
  "and Sheet Sync leave the Operations view entirely (CEO: 'they shouldn't be " +
  "able to see anything else'); their own submissions live under My " +
  "submissions. Admin, as the configured approver, posts straight through. " +
  "Enable per environment: approval rule cost.post (ships OFF by design).";
