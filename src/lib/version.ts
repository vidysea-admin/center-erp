// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-100";
export const RELEASE_NOTE =
  "-100: this ERP syncs ONE workbook - the client's OneDrive location sheet. Our own Google " +
  "sheets (trainer nomination, resumes, registered trainers) were ordered removed on 13 Aug, " +
  "and a setup script upserted them straight back on 14 Aug, after which they polled our own " +
  "tabs into the review queue for three days. The rule is now code: only the client workbook " +
  "can be registered, edited, probed, run or polled, and it cannot be registered twice in the " +
  "same mode (which was showing every location change to the reviewer twice). Sheet Watch gained " +
  "a Sheet column and a source filter, so a stray workbook is visible on the screen instead of " +
  "days later; 'Create location...' is refused on any row that is not a centre row (it was " +
  "offered beside a trainer-nomination row); and a daily sync time is read in IST, not UTC.";
