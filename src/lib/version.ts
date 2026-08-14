// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-33";
export const RELEASE_NOTE =
  "R-A: the CEO's stage vocabulary is now the STORED truth, renamed during the " +
  "post-wipe empty-DB window so no label layer is left to drift (the QA-045 bug " +
  "class). Trainer pipeline: Fresh Lead > Shortlisted (docs collect here) > " +
  "Documents Completed (all-papers gate) > Sent to NSDC > NSDC Approved > TOT " +
  "Payment Done > TOT Scheduled > TOT In Progress > Certified; a free certified " +
  "trainer's status tag reads Certified (Ready to Train retired). Candidates: " +
  "journey gains Dropout (enrolled-then-left) and Failed (was Not Certified), " +
  "and enrolled_at is stamped the moment enrollment completes. Legacy sheet " +
  "values stay importable as aliases. The TEMPORARY /api/admin/wipe endpoint is " +
  "REMOVED now that the reset has run; /api/admin/avpl-rebase remains.";
