// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-29";
export const RELEASE_NOTE =
  "Trainers polish (checker round): every pipeline stage shows the CEO's pair - " +
  "accepted-through (green) and rejected-here (red) with a hover explaining both " +
  "(QA-046); Open Positions flags over-nomination when more people are in the " +
  "pipeline than the position needs (QA-001); a name appearing under two phone " +
  "numbers is surfaced as a possible duplicate for the team to confirm, never " +
  "auto-merged (QA-047); cost rows carry Source / Entered by - the person, or " +
  "the AVPL sheet the seed absorbed them from (QA-039).";
