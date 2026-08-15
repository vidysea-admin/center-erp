// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-69";
export const RELEASE_NOTE =
  "Loop tick 1 (QA-129/101/029/018): mail suppression is STRUCTURAL - " +
  "a test environment is recognised (test DB name or localhost auth " +
  "URL), not declared by a flag someone must remember; the skip " +
  "reason names it, MAIL_DISABLED stays as an extra switch, prod is " +
  "untouched. The four remaining server-day comparisons (batch start " +
  "gate, missing-log streak, overdue flag, missing-log queue) now use " +
  "the IST calendar day like the daily-log path. The trainer form's " +
  "skills input suggests from the job-roles master and warns - never " +
  "blocks - when no skill names a recognised job role, and the list " +
  "flags such rows: those are exactly the rows that blank the " +
  "Preparation board at scale. The locations table gets an explicit " +
  "per-row Edit affordance (same detail-page destination, said out " +
  "loud).";
