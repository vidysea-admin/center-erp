// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-43";
export const RELEASE_NOTE =
  "R-K: the programme gets a front door. /programs/[id] - facts (QP, scheme, " +
  "training hours, duration, extra trainer documents; the Admin-only amount " +
  "renders only for the Admin, the API masks it for everyone else), the " +
  "centres running the job role with their hiring positions (reusing the Open " +
  "Positions derivation), and every batch under it. The programme name is now " +
  "a link wherever it appears - candidate rows, the batch list and the batch " +
  "header - completing the CEO's click-through ask: candidate, location, " +
  "batch and programme all open their detail.";
