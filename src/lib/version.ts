// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-54";
export const RELEASE_NOTE =
  "QA-115 (CEO [19:48] 'I didn't get the mail'): the product can send " +
  "email now. SES SMTP transport (the working pathlynks setup, hardened: " +
  "no open endpoint, server-built templates, pooled connection, every " +
  "attempt logged in MailLog as sent/failed/skipped). Seven mail moments: " +
  "account approved, account created (never the password), candidate " +
  "registration confirmation, trainer application acknowledgement, " +
  "quick-invite link straight to the applicant's inbox, and inbox " +
  "mirrors of the batch-opened / approval-needed / trainer-request / " +
  "trainer-application alerts to the exact roles the bell targets. " +
  "Admin kill-switch in Defaults; sending stays safely OFF until the " +
  "SES environment variables are set on the server - every skipped send " +
  "is recorded, nothing ever fails a business action. Admin-only " +
  "/api/test-email verifies the connection in one click. Also QA-104: " +
  "the defaults no longer advertise a 100 MB upload cap that does not " +
  "exist.";
