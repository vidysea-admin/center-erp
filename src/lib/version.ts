// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-65";
export const RELEASE_NOTE =
  "QA-116: the OTP enrolment path exists - the second of the CEO's " +
  "'one of the two'. A walk-in candidate with no centre link opens " +
  "/p/enrol, proves their email with a 6-digit one-time code (hash-" +
  "only storage, 10-minute expiry, 5 wrong tries burn it, rate-" +
  "limited, honeypot), then registers through the same field set the " +
  "link path uses - centre chosen from operational ones, phone " +
  "format-checked (QA-141), confirmation mailed to the VERIFIED " +
  "address. Single-use challenge; intake only, never unlocks an " +
  "existing record. Linked from the signup page.";
