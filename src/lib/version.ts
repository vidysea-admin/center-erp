// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.13-5";
export const RELEASE_NOTE =
  "Umesh-testing fixes (13/08 doc): sheet's new Batch Status column drives batch statuses " +
  "(Complete→Completed, In Progress→Active — counts finally match the sheet, apply via " +
  "seed-avpl-master); teaching trainers (TR code + batch on Trainer_Master) import as " +
  "Certified/Assigned instead of everyone stuck 'under preparation'; candidates in a batch show " +
  "the batch's programme instead of a false 'No programme'; every list shows a loading skeleton " +
  "instead of blank/'nothing here' while data fetches; New Batch drawer has Create Batch + " +
  "Create backward plan buttons and the plan is WhatsApp-shareable; per-batch bulk attendance " +
  "upload is a visible button.";
