// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-11";
export const RELEASE_NOTE =
  "Trainer admin round (Manish backlog): F-B1 — all four compensation types in the " +
  "dropdown (Batch-wise / Monthly / Fixed / Incentive-based) and the trainer-fee " +
  "suggestion now follows the model (batch-wise or fixed amount when recorded, else " +
  "day-rate x training days, basis named in the note); F-B5 — a halted centre stops " +
  "HIRING too: no new trainer requests for it, no nominating or re-pointing trainers " +
  "at it, resumes when the centre does.";
