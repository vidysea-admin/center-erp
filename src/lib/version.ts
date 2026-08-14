// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-24";
export const RELEASE_NOTE =
  "List endpoints sanitize ?limit before the page cap (maker-found M-02): a " +
  "non-numeric, zero, or negative limit used to make the query return the whole " +
  "collection (or a negative-slice count) instead of a page - now coerced to a " +
  "positive integer, default 50, hard-capped at 5000. No behaviour change for " +
  "valid values; scope filters were never affected.";
