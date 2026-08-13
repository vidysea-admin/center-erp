// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-9";
export const RELEASE_NOTE =
  "Certificates bulk upload: pick a whole folder's files on the batch Closure tab; " +
  "each filename's CAN id joins to the roster's SIDH candidate id and the certificate " +
  "lands on that candidate automatically — files with no id, no roster match, an " +
  "ambiguous id, or a non-Pass result are reported by name with the reason, never " +
  "guessed. On a Completed batch only an ABSENT certificate file may be filled " +
  "(the DEC-6 freeze stays intact for everything recorded).";
