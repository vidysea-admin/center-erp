// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-96";
export const RELEASE_NOTE =
  "-96: prod ladder on -95 proved token + bucket (ASIA-SOUTH1, uniform, PAP enforced) and " +
  "stopped at cors: 'Provided scope(s) are not authorized' - the WIF token was scoped " +
  "devstorage.read_write; bucket-metadata PATCH needs full_control (now the SDK's default " +
  "scopes). The cors rung is non-fatal so every rung reports; verdict stays red until CORS " +
  "is in place.";
