// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-18";
export const RELEASE_NOTE =
  "Certificate bulk upload learns late-arrival results: on a Completed batch " +
  "that finished with batch-level figures (no per-candidate rows), an uploaded " +
  "CAN-id certificate creates the Pass row carrying that file as evidence " +
  "(Rule 45 by construction). Recorded batch-level closure figures stay frozen " +
  "(Rule 42/S0 guard); everything already recorded stays DEC-6-locked.";
