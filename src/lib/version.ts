// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-36";
export const RELEASE_NOTE =
  "R-D attendance in hours. Every batch gains an Attendance tab: day-wise " +
  "presence per student, BOTH meters side by side (our daily logs in days; the " +
  "government portal in days AND hours), and the green verdict the CEO asked " +
  "for - once a student's hours cross the programme threshold (min-attendance % " +
  "x QP hours) they are marked 'Qualified for assessments', visible in every " +
  "login that can open the batch. Portal hours are authoritative when a matched " +
  "import exists; until then hours are estimated from our logs x the batch " +
  "slot, and an unmatched student shows no portal figures rather than a guess. " +
  "One shared threshold formula now feeds this tab and the student's own " +
  "public portal page.";
