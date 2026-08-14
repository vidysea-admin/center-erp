// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-48";
export const RELEASE_NOTE =
  "QA-076: batch codes speak all FOUR of the CEO's parts - centre code, " +
  "course, skill, number (AVP-GURU-RPLAVP-DST-01; the programme code is " +
  "already course-and-skill fused) - the checker caught the dropped third " +
  "part before the bulk batch-planning wave could mint 8-10k codes in the " +
  "short form. QA-089: district and operating_partner join the fixed set on " +
  "both the park side and the approval replay - everything the AVPL master " +
  "sheet writes is now protected the same way, so the next rebase can never " +
  "silently undo an approved SPOC edit.";
