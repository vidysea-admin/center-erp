// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-13";
export const RELEASE_NOTE =
  "F-A3 (Manish): 'TOT done at least three days before batch start' is a HARD " +
  "readiness gate now, not advisory — a batch cannot go Ready while its trainer's " +
  "TOT completion date is inside the lead window (Defaults.lead_tot_done_days, 3 " +
  "by default). Applies only when the TOT date is on record; trainers who predate " +
  "the pipeline are not retro-blocked.";
