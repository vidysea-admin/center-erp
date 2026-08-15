// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-81";
export const RELEASE_NOTE =
  "QA-150 + QA-151 + QA-152 (part 1) - the Gurugram live-batch round. Umesh, " +
  "entering a batch that began 30-07 on 15-08, met a checklist reading 5/5 " +
  "under a Red banner: readiness had five checks, the checklist drew four plus a " +
  "row that was not a check, and the failing one (TOT lead time) never appeared. " +
  "His ruling: planning verdicts live only inside a batch's plan, and the plan " +
  "exists only when someone asks for it. So: readiness.checks = the four " +
  "operational checks (rendered exactly, counted exactly); the TOT lead verdict " +
  "is a plan flag shown in the plan section; batches are created WITHOUT a plan " +
  "and 'Create backward plan' makes one; pre-81 auto-milestones stay hidden and " +
  "silent until asked. Start Batch may carry the REAL start date (today or " +
  "earlier) and restamps joined_on so Rule 29/32 accept the real days. The " +
  "batch-scoped bulk attendance importer link now sits on the Attendance tab " +
  "in every status (it was inside Daily Execution, locked until Active). The " +
  "bypass-Certified prompt asks for the TOT completion date.";
