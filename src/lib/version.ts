// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-17";
export const RELEASE_NOTE =
  "Candidate import learns the interest fields (F-B4 complete): map comma-" +
  "separated centre / job-role NAMES into interested_locations / " +
  "interested_programs - exact case-insensitive resolution, ambiguous or " +
  "unknown names reported in the preview and left blank, never guessed.";
