// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-60";
export const RELEASE_NOTE =
  "QA-125 follow-up (checker design note): trainer document DELETE is " +
  "now narrower than read/upload. capable_locations is a teaching tie - " +
  "it no longer grants every capable centre's SPOC the right to erase a " +
  "trainer's Aadhaar/PAN. Deletion belongs to the nominating or home " +
  "centre; a capable-only trainer (the quick-invite window) falls back " +
  "to the union so a mis-upload stays fixable without an Admin. Reads " +
  "and uploads keep the wide union.";
