// Deployed-build marker. Bump RELEASE on every meaningful release so anyone can tell,
// from outside and without logging in, exactly which build production is running:
//     curl https://www.vidysea.com/erp/api/public/version
// GIT_COMMIT is optional — set it at build time (docker build --build-arg / env) to also
// surface the exact commit.
export const RELEASE = "2026.08.14-98";
export const RELEASE_NOTE =
  "-98: QA-163 stored evidence (certificates, candidate documents, trainee photos, video) " +
  "now needs a LOGIN to open - anonymous and forged-header reads answer 401; the 32-hex " +
  "capability name stays as the second layer; same-origin <img>/<video>/PDF viewers send " +
  "the cookie themselves; the sync engine's loopback read of an uploaded sheet keeps " +
  "working through a server-internal header. QA-165 a daily log can be read singly and " +
  "DELETED (same right that creates it, frozen batches refuse, audited with the snapshot " +
  "+ reason, the day's own evidence leaves storage with it) - Delete on the log row.";
