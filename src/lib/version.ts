// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-10";
export const RELEASE_NOTE =
  "F-B17 defect fix: master-list names are unique case-insensitively (the refusal " +
  "names the existing entry), and the trainer-fee auto-suggest matches its category " +
  "case-insensitively — production carried 'Trainer fee' beside 'Trainer Fee' and " +
  "the suggestion silently broke. The unused lowercase duplicate was removed from " +
  "production (backed up first).";
