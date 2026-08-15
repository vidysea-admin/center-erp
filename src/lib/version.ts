// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-80";
export const RELEASE_NOTE =
  "QA-145 - Drive storage PROVED against real Google, and a second way in. " +
  "Umesh: 'mere credentials jo already available hain, .env me daal do' - " +
  "the gws CLI on his machine holds an OAuth refresh token for his " +
  "Workspace account with full Drive scope. storage.ts now accepts that " +
  "triple (GDRIVE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN) alongside the " +
  "service-account key, env-first. Local run with those creds against " +
  "the real 'All Locations' folder: probe write+read-back ok (8.9s cold), " +
  "real /api/upload of a 2KB mp4 -> Drive under _healthcheck/PROBE-" +
  "BATCH-01/evidence/, proxy read-back byte-identical, StoredFile row " +
  "carries backend=drive + Drive id + folder path; the folder tree is " +
  "visible in Drive. What remains is the same three env values on ECS.";
