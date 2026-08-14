// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-47";
export const RELEASE_NOTE =
  "The not-built set, built. QA-046: the Accepted/Rejected pair shows at " +
  "EVERY pipeline stage, zeros included. QA-075: a SPOC's classroom/lab " +
  "suggestion parks for Admin approval like their field edits - the Room is " +
  "created only by the approval - and a cluster-head number that matches the " +
  "SPOC's says '= SPOC' instead of printing the same digits twice. QA-033: " +
  "per-candidate marking is the default path; legacy batch-level figures " +
  "hide behind their own explicit button and never ride a save unseen. " +
  "QA-022: an app-created batch's Source says WHO entered it, and the " +
  "batches table gains the column picker. QA-032/021/069: assignment stamps " +
  "the journey's middle (Assigned) - the pre-wipe rows that skipped it were " +
  "seed artifacts; e2e now pins the full chain.";
