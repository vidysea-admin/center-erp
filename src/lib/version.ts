// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-27";
export const RELEASE_NOTE =
  "The money chain after Completed is visible (QA-048): every Completed/Closed " +
  "batch shows where it stands - awaiting certification / invoice to raise / " +
  "payment pending / dues to settle / ready to close - derived from the same " +
  "Closure+Invoice facts Rule 52 enforces. 'Close Batch' disables itself and " +
  "names what is still needed instead of bouncing (QA-004). A Completed batch " +
  "with zero students is Amber, never Green, and an Active one names 'no " +
  "students on the roster' as the reason (QA-003). The main Batches list " +
  "announces how many positions Preparation is holding back (QA-030).";
