// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-46";
export const RELEASE_NOTE =
  "One definition of today, and a stop that stops. QA-081: every date guard " +
  "in the daily-log path - future-date refusal, the trainer's same-day " +
  "marking rounds, the dropout future check - now reads the same IST calendar " +
  "day (istToday); at 1am IST the server's UTC clock no longer refuses an " +
  "on-time trainer or accepts a future drop. QA-080: stopping a user " +
  "invalidates their LIVE session on the very next request - not after a " +
  "cache TTL, and never 30 days. QA-072: the daily log's photo and video " +
  "pickers take multiple files in one go. QA-030: the Batches screen names " +
  "WHY positions are blocked, not just how many. QA-073: the users list " +
  "names the granted/removed rights, and choosing a role shows what that " +
  "preset profile carries.";
