// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.13-12";
export const RELEASE_NOTE =
  "The sync ENGINE now resolves merged cells itself (Umesh: 'ye kaam code ko karna chahiye " +
  "tha') — every grid the app reads (Sheet Watch diffs, mapped sync, tab-mapping imports) " +
  "goes through one merge-expanding reader, so continuation rows carry their institution " +
  "instead of appearing as '· Solar Panel…' keys, and the 30-minute sync tracks the same " +
  "values a human sees in Excel. No more manual re-seeds to correct counts.";
