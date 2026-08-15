// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-76";
export const RELEASE_NOTE =
  "QA-147 enrollment UX - Manish's 15/08 recording, all five points. " +
  "BULK: one request marks a step (or completes enrollment) for every " +
  "pending member - the 135-click wall is three clicks or one, and the " +
  "RPL cohort's ~50 hours of clicking becomes minutes. SCROLL: the card " +
  "components were declared inside the render, so each click remounted " +
  "the whole list ('page upar bhaga') - hoisted, a click updates one " +
  "card in place. NAME: every card names the person in every state, " +
  "Completed included (name -> email -> phone). TEXT: the readiness " +
  "blocker says the failure ('room not assigned') instead of the check " +
  "('Not ready: room assigned'). ROOM: the failing check now carries the " +
  "path - pick one of the centre's rooms or add one right there (rooms " +
  "were per-centre already; CHI-ITI simply had none).";
