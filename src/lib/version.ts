// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-15";
export const RELEASE_NOTE =
  "F-A4 (Manish): the closure evidence files finally have a UI - the Assessment " +
  "section gets a Result-sheet slot and the Certification section a Certificate-" +
  "bundle slot (view link when present, Upload/Replace until the batch closes; " +
  "post-completion the closure stays frozen per DEC-6). Fields existed in the " +
  "schema since day one with no way to fill them.";
