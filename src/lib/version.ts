// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-82";
export const RELEASE_NOTE =
  "QA-152 part 2 + bulk day-wise attendance. The backward plan is now an " +
  "ARTIFACT: its own page (/batches/<id>/plan) where the planner edits due " +
  "dates, labels, notes and owners, adds and removes rows; a shareable link " +
  "(/p/plan/<token>, no login, like the self-registration form) that reads " +
  "the live plan and - only when shared that way - can tick milestones done " +
  "(recorded as 'via link'); Excel download on both sides; copy-as-text and " +
  "WhatsApp. Re-sharing rotates the old link off. Plan-only verdicts (TOT " +
  "lead time) render here and nowhere else. And the Attendance tab gained " +
  "'Mark attendance (bulk)': a date-range x roster grid, everyone starts " +
  "Present, untick absentees, one save posts every day through the SAME " +
  "per-day rules as a single entry (POST /logs/bulk -> createDailyLogChecked) " +
  "and answers per day: saved / already logged / the rule that refused it.";
