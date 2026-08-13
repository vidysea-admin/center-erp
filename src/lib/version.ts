// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-8";
export const RELEASE_NOTE =
  "SPOC directory: Locations page gets a derived one-row-per-person directory " +
  "(keyed by phone) showing each SPOC's centres — the CEO's 'ek SPOC, multiple " +
  "locations pe mapping, Om Prakash das mat banana'. Same phone under different " +
  "name spellings, or same name under multiple phones, is flagged with a warning " +
  "badge for correction — never silently merged. Read-only lens; no data changes.";
