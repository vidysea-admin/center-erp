// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-71";
export const RELEASE_NOTE =
  "QA-027 (loop tick 3): the status vocabularies are reconciled, on " +
  "paper and in the product. The cell-by-cell table (client module " +
  "spec vs live enums vs the CEO's own spoken renames) lives in " +
  "qa/VOCAB-RECONCILE-QA027.md - one FIX, zero undecided cells, the " +
  "rest intentional with the CEO's vocabulary quoted. The FIX ships " +
  "here: the spec's blocker states (Trainer Required / Candidate " +
  "Shortage / Infrastructure Pending) are FILTERABLE on the batch " +
  "list now - computed from the Preparation engine's own blockers, " +
  "joined by centre x role, never a parallel enum that could drift.";
