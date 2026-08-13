// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.13-3";
export const RELEASE_NOTE =
  "List-UX cycle: every list gets status-tag pills with counts + per-column sorting (trainers " +
  "available/under-preparation/assigned, batches by status with inline Planning gaps, candidates " +
  "incl. No-programme/Multi-interest/Not Certified, locations by approval). Dashboard KPIs deep-link " +
  "to the same filtered population they count. New Preparation board (Batches → Preparation): every " +
  "location×job-role target with what is still missing before a batch can start. Manual-entry parity: " +
  "trainer nomination (centre × job role) finally settable in the UI (the hiring journey is now " +
  "completable end-to-end), trainer qualification/experience/source inputs, stage backdating, " +
  "client-reported target figures, room edit/out-of-service, the 2 missing planner knobs. " +
  "B12 fixed: /batches?location= honoured + drawer prefill";
