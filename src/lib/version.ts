// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-64";
export const RELEASE_NOTE =
  "QA-141 (Umesh, after a 12-digit keyboard-mash phone sat on prod " +
  "with nothing to stop it): identity fields are format-checked " +
  "everywhere. Phone canon = the bare 10 digits (+91/0 forms " +
  "normalize to the same ten, so one person cannot become three rows " +
  "under the unique index); email must look like one. Strict on " +
  "manual entry - trainers, candidates, users, quick-invite, on " +
  "create AND edit, with the same errors inline in the forms while " +
  "you type (shared validate.ts, one source). Bulk imports normalize " +
  "what they can and REPORT what they cannot (phone_invalid counts) - " +
  "client rows are never dropped over format. Legacy raw rows are " +
  "not rewritten; backfill is a separate approved step.";
