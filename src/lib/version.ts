// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-7";
export const RELEASE_NOTE =
  "Visibility polish: the trainer journey is a stage-count strip (har stage pe kitne, " +
  "aur us stage pe kitne REJECTED — click filters the list); every batch shows the " +
  "CEO's 3-way attendance — Expected so far (operating days × roster, with hours) vs " +
  "our trainer-marked days vs the govt portal, gaps amber; and settled (Closed) " +
  "batches finally have their own pill on the Batches list.";
