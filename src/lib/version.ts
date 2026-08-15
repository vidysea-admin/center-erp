// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-72";
export const RELEASE_NOTE =
  "QA-132 maker-half + QA-025 P3 + double-submit guards. The product " +
  "LISTENS for bounces now: /api/public/ses-notifications takes the " +
  "SES SNS feed (subscription confirm with an AWS-only SSRF guard; " +
  "Bounce/Complaint flip the MailLog row to BOUNCED/complained with " +
  "the diagnostic) - a typo'd address stops looking like a success " +
  "the moment devops points the SNS topic at this URL, their one " +
  "console step. Rights phase 3: the user list, the sheet-changes " +
  "queue and government attendance READ at view level; every write " +
  "keeps needing edit. And the four main create forms carry in-flight " +
  "guards - a double click is one POST now.";
