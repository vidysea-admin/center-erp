// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.13-6";
export const RELEASE_NOTE =
  "Table readability: every table now has a per-column min-width floor, so a wide table " +
  "(Sheet Watch with paragraph-long old→new diffs) scrolls horizontally instead of crushing " +
  "every column into slivers; heavy columns (Sheet Watch/Sync old→new, row keys) declare the " +
  "room they need; cells top-align so tall rows read row-wise. Sync inbox old→new is now " +
  "searchable text too.";
