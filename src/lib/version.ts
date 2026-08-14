// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-19";
export const RELEASE_NOTE =
  "English-only user-facing copy (Umesh 14/08): the public candidate portal " +
  "(My Training entry + attendance page), the WhatsApp trainer application " +
  "form, login/signup doors, the quick-invite drawer, every WhatsApp/SMS " +
  "message template and the portal-lookup error now speak English.";
