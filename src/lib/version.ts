// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-21";
export const RELEASE_NOTE =
  "Trainer application actually saves (QA-040): the prefill no longer races over " +
  "what the applicant typed, and the server writes via the supported set() path - " +
  "a blank field never erases what staff pre-typed. Applications now notify " +
  "Admin/Operations (QA-041). Batches list gains an 'Entered by' column (QA-022). " +
  "Late-arrival certificates on a batch with NO recorded closure now derive the " +
  "closure figures - '0 passed' on a batch holding 7 certificates was the guard " +
  "being too broad (QA-044); recorded batch-level figures stay protected.";
