// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-20";
export const RELEASE_NOTE =
  "Tables: header row now stays pinned while you scroll (every table, via the " +
  "shared component) and long tables scroll inside their own frame; batch-detail " +
  "tab tables show loading skeletons instead of blanks. Trainer pipeline funnel " +
  "filter speaks the renamed display labels (was raw enum - the 'old labels in " +
  "filters' catch). Status pills explain themselves on hover (N01/N02: the states " +
  "are mutually exclusive today-states, not a funnel). Cert upload without a " +
  "multipart body now answers 400, not 500.";
