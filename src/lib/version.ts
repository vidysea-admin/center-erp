// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-86";
export const RELEASE_NOTE =
  "Umesh 15/08 22:55 + QA-159. (1) The batch health and no-students banners " +
  "get a cross - a dismissal lasts this session per batch (health: per " +
  "score, so a Red that turns Amber shows again); the roster banner collapses " +
  "to a 'No students yet - show' chip. (2) The batches list gains an " +
  "Attendance column - our day-wise logs (count, last day) and the newest " +
  "matched portal import per batch, '- none yet' otherwise - plus a 'No " +
  "attendance yet' filter; the Attendance tab names its two meters apart " +
  "(Our logs vs Portal) instead of one '0 days logged' next to 13 portal " +
  "days; the Govt Attendance imports table shows the batch code. (3) The " +
  "closure result/certificate upload now goes through the one upload path " +
  "(compression, retry, folder + entity).";
