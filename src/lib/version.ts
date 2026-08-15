// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-88";
export const RELEASE_NOTE =
  "Umesh 15/08 23:20: 'jis batch me attendance upload ho gayi hai usme Start " +
  "batch jaise buttons aa rahe hain - ye to apne aap hona chahiye.' Attendance " +
  "on record IS proof the batch runs. A Planning/Ready batch that receives " +
  "matched portal rows (or already carries any attendance evidence) becomes " +
  "Active on its own: actual_start = the planned start, roster counted from " +
  "that day, readiness gates skipped ON RECORD (audit: 'auto-activated from " +
  "attendance evidence'). The import is never blocked. The batch page " +
  "reconciles once on open for batches that carried evidence before this " +
  "build (DST-02). Never past Active by itself - Closing/Completed still " +
  "need assessment/certification. Once running, the Overview says so in " +
  "numbers: running since, day N of M, our logged days, portal working days, " +
  "qualified count.";
