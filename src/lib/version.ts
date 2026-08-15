// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-90";
export const RELEASE_NOTE =
  "Evidence transport: browser -> Google Drive, resumable (checker's " +
  "DESIGN-video-upload.md; Umesh: 'plan out how the video upload really " +
  "works'). The server AUTHORISES and RECORDS - POST /api/upload/intent opens " +
  "a Drive resumable session in the right <Centre>/<Batch>/<kind> folder and " +
  "hands the browser a per-file session URI (never a key); the browser PUTs " +
  "8 MiB chunks straight to Google with a real progress bar and resumes from " +
  "the last committed byte after a dropped connection; POST /api/upload/" +
  "complete confirms size + folder with Drive and flips the StoredFile row " +
  "from pending to ready (the only state the file proxy serves); abort cleans " +
  "up. Nothing large passes through the container. Large files and every " +
  "video take this path when Drive is on; small photos keep the multipart door " +
  "(and its server-side compression); with Drive off, intent says 409 and the " +
  "client falls back. Also QA-160 refinement: an auto-activated batch's " +
  "actual_start is the earliest logged day when logs exist.";
