// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.12-9";
export const RELEASE_NOTE =
  "The RPL business, modelled: schemes and TC identity, the 14-stage trainer hiring journey " +
  "(documents gate incl. per-job-role extras, NSDC round-trip, ₹3250 auto-costed, TOT, TR ID), " +
  "the location×trainer×candidate readiness with a Home queue, TR-ID-gated trainer dropdowns, " +
  "SIDH batch id + Drive folder, registration-failed queue, per-candidate attendance, and both " +
  "client sheets watched with derived counters cross-checking them";
