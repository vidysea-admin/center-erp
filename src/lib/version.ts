// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-31";
export const RELEASE_NOTE =
  "Checker round four. QA-056 (S1): 504 students with an IST-midnight date of " +
  "birth were locked out of the candidate portal - the UTC comparison read their " +
  "DOB as the previous day; both sides now canonicalize to the IST calendar " +
  "date, so the REAL birthday opens the page. QA-057: the refusal names the " +
  "date-of-birth field and the label stops promising a prompt that never comes. " +
  "QA-045 (third reopen, closed): the trainer Status COLUMN renders the derived " +
  "tag - the stale stored field is never shown again. QA-055: non-editors get a " +
  "read-only Details card, not a Save button that bounces. QA-058/059: Trainer " +
  "and Enrollment get the lean Home - no money/hiring cards or 403 buttons.";
