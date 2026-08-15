// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-89";
export const RELEASE_NOTE =
  "Umesh 15/08 23:45: 'sab .env me hai, tu check kar le, gap ho to fix kar.' " +
  "The app used to be strict about the Drive env (exact names, raw values) and " +
  "mute about what it saw. Now: values are read liberally (aliases GDRIVE_/GOOGLE_/" +
  "OAUTH_ forms, trimmed, surrounding quotes stripped, SA key as base64 OR raw " +
  "JSON), and the Admin storage banner + /api/test-storage say exactly which " +
  "Drive names reached THIS container (names and lengths only, never values) " +
  "with SES_SMTP_USER / MONGODB_URL as the control, plus a one-line hint. " +
  "Compression, transport and everything else unchanged.";
