// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-41";
export const RELEASE_NOTE =
  "R-I: the Trainer login shrinks to its job. Doors: Home and Batches only - " +
  "no Locations tab, no other trainers, no all-candidates list ('my job is " +
  "primarily to go to a batch'). The batch list opens on MY batches, with one " +
  "click widening to the centre's other batches for guest-faculty duty - " +
  "still never another centre's (Rule 38). This closes the CEO's 14/08 " +
  "recorded-review backlog: every R-A..R-I cluster is shipped.";
