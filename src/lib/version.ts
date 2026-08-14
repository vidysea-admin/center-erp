// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-49";
export const RELEASE_NOTE =
  "THE upload fix (team-reported, live-reproduced): the upload helper was " +
  "the one fetch in the app without the /erp basePath, so on production " +
  "every UI upload - trainer documents, daily-log photos and videos, " +
  "certificates - went to the marketing site's 404, retried three times and " +
  "died. One prefix, everything works. Riding along: several documents in " +
  "one pick (type auto-detected from the filename, duplicate names refused " +
  "by name), PDF/Word/photo/HEIC accepted on every document surface, and " +
  "an honest message when a file over ~8 MB hits the platform's multipart " +
  "cap instead of 'something went wrong'.";
